import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { config } from '../config.js';
import { query, execute, queryOne } from '../db/index.js';
import { emitToEmployees } from '../realtime/io.js';
import { toIso } from '../lib/dates.js';
import { NotificationService } from '../services/NotificationService.js';
export const callsRouter = Router();
callsRouter.use(authenticate);
export function rtcIceServers() {
    const stun = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean);
    const servers = stun.map((url) => ({ urls: url }));
    if (config.turn.url) {
        servers.push({
            urls: config.turn.url,
            username: config.turn.username || undefined,
            credential: config.turn.credential || undefined,
        });
    }
    return servers;
}
async function markCallNotificationRead(employeeId, callId) {
    await execute(`UPDATE notification_recipients nr
     JOIN notifications n ON n.id = nr.notification_id
     SET nr.read_at = NOW(3)
     WHERE nr.employee_id = ? AND n.dedupe_key IN (?, ?) AND nr.read_at IS NULL`, [employeeId, `call_${callId}`, `missed_${callId}`]);
}
async function activeCallForEmployee(employeeId) {
    return queryOne(`SELECT call_id, status, caller_id, callee_id FROM calls
     WHERE (caller_id = ? OR callee_id = ?)
       AND (status = 'active' OR (status = 'ringing' AND started_at > DATE_SUB(NOW(3), INTERVAL 60 SECOND)))
     ORDER BY id DESC LIMIT 1`, [employeeId, employeeId]);
}
async function notifyMissedCall(call, actorId) {
    const caller = await queryOne('SELECT full_name FROM employees WHERE id = ?', [call.caller_id]);
    await NotificationService.notify({
        employeeIds: [call.callee_id],
        type: 'missed_call',
        title: `Missed ${call.type} call`,
        body: caller ? `Missed call from ${caller.full_name}` : 'You missed an incoming call',
        link: '/calls',
        priority: 'high',
        actorId,
        dedupeKey: `missed_${call.call_id}`,
    });
}
/**
 * Get list of employees available for calling
 */
callsRouter.get('/contacts', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const rows = await query(`
      SELECT e.id, e.employee_code AS employeeCode, e.full_name AS fullName, e.photo_url AS photoUrl,
             d.name AS departmentName, dg.title AS designationTitle
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN designations dg ON dg.id = e.designation_id
      WHERE e.status = 'active' AND e.id != ?
      ORDER BY e.full_name
    `, [user.id]);
    res.json({ contacts: rows });
}));
/** ICE configuration is served from the backend so TURN credentials never live in the bundle. */
callsRouter.get('/config', asyncHandler(async (_req, res) => {
    res.json({
        iceServers: rtcIceServers(),
        ringTimeoutSeconds: 45,
        maxCallSeconds: 3600,
    });
}));
/**
 * Initiate a call - creates call record and notifies recipient
 */
