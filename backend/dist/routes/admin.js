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
        if (!allowed.has(key))
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
//# sourceMappingURL=admin.js.map