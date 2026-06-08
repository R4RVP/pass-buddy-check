// PASS Buddy Check — Web Push subscription endpoints
//
// GET    /api/push/vapid-key   — return VAPID public key (safe to expose)
// POST   /api/push/subscribe   — save or update push subscription
// DELETE /api/push/subscribe   — clear push subscription (opt-out)
// GET    /api/push/test        — debug: test push from Worker env (temp)

import { requireAuth }             from './auth.js';
import { json, err400, err401 }    from './utils.js';
import { sendPush }                from './push.js';

// ── GET /api/push/vapid-key ───────────────────────────────────────────────────
// The VAPID public key is safe to expose — it is not a secret.
// The client needs it to call pushManager.subscribe({ applicationServerKey }).

export async function handleVapidKey(_request, env) {
  if (!env.VAPID_PUBLIC_KEY) {
    return json({ error: 'Push notifications not configured on this server.' }, 503);
  }
  return json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY });
}

// ── POST /api/push/subscribe ──────────────────────────────────────────────────
// Body: PushSubscription JSON { endpoint, expirationTime, keys: { p256dh, auth } }
// Upserts into members.push_sub for the authenticated member.

export async function handleSubscribe(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  let sub;
  try { sub = await request.json(); } catch { return err400('Invalid JSON'); }

  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return err400('Invalid push subscription — endpoint, keys.p256dh, and keys.auth are required.');
  }

  await env.DB.prepare(
    `UPDATE members SET push_sub = ? WHERE id = ?`
  ).bind(JSON.stringify(sub), session.sub).run();

  console.log(`[subscribe] Push subscription saved for member ${session.sub}`);
  return json({ ok: true });
}

// ── GET /api/push/test ────────────────────────────────────────────────────────
// Debug-only: sends a real push from the Worker env (not DO) so we can confirm
// VAPID secrets are reachable here vs in the Durable Object alarm context.
// Remove after debugging is complete.

export async function handleTestPush(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  const debug = {
    VAPID_PUBLIC_KEY:  !!env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: !!env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT:     !!env.VAPID_SUBJECT,
    VAPID_PK_len:      env.VAPID_PUBLIC_KEY?.length  ?? 0,
    VAPID_SK_len:      env.VAPID_PRIVATE_KEY?.length ?? 0,
    VAPID_SUB_len:     env.VAPID_SUBJECT?.length     ?? 0,
  };

  const { results } = await env.DB.prepare(
    'SELECT push_sub FROM members WHERE id = ?'
  ).bind(session.sub).all();

  const sub = results[0]?.push_sub ? JSON.parse(results[0].push_sub) : null;
  if (!sub) return json({ ok: false, error: 'no_subscription_in_db', debug });

  const result = await sendPush(
    sub,
    { title: 'PASS Buddy Test', body: 'Push is working from Worker context.', tag: 'push-test' },
    env
  );

  return json({ ok: result.ok, push: result, debug });
}

// ── DELETE /api/push/subscribe ────────────────────────────────────────────────
// Clears push subscription for the authenticated member.
// Called on explicit opt-out or when browser revokes permission.

export async function handleUnsubscribe(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  await env.DB.prepare(
    `UPDATE members SET push_sub = NULL WHERE id = ?`
  ).bind(session.sub).run();

  console.log(`[subscribe] Push subscription cleared for member ${session.sub}`);
  return json({ ok: true });
}