callsRouter.post('/start', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        targetEmployeeId: z.number().int().positive(),
        type: z.enum(['audio', 'video']),
    }), req.body);
    const target = await queryOne(`SELECT e.id, e.employee_code AS employeeCode, e.full_name AS fullName, e.photo_url AS photoUrl,
              d.name AS departmentName, dg.title AS designationTitle
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE e.id = ? AND e.status = 'active'`, [body.targetEmployeeId]);
    if (!target)
        throw ApiError.notFound('Employee not found or inactive');
    if (target.id === user.id)
        throw ApiError.badRequest('Cannot call yourself');
    const ownActive = await activeCallForEmployee(user.id);
    if (ownActive)
        throw new ApiError(409, 'You are already in a call.', 'already_in_call');
    const targetActive = await activeCallForEmployee(target.id);
    if (targetActive) {
        // Record the attempt so both histories show a busy call.
        await execute(`INSERT INTO calls (call_id, caller_id, callee_id, type, status, direction, meeting_code, started_at, ended_at)
         VALUES (?, ?, ?, ?, 'busy', 'outgoing', NULL, NOW(3), NOW(3))`, [`busy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, user.id, target.id, body.type]);
        throw new ApiError(409, `${target.fullName} is on another call.`, 'busy');
    }
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    const result = await execute(`INSERT INTO calls (call_id, caller_id, callee_id, type, status, direction, meeting_code, started_at)
       VALUES (?, ?, ?, ?, 'ringing', 'outgoing', NULL, NOW(3))`, [callId, user.id, target.id, body.type]);
    // Two callers can pass the busy check at the same moment; the earliest live call wins.
    const contested = await queryOne(`SELECT id FROM calls WHERE id < ? AND (caller_id IN (?, ?) OR callee_id IN (?, ?))
         AND (status = 'active' OR (status = 'ringing' AND started_at > DATE_SUB(NOW(3), INTERVAL 60 SECOND)))
       LIMIT 1`, [result.insertId, user.id, target.id, user.id, target.id]);
    if (contested) {
        await execute("UPDATE calls SET status = 'busy', ended_at = NOW(3) WHERE id = ?", [result.insertId]);
        throw new ApiError(409, `${target.fullName} is on another call.`, 'busy');
    }
    emitToEmployees([target.id], 'call:incoming', {
        callId,
        caller: {
            employeeId: user.id,
            employeeCode: user.employeeCode,
            name: user.fullName,
            photoUrl: user.photoUrl,
            department: user.departmentName,
            designation: user.designationTitle,
            location: user.locationName,
        },
        type: body.type,
    });
    await NotificationService.notify({
        employeeIds: [target.id],
        type: 'incoming_call',
        title: `Incoming ${body.type} call`,
        body: `${user.fullName} is calling you`,
        link: `/calls?incoming=${callId}`,
        priority: 'high',
        actorId: user.id,
        dedupeKey: `call_${callId}`,
    });
    res.status(201).json({
        callId,
        callRecordId: result.insertId,
        peer: {
            employeeId: target.id,
            employeeCode: target.employeeCode,
            name: target.fullName,
            photoUrl: target.photoUrl,
            department: target.departmentName,
            designation: target.designationTitle,
        },
        iceServers: rtcIceServers(),
    });
}));
/**
 * Accept an incoming call
 */
callsRouter.post('/:callId/accept', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;
    const call = await queryOne('SELECT id, caller_id, callee_id, status FROM calls WHERE call_id = ?', [callId]);
    if (!call)
        throw ApiError.notFound('Call not found');
    if (Number(call.callee_id) !== user.id)
        throw ApiError.forbidden('Not authorized for this call');
    if (call.status !== 'ringing')
        throw new ApiError(409, 'Call is no longer ringing.', 'call_ended');
    const accepted = await execute("UPDATE calls SET status = 'active', accepted_at = NOW(3) WHERE id = ? AND status = 'ringing'", [call.id]);
    if (accepted.affectedRows !== 1)
        throw new ApiError(409, 'Call is no longer ringing.', 'call_ended');
    emitToEmployees([call.caller_id], 'call:accepted', { callId });
    await markCallNotificationRead(user.id, callId);
    res.json({ ok: true });
}));
/**
 * Reject an incoming call
 */
callsRouter.post('/:callId/reject', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;
    const call = await queryOne('SELECT id, caller_id, callee_id, status FROM calls WHERE call_id = ?', [callId]);
    if (!call)
        throw ApiError.notFound('Call not found');
    if (Number(call.callee_id) !== user.id)
        throw ApiError.forbidden('Not authorized for this call');
    if (call.status !== 'ringing') {
        res.json({ ok: true });
        return;
    }
    const changed = await execute("UPDATE calls SET status = 'declined', ended_at = NOW(3) WHERE id = ? AND status = 'ringing'", [call.id]);
    if (changed.affectedRows !== 1) {
        res.json({ ok: true });
        return;
    }
    emitToEmployees([call.caller_id], 'call:rejected', { callId });
    await markCallNotificationRead(user.id, callId);
    res.json({ ok: true });
}));
/**
 * Mark call as missed (from push notification close)
 */
callsRouter.post('/missed', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ callId: z.string().min(3).max(80) }), req.body);
    const call = await queryOne('SELECT id, call_id, caller_id, callee_id, type, status FROM calls WHERE call_id = ?', [body.callId]);
    if (!call)
        throw ApiError.notFound('Call not found');
    if (Number(call.callee_id) !== user.id)
        throw ApiError.forbidden('Not authorized for this call');
    if (call.status !== 'ringing') {
        res.json({ ok: true });
        return;
    }
    const changed = await execute("UPDATE calls SET status = 'missed', ended_at = NOW(3) WHERE id = ? AND status = 'ringing'", [call.id]);
    if (changed.affectedRows !== 1) {
        res.json({ ok: true });
        return;
    }
    emitToEmployees([call.caller_id], 'call:missed', { callId: call.call_id });
    await notifyMissedCall({ ...call, call_id: call.call_id }, user.id);
    await markCallNotificationRead(user.id, call.call_id);
    res.json({ ok: true });
}));
/**
 * Decline call from push notification (when app is in background)
 */
callsRouter.post('/decline', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ callId: z.string().min(3).max(80) }), req.body);
    const call = await queryOne('SELECT id, call_id, caller_id, callee_id, type, status FROM calls WHERE call_id = ?', [body.callId]);
    if (!call || call.status !== 'ringing' || Number(call.callee_id) !== user.id) {
        res.json({ ok: true });
        return;
    }
    const changed = await execute("UPDATE calls SET status = 'declined', ended_at = NOW(3) WHERE id = ? AND status = 'ringing'", [call.id]);
    if (changed.affectedRows !== 1) {
        res.json({ ok: true });
        return;
    }
    emitToEmployees([call.caller_id], 'call:rejected', { callId: call.call_id });
    await markCallNotificationRead(user.id, call.call_id);
    res.json({ ok: true });
}));
/**
 * Caller cancels an unanswered call (ring timeout).
 */
callsRouter.post('/:callId/cancel', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;
    const call = await queryOne('SELECT id, call_id, caller_id, callee_id, type, status FROM calls WHERE call_id = ?', [callId]);
    if (!call)
        throw ApiError.notFound('Call not found');
    if (Number(call.caller_id) !== user.id)
        throw ApiError.forbidden('Not authorized for this call');
    if (call.status !== 'ringing') {
        res.json({ ok: true });
        return;
    }
    const changed = await execute("UPDATE calls SET status = 'missed', ended_at = NOW(3) WHERE id = ? AND status = 'ringing'", [call.id]);
    if (changed.affectedRows !== 1) {
        res.json({ ok: true });
        return;
    }
    emitToEmployees([call.caller_id, call.callee_id], 'call:ended', { callId, reason: 'no_answer' });
    await notifyMissedCall(call, user.id);
    await markCallNotificationRead(user.id, callId);
    res.json({ ok: true });
}));
/**
 * End an active call
 */
callsRouter.post('/:callId/end', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;
    const call = await queryOne('SELECT id, call_id, caller_id, callee_id, type, status, accepted_at FROM calls WHERE call_id = ?', [callId]);
    if (!call)
        throw ApiError.notFound('Call not found');
    if (Number(call.caller_id) !== user.id && Number(call.callee_id) !== user.id) {
        throw ApiError.forbidden('Not authorized for this call');
    }
    if (['completed', 'declined', 'missed', 'busy', 'failed'].includes(call.status)) {
        res.json({ ok: true, duration: 0 });
        return;
    }
    const status = call.status === 'ringing'
        ? (Number(call.caller_id) === user.id ? 'missed' : 'declined')
        : 'completed';
    // Duration comes from database server timestamps, never a client or host-local clock.
    const ended = await execute(`UPDATE calls SET status = ?, ended_at = NOW(3),
              duration_seconds = IF(accepted_at IS NULL, 0, GREATEST(0, TIMESTAMPDIFF(SECOND, accepted_at, NOW(3))))
       WHERE id = ? AND status IN ('ringing', 'active')`, [status, call.id]);
    if (ended.affectedRows !== 1) {
        res.json({ ok: true, duration: 0 });
        return;
    }
    const duration = Number((await queryOne('SELECT duration_seconds AS d FROM calls WHERE id = ?', [call.id]))?.d ?? 0);
    emitToEmployees([call.caller_id, call.callee_id], 'call:ended', {
        callId,
        reason: status === 'missed' ? 'no_answer' : status === 'declined' ? 'rejected' : 'ended',
        duration,
    });
    if (status === 'missed')
        await notifyMissedCall(call, user.id);
    res.json({ ok: true, duration, status });
}));
/**
 * Get one call (used to restore an incoming call from a push notification).
 */
callsRouter.get('/detail/:callId', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;
    const call = await queryOne(`SELECT c.*, caller.employee_code AS caller_code, caller.full_name AS caller_name,
              caller.photo_url AS caller_photo, cd.name AS caller_dept, cg.title AS caller_desig,
              callee.employee_code AS callee_code, callee.full_name AS callee_name,
              callee.photo_url AS callee_photo, ed.name AS callee_dept, eg.title AS callee_desig
       FROM calls c
       JOIN employees caller ON caller.id = c.caller_id
       JOIN employees callee ON callee.id = c.callee_id
       LEFT JOIN departments cd ON cd.id = caller.department_id
       LEFT JOIN designations cg ON cg.id = caller.designation_id
       LEFT JOIN departments ed ON ed.id = callee.department_id
       LEFT JOIN designations eg ON eg.id = callee.designation_id
       WHERE c.call_id = ?`, [callId]);
    if (!call)
        throw ApiError.notFound('Call not found');
    if (Number(call.caller_id) !== user.id && Number(call.callee_id) !== user.id) {
        throw ApiError.forbidden('Not authorized for this call');
    }
    const outgoing = Number(call.caller_id) === user.id;
    res.json({
        callId: call.call_id,
        type: call.type,
        status: call.status,
        direction: outgoing ? 'outgoing' : 'incoming',
        startedAt: toIso(call.started_at),
        acceptedAt: call.accepted_at ? toIso(call.accepted_at) : null,
        endedAt: call.ended_at ? toIso(call.ended_at) : null,
        duration: Number(call.duration_seconds || 0),
        peer: outgoing
            ? {
                employeeId: Number(call.callee_id),
                employeeCode: call.callee_code,
                name: call.callee_name,
                photoUrl: call.callee_photo,
                department: call.callee_dept,
                designation: call.callee_desig,
            }
            : {
                employeeId: Number(call.caller_id),
                employeeCode: call.caller_code,
                name: call.caller_name,
                photoUrl: call.caller_photo,
                department: call.caller_dept,
                designation: call.caller_desig,
            },
        iceServers: rtcIceServers(),
    });
}));
/**
 * Get call history for current user
 */
callsRouter.get('/history', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit ?? 50)) || 50));
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0)) || 0);
    const rows = await query(`
      SELECT
        c.id, c.call_id, c.type, c.direction, c.status, c.duration_seconds,
        c.started_at, c.ended_at,
        c.caller_id, c.callee_id,
        caller.employee_code AS caller_code,
        caller.full_name AS caller_name,
        caller.photo_url AS caller_photo,
        caller_dept.name AS caller_dept,
        caller_desig.title AS caller_desig,
        callee.employee_code AS callee_code,
        callee.full_name AS callee_name,
        callee.photo_url AS callee_photo,
        callee_dept.name AS callee_dept,
        callee_desig.title AS callee_desig
      FROM calls c
      JOIN employees caller ON caller.id = c.caller_id
      JOIN employees callee ON callee.id = c.callee_id
      LEFT JOIN departments caller_dept ON caller_dept.id = caller.department_id
      LEFT JOIN designations caller_desig ON caller_desig.id = caller.designation_id
      LEFT JOIN departments callee_dept ON callee_dept.id = callee.department_id
      LEFT JOIN designations callee_desig ON callee_desig.id = callee.designation_id
      WHERE c.caller_id = ? OR c.callee_id = ?
      ORDER BY c.started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [user.id, user.id]);
    const unreadResult = await queryOne(`
      SELECT COUNT(*) AS count FROM notification_recipients nr
      JOIN notifications n ON n.id = nr.notification_id
      WHERE nr.employee_id = ? AND nr.read_at IS NULL
      AND n.notif_type IN ('incoming_call', 'missed_call')
    `, [user.id]);
    const calls = rows.map(r => {
        const isOutgoing = Number(r.caller_id) === user.id;
        const participant = isOutgoing ? {
            id: Number(r.callee_id),
            name: r.callee_name,
            photoUrl: r.callee_photo,
            employeeCode: r.callee_code,
            department: r.callee_dept,
            designation: r.callee_desig,
        } : {
            id: Number(r.caller_id),
            name: r.caller_name,
            photoUrl: r.caller_photo,
            employeeCode: r.caller_code,
            department: r.caller_dept,
            designation: r.caller_desig,
        };
        return {
            id: Number(r.id),
            callId: r.call_id,
            type: r.type,
            direction: isOutgoing ? 'outgoing' : 'incoming',
            status: r.status,
            duration: Number(r.duration_seconds || 0),
            participant,
            startedAt: toIso(r.started_at),
            endedAt: r.ended_at ? toIso(r.ended_at) : null,
            read: r.status !== 'missed',
        };
    });
    res.json({ calls, unreadMissed: Number(unreadResult?.count || 0) });
}));
/**
 * Sync call history (for background sync)
 */
