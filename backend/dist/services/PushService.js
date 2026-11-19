import crypto from 'node:crypto';
import webpush from 'web-push';
import { execute, query } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { fcmConfigured, sendFcm } from '../lib/fcm.js';
import { config } from '../config.js';
/**
 * Push notifications to phones and browsers.
 *
 * Two transports, same rules:
 *  - Web Push (VAPID) for the website / installed PWA (Android Chrome, desktop, iOS 16.4+ Home Screen apps).
 *  - Firebase Cloud Messaging for the Capacitor Android / iOS app.
 *
 * A device keeps receiving pushes after its user signs out when the user chose
 * "keep notifications on" at sign-out (`keep_after_logout`). Such devices get a
 * reduced payload (no message text) because a signed-out phone may be shared.
 *
 * Every attempt is written to push_delivery_log (sent / delivered / failed / expired);
 * "delivered" is reported back by the service worker through POST /api/push/ack.
 */
/** Categories shown as toggles in the app's Settings screen. */
export const PUSH_CATEGORIES = [
    { key: 'tasks', label: 'Tasks and projects' },
    { key: 'chat', label: 'Chat messages' },
    { key: 'meetings', label: 'Meetings and calls' },
    { key: 'leave', label: 'Leave and attendance' },
    { key: 'tickets', label: 'Tickets' },
    { key: 'reports', label: 'Reports, KPIs and activity' },
    { key: 'announcements', label: 'Announcements' },
    { key: 'other', label: 'Other updates' },
];
const CATEGORY_KEYS = new Set(PUSH_CATEGORIES.map((c) => c.key));
/** Maps a notification type (notifications.notif_type) to a push category. */
export function categoryOf(type) {
    const t = type.toLowerCase();
    if (t === 'security')
        return 'security';
    if (t.startsWith('task') || t.startsWith('project') || t.startsWith('collection'))
        return 'tasks';
    if (t.startsWith('chat'))
        return 'chat';
    if (t.startsWith('meeting') || t.endsWith('_call') || t.startsWith('call'))
        return 'meetings';
    if (t.startsWith('leave') || t.startsWith('attendance') || t === 'registration')
        return 'leave';
    if (t.startsWith('ticket'))
        return 'tickets';
    if (t.startsWith('daily_report') || t.startsWith('kpi') || t.startsWith('activity') || t === 'pattern')
        return 'reports';
    if (t === 'announcement' || t === 'system' || t === 'app')
        return 'announcements';
    return 'other';
}
/** Only same-app relative paths are allowed as deep links. */
export function safeDeepLink(link) {
    if (!link || !link.startsWith('/') || link.startsWith('//') || link.includes('\\'))
        return '/notifications';
    return link.slice(0, 255);
}
/**
 * HMAC that lets the service worker decline / mark-missed a call without a
 * session cookie (the phone may be signed out or the cookie may not be sent
 * from the worker). Bound to one call and one callee.
 */
