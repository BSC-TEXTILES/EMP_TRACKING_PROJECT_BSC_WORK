import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, transaction, txQuery } from '../db/index.js';
import { getSetting, recordAudit } from '../lib/audit.js';
import { today, toIso } from '../lib/dates.js';
import { MONTH_NAMES as MONTHS, WEEKDAY_NAMES, chargeableDays, isValidIsoDate, isWeeklyOff } from '../lib/calendar.js';
import { emitToEmployee } from '../realtime/io.js';
import { WeeklyOffService } from './WeeklyOffService.js';
import { ApiError } from '../lib/http.js';
import { assertEmployeeAccess, locationEmployeeClause, locationEmployeeIds, subtreeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { AttendanceService } from './AttendanceService.js';
import { AuthService, type AuthUser } from './AuthService.js';

export type HalfDaySlot = 'first_half' | 'second_half';
export type RequestKind = 'leave' | 'weekly_off' | 'half_day';

const SLOT_LABEL: Record<HalfDaySlot, string> = { first_half: 'First Half', second_half: 'Second Half' };
/** Default order in which a half day is charged (HR policy setting `leave_policy.half_day_order`). */
const DEFAULT_HALF_DAY_ORDER = 'CL,EL,SL';

function describeRequest(kind: string | null | undefined, startDate: string, endDate: string, slot?: string | null): string {
  const start = String(startDate).slice(0, 10);
  const end = String(endDate).slice(0, 10);
  if (kind === 'weekly_off') return `Weekly off on ${start}`;
  if (slot === 'first_half' || slot === 'second_half') return `Half-day leave (${SLOT_LABEL[slot]}) on ${start}`;
  return start === end ? `Leave on ${start}` : `Leave ${start} → ${end}`;
}

/** Runs SQL on a transaction connection, so balances are re-validated under the employee row lock. */
function runnerFor(conn: PoolConnection) {
  return <T>(sql: string, params: unknown[]) => txQuery<T>(conn, sql, params);
}

async function recordHistory(
  conn: PoolConnection | null,
  leaveRequestId: number,
  action: string,
  fromStatus: string | null,
  toStatus: string,
  actorId: number | null,
  note?: string | null,
): Promise<void> {
  const sql = 'INSERT INTO leave_request_history (leave_request_id, action, from_status, to_status, actor_id, note) VALUES (?, ?, ?, ?, ?, ?)';
  const params = [leaveRequestId, action, fromStatus, toStatus, actorId, note ? String(note).slice(0, 500) : null];
  if (conn) await conn.query(sql, params);
  else await execute(sql, params);
}

export class LeaveService {
  static async applicationContext(employeeId: number) {
    const employee = await queryOne<{ id: number; full_name: string; location_id: number | null; location_name: string | null; manager_id: number | null }>(
      `SELECT e.id, e.full_name, e.location_id, l.name location_name, e.manager_id
       FROM employees e LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`, [employeeId]);
    if (!employee) throw ApiError.notFound('Employee not found');

    // 1. Resolve manager (direct manager first, then location manager, then fallback to Super Admin)
    let manager: { id: number; name: string } | null = null;
    if (employee.manager_id) {
      const directMgr = await queryOne<{ id: number; full_name: string }>(
        `SELECT id, full_name FROM employees WHERE id = ? AND status = 'active'`,
        [employee.manager_id],
      );
      if (directMgr) {
        manager = { id: Number(directMgr.id), name: directMgr.full_name };
      }
    }
    if (!manager && employee.location_id) {
      const locMgr = await queryOne<{ id: number; full_name: string }>(
        `SELECT e.id, e.full_name FROM employees e
         JOIN roles r ON r.id = e.role_id
         WHERE e.status = 'active' AND e.id <> ?
         AND (e.location_id = ? OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.employee_id = e.id AND el.location_id = ?))
         AND (r.slug IN ('store_manager', 'department_manager', 'location_manager', 'manager') OR r.level >= 40)
         ORDER BY r.level DESC, e.full_name LIMIT 1`,
        [employeeId, employee.location_id, employee.location_id],
      );
      if (locMgr) {
        manager = { id: Number(locMgr.id), name: locMgr.full_name };
      }
    }
    // Approval routes must stay within the employee's assigned location.
    const hrApprovers = employee.location_id ? await query<{ id: number; name: string }>(
      `SELECT DISTINCT e.id, e.full_name AS name FROM employees e
       JOIN role_permissions rp ON rp.role_id = e.role_id
       JOIN permissions p ON p.id = rp.permission_id AND p.code = 'leave.approve.hr'
       WHERE e.status = 'active' AND e.id <> ? AND (
         e.location_id = ?
         OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.employee_id = e.id AND el.location_id = ?)
         OR EXISTS (SELECT 1 FROM location_hr_assignments lh WHERE lh.employee_id = e.id AND lh.location_id = ?)
       ) ORDER BY e.full_name`,
      [employeeId, employee.location_id, employee.location_id, employee.location_id],
    ) : [];
    const effectiveLocationId = employee.location_id;
    const effectiveLocationName = employee.location_name;

    const issues: string[] = [];
    if (!employee.location_id) issues.push('No location is assigned. Contact administration.');
    if (!manager) issues.push('No reporting manager could be assigned. Contact administration.');
    if (!hrApprovers.length) issues.push('No HR approver could be found. Contact administration.');

    return {
      employeeName: employee.full_name,
      locationId: effectiveLocationId,
      locationName: effectiveLocationName,
      manager,
      hrApprovers,
      canApply: issues.length === 0,
      issues,
    };
  }

  static async types() {
    return query<{ id: number; name: string; code: string; annual_quota: number; is_paid: number; requires_document: number }>(
      'SELECT id, name, code, annual_quota, is_paid, requires_document FROM leave_types WHERE is_active = 1 ORDER BY name',
    );
  }

  static async balances(employeeId: number, year = new Date().getFullYear()) {
    const types = await LeaveService.types();
    const rows = await query<{ leave_type_id: number; allocated: number; used: number }>(
      'SELECT leave_type_id, allocated, used FROM leave_balances WHERE employee_id = ? AND balance_year = ?',
      [employeeId, year],
    );
    const compOff = types.some((t) => t.code === 'CO') ? await WeeklyOffService.compOffTotals(employeeId) : null;
    return types.map((t) => {
      const row = rows.find((r) => Number(r.leave_type_id) === Number(t.id));
      // Comp-off is earned by working Sundays / holidays and does not reset on 1 January.
      const allocated = t.code === 'CO' && compOff ? compOff.allocated : row ? Number(row.allocated) : Number(t.annual_quota);
      const used = t.code === 'CO' && compOff ? compOff.used : row ? Number(row.used) : 0;
      return {
        leaveTypeId: Number(t.id),
        name: t.name,
        code: t.code,
        allocated,
        used,
        available: Math.max(0, allocated - used),
        requiresDocument: Boolean(t.requires_document),
        isPaid: Boolean(t.is_paid),
      };
    });
  }

  /**
   * Days charged for a leave range: Sundays (weekly offs) and public holidays that
   * apply to the employee's location are never deducted from CL / SL / EL / CO.
   * Maternity leave is statutory and counted in calendar days.
   */
  static async dayBreakdown(
    employeeId: number,
    startDate: string,
    endDate: string,
    leaveTypeCode?: string | null,
    isHalfDay = false,
  ) {
    if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) throw ApiError.badRequest('Enter valid leave dates.');
    if (endDate < startDate) throw ApiError.badRequest('End date cannot be before the start date.');
    if (isHalfDay && startDate !== endDate) throw ApiError.badRequest('Half-day leave must start and end on the same date.');
    const holidays = await WeeklyOffService.employeeHolidays(employeeId, startDate, endDate);
    const weekday = await WeeklyOffService.employeeWeekday(employeeId);
    const split = chargeableDays(startDate, endDate, holidays.keys(), weekday);
    const calendarCounted = leaveTypeCode === 'ML';
    let chargedDays = calendarCounted ? split.calendarDays : split.charged.length;
    if (isHalfDay) {
      chargedDays = split.charged.length > 0 ? 0.5 : 0;
    }
    return {
      startDate,
      endDate,
      calendarDays: isHalfDay ? 0.5 : split.calendarDays,
      chargedDays,
      weeklyOffDays: calendarCounted ? 0 : split.weeklyOffs.length,
      holidayDays: calendarCounted ? 0 : split.publicHolidays.length,
      weeklyOffDates: split.weeklyOffs,
      holidays: split.publicHolidays.map((date) => ({ date, name: holidays.get(date) ?? 'Holiday' })),
      calendarCounted,
      isHalfDay,
    };
  }

  static async apply(
    employeeId: number,
    input: {
      leaveTypeId: number;
      startDate: string;
      endDate: string;
      reason?: string | null;
      hrApproverId?: number;
      documentFileId?: number | null;
      isHalfDay?: boolean;
      halfDaySlot?: 'first_half' | 'second_half' | null;
    },
    context: { ip?: string; userAgent?: string },
  ) {
    const routing = await LeaveService.applicationContext(employeeId);
    if (!routing.canApply) throw ApiError.conflict(routing.issues.join(' '));
    const hr = routing.hrApprovers.find((entry) => entry.id === input.hrApproverId)
      ?? (input.hrApproverId === undefined && routing.hrApprovers.length === 1 ? routing.hrApprovers[0] : undefined);
    if (!hr) throw ApiError.badRequest('Select an HR approver assigned to your location.');
    if (![input.startDate, input.endDate].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)) {
      throw ApiError.badRequest('Enter valid leave dates.');
    }
    if (input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) throw ApiError.badRequest('Submit separate requests for each calendar year.');
    if (input.documentFileId) {
      const file = await queryOne<{ id: number }>("SELECT id FROM files WHERE id = ? AND owner_id = ? AND scan_status IN ('clean','validated')", [input.documentFileId, employeeId]);
      if (!file) throw ApiError.forbidden('Select a supporting document uploaded by you.');
    }
    if (input.endDate < input.startDate) throw ApiError.badRequest('End date cannot be before the start date.');
    if (input.startDate < today()) throw ApiError.badRequest('Leave cannot be requested for past dates.');
    const reason = (input.reason ?? '').trim();

    const isHalfDay = Boolean(input.isHalfDay);
    const halfDaySlot = isHalfDay ? (input.halfDaySlot ?? 'first_half') : null;
    if (isHalfDay) {
      if (input.startDate !== input.endDate) throw ApiError.badRequest('Half-day leave must start and end on the same date.');
      if (!['first_half', 'second_half'].includes(String(halfDaySlot))) {
        throw ApiError.badRequest('Select whether the half-day leave is for the First Half or Second Half.');
      }
    }

    const typeCode = await queryOne<{ code: string }>('SELECT code FROM leave_types WHERE id = ?', [input.leaveTypeId]);
    const breakdown = await LeaveService.dayBreakdown(employeeId, input.startDate, input.endDate, typeCode?.code, isHalfDay);
    if (typeCode?.code !== 'ML' && breakdown.calendarDays > 60) throw ApiError.badRequest('Leave requests cannot exceed 60 consecutive days.');
    const days = breakdown.chargedDays;
    if (days <= 0) {
      throw ApiError.badRequest('The selected dates are all weekly offs (Sundays) or public holidays, so no leave is needed.');
    }

    const overlap = await queryOne<{ id: number; is_half_day: number; half_day_slot: string | null }>(
      `SELECT id, is_half_day, half_day_slot FROM leave_requests WHERE employee_id = ? AND status IN ('pending_manager','pending_hr','approved')
       AND request_kind <> 'weekly_off' AND start_date <= ? AND end_date >= ?`,
      [employeeId, input.endDate, input.startDate],
    );
    if (overlap) {
      const canCoexist = isHalfDay && Boolean(overlap.is_half_day) && overlap.half_day_slot && halfDaySlot && overlap.half_day_slot !== halfDaySlot;
      if (!canCoexist) {
        throw ApiError.conflict('You already have a leave request overlapping these dates.');
      }
    }

    const type = await queryOne<{ id: number; annual_quota: number; requires_document: number; name: string; code: string; is_paid: number }>(
      'SELECT id, annual_quota, requires_document, name, code, is_paid FROM leave_types WHERE id = ? AND is_active = 1',
      [input.leaveTypeId],
    );
    if (!type) throw ApiError.badRequest('Select a valid leave type.');
    if (type.requires_document && !input.documentFileId) throw ApiError.badRequest('This leave type requires a supporting document.');

    const year = Number(input.startDate.slice(0, 4));
    const balance = await LeaveService.balances(employeeId, year);
    const selected = balance.find((b) => b.leaveTypeId === Number(input.leaveTypeId));

    // Special validation by leave type
    if (type.code === 'ML') {
      if (days > 182) throw ApiError.badRequest('Maternity leave cannot exceed 182 days (26 weeks).');
    } else if (type.code === 'PL') {
      if (days > 15) throw ApiError.badRequest('Paternity leave cannot exceed 15 days.');
    } else if (type.code === 'LWP' || !type.is_paid) {
      // Unpaid leave (Leave Without Pay) is uncapped upon approval
    } else if (selected && selected.allocated > 0 && days > selected.available) {
      throw ApiError.badRequest(`Insufficient ${selected.name} balance (${selected.available} day(s) available).`);
    }

    const employee = await queryOne<{ manager_id: number | null; full_name: string }>(
      'SELECT manager_id, full_name FROM employees WHERE id = ?',
      [employeeId],
    );

    const result = await transaction(async (conn) => {
      await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [employeeId]);
      const [overlaps] = await conn.query<any[]>(
        "SELECT id, is_half_day, half_day_slot FROM leave_requests WHERE employee_id = ? AND status IN ('pending_manager','pending_hr','approved') AND request_kind <> 'weekly_off' AND start_date <= ? AND end_date >= ?",
        [employeeId, input.endDate, input.startDate],
      );
      if (overlaps.length) {
        const canCoexist = isHalfDay && Boolean(overlaps[0].is_half_day) && overlaps[0].half_day_slot && halfDaySlot && overlaps[0].half_day_slot !== halfDaySlot;
        if (!canCoexist) throw ApiError.conflict('You already have a leave request overlapping these dates.');
      }
      const [created] = await conn.query<any>(
        `INSERT INTO leave_requests (employee_id, leave_type_id, request_kind, start_date, end_date, days, weekly_off_days, holiday_days, reason, document_file_id, status, manager_id, request_location_id, hr_approver_id, is_half_day, half_day_slot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_manager', ?, ?, ?, ?, ?)`,
        [employeeId, input.leaveTypeId, isHalfDay ? 'half_day' : 'leave', input.startDate, input.endDate, days, breakdown.weeklyOffDays, breakdown.holidayDays, reason, input.documentFileId ?? null, routing.manager!.id, routing.locationId, hr.id, isHalfDay ? 1 : 0, halfDaySlot],
      );
      await recordHistory(conn, created.insertId, 'submitted', null, 'pending_manager', employeeId);
      return created;
    });

    await recordAudit({
      actorId: employeeId,
      action: isHalfDay ? 'leave.applied_half_day' : 'leave.applied',
      entityType: 'leave_request',
      entityId: result.insertId,
      after: { ...input, days, isHalfDay, halfDaySlot, weeklyOffDays: breakdown.weeklyOffDays, holidayDays: breakdown.holidayDays },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const managerId = routing.manager?.id ?? (employee?.manager_id ? Number(employee.manager_id) : null);
    if (managerId) {
      await NotificationService.notify({
        employeeIds: [managerId],
        type: 'leave',
        title: 'Leave request awaiting approval',
        body: `${employee?.full_name ?? 'An employee'} requested ${days} day(s) of ${type.name} leave.`,
        link: '/leave?tab=team',
        priority: 'normal',
        actorId: employeeId,
      });
    }
    emitToEmployee(employeeId, 'leave:updated', { reason: 'applied', id: result.insertId });
    if (managerId) emitToEmployee(managerId, 'leave:updated', { reason: 'applied', id: result.insertId });
    return { id: result.insertId, days, weeklyOffDays: breakdown.weeklyOffDays, holidayDays: breakdown.holidayDays };
  }

  // ------------------------------------------------------------ weekly off & half day

  /** Approval route (manager + HR) shared by the weekly-off and half-day applications. */
  private static async resolveRoute(employeeId: number, hrApproverId?: number) {
    const routing = await LeaveService.applicationContext(employeeId);
    if (!routing.canApply) throw ApiError.conflict(routing.issues.join(' '));
    const hr = routing.hrApprovers.find((entry) => entry.id === hrApproverId)
      ?? (hrApproverId === undefined && routing.hrApprovers.length >= 1 ? routing.hrApprovers[0] : undefined);
    if (!hr) throw ApiError.badRequest('Select an HR approver assigned to your location.');
    return { routing, hr };
  }

  private static async notifySubmitted(employeeId: number, managerId: number, requestId: number, summary: string) {
    const employee = await queryOne<{ full_name: string }>('SELECT full_name FROM employees WHERE id = ?', [employeeId]);
    await NotificationService.notify({
      employeeIds: [managerId],
      type: 'leave',
      title: 'Request awaiting your approval',
      body: `${employee?.full_name ?? 'An employee'} requested: ${summary}.`,
      link: '/leave?tab=team',
      priority: 'normal',
      actorId: employeeId,
    });
    emitToEmployee(employeeId, 'leave:updated', { reason: 'applied', id: requestId });
    emitToEmployee(managerId, 'leave:updated', { reason: 'applied', id: requestId });
  }

  /**
   * Weekly-off application for one assigned weekly-off date. The date must be eligible
   * (assigned weekday, on/after joining), not taken, not reserved by a pending request,
   * not worked, and the month must still have available weekly-off balance. Everything is
   * re-validated under a row lock, and a UNIQUE key on active weekly-off dates is the final guard.
   */
  static async applyWeeklyOff(
    employeeId: number,
    input: { date: string; reason?: string | null; hrApproverId?: number },
    context: { ip?: string; userAgent?: string } = {},
  ) {
    if (!isValidIsoDate(input.date)) throw ApiError.badRequest('Select a valid weekly-off date.');
    const { routing, hr } = await LeaveService.resolveRoute(employeeId, input.hrApproverId);
    const year = Number(input.date.slice(0, 4));
    const month = Number(input.date.slice(5, 7));
    const reason = (input.reason ?? '').trim();

    const assertAvailable = (balance: Awaited<ReturnType<typeof WeeklyOffService.monthBalance>>) => {
      const entry = balance.dates.find((d) => d.date === input.date);
      if (!entry) throw ApiError.badRequest(`${input.date} is not your assigned weekly-off day (${balance.weekdayName}).`);
      switch (entry.status) {
        case 'not_eligible':
          throw ApiError.badRequest(`${input.date} is before your joining date (${balance.joiningDate}), so it is not an eligible weekly off.`);
        case 'taken':
          throw ApiError.conflict(`The weekly off on ${input.date} has already been taken.`);
        case 'pending':
          throw ApiError.conflict(`You already have a weekly-off request for ${input.date} awaiting approval.`);
        case 'worked':
          throw ApiError.conflict(`Attendance shows you worked on ${input.date}, so it cannot be taken as a weekly off.`);
        case 'lapsed':
          throw ApiError.badRequest(`${input.date} is in a closed month; weekly offs can only be applied for the current or a future month.`);
        default:
          break;
      }
      if (balance.available <= 0) {
        throw ApiError.conflict(`No weekly-off balance left for ${MONTHS[month - 1]} ${year} (${balance.allocated} allocated, ${balance.taken} taken, ${balance.pending} pending).`);
      }
    };

    // Fast pre-check (clear errors before opening a transaction).
    assertAvailable(await WeeklyOffService.monthBalance(employeeId, year, month));
    const typeRow = await queryOne<{ id: number }>("SELECT id FROM leave_types WHERE code = 'WO' LIMIT 1");
    if (!typeRow) throw ApiError.conflict('Weekly-off requests are not configured. Run the database migrations.');

    const created = await transaction(async (conn) => {
      await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [employeeId]);
      const balance = await WeeklyOffService.monthBalance(employeeId, year, month, runnerFor(conn));
      assertAvailable(balance);
      try {
        const [result] = await conn.query<any>(
          `INSERT INTO leave_requests (employee_id, leave_type_id, request_kind, start_date, end_date, days, weekly_off_days, holiday_days, reason, document_file_id, status, manager_id, request_location_id, hr_approver_id, is_half_day, half_day_slot)
           VALUES (?, ?, 'weekly_off', ?, ?, 1, 1, 0, ?, NULL, 'pending_manager', ?, ?, ?, 0, NULL)`,
          [employeeId, typeRow.id, input.date, input.date, reason, routing.manager!.id, routing.locationId, hr.id],
        );
        await recordHistory(conn, result.insertId, 'submitted', null, 'pending_manager', employeeId);
        return { id: Number(result.insertId), balance };
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw ApiError.conflict(`A weekly-off request for ${input.date} already exists.`);
        throw error;
      }
    });

    await recordAudit({
      actorId: employeeId,
      action: 'leave.applied_weekly_off',
      entityType: 'leave_request',
      entityId: created.id,
      after: { date: input.date, reason, hrApproverId: hr.id },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await WeeklyOffService.persistAllocation(employeeId, year, month);
    await LeaveService.notifySubmitted(employeeId, routing.manager!.id, created.id, `Weekly off on ${input.date}`);
    return {
      id: created.id,
      date: input.date,
      allocated: created.balance.allocated,
      taken: created.balance.taken,
      // After this request is approved, one more weekly off is taken.
      remainingAfterApproval: Math.max(0, created.balance.remaining - 1),
    };
  }

  /** Leave types eligible to absorb a half day, in policy order, with balances net of pending requests. */
  private static async halfDayBalances(employeeId: number, year: number) {
    const order = (await getSetting('leave_policy.half_day_order', DEFAULT_HALF_DAY_ORDER))
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean);
    const balances = await LeaveService.balances(employeeId, year);
    const pendingRows = await query<{ leave_type_id: number; days: number }>(
      `SELECT leave_type_id, SUM(days) AS days FROM leave_requests
       WHERE employee_id = ? AND status IN ('pending_manager','pending_hr') AND request_kind <> 'weekly_off' AND YEAR(start_date) = ?
       GROUP BY leave_type_id`,
      [employeeId, year],
    );
    const pending = new Map(pendingRows.map((row) => [Number(row.leave_type_id), Number(row.days)]));
    return order
      .map((code) => balances.find((b) => b.code === code))
      .filter((b): b is NonNullable<typeof b> => Boolean(b))
      .map((b) => ({ ...b, pending: pending.get(b.leaveTypeId) ?? 0, usable: Math.max(0, b.available - (pending.get(b.leaveTypeId) ?? 0)) }));
  }

  /**
   * Validates a half-day date / session against joining date, weekly off, holidays,
   * attendance and existing requests; returns the leave type that will be charged 0.5 day.
   */
  static async halfDayPreview(employeeId: number, date: string, slot: HalfDaySlot) {
    if (!isValidIsoDate(date)) throw ApiError.badRequest('Select a valid half-day date.');
    if (!['first_half', 'second_half'].includes(slot)) throw ApiError.badRequest('Select First Half or Second Half.');
    if (date < today()) throw ApiError.badRequest('Half-day leave cannot be requested for past dates.');
    const employee = await queryOne<{ joining_date: string | null; weekly_off_day: number | null }>(
      'SELECT joining_date, weekly_off_day FROM employees WHERE id = ?',
      [employeeId],
    );
    if (!employee) throw ApiError.notFound('Employee not found');
    const joining = employee.joining_date ? String(employee.joining_date).slice(0, 10) : null;
    if (joining && date < joining) throw ApiError.badRequest(`Half-day leave cannot be taken before your joining date (${joining}).`);
    const weekday = await WeeklyOffService.employeeWeekday(employeeId);
    if (isWeeklyOff(date, weekday)) throw ApiError.badRequest(`${date} is your weekly off (${WEEKDAY_NAMES[weekday]}), so no half-day leave is needed.`);
    const holidays = await WeeklyOffService.employeeHolidays(employeeId, date, date);
    if (holidays.has(date)) throw ApiError.badRequest(`${date} is a public holiday (${holidays.get(date)}), so no half-day leave is needed.`);

    await LeaveService.assertNoHalfDayConflict(employeeId, date, slot);

    const candidates = await LeaveService.halfDayBalances(employeeId, Number(date.slice(0, 4)));
    const chosen = candidates.find((b) => b.usable >= 0.5) ?? null;
    let lossOfPay = false;
    let deductFrom: { leaveTypeId: number; code: string; name: string; available: number; usable: number } | null = chosen
      ? { leaveTypeId: chosen.leaveTypeId, code: chosen.code, name: chosen.name, available: chosen.available, usable: chosen.usable }
      : null;
    if (!deductFrom) {
      const lwp = await queryOne<{ id: number; code: string; name: string }>("SELECT id, code, name FROM leave_types WHERE code = 'LWP' AND is_active = 1 LIMIT 1");
      if (!lwp) throw ApiError.conflict('You have no leave balance left for a half day.');
      lossOfPay = true;
      deductFrom = { leaveTypeId: Number(lwp.id), code: lwp.code, name: lwp.name, available: 0, usable: 0 };
    }
    return {
      date,
      slot,
      slotLabel: SLOT_LABEL[slot],
      days: 0.5,
      deductFrom,
      lossOfPay,
      remainingAfterApproval: lossOfPay ? 0 : Math.max(0, deductFrom.usable - 0.5),
      balances: candidates.map((b) => ({ leaveTypeId: b.leaveTypeId, code: b.code, name: b.name, available: b.available, pending: b.pending, usable: b.usable })),
    };
  }

  /** Blocks a duplicate half day (same session), an overlapping full day, weekly off or recorded leave. */
  private static async assertNoHalfDayConflict(employeeId: number, date: string, slot: HalfDaySlot, conn?: PoolConnection) {
    const run = conn ? runnerFor(conn) : <T>(sql: string, params: unknown[]) => query<T>(sql, params);
    const overlaps = await run<{ id: number; request_kind: string; is_half_day: number; half_day_slot: string | null }>(
      `SELECT id, request_kind, is_half_day, half_day_slot FROM leave_requests
       WHERE employee_id = ? AND status IN ('pending_manager','pending_hr','approved') AND start_date <= ? AND end_date >= ?`,
      [employeeId, date, date],
    );
    for (const row of overlaps) {
      if (row.request_kind === 'weekly_off') throw ApiError.conflict(`${date} is booked as a weekly off.`);
      if (!Number(row.is_half_day)) throw ApiError.conflict(`You already have a full-day leave request covering ${date}.`);
      if (row.half_day_slot === slot) throw ApiError.conflict(`You already have a ${SLOT_LABEL[slot]} half-day request on ${date}.`);
    }
    const [attendance] = await run<{ status: string; notes: string | null }>('SELECT status, notes FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, date]);
    if (attendance?.status === 'on_leave') throw ApiError.conflict(`Attendance already shows you on leave on ${date}.`);
  }

  /** Half-day leave: one date, First or Second Half, always 0.5 day, never touches the weekly-off balance. */
  static async applyHalfDay(
    employeeId: number,
    input: { date: string; slot: HalfDaySlot; reason?: string | null; hrApproverId?: number; documentFileId?: number | null },
    context: { ip?: string; userAgent?: string } = {},
  ) {
    const { routing, hr } = await LeaveService.resolveRoute(employeeId, input.hrApproverId);
    let preview = await LeaveService.halfDayPreview(employeeId, input.date, input.slot);
    if (input.documentFileId) {
      const file = await queryOne<{ id: number }>("SELECT id FROM files WHERE id = ? AND owner_id = ? AND scan_status IN ('clean','validated')", [input.documentFileId, employeeId]);
      if (!file) throw ApiError.forbidden('Select a supporting document uploaded by you.');
    }
    const reason = (input.reason ?? '').trim();

    const id = await transaction(async (conn) => {
      await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [employeeId]);
      // Re-read pending reservations after acquiring the employee lock. A preview
      // made before waiting for another application may no longer have balance.
      preview = await LeaveService.halfDayPreview(employeeId, input.date, input.slot);
      await LeaveService.assertNoHalfDayConflict(employeeId, input.date, input.slot, conn);
      const [result] = await conn.query<any>(
        `INSERT INTO leave_requests (employee_id, leave_type_id, request_kind, start_date, end_date, days, weekly_off_days, holiday_days, reason, document_file_id, status, manager_id, request_location_id, hr_approver_id, is_half_day, half_day_slot)
         VALUES (?, ?, 'half_day', ?, ?, 0.5, 0, 0, ?, ?, 'pending_manager', ?, ?, ?, 1, ?)`,
        [employeeId, preview.deductFrom.leaveTypeId, input.date, input.date, reason, input.documentFileId ?? null, routing.manager!.id, routing.locationId, hr.id, input.slot],
      );
      await recordHistory(conn, result.insertId, 'submitted', null, 'pending_manager', employeeId);
      return Number(result.insertId);
    });

    await recordAudit({
      actorId: employeeId,
      action: 'leave.applied_half_day',
      entityType: 'leave_request',
      entityId: id,
      after: { date: input.date, slot: input.slot, days: 0.5, leaveType: preview.deductFrom.code, lossOfPay: preview.lossOfPay, reason },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await LeaveService.notifySubmitted(employeeId, routing.manager!.id, id, `Half-day leave (${SLOT_LABEL[input.slot]}) on ${input.date}`);
    return { id, date: input.date, slot: input.slot, days: 0.5, leaveType: preview.deductFrom.code, lossOfPay: preview.lossOfPay };
  }

  static async list(
    user: AuthUser,
    filters: { status?: string; scope?: 'mine' | 'team' | 'all'; employeeId?: number; page?: number; pageSize?: number },
  ) {
    const clauses: string[] = ['1 = 1'];
    const params: unknown[] = [];
    const wantsAll = filters.scope === 'all' && user.permissions.includes('leave.view.all');
    const wantsTeam = filters.scope === 'team' && (user.permissions.includes('leave.view.team') || user.permissions.includes('leave.view.all'));

    if (filters.employeeId) {
      await assertEmployeeAccess(user, filters.employeeId, 'leave');
      clauses.push('l.employee_id = ?');
      params.push(filters.employeeId);
    } else if (wantsAll) {
      const location = await locationEmployeeClause(user, 'l.employee_id');
      clauses.push(location.clause);
      params.push(...location.params);
    } else if (wantsTeam) {
      const ids = await subtreeIds(user.id);
      if (ids.length === 0) return { items: [], total: 0 };
      clauses.push(`(l.employee_id IN (${ids.map(() => '?').join(',')}) OR l.manager_id = ? OR l.hr_approver_id = ?)`);
      params.push(...ids, user.id, user.id);
    } else {
      clauses.push('l.employee_id = ?');
      params.push(user.id);
    }
    if (wantsAll || wantsTeam) {
      const location = await locationEmployeeClause(user, 'l.employee_id');
      clauses.push(location.clause); params.push(...location.params);
    }
    if (filters.status) {
      clauses.push('l.status = ?');
      params.push(filters.status);
    }
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 30));
    const where = clauses.join(' AND ');

    const rows = await query<{
      id: number;
      employee_id: number;
      full_name: string;
      employee_code: string;
      department_name: string | null;
      type_name: string;
      start_date: string;
      end_date: string;
      days: number;
      weekly_off_days: number | null;
      holiday_days: number | null;
      reason: string;
      status: string;
      decision_note: string | null;
      manager_action_at: string | null;
      hr_action_at: string | null;
      created_at: string;
      location_name: string | null;
      manager_name: string | null;
      hr_name: string | null;
      hr_approver_id: number | null;
      document_file_id: number | null;
      created_by_me: number;
      is_my_report: number;
      is_half_day?: number;
      half_day_slot?: string | null;
      request_kind?: string | null;
      type_code: string;
    }>(
      `SELECT l.*, e.full_name, e.employee_code, d.name AS department_name, lt.name AS type_name, lt.code AS type_code,
              (l.employee_id = ?) AS created_by_me,
              (l.manager_id = ?) AS is_my_report, loc.name location_name, mgr.full_name manager_name, hr.full_name hr_name
       FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       JOIN leave_types lt ON lt.id = l.leave_type_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN locations loc ON loc.id = COALESCE(l.request_location_id, e.location_id)
       LEFT JOIN employees mgr ON mgr.id = l.manager_id
       LEFT JOIN employees hr ON hr.id = l.hr_approver_id
       WHERE ${where}
       ORDER BY FIELD(l.status, 'pending_manager','pending_hr','approved','rejected','cancelled'), l.start_date DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      [user.id, user.id, ...params],
    );
    const ids = rows.map((r) => Number(r.id));
    const historyRows = ids.length
      ? await query<{ leave_request_id: number; action: string; from_status: string | null; to_status: string; note: string | null; created_at: string; actor_name: string | null }>(
          `SELECT h.leave_request_id, h.action, h.from_status, h.to_status, h.note, h.created_at, a.full_name AS actor_name
           FROM leave_request_history h LEFT JOIN employees a ON a.id = h.actor_id
           WHERE h.leave_request_id IN (${ids.map(() => '?').join(',')}) ORDER BY h.created_at, h.id`,
          ids,
        )
      : [];
    const historyBy = new Map<number, { action: string; fromStatus: string | null; toStatus: string; note: string | null; at: string | null; actorName: string | null }[]>();
    for (const h of historyRows) {
      const list = historyBy.get(Number(h.leave_request_id)) ?? [];
      list.push({ action: h.action, fromStatus: h.from_status, toStatus: h.to_status, note: h.note, at: toIso(h.created_at), actorName: h.actor_name });
      historyBy.set(Number(h.leave_request_id), list);
    }
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        employeeId: Number(r.employee_id),
        employeeName: r.full_name,
        employeeCode: r.employee_code,
        departmentName: r.department_name,
        requestKind: (r.request_kind === 'weekly_off' || r.request_kind === 'half_day' ? r.request_kind : r.is_half_day ? 'half_day' : 'leave') as RequestKind,
        leaveTypeCode: r.type_code,
        history: historyBy.get(Number(r.id)) ?? [],
        leaveType: r.type_name,
        documentFileId: r.document_file_id ? Number(r.document_file_id) : null,
        locationName: r.location_name, managerName: r.manager_name, hrName: r.hr_name,
        startDate: r.start_date,
        endDate: r.end_date,
        days: Number(r.days),
        isHalfDay: Boolean(r.is_half_day),
        halfDaySlot: (r.half_day_slot as 'first_half' | 'second_half' | null) ?? null,
        weeklyOffDays: r.weekly_off_days === null || r.weekly_off_days === undefined ? null : Number(r.weekly_off_days),
        holidayDays: r.holiday_days === null || r.holiday_days === undefined ? null : Number(r.holiday_days),
        reason: r.reason,
        status: r.status,
        decisionNote: r.decision_note,
        managerActionAt: toIso(r.manager_action_at),
        hrActionAt: toIso(r.hr_action_at),
        createdAt: toIso(r.created_at),
        canApproveManager: r.status === 'pending_manager' && Number(r.is_my_report) === 1 && user.permissions.includes('leave.approve.manager') && Number(r.employee_id) !== user.id,
        canApproveHr: r.status === 'pending_hr' && user.permissions.includes('leave.approve.hr') && Number(r.employee_id) !== user.id && (r.hr_approver_id === null || Number(r.hr_approver_id) === user.id),
        canCancel: Number(r.created_by_me) === 1 && ['pending_manager', 'pending_hr'].includes(r.status),
      })),
      total: rows.length,
    };
  }

  static async decide(
    leaveId: number,
    actor: AuthUser,
    input: { approve: boolean; note?: string; stage: 'manager' | 'hr' },
    context: { ip?: string; userAgent?: string },
  ) {
    const leave = await queryOne<{
      id: number;
      employee_id: number;
      leave_type_id: number;
      start_date: string;
      end_date: string;
      days: number;
      status: string;
      manager_id: number | null;
      hr_approver_id: number | null;
      request_location_id: number | null;
      is_half_day?: number;
      half_day_slot?: string | null;
      request_kind?: string | null;
      full_name: string;
    }>(
      `SELECT l.*, e.full_name FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = ?`,
      [leaveId],
    );
    if (!leave) throw ApiError.notFound('Leave request not found');

    if (Number(leave.employee_id) === actor.id) throw ApiError.forbidden('You cannot approve your own leave.');
    const routing = await LeaveService.applicationContext(Number(leave.employee_id));
    const isSuperOrOrgWide = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90 || actor.permissions.includes('locations.manage');
    const assignedLocations = await query<{ location_id: number }>('SELECT location_id FROM employee_locations WHERE employee_id = ? UNION SELECT location_id FROM location_hr_assignments WHERE employee_id = ?', [actor.id, actor.id]);
    const requestLocation = Number(leave.request_location_id ?? routing.locationId);
    if (!isSuperOrOrgWide && requestLocation > 0 && Number(actor.locationId) !== requestLocation && !assignedLocations.some((l) => Number(l.location_id) === requestLocation)) {
      throw ApiError.forbidden('You can only approve leave for your assigned locations.');
    }
    if (input.stage === 'manager') {
      if (leave.status !== 'pending_manager') throw ApiError.conflict('This request is not awaiting manager approval.');
      const isManager = Number(leave.manager_id) === actor.id || isSuperOrOrgWide || leave.manager_id === null;
      if (!isManager || (!actor.permissions.includes('leave.approve.manager') && !isSuperOrOrgWide)) {
        throw ApiError.forbidden('You are not the reporting manager for this employee.');
      }
      if (input.approve) {
        const updated = await execute(
          "UPDATE leave_requests SET status = 'pending_hr', manager_action_at = NOW(3), manager_id = COALESCE(manager_id, ?), decision_note = ? WHERE id = ? AND status = 'pending_manager'",
          [actor.id, input.note ?? null, leaveId],
        );
        if (!updated.affectedRows) throw ApiError.conflict('This request was already processed.');
        await recordHistory(null, leaveId, 'manager_approved', 'pending_manager', 'pending_hr', actor.id, input.note);
      } else {
        if (!input.note) throw ApiError.badRequest('Provide a rejection reason.');
        const updated = await execute(
          "UPDATE leave_requests SET status = 'rejected', manager_action_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'pending_manager'",
          [input.note, leaveId],
        );
        if (!updated.affectedRows) throw ApiError.conflict('This request was already processed.');
        await recordHistory(null, leaveId, 'manager_rejected', 'pending_manager', 'rejected', actor.id, input.note);
      }
    } else {
      if (leave.hr_approver_id && Number(leave.hr_approver_id) !== actor.id) throw ApiError.forbidden('This request is assigned to another HR approver.');
      if (!actor.permissions.includes('leave.approve.hr')) throw ApiError.forbidden('You cannot approve at HR stage.');
      if (leave.status !== 'pending_hr') throw ApiError.conflict('This request is not awaiting HR approval.');
      if (input.approve && leave.request_kind === 'weekly_off') {
        const date = String(leave.start_date).slice(0, 10);
        const year = Number(date.slice(0, 4));
        const month = Number(date.slice(5, 7));
        await transaction(async (conn) => {
          await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [leave.employee_id]);
          // Re-validate on the server: the date must still be an eligible weekly off and the
          // month must still have an untaken weekly off (this request is counted as pending).
          const balance = await WeeklyOffService.monthBalance(Number(leave.employee_id), year, month, runnerFor(conn));
          const entry = balance.dates.find((d) => d.date === date);
          if (!entry || entry.status === 'not_eligible') throw ApiError.conflict(`${date} is no longer an eligible weekly off for this employee.`);
          if (entry.status === 'worked') throw ApiError.conflict(`Attendance shows the employee worked on ${date}.`);
          if (balance.taken >= balance.allocated) throw ApiError.conflict('The employee has no weekly offs remaining this month.');
          const [updated] = await conn.query<any>("UPDATE leave_requests SET status = 'approved', hr_action_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'pending_hr'", [
            input.note ?? null,
            leaveId,
          ]);
          if (!updated.affectedRows) throw ApiError.conflict('This request was already processed.');
          await conn.query(
            `INSERT INTO attendance (employee_id, work_date, status, notes) VALUES (?, ?, 'weekly_off', 'Approved weekly off')
             ON DUPLICATE KEY UPDATE status = IF(check_in_at IS NULL, 'weekly_off', status), notes = IF(check_in_at IS NULL, VALUES(notes), notes)`,
            [leave.employee_id, date],
          );
          await recordHistory(conn, leaveId, 'hr_approved', 'pending_hr', 'approved', actor.id, input.note);
        });
        await WeeklyOffService.persistAllocation(Number(leave.employee_id), year, month);
      } else if (input.approve) {
        await transaction(async (conn) => {
          await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [leave.employee_id]);
          const [updated] = await conn.query<any>("UPDATE leave_requests SET status = 'approved', hr_action_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'pending_hr'", [
            input.note ?? null,
            leaveId,
          ]);
          if (!updated.affectedRows) throw ApiError.conflict('This request was already processed.');
          await recordHistory(conn, leaveId, 'hr_approved', 'pending_hr', 'approved', actor.id, input.note);
          const year = Number(String(leave.start_date).slice(0, 4));
          const [typeRows] = await conn.query<any[]>('SELECT is_paid, code FROM leave_types WHERE id = ?', [leave.leave_type_id]);
          const isPaid = Boolean(typeRows?.[0]?.is_paid);
          const isLwp = typeRows?.[0]?.code === 'LWP';

          if (isPaid && !isLwp && typeRows?.[0]?.code === 'CO') {
            // Comp-off: availability comes from earned credits (running balance), not an annual quota.
            const compOff = await WeeklyOffService.compOffTotals(Number(leave.employee_id));
            if (compOff.available < Number(leave.days)) throw ApiError.conflict(`The employee has only ${compOff.available} comp-off day(s) available.`);
            await conn.query(
              `INSERT INTO leave_balances (employee_id, leave_type_id, balance_year, allocated, used)
               VALUES (?, ?, ?, 0, ?)
               ON DUPLICATE KEY UPDATE used = used + VALUES(used)`,
              [leave.employee_id, leave.leave_type_id, year, leave.days],
            );
          } else if (isPaid && !isLwp) {
            const [balanceRows] = await conn.query<any[]>(
              `SELECT COALESCE(b.allocated, t.annual_quota) allocated, COALESCE(b.used, 0) used
               FROM leave_types t LEFT JOIN leave_balances b ON b.leave_type_id = t.id AND b.employee_id = ? AND b.balance_year = ? WHERE t.id = ?`,
              [leave.employee_id, year, leave.leave_type_id]);
            if (balanceRows.length && Number(balanceRows[0].allocated) > 0 && Number(balanceRows[0].allocated) - Number(balanceRows[0].used) < Number(leave.days)) {
              throw ApiError.conflict('The employee no longer has sufficient leave balance.');
            }
            await conn.query(
              `INSERT INTO leave_balances (employee_id, leave_type_id, balance_year, allocated, used)
               VALUES (?, ?, ?, (SELECT annual_quota FROM leave_types WHERE id = ?), ?)
               ON DUPLICATE KEY UPDATE used = used + VALUES(used)`,
              [leave.employee_id, leave.leave_type_id, year, leave.leave_type_id, leave.days],
            );
          }
        });
        await AttendanceService.markLeaveRange(Number(leave.employee_id), String(leave.start_date), String(leave.end_date), {
          isHalfDay: Boolean(leave.is_half_day),
          halfDaySlot: leave.half_day_slot,
        });
      } else {
        if (!input.note) throw ApiError.badRequest('Provide a rejection reason.');
        const updated = await execute("UPDATE leave_requests SET status = 'rejected', hr_action_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'pending_hr'", [
          input.note,
          leaveId,
        ]);
        if (!updated.affectedRows) throw ApiError.conflict('This request was already processed.');
        await recordHistory(null, leaveId, 'hr_rejected', 'pending_hr', 'rejected', actor.id, input.note);
      }
    }
    if (leave.request_kind === 'weekly_off' && !input.approve) {
      const date = String(leave.start_date).slice(0, 10);
      await WeeklyOffService.persistAllocation(Number(leave.employee_id), Number(date.slice(0, 4)), Number(date.slice(5, 7)));
    }

    await recordAudit({
      actorId: actor.id,
      action: `leave.${input.stage}_${input.approve ? 'approved' : 'rejected'}`,
      entityType: 'leave_request',
      entityId: leaveId,
      before: { status: leave.status },
      after: { status: input.approve ? (input.stage === 'manager' ? 'pending_hr' : 'approved') : 'rejected', note: input.note },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const summary = describeRequest(leave.request_kind, leave.start_date, leave.end_date, leave.is_half_day ? leave.half_day_slot : null);
    emitToEmployee(Number(leave.employee_id), 'leave:updated', { reason: 'decided', id: leaveId });
    await NotificationService.notify({
      employeeIds: [Number(leave.employee_id)],
      type: 'leave',
      title: input.approve ? (input.stage === 'manager' ? 'Approved by manager · pending HR approval' : 'Request approved') : 'Request rejected',
      body: `${summary} was ${input.approve ? (input.stage === 'manager' ? 'approved by your manager and sent to HR' : 'approved by HR') : `rejected${input.note ? `: ${input.note}` : ''}`}.`,
      link: '/leave',
      priority: 'high',
      actorId: actor.id,
    });

    if (input.approve && input.stage === 'manager') {
      const hrUsers = leave.hr_approver_id ? [{ id: Number(leave.hr_approver_id) }] : routing.hrApprovers;
      if (hrUsers.length > 0) {
        await NotificationService.notify({
          employeeIds: hrUsers.map((h) => Number(h.id)),
          type: 'leave',
          title: 'Request awaiting HR approval',
          body: `${leave.full_name}: ${summary} (approved by manager).`,
          link: '/leave?tab=all',
          actorId: actor.id,
        });
        for (const h of hrUsers) emitToEmployee(Number(h.id), 'leave:updated', { reason: 'decided', id: leaveId });
      }
    }
  }

  static async cancel(leaveId: number, employeeId: number): Promise<void> {
    const leave = await queryOne<{ employee_id: number; status: string; start_date: string; request_kind: string | null; manager_id: number | null }>(
      'SELECT employee_id, status, start_date, request_kind, manager_id FROM leave_requests WHERE id = ?',
      [leaveId],
    );
    if (!leave) throw ApiError.notFound('Leave request not found');
    if (Number(leave.employee_id) !== employeeId) throw ApiError.forbidden('You can only cancel your own leave requests.');
    if (!['pending_manager', 'pending_hr'].includes(leave.status)) throw ApiError.badRequest('Only pending requests can be cancelled.');
    const updated = await execute("UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND status IN ('pending_manager','pending_hr')", [leaveId]);
    if (!updated.affectedRows) throw ApiError.conflict('This request was already processed.');
    await recordHistory(null, leaveId, 'cancelled', leave.status, 'cancelled', employeeId);
    await recordAudit({ actorId: employeeId, action: 'leave.cancelled', entityType: 'leave_request', entityId: leaveId, before: { status: leave.status } });
    if (leave.request_kind === 'weekly_off') {
      const date = String(leave.start_date).slice(0, 10);
      await WeeklyOffService.persistAllocation(employeeId, Number(date.slice(0, 4)), Number(date.slice(5, 7)));
    }
    emitToEmployee(employeeId, 'leave:updated', { reason: 'cancelled', id: leaveId });
    if (leave.manager_id) emitToEmployee(Number(leave.manager_id), 'leave:updated', { reason: 'cancelled', id: leaveId });
  }

  /** Holidays for the viewer's location plus organisation-wide ones (location_id NULL). */
  static async holidays(from: string, to: string, employeeId?: number) {
    if (!employeeId) {
      return query<{ id: number; name: string; holiday_date: string; holiday_type: string }>(
        'SELECT id, name, holiday_date, holiday_type FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date',
        [from, to],
      );
    }
    return query<{ id: number; name: string; holiday_date: string; holiday_type: string }>(
      `SELECT id, name, holiday_date, holiday_type FROM holidays
       WHERE holiday_date BETWEEN ? AND ?
         AND (location_id IS NULL OR location_id = (SELECT location_id FROM employees WHERE id = ?))
       ORDER BY holiday_date`,
      [from, to, employeeId],
    );
  }

  static async balancesForAdmin(employeeId: number, year: number) {
    return LeaveService.balances(employeeId, year);
  }

  static async setBalance(employeeId: number, leaveTypeId: number, year: number, allocated: number, actor: AuthUser) {
    if (!actor.permissions.includes('leave.manage')) throw ApiError.forbidden('You cannot modify leave balances.');
    await execute(
      `INSERT INTO leave_balances (employee_id, leave_type_id, balance_year, allocated) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE allocated = VALUES(allocated)`,
      [employeeId, leaveTypeId, year, allocated],
    );
    emitToEmployee(employeeId, 'leave:updated', { reason: 'balance' });
    await recordAudit({
      actorId: actor.id,
      action: 'leave.balance_updated',
      entityType: 'leave_balance',
      entityId: employeeId,
      after: { leaveTypeId, year, allocated },
    });
  }
}
