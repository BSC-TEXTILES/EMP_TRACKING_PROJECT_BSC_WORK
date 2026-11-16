import { execute, query, queryOne } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { today, toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { locationEmployeeClause, locationEmployeeIds, subtreeIds } from '../lib/scope.js';
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
  report_date: string;
  work_start: string | null;
  work_end: string | null;
  total_minutes: number;
  summary: string;
  problems: string | null;
  support_required: string | null;
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
    reportDate: r.report_date,
    workStart: r.work_start,
    workEnd: r.work_end,
    totalMinutes: Number(r.total_minutes),
    summary: r.summary,
    problems: r.problems,
    supportRequired: r.support_required,
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

  /** Suggested task counts for the report form, derived from live task state. */
  static async suggestions(employeeId: number, date = today()) {
    const row = await queryOne<{ completed: number; in_progress: number; pending: number }>(
      `SELECT
        SUM(t.status = 'completed' AND DATE(t.completed_at) = ?) AS completed,
        SUM(t.status IN ('in_progress','on_hold','accepted')) AS in_progress,
        SUM(t.status IN ('assigned','not_started','pending_approval','overdue')) AS pending
       FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.employee_id = ? AND t.archived_at IS NULL`,
      [date, employeeId],
    );
    const attendance = await queryOne<{ check_in_at: string | null; check_out_at: string | null; total_minutes: number }>(
      'SELECT check_in_at, check_out_at, total_minutes FROM attendance WHERE employee_id = ? AND work_date = ?',
      [employeeId, date],
    );
    return {
      date,
      tasksCompleted: Number(row?.completed ?? 0),
      tasksInProgress: Number(row?.in_progress ?? 0),
      tasksPending: Number(row?.pending ?? 0),
      attendance,
    };
  }

  static async submit(
    employeeId: number,
    input: {
      reportDate: string;
      summary: string;
      problems?: string;
      supportRequired?: string;
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
        (employee_id, report_date, work_start, work_end, total_minutes, summary, problems, support_required, tomorrow_plan,
         tasks_completed, tasks_in_progress, tasks_pending, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', NOW(3))
       ON DUPLICATE KEY UPDATE
         work_start = VALUES(work_start), work_end = VALUES(work_end), total_minutes = VALUES(total_minutes),
         summary = VALUES(summary), problems = VALUES(problems), support_required = VALUES(support_required),
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

    if (report && input.attachmentIds?.length) {
      for (const fileId of input.attachmentIds) {
        await execute('INSERT IGNORE INTO daily_report_attachments (report_id, file_id) VALUES (?, ?)', [report.id, fileId]);
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
        body: `${employee.full_name} submitted the report for ${input.reportDate}.`,
        link: `/reports?report=${report?.id ?? ''}`,
        actorId: employeeId,
      });
    }

    emitToEmployee(employeeId, 'report:updated', { id: report?.id, date: input.reportDate });
    return { id: report?.id ?? null };
  }

  static async list(
    user: AuthUser,
    filters: { employeeId?: number; from?: string; to?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const scope = await DailyReportService.scopeClause(user);
    const clauses = [scope.clause];
    const params: unknown[] = [...scope.params];
    if (filters.employeeId) {
      clauses.push('r.employee_id = ?');
      params.push(filters.employeeId);
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
      `SELECT r.*, e.full_name, e.employee_code, d.name AS department_name, dg.title AS designation_title, rv.full_name AS reviewer_name
       FROM daily_work_reports r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees rv ON rv.id = r.reviewed_by
       WHERE ${where}
       ORDER BY r.report_date DESC, r.id DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const total = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM daily_work_reports r WHERE ${where}`, params);
    return { items: rows.map(mapReport), total: Number(total?.total ?? 0), page, pageSize };
  }

  static async detail(reportId: number, user: AuthUser) {
    const scope = await DailyReportService.scopeClause(user);
    const row = await queryOne<ReportRow>(
      `SELECT r.*, e.full_name, e.employee_code, d.name AS department_name, dg.title AS designation_title, rv.full_name AS reviewer_name
       FROM daily_work_reports r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees rv ON rv.id = r.reviewed_by
       WHERE r.id = ? AND ${scope.clause}`,
      [reportId, ...scope.params],
    );
    if (!row) throw ApiError.notFound('Report not found or outside your access scope');
    const attachments = await query<{ file_id: number; original_name: string; mime_type: string; size_bytes: number }>(
      `SELECT f.id AS file_id, f.original_name, f.mime_type, f.size_bytes
       FROM daily_report_attachments a JOIN files f ON f.id = a.file_id WHERE a.report_id = ?`,
      [reportId],
    );
    return { ...mapReport(row), attachments };
  }

  static async review(
    reportId: number,
    reviewer: AuthUser,
    input: { approve: boolean; note?: string },
    context: { ip?: string; userAgent?: string },
  ) {
    const scope = await DailyReportService.scopeClause(reviewer);
    const report = await queryOne<{ id: number; employee_id: number; report_date: string; status: string; full_name: string }>(
      `SELECT r.id, r.employee_id, r.report_date, r.status, e.full_name
       FROM daily_work_reports r JOIN employees e ON e.id = r.employee_id
       WHERE r.id = ? AND ${scope.clause}`,
      [reportId, ...scope.params],
    );
    if (!report) throw ApiError.notFound('Report not found');
    if (report.status === 'approved' && input.approve) throw ApiError.conflict('This report is already approved.');
    if (!input.approve && !input.note) throw ApiError.badRequest('Explain what the employee should correct.');

    await execute(
      `UPDATE daily_work_reports SET status = ?, reviewed_by = ?, reviewed_at = NOW(3), review_note = ? WHERE id = ?`,
      [input.approve ? 'approved' : 'changes_requested', reviewer.id, input.note ?? null, reportId],
    );

    await recordAudit({
      actorId: reviewer.id,
      action: input.approve ? 'daily_report.approved' : 'daily_report.changes_requested',
      entityType: 'daily_work_report',
      entityId: reportId,
      before: { status: report.status },
      after: { status: input.approve ? 'approved' : 'changes_requested', note: input.note },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await NotificationService.notify({
      employeeIds: [Number(report.employee_id)],
      type: 'daily_report',
      title: input.approve ? 'Daily report approved' : 'Daily report needs changes',
      body: input.approve
        ? `Your report for ${report.report_date} was approved.`
        : `Your report for ${report.report_date} needs changes${input.note ? `: ${input.note}` : '.'}`,
      link: '/reports',
      priority: input.approve ? 'normal' : 'high',
      actorId: reviewer.id,
    });
    emitToEmployee(Number(report.employee_id), 'report:updated', { id: reportId, date: report.report_date });
  }

  static async todayStatus(employeeId: number) {
    const row = await queryOne<{ id: number; status: string; submitted_at: string | null; summary: string }>(
      'SELECT id, status, submitted_at, summary FROM daily_work_reports WHERE employee_id = ? AND report_date = ?',
      [employeeId, today()],
    );
    return row ? { id: Number(row.id), status: row.status, submittedAt: toIso(row.submitted_at), summary: row.summary } : null;
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
        title: 'Daily work report pending',
        body: 'Please submit your daily work report before signing off.',
        link: '/reports',
        priority: 'normal',
        dedupeKey: `report_reminder:${row.id}:${today()}`,
      });
    }
    return rows.length;
  }
}
