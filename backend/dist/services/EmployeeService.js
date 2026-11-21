import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { hashPassword, passwordIssues } from '../lib/crypto.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { allowedLocationIds, locationEmployeeClause, requestedLocation, subtreeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { ChatService } from './ChatService.js';
import { GroupService } from './GroupService.js';
import { HierarchyService } from './HierarchyService.js';
import { emitToEmployee, getIO } from '../realtime/io.js';
async function employeeScope(user) {
    if (user.permissions.includes('employees.view.all') || user.roleLevel >= 90)
        return locationEmployeeClause(user, 'e.id');
    if (user.permissions.includes('employees.view.team')) {
        const ids = await subtreeIds(user.id);
        if (ids.length === 0)
            return { clause: '1 = 0', params: [] };
        return { clause: `e.id IN (${ids.map(() => '?').join(',')})`, params: ids };
    }
    return { clause: 'e.id = ?', params: [user.id] };
}
const SUPER_ADMIN_LEVEL = 100;
/** Store Manager (50) and above count as managers/admins for self-service location changes. */
const SELF_LOCATION_MIN_LEVEL = 50;
/**
 * Role hierarchy guard: you may only manage people whose role ranks strictly
 * below your own (Super Admin may manage anyone except themselves).
 */
async function assertCanManageEmployee(actor, employeeId, verb) {
    if (employeeId === actor.id && actor.roleLevel < SUPER_ADMIN_LEVEL) {
        throw ApiError.badRequest(`You cannot ${verb} your own account.`);
    }
    const target = await queryOne('SELECT r.level, r.name FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?', [employeeId]);
    if (!target)
        throw ApiError.notFound('Employee not found');
    if (actor.roleLevel < SUPER_ADMIN_LEVEL && Number(target.level) >= actor.roleLevel) {
        throw ApiError.forbidden(`You cannot ${verb} a ${target.name}: their role is the same as or above yours.`);
    }
}
/** You can only hand out roles at or below your own level, so nobody can escalate privileges. */
async function assertCanAssignRole(actor, roleId) {
    if (!roleId)
        return;
    const role = await queryOne('SELECT level, name FROM roles WHERE id = ?', [roleId]);
    if (!role)
        throw ApiError.badRequest('That role does not exist.');
    if (actor.roleLevel < SUPER_ADMIN_LEVEL && Number(role.level) > actor.roleLevel) {
        throw ApiError.forbidden(`You cannot assign the ${role.name} role: it ranks above your own.`);
    }
}
export class EmployeeService {
    static async list(user, filters) {
        const scope = await employeeScope(user);
        const clauses = [
            scope.clause,
            "e.status NOT IN ('rejected','deleted')",
        ];
        const params = [...scope.params];
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
            const locId = await requestedLocation(user, filters.locationId);
            if (locId) {
                clauses.push('e.location_id = ?');
                params.push(locId);
            }
        }
        if (filters.groupId) {
            clauses.push('e.group_id = ?');
            params.push(filters.groupId);
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
        const rows = await query(`SELECT e.id, e.employee_code, e.full_name, e.email, e.mobile, e.photo_url, e.status, e.employment_type, e.joining_date,
              e.department_id, e.manager_id, e.created_at,
              e.location_id, l.name AS location_name, l.code AS location_code,
              e.group_id, wg.name AS group_name, wg.code AS group_code,
              e.team_leader_id, tl.full_name AS team_leader_name,
              d.name AS department_name, dg.title AS designation_title, r.name AS role_name, r.slug AS role_slug,
              m.full_name AS manager_name,
              a.status AS attendance_status, a.check_in_at,
              (SELECT COUNT(*) FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
                WHERE ta.employee_id = e.id AND t.status IN ('assigned','accepted','in_progress','on_hold','pending_approval')) AS open_tasks
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN workforce_groups wg ON wg.id = e.group_id
       LEFT JOIN employees tl ON tl.id = e.team_leader_id
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
       WHERE ${where}
       ORDER BY FIELD(e.status, 'pending_verification','pending_approval','active','inactive'), e.full_name
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
        const total = await queryOne(`SELECT COUNT(*) AS total FROM employees e WHERE ${where}`, params);
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
                locationId: r.location_id ? Number(r.location_id) : null,
                locationName: r.location_name,
                locationCode: r.location_code,
                groupId: r.group_id ? Number(r.group_id) : null,
                groupName: r.group_name,
                groupCode: r.group_code,
                teamLeaderId: r.team_leader_id ? Number(r.team_leader_id) : null,
                teamLeaderName: r.team_leader_name,
                attendanceStatus: r.attendance_status,
                checkInAt: toIso(r.check_in_at),
                openTasks: Number(r.open_tasks),
            })),
            total: Number(total?.total ?? 0),
            page,
            pageSize,
        };
    }
    static async detail(employeeId, user) {
        const scope = await employeeScope(user);
        const row = await queryOne(`SELECT e.*, d.name AS department_name, dg.title AS designation_title, r.name AS role_name, r.slug AS role_slug,
              m.full_name AS manager_name, l.name AS location_name, l.code AS location_code,
              wg.name AS group_name, wg.code AS group_code, tl.full_name AS team_leader_name
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN workforce_groups wg ON wg.id = e.group_id
       LEFT JOIN employees tl ON tl.id = e.team_leader_id
       WHERE e.id = ? AND ${scope.clause}`, [employeeId, ...scope.params]);
        if (!row)
            throw ApiError.notFound('Employee not found or outside your access scope');
        const [taskStats, attendanceStats, ticketStats, kpi, reports, addlLocRows] = await Promise.all([
            queryOne(`SELECT COUNT(*) AS total, SUM(t.status = 'completed') AS completed,
                SUM(t.status IN ('assigned','accepted','in_progress','on_hold','pending_approval')) AS active,
                SUM(t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')) AS overdue
         FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id WHERE ta.employee_id = ?`, [employeeId]),
            queryOne(`SELECT SUM(status IN ('present','late','half_day')) AS present, SUM(is_late) AS late, COALESCE(SUM(total_minutes),0) AS minutes
         FROM attendance WHERE employee_id = ? AND work_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`, [employeeId]),
            queryOne(`SELECT COUNT(*) AS total, SUM(status NOT IN ('resolved','closed','cancelled')) AS open,
                SUM(status IN ('resolved','closed')) AS resolved
         FROM tickets WHERE requester_id = ? OR assignee_id = ?`, [employeeId, employeeId]),
            queryOne(`SELECT period, total_score, category, status FROM employee_kpi_records WHERE employee_id = ? ORDER BY period DESC LIMIT 1`, [employeeId]),
            queryOne(`SELECT COUNT(*) AS submitted, SUM(status = 'approved') AS approved
         FROM daily_work_reports WHERE employee_id = ? AND report_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`, [employeeId]),
            query(`SELECT el.location_id, l.code, l.name
         FROM employee_locations el JOIN locations l ON el.location_id = l.id
         WHERE el.employee_id = ?`, [employeeId]),
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
            locationCode: row.location_code ?? null,
            additionalLocationIds: (addlLocRows ?? []).map((r) => Number(r.location_id)),
            additionalLocations: (addlLocRows ?? []).map((r) => ({ id: Number(r.location_id), code: r.code, name: r.name })),
            groupId: row.group_id ? Number(row.group_id) : null,
            groupName: row.group_name ?? null,
            groupCode: row.group_code ?? null,
            teamLeaderId: row.team_leader_id ? Number(row.team_leader_id) : null,
            teamLeaderName: row.team_leader_name ?? null,
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
    static async update(employeeId, actor, input) {
        const target = await queryOne('SELECT * FROM employees WHERE id = ?', [employeeId]);
        if (!target)
            throw ApiError.notFound('Employee not found');
        const isSelf = Number(target.id) === actor.id;
        if (!isSelf && !actor.permissions.includes('employees.manage')) {
            throw ApiError.forbidden('You cannot edit this employee record.');
        }
        // Only allow employees.manage to change employeeCode
        const canManageEmployees = actor.permissions.includes('employees.manage');
        const fields = [];
        const params = [];
        if (input.fullName) {
            fields.push('full_name = ?');
            params.push(input.fullName.trim());
        }
        if (input.mobile) {
            const duplicate = await queryOne('SELECT id FROM employees WHERE mobile = ? AND id <> ?', [input.mobile, employeeId]);
            if (duplicate)
                throw ApiError.conflict('That mobile number is already registered.');
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
        if (input.employeeCode !== undefined && canManageEmployees) {
            const code = input.employeeCode.trim().toUpperCase();
            if (!code) {
                throw ApiError.badRequest('Employee number cannot be empty.');
            }
            if (!/^EMP(-[A-Z0-9]{2,5})?-\d{1,6}$/i.test(code)) {
                throw ApiError.badRequest('Employee number must follow the format EMP-DVG-1604 (e.g. EMP-DVG-1604, EMP-BLG-1601, EMP-SMG-1601).');
            }
            const duplicate = await queryOne('SELECT id FROM employees WHERE employee_code = ? AND id <> ?', [code, employeeId]);
            if (duplicate)
                throw ApiError.conflict('That employee number is already assigned to another employee.');
            fields.push('employee_code = ?');
            params.push(code);
        }
        if (fields.length === 0)
            throw ApiError.badRequest('Nothing to update.');
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
    static async updateOrgAssignment(employeeId, actor, input) {
        if (!actor.permissions.includes('employees.manage'))
            throw ApiError.forbidden('You cannot change organisational assignments.');
        const target = await queryOne('SELECT * FROM employees WHERE id = ?', [employeeId]);
        if (!target)
            throw ApiError.notFound('Employee not found');
        await assertCanManageEmployee(actor, employeeId, 'change the role or reporting line of');
        if (employeeId === actor.id && input.roleId && input.roleId !== actor.roleId) {
            throw ApiError.badRequest('Administrators cannot change their own role.');
        }
        await assertCanAssignRole(actor, input.roleId);
        if (input.managerId === employeeId)
            throw ApiError.badRequest('An employee cannot report to themselves.');
        if (input.teamLeaderId === employeeId)
            throw ApiError.badRequest('An employee cannot be their own team leader.');
        if (input.managerId) {
            const descendants = await subtreeIds(employeeId);
            if (descendants.includes(input.managerId)) {
                throw ApiError.badRequest('That manager is inside this employee\'s own reporting line.');
            }
        }
        if (input.locationId !== undefined && input.locationId !== null) {
            const allowed = await allowedLocationIds(actor);
            if (allowed !== null && !allowed.includes(Number(input.locationId))) {
                const loc = await queryOne('SELECT code FROM locations WHERE id = ?', [input.locationId]);
                if (loc?.code !== 'ALL') {
                    throw ApiError.forbidden('You cannot assign an employee to an unauthorized location.');
                }
            }
        }
        const effectiveLocationId = input.locationId ?? target.location_id;
        if (input.groupId && effectiveLocationId) {
            const grp = await queryOne('SELECT id FROM workforce_groups WHERE id = ? AND location_id = ?', [input.groupId, effectiveLocationId]);
            if (!grp)
                throw ApiError.badRequest('Selected group does not belong to the employee\'s assigned store location.');
        }
        const fields = [];
        const params = [];
        for (const [column, value] of [
            ['role_id', input.roleId],
            ['department_id', input.departmentId],
            ['designation_id', input.designationId],
            ['manager_id', input.managerId],
            ['location_id', input.locationId],
            ['group_id', input.groupId],
            ['team_leader_id', input.teamLeaderId],
            ['employment_type', input.employmentType],
        ]) {
            if (value !== undefined) {
                fields.push(`${column} = ?`);
                params.push(value);
            }
        }
        if (fields.length === 0)
            return;
        await execute(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, [...params, employeeId]);
        const previousManager = target.manager_id ? Number(target.manager_id) : null;
        if (input.managerId !== undefined && (input.managerId ?? null) !== previousManager) {
            await transaction((conn) => HierarchyService.recordManagerChange(conn, {
                employeeId, managerId: input.managerId ?? null, previousManagerId: previousManager,
                locationId: (input.locationId ?? target.location_id ?? null),
                reason: 'Changed from the employee directory', source: 'manual', actorId: actor.id,
            }));
        }
        // An employee left without a manager is attached to the Software Manager.
        await HierarchyService.ensureStructure(actor.id).catch((error) => console.warn('[hierarchy] ensure failed', error));
        if (input.groupId !== undefined) {
            if (input.groupId) {
                await execute('INSERT INTO employee_group_members (group_id, employee_id, role, assigned_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [input.groupId, employeeId, 'member', actor.id]);
            }
            else {
                await execute('DELETE FROM employee_group_members WHERE employee_id = ?', [employeeId]);
            }
        }
        // Save accessible store locations in employee_locations
        if (input.additionalLocationIds !== undefined) {
            await execute('DELETE FROM employee_locations WHERE employee_id = ?', [employeeId]);
            for (const locId of input.additionalLocationIds) {
                if (locId) {
                    await execute('INSERT INTO employee_locations (employee_id, location_id, granted_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by)', [employeeId, locId, actor.id]);
                }
            }
        }
        else if (input.locationId) {
            const loc = await queryOne('SELECT code FROM locations WHERE id = ?', [input.locationId]);
            if (loc?.code === 'ALL') {
                const storeLocs = await query('SELECT id FROM locations WHERE code IN (\'BEL\', \'DAV\', \'SHI\', \'HQ\')');
                await execute('DELETE FROM employee_locations WHERE employee_id = ?', [employeeId]);
                for (const sl of storeLocs) {
                    await execute('INSERT INTO employee_locations (employee_id, location_id, granted_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by)', [employeeId, sl.id, actor.id]);
                }
            }
        }
        await recordAudit({
            actorId: actor.id,
            action: 'employee.org_assignment_updated',
            entityType: 'employee',
            entityId: employeeId,
            before: { role_id: target.role_id, department_id: target.department_id, manager_id: target.manager_id, location_id: target.location_id, group_id: target.group_id },
            after: input,
        });
    }
    static async approveRegistration(employeeId, actor, input) {
        if (!actor.permissions.includes('employees.approve') && !actor.permissions.includes('employees.manage')) {
            throw ApiError.forbidden('You cannot approve registrations.');
        }
        await assertCanAssignRole(actor, input.roleId);
        const employee = await queryOne('SELECT id, full_name, status, email, mobile, department_id FROM employees WHERE id = ?', [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found');
        if (!['pending_approval', 'pending_verification'].includes(employee.status)) {
            throw ApiError.badRequest('This registration is not awaiting approval.');
        }
        await execute(`UPDATE employees SET status = 'active',
              email_verified_at = COALESCE(email_verified_at, NOW(3)),
              mobile_verified_at = COALESCE(mobile_verified_at, NOW(3)),
              role_id = COALESCE(?, role_id), department_id = COALESCE(?, department_id),
              designation_id = COALESCE(?, designation_id), manager_id = COALESCE(?, manager_id), location_id = COALESCE(?, location_id),
              joining_date = COALESCE(joining_date, CURDATE())
       WHERE id = ?`, [
            input.roleId ?? null,
            input.departmentId ?? null,
            input.designationId ?? null,
            input.managerId ?? null,
            input.locationId ?? null,
            employeeId,
        ]);
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
        await HierarchyService.ensureStructure(actor.id).catch((error) => console.warn('[hierarchy] ensure failed', error));
    }
    static async rejectRegistration(employeeId, actor, reason) {
        if (!actor.permissions.includes('employees.approve') && !actor.permissions.includes('employees.manage')) {
            throw ApiError.forbidden('You cannot reject registrations.');
        }
        if (!reason.trim())
            throw ApiError.badRequest('Provide a reason for rejecting this registration.');
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
    static async createByAdmin(actor, input, context) {
        if (!actor.permissions.includes('employees.manage'))
            throw ApiError.forbidden('You cannot create employees.');
        await assertCanAssignRole(actor, input.roleId);
        const issues = passwordIssues(input.password);
        if (issues.length > 0)
            throw ApiError.badRequest(`Password must contain ${issues.join(', ')}.`);
        const duplicate = await queryOne('SELECT id FROM employees WHERE email = ? OR mobile = ?', [input.email.toLowerCase(), input.mobile]);
        if (duplicate)
            throw ApiError.conflict('An employee already exists with this email or mobile.');
        if (input.locationId) {
            const allowed = await allowedLocationIds(actor);
            if (allowed !== null && !allowed.includes(Number(input.locationId))) {
                throw ApiError.forbidden('You cannot assign an employee to an unauthorized location.');
            }
        }
        if (input.groupId && input.locationId) {
            const grp = await queryOne('SELECT id FROM workforce_groups WHERE id = ? AND location_id = ? AND is_active = 1', [
                input.groupId,
                input.locationId,
            ]);
            if (!grp)
                throw ApiError.badRequest('Selected group does not belong to the selected store location.');
        }
        let code = input.employeeCode?.trim().toUpperCase();
        if (code) {
            if (!/^EMP(-[A-Z0-9]{2,5})?-\d{1,6}$/i.test(code)) {
                throw ApiError.badRequest('Employee number must follow the format EMP-DVG-1604 (e.g. EMP-DVG-1604, EMP-BLG-1601, EMP-SMG-1601).');
            }
            const duplicate = await queryOne('SELECT id FROM employees WHERE employee_code = ?', [code]);
            if (duplicate)
                throw ApiError.conflict('That employee number is already assigned to another employee.');
        }
        else {
            let locCode = 'DVG';
            if (input.locationId) {
                const loc = await queryOne('SELECT code FROM locations WHERE id = ?', [input.locationId]);
                if (loc) {
                    if (loc.code === 'DAV' || loc.code === 'DVG')
                        locCode = 'DVG';
                    else if (loc.code === 'BEL' || loc.code === 'BLG')
                        locCode = 'BLG';
                    else if (loc.code === 'SHI' || loc.code === 'SMG')
                        locCode = 'SMG';
                    else if (loc.code === 'HQ')
                        locCode = 'HQ';
                    else if (loc.code === 'ALL')
                        locCode = 'DVG';
                    else
                        locCode = loc.code.replace(/[^A-Z0-9]/g, '').slice(0, 4);
                }
            }
            const maxRow = await queryOne('SELECT employee_code AS max_code FROM employees WHERE employee_code LIKE ? ORDER BY id DESC LIMIT 1', [`EMP-${locCode}-%`]);
            let nextNum = 1601;
            if (maxRow?.max_code) {
                const parts = maxRow.max_code.split('-');
                const parsed = parseInt(parts[parts.length - 1], 10);
                if (!isNaN(parsed))
                    nextNum = Math.max(nextNum, parsed + 1);
            }
            while (await queryOne('SELECT id FROM employees WHERE employee_code = ?', [`EMP-${locCode}-${nextNum}`])) {
                nextNum++;
            }
            code = `EMP-${locCode}-${nextNum}`;
        }
        const result = await execute(`INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, designation_id, manager_id,
        location_id, group_id, team_leader_id, employment_type, status, joining_date, email_verified_at, mobile_verified_at, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURDATE(), NOW(3), NOW(3), 1)`, [
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
            input.groupId ?? null,
            input.teamLeaderId ?? null,
            input.employmentType ?? 'full_time',
        ]);
        if (input.groupId) {
            await execute('INSERT INTO employee_group_members (group_id, employee_id, role, assigned_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [input.groupId, result.insertId, 'member', actor.id]);
        }
        if (input.locationId) {
            await GroupService.logLocationAudit({
                actor,
                action: 'assign_location',
                targetEmployeeId: result.insertId,
                targetEmployeeName: input.fullName,
                groupId: input.groupId ?? null,
                toLocationId: input.locationId,
                details: { reason: 'New employee assigned during creation', userAgent: context?.userAgent ?? null },
                ipAddress: context?.ipAddress,
            });
        }
        await ChatService.emptyOrEnsureGeneral(result.insertId, input.departmentId);
        await recordAudit({
            actorId: actor.id,
            action: 'employee.created',
            entityType: 'employee',
            entityId: result.insertId,
            after: { employeeCode: code, email: input.email, roleId: input.roleId, locationId: input.locationId, groupId: input.groupId },
        });
        await HierarchyService.ensureStructure(actor.id).catch((error) => console.warn('[hierarchy] ensure failed', error));
        return { id: result.insertId, employeeCode: code };
    }
    static async transferLocation(actor, employeeId, input, context) {
        if (!actor.permissions.includes('employees.manage') && !actor.permissions.includes('employees.transfer')) {
            throw ApiError.forbidden('You do not have permission to transfer employees across locations.');
        }
        const target = await queryOne('SELECT id, employee_code, full_name, location_id, group_id, team_leader_id FROM employees WHERE id = ?', [employeeId]);
        if (!target)
            throw ApiError.notFound('Employee not found.');
        const allowed = await allowedLocationIds(actor);
        if (allowed !== null && !allowed.includes(Number(input.locationId))) {
            throw ApiError.forbidden('You cannot transfer an employee to an unauthorized location.');
        }
        if (allowed !== null && target.location_id && !allowed.includes(Number(target.location_id))) {
            throw ApiError.forbidden('You cannot transfer an employee from a location you are not authorized to manage.');
        }
        const loc = await queryOne('SELECT id, name, code FROM locations WHERE id = ? AND is_active = 1', [input.locationId]);
        if (!loc)
            throw ApiError.badRequest('Target store location does not exist or is inactive.');
        if (input.groupId) {
            const grp = await queryOne('SELECT id, name FROM workforce_groups WHERE id = ? AND location_id = ? AND is_active = 1', [
                input.groupId,
                input.locationId,
            ]);
            if (!grp)
                throw ApiError.badRequest('Selected group does not belong to the target store location.');
        }
        const fromLocationId = target.location_id;
        const fromGroupId = target.group_id;
        await execute('UPDATE employees SET location_id = ?, group_id = ?, team_leader_id = ? WHERE id = ?', [input.locationId, input.groupId ?? null, input.teamLeaderId ?? null, employeeId]);
        // Update group membership
        await execute('DELETE FROM employee_group_members WHERE employee_id = ?', [employeeId]);
        if (input.groupId) {
            await execute('INSERT INTO employee_group_members (group_id, employee_id, role, assigned_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [input.groupId, employeeId, 'member', actor.id]);
        }
        await GroupService.logLocationAudit({
            actor,
            action: 'transfer_employee',
            targetEmployeeId: employeeId,
            targetEmployeeName: target.full_name,
            groupId: input.groupId ?? null,
            fromLocationId,
            toLocationId: input.locationId,
            toLocationName: loc.name,
            details: { fromGroupId, reason: input.reason ?? 'Location transfer by authorized administrator', userAgent: context?.userAgent ?? null },
            ipAddress: context?.ipAddress,
        });
        await recordAudit({
            actorId: actor.id,
            action: 'employee.location_transferred',
            entityType: 'employee',
            entityId: employeeId,
            before: { locationId: fromLocationId, groupId: fromGroupId },
            after: { locationId: input.locationId, groupId: input.groupId, teamLeaderId: input.teamLeaderId, reason: input.reason },
        });
        return { ok: true };
    }
    /** Admins and managers may move their own primary work location. */
    static canChangeOwnLocation(user) {
        const slug = (user.roleSlug ?? '').toLowerCase();
        return user.roleLevel >= SELF_LOCATION_MIN_LEVEL || /(admin|manager|owner)/.test(slug);
    }
    /** Active locations an admin/manager may pick as their own location. */
    static async selfLocationOptions(user) {
        if (!EmployeeService.canChangeOwnLocation(user))
            return [];
        return query("SELECT id, code, name, city FROM locations WHERE is_active = 1 ORDER BY FIELD(code, 'SHI', 'DAV', 'BEL', 'HQ') DESC, name");
    }
    static async changeOwnLocation(actor, input, context) {
        if (!EmployeeService.canChangeOwnLocation(actor)) {
            throw ApiError.forbidden('Only administrators and managers can change their own location.');
        }
        const target = await queryOne('SELECT id, full_name, location_id, group_id FROM employees WHERE id = ?', [actor.id]);
        if (!target)
            throw ApiError.notFound('Employee not found.');
        const loc = await queryOne('SELECT id, name, code FROM locations WHERE id = ? AND is_active = 1', [input.locationId]);
        if (!loc)
            throw ApiError.badRequest('That location does not exist or is inactive.');
        const fromLocationId = target.location_id ? Number(target.location_id) : null;
        if (fromLocationId === Number(loc.id)) {
            return { ok: true, changed: false, location: loc };
        }
        // A workforce group belongs to one location: keep it only if it matches the new one.
        let keepGroup = false;
        if (target.group_id) {
            const grp = await queryOne('SELECT id FROM workforce_groups WHERE id = ? AND location_id = ?', [target.group_id, loc.id]);
            keepGroup = Boolean(grp);
        }
        await transaction(async (conn) => {
            if (keepGroup) {
                await conn.query('UPDATE employees SET location_id = ? WHERE id = ?', [loc.id, actor.id]);
            }
            else {
                await conn.query('UPDATE employees SET location_id = ?, group_id = NULL WHERE id = ?', [loc.id, actor.id]);
                await conn.query('DELETE FROM employee_group_members WHERE employee_id = ?', [actor.id]);
            }
        });
        await GroupService.logLocationAudit({
            actor,
            action: 'self_location_change',
            targetEmployeeId: actor.id,
            targetEmployeeName: target.full_name,
            groupId: keepGroup ? target.group_id : null,
            fromLocationId,
            toLocationId: loc.id,
            toLocationName: loc.name,
            details: { reason: input.reason ?? 'Changed own location from My Profile', userAgent: context?.userAgent ?? null },
            ipAddress: context?.ipAddress,
        });
        await recordAudit({
            actorId: actor.id,
            action: 'employee.own_location_changed',
            entityType: 'employee',
            entityId: actor.id,
            before: { locationId: fromLocationId, groupId: target.group_id },
            after: { locationId: loc.id, groupId: keepGroup ? target.group_id : null, reason: input.reason },
        });
        // Move this user's live sockets to the new location room; keep the old one only if still granted.
        const io = getIO();
        if (io) {
            io.in(`user:${actor.id}`).socketsJoin(`location:${loc.id}`);
            if (fromLocationId) {
                const stillGranted = await queryOne(`SELECT location_id FROM employee_locations WHERE employee_id = ? AND location_id = ?
           UNION SELECT location_id FROM location_hr_assignments WHERE employee_id = ? AND location_id = ?`, [actor.id, fromLocationId, actor.id, fromLocationId]);
                if (!stillGranted && !actor.permissions.includes('locations.view.all')) {
                    io.in(`user:${actor.id}`).socketsLeave(`location:${fromLocationId}`);
                }
            }
        }
        // Every open tab/device of this user refreshes its session.
        emitToEmployee(actor.id, 'profile:location_changed', { locationId: loc.id, locationName: loc.name, locationCode: loc.code });
        return { ok: true, changed: true, location: loc };
    }
    static async getUserAllowedLocations(user) {
        const allowed = await allowedLocationIds(user);
        if (allowed === null) {
            return query("SELECT id, code, name, city FROM locations WHERE is_active = 1 AND code IN ('ALL', 'BEL', 'DAV', 'SHI', 'HQ') ORDER BY FIELD(code, 'ALL', 'HQ', 'BEL', 'DAV', 'SHI')");
        }
        if (allowed.length === 0)
            return [];
        return query(`SELECT id, code, name, city FROM locations WHERE is_active = 1 AND id IN (${allowed.join(',')}) ORDER BY FIELD(code, 'ALL', 'HQ', 'BEL', 'DAV', 'SHI')`);
    }
    static async setStatus(employeeId, actor, status, reason) {
        if (!actor.permissions.includes('employees.manage'))
            throw ApiError.forbidden('You cannot change employee status.');
        if (employeeId === actor.id)
            throw ApiError.badRequest('You cannot deactivate your own account.');
        const target = await queryOne('SELECT status, full_name FROM employees WHERE id = ?', [employeeId]);
        if (!target)
            throw ApiError.notFound('Employee not found');
        if (target.status === 'deleted')
            throw ApiError.badRequest('This account has been deleted and cannot be reactivated.');
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
    static async remove(employeeId, actor, reason) {
        if (!actor.permissions.includes('employees.delete') && !actor.permissions.includes('employees.manage') && actor.roleLevel < 100) {
            throw ApiError.forbidden('You cannot delete employees.');
        }
        const target = await queryOne(`SELECT e.id, e.full_name, e.employee_code, e.email, e.mobile, e.status, e.manager_id, r.slug AS role_slug
         FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`, [employeeId]);
        if (!target)
            throw ApiError.notFound('Employee not found');
        if (target.status === 'deleted')
            throw ApiError.badRequest('This employee has already been deleted.');
        await assertCanManageEmployee(actor, employeeId, 'delete');
        if (target.role_slug === 'super_admin') {
            const others = await queryOne("SELECT COUNT(*) AS n FROM employees e JOIN roles r ON r.id = e.role_id WHERE r.slug = 'super_admin' AND e.status = 'active' AND e.id <> ?", [employeeId]);
            if (Number(others?.n ?? 0) === 0)
                throw ApiError.badRequest('You cannot delete the last Super Admin.');
        }
        await transaction(async (conn) => {
            await conn.execute('UPDATE employees SET manager_id = ? WHERE manager_id = ?', [target.manager_id, employeeId]);
            await conn.execute('UPDATE departments SET head_employee_id = NULL WHERE head_employee_id = ?', [employeeId]);
            await conn.execute(`UPDATE employees
            SET status = 'deleted', deactivated_at = NOW(3), manager_id = NULL,
                email = ?, mobile = ?
          WHERE id = ?`, [`deleted.${employeeId}.${Date.now()}@removed.invalid`, `DEL${employeeId}`.slice(0, 20), employeeId]);
            await conn.execute("UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = 'account_deleted' WHERE employee_id = ? AND revoked_at IS NULL", [employeeId]);
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
    static async hierarchy(user) {
        const scope = await HierarchyService.scope(user);
        const scoped = scope.ids === null ? '' : scope.ids.length ? ` AND e.id IN (${scope.ids.map(() => '?').join(',')})` : ' AND 1 = 0';
        const rows = await query(`SELECT e.id, e.full_name, e.employee_code, e.manager_id, dg.title AS designation_title, d.name AS department_name,
              e.photo_url, r.slug AS role_slug, e.status
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status IN ('active','pending_approval')${scoped}
       ORDER BY r.level DESC, e.full_name`, scope.ids ?? []);
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
    static async picker(employeeId) {
        // Used for assignee/participant pickers: all active employees are visible organisation-wide
        // by design (names + designations only), never confidential records.
        return query(`SELECT e.id, e.full_name, e.employee_code, dg.title AS designation_title, d.name AS department_name, e.manager_id
       FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active'
       ORDER BY e.full_name`, []);
    }
    static async structure() {
        const [departments, designations, locations, roles] = await Promise.all([
            query(`SELECT d.id, d.name, d.code, d.head_employee_id, h.full_name AS head_name,
                (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'active') AS employee_count
         FROM departments d LEFT JOIN employees h ON h.id = d.head_employee_id ORDER BY d.name`),
            query(`SELECT g.id, g.title, g.code, g.department_id, g.level, g.reporting_designation_id, g.employment_category, g.description, g.is_active,
                (SELECT COUNT(*) FROM employees e WHERE e.designation_id = g.id AND e.status = 'active') AS employee_count,
                (SELECT GROUP_CONCAT(dl.location_id) FROM designation_locations dl WHERE dl.designation_id = g.id) AS location_ids
         FROM designations g ORDER BY g.is_active DESC, g.level DESC, g.title`),
            query(`SELECT l.id, l.name, l.code, l.city, l.state, l.address, l.timezone, l.latitude, l.longitude, l.geofence_radius_m, l.is_active,
                (SELECT COUNT(*) FROM employees e WHERE e.location_id = l.id AND e.status = 'active') AS employee_count
         FROM locations l WHERE l.is_active = 1 ORDER BY l.name`),
            query(`SELECT r.id, r.name, r.slug, r.category, r.level, r.description, r.is_system,
                (SELECT COUNT(*) FROM employees e WHERE e.role_id = r.id AND e.status = 'active') AS employee_count
         FROM roles r ORDER BY r.level DESC, r.name`),
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
            roles: roles.map((r) => ({
                ...r,
                id: Number(r.id),
                employeeCount: Number(r.employee_count),
                isSystem: Boolean(r.is_system) || r.slug === 'super_admin' || r.level >= 100,
            })),
        };
    }
    static async rolePermissions() {
        const roles = await query(`SELECT r.id, r.name, r.slug, r.level, r.description, r.is_system,
              COUNT(e.id) AS employee_count
       FROM roles r
       LEFT JOIN employees e ON e.role_id = r.id AND e.status NOT IN ('deleted', 'rejected')
       GROUP BY r.id
       ORDER BY r.level DESC, r.name ASC`);
        const permissions = await query('SELECT id, code, module, action, description FROM permissions ORDER BY module, action');
        const mapping = await query('SELECT role_id, permission_id FROM role_permissions');
        const roleLocs = await query('SELECT role_id, location_id FROM role_locations');
        return {
            roles: roles.map((r) => ({
                id: Number(r.id),
                name: r.name,
                slug: r.slug,
                level: Number(r.level),
                description: r.description,
                isSystem: Boolean(r.is_system),
                employeeCount: Number(r.employee_count || 0),
                permissions: mapping.filter((m) => Number(m.role_id) === Number(r.id)).map((m) => Number(m.permission_id)),
                locations: roleLocs.filter((l) => Number(l.role_id) === Number(r.id)).map((l) => Number(l.location_id)),
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
    static async updateRolePermissions(roleId, actor, permissionIds, ip) {
        if (!actor.permissions.includes('roles.manage') && actor.roleSlug !== 'super_admin' && (actor.roleLevel ?? 0) < 90) {
            throw ApiError.forbidden('You cannot change the permission matrix.');
        }
        const role = await queryOne('SELECT name, slug FROM roles WHERE id = ?', [roleId]);
        if (!role)
            throw ApiError.notFound('Role not found');
        const before = await query('SELECT permission_id FROM role_permissions WHERE role_id = ?', [roleId]);
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
        try {
            await execute(`INSERT INTO permission_audit_logs (actor_id, role_id, action, module, details, ip)
         VALUES (?, ?, 'permissions.updated', 'roles', ?, ?)`, [
                actor.id,
                roleId,
                JSON.stringify({
                    roleName: role.name,
                    roleSlug: role.slug,
                    count: permissionIds.length,
                    addedCount: permissionIds.filter((p) => !before.some((b) => Number(b.permission_id) === p)).length,
                    removedCount: before.filter((b) => !permissionIds.includes(Number(b.permission_id))).length,
                }),
                ip ?? null,
            ]);
        }
        catch {
            /* audit log safe fallback */
        }
    }
    static async setUserPermission(employeeId, actor, permissionId, effect) {
        if (!actor.permissions.includes('roles.manage'))
            throw ApiError.forbidden('You cannot change user permissions.');
        if (effect === 'clear') {
            await execute('DELETE FROM user_permissions WHERE employee_id = ? AND permission_id = ?', [employeeId, permissionId]);
        }
        else {
            await execute(`INSERT INTO user_permissions (employee_id, permission_id, effect, granted_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE effect = VALUES(effect), granted_by = VALUES(granted_by)`, [employeeId, permissionId, effect, actor.id]);
        }
        await recordAudit({
            actorId: actor.id,
            action: 'employee.permission_override',
            entityType: 'employee',
            entityId: employeeId,
            after: { permissionId, effect },
        });
    }
    static async createDepartment(actor, input) {
        if (!actor.permissions.includes('org.manage'))
            throw ApiError.forbidden('You cannot manage the organisation structure.');
        const duplicate = await queryOne('SELECT id FROM departments WHERE code = ?', [input.code.toUpperCase()]);
        if (duplicate)
            throw ApiError.conflict('A department with that code already exists.');
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
    static async assertNoReportingCycle(designationId, reportingId) {
        if (!reportingId)
            return;
        if (designationId && reportingId === designationId)
            throw ApiError.badRequest('A designation cannot report to itself.');
        let cursor = reportingId;
        for (let depth = 0; cursor && depth < 30; depth += 1) {
            const row = await queryOne('SELECT reporting_designation_id, is_active FROM designations WHERE id = ?', [cursor]);
            if (!row)
                throw ApiError.badRequest('The reporting designation does not exist.');
            if (depth === 0 && !row.is_active)
                throw ApiError.badRequest('The reporting designation is inactive.');
            cursor = row.reporting_designation_id ? Number(row.reporting_designation_id) : null;
            if (designationId && cursor === designationId)
                throw ApiError.badRequest('That reporting line would create a cycle.');
        }
    }
    static async validateLocations(ids) {
        const unique = [...new Set((ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
        if (unique.length === 0)
            return [];
        const rows = await query(`SELECT id FROM locations WHERE is_active = 1 AND id IN (${unique.map(() => '?').join(',')})`, unique);
        if (rows.length !== unique.length)
            throw ApiError.badRequest('One or more selected locations are invalid or inactive.');
        return unique;
    }
    static async createDesignation(actor, input) {
        if (!actor.permissions.includes('org.manage'))
            throw ApiError.forbidden('You cannot manage the organisation structure.');
        const title = input.title.trim().replace(/\s+/g, ' ');
        if (title.length < 2)
            throw ApiError.badRequest('Enter a designation title.');
        if (input.departmentId) {
            const department = await queryOne('SELECT id, code FROM departments WHERE id = ?', [input.departmentId]);
            if (!department)
                throw ApiError.badRequest('Select a valid department.');
        }
        const duplicate = await queryOne('SELECT id FROM designations WHERE title = ? AND department_id <=> ?', [title, input.departmentId ?? null]);
        if (duplicate)
            throw ApiError.conflict('This designation already exists in that department.');
        const department = input.departmentId ? await queryOne('SELECT code FROM departments WHERE id = ?', [input.departmentId]) : null;
        const code = (input.code?.trim() || `${department?.code ?? 'GEN'}-${title.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`).toUpperCase().slice(0, 32);
        if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code))
            throw ApiError.badRequest('Use 2–32 letters, digits or hyphens for the designation code.');
        if (await queryOne('SELECT id FROM designations WHERE code = ?', [code]))
            throw ApiError.conflict('That designation code is already used.');
        await EmployeeService.assertNoReportingCycle(null, input.reportingDesignationId ?? null);
        const locations = await EmployeeService.validateLocations(input.locationIds);
        const id = await transaction(async (conn) => {
            const [result] = await conn.query(`INSERT INTO designations (title, code, department_id, level, reporting_designation_id, employment_category, description, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [title, code, input.departmentId ?? null, input.level ?? 1, input.reportingDesignationId ?? null,
                input.employmentCategory ?? 'staff', input.description?.trim() || null, actor.id, actor.id]);
            for (const locationId of locations) {
                await conn.query('INSERT INTO designation_locations (designation_id, location_id) VALUES (?, ?)', [result.insertId, locationId]);
            }
            return Number(result.insertId);
        });
        await recordAudit({ actorId: actor.id, action: 'designation.created', entityType: 'designation', entityId: id, after: { ...input, code } });
        return id;
    }
    /** Updates or deactivates a designation. Employees keep their designation id; history is untouched. */
    static async updateDesignation(actor, id, input) {
        if (!actor.permissions.includes('org.manage'))
            throw ApiError.forbidden('You cannot manage the organisation structure.');
        const current = await queryOne('SELECT * FROM designations WHERE id = ?', [id]);
        if (!current)
            throw ApiError.notFound('Designation not found');
        const title = input.title === undefined ? String(current.title) : input.title.trim().replace(/\s+/g, ' ');
        const departmentId = input.departmentId === undefined ? current.department_id : input.departmentId;
        if (title.length < 2)
            throw ApiError.badRequest('Enter a designation title.');
        const duplicate = await queryOne('SELECT id FROM designations WHERE title = ? AND department_id <=> ? AND id <> ?', [title, departmentId ?? null, id]);
        if (duplicate)
            throw ApiError.conflict('Another designation with this title already exists in that department.');
        const code = input.code === undefined ? String(current.code) : input.code.trim().toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code))
            throw ApiError.badRequest('Use 2–32 letters, digits or hyphens for the designation code.');
        if (await queryOne('SELECT id FROM designations WHERE code = ? AND id <> ?', [code, id]))
            throw ApiError.conflict('That designation code is already used.');
        const reportingId = input.reportingDesignationId === undefined ? current.reporting_designation_id : input.reportingDesignationId;
        await EmployeeService.assertNoReportingCycle(id, reportingId ? Number(reportingId) : null);
        if (input.isActive === false) {
            const dependants = await queryOne('SELECT COUNT(*) AS total FROM designations WHERE reporting_designation_id = ? AND is_active = 1', [id]);
            if (Number(dependants?.total ?? 0) > 0)
                throw ApiError.conflict('Other active designations report to this one. Reassign their reporting line first.');
        }
        const locations = input.locationIds === undefined ? null : await EmployeeService.validateLocations(input.locationIds);
        await transaction(async (conn) => {
            await conn.query(`UPDATE designations SET title = ?, code = ?, department_id = ?, level = ?, reporting_designation_id = ?, employment_category = ?,
                description = ?, is_active = ?, updated_by = ? WHERE id = ?`, [title, code, departmentId ?? null, input.level ?? current.level, reportingId ?? null,
                input.employmentCategory ?? current.employment_category, input.description === undefined ? current.description : (input.description?.trim() || null),
                input.isActive === undefined ? current.is_active : (input.isActive ? 1 : 0), actor.id, id]);
            if (locations) {
                await conn.query('DELETE FROM designation_locations WHERE designation_id = ?', [id]);
                for (const locationId of locations)
                    await conn.query('INSERT INTO designation_locations (designation_id, location_id) VALUES (?, ?)', [id, locationId]);
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
    static async designationHistory(id) {
        return query(`SELECT a.action, a.before_data, a.after_data, a.created_at, e.full_name AS actor_name
       FROM audit_logs a LEFT JOIN employees e ON e.id = a.actor_id
       WHERE a.entity_type = 'designation' AND a.entity_id = ? ORDER BY a.created_at DESC LIMIT 50`, [id]);
    }
    // ----------------------------- Locations -----------------------------------
    static async createLocation(actor, input) {
        const canManage = actor.permissions.includes('locations.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('Only an administrator can add locations.');
        const code = input.code.trim().toUpperCase();
        if (!/^[A-Z0-9]{2,12}$/.test(code))
            throw ApiError.badRequest('Location codes use 2–12 letters or digits, e.g. BEL.');
        if (await queryOne('SELECT id FROM locations WHERE code = ? AND is_active = 1', [code]))
            throw ApiError.conflict('That location code is already used.');
        if (await queryOne('SELECT id FROM locations WHERE name = ? AND is_active = 1', [input.name.trim()]))
            throw ApiError.conflict('A location with that name already exists.');
        // A previously deleted (archived) location with the same code is brought back instead of duplicated.
        const archived = await queryOne('SELECT id FROM locations WHERE code = ? AND is_active = 0', [code]);
        if (archived) {
            await execute(`UPDATE locations SET name = ?, city = ?, state = ?, address = ?, timezone = ?, latitude = ?, longitude = ?, geofence_radius_m = ?, is_active = 1, updated_by = ? WHERE id = ?`, [input.name.trim(), input.city?.trim() || null, input.state?.trim() || null, input.address?.trim() || null, input.timezone ?? 'Asia/Kolkata',
                input.latitude ?? null, input.longitude ?? null, input.geofenceRadiusM ?? null, actor.id, archived.id]);
            await recordAudit({ actorId: actor.id, action: 'location.restored', entityType: 'location', entityId: archived.id, after: { ...input, code } });
            return Number(archived.id);
        }
        if (await queryOne('SELECT id FROM locations WHERE name = ?', [input.name.trim()]))
            throw ApiError.conflict('An archived location already uses that name; choose another name.');
        if ((input.latitude === undefined) !== (input.longitude === undefined))
            throw ApiError.badRequest('Provide both latitude and longitude, or neither.');
        const result = await execute(`INSERT INTO locations (name, code, city, state, address, timezone, latitude, longitude, geofence_radius_m, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [input.name.trim(), code, input.city?.trim() || null, input.state?.trim() || null, input.address?.trim() || null,
            input.timezone ?? 'Asia/Kolkata', input.latitude ?? null, input.longitude ?? null, input.geofenceRadiusM ?? null, actor.id, actor.id]);
        await recordAudit({ actorId: actor.id, action: 'location.created', entityType: 'location', entityId: result.insertId, after: { ...input, code } });
        return result.insertId;
    }
    static async updateLocation(actor, id, input) {
        const canManage = actor.permissions.includes('locations.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('Only an administrator can change locations.');
        const current = await queryOne('SELECT * FROM locations WHERE id = ?', [id]);
        if (!current)
            throw ApiError.notFound('Location not found');
        const code = input.code === undefined ? String(current.code) : input.code.trim().toUpperCase();
        if (!/^[A-Z0-9]{2,12}$/.test(code))
            throw ApiError.badRequest('Location codes use 2–12 letters or digits, e.g. BEL.');
        if (await queryOne('SELECT id FROM locations WHERE code = ? AND id <> ?', [code, id]))
            throw ApiError.conflict('That location code is already used.');
        const name = input.name === undefined ? String(current.name) : input.name.trim();
        if (await queryOne('SELECT id FROM locations WHERE name = ? AND id <> ?', [name, id]))
            throw ApiError.conflict('A location with that name already exists.');
        if (input.isActive === false) {
            const active = await queryOne("SELECT COUNT(*) AS total FROM employees WHERE location_id = ? AND status = 'active'", [id]);
            if (Number(active?.total ?? 0) > 0)
                throw ApiError.conflict(`${active?.total} active employee(s) are assigned to this location. Move them before deactivating it.`);
        }
        const pick = (value, fallback) => (value === undefined ? fallback : value);
        await execute(`UPDATE locations SET name = ?, code = ?, city = ?, state = ?, address = ?, timezone = ?, latitude = ?, longitude = ?,
              geofence_radius_m = ?, is_active = ?, updated_by = ? WHERE id = ?`, [name, code, pick(input.city, current.city), pick(input.state, current.state), pick(input.address, current.address),
            pick(input.timezone, current.timezone), pick(input.latitude, current.latitude), pick(input.longitude, current.longitude),
            pick(input.geofenceRadiusM, current.geofence_radius_m), input.isActive === undefined ? current.is_active : (input.isActive ? 1 : 0), actor.id, id]);
        await recordAudit({
            actorId: actor.id,
            action: input.isActive === false ? 'location.deactivated' : 'location.updated',
            entityType: 'location',
            entityId: id,
            before: { name: current.name, code: current.code, isActive: Boolean(current.is_active) },
            after: { ...input, name, code },
        });
    }
    /**
     * Deletes a location. Its employees must be moved first (moveToLocationId). The row is removed
     * when nothing else refers to it; otherwise (e.g. historical leave requests) it is archived:
     * hidden everywhere, its code freed, and its history kept.
     */
    static async deleteLocation(actor, id, moveToLocationId, ip) {
        const canManage = actor.permissions.includes('locations.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('Only an administrator can delete locations.');
        const location = await queryOne('SELECT id, code, name, is_active FROM locations WHERE id = ?', [id]);
        if (!location || !Number(location.is_active))
            throw ApiError.notFound('Location not found');
        const remaining = await queryOne('SELECT COUNT(*) AS total FROM locations WHERE is_active = 1 AND id <> ?', [id]);
        if (Number(remaining?.total ?? 0) === 0)
            throw ApiError.conflict('The last location cannot be deleted.');
        const staff = await query("SELECT id FROM employees WHERE location_id = ? AND status NOT IN ('deleted','rejected')", [id]);
        let target = null;
        if (staff.length) {
            if (!moveToLocationId) {
                throw ApiError.conflict(`${staff.length} employee(s) are assigned to ${location.code}. Choose the location they should move to.`);
            }
            if (moveToLocationId === id)
                throw ApiError.badRequest('Choose a different location to move the employees to.');
            target = await queryOne('SELECT id, code FROM locations WHERE id = ? AND is_active = 1', [moveToLocationId]);
            if (!target)
                throw ApiError.badRequest('The location to move employees to does not exist.');
        }
        const outcome = await transaction(async (conn) => {
            if (target && staff.length) {
                const ids = staff.map((s) => Number(s.id));
                await conn.query(`UPDATE employees SET location_id = ?, group_id = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, [target.id, ...ids]);
            }
            await conn.query('UPDATE workforce_groups SET is_active = 0 WHERE location_id = ?', [id]).catch(() => undefined);
            await conn.query('DELETE FROM employee_locations WHERE location_id = ?', [id]);
            await conn.query('DELETE FROM location_hr_assignments WHERE location_id = ?', [id]).catch(() => undefined);
            try {
                await conn.query('SAVEPOINT before_location_delete');
                await conn.query('DELETE FROM locations WHERE id = ?', [id]);
                return 'removed';
            }
            catch (error) {
                if (error.code !== 'ER_ROW_IS_REFERENCED_2' && error.code !== 'ER_ROW_IS_REFERENCED')
                    throw error;
                await conn.query('ROLLBACK TO SAVEPOINT before_location_delete');
                await conn.query('UPDATE locations SET is_active = 0, code = ?, name = ?, updated_by = ? WHERE id = ?', [
                    `${location.code}~${id}`.slice(0, 24), `${location.name} (deleted)`.slice(0, 120), actor.id, id,
                ]);
                return 'archived';
            }
        });
        await recordAudit({
            actorId: actor.id, action: 'location.deleted', entityType: 'location', entityId: id, ip,
            before: { code: location.code, name: location.name, employees: staff.length },
            after: { outcome, movedTo: target?.code ?? null, movedEmployeeIds: staff.map((s) => Number(s.id)) },
        });
        await HierarchyService.ensureStructure(actor.id).catch((error) => console.warn('[hierarchy] ensure failed', error));
        return { outcome, moved: staff.length, movedTo: target?.code ?? null };
    }
    /** Additional locations an employee may access beyond their primary location. */
    static async setEmployeeLocations(actor, employeeId, locationIds) {
        if (!actor.permissions.includes('org.manage') && !actor.permissions.includes('employees.manage'))
            throw ApiError.forbidden('You cannot change location access.');
        const employee = await queryOne('SELECT id FROM employees WHERE id = ?', [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found');
        const locations = await EmployeeService.validateLocations(locationIds);
        const before = await query('SELECT location_id FROM employee_locations WHERE employee_id = ?', [employeeId]);
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
    static async employeeLocations(employeeId) {
        const rows = await query('SELECT location_id FROM employee_locations WHERE employee_id = ?', [employeeId]);
        return rows.map((row) => Number(row.location_id));
    }
    static async updateRoleDetails(actor, roleId, input) {
        const canManage = actor.permissions.includes('roles.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('You cannot manage roles.');
        const role = await queryOne('SELECT id, slug, level, is_system FROM roles WHERE id = ?', [roleId]);
        if (!role)
            throw ApiError.notFound('Role not found');
        if (role.slug === 'super_admin' && input.level !== undefined && input.level < 100) {
            throw ApiError.badRequest('Super Admin role must remain at hierarchy level 100.');
        }
        const cleanSlug = input.slug ? input.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') : undefined;
        if (cleanSlug && cleanSlug !== role.slug) {
            if (role.slug === 'super_admin')
                throw ApiError.badRequest('Super Admin slug cannot be changed.');
            const exists = await queryOne('SELECT id FROM roles WHERE slug = ? AND id <> ?', [cleanSlug, roleId]);
            if (exists)
                throw ApiError.conflict('A role with that slug already exists.');
        }
        await execute('UPDATE roles SET name = COALESCE(?, name), slug = COALESCE(?, slug), description = COALESCE(?, description), level = COALESCE(?, level) WHERE id = ?', [
            input.name?.trim() ?? null,
            cleanSlug ?? null,
            input.description ?? null,
            input.level ?? null,
            roleId,
        ]);
        await recordAudit({ actorId: actor.id, action: 'role.updated', entityType: 'role', entityId: roleId, after: input });
    }
    static async createRole(actor, input) {
        const canManage = actor.permissions.includes('roles.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('You cannot create roles.');
        const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (!slug)
            throw ApiError.badRequest('A valid role slug is required.');
        const duplicate = await queryOne('SELECT id FROM roles WHERE slug = ?', [slug]);
        if (duplicate)
            throw ApiError.conflict('A role with that identifier already exists.');
        const result = await execute('INSERT INTO roles (name, slug, category, level, description) VALUES (?, ?, ?, ?, ?)', [
            input.name.trim(),
            slug,
            input.category ?? 'general',
            input.level ?? 20,
            input.description?.trim() || null,
        ]);
        await recordAudit({ actorId: actor.id, action: 'role.created', entityType: 'role', entityId: result.insertId, after: input });
        return result.insertId;
    }
    static async deleteRole(actor, roleId, moveToRoleId, ip) {
        const canManage = actor.permissions.includes('roles.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('Only an administrator can delete roles.');
        const role = await queryOne('SELECT id, name, slug, level, is_system FROM roles WHERE id = ?', [roleId]);
        if (!role)
            throw ApiError.notFound('Role not found');
        if (role.slug === 'super_admin' || role.level >= 100 || Number(role.is_system) === 1) {
            throw ApiError.badRequest('Core system roles like Super Admin cannot be deleted.');
        }
        const staff = await query("SELECT id FROM employees WHERE role_id = ? AND status NOT IN ('deleted', 'rejected')", [roleId]);
        if (staff.length > 0) {
            if (!moveToRoleId) {
                throw ApiError.conflict(`${staff.length} active employee(s) are assigned to the "${role.name}" role. Choose a replacement role to transfer them to.`);
            }
            if (moveToRoleId === roleId)
                throw ApiError.badRequest('Choose a different replacement role.');
            const targetRole = await queryOne('SELECT id, name FROM roles WHERE id = ?', [moveToRoleId]);
            if (!targetRole)
                throw ApiError.badRequest('Target replacement role not found.');
            const ids = staff.map((s) => Number(s.id));
            await execute(`UPDATE employees SET role_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [targetRole.id, ...ids]);
        }
        await execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
        await execute('DELETE FROM roles WHERE id = ?', [roleId]);
        await recordAudit({ actorId: actor.id, action: 'role.deleted', entityType: 'role', entityId: roleId, before: role, ip });
        try {
            await execute(`INSERT INTO permission_audit_logs (actor_id, role_id, action, module, details, ip)
         VALUES (?, ?, 'role.deleted', 'roles', ?, ?)`, [actor.id, roleId, JSON.stringify({ name: role.name, slug: role.slug, transferred: staff.length }), ip ?? null]);
        }
        catch {
            /* audit log safe fallback */
        }
        return { ok: true, moved: staff.length };
    }
    static async duplicateRole(actor, sourceRoleId, ip) {
        const canManage = actor.permissions.includes('roles.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('You cannot duplicate roles.');
        const source = await queryOne('SELECT id, name, slug, level, description, category FROM roles WHERE id = ?', [sourceRoleId]);
        if (!source)
            throw ApiError.notFound('Source role not found');
        const suffix = Date.now().toString(36).slice(-4);
        const newName = `${source.name} (Copy)`;
        const newSlug = `${source.slug.slice(0, 50)}_copy_${suffix}`;
        const res = await execute('INSERT INTO roles (name, slug, category, level, description) VALUES (?, ?, ?, ?, ?)', [newName, newSlug, source.category || 'general', source.level, source.description]);
        const newRoleId = res.insertId;
        // Clone all permissions
        await execute('INSERT INTO role_permissions (role_id, permission_id) SELECT ?, permission_id FROM role_permissions WHERE role_id = ?', [newRoleId, sourceRoleId]);
        // Clone all locations
        await execute('INSERT INTO role_locations (role_id, location_id, granted_by) SELECT ?, location_id, ? FROM role_locations WHERE role_id = ?', [newRoleId, actor.id, sourceRoleId]);
        await recordAudit({
            actorId: actor.id,
            action: 'role.duplicated',
            entityType: 'role',
            entityId: newRoleId,
            after: { sourceRoleId, name: newName, slug: newSlug },
            ip,
        });
        try {
            await execute(`INSERT INTO permission_audit_logs (actor_id, role_id, action, module, details, ip)
         VALUES (?, ?, 'role.duplicated', 'roles', ?, ?)`, [actor.id, newRoleId, JSON.stringify({ sourceRoleId, sourceName: source.name, newName, newSlug }), ip ?? null]);
        }
        catch {
            /* ignore */
        }
        return { id: newRoleId, name: newName, slug: newSlug };
    }
    static async getRoleEmployees(roleId) {
        const rows = await query(`SELECT e.id, e.employee_code AS employeeCode, e.full_name AS fullName, e.email, e.mobile,
              e.photo_url AS photoUrl, e.status,
              d.name AS departmentName, dg.title AS designationTitle,
              l.name AS locationName, l.code AS locationCode
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.role_id = ? AND e.status NOT IN ('deleted', 'rejected')
       ORDER BY e.full_name ASC`, [roleId]);
        return rows;
    }
    static async assignEmployeeToRole(actor, roleId, employeeId, ip) {
        const canManage = actor.permissions.includes('roles.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('You cannot assign roles to employees.');
        const role = await queryOne('SELECT id, name, slug FROM roles WHERE id = ?', [roleId]);
        if (!role)
            throw ApiError.notFound('Role not found');
        const emp = await queryOne('SELECT e.id, e.full_name, e.role_id, r.name AS role_name FROM employees e LEFT JOIN roles r ON r.id = e.role_id WHERE e.id = ?', [employeeId]);
        if (!emp)
            throw ApiError.notFound('Employee not found');
        await execute('UPDATE employees SET role_id = ? WHERE id = ?', [roleId, employeeId]);
        await recordAudit({
            actorId: actor.id,
            action: 'employee.role_assigned',
            entityType: 'employee',
            entityId: employeeId,
            before: { roleId: emp.role_id, roleName: emp.role_name },
            after: { roleId, roleName: role.name },
            ip,
        });
        try {
            await execute(`INSERT INTO permission_audit_logs (actor_id, role_id, employee_id, action, module, details, ip)
         VALUES (?, ?, ?, 'employee.role_assigned', 'roles', ?, ?)`, [actor.id, roleId, employeeId, JSON.stringify({ employeeName: emp.full_name, previousRole: emp.role_name, newRole: role.name }), ip ?? null]);
        }
        catch {
            /* ignore */
        }
        return { ok: true, roleName: role.name };
    }
    static async unassignEmployeeFromRole(actor, roleId, employeeId, targetRoleId, ip) {
        const canManage = actor.permissions.includes('roles.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('You cannot unassign employees.');
        let fallbackId = targetRoleId;
        if (!fallbackId) {
            const defaultRole = await queryOne('SELECT id FROM roles WHERE slug = "employee" LIMIT 1');
            fallbackId = defaultRole ? defaultRole.id : 1;
        }
        return await EmployeeService.assignEmployeeToRole(actor, fallbackId, employeeId, ip);
    }
    static async getRoleLocations(roleId) {
        const rows = await query('SELECT location_id FROM role_locations WHERE role_id = ?', [roleId]);
        return rows.map((r) => Number(r.location_id));
    }
    static async setRoleLocations(actor, roleId, locationIds, ip) {
        const canManage = actor.permissions.includes('roles.manage') || actor.permissions.includes('org.manage') || actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!canManage)
            throw ApiError.forbidden('You cannot change role location access.');
        const role = await queryOne('SELECT id, name FROM roles WHERE id = ?', [roleId]);
        if (!role)
            throw ApiError.notFound('Role not found');
        await execute('DELETE FROM role_locations WHERE role_id = ?', [roleId]);
        for (const locId of locationIds) {
            await execute('INSERT IGNORE INTO role_locations (role_id, location_id, granted_by) VALUES (?, ?, ?)', [roleId, locId, actor.id]);
        }
        await recordAudit({
            actorId: actor.id,
            action: 'role.locations_updated',
            entityType: 'role',
            entityId: roleId,
            after: { locationIds },
            ip,
        });
        try {
            await execute(`INSERT INTO permission_audit_logs (actor_id, role_id, action, module, details, ip)
         VALUES (?, ?, 'role.locations_updated', 'locations', ?, ?)`, [actor.id, roleId, JSON.stringify({ roleName: role.name, locationIds }), ip ?? null]);
        }
        catch {
            /* ignore */
        }
        return locationIds;
    }
    static async getPermissionAuditLogs(limit = 60) {
        const rows = await query(`SELECT pal.id, pal.action, pal.module, pal.details, pal.ip, pal.created_at AS createdAt,
              actor.full_name AS actorName, actor.employee_code AS actorCode,
              r.name AS roleName, r.slug AS roleSlug,
              emp.full_name AS employeeName, emp.employee_code AS employeeCode
       FROM permission_audit_logs pal
       LEFT JOIN employees actor ON actor.id = pal.actor_id
       LEFT JOIN roles r ON r.id = pal.role_id
       LEFT JOIN employees emp ON emp.id = pal.employee_id
       ORDER BY pal.created_at DESC
       LIMIT ?`, [limit]);
        return rows;
    }
}
//# sourceMappingURL=EmployeeService.js.map