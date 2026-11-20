import { query, queryOne, execute, transaction } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { emitToEmployees } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
export class IssueService {
    /**
     * Generates the next sequential issue reference: BSC-ISS-YYYY-XXXXX
     */
    static async nextIssueNumber() {
        const year = new Date().getFullYear();
        const prefix = `BSC-ISS-${year}-`;
        const row = await queryOne(`SELECT issue_no AS max_no 
       FROM issues 
       WHERE issue_no LIKE ? 
       ORDER BY id DESC 
       LIMIT 1`, [`${prefix}%`]);
        let nextSeq = 1;
        if (row?.max_no) {
            const parts = row.max_no.split('-');
            const lastNum = parseInt(parts[parts.length - 1], 10);
            if (!Number.isNaN(lastNum)) {
                nextSeq = lastNum + 1;
            }
        }
        return `${prefix}${String(nextSeq).padStart(5, '0')}`;
    }
    /**
     * Resolves the manager to whom the issue should be automatically routed
     */
    static async resolveAutoManager(reporter) {
        // 1. Check direct manager in employees table
        if (reporter.managerId) {
            const mgr = await queryOne(`SELECT id, status FROM employees WHERE id = ? AND status = 'active'`, [reporter.managerId]);
            if (mgr)
                return mgr.id;
        }
        // 2. Check reporting_assignments
        const reportingRow = await queryOne(`SELECT manager_id 
       FROM reporting_assignments 
       WHERE employee_id = ? AND (effective_to IS NULL OR effective_to > NOW(3)) 
       ORDER BY id DESC 
       LIMIT 1`, [reporter.id]);
        if (reportingRow?.manager_id) {
            const mgr = await queryOne(`SELECT id, status FROM employees WHERE id = ? AND status = 'active'`, [reportingRow.manager_id]);
            if (mgr)
                return mgr.id;
        }
        // 3. Check department head
        if (reporter.departmentId) {
            const dept = await queryOne(`SELECT head_employee_id FROM departments WHERE id = ?`, [reporter.departmentId]);
            if (dept?.head_employee_id && dept.head_employee_id !== reporter.id) {
                const mgr = await queryOne(`SELECT id, status FROM employees WHERE id = ? AND status = 'active'`, [dept.head_employee_id]);
                if (mgr)
                    return mgr.id;
            }
        }
        // 4. Check store / location manager
        if (reporter.locationId) {
            const storeMgr = await queryOne(`SELECT e.id 
         FROM employees e
         JOIN roles r ON r.id = e.role_id
         WHERE e.location_id = ? 
           AND e.status = 'active' 
           AND r.slug IN ('store_manager', 'branch_manager', 'admin')
           AND e.id != ?
         LIMIT 1`, [reporter.locationId, reporter.id]);
            if (storeMgr)
                return storeMgr.id;
        }
        // 5. Fallback to Super Admin (Renukaradhya)
        const superAdmin = await queryOne(`SELECT e.id 
       FROM employees e 
       JOIN roles r ON r.id = e.role_id 
       WHERE r.slug = 'super_admin' AND e.status = 'active' 
       ORDER BY (LOWER(e.full_name) = 'renukaradhya') DESC, e.id ASC 
       LIMIT 1`);
        return superAdmin?.id ?? null;
    }
    /**
     * Finds the next higher manager in the reporting chain for auto-escalation
     */
    static async resolveHigherManager(currentAssigneeId) {
        const current = await queryOne(`SELECT e.id, e.manager_id, e.department_id, e.location_id, r.slug AS role_slug
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       WHERE e.id = ?`, [currentAssigneeId]);
        if (!current)
            return null;
        // Direct manager of current assignee
        if (current.manager_id && current.manager_id !== current.id) {
            const higher = await queryOne(`SELECT id, status FROM employees WHERE id = ? AND status = 'active'`, [current.manager_id]);
            if (higher)
                return higher.id;
        }
        // Department head
        if (current.department_id) {
            const dept = await queryOne(`SELECT head_employee_id FROM departments WHERE id = ?`, [current.department_id]);
            if (dept?.head_employee_id && dept.head_employee_id !== current.id) {
                return dept.head_employee_id;
            }
        }
        // Executive / Super Admin
        const superAdmin = await queryOne(`SELECT e.id 
       FROM employees e 
       JOIN roles r ON r.id = e.role_id 
       WHERE r.slug = 'super_admin' AND e.status = 'active' AND e.id != ?
       LIMIT 1`, [currentAssigneeId]);
        return superAdmin?.id ?? null;
    }
    /**
     * Creates a new issue with auto or manual routing
     */
    static async createIssue(input, actor) {
        const issueNo = await IssueService.nextIssueNumber();
        const priority = input.priority || 'medium';
        const routingMode = input.routingMode || 'auto';
        let assignedTo = null;
        if (routingMode === 'manual' && input.assignedTo) {
            const target = await queryOne(`SELECT id, status FROM employees WHERE id = ? AND status = 'active'`, [input.assignedTo]);
            if (!target)
                throw ApiError.badRequest('Selected assignee employee does not exist or is inactive.');
            assignedTo = target.id;
        }
        else {
            assignedTo = await IssueService.resolveAutoManager(actor);
        }
        if (!assignedTo) {
            throw ApiError.badRequest('Unable to route issue: no authorized manager or super admin is configured.');
        }
        // Fetch escalation SLA rule
        const rule = await queryOne(`SELECT * FROM issue_escalation_rules WHERE priority = ? AND is_active = 1 LIMIT 1`, [priority]);
        const resolveHours = rule?.resolve_within_hours ?? 48;
        // Insert issue record
        const insertRes = await execute(`INSERT INTO issues (
        issue_no, title, description, category, priority, status,
        affected_module, reporter_id, location_id, department_id,
        routing_mode, assigned_to, escalation_level, due_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 1, DATE_ADD(NOW(3), INTERVAL ? HOUR))`, [
            issueNo,
            input.title.trim().slice(0, 200),
            input.description.trim(),
            input.category,
            priority,
            input.affectedModule?.slice(0, 120) ?? null,
            actor.id,
            actor.locationId ?? null,
            actor.departmentId ?? null,
            routingMode,
            assignedTo,
            resolveHours,
        ]);
        const issueId = Number(insertRes.insertId);
        // Create primary active assignment
        const assignRes = await execute(`INSERT INTO issue_assignments (
        issue_id, assigned_to, assigned_by, reason, level, note, is_active, assigned_at
      ) VALUES (?, ?, ?, ?, 1, ?, 1, NOW(3))`, [
            issueId,
            assignedTo,
            actor.id,
            routingMode === 'manual' ? 'initial_manual' : 'initial_auto',
            `Assigned via ${routingMode} routing`,
        ]);
        const assignmentId = Number(assignRes.insertId);
        await execute(`UPDATE issues SET current_assignment_id = ? WHERE id = ?`, [assignmentId, issueId]);
        // Attach uploaded files if provided
        if (input.fileIds && input.fileIds.length > 0) {
            for (const fileId of input.fileIds) {
                await execute(`INSERT IGNORE INTO issue_attachments (issue_id, file_id, uploaded_by, is_internal)
           VALUES (?, ?, ?, 0)`, [issueId, fileId, actor.id]);
            }
        }
        // Log in activity logs
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, from_status, to_status, details)
       VALUES (?, ?, 'created', NULL, 'pending', ?)`, [
            issueId,
            actor.id,
            JSON.stringify({
                issueNo,
                priority,
                category: input.category,
                routingMode,
                assignedTo,
            }),
        ]);
        // Notify assigned manager across all registered devices
        const assignedManager = await queryOne(`SELECT full_name FROM employees WHERE id = ?`, [assignedTo]);
        void NotificationService.notify({
            employeeIds: [assignedTo],
            type: 'issue',
            title: `[${priority.toUpperCase()}] New Issue: ${issueNo}`,
            body: `${actor.fullName} reported: "${input.title}"`,
            link: `/issues?id=${issueId}`,
            priority: priority === 'critical' ? 'critical' : 'high',
            actorId: actor.id,
            dedupeKey: `issue_created_${issueId}_${assignedTo}`,
        });
        // Notify higher leadership immediately if rule requires for critical issues
        if (priority === 'critical' && rule?.notify_higher_immediately) {
            const higherId = await IssueService.resolveHigherManager(assignedTo);
            if (higherId && higherId !== assignedTo) {
                void NotificationService.notify({
                    employeeIds: [higherId],
                    type: 'issue',
                    title: `[CRITICAL ALERT] Immediate Escalation Notice: ${issueNo}`,
                    body: `Critical issue raised by ${actor.fullName} assigned to ${assignedManager?.full_name ?? 'Manager'}: "${input.title}"`,
                    link: `/issues?id=${issueId}`,
                    priority: 'critical',
                    actorId: actor.id,
                    dedupeKey: `issue_critical_immediate_${issueId}_${higherId}`,
                });
            }
        }
        // Realtime Socket broadcast to reporter and manager
        emitToEmployees([actor.id, assignedTo], 'issue:created', {
            issueId,
            issueNo,
            title: input.title,
            priority,
            status: 'pending',
            assignedTo,
            createdAt: new Date().toISOString(),
        });
        return { id: issueId, issueNo };
    }
    /**
     * List issues with role-based visibility and rich filtering
     */
    static async listIssues(actor, filters) {
        const page = Math.max(1, Number(filters.page) || 1);
        const pageSize = Math.min(100, Math.max(5, Number(filters.pageSize) || 20));
        const offset = (page - 1) * pageSize;
        const whereClauses = ['1=1'];
        const params = [];
        // Role-based visibility enforcement
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        const isManager = (actor.roleLevel ?? 0) >= 50 || actor.permissions?.includes('issues.view.team');
        if (filters.tab === 'my_issues') {
            whereClauses.push('i.reporter_id = ?');
            params.push(actor.id);
        }
        else if (filters.tab === 'assigned_to_me') {
            whereClauses.push('i.assigned_to = ?');
            params.push(actor.id);
        }
        else if (filters.tab === 'escalated') {
            whereClauses.push("i.status = 'escalated'");
            if (!isSuperAdmin) {
                if (isManager) {
                    whereClauses.push('(i.assigned_to = ? OR i.reporter_id = ? OR i.location_id = ? OR i.reporter_id IN (SELECT employee_id FROM reporting_assignments WHERE manager_id = ? AND (effective_to IS NULL OR effective_to > NOW(3))))');
                    params.push(actor.id, actor.id, actor.locationId ?? 0, actor.id);
                }
                else {
                    whereClauses.push('(i.reporter_id = ? OR i.assigned_to = ?)');
                    params.push(actor.id, actor.id);
                }
            }
        }
        else if (filters.tab === 'team_issues') {
            if (isSuperAdmin) {
                // sees all team issues
            }
            else if (isManager) {
                whereClauses.push('(i.assigned_to = ? OR i.location_id = ? OR i.reporter_id IN (SELECT employee_id FROM reporting_assignments WHERE manager_id = ? AND (effective_to IS NULL OR effective_to > NOW(3))))');
                params.push(actor.id, actor.locationId ?? 0, actor.id);
            }
            else {
                whereClauses.push('i.reporter_id = ?');
                params.push(actor.id);
            }
        }
        else {
            // General 'all' tab or default
            if (!isSuperAdmin) {
                if (isManager) {
                    whereClauses.push('(i.reporter_id = ? OR i.assigned_to = ? OR i.location_id = ? OR i.reporter_id IN (SELECT employee_id FROM reporting_assignments WHERE manager_id = ? AND (effective_to IS NULL OR effective_to > NOW(3))))');
                    params.push(actor.id, actor.id, actor.locationId ?? 0, actor.id);
                }
                else {
                    whereClauses.push('(i.reporter_id = ? OR i.assigned_to = ?)');
                    params.push(actor.id, actor.id);
                }
            }
        }
        if (filters.status) {
            whereClauses.push('i.status = ?');
            params.push(filters.status);
        }
        if (filters.priority) {
            whereClauses.push('i.priority = ?');
            params.push(filters.priority);
        }
        if (filters.category) {
            whereClauses.push('i.category = ?');
            params.push(filters.category);
        }
        if (filters.locationId) {
            whereClauses.push('i.location_id = ?');
            params.push(filters.locationId);
        }
        if (filters.departmentId) {
            whereClauses.push('i.department_id = ?');
            params.push(filters.departmentId);
        }
        if (filters.search?.trim()) {
            whereClauses.push('(i.issue_no LIKE ? OR i.title LIKE ? OR i.description LIKE ? OR rep.full_name LIKE ?)');
            const term = `%${filters.search.trim()}%`;
            params.push(term, term, term, term);
        }
        const whereSql = whereClauses.join(' AND ');
        const countRow = await queryOne(`SELECT COUNT(*) AS total 
       FROM issues i 
       LEFT JOIN employees rep ON rep.id = i.reporter_id
       WHERE ${whereSql}`, params);
        const total = Number(countRow?.total ?? 0);
        const rows = await query(`SELECT 
        i.*,
        rep.full_name AS reporter_name,
        rep.employee_code AS reporter_code,
        rep.photo_url AS reporter_photo,
        mgr.full_name AS assigned_to_name,
        mgr.employee_code AS assigned_to_code,
        mgr.photo_url AS assigned_to_photo,
        loc.name AS location_name,
        loc.code AS location_code,
        dept.name AS department_name,
        (SELECT COUNT(*) FROM issue_comments ic WHERE ic.issue_id = i.id ${!isManager && !isSuperAdmin ? 'AND ic.is_internal = 0' : ''}) AS comment_count,
        (SELECT COUNT(*) FROM issue_attachments ia WHERE ia.issue_id = i.id ${!isManager && !isSuperAdmin ? 'AND ia.is_internal = 0' : ''}) AS attachment_count
       FROM issues i
       LEFT JOIN employees rep ON rep.id = i.reporter_id
       LEFT JOIN employees mgr ON mgr.id = i.assigned_to
       LEFT JOIN locations loc ON loc.id = i.location_id
       LEFT JOIN departments dept ON dept.id = i.department_id
       WHERE ${whereSql}
       ORDER BY 
         CASE i.priority 
           WHEN 'critical' THEN 1 
           WHEN 'high' THEN 2 
           WHEN 'medium' THEN 3 
           ELSE 4 
         END,
         i.created_at DESC
       LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
        return {
            items: rows,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    /**
     * Retrieves summary counts for user dashboard and manager dashboard
     */
    static async getSummary(actor) {
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        const isManager = (actor.roleLevel ?? 0) >= 50 || actor.permissions?.includes('issues.view.team');
        const [myOpenRow] = await query(`SELECT COUNT(*) as count FROM issues WHERE reporter_id = ? AND status NOT IN ('resolved', 'closed', 'cancelled')`, [actor.id]);
        const [assignedPendingRow] = await query(`SELECT COUNT(*) as count FROM issues WHERE assigned_to = ? AND status IN ('new', 'pending')`, [actor.id]);
        const [assignedInProgressRow] = await query(`SELECT COUNT(*) as count FROM issues WHERE assigned_to = ? AND status = 'in_progress'`, [actor.id]);
        let escalatedQuery = `SELECT COUNT(*) as count FROM issues WHERE status = 'escalated'`;
        let escalatedParams = [];
        if (!isSuperAdmin) {
            if (isManager) {
                escalatedQuery += ' AND (assigned_to = ? OR location_id = ? OR reporter_id = ?)';
                escalatedParams = [actor.id, actor.locationId ?? 0, actor.id];
            }
            else {
                escalatedQuery += ' AND (reporter_id = ? OR assigned_to = ?)';
                escalatedParams = [actor.id, actor.id];
            }
        }
        const [escalatedRow] = await query(escalatedQuery, escalatedParams);
        let overdueQuery = `SELECT COUNT(*) as count FROM issues WHERE status NOT IN ('resolved', 'closed', 'cancelled') AND due_at < NOW()`;
        let overdueParams = [];
        if (!isSuperAdmin) {
            if (isManager) {
                overdueQuery += ' AND (assigned_to = ? OR location_id = ? OR reporter_id = ?)';
                overdueParams = [actor.id, actor.locationId ?? 0, actor.id];
            }
            else {
                overdueQuery += ' AND (reporter_id = ? OR assigned_to = ?)';
                overdueParams = [actor.id, actor.id];
            }
        }
        const [overdueRow] = await query(overdueQuery, overdueParams);
        const [resolvedTodayRow] = await query(`SELECT COUNT(*) as count FROM issues WHERE status = 'resolved' AND DATE(resolved_at) = CURDATE()`);
        return {
            myOpen: Number(myOpenRow?.count ?? 0),
            assignedPending: Number(assignedPendingRow?.count ?? 0),
            assignedInProgress: Number(assignedInProgressRow?.count ?? 0),
            escalated: Number(escalatedRow?.count ?? 0),
            overdue: Number(overdueRow?.count ?? 0),
            resolvedToday: Number(resolvedTodayRow?.count ?? 0),
            isManager: isManager || isSuperAdmin,
        };
    }
    /**
     * Retrieves full issue details, assignment chain, comments, and attachments
     */
    static async getIssue(id, actor) {
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        const isManager = (actor.roleLevel ?? 0) >= 50 || actor.permissions?.includes('issues.view.team');
        const issue = await queryOne(`SELECT 
        i.*,
        rep.full_name AS reporter_name,
        rep.employee_code AS reporter_code,
        rep.email AS reporter_email,
        rep.mobile AS reporter_mobile,
        rep.photo_url AS reporter_photo,
        mgr.full_name AS assigned_to_name,
        mgr.employee_code AS assigned_to_code,
        mgr.email AS assigned_to_email,
        mgr.photo_url AS assigned_to_photo,
        res.full_name AS resolved_by_name,
        loc.name AS location_name,
        loc.code AS location_code,
        dept.name AS department_name
       FROM issues i
       LEFT JOIN employees rep ON rep.id = i.reporter_id
       LEFT JOIN employees mgr ON mgr.id = i.assigned_to
       LEFT JOIN employees res ON res.id = i.resolved_by
       LEFT JOIN locations loc ON loc.id = i.location_id
       LEFT JOIN departments dept ON dept.id = i.department_id
       WHERE i.id = ?`, [id]);
        if (!issue)
            throw ApiError.notFound('Issue not found.');
        // Security check
        if (!isSuperAdmin && !isManager && issue.reporter_id !== actor.id && issue.assigned_to !== actor.id) {
            throw ApiError.forbidden('You do not have permission to view this issue.');
        }
        const canSeeInternal = isManager || isSuperAdmin;
        // Fetch comments
        const comments = await query(`SELECT 
        ic.*,
        e.full_name AS author_name,
        e.employee_code AS author_code,
        e.photo_url AS author_photo,
        r.name AS author_role
       FROM issue_comments ic
       JOIN employees e ON e.id = ic.author_id
       JOIN roles r ON r.id = e.role_id
       WHERE ic.issue_id = ? ${!canSeeInternal ? 'AND ic.is_internal = 0' : ''}
       ORDER BY ic.created_at ASC`, [id]);
        // Fetch attachments
        const attachments = await query(`SELECT 
        ia.*,
        f.original_name,
        f.mime_type,
        f.size_bytes,
        CONCAT('/api/files/', f.id, '/download') AS download_url,
        e.full_name AS uploaded_by_name
       FROM issue_attachments ia
       JOIN files f ON f.id = ia.file_id
       JOIN employees e ON e.id = ia.uploaded_by
       WHERE ia.issue_id = ? ${!canSeeInternal ? 'AND ia.is_internal = 0' : ''}
       ORDER BY ia.created_at ASC`, [id]);
        // Fetch escalation history
        const escalationHistory = await query(`SELECT 
        eh.*,
        from_emp.full_name AS from_employee_name,
        to_emp.full_name AS to_employee_name,
        by_emp.full_name AS escalated_by_name
       FROM issue_escalation_history eh
       LEFT JOIN employees from_emp ON from_emp.id = eh.from_employee_id
       LEFT JOIN employees to_emp ON to_emp.id = eh.to_employee_id
       LEFT JOIN employees by_emp ON by_emp.id = eh.escalated_by
       WHERE eh.issue_id = ?
       ORDER BY eh.created_at ASC`, [id]);
        // Fetch activity logs
        const activityLogs = await query(`SELECT 
        al.*,
        e.full_name AS actor_name,
        e.employee_code AS actor_code
       FROM issue_activity_logs al
       LEFT JOIN employees e ON e.id = al.actor_id
       WHERE al.issue_id = ? ${!canSeeInternal ? 'AND al.is_internal = 0' : ''}
       ORDER BY al.created_at DESC`, [id]);
        return {
            issue,
            comments,
            attachments,
            escalationHistory,
            activityLogs,
            canSeeInternal,
        };
    }
    /**
     * Manager acknowledges the assigned issue
     */
    static async acknowledgeIssue(id, actor, note) {
        const issue = await queryOne(`SELECT id, status, assigned_to, reporter_id, issue_no, current_assignment_id FROM issues WHERE id = ?`, [id]);
        if (!issue)
            throw ApiError.notFound('Issue not found.');
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        if (!isSuperAdmin && issue.assigned_to !== actor.id) {
            throw ApiError.forbidden('Only the currently assigned manager or an administrator can acknowledge this issue.');
        }
        const nextStatus = issue.status === 'new' || issue.status === 'pending' ? 'in_progress' : issue.status;
        await execute(`UPDATE issues 
       SET acknowledged_at = NOW(3), status = ? 
       WHERE id = ?`, [nextStatus, id]);
        if (issue.current_assignment_id) {
            await execute(`UPDATE issue_assignments 
         SET acknowledged_at = NOW(3), note = COALESCE(?, note) 
         WHERE id = ?`, [note ?? null, issue.current_assignment_id]);
        }
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, from_status, to_status, details)
       VALUES (?, ?, 'acknowledged', ?, ?, ?)`, [id, actor.id, issue.status, nextStatus, JSON.stringify({ note })]);
        // Notify the reporter
        void NotificationService.notify({
            employeeIds: [issue.reporter_id],
            type: 'issue',
            title: `Issue Acknowledged: ${issue.issue_no}`,
            body: `${actor.fullName} acknowledged your issue and has begun work.`,
            link: `/issues?id=${id}`,
            actorId: actor.id,
            dedupeKey: `issue_ack_${id}_${Date.now()}`,
        });
        emitToEmployees([issue.reporter_id, issue.assigned_to], 'issue:updated', {
            issueId: id,
            issueNo: issue.issue_no,
            status: nextStatus,
            acknowledgedAt: new Date().toISOString(),
        });
        return { ok: true, status: nextStatus };
    }
    /**
     * Manually escalates an issue to a higher manager or specified manager
     */
    static async escalateIssue(id, actor, input) {
        const issue = await queryOne(`SELECT id, issue_no, status, priority, assigned_to, reporter_id, escalation_level, current_assignment_id 
       FROM issues WHERE id = ?`, [id]);
        if (!issue)
            throw ApiError.notFound('Issue not found.');
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        const isCurrentManager = issue.assigned_to === actor.id;
        const isReporter = issue.reporter_id === actor.id;
        if (!isSuperAdmin && !isCurrentManager && !isReporter) {
            throw ApiError.forbidden('You are not authorized to escalate this issue.');
        }
        let targetManagerId = input.targetEmployeeId;
        if (!targetManagerId) {
            targetManagerId = (await IssueService.resolveHigherManager(issue.assigned_to)) ?? undefined;
        }
        if (!targetManagerId || targetManagerId === issue.assigned_to) {
            throw ApiError.badRequest('No higher authorized manager found in hierarchy to escalate to.');
        }
        const newLevel = issue.escalation_level + 1;
        // End current assignment
        if (issue.current_assignment_id) {
            await execute(`UPDATE issue_assignments 
         SET is_active = 0, ended_at = NOW(3) 
         WHERE id = ?`, [issue.current_assignment_id]);
        }
        // Create new assignment
        const assignRes = await execute(`INSERT INTO issue_assignments (
        issue_id, assigned_to, assigned_by, reason, level, note, is_active, assigned_at
      ) VALUES (?, ?, ?, 'manual_escalation', ?, ?, 1, NOW(3))`, [id, targetManagerId, actor.id, newLevel, input.note ?? input.reason]);
        const newAssignmentId = Number(assignRes.insertId);
        // Record escalation history
        await execute(`INSERT INTO issue_escalation_history (
        issue_id, from_employee_id, to_employee_id, from_level, to_level,
        escalation_type, reason, escalated_by, notification_status
      ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, 'sent')`, [
            id,
            issue.assigned_to,
            targetManagerId,
            issue.escalation_level,
            newLevel,
            input.reason.trim().slice(0, 500),
            actor.id,
        ]);
        // Update issue
        await execute(`UPDATE issues 
       SET status = 'escalated',
           assigned_to = ?,
           current_assignment_id = ?,
           escalation_level = ?,
           last_escalated_at = NOW(3)
       WHERE id = ?`, [targetManagerId, newAssignmentId, newLevel, id]);
        // Activity log
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, from_status, to_status, details)
       VALUES (?, ?, 'escalated', ?, 'escalated', ?)`, [
            id,
            actor.id,
            issue.status,
            JSON.stringify({
                fromManager: issue.assigned_to,
                toManager: targetManagerId,
                reason: input.reason,
                level: newLevel,
            }),
        ]);
        // Notify new manager
        void NotificationService.notify({
            employeeIds: [targetManagerId],
            type: 'issue',
            title: `[ESCALATED] Issue ${issue.issue_no} Escalated to You`,
            body: `Reason: ${input.reason}. Escalated by ${actor.fullName}.`,
            link: `/issues?id=${id}`,
            priority: 'critical',
            actorId: actor.id,
            dedupeKey: `issue_escalate_${id}_${newLevel}_${targetManagerId}`,
        });
        // Notify old manager & reporter
        void NotificationService.notify({
            employeeIds: [issue.reporter_id, issue.assigned_to],
            type: 'issue',
            title: `Issue Escalated: ${issue.issue_no}`,
            body: `Issue has been escalated to level ${newLevel}. Reason: ${input.reason}`,
            link: `/issues?id=${id}`,
            actorId: actor.id,
            dedupeKey: `issue_escalate_notice_${id}_${newLevel}`,
        });
        emitToEmployees([issue.reporter_id, issue.assigned_to, targetManagerId], 'issue:escalated', {
            issueId: id,
            issueNo: issue.issue_no,
            status: 'escalated',
            level: newLevel,
            assignedTo: targetManagerId,
        });
        return { ok: true, newLevel, assignedTo: targetManagerId };
    }
    /**
     * Reassigns issue to another authorized employee
     */
    static async reassignIssue(id, actor, input) {
        const issue = await queryOne(`SELECT id, issue_no, assigned_to, reporter_id, current_assignment_id FROM issues WHERE id = ?`, [id]);
        if (!issue)
            throw ApiError.notFound('Issue not found.');
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        const isCurrentManager = issue.assigned_to === actor.id;
        if (!isSuperAdmin && !isCurrentManager) {
            throw ApiError.forbidden('Only the currently assigned manager or administrator can reassign this issue.');
        }
        const target = await queryOne(`SELECT id, full_name, status FROM employees WHERE id = ? AND status = 'active'`, [input.targetEmployeeId]);
        if (!target)
            throw ApiError.badRequest('Target employee does not exist or is inactive.');
        if (issue.current_assignment_id) {
            await execute(`UPDATE issue_assignments SET is_active = 0, ended_at = NOW(3) WHERE id = ?`, [issue.current_assignment_id]);
        }
        const assignRes = await execute(`INSERT INTO issue_assignments (issue_id, assigned_to, assigned_by, reason, level, note, is_active, assigned_at)
       VALUES (?, ?, ?, 'reassign', 1, ?, 1, NOW(3))`, [id, target.id, actor.id, input.reason ?? 'Reassigned by manager']);
        const newAssignmentId = Number(assignRes.insertId);
        await execute(`UPDATE issues SET assigned_to = ?, current_assignment_id = ? WHERE id = ?`, [target.id, newAssignmentId, id]);
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, details)
       VALUES (?, ?, 'reassigned', ?)`, [id, actor.id, JSON.stringify({ from: issue.assigned_to, to: target.id, reason: input.reason })]);
        void NotificationService.notify({
            employeeIds: [target.id],
            type: 'issue',
            title: `Issue Reassigned to You: ${issue.issue_no}`,
            body: `Reassigned by ${actor.fullName}. Reason: ${input.reason ?? 'Direct assignment'}`,
            link: `/issues?id=${id}`,
            actorId: actor.id,
            dedupeKey: `issue_reassign_${id}_${target.id}`,
        });
        emitToEmployees([issue.reporter_id, issue.assigned_to, target.id], 'issue:updated', {
            issueId: id,
            issueNo: issue.issue_no,
            assignedTo: target.id,
        });
        return { ok: true, assignedTo: target.id };
    }
    /**
     * Updates issue status (in_progress, on_hold, resolved, closed, cancelled)
     */
    static async updateStatus(id, actor, input) {
        const issue = await queryOne(`SELECT id, issue_no, status, reporter_id, assigned_to FROM issues WHERE id = ?`, [id]);
        if (!issue)
            throw ApiError.notFound('Issue not found.');
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        const isCurrentManager = issue.assigned_to === actor.id;
        const isReporter = issue.reporter_id === actor.id;
        if (!isSuperAdmin && !isCurrentManager && !isReporter) {
            throw ApiError.forbidden('You are not authorized to update this issue.');
        }
        const nextStatus = input.status;
        let resolvedAtSql = '';
        const updateParams = [nextStatus];
        if (nextStatus === 'resolved') {
            if (!input.resolution?.trim()) {
                throw ApiError.badRequest('Resolution summary is required when marking an issue as resolved.');
            }
            resolvedAtSql = ', resolved_at = NOW(3), resolved_by = ?, resolution = ?';
            updateParams.push(actor.id, input.resolution.trim());
        }
        updateParams.push(id);
        await execute(`UPDATE issues 
       SET status = ? ${resolvedAtSql}
       WHERE id = ?`, updateParams);
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, from_status, to_status, details)
       VALUES (?, ?, 'status_change', ?, ?, ?)`, [id, actor.id, issue.status, nextStatus, JSON.stringify({ resolution: input.resolution, note: input.note })]);
        // Notify participants
        void NotificationService.notify({
            employeeIds: [issue.reporter_id, issue.assigned_to].filter((id) => id !== actor.id),
            type: 'issue',
            title: `Issue ${nextStatus.toUpperCase()}: ${issue.issue_no}`,
            body: nextStatus === 'resolved' ? `Resolution: ${input.resolution}` : `Status updated to ${nextStatus}`,
            link: `/issues?id=${id}`,
            actorId: actor.id,
            dedupeKey: `issue_status_${id}_${nextStatus}_${Date.now()}`,
        });
        emitToEmployees([issue.reporter_id, issue.assigned_to], 'issue:updated', {
            issueId: id,
            issueNo: issue.issue_no,
            status: nextStatus,
            resolution: input.resolution ?? null,
        });
        return { ok: true, status: nextStatus };
    }
    /**
     * Reopens a resolved or closed issue with retention of original issue_no
     */
    static async reopenIssue(id, actor, reason) {
        const issue = await queryOne(`SELECT id, issue_no, status, reporter_id, assigned_to, reopen_count FROM issues WHERE id = ?`, [id]);
        if (!issue)
            throw ApiError.notFound('Issue not found.');
        await execute(`UPDATE issues 
       SET status = 'reopened',
           reopen_count = reopen_count + 1,
           resolved_at = NULL,
           resolved_by = NULL
       WHERE id = ?`, [id]);
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, from_status, to_status, details)
       VALUES (?, ?, 'reopened', ?, 'reopened', ?)`, [id, actor.id, issue.status, JSON.stringify({ reason, reopenCount: issue.reopen_count + 1 })]);
        void NotificationService.notify({
            employeeIds: [issue.assigned_to],
            type: 'issue',
            title: `Issue Reopened: ${issue.issue_no}`,
            body: `Reason: ${reason}. Reopened by ${actor.fullName}.`,
            link: `/issues?id=${id}`,
            priority: 'high',
            actorId: actor.id,
            dedupeKey: `issue_reopened_${id}_${Date.now()}`,
        });
        emitToEmployees([issue.reporter_id, issue.assigned_to], 'issue:updated', {
            issueId: id,
            issueNo: issue.issue_no,
            status: 'reopened',
        });
        return { ok: true, status: 'reopened' };
    }
    /**
     * Adds a public comment or confidential manager-only internal note
     */
    static async addComment(id, actor, input) {
        const issue = await queryOne(`SELECT id, issue_no, reporter_id, assigned_to FROM issues WHERE id = ?`, [id]);
        if (!issue)
            throw ApiError.notFound('Issue not found.');
        const isSuperAdmin = actor.roleSlug === 'super_admin' || (actor.roleLevel ?? 0) >= 90;
        const isManager = (actor.roleLevel ?? 0) >= 50 || actor.permissions?.includes('issues.view.team');
        const isInternal = Boolean(input.isInternal);
        if (isInternal && !isManager && !isSuperAdmin) {
            throw ApiError.forbidden('Only authorized managers or administrators can post internal notes.');
        }
        const insertRes = await execute(`INSERT INTO issue_comments (issue_id, author_id, kind, body, is_internal)
       VALUES (?, ?, ?, ?, ?)`, [id, actor.id, isInternal ? 'note' : 'comment', input.body.trim(), isInternal ? 1 : 0]);
        const commentId = Number(insertRes.insertId);
        if (input.fileIds && input.fileIds.length > 0) {
            for (const fileId of input.fileIds) {
                await execute(`INSERT IGNORE INTO issue_attachments (issue_id, comment_id, file_id, uploaded_by, is_internal)
           VALUES (?, ?, ?, ?, ?)`, [id, commentId, fileId, actor.id, isInternal ? 1 : 0]);
            }
        }
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, is_internal, details)
       VALUES (?, ?, ?, ?, ?)`, [id, actor.id, isInternal ? 'internal_note' : 'comment_added', isInternal ? 1 : 0, JSON.stringify({ commentId })]);
        const payload = {
            commentId,
            issueId: id,
            issueNo: issue.issue_no,
            authorName: actor.fullName,
            authorId: actor.id,
            body: input.body,
            isInternal,
            createdAt: new Date().toISOString(),
        };
        if (isInternal) {
            // Internal note: ONLY broadcast/notify to managers and admins
            const managers = await query(`SELECT e.id FROM employees e 
         JOIN roles r ON r.id = e.role_id 
         WHERE r.slug IN ('super_admin', 'director', 'admin', 'store_manager', 'department_head')
           AND e.status = 'active'`);
            emitToEmployees(managers.map((m) => m.id), 'issue:comment', payload);
        }
        else {
            // Public comment: notify other issue participants
            const targets = [issue.reporter_id, issue.assigned_to].filter((id) => id !== actor.id);
            void NotificationService.notify({
                employeeIds: targets,
                type: 'issue',
                title: `New Comment on ${issue.issue_no}`,
                body: `${actor.fullName}: "${input.body.slice(0, 100)}"`,
                link: `/issues?id=${id}`,
                actorId: actor.id,
                dedupeKey: `issue_comment_${commentId}`,
            });
            emitToEmployees([issue.reporter_id, issue.assigned_to], 'issue:comment', payload);
        }
        return { id: commentId, isInternal };
    }
    /**
     * Reads the current escalation rules configured in the database
     */
    static async getRules() {
        return query(`SELECT * FROM issue_escalation_rules ORDER BY FIELD(priority, 'critical', 'high', 'medium', 'low')`);
    }
    /**
     * Updates escalation rules (Super Admin / IT Admin only)
     */
    static async updateRules(rules, actor) {
        for (const r of rules) {
            await execute(`UPDATE issue_escalation_rules 
         SET ack_reminder_minutes = ?,
             escalate_after_minutes = ?,
             resolve_within_hours = ?,
             overdue_repeat_minutes = ?,
             max_level = ?,
             notify_higher_immediately = ?,
             updated_by = ?,
             updated_at = NOW(3)
         WHERE priority = ?`, [
                r.ack_reminder_minutes,
                r.escalate_after_minutes,
                r.resolve_within_hours,
                r.overdue_repeat_minutes,
                r.max_level,
                r.notify_higher_immediately ? 1 : 0,
                actor.id,
                r.priority,
            ]);
        }
        return { ok: true };
    }
    /**
     * Background sweep engine: checks SLA reminders and auto-escalates breaches
     * Runs every minute via scheduler
     */
    static async runEscalationSweep() {
        let remindersSent = 0;
        let escalationsTriggered = 0;
        const rules = await query(`SELECT * FROM issue_escalation_rules WHERE is_active = 1`);
        const ruleMap = new Map();
        for (const r of rules)
            ruleMap.set(r.priority, r);
        // 1. Check for unacknowledged issues that need an acknowledgement reminder
        const unacknowledged = await query(`SELECT 
        i.id, i.issue_no, i.title, i.priority, i.assigned_to, i.current_assignment_id, i.created_at,
        ia.reminder_sent_at,
        TIMESTAMPDIFF(MINUTE, ia.assigned_at, NOW()) AS age_minutes
       FROM issues i
       JOIN issue_assignments ia ON ia.id = i.current_assignment_id
       WHERE i.status IN ('new', 'pending', 'escalated')
         AND i.acknowledged_at IS NULL
         AND ia.is_active = 1`);
        for (const row of unacknowledged) {
            const rule = ruleMap.get(row.priority);
            if (!rule)
                continue;
            if (row.age_minutes >= rule.ack_reminder_minutes && !row.reminder_sent_at) {
                // Send acknowledgement reminder
                void NotificationService.notify({
                    employeeIds: [row.assigned_to],
                    type: 'issue',
                    title: `[ACTION REQUIRED] Acknowledge Issue: ${row.issue_no}`,
                    body: `Issue "${row.title}" has been awaiting your acknowledgement for ${row.age_minutes} minutes.`,
                    link: `/issues?id=${row.id}`,
                    priority: 'critical',
                    dedupeKey: `issue_ack_remind_${row.id}_${row.assigned_to}`,
                });
                await execute(`UPDATE issue_assignments SET reminder_sent_at = NOW(3) WHERE id = ?`, [row.current_assignment_id]);
                remindersSent++;
            }
        }
        // 2. Check for SLA breaches requiring automatic escalation
        const candidates = await query(`SELECT 
        i.id, i.issue_no, i.title, i.priority, i.assigned_to, i.reporter_id, i.escalation_level,
        i.current_assignment_id, i.escalation_exhausted,
        TIMESTAMPDIFF(MINUTE, ia.assigned_at, NOW()) AS age_since_assigned_minutes
       FROM issues i
       JOIN issue_assignments ia ON ia.id = i.current_assignment_id
       WHERE i.status IN ('new', 'pending', 'in_progress', 'escalated')
         AND i.escalation_exhausted = 0
         AND ia.is_active = 1`);
        for (const item of candidates) {
            const rule = ruleMap.get(item.priority);
            if (!rule)
                continue;
            if (item.age_since_assigned_minutes >= rule.escalate_after_minutes &&
                item.escalation_level < rule.max_level) {
                // Auto-escalate to higher level manager
                const higherManagerId = await IssueService.resolveHigherManager(item.assigned_to);
                if (!higherManagerId || higherManagerId === item.assigned_to) {
                    // No higher manager exists, mark exhausted so we do not retry every minute
                    await execute(`UPDATE issues SET escalation_exhausted = 1 WHERE id = ?`, [item.id]);
                    continue;
                }
                const newLevel = item.escalation_level + 1;
                // End current assignment
                await execute(`UPDATE issue_assignments SET is_active = 0, ended_at = NOW(3) WHERE id = ?`, [item.current_assignment_id]);
                // Insert new assignment
                const assignRes = await execute(`INSERT INTO issue_assignments (
            issue_id, assigned_to, assigned_by, reason, level, note, is_active, assigned_at
          ) VALUES (?, ?, NULL, 'sla_breach_auto', ?, 'Automatic escalation due to SLA response timeout', 1, NOW(3))`, [item.id, higherManagerId, newLevel]);
                const newAssignmentId = Number(assignRes.insertId);
                // Record escalation history
                await execute(`INSERT INTO issue_escalation_history (
            issue_id, from_employee_id, to_employee_id, from_level, to_level,
            escalation_type, reason, escalated_by, notification_status
          ) VALUES (?, ?, ?, ?, ?, 'sla_breach', 'Auto-escalated after SLA breach timeout', NULL, 'sent')`, [item.id, item.assigned_to, higherManagerId, item.escalation_level, newLevel]);
                // Update issue
                await execute(`UPDATE issues 
           SET status = 'escalated',
               assigned_to = ?,
               current_assignment_id = ?,
               escalation_level = ?,
               last_escalated_at = NOW(3)
           WHERE id = ?`, [higherManagerId, newAssignmentId, newLevel, item.id]);
                // Activity log
                await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, from_status, to_status, details)
           VALUES (?, NULL, 'auto_escalated', 'in_progress', 'escalated', ?)`, [
                    item.id,
                    JSON.stringify({
                        fromManager: item.assigned_to,
                        toManager: higherManagerId,
                        level: newLevel,
                        slaMinutes: rule.escalate_after_minutes,
                    }),
                ]);
                // Push / Notifications to new manager and reporter
                void NotificationService.notify({
                    employeeIds: [higherManagerId],
                    type: 'issue',
                    title: `[AUTO-ESCALATION] Issue ${item.issue_no} Escalated to You`,
                    body: `Issue "${item.title}" breached resolution SLA and was auto-escalated to Level ${newLevel}.`,
                    link: `/issues?id=${item.id}`,
                    priority: 'critical',
                    dedupeKey: `issue_auto_esc_${item.id}_${newLevel}`,
                });
                void NotificationService.notify({
                    employeeIds: [item.reporter_id, item.assigned_to],
                    type: 'issue',
                    title: `Issue Auto-Escalated: ${item.issue_no}`,
                    body: `Issue has been automatically escalated to higher management (Level ${newLevel}) due to SLA deadline.`,
                    link: `/issues?id=${item.id}`,
                    dedupeKey: `issue_auto_esc_notice_${item.id}_${newLevel}`,
                });
                emitToEmployees([item.reporter_id, item.assigned_to, higherManagerId], 'issue:escalated', {
                    issueId: item.id,
                    issueNo: item.issue_no,
                    status: 'escalated',
                    level: newLevel,
                    assignedTo: higherManagerId,
                });
                escalationsTriggered++;
            }
        }
        return { remindersSent, escalationsTriggered };
    }
    static async updateIssue(id, actor, input) {
        const existing = await queryOne('SELECT id, issue_no, reporter_id, current_assignee_id FROM issues WHERE id = ?', [id]);
        if (!existing)
            throw ApiError.notFound('Issue not found');
        const updates = [];
        const params = [];
        if (input.title !== undefined) {
            updates.push('title = ?');
            params.push(input.title.trim());
        }
        if (input.description !== undefined) {
            updates.push('description = ?');
            params.push(input.description.trim());
        }
        if (input.category !== undefined) {
            updates.push('category = ?');
            params.push(input.category.trim());
        }
        if (input.priority !== undefined) {
            updates.push('priority = ?');
            params.push(input.priority);
        }
        if (input.status !== undefined) {
            updates.push('status = ?');
            params.push(input.status);
            if (input.status === 'resolved')
                updates.push('resolved_at = COALESCE(resolved_at, NOW(3))');
            if (input.status === 'closed')
                updates.push('closed_at = COALESCE(closed_at, NOW(3))');
        }
        if (input.affectedModule !== undefined) {
            updates.push('affected_module = ?');
            params.push(input.affectedModule ? input.affectedModule.trim() : null);
        }
        if (input.assignedTo !== undefined) {
            const newAssigneeId = Number(input.assignedTo);
            updates.push('current_assignee_id = ?');
            params.push(newAssigneeId);
            await execute('UPDATE issue_assignments SET is_active = 0 WHERE issue_id = ?', [id]);
            const res = await execute(`INSERT INTO issue_assignments (issue_id, assigned_to, assigned_by, reason, is_active, assigned_at)
         VALUES (?, ?, ?, 'manual_reassign', 1, NOW(3))`, [id, newAssigneeId, actor.id]);
            updates.push('current_assignment_id = ?');
            params.push(res.insertId);
        }
        if (updates.length > 0) {
            params.push(id);
            await execute(`UPDATE issues SET ${updates.join(', ')} WHERE id = ?`, params);
        }
        await execute(`INSERT INTO issue_activity_logs (issue_id, actor_id, action, note)
       VALUES (?, ?, 'issue_updated', 'Issue updated')`, [id, actor.id]);
        const recipients = new Set([
            Number(existing.reporter_id),
            Number(existing.current_assignee_id),
            ...(input.assignedTo ? [Number(input.assignedTo)] : []),
            actor.id,
        ]);
        emitToEmployees([...recipients].filter(Boolean), 'issue:updated', { issueId: id });
        return await IssueService.getIssue(id, actor);
    }
    static async deleteIssue(id, actor) {
        const existing = await queryOne('SELECT id, issue_no, reporter_id, current_assignee_id FROM issues WHERE id = ?', [id]);
        if (!existing)
            throw ApiError.notFound('Issue not found');
        await transaction(async (conn) => {
            await conn.query('DELETE FROM issue_attachments WHERE issue_id = ?', [id]);
            await conn.query('DELETE FROM issue_comments WHERE issue_id = ?', [id]);
            await conn.query('DELETE FROM issue_assignments WHERE issue_id = ?', [id]);
            await conn.query('DELETE FROM issue_escalation_history WHERE issue_id = ?', [id]);
            await conn.query('DELETE FROM issue_activity_logs WHERE issue_id = ?', [id]);
            await conn.query('DELETE FROM issue_notifications WHERE issue_id = ?', [id]);
            await conn.query('DELETE FROM issues WHERE id = ?', [id]);
        });
        const recipients = new Set([
            Number(existing.reporter_id),
            Number(existing.current_assignee_id),
            actor.id,
        ]);
        emitToEmployees([...recipients].filter(Boolean), 'issue:deleted', { issueId: id, issueNo: existing.issue_no });
        return { success: true, id };
    }
}
//# sourceMappingURL=IssueService.js.map