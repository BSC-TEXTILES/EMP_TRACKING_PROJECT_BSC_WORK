import { execute, query, queryOne } from '../db/index.js';
import { today } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { subtreeIds, visibleEmployeeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { ActivityService, cleanText, parseJson } from './ActivityService.js';
function number(value) {
    return Number(value ?? 0);
}
function percent(part, total) {
    return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}
/** DATE columns arrive as strings (dateStrings); normalise defensively. */
function sqlDate(value) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function grade(score) {
    if (score >= 90)
        return 'A+';
    if (score >= 80)
        return 'A';
    if (score >= 70)
        return 'B';
    if (score >= 60)
        return 'C';
    if (score >= 50)
        return 'D';
    return 'E';
}
const KPI_WEIGHTS = {
    taskCompletion: 25,
    onTimeDelivery: 20,
    workQuality: 20,
    attendance: 10,
    dailyReporting: 10,
    projectContribution: 10,
    collaboration: 5,
};
export class ActivityAnalyticsService {
    static async assertAccess(user, employeeId) {
        if (employeeId === user.id || user.permissions.includes('activity.view.all'))
            return;
        if (user.permissions.includes('activity.view.team')) {
            const ids = await subtreeIds(user.id);
            if (ids.includes(employeeId))
                return;
        }
        throw ApiError.forbidden('You do not have access to this employee activity.');
    }
    static async employeeSummaries(ids, date) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => '?').join(',');
        return query(`SELECT s.*, e.full_name, e.employee_code FROM daily_activity_summaries s
       JOIN employees e ON e.id = s.employee_id
       WHERE s.summary_date = ? AND s.employee_id IN (${placeholders})
       ORDER BY e.full_name`, [date, ...ids]);
    }
    /** Rebuilds a daily activity summary from real attendance, app, task and ticket records. */
    static async generateDaily(employeeId, date) {
        const employee = await queryOne(`SELECT e.id, e.full_name, e.employee_code, e.status, d.name AS department_name, dg.title AS designation_title,
              m.full_name AS manager_name, l.name AS location_name, e.photo_url
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`, [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found');
        const [attendance, apps, browser, modules, taskCounts, completedTasks, report, errors, tickets, events] = await Promise.all([
            queryOne('SELECT check_in_at, check_out_at, total_minutes, break_minutes FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, date]),
            query(`SELECT app_name, app_category, SUM(active_seconds) AS seconds FROM application_usage_logs
         WHERE employee_id = ? AND DATE(started_at) = ? GROUP BY app_name, app_category ORDER BY seconds DESC`, [employeeId, date]),
            query(`SELECT domain, category, SUM(active_seconds) AS seconds FROM browser_usage_logs
         WHERE employee_id = ? AND DATE(started_at) = ? GROUP BY domain, category ORDER BY seconds DESC LIMIT 30`, [employeeId, date]),
            query(`SELECT module, SUM(active_seconds) AS seconds, COUNT(*) AS visits FROM internal_module_activity
         WHERE employee_id = ? AND DATE(entered_at) = ? GROUP BY module ORDER BY seconds DESC`, [employeeId, date]),
            queryOne(`SELECT COUNT(*) AS assigned,
                SUM(t.status NOT IN ('completed','cancelled','rejected')) AS pending,
                COALESCE(SUM(ta.time_spent_minutes),0) AS minutes
         FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.employee_id = ? AND DATE(ta.assigned_at) <= ?`, [employeeId, date]),
            query(`SELECT t.id, t.task_no, t.title, t.project_id, t.completed_at, ta.completed_at AS assignment_completed_at,
                p.name AS project_name
         FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE ta.employee_id = ? AND DATE(COALESCE(t.completed_at, ta.completed_at)) = ?
         ORDER BY t.completed_at DESC`, [employeeId, date]),
            queryOne('SELECT id, summary, problems, tomorrow_plan, status, total_minutes FROM daily_work_reports WHERE employee_id = ? AND report_date = ?', [employeeId, date]),
            query(`SELECT e.description, e.severity, e.category, e.ticket_id, i.title AS incident_title
         FROM system_error_events e JOIN error_incidents i ON i.id = e.incident_id
         WHERE e.employee_id = ? AND DATE(e.occurred_at) = ? ORDER BY e.occurred_at DESC`, [employeeId, date]),
            query(`SELECT t.id, t.ticket_no, t.subject, t.status, t.priority FROM tickets t
         WHERE t.requester_id = ? AND DATE(t.created_at) = ? ORDER BY t.created_at DESC`, [employeeId, date]),
            query(`SELECT title, detail, keywords FROM work_activity_events WHERE employee_id = ? AND DATE(occurred_at) = ? ORDER BY occurred_at`, [employeeId, date]),
        ]);
        const [workedTasks, resolvedTickets, actionItems, milestones, meetings] = await Promise.all([
            query(`SELECT t.id, t.title, t.description, t.status, p.name AS project_name, SUM(l.minutes) AS minutes
         FROM task_time_logs l JOIN tasks t ON t.id = l.task_id LEFT JOIN projects p ON p.id = t.project_id
         WHERE l.employee_id = ? AND DATE(l.started_at) = ? GROUP BY t.id, t.title, t.description, t.status, p.name ORDER BY minutes DESC LIMIT 10`, [employeeId, date]),
            query(`SELECT ticket_no, subject FROM tickets WHERE assignee_id = ? AND DATE(resolved_at) = ? ORDER BY resolved_at`, [employeeId, date]),
            query(`SELECT a.title, a.status, m.title AS meeting_title FROM meeting_action_items a JOIN meetings m ON m.id = a.meeting_id
         WHERE a.assignee_id = ? AND (DATE(a.completed_at) = ? OR DATE(a.created_at) = ?) ORDER BY a.created_at`, [employeeId, date, date]),
            query(`SELECT DISTINCT ms.title, p.name AS project_name FROM project_milestones ms JOIN projects p ON p.id = ms.project_id
         JOIN tasks t ON t.milestone_id = ms.id JOIN task_assignments ta ON ta.task_id = t.id
         WHERE ta.employee_id = ? AND DATE(ms.completed_at) = ?`, [employeeId, date]),
            query(`SELECT m.title, TIMESTAMPDIFF(MINUTE, m.start_at, m.end_at) AS minutes FROM meeting_participants mp JOIN meetings m ON m.id = mp.meeting_id
         WHERE mp.employee_id = ? AND DATE(m.start_at) = ? AND m.status <> 'cancelled' ORDER BY m.start_at`, [employeeId, date]),
        ]);
        const appBreakdown = apps.map((row) => ({
            app: String(row.app_name),
            category: String(row.app_category),
            minutes: Math.round(number(row.seconds) / 60),
            seconds: number(row.seconds),
        }));
        const activeSeconds = appBreakdown.reduce((sum, item) => sum + item.seconds, 0);
        const checkIn = attendance?.check_in_at ? new Date(String(attendance.check_in_at)).getTime() : 0;
        const checkOut = attendance?.check_out_at ? new Date(String(attendance.check_out_at)).getTime() : 0;
        const attendanceMinutes = checkIn ? Math.max(0, Math.round(((checkOut || Date.now()) - checkIn) / 60000)) : 0;
        const breakMinutes = number(attendance?.break_minutes);
        const completed = completedTasks.map((row) => ({
            id: Number(row.id),
            taskNo: row.task_no,
            title: String(row.title),
            project: row.project_name ?? null,
            completedAt: row.completed_at ?? row.assignment_completed_at,
        }));
        const reportLines = String(report?.summary ?? '')
            .split(/\r?\n|(?<=\.)\s+/)
            .map((line) => cleanText(line, 180))
            .filter((line) => line.length > 8);
        const keywordRows = await query('SELECT keyword, category, weight FROM activity_keywords ORDER BY weight DESC LIMIT 100');
        // Only permitted, work-authored sources: report, task titles/descriptions,
        // ticket subjects, meeting action items, milestones and agent work events.
        const combinedText = [
            reportLines.join(' '),
            completed.map((task) => task.title).join(' '),
            workedTasks.map((task) => `${task.title} ${String(task.description ?? '').slice(0, 400)}`).join(' '),
            tickets.map((ticket) => ticket.subject).join(' '),
            resolvedTickets.map((ticket) => ticket.subject).join(' '),
            actionItems.map((item) => item.title).join(' '),
            milestones.map((item) => item.title).join(' '),
            ...events.map((event) => `${String(event.title)} ${parseJson(event.keywords, []).join(' ')}`),
        ].join(' ').toLowerCase();
        const matchedKeywords = keywordRows
            .filter((row) => new RegExp(`\\b${row.keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(combinedText))
            .map((row) => ({ keyword: row.keyword, category: row.category }));
        const completedIds = new Set(completed.map((task) => task.id));
        const generatedActivities = [...new Set([
                ...completed.map((task) => `Completed ${task.title}${task.project ? ` (${task.project})` : ''}`),
                ...milestones.map((item) => `Reached milestone ${item.title} (${item.project_name})`),
                ...workedTasks.filter((task) => !completedIds.has(Number(task.id))).map((task) => `Worked on ${task.title}${task.project_name ? ` (${task.project_name})` : ''}`),
                ...resolvedTickets.map((ticket) => `Resolved ticket ${ticket.ticket_no}: ${ticket.subject}`),
                ...actionItems.filter((item) => item.status === 'done' || item.status === 'completed').map((item) => `Completed action item: ${item.title}`),
                ...events.map((event) => String(event.title)),
                ...meetings.map((meeting) => `Attended meeting: ${meeting.title}`),
                ...reportLines,
                ...(errors.length ? [`Reported ${errors.length} technical issue${errors.length > 1 ? 's' : ''}`] : []),
            ].map((line) => cleanText(line, 200)).filter(Boolean))].slice(0, 10);
        const existingSummary = await queryOne('SELECT key_activities, key_activities_edited FROM daily_activity_summaries WHERE employee_id = ? AND summary_date = ?', [employeeId, date]);
        // Once the employee has corrected the list, regeneration never overwrites it.
        const keyActivities = existingSummary?.key_activities_edited
            ? parseJson(existingSummary.key_activities, generatedActivities)
            : generatedActivities;
        const issues = errors.map((row) => ({
            title: row.incident_title ?? row.description,
            severity: row.severity,
            category: row.category,
            ticketId: row.ticket_id ? Number(row.ticket_id) : null,
        }));
        const taskSummary = {
            assigned: number(taskCounts?.assigned),
            pending: number(taskCounts?.pending),
            completed: completed.length,
            loggedMinutes: number(taskCounts?.minutes),
            completedItems: completed,
        };
        const payload = {
            attendanceMinutes,
            breakMinutes,
            activeMinutes: Math.round(activeSeconds / 60),
            appBreakdown,
            moduleBreakdown: modules.map((row) => ({ module: row.module, seconds: number(row.seconds), visits: number(row.visits) })),
            taskSummary,
            keyActivities,
            issues,
            tickets,
            report: report ? { id: Number(report.id), status: report.status, summary: report.summary, problems: report.problems, tomorrowPlan: report.tomorrow_plan } : null,
            keywords: matchedKeywords,
            suggestedActivities: generatedActivities,
            browserBreakdown: browser.map((row) => ({ domain: row.domain, category: row.category, minutes: Math.round(number(row.seconds) / 60) })),
            meetings: meetings.map((meeting) => ({ title: meeting.title, minutes: number(meeting.minutes) })),
            attendance: attendance ? { checkInAt: attendance.check_in_at, checkOutAt: attendance.check_out_at } : null,
            netWorkingMinutes: Math.max(0, attendanceMinutes - breakMinutes),
            employee,
            date,
        };
        await execute(`INSERT INTO daily_activity_summaries
        (employee_id, summary_date, attendance_minutes, break_minutes, active_minutes, app_breakdown, module_breakdown, task_summary, key_activities, issues, tickets, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE attendance_minutes = VALUES(attendance_minutes), break_minutes = VALUES(break_minutes),
         active_minutes = VALUES(active_minutes), app_breakdown = VALUES(app_breakdown), module_breakdown = VALUES(module_breakdown),
         task_summary = VALUES(task_summary), key_activities = VALUES(key_activities), issues = VALUES(issues), tickets = VALUES(tickets)`, [
            employeeId, date, attendanceMinutes, breakMinutes, payload.activeMinutes,
            JSON.stringify(appBreakdown), JSON.stringify(payload.moduleBreakdown), JSON.stringify(taskSummary),
            JSON.stringify(keyActivities), JSON.stringify(issues), JSON.stringify(tickets),
        ]);
        const stored = await queryOne('SELECT * FROM daily_activity_summaries WHERE employee_id = ? AND summary_date = ?', [employeeId, date]);
        return ActivityAnalyticsService.mapDaily(stored, payload);
    }
    static mapDaily(row, extra) {
        if (!row && !extra)
            return null;
        return {
            id: row ? Number(row.id) : null,
            employeeId: row ? Number(row.employee_id) : Number(extra?.employee?.id),
            date: row?.summary_date ?? extra?.date,
            attendanceMinutes: number(row?.attendance_minutes ?? extra?.attendanceMinutes),
            breakMinutes: number(row?.break_minutes ?? extra?.breakMinutes),
            activeMinutes: number(row?.active_minutes ?? extra?.activeMinutes),
            appBreakdown: parseJson(row?.app_breakdown ?? extra?.appBreakdown, []),
            moduleBreakdown: parseJson(row?.module_breakdown ?? extra?.moduleBreakdown, []),
            taskSummary: parseJson(row?.task_summary ?? extra?.taskSummary, {}),
            keyActivities: parseJson(row?.key_activities ?? extra?.keyActivities, []),
            issues: parseJson(row?.issues ?? extra?.issues, []),
            tickets: parseJson(row?.tickets ?? extra?.tickets, []),
            keywords: extra?.keywords ?? [],
            keyActivitiesEdited: Boolean(row?.key_activities_edited),
            suggestedActivities: extra?.suggestedActivities ?? [],
            browserBreakdown: extra?.browserBreakdown ?? [],
            meetings: extra?.meetings ?? [],
            attendance: extra?.attendance ?? null,
            netWorkingMinutes: extra?.netWorkingMinutes ?? Math.max(0, number(row?.attendance_minutes) - number(row?.break_minutes)),
            report: extra?.report ?? null,
            employee: extra?.employee ?? null,
            employeeNotes: row?.employee_notes ?? null,
            status: row?.status ?? 'draft',
            submittedAt: row?.submitted_at ?? null,
            reviewedAt: row?.reviewed_at ?? null,
            managerNote: row?.manager_note ?? null,
        };
    }
    static async daily(user, employeeId, date) {
        await ActivityAnalyticsService.assertAccess(user, employeeId);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
            throw ApiError.badRequest('Use a valid YYYY-MM-DD date.');
        await ActivityService.logAccess(user, employeeId, 'daily');
        return ActivityAnalyticsService.generateDaily(employeeId, date);
    }
    /** Employee submits the day, optionally correcting the extracted key activities. */
    static async submitDaily(user, date, notes, keyActivities) {
        if (date > today())
            throw ApiError.badRequest('You cannot submit a future day.');
        const summary = await ActivityAnalyticsService.generateDaily(user.id, date);
        if (!summary?.id)
            throw ApiError.badRequest('Unable to generate the daily summary.');
        if (summary.status === 'approved')
            throw ApiError.conflict('This summary is already approved.');
        const edited = Array.isArray(keyActivities)
            ? [...new Set(keyActivities.map((item) => cleanText(item, 200)).filter(Boolean))].slice(0, 15)
            : null;
        await execute(`UPDATE daily_activity_summaries SET employee_notes = ?, status = 'submitted', submitted_at = NOW(3),
              key_activities = COALESCE(?, key_activities), key_activities_edited = IF(? IS NULL, key_activities_edited, 1)
       WHERE id = ?`, [cleanText(notes, 2000) || null, edited ? JSON.stringify(edited) : null, edited ? 1 : null, summary.id]);
        await ActivityService.audit(user.id, 'activity.daily_submitted', user.id, 'daily_activity_summary', summary.id, { date, editedActivities: Boolean(edited) });
        const managers = await query('SELECT manager_id FROM employees WHERE id = ?', [user.id]);
        if (managers[0]?.manager_id) {
            await NotificationService.notify({
                employeeIds: [Number(managers[0].manager_id)],
                type: 'activity_daily',
                title: 'Daily activity summary submitted',
                body: `${user.fullName} submitted the summary for ${date}.`,
                link: '/activity?tab=team',
                actorId: user.id,
                dedupeKey: `daily_submitted:${summary.id}:${Date.now()}`,
            });
        }
        return ActivityAnalyticsService.generateDaily(user.id, date);
    }
    /** Chronological work timeline (applications, logins, meetings, breaks, tasks, attendance). */
    static async timeline(user, employeeId, date) {
        await ActivityAnalyticsService.assertAccess(user, employeeId);
        const rows = await query(`SELECT * FROM (
         SELECT 'login' AS kind, id, CONCAT('HRMS Web Login (', COALESCE(browser, 'Browser'), ')') AS label, 'Access' AS category,
                login_at AS started_at, COALESCE(logout_at, NOW(3)) AS ended_at, duration_minutes * 60 AS active_seconds
         FROM employee_login_audit WHERE employee_id = ? AND DATE(login_at) = ?
         UNION ALL
         SELECT 'logout' AS kind, id, CONCAT('HRMS Logout (', COALESCE(logout_reason, 'normal'), ')') AS label, 'Access' AS category,
                logout_at AS started_at, logout_at AS ended_at, 0 AS active_seconds
         FROM employee_login_audit WHERE employee_id = ? AND DATE(logout_at) = ? AND logout_at IS NOT NULL
         UNION ALL
         SELECT 'attendance' AS kind, id, 'Store Attendance Check-In' AS label, 'Attendance' AS category,
                check_in_at AS started_at, COALESCE(check_out_at, NOW(3)) AS ended_at, total_minutes * 60 AS active_seconds
         FROM attendance WHERE employee_id = ? AND work_date = ? AND check_in_at IS NOT NULL
         UNION ALL
         SELECT 'break' AS kind, b.id, 'Employee Break' AS label, 'Attendance' AS category,
                b.started_at, COALESCE(b.ended_at, NOW(3)) AS ended_at,
                TIMESTAMPDIFF(SECOND, b.started_at, COALESCE(b.ended_at, NOW(3))) AS active_seconds
         FROM attendance_breaks b JOIN attendance a ON a.id = b.attendance_id
         WHERE a.employee_id = ? AND a.work_date = ?
         UNION ALL
         SELECT 'meeting' AS kind, m.id, CONCAT('Meeting: ', m.title) AS label, 'Collaboration' AS category,
                COALESCE(mp.joined_at, m.start_at) AS started_at, COALESCE(mp.left_at, m.end_at) AS ended_at,
                TIMESTAMPDIFF(SECOND, COALESCE(mp.joined_at, m.start_at), COALESCE(mp.left_at, m.end_at, NOW(3))) AS active_seconds
         FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
         WHERE mp.employee_id = ? AND DATE(m.start_at) = ?
         UNION ALL
         SELECT 'task' AS kind, t.id, CONCAT('Task Completed: ', t.title) AS label, 'Tasks' AS category,
                t.completed_at AS started_at, t.completed_at AS ended_at, 0 AS active_seconds
         FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
         WHERE ta.employee_id = ? AND DATE(t.completed_at) = ?
         UNION ALL
         SELECT 'session' AS kind, id, CONCAT('Monitoring Session (', status, ')') AS label, 'System' AS category,
                started_at, COALESCE(ended_at, NOW(3)) AS ended_at,
                TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, NOW(3))) AS active_seconds
         FROM monitoring_sessions WHERE employee_id = ? AND work_date = ?
         UNION ALL
         SELECT 'app' AS kind, id, app_name AS label, app_category AS category, started_at, ended_at, active_seconds
         FROM application_usage_logs WHERE employee_id = ? AND DATE(started_at) = ?
         UNION ALL
         SELECT 'browser' AS kind, id, domain AS label, category, started_at, ended_at, active_seconds
         FROM browser_usage_logs WHERE employee_id = ? AND DATE(started_at) = ?
         UNION ALL
         SELECT 'module' AS kind, id, module AS label, 'Platform' AS category, entered_at AS started_at, exited_at AS ended_at, active_seconds
         FROM internal_module_activity WHERE employee_id = ? AND DATE(entered_at) = ?
       ) segments ORDER BY started_at ASC LIMIT 400`, [
            employeeId, date,
            employeeId, date,
            employeeId, date,
            employeeId, date,
            employeeId, date,
            employeeId, date,
            employeeId, date,
            employeeId, date,
            employeeId, date,
            employeeId, date,
        ]);
        return rows.map((row) => ({
            kind: String(row.kind),
            id: Number(row.id),
            label: String(row.label),
            category: String(row.category),
            startedAt: String(row.started_at),
            endedAt: String(row.ended_at),
            seconds: number(row.active_seconds),
        }));
    }
    /** Scheduler: refresh every summary for employees who attended or were monitored on the date. */
    static async generateAllDaily(date) {
        const rows = await query(`SELECT employee_id FROM attendance WHERE work_date = ? AND check_in_at IS NOT NULL
       UNION SELECT employee_id FROM monitoring_sessions WHERE work_date = ?`, [date, date]);
        let generated = 0;
        for (const row of rows) {
            try {
                await ActivityAnalyticsService.generateDaily(Number(row.employee_id), date);
                generated += 1;
            }
            catch (error) {
                console.error('[activity] daily summary failed', row.employee_id, error.message);
            }
        }
        return generated;
    }
    /** Scheduler: calculate preliminary weekly reports for every active employee and notify them. */
    static async generateAllWeekly(weekStart) {
        const rows = await query("SELECT id, manager_id FROM employees WHERE status = 'active'");
        let generated = 0;
        const byManager = new Map();
        for (const row of rows) {
            try {
                const report = await ActivityAnalyticsService.generateWeekly(Number(row.id), weekStart);
                if (!report || report.status === 'final')
                    continue;
                generated += 1;
                await NotificationService.notify({
                    employeeIds: [Number(row.id)],
                    type: 'activity_weekly',
                    title: 'Preliminary weekly performance published',
                    body: `Week of ${weekStart}: preliminary score ${report.score}. Add feedback before your manager finalises it.`,
                    link: '/activity?tab=weekly',
                    dedupeKey: `weekly_published:${row.id}:${weekStart}`,
                });
                if (row.manager_id)
                    byManager.set(Number(row.manager_id), (byManager.get(Number(row.manager_id)) ?? 0) + 1);
            }
            catch (error) {
                console.error('[activity] weekly report failed', row.id, error.message);
            }
        }
        for (const [managerId, count] of byManager) {
            await NotificationService.notify({
                employeeIds: [managerId],
                type: 'activity_weekly',
                title: 'Weekly scores ready for review',
                body: `${count} preliminary weekly report(s) for the week of ${weekStart} await your review.`,
                link: '/activity?tab=team',
                dedupeKey: `weekly_review:${managerId}:${weekStart}`,
            });
        }
        return generated;
    }
    static async reviewDaily(user, id, decision, note) {
        if (!user.permissions.includes('activity.review'))
            throw ApiError.forbidden('You cannot review activity summaries.');
        const row = await queryOne('SELECT * FROM daily_activity_summaries WHERE id = ?', [id]);
        if (!row)
            throw ApiError.notFound('Summary not found');
        await ActivityAnalyticsService.assertAccess(user, Number(row.employee_id));
        if (Number(row.employee_id) === user.id)
            throw ApiError.forbidden('You cannot review your own daily summary.');
        if (row.status !== 'submitted')
            throw ApiError.badRequest('Only submitted summaries can be reviewed.');
        await execute('UPDATE daily_activity_summaries SET status = ?, reviewed_by = ?, reviewed_at = NOW(3), manager_note = ? WHERE id = ?', [decision, user.id, cleanText(note, 500) || null, id]);
        await ActivityService.audit(user.id, `activity.daily_${decision}`, Number(row.employee_id), 'daily_activity_summary', id, { note });
        await NotificationService.notify({
            employeeIds: [Number(row.employee_id)],
            type: 'activity_daily',
            title: decision === 'approved' ? 'Daily activity summary approved' : 'Daily activity summary returned',
            body: cleanText(note, 300) || `Summary for ${String(row.summary_date)}`,
            link: '/activity',
            actorId: user.id,
            priority: decision === 'returned' ? 'high' : 'normal',
        });
        const stored = await queryOne('SELECT * FROM daily_activity_summaries WHERE id = ?', [id]);
        return ActivityAnalyticsService.mapDaily(stored);
    }
    /**
     * Calculates a transparent weekly performance score from platform records.
     * Parameters without data for the week (e.g. no tasks assigned) are marked
     * not applicable and their weight is redistributed, so nobody is rewarded or
     * penalised for missing data. Application usage is reported as context only.
     */
    static async generateWeekly(employeeId, weekStart) {
        const week = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart)
            ? await queryOne('SELECT DATE_SUB(DATE(?), INTERVAL WEEKDAY(DATE(?)) DAY) AS start, DATE_ADD(DATE_SUB(DATE(?), INTERVAL WEEKDAY(DATE(?)) DAY), INTERVAL 6 DAY) AS end', [weekStart, weekStart, weekStart, weekStart])
            : await queryOne('SELECT DATE_SUB(DATE(?), INTERVAL WEEKDAY(DATE(?)) DAY) AS start, DATE_ADD(DATE_SUB(DATE(?), INTERVAL WEEKDAY(DATE(?)) DAY), INTERVAL 6 DAY) AS end', [today(), today(), today(), today()]);
        if (!week)
            throw ApiError.badRequest('Unable to resolve the week.');
        const start = sqlDate(week.start);
        const end = sqlDate(week.end);
        const employee = await queryOne('SELECT id FROM employees WHERE id = ?', [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found');
        const [tasks, completedRows, overdue, pendingRows, attendance, reports, meetings, messages, apps, ticketsResolved, existing, previousWeek, kpiFeedback] = await Promise.all([
            // Tasks due in the week, or assigned in the week without a due date.
            queryOne(`SELECT COUNT(*) AS assigned FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.employee_id = ? AND t.status NOT IN ('cancelled')
           AND (t.due_date BETWEEN ? AND ? OR (t.due_date IS NULL AND DATE(ta.assigned_at) BETWEEN ? AND ?))`, [employeeId, start, end, start, end]),
            query(`SELECT t.id, t.title, t.project_id, t.approved_at, t.rejection_reason, p.name AS project_name,
                COALESCE(t.completed_at, ta.completed_at) AS completed_at,
                (COALESCE(t.completed_at, ta.completed_at) <= TIMESTAMP(t.due_date, COALESCE(t.due_time, '23:59:59')) OR t.due_date IS NULL) AS on_time,
                TIMESTAMPDIFF(MINUTE, COALESCE(ta.started_at, ta.assigned_at), COALESCE(t.completed_at, ta.completed_at)) AS cycle_minutes
         FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id LEFT JOIN projects p ON p.id = t.project_id
         WHERE ta.employee_id = ? AND DATE(COALESCE(t.completed_at, ta.completed_at)) BETWEEN ? AND ?
           AND t.status IN ('completed','approved','submitted')`, [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS total FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.employee_id = ? AND t.status NOT IN ('completed','approved','cancelled','rejected') AND t.due_date < LEAST(?, ?)`, [employeeId, end, today()]),
            query(`SELECT t.id, t.task_no, t.title, t.due_date, t.priority FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.employee_id = ? AND t.status NOT IN ('completed','approved','cancelled','rejected') ORDER BY t.due_date IS NULL, t.due_date LIMIT 10`, [employeeId]),
            queryOne(`SELECT COUNT(*) AS present_days, SUM(is_late = 1) AS late_days,
                COALESCE(SUM(CASE WHEN check_out_at IS NULL AND work_date = ? THEN TIMESTAMPDIFF(MINUTE, check_in_at, NOW(3)) ELSE total_minutes END),0) AS minutes,
                COALESCE(SUM(break_minutes),0) AS break_minutes
         FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status IN ('present','late','half_day')`, [today(), employeeId, start, end]),
            query('SELECT report_date, status FROM daily_work_reports WHERE employee_id = ? AND report_date BETWEEN ? AND ?', [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS invited, SUM(mp.attended = 1) AS attended,
                COALESCE(SUM(IF(mp.attended = 1, TIMESTAMPDIFF(MINUTE, m.start_at, m.end_at), 0)),0) AS minutes
         FROM meeting_participants mp JOIN meetings m ON m.id = mp.meeting_id
         WHERE mp.employee_id = ? AND DATE(m.start_at) BETWEEN ? AND ? AND m.status <> 'cancelled'`, [employeeId, start, end]),
            queryOne('SELECT COUNT(*) AS sent FROM messages WHERE sender_id = ? AND DATE(created_at) BETWEEN ? AND ?', [employeeId, start, end]),
            query(`SELECT app_category, SUM(active_seconds) AS seconds FROM application_usage_logs
         WHERE employee_id = ? AND DATE(started_at) BETWEEN ? AND ? GROUP BY app_category ORDER BY seconds DESC`, [employeeId, start, end]),
            queryOne('SELECT COUNT(*) AS total FROM tickets WHERE assignee_id = ? AND DATE(resolved_at) BETWEEN ? AND ?', [employeeId, start, end]),
            queryOne('SELECT score, status FROM weekly_performance_reports WHERE employee_id = ? AND week_start = ?', [employeeId, start]),
            queryOne('SELECT score, metrics FROM weekly_performance_reports WHERE employee_id = ? AND week_start = DATE_SUB(?, INTERVAL 7 DAY)', [employeeId, start]),
            queryOne('SELECT manager_remarks FROM weekly_performance_reports WHERE employee_id = ? AND week_start < ? AND manager_remarks IS NOT NULL ORDER BY week_start DESC LIMIT 1', [employeeId, start]),
        ]);
        const completed = completedRows.length;
        const assigned = Math.max(number(tasks?.assigned), completed);
        const onTime = completedRows.filter((row) => Number(row.on_time) === 1).length;
        const reviewed = completedRows.filter((row) => row.approved_at || row.rejection_reason);
        const approved = completedRows.filter((row) => row.approved_at).length;
        const withProject = completedRows.filter((row) => row.project_id).length;
        const cycleMinutes = completedRows.map((row) => number(row.cycle_minutes)).filter((value) => value > 0);
        const averageCompletionHours = cycleMinutes.length ? Math.round(cycleMinutes.reduce((sum, value) => sum + value, 0) / cycleMinutes.length / 6) / 10 : null;
        const presentDays = number(attendance?.present_days);
        const lateDays = number(attendance?.late_days);
        const workDaysSetting = await queryOne("SELECT setting_value FROM system_settings WHERE setting_key = 'work_days'");
        const workDays = new Set(String(workDaysSetting?.setting_value ?? '1,2,3,4,5,6').split(',').map((value) => Number(value.trim())));
        const [leaveRows, holidayRows] = await Promise.all([
            query("SELECT work_date FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status IN ('leave','on_leave','holiday')", [employeeId, start, end]).catch(() => []),
            query('SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ?', [start, end]).catch(() => []),
        ]);
        const excluded = new Set([...leaveRows.map((row) => sqlDate(row.work_date)), ...holidayRows.map((row) => sqlDate(row.holiday_date))]);
        const lastDay = end < today() ? end : today();
        let elapsedWorkDays = 0;
        for (let cursor = new Date(`${start}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= lastDay; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
            const iso = cursor.toISOString().slice(0, 10);
            if (workDays.has(cursor.getUTCDay()) && !excluded.has(iso))
                elapsedWorkDays += 1;
        }
        const submittedReports = reports.filter((row) => row.status !== 'draft').length;
        // null = not applicable this week; its weight is redistributed.
        const raw = {
            taskCompletion: assigned > 0 ? percent(completed, assigned) : null,
            onTimeDelivery: completed > 0 ? percent(onTime, completed) : null,
            workQuality: reviewed.length > 0 ? percent(approved, reviewed.length) : null,
            attendance: elapsedWorkDays > 0 ? Math.max(0, percent(Math.min(presentDays, elapsedWorkDays), elapsedWorkDays) - Math.min(20, lateDays * 2)) : null,
            dailyReporting: elapsedWorkDays > 0 ? percent(Math.min(submittedReports, elapsedWorkDays), elapsedWorkDays) : null,
            projectContribution: completed > 0 ? percent(withProject, completed) : null,
            collaboration: number(meetings?.invited) + number(messages?.sent) + number(ticketsResolved?.total) > 0
                ? Math.min(100, (number(meetings?.invited) > 0 ? percent(number(meetings?.attended), number(meetings?.invited)) * 0.6 : 60)
                    + Math.min(25, number(messages?.sent)) + Math.min(15, number(ticketsResolved?.total) * 5))
                : null,
        };
        const applicableWeight = Object.keys(KPI_WEIGHTS)
            .filter((key) => raw[key] !== null).reduce((sum, key) => sum + KPI_WEIGHTS[key], 0);
        const score = applicableWeight > 0
            ? Math.round(Object.keys(KPI_WEIGHTS)
                .reduce((sum, key) => sum + (raw[key] ?? 0) * KPI_WEIGHTS[key], 0) / applicableWeight * 10) / 10
            : 0;
        const labels = {
            taskCompletion: 'Task completion', onTimeDelivery: 'On-time delivery', workQuality: 'Work quality',
            attendance: 'Attendance and punctuality', dailyReporting: 'Daily reporting', projectContribution: 'Project contribution', collaboration: 'Collaboration',
        };
        const improvementAreas = Object.keys(raw)
            .filter((key) => raw[key] !== null && raw[key] < 60)
            .map((key) => `${labels[key]} is ${raw[key]}%`);
        if (number(overdue?.total) > 0)
            improvementAreas.push(`${number(overdue?.total)} overdue task(s) need attention`);
        const previousScore = previousWeek?.score === undefined || previousWeek?.score === null ? null : number(previousWeek.score);
        const metrics = {
            weights: KPI_WEIGHTS,
            effectiveWeightTotal: applicableWeight,
            notApplicable: Object.keys(raw).filter((key) => raw[key] === null),
            taskCompletion: raw.taskCompletion ?? 0,
            onTimeDelivery: raw.onTimeDelivery ?? 0,
            workQuality: raw.workQuality ?? 0,
            attendance: raw.attendance ?? 0,
            dailyReporting: raw.dailyReporting ?? 0,
            projectContribution: raw.projectContribution ?? 0,
            collaboration: raw.collaboration ?? 0,
            assigned,
            completed,
            onTime,
            approved,
            reviewed: reviewed.length,
            overdueTasks: number(overdue?.total),
            averageCompletionHours,
            presentDays,
            lateDays,
            elapsedWorkDays,
            attendancePercentage: elapsedWorkDays > 0 ? percent(Math.min(presentDays, elapsedWorkDays), elapsedWorkDays) : null,
            reportsSubmitted: submittedReports,
            meetingsAttended: number(meetings?.attended),
            meetingMinutes: number(meetings?.minutes),
            messagesSent: number(messages?.sent),
            ticketsResolved: number(ticketsResolved?.total),
            attendanceMinutes: number(attendance?.minutes),
            breakMinutes: number(attendance?.break_minutes),
            accomplishments: completedRows.slice(0, 10).map((row) => `${row.title}${row.project_name ? ` (${row.project_name})` : ''}`),
            pendingAssignments: pendingRows.map((row) => ({ id: Number(row.id), taskNo: row.task_no, title: row.title, dueDate: row.due_date, priority: row.priority })),
            improvementAreas,
            previousManagerFeedback: kpiFeedback?.manager_remarks ?? null,
            weekOverWeekChange: previousScore === null ? null : Math.round((score - previousScore) * 10) / 10,
            applicationUsage: apps.map((row) => ({ category: row.app_category, minutes: Math.round(number(row.seconds) / 60) })),
            applicationUsageNote: 'Application duration is contextual only and is not scored. Meetings, documentation, research, troubleshooting, approved breaks and offline work are never penalised.',
        };
        if (!existing || String(existing.status) !== 'final') {
            await execute(`INSERT INTO weekly_performance_reports (employee_id, week_start, week_end, metrics, score, grade, status, previous_score, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'preliminary', ?, NOW(3))
         ON DUPLICATE KEY UPDATE week_end = VALUES(week_end), metrics = VALUES(metrics), score = VALUES(score),
           grade = VALUES(grade), previous_score = VALUES(previous_score), generated_at = NOW(3)`, [employeeId, start, end, JSON.stringify(metrics), score, grade(score), previousScore]);
        }
        const stored = await queryOne('SELECT * FROM weekly_performance_reports WHERE employee_id = ? AND week_start = ?', [employeeId, start]);
        return ActivityAnalyticsService.mapWeekly(stored, metrics);
    }
    static mapWeekly(row, extraMetrics) {
        if (!row && !extraMetrics)
            return null;
        return {
            id: row ? Number(row.id) : null,
            employeeId: row ? Number(row.employee_id) : null,
            weekStart: row?.week_start,
            weekEnd: row?.week_end,
            score: number(row?.score),
            grade: row?.grade,
            status: row?.status,
            metrics: parseJson(row?.metrics ?? extraMetrics, {}),
            managerRemarks: row?.manager_remarks ?? null,
            employeeFeedback: row?.employee_feedback ?? null,
            previousScore: row?.previous_score === null || row?.previous_score === undefined ? null : number(row.previous_score),
            generatedAt: row?.generated_at,
        };
    }
    static async reviewWeekly(user, id, input) {
        if (!user.permissions.includes('activity.review'))
            throw ApiError.forbidden('You cannot review weekly performance.');
        const row = await queryOne('SELECT * FROM weekly_performance_reports WHERE id = ?', [id]);
        if (!row)
            throw ApiError.notFound('Weekly report not found');
        await ActivityAnalyticsService.assertAccess(user, Number(row.employee_id));
        if (Number(row.employee_id) === user.id && !user.permissions.includes('activity.view.all'))
            throw ApiError.forbidden('You cannot review your own weekly performance.');
        const finalize = Boolean(input.finalize);
        await execute(`UPDATE weekly_performance_reports SET manager_remarks = COALESCE(?, manager_remarks),
              status = IF(?, 'final', status), reviewed_by = ?, reviewed_at = NOW(3) WHERE id = ?`, [cleanText(input.managerRemarks, 1000) || null, finalize ? 1 : 0, user.id, id]);
        await ActivityService.audit(user.id, finalize ? 'activity.weekly_finalized' : 'activity.weekly_reviewed', Number(row.employee_id), 'weekly_performance_report', id, { finalize });
        if (Number(row.employee_id) !== user.id) {
            await NotificationService.notify({
                employeeIds: [Number(row.employee_id)],
                type: 'activity_weekly',
                title: finalize ? 'Weekly performance finalised' : 'Manager remarks on your weekly report',
                body: cleanText(input.managerRemarks, 300) || `Week of ${String(row.week_start)}`,
                link: '/activity?tab=weekly',
                actorId: user.id,
            });
        }
        const stored = await queryOne('SELECT * FROM weekly_performance_reports WHERE id = ?', [id]);
        return ActivityAnalyticsService.mapWeekly(stored);
    }
    static async weeklyFeedback(user, id, feedback) {
        const row = await queryOne('SELECT employee_id FROM weekly_performance_reports WHERE id = ?', [id]);
        if (!row)
            throw ApiError.notFound('Weekly report not found');
        if (Number(row.employee_id) !== user.id)
            throw ApiError.forbidden('You can only comment on your own weekly report.');
        await execute('UPDATE weekly_performance_reports SET employee_feedback = ? WHERE id = ?', [cleanText(feedback, 1000) || null, id]);
        const stored = await queryOne('SELECT * FROM weekly_performance_reports WHERE id = ?', [id]);
        return ActivityAnalyticsService.mapWeekly(stored);
    }
    static async weeklyList(user, employeeId, limit = 8) {
        await ActivityAnalyticsService.assertAccess(user, employeeId);
        await ActivityService.logAccess(user, employeeId, 'weekly');
        const rows = await query('SELECT * FROM weekly_performance_reports WHERE employee_id = ? ORDER BY week_start DESC LIMIT ?', [employeeId, Math.min(26, Math.max(1, limit))]);
        return rows.map((row) => ActivityAnalyticsService.mapWeekly(row));
    }
    static async selfDashboard(user, date) {
        const consent = await ActivityService.consentStatus(user);
        const session = await ActivityService.currentSession(user);
        const [daily, errors, tickets, weekly, devices, browser, recentSessions] = await Promise.all([
            ActivityAnalyticsService.daily(user, user.id, date),
            ActivityService.listErrors(user, { ownOnly: true }),
            query(`SELECT t.id, t.ticket_no, t.subject, t.status, t.priority, t.created_at,
                (SELECT COUNT(*) FROM automatic_ticket_links l WHERE l.ticket_id = t.id) AS automatic
         FROM tickets t WHERE t.requester_id = ? ORDER BY t.created_at DESC LIMIT 8`, [user.id]),
            query('SELECT * FROM weekly_performance_reports WHERE employee_id = ? ORDER BY week_start DESC LIMIT 4', [user.id]),
            ActivityService.listDevices(user),
            query(`SELECT domain, category, SUM(active_seconds) AS seconds FROM browser_usage_logs
         WHERE employee_id = ? AND DATE(started_at) = ? GROUP BY domain, category ORDER BY seconds DESC LIMIT 12`, [user.id, date]),
            query(`SELECT s.*, d.device_name FROM monitoring_sessions s JOIN employee_devices d ON d.id = s.device_id
         WHERE s.employee_id = ? ORDER BY s.started_at DESC LIMIT 7`, [user.id]),
        ]);
        return {
            date,
            policy: consent.policy,
            consent: { acknowledged: consent.acknowledged, acknowledgedAt: consent.acknowledgedAt },
            session,
            devices,
            daily,
            errors: errors.slice(0, 10),
            timeline: await ActivityAnalyticsService.timeline(user, user.id, date),
            corrections: await ActivityService.listCorrections(user).then((rows) => rows.filter((row) => row.employeeId === user.id).slice(0, 20)),
            accessHistory: (await ActivityService.accessHistory(user)).slice(0, 20),
            tickets,
            browser: browser.map((row) => ({ domain: row.domain, category: row.category, minutes: Math.round(number(row.seconds) / 60) })),
            weekly: weekly.map((row) => ActivityAnalyticsService.mapWeekly(row)),
            sessions: recentSessions,
        };
    }
    static async teamOverview(user, date) {
        const visible = await visibleEmployeeIds(user, 'activity');
        const ids = visible ?? (await query("SELECT id FROM employees WHERE status = 'active' ORDER BY full_name LIMIT 500")).map((row) => Number(row.id));
        if (ids.length === 0)
            return { scope: 'team', date, employees: [], totals: { employees: 0, activeNow: 0, activeMinutes: 0, tasksCompleted: 0, pendingReviews: 0 } };
        const placeholders = ids.map(() => '?').join(',');
        const [employees, appTotals, taskTotals, summaries, weeks] = await Promise.all([
            query(`SELECT e.id, e.full_name, e.employee_code, e.photo_url, d.name AS department_name, dg.title AS designation_title,
                l.name AS location_name,
                s.id AS session_id, s.started_at AS session_started_at, s.last_heartbeat_at,
                s.current_app, s.current_category, s.idle_seconds
         FROM employees e 
         LEFT JOIN departments d ON d.id = e.department_id 
         LEFT JOIN designations dg ON dg.id = e.designation_id
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN monitoring_sessions s ON s.employee_id = e.id AND s.status = 'active'
         WHERE e.id IN (${placeholders}) AND e.status = 'active' ORDER BY e.full_name`, ids),
            query(`SELECT employee_id, SUM(active_seconds) AS seconds FROM application_usage_logs
         WHERE DATE(started_at) = ? AND employee_id IN (${placeholders}) GROUP BY employee_id`, [date, ...ids]),
            query(`SELECT ta.employee_id, COUNT(*) AS completed FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE DATE(COALESCE(t.completed_at, ta.completed_at)) = ? AND ta.employee_id IN (${placeholders}) GROUP BY ta.employee_id`, [date, ...ids]),
            query(`SELECT employee_id, status, active_minutes, key_activities FROM daily_activity_summaries
         WHERE summary_date = ? AND employee_id IN (${placeholders})`, [date, ...ids]),
            query(`SELECT employee_id, score, grade, status FROM weekly_performance_reports w
         WHERE w.week_start = (SELECT MAX(week_start) FROM weekly_performance_reports x WHERE x.employee_id = w.employee_id)
           AND w.employee_id IN (${placeholders})`, ids),
        ]);
        const [overdueRows, issueRows, loginRows, leaveRows, meetingRows, attendanceRows] = await Promise.all([
            query(`SELECT ta.employee_id, COUNT(*) AS total FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE t.status NOT IN ('completed','approved','cancelled','rejected') AND t.due_date < ? AND ta.employee_id IN (${placeholders}) GROUP BY ta.employee_id`, [date, ...ids]),
            query(`SELECT e.employee_id, COUNT(DISTINCT e.incident_id) AS total FROM system_error_events e JOIN error_incidents i ON i.id = e.incident_id
         WHERE i.status IN ('open','suggested','ticket_created') AND e.employee_id IN (${placeholders}) GROUP BY e.employee_id`, ids),
            query(`SELECT employee_id, login_at, logout_at, duration_minutes, termination_status, browser, os, last_heartbeat_at
         FROM employee_login_audit
         WHERE employee_id IN (${placeholders}) AND DATE(login_at) = ?
         ORDER BY login_at DESC`, [...ids, date]),
            query(`SELECT lr.employee_id, lt.name AS leave_type, lr.start_date, lr.end_date, lr.status, m.full_name AS approver_name
         FROM leave_requests lr
         JOIN leave_types lt ON lt.id = lr.leave_type_id
         LEFT JOIN employees m ON m.id = lr.manager_id
         WHERE lr.employee_id IN (${placeholders}) AND lr.status = 'approved' AND ? BETWEEN lr.start_date AND lr.end_date`, [...ids, date]),
            query(`SELECT mp.employee_id, m.id AS meeting_id, m.title, m.start_at, m.end_at, m.status, mp.joined_at, mp.left_at
         FROM meetings m
         JOIN meeting_participants mp ON mp.meeting_id = m.id
         WHERE mp.employee_id IN (${placeholders})
           AND DATE(m.start_at) = ?
           AND (m.status = 'ongoing' OR (m.status = 'scheduled' AND NOW(3) BETWEEN m.start_at AND m.end_at))`, [...ids, date]),
            query(`SELECT a.employee_id, a.check_in_at, a.check_out_at, a.total_minutes, a.break_minutes,
                (SELECT COUNT(*) FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.ended_at IS NULL) AS on_break
         FROM attendance a
         WHERE a.employee_id IN (${placeholders}) AND a.work_date = ?`, [...ids, date]),
        ]);
        const overdueMap = new Map(overdueRows.map((row) => [Number(row.employee_id), number(row.total)]));
        const issueMap = new Map(issueRows.map((row) => [Number(row.employee_id), number(row.total)]));
        const appMap = new Map(appTotals.map((row) => [Number(row.employee_id), Math.round(number(row.seconds) / 60)]));
        const taskMap = new Map(taskTotals.map((row) => [Number(row.employee_id), number(row.completed)]));
        const summaryMap = new Map(summaries.map((row) => [Number(row.employee_id), row]));
        const weekMap = new Map(weeks.map((row) => [Number(row.employee_id), row]));
        const loginMap = new Map();
        for (const r of loginRows) {
            const eid = Number(r.employee_id);
            if (!loginMap.has(eid))
                loginMap.set(eid, r);
        }
        const leaveMap = new Map(leaveRows.map((r) => [Number(r.employee_id), r]));
        const meetingMap = new Map(meetingRows.map((r) => [Number(r.employee_id), r]));
        const attMap = new Map(attendanceRows.map((r) => [Number(r.employee_id), r]));
        const rows = employees.map((employee) => {
            const eid = Number(employee.id);
            const summary = summaryMap.get(eid);
            const week = weekMap.get(eid);
            const login = loginMap.get(eid);
            const leave = leaveMap.get(eid);
            const meeting = meetingMap.get(eid);
            const att = attMap.get(eid);
            const isMonitoring = Boolean(employee.session_id);
            const isIdle = (employee.idle_seconds ? Number(employee.idle_seconds) : 0) >= 300;
            const onLeave = Boolean(leave);
            const inMeeting = Boolean(meeting);
            const onBreak = Number(att?.on_break ?? 0) > 0;
            const isLoggedIn = Boolean(login && !login.logout_at);
            let liveStatus = 'Offline';
            if (onLeave)
                liveStatus = 'On approved leave';
            else if (inMeeting)
                liveStatus = 'In a meeting';
            else if (onBreak)
                liveStatus = 'On break';
            else if (isMonitoring && !isIdle)
                liveStatus = 'Working';
            else if (isMonitoring && isIdle)
                liveStatus = 'Idle';
            else if (isLoggedIn)
                liveStatus = 'Logged in (Agent Idle)';
            else if (att?.check_in_at && !att?.check_out_at)
                liveStatus = 'Checked In';
            return {
                id: eid,
                name: String(employee.full_name),
                employeeCode: String(employee.employee_code),
                photoUrl: employee.photo_url,
                department: employee.department_name,
                designation: employee.designation_title,
                location: employee.location_name ?? null,
                active: isMonitoring,
                liveStatus,
                sessionStartedAt: employee.session_started_at,
                lastHeartbeatAt: employee.last_heartbeat_at || login?.last_heartbeat_at || null,
                currentApp: employee.current_app ?? (isMonitoring ? 'Working session' : (inMeeting ? 'Meeting' : (onLeave ? 'On leave' : null))),
                currentCategory: employee.current_category ?? null,
                idleSeconds: employee.idle_seconds ? Number(employee.idle_seconds) : 0,
                activeMinutes: appMap.get(eid) ?? 0,
                tasksCompleted: taskMap.get(eid) ?? 0,
                attendanceMinutes: number(att?.total_minutes),
                loginAt: login?.login_at ?? null,
                logoutAt: login?.logout_at ?? null,
                sessionDurationMinutes: login ? (login.logout_at ? number(login.duration_minutes) : Math.max(0, Math.floor((Date.now() - new Date(String(login.login_at)).getTime()) / 60000))) : 0,
                browser: login?.browser ?? null,
                leaveInfo: leave ? {
                    leaveType: String(leave.leave_type),
                    startDate: String(leave.start_date),
                    endDate: String(leave.end_date),
                    approver: leave.approver_name,
                } : null,
                meetingInfo: meeting ? {
                    title: String(meeting.title),
                    startAt: String(meeting.start_at),
                    endAt: String(meeting.end_at),
                } : null,
                dailyStatus: summary?.status ?? null,
                keyActivities: parseJson(summary?.key_activities, []),
                weeklyScore: week ? number(week.score) : null,
                weeklyGrade: week?.grade ?? null,
                overdueTasks: overdueMap.get(eid) ?? 0,
                openIssues: issueMap.get(eid) ?? 0,
                needsAssistance: (week ? number(week.score) < 60 : false) || (overdueMap.get(eid) ?? 0) >= 3 || (issueMap.get(eid) ?? 0) > 0 || summary?.status === 'returned',
            };
        });
        return {
            scope: visible ? 'team' : 'all',
            date,
            employees: rows,
            totals: {
                employees: rows.length,
                activeNow: rows.filter((row) => row.active).length,
                loggedIn: rows.filter((row) => row.loginAt && !row.logoutAt).length,
                working: rows.filter((row) => row.liveStatus === 'Working').length,
                inMeetings: rows.filter((row) => row.liveStatus === 'In a meeting').length,
                onApprovedLeave: rows.filter((row) => row.liveStatus === 'On approved leave').length,
                onBreaks: rows.filter((row) => row.liveStatus === 'On break').length,
                offline: rows.filter((row) => row.liveStatus === 'Offline').length,
                activeMinutes: rows.reduce((sum, row) => sum + row.activeMinutes, 0),
                tasksCompleted: rows.reduce((sum, row) => sum + row.tasksCompleted, 0),
                pendingReviews: rows.filter((row) => row.dailyStatus === 'submitted').length,
                needsAssistance: rows.filter((row) => row.needsAssistance).length,
            },
        };
    }
    static async adminOverview(user, date) {
        const [counts, departments, appTotals, incidents, devices, health, weekly, sessions, team] = await Promise.all([
            queryOne(`SELECT (SELECT COUNT(*) FROM employee_devices WHERE status = 'active') AS devices,
                (SELECT COUNT(*) FROM monitoring_sessions WHERE status = 'active') AS active_sessions,
                (SELECT COUNT(*) FROM monitoring_sessions WHERE work_date = ?) AS sessions_today,
                (SELECT COUNT(*) FROM daily_activity_summaries WHERE summary_date = ? AND status = 'submitted') AS pending_daily,
                (SELECT COUNT(*) FROM error_incidents WHERE status IN ('open','suggested')) AS open_incidents,
                (SELECT COUNT(*) FROM automatic_ticket_links) AS automatic_tickets`, [date, date]),
            query(`SELECT COALESCE(d.name, 'Unassigned') AS department, COUNT(DISTINCT s.employee_id) AS employees,
                COALESCE(SUM(u.active_seconds),0) AS seconds
         FROM monitoring_sessions s LEFT JOIN employees e ON e.id = s.employee_id LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN application_usage_logs u ON u.session_id = s.id AND DATE(u.started_at) = ?
         WHERE s.work_date = ? GROUP BY d.name ORDER BY seconds DESC`, [date, date]),
            query(`SELECT app_name, app_category, SUM(active_seconds) AS seconds FROM application_usage_logs
         WHERE DATE(started_at) = ? GROUP BY app_name, app_category ORDER BY seconds DESC LIMIT 10`, [date]),
            query(`SELECT i.id, i.title, i.severity, i.status, i.occurrence_count, i.last_seen_at, t.ticket_no
         FROM error_incidents i LEFT JOIN tickets t ON t.id = i.ticket_id ORDER BY i.last_seen_at DESC LIMIT 10`),
            query(`SELECT d.id, d.device_name, d.os_name, d.status, d.last_seen_at, e.full_name
         FROM employee_devices d JOIN employees e ON e.id = d.employee_id ORDER BY d.last_seen_at DESC LIMIT 20`),
            query(`SELECT h.*, e.full_name FROM device_health_logs h JOIN employees e ON e.id = h.employee_id ORDER BY h.reported_at DESC LIMIT 10`),
            query(`SELECT employee_id, AVG(score) AS average FROM weekly_performance_reports WHERE week_start >= DATE_SUB(?, INTERVAL 28 DAY) GROUP BY employee_id`, [date]),
            query(`SELECT s.id, s.started_at, s.last_heartbeat_at, e.full_name, d.device_name FROM monitoring_sessions s
         JOIN employees e ON e.id = s.employee_id JOIN employee_devices d ON d.id = s.device_id
         WHERE s.status = 'active' ORDER BY s.started_at DESC LIMIT 20`),
            ActivityAnalyticsService.teamOverview(user, date),
        ]);
        return {
            scope: 'all',
            date,
            employees: team.employees,
            totals: {
                ...team.totals,
                devices: number(counts?.devices),
                activeSessions: number(counts?.active_sessions),
                sessionsToday: number(counts?.sessions_today),
                pendingDailyReviews: number(counts?.pending_daily),
                openIncidents: number(counts?.open_incidents),
                automaticTickets: number(counts?.automatic_tickets),
                averageWeeklyScore: weekly.length > 0 ? Math.round(weekly.reduce((sum, row) => sum + number(row.average), 0) / weekly.length * 10) / 10 : null,
            },
            departments: departments.map((row) => ({ department: row.department, employees: number(row.employees), minutes: Math.round(number(row.seconds) / 60) })),
            applications: appTotals.map((row) => ({ app: row.app_name, category: row.app_category, minutes: Math.round(number(row.seconds) / 60) })),
            incidents: incidents.map((row) => ({ id: Number(row.id), title: row.title, severity: row.severity, status: row.status, occurrences: number(row.occurrence_count), lastSeenAt: row.last_seen_at, ticketNo: row.ticket_no })),
            devices,
            health,
            activeSessions: sessions,
        };
    }
    /** Complete login and logout history across store computers and web sessions. */
    static async loginHistory(user, options = {}) {
        const visible = await visibleEmployeeIds(user, 'activity');
        const clauses = [];
        const params = [];
        if (visible && visible.length > 0) {
            clauses.push(`a.employee_id IN (${visible.map(() => '?').join(',')})`);
            params.push(...visible);
        }
        else if (visible && visible.length === 0) {
            return { total: 0, items: [], summary: { total: 0, active: 0, ended: 0, avgDurationMinutes: 0 } };
        }
        if (options.employeeId) {
            clauses.push('a.employee_id = ?');
            params.push(options.employeeId);
        }
        if (options.date) {
            clauses.push('DATE(a.login_at) = ?');
            params.push(options.date);
        }
        else {
            if (options.from) {
                clauses.push('DATE(a.login_at) >= ?');
                params.push(options.from);
            }
            if (options.to) {
                clauses.push('DATE(a.login_at) <= ?');
                params.push(options.to);
            }
        }
        if (options.location && options.location !== 'ALL') {
            const loc = options.location.toLowerCase();
            if (loc === 'dav')
                clauses.push("(LOWER(a.location_name) LIKE '%davanagere%' OR LOWER(a.location_name) LIKE '%dav%')");
            else if (loc === 'shi')
                clauses.push("(LOWER(a.location_name) LIKE '%shivamogga%' OR LOWER(a.location_name) LIKE '%shi%')");
            else if (loc === 'bel')
                clauses.push("(LOWER(a.location_name) LIKE '%belagavi%' OR LOWER(a.location_name) LIKE '%bel%')");
            else if (loc === 'hq')
                clauses.push("(LOWER(a.location_name) LIKE '%head%' OR LOWER(a.location_name) LIKE '%main%' OR LOWER(a.location_name) LIKE '%hq%')");
            else {
                clauses.push('a.location_name = ?');
                params.push(options.location);
            }
        }
        if (options.status && options.status !== 'all') {
            if (options.status === 'active') {
                clauses.push('a.logout_at IS NULL AND a.termination_status = "active"');
            }
            else {
                clauses.push('(a.termination_status = ? OR a.logout_reason = ?)');
                params.push(options.status, options.status);
            }
        }
        if (options.search?.trim()) {
            const q = `%${options.search.trim().toLowerCase()}%`;
            clauses.push('(LOWER(a.full_name) LIKE ? OR LOWER(a.employee_code) LIKE ? OR LOWER(a.browser) LIKE ?)');
            params.push(q, q, q);
        }
        const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = Math.min(300, Math.max(1, options.limit ?? 50));
        const offset = Math.max(0, options.offset ?? 0);
        const countRow = await queryOne(`SELECT COUNT(*) AS total,
              SUM(IF(logout_at IS NULL AND termination_status = 'active', 1, 0)) AS active,
              SUM(IF(logout_at IS NOT NULL, 1, 0)) AS ended,
              AVG(duration_minutes) AS avg_dur
       FROM employee_login_audit a ${whereClause}`, params);
        const rows = await query(`SELECT a.id, a.session_id, a.employee_id, a.employee_code, a.full_name, a.location_name,
              a.login_at, a.logout_at, a.last_heartbeat_at, a.duration_minutes,
              a.ip, a.user_agent, a.browser, a.os, a.device_id,
              a.login_status, a.logout_reason, a.termination_status
       FROM employee_login_audit a
       ${whereClause}
       ORDER BY a.login_at DESC
       LIMIT ? OFFSET ?`, [...params, limit, offset]);
        return {
            total: number(countRow?.total),
            summary: {
                total: number(countRow?.total),
                active: number(countRow?.active),
                ended: number(countRow?.ended),
                avgDurationMinutes: Math.round(number(countRow?.avg_dur) || 0),
            },
            items: rows.map((r) => {
                const isLive = !r.logout_at && r.termination_status === 'active';
                const dur = isLive
                    ? Math.max(0, Math.floor((Date.now() - new Date(String(r.login_at)).getTime()) / 60000))
                    : number(r.duration_minutes);
                return {
                    id: Number(r.id),
                    sessionId: r.session_id ? Number(r.session_id) : null,
                    employeeId: Number(r.employee_id),
                    employeeCode: String(r.employee_code ?? ''),
                    employeeName: String(r.full_name ?? 'Employee'),
                    location: r.location_name ?? 'Head Office',
                    loginAt: String(r.login_at),
                    logoutAt: r.logout_at ? String(r.logout_at) : null,
                    lastHeartbeatAt: String(r.last_heartbeat_at),
                    durationMinutes: dur,
                    browser: String(r.browser ?? 'Web Browser'),
                    os: String(r.os ?? 'Windows'),
                    ip: r.ip ? String(r.ip) : null,
                    loginStatus: String(r.login_status ?? 'success'),
                    logoutReason: r.logout_reason ?? (isLive ? 'Still active' : 'Normal session end'),
                    terminationStatus: isLive ? 'active' : String(r.termination_status ?? 'normal'),
                };
            }),
        };
    }
    /** Overview of leaves for availability section. */
    static async leavesOverview(user, date, location) {
        const visible = await visibleEmployeeIds(user, 'activity');
        const clauses = ['? BETWEEN lr.start_date AND lr.end_date'];
        const params = [date];
        if (visible && visible.length > 0) {
            clauses.push(`lr.employee_id IN (${visible.map(() => '?').join(',')})`);
            params.push(...visible);
        }
        if (location && location !== 'ALL') {
            const loc = location.toLowerCase();
            if (loc === 'dav')
                clauses.push("(LOWER(l.name) LIKE '%davanagere%' OR LOWER(l.name) LIKE '%dav%')");
            else if (loc === 'shi')
                clauses.push("(LOWER(l.name) LIKE '%shivamogga%' OR LOWER(l.name) LIKE '%shi%')");
            else if (loc === 'bel')
                clauses.push("(LOWER(l.name) LIKE '%belagavi%' OR LOWER(l.name) LIKE '%bel%')");
            else if (loc === 'hq')
                clauses.push("(LOWER(l.name) LIKE '%head%' OR LOWER(l.name) LIKE '%main%' OR LOWER(l.name) LIKE '%hq%')");
        }
        const rows = await query(`SELECT lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.days, lr.status, lr.reason,
              lr.decision_note, lt.name AS leave_type_name,
              e.full_name, e.employee_code, e.photo_url, d.name AS department_name, dg.title AS designation_title,
              l.name AS location_name, m.full_name AS approver_name
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN employees m ON m.id = lr.manager_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY lr.start_date DESC`, params);
        return rows.map((r) => ({
            id: Number(r.id),
            employeeId: Number(r.employee_id),
            employeeName: String(r.full_name),
            employeeCode: String(r.employee_code),
            photoUrl: r.photo_url,
            department: r.department_name,
            designation: r.designation_title,
            location: r.location_name,
            leaveType: String(r.leave_type_name),
            startDate: String(r.start_date),
            endDate: String(r.end_date),
            days: Number(r.days),
            status: String(r.status),
            reason: String(r.reason ?? ''),
            approverName: r.approver_name,
            decisionNote: r.decision_note,
        }));
    }
    /** Overview of meetings for calendar & availability section. */
    static async meetingsOverview(user, date) {
        const visible = await visibleEmployeeIds(user, 'activity');
        const clauses = ['DATE(m.start_at) = ?'];
        const params = [date];
        if (visible && visible.length > 0) {
            clauses.push(`m.id IN (SELECT meeting_id FROM meeting_participants WHERE employee_id IN (${visible.map(() => '?').join(',')}))`);
            params.push(...visible);
        }
        const rows = await query(`SELECT m.id, m.title, m.description, m.agenda, m.location_type, m.room_name,
              m.start_at, m.end_at, m.status, m.meeting_code,
              o.full_name AS organizer_name, d.name AS department_name,
              (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) AS total_participants,
              (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.attended = 1) AS attended_count
       FROM meetings m
       JOIN employees o ON o.id = m.organizer_id
       LEFT JOIN departments d ON d.id = m.department_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY m.start_at ASC`, params);
        return rows.map((r) => {
            const start = new Date(String(r.start_at)).getTime();
            const end = new Date(String(r.end_at)).getTime();
            const durationMinutes = Math.max(0, Math.round((end - start) / 60000));
            return {
                id: Number(r.id),
                title: String(r.title),
                description: r.description,
                agenda: r.agenda,
                locationType: String(r.location_type),
                roomName: r.room_name,
                startAt: String(r.start_at),
                endAt: String(r.end_at),
                durationMinutes,
                status: String(r.status),
                meetingCode: String(r.meeting_code),
                organizerName: String(r.organizer_name),
                department: r.department_name,
                totalParticipants: number(r.total_participants),
                attendedCount: number(r.attended_count),
            };
        });
    }
    /** Automatic monthly activity report, derived from the same daily, task and KPI records. */
    static async monthly(user, employeeId, month) {
        await ActivityAnalyticsService.assertAccess(user, employeeId);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
            throw ApiError.badRequest('Use a valid YYYY-MM month.');
        const bounds = await queryOne("SELECT DATE(CONCAT(?, '-01')) AS start, LAST_DAY(CONCAT(?, '-01')) AS end", [month, month]);
        if (!bounds)
            throw ApiError.badRequest('Unable to resolve the month.');
        const start = String(bounds.start).slice(0, 10);
        const end = String(bounds.end).slice(0, 10);
        const employee = await queryOne(`SELECT e.id, e.full_name, e.employee_code, e.photo_url, d.name AS department_name,
              dg.title AS designation_title, m.full_name AS manager_name, l.name AS location_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`, [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found');
        const [apps, summaries, attendance, tasks, completed, weeks, errorCount, ticketCount, pending] = await Promise.all([
            query(`SELECT app_name, app_category, SUM(active_seconds) AS seconds, COUNT(*) AS sessions
         FROM application_usage_logs WHERE employee_id = ? AND DATE(started_at) BETWEEN ? AND ?
         GROUP BY app_name, app_category ORDER BY seconds DESC`, [employeeId, start, end]),
            query(`SELECT summary_date, status, active_minutes, attendance_minutes, task_summary, key_activities
         FROM daily_activity_summaries WHERE employee_id = ? AND summary_date BETWEEN ? AND ? ORDER BY summary_date`, [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS days, COALESCE(SUM(total_minutes),0) AS minutes FROM attendance
         WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status IN ('present','late','half_day')`, [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS assigned FROM task_assignments WHERE employee_id = ? AND DATE(assigned_at) BETWEEN ? AND ?`, [employeeId, start, end]),
            query(`SELECT t.id, t.task_no, t.title, p.name AS project_name, COALESCE(t.completed_at, ta.completed_at) AS completed_at
         FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id LEFT JOIN projects p ON p.id = t.project_id
         WHERE ta.employee_id = ? AND DATE(COALESCE(t.completed_at, ta.completed_at)) BETWEEN ? AND ?
         ORDER BY completed_at DESC`, [employeeId, start, end]),
            query(`SELECT week_start, week_end, score, grade, status FROM weekly_performance_reports
         WHERE employee_id = ? AND week_start BETWEEN ? AND ? ORDER BY week_start`, [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS total FROM system_error_events WHERE employee_id = ? AND DATE(occurred_at) BETWEEN ? AND ?`, [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS total FROM tickets WHERE requester_id = ? AND DATE(created_at) BETWEEN ? AND ?`, [employeeId, start, end]),
            query(`SELECT t.id, t.task_no, t.title, t.due_date, t.priority, p.name AS project_name
         FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id LEFT JOIN projects p ON p.id = t.project_id
         WHERE ta.employee_id = ? AND t.status NOT IN ('completed','cancelled','rejected') ORDER BY t.due_date LIMIT 10`, [employeeId]),
        ]);
        const appBreakdown = apps.map((row) => ({
            app: String(row.app_name), category: String(row.app_category),
            minutes: Math.round(number(row.seconds) / 60), seconds: number(row.seconds), sessions: number(row.sessions),
        }));
        const activeMinutes = Math.round(appBreakdown.reduce((sum, row) => sum + row.seconds, 0) / 60);
        const keyActivities = [...new Set(summaries.flatMap((row) => parseJson(row.key_activities, []).map((item) => cleanText(item, 200))))].filter(Boolean).slice(0, 20);
        const weeklyScores = weeks.filter((row) => row.score !== null).map((row) => number(row.score));
        const totals = {
            attendanceDays: number(attendance?.days),
            attendanceMinutes: number(attendance?.minutes),
            activeMinutes,
            tasksAssigned: number(tasks?.assigned),
            tasksCompleted: completed.length,
            daysMonitored: summaries.length,
            daysSubmitted: summaries.filter((row) => ['submitted', 'approved', 'returned'].includes(String(row.status))).length,
            daysApproved: summaries.filter((row) => String(row.status) === 'approved').length,
            incidents: number(errorCount?.total),
            tickets: number(ticketCount?.total),
            averageWeeklyScore: weeklyScores.length ? Math.round(weeklyScores.reduce((sum, score) => sum + score, 0) / weeklyScores.length * 10) / 10 : null,
        };
        return {
            month, start, end,
            employee: {
                id: Number(employee.id), name: employee.full_name, employeeCode: employee.employee_code, photoUrl: employee.photo_url,
                department: employee.department_name, designation: employee.designation_title,
                manager: employee.manager_name, location: employee.location_name,
            },
            totals,
            applications: appBreakdown,
            days: summaries.map((row) => ({
                date: row.summary_date, status: row.status, activeMinutes: number(row.active_minutes),
                attendanceMinutes: number(row.attendance_minutes), tasksCompleted: number(parseJson(row.task_summary, {}).completed),
            })),
            weekly: weeks.map((row) => ({ weekStart: row.week_start, weekEnd: row.week_end, score: number(row.score), grade: row.grade, status: row.status })),
            completedTasks: completed.map((row) => ({ id: Number(row.id), taskNo: row.task_no, title: row.title, project: row.project_name, completedAt: row.completed_at })),
            pendingTasks: pending.map((row) => ({ id: Number(row.id), taskNo: row.task_no, title: row.title, dueDate: row.due_date, priority: row.priority, project: row.project_name })),
            keyActivities,
        };
    }
    /** Monthly overview for the caller plus all employees in their permission scope. */
    static async monthlyDashboard(user, month) {
        const self = await ActivityAnalyticsService.monthly(user, user.id, month);
        const canTeam = user.permissions.includes('activity.view.team') || user.permissions.includes('activity.view.all');
        if (!canTeam)
            return { month, self, team: null };
        const visible = await visibleEmployeeIds(user, 'activity');
        const ids = visible ?? (await query("SELECT id FROM employees WHERE status = 'active' ORDER BY full_name LIMIT 500")).map((row) => Number(row.id));
        const start = self.start;
        const end = self.end;
        if (ids.length === 0)
            return { month, self, team: { scope: 'team', employees: [], totals: { employees: 0, activeMinutes: 0, tasksCompleted: 0, submittedDays: 0, averageWeeklyScore: null } } };
        const placeholders = ids.map(() => '?').join(',');
        const rows = await query(`SELECT e.id, e.full_name, e.employee_code, e.photo_url, d.name AS department_name, dg.title AS designation_title,
              (SELECT COALESCE(SUM(u.active_seconds),0) FROM application_usage_logs u WHERE u.employee_id = e.id AND DATE(u.started_at) BETWEEN ? AND ?) AS seconds,
              (SELECT COUNT(*) FROM attendance a WHERE a.employee_id = e.id AND a.work_date BETWEEN ? AND ? AND a.status IN ('present','late','half_day')) AS attendance_days,
              (SELECT COUNT(*) FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id WHERE ta.employee_id = e.id AND DATE(COALESCE(t.completed_at, ta.completed_at)) BETWEEN ? AND ?) AS tasks_completed,
              (SELECT COUNT(*) FROM daily_activity_summaries s WHERE s.employee_id = e.id AND s.summary_date BETWEEN ? AND ? AND s.status IN ('submitted','approved','returned')) AS submitted_days,
              (SELECT AVG(w.score) FROM weekly_performance_reports w WHERE w.employee_id = e.id AND w.week_start BETWEEN ? AND ?) AS average_score
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE e.status = 'active' AND e.id IN (${placeholders}) ORDER BY e.full_name`, [start, end, start, end, start, end, start, end, start, end, ...ids]);
        const employees = rows.map((row) => ({
            id: Number(row.id), name: row.full_name, employeeCode: row.employee_code, photoUrl: row.photo_url,
            department: row.department_name, designation: row.designation_title,
            activeMinutes: Math.round(number(row.seconds) / 60), attendanceDays: number(row.attendance_days),
            tasksCompleted: number(row.tasks_completed), submittedDays: number(row.submitted_days),
            averageWeeklyScore: row.average_score === null ? null : Math.round(number(row.average_score) * 10) / 10,
        }));
        return {
            month, self,
            team: {
                scope: visible ? 'team' : 'all',
                employees,
                totals: {
                    employees: employees.length,
                    activeMinutes: employees.reduce((sum, row) => sum + row.activeMinutes, 0),
                    tasksCompleted: employees.reduce((sum, row) => sum + row.tasksCompleted, 0),
                    submittedDays: employees.reduce((sum, row) => sum + row.submittedDays, 0),
                    averageWeeklyScore: (() => {
                        const scores = employees.map((row) => row.averageWeeklyScore).filter((score) => score !== null);
                        return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 10) / 10 : null;
                    })(),
                },
            },
        };
    }
    static async employeeProfile(user, employeeId, date) {
        await ActivityAnalyticsService.assertAccess(user, employeeId);
        await ActivityService.logAccess(user, employeeId, 'profile');
        const daily = await ActivityAnalyticsService.generateDaily(employeeId, date);
        const weekly = await ActivityAnalyticsService.weeklyList(user, employeeId, 6);
        const timeline = await ActivityAnalyticsService.timeline(user, employeeId, date);
        return { daily, weekly, timeline };
    }
}
//# sourceMappingURL=ActivityAnalyticsService.js.map