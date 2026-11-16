import crypto from 'node:crypto';
import { Router, type NextFunction, type Response } from 'express';
import { ApiError, asyncHandler, intParam } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { ActivityService, type DeviceContext } from '../services/ActivityService.js';
import { ActivityAnalyticsService } from '../services/ActivityAnalyticsService.js';
import { today } from '../lib/dates.js';
import type { AuthedRequest } from '../middleware/auth.js';

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
    res.json(await ActivityService.heartbeat(req.device!));
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
  requireDevice,
  asyncHandler(async (req: AgentRequest, res) => {
    const { execute } = await import('../db/index.js');
    const device = req.device!;
    const numeric = (value: unknown) => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Math.max(0, Number(value)));
    await execute(
      `INSERT INTO device_health_logs (device_id, employee_id, cpu_percent, memory_percent, disk_free_mb, agent_version, details, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`,
      [
        device.deviceId, device.employeeId, numeric(req.body?.cpuPercent), numeric(req.body?.memoryPercent),
        numeric(req.body?.diskFreeMb), String(req.body?.agentVersion ?? '').slice(0, 40) || null,
        JSON.stringify({ source: 'agent' }),
      ],
    );
    if (device.sessionId) await ActivityService.heartbeat(device);
    res.json({ ok: true, deviceId: device.deviceId, sessionId: device.sessionId });
  }),
);

// ------------------------------ Employee API -------------------------------
activityRouter.use(authenticate);

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
  '/sessions/start',
  asyncHandler(async (req: AuthedRequest, res) => {
    const deviceId = Number(req.body?.deviceId);
    if (!deviceId) throw ApiError.badRequest('Select a registered device.');
    res.status(201).json(await ActivityService.startSession(currentUser(req), deviceId, { ip: req.ip, userAgent: req.get('user-agent') }));
  }),
);

activityRouter.post(
  '/sessions/stop',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityService.stopSession(currentUser(req)));
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

activityRouter.post(
  '/client-error',
  rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'activity-client-error' }),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const session = await ActivityService.currentSession(user);
    if (!session) { res.json({ recorded: false, reason: 'no_active_session' }); return; }
    const path = String(req.body?.path ?? '/').slice(0, 180);
    const status = Number(req.body?.status ?? 500);
    if (!Number.isFinite(status) || status < 400 || status > 599) throw ApiError.badRequest('Invalid HTTP status.');
    const recorded = await ActivityService.recordError(user.id, null, session.id, {
      type: 'error',
      clientEventId: `client-${crypto.randomUUID()}`,
      errorCategory: Number(status) >= 500 ? 'Failed project operation' : 'Client request error',
      module: String(req.body?.module ?? 'Platform').slice(0, 60),
      errorCode: `HTTP_${status}`,
      severity: Number(status) >= 500 ? 'medium' : 'low',
      description: `Platform request failed with HTTP ${status} on ${path}`,
      application: 'Workforce web app',
      diagnostic: { status, path, source: 'web_client' },
    });
    res.json({ recorded });
  }),
);

activityRouter.get(
  '/dashboard',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ActivityAnalyticsService.selfDashboard(currentUser(req), dateParam(req.query.date)));
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
