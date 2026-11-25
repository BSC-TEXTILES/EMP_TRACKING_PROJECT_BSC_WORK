import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Router, type NextFunction, type Response } from 'express';
import { config } from '../config.js';
import { ApiError, asyncHandler, clientIp, intParam } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { ActivityService, type DeviceContext } from '../services/ActivityService.js';
import { ActivityAnalyticsService } from '../services/ActivityAnalyticsService.js';
import { ActivityDeletionService } from '../services/ActivityDeletionService.js';
import { DeviceTelemetryService } from '../services/DeviceTelemetryService.js';
import { EmployeeActivityDetailsService } from '../services/EmployeeActivityDetailsService.js';
import { UserActivityTrackingService } from '../services/UserActivityTrackingService.js';
import { today } from '../lib/dates.js';
import type { AuthedRequest } from '../middleware/auth.js';
import type { AuthUser } from '../services/AuthService.js';

type AgentRequest = AuthedRequest & { device?: DeviceContext };

export const activityRouter = Router();

function requireDevice(req: AgentRequest, _res: Response, next: NextFunction): void {
  ActivityService.deviceFromToken(String(req.header('x-device-token') ?? ''))
    .then((device) => { req.device = device; next(); })
    .catch(next);
}

function dateParam(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today();
}

// ------------------------------- Agent API --------------------------------
activityRouter.post(
  '/agent/heartbeat',
  rateLimit({ windowMs: 60000, max: 120, keyPrefix: 'agent-heartbeat' }),
  requireDevice,
  asyncHandler(async (req: AgentRequest, res) => {
    res.json(await ActivityService.heartbeat(req.device!, req.body));
  }),
);

activityRouter.post(
  '/agent/events',
  rateLimit({ windowMs: 60000, max: 60, keyPrefix: 'agent-events' }),
  requireDevice,
  asyncHandler(async (req: AgentRequest, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    res.json(await ActivityService.ingest(req.device!, events));
  }),
);

activityRouter.get(
  '/agent/config',
  rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'agent-config' }),
  requireDevice,
  asyncHandler(async (req: AgentRequest, res) => {
    res.json(await ActivityService.agentConfig(req.device!));
  }),
);

activityRouter.post(
  '/agent/extension',
  requireDevice,
  asyncHandler(async (req: AgentRequest, res) => {
    const { execute } = await import('../db/index.js');
    const device = req.device!;
    const browser = String(req.body?.browser ?? 'Browser').slice(0, 60);
    const version = String(req.body?.version ?? '1.0.0').slice(0, 30);
    await execute(
      `INSERT INTO browser_extension_devices (employee_id, device_id, browser, extension_version, last_seen_at)
       VALUES (?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE extension_version = VALUES(extension_version), last_seen_at = NOW(3), status = 'active'`,
      [device.employeeId, device.deviceId, browser, version],
    );
    res.json({ ok: true, browser });
  }),
);

activityRouter.post(
  '/agent/health',
  rateLimit({ windowMs: 60000, max: 20, keyPrefix: 'agent-health' }),
  requireDevice,
  asyncHandler(async (req: AgentRequest, res) => {
    res.json(await DeviceTelemetryService.recordHealth(req.device!, (req.body ?? {}) as Record<string, unknown>));
  }),
);

// Device location (ported from LiveGuard Pro). Accepted only when the policy enables
// it, the employee acknowledged that policy version, and a work session is active.
activityRouter.post(
  '/agent/location',
  rateLimit({ windowMs: 60000, max: 10, keyPrefix: 'agent-location' }),
  requireDevice,
  asyncHandler(async (req: AgentRequest, res) => {
    res.json(await DeviceTelemetryService.recordLocation(req.device!, (req.body ?? {}) as Record<string, unknown>));
  }),
);

