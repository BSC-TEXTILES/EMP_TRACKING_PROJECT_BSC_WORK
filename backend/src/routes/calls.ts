import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { config } from '../config.js';
import { query, execute, queryOne } from '../db/index.js';
import { emitToEmployees } from '../realtime/io.js';
import { toIso } from '../lib/dates.js';
import { NotificationService } from '../services/NotificationService.js';
import { EmployeeService } from '../services/EmployeeService.js';
import { PushService, verifyCallActionToken } from '../services/PushService.js';
import {
  RECONNECT_GRACE_SECONDS,
  RING_TIMEOUT_SECONDS,
  UNREACHABLE_AFTER_SECONDS,
  endActiveCall,
  endRingingCall,
  loadCall,
  logCallEvent,
  markCallNotificationRead,
  markConnected,
  markDelivered,
  onAccepted,
  startRinging,
  type CallRecord,
} from '../services/CallService.js';
import type { AuthedRequest } from '../middleware/auth.js';

/**
 * Endpoints the service worker calls from a notification action. They work
 * without a session (the phone may be signed out, and a worker request may not
 * carry the cookie): the HMAC action token in the push payload is bound to one
 * call and one callee, and only allows ending a call that is still ringing.
 */
export const callsPublicRouter = Router();
callsPublicRouter.post(
  '/push-action',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        callId: z.string().min(3).max(80),
        token: z.string().min(20).max(64),
        action: z.enum(['decline', 'missed']),
      }),
      req.body,
    );
    const call = await loadCall(body.callId);
    if (!call || !verifyCallActionToken(call.call_id, Number(call.callee_id), body.token)) {
      throw ApiError.forbidden('Invalid call action.');
    }
    if (call.status === 'ringing') {
      await endRingingCall(call, body.action === 'decline' ? 'declined' : 'missed', body.action === 'decline' ? 'declined' : 'no_answer');
    }
    res.json({ ok: true });
  }),
);

/**
 * Delivery receipt from the native Android call service: the phone is ringing now.
 * Works without a session (the app may be closed / signed out); the HMAC token in the
 * push is bound to this call and this callee, so nobody can confirm a ring for someone else.
 */
callsPublicRouter.post(
  '/ring-ack',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        callId: z.string().min(3).max(80),
        token: z.string().min(20).max(64),
        fcmToken: z.string().min(20).max(512).regex(/^[A-Za-z0-9_:\-.]+$/).optional(),
        device: z.string().max(64).optional(),
      }),
      req.body,
    );
    const call = await loadCall(body.callId);
    if (!call || !verifyCallActionToken(call.call_id, Number(call.callee_id), body.token)) {
      throw ApiError.forbidden('Invalid call receipt.');
    }
    await PushService.acknowledgeNative(Number(call.callee_id), `call:${call.call_id}`, body.fcmToken);
    const first = await markDelivered(call.call_id, Number(call.callee_id), 'fcm', body.device ?? 'android');
    // Tell the phone whether it should keep ringing (the call may have ended while it was waking up).
    const current = await loadCall(call.call_id);
    res.json({ ok: true, first, ringing: current?.status === 'ringing' });
  }),
);

export const callsRouter = Router();
callsRouter.use(authenticate);

interface CallParticipant {
  id: number;
  employeeCode: string;
  fullName: string;
  photoUrl: string | null;
  departmentName: string | null;
  designationTitle: string | null;
  locationId?: number | null;
  locationName?: string | null;
  locationCode?: string | null;
  managerName?: string | null;
}

interface IceServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

export function rtcIceServers(): IceServerConfig[] {
  const stun = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const servers: IceServerConfig[] = stun.map((url) => ({ urls: url }));
  if (config.turn.url) {
    servers.push({
      urls: config.turn.url,
      username: config.turn.username || undefined,
      credential: config.turn.credential || undefined,
    });
  }
  return servers;
}

/**
 * The user-facing call state, derived from the stored status and timestamps:
 * initiating → ringing (a device confirmed) → connecting (answered) → connected (media up) → ended,
 * or busy / declined / missed / unreachable / failed.
 */
export function callState(status: string, deliveredAt: unknown, connectedAt: unknown, endReason?: string | null): string {
  switch (status) {
    case 'ringing': return deliveredAt ? 'ringing' : 'initiating';
    case 'active': return connectedAt ? 'connected' : 'connecting';
    case 'completed': return endReason === 'failed' ? 'failed' : 'ended';
    default: return status;
  }
}

