// PASS Buddy Check — Check-in module
// Handles: create check-in, active check-in query, ETA update, checkout
//
// M4: DB operations + Durable Object alarm wiring implemented.
// M5: Web Push dispatch for ETA update + checkout confirmation.
//     Reminder + overdue alarm notifications still stubbed (M7).

import { requireAuth }                                    from './auth.js';
import { normalizePhone, json, err400, err401, err404 }  from './utils.js';
import { sendPush }                                       from './push.js';

const VALID_LOCATION_TYPES = ['fire', 'bomb_threat', 'tornado', 'field', 'other'];

// ── POST /api/checkin ─────────────────────────────────────────────────────────
// Create a new check-in for the authenticated member.
// Guards: must be authenticated; no existing active check-in.
// Response includes checkin record; alarm is scheduled via CheckinAlarmDO.

export async function handleCheckin(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  // ── Required fields ────────────────────────────────────────────────────────
  const buddy_name = String(body.buddy_name ?? '').trim();
  if (!buddy_name) return err400('buddy_name is required.');

  const buddy_phone = normalizePhone(body.buddy_phone);
  if (!buddy_phone) return err400('Valid buddy phone number is required (US, E.164 or 10-digit).');

  const location_label = String(body.location_label ?? '').trim();
  if (!location_label) return err400('location_label is required.');

  const expected_out_at = body.expected_out_at;
  if (!expected_out_at || isNaN(new Date(expected_out_at).getTime())) {
    return err400('expected_out_at must be a valid ISO 8601 timestamp.');
  }
  if (new Date(expected_out_at) <= new Date()) {
    return err400('expected_out_at must be in the future.');
  }

  // ── Optional fields ────────────────────────────────────────────────────────
  const buddy_email   = body.buddy_email   ? String(body.buddy_email).trim()   : null;
  const w3w_address   = body.w3w_address   ? String(body.w3w_address).trim()   : null;
  const facility_code = body.facility_code ? String(body.facility_code).trim() : null;
  const activity      = body.activity      ? String(body.activity).trim()      : null;

  const location_type = VALID_LOCATION_TYPES.includes(body.location_type)
    ? body.location_type : 'field';

  const grace_minutes = Number.isInteger(body.grace_minutes) && body.grace_minutes > 0
    ? Math.min(body.grace_minutes, 480) : 30;

  // Coordinates from geolocation (client-supplied; internal only — never displayed)
  const checkin_lat = typeof body.lat === 'number' && isFinite(body.lat) ? body.lat : null;
  const checkin_lon = typeof body.lon === 'number' && isFinite(body.lon) ? body.lon : null;

  // ── Guard: no open check-in ─────────────────────────────────────────────────
  const { results: existing } = await env.DB.prepare(
    `SELECT id FROM checkins WHERE member_id = ? AND status IN ('active', 'overdue')`
  ).bind(session.sub).all();

  if (existing.length > 0) {
    return json(
      { error: 'You already have an active check-in. Check out before starting a new one.' },
      409
    );
  }

  // ── Insert ─────────────────────────────────────────────────────────────────
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO checkins
      (id, member_id, buddy_name, buddy_phone, buddy_email,
       location_label, w3w_address, facility_code, location_type, activity,
       expected_out_at, original_expected_out, grace_minutes,
       checkin_lat, checkin_lon)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, session.sub,
    buddy_name, buddy_phone, buddy_email,
    location_label, w3w_address, facility_code, location_type, activity,
    expected_out_at, expected_out_at, grace_minutes,
    checkin_lat, checkin_lon
  ).run();

  // ── Schedule alarm via Durable Object (non-fatal on failure) ───────────────
  try {
    const doId = env.CHECKIN_ALARM.idFromName(session.sub);
    const stub = env.CHECKIN_ALARM.get(doId);
    await stub.fetch('https://internal/alarm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        action:        'schedule',
        checkinId:     id,
        expectedOutAt: expected_out_at,
        graceMinutes:  grace_minutes,
      }),
    });
  } catch (e) {
    // Alarm scheduling failure is non-fatal — check-in record is committed.
    // M7 adds a recovery path for missed alarms.
    console.error('[checkin] Alarm schedule failed:', e?.message);
  }

  // M10 TODO: send Web Push confirmation to member
  console.log(`[checkin] ${session.name} → "${location_label}" until ${expected_out_at}`);

  return json({
    ok: true,
    checkin: {
      id,
      location_label,
      buddy_name,
      buddy_phone,
      expected_out_at,
      grace_minutes,
      checkin_at: new Date().toISOString(),
      w3w_address,
      activity,
    },
  }, 201);
}

// ── GET /api/checkin/active ───────────────────────────────────────────────────
// Returns the current active (or overdue) check-in for the authenticated member.
// Response: { ok, checkin: <record|null> }

export async function handleGetActiveCheckin(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  const { results } = await env.DB.prepare(`
    SELECT id, buddy_name, buddy_phone, buddy_email,
           location_label, w3w_address, activity,
           expected_out_at, grace_minutes, status, checkin_at,
           current_w3w, location_updated_at, location_update_count
    FROM   checkins
    WHERE  member_id = ? AND status IN ('active', 'overdue')
    ORDER  BY checkin_at DESC
    LIMIT  1
  `).bind(session.sub).all();

  return json({ ok: true, checkin: results[0] ?? null });
}

// ── POST /api/checkin/:id/checkout ───────────────────────────────────────────
// Close an active check-in. Cancels the Durable Object alarm.
// M5: sends checkout confirmation push to member.
// M7: adds push notification to buddy + safety contact.

