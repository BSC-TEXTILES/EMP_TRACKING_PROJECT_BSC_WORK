import { execute, query, queryOne } from '../db/index.js';
import { dayBounds, toIso, today } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { employeesInCallsOrMeetings, getIO, isOnline } from '../realtime/io.js';
import { WebhookService } from './WebhookService.js';

/**
 * Live availability.
 *
 * Effective status is derived on the server, in this priority order:
 *   1. on_leave        approved leave covering today, or chosen manually
 *   2. offline         no live connection (but signed in earlier today)
 *      inactive_today  no live connection and no successful sign-in today
 *   3. dnd             chosen manually; never overridden automatically
 *   4. in_meeting      currently connected to a meeting room or a call
 *   5. on_break        an attendance break is open
 *   6. away            chosen manually, or no keyboard/mouse/focus activity
 *                      for longer than the configurable idle threshold
 *   7. active
 *
 * Idle detection only receives "there was activity" pings; no keystrokes,
 * page content or input values ever reach the server.
 */

export type PresenceStatus = 'active' | 'away' | 'dnd' | 'in_meeting' | 'on_break' | 'on_leave' | 'offline' | 'inactive_today';
export type ManualStatus = 'away' | 'dnd' | 'on_leave';

export const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  active: 'Active',
  away: 'Away',
  dnd: 'Do Not Disturb',
  in_meeting: 'In a Meeting',
  on_break: 'On Break',
  on_leave: 'On Leave',
  offline: 'Offline',
  inactive_today: 'Inactive Today – Employee has not logged in.',
};

const IDLE_SETTING = 'presence.idle_away_minutes';
const DEFAULT_IDLE_MINUTES = 5;

export interface PresenceEntry {
  employeeId: number;
  status: PresenceStatus;
  label: string;
  manual: ManualStatus | null;
  online: boolean;
  lastActiveAt: string | null;
  lastSeenAt: string | null;
}

interface PresenceRow {
  id: number;
  availability_status: string | null;
  last_active_at: string | null;
  last_seen_at: string | null;
  idle_seconds: number | null;
  on_leave: number;
  on_break: number;
  logged_in_today: number;
}

const lastKnown = new Map<number, PresenceStatus>();
let initialised = false;
let idleCache: { minutes: number; at: number } | null = null;

function resolve(row: PresenceRow, idleMinutes: number, busy: Set<number>): PresenceStatus {
  const id = Number(row.id);
  const manual = row.availability_status as ManualStatus | null;
  if (manual === 'on_leave' || Number(row.on_leave)) return 'on_leave';
  if (!isOnline(id)) return Number(row.logged_in_today) ? 'offline' : 'inactive_today';
  if (manual === 'dnd') return 'dnd';
  if (busy.has(id)) return 'in_meeting';
  if (Number(row.on_break)) return 'on_break';
  if (manual === 'away') return 'away';
  if (row.idle_seconds !== null && Number(row.idle_seconds) > idleMinutes * 60) return 'away';
  return 'active';
}

export class PresenceService {
  static async idleMinutes(): Promise<number> {
    if (idleCache && Date.now() - idleCache.at < 30_000) return idleCache.minutes;
    const row = await queryOne<{ setting_value: string | null }>('SELECT setting_value FROM system_settings WHERE setting_key = ?', [IDLE_SETTING]);
    const parsed = Number.parseInt(row?.setting_value ?? '', 10);
    const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MINUTES;
    idleCache = { minutes, at: Date.now() };
    return minutes;
  }

