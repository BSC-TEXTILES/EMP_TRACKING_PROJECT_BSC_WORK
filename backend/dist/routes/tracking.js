import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/index.js';
import { ApiError, asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { TrackingAgentService, batchSchema, enrollSchema, getInstallerInfo, heartbeatSchema, listTrackingDevices, } from '../services/tracking/TrackingAgentService.js';
import { TrackingConfig, settingsPatchSchema } from '../services/tracking/TrackingConfig.js';
import { TrackingQueryService, canSeeOthers, deviceLive, trackingScope } from '../services/tracking/TrackingQueryService.js';
import { TrackingReportService } from '../services/tracking/TrackingReportService.js';
import { TrackingWorker } from '../services/tracking/TrackingWorker.js';
import { assertEmployeeAccess } from '../lib/scope.js';
export const trackingRouter = Router();
function deviceToken(req) {
    const auth = req.header('authorization');
    if (auth?.startsWith('Bearer bsct_'))
        return auth.slice(7);
    return req.header('x-device-token') ?? undefined;
}
function requireDevice(req, _res, next) {
    TrackingAgentService.authenticate(deviceToken(req))
        .then((device) => { req.trackingDevice = device; next(); })
        .catch(next);
}
const here = path.dirname(fileURLToPath(import.meta.url));
function installerPath() {
    const name = 'BSC-Activity-Tracker-Setup.exe';
    const candidates = [
        process.env.TRACKING_AGENT_INSTALLER,
        path.resolve(here, '../../../tracking-agent/dist', name),
        path.resolve(process.cwd(), 'tracking-agent/dist', name),
        path.resolve(process.cwd(), '../tracking-agent/dist', name),
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}
// ------------------------------------------------------------ Agent API
// Device-token authenticated; no employee session or password is ever stored on the device.
trackingRouter.post('/agent/enroll', rateLimit({ windowMs: 10 * 60_000, max: 20, keyPrefix: 'tracking-enroll' }), asyncHandler(async (req, res) => {
    res.json(await TrackingAgentService.enroll(parseBody(enrollSchema, req.body), clientIp(req)));
}));
trackingRouter.post('/agent/heartbeat', rateLimit({ windowMs: 60_000, max: 600, keyPrefix: 'tracking-heartbeat' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await TrackingAgentService.heartbeat(req.trackingDevice, parseBody(heartbeatSchema, req.body), clientIp(req)));
}));
trackingRouter.post('/agent/events', rateLimit({ windowMs: 60_000, max: 600, keyPrefix: 'tracking-events' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await TrackingAgentService.ingest(req.trackingDevice, parseBody(batchSchema, req.body), clientIp(req)));
}));
trackingRouter.post('/agent/acknowledge', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'tracking-ack' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await TrackingAgentService.acknowledgeNotice(req.trackingDevice, clientIp(req)));
}));
trackingRouter.post('/agent/unenroll', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'tracking-unenroll' }), requireDevice, asyncHandler(async (req, res) => {
    res.json(await TrackingAgentService.unenroll(req.trackingDevice, clientIp(req)));
}));
// ------------------------------------------------------------- Web API
trackingRouter.use(authenticate);
trackingRouter.get('/agent/download', asyncHandler(async (_req, res) => {
    const file = installerPath();
    if (!file)
        throw ApiError.notFound('The tracking agent installer has not been built on this server. See docs/TRACKING_AGENT.md.');
    res.download(file, 'BSC-Activity-Tracker-Setup.exe');
}));
trackingRouter.get('/agent/info', asyncHandler(async (_req, res) => {
    const settings = await TrackingConfig.forLocation(null);
    const installer = getInstallerInfo();
    res.json({
        latestVersion: settings.latestAgentVersion,
        minimumVersion: settings.minimumAgentVersion,
        publisher: 'BSC Textiles Pvt Ltd',
        downloadPath: '/api/tracking/agent/download',
        sha256: installer?.sha256 ?? null,
        sizeBytes: installer?.size ?? null,
    });
}));
/** HRMS page usage from the signed-in web app. */
trackingRouter.post('/web/page', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'tracking-web-page' }), asyncHandler(async (req, res) => {
    const body = parseBody(z.object({
        module: z.string().max(60),
        path: z.string().max(300),
        startedAt: z.string().max(40),
        endedAt: z.string().max(40),
        activeSeconds: z.number().min(0).max(86400),
    }), req.body);
    res.json(await TrackingAgentService.recordHrmsPage(currentUser(req), body));
}));
trackingRouter.get('/overview', asyncHandler(async (req, res) => {
    res.json(await TrackingQueryService.overview(currentUser(req), {
        date: typeof req.query.date === 'string' ? req.query.date : undefined,
        location: typeof req.query.location === 'string' ? req.query.location : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        search: typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : undefined,
        sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
        order: typeof req.query.order === 'string' ? req.query.order : undefined,
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 25,
    }));
}));
trackingRouter.get('/alerts', asyncHandler(async (req, res) => {
    res.json(await TrackingWorker.alerts(currentUser(req)));
}));
trackingRouter.get('/employees/:id', asyncHandler(async (req, res) => {
    res.json(await TrackingQueryService.employeeDetails(currentUser(req), intParam(req.params.id), req.query.date, clientIp(req)));
}));
trackingRouter.get('/devices', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    let ids;
    if (req.query.employeeId) {
        const id = intParam(String(req.query.employeeId), 'employeeId');
        await assertEmployeeAccess(user, id, 'activity');
        ids = [id];
    }
    else if (canSeeOthers(user)) {
        ids = await trackingScope(user);
    }
    else {
        ids = [user.id];
    }
    const rows = await listTrackingDevices(user, ids);
    const settingsByLoc = new Map();
    const devices = [];
    for (const row of rows) {
        const loc = row.location_id ? Number(row.location_id) : null;
        if (!settingsByLoc.has(loc))
            settingsByLoc.set(loc, await TrackingConfig.forLocation(loc));
        const live = deviceLive({ ...row, device_id: row.id }, settingsByLoc.get(loc));
        devices.push({
            ...live,
            status: String(row.status),
            employeeName: String(row.full_name),
            employeeCode: String(row.employee_code),
            locationCode: row.location_code ?? null,
            registeredAt: row.registered_at,
            revokedAt: row.revoked_at,
            revokedReason: row.revoked_reason,
        });
    }
    res.json({ devices, canManage: user.permissions.includes('activity.devices.manage') });
}));
trackingRouter.post('/devices/:id/revoke', asyncHandler(async (req, res) => {
    res.json(await TrackingAgentService.revokeDevice(currentUser(req), intParam(req.params.id), clientIp(req)));
}));
trackingRouter.get('/enrollment-codes', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const scope = canSeeOthers(user) && user.permissions.includes('activity.devices.manage') ? await trackingScope(user) : [user.id];
    const where = scope === null ? '' : scope.length ? `AND c.employee_id IN (${scope.map(() => '?').join(',')})` : 'AND 1 = 0';
    const rows = await query(`SELECT c.id, c.employee_id, c.code_hint, c.expires_at, c.created_at, e.full_name, e.employee_code, cb.full_name AS created_by_name
       FROM tracking_enrollment_codes c
       JOIN employees e ON e.id = c.employee_id
       LEFT JOIN employees cb ON cb.id = c.created_by
       WHERE c.used_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > NOW(3) ${where}
       ORDER BY c.created_at DESC LIMIT 200`, scope ?? []);
    res.json({ codes: rows });
}));
trackingRouter.post('/enrollment-codes', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'tracking-codes' }), asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ employeeId: z.number().int().positive() }), req.body);
    res.json(await TrackingAgentService.createEnrollmentCode(currentUser(req), body.employeeId, clientIp(req)));
}));
trackingRouter.delete('/enrollment-codes/:id', asyncHandler(async (req, res) => {
    await TrackingAgentService.revokeEnrollmentCode(currentUser(req), intParam(req.params.id), clientIp(req));
    res.json({ ok: true });
}));
trackingRouter.get('/settings', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!user.permissions.includes('activity.policy.manage') && !user.permissions.includes('activity.view.all')) {
        throw ApiError.forbidden('You cannot view tracking settings.');
    }
    res.json({ ...(await TrackingConfig.describe(user)), canEdit: user.permissions.includes('activity.policy.manage') });
}));
trackingRouter.put('/settings', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({
        locationId: z.number().int().positive().nullable(),
        settings: settingsPatchSchema,
    }), req.body);
    res.json(await TrackingConfig.update(currentUser(req), body.locationId, body.settings, clientIp(req)));
}));
trackingRouter.get('/reports/export', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'tracking-report' }), asyncHandler(async (req, res) => {
    const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
    const result = await TrackingReportService.generate(currentUser(req), {
        format,
        from: String(req.query.from ?? ''),
        to: String(req.query.to ?? ''),
        employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
        location: typeof req.query.location === 'string' ? req.query.location : undefined,
    }, clientIp(req));
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(result.buffer);
}));
trackingRouter.post('/retention', asyncHandler(async (req, res) => {
    const dryRun = req.body?.dryRun !== false;
    res.json(await TrackingWorker.retention(currentUser(req), dryRun, clientIp(req)));
}));
//# sourceMappingURL=tracking.js.map