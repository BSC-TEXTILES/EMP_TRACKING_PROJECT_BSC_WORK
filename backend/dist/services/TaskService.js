import { execute, nextSequence, query, queryOne, transaction, txQuery, txQueryOne } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { addDays, today, toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { assertCanAllocateTo, locationEmployeeClause, subtreeIds } from '../lib/scope.js';
import { emitToEmployee, emitToEmployees } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
export const TASK_STATUSES = [
    'not_started',
    'assigned',
    'accepted',
    'in_progress',
    'on_hold',
    'pending_approval',
    'completed',
    'rejected',
    'overdue',
    'cancelled',
];
export const TASK_ACTIONS = [
    'accept',
    'start',
    'hold',
    'resume',
    'progress',
    'submit',
    'approve',
    'request_changes',
    'reassign',
    'cancel',
    'reopen',
];
async function taskAccessClause(user) {
    if (user.permissions.includes('tasks.view.all')) {
        const location = await locationEmployeeClause(user, 'ta_loc.employee_id');
        if (location.clause === '1 = 1')
            return { clause: '', params: [] };
        const creator = await locationEmployeeClause(user, 't.created_by');
        return {
            clause: ` AND (${creator.clause} OR EXISTS (SELECT 1 FROM task_assignments ta_loc WHERE ta_loc.task_id = t.id AND ${location.clause}))`,
            params: [...creator.params, ...location.params],
        };
    }
    if (user.permissions.includes('tasks.view.team')) {
        const ids = await subtreeIds(user.id);
        if (ids.length === 0)
            return { clause: ' AND 1 = 0', params: [] };
        const placeholders = ids.map(() => '?').join(',');
        return {
            clause: ` AND (t.created_by IN (${placeholders}) OR t.manager_id IN (${placeholders})
                OR EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.employee_id IN (${placeholders})))`,
            params: [...ids, ...ids, ...ids],
        };
    }
    return {
        clause: ' AND (t.created_by = ? OR EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.employee_id = ?))',
        params: [user.id, user.id],
    };
}
export class TaskService {
    static async create(input, actor, context) {
        if (input.assigneeIds.length === 0)
            throw ApiError.badRequest('Select at least one employee to allocate this task to.');
        if (!input.title?.trim())
            throw ApiError.badRequest('Task title is required.');
        if (input.dueDate && input.startDate && input.dueDate < input.startDate) {
            throw ApiError.badRequest('Due date cannot be before the start date.');
        }
        for (const assignee of input.assigneeIds) {
            await assertCanAllocateTo(actor, assignee);
            const employee = await queryOne("SELECT id FROM employees WHERE id = ? AND status = 'active'", [assignee]);
            if (!employee)
                throw ApiError.badRequest('One of the selected employees is not active.');
        }
        if (input.projectId) {
            const project = await queryOne('SELECT id FROM projects WHERE id = ?', [input.projectId]);
            if (!project)
                throw ApiError.badRequest('Select a valid project.');
        }
        const created = await transaction(async (conn) => {
            const seq = await nextSequence(conn, 'task_no_seq');
            const taskNo = `TSK-${String(seq).padStart(5, '0')}`;
            const [result] = await conn.query(`INSERT INTO tasks
          (task_no, title, description, category, department_id, project_id, priority, status, created_by, manager_id,
           start_date, due_date, due_time, estimated_minutes, instructions, remarks, recurrence, recurrence_end_date, parent_task_id, progress)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [
                taskNo,
                input.title.trim(),
                input.description?.trim() || null,
                input.category ?? null,
                input.departmentId ?? actor.departmentId ?? null,
                input.projectId ?? null,
                input.priority ?? 'medium',
                actor.id,
                actor.id,
                input.startDate ?? today(),
                input.dueDate ?? null,
                input.dueTime ?? null,
                input.estimatedMinutes ?? null,
                input.instructions ?? null,
                input.remarks ?? null,
                input.recurrence ?? 'none',
                input.recurrenceEndDate ?? null,
                input.parentTaskId ?? null,
            ]);
            const taskId = Number(result.insertId);
            for (const assignee of input.assigneeIds) {
                await conn.query(`INSERT INTO task_assignments (task_id, employee_id, assigned_by, status) VALUES (?, ?, ?, 'assigned')`, [taskId, assignee, actor.id]);
            }
            if (input.subtasks?.length) {
                let position = 0;
                for (const title of input.subtasks.filter((s) => s.trim().length > 0)) {
                    await conn.query('INSERT INTO task_subtasks (task_id, title, position) VALUES (?, ?, ?)', [taskId, title.trim(), position]);
                    position += 1;
                }
            }
            for (const fileId of input.attachmentIds ?? []) {
                await conn.query('INSERT INTO task_attachments (task_id, file_id, uploaded_by) VALUES (?, ?, ?)', [taskId, fileId, actor.id]);
            }
            return { id: taskId, taskNo };
        });
        await recordAudit({
            actorId: actor.id,
            action: 'task.created',
            entityType: 'task',
            entityId: created.id,
            after: { ...input, taskNo: created.taskNo },
            ip: context.ip,
            userAgent: context.userAgent,
        });
        await NotificationService.notify({
            employeeIds: input.assigneeIds,
            type: 'task_assigned',
            title: 'New task allocated',
            body: `${actor.fullName} allocated "${input.title.trim()}" (${created.taskNo}).`,
            link: `/tasks?task=${created.id}`,
            priority: input.priority === 'critical' || input.priority === 'high' ? 'high' : 'normal',
            actorId: actor.id,
        });
        emitToEmployees(input.assigneeIds, 'task:created', { id: created.id, taskNo: created.taskNo, title: input.title });
        emitToEmployee(actor.id, 'task:created', { id: created.id, taskNo: created.taskNo, title: input.title });
        return created;
    }
    static async list(user, filters) {
        const access = await taskAccessClause(user);
        const clauses = ['t.archived_at IS NULL'];
        const params = [];
        clauses.push(`1 = 1${access.clause}`);
        params.push(...access.params);
        if (filters.view === 'mine') {
            clauses.push('EXISTS (SELECT 1 FROM task_assignments ta2 WHERE ta2.task_id = t.id AND ta2.employee_id = ?)');
            params.push(user.id);
        }
        else if (filters.view === 'allocated') {
            clauses.push('t.created_by = ?');
            params.push(user.id);
        }
        if (filters.status) {
            clauses.push('t.status = ?');
            params.push(filters.status);
        }
        if (filters.priority) {
            clauses.push('t.priority = ?');
            params.push(filters.priority);
        }
        if (filters.assigneeId) {
            clauses.push('EXISTS (SELECT 1 FROM task_assignments ta3 WHERE ta3.task_id = t.id AND ta3.employee_id = ?)');
            params.push(filters.assigneeId);
        }
        if (filters.departmentId) {
            clauses.push('t.department_id = ?');
            params.push(filters.departmentId);
        }
        if (filters.projectId) {
            clauses.push('t.project_id = ?');
            params.push(filters.projectId);
        }
        if (filters.search) {
            clauses.push('(t.title LIKE ? OR t.task_no LIKE ? OR t.description LIKE ?)');
            const term = `%${filters.search}%`;
            params.push(term, term, term);
        }
        if (filters.dueFrom) {
            clauses.push('t.due_date >= ?');
            params.push(filters.dueFrom);
        }
        if (filters.dueTo) {
            clauses.push('t.due_date <= ?');
            params.push(filters.dueTo);
        }
        if (filters.overdueOnly) {
            clauses.push("t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')");
        }
        const page = Math.max(1, filters.page ?? 1);
        const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));
        const where = clauses.join(' AND ');
        const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM tasks t WHERE ${where}`, params);
        const rows = await query(`SELECT t.*, c.full_name AS creator_name, m.full_name AS manager_name, d.name AS department_name, p.name AS project_name,
              (SELECT GROUP_CONCAT(e.full_name SEPARATOR ', ') FROM task_assignments ta JOIN employees e ON e.id = ta.employee_id WHERE ta.task_id = t.id) AS assignee_names,
              (SELECT GROUP_CONCAT(ta.employee_id) FROM task_assignments ta WHERE ta.task_id = t.id) AS assignee_ids
       FROM tasks t
       JOIN employees c ON c.id = t.created_by
       LEFT JOIN employees m ON m.id = t.manager_id
       LEFT JOIN departments d ON d.id = t.department_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE ${where}
       ORDER BY FIELD(t.status, 'pending_approval','in_progress','accepted','assigned','not_started','on_hold','overdue','rejected','completed','cancelled'),
                FIELD(t.priority, 'critical','high','medium','low'), t.due_date IS NULL, t.due_date ASC, t.id DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
        return {
            items: rows.map((r) => TaskService.mapTask(r)),
            total: Number(totalRow?.total ?? 0),
            page,
            pageSize,
        };
    }
    static mapTask(r) {
        return {
            id: Number(r.id),
            taskNo: r.task_no,
            title: r.title,
            description: r.description,
            category: r.category,
            priority: r.priority,
            status: r.status,
            progress: Number(r.progress),
            departmentId: r.department_id ? Number(r.department_id) : null,
            departmentName: r.department_name ?? null,
            projectId: r.project_id ? Number(r.project_id) : null,
            projectName: r.project_name ?? null,
            createdBy: Number(r.created_by),
            creatorName: r.creator_name ?? null,
            managerId: r.manager_id ? Number(r.manager_id) : null,
            managerName: r.manager_name ?? null,
            assigneeNames: r.assignee_names ?? null,
            assigneeIds: r.assignee_ids ? String(r.assignee_ids).split(',').map(Number) : [],
            startDate: r.start_date,
            dueDate: r.due_date,
            dueTime: r.due_time,
            estimatedMinutes: r.estimated_minutes === null ? null : Number(r.estimated_minutes),
            recurrence: r.recurrence,
            submittedAt: toIso(r.submitted_at),
            completedAt: toIso(r.completed_at),
            approvedAt: toIso(r.approved_at),
            rejectionReason: r.rejection_reason,
            createdAt: toIso(r.created_at),
            isOverdue: Boolean(r.due_date) &&
                String(r.due_date) < today() &&
                !['completed', 'cancelled', 'rejected'].includes(r.status),
        };
    }
    static async detail(taskId, user) {
        const access = await taskAccessClause(user);
        const row = await queryOne(`SELECT t.*, c.full_name AS creator_name, m.full_name AS manager_name, d.name AS department_name, p.name AS project_name,
              (SELECT GROUP_CONCAT(e.full_name SEPARATOR ', ') FROM task_assignments ta JOIN employees e ON e.id = ta.employee_id WHERE ta.task_id = t.id) AS assignee_names,
              (SELECT GROUP_CONCAT(ta.employee_id) FROM task_assignments ta WHERE ta.task_id = t.id) AS assignee_ids
       FROM tasks t
       JOIN employees c ON c.id = t.created_by
       LEFT JOIN employees m ON m.id = t.manager_id
       LEFT JOIN departments d ON d.id = t.department_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? AND t.archived_at IS NULL ${access.clause}`, [taskId, ...access.params]);
        if (!row)
            throw ApiError.notFound('Task not found or you do not have access to it.');
        const [assignments, subtasks, comments, timeLogs, attachments] = await Promise.all([
            query(`SELECT ta.id, ta.employee_id, e.full_name, ta.status, ta.assigned_at, ta.accepted_at, ta.started_at, ta.completed_at,
                ta.time_spent_minutes, ta.completion_note
         FROM task_assignments ta JOIN employees e ON e.id = ta.employee_id WHERE ta.task_id = ? ORDER BY ta.id`, [taskId]),
            query('SELECT id, title, is_done, position FROM task_subtasks WHERE task_id = ? ORDER BY position, id', [taskId]),
            query(`SELECT tc.id, tc.author_id, e.full_name AS author_name, tc.body, tc.created_at
         FROM task_comments tc JOIN employees e ON e.id = tc.author_id WHERE tc.task_id = ? ORDER BY tc.created_at ASC`, [taskId]),
            query(`SELECT tl.id, tl.employee_id, e.full_name, tl.started_at, tl.ended_at, tl.minutes, tl.note
         FROM task_time_logs tl JOIN employees e ON e.id = tl.employee_id WHERE tl.task_id = ? ORDER BY tl.started_at DESC`, [taskId]),
            query(`SELECT ta.id, ta.file_id, f.original_name, f.mime_type, f.size_bytes
         FROM task_attachments ta JOIN files f ON f.id = ta.file_id WHERE ta.task_id = ?`, [taskId]),
        ]);
        const totalLogged = timeLogs.reduce((sum, log) => sum + Number(log.minutes), 0);
        return {
            ...TaskService.mapTask(row),
            description: row.description,
            instructions: row.instructions,
            remarks: row.remarks,
            totalLoggedMinutes: totalLogged,
            assignments: assignments.map((a) => ({
                id: Number(a.id),
                employeeId: Number(a.employee_id),
                employeeName: a.full_name,
                status: a.status,
                assignedAt: toIso(a.assigned_at),
                acceptedAt: toIso(a.accepted_at),
                startedAt: toIso(a.started_at),
                completedAt: toIso(a.completed_at),
                timeSpentMinutes: Number(a.time_spent_minutes),
                completionNote: a.completion_note,
            })),
            subtasks: subtasks.map((s) => ({ id: Number(s.id), title: s.title, isDone: Boolean(s.is_done) })),
            comments: comments.map((c) => ({
                id: Number(c.id),
                authorId: Number(c.author_id),
                authorName: c.author_name,
                body: c.body,
                createdAt: toIso(c.created_at),
            })),
            timeLogs: timeLogs.map((t) => ({
                id: Number(t.id),
                employeeId: Number(t.employee_id),
                employeeName: t.full_name,
                startedAt: toIso(t.started_at),
                endedAt: toIso(t.ended_at),
                minutes: Number(t.minutes),
                note: t.note,
            })),
            attachments,
        };
    }
    static async loadForAction(taskId, conn) {
        const sql = `SELECT * FROM tasks WHERE id = ? AND archived_at IS NULL FOR UPDATE`;
        const row = conn ? await txQueryOne(conn, sql, [taskId]) : await queryOne('SELECT * FROM tasks WHERE id = ? AND archived_at IS NULL', [taskId]);
        if (!row)
            throw ApiError.notFound('Task not found');
        return row;
    }
    static async applyAction(taskId, action, user, payload, context) {
        const task = await TaskService.loadForAction(taskId);
        const assignment = await queryOne('SELECT id, employee_id, status, started_at FROM task_assignments WHERE task_id = ? AND employee_id = ?', [taskId, user.id]);
        const isManager = Number(task.created_by) === user.id || Number(task.manager_id) === user.id || user.permissions.includes('tasks.approve');
        const isAssignee = Boolean(assignment);
        const before = { status: task.status, progress: Number(task.progress) };
        const closeOpenLog = async (conn, employeeId) => {
            await conn.query(`UPDATE task_time_logs SET ended_at = NOW(3), minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, started_at, NOW(3)))
         WHERE task_id = ? AND employee_id = ? AND ended_at IS NULL`, [taskId, employeeId]);
            await conn.query(`UPDATE task_assignments SET time_spent_minutes =
           (SELECT COALESCE(SUM(minutes),0) FROM task_time_logs WHERE task_id = ? AND employee_id = ?)
         WHERE task_id = ? AND employee_id = ?`, [taskId, employeeId, taskId, employeeId]);
        };
        switch (action) {
            case 'accept': {
                if (!isAssignee)
                    throw ApiError.forbidden('Only assigned employees can accept this task.');
                if (!['assigned', 'not_started', 'rejected', 'on_hold'].includes(task.status)) {
                    throw ApiError.badRequest(`Task cannot be accepted while it is ${task.status}.`);
                }
                await execute('UPDATE task_assignments SET status = ?, accepted_at = COALESCE(accepted_at, NOW(3)) WHERE id = ?', ['accepted', assignment.id]);
                await execute("UPDATE tasks SET status = 'accepted' WHERE id = ?", [taskId]);
                await NotificationService.notify({
                    employeeIds: [Number(task.created_by)],
                    type: 'task_update',
                    title: 'Task accepted',
                    body: `${user.fullName} accepted "${task.title}".`,
                    link: `/tasks?task=${taskId}`,
                    actorId: user.id,
                });
                break;
            }
            case 'start': {
                if (!isAssignee)
                    throw ApiError.forbidden('Only assigned employees can start this task.');
                if (['completed', 'cancelled', 'pending_approval'].includes(task.status)) {
                    throw ApiError.badRequest(`Task cannot be started while it is ${task.status}.`);
                }
                await transaction(async (conn) => {
                    const open = await txQuery(conn, 'SELECT id FROM task_time_logs WHERE task_id = ? AND employee_id = ? AND ended_at IS NULL', [taskId, user.id]);
                    if (open.length === 0) {
                        await conn.query('INSERT INTO task_time_logs (task_id, employee_id, started_at, note) VALUES (?, ?, NOW(3), ?)', [
                            taskId,
                            user.id,
                            payload.note ?? null,
                        ]);
                    }
                    await conn.query('UPDATE task_assignments SET status = ?, started_at = COALESCE(started_at, NOW(3)) WHERE id = ?', [
                        'in_progress',
                        assignment.id,
                    ]);
                    await conn.query("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [taskId]);
                });
                break;
            }
            case 'hold': {
                if (!isAssignee && !isManager)
                    throw ApiError.forbidden('You cannot change this task.');
                await transaction(async (conn) => {
                    await closeOpenLog(conn, isAssignee ? user.id : Number(task.manager_id ?? task.created_by));
                    await conn.query("UPDATE tasks SET status = 'on_hold' WHERE id = ?", [taskId]);
                    if (isAssignee)
                        await conn.query("UPDATE task_assignments SET status = 'on_hold' WHERE id = ?", [assignment.id]);
                });
                break;
            }
            case 'resume': {
                if (!isAssignee)
                    throw ApiError.forbidden('Only the assignee can resume this task.');
                await transaction(async (conn) => {
                    await conn.query('INSERT INTO task_time_logs (task_id, employee_id, started_at) VALUES (?, ?, NOW(3))', [taskId, user.id]);
                    await conn.query("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [taskId]);
                    await conn.query("UPDATE task_assignments SET status = 'in_progress' WHERE id = ?", [assignment.id]);
                });
                break;
            }
            case 'progress': {
                if (!isAssignee && !isManager)
                    throw ApiError.forbidden('You cannot update this task.');
                const progress = Math.max(0, Math.min(100, Number(payload.progress ?? task.progress)));
                if (isAssignee) {
                    await execute("UPDATE tasks SET progress = ?, status = IF(status IN ('assigned','accepted','not_started'), 'in_progress', status) WHERE id = ?", [
                        progress,
                        taskId,
                    ]);
                }
                else {
                    await execute('UPDATE tasks SET progress = ? WHERE id = ?', [progress, taskId]);
                }
                if (payload.note) {
                    await execute('INSERT INTO task_comments (task_id, author_id, body) VALUES (?, ?, ?)', [taskId, user.id, payload.note]);
                }
                break;
            }
            case 'submit': {
                if (!isAssignee)
                    throw ApiError.forbidden('Only the assignee can submit this task.');
                if (!payload.completionNote || payload.completionNote.trim().length < 5) {
                    throw ApiError.badRequest('Describe the completed work before submitting for approval.');
                }
                await transaction(async (conn) => {
                    await closeOpenLog(conn, user.id);
                    await conn.query(`UPDATE task_assignments SET status = 'pending_approval', completed_at = NOW(3), completion_note = ? WHERE id = ?`, [payload.completionNote.trim(), assignment.id]);
                    await conn.query("UPDATE tasks SET status = 'pending_approval', submitted_at = NOW(3), progress = 100, rejection_reason = NULL WHERE id = ?", [taskId]);
                });
                await NotificationService.notify({
                    employeeIds: [Number(task.created_by), ...(task.manager_id ? [Number(task.manager_id)] : [])],
                    type: 'task_update',
                    title: 'Task awaiting your approval',
                    body: `${user.fullName} submitted "${task.title}" for review.`,
                    link: `/tasks?task=${taskId}`,
                    priority: 'high',
                    actorId: user.id,
                });
                break;
            }
            case 'approve': {
                if (!isManager)
                    throw ApiError.forbidden('Only the allocating manager can approve this task.');
                if (task.status !== 'pending_approval')
                    throw ApiError.badRequest('Only submitted tasks can be approved.');
                await transaction(async (conn) => {
                    await conn.query("UPDATE tasks SET status = 'completed', progress = 100, completed_at = NOW(3), approved_at = NOW(3), approved_by = ? WHERE id = ?", [user.id, taskId]);
                    await conn.query("UPDATE task_assignments SET status = 'completed', completed_at = COALESCE(completed_at, NOW(3)) WHERE task_id = ?", [taskId]);
                    await closeOpenLog(conn, user.id);
                });
                const assignees = await query('SELECT employee_id FROM task_assignments WHERE task_id = ?', [taskId]);
                await NotificationService.notify({
                    employeeIds: assignees.map((a) => Number(a.employee_id)),
                    type: 'task_update',
                    title: 'Task approved',
                    body: `Your work on "${task.title}" was approved.`,
                    link: `/tasks?task=${taskId}`,
                    actorId: user.id,
                });
                await TaskService.createNextRecurrence(task, user);
                break;
            }
            case 'request_changes': {
                if (!isManager)
                    throw ApiError.forbidden('Only the allocating manager can request changes.');
                if (!payload.note)
                    throw ApiError.badRequest('Explain what needs to change.');
                await execute("UPDATE tasks SET status = 'in_progress', rejection_reason = ?, submitted_at = NULL, progress = 80 WHERE id = ?", [payload.note.slice(0, 255), taskId]);
                await execute("UPDATE task_assignments SET status = 'in_progress' WHERE task_id = ?", [taskId]);
                await execute('INSERT INTO task_comments (task_id, author_id, body) VALUES (?, ?, ?)', [taskId, user.id, payload.note]);
                const assignees = await query('SELECT employee_id FROM task_assignments WHERE task_id = ?', [taskId]);
                await NotificationService.notify({
                    employeeIds: assignees.map((a) => Number(a.employee_id)),
                    type: 'task_update',
                    title: 'Changes requested',
                    body: `"${task.title}" needs revision: ${payload.note}`,
                    link: `/tasks?task=${taskId}`,
                    priority: 'high',
                    actorId: user.id,
                });
                break;
            }
            case 'reassign': {
                if (!isManager)
                    throw ApiError.forbidden('Only the allocating manager can reassign tasks.');
                if (!payload.assigneeId)
                    throw ApiError.badRequest('Select an employee to reassign to.');
                await assertCanAllocateTo(user, payload.assigneeId);
                await transaction(async (conn) => {
                    await conn.query('DELETE FROM task_assignments WHERE task_id = ? AND status = ?', [taskId, 'assigned']);
                    const existing = await txQuery(conn, 'SELECT id FROM task_assignments WHERE task_id = ? AND employee_id = ?', [
                        taskId,
                        payload.assigneeId,
                    ]);
                    if (existing.length === 0) {
                        await conn.query("INSERT INTO task_assignments (task_id, employee_id, assigned_by, status) VALUES (?, ?, ?, 'assigned')", [
                            taskId,
                            payload.assigneeId,
                            user.id,
                        ]);
                    }
                    await conn.query("UPDATE tasks SET status = 'assigned', progress = 0 WHERE id = ?", [taskId]);
                });
                await recordAudit({
                    actorId: user.id,
                    action: 'task.reassigned',
                    entityType: 'task',
                    entityId: taskId,
                    before: { assignees: 'previous' },
                    after: { assigneeId: payload.assigneeId },
                    ip: context.ip,
                    userAgent: context.userAgent,
                });
                await NotificationService.notify({
                    employeeIds: [payload.assigneeId],
                    type: 'task_assigned',
                    title: 'Task reassigned to you',
                    body: `${user.fullName} reassigned "${task.title}" to you.`,
                    link: `/tasks?task=${taskId}`,
                    priority: 'high',
                    actorId: user.id,
                });
                break;
            }
            case 'cancel': {
                if (!isManager)
                    throw ApiError.forbidden('Only the allocating manager can cancel this task.');
                await execute("UPDATE tasks SET status = 'cancelled' WHERE id = ?", [taskId]);
                const assignees = await query('SELECT employee_id FROM task_assignments WHERE task_id = ?', [taskId]);
                await NotificationService.notify({
                    employeeIds: assignees.map((a) => Number(a.employee_id)),
                    type: 'task_update',
                    title: 'Task cancelled',
                    body: `"${task.title}" was cancelled.`,
                    link: `/tasks?task=${taskId}`,
                    actorId: user.id,
                });
                break;
            }
            case 'reopen': {
                if (!isManager)
                    throw ApiError.forbidden('Only the allocating manager can reopen a task.');
                await execute("UPDATE tasks SET status = 'in_progress', progress = 50, completed_at = NULL, approved_at = NULL WHERE id = ?", [taskId]);
                await execute("UPDATE task_assignments SET status = 'in_progress', completed_at = NULL WHERE task_id = ?", [taskId]);
                break;
            }
            default:
                throw ApiError.badRequest('Unsupported task action');
        }
        await recordAudit({
            actorId: user.id,
            action: `task.${action}`,
            entityType: 'task',
            entityId: taskId,
            before,
            after: { status: action, note: payload.note ?? null },
            ip: context.ip,
            userAgent: context.userAgent,
        });
        const detail = await TaskService.detail(taskId, user);
        emitToEmployees([...detail.assigneeIds, detail.createdBy, ...(detail.managerId ? [detail.managerId] : [])].filter(Boolean), 'task:updated', {
            id: taskId,
            status: detail.status,
        });
    }
    static async createNextRecurrence(task, actor) {
        if (!task.recurrence || task.recurrence === 'none' || !task.due_date)
            return;
        const step = task.recurrence === 'daily' ? 1 : task.recurrence === 'weekly' ? 7 : 0;
        let nextDue;
        if (task.recurrence === 'monthly') {
            const [y, m, d] = String(task.due_date).split('-').map(Number);
            const date = new Date(Date.UTC(y, m, d));
            date.setUTCMonth(date.getUTCMonth() + 1);
            nextDue = date.toISOString().slice(0, 10);
        }
        else {
            nextDue = addDays(String(task.due_date), step);
        }
        if (task.recurrence_end_date && nextDue > String(task.recurrence_end_date))
            return;
        const assignees = await query('SELECT employee_id FROM task_assignments WHERE task_id = ?', [task.id]);
        const seqRow = await queryOne("SELECT setting_value FROM system_settings WHERE setting_key = 'task_no_seq'");
        const nextNo = Number(seqRow?.setting_value ?? 0) + 1;
        await execute(`INSERT INTO tasks (task_no, title, description, category, department_id, project_id, priority, status, created_by, manager_id,
        start_date, due_date, due_time, estimated_minutes, instructions, remarks, recurrence, recurrence_end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            `TSK-${String(nextNo).padStart(5, '0')}`,
            task.title,
            task.description,
            task.category,
            task.department_id,
            task.project_id,
            task.priority,
            task.created_by,
            task.manager_id,
            nextDue,
            nextDue,
            task.due_time,
            task.estimated_minutes,
            task.instructions,
            task.remarks,
            task.recurrence,
            task.recurrence_end_date,
        ]);
        await execute("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'task_no_seq'", [String(nextNo)]);
        const created = await queryOne('SELECT id FROM tasks WHERE task_no = ?', [`TSK-${String(nextNo).padStart(5, '0')}`]);
        if (created) {
            for (const a of assignees) {
                await execute(`INSERT INTO task_assignments (task_id, employee_id, assigned_by, status) VALUES (?, ?, ?, 'assigned')`, [created.id, a.employee_id, actor.id]);
            }
            await NotificationService.notify({
                employeeIds: assignees.map((a) => Number(a.employee_id)),
                type: 'task_assigned',
                title: 'Recurring task scheduled',
                body: `Next occurrence of "${task.title}" is due ${nextDue}.`,
                link: `/tasks?task=${created.id}`,
                actorId: actor.id,
            });
        }
    }
    static async addComment(taskId, user, body) {
        await TaskService.detail(taskId, user); // access check
        if (!body.trim())
            throw ApiError.badRequest('Comment cannot be empty');
        await execute('INSERT INTO task_comments (task_id, author_id, body) VALUES (?, ?, ?)', [taskId, user.id, body.trim()]);
        const rows = await query('SELECT employee_id FROM task_assignments WHERE task_id = ?', [taskId]);
        const detail = await queryOne('SELECT created_by, title FROM tasks WHERE id = ?', [taskId]);
        const recipients = new Set(rows.map((r) => Number(r.employee_id)));
        if (detail)
            recipients.add(Number(detail.created_by));
        recipients.delete(user.id);
        await NotificationService.notify({
            employeeIds: [...recipients],
            type: 'task_comment',
            title: 'New task comment',
            body: `${user.fullName} commented on "${detail?.title ?? 'a task'}".`,
            link: `/tasks?task=${taskId}`,
            actorId: user.id,
        });
    }
    static async toggleSubtask(taskId, subtaskId, user) {
        await TaskService.detail(taskId, user);
        await execute('UPDATE task_subtasks SET is_done = 1 - is_done WHERE id = ? AND task_id = ?', [subtaskId, taskId]);
    }
    static async addSubtask(taskId, user, title) {
        await TaskService.detail(taskId, user);
        const result = await execute('INSERT INTO task_subtasks (task_id, title) VALUES (?, ?)', [taskId, title]);
        await execute('UPDATE task_subtasks SET position = ? WHERE id = ?', [result.insertId, result.insertId]);
    }
    static async logTime(taskId, user, minutes, note) {
        await TaskService.detail(taskId, user);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)
            throw ApiError.badRequest('Enter valid minutes (1-1440).');
        await execute(`INSERT INTO task_time_logs (task_id, employee_id, started_at, ended_at, minutes, note, is_manual)
       VALUES (?, ?, DATE_SUB(NOW(3), INTERVAL ? MINUTE), NOW(3), ?, ?, 1)`, [taskId, user.id, minutes, minutes, note ?? null]);
        await execute(`UPDATE task_assignments SET time_spent_minutes =
         (SELECT COALESCE(SUM(minutes),0) FROM task_time_logs WHERE task_id = ? AND employee_id = ?)
       WHERE task_id = ? AND employee_id = ?`, [taskId, user.id, taskId, user.id]);
    }
    static async stats(user) {
        const access = await taskAccessClause(user);
        const row = await queryOne(`SELECT COUNT(*) AS total,
              SUM(t.status IN ('assigned','accepted','in_progress','on_hold','not_started')) AS active,
              SUM(t.status = 'completed') AS completed,
              SUM(t.status IN ('assigned','accepted','in_progress','on_hold','not_started','pending_approval')) AS pending,
              SUM(t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')) AS overdue,
              SUM(t.status = 'pending_approval') AS pending_approval
       FROM tasks t WHERE t.archived_at IS NULL ${access.clause.replace(/^ AND /, ' AND ')}`, access.params);
        return {
            total: Number(row?.total ?? 0),
            active: Number(row?.active ?? 0),
            completed: Number(row?.completed ?? 0),
            pending: Number(row?.pending ?? 0),
            overdue: Number(row?.overdue ?? 0),
            awaitingApproval: Number(row?.pending_approval ?? 0),
        };
    }
    /** Marks tasks past their due date as overdue and notifies once per task per day. */
    static async markOverdue() {
        const rows = await query(`SELECT id, title, created_by, manager_id FROM tasks
       WHERE due_date < CURDATE() AND status NOT IN ('completed','cancelled','rejected','overdue')
       LIMIT 500`);
        for (const row of rows) {
            await execute("UPDATE tasks SET status = 'overdue' WHERE id = ?", [row.id]);
            const assignees = await query('SELECT employee_id FROM task_assignments WHERE task_id = ?', [row.id]);
            const recipients = new Set(assignees.map((a) => Number(a.employee_id)));
            recipients.add(Number(row.created_by));
            if (row.manager_id)
                recipients.add(Number(row.manager_id));
            await NotificationService.notify({
                employeeIds: [...recipients],
                type: 'task_overdue',
                title: 'Task overdue',
                body: `"${row.title}" is past its due date.`,
                link: `/tasks?task=${row.id}`,
                priority: 'high',
                dedupeKey: `overdue:${row.id}:${today()}`,
            });
        }
        return rows.length;
    }
    /** Reminds assignees about work due tomorrow. */
    static async dueTomorrowReminders() {
        const rows = await query(`SELECT t.id, t.title, ta.employee_id FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       WHERE t.due_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
         AND t.status NOT IN ('completed','cancelled','rejected')`);
        for (const row of rows) {
            await NotificationService.notify({
                employeeIds: [Number(row.employee_id)],
                type: 'task_due',
                title: 'Task due tomorrow',
                body: `"${row.title}" is due tomorrow.`,
                link: `/tasks?task=${row.id}`,
                priority: 'normal',
                dedupeKey: `due_tomorrow:${row.id}:${today()}`,
            });
        }
        return rows.length;
    }
}
//# sourceMappingURL=TaskService.js.map