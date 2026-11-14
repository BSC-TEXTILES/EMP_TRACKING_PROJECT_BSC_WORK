import { query, queryOne } from '../db/index.js';
import { addDays, endOfMonth, localDate, startOfMonth, today } from '../lib/dates.js';
import { subtreeIds } from '../lib/scope.js';
import type { AuthUser } from './AuthService.js';

export interface AnalyticsFilters {
  from?: string;
  to?: string;
  departmentId?: number;
  designationId?: number;
  locationId?: number;
  managerId?: number;
}

function dateRange(filters: AnalyticsFilters): { from: string; to: string } {
  const to = filters.to ?? today();
  const from = filters.from ?? addDays(to, -29);
  return { from, to };
}

export class AnalyticsService {
  static async overview(actor: AuthUser, filters: AnalyticsFilters) {
    if (!actor.permissions.includes('admin.dashboard') && !actor.permissions.includes('analytics.view') && !actor.permissions.includes('analytics.view.all')) {
      throw Object.assign(new Error('You do not have access to analytics'), { status: 403, code: 'forbidden' });
    }
    const { from, to } = dateRange(filters);
    const scopeAll = actor.permissions.includes('analytics.view.all') || actor.permissions.includes('admin.dashboard');
    const managerIds = scopeAll ? null : await subtreeIds(actor.id);

    const empClauses = ["e.status = 'active'"];
    const empParams: unknown[] = [];
    if (filters.departmentId) {
      empClauses.push('e.department_id = ?');
      empParams.push(filters.departmentId);
    }
    if (filters.designationId) {
      empClauses.push('e.designation_id = ?');
      empParams.push(filters.designationId);
    }
    if (filters.locationId) {
      empClauses.push('e.location_id = ?');
      empParams.push(filters.locationId);
    }
    if (filters.managerId) {
      empClauses.push('e.manager_id = ?');
      empParams.push(filters.managerId);
    }
    if (managerIds !== null) {
      if (managerIds.length === 0) {
        return AnalyticsService.emptyOverview(from, to);
      }
      empClauses.push(`e.id IN (${managerIds.map(() => '?').join(',')})`);
      empParams.push(...managerIds);
    }
    const empWhere = empClauses.join(' AND ');

    const [headcount, attendanceToday, taskStats, ticketStats, meetingStats, kpiAvg, deptPerf, attendanceTrend, productivity, workload, leaveToday] =
      await Promise.all([
        queryOne<{ total: number; active: number; pending: number; inactive: number; checked_in: number; on_leave: number }>(
          `SELECT COUNT(*) AS total,
                  SUM(e.status = 'active') AS active,
                  SUM(e.status IN ('pending_verification','pending_approval')) AS pending,
                  SUM(e.status = 'inactive') AS inactive,
                  (SELECT COUNT(DISTINCT a.employee_id) FROM attendance a WHERE a.work_date = CURDATE() AND a.check_in_at IS NOT NULL
                     AND a.employee_id IN (SELECT id FROM employees e2 WHERE ${empWhere.replace(/e\./g, 'e2.')})) AS checked_in,
                  (SELECT COUNT(*) FROM attendance a2 JOIN employees e3 ON e3.id = a2.employee_id
                     WHERE a2.work_date = CURDATE() AND a2.status = 'on_leave' AND ${empWhere.replace(/e\./g, 'e3.')}) AS on_leave
           FROM employees e WHERE ${empWhere}`,
          [...empParams, ...empParams, ...empParams],
        ),
        queryOne<{ present: number; late: number; absent: number; total_minutes: number }>(
          `SELECT SUM(a.status IN ('present','late','half_day')) AS present, SUM(a.is_late) AS late,
                  SUM(a.status = 'absent') AS absent, COALESCE(SUM(a.total_minutes),0) AS total_minutes
           FROM attendance a JOIN employees e ON e.id = a.employee_id
           WHERE a.work_date = CURDATE() AND ${empWhere}`,
          empParams,
        ),
        queryOne<{ allocated: number; completed: number; pending: number; overdue: number; rejected: number; awaiting_approval: number }>(
          `SELECT COUNT(*) AS allocated,
                  SUM(t.status = 'completed') AS completed,
                  SUM(t.status IN ('assigned','accepted','in_progress','on_hold','not_started')) AS pending,
                  SUM(t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')) AS overdue,
                  SUM(t.status = 'rejected') AS rejected,
                  SUM(t.status = 'pending_approval') AS awaiting_approval
           FROM tasks t
           WHERE t.archived_at IS NULL AND t.id IN (
             SELECT ta.task_id FROM task_assignments ta JOIN employees e ON e.id = ta.employee_id WHERE ${empWhere}
           )`,
          empParams,
        ),
        queryOne<{ open: number; resolved: number; breached: number; total: number }>(
          `SELECT COUNT(*) AS total, SUM(t.status NOT IN ('resolved','closed','cancelled')) AS open,
                  SUM(t.status IN ('resolved','closed')) AS resolved,
                  SUM(t.sla_due_at < NOW(3) AND t.status NOT IN ('resolved','closed','cancelled')) AS breached
           FROM tickets t JOIN employees e ON e.id = t.requester_id WHERE ${empWhere}`,
          empParams,
        ),
        queryOne<{ upcoming: number; held: number }>(
          `SELECT SUM(m.start_at >= NOW(3) AND m.status IN ('scheduled','ongoing')) AS upcoming,
                  SUM(m.status = 'completed') AS held
           FROM meetings m WHERE m.organizer_id IN (SELECT id FROM employees e WHERE ${empWhere})`,
          empParams,
        ),
        queryOne<{ average: number | null; count: number }>(
          `SELECT AVG(k.total_score) AS average, COUNT(*) AS count FROM employee_kpi_records k
           JOIN employees e ON e.id = k.employee_id WHERE ${empWhere} AND k.period = ?`,
          [...empParams, to.slice(0, 7)],
        ),
        query<{ department: string; employees: number; completed_tasks: number; total_tasks: number; avg_score: number | null; attendance: number | null }>(
          `SELECT COALESCE(d.name, 'Unassigned') AS department,
                  COUNT(DISTINCT e.id) AS employees,
                  SUM((SELECT COUNT(*) FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id WHERE ta.employee_id = e.id AND t.status = 'completed')) AS completed_tasks,
                  SUM((SELECT COUNT(*) FROM task_assignments ta WHERE ta.employee_id = e.id)) AS total_tasks,
                  (SELECT AVG(k.total_score) FROM employee_kpi_records k
                     JOIN employees e2 ON e2.id = k.employee_id WHERE e2.department_id = e.department_id AND k.period = ?) AS avg_score,
                  (SELECT AVG(x.present) FROM (
                      SELECT COUNT(*) AS present FROM attendance a JOIN employees e3 ON e3.id = a.employee_id
                      WHERE e3.department_id = e.department_id AND a.work_date BETWEEN ? AND ? AND a.status IN ('present','late','half_day')
                      GROUP BY a.employee_id) x) AS attendance
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id
           WHERE ${empWhere}
           GROUP BY e.department_id, d.name
           ORDER BY employees DESC`,
          [to.slice(0, 7), from, to, ...empParams],
        ),
        query<{ day: string; present: number; late: number; total_minutes: number }>(
          `SELECT a.work_date AS day, SUM(a.status IN ('present','late','half_day')) AS present,
                  SUM(a.is_late) AS late, COALESCE(SUM(a.total_minutes),0) AS total_minutes
           FROM attendance a JOIN employees e ON e.id = a.employee_id
           WHERE a.work_date BETWEEN ? AND ? AND ${empWhere}
           GROUP BY a.work_date ORDER BY a.work_date`,
          [from, to, ...empParams],
        ),
        query<{ day: string; completed: number; created: number }>(
          `SELECT DATE(t.completed_at) AS day, COUNT(*) AS completed, 0 AS created
           FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id JOIN employees e ON e.id = ta.employee_id
           WHERE t.completed_at IS NOT NULL AND DATE(t.completed_at) BETWEEN ? AND ? AND ${empWhere}
           GROUP BY DATE(t.completed_at) ORDER BY day`,
          [from, to, ...empParams],
        ),
        query<{ employee_id: number; full_name: string; open_tasks: number; overdue: number; hours: number }>(
          `SELECT e.id AS employee_id, e.full_name,
                  (SELECT COUNT(*) FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
                    WHERE ta.employee_id = e.id AND t.status IN ('assigned','accepted','in_progress','on_hold','pending_approval')) AS open_tasks,
                  (SELECT COUNT(*) FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
                    WHERE ta.employee_id = e.id AND t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')) AS overdue,
                  (SELECT COALESCE(SUM(a.total_minutes),0)/60 FROM attendance a WHERE a.employee_id = e.id AND a.work_date BETWEEN ? AND ?) AS hours
           FROM employees e WHERE ${empWhere}
           ORDER BY open_tasks DESC LIMIT 10`,
          [from, to, ...empParams],
        ),
        queryOne<{ total: number }>(
          `SELECT COUNT(*) AS total FROM leave_requests l JOIN employees e ON e.id = l.employee_id
           WHERE l.status = 'approved' AND l.start_date <= CURDATE() AND l.end_date >= CURDATE() AND ${empWhere}`,
          empParams,
        ),
      ]);

    return {
      range: { from, to },
      headcount: {
        total: Number(headcount?.total ?? 0),
        active: Number(headcount?.active ?? 0),
        pending: Number(headcount?.pending ?? 0),
        inactive: Number(headcount?.inactive ?? 0),
        checkedIn: Number(headcount?.checked_in ?? 0),
        onLeave: Number(leaveToday?.total ?? headcount?.on_leave ?? 0),
      },
      attendanceToday: {
        present: Number(attendanceToday?.present ?? 0),
        late: Number(attendanceToday?.late ?? 0),
        absent: Number(attendanceToday?.absent ?? 0),
        totalMinutes: Number(attendanceToday?.total_minutes ?? 0),
      },
      tasks: {
        allocated: Number(taskStats?.allocated ?? 0),
        completed: Number(taskStats?.completed ?? 0),
        pending: Number(taskStats?.pending ?? 0),
        overdue: Number(taskStats?.overdue ?? 0),
        awaitingApproval: Number(taskStats?.awaiting_approval ?? 0),
      },
      tickets: {
        total: Number(ticketStats?.total ?? 0),
        open: Number(ticketStats?.open ?? 0),
        resolved: Number(ticketStats?.resolved ?? 0),
        breached: Number(ticketStats?.breached ?? 0),
      },
      meetings: {
        upcoming: Number(meetingStats?.upcoming ?? 0),
        held: Number(meetingStats?.held ?? 0),
      },
      kpi: {
        average: kpiAvg?.average === null || kpiAvg?.average === undefined ? null : Math.round(Number(kpiAvg.average) * 10) / 10,
        evaluated: Number(kpiAvg?.count ?? 0),
      },
      departments: deptPerf.map((d) => ({
        department: d.department,
        employees: Number(d.employees),
        completedTasks: Number(d.completed_tasks ?? 0),
        totalTasks: Number(d.total_tasks ?? 0),
        completionRate: Number(d.total_tasks ?? 0) > 0 ? Math.round((Number(d.completed_tasks ?? 0) / Number(d.total_tasks)) * 100) : null,
        averageKpi: d.avg_score === null ? null : Math.round(Number(d.avg_score) * 10) / 10,
        attendancePercent: d.attendance === null ? null : Math.round(Number(d.attendance) * 10) / 10,
      })),
      trends: {
        attendance: attendanceTrend.map((r) => ({
          date: r.day,
          present: Number(r.present),
          late: Number(r.late),
          hours: Math.round((Number(r.total_minutes) / 60) * 10) / 10,
        })),
        productivity: productivity.map((r) => ({ date: r.day, completed: Number(r.completed) })),
      },
      workload: workload.map((w) => ({
        employeeId: Number(w.employee_id),
        name: w.full_name,
        openTasks: Number(w.open_tasks),
        overdue: Number(w.overdue),
        hours: Math.round(Number(w.hours) * 10) / 10,
      })),
    };
  }

