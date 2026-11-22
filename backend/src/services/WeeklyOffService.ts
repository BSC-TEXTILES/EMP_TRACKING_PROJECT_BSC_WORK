import { execute, query, queryOne } from '../db/index.js';
import { getSettings, recordAudit, setSetting } from '../lib/audit.js';
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  dateRange,
  datesInMonth,
  daysInMonth,
  eligibleWeeklyOffDates,
  isLeapYear,
  isWeeklyOff,
  isoDate,
  normalizeWeekday,
  sundaysInMonth,
  weekdayOf,
  weekdaysInMonth,
} from '../lib/calendar.js';
import { addDays, today } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { allowedLocationIds, locationEmployeeIds, subtreeIds } from '../lib/scope.js';
import { emitToEmployee, getIO } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import type { AuthUser } from './AuthService.js';

/**
 * Request-based weekly offs and compensatory offs.
 *
 * - Each employee has an assigned weekly-off weekday (employees.weekly_off_day, Sunday by
 *   default). Eligible dates are derived from the real calendar and the joining date, so a
 *   month with five such weekdays allocates five weekly offs, one with four allocates four.
 * - A weekly off counts as taken only once its request is approved by the manager and HR;
 *   a pending request reserves its date. Balances are always recomputed from the database
 *   and snapshotted per employee and month in weekly_off_allocations.
 * - Weekly offs are separate from CL/SL/EL: leave ranges never charge weekly-off days.
 * - Working on a Sunday (or, if enabled, a public holiday) earns a comp-off credit,
 *   recorded once per employee per day (unique key) according to the leave policy.
 *
 * This service depends only on the database and helpers (never on LeaveService or
 * AttendanceService), so both of those can call it without circular imports.
 */

export interface LeavePolicy {
  compOffEnabled: boolean;
  compOffOnHolidays: boolean;
  /** Minutes worked on a weekly off for a full comp-off day. */
  compOffFullDayMinutes: number;
  /** Minutes worked for a half comp-off day; 0 disables half days. */
  compOffHalfDayMinutes: number;
  /** Days after which an unused comp-off lapses; 0 = never. */
  compOffExpiryDays: number;
}

const POLICY_KEYS = {
  compOffEnabled: 'leave_policy.comp_off_enabled',
  compOffOnHolidays: 'leave_policy.comp_off_on_holidays',
  compOffFullDayMinutes: 'leave_policy.comp_off_full_minutes',
  compOffHalfDayMinutes: 'leave_policy.comp_off_half_minutes',
  compOffExpiryDays: 'leave_policy.comp_off_expiry_days',
} as const;

const DEFAULT_POLICY: LeavePolicy = {
  compOffEnabled: true,
  compOffOnHolidays: true,
  compOffFullDayMinutes: 360,
  compOffHalfDayMinutes: 180,
  compOffExpiryDays: 90,
};

export type WeeklyOffDateStatus = 'taken' | 'pending' | 'available' | 'worked' | 'lapsed' | 'not_eligible';

interface EmployeeRow {
  id: number;
  full_name: string;
  employee_code: string | null;
  joining_date: string | null;
  deactivated_at: string | null;
  location_id: number | null;
  weekly_off_day: number | null;
  location_name: string | null;
  location_code: string | null;
  department_name: string | null;
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true';
}

export function assertYearMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw ApiError.badRequest('Select a year between 2000 and 2100.');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw ApiError.badRequest('Select a month between 1 and 12.');
}

export class WeeklyOffService {
  // ------------------------------------------------------------------ policy

  static async policy(): Promise<LeavePolicy> {
    const raw = await getSettings(Object.values(POLICY_KEYS));
    return {
      compOffEnabled: toBool(raw[POLICY_KEYS.compOffEnabled], DEFAULT_POLICY.compOffEnabled),
      compOffOnHolidays: toBool(raw[POLICY_KEYS.compOffOnHolidays], DEFAULT_POLICY.compOffOnHolidays),
      compOffFullDayMinutes: toInt(raw[POLICY_KEYS.compOffFullDayMinutes], DEFAULT_POLICY.compOffFullDayMinutes),
      compOffHalfDayMinutes: toInt(raw[POLICY_KEYS.compOffHalfDayMinutes], DEFAULT_POLICY.compOffHalfDayMinutes),
      compOffExpiryDays: toInt(raw[POLICY_KEYS.compOffExpiryDays], DEFAULT_POLICY.compOffExpiryDays),
    };
  }

