import { execute, query, queryOne } from '../db/index.js';
import { callReach, emitToEmployees, isOnline } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import { PushService } from './PushService.js';
/**
 * Server-side call lifecycle shared by the REST routes, the socket server and the scheduler.
 *
 * Ringing is driven by the server, not by the caller's browser, and it is honest:
 *  - The call starts as "calling". The caller's screen only says "Ringing" once one of the
 *    callee's devices CONFIRMS it is ringing: a socket ack from an open app, the service
 *    worker's push receipt, or the native Android call service's receipt.
 *  - If nothing can reach the callee (no live connection, no registered device), the call is
 *    "unreachable" at once. If devices exist but none confirms within UNREACHABLE_AFTER_SECONDS
 *    (phone switched off, no internet), it becomes "unreachable" then, and the callee gets a
 *    missed-call push that is delivered when their phone comes back online.
 *  - Otherwise it rings until RING_TIMEOUT_SECONDS and becomes missed (end_reason no_answer).
 * Every transition is a guarded UPDATE (… WHERE status = 'ringing'), so two devices, a timer
 * and a late request can never both win.
 */
function envInt(name, fallback, min, max) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw) || raw <= 0)
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(raw)));
}
/** How long a call rings before it becomes a missed call. */
export const RING_TIMEOUT_SECONDS = envInt('CALL_RING_TIMEOUT_SECONDS', 30, 15, 120);
/** How long the caller waits for any device of the callee to confirm the ring before "unreachable". */
export const UNREACHABLE_AFTER_SECONDS = envInt('CALL_UNREACHABLE_SECONDS', 12, 5, RING_TIMEOUT_SECONDS - 3);
const RE_RING_SECONDS = 10;
/** A participant whose connection dropped has this long to rejoin before the call is ended. */
export const RECONNECT_GRACE_SECONDS = envInt('CALL_RECONNECT_GRACE_SECONDS', 20, 10, 120);
/** Someone seen online this recently most likely lost their internet; older than this, the device is off. */
const RECENTLY_ONLINE_SECONDS = 180;
export const UNREACHABLE_MESSAGES = {
    offline: 'User is offline or unreachable',
    device_unavailable: "User's device is unavailable",
};
const ringers = new Map();
const graceTimers = new Map();
export async function loadCall(callId) {
    return queryOne('SELECT id, call_id, caller_id, callee_id, type, status FROM calls WHERE call_id = ?', [callId]);
}
/** Append-only call audit trail (state transitions, device receipts). Never throws. */
export function logCallEvent(callId, employeeId, event, device, detail) {
    execute('INSERT INTO call_events (call_id, employee_id, event, device, detail) VALUES (?, ?, ?, ?, ?)', [callId.slice(0, 64), employeeId, event.slice(0, 40), device?.slice(0, 64) ?? null, detail ? JSON.stringify(detail) : null]).catch((error) => console.error('[calls] event log failed', error.message));
}
async function callerInfo(call) {
    const caller = await queryOne(`SELECT e.full_name, e.photo_url, e.employee_code, dg.title AS desig, l.code AS loc_code, l.name AS loc_name
     FROM employees e
     LEFT JOIN designations dg ON dg.id = e.designation_id
     LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.id = ?`, [call.caller_id]);
    return {
        callId: call.call_id,
        type: call.type,
        callerId: Number(call.caller_id),
        callerName: caller?.full_name ?? 'A colleague',
        callerPhoto: caller?.photo_url ?? null,
        callerCode: caller?.employee_code ?? null,
        callerDesignation: caller?.desig ?? null,
        callerLocationCode: caller?.loc_code ?? null,
        callerLocationName: caller?.loc_name ?? null,
    };
}
export async function markCallNotificationRead(employeeId, callId) {
    await execute(`UPDATE notification_recipients nr
     JOIN notifications n ON n.id = nr.notification_id
     SET nr.read_at = NOW(3)
     WHERE nr.employee_id = ? AND n.dedupe_key = ? AND nr.read_at IS NULL`, [employeeId, `call_${callId}`]);
}
/** A callee with a live connection saw the call end in the app; otherwise they are told on reconnect. */
async function markCalleeNotifiedIfOnline(call) {
    if (isOnline(Number(call.callee_id))) {
        await execute('UPDATE calls SET callee_notified_at = NOW(3) WHERE id = ? AND callee_notified_at IS NULL', [call.id]);
    }
}
async function notifyMissed(call, info) {
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
    // Queued by FCM / Web Push for 24 h: a phone that was off or offline gets it when it reconnects.
    await PushService.sendCall(Number(call.callee_id), 'call_missed', info);
}
// ------------------------------------------------------------------ ringing
function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
}
/**
 * Starts server-driven ringing. Returns "unreachable" immediately when the callee has no live
 * connection and no device that could be woken up; otherwise "calling" (waiting for a device to
 * confirm), and schedules the unreachable check and the no-answer timeout.
 */
