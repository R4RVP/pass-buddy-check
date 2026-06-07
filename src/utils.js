// PASS Buddy Check — shared utilities

// Normalize a US phone number to E.164 (+1XXXXXXXXXX).
// Accepts: 10-digit, 11-digit starting with 1, and common formatted variants.
export function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10)                      return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
  });
}

export const err400 = msg  => json({ error: msg }, 400);
export const err401 = ()   => json({ error: 'Unauthorized' }, 401);
export const err403 = ()   => json({ error: 'Forbidden' }, 403);
export const err404 = ()   => json({ error: 'Not found' }, 404);
export const err409 = msg  => json({ error: msg }, 409);
export const err429 = msg  => json({ error: msg }, 429);
