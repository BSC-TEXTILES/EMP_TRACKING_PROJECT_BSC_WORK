import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../db/index.js';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { recordAudit, setSetting, SETTING_DEFAULTS } from '../lib/audit.js';
import { toIso } from '../lib/dates.js';
import { connectedSocketCount, onlineEmployeeIds } from '../realtime/io.js';
import { FileService } from '../services/FileService.js';
import { EmailService } from '../services/EmailService.js';
import { processEmailQueue } from '../lib/mailer.js';
import { config } from '../config.js';
import { validateEnvironment } from '../lib/envValidation.js';
import { getIO } from '../realtime/io.js';
/** JSON columns arrive already parsed from mysql2; legacy string rows still need parsing. */
function parseAuditJson(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        }
        catch {
            return value;
        }
    }
    return value;
}
export const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.get('/settings', requireAny('settings.manage', 'admin.dashboard'), asyncHandler(async (_req, res) => {
    const rows = await query('SELECT setting_key, setting_value, updated_at FROM system_settings ORDER BY setting_key');
    const settings = { ...SETTING_DEFAULTS };
    for (const row of rows)
        settings[row.setting_key] = row.setting_value ?? '';
    res.json({ settings });
}));
adminRouter.put('/settings', requireAny('settings.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ settings: z.record(z.string().min(1).max(64), z.string().max(4000)) }), req.body);
    const allowed = new Set([...Object.keys(SETTING_DEFAULTS), 'employee_code_seq', 'task_no_seq', 'ticket_no_seq', 'project_seq']);
    for (const [key, value] of Object.entries(body.settings)) {
        if (!allowed.has(key) && !key.startsWith('loc_'))
            continue;
        await setSetting(key, value, user.id);
    }
    await recordAudit({ actorId: user.id, action: 'settings.updated', entityType: 'system_settings', after: body.settings });
    res.json({ ok: true });
}));
adminRouter.get('/audit', requireAny('audit.view'), asyncHandler(async (req, res) => {
    const clauses = ['1 = 1'];
    const params = [];
    if (req.query.action) {
        clauses.push('a.action LIKE ?');
        params.push(`%${String(req.query.action)}%`);
    }
    if (req.query.entityType) {
        clauses.push('a.entity_type = ?');
        params.push(String(req.query.entityType));
    }
    if (req.query.actorId) {
        clauses.push('a.actor_id = ?');
        params.push(intParam(String(req.query.actorId), 'actorId'));
    }
    if (req.query.from) {
        clauses.push('a.created_at >= ?');
        params.push(`${String(req.query.from)} 00:00:00`);
    }
    if (req.query.to) {
        clauses.push('a.created_at <= ?');
        params.push(`${String(req.query.to)} 23:59:59`);
    }
    const limit = Math.min(200, Number(req.query.limit ?? 50));
    const rows = await query(`SELECT a.id, a.actor_id, e.full_name AS actor_name, a.action, a.entity_type, a.entity_id, a.before_data, a.after_data, a.ip, a.created_at
       FROM audit_logs a LEFT JOIN employees e ON e.id = a.actor_id
       WHERE ${clauses.join(' AND ')} ORDER BY a.created_at DESC LIMIT ${limit}`, params);
    res.json({
        entries: rows.map((r) => ({
            id: Number(r.id),
            actorId: r.actor_id ? Number(r.actor_id) : null,
            actorName: r.actor_name,
            action: r.action,
            entityType: r.entity_type,
            entityId: r.entity_id ? Number(r.entity_id) : null,
            before: parseAuditJson(r.before_data),
            after: parseAuditJson(r.after_data),
            ip: r.ip,
            createdAt: toIso(r.created_at),
        })),
    });
}));
adminRouter.get('/environment', requireAny('settings.manage', 'admin.dashboard'), asyncHandler(async (_req, res) => {
    res.json(validateEnvironment());
}));
adminRouter.get('/email', requireAny('settings.manage', 'admin.dashboard'), asyncHandler(async (req, res) => {
    const [overview, deliveries] = await Promise.all([
        EmailService.overview(),
        EmailService.deliveries({
            status: typeof req.query.status === 'string' ? req.query.status : undefined,
            search: typeof req.query.search === 'string' ? req.query.search : undefined,
            limit: req.query.limit ? Number(req.query.limit) : 50,
        }),
    ]);
    res.json({ ...overview, deliveries });
}));
adminRouter.post('/email/test', requireAny('settings.manage'), asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ to: z.string().email().max(190) }), req.body);
    const user = currentUser(req);
    const result = await EmailService.sendTest(body.to);
    await recordAudit({
        actorId: user.id,
        action: 'email.test_sent',
        entityType: 'email',
        after: { to: body.to, delivered: result.delivered },
    });
    if (!result.delivered) {
        res.status(400).json({ error: result.error ?? 'Test email could not be delivered', code: 'email_delivery_failed' });
        return;
    }
    res.json({ delivered: true });
}));
adminRouter.post('/email/retry/:id', requireAny('settings.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(String(req.params.id), 'id');
    const queued = await EmailService.retry(id);
    if (!queued) {
        res.status(400).json({ error: 'Only failed or skipped messages can be retried.', code: 'bad_request' });
        return;
    }
    await processEmailQueue(5);
    await recordAudit({ actorId: user.id, action: 'email.retried', entityType: 'email', entityId: id });
    res.json({ queued: true });
}));
adminRouter.post('/email/retry-all', requireAny('settings.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!config.smtp.configured) {
        res.status(400).json({ error: 'SMTP is not configured. Save the SMTP settings above first, then retry.', code: 'smtp_not_configured' });
        return;
    }
    const body = parseBody(z.object({ days: z.number().int().min(1).max(90).optional() }), req.body ?? {});
    const requeued = await EmailService.retryAll(body.days ?? 7);
    // Send the first batch now; the scheduler drains the rest with backoff.
    if (requeued > 0)
        await processEmailQueue(25);
    await recordAudit({ actorId: user.id, action: 'email.retried_all', entityType: 'email', after: { requeued } });
    res.json({ requeued });
}));
adminRouter.get('/jobs', requireAny('settings.manage', 'admin.dashboard'), asyncHandler(async (_req, res) => {
    const rows = await query('SELECT id, job_name, started_at, finished_at, status, message FROM job_runs ORDER BY id DESC LIMIT 50');
    res.json({
        runs: rows.map((r) => ({
            id: Number(r.id),
            job: r.job_name,
            startedAt: toIso(r.started_at),
            finishedAt: toIso(r.finished_at),
            status: r.status,
            message: r.message,
        })),
    });
}));
adminRouter.get('/system', requireAny('settings.manage', 'admin.dashboard'), asyncHandler(async (_req, res) => {
    const [db, storage] = await Promise.all([
        queryOne('SELECT VERSION() AS version, (SELECT COUNT(*) FROM information_schema.PROCESSLIST) AS connections, 0 AS uptime'),
        FileService.stats(),
    ]);
    res.json({
        database: { version: db?.version ?? 'unknown', connections: Number(db?.connections ?? 0) },
        storage,
        realtime: { sockets: connectedSocketCount(), online: onlineEmployeeIds().length, engine: Boolean(getIO()) },
        runtime: { node: process.version, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
    });
}));
adminRouter.post('/leave-types', requireAny('org.manage'), asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ name: z.string().min(2).max(120), code: z.string().min(2).max(24),
        annualQuota: z.number().min(0).max(366).multipleOf(0.5), isPaid: z.boolean(), requiresDocument: z.boolean() }), req.body);
    const result = await execute('INSERT INTO leave_types (name, code, annual_quota, is_paid, requires_document) VALUES (?, ?, ?, ?, ?)', [body.name, body.code.toUpperCase(), body.annualQuota, Number(body.isPaid), Number(body.requiresDocument)]);
    await recordAudit({ actorId: currentUser(req).id, action: 'leave_type.created', entityType: 'leave_type', entityId: result.insertId, after: body });
    res.status(201).json({ id: result.insertId });
}));
// ------------------------------ Office Times & Shifts ------------------------------
adminRouter.get('/office-times', requireAny('settings.manage', 'org.manage', 'admin.dashboard', 'locations.manage'), asyncHandler(async (_req, res) => {
    const rows = await query('SELECT setting_key, setting_value FROM system_settings');
    const settings = { ...SETTING_DEFAULTS };
    for (const r of rows)
        settings[r.setting_key] = r.setting_value ?? '';
    const locRows = await query('SELECT id, name, code, city, timezone FROM locations WHERE is_active = 1 ORDER BY code');
    let locationShifts = {};
    if (settings.location_shifts_json) {
        try {
            locationShifts = JSON.parse(settings.location_shifts_json);
        }
        catch {
            locationShifts = {};
        }
    }
    const locations = locRows.map((loc) => {
        const custom = locationShifts[String(loc.id)] || {
            workStartTime: settings[`loc_work_start_${loc.id}`],
            workEndTime: settings[`loc_work_end_${loc.id}`],
            lateGraceMinutes: settings[`loc_grace_${loc.id}`] ? Number(settings[`loc_grace_${loc.id}`]) : undefined,
        };
        const hasCustom = Boolean(custom.workStartTime && custom.workEndTime);
        return {
            id: Number(loc.id),
            name: loc.name,
            code: loc.code,
            city: loc.city,
            timezone: loc.timezone || 'Asia/Kolkata',
            workStartTime: custom.workStartTime || settings.work_start_time || '09:30',
            workEndTime: custom.workEndTime || settings.work_end_time || '18:30',
            lateGraceMinutes: custom.lateGraceMinutes != null ? Number(custom.lateGraceMinutes) : Number(settings.late_grace_minutes || 10),
            shiftName: custom.shiftName || 'Standard Store Shift',
            isCustom: hasCustom,
        };
    });
    let shiftsCatalog = [
        {
            id: 'gen-01',
            name: 'General Store Shift',
            code: 'GEN-01',
            startTime: '09:30',
            endTime: '18:30',
            graceMinutes: 10,
            description: 'Standard daytime shift for all retail stores and head office',
            isDefault: true,
            active: true,
        },
        {
            id: 'morn-01',
            name: 'Morning Retail Shift',
            code: 'MORN-01',
            startTime: '09:00',
            endTime: '18:00',
            graceMinutes: 15,
            description: 'Morning floor operations, stock receiving and counter opening',
            isDefault: false,
            active: true,
        },
        {
            id: 'eve-01',
            name: 'Evening Retail Shift',
            code: 'EVE-01',
            startTime: '11:30',
            endTime: '20:30',
            graceMinutes: 15,
            description: 'Afternoon customer traffic, closing tally and reconciliation',
            isDefault: false,
            active: true,
        },
        {
            id: 'corp-01',
            name: 'Corporate & Administrative',
            code: 'CORP-01',
            startTime: '09:30',
            endTime: '18:30',
            graceMinutes: 10,
            description: 'Corporate staff, accounts, digital marketing & IT technology team',
            isDefault: false,
            active: true,
        },
    ];
    if (settings.shifts_catalog_json) {
        try {
            const parsedCatalog = JSON.parse(settings.shifts_catalog_json);
            if (Array.isArray(parsedCatalog) && parsedCatalog.length > 0) {
                shiftsCatalog = parsedCatalog;
            }
        }
        catch {
            // use defaults
        }
    }
    const workDays = (settings.work_days || '1,2,3,4,5,6')
        .split(',')
        .map(Number)
        .filter((n) => !isNaN(n));
    // Calculate current shift status
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const currentTimeKolkata = formatter.format(now);
    const [curH, curM] = currentTimeKolkata.split(':').map(Number);
    const curMinutes = curH * 60 + curM;
    const [startH, startM] = (settings.work_start_time || '09:30').split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const [endH, endM] = (settings.work_end_time || '18:30').split(':').map(Number);
    const endMinutes = endH * 60 + endM;
    const inShift = curMinutes >= startMinutes && curMinutes <= endMinutes;
    const isLateWindow = curMinutes > startMinutes && curMinutes <= startMinutes + Number(settings.late_grace_minutes || 10);
    res.json({
        general: {
            workStartTime: settings.work_start_time || '09:30',
            workEndTime: settings.work_end_time || '18:30',
            lateGraceMinutes: Number(settings.late_grace_minutes || 10),
            halfDayHours: Number(settings.half_day_hours || 4),
            fullDayHours: Number(settings.full_day_hours || 9),
            overtimeAfterHours: Number(settings.overtime_after_hours || 9),
            missingCheckoutGraceMinutes: Number(settings.missing_checkout_grace_minutes || 120),
            workDays,
            dailyReportReminderTime: settings.daily_report_reminder_time || '18:00',
            lunchStartTime: settings.lunch_start_time || '13:00',
            lunchEndTime: settings.lunch_end_time || '14:00',
            breakDurationMinutes: Number(settings.break_duration_minutes || 60),
        },
        locations,
        shifts: shiftsCatalog,
        currentStatus: {
            currentTime: currentTimeKolkata,
            timezone: 'Asia/Kolkata',
            inShift,
            isLateWindow,
            statusLabel: inShift ? 'Store Open · Shift Active' : curMinutes < startMinutes ? 'Pre-Shift · Store Closed' : 'Post-Shift · Store Closed',
        },
    });
}));
adminRouter.put('/office-times', requireAny('settings.manage', 'org.manage', 'locations.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const schema = z.object({
        general: z.object({
            workStartTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
            workEndTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
            lateGraceMinutes: z.number().int().min(0).max(180),
            halfDayHours: z.number().min(1).max(12),
            fullDayHours: z.number().min(1).max(24),
            overtimeAfterHours: z.number().min(1).max(24),
            missingCheckoutGraceMinutes: z.number().int().min(0).max(360).optional(),
            workDays: z.array(z.number().int().min(0).max(6)).min(1),
            dailyReportReminderTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
            lunchStartTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
            lunchEndTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
            breakDurationMinutes: z.number().int().min(0).max(180).optional(),
        }),
        locations: z.array(z.object({
            id: z.number().int().positive(),
            workStartTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
            workEndTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
            lateGraceMinutes: z.number().int().min(0).max(180).optional(),
            shiftName: z.string().max(100).optional(),
            isCustom: z.boolean(),
        })).optional(),
        shifts: z.array(z.object({
            id: z.string().max(32),
            name: z.string().min(2).max(100),
            code: z.string().min(2).max(32),
            startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
            endTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
            graceMinutes: z.number().int().min(0).max(180),
            description: z.string().max(255).optional(),
            isDefault: z.boolean().optional(),
            active: z.boolean().optional(),
        })).optional(),
    });
    const body = parseBody(schema, req.body);
    const g = body.general;
    await setSetting('work_start_time', g.workStartTime, user.id);
    await setSetting('work_end_time', g.workEndTime, user.id);
    await setSetting('late_grace_minutes', String(g.lateGraceMinutes), user.id);
    await setSetting('half_day_hours', String(g.halfDayHours), user.id);
    await setSetting('full_day_hours', String(g.fullDayHours), user.id);
    await setSetting('overtime_after_hours', String(g.overtimeAfterHours), user.id);
    await setSetting('work_days', g.workDays.sort().join(','), user.id);
    if (g.missingCheckoutGraceMinutes != null)
        await setSetting('missing_checkout_grace_minutes', String(g.missingCheckoutGraceMinutes), user.id);
    if (g.dailyReportReminderTime)
        await setSetting('daily_report_reminder_time', g.dailyReportReminderTime, user.id);
    if (g.lunchStartTime)
        await setSetting('lunch_start_time', g.lunchStartTime, user.id);
    if (g.lunchEndTime)
        await setSetting('lunch_end_time', g.lunchEndTime, user.id);
    if (g.breakDurationMinutes != null)
        await setSetting('break_duration_minutes', String(g.breakDurationMinutes), user.id);
    if (body.locations) {
        const locMap = {};
        for (const loc of body.locations) {
            if (loc.isCustom && loc.workStartTime && loc.workEndTime) {
                locMap[String(loc.id)] = {
                    workStartTime: loc.workStartTime,
                    workEndTime: loc.workEndTime,
                    lateGraceMinutes: loc.lateGraceMinutes ?? g.lateGraceMinutes,
                    shiftName: loc.shiftName || 'Store Shift',
                };
                await setSetting(`loc_work_start_${loc.id}`, loc.workStartTime, user.id);
                await setSetting(`loc_work_end_${loc.id}`, loc.workEndTime, user.id);
                await setSetting(`loc_grace_${loc.id}`, String(loc.lateGraceMinutes ?? g.lateGraceMinutes), user.id);
            }
            else {
                await setSetting(`loc_work_start_${loc.id}`, '', user.id);
                await setSetting(`loc_work_end_${loc.id}`, '', user.id);
                await setSetting(`loc_grace_${loc.id}`, '', user.id);
            }
        }
        await setSetting('location_shifts_json', JSON.stringify(locMap), user.id);
    }
    if (body.shifts) {
        await setSetting('shifts_catalog_json', JSON.stringify(body.shifts), user.id);
    }
    await recordAudit({
        actorId: user.id,
        action: 'office_times.updated',
        entityType: 'office_times',
        after: { general: g, locationCount: body.locations?.length ?? 0, shiftCount: body.shifts?.length ?? 0 },
    });
    res.json({ ok: true, message: 'Office times and shift schedules saved successfully.' });
}));
/**
 * Live Login and Branch Tracking Audit
 * Returns real-time login/logout history, assigned location, online state and device info.
 */
