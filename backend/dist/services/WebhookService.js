import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { execute, query, queryOne } from '../db/index.js';
import { configStore } from '../lib/configStore.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
/**
 * Outbound webhooks.
 *
 * Delivery contract (documented in docs/WEBHOOKS.md):
 *   POST <url>
 *   Content-Type: application/json
 *   X-Webhook-Id:        <event id, stable across retries — use it for idempotency>
 *   X-Webhook-Event:     <event type>
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *   body: { id, type, createdAt, data }
 *
 * Any 2xx response counts as delivered. Anything else (or a timeout) is retried
 * with exponential backoff; after the last attempt the delivery is marked failed.
 */
export const WEBHOOK_EVENTS = [
    { type: 'employee.login', label: 'Employee login' },
    { type: 'employee.logout', label: 'Employee logout' },
    { type: 'activity.updated', label: 'Activity update' },
    { type: 'employee.status_changed', label: 'Status change' },
    { type: 'task.created', label: 'Task created' },
    { type: 'task.assigned', label: 'Task assigned' },
    { type: 'task.completed', label: 'Task completed' },
    { type: 'ticket.created', label: 'Ticket created' },
    { type: 'ticket.escalated', label: 'Ticket escalated' },
    { type: 'ticket.resolved', label: 'Ticket resolved' },
    { type: 'meeting.started', label: 'Meeting started' },
    { type: 'meeting.ended', label: 'Meeting ended' },
    { type: 'file.uploaded', label: 'File uploaded' },
    { type: 'file.downloaded', label: 'File downloaded' },
];
const EVENT_TYPES = new Set(WEBHOOK_EVENTS.map((e) => e.type));
/** Minutes to wait before attempt n+1 (index = attempts already made - 1). */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const REQUEST_TIMEOUT_MS = 10_000;
function parseJson(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}
export function signPayload(secret, timestamp, rawBody) {
    return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}
/** Reference verifier for receivers (also used by tests). Rejects stale timestamps to stop replays. */
export function verifySignature(secret, timestamp, rawBody, signature, toleranceSeconds = 300) {
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds)
        return false;
    const expected = Buffer.from(signPayload(secret, timestamp, rawBody));
    const given = Buffer.from(signature);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return (a === 10 || a === 127 || a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127));
    }
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:'))
        return isPrivateAddress(lower.slice(7));
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}
/**
 * Rejects URLs that could be used to reach the server's own network (SSRF).
 * In production only https is allowed and private/loopback targets are refused
 * unless WEBHOOK_ALLOW_PRIVATE_TARGETS=true (for intranet receivers).
 */