  private static emptyOverview(from: string, to: string) {
    return {
      range: { from, to },
      headcount: { total: 0, active: 0, pending: 0, inactive: 0, checkedIn: 0, onLeave: 0 },
      attendanceToday: { present: 0, late: 0, absent: 0, totalMinutes: 0 },
      tasks: { allocated: 0, completed: 0, pending: 0, overdue: 0, awaitingApproval: 0 },
      tickets: { total: 0, open: 0, resolved: 0, breached: 0 },
      meetings: { upcoming: 0, held: 0 },
      kpi: { average: null, evaluated: 0 },
      departments: [],
      trends: { attendance: [], productivity: [] },
      workload: [],
    };
  }

  static async employeePerformance(employeeId: number, period: string) {
    const monthStart = startOfMonth(`${period}-01`);
    const monthEnd = endOfMonth(monthStart);
    const [tasks, attendance, reports, tickets] = await Promise.all([
      queryOne<{ assigned: number; completed: number; overdue: number }>(
        `SELECT COUNT(*) AS assigned, SUM(t.status = 'completed') AS completed,
                SUM(t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled')) AS overdue
         FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id WHERE ta.employee_id = ?`,
        [employeeId],
      ),
      queryOne<{ present: number; minutes: number }>(
        `SELECT SUM(status IN ('present','late','half_day')) AS present, COALESCE(SUM(total_minutes),0) AS minutes
         FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?`,
        [employeeId, monthStart, monthEnd],
      ),
      queryOne<{ submitted: number }>(
        'SELECT COUNT(*) AS submitted FROM daily_work_reports WHERE employee_id = ? AND report_date BETWEEN ? AND ?',
        [employeeId, monthStart, monthEnd],
      ),
      queryOne<{ resolved: number }>(
        `SELECT COUNT(*) AS resolved FROM tickets WHERE assignee_id = ? AND status IN ('resolved','closed')`,
        [employeeId],
      ),
    ]);
    return {
      tasksAssigned: Number(tasks?.assigned ?? 0),
      tasksCompleted: Number(tasks?.completed ?? 0),
      overdue: Number(tasks?.overdue ?? 0),
      presentDays: Number(attendance?.present ?? 0),
      hoursWorked: Math.round((Number(attendance?.minutes ?? 0) / 60) * 10) / 10,
      reportsSubmitted: Number(reports?.submitted ?? 0),
      ticketsResolved: Number(tickets?.resolved ?? 0),
    };
  }

  static async myWeeklySummary(employeeId: number) {
    const to = today();
    const from = addDays(to, -6);
    const rows = await query<{ day: string; minutes: number; status: string }>(
      'SELECT work_date AS day, total_minutes AS minutes, status FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date',
      [employeeId, from, to],
    );
    return rows.map((r) => ({ date: r.day, minutes: Number(r.minutes), status: r.status }));
  }

  static async attendanceTrendForTeam(employeeIds: number[], days = 14) {
    if (employeeIds.length === 0) return [];
    const to = localDate();
    const from = addDays(to, -(days - 1));
    return query<{ day: string; present: number; total_minutes: number }>(
      `SELECT work_date AS day, COUNT(*) AS present, COALESCE(SUM(total_minutes),0) AS total_minutes
       FROM attendance WHERE employee_id IN (${employeeIds.map(() => '?').join(',')}) AND work_date BETWEEN ? AND ?
       GROUP BY work_date ORDER BY work_date`,
      [...employeeIds, from, to],
    );
  }
}