async function activeCallForEmployee(employeeId: number) {
  return queryOne<{ call_id: string; status: string; caller_id: number; callee_id: number }>(
    `SELECT call_id, status, caller_id, callee_id FROM calls
     WHERE (caller_id = ? OR callee_id = ?)
       AND (status = 'active' OR (status = 'ringing' AND started_at > DATE_SUB(NOW(3), INTERVAL ? SECOND)))
     ORDER BY id DESC LIMIT 1`,
    [employeeId, employeeId, RING_TIMEOUT_SECONDS + 15],
  );
}

/**
 * Get list of employees available for calling
 */
callsRouter.get(
  '/contacts',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const isGlobal = (user.roleLevel ?? 0) >= 70 || user.roleSlug === 'super_admin';
    const allowedLocIds = user.allowedLocations?.map((l) => l.id) ?? (user.locationId ? [user.locationId] : []);

    let whereClause = "e.status = 'active' AND e.id != ?";
    const params: unknown[] = [user.id];

    if (!isGlobal && allowedLocIds.length > 0) {
      // Allow contacts in the same location, or HQ, or their direct manager/reportees
      whereClause += ` AND (
        e.location_id IN (${allowedLocIds.map(() => '?').join(',')})
        OR l.code IN ('HQ', 'HUB')
        OR e.id = ?
        OR e.manager_id = ?
      )`;
      params.push(...allowedLocIds, user.managerId ?? 0, user.id);
    }

    const rows = await query<CallParticipant>(`
      SELECT e.id, e.employee_code AS employeeCode, e.full_name AS fullName, e.photo_url AS photoUrl,
             d.name AS departmentName, dg.title AS designationTitle,
             e.location_id AS locationId, l.name AS locationName, l.code AS locationCode,
             mgr.full_name AS managerName
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN designations dg ON dg.id = e.designation_id
      LEFT JOIN locations l ON l.id = e.location_id
      LEFT JOIN employees mgr ON mgr.id = e.manager_id
      WHERE ${whereClause}
      ORDER BY e.full_name
    `, params);
    res.json({ contacts: rows });
  })
);

