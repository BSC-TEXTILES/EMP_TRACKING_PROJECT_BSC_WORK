import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { KpiService } from '../services/KpiService.js';
import { assertEmployeeAccess } from '../lib/scope.js';
import { today } from '../lib/dates.js';
export const kpiRouter = Router();
kpiRouter.use(authenticate);
kpiRouter.get('/parameters', requireAny('kpi.view.own', 'kpi.view.team', 'kpi.view.all'), asyncHandler(async (req, res) => {
    res.json(await KpiService.parameters(req.query.templateId ? Number(req.query.templateId) : undefined));
}));
kpiRouter.put('/parameters', requireAny('kpi.configure'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        templateId: z.number().int().positive(),
        weights: z.array(z.object({ key: z.string(), weight: z.number().min(0).max(100) })).min(1),
    }), req.body);
    await KpiService.updateWeights(user, body.templateId, body.weights);
    res.json({ ok: true });
}));
kpiRouter.get('/', requireAny('kpi.view.own', 'kpi.view.team', 'kpi.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await KpiService.list(user, {
        period: req.query.period ? String(req.query.period) : undefined,
        employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
        scope: req.query.scope ?? undefined,
    }));
}));
kpiRouter.get('/history', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    await assertEmployeeAccess(user, employeeId, 'kpi');
    res.json({ history: await KpiService.history(employeeId), trend: await KpiService.trendFor(employeeId) });
}));
kpiRouter.get('/comparison', requireAny('kpi.view.team', 'kpi.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const period = String(req.query.period ?? today().slice(0, 7));
    res.json({
        period,
        team: await KpiService.teamComparison(user, period),
        departments: await KpiService.departmentAverages(period),
    });
}));
kpiRouter.post('/generate', requireAny('kpi.configure', 'kpi.publish', 'kpi.review'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        period: z.string().regex(/^\d{4}-\d{2}$/),
        employeeIds: z.array(z.number().int().positive()).optional(),
    }), req.body);
    res.json(await KpiService.generate(body.period, user, body.employeeIds));
}));
kpiRouter.post('/publish', requireAny('kpi.publish'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
    res.json(await KpiService.publish(body.period, user));
}));
kpiRouter.get('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    res.json(await KpiService.detail(id, currentUser(req)));
}));
kpiRouter.post('/:id/review', requireAny('kpi.review'), asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({
        scores: z.array(z.object({ key: z.string(), score: z.number().min(0).max(100) })).optional(),
        strengths: z.string().max(2000).optional(),
        improvements: z.string().max(2000).optional(),
        managerComment: z.string().max(2000).optional(),
    }), req.body);
    await KpiService.review(id, user, body);
    res.json(await KpiService.detail(id, user));
}));
kpiRouter.post('/:id/comment', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ comment: z.string().min(1).max(2000) }), req.body);
    await KpiService.employeeComment(id, user.id, body.comment);
    res.json({ ok: true });
}));
//# sourceMappingURL=kpi.js.map