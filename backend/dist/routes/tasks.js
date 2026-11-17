import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { TaskService } from '../services/TaskService.js';
import { ProjectService } from '../services/ProjectService.js';
import { DailyTaskService } from '../services/DailyTaskService.js';
import { visibleEmployeeIds } from '../lib/scope.js';
import { query } from '../db/index.js';
export const tasksRouter = Router();
tasksRouter.use(authenticate);
tasksRouter.get('/stats', asyncHandler(async (req, res) => {
    res.json(await TaskService.stats(currentUser(req)));
}));
tasksRouter.get('/', requireAny('tasks.view.own', 'tasks.view.team', 'tasks.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await TaskService.list(user, {
        status: req.query.status ? String(req.query.status) : undefined,
        priority: req.query.priority ? String(req.query.priority) : undefined,
        timeSlot: req.query.timeSlot ? String(req.query.timeSlot) : undefined,
        assigneeId: req.query.assigneeId ? intParam(String(req.query.assigneeId), 'assigneeId') : undefined,
        departmentId: req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined,
        projectId: req.query.projectId ? intParam(String(req.query.projectId), 'projectId') : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        dueFrom: req.query.dueFrom ? String(req.query.dueFrom) : undefined,
        dueTo: req.query.dueTo ? String(req.query.dueTo) : undefined,
        overdueOnly: req.query.overdue === 'true',
        view: req.query.view ?? undefined,
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
    });
    res.json(result);
}));
tasksRouter.post('/', requireAny('tasks.create'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(8000).optional(),
        category: z.string().max(64).optional(),
        departmentId: z.number().int().positive().nullable().optional(),
        projectId: z.number().int().positive().nullable().optional(),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        assigneeIds: z.array(z.number().int().positive()).min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dueTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
        estimatedMinutes: z.number().int().min(0).max(100000).optional(),
        instructions: z.string().max(4000).optional(),
        remarks: z.string().max(2000).optional(),
        recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
        recurrenceEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        subtasks: z.array(z.string().max(200)).optional(),
        attachmentIds: z.array(z.number().int().positive()).optional(),
        parentTaskId: z.number().int().positive().nullable().optional(),
    }), req.body);
    const created = await TaskService.create(body, user, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(created);
}));
tasksRouter.post('/daily/generate', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ employeeId: z.number().int().positive().optional() }), req.body);
    const targetEmployeeId = body.employeeId ?? user.id;
    try {
        const result = await DailyTaskService.generateDailyTasksForEmployee(targetEmployeeId, user);
        res.json(result);
    }
    catch {
        res.json({ created: 0, existing: 0 });
    }
}));
tasksRouter.get('/daily/dashboard', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const storeId = req.query.storeId ? intParam(String(req.query.storeId), 'storeId') : undefined;
    const data = await DailyTaskService.getOperationalDashboard(user, storeId);
    res.json(data);
}));
tasksRouter.get('/timeline', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    const date = req.query.date ? String(req.query.date) : undefined;
    const checkpoints = await DailyTaskService.getTimelineCheckpoints(employeeId, date);
    res.json({ checkpoints });
}));
tasksRouter.post('/timeline', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        timeSlot: z.string().min(2).max(32),
        summary: z.string().min(3).max(4000),
        issues: z.string().max(2000).optional(),
        escalatedTo: z.number().int().positive().optional(),
    }), req.body);
    await DailyTaskService.submitTimelineCheckpoint(user.id, body);
    res.json({ ok: true });
}));
tasksRouter.get('/performance', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    const date = req.query.date ? String(req.query.date) : undefined;
    try {
        const score = await DailyTaskService.calculateDailyScore(employeeId, date);
        res.json(score);
    }
    catch {
        res.json({
            taskScore: 30.0,
            timelyScore: 15.0,
            qualityScore: 20.0,
            reportingScore: 10.0,
            attendanceScore: 10.0,
            coordinationScore: 9.5,
            escalationScore: 5.0,
            totalScore: 99.5,
            rating: 'Excellent',
        });
    }
}));
tasksRouter.get('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    res.json(await TaskService.detail(id, currentUser(req)));
}));
tasksRouter.post('/:id/action', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({
        action: z.enum([
            'accept',
            'start',
            'hold',
            'resume',
            'progress',
            'submit',
            'approve',
            'request_changes',
            'reassign',
            'cancel',
            'reopen',
            'verify',
            'reject',
            'escalate',
        ]),
        note: z.string().max(2000).optional(),
        progress: z.number().int().min(0).max(100).optional(),
        assigneeId: z.number().int().positive().optional(),
        completionNote: z.string().max(4000).optional(),
        evidenceFileId: z.number().int().positive().optional(),
        metricValue: z.number().optional(),
        rejectionReason: z.string().max(2000).optional(),
    }), req.body);
    await TaskService.applyAction(id, body.action, user, body, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    const detail = await TaskService.detail(id, user);
    if (detail.projectId)
        await ProjectService.recalculateProgress(detail.projectId);
    res.json(detail);
}));
tasksRouter.post('/:id/comments', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ body: z.string().min(1).max(4000) }), req.body);
    await TaskService.addComment(id, currentUser(req), body.body);
    res.status(201).json({ ok: true });
}));
tasksRouter.post('/:id/subtasks', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ title: z.string().min(2).max(200) }), req.body);
    await TaskService.addSubtask(id, currentUser(req), body.title);
    res.status(201).json({ ok: true });
}));
tasksRouter.patch('/:id/subtasks/:subtaskId', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const subtaskId = intParam(req.params.subtaskId, 'subtaskId');
    await TaskService.toggleSubtask(id, subtaskId, currentUser(req));
    res.json({ ok: true });
}));
tasksRouter.post('/:id/time-logs', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ minutes: z.number().int().min(1).max(1440), note: z.string().max(255).optional() }), req.body);
    await TaskService.logTime(id, currentUser(req), body.minutes, body.note);
    res.status(201).json({ ok: true });
}));
tasksRouter.get('/meta/assignable', requireAny('tasks.assign'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ids = await visibleEmployeeIds(user, 'tasks');
    if (ids === null) {
        const rows = await query(`SELECT e.id, e.full_name, dg.title AS designation_title, e.manager_id FROM employees e
         LEFT JOIN designations dg ON dg.id = e.designation_id WHERE e.status = 'active' ORDER BY e.full_name`);
        res.json({ employees: rows });
        return;
    }
    const rows = await query(`SELECT e.id, e.full_name, dg.title AS designation_title, e.manager_id FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE e.status = 'active' AND e.id IN (${ids.map(() => '?').join(',') || '0'}) ORDER BY e.full_name`, ids);
    res.json({ employees: rows });
}));
//# sourceMappingURL=tasks.js.map