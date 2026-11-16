import { execute, query, queryOne } from '../db/index.js';
import { today } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { subtreeIds, visibleEmployeeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { ActivityService, cleanText, parseJson } from './ActivityService.js';
const DEFAULT_WEEK_START = `DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`;
function number(value) {
    return Number(value ?? 0);
}
function percent(part, total) {
    return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
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
    /** Chronological work timeline (applications, approved websites, platform modules). */
    static async timeline(user, employeeId, date) {
        await ActivityAnalyticsService.assertAccess(user, employeeId);
        const rows = await query(`SELECT * FROM (
         SELECT 'app' AS kind, id, app_name AS label, app_category AS category, started_at, ended_at, active_seconds FROM application_usage_logs
         WHERE employee_id = ? AND DATE(started_at) = ?
         UNION ALL
         SELECT 'browser', id, domain, category, started_at, ended_at, active_seconds FROM browser_usage_logs
         WHERE employee_id = ? AND DATE(started_at) = ?
         UNION ALL
         SELECT 'module', id, module, 'Platform', entered_at, exited_at, active_seconds FROM internal_module_activity
         WHERE employee_id = ? AND DATE(entered_at) = ?
       ) segments ORDER BY started_at DESC LIMIT 300`, [employeeId, date, employeeId, date, employeeId, date]);
        return rows.map((row) => ({
            kind: row.kind,
            id: Number(row.id),
            label: row.label,
            category: row.category,
            startedAt: row.started_at,
            endedAt: row.ended_at,
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
        await execute('UPDATE daily_activity_summaries SET status = ?, reviewed_by = ?, reviewed_at = NOW(3), manager_note = ? WHERE id = ?', [decision, user.id, cleanText(note, 500) || null, id]);
        await ActivityService.audit(user.id, `activity.daily_${decision}`, Number(row.employee_id), 'daily_activity_summary', id, { note });
        const stored = await queryOne('SELECT * FROM daily_activity_summaries WHERE id = ?', [id]);
        return ActivityAnalyticsService.mapDaily(stored);
    }
    /** Calculates a transparent weekly performance score from platform records. */
    static async generateWeekly(employeeId, weekStart) {
        const week = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart)
            ? await queryOne('SELECT DATE(?) AS start, DATE_ADD(DATE(?), INTERVAL 6 DAY) AS end', [weekStart, weekStart])
            : await queryOne(`SELECT ${DEFAULT_WEEK_START} AS start, DATE_ADD(${DEFAULT_WEEK_START}, INTERVAL 6 DAY) AS end`);
        if (!week)
            throw ApiError.badRequest('Unable to resolve the week.');
        const start = String(week.start).slice(0, 10);
        const end = String(week.end).slice(0, 10);
        const [tasks, attendance, reports, meetings, messages, apps, existing] = await Promise.all([
            queryOne(`SELECT COUNT(*) AS assigned,
                SUM(t.status IN ('completed','approved')) AS completed,
                SUM(t.status IN ('completed','approved') AND (t.completed_at <= TIMESTAMP(t.due_date, COALESCE(t.due_time, '23:59:59')))) AS on_time,
                SUM(t.approved_at IS NOT NULL) AS approved,
                SUM(t.project_id IS NOT NULL) AS with_project
         FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.employee_id = ? AND DATE(ta.assigned_at) BETWEEN ? AND ?`, [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS present_days,
                COALESCE(SUM(CASE WHEN check_out_at IS NULL AND work_date = CURDATE() THEN TIMESTAMPDIFF(MINUTE, check_in_at, NOW(3)) ELSE total_minutes END),0) AS minutes
         FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status IN ('present','late','half_day')`, [employeeId, start, end]),
            query("SELECT report_date, status FROM daily_work_reports WHERE employee_id = ? AND report_date BETWEEN ? AND ?", [employeeId, start, end]),
            queryOne(`SELECT COUNT(*) AS attended FROM meeting_participants WHERE employee_id = ? AND attended = 1`, [employeeId]),
            queryOne(`SELECT COUNT(*) AS sent FROM messages WHERE sender_id = ? AND DATE(created_at) BETWEEN ? AND ?`, [employeeId, start, end]),
            query(`SELECT app_category, SUM(active_seconds) AS seconds FROM application_usage_logs
         WHERE employee_id = ? AND DATE(started_at) BETWEEN ? AND ? GROUP BY app_category`, [employeeId, start, end]),
            queryOne('SELECT score, status FROM weekly_performance_reports WHERE employee_id = ? AND week_start = ?', [employeeId, start]),
        ]);
        const assigned = number(tasks?.assigned);
        const completed = number(tasks?.completed);
        const onTime = number(tasks?.on_time);
        const approved = number(tasks?.approved);
        const withProject = number(tasks?.with_project);
        const presentDays = number(attendance?.present_days);
        const workDaysSetting = await queryOne("SELECT setting_value FROM system_settings WHERE setting_key = 'work_days'");
        const workDays = new Set(String(workDaysSetting?.setting_value ?? '1,2,3,4,5,6').split(',').map((value) => Number(value.trim())));
        const dayRows = await query(`SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d FROM (
         SELECT DATE(?) + INTERVAL seq DAY AS day FROM (
           SELECT 0 AS seq UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
           UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
         ) days
       ) calendar WHERE day BETWEEN ? AND ? AND day <= CURDATE()`, [start, start, end]);
        const elapsedWorkDays = dayRows.filter((row) => workDays.has(new Date(`${row.d}T00:00:00`).getDay())).length || 1;
        const submittedReports = reports.filter((row) => row.status !== 'draft').length;
        const taskCompletion = assigned > 0 ? percent(completed, assigned) : 70;
        const onTimeDelivery = completed > 0 ? percent(onTime, completed) : 70;
        const workQuality = completed > 0 ? percent(approved, completed) : 70;
        const attendanceScore = percent(Math.min(presentDays, elapsedWorkDays), elapsedWorkDays);
        const dailyReporting = percent(Math.min(submittedReports, elapsedWorkDays), elapsedWorkDays);
        const projectContribution = completed > 0 ? percent(withProject, completed) : 0;
        const collaboration = Math.min(100, 60 + Math.min(25, number(messages?.sent)) + Math.min(15, number(meetings?.attended) * 5));
        const metrics = {
            weights: KPI_WEIGHTS,
            taskCompletion,
            onTimeDelivery,
            workQuality,
            attendance: attendanceScore,
            dailyReporting,
            projectContribution,
            collaboration,
            assigned,
            completed,
            onTime,
            approved,
            presentDays,
            elapsedWorkDays,
            reportsSubmitted: submittedReports,
            meetingsAttended: number(meetings?.attended),
            messagesSent: number(messages?.sent),
            attendanceMinutes: number(attendance?.minutes),
            applicationUsage: apps.map((row) => ({ category: row.app_category, minutes: Math.round(number(row.seconds) / 60) })),
            applicationUsageNote: 'Application duration is contextual only and is not scored as productivity.',
        };
        const score = Math.round((taskCompletion * KPI_WEIGHTS.taskCompletion +
            onTimeDelivery * KPI_WEIGHTS.onTimeDelivery +
            workQuality * KPI_WEIGHTS.workQuality +
            attendanceScore * KPI_WEIGHTS.attendance +
            dailyReporting * KPI_WEIGHTS.dailyReporting +
            projectContribution * KPI_WEIGHTS.projectContribution +
            collaboration * KPI_WEIGHTS.collaboration) / 100 * 10) / 10;
        const previous = existing?.score === undefined ? null : number(existing.score);
        if (!existing || String(existing.status) !== 'final') {
            await execute(`INSERT INTO weekly_performance_reports (employee_id, week_start, week_end, metrics, score, grade, status, previous_score, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'preliminary', ?, NOW(3))
         ON DUPLICATE KEY UPDATE week_end = VALUES(week_end), metrics = VALUES(metrics), score = VALUES(score),
           grade = VALUES(grade), previous_score = VALUES(previous_score), generated_at = NOW(3)`, [employeeId, start, end, JSON.stringify(metrics), score, grade(score), previous]);
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
        const finalize = Boolean(input.finalize);
        await execute(`UPDATE weekly_performance_reports SET manager_remarks = COALESCE(?, manager_remarks),
              status = IF(?, 'final', status), reviewed_by = ?, reviewed_at = NOW(3) WHERE id = ?`, [cleanText(input.managerRemarks, 1000) || null, finalize ? 1 : 0, user.id, id]);
        await ActivityService.audit(user.id, finalize ? 'activity.weekly_finalized' : 'activity.weekly_reviewed', Number(row.employee_id), 'weekly_performance_report', id, { finalize });
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
        const rows = await query('SELECT * FROM weekly_performance_reports WHERE employee_id = ? ORDER BY week_start DESC LIMIT ?', [employeeId, Math.min(26, Math.max(1, limit))]);
        return rows.map((row) => ActivityAnalyticsService.mapWeekly(row));
    }
    static async selfDashboard(user, date) {
        const consent = await ActivityService.consentStatus(user);
        const session = await ActivityService.currentSession(user);
        const [daily, errors, tickets, weekly, devices, browser, recentSessions] = await Promise.all([
            ActivityAnalyticsService.daily(user, user.id, date),
            ActivityService.listErrors(user),
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
            errors: errors.filter((error) => error.employeeName === user.fullName).slice(0, 8),
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
                s.id AS session_id, s.started_at AS session_started_at, s.last_heartbeat_at
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations dg ON dg.id = e.designation_id
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
        const appMap = new Map(appTotals.map((row) => [Number(row.employee_id), Math.round(number(row.seconds) / 60)]));
        const taskMap = new Map(taskTotals.map((row) => [Number(row.employee_id), number(row.completed)]));
        const summaryMap = new Map(summaries.map((row) => [Number(row.employee_id), row]));
        const weekMap = new Map(weeks.map((row) => [Number(row.employee_id), row]));
        const rows = employees.map((employee) => {
            const summary = summaryMap.get(Number(employee.id));
            const week = weekMap.get(Number(employee.id));
            return {
                id: Number(employee.id),
                name: employee.full_name,
                employeeCode: employee.employee_code,
                photoUrl: employee.photo_url,
                department: employee.department_name,
                designation: employee.designation_title,
                active: Boolean(employee.session_id),
                sessionStartedAt: employee.session_started_at,
                lastHeartbeatAt: employee.last_heartbeat_at,
                activeMinutes: appMap.get(Number(employee.id)) ?? 0,
                tasksCompleted: taskMap.get(Number(employee.id)) ?? 0,
                dailyStatus: summary?.status ?? null,
                keyActivities: parseJson(summary?.key_activities, []),
                weeklyScore: week ? number(week.score) : null,
                weeklyGrade: week?.grade ?? null,
                needsAssistance: Boolean(summary && summary.status === 'submitted' && (week ? number(week.score) < 60 : false)),
            };
        });
        return {
            scope: visible ? 'team' : 'all',
            date,
            employees: rows,
            totals: {
                employees: rows.length,
                activeNow: rows.filter((row) => row.active).length,
                activeMinutes: rows.reduce((sum, row) => sum + row.activeMinutes, 0),
                tasksCompleted: rows.reduce((sum, row) => sum + row.tasksCompleted, 0),
                pendingReviews: rows.filter((row) => row.dailyStatus === 'submitted').length,
            },
        };
    }
    static async adminOverview(user, date) {
        const [counts, departments, appTotals, incidents, devices, health, weekly, sessions] = await Promise.all([
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
        ]);
        return {
            scope: 'all',
            date,
            totals: {
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
        const daily = await ActivityAnalyticsService.generateDaily(employeeId, date);
        const weekly = await ActivityAnalyticsService.weeklyList(user, employeeId, 6);
        return { daily, weekly };
    }
}
//# sourceMappingURL=ActivityAnalyticsService.js.map