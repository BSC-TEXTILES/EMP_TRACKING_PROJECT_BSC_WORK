import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../db/index.js';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { NotificationService } from '../services/NotificationService.js';
import { recordAudit } from '../lib/audit.js';
import { emitToEmployees } from '../realtime/io.js';
import { toIso } from '../lib/dates.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const location = typeof req.query.location === 'string' ? req.query.location : undefined;
    const items = await NotificationService.list(user.id, {
      limit: req.query.limit ? Number(req.query.limit) : 30,
      unreadOnly: req.query.unread === 'true',
      offset: req.query.offset ? Number(req.query.offset) : 0,
      category,
      location,
    });
    res.json({ items, unread: await NotificationService.unreadCount(user.id) });
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json({ unread: await NotificationService.unreadCount(user.id) });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    await NotificationService.markAllRead(user.id);
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    await NotificationService.markRead(user.id, id);
    res.json({ ok: true });
  }),
);

notificationsRouter.delete(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    await NotificationService.delete(user.id, id);
    res.json({ ok: true });
  }),
);

/**
 * Bulk announcement fan-out. Audience is resolved on the server from the
 * organisation hierarchy, never trusted from the client as a recipient list.
 */
notificationsRouter.post(
  '/announcements',
  requireAny('notifications.send'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(200),
        message: z.string().min(5).max(4000),
        priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
        audienceType: z.enum(['all', 'employees', 'department', 'role', 'location', 'manager']),
        audienceValue: z.string().max(255).optional(),
        employeeIds: z.array(z.number().int().positive()).optional(),
        expiresAt: z.string().optional(),
      }),
      req.body,
    );

    let recipients: number[] = [];
    switch (body.audienceType) {
      case 'all':
        recipients = (await query<{ id: number }>("SELECT id FROM employees WHERE status = 'active'")).map((r) => Number(r.id));
        break;
      case 'employees':
        recipients = body.employeeIds ?? [];
        break;
      case 'department':
        recipients = (
          await query<{ id: number }>("SELECT id FROM employees WHERE status = 'active' AND department_id = ?", [Number(body.audienceValue)])
        ).map((r) => Number(r.id));
        break;
      case 'role':
        recipients = (await query<{ id: number }>("SELECT id FROM employees WHERE status = 'active' AND role_id = ?", [Number(body.audienceValue)])).map(
          (r) => Number(r.id),
        );
        break;
      case 'location':
        recipients = (await query<{ id: number }>("SELECT id FROM employees WHERE status = 'active' AND location_id = ?", [Number(body.audienceValue)])).map(
          (r) => Number(r.id),
        );
        break;
      case 'manager':
        recipients = (
          await query<{ id: number }>("SELECT id FROM employees WHERE status = 'active' AND manager_id = ?", [Number(body.audienceValue)])
        ).map((r) => Number(r.id));
        break;
      default:
        recipients = [];
    }
    if (recipients.length === 0) {
      res.status(400).json({ error: 'The selected audience has no active employees', code: 'bad_request' });
      return;
    }

    const announcement = await execute(
      `INSERT INTO announcements (title, body, priority, created_by, audience_type, audience_value, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        body.title,
        body.message,
        body.priority ?? 'normal',
        user.id,
        body.audienceType,
        body.audienceValue ?? null,
        body.expiresAt ? new Date(body.expiresAt).toISOString().slice(0, 19).replace('T', ' ') : null,
      ],
    );

    await NotificationService.notify({
      employeeIds: recipients,
      type: 'announcement',
      title: body.title,
      body: body.message.slice(0, 480),
      link: '/notifications',
      priority: body.priority ?? 'normal',
      actorId: user.id,
      announcementId: announcement.insertId,
    });

    await recordAudit({
      actorId: user.id,
      action: 'announcement.sent',
      entityType: 'announcement',
      entityId: announcement.insertId,
      after: { audienceType: body.audienceType, audienceValue: body.audienceValue, recipients: recipients.length },
    });

    res.status(201).json({ id: announcement.insertId, recipients: recipients.length });
  }),
);

notificationsRouter.get(
  '/announcements',
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await query<{
      id: number;
      title: string;
      body: string;
      priority: string;
      audience_type: string;
      author: string;
      published_at: string;
    }>(
      `SELECT a.id, a.title, a.body, a.priority, a.audience_type, e.full_name AS author, a.published_at
       FROM announcements a JOIN employees e ON e.id = a.created_by
       WHERE a.expires_at IS NULL OR a.expires_at > NOW(3)
       ORDER BY a.published_at DESC LIMIT 50`,
    );
    res.json({
      announcements: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        body: r.body,
        priority: r.priority,
        audienceType: r.audience_type,
        author: r.author,
        publishedAt: toIso(r.published_at),
      })),
    });
  }),
);

notificationsRouter.get(
  '/audience-options',
  requireAny('notifications.send'),
  asyncHandler(async (_req, res) => {
    const [departments, roles, locations] = await Promise.all([
      query<{ id: number; name: string }>('SELECT id, name FROM departments ORDER BY name'),
      query<{ id: number; name: string }>("SELECT id, name FROM roles WHERE id IN (SELECT DISTINCT role_id FROM employees) ORDER BY name"),
      query<{ id: number; name: string }>('SELECT id, name FROM locations ORDER BY name'),
    ]);
    res.json({ departments, roles, locations, employeeCount: (await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM employees WHERE status = 'active'"))?.total ?? 0 });
  }),
);