export async function assertSafeTarget(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw ApiError.badRequest('Enter a valid webhook URL, for example https://example.com/hooks/workforce');
    }
    const allowPrivate = !config.isProd || process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowPrivate)) {
        throw ApiError.badRequest('Webhook URLs must use https://');
    }
    if (url.username || url.password)
        throw ApiError.badRequest('Do not put credentials in the webhook URL; use the signing secret instead');
    if (!allowPrivate) {
        let addresses;
        try {
            addresses = (await dns.lookup(url.hostname, { all: true })).map((r) => r.address);
        }
        catch {
            throw ApiError.badRequest(`The host ${url.hostname} could not be resolved`);
        }
        if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
            throw ApiError.badRequest('Webhook URLs may not point to private, loopback or link-local addresses');
        }
    }
    return url;
}
function present(row) {
    return {
        id: Number(row.id),
        name: row.name,
        url: row.url,
        events: parseJson(row.events),
        secretHint: row.secret_hint,
        isActive: Boolean(row.is_active),
        consecutiveFailures: Number(row.consecutive_failures),
        lastDeliveryAt: toIso(row.last_delivery_at),
        lastStatus: row.last_status,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
}
function presentDelivery(row) {
    return {
        id: Number(row.id),
        webhookId: Number(row.webhook_id),
        eventId: row.event_id,
        eventType: row.event_type,
        payload: parseJson(row.payload),
        status: row.status,
        attempts: Number(row.attempts),
        maxAttempts: MAX_ATTEMPTS,
        nextAttemptAt: row.status === 'pending' || row.status === 'retrying' ? toIso(row.next_attempt_at) : null,
        responseStatus: row.response_status,
        responseBody: row.response_body,
        error: row.error,
        durationMs: row.duration_ms,
        isTest: Boolean(row.is_test),
        createdAt: toIso(row.created_at),
        deliveredAt: toIso(row.delivered_at),
    };
}
function normaliseEvents(events) {
    const unique = [...new Set(events)];
    const invalid = unique.filter((e) => e !== '*' && !EVENT_TYPES.has(e));
    if (invalid.length)
        throw ApiError.badRequest(`Unknown webhook event(s): ${invalid.join(', ')}`);
    if (unique.length === 0)
        throw ApiError.badRequest('Select at least one event');
    return unique.includes('*') ? ['*'] : unique;
}
function newSecret() {
    return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}
let processing = null;
export class WebhookService {
    static events() {
        return WEBHOOK_EVENTS.map((e) => ({ ...e }));
    }
    static async list() {
        const rows = await query('SELECT * FROM webhooks ORDER BY created_at DESC');
        return rows.map(present);
    }
    static async load(id) {
        const row = await queryOne('SELECT * FROM webhooks WHERE id = ?', [id]);
        if (!row)
            throw ApiError.notFound('Webhook not found');
        return row;
    }
    static async get(id) {
        return present(await WebhookService.load(id));
    }
    /** Returns the plain secret exactly once so the administrator can configure the receiver. */
    static async create(input, actorId) {
        const url = await assertSafeTarget(input.url);
        const events = normaliseEvents(input.events);
        const secret = input.secret?.trim() || newSecret();
        if (secret.length < 16)
            throw ApiError.badRequest('The signing secret must be at least 16 characters');
        const result = await execute(`INSERT INTO webhooks (name, url, events, secret_enc, secret_hint, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [input.name.trim(), url.toString(), JSON.stringify(events), configStore.encryptField(secret), secret.slice(-4), input.isActive === false ? 0 : 1, actorId]);
        return { webhook: await WebhookService.get(result.insertId), secret };
    }
    static async update(id, input) {
        const current = await WebhookService.load(id);
        const url = input.url !== undefined ? (await assertSafeTarget(input.url)).toString() : current.url;
        const events = input.events !== undefined ? normaliseEvents(input.events) : parseJson(current.events);
        await execute(
        // MySQL applies SET left to right: reset the failure counter (on re-enable)
        // before is_active takes its new value.
        `UPDATE webhooks SET consecutive_failures = IF(? = 1 AND is_active = 0, 0, consecutive_failures),
         name = ?, url = ?, events = ?, is_active = ?
       WHERE id = ?`, [
            input.isActive ? 1 : 0,
            input.name?.trim() ?? current.name,
            url,
            JSON.stringify(events),
            input.isActive === undefined ? current.is_active : input.isActive ? 1 : 0,
            id,
        ]);
        return WebhookService.get(id);
    }
    static async rotateSecret(id, secret) {
        await WebhookService.load(id);
        const next = secret?.trim() || newSecret();
        if (next.length < 16)
            throw ApiError.badRequest('The signing secret must be at least 16 characters');
        await execute('UPDATE webhooks SET secret_enc = ?, secret_hint = ? WHERE id = ?', [configStore.encryptField(next), next.slice(-4), id]);
        return { webhook: await WebhookService.get(id), secret: next };
    }
    static async remove(id) {
        const result = await execute('DELETE FROM webhooks WHERE id = ?', [id]);
        if (result.affectedRows === 0)
            throw ApiError.notFound('Webhook not found');
    }
    static async deliveries(filters) {
        const where = [];
        const params = [];
        if (filters.webhookId) {
            where.push('webhook_id = ?');
            params.push(filters.webhookId);
        }
        if (filters.status) {
            where.push('status = ?');
            params.push(filters.status);
        }
        if (filters.eventType) {
            where.push('event_type = ?');
            params.push(filters.eventType);
        }
        const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
        const rows = await query(`SELECT * FROM webhook_deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`, params);
        return rows.map(presentDelivery);
    }
    /** Re-queues a delivery for an immediate new attempt (keeps the same event id). */
    static async redeliver(deliveryId) {
        const result = await execute(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = NOW(3), locked_until = NULL,
         attempts = LEAST(attempts, ?) WHERE id = ?`, [MAX_ATTEMPTS - 1, deliveryId]);
        if (result.affectedRows === 0)
            throw ApiError.notFound('Delivery not found');
        await WebhookService.processDue(5);
        const row = await queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);
        return row ? presentDelivery(row) : null;
    }
    /** Sends a signed test event right now and reports exactly what the receiver answered. */
    static async test(id) {
        const webhook = await WebhookService.load(id);
        const eventId = crypto.randomUUID();
        const payload = { id: eventId, type: 'webhook.test', createdAt: new Date().toISOString(), data: { message: 'Test delivery from BSC Textiles Workforce', webhookId: Number(webhook.id) } };
        const insert = await execute(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, is_test) VALUES (?, ?, 'webhook.test', ?, 1)`, [webhook.id, eventId, JSON.stringify(payload)]);
        await WebhookService.attempt(Number(insert.insertId), { final: true });
        const row = await queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [insert.insertId]);
        return presentDelivery(row);
    }
    /**
     * Queues an event for every active subscribed webhook. Never throws: webhook
     * problems must not break the business action that produced the event.
     */
    static async emit(type, data) {
        try {
            const hooks = await query('SELECT id, events FROM webhooks WHERE is_active = 1');
            const targets = hooks.filter((h) => {
                const events = parseJson(h.events);
                return events.includes('*') || events.includes(type);
            });
            if (targets.length === 0)
                return;
            const eventId = crypto.randomUUID();
            const payload = JSON.stringify({ id: eventId, type, createdAt: new Date().toISOString(), data });
            for (const hook of targets) {
                await execute(`INSERT IGNORE INTO webhook_deliveries (webhook_id, event_id, event_type, payload) VALUES (?, ?, ?, ?)`, [hook.id, eventId, type, payload]);
            }
            if (!config.isTest)
                void WebhookService.processDue(20).catch((error) => console.error('[webhooks] immediate dispatch failed', error));
        }
        catch (error) {
            console.error(`[webhooks] could not queue ${type}`, error);
        }
    }
    /** Worker: claims due deliveries and attempts each once. Safe to call concurrently. */
    static async processDue(limit = 25) {
        if (processing)
            await processing.catch(() => undefined);
        const run = (async () => {
            const due = await query(`SELECT d.id FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id AND w.is_active = 1
         WHERE d.status IN ('pending','retrying') AND d.next_attempt_at <= NOW(3)
           AND (d.locked_until IS NULL OR d.locked_until < NOW(3))
         ORDER BY d.next_attempt_at, d.id LIMIT ${Math.min(100, Math.max(1, limit))}`);
            const totals = { delivered: 0, retrying: 0, failed: 0 };
            for (const { id } of due) {
                const outcome = await WebhookService.attempt(Number(id));
                if (outcome)
                    totals[outcome] += 1;
            }
            return totals;
        })();
        processing = run;
        try {
            return await run;
        }
        finally {
            if (processing === run)
                processing = null;
        }
    }
    static async attempt(deliveryId, options = {}) {
        // Claim: only one worker may hold a delivery at a time.
        const claim = await execute(`UPDATE webhook_deliveries SET locked_until = DATE_ADD(NOW(3), INTERVAL 60 SECOND)
       WHERE id = ? AND status IN ('pending','retrying') AND (locked_until IS NULL OR locked_until < NOW(3))`, [deliveryId]);
        if (claim.affectedRows === 0)
            return null;
        const delivery = await queryOne(`SELECT d.*, w.url, w.secret_enc FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?`, [deliveryId]);
        if (!delivery)
            return null;
        const rawBody = typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
        const timestamp = Math.floor(Date.now() / 1000);
        const attempts = Number(delivery.attempts) + 1;
        const started = Date.now();
        let responseStatus = null;
        let responseBody = null;
        let error = null;
        try {
            await assertSafeTarget(delivery.url);
            const secret = configStore.decryptField(delivery.secret_enc);
            const response = await fetch(delivery.url, {
                method: 'POST',
                redirect: 'manual',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'BSC-Workforce-Webhooks/1.0',
                    'X-Webhook-Id': delivery.event_id,
                    'X-Webhook-Event': delivery.event_type,
                    'X-Webhook-Timestamp': String(timestamp),
                    'X-Webhook-Signature': signPayload(secret, timestamp, rawBody),
                    'X-Webhook-Attempt': String(attempts),
                },
                body: rawBody,
            });
            responseStatus = response.status;
            responseBody = (await response.text().catch(() => '')).slice(0, 1000) || null;
            if (response.status >= 300 && response.status < 400)
                error = 'Receiver answered with a redirect; redirects are not followed';
            else if (!response.ok)
                error = `Receiver answered HTTP ${response.status}`;
        }
        catch (caught) {
            const err = caught;
            error = err.name === 'TimeoutError' ? `No response within ${REQUEST_TIMEOUT_MS / 1000}s` : (err.cause?.code ? `${err.message} (${err.cause.code})` : err.message);
        }
        const durationMs = Date.now() - started;
        const delivered = !error;
        const exhausted = options.final || attempts >= MAX_ATTEMPTS;
        const status = delivered ? 'delivered' : exhausted ? 'failed' : 'retrying';
        const backoff = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
        await execute(`UPDATE webhook_deliveries SET status = ?, attempts = ?, response_status = ?, response_body = ?, error = ?,
         duration_ms = ?, locked_until = NULL, delivered_at = IF(? = 'delivered', NOW(3), NULL),
         next_attempt_at = IF(? = 'retrying', DATE_ADD(NOW(3), INTERVAL ? MINUTE), next_attempt_at)
       WHERE id = ?`, [status, attempts, responseStatus, responseBody, error?.slice(0, 500) ?? null, durationMs, status, status, backoff, deliveryId]);
        await execute(`UPDATE webhooks SET last_delivery_at = NOW(3), last_status = ?,
         consecutive_failures = IF(? = 'delivered', 0, consecutive_failures + 1) WHERE id = ?`, [status, status, delivery.webhook_id]);
        return status;
    }
    /** Keeps the delivery log bounded. */
    static async purgeOld(days = 30) {
        const result = await execute(`DELETE FROM webhook_deliveries WHERE status IN ('delivered','failed') AND created_at < DATE_SUB(NOW(3), INTERVAL ? DAY)`, [days]);
        return result.affectedRows;
    }
}
//# sourceMappingURL=WebhookService.js.map