export async function startRinging(call) {
    stopRinging(call.call_id);
    const info = await callerInfo(call);
    const startedAt = Date.now();
    const expiresAt = startedAt + RING_TIMEOUT_SECONDS * 1000;
    const calleeId = Number(call.callee_id);
    const reach = callReach(calleeId);
    const state = {
        timer: setTimeout(() => undefined, 0),
        reachTimer: null,
        startedAt,
        attempt: 1,
        info: { ...info, expiresAt },
        calleeId,
        unconfirmable: reach.legacySockets,
    };
    ringers.set(call.call_id, state);
    logCallEvent(call.call_id, Number(call.caller_id), 'initiated', null, { sockets: reach.sockets, legacySockets: reach.legacySockets });
    const push = PushService.sendCall(calleeId, 'call_ring', { ...state.info, attempt: 1 });
    // Wait briefly for the push transports to accept the message; a slow FCM never delays the caller much.
    const stats = await withTimeout(push, 4000);
    if (stats) {
        state.unconfirmable += stats.legacy;
        logCallEvent(call.call_id, null, 'push_sent', null, { ...stats });
    }
    else {
        // Still sending: count it as possibly reachable so the call is not declared dead prematurely.
        state.unconfirmable += 1;
        void push.then((late) => logCallEvent(call.call_id, null, 'push_sent', null, { ...late, late: true }));
    }
    const nothingToReach = reach.sockets === 0 && stats !== null && stats.sent === 0;
    if (nothingToReach) {
        const reason = await recentlyOnline(calleeId) ? 'offline' : 'device_unavailable';
        await endUnreachable(call, reason);
        return { state: 'unreachable', reason, message: UNREACHABLE_MESSAGES[reason] };
    }
    state.reachTimer = setTimeout(() => void checkReachability(call.call_id), UNREACHABLE_AFTER_SECONDS * 1000);
    state.reachTimer.unref?.();
    scheduleTick(call.call_id);
    return { state: 'calling' };
}
async function recentlyOnline(employeeId) {
    const row = await queryOne('SELECT (last_seen_at IS NOT NULL AND last_seen_at > DATE_SUB(NOW(3), INTERVAL ? SECOND)) AS recent FROM employees WHERE id = ?', [RECENTLY_ONLINE_SECONDS, employeeId]);
    return Boolean(Number(row?.recent ?? 0));
}
/** No device confirmed the ring in time: the callee is unreachable (unless an unconfirmable device might be ringing). */
async function checkReachability(callId) {
    const state = ringers.get(callId);
    if (!state)
        return;
    state.reachTimer = null;
    try {
        const row = await queryOne('SELECT id, call_id, caller_id, callee_id, type, status, delivered_at FROM calls WHERE call_id = ?', [callId]);
        if (!row || row.status !== 'ringing' || row.delivered_at)
            return;
        // Only devices that cannot confirm (older builds) keep the call alive without a receipt. A live,
        // up-to-date app acks within a second; a socket that stays silent belongs to a phone that was just
        // switched off or lost its network (Socket.IO notices that only after ~45 s), so it does not count.
        if (state.unconfirmable > 0)
            return;
        const reason = isOnline(state.calleeId) || (await recentlyOnline(state.calleeId)) ? 'offline' : 'device_unavailable';
        await endUnreachable(row, reason);
    }
    catch (error) {
        console.error('[calls] reachability check failed', error.message);
    }
}
function scheduleTick(callId) {
    const state = ringers.get(callId);
    if (!state)
        return;
    const remaining = state.startedAt + RING_TIMEOUT_SECONDS * 1000 - Date.now();
    const delay = Math.max(250, Math.min(RE_RING_SECONDS * 1000, remaining));
    state.timer = setTimeout(() => void tick(callId), delay);
    state.timer.unref?.();
}
async function tick(callId) {
    const state = ringers.get(callId);
    if (!state)
        return;
    try {
        const call = await loadCall(callId);
        if (!call || call.status !== 'ringing') {
            stopRinging(callId);
            return;
        }
        if (Date.now() >= state.startedAt + RING_TIMEOUT_SECONDS * 1000) {
            stopRinging(callId);
            await endRingingCall(call, 'missed', 'no_answer');
            return;
        }
        state.attempt += 1;
        void PushService.sendCall(state.calleeId, 'call_ring', { ...state.info, attempt: state.attempt });
        scheduleTick(callId);
    }
    catch (error) {
        console.error('[calls] ring tick failed', error.message);
        scheduleTick(callId);
    }
}
export function stopRinging(callId) {
    const state = ringers.get(callId);
    if (state) {
        clearTimeout(state.timer);
        if (state.reachTimer)
            clearTimeout(state.reachTimer);
    }
    ringers.delete(callId);
}
/**
 * One of the callee's devices confirmed it is ringing (socket ack, service-worker receipt or
 * native Android receipt). The first confirmation switches the caller from "Calling…" to "Ringing…".
 * Duplicates (several devices, repeated pushes) are harmless.
 */
