import { execute, query } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { fcmConfigured, sendFcm, type FcmMessage } from '../lib/fcm.js';
import type { AuthUser } from './AuthService.js';

/**
 * Push notifications to the Android / iOS app (Firebase Cloud Messaging).
 *
 * Every in-app notification created by NotificationService.notify() is also
 * pushed to the recipients' phones, unless the recipient muted that category.
 * Delivery only uses device tokens whose login session is still valid, so
 * signing out, revoking a session or deactivating an employee stops pushes
 * without any extra clean-up step.
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
] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number]['key'] | 'security';
const CATEGORY_KEYS = new Set<string>(PUSH_CATEGORIES.map((c) => c.key));

/** Maps a notification type (notifications.notif_type) to a push category. */
export function categoryOf(type: string): PushCategory {
  const t = type.toLowerCase();
  if (t === 'security') return 'security';
  if (t.startsWith('task') || t.startsWith('project') || t.startsWith('collection')) return 'tasks';
  if (t.startsWith('chat')) return 'chat';
  if (t.startsWith('meeting') || t.endsWith('_call') || t.startsWith('call')) return 'meetings';
  if (t.startsWith('leave') || t.startsWith('attendance') || t === 'registration') return 'leave';
  if (t.startsWith('ticket')) return 'tickets';
  if (t.startsWith('daily_report') || t.startsWith('kpi') || t.startsWith('activity') || t === 'pattern') return 'reports';
  if (t === 'announcement' || t === 'system' || t === 'app') return 'announcements';
  return 'other';
}

export interface PushPayload {
  notificationId: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  priority: 'low' | 'normal' | 'high' | 'critical';
}

/** Only same-app relative paths are allowed as deep links. */
export function safeDeepLink(link: string | null | undefined): string {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.includes('\\')) return '/notifications';
  return link.slice(0, 255);
}

