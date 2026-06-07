// PASS Buddy Check — Active Board module (M8)
// Returns all active/overdue check-ins for FR/admin users.
// Access is gated by BOARD_PHONES env var (comma-separated E.164).

import { requireAuth }                          from './auth.js';
import { json, err401, err403 }                 from './utils.js';

// ── Access helper ─────────────────────────────────────────────────────────────

export function hasBoardAccess(session, env) {
  if (!env.BOARD_PHONES) return false;
  const allowed = env.BOARD_PHONES.split(',').map(p => p.trim()).filter(Boolean);
  return allowed.includes(session.phone);
}

// ── GET /api/board ────────────────────────────────────────────────────────────
// Returns all active + overdue check-ins with member and buddy details.
// Requires: valid JWT + phone in BOARD_PHONES list.

export async function handleBoard(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasBoardAccess(session, env)) return err403();

  const { results } = await env.DB.prepare(`
    SELECT
      c.id, c.status,
      c.location_label, c.w3w_address, c.activity, c.location_type,
      c.buddy_name, c.buddy_phone, c.buddy_email,
      c.expected_out_at, c.original_expected_out, c.grace_minutes,
      c.checkin_at, c.eta_updated_count,
      c.reminder_sent_at, c.overdue_alerted_at,
      m.id        AS member_id,
      m.name      AS member_name,
      m.phone     AS member_phone,
      m.unit_code AS unit_code
    FROM   checkins c
    JOIN   members  m ON m.id = c.member_id
    WHERE  c.status IN ('active', 'overdue')
    ORDER  BY c.checkin_at ASC
  `).all();

  return json({
    ok:        true,
    checkins:  results,
    timestamp: new Date().toISOString(),
  });
}