// Allow web client to report frontend errors without requiring authentication (e.g. login failures, React crashes)
activityRouter.post(
  '/client-error',
  rateLimit({ windowMs: 60000, max: 60, keyPrefix: 'activity-client-error' }),
  asyncHandler(async (req, res) => {
    const path = String(req.body?.path ?? req.body?.url ?? '/').slice(0, 180);
    const errorName = String(req.body?.errorName ?? req.body?.name ?? 'ClientError').slice(0, 80);
    const message = String(req.body?.message ?? req.body?.description ?? 'Client error occurred').slice(0, 900);
    const stack = req.body?.stack ? String(req.body.stack).slice(0, 2000) : null;
    const componentStack = req.body?.componentStack ? String(req.body.componentStack).slice(0, 2000) : null;
    const moduleName = String(req.body?.module ?? 'Web Client').slice(0, 60);
    const rawStatus = req.body?.status;
    const status = Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : null;
    const severity = (['low', 'medium', 'high', 'critical'] as const).includes(req.body?.severity)
      ? req.body.severity
      : (status && status >= 500 ? 'high' : (componentStack ? 'high' : 'medium'));

    // Attempt to extract user if authorization header or cookie is present
    let userId: number | null = null;
    let sessionId: number | null = null;
    try {
      const token = (req.cookies?.[config.cookieName] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined)) as string | undefined;
      if (token) {
        const { AuthService } = await import('../services/AuthService.js');
        const user = await AuthService.authenticateToken(token);
        if (user) {
          userId = user.id;
          const session = await ActivityService.currentSession(user);
          if (session) {
            sessionId = session.id;
          }
        }
      }
    } catch {
      // Unauthenticated / expired
    }

    const clientEventId = `client-${crypto.randomUUID()}`;
    const description = status
      ? `[${errorName}] HTTP ${status} on ${path}: ${message}`
      : `[${errorName}] on ${path}: ${message}`;

    const diagnostic = {
      path,
      status,
      errorName,
      message,
      stack,
      componentStack,
      userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 255) : null,
      source: 'web_client',
      clientReportedAt: new Date().toISOString(),
    };

    const recorded = await ActivityService.recordError(userId, null, sessionId, {
      type: 'error',
      clientEventId,
      errorCategory: status && status >= 500 ? 'Server Request Failure' : (componentStack ? 'React Component Crash' : 'Client Runtime Error'),
      module: moduleName,
      errorCode: status ? `HTTP_${status}` : errorName,
      severity,
      description,
      application: 'Workforce Web App',
      diagnostic,
    });

    res.json({ recorded: Boolean(recorded), clientEventId });
  }),
);

// ----------------------- Agent Downloads & Scripts -----------------------
activityRouter.get(
  '/agent/download/android',
  asyncHandler(async (_req, res) => {
    res.redirect('/api/downloads/apk/release');
  }),
);

// The legacy batch/PowerShell installers wrote a config the old agent never read.
// They are retired; the signed-in download of the Windows installer lives at
// GET /api/tracking/agent/download (see docs/TRACKING_AGENT.md).
for (const legacy of ['/agent/installer.bat', '/agent/installer.ps1']) {
  activityRouter.get(legacy, (_req, res) => {
    res.status(410).json({ error: { code: 'gone', message: 'This installer has been replaced. Download the BSC Activity Tracker installer from User Activity Tracking → Devices.' } });
  });
}

// ------------------------------ Employee API -------------------------------
activityRouter.use(authenticate);

// ----------------- User Activity Tracking (Admin & HR) -----------------
activityRouter.get(
  '/employees-tracking',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const data = await UserActivityTrackingService.getTrackingDashboard(user, {
      search: req.query.search ? String(req.query.search) : undefined,
      locationId: req.query.locationId ? intParam(String(req.query.locationId)) : undefined,
      departmentId: req.query.departmentId ? intParam(String(req.query.departmentId)) : undefined,
      status: req.query.status as any,
      agentInstalled: req.query.agentInstalled === 'true' ? true : (req.query.agentInstalled === 'false' ? false : undefined),
      sortBy: req.query.sortBy as any,
      sortOrder: (req.query.sortOrder as any) === 'asc' ? 'asc' : 'desc',
      page: req.query.page ? intParam(String(req.query.page)) : 1,
      limit: req.query.limit ? intParam(String(req.query.limit)) : 25,
      date: req.query.date ? String(req.query.date) : undefined,
    });
    res.json(data);
  }),
);