export async function markDelivered(callId, calleeId, via, device) {
    const changed = await execute(`UPDATE calls SET delivered_at = NOW(3), delivered_via = ?
     WHERE call_id = ? AND callee_id = ? AND status = 'ringing' AND delivered_at IS NULL`, [via, callId, calleeId]);
    logCallEvent(callId, calleeId, 'ring_confirmed', device ?? via, { via, first: changed.affectedRows === 1 });
    if (changed.affectedRows !== 1)
        return false;
    const call = await loadCall(callId);
    if (call)
        emitToEmployees([Number(call.caller_id)], 'call:ringing', { callId, via });
    return true;
}
/** Ends a ringing call that no device confirmed. The caller is told why; the callee gets a missed call. */
export async function endUnreachable(call, reason) {
    const changed = await execute("UPDATE calls SET status = 'unreachable', end_reason = ?, ended_at = NOW(3) WHERE id = ? AND status = 'ringing' AND delivered_at IS NULL", [reason, call.id]);
    if (changed.affectedRows !== 1)
        return false;
    stopRinging(call.call_id);
    logCallEvent(call.call_id, null, 'unreachable', null, { reason });
    const message = UNREACHABLE_MESSAGES[reason];
    const info = await callerInfo(call);
    emitToEmployees([Number(call.caller_id)], 'call:unreachable', { callId: call.call_id, reason, message });
    emitToEmployees([Number(call.caller_id), Number(call.callee_id)], 'call:ended', { callId: call.call_id, reason: 'unreachable' });
    await markCallNotificationRead(Number(call.callee_id), call.call_id);
    const callee = await queryOne('SELECT full_name FROM employees WHERE id = ?', [call.callee_id]);
    // The caller keeps a record of the unsuccessful attempt.
    await NotificationService.notify({
        employeeIds: [Number(call.caller_id)],
        type: 'call_failed',
        title: 'Call not connected',
        body: `${callee?.full_name ?? 'The employee'}: ${message.toLowerCase()}.`,
        link: '/calls',
        priority: 'normal',
        actorId: Number(call.callee_id),
        dedupeKey: `unreachable_${call.call_id}`,
        skipPush: true,
    });
    await notifyMissed(call, info);
    return true;
}
/**
 * Ends a call that is still ringing. Returns false when another request already
 * changed it (accepted, declined elsewhere): every transition is a guarded UPDATE.
 */