export function callActionToken(callId, calleeId) {
    return crypto.createHmac('sha256', config.jwtSecret).update(`call-action:${callId}:${calleeId}`).digest('base64url').slice(0, 43);
}
export function verifyCallActionToken(callId, calleeId, token) {
    const expected = Buffer.from(callActionToken(callId, calleeId));
    const given = Buffer.from(String(token));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
const MAX_FAILURES = 10;
const CONCURRENCY = 10;
async function inBatches(items, size, fn) {
    for (let i = 0; i < items.length; i += size) {
        await Promise.all(items.slice(i, i + size).map(fn));
    }
}
let vapidReady = false;
function ensureVapid() {
    if (vapidReady)
        return true;
    if (!config.vapidPublicKey || !config.vapidPrivateKey)
        return false;
    const email = config.smtp.from.replace(/.*<([^>]+)>.*/, '$1').trim();
    webpush.setVapidDetails(`mailto:${email || 'admin@bsctextiles.in'}`, config.vapidPublicKey, config.vapidPrivateKey);
    vapidReady = true;
    return true;
}
async function unmuted(employeeIds, category) {
    if (employeeIds.length === 0 || category === 'security')
        return employeeIds;
    const muted = await query('SELECT employee_id FROM notification_preferences WHERE category = ? AND push_enabled = 0 AND employee_id IN (?)', [category, employeeIds]);
    const mutedIds = new Set(muted.map((m) => Number(m.employee_id)));
    return employeeIds.filter((id) => !mutedIds.has(id));
}
/**
 * Devices that may receive pushes: the employee is active and the device either
 * belongs to a live session, or its user chose to keep notifications after sign-out.
 * Legacy web subscriptions without a session are treated as signed in.
 */
async function webTargets(employeeIds) {
    if (employeeIds.length === 0)
        return [];
    return query(`SELECT ps.id, ps.employee_id, ps.endpoint, ps.p256dh, ps.auth,
            (ps.session_id IS NULL OR s.id IS NOT NULL) AS signed_in
     FROM push_subscriptions ps
     JOIN employees e ON e.id = ps.employee_id AND e.status = 'active'
     LEFT JOIN employee_sessions s ON s.id = ps.session_id AND s.revoked_at IS NULL AND s.expires_at > NOW(3)
     WHERE ps.employee_id IN (?)
       AND (ps.session_id IS NULL OR s.id IS NOT NULL OR ps.keep_after_logout = 1)`, [employeeIds]);
}
async function fcmTargets(employeeIds) {
    if (employeeIds.length === 0 || !fcmConfigured())
        return [];
    return query(`SELECT t.id, t.employee_id, t.token, (s.id IS NOT NULL) AS signed_in
     FROM push_device_tokens t
     JOIN employees e ON e.id = t.employee_id AND e.status = 'active'
     LEFT JOIN employee_sessions s ON s.id = t.session_id AND s.revoked_at IS NULL AND s.expires_at > NOW(3)
     WHERE t.employee_id IN (?) AND (s.id IS NOT NULL OR t.keep_after_logout = 1)`, [employeeIds]);
}
async function logAttempt(row) {
    await execute(`INSERT INTO push_delivery_log (employee_id, channel, target_id, kind, ref, status, http_status, error, ack_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.employeeId, row.channel, row.targetId, row.kind.slice(0, 32), row.ref.slice(0, 80), row.status,
        row.httpStatus ?? null, row.error?.slice(0, 255) ?? null, row.ackToken ?? null]).catch((error) => console.error('[push] could not write delivery log', error.message));
}
async function sendWeb(targets, kind, ref, build, options) {
    const stats = { sent: 0, failed: 0, removed: 0 };
    if (targets.length === 0 || !ensureVapid())
        return stats;
    await inBatches(targets, CONCURRENCY, async (sub) => {
        const ackToken = crypto.randomBytes(16).toString('hex');
        const message = { ...build(sub), ack: ackToken };
        try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(message), { TTL: options.ttl, urgency: options.urgency, ...(options.topic ? { topic: options.topic } : {}) });
            stats.sent += 1;
            await logAttempt({ employeeId: sub.employee_id, channel: 'webpush', targetId: sub.id, kind, ref, status: 'sent', httpStatus: 201, ackToken });
            await execute('UPDATE push_subscriptions SET failure_count = 0, last_error = NULL, last_sent_at = NOW(3) WHERE id = ?', [sub.id]);
        }
        catch (error) {
            const statusCode = Number(error.statusCode) || null;
            const text = String(error.body || error.message || 'error').slice(0, 200);
            // 404/410: subscription gone (app uninstalled, permission revoked, browser rotated it).
            // 403 with a VAPID mismatch: subscribed under an older key; the client re-subscribes on next open.
            const expired = statusCode === 404 || statusCode === 410 || (statusCode === 403 && /vapid|credential|key/i.test(text));
            if (expired) {
                stats.removed += 1;
                await execute('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
            }
            else {
                stats.failed += 1;
                await execute('UPDATE push_subscriptions SET failure_count = failure_count + 1, last_error = ? WHERE id = ?', [text.slice(0, 160), sub.id]);
                await execute('DELETE FROM push_subscriptions WHERE id = ? AND failure_count >= ?', [sub.id, MAX_FAILURES]);
            }
            await logAttempt({ employeeId: sub.employee_id, channel: 'webpush', targetId: sub.id, kind, ref, status: expired ? 'expired' : 'failed', httpStatus: statusCode, error: text });
        }
    });
    return stats;
}
async function sendFcmAll(targets, kind, ref, build) {
    const stats = { sent: 0, failed: 0, removed: 0 };
    await inBatches(targets, CONCURRENCY, async (t) => {
        const outcome = await sendFcm(t.token, build(t));
        if (outcome.status === 'sent') {
            stats.sent += 1;
            await execute('UPDATE push_device_tokens SET failure_count = 0, last_error = NULL, last_sent_at = NOW(3) WHERE id = ?', [t.id]);
            await logAttempt({ employeeId: t.employee_id, channel: 'fcm', targetId: t.id, kind, ref, status: 'sent', httpStatus: 200 });
            return;
        }
        if (outcome.status === 'invalid_token') {
            stats.removed += 1;
            await execute('DELETE FROM push_device_tokens WHERE id = ?', [t.id]);
        }
        else {
            stats.failed += 1;
            await execute('UPDATE push_device_tokens SET failure_count = failure_count + 1, last_error = ? WHERE id = ?', [outcome.error.slice(0, 160), t.id]);
            if (outcome.status === 'failed') {
                await execute('DELETE FROM push_device_tokens WHERE id = ? AND failure_count >= ?', [t.id, MAX_FAILURES]);
            }
        }
        await logAttempt({
            employeeId: t.employee_id, channel: 'fcm', targetId: t.id, kind, ref,
            status: outcome.status === 'invalid_token' ? 'expired' : 'failed', error: outcome.error,
        });
    });
    return stats;
}
async function unreadBadges(employeeIds) {
    if (employeeIds.length === 0)
        return new Map();
    const unread = await query(`SELECT employee_id, COUNT(*) AS total FROM notification_recipients
     WHERE read_at IS NULL AND employee_id IN (?) GROUP BY employee_id`, [employeeIds]);
    return new Map(unread.map((u) => [Number(u.employee_id), Number(u.total)]));
}
export class PushService {
    static configured() {
        return fcmConfigured();
    }
    /**
     * Registers (or moves) a phone's FCM token for the signed-in user and the
     * current session. A token is unique: if another employee signed in on the
     * same phone earlier, the token now belongs to the new user only.
     */
    static async registerDevice(user, input) {
        await execute(`INSERT INTO push_device_tokens (employee_id, session_id, token, platform, device_name, app_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         employee_id = VALUES(employee_id), session_id = VALUES(session_id), platform = VALUES(platform),
         device_name = VALUES(device_name), app_version = VALUES(app_version),
         keep_after_logout = 0, signed_out_at = NULL,
         failure_count = 0, last_error = NULL, updated_at = NOW(3)`, [
            user.id,
            user.sessionId || null,
            input.token,
            input.platform,
            input.deviceName?.slice(0, 120) ?? null,
            input.appVersion?.slice(0, 40) ?? null,
        ]);
    }
    /**
     * Registers a browser / PWA Web Push subscription. One row per endpoint; the
     * endpoint moves to whoever signs in on that browser. `clientDeviceId` is a
     * stable random id kept in the browser so a user can see and remove devices.
     */
    static async registerWebSubscription(user, input) {
        // A browser that re-subscribed (new endpoint) must not leave its old endpoint behind.
        if (input.clientDeviceId) {
            await execute('DELETE FROM push_subscriptions WHERE client_device_id = ? AND endpoint <> ?', [input.clientDeviceId, input.endpoint]);
        }
        await execute(`INSERT INTO push_subscriptions
         (employee_id, device_id, client_device_id, session_id, endpoint, p256dh, auth, platform, user_agent, keep_after_logout)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         employee_id = VALUES(employee_id), client_device_id = VALUES(client_device_id), session_id = VALUES(session_id),
         p256dh = VALUES(p256dh), auth = VALUES(auth), platform = VALUES(platform), user_agent = VALUES(user_agent),
         keep_after_logout = 1, signed_out_at = NULL, failure_count = 0, last_error = NULL, updated_at = NOW(3)`, [
            user.id,
            input.clientDeviceId?.slice(0, 64) ?? null,
            user.sessionId || null,
            input.endpoint,
            input.p256dh,
            input.auth,
            input.platform?.slice(0, 24) ?? null,
            input.userAgent?.slice(0, 255) ?? null,
        ]);
    }
    /** Removes a token (logout, permission withdrawn). Only the owner can remove it. */
    static async unregisterDevice(employeeId, token) {
        const result = await execute('DELETE FROM push_device_tokens WHERE employee_id = ? AND token = ?', [employeeId, token]);
        return result.affectedRows;
    }
    /**
     * Sign-out of a login session. With keep=true (the default the user sees at
     * sign-out) the session's devices stay registered and keep ringing for calls
     * and messages; with keep=false they are removed.
     */
    static async signOutSession(sessionId, keep) {
        if (!sessionId)
            return;
        if (keep) {
            await execute('UPDATE push_device_tokens SET keep_after_logout = 1, signed_out_at = NOW(3) WHERE session_id = ?', [sessionId]);
            await execute('UPDATE push_subscriptions SET keep_after_logout = 1, signed_out_at = NOW(3) WHERE session_id = ?', [sessionId]);
        }
        else {
            await execute('DELETE FROM push_device_tokens WHERE session_id = ?', [sessionId]);
            await execute('DELETE FROM push_subscriptions WHERE session_id = ?', [sessionId]);
        }
    }
    /** Website sign-out: the browser names its own endpoint, which may predate the session link. */
    static async signOutWebEndpoint(employeeId, endpoint, keep) {
        if (keep) {
            await execute('UPDATE push_subscriptions SET keep_after_logout = 1, signed_out_at = NOW(3) WHERE employee_id = ? AND endpoint = ?', [employeeId, endpoint]);
        }
        else {
            await execute('DELETE FROM push_subscriptions WHERE employee_id = ? AND endpoint = ?', [employeeId, endpoint]);
        }
    }
    /** Kept for callers of the previous API: removes every token of a session. */
    static async unregisterSession(sessionId) {
        await PushService.signOutSession(sessionId, false);
    }
    static async devices(employeeId) {
        const rows = await query('SELECT id, platform, device_name, app_version, created_at, last_sent_at FROM push_device_tokens WHERE employee_id = ? ORDER BY updated_at DESC', [employeeId]);
        return rows.map((r) => ({
            id: Number(r.id),
            platform: r.platform,
            deviceName: r.device_name,
            appVersion: r.app_version,
            registeredAt: r.created_at,
            lastPushAt: r.last_sent_at,
        }));
    }
    static async preferences(employeeId) {
        const rows = await query('SELECT category, push_enabled FROM notification_preferences WHERE employee_id = ?', [employeeId]);
        const off = new Set(rows.filter((r) => !r.push_enabled).map((r) => r.category));
        return {
            categories: PUSH_CATEGORIES.map((c) => ({ key: c.key, label: c.label, push: !off.has(c.key) })),
            note: 'Security alerts are always sent.',
        };
    }
    static async setPreferences(employeeId, changes) {
        const entries = Object.entries(changes);
        for (const [key] of entries) {
            if (!CATEGORY_KEYS.has(key))
                throw ApiError.badRequest(`Unknown notification category: ${key}`);
        }
        for (const [key, enabled] of entries) {
            await execute(`INSERT INTO notification_preferences (employee_id, category, push_enabled) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE push_enabled = VALUES(push_enabled)`, [employeeId, key, enabled ? 1 : 0]);
        }
        return PushService.preferences(employeeId);
    }
    /** The service worker confirms it displayed a push. Unauthenticated: the random token is the credential. */
    static async acknowledge(ackToken) {
        if (!/^[a-f0-9]{32}$/.test(ackToken))
            return false;
        const result = await execute("UPDATE push_delivery_log SET status = 'delivered', delivered_at = NOW(3) WHERE ack_token = ? AND status = 'sent'", [ackToken]);
        return result.affectedRows > 0;
    }
    /** Recent delivery attempts for one employee (debugging screen / support). */
    static async deliveryLog(employeeId, limit = 50) {
        const rows = await query(`SELECT id, channel, target_id, kind, ref, status, http_status, error, created_at, delivered_at
       FROM push_delivery_log WHERE employee_id = ? ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, Math.floor(limit)))}`, [employeeId]);
        return rows.map((r) => ({
            id: Number(r.id), channel: r.channel, targetId: Number(r.target_id), kind: r.kind, ref: r.ref,
            status: r.status, httpStatus: r.http_status, error: r.error, createdAt: r.created_at, deliveredAt: r.delivered_at,
        }));
    }
    /** Keeps the delivery log bounded. */
    static async pruneLog(days = 30) {
        const result = await execute('DELETE FROM push_delivery_log WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? DAY)', [days]);
        return result.affectedRows;
    }
    /**
     * Pushes one notification to the recipients' phones and browsers. Never throws: the
     * notification is already stored and visible in the app, push is best effort.
     */
    static async deliver(employeeIds, payload) {
        const total = { sent: 0, failed: 0, removed: 0 };
        try {
            const category = categoryOf(payload.type);
            const recipients = await unmuted([...new Set(employeeIds)], category);
            if (recipients.length === 0)
                return total;
            const isChat = category === 'chat';
            const urgent = payload.priority === 'high' || payload.priority === 'critical';
            const link = safeDeepLink(payload.link);
            const tag = isChat && payload.conversationId ? `chat-${payload.conversationId}` : `notif-${payload.notificationId}`;
            const ref = isChat && payload.conversationId ? `chat:${payload.conversationId}` : `notif:${payload.notificationId}`;
            const privateTitle = isChat ? (payload.senderName ?? 'New message') : payload.title;
            const privateBody = isChat ? 'New message · sign in to read it' : 'Sign in to view this update';
            const [web, fcm, badges] = await Promise.all([
                webTargets(recipients),
                fcmTargets(recipients),
                unreadBadges(recipients),
            ]);
            const webStats = await sendWeb(web, isChat ? 'chat' : 'notification', ref, (t) => ({
                v: 2,
                kind: isChat ? 'chat' : 'notification',
                title: t.signed_in ? payload.title : privateTitle,
                body: t.signed_in ? (payload.body ?? '') : privateBody,
                tag,
                link,
                icon: '/icons/icon-192.png',
                urgent: urgent || isChat,
                data: {
                    notificationId: payload.notificationId,
                    type: payload.type,
                    category,
                    conversationId: payload.conversationId ?? null,
                    badge: badges.get(Number(t.employee_id)) ?? null,
                },
            }), 
            // Chat is time-sensitive (urgency high wakes Android from Doze); stale chat pushes expire after a day.
            { ttl: 86400, urgency: urgent || isChat ? 'high' : 'normal' });
            const channel = isChat ? 'chat' : urgent || category === 'security' ? 'urgent' : 'general';
            const fcmStats = await sendFcmAll(fcm, isChat ? 'chat' : 'notification', ref, (t) => ({
                title: t.signed_in ? payload.title : privateTitle,
                body: t.signed_in ? payload.body : privateBody,
                channel,
                priority: urgent || channel !== 'general' ? 'high' : 'normal',
                tag: isChat ? tag : undefined,
                badge: badges.get(Number(t.employee_id)) ?? undefined,
                data: { notificationId: String(payload.notificationId), type: payload.type, category, link },
            }));
            for (const s of [webStats, fcmStats]) {
                total.sent += s.sent;
                total.failed += s.failed;
                total.removed += s.removed;
            }
            if (total.failed > 0 || total.removed > 0) {
                console.warn(`[push] ${ref}: ${total.sent} sent, ${total.failed} failed, ${total.removed} expired subscriptions removed`);
            }
        }
        catch (error) {
            console.error('[push] delivery error', error.message);
        }
        return total;
    }
    /**
     * Call pushes go to EVERY device of the callee, whether or not the callee has a
     * socket open: a socket can be alive in a frozen background tab that will never
     * play a ringtone. The service worker shows the ring, and closes / replaces it
     * on cancel or missed (same tag).
     */
    static async sendCall(calleeId, kind, info) {
        const total = { sent: 0, failed: 0, removed: 0 };
        try {
            const recipients = await unmuted([calleeId], 'meetings');
            if (recipients.length === 0)
                return total;
            const [web, fcm] = await Promise.all([webTargets(recipients), kind === 'call_cancel' ? Promise.resolve([]) : fcmTargets(recipients)]);
            const tag = `call-${info.callId}`;
            const label = info.type === 'video' ? 'video' : 'voice';
            const title = kind === 'call_ring' ? `${info.callerName}` : kind === 'call_missed' ? `Missed ${label} call` : 'Call ended';
            const body = kind === 'call_ring'
                ? `Incoming ${label} call · tap to answer`
                : kind === 'call_missed' ? `Missed call from ${info.callerName}` : '';
            const ringTtl = info.expiresAt ? Math.max(5, Math.ceil((info.expiresAt - Date.now()) / 1000)) : 45;
            const link = kind === 'call_ring' ? `/calls?incoming=${encodeURIComponent(info.callId)}` : '/calls';
            const webStats = await sendWeb(web, kind, `call:${info.callId}`, () => ({
                v: 2,
                kind,
                title,
                body,
                tag,
                link,
                icon: info.callerPhoto && info.callerPhoto.startsWith('/') ? info.callerPhoto : '/icons/icon-192.png',
                urgent: kind !== 'call_cancel',
                data: { type: kind, callId: info.callId },
                call: {
                    callId: info.callId,
                    type: info.type,
                    callerId: info.callerId,
                    callerName: info.callerName,
                    expiresAt: info.expiresAt ?? null,
                    attempt: info.attempt ?? 1,
                    actionToken: callActionToken(info.callId, calleeId),
                },
            }), 
            // A ring that is not delivered before the call times out must never show up later.
            kind === 'call_ring'
                ? { ttl: ringTtl, urgency: 'high', topic: info.callId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) }
                : { ttl: kind === 'call_missed' ? 86400 : 60, urgency: 'high', topic: info.callId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) });
            const fcmStats = await sendFcmAll(fcm, kind, `call:${info.callId}`, () => ({
                title: kind === 'call_ring' ? `Incoming ${label} call` : title,
                body: kind === 'call_ring' ? `${info.callerName} is calling you` : body,
                channel: 'calls',
                priority: 'high',
                tag,
                ttlSeconds: kind === 'call_ring' ? ringTtl : 86400,
                data: { type: kind === 'call_ring' ? 'incoming_call' : 'missed_call', callId: info.callId, callType: info.type, link },
            }));
            for (const s of [webStats, fcmStats]) {
                total.sent += s.sent;
                total.failed += s.failed;
                total.removed += s.removed;
            }
            if (kind === 'call_ring' && (info.attempt ?? 1) === 1 && total.sent === 0) {
                console.warn(`[push] call ${info.callId}: callee ${calleeId} has no push-capable device (subscribe the phone in the app)`);
            }
        }
        catch (error) {
            console.error('[push] call push error', error.message);
        }
        return total;
    }
}
//# sourceMappingURL=PushService.js.map