activityRouter.get(
  '/employee/:id/details',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = intParam(req.params.id);
    const data = await UserActivityTrackingService.getEmployeeDetailedActivity(user, employeeId, {
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
      date: req.query.date ? String(req.query.date) : undefined,
    });
    res.json(data);
  }),
);

activityRouter.get(
  '/export/report',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const format = (String(req.query.format || 'xlsx').toLowerCase()) as 'pdf' | 'xlsx' | 'csv';
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId)) : undefined;
    const locationId = req.query.locationId ? intParam(String(req.query.locationId)) : undefined;
    const departmentId = req.query.departmentId ? intParam(String(req.query.departmentId)) : undefined;
    const from = String(req.query.from || today());
    const to = String(req.query.to || today());

    const result = await UserActivityTrackingService.exportReport(user, {
      format,
      employeeId,
      locationId,
      departmentId,
      from,
      to,
    });

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.buffer);
  }),
);

// LiveGuard device board: health, security posture and location per device.
activityRouter.get(
  '/live-devices',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await DeviceTelemetryService.liveDevices(currentUser(req)));
  }),
);

activityRouter.get(
  '/devices/:id/locations',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('Invalid device id');
    res.json(await DeviceTelemetryService.locationTrail(currentUser(req), id, dateParam(req.query.date)));
  }),
);

activityRouter.get(
  '/policy',
  asyncHandler(async (req, res) => {
    res.json(await ActivityService.consentStatus(currentUser(req)));
  }),
);

activityRouter.post(
  '/consent',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityService.acknowledge(currentUser(req), { ip: req.ip, userAgent: req.get('user-agent') }));
  }),
);

activityRouter.post(
  '/consent/revoke',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityService.revokeConsent(currentUser(req), { ip: req.ip }));
  }),
);

activityRouter.get(
  '/devices',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ devices: await ActivityService.listDevices(currentUser(req)) });
  }),
);

activityRouter.post(
  '/devices',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.status(201).json(await ActivityService.registerDevice(currentUser(req), {
      deviceName: String(req.body?.deviceName ?? ''),
      osName: String(req.body?.osName ?? 'Windows'),
      osVersion: req.body?.osVersion ? String(req.body.osVersion) : undefined,
      agentVersion: req.body?.agentVersion ? String(req.body.agentVersion) : undefined,
      machineFingerprint: String(req.body?.machineFingerprint ?? ''),
    }));
  }),
);

activityRouter.delete(
  '/devices/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    await ActivityService.revokeDevice(currentUser(req), intParam(req.params.id));
    res.json({ ok: true });
  }),
);

activityRouter.post(
  '/auto-start',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const result = await ActivityService.autoStartTracking(user, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      machineFingerprint: req.body?.machineFingerprint,
    });
    res.json(result);
  }),
);

activityRouter.post(
  '/auto-stop',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const result = await ActivityService.stopTracking(user.id);
    res.json(result);
  }),
);

activityRouter.post(
  '/sessions/start',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const deviceId = Number(req.body?.deviceId);
    if (!deviceId) throw ApiError.badRequest('Select a registered device.');
    const targetEmployeeId = req.body?.employeeId ? Number(req.body.employeeId) : undefined;
    const targetUser = targetEmployeeId && (user.roleLevel >= 50 || user.permissions.includes('activity.admin'))
      ? ({ ...user, id: targetEmployeeId } as AuthUser)
      : user;
    res.status(201).json(await ActivityService.startSession(targetUser, deviceId, { ip: req.ip, userAgent: req.get('user-agent') }));
  }),
);

