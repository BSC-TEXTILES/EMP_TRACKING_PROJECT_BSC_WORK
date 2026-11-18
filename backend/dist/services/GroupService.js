import { execute, query, queryOne, transaction } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { allowedLocationIds, requestedLocation } from '../lib/scope.js';
export class GroupService {
    /**
     * Log administrative location and group actions to the immutable audit table.
     */
    static async logLocationAudit(params) {
        try {
            await execute(`INSERT INTO workforce_location_audit_logs 
          (actor_id, actor_name, action, target_employee_id, target_employee_name,
           group_id, group_name, from_location_id, from_location_name,
           to_location_id, to_location_name, details, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                params.actor.id,
                params.actor.fullName,
                params.action,
                params.targetEmployeeId ?? null,
                params.targetEmployeeName ?? null,
                params.groupId ?? null,
                params.groupName ?? null,
                params.fromLocationId ?? null,
                params.fromLocationName ?? null,
                params.toLocationId ?? null,
                params.toLocationName ?? null,
                params.details ? JSON.stringify(params.details) : null,
                params.ipAddress ?? null,
            ]);
        }
        catch (err) {
            console.error('[GroupService.logLocationAudit] Failed to log location audit:', err);
        }
    }
    /**
     * List all workforce groups within the user's permitted locations.
     */
    static async list(user, filters = {}) {
        const allowedLocs = await allowedLocationIds(user);
        const clauses = [];
        const params = [];
        // Location access constraint
        if (allowedLocs !== null) {
            if (allowedLocs.length === 0)
                return [];
            clauses.push(`g.location_id IN (${allowedLocs.map(() => '?').join(',')})`);
            params.push(...allowedLocs);
        }
        // Explicit location filter requested by caller
        if (filters.locationId) {
            const targetLoc = await requestedLocation(user, filters.locationId);
            if (targetLoc) {
                clauses.push('g.location_id = ?');
                params.push(targetLoc);
            }
        }
        if (filters.isActive !== undefined) {
            clauses.push('g.is_active = ?');
            params.push(filters.isActive ? 1 : 0);
        }
        if (filters.search && filters.search.trim()) {
            clauses.push('(g.name LIKE ? OR g.code LIKE ? OR l.name LIKE ?)');
            const term = `%${filters.search.trim()}%`;
            params.push(term, term, term);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        return query(`SELECT g.id, g.name, g.code, g.location_id, g.manager_id, g.team_leader_id,
              g.description, g.is_active, g.created_at, g.updated_at,
              l.name AS location_name, l.code AS location_code,
              m.full_name AS manager_name, m.employee_code AS manager_code, m.email AS manager_email,
              tl.full_name AS team_leader_name, tl.employee_code AS team_leader_code,
              (SELECT COUNT(*) FROM employees e WHERE e.group_id = g.id AND e.status = 'active') AS member_count,
              (SELECT COUNT(*) FROM employees e 
               JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
               WHERE e.group_id = g.id AND e.status = 'active' AND a.check_in_at IS NOT NULL) AS present_count
       FROM workforce_groups g
       JOIN locations l ON l.id = g.location_id
       LEFT JOIN employees m ON m.id = g.manager_id
       LEFT JOIN employees tl ON tl.id = g.team_leader_id
       ${where}
       ORDER BY l.name, g.name`, params);
    }
    /**
     * Get single group details with members list.
     */
    static async get(user, id) {
        const group = await queryOne(`SELECT g.id, g.name, g.code, g.location_id, g.manager_id, g.team_leader_id,
              g.description, g.is_active, g.created_at, g.updated_at,
              l.name AS location_name, l.code AS location_code,
              m.full_name AS manager_name, m.employee_code AS manager_code, m.email AS manager_email,
              tl.full_name AS team_leader_name, tl.employee_code AS team_leader_code,
              (SELECT COUNT(*) FROM employees e WHERE e.group_id = g.id AND e.status = 'active') AS member_count,
              (SELECT COUNT(*) FROM employees e 
               JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
               WHERE e.group_id = g.id AND e.status = 'active' AND a.check_in_at IS NOT NULL) AS present_count
       FROM workforce_groups g
       JOIN locations l ON l.id = g.location_id
       LEFT JOIN employees m ON m.id = g.manager_id
       LEFT JOIN employees tl ON tl.id = g.team_leader_id
       WHERE g.id = ?`, [id]);
        if (!group)
            throw ApiError.notFound('Workforce group not found.');
        const allowedLocs = await allowedLocationIds(user);
        if (allowedLocs !== null && !allowedLocs.includes(Number(group.location_id))) {
            throw ApiError.forbidden('You do not have access to groups in this location.');
        }
        const members = await query(`SELECT e.id AS employee_id, e.full_name, e.employee_code, e.email, e.photo_url,
              dg.title AS designation_title, d.name AS department_name,
              l.name AS location_name, l.code AS location_code,
              CASE 
                WHEN e.id = g.manager_id THEN 'manager'
                WHEN e.id = g.team_leader_id THEN 'team_leader'
                ELSE COALESCE(egm.role, 'member')
              END AS role,
              a.status AS attendance_status,
              (SELECT s.id IS NOT NULL FROM monitoring_sessions s WHERE s.employee_id = e.id AND s.status = 'active' LIMIT 1) AS is_online,
              COALESCE(egm.created_at, e.created_at) AS joined_at
       FROM employees e
       JOIN workforce_groups g ON g.id = ?
       LEFT JOIN employee_group_members egm ON egm.group_id = g.id AND egm.employee_id = e.id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
       WHERE e.group_id = ? AND e.status = 'active'
       ORDER BY (e.id = g.manager_id) DESC, (e.id = g.team_leader_id) DESC, e.full_name`, [id, id]);
        return { group, members };
    }
    /**
     * Create a new group belonging to a specific location.
     */
    static async create(actor, input, context = {}) {
        if (!actor.permissions.includes('groups.manage')) {
            throw ApiError.forbidden('You are not authorized to create workforce groups.');
        }
        const allowedLocs = await allowedLocationIds(actor);
        if (allowedLocs !== null && !allowedLocs.includes(Number(input.locationId))) {
            throw ApiError.forbidden('You cannot create groups in an unauthorized location.');
        }
        const location = await queryOne('SELECT id, name, code FROM locations WHERE id = ? AND is_active = 1', [input.locationId]);
        if (!location)
            throw ApiError.badRequest('Selected location is invalid or inactive.');
        const name = input.name.trim();
        if (!name)
            throw ApiError.badRequest('Group name is required.');
        const existing = await queryOne('SELECT id FROM workforce_groups WHERE location_id = ? AND name = ?', [input.locationId, name]);
        if (existing)
            throw ApiError.conflict(`A group named "${name}" already exists in ${location.name}.`);
        // Verify manager and team leader belongs to same location (unless Super Admin)
        if (input.managerId) {
            const mgr = await queryOne('SELECT id, location_id, full_name FROM employees WHERE id = ?', [input.managerId]);
            if (!mgr)
                throw ApiError.badRequest('Selected manager does not exist.');
            if (actor.roleLevel < 100 && mgr.location_id !== input.locationId) {
                throw ApiError.badRequest(`Manager ${mgr.full_name} is assigned to a different location.`);
            }
        }
        if (input.teamLeaderId) {
            const tl = await queryOne('SELECT id, location_id, full_name FROM employees WHERE id = ?', [input.teamLeaderId]);
            if (!tl)
                throw ApiError.badRequest('Selected team leader does not exist.');
            if (actor.roleLevel < 100 && tl.location_id !== input.locationId) {
                throw ApiError.badRequest(`Team leader ${tl.full_name} is assigned to a different location.`);
            }
        }
        const code = input.code?.trim() || `${location.code}-GRP-${name.slice(0, 3).toUpperCase()}`;
        const insertResult = await execute(`INSERT INTO workforce_groups 
        (name, code, location_id, manager_id, team_leader_id, description, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`, [
            name,
            code,
            input.locationId,
            input.managerId ?? null,
            input.teamLeaderId ?? null,
            input.description?.trim() ?? null,
            actor.id,
        ]);
        const groupId = Number(insertResult.insertId);
        // If manager or team leader assigned, add to group members
        if (input.managerId) {
            await execute('INSERT IGNORE INTO employee_group_members (group_id, employee_id, role, assigned_by) VALUES (?, ?, ?, ?)', [groupId, input.managerId, 'manager', actor.id]);
            await execute('UPDATE employees SET group_id = COALESCE(group_id, ?) WHERE id = ?', [groupId, input.managerId]);
        }
        if (input.teamLeaderId) {
            await execute('INSERT IGNORE INTO employee_group_members (group_id, employee_id, role, assigned_by) VALUES (?, ?, ?, ?)', [groupId, input.teamLeaderId, 'team_leader', actor.id]);
            await execute('UPDATE employees SET group_id = COALESCE(group_id, ?) WHERE id = ?', [groupId, input.teamLeaderId]);
        }
        await this.logLocationAudit({
            actor,
            action: 'group.created',
            groupId,
            groupName: name,
            toLocationId: location.id,
            toLocationName: location.name,
            details: { code, managerId: input.managerId, teamLeaderId: input.teamLeaderId },
            ipAddress: context.ip,
        });
        return groupId;
    }
    /**
     * Update group details.
     */
    static async update(actor, id, input, context = {}) {
        if (!actor.permissions.includes('groups.manage')) {
            throw ApiError.forbidden('You are not authorized to update workforce groups.');
        }
        const current = await queryOne(`SELECT g.id, g.name, g.code, g.location_id, l.name AS location_name, g.manager_id, g.team_leader_id
       FROM workforce_groups g
       JOIN locations l ON l.id = g.location_id
       WHERE g.id = ?`, [id]);
        if (!current)
            throw ApiError.notFound('Workforce group not found.');
        const allowedLocs = await allowedLocationIds(actor);
        if (allowedLocs !== null && !allowedLocs.includes(Number(current.location_id))) {
            throw ApiError.forbidden('You do not have permission to manage groups in this location.');
        }
        const updates = ['updated_by = ?'];
        const params = [actor.id];
        if (input.name !== undefined) {
            const name = input.name.trim();
            if (!name)
                throw ApiError.badRequest('Group name cannot be blank.');
            updates.push('name = ?');
            params.push(name);
        }
        if (input.code !== undefined) {
            updates.push('code = ?');
            params.push(input.code?.trim() ?? null);
        }
        if (input.description !== undefined) {
            updates.push('description = ?');
            params.push(input.description?.trim() ?? null);
        }
        if (input.isActive !== undefined) {
            updates.push('is_active = ?');
            params.push(input.isActive ? 1 : 0);
        }
        if (input.managerId !== undefined) {
            updates.push('manager_id = ?');
            params.push(input.managerId ?? null);
            if (input.managerId) {
                await execute('INSERT IGNORE INTO employee_group_members (group_id, employee_id, role, assigned_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = ?', [id, input.managerId, 'manager', actor.id, 'manager']);
            }
        }
        if (input.teamLeaderId !== undefined) {
            updates.push('team_leader_id = ?');
            params.push(input.teamLeaderId ?? null);
            if (input.teamLeaderId) {
                await execute('INSERT IGNORE INTO employee_group_members (group_id, employee_id, role, assigned_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = ?', [id, input.teamLeaderId, 'team_leader', actor.id, 'team_leader']);
            }
        }
        // Transfer group between locations
        let newLocation = null;
        if (input.locationId !== undefined && input.locationId !== current.location_id) {
            if (!actor.permissions.includes('employees.transfer')) {
                throw ApiError.forbidden('Only Administrators can transfer groups between locations.');
            }
            newLocation = await queryOne('SELECT id, name FROM locations WHERE id = ? AND is_active = 1', [input.locationId]);
            if (!newLocation)
                throw ApiError.badRequest('Target location is invalid.');
            updates.push('location_id = ?');
            params.push(input.locationId);
            // Reassign all member employees to the new location
            await execute('UPDATE employees SET location_id = ? WHERE group_id = ?', [input.locationId, id]);
        }
        params.push(id);
        await execute(`UPDATE workforce_groups SET ${updates.join(', ')} WHERE id = ?`, params);
        await this.logLocationAudit({
            actor,
            action: newLocation ? 'group.transferred' : 'group.updated',
            groupId: id,
            groupName: input.name ?? current.name,
            fromLocationId: current.location_id,
            fromLocationName: current.location_name,
            toLocationId: newLocation ? newLocation.id : current.location_id,
            toLocationName: newLocation ? newLocation.name : current.location_name,
            details: { input },
            ipAddress: context.ip,
        });
    }
    /**
     * Delete or deactivate group.
     */
    static async delete(actor, id, context = {}) {
        if (!actor.permissions.includes('groups.manage')) {
            throw ApiError.forbidden('You are not authorized to delete workforce groups.');
        }
        const current = await queryOne(`SELECT g.id, g.name, g.location_id, l.name AS location_name
       FROM workforce_groups g
       JOIN locations l ON l.id = g.location_id
       WHERE g.id = ?`, [id]);
        if (!current)
            throw ApiError.notFound('Workforce group not found.');
        const allowedLocs = await allowedLocationIds(actor);
        if (allowedLocs !== null && !allowedLocs.includes(Number(current.location_id))) {
            throw ApiError.forbidden('You do not have permission to delete groups in this location.');
        }
        await transaction(async (conn) => {
            await conn.query('UPDATE employees SET group_id = NULL WHERE group_id = ?', [id]);
            await conn.query('DELETE FROM employee_group_members WHERE group_id = ?', [id]);
            await conn.query('DELETE FROM workforce_groups WHERE id = ?', [id]);
        });
        await this.logLocationAudit({
            actor,
            action: 'group.deleted',
            groupId: id,
            groupName: current.name,
            fromLocationId: current.location_id,
            fromLocationName: current.location_name,
            ipAddress: context.ip,
        });
    }
    /**
     * Add an employee to a group.
     */
    static async addMember(actor, groupId, employeeId, role = 'member', context = {}) {
        const group = await queryOne(`SELECT g.id, g.name, g.location_id, l.name AS location_name
       FROM workforce_groups g
       JOIN locations l ON l.id = g.location_id
       WHERE g.id = ?`, [groupId]);
        if (!group)
            throw ApiError.notFound('Workforce group not found.');
        const allowedLocs = await allowedLocationIds(actor);
        if (allowedLocs !== null && !allowedLocs.includes(Number(group.location_id))) {
            throw ApiError.forbidden('You cannot manage groups outside your permitted locations.');
        }
        const employee = await queryOne(`SELECT e.id, e.full_name, e.location_id, l.name AS location_name
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`, [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found.');
        // Enforce location boundary: employee must belong to group's location, or be transferred by Admin
        if (employee.location_id !== group.location_id) {
            if (!actor.permissions.includes('employees.transfer')) {
                throw ApiError.forbidden(`Cannot add ${employee.full_name} (${employee.location_name}) to ${group.name} (${group.location_name}). Transfer the employee's location first.`);
            }
            // Auto-transfer location if authorized Admin
            await execute('UPDATE employees SET location_id = ? WHERE id = ?', [group.location_id, employeeId]);
        }
        await transaction(async (conn) => {
            await conn.query('UPDATE employees SET group_id = ? WHERE id = ?', [groupId, employeeId]);
            await conn.query(`INSERT INTO employee_group_members (group_id, employee_id, role, assigned_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), assigned_by = VALUES(assigned_by)`, [groupId, employeeId, role, actor.id]);
            if (role === 'team_leader') {
                await conn.query('UPDATE workforce_groups SET team_leader_id = ? WHERE id = ?', [employeeId, groupId]);
            }
            else if (role === 'manager') {
                await conn.query('UPDATE workforce_groups SET manager_id = ? WHERE id = ?', [employeeId, groupId]);
            }
        });
        await this.logLocationAudit({
            actor,
            action: 'employee.group_assigned',
            targetEmployeeId: employeeId,
            targetEmployeeName: employee.full_name,
            groupId,
            groupName: group.name,
            toLocationId: group.location_id,
            toLocationName: group.location_name,
            details: { role },
            ipAddress: context.ip,
        });
    }
    /**
     * Remove an employee from a group.
     */
    static async removeMember(actor, groupId, employeeId, context = {}) {
        const group = await queryOne(`SELECT g.id, g.name, g.location_id, l.name AS location_name
       FROM workforce_groups g
       JOIN locations l ON l.id = g.location_id
       WHERE g.id = ?`, [groupId]);
        if (!group)
            throw ApiError.notFound('Workforce group not found.');
        const allowedLocs = await allowedLocationIds(actor);
        if (allowedLocs !== null && !allowedLocs.includes(Number(group.location_id))) {
            throw ApiError.forbidden('You cannot manage groups outside your permitted locations.');
        }
        const employee = await queryOne('SELECT id, full_name FROM employees WHERE id = ?', [employeeId]);
        await transaction(async (conn) => {
            await conn.query('UPDATE employees SET group_id = NULL WHERE id = ? AND group_id = ?', [employeeId, groupId]);
            await conn.query('DELETE FROM employee_group_members WHERE group_id = ? AND employee_id = ?', [groupId, employeeId]);
            await conn.query('UPDATE workforce_groups SET team_leader_id = NULL WHERE id = ? AND team_leader_id = ?', [groupId, employeeId]);
            await conn.query('UPDATE workforce_groups SET manager_id = NULL WHERE id = ? AND manager_id = ?', [groupId, employeeId]);
        });
        await this.logLocationAudit({
            actor,
            action: 'employee.group_removed',
            targetEmployeeId: employeeId,
            targetEmployeeName: employee?.full_name ?? 'Unknown',
            groupId,
            groupName: group.name,
            fromLocationId: group.location_id,
            fromLocationName: group.location_name,
            ipAddress: context.ip,
        });
    }
    /**
     * Location-based workforce dashboard summary.
     * Auto-filtered to user's assigned location(s), with group-wise breakdown.
     */
    static async dashboardSummary(user, explicitLocationId) {
        const allowedLocs = await allowedLocationIds(user);
        let targetLocationId = null;
        if (explicitLocationId) {
            targetLocationId = await requestedLocation(user, explicitLocationId);
        }
        else if (allowedLocs !== null && allowedLocs.length === 1) {
            targetLocationId = allowedLocs[0];
        }
        else if (allowedLocs !== null && user.locationId && allowedLocs.includes(Number(user.locationId))) {
            targetLocationId = Number(user.locationId);
        }
        // Determine query scope
        const empWhereClauses = ["e.status = 'active'"];
        const empParams = [];
        if (targetLocationId) {
            empWhereClauses.push('e.location_id = ?');
            empParams.push(targetLocationId);
        }
        else if (allowedLocs !== null) {
            if (allowedLocs.length === 0) {
                empWhereClauses.push('1 = 0');
            }
            else {
                empWhereClauses.push(`e.location_id IN (${allowedLocs.map(() => '?').join(',')})`);
                empParams.push(...allowedLocs);
            }
        }
        const empWhere = empWhereClauses.join(' AND ');
        // Metrics query
        const [counts, groupsList] = await Promise.all([
            queryOne(`SELECT 
          COUNT(e.id) AS total,
          SUM(a.check_in_at IS NOT NULL AND a.check_out_at IS NULL) AS present,
          SUM(a.check_in_at IS NULL OR a.status = 'absent') AS absent,
          SUM(s.id IS NOT NULL AND s.status = 'active') AS online,
          SUM(s.id IS NOT NULL AND s.status = 'active' AND COALESCE(s.idle_seconds, 0) < 300) AS working,
          SUM(EXISTS(
            SELECT 1 FROM meeting_participants mp 
            JOIN meetings m ON m.id = mp.meeting_id 
            WHERE mp.employee_id = e.id AND m.status = 'ongoing'
          )) AS meetings,
          SUM(EXISTS(
            SELECT 1 FROM attendance_breaks ab 
            WHERE ab.attendance_id = a.id AND ab.end_time IS NULL
          )) AS breaks
        FROM employees e
        LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
        LEFT JOIN monitoring_sessions s ON s.employee_id = e.id AND s.status = 'active'
        WHERE ${empWhere}`, empParams),
            query(`SELECT g.id, g.name, g.code, l.name AS location_name, l.code AS location_code,
                m.full_name AS manager_name, tl.full_name AS team_leader_name,
                (SELECT COUNT(*) FROM employees e WHERE e.group_id = g.id AND e.status = 'active') AS total_members,
                (SELECT COUNT(*) FROM employees e 
                 JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
                 WHERE e.group_id = g.id AND e.status = 'active' AND a.check_in_at IS NOT NULL) AS present_count,
                (SELECT COUNT(*) FROM employees e 
                 JOIN monitoring_sessions s ON s.employee_id = e.id AND s.status = 'active'
                 WHERE e.group_id = g.id AND e.status = 'active') AS online_count
         FROM workforce_groups g
         JOIN locations l ON l.id = g.location_id
         LEFT JOIN employees m ON m.id = g.manager_id
         LEFT JOIN employees tl ON tl.id = g.team_leader_id
         WHERE g.is_active = 1 ${targetLocationId ? 'AND g.location_id = ?' : (allowedLocs !== null ? `AND g.location_id IN (${allowedLocs.map(() => '?').join(',')})` : '')}
         ORDER BY l.name, g.name`, targetLocationId ? [targetLocationId] : (allowedLocs !== null ? allowedLocs : [])),
        ]);
        // Selected location info
        let selectedLocation = null;
        if (targetLocationId) {
            selectedLocation = await queryOne('SELECT id, name, code FROM locations WHERE id = ?', [targetLocationId]);
        }
        // Location-wise breakdown for multi-location admins
        let locationSummaries;
        if (allowedLocs === null || allowedLocs.length > 1) {
            const locList = await query(`SELECT 
           l.id AS locationId,
           l.name AS locationName,
           l.code AS locationCode,
           COUNT(e.id) AS totalEmployees,
           SUM(a.check_in_at IS NOT NULL AND a.check_out_at IS NULL) AS presentEmployees,
           SUM(a.check_in_at IS NULL OR a.status = 'absent') AS absentEmployees,
           SUM(s.id IS NOT NULL AND s.status = 'active') AS onlineEmployees,
           SUM(s.id IS NOT NULL AND s.status = 'active' AND COALESCE(s.idle_seconds, 0) < 300) AS workingEmployees,
           SUM(EXISTS(
             SELECT 1 FROM meeting_participants mp 
             JOIN meetings m ON m.id = mp.meeting_id 
             WHERE mp.employee_id = e.id AND m.status = 'ongoing'
           )) AS inMeetings,
           SUM(EXISTS(
             SELECT 1 FROM attendance_breaks ab 
             WHERE ab.attendance_id = a.id AND ab.end_time IS NULL
           )) AS onBreak,
           (SELECT COUNT(*) FROM workforce_groups wg WHERE wg.location_id = l.id AND wg.is_active = 1) AS groupCount
         FROM locations l
         LEFT JOIN employees e ON e.location_id = l.id AND e.status = 'active'
         LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = CURDATE()
         LEFT JOIN monitoring_sessions s ON s.employee_id = e.id AND s.status = 'active'
         WHERE l.is_active = 1 ${allowedLocs !== null ? `AND l.id IN (${allowedLocs.map(() => '?').join(',')})` : ''}
         GROUP BY l.id, l.name, l.code
         ORDER BY l.name`, allowedLocs !== null ? allowedLocs : []);
            locationSummaries = locList.map((row) => ({
                locationId: Number(row.locationId),
                locationName: row.locationName,
                locationCode: row.locationCode,
                totalEmployees: Number(row.totalEmployees ?? 0),
                presentEmployees: Number(row.presentEmployees ?? 0),
                absentEmployees: Number(row.absentEmployees ?? 0),
                onlineEmployees: Number(row.onlineEmployees ?? 0),
                workingEmployees: Number(row.workingEmployees ?? 0),
                inMeetings: Number(row.inMeetings ?? 0),
                onBreak: Number(row.onBreak ?? 0),
                groupCount: Number(row.groupCount ?? 0),
            }));
        }
        return {
            selectedLocation,
            totals: {
                totalEmployees: Number(counts?.total ?? 0),
                presentEmployees: Number(counts?.present ?? 0),
                absentEmployees: Number(counts?.absent ?? 0),
                onlineEmployees: Number(counts?.online ?? 0),
                workingEmployees: Number(counts?.working ?? 0),
                inMeetings: Number(counts?.meetings ?? 0),
                onBreak: Number(counts?.breaks ?? 0),
            },
            groups: groupsList.map((g) => ({
                id: Number(g.id),
                name: g.name,
                code: g.code,
                locationName: g.location_name,
                locationCode: g.location_code,
                managerName: g.manager_name,
                teamLeaderName: g.team_leader_name,
                totalMembers: Number(g.total_members ?? 0),
                presentCount: Number(g.present_count ?? 0),
                onlineCount: Number(g.online_count ?? 0),
            })),
            locationSummaries,
        };
    }
    /**
     * Audit log history for workforce location changes and group operations.
     */
    static async auditLogs(user, filters = {}) {
        if (!user.permissions.includes('locations.manage') && !user.permissions.includes('locations.view.all')) {
            throw ApiError.forbidden('You do not have access to location audit logs.');
        }
        const allowedLocs = await allowedLocationIds(user);
        const clauses = [];
        const params = [];
        if (allowedLocs !== null) {
            if (allowedLocs.length === 0)
                return [];
            clauses.push(`(from_location_id IN (${allowedLocs.map(() => '?').join(',')}) OR to_location_id IN (${allowedLocs.map(() => '?').join(',')}))`);
            params.push(...allowedLocs, ...allowedLocs);
        }
        if (filters.locationId) {
            const locId = await requestedLocation(user, filters.locationId);
            if (locId) {
                clauses.push('(from_location_id = ? OR to_location_id = ?)');
                params.push(locId, locId);
            }
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 200);
        return query(`SELECT id, actor_id, actor_name, action, target_employee_id, target_employee_name,
              group_id, group_name, from_location_id, from_location_name,
              to_location_id, to_location_name, details, ip_address, created_at
       FROM workforce_location_audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}`, params);
    }
}
//# sourceMappingURL=GroupService.js.map