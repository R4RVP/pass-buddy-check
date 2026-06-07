/**
 * CheckinAlarmDO — Durable Object for scheduled check-in alerts
 *
 * M7: Full notification dispatch implemented.
 *
 * Each active check-in gets its own DO instance, keyed by member_id.
 * Scheduling:
 *   Alarm 1 (reminder):  expected_out_at − 15 minutes → push to member
 *   Alarm 2 (overdue):   expected_out_at + grace_minutes → push to member + SMS to buddy
 *
 * Because Cloudflare Durable Objects support one alarm at a time, we chain them:
 * the reminder alarm fires first, sends the push, then schedules the overdue alarm.
 */

import { sendPush } from '../push.js';

export class CheckinAlarmDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  // ── Fetch handler ──────────────────────────────────────────────────────────
  // Called by the Worker to schedule or cancel alarms for a check-in.
  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { action } = body;

    if (action === 'schedule' || action === 'reschedule') {
      return this.handleSchedule(body);
    }

    if (action === 'cancel') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true, cancelled: true });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  // ── Schedule alarms ────────────────────────────────────────────────────────
  async handleSchedule({ checkinId, expectedOutAt, graceMinutes = 30 }) {
    if (!checkinId || !expectedOutAt) {
      return Response.json({ error: 'checkinId and expectedOutAt are required' }, { status: 400 });
    }

    const expectedMs = new Date(expectedOutAt).getTime();
    const now        = Date.now();

    if (isNaN(expectedMs)) {
      return Response.json({ error: 'Invalid expectedOutAt timestamp' }, { status: 400 });
    }

    // Persist state so alarm() knows what to do when it fires
    await this.state.storage.put('checkinId',     checkinId);
    await this.state.storage.put('expectedOutAt', expectedOutAt);
    await this.state.storage.put('graceMinutes',  graceMinutes);

    // Determine which phase fires first
    const reminderMs  = expectedMs - 15 * 60 * 1000;
    const targetPhase = reminderMs > now ? 'reminder' : 'overdue';
    const nextAlarm   = targetPhase === 'reminder'
      ? reminderMs
      : expectedMs + graceMinutes * 60 * 1000;

    await this.state.storage.put('phase', targetPhase);

    if (nextAlarm > now) {
      await this.state.storage.setAlarm(nextAlarm);
      console.log(`[AlarmDO] Scheduled ${checkinId}: phase=${targetPhase} at ${new Date(nextAlarm).toISOString()}`);
      return Response.json({ ok: true, checkinId, nextAlarm: new Date(nextAlarm).toISOString() });
    }

    // Both windows have already passed — fire overdue immediately
    console.warn(`[AlarmDO] Check-in ${checkinId} is already past overdue window — firing immediately`);
    await this.fireOverdue(checkinId);
    return Response.json({ ok: true, checkinId, immediate: true });
  }

  // ── Alarm handler ──────────────────────────────────────────────────────────
  // Called automatically by Cloudflare when the scheduled time arrives.
  async alarm() {
    const checkinId     = await this.state.storage.get('checkinId');
    const expectedOutAt = await this.state.storage.get('expectedOutAt');
    const graceMinutes  = (await this.state.storage.get('graceMinutes')) ?? 30;
    const phase         = (await this.state.storage.get('phase')) ?? 'overdue';

    if (!checkinId) {
      console.warn('[AlarmDO] alarm() fired but no checkinId in storage — ignoring');
      return;
    }

    console.log(`[AlarmDO] Alarm fired: checkin=${checkinId} phase=${phase}`);

    if (phase === 'reminder') {
      await this.fireReminder(checkinId);

      // Chain: schedule the overdue alarm
      const overdueMs = new Date(expectedOutAt).getTime() + graceMinutes * 60 * 1000;
      const now       = Date.now();

      if (overdueMs > now) {
        await this.state.storage.put('phase', 'overdue');
        await this.state.storage.setAlarm(overdueMs);
        console.log(`[AlarmDO] Chained overdue alarm for ${checkinId} at ${new Date(overdueMs).toISOString()}`);
      } else {
        // Overdue window already passed while reminder was in flight
        await this.fireOverdue(checkinId);
      }
    } else {
      await this.fireOverdue(checkinId);
    }
  }

  // ── fireReminder ───────────────────────────────────────────────────────────
  // Fires ~15 minutes before ETA. Sends a heads-up push to the member.
  async fireReminder(checkinId) {
    const env = this.env;

    // Load check-in + member data from D1
    const { results } = await env.DB.prepare(`
      SELECT c.id, c.status, c.location_label, c.expected_out_at,
             m.id   AS member_id,
             m.name AS member_name,
             m.push_sub
      FROM   checkins c
      JOIN   members  m ON m.id = c.member_id
      WHERE  c.id = ?
    `).bind(checkinId).all();

    if (!results.length) {
      console.warn(`[AlarmDO] fireReminder: check-in ${checkinId} not found in DB`);
      return;
    }

    const row = results[0];

    // Guard: member may have already checked out between scheduling and firing
    if (row.status !== 'active') {
      console.log(`[AlarmDO] fireReminder: ${checkinId} status=${row.status} — skipping`);
      return;
    }

    // ── Push to member ─────────────────────────────────────────────────────
    const subscription = row.push_sub ? JSON.parse(row.push_sub) : null;
    const pushResult   = await sendPush(
      subscription,
      {
        title: '⏱ 15-Minute Warning',
        body:  `You're expected back from "${row.location_label}" soon. Check out when you return safely.`,
        tag:   'buddy-check-reminder',
        url:   '/',
      },
      env
    );

    // Clear expired subscription from DB
    if (pushResult.gone) {
      await env.DB.prepare(`UPDATE members SET push_sub = NULL WHERE id = ?`)
        .bind(row.member_id).run();
    }

    // Mark reminder sent on the check-in record
    await env.DB.prepare(
      `UPDATE checkins SET reminder_sent_at = datetime('now') WHERE id = ?`
    ).bind(checkinId).run();

    // Log to notification_log
    const logStatus = pushResult.ok                  ? 'sent'
      : pushResult.reason === 'vapid_not_configured' ? 'stubbed'
      : pushResult.reason === 'no_subscription'      ? 'stubbed'
      : 'failed';

    await env.DB.prepare(`
      INSERT INTO notification_log
        (id, checkin_id, recipient_type, channel, event, status, sent_at)
      VALUES (?, ?, 'member', 'push', 'reminder', ?, datetime('now'))
    `).bind(crypto.randomUUID(), checkinId, logStatus).run().catch(e =>
      console.error('[AlarmDO] fireReminder notification_log insert failed:', e?.message)
    );

    console.log(`[AlarmDO] fireReminder: ${row.member_name} @ "${row.location_label}" — push: ${pushResult.ok ? 'sent' : (pushResult.reason ?? 'failed')}`);
  }

  // ── fireOverdue ────────────────────────────────────────────────────────────
  // Fires at ETA + grace_minutes. Sets status='overdue'.
  // Pushes overdue alert to member; sends SMS to buddy (stubbed when SMS_ENABLED=false).
  async fireOverdue(checkinId) {
    const env = this.env;

    // Load check-in + member data from D1
    const { results } = await env.DB.prepare(`
      SELECT c.id, c.status, c.location_label,
             c.buddy_name, c.buddy_phone, c.buddy_email,
             m.id   AS member_id,
             m.name AS member_name,
             m.push_sub
      FROM   checkins c
      JOIN   members  m ON m.id = c.member_id
      WHERE  c.id = ?
    `).bind(checkinId).all();

    if (!results.length) {
      console.warn(`[AlarmDO] fireOverdue: check-in ${checkinId} not found in DB`);
      return;
    }

    const row = results[0];

    // Guard: member may have already checked out since alarm was scheduled
    if (row.status !== 'active') {
      console.log(`[AlarmDO] fireOverdue: ${checkinId} status=${row.status} — skipping`);
      return;
    }

    // ── Mark overdue in DB ─────────────────────────────────────────────────
    // Use AND status='active' to prevent a race if checkout happened mid-flight
    await env.DB.prepare(`
      UPDATE checkins
      SET    status = 'overdue', overdue_alerted_at = datetime('now')
      WHERE  id = ? AND status = 'active'
    `).bind(checkinId).run();

    // ── Push overdue alert to member ───────────────────────────────────────
    const subscription = row.push_sub ? JSON.parse(row.push_sub) : null;
    const memberPush   = await sendPush(
      subscription,
      {
        title: '⚠️ Check-in Overdue',
        body:  `You're past your return time from "${row.location_label}". Please check out or update your ETA.`,
        tag:   'buddy-check-overdue',
        url:   '/',
      },
      env
    );

    // Clear expired subscription from DB
    if (memberPush.gone) {
      await env.DB.prepare(`UPDATE members SET push_sub = NULL WHERE id = ?`)
        .bind(row.member_id).run();
    }

    // Log member push
    const memberLogStatus = memberPush.ok                  ? 'sent'
      : memberPush.reason === 'vapid_not_configured'       ? 'stubbed'
      : memberPush.reason === 'no_subscription'            ? 'stubbed'
      : 'failed';

    await env.DB.prepare(`
      INSERT INTO notification_log
        (id, checkin_id, recipient_type, channel, event, status, sent_at)
      VALUES (?, ?, 'member', 'push', 'overdue', ?, datetime('now'))
    `).bind(crypto.randomUUID(), checkinId, memberLogStatus).run().catch(e =>
      console.error('[AlarmDO] fireOverdue member push log failed:', e?.message)
    );

    // ── SMS to buddy ───────────────────────────────────────────────────────
    const buddySmsBody = `PASS Buddy Check Alert: ${row.member_name} is overdue from "${row.location_label}" and has not checked out. Please check on them.`;
    const smsResult    = await this.sendSms(row.buddy_phone, buddySmsBody);

    await env.DB.prepare(`
      INSERT INTO notification_log
        (id, checkin_id, recipient_type, channel, event, status, payload, sent_at)
      VALUES (?, ?, 'buddy', 'sms', 'overdue', ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      checkinId,
      smsResult.ok ? 'sent' : (smsResult.stubbed ? 'stubbed' : 'failed'),
      JSON.stringify({ to: row.buddy_phone, body: buddySmsBody })
    ).run().catch(e =>
      console.error('[AlarmDO] fireOverdue buddy SMS log failed:', e?.message)
    );

    console.log(
      `[AlarmDO] fireOverdue: ${row.member_name} overdue @ "${row.location_label}"` +
      ` — member push: ${memberPush.ok ? 'sent' : (memberPush.reason ?? 'failed')}` +
      ` | buddy SMS (${row.buddy_phone}): ${smsResult.ok ? 'sent' : (smsResult.stubbed ? 'stubbed' : 'failed')}`
    );
  }

  // ── sendSms ────────────────────────────────────────────────────────────────
  // Sends an outbound SMS via Twilio, or stubs when SMS_ENABLED=false.
  // Mirrors the sendSms function in auth.js.
  // Returns: { ok: true } | { ok: false, stubbed: true } | { ok: false, error: string }
  async sendSms(to, body) {
    const env = this.env;

    if (env.SMS_ENABLED !== 'true') {
      console.log(`[AlarmDO] sendSms STUBBED → ${to}: ${body}`);
      return { ok: false, stubbed: true };
    }

    try {
      const params = new URLSearchParams({
        To:   to,
        From: env.TWILIO_FROM_NUMBER,
        Body: body,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/x-www-form-urlencoded',
            'Authorization': `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
          },
          body: params.toString(),
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[AlarmDO] sendSms Twilio error ${res.status}: ${text}`);
        return { ok: false, error: `HTTP ${res.status}` };
      }

      return { ok: true };
    } catch (e) {
      console.error('[AlarmDO] sendSms fetch error:', e?.message);
      return { ok: false, error: e?.message ?? 'unknown' };
    }
  }
}