activityRouter.post(
  '/sessions/stop',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = req.body ?? {};
    res.json(
      await ActivityService.stopSession(user, {
        employeeId: body.employeeId ? Number(body.employeeId) : undefined,
        sessionId: body.sessionId ? Number(body.sessionId) : undefined,
      }),
    );
  }),
);

activityRouter.get(
  '/sessions/current',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ session: await ActivityService.currentSession(currentUser(req)) });
  }),
);

activityRouter.post(
  '/module-activity',
  rateLimit({ windowMs: 60000, max: 40, keyPrefix: 'module-activity' }),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityService.moduleActivity(currentUser(req), {
      module: String(req.body?.module ?? 'Platform'),
      pagePath: String(req.body?.pagePath ?? '/'),
      enteredAt: req.body?.enteredAt,
      exitedAt: req.body?.exitedAt,
      activeSeconds: Number(req.body?.activeSeconds ?? 0),
      relatedTaskId: req.body?.relatedTaskId ? Number(req.body.relatedTaskId) : null,
    }));
  }),
);



activityRouter.get(
  '/dashboard',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const targetEmployeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    res.json(await ActivityAnalyticsService.selfDashboard(user, dateParam(req.query.date), targetEmployeeId));
  }),
);

activityRouter.get(
  '/team',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.view.team') && !user.permissions.includes('activity.view.all')) {
      throw ApiError.forbidden('You do not have team activity access.');
    }
    res.json(await ActivityAnalyticsService.teamOverview(user, dateParam(req.query.date)));
  }),
);

activityRouter.get(
  '/admin',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.view.all')) throw ApiError.forbidden('You do not have organisation activity access.');
    res.json(await ActivityAnalyticsService.adminOverview(user, dateParam(req.query.date)));
  }),
);

activityRouter.get(
  '/monthly',
  asyncHandler(async (req: AuthedRequest, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    res.json(await ActivityAnalyticsService.monthlyDashboard(currentUser(req), month));
  }),
);

activityRouter.get(
  '/employee/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json(await ActivityAnalyticsService.employeeProfile(currentUser(req), id, dateParam(req.query.date)));
  }),
);

activityRouter.get(
  '/daily',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : user.id;
    res.json(await ActivityAnalyticsService.daily(user, employeeId, dateParam(req.query.date)));
  }),
);

activityRouter.post(
  '/daily/submit',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(await ActivityAnalyticsService.submitDaily(user, dateParam(req.body?.date), String(req.body?.notes ?? ''), req.body?.keyActivities));
  }),
);

activityRouter.post(
  '/daily/:id/review',
  asyncHandler(async (req: AuthedRequest, res) => {
    const decision = req.body?.decision === 'returned' ? 'returned' : 'approved';
    res.json(await ActivityAnalyticsService.reviewDaily(currentUser(req), intParam(req.params.id), decision, String(req.body?.note ?? '')));
  }),
);

activityRouter.get(
  '/weekly',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : user.id;
    res.json({ reports: await ActivityAnalyticsService.weeklyList(user, employeeId, req.query.limit ? Number(req.query.limit) : 8) });
  }),
);

activityRouter.post(
  '/weekly/generate',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = req.body?.employeeId ? Number(req.body.employeeId) : user.id;
    if (employeeId !== user.id && !user.permissions.includes('activity.review') && !user.permissions.includes('activity.view.all')) {
      throw ApiError.forbidden('You cannot generate another employee report.');
    }
    res.json(await ActivityAnalyticsService.generateWeekly(employeeId, req.body?.weekStart));
  }),
);

activityRouter.post(
  '/weekly/:id/review',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityAnalyticsService.reviewWeekly(currentUser(req), intParam(req.params.id), {
      managerRemarks: req.body?.managerRemarks ? String(req.body.managerRemarks) : undefined,
      finalize: Boolean(req.body?.finalize),
    }));
  }),
);

