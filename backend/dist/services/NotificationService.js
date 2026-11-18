import { execute, query, queryOne } from '../db/index.js';
import { toIso } from '../lib/dates.js';
import { emitToEmployees } from '../realtime/io.js';
import { EmailService } from './EmailService.js';
import { PushService } from './PushService.js';
export class NotificationService {
    /**
     * Persists one notification and fan-outs per-recipient rows, then pushes it to
     * every online recipient. Duplicate dedupe keys are ignored safely.
     */
    static async notify(input) {
        const recipients = [...new Set(input.employeeIds.filter((id) => Number.isFinite(id) && id > 0))];
        if (recipients.length === 0)
            return null;
        const result = await execute(`INSERT INTO notifications (notif_type, title, body, link, priority, actor_id, announcement_id, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`, [
            input.type,
            input.title.slice(0, 200),
            input.body?.slice(0, 500) ?? null,
            input.link?.slice(0, 255) ?? null,
            input.priority ?? 'normal',
            input.actorId ?? null,
            input.announcementId ?? null,
            input.dedupeKey?.slice(0, 160) ?? null,
        ]);
        let notificationId = result.insertId;
        if (!notificationId) {
            const existing = input.dedupeKey
                ? await queryOne('SELECT id FROM notifications WHERE dedupe_key = ?', [input.dedupeKey])
                : null;
            notificationId = existing?.id ?? 0;
        }
        if (!notificationId)
            return null;
        const chunkSize = 400;
        for (let i = 0; i < recipients.length; i += chunkSize) {
            const chunk = recipients.slice(i, i + chunkSize);
            const values = chunk.map(() => '(?, ?)').join(',');
            const params = [];
            for (const id of chunk)
                params.push(notificationId, id);
            await execute(`INSERT IGNORE INTO notification_recipients (notification_id, employee_id) VALUES ${values}`, params);
        }
        const payload = {
            id: notificationId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
            priority: input.priority ?? 'normal',
            createdAt: new Date().toISOString(),
            read: false,
        };
        emitToEmployees(recipients, 'notification:new', payload);
        // Phone push (Android / iOS app). Best effort, never blocks or fails the caller.
        void PushService.deliver(recipients, {
            notificationId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
            priority: input.priority ?? 'normal',
        });
        // Email is queued after the notification is durable. A mail failure never
        // affects the business transaction that produced this notification.
        void EmailService.notifyRecipients(recipients, {
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
            notificationId,
        });
        return notificationId;
    }
    static async unreadCount(employeeId) {
        const row = await queryOne('SELECT COUNT(*) AS total FROM notification_recipients WHERE employee_id = ? AND read_at IS NULL', [employeeId]);
        return Number(row?.total ?? 0);
    }
    static async list(employeeId, options = {}) {
        const limit = Math.min(100, Math.max(1, options.limit ?? 30));
        const offset = Math.max(0, options.offset ?? 0);
        const conditions = ['nr.employee_id = ?'];
        const params = [employeeId];
        if (options.unreadOnly) {
            conditions.push('nr.read_at IS NULL');
        }
        if (options.category && options.category !== 'all') {
            const cat = options.category.toLowerCase();
            if (cat === 'tasks') {
                conditions.push("(n.notif_type LIKE 'task%' OR n.notif_type LIKE 'project%' OR n.notif_type LIKE 'collection%')");
            }
            else if (cat === 'reports') {
                conditions.push("(n.notif_type LIKE 'daily_report%' OR n.notif_type LIKE 'kpi%' OR n.notif_type LIKE 'activity%')");
            }
            else if (cat === 'attendance' || cat === 'leave') {
                conditions.push("(n.notif_type LIKE 'attendance%' OR n.notif_type LIKE 'leave%')");
            }
            else if (cat === 'calls' || cat === 'meetings') {
                conditions.push("(n.notif_type LIKE '%call%' OR n.notif_type LIKE 'meeting%')");
            }
            else if (cat === 'chat') {
                conditions.push("n.notif_type LIKE 'chat%'");
            }
            else if (cat === 'tickets') {
                conditions.push("n.notif_type LIKE 'ticket%'");
            }
            else if (cat === 'announcements') {
                conditions.push("(n.notif_type = 'announcement' OR n.notif_type = 'system')");
            }
        }
        if (options.location && options.location !== 'all') {
            conditions.push('(l.code = ? OR l.name LIKE ?)');
            params.push(options.location, `%${options.location}%`);
        }
        const where = conditions.join(' AND ');
        const rows = await query(`SELECT n.id, n.notif_type, n.title, n.body, n.link, n.priority, n.created_at, nr.read_at,
              act.full_name AS sender_name, l.name AS location_name, l.code AS location_code
       FROM notification_recipients nr
       JOIN notifications n ON n.id = nr.notification_id
       LEFT JOIN employees act ON act.id = n.actor_id
       LEFT JOIN locations l ON l.id = act.location_id
       WHERE ${where}
       ORDER BY n.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`, params);
        return rows.map((r) => ({
            id: Number(r.id),
            type: r.notif_type,
            title: r.title,
            body: r.body,
            link: r.link,
            priority: r.priority,
            senderName: r.sender_name ?? 'System',
            locationName: r.location_name ?? null,
            locationCode: r.location_code ?? null,
            createdAt: toIso(r.created_at),
            read: Boolean(r.read_at),
        }));
    }
    static async markRead(employeeId, notificationId) {
        await execute('UPDATE notification_recipients SET read_at = NOW(3) WHERE employee_id = ? AND notification_id = ? AND read_at IS NULL', [employeeId, notificationId]);
    }
    static async markAllRead(employeeId) {
        await execute('UPDATE notification_recipients SET read_at = NOW(3) WHERE employee_id = ? AND read_at IS NULL', [employeeId]);
    }
    static async delete(employeeId, notificationId) {
        await execute('DELETE FROM notification_recipients WHERE employee_id = ? AND notification_id = ?', [employeeId, notificationId]);
    }
}
//# sourceMappingURL=NotificationService.js.map