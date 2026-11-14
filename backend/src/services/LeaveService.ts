import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { daysBetween, today, toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { subtreeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { AttendanceService } from './AttendanceService.js';
import type { AuthUser } from './AuthService.js';

export class LeaveService {
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
    return types.map((t) => {
      const row = rows.find((r) => Number(r.leave_type_id) === Number(t.id));
      const allocated = row ? Number(row.allocated) : Number(t.annual_quota);
      const used = row ? Number(row.used) : 0;
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

  static async apply(
    employeeId: number,
    input: { leaveTypeId: number; startDate: string; endDate: string; reason: string; documentFileId?: number | null },
    context: { ip?: string; userAgent?: string },
  ) {
    if (input.endDate < input.startDate) throw ApiError.badRequest('End date cannot be before the start date.');
    if (input.startDate < today()) throw ApiError.badRequest('Leave cannot be requested for past dates.');
    if (!input.reason?.trim()) throw ApiError.badRequest('Provide a reason for the leave.');
    const days = daysBetween(input.startDate, input.endDate) + 1;
    if (days > 60) throw ApiError.badRequest('Leave requests cannot exceed 60 consecutive days.');

    const overlap = await queryOne<{ id: number }>(
      `SELECT id FROM leave_requests WHERE employee_id = ? AND status IN ('pending_manager','pending_hr','approved')
       AND start_date <= ? AND end_date >= ?`,
      [employeeId, input.endDate, input.startDate],
    );
    if (overlap) throw ApiError.conflict('You already have a leave request overlapping these dates.');

    const type = await queryOne<{ id: number; annual_quota: number; requires_document: number; name: string }>(
      'SELECT id, annual_quota, requires_document, name FROM leave_types WHERE id = ? AND is_active = 1',
      [input.leaveTypeId],
    );
    if (!type) throw ApiError.badRequest('Select a valid leave type.');
    if (type.requires_document && !input.documentFileId) throw ApiError.badRequest('This leave type requires a supporting document.');

    const year = Number(input.startDate.slice(0, 4));
    const balance = await LeaveService.balances(employeeId, year);
    const selected = balance.find((b) => b.leaveTypeId === Number(input.leaveTypeId));
    if (selected && days > selected.available) {
      throw ApiError.badRequest(`Insufficient ${selected.name} balance (${selected.available} day(s) available).`);
    }

    const employee = await queryOne<{ manager_id: number | null; full_name: string }>(
      'SELECT manager_id, full_name FROM employees WHERE id = ?',
      [employeeId],
    );

    const result = await execute(
      `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, document_file_id, status, manager_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_manager', ?)`,
      [employeeId, input.leaveTypeId, input.startDate, input.endDate, days, input.reason.trim(), input.documentFileId ?? null, employee?.manager_id ?? null],
    );

    await recordAudit({
      actorId: employeeId,
      action: 'leave.applied',
      entityType: 'leave_request',
      entityId: result.insertId,
      after: { ...input, days },
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
    return { id: result.insertId, days };
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
      clauses.push('l.employee_id = ?');
      params.push(filters.employeeId);
    } else if (wantsAll) {
      // all leave requests, no extra filter
    } else if (wantsTeam) {
      const ids = await subtreeIds(user.id);
      if (ids.length === 0) return { items: [], total: 0 };
      clauses.push(`l.employee_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    } else {
      clauses.push('l.employee_id = ?');
      params.push(user.id);
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
      reason: string;
      status: string;
      decision_note: string | null;
      manager_action_at: string | null;
      hr_action_at: string | null;
      created_at: string;
      created_by_me: number;
      is_my_report: number;
    }>(
      `SELECT l.*, e.full_name, e.employee_code, d.name AS department_name, lt.name AS type_name,
              (l.employee_id = ?) AS created_by_me,
              (e.manager_id = ?) AS is_my_report
       FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       JOIN leave_types lt ON lt.id = l.leave_type_id
       LEFT JOIN departments d ON d.id = e.department_id
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
        startDate: r.start_date,
        endDate: r.end_date,
        days: Number(r.days),
        reason: r.reason,
        status: r.status,
        decisionNote: r.decision_note,
        managerActionAt: toIso(r.manager_action_at),
        hrActionAt: toIso(r.hr_action_at),
        createdAt: toIso(r.created_at),
        canApproveManager: r.status === 'pending_manager' && Number(r.is_my_report) === 1,
        canApproveHr: r.status === 'pending_hr' && user.permissions.includes('leave.approve.hr'),
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
      full_name: string;
    }>(
      `SELECT l.*, e.full_name FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = ?`,
      [leaveId],
    );
    if (!leave) throw ApiError.notFound('Leave request not found');

    if (input.stage === 'manager') {
      if (leave.status !== 'pending_manager') throw ApiError.conflict('This request is not awaiting manager approval.');
      const isManager = Number(leave.manager_id) === actor.id;
      if (!isManager && !actor.permissions.includes('leave.approve.hr')) {
        throw ApiError.forbidden('You are not the reporting manager for this employee.');
      }
      if (input.approve) {
        await execute(
          "UPDATE leave_requests SET status = 'pending_hr', manager_action_at = NOW(3), manager_id = COALESCE(manager_id, ?), decision_note = ? WHERE id = ?",
          [actor.id, input.note ?? null, leaveId],
        );
      } else {
        if (!input.note) throw ApiError.badRequest('Provide a rejection reason.');
        await execute(
          "UPDATE leave_requests SET status = 'rejected', manager_action_at = NOW(3), decision_note = ? WHERE id = ?",
          [input.note, leaveId],
        );
      }
    } else {
      if (!actor.permissions.includes('leave.approve.hr')) throw ApiError.forbidden('You cannot approve at HR stage.');
      if (leave.status !== 'pending_hr') throw ApiError.conflict('This request is not awaiting HR approval.');
      if (input.approve) {
        await transaction(async (conn) => {
          await conn.query("UPDATE leave_requests SET status = 'approved', hr_action_at = NOW(3), decision_note = ? WHERE id = ?", [
            input.note ?? null,
            leaveId,
          ]);
          const year = Number(String(leave.start_date).slice(0, 4));
          await conn.query(
            `INSERT INTO leave_balances (employee_id, leave_type_id, balance_year, allocated, used)
             VALUES (?, ?, ?, (SELECT annual_quota FROM leave_types WHERE id = ?), ?)
             ON DUPLICATE KEY UPDATE used = used + VALUES(used)`,
            [leave.employee_id, leave.leave_type_id, year, leave.leave_type_id, leave.days],
          );
        });
        await AttendanceService.markLeaveRange(Number(leave.employee_id), String(leave.start_date), String(leave.end_date));
      } else {
        if (!input.note) throw ApiError.badRequest('Provide a rejection reason.');
        await execute("UPDATE leave_requests SET status = 'rejected', hr_action_at = NOW(3), decision_note = ? WHERE id = ?", [
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
      const hrUsers = await query<{ id: number }>(
        `SELECT DISTINCT e.id FROM employees e
         JOIN role_permissions rp ON rp.role_id = e.role_id
         JOIN permissions p ON p.id = rp.permission_id AND p.code = 'leave.approve.hr'
         WHERE e.status = 'active'`,
      );
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
    await execute("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?", [leaveId]);
    await recordAudit({ actorId: employeeId, action: 'leave.cancelled', entityType: 'leave_request', entityId: leaveId });
  }

  static async holidays(from: string, to: string) {
    return query<{ id: number; name: string; holiday_date: string; holiday_type: string }>(
      'SELECT id, name, holiday_date, holiday_type FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date',
      [from, to],
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
    await recordAudit({
      actorId: actor.id,
      action: 'leave.balance_updated',
      entityType: 'leave_balance',
      entityId: employeeId,
      after: { leaveTypeId, year, allocated },
    });
  }
}