activityRouter.post(
  '/weekly/:id/feedback',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityAnalyticsService.weeklyFeedback(currentUser(req), intParam(req.params.id), String(req.body?.feedback ?? '')));
  }),
);

activityRouter.get(
  '/errors',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ errors: await ActivityService.listErrors(currentUser(req)) });
  }),
);

activityRouter.post(
  '/errors/:incidentId/ticket',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const privileged = user.permissions.includes('activity.review') || user.permissions.includes('tickets.resolve') || user.permissions.includes('activity.view.all');
    if (!privileged) {
      // Employees may confirm suggested tickets for incidents they experienced.
      const { queryOne } = await import('../db/index.js');
      const own = await queryOne<{ id: number }>('SELECT id FROM system_error_events WHERE incident_id = ? AND employee_id = ? LIMIT 1', [intParam(req.params.incidentId), user.id]);
      if (!own) throw ApiError.forbidden('You cannot confirm automatic tickets.');
    }
    res.status(201).json(await ActivityService.createIncidentTicket(intParam(req.params.incidentId), 'manual_confirmation'));
  }),
);

activityRouter.post(
  '/errors/:incidentId/dismiss',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.review') && !user.permissions.includes('tickets.resolve') && !user.permissions.includes('activity.view.all')) {
      throw ApiError.forbidden('You cannot dismiss incidents.');
    }
    res.json(await ActivityService.dismissIncident(user, intParam(req.params.incidentId)));
  }),
);

activityRouter.post(
  '/retention/purge',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.policy.manage')) throw ApiError.forbidden('You cannot run retention cleanup.');
    const dryRun = req.body?.dryRun !== false;
    res.json(await ActivityService.purgeExpired(user.id, dryRun));
  }),
);

activityRouter.put(
  '/policy',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityService.updatePolicy(currentUser(req), req.body ?? {}));
  }),
);

activityRouter.get(
  '/audit',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.policy.manage') && !user.permissions.includes('activity.view.all')) {
      throw ApiError.forbidden('You cannot view monitoring audit logs.');
    }
    const { query } = await import('../db/index.js');
    const rows = await query<Record<string, unknown>>(
      `SELECT a.*, e.full_name AS actor_name FROM activity_audit_logs a
       LEFT JOIN employees e ON e.id = a.actor_id ORDER BY a.created_at DESC LIMIT 100`,
    );
    res.json({ entries: rows });
  }),
);

activityRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    res.json({ applications: await ActivityService.catalog() });
  }),
);

activityRouter.put(
  '/catalog',
  asyncHandler(async (req: AuthedRequest, res) => {
    const status = ['approved', 'blocked', 'unapproved'].includes(req.body?.status) ? req.body.status : 'approved';
    res.json({
      applications: await ActivityService.upsertCatalogApp(currentUser(req), {
        name: String(req.body?.name ?? ''),
        processPattern: String(req.body?.processPattern ?? ''),
        category: String(req.body?.category ?? 'Other'),
        status,
      }),
    });
  }),
);

activityRouter.get(
  '/timeline',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : user.id;
    res.json({ segments: await ActivityAnalyticsService.timeline(user, employeeId, dateParam(req.query.date)) });
  }),
);

activityRouter.get(
  '/corrections',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ corrections: await ActivityService.listCorrections(currentUser(req), typeof req.query.status === 'string' ? req.query.status : undefined) });
  }),
);

activityRouter.post(
  '/corrections',
  rateLimit({ windowMs: 60000, max: 20, keyPrefix: 'activity-corrections' }),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.status(201).json(await ActivityService.requestCorrection(currentUser(req), {
      recordType: String(req.body?.recordType ?? ''),
      recordId: Number(req.body?.recordId),
      action: String(req.body?.action ?? 'exclude'),
      category: req.body?.category ? String(req.body.category) : undefined,
      reason: String(req.body?.reason ?? ''),
    }));
  }),
);