export async function handleCheckout(request, env, params) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  const { id } = params;

  // Fetch check-in + member push subscription in one query
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.status, m.push_sub
    FROM   checkins c
    JOIN   members  m ON m.id = c.member_id
    WHERE  c.id = ? AND c.member_id = ?
  `).bind(id, session.sub).all();

  if (!results.length) return err404();

  const { status, push_sub } = results[0];

  if (status === 'checked_out') {
    return json({ ok: true, message: 'Already checked out.' });
  }
  if (!['active', 'overdue'].includes(status)) {
    return err400(`Cannot check out a check-in with status "${status}".`);
  }

  await env.DB.prepare(
    `UPDATE checkins SET status = 'checked_out', checkout_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  // Cancel Durable Object alarm (non-fatal)
  try {
    const doId = env.CHECKIN_ALARM.idFromName(session.sub);
    const stub = env.CHECKIN_ALARM.get(doId);
    await stub.fetch('https://internal/alarm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'cancel' }),
    });
  } catch (e) {
    console.error('[checkout] Alarm cancel failed:', e?.message);
  }

  // ── M5: send checkout confirmation push to member ──────────────────────────
  const subscription = push_sub ? JSON.parse(push_sub) : null;
  const pushResult   = await sendPush(
    subscription,
    {
      title: '✅ Checked Out',
      body:  "You've been marked as safely checked out.",
      tag:   'buddy-check-checkout',
      url:   '/',
    },
    env
  );

  // Clear expired subscription from DB
  if (pushResult.gone) {
    await env.DB.prepare(`UPDATE members SET push_sub = NULL WHERE id = ?`)
      .bind(session.sub).run();
  }

  // Log to notification_log (always — helps track push coverage across pilot members)
  const logStatus = pushResult.ok                  ? 'sent'
    : pushResult.reason === 'vapid_not_configured' ? 'stubbed'
    : pushResult.reason === 'no_subscription'      ? 'stubbed'
    : 'failed';
  await env.DB.prepare(`
    INSERT INTO notification_log
      (id, checkin_id, recipient_type, channel, event, status, sent_at)
    VALUES (?, ?, 'member', 'push', 'checkout', ?, datetime('now'))
  `).bind(crypto.randomUUID(), id, logStatus).run().catch(e =>
    console.error('[checkout] notification_log insert failed:', e?.message)
  );

  // M7 TODO: send checkout notification to buddy + safety contact
  console.log(`[checkout] ${session.name} checked out of ${id} — push: ${pushResult.ok ? 'sent' : pushResult.reason ?? 'failed'}`);

  return json({ ok: true });
}

// ── PATCH /api/checkin/:id/eta ────────────────────────────────────────────────
// Update the expected return time on an active check-in.
// Reschedules the Durable Object alarm with the new ETA.
// M5 adds push notification to member confirming the update.

export async function handleEtaUpdate(request, env, params) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  const { id } = params;

  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const expected_out_at = body.expected_out_at;
  if (!expected_out_at || isNaN(new Date(expected_out_at).getTime())) {
    return err400('expected_out_at must be a valid ISO 8601 timestamp.');
  }
  if (new Date(expected_out_at) <= new Date()) {
    return err400('expected_out_at must be in the future.');
  }

  // Fetch check-in + member push subscription in one query
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.grace_minutes, m.push_sub
    FROM   checkins c
    JOIN   members  m ON m.id = c.member_id
    WHERE  c.id = ? AND c.member_id = ? AND c.status IN ('active', 'overdue')
  `).bind(id, session.sub).all();

  if (!results.length) return err404();

  const { grace_minutes: rawGrace, push_sub } = results[0];
  const grace_minutes = rawGrace ?? 30;

  await env.DB.prepare(
    `UPDATE checkins
     SET expected_out_at   = ?,
         status            = 'active',
         overdue_alerted_at = NULL,
         eta_updated_count = eta_updated_count + 1
     WHERE id = ?`
  ).bind(expected_out_at, id).run();

  // Reschedule alarm (non-fatal)
  try {
    const doId = env.CHECKIN_ALARM.idFromName(session.sub);
    const stub = env.CHECKIN_ALARM.get(doId);
    await stub.fetch('https://internal/alarm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        action:        'reschedule',
        checkinId:     id,
        expectedOutAt: expected_out_at,
        graceMinutes:  grace_minutes,
      }),
    });
  } catch (e) {
    console.error('[eta] Alarm reschedule failed:', e?.message);
  }

  // ── M5: send ETA update confirmation push to member ────────────────────────
  const subscription = push_sub ? JSON.parse(push_sub) : null;
  const pushResult   = await sendPush(
    subscription,
    {
      title: '⏱ ETA Updated',
      body:  'Your check-in return time has been updated.',
      tag:   'buddy-check-eta',
      url:   '/',
    },
    env
  );

  // Clear expired subscription from DB
  if (pushResult.gone) {
    await env.DB.prepare(`UPDATE members SET push_sub = NULL WHERE id = ?`)
      .bind(session.sub).run();
  }

  // Log to notification_log
  const logStatus = pushResult.ok                  ? 'sent'
    : pushResult.reason === 'vapid_not_configured' ? 'stubbed'
    : pushResult.reason === 'no_subscription'      ? 'stubbed'
    : 'failed';
  await env.DB.prepare(`
    INSERT INTO notification_log
      (id, checkin_id, recipient_type, channel, event, status, sent_at)
    VALUES (?, ?, 'member', 'push', 'eta_update', ?, datetime('now'))
  `).bind(crypto.randomUUID(), id, logStatus).run().catch(e =>
    console.error('[eta] notification_log insert failed:', e?.message)
  );

  console.log(`[eta] ${session.name} updated ETA for ${id} → ${expected_out_at} — push: ${pushResult.ok ? 'sent' : pushResult.reason ?? 'failed'}`);

  return json({ ok: true, expected_out_at });
}
