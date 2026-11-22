import { execute, query, queryOne } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { today, toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { locationEmployeeClause, subtreeIds } from '../lib/scope.js';
import { emitToEmployee } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import type { AuthUser } from './AuthService.js';

interface ReportRow {
  id: number;
  employee_id: number;
  full_name: string;
  employee_code: string;
  department_name: string | null;
  designation_title: string | null;
  location_name?: string | null;
  report_date: string;
  work_start: string | null;
  work_end: string | null;
  total_minutes: number;
  summary: string;
  problems: string | null;
  support_required: string | null;
  support_dept_id?: number | null;
  support_manager_id?: number | null;
  support_manager_name?: string | null;
  support_dept_name?: string | null;
  tomorrow_plan: string | null;
  tasks_completed: number;
  tasks_in_progress: number;
  tasks_pending: number;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  reviewer_name: string | null;
  created_at: string;
}

function mapReport(r: ReportRow) {
  return {
    id: Number(r.id),
    employeeId: Number(r.employee_id),
    employeeName: r.full_name,
    employeeCode: r.employee_code,
    departmentName: r.department_name,
    designationTitle: r.designation_title,
    locationName: r.location_name ?? null,
    reportDate: r.report_date,
    workStart: r.work_start,
    workEnd: r.work_end,
    totalMinutes: Number(r.total_minutes),
    summary: r.summary,
    problems: r.problems,
    supportRequired: r.support_required,
    supportDeptId: r.support_dept_id ? Number(r.support_dept_id) : null,
    supportManagerId: r.support_manager_id ? Number(r.support_manager_id) : null,
    supportManagerName: r.support_manager_name ?? null,
    supportDeptName: r.support_dept_name ?? null,
    tomorrowPlan: r.tomorrow_plan,
    tasksCompleted: Number(r.tasks_completed),
    tasksInProgress: Number(r.tasks_in_progress),
    tasksPending: Number(r.tasks_pending),
    status: r.status,
    submittedAt: toIso(r.submitted_at),
    reviewedAt: toIso(r.reviewed_at),
    reviewNote: r.review_note,
    reviewerName: r.reviewer_name,
    createdAt: toIso(r.created_at),
  };
}

export class DailyReportService {
  private static async scopeClause(user: AuthUser): Promise<{ clause: string; params: unknown[] }> {
    if (user.permissions.includes('reports.view.all')) return locationEmployeeClause(user, 'r.employee_id');
    if (user.permissions.includes('reports.view.team')) {
      const ids = await subtreeIds(user.id);
      if (ids.length === 0) return { clause: '1 = 0', params: [] };
      return { clause: `r.employee_id IN (${ids.map(() => '?').join(',')})`, params: ids };
    }
    return { clause: 'r.employee_id = ?', params: [user.id] };
  }

  /** Suggested task counts and live tasks for the report form, derived from live task state. */
  static async suggestions(employeeId: number, date = today()) {
    const row = await queryOne<{ completed: number; in_progress: number; pending: number }>(
      `SELECT
        SUM(t.status = 'completed' AND (DATE(t.completed_at) = ? OR t.completed_at IS NULL)) AS completed,
        SUM(t.status IN ('in_progress','on_hold','accepted')) AS in_progress,
        SUM(t.status IN ('assigned','not_started','pending_approval','overdue')) AS pending
       FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.employee_id = ? AND t.archived_at IS NULL`,
      [date, employeeId],
    );

    const assignedTasks = await query<{
      id: number;
      title: string;
      priority: string;
      status: string;
      completed_at: string | null;
      created_at: string;
    }>(
      `SELECT t.id, t.title, t.priority, t.status, t.completed_at, t.created_at
       FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.employee_id = ? AND t.archived_at IS NULL
       ORDER BY t.status = 'in_progress' DESC, t.status = 'assigned' DESC, t.created_at DESC
       LIMIT 30`,
      [employeeId],
    );

    const attendance = await queryOne<{ check_in_at: string | null; check_out_at: string | null; total_minutes: number; status: string }>(
      'SELECT check_in_at, check_out_at, total_minutes, status FROM attendance WHERE employee_id = ? AND work_date = ?',
      [employeeId, date],
    );

    const employee = await queryOne<{
      id: number;
      full_name: string;
      employee_code: string;
      location_name: string | null;
      department_name: string | null;
      designation_title: string | null;
      manager_name: string | null;
      manager_id: number | null;
    }>(
      `SELECT e.id, e.full_name, e.employee_code, l.name AS location_name, d.name AS department_name, dg.title AS designation_title, m.full_name AS manager_name, e.manager_id
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       WHERE e.id = ?`,
      [employeeId],
    );

    const completed = Number(row?.completed ?? 0);
    const inProgress = Number(row?.in_progress ?? 0);
    const pending = Number(row?.pending ?? 0);
    const totalAssigned = completed + inProgress + pending;

    return {
      date,
      tasksCompleted: completed,
      tasksInProgress: inProgress,
      tasksPending: pending,
      totalAssigned,
      hasAssignedTasks: totalAssigned > 0,
      assignedTasks: assignedTasks.map((t) => ({
        id: Number(t.id),
        title: t.title,
        priority: t.priority,
        status: t.status,
        completedAt: toIso(t.completed_at),
        createdAt: toIso(t.created_at),
      })),
      attendance,
      employee: employee
        ? {
            id: Number(employee.id),
            name: employee.full_name,
            code: employee.employee_code,
            location: employee.location_name,
            department: employee.department_name,
            designation: employee.designation_title,
            managerName: employee.manager_name,
            managerId: employee.manager_id ? Number(employee.manager_id) : null,
          }
        : null,
    };
  }

  static async submit(
    employeeId: number,
    input: {
      reportDate: string;
      summary: string;
      problems?: string;
      supportRequired?: string;
      supportDeptId?: number;
      supportManagerId?: number;
      tomorrowPlan?: string;
      workStart?: string;
      workEnd?: string;
      totalMinutes?: number;
      tasksCompleted?: number;
      tasksInProgress?: number;
      tasksPending?: number;
      attachmentIds?: number[];
    },
    context: { ip?: string; userAgent?: string },
  ) {
    if (!input.summary || input.summary.trim().length < 10) {
      throw ApiError.badRequest('Describe the work completed today (at least 10 characters).');
    }
    if (input.reportDate > today()) throw ApiError.badRequest('You cannot submit a report for a future date.');

    const employee = await queryOne<{ manager_id: number | null; full_name: string }>(
      'SELECT manager_id, full_name FROM employees WHERE id = ?',
      [employeeId],
    );

    await execute(
      `INSERT INTO daily_work_reports
        (employee_id, report_date, work_start, work_end, total_minutes, summary, problems, support_required, support_dept_id, support_manager_id, tomorrow_plan,
         tasks_completed, tasks_in_progress, tasks_pending, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', NOW(3))
       ON DUPLICATE KEY UPDATE
         work_start = VALUES(work_start), work_end = VALUES(work_end), total_minutes = VALUES(total_minutes),
         summary = VALUES(summary), problems = VALUES(problems), support_required = VALUES(support_required),
         support_dept_id = VALUES(support_dept_id), support_manager_id = VALUES(support_manager_id),
         tomorrow_plan = VALUES(tomorrow_plan), tasks_completed = VALUES(tasks_completed),
         tasks_in_progress = VALUES(tasks_in_progress), tasks_pending = VALUES(tasks_pending),
         status = 'submitted', submitted_at = NOW(3), reviewed_by = NULL, reviewed_at = NULL, review_note = NULL`,
      [
        employeeId,
        input.reportDate,
        input.workStart ?? null,
        input.workEnd ?? null,
        input.totalMinutes ?? 0,
        input.summary.trim(),
        input.problems?.trim() || null,
        input.supportRequired?.trim() || null,
        input.supportDeptId ?? null,
        input.supportManagerId ?? null,
        input.tomorrowPlan?.trim() || null,
        input.tasksCompleted ?? 0,
        input.tasksInProgress ?? 0,
        input.tasksPending ?? 0,
      ],
    );

    const report = await queryOne<{ id: number }>('SELECT id FROM daily_work_reports WHERE employee_id = ? AND report_date = ?', [
      employeeId,
      input.reportDate,
    ]);

    if (report) {
      // Record in history audit table
      await execute(
        `INSERT INTO daily_report_history (report_id, actor_id, action, status, summary, problems, support_required, tomorrow_plan, tasks_completed, tasks_in_progress, tasks_pending)
         VALUES (?, ?, 'submitted', 'submitted', ?, ?, ?, ?, ?, ?, ?)`,
        [
          report.id,
          employeeId,
          input.summary.trim(),
          input.problems?.trim() || null,
          input.supportRequired?.trim() || null,
          input.tomorrowPlan?.trim() || null,
          input.tasksCompleted ?? 0,
          input.tasksInProgress ?? 0,
          input.tasksPending ?? 0,
        ],
      );

      if (input.attachmentIds?.length) {
        for (const fileId of input.attachmentIds) {
          await execute('INSERT IGNORE INTO daily_report_attachments (report_id, file_id) VALUES (?, ?)', [report.id, fileId]);
        }
      }
    }

    await recordAudit({
      actorId: employeeId,
      action: 'daily_report.submitted',
      entityType: 'daily_work_report',
      entityId: report?.id ?? null,
      after: { date: input.reportDate },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    if (employee?.manager_id) {
      await NotificationService.notify({
        employeeIds: [Number(employee.manager_id)],
        type: 'daily_report',
        title: 'Daily work report submitted',
        body: `${employee.full_name} submitted their EOD report for ${input.reportDate}.`,
        link: `/reports?report=${report?.id ?? ''}`,
        actorId: employeeId,
      });
    }

    emitToEmployee(employeeId, 'report:updated', { id: report?.id, date: input.reportDate });
    return { id: report?.id ?? null };
  }

  static async list(
    user: AuthUser,
    filters: { employeeId?: number; locationId?: number; from?: string; to?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const scope = await DailyReportService.scopeClause(user);
    const clauses = [scope.clause];
    const params: unknown[] = [...scope.params];

    if (filters.employeeId) {
      clauses.push('r.employee_id = ?');
      params.push(filters.employeeId);
    }
    if (filters.locationId) {
      clauses.push('e.location_id = ?');
      params.push(filters.locationId);
    }
    if (filters.from) {
      clauses.push('r.report_date >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('r.report_date <= ?');
      params.push(filters.to);
    }
    if (filters.status) {
      clauses.push('r.status = ?');
      params.push(filters.status);
    }

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));
    const where = clauses.join(' AND ');

    const rows = await query<ReportRow>(
      `SELECT r.*, e.full_name, e.employee_code, d.name AS department_name, dg.title AS designation_title,
              l.name AS location_name, rv.full_name AS reviewer_name,
              sd.name AS support_dept_name, sm.full_name AS support_manager_name
       FROM daily_work_reports r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN employees rv ON rv.id = r.reviewed_by
       LEFT JOIN departments sd ON sd.id = r.support_dept_id
       LEFT JOIN employees sm ON sm.id = r.support_manager_id
       WHERE ${where}
       ORDER BY r.report_date DESC, r.id DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const total = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM daily_work_reports r JOIN employees e ON e.id = r.employee_id WHERE ${where}`,
      params,
    );
    return { items: rows.map(mapReport), total: Number(total?.total ?? 0), page, pageSize };
  }

  static async detail(reportId: number, user: AuthUser) {
    const scope = await DailyReportService.scopeClause(user);
    const row = await queryOne<ReportRow>(
      `SELECT r.*, e.full_name, e.employee_code, d.name AS department_name, dg.title AS designation_title,
              l.name AS location_name, rv.full_name AS reviewer_name,
              sd.name AS support_dept_name, sm.full_name AS support_manager_name
       FROM daily_work_reports r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN employees rv ON rv.id = r.reviewed_by
       LEFT JOIN departments sd ON sd.id = r.support_dept_id
       LEFT JOIN employees sm ON sm.id = r.support_manager_id
       WHERE r.id = ? AND ${scope.clause}`,
      [reportId, ...scope.params],
    );
    if (!row) throw ApiError.notFound('Report not found or outside your access scope');
    const attachments = await query<{ file_id: number; original_name: string; mime_type: string; size_bytes: number }>(
      `SELECT f.id AS file_id, f.original_name, f.mime_type, f.size_bytes
       FROM daily_report_attachments a JOIN files f ON f.id = a.file_id WHERE a.report_id = ?`,
      [reportId],
    );

    const history = await query<{
      id: number;
      actor_id: number;
      actor_name: string;
      action: string;
      status: string;
      summary: string | null;
      review_note: string | null;
      created_at: string;
    }>(
      `SELECT h.*, e.full_name AS actor_name
       FROM daily_report_history h
       JOIN employees e ON e.id = h.actor_id
       WHERE h.report_id = ?
       ORDER BY h.id ASC`,
      [reportId],
    );

    return {
      ...mapReport(row),
      attachments,
      history: history.map((h) => ({
        id: Number(h.id),
        actorId: Number(h.actor_id),
        actorName: h.actor_name,
        action: h.action,
        status: h.status,
        summary: h.summary,
        reviewNote: h.review_note,
        createdAt: toIso(h.created_at),
      })),
    };
  }

  static async review(
    reportId: number,
    reviewer: AuthUser,
    input: { approve: boolean; note?: string },
    context: { ip?: string; userAgent?: string },
  ) {
    const scope = await DailyReportService.scopeClause(reviewer);
    const report = await queryOne<{ id: number; employee_id: number; report_date: string; status: string; full_name: string; summary: string }>(
      `SELECT r.id, r.employee_id, r.report_date, r.status, r.summary, e.full_name
       FROM daily_work_reports r JOIN employees e ON e.id = r.employee_id
       WHERE r.id = ? AND ${scope.clause}`,
      [reportId, ...scope.params],
    );
    if (!report) throw ApiError.notFound('Report not found');
    if (report.status === 'approved' && input.approve) throw ApiError.conflict('This report is already reviewed & approved.');
    if (!input.approve && !input.note) throw ApiError.badRequest('Please explain what needs to be corrected in the report.');

    const newStatus = input.approve ? 'approved' : 'changes_requested';

    await execute(
      `UPDATE daily_work_reports SET status = ?, reviewed_by = ?, reviewed_at = NOW(3), review_note = ? WHERE id = ?`,
      [newStatus, reviewer.id, input.note ?? null, reportId],
    );

    // Record in history audit table
    await execute(
      `INSERT INTO daily_report_history (report_id, actor_id, action, status, summary, review_note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [reportId, reviewer.id, input.approve ? 'reviewed' : 'correction_requested', newStatus, report.summary, input.note ?? null],
    );

    await recordAudit({
      actorId: reviewer.id,
      action: input.approve ? 'daily_report.approved' : 'daily_report.changes_requested',
      entityType: 'daily_work_report',
      entityId: reportId,
      before: { status: report.status },
      after: { status: newStatus, note: input.note },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await NotificationService.notify({
      employeeIds: [Number(report.employee_id)],
      type: 'daily_report',
      title: input.approve ? 'EOD report reviewed & approved' : 'EOD report returned for correction',
      body: input.approve
        ? `Your report for ${report.report_date} was approved by ${reviewer.fullName}.`
        : `Your report for ${report.report_date} was returned for correction: "${input.note ?? 'Please review'}"`,
      link: '/reports',
      priority: input.approve ? 'normal' : 'high',
      actorId: reviewer.id,
    });
    emitToEmployee(Number(report.employee_id), 'report:updated', { id: reportId, date: report.report_date });
  }

  static async update(
    reportId: number,
    user: AuthUser,
    input: {
      summary?: string;
      problems?: string;
      supportRequired?: string;
      supportDeptId?: number;
      supportManagerId?: number;
      tomorrowPlan?: string;
      workStart?: string;
      workEnd?: string;
      totalMinutes?: number;
      tasksCompleted?: number;
      tasksInProgress?: number;
      tasksPending?: number;
      status?: 'submitted' | 'approved' | 'changes_requested';
      reviewNote?: string;
    },
    context: { ip?: string; userAgent?: string } = {},
  ) {
    const report = await queryOne<{ id: number; employee_id: number; status: string; report_date: string; full_name: string; summary: string; problems: string | null; support_required: string | null; tomorrow_plan: string | null; tasks_completed: number; tasks_in_progress: number; tasks_pending: number }>(
      `SELECT r.*, e.full_name
       FROM daily_work_reports r
       JOIN employees e ON e.id = r.employee_id
       WHERE r.id = ?`,
      [reportId],
    );
    if (!report) throw ApiError.notFound('Report not found');

    const isAuthor = Number(report.employee_id) === user.id;
    const isReviewer =
      user.permissions.includes('reports.review') ||
      user.permissions.includes('reports.view.all') ||
      user.roleSlug === 'admin' ||
      user.roleSlug === 'super_admin' ||
      user.roleSlug === 'manager';
    if (!isAuthor && !isReviewer) {
      throw ApiError.forbidden('You do not have permission to edit this report');
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.summary !== undefined) {
      if (input.summary.trim().length < 10) throw ApiError.badRequest('Work completed summary must be at least 10 characters.');
      updates.push('summary = ?');
      params.push(input.summary.trim());
    }
    if (input.problems !== undefined) {
      updates.push('problems = ?');
      params.push(input.problems.trim() || null);
    }
    if (input.supportRequired !== undefined) {
      updates.push('support_required = ?');
      params.push(input.supportRequired.trim() || null);
    }
    if (input.supportDeptId !== undefined) {
      updates.push('support_dept_id = ?');
      params.push(input.supportDeptId);
    }
    if (input.supportManagerId !== undefined) {
      updates.push('support_manager_id = ?');
      params.push(input.supportManagerId);
    }
    if (input.tomorrowPlan !== undefined) {
      updates.push('tomorrow_plan = ?');
      params.push(input.tomorrowPlan.trim() || null);
    }
    if (input.tasksCompleted !== undefined) {
      updates.push('tasks_completed = ?');
      params.push(input.tasksCompleted);
    }
    if (input.tasksInProgress !== undefined) {
      updates.push('tasks_in_progress = ?');
      params.push(input.tasksInProgress);
    }
    if (input.tasksPending !== undefined) {
      updates.push('tasks_pending = ?');
      params.push(input.tasksPending);
    }
    if (input.totalMinutes !== undefined) {
      updates.push('total_minutes = ?');
      params.push(input.totalMinutes);
    }

    let newStatus = report.status;
    if (input.status) {
      newStatus = input.status;
      updates.push('status = ?');
      params.push(newStatus);
      if (newStatus === 'approved' || newStatus === 'changes_requested') {
        updates.push('reviewed_by = ?, reviewed_at = NOW(3)');
        params.push(user.id);
      } else if (newStatus === 'submitted') {
        updates.push('submitted_at = NOW(3)');
      }
    } else if (isAuthor && report.status === 'changes_requested') {
      newStatus = 'submitted';
      updates.push("status = 'submitted', submitted_at = NOW(3)");
    }

    if (input.reviewNote !== undefined) {
      updates.push('review_note = ?');
      params.push(input.reviewNote.trim() || null);
    }

    if (updates.length > 0) {
      params.push(reportId);
      await execute(`UPDATE daily_work_reports SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    // Record update in history
    await execute(
      `INSERT INTO daily_report_history (report_id, actor_id, action, status, summary, problems, support_required, tomorrow_plan, tasks_completed, tasks_in_progress, tasks_pending, review_note)
       VALUES (?, ?, 'updated', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reportId,
        user.id,
        newStatus,
        input.summary?.trim() ?? report.summary,
        input.problems !== undefined ? input.problems?.trim() || null : report.problems,
        input.supportRequired !== undefined ? input.supportRequired?.trim() || null : report.support_required,
        input.tomorrowPlan !== undefined ? input.tomorrowPlan?.trim() || null : report.tomorrow_plan,
        input.tasksCompleted ?? report.tasks_completed,
        input.tasksInProgress ?? report.tasks_in_progress,
        input.tasksPending ?? report.tasks_pending,
        input.reviewNote?.trim() ?? null,
      ],
    );

    await recordAudit({
      actorId: user.id,
      action: 'daily_report.updated',
      entityType: 'daily_work_report',
      entityId: reportId,
      before: { status: report.status },
      after: { status: newStatus, ...input },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    emitToEmployee(Number(report.employee_id), 'report:updated', { id: reportId, date: report.report_date });

    if (newStatus !== report.status) {
      await NotificationService.notify({
        employeeIds: [Number(report.employee_id)],
        type: 'daily_report',
        title: `EOD report status: ${newStatus.replace('_', ' ')}`,
        body: `Report for ${report.report_date} was updated to ${newStatus.replace('_', ' ')}.`,
        link: '/reports',
        priority: 'normal',
        actorId: user.id,
      });
    }

    return DailyReportService.detail(reportId, user);
  }

  static async todayStatus(employeeId: number) {
    const row = await queryOne<{ id: number; status: string; submitted_at: string | null; summary: string }>(
      'SELECT id, status, submitted_at, summary FROM daily_work_reports WHERE employee_id = ? AND report_date = ?',
      [employeeId, today()],
    );
    return row ? { id: Number(row.id), status: row.status, submittedAt: toIso(row.submitted_at), summary: row.summary } : null;
  }

  /** Compliance and Missing Submission Inspector for Managers and HR/Admin. */
  static async compliance(
    user: AuthUser,
    filters: { date?: string; locationId?: number; departmentId?: number },
  ) {
    const reportDate = filters.date || today();

    // Active employees within user scope
    const empClauses = ["e.status = 'active'"];
    const empParams: unknown[] = [];

    if (user.permissions.includes('reports.view.all')) {
      const loc = await locationEmployeeClause(user, 'e.id');
      empClauses.push(loc.clause);
      empParams.push(...loc.params);
    } else if (user.permissions.includes('reports.view.team')) {
      const ids = await subtreeIds(user.id);
      if (ids.length === 0) {
        return {
          date: reportDate,
          summary: { total: 0, submitted: 0, reviewed: 0, changesRequested: 0, missing: 0, rate: 0 },
          missingEmployees: [],
          submittedReports: [],
        };
      }
      empClauses.push(`e.id IN (${ids.map(() => '?').join(',')})`);
      empParams.push(...ids);
    } else {
      empClauses.push('e.id = ?');
      empParams.push(user.id);
    }

    if (filters.locationId) {
      empClauses.push('e.location_id = ?');
      empParams.push(filters.locationId);
    }
    if (filters.departmentId) {
      empClauses.push('e.department_id = ?');
      empParams.push(filters.departmentId);
    }

    const employees = await query<{
      id: number;
      full_name: string;
      employee_code: string;
      mobile: string;
      department_name: string | null;
      designation_title: string | null;
      location_name: string | null;
      manager_name: string | null;
      attendance_status: string | null;
      report_id: number | null;
      report_status: string | null;
      submitted_at: string | null;
      reviewer_name: string | null;
      review_note: string | null;
      tasks_completed: number | null;
      tasks_in_progress: number | null;
      tasks_pending: number | null;
      summary: string | null;
      problems: string | null;
      support_required: string | null;
      tomorrow_plan: string | null;
    }>(
      `SELECT e.id, e.full_name, e.employee_code, e.mobile,
              d.name AS department_name, dg.title AS designation_title,
              l.name AS location_name, m.full_name AS manager_name,
              att.status AS attendance_status,
              r.id AS report_id, r.status AS report_status, r.submitted_at,
              rv.full_name AS reviewer_name, r.review_note,
              r.tasks_completed, r.tasks_in_progress, r.tasks_pending,
              r.summary, r.problems, r.support_required, r.tomorrow_plan
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN attendance att ON att.employee_id = e.id AND att.work_date = ?
       LEFT JOIN daily_work_reports r ON r.employee_id = e.id AND r.report_date = ?
       LEFT JOIN employees rv ON rv.id = r.reviewed_by
       WHERE ${empClauses.join(' AND ')}
       ORDER BY l.name, d.name, e.full_name`,
      [reportDate, reportDate, ...empParams],
    );

    const total = employees.length;
    let submitted = 0;
    let reviewed = 0;
    let changesRequested = 0;
    let missing = 0;

    const missingEmployees: typeof employees = [];
    const submittedEmployees: typeof employees = [];

    for (const emp of employees) {
      if (!emp.report_id) {
        missing++;
        missingEmployees.push(emp);
      } else {
        submitted++;
        if (emp.report_status === 'approved') reviewed++;
        else if (emp.report_status === 'changes_requested') changesRequested++;
        submittedEmployees.push(emp);
      }
    }

    const rate = total > 0 ? Math.round((submitted / total) * 100) : 0;

    return {
      date: reportDate,
      summary: {
        total,
        submitted,
        reviewed,
        changesRequested,
        missing,
        rate,
      },
      missingEmployees: missingEmployees.map((e) => ({
        id: Number(e.id),
        name: e.full_name,
        code: e.employee_code,
        mobile: e.mobile,
        department: e.department_name,
        designation: e.designation_title,
        location: e.location_name,
        managerName: e.manager_name,
        attendanceStatus: e.attendance_status ?? 'No attendance record',
      })),
      submittedReports: submittedEmployees.map((e) => ({
        reportId: Number(e.report_id),
        employeeId: Number(e.id),
        name: e.full_name,
        code: e.employee_code,
        department: e.department_name,
        designation: e.designation_title,
        location: e.location_name,
        managerName: e.manager_name,
        status: e.report_status,
        submittedAt: toIso(e.submitted_at),
        reviewerName: e.reviewer_name,
        reviewNote: e.review_note,
        tasksCompleted: Number(e.tasks_completed ?? 0),
        tasksInProgress: Number(e.tasks_in_progress ?? 0),
        tasksPending: Number(e.tasks_pending ?? 0),
        summary: e.summary,
        problems: e.problems,
        supportRequired: e.support_required,
        tomorrowPlan: e.tomorrow_plan,
      })),
    };
  }

  /** Reminds employees who have not submitted today's report. */
  static async remindMissing(): Promise<number> {
    const rows = await query<{ id: number; full_name: string; manager_id: number | null }>(
      `SELECT e.id, e.full_name, e.manager_id FROM employees e
       WHERE e.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM daily_work_reports r WHERE r.employee_id = e.id AND r.report_date = CURDATE())
         AND EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.work_date = CURDATE() AND a.check_in_at IS NOT NULL)`,
    );
    for (const row of rows) {
      await NotificationService.notify({
        employeeIds: [Number(row.id)],
        type: 'daily_report',
        title: 'End-of-Day report pending',
        body: 'Please submit your End-of-Day work report before signing off.',
        link: '/reports',
        priority: 'high',
        dedupeKey: `report_reminder:${row.id}:${today()}`,
      });

      if (row.manager_id) {
        await NotificationService.notify({
          employeeIds: [Number(row.manager_id)],
          type: 'daily_report',
          title: 'Missing EOD report reminder',
          body: `${row.full_name} has not submitted their End-of-Day report for today.`,
          link: '/reports?tab=missing',
          priority: 'normal',
          dedupeKey: `mgr_missing_reminder:${row.manager_id}:${row.id}:${today()}`,
        });
      }
    }
    return rows.length;
  }

  /** Generate Excel file of EOD reports for export. */
  static async exportExcel(
    user: AuthUser,
    filters: { from?: string; to?: string; locationId?: number; employeeId?: number },
  ) {
    const { items } = await DailyReportService.list(user, { ...filters, pageSize: 5000 });
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'BSC Textiles HRMS';
    wb.created = new Date();

    const ws = wb.addWorksheet('EOD Reports', {
      views: [{ showGridLines: true }],
    });

    // Styling
    ws.columns = [
      { header: 'Report ID', key: 'id', width: 12 },
      { header: 'Date', key: 'reportDate', width: 14 },
      { header: 'Employee Code', key: 'employeeCode', width: 18 },
      { header: 'Employee Name', key: 'employeeName', width: 25 },
      { header: 'Location', key: 'locationName', width: 18 },
      { header: 'Department', key: 'departmentName', width: 22 },
      { header: 'Designation', key: 'designationTitle', width: 24 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Tasks Done', key: 'tasksCompleted', width: 14 },
      { header: 'Tasks Active', key: 'tasksInProgress', width: 14 },
      { header: 'Tasks Pending', key: 'tasksPending', width: 14 },
      { header: 'Work Completed Today', key: 'summary', width: 45 },
      { header: 'Problems Encountered', key: 'problems', width: 35 },
      { header: 'Support Required', key: 'supportRequired', width: 35 },
      { header: "Tomorrow's Plan", key: 'tomorrowPlan', width: 35 },
      { header: 'Reviewed By', key: 'reviewerName', width: 22 },
      { header: 'Reviewer Note', key: 'reviewNote', width: 30 },
      { header: 'Submitted At', key: 'submittedAt', width: 22 },
    ];

    // Header styling
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    headerRow.height = 26;

    for (const item of items) {
      ws.addRow({
        id: item.id,
        reportDate: item.reportDate,
        employeeCode: item.employeeCode,
        employeeName: item.employeeName,
        locationName: item.locationName ?? 'N/A',
        departmentName: item.departmentName ?? 'N/A',
        designationTitle: item.designationTitle ?? 'N/A',
        status: item.status.toUpperCase(),
        tasksCompleted: item.tasksCompleted,
        tasksInProgress: item.tasksInProgress,
        tasksPending: item.tasksPending,
        summary: item.summary,
        problems: item.problems ?? '',
        supportRequired: item.supportRequired ?? '',
        tomorrowPlan: item.tomorrowPlan ?? '',
        reviewerName: item.reviewerName ?? '',
        reviewNote: item.reviewNote ?? '',
        submittedAt: item.submittedAt ?? '',
      });
    }

    return wb.xlsx.writeBuffer();
  }

  /** Generate PDF buffer of EOD reports for export. */
  static async exportPdf(
    user: AuthUser,
    filters: { from?: string; to?: string; locationId?: number; employeeId?: number },
  ): Promise<Buffer> {
    const { items } = await DailyReportService.list(user, { ...filters, pageSize: 200 });
    const PDFDocument = (await import('pdfkit')).default;

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
      const buffers: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err: Error) => reject(err));

      // Title header
      doc.fillColor('#1e40af').fontSize(16).text('BSC TEXTILES HRMS - END-OF-DAY WORK REPORTS', { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor('#4b5563').fontSize(9).text(`Generated on ${new Date().toLocaleString()} by ${user.fullName} | Records: ${items.length}`, { align: 'center' });
      doc.moveDown(1);

      // Simple Table layout
      const startX = 36;
      let curY = doc.y;

      doc.fillColor('#1e3a8a').fontSize(8);
      doc.text('Date', startX, curY, { width: 55 });
      doc.text('Employee', startX + 60, curY, { width: 95 });
      doc.text('Location', startX + 160, curY, { width: 65 });
      doc.text('Status', startX + 230, curY, { width: 60 });
      doc.text('Tasks (C/I/P)', startX + 295, curY, { width: 65 });
      doc.text('Work Completed Today', startX + 365, curY, { width: 220 });
      doc.text('Support / Problems', startX + 590, curY, { width: 170 });

      curY += 15;
      doc.strokeColor('#cbd5e1').lineWidth(1).moveTo(startX, curY).lineTo(790, curY).stroke();
      curY += 8;

      doc.fillColor('#1f2937').fontSize(7.5);

      for (const item of items) {
        if (curY > 520) {
          doc.addPage();
          curY = 36;
        }

        doc.text(item.reportDate, startX, curY, { width: 55 });
        doc.text(`${item.employeeName}\n(${item.employeeCode})`, startX + 60, curY, { width: 95 });
        doc.text(item.locationName ?? 'N/A', startX + 160, curY, { width: 65 });
        doc.text(item.status.toUpperCase(), startX + 230, curY, { width: 60 });
        doc.text(`${item.tasksCompleted} / ${item.tasksInProgress} / ${item.tasksPending}`, startX + 295, curY, { width: 65 });
        doc.text(item.summary.slice(0, 150) + (item.summary.length > 150 ? '…' : ''), startX + 365, curY, { width: 220 });
        doc.text(`Support: ${item.supportRequired || 'None'}\nIssues: ${item.problems || 'None'}`, startX + 590, curY, { width: 170 });

        curY += 28;
        doc.strokeColor('#f1f5f9').lineWidth(0.5).moveTo(startX, curY - 2).lineTo(790, curY - 2).stroke();
      }

      doc.end();
    });
  }
}
