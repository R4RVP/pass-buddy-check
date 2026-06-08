// PASS Buddy Check — M13: Drop a Pin (live location update)

import { requireAuth }                   from './auth.js';
import { json, err400, err401, err404 }  from './utils.js';
import { sendPush }                      from './push.js';

export async function handleDropPin(request, env, params) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  const { id } = params;

  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const lat = typeof body.lat === 'number' && isFinite(body.lat) ? body.lat : null;
  const lon = typeof body.lon === 'number' && isFinite(body.lon) ? body.lon : null;
  if (lat === null || lon === null) return err400('lat and lon are required numbers.');

  const { results } = await env.DB.prepare(`
    SELECT c.id, c.status, m.push_sub
    FROM   checkins c
    JOIN   members  m ON m.id = c.member_id
    WHERE  c.id = ? AND c.member_id = ? AND c.status IN ('active', 'overdue')
  `).bind(id, session.sub).all();

  if (!results.length) return err404();

  const { push_sub } = results[0];

  // W3W reverse lookup — non-fatal if key missing or API down
  let current_w3w = null;
  if (env.W3W_API_KEY) {
    try {
      const w3wRes = await fetch(
        `https://api.what3words.com/v3/convert-to-3wa?coordinates=${lat},${lon}&language=en&key=${env.W3W_API_KEY}`,
        { headers: {
            'X-Correlation-ID': id,
            'Referer': env.APP_URL ?? 'https://pass-buddy-check.passregioniv.workers.dev',
          }
        }
      );
      if (w3wRes.ok) {
        const d = await w3wRes.json();
        current_w3w = d.words ?? null;  // "word.word.word" — no ///
      } else {
        console.warn('[drop-pin] W3W API returned', w3wRes.status);
      }
    } catch (e) {
      console.error('[drop-pin] W3W lookup failed:', e?.message);
    }
  } else {
    console.warn('[drop-pin] W3W_API_KEY not configured — storing coords only');
  }

  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE checkins
    SET current_lat           = ?,
        current_lon           = ?,
        current_w3w           = ?,
        location_updated_at   = ?,
        location_update_count = location_update_count + 1
    WHERE id = ?
  `).bind(lat, lon, current_w3w, now, id).run();

  // Push confirmation to member
  const subscription = push_sub ? JSON.parse(push_sub) : null;
  const pushResult   = await sendPush(subscription, {
    title: '📍 Location Updated',
    body:  current_w3w ? `Pin dropped at ///${current_w3w}` : 'Your location has been updated.',
    tag:   'buddy-check-pin',
    url:   '/',
  }, env);

  if (pushResult.gone) {
    await env.DB.prepare(`UPDATE members SET push_sub = NULL WHERE id = ?`)
      .bind(session.sub).run();
  }

  const logStatus = pushResult.ok                  ? 'sent'
    : pushResult.reason === 'vapid_not_configured' ? 'stubbed'
    : pushResult.reason === 'no_subscription'      ? 'stubbed'
    : 'failed';

  await env.DB.prepare(`
    INSERT INTO notification_log
      (id, checkin_id, recipient_type, channel, event, status, sent_at)
    VALUES (?, ?, 'member', 'push', 'checkin_confirm', ?, datetime('now'))
  `).bind(crypto.randomUUID(), id, logStatus).run().catch(e =>
    console.error('[drop-pin] notification_log insert failed:', e?.message)
  );

  console.log(`[drop-pin] ${session.name} → ${lat},${lon} — w3w: ${current_w3w ?? 'none'} — push: ${pushResult.ok ? 'sent' : pushResult.reason}`);

  return json({ ok: true, current_w3w, location_updated_at: now });
}
