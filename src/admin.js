// PASS Buddy Check — Admin module (M9)
// Member management and pending-request review for FR/admin users.
// Access gated by ADMIN_PHONES env var (comma-separated E.164).

import { requireAuth }                                           from './auth.js';
import { normalizePhone, json, err400, err401, err403, err404 } from './utils.js';
import { handlePurge }                                          from './purge.js';

const VALID_ORG_LEVELS = ['flight_standards', 'aircraft_cert', 'other'];

// ── Access helper ─────────────────────────────────────────────────────────────

export function hasAdminAccess(session, env) {
  if (!env.ADMIN_PHONES) return false;
  return env.ADMIN_PHONES.split(',').map(p => p.trim()).filter(Boolean)
    .includes(session.phone);
}

// ── GET /api/admin/members ────────────────────────────────────────────────────
// Returns all members sorted active → pending → suspended, then by name.

export async function handleAdminListMembers(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasAdminAccess(session, env)) return err403();

  const { results } = await env.DB.prepare(`
    SELECT id, name, phone, status, org_level, unit_code,
           roster_matched, gov_device_disclosed, created_at, activated_at
    FROM   members
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      name ASC
  `).all();

  return json({ ok: true, members: results });
}

// ── POST /api/admin/members ───────────────────────────────────────────────────
// Manually add a member (bypasses roster check; status immediately active).

export async function handleAdminAddMember(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasAdminAccess(session, env)) return err403();

  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const phone = normalizePhone(body.phone);
  if (!phone) return err400('Valid US phone number is required.');

  const name = String(body.name ?? '').trim();
  if (!name) return err400('Name is required.');

  const org_level = VALID_ORG_LEVELS.includes(body.org_level) ? body.org_level : null;
  const unit_code = body.unit_code ? String(body.unit_code).trim() : null;
  const email     = body.email     ? String(body.email).trim()     : null;

  // Guard: phone already registered
  const { results: existing } = await env.DB.prepare(
    `SELECT status FROM members WHERE phone = ?`
  ).bind(phone).all();

  if (existing.length > 0) {
    return err400(`A member with this phone already exists (status: ${existing[0].status}).`);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO members
      (id, phone, name, org_level, unit_code, email, status,
       roster_matched, created_at, activated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 0, datetime('now'), datetime('now'))
  `).bind(id, phone, name, org_level, unit_code, email).run();

  return json({ ok: true, member: { id, phone, name, status: 'active' } }, 201);
}

// ── PATCH /api/admin/members/:id ──────────────────────────────────────────────
// Update a member's status or unit_code. Only fields present in the body change.

export async function handleAdminUpdateMember(request, env, params) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasAdminAccess(session, env)) return err403();

  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const { id } = params;

  const { results: found } = await env.DB.prepare(
    `SELECT id, status FROM members WHERE id = ?`
  ).bind(id).all();
  if (!found.length) return err404();

  const parts = [];
  const binds = [];

  if (body.status !== undefined) {
    const VALID_STATUSES = ['active', 'pending', 'suspended'];
    if (!VALID_STATUSES.includes(body.status)) {
      return err400(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    parts.push('status = ?');
    binds.push(body.status);
    // Set activated_at when transitioning to active for the first time
    if (body.status === 'active' && found[0].status !== 'active') {
      parts.push("activated_at = datetime('now')");
    }
  }

  if (body.unit_code !== undefined) {
    parts.push('unit_code = ?');
    binds.push(body.unit_code ? String(body.unit_code).trim() : null);
  }

  if (!parts.length) return err400('No updatable fields provided (status, unit_code).');

  binds.push(id);
  await env.DB.prepare(
    `UPDATE members SET ${parts.join(', ')} WHERE id = ?`
  ).bind(...binds).run();

  return json({ ok: true });
}

// ── GET /api/admin/requests ───────────────────────────────────────────────────
// Returns pending registration requests (undecided by default).
// Pass ?all=1 to include previously decided requests.

export async function handleAdminListRequests(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasAdminAccess(session, env)) return err403();

  const url        = new URL(request.url);
  const includeAll = url.searchParams.get('all') === '1';

  const { results } = await env.DB.prepare(`
    SELECT id, name, phone, org_level, unit_code, email, note,
           submitted_at, decision, reviewed_at
    FROM   pending_requests
    ${includeAll ? '' : 'WHERE decision IS NULL'}
    ORDER BY submitted_at DESC
    LIMIT  100
  `).all();

  return json({ ok: true, requests: results });
}

// ── POST /api/admin/requests/:id/decide ───────────────────────────────────────
// Approve or deny a pending registration request.
// Approving creates an active member record (phone → name/org from the request).

export async function handleAdminDecideRequest(request, env, params) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasAdminAccess(session, env)) return err403();

  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const { decision } = body;
  if (!['approved', 'denied'].includes(decision)) {
    return err400('decision must be "approved" or "denied".');
  }

  const { id } = params;

  const { results } = await env.DB.prepare(
    `SELECT * FROM pending_requests WHERE id = ? AND decision IS NULL`
  ).bind(id).all();
  if (!results.length) return err404();

  const req = results[0];

  if (decision === 'approved') {
    // Guard: phone may have been added manually since the request came in
    const { results: existing } = await env.DB.prepare(
      `SELECT id FROM members WHERE phone = ?`
    ).bind(req.phone).all();

    if (!existing.length) {
      const memberId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO members
          (id, phone, name, org_level, unit_code, email, status,
           roster_matched, created_at, activated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', 0, datetime('now'), datetime('now'))
      `).bind(
        memberId, req.phone, req.name, req.org_level,
        req.unit_code, req.email
      ).run();
    }
  }

  await env.DB.prepare(`
    UPDATE pending_requests
    SET    decision = ?, reviewed_at = datetime('now')
    WHERE  id = ?
  `).bind(decision, id).run();

  return json({ ok: true, decision });
}

// ── POST /api/admin/purge ─────────────────────────────────────────────────────
// Manual trigger for the purge job. Useful for testing without waiting for cron.
// Runs the same logic as the scheduled cron handler.

export async function handleAdminPurge(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasAdminAccess(session, env)) return err403();

  const result = await handlePurge(env);
  return json({ ok: true, ...result });
}
