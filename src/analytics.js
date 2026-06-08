// PASS Buddy Check — Analytics module (M12)
// Read-only aggregate view of anonymized check-in data.
// All data comes from analytics_events — no PII in this table.
// Access gated by ADMIN_PHONES (same as admin panel).

import { requireAuth }           from './auth.js';
import { hasAdminAccess }        from './admin.js';
import { json, err401, err403 }  from './utils.js';

// ── GET /api/admin/analytics ──────────────────────────────────────────────────
// Returns aggregate stats:
//   summary        — totals + ETA-extended rate
//   by_location    — count per location_type
//   by_duration    — count per duration_bucket (ordered)
//   top_facilities — top-10 facilities by check-in count
//   daily_30d      — daily check-in counts for the last 30 calendar days

export async function handleAdminAnalytics(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return err401();
  if (!hasAdminAccess(session, env)) return err403();

  // Run all queries in one D1 batch for a single round-trip
  const [
    summaryRes,
    last7dRes,
    last30dRes,
    byLocationRes,
    byDurationRes,
    topFacilitiesRes,
    daily30dRes,
  ] = await env.DB.batch([
    // Overall totals
    env.DB.prepare(`
      SELECT COUNT(*)           AS total,
             SUM(eta_extended)  AS eta_extended_total
      FROM   analytics_events
    `),
    // Last 7 days
    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM   analytics_events
      WHERE  event_date >= date('now', '-7 days')
    `),
    // Last 30 days
    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM   analytics_events
      WHERE  event_date >= date('now', '-30 days')
    `),
    // By location type
    env.DB.prepare(`
      SELECT COALESCE(location_type, 'unknown') AS location_type,
             COUNT(*) AS count
      FROM   analytics_events
      GROUP  BY location_type
      ORDER  BY count DESC
    `),
    // By duration bucket (defined order)
    env.DB.prepare(`
      SELECT duration_bucket, COUNT(*) AS count
      FROM   analytics_events
      GROUP  BY duration_bucket
      ORDER  BY CASE duration_bucket
                  WHEN '<1h'        THEN 0
                  WHEN '1-4h'       THEN 1
                  WHEN '4-8h'       THEN 2
                  WHEN '8h+'        THEN 3
                  WHEN 'incomplete' THEN 4
                  ELSE 5
                END
    `),
    // Top 10 facilities
    env.DB.prepare(`
      SELECT facility_code, COUNT(*) AS count
      FROM   analytics_events
      WHERE  facility_code != 'UNKNOWN'
      GROUP  BY facility_code
      ORDER  BY count DESC
      LIMIT  10
    `),
    // Daily counts — last 30 calendar days
    env.DB.prepare(`
      SELECT event_date AS date, COUNT(*) AS count
      FROM   analytics_events
      WHERE  event_date >= date('now', '-29 days')
      GROUP  BY event_date
      ORDER  BY event_date ASC
    `),
  ]);

  const total          = summaryRes.results[0]?.total          ?? 0;
  const etaExtTotal    = summaryRes.results[0]?.eta_extended_total ?? 0;
  const last7d         = last7dRes.results[0]?.count   ?? 0;
  const last30d        = last30dRes.results[0]?.count  ?? 0;
  const etaExtPct      = total > 0 ? Math.round((etaExtTotal / total) * 100) : 0;

  return json({
    ok: true,
    summary: {
      total,
      last_7d:           last7d,
      last_30d:          last30d,
      eta_extended_total: etaExtTotal,
      eta_extended_pct:  etaExtPct,
    },
    by_location:  byLocationRes.results,
    by_duration:  byDurationRes.results,
    top_facilities: topFacilitiesRes.results,
    daily_30d:    daily30dRes.results,
  });
}
