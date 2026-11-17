import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../lib/audit.js';
import { today } from '../lib/dates.js';
import { assertEmployeeAccess } from '../lib/scope.js';
import { asyncHandler, clientIp, parseBody } from '../lib/http.js';
import { authenticate, currentUser, hasPermission, requireAny } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { PRESENCE_LABELS, PresenceService } from '../services/PresenceService.js';
export const presenceRouter = Router();
presenceRouter.use(authenticate);
/** Colleagues see the status (as in any collaboration tool); idle timestamps are for supervisors only. */
function forViewer(entry, viewer) {
    if (entry.employeeId === viewer.id || hasPermission(viewer, 'activity.view.team') || hasPermission(viewer, 'activity.view.all'))
        return entry;
    return { ...entry, lastActiveAt: null };
}
presenceRouter.get('/', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ids = typeof req.query.ids === 'string' && req.query.ids
        ? req.query.ids.split(',').map((v) => Number.parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 500)
        : undefined;
    const entries = await PresenceService.list(ids);
    res.json({ items: entries.map((e) => forViewer(e, user)), labels: PRESENCE_LABELS });
}));
presenceRouter.get('/me', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ presence: await PresenceService.forEmployee(user.id), idleAwayMinutes: await PresenceService.idleMinutes() });
}));
presenceRouter.put('/me', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'presence-set' }), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ status: z.enum(['active', 'away', 'dnd', 'on_leave']) }), req.body);
    const presence = await PresenceService.setManual(user.id, body.status);
    res.json({ presence });
}));
/**
 * Activity ping from the web app: "the user used keyboard/mouse/focus recently".
 * Carries no content. Sent at most about once a minute while the user is active.
 */
presenceRouter.post('/ping', rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'presence-ping' }), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ presence: await PresenceService.ping(user.id) });
}));
presenceRouter.get('/history/:employeeId', requireAny('activity.view.team', 'activity.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = Number.parseInt(String(req.params.employeeId), 10);
    await assertEmployeeAccess(user, employeeId, 'activity');
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : today();
    res.json({ items: await PresenceService.history(employeeId, date) });
}));
presenceRouter.get('/settings', asyncHandler(async (_req, res) => {
    res.json({ idleAwayMinutes: await PresenceService.idleMinutes() });
}));
presenceRouter.put('/settings', requireAny('settings.manage', 'activity.policy.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ idleAwayMinutes: z.number().int().min(1).max(240) }), req.body);
    const before = await PresenceService.idleMinutes();
    const idleAwayMinutes = await PresenceService.setIdleMinutes(body.idleAwayMinutes, user.id);
    await recordAudit({
        actorId: user.id,
        action: 'presence.settings.update',
        entityType: 'system_settings',
        before: { idleAwayMinutes: before },
        after: { idleAwayMinutes },
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
    });
    res.json({ idleAwayMinutes });
}));
//# sourceMappingURL=presence.js.map