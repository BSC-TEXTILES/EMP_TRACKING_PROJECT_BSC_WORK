import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { TaskService } from '../services/TaskService.js';
import { ProjectService } from '../services/ProjectService.js';
import { visibleEmployeeIds } from '../lib/scope.js';
import { query } from '../db/index.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const tasksRouter = Router();
tasksRouter.use(authenticate);

tasksRouter.get(
  '/stats',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await TaskService.stats(currentUser(req)));
  }),
);

tasksRouter.get(
  '/',
  requireAny('tasks.view.own', 'tasks.view.team', 'tasks.view.all'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const result = await TaskService.list(user, {
      status: req.query.status ? String(req.query.status) : undefined,
      priority: req.query.priority ? String(req.query.priority) : undefined,
      assigneeId: req.query.assigneeId ? intParam(String(req.query.assigneeId), 'assigneeId') : undefined,
      departmentId: req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined,
      projectId: req.query.projectId ? intParam(String(req.query.projectId), 'projectId') : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      dueFrom: req.query.dueFrom ? String(req.query.dueFrom) : undefined,
      dueTo: req.query.dueTo ? String(req.query.dueTo) : undefined,
      overdueOnly: req.query.overdue === 'true',
      view: (req.query.view as 'mine' | 'allocated' | 'all' | undefined) ?? undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
    });
    res.json(result);
  }),
);

tasksRouter.post(
  '/',
  requireAny('tasks.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
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
      }),
      req.body,
    );
    const created = await TaskService.create(body, user, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(created);
  }),
);

tasksRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json(await TaskService.detail(id, currentUser(req)));
  }),
);

tasksRouter.post(
  '/:id/action',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({
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
        ]),
        note: z.string().max(2000).optional(),
        progress: z.number().int().min(0).max(100).optional(),
        assigneeId: z.number().int().positive().optional(),
        completionNote: z.string().max(4000).optional(),
      }),
      req.body,
    );
    await TaskService.applyAction(id, body.action, user, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    const detail = await TaskService.detail(id, user);
    if (detail.projectId) await ProjectService.recalculateProgress(detail.projectId);
    res.json(detail);
  }),
);

tasksRouter.post(
  '/:id/comments',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ body: z.string().min(1).max(4000) }), req.body);
    await TaskService.addComment(id, currentUser(req), body.body);
    res.status(201).json({ ok: true });
  }),
);

tasksRouter.post(
  '/:id/subtasks',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ title: z.string().min(2).max(200) }), req.body);
    await TaskService.addSubtask(id, currentUser(req), body.title);
    res.status(201).json({ ok: true });
  }),
);

tasksRouter.patch(
  '/:id/subtasks/:subtaskId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const subtaskId = intParam(req.params.subtaskId, 'subtaskId');
    await TaskService.toggleSubtask(id, subtaskId, currentUser(req));
    res.json({ ok: true });
  }),
);

tasksRouter.post(
  '/:id/time-logs',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ minutes: z.number().int().min(1).max(1440), note: z.string().max(255).optional() }), req.body);
    await TaskService.logTime(id, currentUser(req), body.minutes, body.note);
    res.status(201).json({ ok: true });
  }),
);

tasksRouter.get(
  '/meta/assignable',
  requireAny('tasks.assign'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const ids = await visibleEmployeeIds(user, 'tasks');
    if (ids === null) {
      const rows = await query<{ id: number; full_name: string; designation_title: string | null; manager_id: number | null }>(
        `SELECT e.id, e.full_name, dg.title AS designation_title, e.manager_id FROM employees e
         LEFT JOIN designations dg ON dg.id = e.designation_id WHERE e.status = 'active' ORDER BY e.full_name`,
      );
      res.json({ employees: rows });
      return;
    }
    const rows = await query<{ id: number; full_name: string; designation_title: string | null; manager_id: number | null }>(
      `SELECT e.id, e.full_name, dg.title AS designation_title, e.manager_id FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE e.status = 'active' AND e.id IN (${ids.map(() => '?').join(',') || '0'}) ORDER BY e.full_name`,
      ids,
    );
    res.json({ employees: rows });
  }),
);