adminRouter.get('/login-audit', requireAny('settings.manage', 'audit.view', 'admin.dashboard', 'employees.view.team', 'employees.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const location = typeof req.query.location === 'string' ? req.query.location.trim() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const isGlobal = (user.roleLevel ?? 0) >= 70 || user.roleSlug === 'super_admin';
    const allowedLocIds = user.allowedLocations?.map((l) => l.id) ?? (user.locationId ? [user.locationId] : []);
    const conditions = [];
    const params = [];
    if (!isGlobal && allowedLocIds.length > 0) {
        conditions.push(`e.location_id IN (${allowedLocIds.map(() => '?').join(',')})`);
        params.push(...allowedLocIds);
    }
    if (location) {
        conditions.push(`(l.code = ? OR l.name LIKE ? OR a.location_name LIKE ?)`);
        params.push(location, `%${location}%`, `%${location}%`);
    }
    if (search) {
        conditions.push(`(a.full_name LIKE ? OR a.employee_code LIKE ? OR a.ip LIKE ? OR a.browser LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRow = await queryOne(`SELECT COUNT(*) AS total
       FROM employee_login_audit a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN locations l ON l.id = e.location_id
       ${where}`, params);
    const rows = await query(`SELECT a.id, a.session_id, a.employee_id, a.employee_code, a.full_name,
              COALESCE(l.name, a.location_name, 'Head Office') AS location_name,
              l.code AS location_code,
              d.name AS department_name,
              dg.title AS designation_title,
              a.login_at, a.logout_at, a.last_heartbeat_at, a.duration_minutes,
              a.ip, a.user_agent, a.browser, a.os,
              a.login_status, a.logout_reason, a.termination_status
       FROM employee_login_audit a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       ${where}
       ORDER BY a.login_at DESC
       LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({
        records: rows.map((r) => ({
            id: Number(r.id),
            sessionId: r.session_id ? Number(r.session_id) : null,
            employeeId: Number(r.employee_id),
            employeeCode: r.employee_code,
            fullName: r.full_name,
            locationName: r.location_name,
            locationCode: r.location_code || 'HUB',
            department: r.department_name,
            designation: r.designation_title,
            loginAt: toIso(r.login_at),
            logoutAt: r.logout_at ? toIso(r.logout_at) : null,
            lastHeartbeatAt: toIso(r.last_heartbeat_at),
            durationMinutes: Number(r.duration_minutes || 0),
            ip: r.ip,
            browser: r.browser,
            os: r.os,
            status: r.login_status,
            logoutReason: r.logout_reason,
            terminationStatus: r.termination_status,
            isLive: !r.logout_at && r.termination_status === 'active',
        })),
        total: Number(countRow?.total ?? 0),
    });
}));
//# sourceMappingURL=admin.js.map