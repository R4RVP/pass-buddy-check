/**
 * CheckinAlarmDO — Durable Object for scheduled check-in alerts
 *
 * Milestone 0: Stub — structure and scheduling logic in place.
 * Full notification implementation added in M7.
 *
 * Each active check-in gets its own DO instance, keyed by check-in ID.
 * Scheduling:
 *   Alarm 1 (reminder):  expected_out_at − 15 minutes → push to member
 *   Alarm 2 (overdue):   expected_out_at + grace_minutes → push to buddy + safety contact
 *
 * Because Cloudflare Durable Objects support one alarm at a time, we chain them:
 * the reminder alarm fires first, sends the push, then schedules the overdue alarm.
 */
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

    if (action === 'schedule') {
      return this.handleSchedule(body);
    }

    if (action === 'reschedule') {
      // Called when member updates their ETA
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

    // Persist state so the alarm handler knows what to do
    await this.state.storage.put('checkinId',      checkinId);
    await this.state.storage.put('expectedOutAt',  expectedOutAt);
    await this.state.storage.put('graceMinutes',   graceMinutes);
    await this.state.storage.put('phase',          'reminder'); // which alarm fires next

    // Schedule the reminder alarm (or jump straight to overdue if past reminder window)
    const reminderMs = expectedMs - 15 * 60 * 1000;
    const nextAlarm  = reminderMs > now ? reminderMs : expectedMs + graceMinutes * 60 * 1000;

    if (nextAlarm > now) {
      await this.state.storage.setAlarm(nextAlarm);
      console.log(`[AlarmDO] Scheduled ${checkinId}: phase=${reminderMs > now ? 'reminder' : 'overdue'} at ${new Date(nextAlarm).toISOString()}`);
      return Response.json({ ok: true, checkinId, nextAlarm: new Date(nextAlarm).toISOString() });
    }

    // Check-in is already past overdue window — fire immediately
    console.warn(`[AlarmDO] Check-in ${checkinId} is already past overdue window`);
    ctx?.waitUntil?.(this.fireOverdue(checkinId));
    return Response.json({ ok: true, checkinId, immediate: true });
  }

  // ── Alarm handler ──────────────────────────────────────────────────────────
  // Called automatically by Cloudflare when the scheduled time arrives.
  async alarm() {
    const checkinId     = await this.state.storage.get('checkinId');
    const expectedOutAt = await this.state.storage.get('expectedOutAt');
    const graceMinutes  = await this.state.storage.get('graceMinutes') ?? 30;
    const phase         = await this.state.storage.get('phase') ?? 'overdue';

    if (!checkinId) {
      console.warn('[AlarmDO] alarm() fired but no checkinId in storage — ignoring');
      return;
    }

    console.log(`[AlarmDO] Alarm fired: checkin=${checkinId} phase=${phase}`);

    if (phase === 'reminder') {
      await this.fireReminder(checkinId);

      // Chain: schedule overdue alarm
      const overdueMs = new Date(expectedOutAt).getTime() + graceMinutes * 60 * 1000;
      const now       = Date.now();
      if (overdueMs > now) {
        await this.state.storage.put('phase', 'overdue');
        await this.state.storage.setAlarm(overdueMs);
        console.log(`[AlarmDO] Chained overdue alarm for ${checkinId} at ${new Date(overdueMs).toISOString()}`);
      } else {
        // Overdue window already passed — fire immediately
        await this.fireOverdue(checkinId);
      }
    } else {
      await this.fireOverdue(checkinId);
    }
  }

  // ── Notification dispatchers (M7 implementation) ───────────────────────────
  async fireReminder(checkinId) {
    // M7: load check-in from DB, send push to member, log to notification_log
    console.log(`[AlarmDO] STUB fireReminder — checkin=${checkinId} — full impl in M7`);
  }

  async fireOverdue(checkinId) {
    // M7: verify status still 'active', set status='overdue', push to buddy + safety contact
    console.log(`[AlarmDO] STUB fireOverdue  — checkin=${checkinId} — full impl in M7`);
  }
}
