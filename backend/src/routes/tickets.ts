import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { TicketService, TICKET_CATEGORIES } from '../services/TicketService.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const ticketsRouter = Router();
ticketsRouter.use(authenticate);
ticketsRouter.use(requireAny('tickets.create', 'tickets.view.own', 'tickets.view.team', 'tickets.view.all', 'tickets.resolve', 'tickets.manage'));

ticketsRouter.get('/categories', (_req, res) => {
  res.json({ categories: TICKET_CATEGORIES });
});

ticketsRouter.get(
  '/stats',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await TicketService.stats(currentUser(req)));
  }),
);

ticketsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(
      await TicketService.list(user, {
        status: req.query.status ? String(req.query.status) : undefined,
        priority: req.query.priority ? String(req.query.priority) : undefined,
        category: req.query.category ? String(req.query.category) : undefined,
        assigneeId: req.query.assigneeId ? intParam(String(req.query.assigneeId), 'assigneeId') : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        mine: req.query.mine === 'true',
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
      }),
    );
  }),
);

ticketsRouter.post(
  '/',
  requireAny('tickets.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        subject: z.string().min(4).max(200),
        description: z.string().min(10).max(8000),
        category: z.string().min(2).max(64),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        departmentId: z.number().int().positive().nullable().optional(),
        relatedTaskId: z.number().int().positive().nullable().optional(),
        attachmentIds: z.array(z.number().int().positive()).max(10).optional(),
        issueDetails: z.object({
          subcategory: z.string().max(120).optional(),
          stepsToReproduce: z.string().max(4000).optional(),
          expectedResult: z.string().max(2000).optional(),
          actualResult: z.string().max(2000).optional(),
          errorMessage: z.string().max(2000).optional(),
          errorCode: z.string().max(100).optional(),
          affectedModule: z.string().max(120).optional(),
          browserAndOs: z.string().max(300).optional(),
          device: z.string().max(200).optional(),
          impact: z.enum(['individual', 'team', 'organization']).optional(),
          urgency: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          occurredAt: z.string().max(40).optional(),
          relatedProject: z.string().max(200).optional(),
          remarks: z.string().max(2000).optional(),
          diagnosticsConsent: z.boolean().optional(),
          diagnostics: z.object({ online: z.boolean(), viewportWidth: z.number().int().min(0).max(30000), viewportHeight: z.number().int().min(0).max(30000) }).strict().optional(),
        }).strict().refine(value => !value.diagnostics || value.diagnosticsConsent === true, 'Consent is required for diagnostics').optional(),
      }),
      req.body,
    );
    const created = await TicketService.create(user, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    const detail = await TicketService.detail(created.id, user);
    res.status(201).json(detail);
  }),
);

ticketsRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json(await TicketService.detail(id, currentUser(req)));
  }),
);

ticketsRouter.post(
  '/:id/comments',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ body: z.string().min(1).max(4000), isInternal: z.boolean().optional() }), req.body);
    await TicketService.addComment(id, user, body.body, Boolean(body.isInternal));
    res.status(201).json(await TicketService.detail(id, user));
  }),
);

ticketsRouter.post(
  '/:id/action',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        action: z.enum(['assign', 'acknowledge', 'start', 'wait_info', 'resolve', 'close', 'reopen', 'escalate', 'cancel', 'feedback']),
        assigneeId: z.number().int().positive().optional(),
        note: z.string().max(2000).optional(),
        resolution: z.string().max(4000).optional(),
        rating: z.number().int().min(1).max(5).optional(),
      }),
      req.body,
    );
    await TicketService.act(id, user, body.action, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json(await TicketService.detail(id, user));
  }),
);
