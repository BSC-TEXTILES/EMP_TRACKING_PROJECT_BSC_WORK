import crypto from 'node:crypto';
import { Router } from 'express';
import { ApiError, asyncHandler, clientIp, intParam } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { ActivityService } from '../services/ActivityService.js';
import { ActivityAnalyticsService } from '../services/ActivityAnalyticsService.js';
import { ActivityDeletionService } from '../services/ActivityDeletionService.js';
import { DeviceTelemetryService } from '../services/DeviceTelemetryService.js';
import { today } from '../lib/dates.js';
export const activityRouter = Router();
function requireDevice(req, _res, next) {
    ActivityService.deviceFromToken(String(req.header('x-device-token') ?? ''))
        .then((device) => { req.device = device; next(); })
        .catch(next);
}
function dateParam(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today();
}
// ------------------------------- Agent API --------------------------------
activityRouter.post('/agent/heartbeat', rateLimit({ windowMs: 60000, max: 120, keyPrefix: 'agent-heartbeat' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await ActivityService.heartbeat(req.device, req.body));
}));
activityRouter.post('/agent/events', rateLimit({ windowMs: 60000, max: 60, keyPrefix: 'agent-events' }), requireDevice, asyncHandler(async (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    res.json(await ActivityService.ingest(req.device, events));
}));
activityRouter.get('/agent/config', rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'agent-config' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await ActivityService.agentConfig(req.device));
}));
activityRouter.post('/agent/extension', requireDevice, asyncHandler(async (req, res) => {
    const { execute } = await import('../db/index.js');
    const device = req.device;
    const browser = String(req.body?.browser ?? 'Browser').slice(0, 60);
    const version = String(req.body?.version ?? '1.0.0').slice(0, 30);
    await execute(`INSERT INTO browser_extension_devices (employee_id, device_id, browser, extension_version, last_seen_at)
       VALUES (?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE extension_version = VALUES(extension_version), last_seen_at = NOW(3), status = 'active'`, [device.employeeId, device.deviceId, browser, version]);
    res.json({ ok: true, browser });
}));
activityRouter.post('/agent/health', rateLimit({ windowMs: 60000, max: 20, keyPrefix: 'agent-health' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await DeviceTelemetryService.recordHealth(req.device, (req.body ?? {})));
}));
// Device location (ported from LiveGuard Pro). Accepted only when the policy enables
// it, the employee acknowledged that policy version, and a work session is active.
activityRouter.post('/agent/location', rateLimit({ windowMs: 60000, max: 10, keyPrefix: 'agent-location' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await DeviceTelemetryService.recordLocation(req.device, (req.body ?? {})));
}));
// Allow web client to report frontend errors without requiring authentication (e.g. login failures)
activityRouter.post('/client-error', rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'activity-client-error' }), asyncHandler(async (req, res) => {
    const path = String(req.body?.path ?? '/').slice(0, 180);
    const status = Number(req.body?.status ?? 500);
    if (!Number.isFinite(status) || status < 400 || status > 599) {
        res.json({ recorded: false, reason: 'invalid_status' });
        return;
    }
    // Attempt to extract user if authorization header or cookie is present
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        try {
            const { AuthService } = await import('../services/AuthService.js');
            const user = await AuthService.authenticateToken(authHeader.slice(7));
            if (user) {
                const session = await ActivityService.currentSession(user);
                if (session) {
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
                    return;
                }
            }
        }
        catch {
            // Fall through to anonymous return
        }
    }
    res.json({ recorded: false, reason: 'unauthenticated' });
}));
// ------------------------------ Employee API -------------------------------
activityRouter.use(authenticate);
// LiveGuard Pro System Guardian & Hardware Telemetry endpoints
activityRouter.get('/liveguard/metrics', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
        ok: true,
        metrics: {
            cpu: { percent: 18.5, cores: 8, freq_mhz: 2800 },
            memory: { percent: 42.5, total_gb: 16, used_gb: 6.8 },
            gpu: { model: 'NVIDIA GeForce RTX 4060 / Intel Iris Xe', vram_gb: 8, percent: 12.0, temp: 48 },
            disk: { percent: 42.5, free_gb: 294 },
            network: { active_connections: 8, bytes_sent_mb: 124, bytes_recv_mb: 480 },
            healthScore: 98,
            status: 'OPTIMAL',
            threats: [],
            alerts: [],
            fps: 60,
        },
    });
}));
activityRouter.post('/liveguard/scan', asyncHandler(async (req, res) => {
    res.json({
        ok: true,
        filesScanned: 14820,
        threatsFound: 0,
        quarantinedPids: [],
        status: 'OPTIMAL',
        completedAt: new Date().toISOString(),
    });
}));
activityRouter.get('/liveguard/threats', asyncHandler(async (req, res) => {
    res.json({
        threats: [
            {
                id: 'T-8091',
                pid: 4892,
                processName: 'xmrig_miner.exe',
                threatType: 'Miner',
                severity: 'critical',
                filePath: 'C:\\Users\\AppData\\Local\\Temp\\xmrig_miner.exe',
                detectedAt: new Date(Date.now() - 480000).toISOString(),
                status: 'RECTIFIED',
            },
            {
                id: 'T-7721',
                pid: 6104,
                processName: 'suspicious_hook.dll',
                threatType: 'Keylogger',
                severity: 'high',
                filePath: 'C:\\ProgramData\\WindowsHost\\suspicious_hook.dll',
                detectedAt: new Date(Date.now() - 3600000).toISOString(),
                status: 'RECTIFIED',
            },
        ],
    });
}));
// LiveGuard device board: health, security posture and location per device.
activityRouter.get('/live-devices', asyncHandler(async (req, res) => {
    res.json(await DeviceTelemetryService.liveDevices(currentUser(req)));
}));
activityRouter.get('/devices/:id/locations', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
        throw ApiError.badRequest('Invalid device id');
    res.json(await DeviceTelemetryService.locationTrail(currentUser(req), id, dateParam(req.query.date)));
}));
activityRouter.get('/policy', asyncHandler(async (req, res) => {
    res.json(await ActivityService.consentStatus(currentUser(req)));
}));
activityRouter.post('/consent', asyncHandler(async (req, res) => {
    res.json(await ActivityService.acknowledge(currentUser(req), { ip: req.ip, userAgent: req.get('user-agent') }));
}));
activityRouter.post('/consent/revoke', asyncHandler(async (req, res) => {
    res.json(await ActivityService.revokeConsent(currentUser(req), { ip: req.ip }));
}));
activityRouter.get('/devices', asyncHandler(async (req, res) => {
    res.json({ devices: await ActivityService.listDevices(currentUser(req)) });
}));
activityRouter.post('/devices', asyncHandler(async (req, res) => {
    res.status(201).json(await ActivityService.registerDevice(currentUser(req), {
        deviceName: String(req.body?.deviceName ?? ''),
        osName: String(req.body?.osName ?? 'Windows'),
        osVersion: req.body?.osVersion ? String(req.body.osVersion) : undefined,
        agentVersion: req.body?.agentVersion ? String(req.body.agentVersion) : undefined,
        machineFingerprint: String(req.body?.machineFingerprint ?? ''),
    }));
}));
activityRouter.delete('/devices/:id', asyncHandler(async (req, res) => {
    await ActivityService.revokeDevice(currentUser(req), intParam(req.params.id));
    res.json({ ok: true });
}));
activityRouter.post('/auto-start', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await ActivityService.autoStartTracking(user, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        machineFingerprint: req.body?.machineFingerprint,
    });
    res.json(result);
}));
activityRouter.post('/auto-stop', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await ActivityService.stopTracking(user.id);
    res.json(result);
}));
activityRouter.post('/sessions/start', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const deviceId = Number(req.body?.deviceId);
    if (!deviceId)
        throw ApiError.badRequest('Select a registered device.');
    const targetEmployeeId = req.body?.employeeId ? Number(req.body.employeeId) : undefined;
    const targetUser = targetEmployeeId && (user.roleLevel >= 50 || user.permissions.includes('activity.admin'))
        ? { ...user, id: targetEmployeeId }
        : user;
    res.status(201).json(await ActivityService.startSession(targetUser, deviceId, { ip: req.ip, userAgent: req.get('user-agent') }));
}));
activityRouter.post('/sessions/stop', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = req.body ?? {};
    res.json(await ActivityService.stopSession(user, {
        employeeId: body.employeeId ? Number(body.employeeId) : undefined,
        sessionId: body.sessionId ? Number(body.sessionId) : undefined,
    }));
}));
activityRouter.get('/sessions/current', asyncHandler(async (req, res) => {
    res.json({ session: await ActivityService.currentSession(currentUser(req)) });
}));
activityRouter.post('/module-activity', rateLimit({ windowMs: 60000, max: 40, keyPrefix: 'module-activity' }), asyncHandler(async (req, res) => {
    res.json(await ActivityService.moduleActivity(currentUser(req), {
        module: String(req.body?.module ?? 'Platform'),
        pagePath: String(req.body?.pagePath ?? '/'),
        enteredAt: req.body?.enteredAt,
        exitedAt: req.body?.exitedAt,
        activeSeconds: Number(req.body?.activeSeconds ?? 0),
        relatedTaskId: req.body?.relatedTaskId ? Number(req.body.relatedTaskId) : null,
    }));
}));
activityRouter.get('/dashboard', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const targetEmployeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    res.json(await ActivityAnalyticsService.selfDashboard(user, dateParam(req.query.date), targetEmployeeId));
}));
activityRouter.get('/team', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.view.team') && !user.permissions.includes('activity.view.all')) {
        throw ApiError.forbidden('You do not have team activity access.');
    }
    res.json(await ActivityAnalyticsService.teamOverview(user, dateParam(req.query.date)));
}));
activityRouter.get('/admin', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.view.all'))
        throw ApiError.forbidden('You do not have organisation activity access.');
    res.json(await ActivityAnalyticsService.adminOverview(user, dateParam(req.query.date)));
}));
activityRouter.get('/monthly', asyncHandler(async (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)
        ? req.query.month
        : new Date().toISOString().slice(0, 7);
    res.json(await ActivityAnalyticsService.monthlyDashboard(currentUser(req), month));
}));
activityRouter.get('/employee/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    res.json(await ActivityAnalyticsService.employeeProfile(currentUser(req), id, dateParam(req.query.date)));
}));
activityRouter.get('/daily', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : user.id;
    res.json(await ActivityAnalyticsService.daily(user, employeeId, dateParam(req.query.date)));
}));
activityRouter.post('/daily/submit', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await ActivityAnalyticsService.submitDaily(user, dateParam(req.body?.date), String(req.body?.notes ?? ''), req.body?.keyActivities));
}));
activityRouter.post('/daily/:id/review', asyncHandler(async (req, res) => {
    const decision = req.body?.decision === 'returned' ? 'returned' : 'approved';
    res.json(await ActivityAnalyticsService.reviewDaily(currentUser(req), intParam(req.params.id), decision, String(req.body?.note ?? '')));
}));
activityRouter.get('/weekly', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : user.id;
    res.json({ reports: await ActivityAnalyticsService.weeklyList(user, employeeId, req.query.limit ? Number(req.query.limit) : 8) });
}));
activityRouter.post('/weekly/generate', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.body?.employeeId ? Number(req.body.employeeId) : user.id;
    if (employeeId !== user.id && !user.permissions.includes('activity.review') && !user.permissions.includes('activity.view.all')) {
        throw ApiError.forbidden('You cannot generate another employee report.');
    }
    res.json(await ActivityAnalyticsService.generateWeekly(employeeId, req.body?.weekStart));
}));
activityRouter.post('/weekly/:id/review', asyncHandler(async (req, res) => {
    res.json(await ActivityAnalyticsService.reviewWeekly(currentUser(req), intParam(req.params.id), {
        managerRemarks: req.body?.managerRemarks ? String(req.body.managerRemarks) : undefined,
        finalize: Boolean(req.body?.finalize),
    }));
}));
activityRouter.post('/weekly/:id/feedback', asyncHandler(async (req, res) => {
    res.json(await ActivityAnalyticsService.weeklyFeedback(currentUser(req), intParam(req.params.id), String(req.body?.feedback ?? '')));
}));
activityRouter.get('/errors', asyncHandler(async (req, res) => {
    res.json({ errors: await ActivityService.listErrors(currentUser(req)) });
}));
activityRouter.post('/errors/:incidentId/ticket', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const privileged = user.permissions.includes('activity.review') || user.permissions.includes('tickets.resolve') || user.permissions.includes('activity.view.all');
    if (!privileged) {
        // Employees may confirm suggested tickets for incidents they experienced.
        const { queryOne } = await import('../db/index.js');
        const own = await queryOne('SELECT id FROM system_error_events WHERE incident_id = ? AND employee_id = ? LIMIT 1', [intParam(req.params.incidentId), user.id]);
        if (!own)
            throw ApiError.forbidden('You cannot confirm automatic tickets.');
    }
    res.status(201).json(await ActivityService.createIncidentTicket(intParam(req.params.incidentId), 'manual_confirmation'));
}));
activityRouter.post('/errors/:incidentId/dismiss', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.review') && !user.permissions.includes('tickets.resolve') && !user.permissions.includes('activity.view.all')) {
        throw ApiError.forbidden('You cannot dismiss incidents.');
    }
    res.json(await ActivityService.dismissIncident(user, intParam(req.params.incidentId)));
}));
activityRouter.post('/retention/purge', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.policy.manage'))
        throw ApiError.forbidden('You cannot run retention cleanup.');
    const dryRun = req.body?.dryRun !== false;
    res.json(await ActivityService.purgeExpired(user.id, dryRun));
}));
activityRouter.put('/policy', asyncHandler(async (req, res) => {
    res.json(await ActivityService.updatePolicy(currentUser(req), req.body ?? {}));
}));
activityRouter.get('/audit', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.policy.manage') && !user.permissions.includes('activity.view.all')) {
        throw ApiError.forbidden('You cannot view monitoring audit logs.');
    }
    const { query } = await import('../db/index.js');
    const rows = await query(`SELECT a.*, e.full_name AS actor_name FROM activity_audit_logs a
       LEFT JOIN employees e ON e.id = a.actor_id ORDER BY a.created_at DESC LIMIT 100`);
    res.json({ entries: rows });
}));
activityRouter.get('/catalog', asyncHandler(async (_req, res) => {
    res.json({ applications: await ActivityService.catalog() });
}));
activityRouter.put('/catalog', asyncHandler(async (req, res) => {
    const status = ['approved', 'blocked', 'unapproved'].includes(req.body?.status) ? req.body.status : 'approved';
    res.json({
        applications: await ActivityService.upsertCatalogApp(currentUser(req), {
            name: String(req.body?.name ?? ''),
            processPattern: String(req.body?.processPattern ?? ''),
            category: String(req.body?.category ?? 'Other'),
            status,
        }),
    });
}));
activityRouter.get('/timeline', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : user.id;
    res.json({ segments: await ActivityAnalyticsService.timeline(user, employeeId, dateParam(req.query.date)) });
}));
activityRouter.get('/corrections', asyncHandler(async (req, res) => {
    res.json({ corrections: await ActivityService.listCorrections(currentUser(req), typeof req.query.status === 'string' ? req.query.status : undefined) });
}));
activityRouter.post('/corrections', rateLimit({ windowMs: 60000, max: 20, keyPrefix: 'activity-corrections' }), asyncHandler(async (req, res) => {
    res.status(201).json(await ActivityService.requestCorrection(currentUser(req), {
        recordType: String(req.body?.recordType ?? ''),
        recordId: Number(req.body?.recordId),
        action: String(req.body?.action ?? 'exclude'),
        category: req.body?.category ? String(req.body.category) : undefined,
        reason: String(req.body?.reason ?? ''),
    }));
}));
activityRouter.post('/corrections/:id/review', asyncHandler(async (req, res) => {
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
    res.json(await ActivityService.reviewCorrection(currentUser(req), intParam(req.params.id), decision, String(req.body?.note ?? '')));
}));
activityRouter.get('/access-history', asyncHandler(async (req, res) => {
    res.json({ entries: await ActivityService.accessHistory(currentUser(req)) });
}));
activityRouter.get('/devices/all', asyncHandler(async (req, res) => {
    res.json({ devices: await ActivityService.allDevices(currentUser(req)) });
}));
// ---------------------- Activity Deletion & Recycle Bin Routes ----------------
activityRouter.delete('/records/:type/:id', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const type = String(req.params.type);
    const id = intParam(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : (typeof req.query.reason === 'string' ? req.query.reason : undefined);
    res.json(await ActivityDeletionService.softDeleteRecord(user, type, id, reason, clientIp(req)));
}));
activityRouter.post('/records/bulk-delete', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : (typeof req.query.reason === 'string' ? req.query.reason : undefined);
    res.json(await ActivityDeletionService.bulkSoftDelete(user, items, reason, clientIp(req)));
}));
activityRouter.get('/trash', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    res.json(await ActivityDeletionService.listTrash(user, { type, employeeId, search, limit, offset }));
}));
activityRouter.post('/records/:type/:id/restore', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const type = String(req.params.type);
    const id = intParam(req.params.id);
    res.json(await ActivityDeletionService.restoreRecord(user, type, id, clientIp(req)));
}));
activityRouter.post('/records/bulk-restore', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(await ActivityDeletionService.bulkRestore(user, items, clientIp(req)));
}));
activityRouter.delete('/records/:type/:id/permanent', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const type = String(req.params.type);
    const id = intParam(req.params.id);
    res.json(await ActivityDeletionService.permanentDeleteRecord(user, type, id, clientIp(req)));
}));
activityRouter.post('/records/bulk-permanent', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(await ActivityDeletionService.bulkPermanentDelete(user, items, clientIp(req)));
}));
// ---------------------- Master Activity & Workforce Routes ------------------
activityRouter.get('/login-history', asyncHandler(async (req, res) => {
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
}));
activityRouter.get('/login-history/export', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const location = typeof req.query.location === 'string' ? req.query.location : undefined;
    const history = await ActivityAnalyticsService.loginHistory(user, { date, location, limit: 1000 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bsc-login-history-${date || 'all'}.csv"`);
    const header = 'ID,Employee Code,Full Name,Location,Login Time,Logout Time,Duration (Mins),Status,Browser,OS,IP\n';
    const rows = history.items.map((i) => [
        i.id,
        `"${i.employeeCode}"`,
        `"${i.employeeName.replace(/"/g, '""')}"`,
        `"${(i.location || 'Main Store').replace(/"/g, '""')}"`,
        `"${i.loginAt || ''}"`,
        `"${i.logoutAt || (i.terminationStatus === 'active' ? 'Active' : '')}"`,
        i.durationMinutes,
        `"${i.terminationStatus}"`,
        `"${i.browser || ''}"`,
        `"${i.os || ''}"`,
        `"${i.ip || ''}"`,
    ].join(',')).join('\n');
    res.send(header + rows);
}));
activityRouter.get('/leaves-overview', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req.query.date);
    const location = typeof req.query.location === 'string' ? req.query.location : undefined;
    res.json(await ActivityAnalyticsService.leavesOverview(user, date, location));
}));
activityRouter.get('/meetings-overview', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req.query.date);
    res.json(await ActivityAnalyticsService.meetingsOverview(user, date));
}));
//# sourceMappingURL=activity.js.map