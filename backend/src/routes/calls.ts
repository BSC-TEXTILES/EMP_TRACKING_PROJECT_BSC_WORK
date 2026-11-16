import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { query, execute, queryOne } from '../db/index.js';
import { emitToEmployees } from '../realtime/io.js';
import { toIso } from '../lib/dates.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const callsRouter = Router();
callsRouter.use(authenticate);

interface CallParticipant {
  id: number;
  employeeCode: string;
  fullName: string;
  photoUrl: string | null;
  departmentName: string | null;
  designationTitle: string | null;
}

/**
 * Get list of employees available for calling
 */
callsRouter.get(
  '/contacts',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const rows = await query<CallParticipant>(`
      SELECT id, employee_code, full_name, photo_url, department_name, designation_title
      FROM employees
      WHERE status = 'active' AND id != ?
      ORDER BY full_name
    `, [user.id]);
    res.json({ contacts: rows });
  })
);

/**
 * Initiate a call - creates call record and notifies recipient
 */
callsRouter.post(
  '/start',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        targetEmployeeId: z.number().int().positive(),
        type: z.enum(['audio', 'video']),
      }),
      req.body,
    );

    // Check if target exists and is active
    const target = await queryOne<CallParticipant>(
      `SELECT id, employee_code, full_name, photo_url, department_name, designation_title
       FROM employees WHERE id = ? AND status = 'active'`,
      [body.targetEmployeeId],
    );

    if (!target) {
      res.status(404).json({ error: 'Employee not found or inactive', code: 'not_found' });
      return;
    }

    // Prevent calling yourself
    if (target.id === user.id) {
      res.status(400).json({ error: 'Cannot call yourself', code: 'bad_request' });
      return;
    }

    // Generate unique call ID and meeting code
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const meetingCode = `meet_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    // Create call record
    const result = await execute(
      `INSERT INTO calls (call_id, caller_id, callee_id, type, status, direction, meeting_code, started_at)
       VALUES (?, ?, ?, ?, 'ringing', 'outgoing', ?, NOW(3))`,
      [callId, user.id, target.id, body.type, meetingCode],
    );

    const callRecordId = result.insertId;

    // Notify recipient via real-time
    emitToEmployees([target.id], 'call:incoming', {
      callId,
      caller: {
        employeeId: user.id,
        employeeCode: user.employeeCode,
        name: user.fullName,
        photoUrl: user.photoUrl,
        department: user.departmentName,
        designation: user.designationTitle,
      },
      type: body.type,
      meetingCode,
    });

    // Also create notification for missed call tracking
    await execute(
      `INSERT INTO notifications (notif_type, title, body, link, priority, actor_id, dedupe_key)
       VALUES ('incoming_call', ?, ?, ?, 'high', ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        `Incoming ${body.type} call`,
        `${user.fullName} is calling you`,
        `/calls?incoming=${callId}`,
        user.id,
        `call_${callId}`,
      ],
    );

    const notificationResult = await execute(
      `INSERT IGNORE INTO notification_recipients (notification_id, employee_id) VALUES (?, ?)`,
      [result.insertId, target.id],
    );

    res.status(201).json({ callId, meetingCode, callRecordId });
  })
);

/**
 * Accept an incoming call
 */
callsRouter.post(
  '/:callId/accept',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;

    const call = await queryOne<{ id: number; caller_id: number; callee_id: number; meeting_code: string; status: string }>(
      'SELECT id, caller_id, callee_id, meeting_code, status FROM calls WHERE call_id = ?',
      [callId],
    );

    if (!call) {
      res.status(404).json({ error: 'Call not found', code: 'not_found' });
      return;
    }

    if (call.callee_id !== user.id) {
      res.status(403).json({ error: 'Not authorized for this call', code: 'forbidden' });
      return;
    }

    if (call.status !== 'ringing') {
      res.status(400).json({ error: 'Call is no longer ringing', code: 'bad_request' });
      return;
    }

    await execute(
      'UPDATE calls SET status = ?, accepted_at = NOW(3) WHERE id = ?',
      ['active', call.id],
    );

    // Notify caller
    emitToEmployees([call.caller_id], 'call:accepted', {
      callId,
      meetingCode: call.meeting_code,
    });

    // Mark notification as read
    await execute(
      `UPDATE notification_recipients nr
       JOIN notifications n ON n.id = nr.notification_id
       SET nr.read_at = NOW(3)
       WHERE nr.employee_id = ? AND n.dedupe_key = ? AND nr.read_at IS NULL`,
      [user.id, `call_${callId}`],
    );

    res.json({ ok: true, meetingCode: call.meeting_code });
  })
);