callsRouter.post('/sync', asyncHandler(async (_req, res) => {
    res.json({ ok: true });
}));
/**
 * Scheduler: closes calls nobody finished. Unanswered ringing calls become
 * missed (with a missed-call notification); active calls abandoned by both
 * clients are closed at the maximum call length. Safe to run repeatedly.
 */
export async function sweepStaleCalls(ringTimeoutSeconds = 60, maxCallSeconds = 4 * 3600) {
    const ringing = await query(`SELECT id, call_id, caller_id, callee_id, type FROM calls
     WHERE status = 'ringing' AND started_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)`, [ringTimeoutSeconds]);
    let missed = 0;
    for (const call of ringing) {
        const changed = await execute("UPDATE calls SET status = 'missed', ended_at = NOW(3) WHERE id = ? AND status = 'ringing'", [call.id]);
        if (changed.affectedRows !== 1)
            continue;
        missed += 1;
        emitToEmployees([call.caller_id, call.callee_id], 'call:ended', { callId: call.call_id, reason: 'no_answer' });
        await notifyMissedCall(call, call.caller_id);
    }
    const closed = await execute(`UPDATE calls SET status = 'completed', ended_at = DATE_ADD(accepted_at, INTERVAL ? SECOND), duration_seconds = ?
     WHERE status = 'active' AND accepted_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)`, [maxCallSeconds, maxCallSeconds, maxCallSeconds]);
    return { missed, closed: closed.affectedRows };
}
//# sourceMappingURL=calls.js.map