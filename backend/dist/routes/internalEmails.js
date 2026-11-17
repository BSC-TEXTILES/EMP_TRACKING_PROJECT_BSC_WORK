import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { InternalEmailService } from '../services/InternalEmailService.js';
export const internalEmailsRouter = Router();
internalEmailsRouter.use(authenticate);
internalEmailsRouter.get('/inbox', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await InternalEmailService.inbox(user.id, {
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 20,
        search: req.query.search ? String(req.query.search) : undefined,
        starredOnly: req.query.starred === 'true',
        unreadOnly: req.query.unread === 'true',
    });
    res.json(result);
}));
internalEmailsRouter.get('/sent', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await InternalEmailService.sent(user.id, {
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 20,
        search: req.query.search ? String(req.query.search) : undefined,
    });
    res.json(result);
}));
internalEmailsRouter.get('/unread-count', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const count = await InternalEmailService.unreadCount(user.id);
    res.json({ unread: count });
}));
internalEmailsRouter.get('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const email = await InternalEmailService.get(id, user.id);
    res.json(email);
}));
internalEmailsRouter.post('/send', rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'mail-send' }), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        recipientIds: z.array(z.number().int().positive()).optional(),
        toEmails: z.array(z.string().email().max(190)).optional(),
        ccEmails: z.array(z.string().email().max(190)).optional(),
        bccEmails: z.array(z.string().email().max(190)).optional(),
        subject: z.string().min(1).max(255),
        body: z.string().min(1).max(50000),
        html: z.string().max(100000).optional(),
        attachments: z
            .array(z.object({
            fileId: z.number().int().positive(),
            name: z.string(),
            size: z.number().int().nonnegative(),
            mimeType: z.string(),
        }))
            .max(10)
            .optional(),
        idempotencyKey: z.string().max(120).optional(),
    }), req.body);
    const result = await InternalEmailService.send(user, body);
    res.status(201).json(result);
}));
internalEmailsRouter.patch('/:id/star', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const result = await InternalEmailService.toggleStar(id, user.id);
    res.json(result);
}));
internalEmailsRouter.delete('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const result = await InternalEmailService.delete(id, user.id);
    res.json(result);
}));
//# sourceMappingURL=internalEmails.js.map