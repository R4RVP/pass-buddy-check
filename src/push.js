/**
 * src/push.js — Web Push dispatch (VAPID + RFC 8291 aes128gcm)
 *
 * Uses the Web Crypto API. No external dependencies.
 * Compatible with Cloudflare Workers.
 *
 * References:
 *   RFC 8291 — Message Encryption for Web Push
 *   RFC 8292 — Voluntary Application Server Identification (VAPID)
 *   RFC 8188 — Encrypted Content-Encoding for HTTP
 */

const ENC = new TextEncoder();

// ── base64url helpers ─────────────────────────────────────────────────────────

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function unb64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// ── Uint8Array concat ─────────────────────────────────────────────────────────

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let   off   = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── HKDF-SHA-256 ─────────────────────────────────────────────────────────────
// Only computes T(1), so L must be ≤ 32.
// All our use cases: L=32 (IKM), L=16 (CEK), L=12 (nonce) — all within range.

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey(
    'raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  // T(1) = HMAC(PRK, info || 0x01)
  const t = await crypto.subtle.sign('HMAC', key, concat(info, new Uint8Array([1])));
  return new Uint8Array(t).slice(0, length);
}

// ── RFC 8291 + RFC 8188 payload encryption ────────────────────────────────────

async function encryptPayload(subscription, message) {
  const p256dh = unb64url(subscription.keys.p256dh);
  const auth   = unb64url(subscription.keys.auth);
  const plain  = ENC.encode(message);

  // Import receiver's (UA) public key
  const receiverKey = await crypto.subtle.importKey(
    'raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // Generate ephemeral sender key pair
  const senderPair   = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const senderPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderPair.publicKey)
  );

  // ECDH shared secret (256 bits = 32 bytes)
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: receiverKey }, senderPair.privateKey, 256
    )
  );

  // RFC 8291 §3.3: derive IKM
  //   ikm_info = "WebPush: info\0" || ua_pub(65B) || as_pub(65B)
  //   PRK      = HKDF-Extract(salt=auth_secret, IKM=ecdh_secret)
  //   IKM      = HKDF-Expand(PRK, ikm_info, L=32)
  const ikmInfo = concat(ENC.encode('WebPush: info\0'), p256dh, senderPubRaw);
  const prk1    = await hkdfExtract(auth, ecdhSecret);
  const ikm     = await hkdfExpand(prk1, ikmInfo, 32);

  // Random 16-byte salt for RFC 8188
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8188 §2.3: derive CEK (16B) and nonce (12B)
  //   PRK  = HKDF-Extract(salt, IKM)
  //   CEK  = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  //   NONCE = HKDF-Expand(PRK, "Content-Encoding: nonce\0",    12)
  const prk2  = await hkdfExtract(salt, ikm);
  const cek   = await hkdfExpand(prk2, ENC.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk2, ENC.encode('Content-Encoding: nonce\0'), 12);

  // AES-128-GCM encrypt
  //   Plaintext = message || 0x02   (0x02 = last-record delimiter, RFC 8188)
  const aesKey    = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      concat(plain, new Uint8Array([2]))
    )
  );

  // RFC 8188 §2.1 content header:
  //   [salt(16)] [rs(4, big-endian)] [idlen(1)] [keyid=senderPub(idlen)] [ciphertext]
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096, false); // record size (big-endian)

  return concat(
    salt,
    rsBytes,
    new Uint8Array([senderPubRaw.length]),
    senderPubRaw,
    encrypted
  );
}

// ── VAPID JWT (RFC 8292) ──────────────────────────────────────────────────────

async function buildVapidJwt(endpoint, vapidPublicB64, vapidPrivateB64, subject) {
  const url      = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const exp      = Math.floor(Date.now() / 1000) + 43200; // 12-hour expiry

  const header  = b64url(ENC.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(ENC.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const sigInput = ENC.encode(`${header}.${payload}`);

  // Reconstruct JWK from raw VAPID key bytes
  // VAPID_PUBLIC_KEY  = base64url(uncompressed P-256 point, 65 bytes: 0x04 || x || y)
  // VAPID_PRIVATE_KEY = base64url(raw 32-byte scalar)
  const pubBytes = unb64url(vapidPublicB64);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: vapidPrivateB64,                    // private scalar
    x: b64url(pubBytes.slice(1, 33)),      // x coordinate (bytes 1–32)
    y: b64url(pubBytes.slice(33, 65)),     // y coordinate (bytes 33–64)
  };

  const signingKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );

  // Web Crypto returns IEEE P1363 (r||s, 64 bytes for P-256) — correct for JWT ES256
  const sig = b64url(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, sigInput)
  );

  return `${header}.${payload}.${sig}`;
}

// ── Public: sendPush ──────────────────────────────────────────────────────────

/**
 * Send a Web Push notification to a member.
 *
 * @param {object|null} subscription
 *   The stored Web Push subscription (parsed JSON from members.push_sub).
 *   If null, returns { ok: false, reason: 'no_subscription' }.
 *
 * @param {object} notification
 *   Notification payload: { title, body, tag?, url?, requireInteraction? }
 *
 * @param {object} env
 *   Worker env — needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
 *
 * @returns {{ ok: boolean, status?: number, reason?: string, gone?: boolean }}
 *   gone=true means the subscription is expired; caller should clear push_sub in DB.
 */
export async function sendPush(subscription, notification, env) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    const missing = [];
    if (!VAPID_PUBLIC_KEY)  missing.push('VAPID_PUBLIC_KEY');
    if (!VAPID_PRIVATE_KEY) missing.push('VAPID_PRIVATE_KEY');
    if (!VAPID_SUBJECT)     missing.push('VAPID_SUBJECT');
    console.warn('[push] VAPID secrets missing:', missing.join(', '));
    return { ok: false, reason: 'vapid_not_configured' };
  }

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return { ok: false, reason: 'no_subscription' };
  }

  let body;
  try {
    body = await encryptPayload(subscription, JSON.stringify(notification));
  } catch (e) {
    console.error('[push] Encryption failed:', e?.message);
    return { ok: false, reason: 'encryption_failed' };
  }

  let jwt;
  try {
    jwt = await buildVapidJwt(
      subscription.endpoint,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY,
      VAPID_SUBJECT
    );
  } catch (e) {
    console.error('[push] VAPID JWT failed:', e?.message);
    return { ok: false, reason: 'jwt_failed' };
  }

  let res;
  try {
    res = await fetch(subscription.endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Authorization':    `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
        'TTL':              '86400',
        'Urgency':          'high',
      },
      body,
    });
  } catch (e) {
    console.error('[push] Fetch to push endpoint failed:', e?.message);
    return { ok: false, reason: 'fetch_failed' };
  }

  // 410 Gone or 404 = subscription expired/removed; caller should clear push_sub
  if (res.status === 410 || res.status === 404) {
    console.warn(`[push] Subscription gone (${res.status}) — caller should clear push_sub`);
    return { ok: false, status: res.status, gone: true };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[push] Push service returned ${res.status}: ${text.slice(0, 200)}`);
    return { ok: false, status: res.status };
  }

  return { ok: true };
}
