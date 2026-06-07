// PASS Buddy Check — Registration module
// Self-service member registration + Velarium CSV roster import

import { normalizePhone, json, err400, err403, err409 } from './utils.js';

const VALID_ORG_LEVELS = ['flight_standards', 'aircraft_cert', 'other'];

// ── POST /api/register ────────────────────────────────────────────────────────
// Open endpoint — no auth required (member is registering before they have an account).
//
// Flow:
//   phone in member_roster → auto-approve (status = active)
//   phone not in roster    → create pending_request (FR/admin review required)
//
// Response includes phone_uncertain flag when auto-approving so M4 UI can
// show enhanced government-device disclosure when warranted.

export async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const phone = normalizePhone(body.phone);
  if (!phone) return err400('Invalid phone number format.');

  const name = String(body.name ?? '').trim();
  if (!name) return err400('Name is required.');

  const org_level = VALID_ORG_LEVELS.includes(body.org_level) ? body.org_level : null;
  const unit_code = body.unit_code ? String(body.unit_code).trim() : null;
  const email     = body.email     ? String(body.email).trim()     : null;
  const note      = body.note      ? String(body.note).trim()      : null;

  // Guard: phone already has an active or pending member account
  const { results: existing } = await env.DB.prepare(
    `SELECT status FROM members WHERE phone = ?`
  ).bind(phone).all();

  if (existing.length > 0) {
    if (existing[0].status === 'active') {
      return err409('This number is already registered. Use it to log in.');
    }
    return json({ ok: true, status: 'pending',
      message: 'Your registration is already under review.' });
  }

  // Guard: open pending_request for this phone
  const { results: openReq } = await env.DB.prepare(
    `SELECT id FROM pending_requests WHERE phone = ? AND decision IS NULL`
  ).bind(phone).all();

  if (openReq.length > 0) {
    return json({ ok: true, status: 'pending',
      message: 'Your registration is already under review.' });
  }

  // Roster check — also fetch phone_uncertain for UI disclosure hint
  const { results: roster } = await env.DB.prepare(
    `SELECT chapter_ref, local_num, phone_uncertain FROM member_roster WHERE phone = ?`
  ).bind(phone).all();

  if (roster.length > 0) {
    // Auto-approve: phone is on the Velarium allowlist
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO members
        (id, phone, name, org_level, unit_code, email, status,
         roster_matched, created_at, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 1, datetime('now'), datetime('now'))
    `).bind(id, phone, name, org_level, unit_code, email).run();

    return json({
      ok:               true,
      status:           'active',
      // M4: when true, show enhanced government-device disclosure before first check-in
      phone_uncertain:  roster[0].phone_uncertain === 1,
      message:          'Registration complete. You can now check in.',
    });
  }

  // No roster match: queue for manual review
  const reqId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO pending_requests
      (id, phone, name, org_level, unit_code, email, note, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(reqId, phone, name, org_level, unit_code, email, note).run();

  // M10: replace this log with a Web Push notification to admin/FR
  console.log(`[M10 TODO] Push admin: new pending registration — ${name} ${phone}`);

  return json({ ok: true, status: 'pending',
    message: 'We couldn\'t verify your membership automatically. ' +
             'A safety contact will review your request.' });
}

// ── POST /api/admin/roster/import ─────────────────────────────────────────────
// Cloudflare Access protected (/admin path locked in CF dashboard).
// Accepts CSV produced by import_roster.py (or any CSV with a phone column).
//
// Supported columns (matched by header name, case-insensitive):
//   phone*           E.164 or common US formats — required
//   name             Full name from Velarium — admin-facing only
//   phone_work       Desk/office number — reference, never used for OTP
//   phone_uncertain  1 = only one phone on file (may be gov device)
//   chapter_ref      Human-readable ID e.g. "NE3-10"
//   local_num        Chapter code e.g. "NE3"
//   member_id        Backward-compat alias for chapter_ref
//
// Safe to re-run — all rows are upserted on phone conflict.

export async function handleRosterImport(request, env) {
  const userEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!userEmail) return err403();

  const ct = request.headers.get('Content-Type') ?? '';
  let csvText;

  if (ct.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    if (!form) return err400('Could not parse form data.');
    const file = form.get('file');
    if (!file) return err400('No "file" field in form data.');
    csvText = typeof file === 'string' ? file : await file.text();
  } else {
    csvText = await request.text().catch(() => '');
  }

  if (!csvText?.trim()) return err400('Empty CSV.');

  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return err400('CSV has no data rows.');

  // Parse header to column index map (case-insensitive)
  const headerCols = lines[0].toLowerCase().split(',').map(c => c.trim().replace(/^"|"$/g, ''));
  const idx = name => {
    const i = headerCols.indexOf(name);
    return i >= 0 ? i : -1;
  };

  const iPhone          = idx('phone');
  const iPhoneWork      = idx('phone_work');
  const iPhoneUncertain = idx('phone_uncertain');
  const iName           = idx('name');
  const iChapterRef     = idx('chapter_ref') >= 0 ? idx('chapter_ref') : idx('member_id');
  const iLocalNum       = idx('local_num');

  if (iPhone < 0) return err400('CSV must have a "phone" column.');

  const col = (cols, i) => (i >= 0 && cols[i] ? cols[i].trim() : null);

  let imported = 0;
  let skipped  = 0;
  const errors = [];

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;

    const cols           = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const rawPhone       = col(cols, iPhone);
    const rawPhoneWork   = col(cols, iPhoneWork);
    const phoneUncertain = parseInt(col(cols, iPhoneUncertain) ?? '0', 10) || 0;
    const name           = col(cols, iName);
    const chapterRef     = col(cols, iChapterRef);
    const localNum       = col(cols, iLocalNum);

    const phone     = normalizePhone(rawPhone);
    const phoneWork = normalizePhone(rawPhoneWork) || rawPhoneWork || null;

    if (!phone) {
      errors.push(`Invalid phone skipped: "${rawPhone}"`);
      skipped++;
      continue;
    }

    try {
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO member_roster
          (id, phone, phone_work, phone_uncertain, name, chapter_ref, local_num, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(phone) DO UPDATE SET
          phone_work      = excluded.phone_work,
          phone_uncertain = excluded.phone_uncertain,
          name            = excluded.name,
          chapter_ref     = excluded.chapter_ref,
          local_num       = excluded.local_num,
          imported_at     = excluded.imported_at
      `).bind(id, phone, phoneWork, phoneUncertain, name, chapterRef, localNum).run();
      imported++;
    } catch (e) {
      errors.push(`DB error on ${phone}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`[roster import] ${userEmail}: ${imported} imported, ${skipped} skipped`);
  return json({ ok: true, imported, skipped, errors: errors.slice(0, 20) });
}