export async function endRingingCall(call, status, reason) {
    const changed = await execute("UPDATE calls SET status = ?, end_reason = ?, ended_at = NOW(3) WHERE id = ? AND status = 'ringing'", [status, reason, call.id]);
    if (changed.affectedRows !== 1)
        return false;
    stopRinging(call.call_id);
    logCallEvent(call.call_id, null, status, null, { reason });
    const participants = [Number(call.caller_id), Number(call.callee_id)];
    if (status === 'declined') {
        emitToEmployees([Number(call.caller_id)], 'call:rejected', { callId: call.call_id });
        emitToEmployees(participants, 'call:ended', { callId: call.call_id, reason: 'rejected' });
        await markCallNotificationRead(Number(call.callee_id), call.call_id);
        await execute('UPDATE calls SET callee_notified_at = NOW(3) WHERE id = ?', [call.id]);
        // Close the ringing notification / native ring on the callee's other phones and browsers.
        void PushService.sendCall(Number(call.callee_id), 'call_cancel', await callerInfo(call));
    }
    else {
        emitToEmployees([Number(call.caller_id)], 'call:missed', { callId: call.call_id });
        emitToEmployees(participants, 'call:ended', { callId: call.call_id, reason: 'no_answer' });
        await markCallNotificationRead(Number(call.callee_id), call.call_id);
        await markCalleeNotifiedIfOnline(call);
        await notifyMissed(call, await callerInfo(call));
    }
    return true;
}
/** Callee answered on one device: stop ringing everywhere else (other tabs, phones, native ring). */
export async function onAccepted(call, deviceId) {
    stopRinging(call.call_id);
    logCallEvent(call.call_id, Number(call.callee_id), 'answered', deviceId ?? null);
    await execute('UPDATE calls SET callee_notified_at = NOW(3), delivered_at = COALESCE(delivered_at, NOW(3)) WHERE id = ?', [call.id]);
    emitToEmployees([Number(call.callee_id)], 'call:answered_elsewhere', { callId: call.call_id, deviceId: deviceId ?? null });
    await markCallNotificationRead(Number(call.callee_id), call.call_id);
    void PushService.sendCall(Number(call.callee_id), 'call_cancel', await callerInfo(call));
}
/** A participant reports that the WebRTC media path is connected (audio flowing). */
export async function markConnected(call, employeeId) {
    const changed = await execute("UPDATE calls SET connected_at = NOW(3) WHERE id = ? AND status = 'active' AND connected_at IS NULL", [call.id]);
    if (changed.affectedRows === 1) {
        logCallEvent(call.call_id, employeeId, 'media_connected');
        emitToEmployees([Number(call.caller_id), Number(call.callee_id)], 'call:connected', { callId: call.call_id });
    }
    return changed.affectedRows === 1;
}
/** Ends an active (connected) call and stores the server-measured duration. */
export async function endActiveCall(call, reason) {
    const ended = await execute(`UPDATE calls SET status = 'completed', end_reason = ?, ended_at = NOW(3),
            duration_seconds = IF(accepted_at IS NULL, 0, GREATEST(0, TIMESTAMPDIFF(SECOND, accepted_at, NOW(3))))
     WHERE id = ? AND status = 'active'`, [reason, call.id]);
    if (ended.affectedRows !== 1)
        return null;
    const row = await queryOne('SELECT duration_seconds AS d FROM calls WHERE id = ?', [call.id]);
    const duration = Number(row?.d ?? 0);
    logCallEvent(call.call_id, null, 'ended', null, { reason, duration });
    emitToEmployees([Number(call.caller_id), Number(call.callee_id)], 'call:ended', {
        callId: call.call_id,
        reason: reason === 'disconnected' ? 'disconnected' : reason === 'failed' ? 'failed' : 'ended',
        duration,
    });
    return duration;
}
/**
 * Calls the employee missed while none of their devices was connected. Returned once:
 * they are marked as notified, so a reconnect shows each missed call exactly one time.
 */
export async function takeMissedWhileAway(employeeId) {
    const rows = await query(`SELECT c.id, c.call_id, c.type, c.status, c.started_at, c.caller_id, e.full_name, e.photo_url, e.employee_code
     FROM calls c JOIN employees e ON e.id = c.caller_id
     WHERE c.callee_id = ? AND c.callee_notified_at IS NULL AND c.status IN ('missed', 'unreachable')
       AND c.started_at > DATE_SUB(NOW(3), INTERVAL 7 DAY)
     ORDER BY c.id DESC LIMIT 20`, [employeeId]);
    if (rows.length === 0)
        return [];
    await execute(`UPDATE calls SET callee_notified_at = NOW(3) WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id));
    return rows.map((r) => ({
        callId: r.call_id,
        type: r.type,
        status: r.status,
        startedAt: new Date(r.started_at).toISOString(),
        caller: { employeeId: Number(r.caller_id), name: r.full_name, photoUrl: r.photo_url, employeeCode: r.employee_code },
    }));
}
// ------------------------------------------------------- reconnect grace period
function graceKey(callId, employeeId) {
    return `${callId}:${employeeId}`;
}
/**
 * A participant's last socket left the call room without hanging up (network
 * drop, app frozen). Give them RECONNECT_GRACE_SECONDS to rejoin; otherwise end
 * the call in the database so neither side stays "busy".
 */
export function scheduleDisconnectEnd(callId, employeeId, stillConnected) {
    const key = graceKey(callId, employeeId);
    clearTimeout(graceTimers.get(key));
    logCallEvent(callId, employeeId, 'peer_disconnected');
    const timer = setTimeout(async () => {
        graceTimers.delete(key);
        try {
            if (await stillConnected())
                return;
            const call = await loadCall(callId);
            if (!call)
                return;
            if (call.status === 'active')
                await endActiveCall(call, 'disconnected');
            else if (call.status === 'ringing' && Number(call.caller_id) === employeeId) {
                // Caller vanished while ringing: the callee still sees it as a missed call.
                await endRingingCall(call, 'missed', 'cancelled');
            }
        }
        catch (error) {
            console.error('[calls] disconnect cleanup failed', error.message);
        }
    }, RECONNECT_GRACE_SECONDS * 1000);
    timer.unref?.();
    graceTimers.set(key, timer);
}
export function cancelDisconnectEnd(callId, employeeId) {
    const key = graceKey(callId, employeeId);
    const timer = graceTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        logCallEvent(callId, employeeId, 'peer_rejoined');
    }
    graceTimers.delete(key);
}
//# sourceMappingURL=CallService.js.map