activityRouter.post(
  '/corrections/:id/review',
  asyncHandler(async (req: AuthedRequest, res) => {
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
    res.json(await ActivityService.reviewCorrection(currentUser(req), intParam(req.params.id), decision, String(req.body?.note ?? '')));
  }),
);

activityRouter.get(
  '/access-history',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ entries: await ActivityService.accessHistory(currentUser(req)) });
  }),
);

activityRouter.get(
  '/devices/all',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ devices: await ActivityService.allDevices(currentUser(req)) });
  }),
);

// ---------------------- Activity Deletion & Recycle Bin Routes ----------------
activityRouter.delete(
  '/records/:type/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const type = String(req.params.type);
    const id = intParam(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : (typeof req.query.reason === 'string' ? req.query.reason : undefined);
    res.json(await ActivityDeletionService.softDeleteRecord(user, type, id, reason, clientIp(req)));
  }),
);

activityRouter.post(
  '/records/bulk-delete',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : (typeof req.query.reason === 'string' ? req.query.reason : undefined);
    res.json(await ActivityDeletionService.bulkSoftDelete(user, items, reason, clientIp(req)));
  }),
);

activityRouter.get(
  '/trash',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    res.json(await ActivityDeletionService.listTrash(user, { type, employeeId, search, limit, offset }));
  }),
);

activityRouter.post(
  '/records/:type/:id/restore',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const type = String(req.params.type);
    const id = intParam(req.params.id);
    res.json(await ActivityDeletionService.restoreRecord(user, type, id, clientIp(req)));
  }),
);

activityRouter.post(
  '/records/bulk-restore',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(await ActivityDeletionService.bulkRestore(user, items, clientIp(req)));
  }),
);

activityRouter.delete(
  '/records/:type/:id/permanent',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const type = String(req.params.type);
    const id = intParam(req.params.id);
    res.json(await ActivityDeletionService.permanentDeleteRecord(user, type, id, clientIp(req)));
  }),
);

activityRouter.post(
  '/records/bulk-permanent',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(await ActivityDeletionService.bulkPermanentDelete(user, items, clientIp(req)));
  }),
);

// ---------------------- Master Activity & Workforce Routes ------------------
activityRouter.get(
  '/login-history',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : undefined;
    const location = typeof req.query.location === 'string' ? req.query.location : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;

    res.json(await ActivityAnalyticsService.loginHistory(user, {
      date,
      from,
      to,
      location,
      status,
      search,
      employeeId,
      limit,
      offset,
    }));
  }),
);

activityRouter.get(
  '/login-history/export',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const location = typeof req.query.location === 'string' ? req.query.location : undefined;
    const history = await ActivityAnalyticsService.loginHistory(user, { date, location, limit: 1000 });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bsc-login-history-${date || 'all'}.csv"`);

    const formatT12 = (val?: string | null) => {
      if (!val) return '';
      const dt = new Date(val);
      if (Number.isNaN(dt.getTime())) return val;
      const d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(dt).replace(/\//g, '-');
      const t = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(dt);
      return `${d} ${t}`;
    };

    const formatWorkingDur = (mins: number) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h > 0 && m > 0) return `${h} Hours ${m} Minutes`;
      if (h > 0) return `${h} Hours`;
      return `${m} Minutes`;
    };

    const header = 'ID,Employee Code,Full Name,Location,Login Time,Logout Time,Session Duration,Status,Browser,OS,IP\n';
    const rows = history.items.map((i) =>
      [
        i.id,
        `"${i.employeeCode}"`,
        `"${i.employeeName.replace(/"/g, '""')}"`,
        `"${(i.location || 'Main Store').replace(/"/g, '""')}"`,
        `"${formatT12(i.loginAt)}"`,
        `"${i.terminationStatus === 'active' && !i.logoutAt ? 'Active Session' : formatT12(i.logoutAt)}"`,
        `"${formatWorkingDur(i.durationMinutes)}"`,
        `"${i.terminationStatus === 'active' && !i.logoutAt ? 'Logged In' : 'Logged Out'}"`,
        `"${i.browser || ''}"`,
        `"${i.os || ''}"`,
        `"${i.ip || ''}"`,
      ].join(','),
    ).join('\n');

    res.send(header + rows);
  }),
);

