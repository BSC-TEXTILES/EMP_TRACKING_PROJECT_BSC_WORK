import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny, requirePermission } from '../middleware/auth.js';
import { IssueService } from '../services/IssueService.js';
export const issuesRouter = Router();
issuesRouter.use(authenticate);
// 1. Get summary counters
issuesRouter.get('/summary', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await IssueService.getSummary(user));
}));
// 2. Get escalation rules
issuesRouter.get('/rules', asyncHandler(async (_req, res) => {
    res.json({ rules: await IssueService.getRules() });
}));
// 3. Update escalation rules (Admin only)
issuesRouter.put('/rules', requirePermission('issues.configure'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        rules: z.array(z.object({
            priority: z.enum(['low', 'medium', 'high', 'critical']),
            ack_reminder_minutes: z.number().int().min(1).max(10080),
            escalate_after_minutes: z.number().int().min(1).max(10080),
            resolve_within_hours: z.number().int().min(1).max(720),
            overdue_repeat_minutes: z.number().int().min(1).max(10080),
            max_level: z.number().int().min(1).max(10),
            notify_higher_immediately: z.boolean(),
        })),
    }), req);
    res.json(await IssueService.updateRules(body.rules, user));
}));
// 4. List issues with tabs and filters
issuesRouter.get('/', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const tab = req.query.tab;
    const result = await IssueService.listIssues(user, {
        tab,
        status: req.query.status ? String(req.query.status) : undefined,
        priority: req.query.priority ? String(req.query.priority) : undefined,
        category: req.query.category ? String(req.query.category) : undefined,
        locationId: req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined,
        departmentId: req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
    });
    res.json(result);
}));
// 5. Create new issue
issuesRouter.post('/', requireAny('issues.create'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        title: z.string().min(3).max(200),
        description: z.string().min(5).max(10000),
        category: z.string().min(2).max(64),
        priority: z.enum(['low', 'medium', 'high', 'critical']),
        affectedModule: z.string().max(120).optional(),
        routingMode: z.enum(['auto', 'manual']).optional(),
        assignedTo: z.number().int().positive().optional(),
        fileIds: z.array(z.number().int().positive()).optional(),
    }), req);
    const result = await IssueService.createIssue(body, user);
    res.status(201).json(result);
}));
// 6. Get single issue details
issuesRouter.get('/:id', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id, 'id');
    res.json(await IssueService.getIssue(id, user));
}));
// 7. Acknowledge issue
issuesRouter.post('/:id/acknowledge', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id, 'id');
    const body = parseBody(z.object({
        note: z.string().max(500).optional(),
    }), req);
    res.json(await IssueService.acknowledgeIssue(id, user, body.note));
}));
// 8. Escalate issue (manual)
issuesRouter.post('/:id/escalate', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id, 'id');
    const body = parseBody(z.object({
        targetEmployeeId: z.number().int().positive().optional(),
        reason: z.string().min(3).max(500),
        note: z.string().max(500).optional(),
    }), req);
    res.json(await IssueService.escalateIssue(id, user, body));
}));
// 9. Reassign issue
issuesRouter.post('/:id/reassign', requireAny('issues.assign'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id, 'id');
    const body = parseBody(z.object({
        targetEmployeeId: z.number().int().positive(),
        reason: z.string().max(500).optional(),
    }), req);
    res.json(await IssueService.reassignIssue(id, user, body));
}));
// 10. Update status / resolve
issuesRouter.post('/:id/status', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id, 'id');
    const body = parseBody(z.object({
        status: z.enum(['in_progress', 'on_hold', 'resolved', 'closed', 'cancelled']),
        resolution: z.string().max(4000).optional(),
        note: z.string().max(500).optional(),
    }), req);
    res.json(await IssueService.updateStatus(id, user, body));
}));
// 11. Reopen issue
issuesRouter.post('/:id/reopen', requireAny('issues.reopen'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id, 'id');
    const body = parseBody(z.object({
        reason: z.string().min(3).max(500),
    }), req);
    res.json(await IssueService.reopenIssue(id, user, body.reason));
}));
// 12. Add comment / internal note
issuesRouter.post('/:id/comments', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id, 'id');
    const body = parseBody(z.object({
        body: z.string().min(1).max(8000),
        isInternal: z.boolean().optional(),
        fileIds: z.array(z.number().int().positive()).optional(),
    }), req);
    res.json(await IssueService.addComment(id, user, body));
}));
//# sourceMappingURL=issues.js.map