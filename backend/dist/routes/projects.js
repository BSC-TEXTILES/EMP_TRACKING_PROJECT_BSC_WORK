import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { ProjectService } from '../services/ProjectService.js';
export const projectsRouter = Router();
projectsRouter.use(authenticate, requireAny('projects.view'));
projectsRouter.get('/', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
        projects: await ProjectService.list(user, {
            status: req.query.status ? String(req.query.status) : undefined,
            search: req.query.search ? String(req.query.search) : undefined,
        }),
    });
}));
projectsRouter.post('/', requireAny('projects.create', 'projects.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        name: z.string().min(3).max(160),
        code: z.string().max(24).optional(),
        description: z.string().max(4000).optional(),
        managerId: z.number().int().positive().nullable().optional(),
        departmentId: z.number().int().positive().nullable().optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        memberIds: z.array(z.number().int().positive()).optional(),
    }), req.body);
    res.status(201).json(await ProjectService.create(user, body));
}));
projectsRouter.get('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    res.json(await ProjectService.detail(id, currentUser(req)));
}));
projectsRouter.post('/:id/status', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ status: z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled']) }), req.body);
    await ProjectService.updateStatus(id, user, body.status);
    res.json({ ok: true });
}));
projectsRouter.delete('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    await ProjectService.remove(id, currentUser(req));
    res.json({ ok: true });
}));
projectsRouter.post('/:id/milestones', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ title: z.string().min(2).max(160), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), description: z.string().max(255).optional() }), req.body);
    res.status(201).json({ id: await ProjectService.addMilestone(id, user, body) });
}));
projectsRouter.patch('/:id/milestones/:milestoneId', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const milestoneId = intParam(req.params.milestoneId, 'milestoneId');
    await ProjectService.completeMilestone(id, milestoneId, currentUser(req));
    res.json({ ok: true });
}));
projectsRouter.post('/:id/members', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ employeeId: z.number().int().positive() }), req.body);
    await ProjectService.addMember(id, user, body.employeeId);
    res.json({ ok: true });
}));
projectsRouter.delete('/:id/members/:employeeId', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const employeeId = intParam(req.params.employeeId, 'employeeId');
    await ProjectService.removeMember(id, currentUser(req), employeeId);
    res.json({ ok: true });
}));
//# sourceMappingURL=projects.js.map