const MAX_FAILURES = 10;
const CONCURRENCY = 10;

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export class PushService {
  static configured(): boolean {
    return fcmConfigured();
  }

  /**
   * Registers (or moves) a phone's FCM token for the signed-in user and the
   * current session. A token is unique: if another employee signed in on the
   * same phone earlier, the token now belongs to the new user only.
   */
  static async registerDevice(
    user: AuthUser,
    input: { token: string; platform: 'android' | 'ios'; deviceName?: string; appVersion?: string },
  ): Promise<void> {
    await execute(
      `INSERT INTO push_device_tokens (employee_id, session_id, token, platform, device_name, app_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         employee_id = VALUES(employee_id), session_id = VALUES(session_id), platform = VALUES(platform),
         device_name = VALUES(device_name), app_version = VALUES(app_version),
         failure_count = 0, last_error = NULL, updated_at = NOW(3)`,
      [
        user.id,
        user.sessionId || null,
        input.token,
        input.platform,
        input.deviceName?.slice(0, 120) ?? null,
        input.appVersion?.slice(0, 40) ?? null,
      ],
    );
  }

  /** Removes a token (logout, permission withdrawn). Only the owner can remove it. */
  static async unregisterDevice(employeeId: number, token: string): Promise<number> {
    const result = await execute('DELETE FROM push_device_tokens WHERE employee_id = ? AND token = ?', [employeeId, token]);
    return result.affectedRows;
  }

  /** Removes every token registered by a login session (called on logout). */
  static async unregisterSession(sessionId: number): Promise<void> {
    if (!sessionId) return;
    await execute('DELETE FROM push_device_tokens WHERE session_id = ?', [sessionId]);
  }

  static async devices(employeeId: number) {
    const rows = await query<{ id: number; platform: string; device_name: string | null; app_version: string | null; created_at: string; last_sent_at: string | null }>(
      'SELECT id, platform, device_name, app_version, created_at, last_sent_at FROM push_device_tokens WHERE employee_id = ? ORDER BY updated_at DESC',
      [employeeId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      platform: r.platform,
      deviceName: r.device_name,
      appVersion: r.app_version,
      registeredAt: r.created_at,
      lastPushAt: r.last_sent_at,
    }));
  }

  static async preferences(employeeId: number) {
    const rows = await query<{ category: string; push_enabled: number }>(
      'SELECT category, push_enabled FROM notification_preferences WHERE employee_id = ?',
      [employeeId],
    );
    const off = new Set(rows.filter((r) => !r.push_enabled).map((r) => r.category));
    return {
      categories: PUSH_CATEGORIES.map((c) => ({ key: c.key, label: c.label, push: !off.has(c.key) })),
      note: 'Security alerts are always sent.',
    };
  }

  static async setPreferences(employeeId: number, changes: Record<string, boolean>) {
    const entries = Object.entries(changes);
    for (const [key] of entries) {
      if (!CATEGORY_KEYS.has(key)) throw ApiError.badRequest(`Unknown notification category: ${key}`);
    }
    for (const [key, enabled] of entries) {
      await execute(
        `INSERT INTO notification_preferences (employee_id, category, push_enabled) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE push_enabled = VALUES(push_enabled)`,
        [employeeId, key, enabled ? 1 : 0],
      );
    }
    return PushService.preferences(employeeId);
  }

  /**
   * Pushes one notification to the recipients' phones. Never throws: the
   * notification is already stored and visible in the app, push is best effort.
   */
  static async deliver(employeeIds: number[], payload: PushPayload): Promise<{ sent: number; failed: number; removed: number }> {
    const stats = { sent: 0, failed: 0, removed: 0 };
    try {
      if (!fcmConfigured() || employeeIds.length === 0) return stats;
      const category = categoryOf(payload.type);

      let recipients = employeeIds;
      if (category !== 'security') {
        const muted = await query<{ employee_id: number }>(
          'SELECT employee_id FROM notification_preferences WHERE category = ? AND push_enabled = 0 AND employee_id IN (?)',
          [category, recipients],
        );
        const mutedIds = new Set(muted.map((m) => Number(m.employee_id)));
        recipients = recipients.filter((id) => !mutedIds.has(id));
      }
      if (recipients.length === 0) return stats;

      const tokens = await query<{ id: number; employee_id: number; token: string }>(
        `SELECT t.id, t.employee_id, t.token
         FROM push_device_tokens t
         JOIN employee_sessions s ON s.id = t.session_id AND s.revoked_at IS NULL AND s.expires_at > NOW(3)
         JOIN employees e ON e.id = t.employee_id AND e.status = 'active'
         WHERE t.employee_id IN (?)`,
        [recipients],
      );
      if (tokens.length === 0) return stats;

      const unread = await query<{ employee_id: number; total: number }>(
        `SELECT employee_id, COUNT(*) AS total FROM notification_recipients
         WHERE read_at IS NULL AND employee_id IN (?) GROUP BY employee_id`,
        [[...new Set(tokens.map((t) => Number(t.employee_id)))]],
      );
      const badge = new Map(unread.map((u) => [Number(u.employee_id), Number(u.total)]));

      const urgent = payload.priority === 'high' || payload.priority === 'critical';
      const channel: FcmMessage['channel'] =
        category === 'chat' ? 'chat' : payload.type.endsWith('_call') ? 'calls' : urgent || category === 'security' ? 'urgent' : 'general';
      const base: Omit<FcmMessage, 'badge'> = {
        title: payload.title,
        body: payload.body,
        channel,
        priority: urgent || channel !== 'general' ? 'high' : 'normal',
        tag: category === 'chat' ? `chat:${safeDeepLink(payload.link)}` : undefined,
        data: {
          notificationId: String(payload.notificationId),
          type: payload.type,
          category,
          link: safeDeepLink(payload.link),
        },
      };

      await inBatches(tokens, CONCURRENCY, async (t) => {
        const outcome = await sendFcm(t.token, { ...base, badge: badge.get(Number(t.employee_id)) ?? undefined });
        if (outcome.status === 'sent') {
          stats.sent += 1;
          await execute('UPDATE push_device_tokens SET failure_count = 0, last_error = NULL, last_sent_at = NOW(3) WHERE id = ?', [t.id]);
        } else if (outcome.status === 'invalid_token') {
          stats.removed += 1;
          await execute('DELETE FROM push_device_tokens WHERE id = ?', [t.id]);
        } else {
          stats.failed += 1;
          await execute(
            'UPDATE push_device_tokens SET failure_count = failure_count + 1, last_error = ? WHERE id = ?',
            [outcome.error.slice(0, 160), t.id],
          );
          if (outcome.status === 'failed') {
            await execute('DELETE FROM push_device_tokens WHERE id = ? AND failure_count >= ?', [t.id, MAX_FAILURES]);
          }
        }
      });
      if (stats.failed > 0 || stats.removed > 0) {
        console.warn(`[push] notification ${payload.notificationId}: ${stats.sent} sent, ${stats.failed} failed, ${stats.removed} stale tokens removed`);
      }
    } catch (error) {
      console.error('[push] delivery error', (error as Error).message);
    }
    return stats;
  }
}