  /** Super Admin / HR only (permission `leave.manage`). */
  static async updatePolicy(actor: AuthUser, input: LeavePolicy): Promise<LeavePolicy> {
    if (!actor.permissions.includes('leave.manage')) throw ApiError.forbidden('Only HR or a Super Admin can change the leave policy.');
    if (input.compOffFullDayMinutes < 60 || input.compOffFullDayMinutes > 1440) {
      throw ApiError.badRequest('Full-day comp-off threshold must be between 60 and 1440 minutes.');
    }
    if (input.compOffHalfDayMinutes < 0 || input.compOffHalfDayMinutes >= input.compOffFullDayMinutes) {
      throw ApiError.badRequest('Half-day threshold must be 0 (disabled) or less than the full-day threshold.');
    }
    if (input.compOffExpiryDays < 0 || input.compOffExpiryDays > 730) throw ApiError.badRequest('Comp-off expiry must be between 0 and 730 days.');
    const before = await WeeklyOffService.policy();
    await setSetting(POLICY_KEYS.compOffEnabled, input.compOffEnabled ? '1' : '0', actor.id);
    await setSetting(POLICY_KEYS.compOffOnHolidays, input.compOffOnHolidays ? '1' : '0', actor.id);
    await setSetting(POLICY_KEYS.compOffFullDayMinutes, String(input.compOffFullDayMinutes), actor.id);
    await setSetting(POLICY_KEYS.compOffHalfDayMinutes, String(input.compOffHalfDayMinutes), actor.id);
    await setSetting(POLICY_KEYS.compOffExpiryDays, String(input.compOffExpiryDays), actor.id);
    await recordAudit({ actorId: actor.id, action: 'leave.policy_updated', entityType: 'leave_policy', entityId: null, before, after: input });
    const after = await WeeklyOffService.policy();
    getIO()?.emit('leave:policy', after);
    return after;
  }

  // ---------------------------------------------------------------- holidays

  /** Public holidays that apply to the employee (organisation-wide or their own location). */
  static async employeeHolidays(employeeId: number, from: string, to: string): Promise<Map<string, string>> {
    const rows = await query<{ holiday_date: string; name: string }>(
      `SELECT h.holiday_date, h.name FROM holidays h
       WHERE h.holiday_date BETWEEN ? AND ?
         AND (h.location_id IS NULL OR h.location_id = (SELECT location_id FROM employees WHERE id = ?))
       ORDER BY h.holiday_date, h.id`,
      [from, to, employeeId],
    );
    const map = new Map<string, string>();
    for (const row of rows) {
      const date = String(row.holiday_date).slice(0, 10);
      // Two entries on the same date are shown once (no duplicate holiday).
      map.set(date, map.has(date) ? `${map.get(date)} / ${row.name}` : row.name);
    }
    return map;
  }

  // ---------------------------------------------------------------- comp-off

  /** Comp-off balance across years (credits do not reset on 1 January; they expire by policy). */
  static async compOffTotals(employeeId: number) {
    const credits = await queryOne<{ earned: number | null }>(
      `SELECT SUM(days - expired_days) AS earned FROM comp_off_credits WHERE employee_id = ? AND status IN ('earned', 'expired')`,
      [employeeId],
    );
    const ledger = await queryOne<{ manual: number | null; used: number | null }>(
      `SELECT SUM(b.allocated) AS manual, SUM(b.used) AS used
       FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
       WHERE b.employee_id = ? AND t.code = 'CO'`,
      [employeeId],
    );
    const earned = Number(credits?.earned ?? 0);
    const manual = Number(ledger?.manual ?? 0);
    const used = Number(ledger?.used ?? 0);
    const allocated = earned + manual;
    return { earned, manual, allocated, used, available: Math.max(0, allocated - used) };
  }

