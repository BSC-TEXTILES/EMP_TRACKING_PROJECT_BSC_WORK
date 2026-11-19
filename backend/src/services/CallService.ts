import { execute, queryOne } from '../db/index.js';
import { emitToEmployees } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import { PushService, type CallPushInfo } from './PushService.js';

/**
 * Server-side call lifecycle shared by the REST routes, the socket server and the scheduler.
 *
 * Ringing is driven by the server, not by the caller's browser:
 *  - the callee's devices get a high-priority push immediately (plus the socket event),
 *  - the push is repeated every RE_RING_SECONDS so the phone alerts again (a web
 *    notification cannot loop a ringtone by itself),
 *  - after RING_TIMEOUT_SECONDS the call becomes missed (end_reason no_answer), the
 *    ringing notification is replaced by "Missed call from X" on every device.
 * If the caller closes the app mid-ring, the call still ends correctly.
 */

export const RING_TIMEOUT_SECONDS = 45;
const RE_RING_SECONDS = 10;
/** A participant whose connection dropped has this long to rejoin before the call is ended. */
export const RECONNECT_GRACE_SECONDS = 20;

export type CallEndReason = 'no_answer' | 'cancelled' | 'declined' | 'busy' | 'completed' | 'disconnected' | 'failed';

export interface CallRecord {
  id: number;
  call_id: string;
  caller_id: number;
  callee_id: number;
  type: 'audio' | 'video';
  status: string;
}

const ringers = new Map<string, { timer: NodeJS.Timeout; startedAt: number; attempt: number; info: CallPushInfo; calleeId: number }>();
const graceTimers = new Map<string, NodeJS.Timeout>();

export async function loadCall(callId: string): Promise<CallRecord | null> {
  return queryOne<CallRecord>('SELECT id, call_id, caller_id, callee_id, type, status FROM calls WHERE call_id = ?', [callId]);
}

async function callerInfo(call: CallRecord): Promise<CallPushInfo> {
  const caller = await queryOne<{ full_name: string; photo_url: string | null }>(
    'SELECT full_name, photo_url FROM employees WHERE id = ?',
    [call.caller_id],
  );
  return {
    callId: call.call_id,
    type: call.type,
    callerId: Number(call.caller_id),
    callerName: caller?.full_name ?? 'A colleague',
    callerPhoto: caller?.photo_url ?? null,
  };
}

export async function markCallNotificationRead(employeeId: number, callId: string): Promise<void> {
  await execute(
    `UPDATE notification_recipients nr
     JOIN notifications n ON n.id = nr.notification_id
     SET nr.read_at = NOW(3)
     WHERE nr.employee_id = ? AND n.dedupe_key = ? AND nr.read_at IS NULL`,
    [employeeId, `call_${callId}`],
  );
}

async function notifyMissed(call: CallRecord, info: CallPushInfo): Promise<void> {
  // In-app record (notification centre, missed-call badge). The phone alert is the call push below.
  await NotificationService.notify({
    employeeIds: [Number(call.callee_id)],
    type: 'missed_call',
    title: `Missed ${call.type === 'video' ? 'video' : 'voice'} call`,
    body: `Missed call from ${info.callerName}`,
    link: '/calls',
    priority: 'high',
    actorId: Number(call.caller_id),
    dedupeKey: `missed_${call.call_id}`,
    skipPush: true,
  });
  await PushService.sendCall(Number(call.callee_id), 'call_missed', info);
}

// ------------------------------------------------------------------ ringing

/** Starts server-driven ringing: first push now, re-ring, expire at the timeout. */
export async function startRinging(call: CallRecord): Promise<void> {
  stopRinging(call.call_id);
  const info = await callerInfo(call);
  const startedAt = Date.now();
  const expiresAt = startedAt + RING_TIMEOUT_SECONDS * 1000;
  const state = { timer: setTimeout(() => undefined, 0), startedAt, attempt: 1, info: { ...info, expiresAt }, calleeId: Number(call.callee_id) };
  ringers.set(call.call_id, state);
  void PushService.sendCall(state.calleeId, 'call_ring', { ...state.info, attempt: 1 });
  scheduleTick(call.call_id);
}

function scheduleTick(callId: string): void {
  const state = ringers.get(callId);
  if (!state) return;
  const remaining = state.startedAt + RING_TIMEOUT_SECONDS * 1000 - Date.now();
  const delay = Math.max(250, Math.min(RE_RING_SECONDS * 1000, remaining));
  state.timer = setTimeout(() => void tick(callId), delay);
  state.timer.unref?.();
}

