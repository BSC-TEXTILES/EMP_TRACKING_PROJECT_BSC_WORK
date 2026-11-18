import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { hashPassword, passwordIssues } from '../lib/crypto.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { locationEmployeeClause, locationEmployeeIds, subtreeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { ChatService } from './ChatService.js';
import type { AuthUser } from './AuthService.js';

export interface EmployeeListFilters {
  search?: string;
  departmentId?: number;
  designationId?: number;
  locationId?: number;
  managerId?: number;
  status?: string;
  roleId?: number;
  page?: number;
  pageSize?: number;
}

interface EmployeeListRow {
  id: number;
  employee_code: string;
  full_name: string;
  email: string;
  mobile: string;
  photo_url: string | null;
  status: string;
  employment_type: string;
  joining_date: string | null;
  department_id: number | null;
  department_name: string | null;
  designation_title: string | null;
  role_name: string;
  role_slug: string;
  manager_id: number | null;
  manager_name: string | null;
  location_name: string | null;
  created_at: string;
  attendance_status: string | null;
  check_in_at: string | null;
  open_tasks: number;
}

async function employeeScope(user: AuthUser): Promise<{ clause: string; params: unknown[] }> {
  if (user.permissions.includes('employees.view.all')) return locationEmployeeClause(user, 'e.id');
  if (user.permissions.includes('employees.view.team')) {
    const ids = await subtreeIds(user.id);
    if (ids.length === 0) return { clause: '1 = 0', params: [] };
    return { clause: `e.id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  return { clause: 'e.id = ?', params: [user.id] };
}

const SUPER_ADMIN_LEVEL = 100;

/**
 * Role hierarchy guard: you may only manage people whose role ranks strictly
 * below your own (Super Admin may manage anyone except themselves).
 */
async function assertCanManageEmployee(actor: AuthUser, employeeId: number, verb: string) {
  if (employeeId === actor.id) throw ApiError.badRequest(`You cannot ${verb} your own account.`);
  const target = await queryOne<{ level: number; name: string }>(
    'SELECT r.level, r.name FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?',
    [employeeId],
  );
  if (!target) throw ApiError.notFound('Employee not found');
  if (actor.roleLevel < SUPER_ADMIN_LEVEL && Number(target.level) >= actor.roleLevel) {
    throw ApiError.forbidden(`You cannot ${verb} a ${target.name}: their role is the same as or above yours.`);
  }
}

/** You can only hand out roles at or below your own level, so nobody can escalate privileges. */
async function assertCanAssignRole(actor: AuthUser, roleId: number | null | undefined) {
  if (!roleId) return;
  const role = await queryOne<{ level: number; name: string }>('SELECT level, name FROM roles WHERE id = ?', [roleId]);
  if (!role) throw ApiError.badRequest('That role does not exist.');
  if (actor.roleLevel < SUPER_ADMIN_LEVEL && Number(role.level) > actor.roleLevel) {
    throw ApiError.forbidden(`You cannot assign the ${role.name} role: it ranks above your own.`);
  }
}

export class EmployeeService {
  static async list(user: AuthUser, filters: EmployeeListFilters) {
    const scope = await employeeScope(user);
    const clauses = [
      scope.clause,
      "e.status NOT IN ('rejected','deleted')",
    ];
    const params: unknown[] = [...scope.params];

    if (filters.search) {
      clauses.push('(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR e.mobile LIKE ?)');
      const term = `%${filters.search}%`;
      params.push(term, term, term, term);
    }
    if (filters.departmentId) {
      clauses.push('e.department_id = ?');
      params.push(filters.departmentId);
    }
    if (filters.designationId) {
      clauses.push('e.designation_id = ?');
      params.push(filters.designationId);
    }
    if (filters.locationId) {
      clauses.push('e.location_id = ?');
      params.push(filters.locationId);
    }
    if (filters.managerId) {
      clauses.push('e.manager_id = ?');
      params.push(filters.managerId);
    }
    if (filters.status) {
      clauses.push('e.status = ?');
      params.push(filters.status);
    }
    if (filters.roleId) {
      clauses.push('e.role_id = ?');
      params.push(filters.roleId);
    }

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(5, filters.pageSize ?? 25));
    const where = clauses.join(' AND ');

    const rows = await query<EmployeeListRow>(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.mobile, e.photo_url, e.status, e.employment_type, e.joining_date,
              e.department_id, e.manager_id, e.created_at,
              d.name AS department_name, dg.title AS designation_title, r.name AS role_name, r.slug AS role_slug,
              m.full_name AS manager_name, l.name AS location_name,
              a.status AS attendance_status, a.check_in_at,
              (SELECT COUNT(*) FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
                WHERE ta.employee_id = e.id AND t.status IN ('assigned','accepted','in_progress','on_hold','pending_approval')) AS open_tasks
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
       WHERE ${where}
       ORDER BY FIELD(e.status, 'pending_verification','pending_approval','active','inactive'), e.full_name
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const total = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM employees e WHERE ${where}`, params);

    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        employeeCode: r.employee_code,
        fullName: r.full_name,
        email: r.email,
        mobile: r.mobile,
        photoUrl: r.photo_url,
        status: r.status,
        employmentType: r.employment_type,
        joiningDate: r.joining_date,
        departmentId: r.department_id ? Number(r.department_id) : null,
        departmentName: r.department_name,
        designationTitle: r.designation_title,
        roleName: r.role_name,
        roleSlug: r.role_slug,
        managerId: r.manager_id ? Number(r.manager_id) : null,
        managerName: r.manager_name,
        locationName: r.location_name,
        attendanceStatus: r.attendance_status,
        checkInAt: toIso(r.check_in_at),
        openTasks: Number(r.open_tasks),
      })),
      total: Number(total?.total ?? 0),
      page,
      pageSize,
    };
  }

  static async detail(employeeId: number, user: AuthUser) {
    const scope = await employeeScope(user);
    const row = await queryOne<{
      id: number;
      employee_code: string;
      full_name: string;
      email: string;
      mobile: string;
      photo_url: string | null;
      status: string;
      employment_type: string;
      joining_date: string | null;
      date_of_birth: string | null;
      address: string | null;
      emergency_contact: string | null;
      department_id: number | null;
      designation_id: number | null;
      manager_id: number | null;
      location_id: number | null;
      role_id: number;
      mfa_enabled: number;
      last_login_at: string | null;
      created_at: string;
      department_name: string | null;
      designation_title: string | null;
      role_name: string;
      role_slug: string;
      manager_name: string | null;
      location_name: string | null;
      email_verified_at: string | null;
      mobile_verified_at: string | null;
    }>(
      `SELECT e.*, d.name AS department_name, dg.title AS designation_title, r.name AS role_name, r.slug AS role_slug,
              m.full_name AS manager_name, l.name AS location_name
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.id = ? AND ${scope.clause}`,
      [employeeId, ...scope.params],
    );
    if (!row) throw ApiError.notFound('Employee not found or outside your access scope');

    const [taskStats, attendanceStats, ticketStats, kpi, reports] = await Promise.all([
      queryOne<{ total: number; completed: number; active: number; overdue: number }>(
        `SELECT COUNT(*) AS total, SUM(t.status = 'completed') AS completed,
                SUM(t.status IN ('assigned','accepted','in_progress','on_hold','pending_approval')) AS active,
                SUM(t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')) AS overdue
         FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id WHERE ta.employee_id = ?`,
        [employeeId],
      ),
      queryOne<{ present: number; late: number; minutes: number }>(
        `SELECT SUM(status IN ('present','late','half_day')) AS present, SUM(is_late) AS late, COALESCE(SUM(total_minutes),0) AS minutes
         FROM attendance WHERE employee_id = ? AND work_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
        [employeeId],
      ),
      queryOne<{ total: number; open: number; resolved: number }>(
        `SELECT COUNT(*) AS total, SUM(status NOT IN ('resolved','closed','cancelled')) AS open,
                SUM(status IN ('resolved','closed')) AS resolved
         FROM tickets WHERE requester_id = ? OR assignee_id = ?`,
        [employeeId, employeeId],
      ),
      queryOne<{ period: string; total_score: number; category: string; status: string }>(
        `SELECT period, total_score, category, status FROM employee_kpi_records WHERE employee_id = ? ORDER BY period DESC LIMIT 1`,
        [employeeId],
      ),
      queryOne<{ submitted: number; approved: number }>(
        `SELECT COUNT(*) AS submitted, SUM(status = 'approved') AS approved
         FROM daily_work_reports WHERE employee_id = ? AND report_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
        [employeeId],
      ),
    ]);

    return {
      id: Number(row.id),
      employeeCode: row.employee_code,
      fullName: row.full_name,
      email: row.email,
      mobile: row.mobile,
      photoUrl: row.photo_url,
      status: row.status,
      employmentType: row.employment_type,
      joiningDate: row.joining_date,
      dateOfBirth: row.date_of_birth,
      address: row.address,
      emergencyContact: row.emergency_contact,
      departmentId: row.department_id ? Number(row.department_id) : null,
      departmentName: row.department_name,
      designationId: row.designation_id ? Number(row.designation_id) : null,
      designationTitle: row.designation_title,
      managerId: row.manager_id ? Number(row.manager_id) : null,
      managerName: row.manager_name,
      locationId: row.location_id ? Number(row.location_id) : null,
      locationName: row.location_name,
      roleId: Number(row.role_id),
      roleName: row.role_name,
      roleSlug: row.role_slug,
      mfaEnabled: Boolean(row.mfa_enabled),
      lastLoginAt: toIso(row.last_login_at),
      createdAt: toIso(row.created_at),
      emailVerifiedAt: toIso(row.email_verified_at),
      mobileVerifiedAt: toIso(row.mobile_verified_at),
      stats: {
        tasks: {
          total: Number(taskStats?.total ?? 0),
          completed: Number(taskStats?.completed ?? 0),
          active: Number(taskStats?.active ?? 0),
          overdue: Number(taskStats?.overdue ?? 0),
        },
        attendance: {
          presentDays: Number(attendanceStats?.present ?? 0),
          lateDays: Number(attendanceStats?.late ?? 0),
          totalMinutes: Number(attendanceStats?.minutes ?? 0),
        },
        tickets: {
          total: Number(ticketStats?.total ?? 0),
          open: Number(ticketStats?.open ?? 0),
          resolved: Number(ticketStats?.resolved ?? 0),
        },
        reports: {
          submitted: Number(reports?.submitted ?? 0),
          approved: Number(reports?.approved ?? 0),
        },
        kpi: kpi
          ? { period: kpi.period, score: Number(kpi.total_score), category: kpi.category, status: kpi.status }
          : null,
      },
    };
  }

  static async update(
    employeeId: number,
    actor: AuthUser,
    input: {
      fullName?: string;
      mobile?: string;
      address?: string;
      emergencyContact?: string;
      dateOfBirth?: string;
      photoUrl?: string;
    },
  ) {
    const target = await queryOne<Record<string, unknown>>('SELECT * FROM employees WHERE id = ?', [employeeId]);
    if (!target) throw ApiError.notFound('Employee not found');
    const isSelf = Number(target.id) === actor.id;
    if (!isSelf && !actor.permissions.includes('employees.manage')) {
      throw ApiError.forbidden('You cannot edit this employee record.');
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    if (input.fullName) {
      fields.push('full_name = ?');
      params.push(input.fullName.trim());
    }
    if (input.mobile) {
      const duplicate = await queryOne<{ id: number }>('SELECT id FROM employees WHERE mobile = ? AND id <> ?', [input.mobile, employeeId]);
      if (duplicate) throw ApiError.conflict('That mobile number is already registered.');
      fields.push('mobile = ?');
      params.push(input.mobile.trim());
    }
    if (input.address !== undefined) {
      fields.push('address = ?');
      params.push(input.address);
    }
    if (input.emergencyContact !== undefined) {
      fields.push('emergency_contact = ?');
      params.push(input.emergencyContact);
    }
    if (input.dateOfBirth !== undefined) {
      fields.push('date_of_birth = ?');
      params.push(input.dateOfBirth || null);
    }
    if (input.photoUrl !== undefined) {
      fields.push('photo_url = ?');
      params.push(input.photoUrl);
    }
    if (fields.length === 0) throw ApiError.badRequest('Nothing to update.');
    await execute(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, [...params, employeeId]);
    await recordAudit({
      actorId: actor.id,
      action: isSelf ? 'employee.profile_updated' : 'employee.updated',
      entityType: 'employee',
      entityId: employeeId,
      after: input,
    });
  }

  /** Sensitive organisational changes always require employee management rights. */
  static async updateOrgAssignment(
    employeeId: number,
    actor: AuthUser,
    input: { roleId?: number; departmentId?: number | null; designationId?: number | null; managerId?: number | null; locationId?: number | null; employmentType?: string },
  ) {
    if (!actor.permissions.includes('employees.manage')) throw ApiError.forbidden('You cannot change organisational assignments.');
    const target = await queryOne<Record<string, unknown>>('SELECT * FROM employees WHERE id = ?', [employeeId]);
    if (!target) throw ApiError.notFound('Employee not found');
    await assertCanManageEmployee(actor, employeeId, 'change the role or reporting line of');
    await assertCanAssignRole(actor, input.roleId);
    if (input.managerId === employeeId) throw ApiError.badRequest('An employee cannot report to themselves.');
    if (input.managerId) {
      const descendants = await subtreeIds(employeeId);
      if (descendants.includes(input.managerId)) {
        throw ApiError.badRequest('That manager is inside this employee\'s own reporting line.');
      }
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['role_id', input.roleId],
      ['department_id', input.departmentId],
      ['designation_id', input.designationId],
      ['manager_id', input.managerId],
      ['location_id', input.locationId],
      ['employment_type', input.employmentType],
    ] as const) {
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (fields.length === 0) throw ApiError.badRequest('Nothing to update.');
    await execute(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, [...params, employeeId]);
    await recordAudit({
      actorId: actor.id,
      action: 'employee.org_assignment_updated',
      entityType: 'employee',
      entityId: employeeId,
      before: { role_id: target.role_id, department_id: target.department_id, manager_id: target.manager_id },
      after: input,
    });
  }

  static async approveRegistration(
    employeeId: number,
    actor: AuthUser,
    input: { roleId?: number; departmentId?: number; designationId?: number; managerId?: number; locationId?: number },
  ) {
    if (!actor.permissions.includes('employees.approve') && !actor.permissions.includes('employees.manage')) {
      throw ApiError.forbidden('You cannot approve registrations.');
    }
    await assertCanAssignRole(actor, input.roleId);
    const employee = await queryOne<{
      id: number;
      full_name: string;
      status: string;
      email: string;
      mobile: string;
      department_id: number | null;
    }>('SELECT id, full_name, status, email, mobile, department_id FROM employees WHERE id = ?', [employeeId]);
    if (!employee) throw ApiError.notFound('Employee not found');
    if (!['pending_approval', 'pending_verification'].includes(employee.status)) {
      throw ApiError.badRequest('This registration is not awaiting approval.');
    }

    await execute(
      `UPDATE employees SET status = 'active',
              email_verified_at = COALESCE(email_verified_at, NOW(3)),
              mobile_verified_at = COALESCE(mobile_verified_at, NOW(3)),
              role_id = COALESCE(?, role_id), department_id = COALESCE(?, department_id),
              designation_id = COALESCE(?, designation_id), manager_id = COALESCE(?, manager_id), location_id = COALESCE(?, location_id),
              joining_date = COALESCE(joining_date, CURDATE())
       WHERE id = ?`,
      [
        input.roleId ?? null,
        input.departmentId ?? null,
        input.designationId ?? null,
        input.managerId ?? null,
        input.locationId ?? null,
        employeeId,
      ],
    );

    await recordAudit({
      actorId: actor.id,
      action: 'employee.registration_approved',
      entityType: 'employee',
      entityId: employeeId,
      before: { status: employee.status },
      after: { status: 'active', ...input },
    });

    await ChatService.emptyOrEnsureGeneral(employeeId, input.departmentId ?? employee.department_id);
    await NotificationService.notify({
      employeeIds: [employeeId],
      type: 'account',
      title: 'Account approved',
      body: 'Your account is active. You can now sign in and start tracking your work.',
      link: '/',
      priority: 'high',
      actorId: actor.id,
    });
  }

  static async rejectRegistration(employeeId: number, actor: AuthUser, reason: string) {
    if (!actor.permissions.includes('employees.approve') && !actor.permissions.includes('employees.manage')) {
      throw ApiError.forbidden('You cannot reject registrations.');
    }
    if (!reason.trim()) throw ApiError.badRequest('Provide a reason for rejecting this registration.');
    await execute("UPDATE employees SET status = 'rejected', deactivated_at = NOW(3) WHERE id = ? AND status IN ('pending_approval','pending_verification')", [
      employeeId,
    ]);
    await recordAudit({
      actorId: actor.id,
      action: 'employee.registration_rejected',
      entityType: 'employee',
      entityId: employeeId,
      after: { reason },
    });
  }

  static async createByAdmin(
    actor: AuthUser,
    input: {
      fullName: string;
      email: string;
      mobile: string;
      employeeCode?: string;
      roleId: number;
      departmentId: number;
      designationId?: number | null;
      managerId?: number | null;
      locationId?: number | null;
      employmentType?: string;
      password: string;
    },
  ) {
    if (!actor.permissions.includes('employees.manage')) throw ApiError.forbidden('You cannot create employees.');
    await assertCanAssignRole(actor, input.roleId);
    const issues = passwordIssues(input.password);
    if (issues.length > 0) throw ApiError.badRequest(`Password must contain ${issues.join(', ')}.`);
    const duplicate = await queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ? OR mobile = ?', [input.email.toLowerCase(), input.mobile]);
    if (duplicate) throw ApiError.conflict('An employee already exists with this email or mobile.');

    let code = input.employeeCode?.trim();
    if (!code) {
      const seq = await queryOne<{ setting_value: string }>("SELECT setting_value FROM system_settings WHERE setting_key = 'employee_code_seq'");
      const next = Number(seq?.setting_value ?? 0) + 1;
      await execute(
        "INSERT INTO system_settings (setting_key, setting_value) VALUES ('employee_code_seq', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
        [String(next)],
      );
      code = `EMP-${1000 + next}`;
    }

    const result = await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, designation_id, manager_id,
        location_id, employment_type, status, joining_date, email_verified_at, mobile_verified_at, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURDATE(), NOW(3), NOW(3), 1)`,
      [
        code,
        input.fullName.trim(),
        input.email.toLowerCase(),
        input.mobile,
        await hashPassword(input.password),
        input.roleId,
        input.departmentId,
        input.designationId ?? null,
        input.managerId ?? null,
        input.locationId ?? null,
        input.employmentType ?? 'full_time',
      ],
    );
    await ChatService.emptyOrEnsureGeneral(result.insertId, input.departmentId);
    await recordAudit({
      actorId: actor.id,
      action: 'employee.created',
      entityType: 'employee',
      entityId: result.insertId,
      after: { employeeCode: code, email: input.email, roleId: input.roleId },
    });
    return { id: result.insertId, employeeCode: code };
  }

  static async setStatus(employeeId: number, actor: AuthUser, status: 'active' | 'inactive', reason?: string) {
    if (!actor.permissions.includes('employees.manage')) throw ApiError.forbidden('You cannot change employee status.');
    if (employeeId === actor.id) throw ApiError.badRequest('You cannot deactivate your own account.');
    const target = await queryOne<{ status: string; full_name: string }>('SELECT status, full_name FROM employees WHERE id = ?', [employeeId]);
    if (!target) throw ApiError.notFound('Employee not found');
    if (target.status === 'deleted') throw ApiError.badRequest('This account has been deleted and cannot be reactivated.');
    await assertCanManageEmployee(actor, employeeId, status === 'active' ? 'reactivate' : 'deactivate');
    await execute('UPDATE employees SET status = ?, deactivated_at = ? WHERE id = ?', [
      status,
      status === 'inactive' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      employeeId,
    ]);
    if (status === 'inactive') {
      await execute('UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE employee_id = ? AND revoked_at IS NULL', [
        'account_deactivated',
        employeeId,
      ]);
    }
    await recordAudit({
      actorId: actor.id,
      action: status === 'active' ? 'employee.reactivated' : 'employee.deactivated',
      entityType: 'employee',
      entityId: employeeId,
      before: { status: target.status },
      after: { status, reason },
    });
  }

  /**
   * Deletes an employee account. Attendance, tasks, reports and audit history are
   * kept for payroll and compliance, so the row is retired rather than erased:
   * sign-in is blocked, every session ends, the email and mobile are released so
   * they can be registered again, and direct reports move up to the next manager.
   */
  static async remove(employeeId: number, actor: AuthUser, reason?: string) {
    if (!actor.permissions.includes('employees.delete') && !actor.permissions.includes('employees.manage') && actor.roleLevel < 100) {
      throw ApiError.forbidden('You cannot delete employees.');
    }
    const target = await queryOne<{ id: number; full_name: string; employee_code: string; email: string; mobile: string; status: string; manager_id: number | null; role_slug: string }>(
      `SELECT e.id, e.full_name, e.employee_code, e.email, e.mobile, e.status, e.manager_id, r.slug AS role_slug
         FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`,
      [employeeId],
    );
    if (!target) throw ApiError.notFound('Employee not found');
    if (target.status === 'deleted') throw ApiError.badRequest('This employee has already been deleted.');
    await assertCanManageEmployee(actor, employeeId, 'delete');
    if (target.role_slug === 'super_admin') {
      const others = await queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM employees e JOIN roles r ON r.id = e.role_id WHERE r.slug = 'super_admin' AND e.status = 'active' AND e.id <> ?",
        [employeeId],
      );
      if (Number(others?.n ?? 0) === 0) throw ApiError.badRequest('You cannot delete the last Super Admin.');
    }

    await transaction(async (conn) => {
      await conn.execute('UPDATE employees SET manager_id = ? WHERE manager_id = ?', [target.manager_id, employeeId]);
      await conn.execute('UPDATE departments SET head_employee_id = NULL WHERE head_employee_id = ?', [employeeId]);
      await conn.execute(
        `UPDATE employees
            SET status = 'deleted', deactivated_at = NOW(3), manager_id = NULL,
                email = ?, mobile = ?
          WHERE id = ?`,
        [`deleted.${employeeId}.${Date.now()}@removed.invalid`, `DEL${employeeId}`.slice(0, 20), employeeId],
      );
      await conn.execute(
        "UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = 'account_deleted' WHERE employee_id = ? AND revoked_at IS NULL",
        [employeeId],
      );
      await conn.execute('DELETE FROM user_permissions WHERE employee_id = ?', [employeeId]);
    });

    await recordAudit({
      actorId: actor.id,
      action: 'employee.deleted',
      entityType: 'employee',
      entityId: employeeId,
      before: { status: target.status, email: target.email, mobile: target.mobile, employeeCode: target.employee_code, name: target.full_name },
      after: { status: 'deleted', reason: reason ?? null },
    });
    return { name: target.full_name };
  }

  static async hierarchy() {
    const rows = await query<{
      id: number;
      full_name: string;
      employee_code: string;
      manager_id: number | null;
      designation_title: string | null;
      department_name: string | null;
      photo_url: string | null;
      role_slug: string;
      status: string;
    }>(
      `SELECT e.id, e.full_name, e.employee_code, e.manager_id, dg.title AS designation_title, d.name AS department_name,
              e.photo_url, r.slug AS role_slug, e.status
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status IN ('active','pending_approval')
       ORDER BY r.level DESC, e.full_name`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.full_name,
      employeeCode: r.employee_code,
      managerId: r.manager_id ? Number(r.manager_id) : null,
      designation: r.designation_title,
      department: r.department_name,
      photoUrl: r.photo_url,
      roleSlug: r.role_slug,
      status: r.status,
    }));
  }

  static async picker(employeeId: number) {
    // Used for assignee/participant pickers: all active employees are visible organisation-wide
    // by design (names + designations only), never confidential records.
    return query<{
      id: number;
      full_name: string;
      employee_code: string;
      designation_title: string | null;
      department_name: string | null;
      manager_id: number | null;
    }>(
      `SELECT e.id, e.full_name, e.employee_code, dg.title AS designation_title, d.name AS department_name, e.manager_id
       FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active'
       ORDER BY e.full_name`,
      [],
    );
  }

  static async structure() {
    const [departments, designations, locations, roles] = await Promise.all([
      query<{ id: number; name: string; code: string; head_employee_id: number | null; head_name: string | null; employee_count: number }>(
        `SELECT d.id, d.name, d.code, d.head_employee_id, h.full_name AS head_name,
                (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'active') AS employee_count
         FROM departments d LEFT JOIN employees h ON h.id = d.head_employee_id ORDER BY d.name`,
      ),
      query<{ id: number; title: string; code: string; department_id: number | null; level: number; reporting_designation_id: number | null; employment_category: string; description: string | null; is_active: number; employee_count: number; location_ids: string | null }>(
        `SELECT g.id, g.title, g.code, g.department_id, g.level, g.reporting_designation_id, g.employment_category, g.description, g.is_active,
                (SELECT COUNT(*) FROM employees e WHERE e.designation_id = g.id AND e.status = 'active') AS employee_count,
                (SELECT GROUP_CONCAT(dl.location_id) FROM designation_locations dl WHERE dl.designation_id = g.id) AS location_ids
         FROM designations g ORDER BY g.is_active DESC, g.level DESC, g.title`,
      ),
      query<{ id: number; name: string; code: string; city: string | null; state: string | null; address: string | null; timezone: string; latitude: number | null; longitude: number | null; geofence_radius_m: number | null; is_active: number; employee_count: number }>(
        `SELECT l.id, l.name, l.code, l.city, l.state, l.address, l.timezone, l.latitude, l.longitude, l.geofence_radius_m, l.is_active,
                (SELECT COUNT(*) FROM employees e WHERE e.location_id = l.id AND e.status = 'active') AS employee_count
         FROM locations l ORDER BY l.is_active DESC, l.name`,
      ),
      query<{ id: number; name: string; slug: string; category: string; level: number; employee_count: number }>(
        `SELECT r.id, r.name, r.slug, r.category, r.level,
                (SELECT COUNT(*) FROM employees e WHERE e.role_id = r.id AND e.status = 'active') AS employee_count
         FROM roles r ORDER BY r.level DESC`,
      ),
    ]);
    return {
      departments: departments.map((d) => ({ ...d, id: Number(d.id), employeeCount: Number(d.employee_count) })),
      designations: designations.map((d) => ({
        ...d,
        id: Number(d.id),
        departmentId: d.department_id ? Number(d.department_id) : null,
        reportingDesignationId: d.reporting_designation_id ? Number(d.reporting_designation_id) : null,
        employmentCategory: d.employment_category,
        isActive: Boolean(d.is_active),
        employeeCount: Number(d.employee_count),
        locationIds: d.location_ids ? String(d.location_ids).split(',').map(Number) : [],
      })),
      locations: locations.map((l) => ({
        ...l,
        latitude: l.latitude === null ? null : Number(l.latitude),
        longitude: l.longitude === null ? null : Number(l.longitude),
        geofenceRadiusM: l.geofence_radius_m === null ? null : Number(l.geofence_radius_m),
        isActive: Boolean(l.is_active),
        employeeCount: Number(l.employee_count),
      })),
      roles: roles.map((r) => ({ ...r, employeeCount: Number(r.employee_count) })),
    };
  }

  static async rolePermissions() {
    const roles = await query<{ id: number; name: string; slug: string; level: number; description: string | null; is_system: number }>(
      'SELECT id, name, slug, level, description, is_system FROM roles ORDER BY level DESC',
    );
    const permissions = await query<{ id: number; code: string; module: string; action: string; description: string | null }>(
      'SELECT id, code, module, action, description FROM permissions ORDER BY module, action',
    );
    const mapping = await query<{ role_id: number; permission_id: number }>('SELECT role_id, permission_id FROM role_permissions');
    return {
      roles: roles.map((r) => ({
        id: Number(r.id),
        name: r.name,
        slug: r.slug,
        level: Number(r.level),
        description: r.description,
        isSystem: Boolean(r.is_system),
        permissions: mapping.filter((m) => Number(m.role_id) === Number(r.id)).map((m) => Number(m.permission_id)),
      })),
      permissions: permissions.map((p) => ({
        id: Number(p.id),
        code: p.code,
        module: p.module,
        action: p.action,
        description: p.description,
      })),
    };
  }

  static async updateRolePermissions(roleId: number, actor: AuthUser, permissionIds: number[]) {
    if (!actor.permissions.includes('roles.manage')) throw ApiError.forbidden('You cannot change the permission matrix.');
    const role = await queryOne<{ name: string; slug: string }>('SELECT name, slug FROM roles WHERE id = ?', [roleId]);
    if (!role) throw ApiError.notFound('Role not found');
    const before = await query<{ permission_id: number }>('SELECT permission_id FROM role_permissions WHERE role_id = ?', [roleId]);
    await execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    for (const permissionId of permissionIds) {
      await execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, permissionId]);
    }
    await recordAudit({
      actorId: actor.id,
      action: 'role.permissions_updated',
      entityType: 'role',
      entityId: roleId,
      before: { permissions: before.map((b) => Number(b.permission_id)) },
      after: { permissions: permissionIds },
    });
  }

  static async setUserPermission(employeeId: number, actor: AuthUser, permissionId: number, effect: 'grant' | 'deny' | 'clear') {
    if (!actor.permissions.includes('roles.manage')) throw ApiError.forbidden('You cannot change user permissions.');
    if (effect === 'clear') {
      await execute('DELETE FROM user_permissions WHERE employee_id = ? AND permission_id = ?', [employeeId, permissionId]);
    } else {
      await execute(
        `INSERT INTO user_permissions (employee_id, permission_id, effect, granted_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE effect = VALUES(effect), granted_by = VALUES(granted_by)`,
        [employeeId, permissionId, effect, actor.id],
      );
    }
    await recordAudit({
      actorId: actor.id,
      action: 'employee.permission_override',
      entityType: 'employee',
      entityId: employeeId,
      after: { permissionId, effect },
    });
  }

  static async createDepartment(actor: AuthUser, input: { name: string; code: string; description?: string; headEmployeeId?: number | null }) {
    if (!actor.permissions.includes('org.manage')) throw ApiError.forbidden('You cannot manage the organisation structure.');
    const duplicate = await queryOne<{ id: number }>('SELECT id FROM departments WHERE code = ?', [input.code.toUpperCase()]);
    if (duplicate) throw ApiError.conflict('A department with that code already exists.');
    const result = await execute('INSERT INTO departments (name, code, description, head_employee_id) VALUES (?, ?, ?, ?)', [
      input.name,
      input.code.toUpperCase(),
      input.description ?? null,
      input.headEmployeeId ?? null,
    ]);
    await recordAudit({ actorId: actor.id, action: 'department.created', entityType: 'department', entityId: result.insertId, after: input });
    return result.insertId;
  }

  // --------------------------- Designations ---------------------------------

  /** Rejects a reporting designation that would create a cycle (A reports to B reports to A). */
  private static async assertNoReportingCycle(designationId: number | null, reportingId: number | null) {
    if (!reportingId) return;
    if (designationId && reportingId === designationId) throw ApiError.badRequest('A designation cannot report to itself.');
    let cursor: number | null = reportingId;
    for (let depth = 0; cursor && depth < 30; depth += 1) {
      const row: { reporting_designation_id: number | null; is_active: number } | null = await queryOne(
        'SELECT reporting_designation_id, is_active FROM designations WHERE id = ?', [cursor],
      );
      if (!row) throw ApiError.badRequest('The reporting designation does not exist.');
      if (depth === 0 && !row.is_active) throw ApiError.badRequest('The reporting designation is inactive.');
      cursor = row.reporting_designation_id ? Number(row.reporting_designation_id) : null;
      if (designationId && cursor === designationId) throw ApiError.badRequest('That reporting line would create a cycle.');
    }
  }

  private static async validateLocations(ids: number[] | undefined): Promise<number[]> {
    const unique = [...new Set((ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return [];
    const rows = await query<{ id: number }>(`SELECT id FROM locations WHERE is_active = 1 AND id IN (${unique.map(() => '?').join(',')})`, unique);
    if (rows.length !== unique.length) throw ApiError.badRequest('One or more selected locations are invalid or inactive.');
    return unique;
  }

  static async createDesignation(
    actor: AuthUser,
    input: { title: string; code?: string; departmentId?: number | null; level?: number; reportingDesignationId?: number | null; employmentCategory?: string; description?: string | null; locationIds?: number[] },
  ) {
    if (!actor.permissions.includes('org.manage')) throw ApiError.forbidden('You cannot manage the organisation structure.');
    const title = input.title.trim().replace(/\s+/g, ' ');
    if (title.length < 2) throw ApiError.badRequest('Enter a designation title.');
    if (input.departmentId) {
      const department = await queryOne<{ id: number; code: string }>('SELECT id, code FROM departments WHERE id = ?', [input.departmentId]);
      if (!department) throw ApiError.badRequest('Select a valid department.');
    }
    const duplicate = await queryOne<{ id: number }>('SELECT id FROM designations WHERE title = ? AND department_id <=> ?', [title, input.departmentId ?? null]);
    if (duplicate) throw ApiError.conflict('This designation already exists in that department.');
    const department = input.departmentId ? await queryOne<{ code: string }>('SELECT code FROM departments WHERE id = ?', [input.departmentId]) : null;
    const code = (input.code?.trim() || `${department?.code ?? 'GEN'}-${title.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`).toUpperCase().slice(0, 32);
    if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code)) throw ApiError.badRequest('Use 2–32 letters, digits or hyphens for the designation code.');
    if (await queryOne('SELECT id FROM designations WHERE code = ?', [code])) throw ApiError.conflict('That designation code is already used.');
    await EmployeeService.assertNoReportingCycle(null, input.reportingDesignationId ?? null);
    const locations = await EmployeeService.validateLocations(input.locationIds);
    const id = await transaction(async (conn) => {
      const [result] = await conn.query<any>(
        `INSERT INTO designations (title, code, department_id, level, reporting_designation_id, employment_category, description, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, code, input.departmentId ?? null, input.level ?? 1, input.reportingDesignationId ?? null,
          input.employmentCategory ?? 'staff', input.description?.trim() || null, actor.id, actor.id],
      );
      for (const locationId of locations) {
        await conn.query('INSERT INTO designation_locations (designation_id, location_id) VALUES (?, ?)', [result.insertId, locationId]);
      }
      return Number(result.insertId);
    });
    await recordAudit({ actorId: actor.id, action: 'designation.created', entityType: 'designation', entityId: id, after: { ...input, code } });
    return id;
  }

  /** Updates or deactivates a designation. Employees keep their designation id; history is untouched. */
  static async updateDesignation(
    actor: AuthUser,
    id: number,
    input: { title?: string; code?: string; departmentId?: number | null; level?: number; reportingDesignationId?: number | null; employmentCategory?: string; description?: string | null; isActive?: boolean; locationIds?: number[] },
  ) {
    if (!actor.permissions.includes('org.manage')) throw ApiError.forbidden('You cannot manage the organisation structure.');
    const current = await queryOne<Record<string, unknown>>('SELECT * FROM designations WHERE id = ?', [id]);
    if (!current) throw ApiError.notFound('Designation not found');
    const title = input.title === undefined ? String(current.title) : input.title.trim().replace(/\s+/g, ' ');
    const departmentId = input.departmentId === undefined ? (current.department_id as number | null) : input.departmentId;
    if (title.length < 2) throw ApiError.badRequest('Enter a designation title.');
    const duplicate = await queryOne<{ id: number }>('SELECT id FROM designations WHERE title = ? AND department_id <=> ? AND id <> ?', [title, departmentId ?? null, id]);
    if (duplicate) throw ApiError.conflict('Another designation with this title already exists in that department.');
    const code = input.code === undefined ? String(current.code) : input.code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code)) throw ApiError.badRequest('Use 2–32 letters, digits or hyphens for the designation code.');
    if (await queryOne('SELECT id FROM designations WHERE code = ? AND id <> ?', [code, id])) throw ApiError.conflict('That designation code is already used.');
    const reportingId = input.reportingDesignationId === undefined ? (current.reporting_designation_id as number | null) : input.reportingDesignationId;
    await EmployeeService.assertNoReportingCycle(id, reportingId ? Number(reportingId) : null);
    if (input.isActive === false) {
      const dependants = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM designations WHERE reporting_designation_id = ? AND is_active = 1', [id]);
      if (Number(dependants?.total ?? 0) > 0) throw ApiError.conflict('Other active designations report to this one. Reassign their reporting line first.');
    }
    const locations = input.locationIds === undefined ? null : await EmployeeService.validateLocations(input.locationIds);
    await transaction(async (conn) => {
      await conn.query(
        `UPDATE designations SET title = ?, code = ?, department_id = ?, level = ?, reporting_designation_id = ?, employment_category = ?,
                description = ?, is_active = ?, updated_by = ? WHERE id = ?`,
        [title, code, departmentId ?? null, input.level ?? current.level, reportingId ?? null,
          input.employmentCategory ?? current.employment_category, input.description === undefined ? current.description : (input.description?.trim() || null),
          input.isActive === undefined ? current.is_active : (input.isActive ? 1 : 0), actor.id, id],
      );
      if (locations) {
        await conn.query('DELETE FROM designation_locations WHERE designation_id = ?', [id]);
        for (const locationId of locations) await conn.query('INSERT INTO designation_locations (designation_id, location_id) VALUES (?, ?)', [id, locationId]);
      }
    });
    await recordAudit({
      actorId: actor.id,
      action: input.isActive === false ? 'designation.deactivated' : 'designation.updated',
      entityType: 'designation',
      entityId: id,
      before: { title: current.title, code: current.code, departmentId: current.department_id, reportingDesignationId: current.reporting_designation_id, isActive: Boolean(current.is_active) },
      after: { ...input, title, code },
    });
  }

  /** Change history for a designation (from the audit trail). */
  static async designationHistory(id: number) {
    return query<Record<string, unknown>>(
      `SELECT a.action, a.before_data, a.after_data, a.created_at, e.full_name AS actor_name
       FROM audit_logs a LEFT JOIN employees e ON e.id = a.actor_id
       WHERE a.entity_type = 'designation' AND a.entity_id = ? ORDER BY a.created_at DESC LIMIT 50`,
      [id],
    );
  }

  // ----------------------------- Locations -----------------------------------

  static async createLocation(
    actor: AuthUser,
    input: { name: string; code: string; city?: string; state?: string; address?: string; timezone?: string; latitude?: number; longitude?: number; geofenceRadiusM?: number },
  ) {
    if (!actor.permissions.includes('org.manage')) throw ApiError.forbidden('You cannot manage the organisation structure.');
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(code)) throw ApiError.badRequest('Location codes use 2–12 letters or digits, e.g. BEL.');
    if (await queryOne('SELECT id FROM locations WHERE code = ?', [code])) throw ApiError.conflict('That location code is already used.');
    if (await queryOne('SELECT id FROM locations WHERE name = ?', [input.name.trim()])) throw ApiError.conflict('A location with that name already exists.');
    if ((input.latitude === undefined) !== (input.longitude === undefined)) throw ApiError.badRequest('Provide both latitude and longitude, or neither.');
    const result = await execute(
      `INSERT INTO locations (name, code, city, state, address, timezone, latitude, longitude, geofence_radius_m, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.name.trim(), code, input.city?.trim() || null, input.state?.trim() || null, input.address?.trim() || null,
        input.timezone ?? 'Asia/Kolkata', input.latitude ?? null, input.longitude ?? null, input.geofenceRadiusM ?? null, actor.id, actor.id],
    );
    await recordAudit({ actorId: actor.id, action: 'location.created', entityType: 'location', entityId: result.insertId, after: { ...input, code } });
    return result.insertId;
  }

  static async updateLocation(
    actor: AuthUser,
    id: number,
    input: { name?: string; code?: string; city?: string | null; state?: string | null; address?: string | null; timezone?: string; latitude?: number | null; longitude?: number | null; geofenceRadiusM?: number | null; isActive?: boolean },
  ) {
    if (!actor.permissions.includes('org.manage')) throw ApiError.forbidden('You cannot manage the organisation structure.');
    const current = await queryOne<Record<string, unknown>>('SELECT * FROM locations WHERE id = ?', [id]);
    if (!current) throw ApiError.notFound('Location not found');
    const code = input.code === undefined ? String(current.code) : input.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(code)) throw ApiError.badRequest('Location codes use 2–12 letters or digits, e.g. BEL.');
    if (await queryOne('SELECT id FROM locations WHERE code = ? AND id <> ?', [code, id])) throw ApiError.conflict('That location code is already used.');
    const name = input.name === undefined ? String(current.name) : input.name.trim();
    if (await queryOne('SELECT id FROM locations WHERE name = ? AND id <> ?', [name, id])) throw ApiError.conflict('A location with that name already exists.');
    if (input.isActive === false) {
      const active = await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM employees WHERE location_id = ? AND status = 'active'", [id]);
      if (Number(active?.total ?? 0) > 0) throw ApiError.conflict(`${active?.total} active employee(s) are assigned to this location. Move them before deactivating it.`);
    }
    const pick = <T>(value: T | undefined, fallback: unknown) => (value === undefined ? fallback : value);
    await execute(
      `UPDATE locations SET name = ?, code = ?, city = ?, state = ?, address = ?, timezone = ?, latitude = ?, longitude = ?,
              geofence_radius_m = ?, is_active = ?, updated_by = ? WHERE id = ?`,
      [name, code, pick(input.city, current.city), pick(input.state, current.state), pick(input.address, current.address),
        pick(input.timezone, current.timezone), pick(input.latitude, current.latitude), pick(input.longitude, current.longitude),
        pick(input.geofenceRadiusM, current.geofence_radius_m), input.isActive === undefined ? current.is_active : (input.isActive ? 1 : 0), actor.id, id],
    );
    await recordAudit({
      actorId: actor.id,
      action: input.isActive === false ? 'location.deactivated' : 'location.updated',
      entityType: 'location',
      entityId: id,
      before: { name: current.name, code: current.code, isActive: Boolean(current.is_active) },
      after: { ...input, name, code },
    });
  }

  /** Additional locations an employee may access beyond their primary location. */
  static async setEmployeeLocations(actor: AuthUser, employeeId: number, locationIds: number[]) {
    if (!actor.permissions.includes('org.manage') && !actor.permissions.includes('employees.manage')) throw ApiError.forbidden('You cannot change location access.');
    const employee = await queryOne<{ id: number }>('SELECT id FROM employees WHERE id = ?', [employeeId]);
    if (!employee) throw ApiError.notFound('Employee not found');
    const locations = await EmployeeService.validateLocations(locationIds);
    const before = await query<{ location_id: number }>('SELECT location_id FROM employee_locations WHERE employee_id = ?', [employeeId]);
    await transaction(async (conn) => {
      await conn.query('DELETE FROM employee_locations WHERE employee_id = ?', [employeeId]);
      for (const locationId of locations) {
        await conn.query('INSERT INTO employee_locations (employee_id, location_id, granted_by) VALUES (?, ?, ?)', [employeeId, locationId, actor.id]);
      }
    });
    await recordAudit({
      actorId: actor.id, action: 'employee.location_access_changed', entityType: 'employee', entityId: employeeId,
      before: { locationIds: before.map((row) => Number(row.location_id)) }, after: { locationIds: locations },
    });
    return locations;
  }

  static async employeeLocations(employeeId: number) {
    const rows = await query<{ location_id: number }>('SELECT location_id FROM employee_locations WHERE employee_id = ?', [employeeId]);
    return rows.map((row) => Number(row.location_id));
  }


  static async updateRoleDetails(actor: AuthUser, roleId: number, input: { name?: string; description?: string; level?: number }) {
    if (!actor.permissions.includes('roles.manage')) throw ApiError.forbidden('You cannot manage roles.');
    const role = await queryOne<{ is_system: number }>('SELECT is_system FROM roles WHERE id = ?', [roleId]);
    if (!role) throw ApiError.notFound('Role not found');
    await execute('UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), level = COALESCE(?, level) WHERE id = ?', [
      input.name ?? null,
      input.description ?? null,
      input.level ?? null,
      roleId,
    ]);
    await recordAudit({ actorId: actor.id, action: 'role.updated', entityType: 'role', entityId: roleId, after: input });
  }

  static async createRole(actor: AuthUser, input: { name: string; slug: string; category?: string; level?: number; description?: string }) {
    if (!actor.permissions.includes('roles.manage')) throw ApiError.forbidden('You cannot create roles.');
    const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const duplicate = await queryOne<{ id: number }>('SELECT id FROM roles WHERE slug = ?', [slug]);
    if (duplicate) throw ApiError.conflict('A role with that identifier already exists.');
    const result = await execute('INSERT INTO roles (name, slug, category, level, description) VALUES (?, ?, ?, ?, ?)', [
      input.name,
      slug,
      input.category ?? 'general',
      input.level ?? 20,
      input.description ?? null,
    ]);
    await recordAudit({ actorId: actor.id, action: 'role.created', entityType: 'role', entityId: result.insertId, after: input });
    return result.insertId;
  }
}