  static async compOffCredits(employeeId: number, limit = 50) {
    const rows = await query<{
      id: number;
      work_date: string;
      source: string;
      worked_minutes: number;
      days: number;
      expired_days: number;
      status: string;
      expires_on: string | null;
      note: string | null;
    }>(
      `SELECT id, work_date, source, worked_minutes, days, expired_days, status, expires_on, note
       FROM comp_off_credits WHERE employee_id = ? ORDER BY work_date DESC LIMIT ${Math.min(200, Math.max(1, limit))}`,
      [employeeId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      workDate: String(row.work_date).slice(0, 10),
      source: row.source,
      workedMinutes: Number(row.worked_minutes),
      days: Number(row.days),
      expiredDays: Number(row.expired_days),
      status: row.status,
      expiresOn: row.expires_on ? String(row.expires_on).slice(0, 10) : null,
      note: row.note,
    }));
  }

  /**
   * Re-evaluates the comp-off credit for one employee-day from the attendance row.
   * Idempotent: safe to call after check-out, correction approval, auto-close and
   * from the nightly reconciliation. Never creates a second credit for the same day.
   */
  static async syncCompOff(employeeId: number, workDate: string): Promise<void> {
    const date = workDate.slice(0, 10);
    const policy = await WeeklyOffService.policy();
    if (!policy.compOffEnabled) return;

    let source: 'sunday' | 'holiday' | null = null;
    // 'sunday' is the stored source name for "worked on the assigned weekly off".
    if (isWeeklyOff(date, await WeeklyOffService.employeeWeekday(employeeId))) source = 'sunday';
    else if (policy.compOffOnHolidays && (await WeeklyOffService.employeeHolidays(employeeId, date, date)).has(date)) source = 'holiday';

    const existing = await queryOne<{ id: number; days: number; status: string }>(
      'SELECT id, days, status FROM comp_off_credits WHERE employee_id = ? AND work_date = ?',
      [employeeId, date],
    );
    if (!source) return;

    const attendance = await queryOne<{ id: number; total_minutes: number; check_in_at: string | null; check_out_at: string | null }>(
      'SELECT id, total_minutes, check_in_at, check_out_at FROM attendance WHERE employee_id = ? AND work_date = ?',
      [employeeId, date],
    );
    if (attendance?.check_in_at && !attendance.check_out_at) return; // still working: decide at check-out
    const minutes = Number(attendance?.total_minutes ?? 0);
    const days =
      minutes >= policy.compOffFullDayMinutes ? 1 : policy.compOffHalfDayMinutes > 0 && minutes >= policy.compOffHalfDayMinutes ? 0.5 : 0;
    const expiresOn = policy.compOffExpiryDays > 0 ? addDays(date, policy.compOffExpiryDays) : null;
    const label = source === 'sunday' ? 'weekly off' : 'public holiday';

    if (!existing) {
      if (days === 0) return;
      const result = await execute(
        `INSERT IGNORE INTO comp_off_credits (employee_id, work_date, source, attendance_id, worked_minutes, days, expires_on, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [employeeId, date, source, attendance?.id ?? null, minutes, days, expiresOn, `Worked on ${label}`],
      );
      if (result.affectedRows) {
        await recordAudit({ actorId: null, action: 'leave.comp_off_credited', entityType: 'comp_off_credit', entityId: result.insertId, after: { employeeId, date, source, minutes, days } });
        await NotificationService.notify({
          employeeIds: [employeeId],
          type: 'leave',
          title: 'Compensatory off credited',
          body: `You worked on a ${label} (${date}). ${days === 1 ? '1 day' : 'Half a day'} of comp-off was added${expiresOn ? `, usable until ${expiresOn}` : ''}.`,
          link: '/leave',
          dedupeKey: `comp_off:${employeeId}:${date}`,
        });
        emitToEmployee(employeeId, 'leave:updated', { reason: 'comp_off', date });
      }
      return;
    }

    if (existing.status === 'expired') return; // history is never rewritten after expiry
    const currentDays = existing.status === 'revoked' ? 0 : Number(existing.days);
    if (currentDays === days) return;
    if (days === 0) {
      await execute(
        "UPDATE comp_off_credits SET status = 'revoked', worked_minutes = ?, note = ? WHERE id = ?",
        [minutes, 'Worked time below the comp-off threshold after attendance update', existing.id],
      );
    } else {
      await execute(
        "UPDATE comp_off_credits SET status = 'earned', days = ?, worked_minutes = ?, attendance_id = ?, note = ? WHERE id = ?",
        [days, minutes, attendance?.id ?? null, `Worked on ${label} (updated)`, existing.id],
      );
    }
    await recordAudit({ actorId: null, action: 'leave.comp_off_adjusted', entityType: 'comp_off_credit', entityId: Number(existing.id), before: { days: currentDays }, after: { days, minutes } });
    emitToEmployee(employeeId, 'leave:updated', { reason: 'comp_off', date });
  }

  /** Nightly catch-up so a missed hook (crash, manual DB fix) still credits comp-offs. */
  static async reconcileRecent(days = 7): Promise<number> {
    const from = addDays(today(), -days);
    const rows = await query<{ employee_id: number; work_date: string }>(
      `SELECT a.employee_id, a.work_date FROM attendance a JOIN employees e ON e.id = a.employee_id
       WHERE a.work_date >= ? AND a.check_in_at IS NOT NULL AND a.check_out_at IS NOT NULL
         AND (DAYOFWEEK(a.work_date) = e.weekly_off_day + 1 OR EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = a.work_date)
              OR EXISTS (SELECT 1 FROM comp_off_credits c WHERE c.employee_id = a.employee_id AND c.work_date = a.work_date))`,
      [from],
    );
    for (const row of rows) {
      try {
        await WeeklyOffService.syncCompOff(Number(row.employee_id), String(row.work_date));
      } catch (error) {
        console.error('[comp-off] reconcile failed', row, error);
      }
    }
    return rows.length;
  }

  /**
   * Lapses unused comp-off past its expiry. Usage is applied oldest-credit-first, so
   * only the part of an expired credit that was never used is lapsed.
   */
  static async expireCompOffs(): Promise<number> {
    const due = await query<{ employee_id: number }>(
      "SELECT DISTINCT employee_id FROM comp_off_credits WHERE status = 'earned' AND expires_on IS NOT NULL AND expires_on < ?",
      [today()],
    );
    let lapsed = 0;
    for (const { employee_id } of due) {
      const employeeId = Number(employee_id);
      const totals = await WeeklyOffService.compOffTotals(employeeId);
      let remainingUsed = totals.used;
      const credits = await query<{ id: number; days: number; expired_days: number; status: string; expires_on: string | null }>(
        "SELECT id, days, expired_days, status, expires_on FROM comp_off_credits WHERE employee_id = ? AND status IN ('earned','expired') ORDER BY work_date, id",
        [employeeId],
      );
      for (const credit of credits) {
        const net = Number(credit.days) - Number(credit.expired_days);
        const consumed = Math.min(net, Math.max(0, remainingUsed));
        remainingUsed -= consumed;
        if (credit.status !== 'earned' || !credit.expires_on || String(credit.expires_on).slice(0, 10) >= today()) continue;
        const unused = net - consumed;
        await execute("UPDATE comp_off_credits SET status = 'expired', expired_days = expired_days + ? WHERE id = ? AND status = 'earned'", [unused, credit.id]);
        if (unused > 0) lapsed += 1;
      }
      emitToEmployee(employeeId, 'leave:updated', { reason: 'comp_off_expired' });
    }
    return lapsed;
  }


  // ------------------------------------------------------ weekly-off balance

  /** The employee's assigned weekly-off weekday (0 = Sunday … 6 = Saturday). */
  static async employeeWeekday(employeeId: number): Promise<number> {
    const row = await queryOne<{ weekly_off_day: number | null }>('SELECT weekly_off_day FROM employees WHERE id = ?', [employeeId]);
    return normalizeWeekday(row?.weekly_off_day);
  }

  /** HR / Super Admin: change an employee's weekly-off weekday. Past approved requests are kept as history. */
  static async setEmployeeWeekday(actor: AuthUser, employeeId: number, weekday: number): Promise<{ weekday: number; weekdayName: string }> {
    if (!actor.permissions.includes('leave.manage')) throw ApiError.forbidden('Only HR or a Super Admin can change weekly-off days.');
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw ApiError.badRequest('Select a weekday between Sunday and Saturday.');
    const before = await WeeklyOffService.employeeWeekday(employeeId);
    const result = await execute('UPDATE employees SET weekly_off_day = ? WHERE id = ?', [weekday, employeeId]);
    if (!result.affectedRows) throw ApiError.notFound('Employee not found');
    await recordAudit({ actorId: actor.id, action: 'leave.weekly_off_day_updated', entityType: 'employee', entityId: employeeId, before: { weekday: before }, after: { weekday } });
    emitToEmployee(employeeId, 'leave:updated', { reason: 'weekly_off_day' });
    getIO()?.emit('leave:policy', { reason: 'weekly_off_day', employeeId });
    return { weekday, weekdayName: WEEKDAY_NAMES[weekday] };
  }

  /**
   * The single source of truth for one employee's weekly offs in one month.
   *
   * - allocated = assigned-weekday dates in the month on/after joining (and on/before exit)
   * - taken     = approved weekly-off requests (or attendance explicitly marked weekly_off) on those dates
   * - pending   = weekly-off requests awaiting manager / HR approval (they reserve their date)
   * - remaining = allocated − taken
   * - available = allocated − taken − pending   (what can still be applied for)
   *
   * `run` lets the same calculation execute inside a locked transaction.
   */
  static async monthBalance(
    employeeId: number,
    year: number,
    month: number,
    run: <T>(sql: string, params: unknown[]) => Promise<T[]> = (sql, params) => query(sql, params),
  ) {
    assertYearMonth(year, month);
    const [employee] = await run<{ joining_date: string | null; deactivated_at: string | null; weekly_off_day: number | null }>(
      'SELECT joining_date, deactivated_at, weekly_off_day FROM employees WHERE id = ?',
      [employeeId],
    );
    if (!employee) throw ApiError.notFound('Employee not found');
    const weekday = normalizeWeekday(employee.weekly_off_day);
    const joiningDate = employee.joining_date ? String(employee.joining_date).slice(0, 10) : null;
    const exitDate = employee.deactivated_at ? String(employee.deactivated_at).slice(0, 10) : null;
    const start = isoDate(year, month, 1);
    const end = isoDate(year, month, daysInMonth(year, month));
    const allDates = weekdaysInMonth(year, month, weekday);
    const eligible = eligibleWeeklyOffDates(year, month, weekday, joiningDate, exitDate);

    const [requests, attendance] = await Promise.all([
      run<{ id: number; start_date: string; status: string }>(
        `SELECT id, start_date, status FROM leave_requests
         WHERE employee_id = ? AND request_kind = 'weekly_off' AND status IN ('pending_manager','pending_hr','approved')
           AND start_date BETWEEN ? AND ?`,
        [employeeId, start, end],
      ),
      run<{ work_date: string; status: string; check_in_at: string | null }>(
        'SELECT work_date, status, check_in_at FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?',
        [employeeId, start, end],
      ),
    ]);

    const approved = new Map<string, number>();
    const pending = new Map<string, number>();
    for (const row of requests) {
      const date = String(row.start_date).slice(0, 10);
      if (row.status === 'approved') approved.set(date, Number(row.id));
      else if (row.status === 'pending_manager' || row.status === 'pending_hr') pending.set(date, Number(row.id));
    }
    const markedOff = new Set<string>();
    const worked = new Set<string>();
    for (const row of attendance) {
      const date = String(row.work_date).slice(0, 10);
      if (row.check_in_at) worked.add(date);
      else if (row.status === 'weekly_off') {
        markedOff.add(date);
        if (!approved.has(date)) approved.set(date, 0);
      }
    }

    const now = today();
    const currentMonthStart = `${now.slice(0, 7)}-01`;
    const eligibleSet = new Set(eligible);
    const dates = allDates.map((date) => {
      let status: WeeklyOffDateStatus;
      if (!eligibleSet.has(date)) status = 'not_eligible';
      else if (approved.has(date) || markedOff.has(date)) status = 'taken';
      else if (pending.has(date)) status = 'pending';
      else if (worked.has(date)) status = 'worked';
      // Weekly offs of a closed month that were never applied for lapse; the current
      // month can still be regularised (no check-in recorded on that date).
      else if (date < currentMonthStart) status = 'lapsed';
      else status = 'available';
      return { date, day: Number(date.slice(8, 10)), status, requestId: approved.get(date) ?? pending.get(date) ?? null };
    });

    const allocated = eligible.length;
    // Count all approved weekly offs in this month (including those taken on weekdays)
    const taken = approved.size;
    const pendingCount = pending.size;
    const takenDates = Array.from(approved.keys()).sort();
    const pendingDates = Array.from(pending.keys()).sort();

    return {
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday],
      joiningDate,
      exitDate,
      allDates,
      eligible,
      dates,
      allocated,
      taken,
      pending: pendingCount,
      remaining: Math.max(0, allocated - taken),
      available: Math.max(0, allocated - taken - pendingCount),
      worked: worked.size,
      notEligible: Math.max(0, allDates.length - eligible.length),
      takenDates,
      pendingDates,
      sundays: allDates,
      sundaysCount: allDates.length,
    };
  }

  /** Stores the monthly allocation snapshot (employee × month) so HR reports read persisted figures. */
  static async persistAllocation(employeeId: number, year: number, month: number, balance?: Awaited<ReturnType<typeof WeeklyOffService.monthBalance>>) {
    const b = balance ?? (await WeeklyOffService.monthBalance(employeeId, year, month));
    await execute(
      `INSERT INTO weekly_off_allocations (employee_id, alloc_year, alloc_month, weekday, allocated, taken, pending, eligible_dates)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE weekday = VALUES(weekday), allocated = VALUES(allocated), taken = VALUES(taken),
                               pending = VALUES(pending), eligible_dates = VALUES(eligible_dates)`,
      [employeeId, year, month, b.weekday, b.allocated, b.taken, b.pending, JSON.stringify(b.eligible)],
    ).catch((error) => console.error('[weekly-off] allocation snapshot failed', error));
  }

  // ------------------------------------------------------------- summaries

  private static async employee(employeeId: number): Promise<EmployeeRow> {
    const row = await queryOne<EmployeeRow>(
      `SELECT e.id, e.full_name, e.employee_code, e.joining_date, e.deactivated_at, e.location_id, e.weekly_off_day,
              l.name AS location_name, l.code AS location_code, d.name AS department_name
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`,
      [employeeId],
    );
    if (!row) throw ApiError.notFound('Employee not found');
    return row;
  }

  /** Full month view for one employee: weekly-off counters, half-day counters and a read-only day calendar. */
  static async monthSummary(employeeId: number, year: number, month: number) {
    assertYearMonth(year, month);
    const employee = await WeeklyOffService.employee(employeeId);
    const start = isoDate(year, month, 1);
    const end = isoDate(year, month, daysInMonth(year, month));
    const now = today();

    const [balance, holidays, attendanceRows, leaveRows, credits, policy, halfDayRows, pendingRows] = await Promise.all([
      WeeklyOffService.monthBalance(employeeId, year, month),
      WeeklyOffService.employeeHolidays(employeeId, start, end),
      query<{ work_date: string; status: string; check_in_at: string | null; total_minutes: number }>(
        'SELECT work_date, status, check_in_at, total_minutes FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?',
        [employeeId, start, end],
      ),
      query<{ start_date: string; end_date: string; type_name: string; code: string; status: string; is_half_day: number; half_day_slot: string | null }>(
        `SELECT l.start_date, l.end_date, t.name AS type_name, t.code, l.status, l.is_half_day, l.half_day_slot
         FROM leave_requests l JOIN leave_types t ON t.id = l.leave_type_id
         WHERE l.employee_id = ? AND l.request_kind <> 'weekly_off' AND l.status IN ('approved','pending_manager','pending_hr')
           AND l.start_date <= ? AND l.end_date >= ?`,
        [employeeId, end, start],
      ),
      query<{ work_date: string; days: number; status: string }>(
        'SELECT work_date, days, status FROM comp_off_credits WHERE employee_id = ? AND work_date BETWEEN ? AND ?',
        [employeeId, start, end],
      ),
      WeeklyOffService.policy(),
      query<{ total: number; deducted: number | null }>(
        `SELECT COUNT(*) AS total, SUM(days) AS deducted FROM leave_requests
         WHERE employee_id = ? AND is_half_day = 1 AND status = 'approved' AND start_date BETWEEN ? AND ?`,
        [employeeId, start, end],
      ),
      query<{ request_kind: string; is_half_day: number; total: number }>(
        `SELECT request_kind, is_half_day, COUNT(*) AS total FROM leave_requests
         WHERE employee_id = ? AND status IN ('pending_manager','pending_hr') AND start_date BETWEEN ? AND ?
         GROUP BY request_kind, is_half_day`,
        [employeeId, start, end],
      ),
    ]);

    const weekday = balance.weekday;
    const attendance = new Map(attendanceRows.map((row) => [String(row.work_date).slice(0, 10), row]));
    const creditByDate = new Map(credits.map((row) => [String(row.work_date).slice(0, 10), row]));
    const offByDate = new Map(balance.dates.map((entry) => [entry.date, entry]));
    const leaveByDate = new Map<string, { type: string; code: string; status: string; isHalfDay: boolean; halfDaySlot: string | null }>();
    for (const leave of leaveRows) {
      const from = String(leave.start_date).slice(0, 10) < start ? start : String(leave.start_date).slice(0, 10);
      const to = String(leave.end_date).slice(0, 10) > end ? end : String(leave.end_date).slice(0, 10);
      for (const date of dateRange(from, to)) {
        if (!leaveByDate.has(date) || leave.status === 'approved') {
          leaveByDate.set(date, {
            type: leave.type_name,
            code: leave.code,
            status: leave.status,
            isHalfDay: Boolean(leave.is_half_day),
            halfDaySlot: leave.half_day_slot ?? null,
          });
        }
      }
    }

    const weeklyOffDates = balance.dates.map((entry) => {
      const row = attendance.get(entry.date);
      const credit = creditByDate.get(entry.date);
      return {
        ...entry,
        holidayName: holidays.get(entry.date) ?? null,
        workedMinutes: row?.check_in_at ? Number(row?.total_minutes ?? 0) : 0,
        compOffDays: credit && credit.status !== 'revoked' ? Number(credit.days) : 0,
      };
    });

    const days = datesInMonth(year, month).map((date) => {
      const row = attendance.get(date);
      const leave = leaveByDate.get(date) ?? null;
      const off = offByDate.get(date) ?? null;
      const weeklyOff = isWeeklyOff(date, weekday);
      const holidayName = holidays.get(date) ?? null;
      const credit = creditByDate.get(date);
      const isHalfDay = Boolean(row?.status === 'half_day' || leave?.isHalfDay);
      return {
        date,
        day: Number(date.slice(8, 10)),
        weekday: weekdayOf(date),
        isWeeklyOff: weeklyOff,
        isEligibleWeeklyOff: weeklyOff && off?.status !== 'not_eligible',
        weeklyOffStatus: off?.status ?? null,
        // System-generated weekly-off cells can never be edited from the calendar.
        readOnly: weeklyOff,
        holidayName,
        isToday: date === now,
        isFuture: date > now,
        attendanceStatus: row ? row.status : null,
        worked: Boolean(row?.check_in_at),
        workedMinutes: Number(row?.total_minutes ?? 0),
        isHalfDay,
        halfDaySlot: leave?.halfDaySlot ?? null,
        // Leave never "consumes" a weekly off or holiday, so those days do not show the leave.
        leave: leave && !weeklyOff && !holidayName ? leave : null,
        compOffDays: credit && credit.status !== 'revoked' ? Number(credit.days) : 0,
      };
    });

    const holidaysOnWorkdays = [...holidays.keys()].filter((date) => !isWeeklyOff(date, weekday)).length;
    const compOff = await WeeklyOffService.compOffTotals(employeeId);
    const pendingTotal = pendingRows.reduce((sum, row) => sum + Number(row.total), 0);
    const pendingHalfDays = pendingRows.filter((row) => Number(row.is_half_day) === 1).reduce((sum, row) => sum + Number(row.total), 0);
    await WeeklyOffService.persistAllocation(employeeId, year, month, balance);

    return {
      employee: {
        id: Number(employee.id),
        name: employee.full_name,
        code: employee.employee_code,
        joiningDate: balance.joiningDate,
        locationId: employee.location_id ? Number(employee.location_id) : null,
        locationName: employee.location_name,
        locationCode: employee.location_code,
        departmentName: employee.department_name,
      },
      year,
      month,
      monthName: MONTH_NAMES[month - 1],
      daysInMonth: daysInMonth(year, month),
      isLeapYear: isLeapYear(year),
      firstWeekday: weekdayOf(start),
      today: now,
      weeklyOffDay: weekday,
      weeklyOffDayName: balance.weekdayName,
      /** Number of assigned-weekday dates in the month (kept under its historic name). */
      totalSundays: balance.allDates.length,
      weeklyOffs: {
        allocated: balance.allocated,
        taken: balance.taken,
        pending: balance.pending,
        remaining: balance.remaining,
        available: balance.available,
        worked: balance.worked,
        notEligible: balance.notEligible,
      },
      halfDays: {
        taken: Number(halfDayRows[0]?.total ?? 0),
        deducted: Number(halfDayRows[0]?.deducted ?? 0),
        pending: pendingHalfDays,
      },
      pendingRequests: pendingTotal,
      publicHolidays: [...holidays.entries()].map(([date, name]) => ({ date, name, onWeeklyOff: isWeeklyOff(date, weekday) })),
      workingDays: daysInMonth(year, month) - balance.allDates.length - holidaysOnWorkdays,
      leaveDaysThisMonth: days.filter((day) => day.leave?.status === 'approved').reduce((sum, day) => sum + (day.leave?.isHalfDay ? 0.5 : 1), 0),
      compOff: {
        earnedThisMonth: credits.filter((row) => row.status !== 'revoked').reduce((sum, row) => sum + Number(row.days), 0),
        ...compOff,
      },
      policy,
      /** Weekly-off dates of the month with their status (kept under its historic name). */
      sundays: weeklyOffDates,
      days,
    };
  }

  /** Employees whose weekly-off and leave details the user may see, with location scoping (BEL / DAV / SHI / HQ). */
  private static async visibleEmployees(user: AuthUser, locationId: number | null): Promise<EmployeeRow[]> {
    let ids: number[] | null;
    if (user.permissions.includes('leave.view.all')) {
      ids = await locationEmployeeIds(user);
    } else if (user.permissions.includes('leave.view.team')) {
      const team = await subtreeIds(user.id);
      const located = await locationEmployeeIds(user);
      ids = located === null ? team : team.filter((id) => located.includes(id));
    } else {
      throw ApiError.forbidden('You can only view your own weekly offs.');
    }
    if (locationId) {
      const allowed = await allowedLocationIds(user);
      if (allowed !== null && !allowed.includes(locationId)) throw ApiError.forbidden('That location is outside your access.');
    }
    if (ids !== null && ids.length === 0) return [];
    const clauses = ["e.status = 'active'"];
    const params: unknown[] = [];
    if (ids !== null) {
      clauses.push(`e.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (locationId) {
      clauses.push('e.location_id = ?');
      params.push(locationId);
    }
    return query<EmployeeRow>(
      `SELECT e.id, e.full_name, e.employee_code, e.joining_date, e.deactivated_at, e.location_id, e.weekly_off_day,
              l.name AS location_name, l.code AS location_code, d.name AS department_name
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY l.code, e.full_name
       LIMIT 1000`,
      params,
    );
  }

  /** Manager / HR view: weekly-off and half-day counters for every visible employee in a month. */
  static async teamSummary(user: AuthUser, year: number, month: number, locationId: number | null) {
    assertYearMonth(year, month);
    const employees = await WeeklyOffService.visibleEmployees(user, locationId);
    const start = isoDate(year, month, 1);
    const end = isoDate(year, month, daysInMonth(year, month));
    const allSundays = sundaysInMonth(year, month);
    const base = { year, month, monthName: MONTH_NAMES[month - 1], totalSundays: allSundays.length, sundays: allSundays };
    if (employees.length === 0) return { ...base, employees: [] };

    const ids = employees.map((employee) => Number(employee.id));
    const placeholders = ids.map(() => '?').join(',');
    const [requests, attendance, leaveDays, halfDays, credits, coLedger] = await Promise.all([
      query<{ employee_id: number; start_date: string; status: string }>(
        `SELECT employee_id, start_date, status FROM leave_requests
         WHERE employee_id IN (${placeholders}) AND request_kind = 'weekly_off'
           AND status IN ('pending_manager','pending_hr','approved') AND start_date BETWEEN ? AND ?`,
        [...ids, start, end],
      ),
      query<{ employee_id: number; work_date: string; status: string; check_in_at: string | null }>(
        `SELECT employee_id, work_date, status, check_in_at FROM attendance
         WHERE employee_id IN (${placeholders}) AND work_date BETWEEN ? AND ? AND (check_in_at IS NOT NULL OR status = 'weekly_off')`,
        [...ids, start, end],
      ),
      query<{ employee_id: number; total: number }>(
        `SELECT employee_id, COUNT(*) AS total FROM attendance
         WHERE employee_id IN (${placeholders}) AND work_date BETWEEN ? AND ? AND status = 'on_leave'
         GROUP BY employee_id`,
        [...ids, start, end],
      ),
      query<{ employee_id: number; total: number; deducted: number }>(
        `SELECT employee_id, COUNT(*) AS total, SUM(days) AS deducted FROM leave_requests
         WHERE employee_id IN (${placeholders}) AND is_half_day = 1 AND status = 'approved' AND start_date BETWEEN ? AND ?
         GROUP BY employee_id`,
        [...ids, start, end],
      ),
      query<{ employee_id: number; earned: number }>(
        `SELECT employee_id, SUM(days - expired_days) AS earned FROM comp_off_credits
         WHERE employee_id IN (${placeholders}) AND status IN ('earned','expired') GROUP BY employee_id`,
        ids,
      ),
      query<{ employee_id: number; manual: number; used: number }>(
        `SELECT b.employee_id, SUM(b.allocated) AS manual, SUM(b.used) AS used
         FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
         WHERE b.employee_id IN (${placeholders}) AND t.code = 'CO' GROUP BY b.employee_id`,
        ids,
      ),
    ]);
    const key = (id: number | string, date: string) => `${Number(id)}:${String(date).slice(0, 10)}`;
    const approvedSet = new Set(requests.filter((r) => r.status === 'approved').map((r) => key(r.employee_id, r.start_date)));
    const pendingSet = new Set(requests.filter((r) => r.status !== 'approved').map((r) => key(r.employee_id, r.start_date)));
    const workedSet = new Set(attendance.filter((r) => r.check_in_at).map((r) => key(r.employee_id, r.work_date)));
    const markedSet = new Set(attendance.filter((r) => !r.check_in_at && r.status === 'weekly_off').map((r) => key(r.employee_id, r.work_date)));
    const leaveMap = new Map(leaveDays.map((row) => [Number(row.employee_id), Number(row.total)]));
    const halfMap = new Map(halfDays.map((row) => [Number(row.employee_id), row]));
    const earnedMap = new Map(credits.map((row) => [Number(row.employee_id), Number(row.earned ?? 0)]));
    const ledgerMap = new Map(coLedger.map((row) => [Number(row.employee_id), row]));

    return {
      ...base,
      employees: employees.map((employee) => {
        const id = Number(employee.id);
        const weekday = normalizeWeekday(employee.weekly_off_day);
        const eligible = eligibleWeeklyOffDates(
          year,
          month,
          weekday,
          employee.joining_date ? String(employee.joining_date) : null,
          employee.deactivated_at ? String(employee.deactivated_at) : null,
        );
        let taken = 0;
        let pending = 0;
        let workedCount = 0;
        for (const date of eligible) {
          const k = key(id, date);
          if (approvedSet.has(k) || markedSet.has(k)) taken += 1;
          else if (pendingSet.has(k)) pending += 1;
          else if (workedSet.has(k)) workedCount += 1;
        }
        const ledger = ledgerMap.get(id);
        const allocatedCo = (earnedMap.get(id) ?? 0) + Number(ledger?.manual ?? 0);
        const half = halfMap.get(id);
        return {
          employeeId: id,
          name: employee.full_name,
          code: employee.employee_code,
          locationCode: employee.location_code,
          locationName: employee.location_name,
          departmentName: employee.department_name,
          weeklyOffDay: weekday,
          weeklyOffDayName: WEEKDAY_NAMES[weekday],
          allocated: eligible.length,
          taken,
          pending,
          worked: workedCount,
          remaining: Math.max(0, eligible.length - taken),
          halfDaysTaken: Number(half?.total ?? 0),
          halfDayDeducted: Number(half?.deducted ?? 0),
          leaveDaysThisMonth: leaveMap.get(id) ?? 0,
          compOffAvailable: Math.max(0, allocatedCo - Number(ledger?.used ?? 0)),
        };
      }),
    };
  }
}