  static async setIdleMinutes(minutes: number, actorId: number): Promise<number> {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw ApiError.badRequest('The inactivity threshold must be between 1 and 240 minutes');
    await execute(
      `INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [IDLE_SETTING, String(minutes), actorId],
    );
    idleCache = null;
    void PresenceService.sweep();
    return minutes;
  }

  private static async rows(employeeIds?: number[]): Promise<PresenceRow[]> {
    if (employeeIds && employeeIds.length === 0) return [];
    const date = today();
    const { start } = dayBounds(date);
    const filter = employeeIds ? `AND e.id IN (${employeeIds.map(() => '?').join(',')})` : '';
    return query<PresenceRow>(
      `SELECT e.id, e.availability_status, e.last_active_at, e.last_seen_at,
         TIMESTAMPDIFF(SECOND, e.last_active_at, NOW(3)) AS idle_seconds,
         EXISTS(SELECT 1 FROM leave_requests lr WHERE lr.employee_id = e.id AND lr.status = 'approved'
                AND ? BETWEEN lr.start_date AND lr.end_date) AS on_leave,
         EXISTS(SELECT 1 FROM attendance_breaks b JOIN attendance a ON a.id = b.attendance_id
                WHERE a.employee_id = e.id AND a.work_date = ? AND b.ended_at IS NULL) AS on_break,
         EXISTS(SELECT 1 FROM login_history h WHERE h.employee_id = e.id AND h.success = 1 AND h.created_at >= ?) AS logged_in_today
       FROM employees e WHERE e.status = 'active' ${filter}`,
      [date, date, start, ...(employeeIds ?? [])],
    );
  }

  private static entry(row: PresenceRow, status: PresenceStatus): PresenceEntry {
    return {
      employeeId: Number(row.id),
      status,
      label: PRESENCE_LABELS[status],
      manual: (row.availability_status as ManualStatus | null) ?? null,
      online: isOnline(Number(row.id)),
      lastActiveAt: toIso(row.last_active_at),
      lastSeenAt: toIso(row.last_seen_at),
    };
  }

  static async list(employeeIds?: number[]): Promise<PresenceEntry[]> {
    const [rows, idle] = await Promise.all([PresenceService.rows(employeeIds), PresenceService.idleMinutes()]);
    const busy = employeesInCallsOrMeetings();
    return rows.map((row) => PresenceService.entry(row, resolve(row, idle, busy)));
  }

  static async forEmployee(employeeId: number): Promise<PresenceEntry> {
    const [entry] = await PresenceService.list([employeeId]);
    if (!entry) throw ApiError.notFound('Employee not found');
    return entry;
  }

  static async setManual(employeeId: number, status: 'active' | ManualStatus): Promise<PresenceEntry> {
    const manual = status === 'active' ? null : status;
    await execute(
      'UPDATE employees SET availability_status = ?, availability_set_at = NOW(3), last_active_at = IF(? IS NULL, NOW(3), last_active_at) WHERE id = ?',
      [manual, manual, employeeId],
    );
    return PresenceService.refresh(employeeId, 'manual');
  }

  /** Records that real user activity happened. Returns the new effective status. */
  static async ping(employeeId: number): Promise<PresenceEntry> {
    await execute('UPDATE employees SET last_active_at = NOW(3) WHERE id = ?', [employeeId]);
    return PresenceService.refresh(employeeId);
  }

  /** Clears a manual status at explicit sign-out so it does not stick to the next day. */
  static async clearOnSignOut(employeeId: number): Promise<void> {
    await execute("UPDATE employees SET availability_status = NULL WHERE id = ? AND availability_status IN ('away','dnd')", [employeeId]);
  }

  /** Recomputes one employee and broadcasts if the status changed. */
  static async refresh(employeeId: number, source: 'auto' | 'manual' = 'auto'): Promise<PresenceEntry> {
    const entry = await PresenceService.forEmployee(employeeId);
    await PresenceService.publish(entry, source);
    return entry;
  }

  private static async publish(entry: PresenceEntry, source: 'auto' | 'manual'): Promise<void> {
    const previous = lastKnown.get(entry.employeeId);
    lastKnown.set(entry.employeeId, entry.status);
    if (previous === entry.status) return;
    getIO()?.emit('presence:status', entry);
    // The first observation after boot is a baseline, not a transition.
    if (previous === undefined && !initialised) return;
    await execute('INSERT INTO employee_status_events (employee_id, status, previous_status, source) VALUES (?, ?, ?, ?)', [
      entry.employeeId,
      entry.status,
      previous ?? null,
      source,
    ]).catch((error) => console.error('[presence] could not record status event', error));
    void WebhookService.emit('employee.status_changed', {
      employeeId: entry.employeeId,
      status: entry.status,
      previousStatus: previous ?? null,
      source,
    });
  }

  /** Periodic recomputation: catches idle timeouts, leave starting, day rollover. */
  static async sweep(): Promise<number> {
    const entries = await PresenceService.list();
    let changed = 0;
    for (const entry of entries) {
      if (lastKnown.get(entry.employeeId) !== entry.status) changed += 1;
      await PresenceService.publish(entry, 'auto');
    }
    initialised = true;
    return changed;
  }

  /** Status-change history for one employee and day (used by reports). */
  static async history(employeeId: number, date: string) {
    const { start, end } = dayBounds(date);
    const rows = await query<{ status: string; previous_status: string | null; source: string; created_at: string }>(
      `SELECT status, previous_status, source, created_at FROM employee_status_events
       WHERE employee_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`,
      [employeeId, start, end],
    );
    return rows.map((r) => ({ status: r.status, previousStatus: r.previous_status, source: r.source, at: toIso(r.created_at) }));
  }
}
