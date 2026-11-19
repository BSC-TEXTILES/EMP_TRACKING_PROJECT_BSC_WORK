import { query, queryOne } from '../db/index.js';
import { addDays, localDate, periodOf, today, toIso } from '../lib/dates.js';
import { ChatService } from './ChatService.js';
import { AttendanceService } from './AttendanceService.js';
import { NotificationService } from './NotificationService.js';
import { MeetingService } from './MeetingService.js';
import { DailyReportService } from './DailyReportService.js';
import { TaskService } from './TaskService.js';
import type { AuthUser } from './AuthService.js';

export class DashboardService {
  static async personal(user: AuthUser) {
    const date = today();
    const period = periodOf(date);
    const [attendance, taskStats, ticketStats, kpi, upcoming, unreadNotifications, unreadChat, reportStatus, weekly, attendanceSummary, myTasksList, teamTasksList] =
      await Promise.all([
        AttendanceService.stateFor(user.id, date),
        queryOne<{ active: number; completed: number; pending: number; overdue: number; awaiting: number; completed_month: number }>(
          `SELECT SUM(t.status IN ('assigned','accepted','in_progress','on_hold')) AS active,
                  SUM(t.status = 'completed') AS completed,
                  SUM(t.status IN ('assigned','accepted','in_progress','on_hold','not_started','pending_approval')) AS pending,
                  SUM(t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')) AS overdue,
                  SUM(t.status = 'pending_approval') AS awaiting,
                  SUM(t.status = 'completed' AND DATE(t.completed_at) >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS completed_month
           FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
           WHERE ta.employee_id = ? AND t.archived_at IS NULL`,
          [user.id],
        ),
        queryOne<{ assigned: number; open: number; resolved: number }>(
          `SELECT COUNT(*) AS assigned, SUM(status NOT IN ('resolved','closed','cancelled')) AS open,
                  SUM(status IN ('resolved','closed')) AS resolved
           FROM tickets WHERE assignee_id = ?`,
          [user.id],
        ),
        queryOne<{ id: number; period: string; total_score: number; category: string; status: string }>(
          'SELECT id, period, total_score, category, status FROM employee_kpi_records WHERE employee_id = ? ORDER BY period DESC LIMIT 1',
          [user.id],
        ),
        MeetingService.upcoming(user, 5),
        NotificationService.unreadCount(user.id),
        ChatService.unreadTotal(user.id),
        DailyReportService.todayStatus(user.id),
        query<{ day: string; minutes: number }>(
          `SELECT work_date AS day, total_minutes AS minutes FROM attendance
           WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date`,
          [user.id, addDays(date, -6), date],
        ),
        AttendanceService.summary(user.id, period),
        TaskService.list(user, { view: 'mine', pageSize: 6 }),
        (user.permissions.includes('tasks.view.team') || user.permissions.includes('tasks.view.all'))
          ? TaskService.list(user, { view: 'allocated', pageSize: 6 })
          : Promise.resolve({ items: [] }),
      ]);

    const holiday = await queryOne<{ name: string; holiday_date: string }>(
      `SELECT name, holiday_date FROM holidays WHERE holiday_date = ? AND location_id IS NULL LIMIT 1`,
      [date],
    );

    return {
      employee: {
        id: user.id,
        name: user.fullName,
        code: user.employeeCode,
        email: user.email,
        mobile: user.mobile,
        photoUrl: user.photoUrl,
        designation: user.designationTitle,
        department: user.departmentName,
        location: user.locationName,
        manager: user.managerName,
        role: user.roleName,
        employmentType: user.employmentType,
        joiningDate: user.joiningDate,
      },
      serverNow: attendance.serverNow,
      today: {
        date,
        isHoliday: Boolean(holiday),
        holidayName: holiday?.name ?? null,
        attendance,
        report: reportStatus,
      },
      tasks: {
        active: Number(taskStats?.active ?? 0),
        completed: Number(taskStats?.completed ?? 0),
        pending: Number(taskStats?.pending ?? 0),
        overdue: Number(taskStats?.overdue ?? 0),
        awaitingApproval: Number(taskStats?.awaiting ?? 0),
        completedThisMonth: Number(taskStats?.completed_month ?? 0),
      },
      tickets: {
        assigned: Number(ticketStats?.assigned ?? 0),
        open: Number(ticketStats?.open ?? 0),
        resolved: Number(ticketStats?.resolved ?? 0),
      },
      kpi: kpi
        ? { id: Number(kpi.id), period: kpi.period, score: Number(kpi.total_score), category: kpi.category, status: kpi.status }
        : null,
      meetings: upcoming.map((m) => ({
        id: Number(m.id),
        title: m.title,
        startAt: toIso(m.start_at),
        endAt: toIso(m.end_at),
        organizerName: m.organizer_name,
      })),
      unreadNotifications,
      unreadChat,
      weeklyHours: weekly.map((w) => ({ date: w.day, hours: Math.round((Number(w.minutes) / 60) * 10) / 10 })),
      attendanceSummary,
      myTasks: myTasksList.items,
      teamTasks: teamTasksList.items,
      date: localDate(),
    };
  }

  static async teamSnapshot(user: AuthUser) {
    const rows = await query<{ id: number }>(
      `WITH RECURSIVE sub AS (SELECT id FROM employees WHERE manager_id = ? UNION ALL
        SELECT e.id FROM employees e JOIN sub s ON e.manager_id = s.id)
       SELECT id FROM sub`,
      [user.id],
    );
    if (rows.length === 0) return { size: 0, checkedIn: 0, onLeave: 0, overdueTasks: 0, pendingApprovals: 0, reportsPending: 0 };
    const ids = rows.map((r) => Number(r.id));
    const ph = ids.map(() => '?').join(',');
    const [attendance, tasks, reports] = await Promise.all([
      queryOne<{ checked_in: number; on_leave: number }>(
        `SELECT SUM(a.check_in_at IS NOT NULL) AS checked_in, SUM(a.status = 'on_leave') AS on_leave
         FROM attendance a WHERE a.work_date = CURDATE() AND a.employee_id IN (${ph})`,
        ids,
      ),
      queryOne<{ overdue: number; pending: number }>(
        `SELECT SUM(t.due_date < CURDATE() AND t.status NOT IN ('completed','cancelled','rejected')) AS overdue,
                SUM(t.status = 'pending_approval') AS pending
         FROM tasks t WHERE t.id IN (SELECT task_id FROM task_assignments WHERE employee_id IN (${ph}))`,
        ids,
      ),
      queryOne<{ pending: number }>(
        `SELECT COUNT(*) AS pending FROM daily_work_reports WHERE employee_id IN (${ph}) AND status = 'submitted'`,
        ids,
      ),
    ]);
    return {
      size: ids.length,
      checkedIn: Number(attendance?.checked_in ?? 0),
      onLeave: Number(attendance?.on_leave ?? 0),
      overdueTasks: Number(tasks?.overdue ?? 0),
      pendingApprovals: Number(tasks?.pending ?? 0),
      reportsPending: Number(reports?.pending ?? 0),
    };
  }
}