/**
 * Reject an incoming call
 */
callsRouter.post(
  '/:callId/reject',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;

    const call = await queryOne<{ id: number; caller_id: number; callee_id: number; status: string }>(
      'SELECT id, caller_id, callee_id, status FROM calls WHERE call_id = ?',
      [callId],
    );

    if (!call) {
      res.status(404).json({ error: 'Call not found', code: 'not_found' });
      return;
    }

    if (call.callee_id !== user.id) {
      res.status(403).json({ error: 'Not authorized for this call', code: 'forbidden' });
      return;
    }

    await execute(
      'UPDATE calls SET status = ?, ended_at = NOW(3) WHERE id = ?',
      ['declined', call.id],
    );

    // Notify caller
    emitToEmployees([call.caller_id], 'call:rejected', { callId });

    // Mark notification as read
    await execute(
      `UPDATE notification_recipients nr
       JOIN notifications n ON n.id = nr.notification_id
       SET nr.read_at = NOW(3)
       WHERE nr.employee_id = ? AND n.dedupe_key = ? AND nr.read_at IS NULL`,
      [user.id, `call_${callId}`],
    );

    res.json({ ok: true });
  })
);

/**
 * Mark call as missed (from push notification close or timeout)
 */
callsRouter.post(
  '/missed',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ callId: z.string() }), req.body);

    const call = await queryOne<{ id: number; caller_id: number; callee_id: number; status: string }>(
      'SELECT id, caller_id, callee_id, status FROM calls WHERE call_id = ?',
      [body.callId],
    );

    if (!call) {
      res.status(404).json({ error: 'Call not found', code: 'not_found' });
      return;
    }

    if (call.callee_id !== user.id) {
      res.status(403).json({ error: 'Not authorized for this call', code: 'forbidden' });
      return;
    }

    if (call.status !== 'ringing') {
      res.json({ ok: true }); // Already handled
      return;
    }

    await execute(
      'UPDATE calls SET status = ?, ended_at = NOW(3) WHERE id = ?',
      ['missed', call.id],
    );

    // Notify caller
    emitToEmployees([call.caller_id], 'call:missed', { 
      callId: body.callId,
      caller: { name: user.fullName },
    });

    // Create missed call notification for callee
    await execute(
      `INSERT INTO notifications (notif_type, title, body, link, priority, actor_id, dedupe_key)
       VALUES ('missed_call', ?, ?, ?, 'normal', ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        `Missed ${call.caller_id === user.id ? 'outgoing' : 'incoming'} call`,
        `Missed call from ${call.caller_id === user.id ? 'unknown' : 'caller'}`,
        '/calls',
        user.id,
        `missed_${body.callId}`,
      ],
    );

    res.json({ ok: true });
  })
);

/**
 * Decline call from push notification (when app is in background)
 */
callsRouter.post(
  '/decline',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ callId: z.string() }), req.body);

    const call = await queryOne<{ id: number; caller_id: number; callee_id: number; status: string }>(
      'SELECT id, caller_id, callee_id, status FROM calls WHERE call_id = ?',
      [body.callId],
    );

    if (!call || call.status !== 'ringing' || call.callee_id !== user.id) {
      res.json({ ok: true });
      return;
    }

    await execute(
      'UPDATE calls SET status = ?, ended_at = NOW(3) WHERE id = ?',
      ['declined', call.id],
    );

    emitToEmployees([call.caller_id], 'call:rejected', { callId: body.callId });

    res.json({ ok: true });
  })
);

/**
 * End an active call
 */
callsRouter.post(
  '/:callId/end',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;

    const call = await queryOne<{ 
      id: number; 
      caller_id: number; 
      callee_id: number; 
      status: string; 
      started_at: string;
      accepted_at: string | null;
    }>(
      'SELECT id, caller_id, callee_id, status, started_at, accepted_at FROM calls WHERE call_id = ?',
      [callId],
    );

    if (!call) {
      res.status(404).json({ error: 'Call not found', code: 'not_found' });
      return;
    }

    if (call.caller_id !== user.id && call.callee_id !== user.id) {
      res.status(403).json({ error: 'Not authorized for this call', code: 'forbidden' });
      return;
    }

    if (call.status === 'ended' || call.status === 'declined' || call.status === 'missed') {
      res.json({ ok: true });
      return;
    }

    const duration = call.accepted_at 
      ? Math.floor((new Date().getTime() - new Date(call.accepted_at).getTime()) / 1000)
      : 0;

    await execute(
      'UPDATE calls SET status = ?, ended_at = NOW(3), duration_seconds = ? WHERE id = ?',
      ['completed', duration, call.id],
    );

    const otherPartyId = call.caller_id === user.id ? call.callee_id : call.caller_id;
    emitToEmployees([otherPartyId], 'call:ended', { callId });

    res.json({ ok: true, duration });
  })
);

/**
 * Get call history for current user
 */
callsRouter.get(
  '/history',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const limit = Math.min(100, req.query.limit ? Number(req.query.limit) : 50);
    const offset = req.query.offset ? Number(req.query.offset) : 0;

    const rows = await query<{
      id: number;
      call_id: string;
      type: string;
      direction: string;
      status: string;
      duration_seconds: number;
      started_at: string;
      ended_at: string | null;
      caller_id: number;
      callee_id: number;
      caller_code: string;
      caller_name: string;
      caller_photo: string | null;
      caller_dept: string | null;
      caller_desig: string | null;
      callee_code: string;
      callee_name: string;
      callee_photo: string | null;
      callee_dept: string | null;
      callee_desig: string | null;
    }>(`
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

    // Get unread missed call count
    const unreadResult = await queryOne<{ count: number }>(`
      SELECT COUNT(*) AS count FROM notification_recipients nr
      JOIN notifications n ON n.id = nr.notification_id
      WHERE nr.employee_id = ? AND nr.read_at IS NULL 
      AND n.notif_type IN ('incoming_call', 'missed_call')
    `, [user.id]);

    const calls = rows.map(r => {
      const isOutgoing = r.caller_id === user.id;
      const participant = isOutgoing ? {
        id: r.callee_id,
        name: r.callee_name,
        photoUrl: r.callee_photo,
        employeeCode: r.callee_code,
        department: r.callee_dept,
        designation: r.callee_desig,
      } : {
        id: r.caller_id,
        name: r.caller_name,
        photoUrl: r.caller_photo,
        employeeCode: r.caller_code,
        department: r.caller_dept,
        designation: r.caller_desig,
      };

      return {
        id: Number(r.id),
        callId: r.call_id,
        type: r.type as 'audio' | 'video',
        direction: isOutgoing ? 'outgoing' : 'incoming',
        status: r.status,
        duration: Number(r.duration_seconds || 0),
        participant,
        startedAt: toIso(r.started_at),
        endedAt: r.ended_at ? toIso(r.ended_at) : null,
        read: r.status !== 'missed', // Simplified - could track separately
      };
    });

    res.json({ calls, unreadMissed: Number(unreadResult?.count || 0) });
  })
);

/**
 * Sync call history (for background sync)
 */
callsRouter.post(
  '/sync',
  asyncHandler(async (req: AuthedRequest, res) => {
    // This endpoint can be used for background sync of offline call logs
    res.json({ ok: true });
  })
);