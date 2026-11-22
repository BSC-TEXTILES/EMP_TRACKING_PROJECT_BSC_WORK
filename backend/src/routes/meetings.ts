import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { MeetingService } from '../services/MeetingService.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const meetingsRouter = Router();
meetingsRouter.use(authenticate);

meetingsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json({
      meetings: await MeetingService.list(user, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        upcoming: req.query.upcoming === 'true',
        limit: req.query.limit ? Number(req.query.limit) : 100,
      }),
    });
  }),
);

meetingsRouter.post(
  '/',
  requireAny('meetings.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(4000).optional(),
        agenda: z.string().max(4000).optional(),
        participantIds: z.array(z.number().int().positive()).default([]),
        startAt: z.string().min(10),
        endAt: z.string().min(10),
        locationType: z.enum(['online', 'room']).optional(),
        roomName: z.string().max(120).optional(),
        departmentId: z.number().int().positive().nullable().optional(),
      }),
      req.body,
    );
    const created = await MeetingService.create(user, { ...body, participantIds: body.participantIds ?? [] }, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(created);
  }),
);

meetingsRouter.get(
  '/by-code/:code',
  asyncHandler(async (req: AuthedRequest, res) => {
    const code = String(req.params.code).trim().toUpperCase();
    res.json(await MeetingService.detailByCode(code, currentUser(req)));
  }),
);

meetingsRouter.post(
  '/instant',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        title: z.string().min(2).max(200).optional(),
        participantIds: z.array(z.number().int().positive()).optional(),
      }),
      req.body ?? {},
    );
    const created = await MeetingService.createInstant(user, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(created);
  }),
);

meetingsRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json(await MeetingService.detail(id, currentUser(req)));
  }),
);

meetingsRouter.post(
  '/:id/end',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    await MeetingService.endMeeting(id, currentUser(req));
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  '/:id/respond',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ response: z.enum(['accepted', 'declined']) }), req.body);
    await MeetingService.respond(id, currentUser(req), body.response);
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  '/:id/join',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const code = await MeetingService.markJoined(id, user);
    res.json({ ok: true, meetingCode: code });
  }),
);

meetingsRouter.get(
  '/:id/rtc-config',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const meeting = await MeetingService.detail(id, user);
    const iceServers: { urls: string; username?: string; credential?: string }[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    if (config.turn.url && config.turn.username) {
      iceServers.push({ urls: config.turn.url, username: config.turn.username, credential: config.turn.credential });
    }
    res.json({ iceServers, meetingCode: meeting.meetingCode, title: meeting.title, turnConfigured: Boolean(config.turn.url) });
  }),
);

meetingsRouter.post(
  '/:id/action-items',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(
      z.object({
        title: z.string().min(2).max(200),
        assigneeId: z.number().int().positive().nullable().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
      req.body,
    );
    await MeetingService.addActionItem(id, currentUser(req), body);
    res.status(201).json({ ok: true });
  }),
);

meetingsRouter.patch(
  '/:id/action-items/:itemId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const itemId = intParam(req.params.itemId, 'itemId');
    await MeetingService.toggleActionItem(id, itemId, currentUser(req));
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  '/:id/outcome',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ outcome: z.string().min(5).max(8000) }), req.body);
    await MeetingService.saveOutcome(id, currentUser(req), body.outcome);
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ reason: z.string().max(500).optional() }), req.body);
    await MeetingService.cancel(id, currentUser(req), body.reason ?? '');
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  '/:id/messages',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ body: z.string().min(1).max(1000) }), req.body);
    res.status(201).json(await MeetingService.addMessage(id, currentUser(req), body.body));
  }),
);
