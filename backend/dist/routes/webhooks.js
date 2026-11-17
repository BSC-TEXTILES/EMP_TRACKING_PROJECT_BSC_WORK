import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { WebhookService } from '../services/WebhookService.js';
export const webhooksRouter = Router();
webhooksRouter.use(authenticate, requireAny('settings.manage'));
const eventsSchema = z.array(z.string().min(1).max(64)).min(1).max(40);
const createSchema = z.object({
    name: z.string().trim().min(2).max(120),
    url: z.string().trim().min(8).max(500),
    events: eventsSchema,
    secret: z.string().min(16).max(200).optional(),
    isActive: z.boolean().optional(),
});
const updateSchema = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    url: z.string().trim().min(8).max(500).optional(),
    events: eventsSchema.optional(),
    isActive: z.boolean().optional(),
});
function audit(req, action, entityId, after) {
    return recordAudit({
        actorId: currentUser(req).id,
        action,
        entityType: 'webhook',
        entityId,
        after,
        ip: clientIp(req),
        userAgent: req.get('user-agent'),
    });
}
webhooksRouter.get('/events', (_req, res) => {
    res.json({ items: WebhookService.events() });
});
webhooksRouter.get('/', asyncHandler(async (_req, res) => {
    res.json({ items: await WebhookService.list() });
}));
webhooksRouter.post('/', asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const result = await WebhookService.create(body, currentUser(req).id);
    await audit(req, 'webhook.create', result.webhook.id, { name: result.webhook.name, url: result.webhook.url, events: result.webhook.events });
    res.status(201).json(result);
}));
webhooksRouter.get('/deliveries', asyncHandler(async (req, res) => {
    res.json({
        items: await WebhookService.deliveries({
            webhookId: req.query.webhookId ? intParam(String(req.query.webhookId), 'webhookId') : undefined,
            status: typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined,
            eventType: typeof req.query.eventType === 'string' && req.query.eventType ? req.query.eventType : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        }),
    });
}));
webhooksRouter.post('/deliveries/:id/redeliver', rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'webhook-redeliver' }), asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const delivery = await WebhookService.redeliver(id);
    res.json({ delivery });
}));
webhooksRouter.get('/:id', asyncHandler(async (req, res) => {
    res.json({ webhook: await WebhookService.get(intParam(req.params.id)) });
}));
webhooksRouter.patch('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(updateSchema, req.body);
    const webhook = await WebhookService.update(id, body);
    await audit(req, 'webhook.update', id, body);
    res.json({ webhook });
}));
webhooksRouter.post('/:id/rotate-secret', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ secret: z.string().min(16).max(200).optional() }), req.body);
    const result = await WebhookService.rotateSecret(id, body.secret);
    await audit(req, 'webhook.rotate_secret', id);
    res.json(result);
}));
webhooksRouter.post('/:id/test', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'webhook-test' }), asyncHandler(async (req, res) => {
    res.json({ delivery: await WebhookService.test(intParam(req.params.id)) });
}));
webhooksRouter.delete('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    await WebhookService.remove(id);
    await audit(req, 'webhook.delete', id);
    res.json({ ok: true });
}));
//# sourceMappingURL=webhooks.js.map