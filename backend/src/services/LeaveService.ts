import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { today, toIso } from '../lib/dates.js';
import { chargeableDays, isValidIsoDate } from '../lib/calendar.js';
import { emitToEmployee } from '../realtime/io.js';
import { WeeklyOffService } from './WeeklyOffService.js';
import { ApiError } from '../lib/http.js';
import { assertEmployeeAccess, locationEmployeeClause, locationEmployeeIds, subtreeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { AttendanceService } from './AttendanceService.js';
import { AuthService, type AuthUser } from './AuthService.js';

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
    if (!manager) {
      const defaultAdmin = await queryOne<{ id: number; full_name: string }>(
        `SELECT e.id, e.full_name FROM employees e
         JOIN roles r ON r.id = e.role_id
         WHERE e.status = 'active' AND e.id <> ? AND (r.slug IN ('super_admin', 'admin') OR r.level >= 90)
         ORDER BY e.id ASC LIMIT 1`,
        [employeeId],
      );
      if (defaultAdmin) {
        manager = { id: Number(defaultAdmin.id), name: defaultAdmin.full_name };
      }
    }

    // 2. Resolve HR approvers (location-assigned HR first, then global HR / Admin)
    const hrApprovers: { id: number; name: string }[] = [];
    if (employee.location_id) {
      const assignedHr = await query<{ id: number; full_name: string }>(
        `SELECT e.id, e.full_name FROM location_hr_assignments lh JOIN employees e ON e.id = lh.employee_id
         WHERE lh.location_id = ? AND e.status = 'active' AND e.id <> ? ORDER BY e.full_name`,
        [employee.location_id, employeeId],
      ).catch(() => []);
      for (const hr of assignedHr) {
        hrApprovers.push({ id: Number(hr.id), name: hr.full_name });
      }
    }
    if (hrApprovers.length === 0) {
      const globalHrs = await query<{ id: number; full_name: string }>(
        `SELECT e.id, e.full_name FROM employees e
         JOIN roles r ON r.id = e.role_id
         WHERE e.status = 'active' AND e.id <> ? AND (r.slug IN ('hr', 'hr_manager', 'super_admin', 'admin') OR r.level >= 60)
         ORDER BY r.level DESC, e.full_name LIMIT 5`,
        [employeeId],
      );
      for (const hr of globalHrs) {
        hrApprovers.push({ id: Number(hr.id), name: hr.full_name });
      }
    }

    // Default location fallback
    const effectiveLocationId = employee.location_id ?? 1;
    const effectiveLocationName = employee.location_name ?? 'Head Office (HUB-HQ)';

    const issues: string[] = [];
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
    const split = chargeableDays(startDate, endDate, holidays.keys());
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
      reason: string;
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
    if (!input.reason?.trim()) throw ApiError.badRequest('Provide a reason for the leave.');

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
       AND start_date <= ? AND end_date >= ?`,
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
        "SELECT id, is_half_day, half_day_slot FROM leave_requests WHERE employee_id = ? AND status IN ('pending_manager','pending_hr','approved') AND start_date <= ? AND end_date >= ?",
        [employeeId, input.endDate, input.startDate],
      );
      if (overlaps.length) {
        const canCoexist = isHalfDay && Boolean(overlaps[0].is_half_day) && overlaps[0].half_day_slot && halfDaySlot && overlaps[0].half_day_slot !== halfDaySlot;
        if (!canCoexist) throw ApiError.conflict('You already have a leave request overlapping these dates.');
      }
      const [created] = await conn.query<any>(
        `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, weekly_off_days, holiday_days, reason, document_file_id, status, manager_id, request_location_id, hr_approver_id, is_half_day, half_day_slot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_manager', ?, ?, ?, ?, ?)`,
        [employeeId, input.leaveTypeId, input.startDate, input.endDate, days, breakdown.weeklyOffDays, breakdown.holidayDays, input.reason.trim(), input.documentFileId ?? null, routing.manager!.id, routing.locationId, hr.id, isHalfDay ? 1 : 0, halfDaySlot],
      );
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

    if (employee?.manager_id) {
      await NotificationService.notify({
        employeeIds: [Number(employee.manager_id)],
        type: 'leave',
        title: 'Leave request awaiting approval',
        body: `${employee.full_name} requested ${days} day(s) of ${type.name} leave.`,
        link: '/leave?tab=team',
        priority: 'normal',
        actorId: employeeId,
      });
    }
    emitToEmployee(employeeId, 'leave:updated', { reason: 'applied', id: result.insertId });
    return { id: result.insertId, days, weeklyOffDays: breakdown.weeklyOffDays, holidayDays: breakdown.holidayDays };
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
    }>(
      `SELECT l.*, e.full_name, e.employee_code, d.name AS department_name, lt.name AS type_name,
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
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        employeeId: Number(r.employee_id),
        employeeName: r.full_name,
        employeeCode: r.employee_code,
        departmentName: r.department_name,
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
      full_name: string;
    }>(
      `SELECT l.*, e.full_name FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = ?`,
      [leaveId],
    );
    if (!leave) throw ApiError.notFound('Leave request not found');

    if (Number(leave.employee_id) === actor.id) throw ApiError.forbidden('You cannot approve your own leave.');
    const routing = await LeaveService.applicationContext(Number(leave.employee_id));
    const isSuperOrOrgWide = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90 || actor.permissions.includes('locations.manage');
    const assignedLocations = await query<{ location_id: number }>('SELECT location_id FROM employee_locations WHERE employee_id = ?', [actor.id]);
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
        await execute(
          "UPDATE leave_requests SET status = 'pending_hr', manager_action_at = NOW(3), manager_id = COALESCE(manager_id, ?), decision_note = ? WHERE id = ? AND status = 'pending_manager'",
          [actor.id, input.note ?? null, leaveId],
        );
      } else {
        if (!input.note) throw ApiError.badRequest('Provide a rejection reason.');
        await execute(
          "UPDATE leave_requests SET status = 'rejected', manager_action_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'pending_manager'",
          [input.note, leaveId],
        );
      }
    } else {
      if (leave.hr_approver_id && Number(leave.hr_approver_id) !== actor.id) throw ApiError.forbidden('This request is assigned to another HR approver.');
      if (!actor.permissions.includes('leave.approve.hr')) throw ApiError.forbidden('You cannot approve at HR stage.');
      if (leave.status !== 'pending_hr') throw ApiError.conflict('This request is not awaiting HR approval.');
      if (input.approve) {
        await transaction(async (conn) => {
          await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [leave.employee_id]);
          const [updated] = await conn.query<any>("UPDATE leave_requests SET status = 'approved', hr_action_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'pending_hr'", [
            input.note ?? null,
            leaveId,
          ]);
          if (!updated.affectedRows) throw ApiError.conflict('This request was already processed.');
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
        await execute("UPDATE leave_requests SET status = 'rejected', hr_action_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'pending_hr'", [
          input.note,
          leaveId,
        ]);
      }
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

    emitToEmployee(Number(leave.employee_id), 'leave:updated', { reason: 'decided', id: leaveId });
    await NotificationService.notify({
      employeeIds: [Number(leave.employee_id)],
      type: 'leave',
      title: input.approve ? 'Leave request approved' : 'Leave request rejected',
      body: `${leave.full_name}: ${leave.start_date} → ${leave.end_date} was ${input.approve ? (input.stage === 'manager' ? 'approved by your manager and sent to HR' : 'approved by HR') : `rejected${input.note ? `: ${input.note}` : ''}`}.`,
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
          title: 'Leave request awaiting HR approval',
          body: `${leave.full_name}: ${leave.start_date} → ${leave.end_date}.`,
          link: '/leave?tab=all',
          actorId: actor.id,
        });
      }
    }
  }

  static async cancel(leaveId: number, employeeId: number): Promise<void> {
    const leave = await queryOne<{ employee_id: number; status: string; start_date: string }>('SELECT employee_id, status, start_date FROM leave_requests WHERE id = ?', [
      leaveId,
    ]);
    if (!leave) throw ApiError.notFound('Leave request not found');
    if (Number(leave.employee_id) !== employeeId) throw ApiError.forbidden('You can only cancel your own leave requests.');
    if (!['pending_manager', 'pending_hr'].includes(leave.status)) throw ApiError.badRequest('Only pending requests can be cancelled.');
    await execute("UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND status IN ('pending_manager','pending_hr')", [leaveId]);
    await recordAudit({ actorId: employeeId, action: 'leave.cancelled', entityType: 'leave_request', entityId: leaveId });
    emitToEmployee(employeeId, 'leave:updated', { reason: 'cancelled', id: leaveId });
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
