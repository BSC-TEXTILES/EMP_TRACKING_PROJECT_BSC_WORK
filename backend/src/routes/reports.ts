import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { DailyReportService } from '../services/DailyReportService.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

reportsRouter.get(
  '/suggestions',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(await DailyReportService.suggestions(user.id, req.query.date ? String(req.query.date) : undefined));
  }),
);

reportsRouter.get(
  '/today',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json({ report: await DailyReportService.todayStatus(user.id) });
  }),
);

reportsRouter.get(
  '/',
  requireAny('reports.view.own', 'reports.view.team', 'reports.view.all'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(
      await DailyReportService.list(user, {
        employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
      }),
    );
  }),
);

reportsRouter.post(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        summary: z.string().min(10).max(8000),
        problems: z.string().max(4000).optional(),
        supportRequired: z.string().max(4000).optional(),
        tomorrowPlan: z.string().max(4000).optional(),
        workStart: z.string().max(8).optional(),
        workEnd: z.string().max(8).optional(),
        totalMinutes: z.number().int().min(0).max(1440).optional(),
        tasksCompleted: z.number().int().min(0).optional(),
        tasksInProgress: z.number().int().min(0).optional(),
        tasksPending: z.number().int().min(0).optional(),
        attachmentIds: z.array(z.number().int().positive()).optional(),
      }),
      req.body,
    );
    const result = await DailyReportService.submit(user.id, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(result);
  }),
);

reportsRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json(await DailyReportService.detail(id, currentUser(req)));
  }),
);

reportsRouter.post(
  '/:id/review',
  requireAny('reports.review'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ approve: z.boolean(), note: z.string().max(1000).optional() }), req.body);
    await DailyReportService.review(id, user, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json({ ok: true });
  }),
);
