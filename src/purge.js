// PASS Buddy Check — Purge job (M11)
// Runs on a Cloudflare Cron trigger (see wrangler.toml).
// Can also be triggered manually via POST /api/admin/purge (admin only).
//
// What it does:
//   1. Finds closed check-ins (checked_out | cancelled | overdue) older than PURGE_DAYS
//   2. Writes one anonymized row to analytics_events per check-in (no PII)
//   3. Deletes the check-in rows — notification_log rows cascade automatically
//
// analytics_events schema (no PII):
//   event_date      YYYY-MM-DD only
//   facility_code   facility_code from check-in, or 'UNKNOWN'
//   location_type   field | fire | bomb_threat | tornado | other
//   duration_bucket <1h | 1-4h | 4-8h | 8h+ | incomplete
//   eta_extended    1 if member updated ETA at least once, 0 otherwise

const PURGE_DAYS  = 7;
const BATCH_LIMIT = 100; // max check-ins per purge run

export async function handlePurge(env) {
  // Find closed check-ins older than PURGE_DAYS
  const { results } = await env.DB.prepare(`
    SELECT id, facility_code, location_type,
           checkin_at, checkout_at, eta_updated_count, status
    FROM   checkins
    WHERE  status IN ('checked_out', 'cancelled', 'overdue')
      AND  checkin_at < datetime('now', '-${PURGE_DAYS} days')
    ORDER  BY checkin_at ASC
    LIMIT  ${BATCH_LIMIT}
  `).all();

  if (!results.length) {
    console.log('[purge] Nothing to purge.');
    return { purged: 0, analytics: 0 };
  }

  // Build a D1 batch: one analytics INSERT + one checkin DELETE per row.
  // Batching keeps the operation atomic and avoids N round-trips.
  const statements = [];

  for (const c of results) {
    const eventDate   = (c.checkin_at ?? '').slice(0, 10);  // YYYY-MM-DD
    const facility    = c.facility_code ?? 'UNKNOWN';
    const bucket      = durationBucket(c.checkin_at, c.checkout_at);
    const etaExtended = (c.eta_updated_count ?? 0) > 0 ? 1 : 0;

    statements.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO analytics_events
          (id, event_date, facility_code, location_type, duration_bucket, eta_extended, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).bind(
        crypto.randomUUID(),
        eventDate,
        facility,
        c.location_type ?? null,
        bucket,
        etaExtended
      )
    );

    // DELETE cascades to notification_log (ON DELETE CASCADE)
    statements.push(
      env.DB.prepare(`DELETE FROM checkins WHERE id = ?`).bind(c.id)
    );
  }

  await env.DB.batch(statements);

  console.log(`[purge] Purged ${results.length} check-in(s); wrote ${results.length} analytics event(s).`);
  return { purged: results.length, analytics: results.length };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function durationBucket(checkinAt, checkoutAt) {
  if (!checkoutAt) return 'incomplete';
  const ms    = new Date(checkoutAt) - new Date(checkinAt);
  const hours = ms / 3_600_000;
  if (hours < 1) return '<1h';
  if (hours < 4) return '1-4h';
  if (hours < 8) return '4-8h';
  return '8h+';
}