activityRouter.get(
  '/leaves-overview',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const date = dateParam(req.query.date);
    const location = typeof req.query.location === 'string' ? req.query.location : undefined;
    res.json(await ActivityAnalyticsService.leavesOverview(user, date, location));
  }),
);

activityRouter.get(
  '/meetings-overview',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const date = dateParam(req.query.date);
    res.json(await ActivityAnalyticsService.meetingsOverview(user, date));
  }),
);

// ---------------------- Comprehensive User Details ------------------------
activityRouter.get(
  '/user-details/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const date = dateParam(req.query.date);
    const data = await EmployeeActivityDetailsService.getComprehensiveDashboard(user, id, date, req.ip);
    res.json(data);
  }),
);

activityRouter.get(
  '/user-details/:id/export',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const date = dateParam(req.query.date);
    const data = await EmployeeActivityDetailsService.getComprehensiveDashboard(user, id, date, req.ip);

    // CSV format output
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="activity-report-${data.profile.employeeCode}-${date}.csv"`);

    const lines: string[] = [];
    lines.push(`"Employee Activity Report","BSC Textiles HRMS"`);
    lines.push(`"Generated At","${new Date().toISOString()}"`);
    lines.push(`"Target Date","${date}"`);
    lines.push('');
    lines.push(`"Employee ID","${data.profile.employeeCode}"`);
    lines.push(`"Full Name","${data.profile.fullName}"`);
    lines.push(`"Department","${data.profile.departmentName ?? ''}"`);
    lines.push(`"Designation","${data.profile.designationTitle ?? ''}"`);
    lines.push(`"Location","${data.profile.locationName ?? ''}"`);
    lines.push(`"Reporting Manager","${data.profile.managerName ?? ''}"`);
    lines.push(`"HR Manager","${data.profile.hrName ?? ''}"`);
    lines.push('');
    lines.push(`"Summary Metrics"`);
    lines.push(`"Total Working Duration","${data.reports.periodSummary.workedHours}"`);
    lines.push(`"Total Active Working Time","${data.reports.periodSummary.activeHours}"`);
    lines.push(`"Total Idle Time","${data.reports.periodSummary.idleHours}"`);
    lines.push(`"Application Time","${data.reports.periodSummary.appHours}"`);
    lines.push(`"Website Time","${data.reports.periodSummary.webHours}"`);
    lines.push(`"Active/Idle Ratio","${data.metrics.activeToIdleRatio}"`);
    lines.push(`"Productivity Score","${data.reports.periodSummary.productivityScore}%"`);
    lines.push('');
    lines.push(`"Applications Usage"`);
    lines.push(`"Application","Category","Duration (Mins)","Launches","Last Used"`);
    for (const app of data.applications.daily) {
      lines.push(`"${app.appName}","${app.appCategory}","${app.totalMinutes}","${app.launchCount}","${app.lastUsedAt ?? ''}"`);
    }
    lines.push('');
    lines.push(`"Websites Usage"`);
    lines.push(`"Domain","Category","Duration (Mins)","Visits","Browser"`);
    for (const site of data.websites.daily) {
      lines.push(`"${site.domain}","${site.category}","${site.totalMinutes}","${site.visitCount}","${site.browserName}"`);
    }
    lines.push('');
    lines.push(`"Idle Sessions"`);
    lines.push(`"Started At","Ended At","Duration (Mins)","Type","Reason"`);
    for (const idle of data.idle.sessions) {
      lines.push(`"${idle.startedAt}","${idle.endedAt ?? 'Ongoing'}","${idle.durationMinutes}","${idle.idleType}","${idle.reason ?? 'Inactive'}"`);
    }

    res.send(lines.join('\n'));
  }),
);