/** ICE configuration is served from the backend so TURN credentials never live in the bundle. */
callsRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({
      iceServers: rtcIceServers(),
      ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
      unreachableAfterSeconds: UNREACHABLE_AFTER_SECONDS,
      reconnectGraceSeconds: RECONNECT_GRACE_SECONDS,
      turnConfigured: Boolean(config.turn.url),
      maxCallSeconds: 3600,
    });
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

    // 1. Authorize caller
    const canMakeCalls =
      user.permissions.includes('calls.make') ||
      user.roleSlug === 'super_admin' ||
      (user.roleLevel ?? 0) >= 80;
    if (!canMakeCalls) {
      throw ApiError.forbidden('You do not have permission to make calls. Contact your administrator.');
    }

    const target = await queryOne<CallParticipant & { locationId?: number; roleId?: number }>(
      `SELECT e.id, e.employee_code AS employeeCode, e.full_name AS fullName, e.photo_url AS photoUrl,
              e.location_id AS locationId, e.role_id AS roleId,
              d.name AS departmentName, dg.title AS designationTitle,
              l.name AS locationName, l.code AS locationCode
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.id = ? AND e.status = 'active'`,
      [body.targetEmployeeId],
    );

    if (!target) throw ApiError.notFound('Employee not found or inactive');
    if (target.id === user.id) throw ApiError.badRequest('Cannot call yourself');

    // 2. Location-based authorization
    const callerAllowedLocs = await EmployeeService.getUserAllowedLocations(user);
    const hasCrossLocationAccess =
      user.roleSlug === 'super_admin' ||
      (user.roleLevel ?? 0) >= 80 ||
      user.permissions.includes('locations.view.all') ||
      callerAllowedLocs.length === 0 ||
      (target.locationId && callerAllowedLocs.some((l) => l.id === target.locationId));

    if (!hasCrossLocationAccess) {
      throw ApiError.forbidden('You do not have access to call employees outside your assigned branch.');
    }

    // 3. Verify recipient is authorized to receive calls
    if (target.roleId && target.roleId !== 1) {
      const calleePerms = await query<{ code: string }>(
        `SELECT p.code FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.code = 'calls.receive'`,
        [target.roleId],
      );
      if (calleePerms.length === 0) {
        throw ApiError.forbidden(`${target.fullName} is not authorized to receive calls.`);
      }
    }

    const ownActive = await activeCallForEmployee(user.id);
    if (ownActive) throw new ApiError(409, 'You are already in a call.', 'already_in_call');

    const targetActive = await activeCallForEmployee(target.id);
    if (targetActive) {
      // Record the attempt so both histories show a busy call.
      await execute(
        `INSERT INTO calls (call_id, caller_id, callee_id, type, status, end_reason, direction, meeting_code, started_at, ended_at)
         VALUES (?, ?, ?, ?, 'busy', 'busy', 'outgoing', NULL, NOW(3), NOW(3))`,
        [`busy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, user.id, target.id, body.type],
      );
      throw new ApiError(409, `${target.fullName} is on another call.`, 'busy');
    }

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    const result = await execute(
      `INSERT INTO calls (call_id, caller_id, callee_id, type, status, direction, meeting_code, started_at)
       VALUES (?, ?, ?, ?, 'ringing', 'outgoing', NULL, NOW(3))`,
      [callId, user.id, target.id, body.type],
    );

    // Two callers can pass the busy check at the same moment; the earliest live call wins.
    const contested = await queryOne<{ id: number }>(
      `SELECT id FROM calls WHERE id < ? AND (caller_id IN (?, ?) OR callee_id IN (?, ?))
         AND (status = 'active' OR (status = 'ringing' AND started_at > DATE_SUB(NOW(3), INTERVAL ? SECOND)))
       LIMIT 1`,
      [result.insertId, user.id, target.id, user.id, target.id, RING_TIMEOUT_SECONDS + 15],
    );
    if (contested) {
      await execute("UPDATE calls SET status = 'busy', end_reason = 'busy', ended_at = NOW(3) WHERE id = ?", [result.insertId]);
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
        locationCode: user.locationCode ?? null,
      },
      type: body.type,
      expiresAt: Date.now() + RING_TIMEOUT_SECONDS * 1000,
    });

    // In-app record only; the phone / browser ring is the dedicated call push below.
    await NotificationService.notify({
      employeeIds: [target.id],
      type: 'incoming_call',
      title: `Incoming ${body.type} call`,
      body: `${user.fullName} is calling you`,
      link: `/calls?incoming=${callId}`,
      priority: 'high',
      actorId: user.id,
      dedupeKey: `call_${callId}`,
      skipPush: true,
    });

    // High-priority push to ALL of the callee's devices, re-rung until answer / decline / timeout.
    // Sent even when the callee is "online": a socket in a frozen background tab cannot ring.
    const ring = await startRinging({
      id: Number(result.insertId),
      call_id: callId,
      caller_id: user.id,
      callee_id: target.id,
      type: body.type,
      status: 'ringing',
    });

    res.status(201).json({
      callId,
      callRecordId: result.insertId,
      // 'calling': waiting for a device to confirm; 'unreachable': ended, nothing could ring.
      state: ring.state,
      ...(ring.state === 'unreachable' ? { reason: ring.reason, message: ring.message } : {}),
      peer: {
        employeeId: target.id,
        employeeCode: target.employeeCode,
        name: target.fullName,
        photoUrl: target.photoUrl,
        department: target.departmentName,
        designation: target.designationTitle,
        location: target.locationName ?? null,
        locationCode: target.locationCode ?? null,
      },
      iceServers: rtcIceServers(),
      ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
      unreachableAfterSeconds: UNREACHABLE_AFTER_SECONDS,
    });
  })
);

/**
 * The callee's ringing call, if any. The app asks on every (re)connect and when it
 * comes back to the foreground, so a `call:incoming` socket event lost during a
 * reconnect never means a silent phone.
 */
callsRouter.get(
  '/pending',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const row = await queryOne<{ call_id: string; type: 'audio' | 'video'; started_at: string; caller_id: number; employee_code: string; full_name: string; photo_url: string | null; dept: string | null; desig: string | null; loc: string | null; loc_code: string | null }>(
      `SELECT c.call_id, c.type, c.started_at, c.caller_id, e.employee_code, e.full_name, e.photo_url,
              d.name AS dept, dg.title AS desig, l.name AS loc, l.code AS loc_code
       FROM calls c
       JOIN employees e ON e.id = c.caller_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE c.callee_id = ? AND c.status = 'ringing' AND c.started_at > DATE_SUB(NOW(3), INTERVAL ? SECOND)
       ORDER BY c.id DESC LIMIT 1`,
      [user.id, RING_TIMEOUT_SECONDS],
    );
    if (!row) {
      res.json({ call: null });
      return;
    }
    res.json({
      call: {
        callId: row.call_id,
        type: row.type,
        startedAt: toIso(row.started_at),
        caller: {
          employeeId: Number(row.caller_id),
          employeeCode: row.employee_code,
          name: row.full_name,
          photoUrl: row.photo_url,
          department: row.dept,
          designation: row.desig,
          location: row.loc,
          locationCode: row.loc_code,
        },
        expiresAt: new Date(row.started_at).getTime() + RING_TIMEOUT_SECONDS * 1000,
      },
      iceServers: rtcIceServers(),
    });
  }),
);

/**
 * Accept an incoming call
 */
callsRouter.post(
  '/:callId/accept',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const callId = String(req.params.callId);
    const deviceId = typeof req.body?.deviceId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(req.body.deviceId) ? req.body.deviceId : null;

    const canReceive =
      user.permissions.includes('calls.receive') ||
      user.roleSlug === 'super_admin' ||
      (user.roleLevel ?? 0) >= 80;
    if (!canReceive) {
      throw ApiError.forbidden('You do not have permission to accept calls.');
    }

    const call = await queryOne<{ id: number; caller_id: number; callee_id: number; status: string }>(
      'SELECT id, caller_id, callee_id, status FROM calls WHERE call_id = ?',
      [callId],
    );

    if (!call) throw ApiError.notFound('Call not found');
    if (Number(call.callee_id) !== user.id) throw ApiError.forbidden('Not authorized for this call');
    if (call.status !== 'ringing') throw new ApiError(409, 'Call is no longer ringing.', 'call_ended');

    // Guarded transition: when two devices answer at the same moment, exactly one wins.
    const accepted = await execute(
      "UPDATE calls SET status = 'active', accepted_at = NOW(3), answered_device = ? WHERE id = ? AND status = 'ringing'",
      [deviceId, call.id],
    );
    if (accepted.affectedRows !== 1) throw new ApiError(409, 'Call is no longer ringing.', 'call_ended');

    emitToEmployees([call.caller_id], 'call:accepted', { callId });
    // Other devices of the callee stop ringing.
    await onAccepted({ id: Number(call.id), call_id: callId, caller_id: Number(call.caller_id), callee_id: Number(call.callee_id), type: 'audio', status: 'active' }, deviceId);

    res.json({ ok: true });
  })
);

async function participantCall(callId: string, userId: number, role: 'callee' | 'caller' | 'either'): Promise<CallRecord> {
  const call = await loadCall(callId);
  if (!call) throw ApiError.notFound('Call not found');
  const isCaller = Number(call.caller_id) === userId;
  const isCallee = Number(call.callee_id) === userId;
  if ((role === 'callee' && !isCallee) || (role === 'caller' && !isCaller) || (role === 'either' && !isCaller && !isCallee)) {
    throw ApiError.forbidden('Not authorized for this call');
  }
  return call;
}

/** Callee declines (in-app button). */
callsRouter.post(
  '/:callId/reject',
  asyncHandler(async (req: AuthedRequest, res) => {
    const call = await participantCall(String(req.params.callId), currentUser(req).id, 'callee');
    if (call.status === 'ringing') await endRingingCall(call, 'declined', 'declined');
    res.json({ ok: true });
  })
);

/** Callee's device gave up ringing without an answer (notification dismissed / timed out). */
callsRouter.post(
  '/missed',
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(z.object({ callId: z.string().min(3).max(80) }), req.body);
    const call = await participantCall(body.callId, currentUser(req).id, 'callee');
    if (call.status === 'ringing') await endRingingCall(call, 'missed', 'no_answer');
    res.json({ ok: true });
  })
);

/** Decline from a push notification action while signed in (the worker also has /push-action). */
callsRouter.post(
  '/decline',
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(z.object({ callId: z.string().min(3).max(80) }), req.body);
    const call = await loadCall(body.callId);
    if (call && call.status === 'ringing' && Number(call.callee_id) === currentUser(req).id) {
      await endRingingCall(call, 'declined', 'declined');
    }
    res.json({ ok: true });
  })
);

/** Caller hangs up before an answer. The callee sees "Missed call from X". */
callsRouter.post(
  '/:callId/cancel',
  asyncHandler(async (req: AuthedRequest, res) => {
    const call = await participantCall(String(req.params.callId), currentUser(req).id, 'caller');
    if (call.status === 'ringing') await endRingingCall(call, 'missed', 'cancelled');
    res.json({ ok: true });
  })
);

/** A participant's WebRTC media path is connected (both directions negotiated, audio flowing). */
callsRouter.post(
  '/:callId/connected',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const call = await participantCall(String(req.params.callId), user.id, 'either');
    res.json({ ok: true, first: call.status === 'active' ? await markConnected(call, user.id) : false });
  }),
);

/** Client-side call diagnostics (ICE restarts, quality drops, permission errors) for the audit trail. */
callsRouter.post(
  '/:callId/events',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        event: z.enum(['ice_restart', 'reconnecting', 'reconnected', 'quality_poor', 'quality_good', 'mic_denied', 'media_failed', 'turn_unavailable', 'audio_route']),
        detail: z.record(z.string().max(40), z.union([z.string().max(120), z.number(), z.boolean(), z.null()])).optional(),
      }),
      req.body,
    );
    const call = await participantCall(String(req.params.callId), user.id, 'either');
    logCallEvent(call.call_id, user.id, body.event, null, body.detail);
    res.json({ ok: true });
  }),
);

/** The call's audit trail (participants only). */
callsRouter.get(
  '/:callId/events',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const call = await participantCall(String(req.params.callId), user.id, 'either');
    const rows = await query<{ id: number; employee_id: number | null; event: string; device: string | null; detail: unknown; created_at: string }>(
      'SELECT id, employee_id, event, device, detail, created_at FROM call_events WHERE call_id = ? ORDER BY id LIMIT 200',
      [call.call_id],
    );
    res.json({
      events: rows.map((r) => ({
        id: Number(r.id), employeeId: r.employee_id === null ? null : Number(r.employee_id), event: r.event,
        device: r.device, detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail, at: toIso(r.created_at),
      })),
    });
  }),
);

/** Either side hangs up. Ringing calls become missed / declined, connected calls completed. */
callsRouter.post(
  '/:callId/end',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const failed = req.body?.reason === 'failed';
    const call = await participantCall(String(req.params.callId), user.id, 'either');
    if (call.status === 'ringing') {
      const byCaller = Number(call.caller_id) === user.id;
      await endRingingCall(call, byCaller ? 'missed' : 'declined', byCaller ? 'cancelled' : 'declined');
      res.json({ ok: true, duration: 0, status: byCaller ? 'missed' : 'declined' });
      return;
    }
    if (call.status === 'active') {
      // Duration comes from database server timestamps, never a client clock.
      const duration = await endActiveCall(call, failed ? 'failed' : 'completed');
      res.json({ ok: true, duration: duration ?? 0, status: 'completed' });
      return;
    }
    res.json({ ok: true, duration: 0, status: call.status });
  })
);

/** Removes a call from the requester's history only; the other participant keeps it. */
callsRouter.delete(
  '/history/:callId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const call = await participantCall(String(req.params.callId), user.id, 'either');
    if (['ringing', 'active'].includes(call.status)) throw ApiError.badRequest('End the call before deleting it.');
    const column = Number(call.caller_id) === user.id ? 'caller_deleted_at' : 'callee_deleted_at';
    await execute(`UPDATE calls SET ${column} = COALESCE(${column}, NOW(3)) WHERE id = ?`, [call.id]);
    res.json({ ok: true });
  })
);

/**
 * Get one call (used to restore an incoming call from a push notification).
 */
callsRouter.get(
  '/detail/:callId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const callId = req.params.callId;
    const call = await queryOne<{
      id: number;
      call_id: string;
      caller_id: number;
      callee_id: number;
      type: string;
      status: string;
      started_at: string;
      accepted_at: string | null;
      ended_at: string | null;
      duration_seconds: number;
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
      delivered_at: string | null;
      connected_at: string | null;
      end_reason: string | null;
      caller_loc: string | null;
      caller_loc_code: string | null;
      callee_loc: string | null;
      callee_loc_code: string | null;
    }>(
      `SELECT c.*, caller.employee_code AS caller_code, caller.full_name AS caller_name,
              caller.photo_url AS caller_photo, cd.name AS caller_dept, cg.title AS caller_desig,
              callee.employee_code AS callee_code, callee.full_name AS callee_name,
              callee.photo_url AS callee_photo, ed.name AS callee_dept, eg.title AS callee_desig,
              cl.name AS caller_loc, cl.code AS caller_loc_code, el.name AS callee_loc, el.code AS callee_loc_code
       FROM calls c
       JOIN employees caller ON caller.id = c.caller_id
       JOIN employees callee ON callee.id = c.callee_id
       LEFT JOIN departments cd ON cd.id = caller.department_id
       LEFT JOIN designations cg ON cg.id = caller.designation_id
       LEFT JOIN departments ed ON ed.id = callee.department_id
       LEFT JOIN designations eg ON eg.id = callee.designation_id
       LEFT JOIN locations cl ON cl.id = caller.location_id
       LEFT JOIN locations el ON el.id = callee.location_id
       WHERE c.call_id = ?`,
      [callId],
    );
    if (!call) throw ApiError.notFound('Call not found');
    if (Number(call.caller_id) !== user.id && Number(call.callee_id) !== user.id) {
      throw ApiError.forbidden('Not authorized for this call');
    }
    const outgoing = Number(call.caller_id) === user.id;
    res.json({
      callId: call.call_id,
      type: call.type,
      status: call.status,
      state: callState(call.status, call.delivered_at, call.connected_at, call.end_reason),
      endReason: call.end_reason ?? null,
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
            location: call.callee_loc,
            locationCode: call.callee_loc_code,
          }
        : {
            employeeId: Number(call.caller_id),
            employeeCode: call.caller_code,
            name: call.caller_name,
            photoUrl: call.caller_photo,
            department: call.caller_dept,
            designation: call.caller_desig,
            location: call.caller_loc,
            locationCode: call.caller_loc_code,
          },
      expiresAt: call.status === 'ringing' ? new Date(call.started_at).getTime() + RING_TIMEOUT_SECONDS * 1000 : null,
      iceServers: rtcIceServers(),
    });
  })
);

/**
 * Get call history for current user
 */
callsRouter.get(
  '/history',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit ?? 50)) || 50));
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0)) || 0);

    const rows = await query<{
      id: number;
      call_id: string;
      type: string;
      direction: string;
      status: string;
      end_reason: string | null;
      duration_seconds: number;
      started_at: string;
      ended_at: string | null;
      delivered_at: string | null;
      connected_at: string | null;
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
        c.id, c.call_id, c.type, c.direction, c.status, c.end_reason, c.duration_seconds,
        c.started_at, c.ended_at, c.delivered_at, c.connected_at,
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
      WHERE (c.caller_id = ? AND c.caller_deleted_at IS NULL) OR (c.callee_id = ? AND c.callee_deleted_at IS NULL)
      ORDER BY c.started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [user.id, user.id]);

    const unreadResult = await queryOne<{ count: number }>(`
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
        type: r.type as 'audio' | 'video',
        direction: isOutgoing ? 'outgoing' : 'incoming',
        status: r.status,
        state: callState(r.status, r.delivered_at, r.connected_at, r.end_reason),
        endReason: r.end_reason ?? null,
        duration: Number(r.duration_seconds || 0),
        participant,
        startedAt: toIso(r.started_at),
        endedAt: r.ended_at ? toIso(r.ended_at) : null,
        read: r.status !== 'missed',
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
  asyncHandler(async (_req: AuthedRequest, res) => {
    res.json({ ok: true });
  })
);

/**
 * Scheduler: closes calls nobody finished. Unanswered ringing calls become
 * missed (with a missed-call notification); active calls abandoned by both
 * clients are closed at the maximum call length. Safe to run repeatedly.
 */
export async function sweepStaleCalls(ringTimeoutSeconds = RING_TIMEOUT_SECONDS + 15, maxCallSeconds = 4 * 3600): Promise<{ missed: number; closed: number }> {
  // Backstop only: CallService expires rings on time. This catches calls whose timer was lost (server restart).
  const ringing = await query<CallRecord>(
    `SELECT id, call_id, caller_id, callee_id, type, status FROM calls
     WHERE status = 'ringing' AND started_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
    [ringTimeoutSeconds],
  );
  let missed = 0;
  for (const call of ringing) {
    if (await endRingingCall(call, 'missed', 'no_answer')) missed += 1;
  }
  const closed = await execute(
    `UPDATE calls SET status = 'completed', end_reason = 'disconnected', ended_at = DATE_ADD(accepted_at, INTERVAL ? SECOND), duration_seconds = ?
     WHERE status = 'active' AND accepted_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
    [maxCallSeconds, maxCallSeconds, maxCallSeconds],
  );
  return { missed, closed: closed.affectedRows };
}
