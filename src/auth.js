// PASS Buddy Check — Auth module
// JWT session management, OTP generation/verification, Twilio SMS stub

import { normalizePhone, json, err400, err401, err429 } from './utils.js';

const JWT_ALG        = { name: 'HMAC', hash: 'SHA-256' };
const OTP_TTL_SEC    = 600;   // 10 minutes
const OTP_MAX_REQ    = 3;     // per phone per window
const OTP_WINDOW_MIN = 10;
const DEV_OTP        = '123456'; // accepted when SMS_ENABLED=false

// ── JWT ───────────────────────────────────────────────────────────────────────

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), JWT_ALG, false, ['sign', 'verify']
  );
}

export async function signJwt(payload, secret, ttlSeconds = 86400) {
  const key  = await importHmacKey(secret);
  const now  = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + ttlSeconds };
  const hdr  = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const bdy  = b64url(new TextEncoder().encode(JSON.stringify(full)));
  const sig  = await crypto.subtle.sign(JWT_ALG, key, new TextEncoder().encode(`${hdr}.${bdy}`));
  return `${hdr}.${bdy}.${b64url(sig)}`;
}

export async function verifyJwt(token, secret) {
  try {
    const [h, b, s] = token.split('.');
    if (!h || !b || !s) return null;
    const key   = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      JWT_ALG, key, fromB64url(s), new TextEncoder().encode(`${h}.${b}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(b)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Session cookies ───────────────────────────────────────────────────────────

export function sessionCookie(token) {
  return `token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`;
}

export function clearCookie() {
  return `token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function tokenFromRequest(request) {
  const cookie = request.headers.get('Cookie') ?? '';
  return cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? null;
}

// ── Session middleware ────────────────────────────────────────────────────────

export async function requireAuth(request, env) {
  const token = tokenFromRequest(request);
  if (!token) return null;
  return verifyJwt(token, env.JWT_SECRET);
}

// ── OTP ───────────────────────────────────────────────────────────────────────

function generateOtp() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return String(new DataView(bytes.buffer).getUint32(0) % 1_000_000).padStart(6, '0');
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function handleRequestOtp(request, env) {
  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const phone = normalizePhone(body.phone);
  if (!phone) return err400('Invalid phone number format.');

  // Rate limit: max OTP_MAX_REQ per OTP_WINDOW_MIN minutes
  const windowStart = new Date(Date.now() - OTP_WINDOW_MIN * 60_000).toISOString();
  const { results: rateCnt } = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM otp_attempts WHERE phone = ? AND created_at > ?`
  ).bind(phone, windowStart).all();

  if ((rateCnt[0]?.cnt ?? 0) >= OTP_MAX_REQ) {
    return err429(`Too many requests. Try again in ${OTP_WINDOW_MIN} minutes.`);
  }

  // Check allowlist — only active members get a real OTP
  const { results: member } = await env.DB.prepare(
    `SELECT id FROM members WHERE phone = ? AND status = 'active'`
  ).bind(phone).all();

  if (member.length > 0) {
    const code    = generateOtp();
    const id      = crypto.randomUUID();
    const expires = new Date(Date.now() + OTP_TTL_SEC * 1_000).toISOString();

    await env.DB.prepare(
      `INSERT INTO otp_attempts (id, phone, code, expires_at) VALUES (?, ?, ?, ?)`
    ).bind(id, phone, code, expires).run();

    if (env.SMS_ENABLED === 'true') {
      await sendSms(phone, `Your PASS Buddy Check code is: ${code}. Valid for 10 minutes.`, env);
    } else {
      console.log(`[OTP STUB] ${phone} → ${code}  (expires ${expires})`);
    }
  }
  // Unknown numbers: same response, no signal either way

  return json({ ok: true, message: 'If your number is registered, you will receive a code shortly.' });
}

export async function handleVerifyOtp(request, env) {
  let body;
  try { body = await request.json(); } catch { return err400('Invalid JSON'); }

  const phone = normalizePhone(body.phone);
  const code  = String(body.code ?? '').replace(/\D/g, '');
  if (!phone || code.length !== 6) return err400('phone and 6-digit code are required.');

  const isDevBypass = env.SMS_ENABLED !== 'true' && code === DEV_OTP;

  let memberId;

  if (isDevBypass) {
    // Dev: skip OTP lookup — accept magic code for any active member
    const { results } = await env.DB.prepare(
      `SELECT id FROM members WHERE phone = ? AND status = 'active'`
    ).bind(phone).all();
    if (results.length === 0) return json({ error: 'Invalid code.' }, 401);
    memberId = results[0].id;
  } else {
    const now = new Date().toISOString();
    const { results } = await env.DB.prepare(
      `SELECT id FROM otp_attempts
       WHERE phone = ? AND code = ? AND used = 0 AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(phone, code, now).all();
    if (results.length === 0) return json({ error: 'Invalid or expired code.' }, 401);

    // Mark used so it can't be replayed
    await env.DB.prepare(`UPDATE otp_attempts SET used = 1 WHERE id = ?`)
      .bind(results[0].id).run();

    // Resolve member from phone
    const { results: members } = await env.DB.prepare(
      `SELECT id FROM members WHERE phone = ? AND status = 'active'`
    ).bind(phone).all();
    if (members.length === 0) return json({ error: 'Invalid code.' }, 401);
    memberId = members[0].id;
  }

  // Fetch full member + phone_uncertain flag from roster for session payload
  const { results: rows } = await env.DB.prepare(
    `SELECT m.id, m.name, m.org_level, m.unit_code, m.gov_device_disclosed,
            COALESCE(mr.phone_uncertain, 0) AS phone_uncertain
     FROM   members m
     LEFT JOIN member_roster mr ON mr.phone = m.phone
     WHERE  m.id = ?`
  ).bind(memberId).all();
  const m = rows[0];

  const token = await signJwt(
    { sub: m.id, phone, name: m.name, org_level: m.org_level },
    env.JWT_SECRET
  );

  return new Response(JSON.stringify({
    ok:     true,
    member: {
      id:                  m.id,
      name:                m.name,
      gov_device_disclosed: m.gov_device_disclosed === 1,
      phone_uncertain:      m.phone_uncertain === 1,
    },
  }), {
    status:  200,
    headers: {
      'Content-Type':           'application/json',
      'Set-Cookie':             sessionCookie(token),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status:  200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie':   clearCookie(),
    },
  });
}

// ── GET /api/me ───────────────────────────────────────────────────────────────
// Returns session member profile including phone_uncertain from roster.
// Called on every page load to restore session without re-authenticating.

export async function handleMe(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return json({ ok: false, authenticated: false }, 401);

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.name, m.phone, m.status, m.gov_device_disclosed, m.org_level,
            COALESCE(mr.phone_uncertain, 0) AS phone_uncertain
     FROM   members m
     LEFT JOIN member_roster mr ON mr.phone = m.phone
     WHERE  m.id = ?`
  ).bind(session.sub).all();

  if (!results.length) return json({ ok: false, authenticated: false }, 401);

  const m = results[0];
  return json({
    ok:                   true,
    authenticated:        true,
    id:                   m.id,
    name:                 m.name,
    phone:                m.phone,
    status:               m.status,
    org_level:            m.org_level,
    gov_device_disclosed: m.gov_device_disclosed === 1,
    phone_uncertain:      m.phone_uncertain === 1,
  });
}

// ── POST /api/me/disclosure ───────────────────────────────────────────────────
// Member acknowledges the government-device disclosure.
// Sets gov_device_disclosed = 1; disclosure screen is not shown again.

export async function handleDisclosure(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();

  await env.DB.prepare(
    `UPDATE members SET gov_device_disclosed = 1 WHERE id = ?`
  ).bind(session.sub).run();

  return json({ ok: true });
}

// ── Twilio SMS (Phase 2) ──────────────────────────────────────────────────────

async function sendSms(to, body, env) {
  const params = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    }
  );
  if (!res.ok) console.error(`[Twilio] SMS to ${to} failed:`, await res.text());
}