async function tick(callId: string): Promise<void> {
  const state = ringers.get(callId);
  if (!state) return;
  try {
    const call = await loadCall(callId);
    if (!call || call.status !== 'ringing') {
      ringers.delete(callId);
      return;
    }
    if (Date.now() >= state.startedAt + RING_TIMEOUT_SECONDS * 1000) {
      ringers.delete(callId);
      await endRingingCall(call, 'missed', 'no_answer');
      return;
    }
    state.attempt += 1;
    void PushService.sendCall(state.calleeId, 'call_ring', { ...state.info, attempt: state.attempt });
    scheduleTick(callId);
  } catch (error) {
    console.error('[calls] ring tick failed', (error as Error).message);
    scheduleTick(callId);
  }
}

export function stopRinging(callId: string): void {
  const state = ringers.get(callId);
  if (state) clearTimeout(state.timer);
  ringers.delete(callId);
}

/**
 * Ends a call that is still ringing. Returns false when another request already
 * changed it (accepted, declined elsewhere): every transition is a guarded UPDATE.
 */
export async function endRingingCall(
  call: CallRecord,
  status: 'missed' | 'declined',
  reason: CallEndReason,
): Promise<boolean> {
  const changed = await execute(
    "UPDATE calls SET status = ?, end_reason = ?, ended_at = NOW(3) WHERE id = ? AND status = 'ringing'",
    [status, reason, call.id],
  );
  if (changed.affectedRows !== 1) return false;
  stopRinging(call.call_id);

  const participants = [Number(call.caller_id), Number(call.callee_id)];
  if (status === 'declined') {
    emitToEmployees([Number(call.caller_id)], 'call:rejected', { callId: call.call_id });
    emitToEmployees(participants, 'call:ended', { callId: call.call_id, reason: 'rejected' });
    await markCallNotificationRead(Number(call.callee_id), call.call_id);
    // Close the ringing notification on the callee's other phones / browsers.
    void PushService.sendCall(Number(call.callee_id), 'call_cancel', await callerInfo(call));
  } else {
    emitToEmployees([Number(call.caller_id)], 'call:missed', { callId: call.call_id });
    emitToEmployees(participants, 'call:ended', { callId: call.call_id, reason: 'no_answer' });
    await markCallNotificationRead(Number(call.callee_id), call.call_id);
    await notifyMissed(call, await callerInfo(call));
  }
  return true;
}

/** Callee answered on one device: stop ringing everywhere else. */
export async function onAccepted(call: CallRecord): Promise<void> {
  stopRinging(call.call_id);
  await markCallNotificationRead(Number(call.callee_id), call.call_id);
  void PushService.sendCall(Number(call.callee_id), 'call_cancel', await callerInfo(call));
}

/** Ends an active (connected) call and stores the server-measured duration. */
export async function endActiveCall(call: CallRecord, reason: CallEndReason): Promise<number | null> {
  const ended = await execute(
    `UPDATE calls SET status = 'completed', end_reason = ?, ended_at = NOW(3),
            duration_seconds = IF(accepted_at IS NULL, 0, GREATEST(0, TIMESTAMPDIFF(SECOND, accepted_at, NOW(3))))
     WHERE id = ? AND status = 'active'`,
    [reason, call.id],
  );
  if (ended.affectedRows !== 1) return null;
  const row = await queryOne<{ d: number }>('SELECT duration_seconds AS d FROM calls WHERE id = ?', [call.id]);
  const duration = Number(row?.d ?? 0);
  emitToEmployees([Number(call.caller_id), Number(call.callee_id)], 'call:ended', {
    callId: call.call_id,
    reason: reason === 'disconnected' ? 'disconnected' : 'ended',
    duration,
  });
  return duration;
}

// ------------------------------------------------------- reconnect grace period

function graceKey(callId: string, employeeId: number): string {
  return `${callId}:${employeeId}`;
}

/**
 * A participant's last socket left the call room without hanging up (network
 * drop, app frozen). Give them RECONNECT_GRACE_SECONDS to rejoin; otherwise end
 * the call in the database so neither side stays "busy".
 */
export function scheduleDisconnectEnd(callId: string, employeeId: number, stillConnected: () => Promise<boolean>): void {
  const key = graceKey(callId, employeeId);
  clearTimeout(graceTimers.get(key));
  const timer = setTimeout(async () => {
    graceTimers.delete(key);
    try {
      if (await stillConnected()) return;
      const call = await loadCall(callId);
      if (!call) return;
      if (call.status === 'active') await endActiveCall(call, 'disconnected');
      else if (call.status === 'ringing' && Number(call.caller_id) === employeeId) {
        // Caller vanished while ringing: the callee still sees it as a missed call.
        await endRingingCall(call, 'missed', 'cancelled');
      }
    } catch (error) {
      console.error('[calls] disconnect cleanup failed', (error as Error).message);
    }
  }, RECONNECT_GRACE_SECONDS * 1000);
  timer.unref?.();
  graceTimers.set(key, timer);
}

export function cancelDisconnectEnd(callId: string, employeeId: number): void {
  const key = graceKey(callId, employeeId);
  const timer = graceTimers.get(key);
  if (timer) clearTimeout(timer);
  graceTimers.delete(key);
}
