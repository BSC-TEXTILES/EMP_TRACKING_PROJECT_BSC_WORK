import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { GroupService } from '../services/GroupService.js';
export const groupsRouter = Router();
groupsRouter.use(authenticate);
// Get location-based dashboard summary
groupsRouter.get('/dashboard/summary', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const summary = await GroupService.dashboardSummary(user, locationId);
    res.json(summary);
}));
// Get location audit logs
groupsRouter.get('/audit/logs', requireAny('locations.manage', 'locations.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const logs = await GroupService.auditLogs(user, { locationId, limit });
    res.json({ logs });
}));
// List groups
groupsRouter.get('/', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const isActive = req.query.isActive !== undefined ? req.query.isActive === 'true' || req.query.isActive === '1' : undefined;
    const groups = await GroupService.list(user, { locationId, search, isActive });
    res.json({ groups });
}));
// Get group by ID
groupsRouter.get('/:id', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const result = await GroupService.get(user, id);
    res.json(result);
}));
// Create a new group
groupsRouter.post('/', requireAny('groups.manage', 'locations.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        name: z.string().min(2).max(160),
        code: z.string().max(64).nullable().optional(),
        locationId: z.number().int().positive(),
        managerId: z.number().int().positive().nullable().optional(),
        teamLeaderId: z.number().int().positive().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
    }), req.body);
    const id = await GroupService.create(user, body, { ip: req.ip });
    res.status(201).json({ id });
}));
// Update a group
groupsRouter.patch('/:id', requireAny('groups.manage', 'locations.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(z.object({
        name: z.string().min(2).max(160).optional(),
        code: z.string().max(64).nullable().optional(),
        locationId: z.number().int().positive().optional(),
        managerId: z.number().int().positive().nullable().optional(),
        teamLeaderId: z.number().int().positive().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        isActive: z.boolean().optional(),
    }), req.body);
    await GroupService.update(user, id, body, { ip: req.ip });
    res.json({ ok: true });
}));
// Delete group
groupsRouter.delete('/:id', requireAny('groups.manage', 'locations.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    await GroupService.delete(user, id, { ip: req.ip });
    res.json({ ok: true });
}));
// Add member to group
groupsRouter.post('/:id/members', requireAny('groups.manage', 'employees.manage', 'locations.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(z.object({
        employeeId: z.number().int().positive(),
        role: z.enum(['member', 'team_leader', 'manager']).default('member'),
    }), req.body);
    await GroupService.addMember(user, id, body.employeeId, body.role, { ip: req.ip });
    res.status(201).json({ ok: true });
}));
// Remove member from group
groupsRouter.delete('/:id/members/:employeeId', requireAny('groups.manage', 'employees.manage', 'locations.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const employeeId = intParam(req.params.employeeId, 'employeeId');
    await GroupService.removeMember(user, id, employeeId, { ip: req.ip });
    res.json({ ok: true });
}));
//# sourceMappingURL=groups.js.map