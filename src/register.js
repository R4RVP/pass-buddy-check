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

export async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const phone = normalizePhone(body.phone);
  if (!phone) return err400('Invalid phone number format.');

  const name = String(body.name ?? '').trim();
  if (!name) return err400('Name is required.');

  const org_level  = VALID_ORG_LEVELS.includes(body.org_level) ? body.org_level : null;
  const unit_code  = body.unit_code  ? String(body.unit_code).trim()  : null;
  const email      = body.email      ? String(body.email).trim()      : null;
  const note       = body.note       ? String(body.note).trim()       : null;

  // Guard: phone already has an active or pending member account
  const { results: existing } = await env.DB.prepare(
    `SELECT status FROM members WHERE phone = ?`
  ).bind(phone).all();

  if (existing.length > 0) {
    if (existing[0].status === 'active') {
      return err409('This number is already registered. Use it to log in.');
    }
    // pending or suspended — give same pending message (don't reveal suspended status)
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

  // Roster check
  const { results: roster } = await env.DB.prepare(
    `SELECT member_id, local_num FROM member_roster WHERE phone = ?`
  ).bind(phone).all();

  if (roster.length > 0) {
    // Auto-approve: known PASS member
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO members
        (id, phone, name, org_level, unit_code, email, status,
         roster_matched, created_at, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 1, datetime('now'), datetime('now'))
    `).bind(id, phone, name, org_level, unit_code, email).run();

    return json({ ok: true, status: 'active',
      message: 'Registration complete. You can now check in.' });
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
// Cloudflare Access protected (/admin path locked to bstruck@passnational.org).
// Accepts CSV with columns: phone, member_id (optional), local_num (optional).
// Upserts into member_roster — safe to re-run on any Velarium export.

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
    // Accept text/csv or text/plain bodies directly
    csvText = await request.text().catch(() => '');
  }

  if (!csvText?.trim()) return err400('Empty CSV.');

  const lines      = csvText.trim().split(/\r?\n/);
  const firstLine  = lines[0].toLowerCase();
  const hasHeader  = firstLine.includes('phone');
  const dataLines  = hasHeader ? lines.slice(1) : lines;

  let imported = 0;
  let skipped  = 0;
  const errors = [];

  for (const line of dataLines) {
    if (!line.trim()) continue;

    // Strip quotes, handle comma-separated values
    const cols     = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const rawPhone = cols[0];
    const memberId = cols[1] || null;
    const localNum = cols[2] || null;

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      errors.push(`Invalid phone skipped: "${rawPhone}"`);
      skipped++;
      continue;
    }

    try {
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO member_roster (id, phone, member_id, local_num, imported_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(phone) DO UPDATE SET
          member_id   = excluded.member_id,
          local_num   = excluded.local_num,
          imported_at = excluded.imported_at
      `).bind(id, phone, memberId, localNum).run();
      imported++;
    } catch (e) {
      errors.push(`DB error on ${phone}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`[roster import] ${userEmail}: ${imported} imported, ${skipped} skipped`);
  return json({ ok: true, imported, skipped, errors: errors.slice(0, 20) });
}
