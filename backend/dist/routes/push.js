import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { PushService } from '../services/PushService.js';
import { query, execute } from '../db/index.js';
import { config } from '../config.js';
import webpush from 'web-push';
export const pushRouter = Router();
pushRouter.use(authenticate);
// Initialize web-push with VAPID keys
let vapidInitialized = false;
function initVapid() {
    if (vapidInitialized)
        return;
    if (config.vapidPublicKey && config.vapidPrivateKey) {
        const email = config.smtp.from.replace(/.*<([^>]+)>.*/, '$1').trim() || 'admin@bsctextiles.in';
        webpush.setVapidDetails(`mailto:${email}`, config.vapidPublicKey, config.vapidPrivateKey);
        vapidInitialized = true;
    }
}
/**
 * Get VAPID public key for client subscription
 */
pushRouter.get('/vapid-key', asyncHandler(async (_req, res) => {
    initVapid();
    if (!config.vapidPublicKey) {
        res.status(503).json({ error: 'Push notifications not configured', code: 'not_configured' });
        return;
    }
    res.json({ publicKey: config.vapidPublicKey });
}));
/**
 * Subscribe to push notifications
 */
pushRouter.post('/subscribe', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        endpoint: z.string().url(),
        keys: z.object({
            p256dh: z.string(),
            auth: z.string(),
        }),
    }), req.body);
    // Store subscription
    await execute(`INSERT INTO push_subscriptions (employee_id, device_id, endpoint, p256dh, auth, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE
         p256dh = VALUES(p256dh),
         auth = VALUES(auth),
         updated_at = NOW(3)`, [user.id, body.endpoint, body.keys.p256dh, body.keys.auth]);
    res.json({ ok: true });
}));
/**
 * Unsubscribe from push notifications
 */
pushRouter.post('/unsubscribe', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        endpoint: z.string().url(),
    }), req.body);
    await execute('DELETE FROM push_subscriptions WHERE employee_id = ? AND endpoint = ?', [user.id, body.endpoint]);
    res.json({ ok: true });
}));
/**
 * Send push notification to specific employees (internal use)
 */
pushRouter.post('/send', 
// Previously open to every signed-in user, letting anyone push arbitrary text to anyone.
requireAny('notifications.send'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        employeeIds: z.array(z.number().int().positive()).min(1).max(100),
        title: z.string().max(200),
        body: z.string().max(500).optional(),
        icon: z.string().url().optional(),
        badge: z.string().url().optional(),
        image: z.string().url().optional(),
        tag: z.string().max(100).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        actions: z.array(z.object({
            action: z.string(),
            title: z.string(),
        })).max(2).optional(),
        requireInteraction: z.boolean().optional(),
        vibrate: z.array(z.number().int()).optional(),
    }), req.body);
    // Get push subscriptions for target employees
    const subscriptions = await query('SELECT employee_id, endpoint, p256dh, auth FROM push_subscriptions WHERE employee_id IN (?)', [body.employeeIds]);
    if (!vapidInitialized) {
        initVapid();
    }
    if (!vapidInitialized) {
        res.status(503).json({ error: 'Push notifications not configured on server', code: 'not_configured' });
        return;
    }
    const payload = JSON.stringify({
        title: body.title,
        body: body.body,
        icon: body.icon || '/icons/icon-192.png',
        badge: body.badge || '/icons/badge-72.png',
        image: body.image,
        tag: body.tag,
        data: body.data,
        actions: body.actions,
        requireInteraction: body.requireInteraction,
        vibrate: body.vibrate || [200, 100, 200],
    });
    const results = await Promise.allSettled(subscriptions.map(async (sub) => {
        try {
            await webpush.sendNotification({
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
            }, payload);
            return { employeeId: sub.employee_id, success: true };
        }
        catch (error) {
            // Handle expired/invalid subscriptions
            if (error.statusCode === 410 || error.statusCode === 404) {
                await execute('DELETE FROM push_subscriptions WHERE employee_id = ? AND endpoint = ?', [
                    sub.employee_id,
                    sub.endpoint,
                ]);
            }
            return { employeeId: sub.employee_id, success: false, error: error.message };
        }
    }));
    const sent = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - sent;
    res.json({ sent, failed, total: subscriptions.length });
}));
/**
 * Get push subscription status for current user
 */
pushRouter.get('/status', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const subs = await query('SELECT endpoint, created_at FROM push_subscriptions WHERE employee_id = ?', [user.id]);
    res.json({
        subscribed: subs.length > 0,
        subscriptions: subs.map(s => ({
            endpoint: s.endpoint,
            createdAt: s.created_at,
        })),
    });
}));
/**
 * Send test notification to current user
 */
pushRouter.post('/test', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const subs = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE employee_id = ?', [user.id]);
    if (subs.length === 0) {
        res.status(400).json({ error: 'No push subscription found', code: 'not_subscribed' });
        return;
    }
    if (!vapidInitialized) {
        initVapid();
    }
    if (!vapidInitialized) {
        res.status(503).json({ error: 'Push notifications not configured on server', code: 'not_configured' });
        return;
    }
    const payload = JSON.stringify({
        title: 'BSC Workforce Test',
        body: 'Push notifications are working correctly!',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: 'test-notification',
        data: { type: 'test' },
        actions: [{ action: 'open', title: 'Open' }, { action: 'dismiss', title: 'Dismiss' }],
        vibrate: [200, 100, 200],
    });
    const results = await Promise.allSettled(subs.map(async (sub) => {
        try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
            return { success: true };
        }
        catch (error) {
            if (error.statusCode === 410 || error.statusCode === 404) {
                await execute('DELETE FROM push_subscriptions WHERE employee_id = ? AND endpoint = ?', [
                    user.id,
                    sub.endpoint,
                ]);
            }
            return { success: false, error: error.message };
        }
    }));
    const sent = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    res.json({ sent, total: subs.length });
}));
// ---------------------------------------------------------------------------
// Mobile app (Android / iOS) - Firebase Cloud Messaging device tokens
// ---------------------------------------------------------------------------
const deviceSchema = z.object({
    // FCM registration tokens are ~150-200 URL-safe characters.
    token: z.string().min(20).max(512).regex(/^[A-Za-z0-9_:\-.]+$/, 'Invalid device token'),
    platform: z.enum(['android', 'ios']),
    deviceName: z.string().max(120).optional(),
    appVersion: z.string().max(40).optional(),
});
/** Registers (or refreshes) this phone for push. Call after login and whenever FCM rotates the token. */
pushRouter.post('/devices', asyncHandler(async (req, res) => {
    const body = parseBody(deviceSchema, req.body);
    await PushService.registerDevice(currentUser(req), body);
    res.json({ ok: true, pushConfigured: PushService.configured() });
}));
/** Removes this phone's token (permission withdrawn in Settings). Logout removes it automatically. */
pushRouter.delete('/devices', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ token: deviceSchema.shape.token }), req.body);
    const removed = await PushService.unregisterDevice(currentUser(req).id, body.token);
    res.json({ ok: true, removed });
}));
pushRouter.get('/devices', asyncHandler(async (req, res) => {
    res.json({ devices: await PushService.devices(currentUser(req).id), pushConfigured: PushService.configured() });
}));
/** Per-category push toggles for the app's Settings screen. */
pushRouter.get('/preferences', asyncHandler(async (req, res) => {
    res.json(await PushService.preferences(currentUser(req).id));
}));
pushRouter.put('/preferences', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ categories: z.record(z.string().max(40), z.boolean()) }), req.body);
    res.json(await PushService.setPreferences(currentUser(req).id, body.categories));
}));
//# sourceMappingURL=push.js.map