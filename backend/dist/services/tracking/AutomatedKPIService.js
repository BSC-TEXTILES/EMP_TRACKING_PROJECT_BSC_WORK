import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { execute, query, queryOne } from '../../db/index.js';
import { ApiError } from '../../lib/http.js';
import { addDays } from '../../lib/dates.js';
import { allowedLocationIds } from '../../lib/scope.js';
const TZ = 'Asia/Kolkata';
/** Format Date string YYYY-MM-DD to DD-MM-YYYY */
export function formatDmy(dateStr) {
    if (!dateStr)
        return '—';
    const trimmed = dateStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const [y, m, d] = trimmed.split('-');
        return `${d}-${m}-${y}`;
    }
    const dt = new Date(trimmed);
    if (Number.isNaN(dt.getTime()))
        return '—';
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(dt).replace(/\//g, '-');
}
/** Format Date/Time to 12-hour hh:mm AM/PM */
export function format12Hour(value) {
    if (!value)
        return '—';
    if (typeof value === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(value.trim())) {
        const [hStr, mStr] = value.trim().split(':');
        let h = parseInt(hStr, 10);
        const m = mStr;
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
    }
    const dt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dt.getTime()))
        return '—';
    return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }).format(dt);
}
/** Format duration in seconds to "X Hours Y Minutes" or "Xh Ym" */
export function formatDurationText(seconds) {
    const s = Math.max(0, Math.round(seconds ?? 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h === 0)
        return `${m} Minute${m !== 1 ? 's' : ''}`;
    return `${h} Hour${h !== 1 ? 's' : ''} ${m} Minute${m !== 1 ? 's' : ''}`;
}
export function formatDurationShort(seconds) {
    const s = Math.max(0, Math.round(seconds ?? 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
}
export class AutomatedKPIService {
    /**
     * Generates or calculates the official Daily KPI Report for an employee on a given calendar date.
     */
    static async getDailyKPI(employeeId, targetDateIso) {
        const emp = await queryOne(`SELECT e.id, e.full_name, e.employee_code,
              d.name AS department_name, dg.title AS designation_title,
              l.name AS location_name, l.code AS location_code
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`, [employeeId]);
        if (!emp)
            throw ApiError.notFound('Employee not found.');
        // 1. Attendance & Punch In/Out
        const att = await queryOne('SELECT id, check_in_at, check_out_at, status, total_minutes, break_minutes FROM attendance WHERE employee_id = ? AND work_date = ? LIMIT 1', [employeeId, targetDateIso]);
        // 2. Web & Desktop Sessions
        const sessions = await query(`SELECT id, started_at, ended_at, last_seen_at
       FROM tracking_sessions
       WHERE employee_id = ? AND work_date = ?
       ORDER BY started_at ASC`, [employeeId, targetDateIso]);
        // Also check employee_sessions for web portal login/logout
        const webSessions = await query(`SELECT created_at, last_seen_at, revoked_at, duration_minutes
       FROM employee_sessions
       WHERE employee_id = ? AND DATE(CONVERT_TZ(created_at, '+00:00', '+05:30')) = ?
       ORDER BY created_at ASC`, [employeeId, targetDateIso]);
        // Compute first login and last logout
        let firstLoginUtc = att?.check_in_at ?? null;
        let lastLogoutUtc = att?.check_out_at ?? null;
        for (const s of sessions) {
            if (!firstLoginUtc || new Date(s.started_at) < new Date(firstLoginUtc))
                firstLoginUtc = s.started_at;
            const endCandidate = s.ended_at || s.last_seen_at;
            if (endCandidate && (!lastLogoutUtc || new Date(endCandidate) > new Date(lastLogoutUtc)))
                lastLogoutUtc = endCandidate;
        }
        for (const ws of webSessions) {
            if (!firstLoginUtc || new Date(ws.created_at) < new Date(firstLoginUtc))
                firstLoginUtc = ws.created_at;
            const endCandidate = ws.revoked_at || ws.last_seen_at;
            if (endCandidate && (!lastLogoutUtc || new Date(endCandidate) > new Date(lastLogoutUtc)))
                lastLogoutUtc = endCandidate;
        }
        // 3. Activity Intervals from tracking_events
        const eventStats = await query(`SELECT state, event_type, SUM(duration_seconds) AS total_duration
       FROM tracking_events
       WHERE employee_id = ? AND work_date = ?
       GROUP BY state, event_type`, [employeeId, targetDateIso]);
        let activeSec = 0;
        let idleSec = 0;
        let lockedSec = 0;
        for (const row of eventStats) {
            const dur = Number(row.total_duration || 0);
            if (row.state === 'active')
                activeSec += dur;
            else if (row.state === 'idle')
                idleSec += dur;
            else if (row.state === 'locked')
                lockedSec += dur;
        }
        // Breaks from attendance or employee_breaks
        let breakSec = (att?.break_minutes ? att.break_minutes * 60 : 0);
        const breakRows = await query('SELECT duration_seconds FROM employee_breaks WHERE employee_id = ? AND work_date = ?', [employeeId, targetDateIso]);
        for (const br of breakRows) {
            breakSec = Math.max(breakSec, Number(br.duration_seconds || 0));
        }
        // Session duration
        let totalSessionSec = 0;
        if (firstLoginUtc && lastLogoutUtc) {
            totalSessionSec = Math.max(0, Math.round((new Date(lastLogoutUtc).getTime() - new Date(firstLoginUtc).getTime()) / 1000));
        }
        // Reconcile if session is open or longer
        totalSessionSec = Math.max(totalSessionSec, activeSec + idleSec + breakSec + lockedSec);
        // 4. Applications usage
        const appRows = await query(`SELECT COALESCE(app_name, 'Other') AS app_name, SUM(duration_seconds) AS total_sec
       FROM tracking_events
       WHERE employee_id = ? AND work_date = ? AND app_name IS NOT NULL AND state = 'active'
       GROUP BY app_name
       ORDER BY total_sec DESC
       LIMIT 10`, [employeeId, targetDateIso]);
        const applications = appRows.map((r) => {
            const sec = Number(r.total_sec || 0);
            return {
                app: r.app_name,
                seconds: sec,
                durationText: formatDurationText(sec),
                percentage: activeSec > 0 ? Math.round((sec / activeSec) * 100) : 0,
            };
        });
        // 5. Chrome Tabs & Website domains
        const tabRows = await query(`SELECT domain, window_title, SUM(duration_seconds) AS total_sec, COUNT(*) AS switches
       FROM tracking_events
       WHERE employee_id = ? AND work_date = ? AND domain IS NOT NULL
       GROUP BY domain, window_title
       ORDER BY total_sec DESC
       LIMIT 15`, [employeeId, targetDateIso]);
        const chromeTabs = tabRows.map((t) => {
            const sec = Number(t.total_sec || 0);
            return {
                domain: t.domain,
                title: t.window_title,
                seconds: sec,
                durationText: formatDurationText(sec),
                switches: Number(t.switches || 1),
            };
        });
        // Group domains
        const domainMap = new Map();
        for (const t of tabRows) {
            domainMap.set(t.domain, (domainMap.get(t.domain) ?? 0) + Number(t.total_sec || 0));
        }
        const websites = Array.from(domainMap.entries())
            .map(([domain, sec]) => ({
            domain,
            seconds: sec,
            durationText: formatDurationText(sec),
            percentage: activeSec > 0 ? Math.round((sec / activeSec) * 100) : 0,
        }))
            .sort((a, b) => b.seconds - a.seconds);
        // 6. Leave and Week-Off
        const leaveRow = await queryOne(`SELECT lt.name AS leave_name, lt.code
       FROM leave_requests lr
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.employee_id = ? AND lr.status = 'approved' AND ? BETWEEN lr.start_date AND lr.end_date
       LIMIT 1`, [employeeId, targetDateIso]);
        // 7. Monitoring Status
        const deviceRow = await queryOne('SELECT id, last_heartbeat_at FROM employee_devices WHERE employee_id = ? AND status = "active" ORDER BY last_seen_at DESC LIMIT 1', [employeeId]);
        let monitoringStatus = 'not_installed';
        if (deviceRow) {
            const diffMs = deviceRow.last_heartbeat_at ? Date.now() - new Date(deviceRow.last_heartbeat_at).getTime() : Infinity;
            monitoringStatus = diffMs <= 180_000 ? 'connected' : 'disconnected';
        }
        // 8. Transparent Daily KPI Score Calculation (0 - 100)
        // Rule:
        // a. Working hours (35 pts): 8 hours = 28800s. Ratio capped at 35.
        const workingScore = Math.min(35, Math.round(((activeSec + idleSec) / 28800) * 35));
        // b. Active Time Ratio (30 pts): Active vs (Active + Idle).
        const activeRatio = (activeSec + idleSec) > 0 ? activeSec / (activeSec + idleSec) : 0;
        const activeScore = Math.round(activeRatio * 30);
        // c. Idle Discipline (20 pts): Under 15% idle = 20 pts.
        const idlePct = (activeSec + idleSec) > 0 ? (idleSec / (activeSec + idleSec)) * 100 : 0;
        const idleDisciplineScore = idlePct <= 15 ? 20 : Math.max(0, Math.round(20 - ((idlePct - 15) / 85) * 20));
        // d. Attendance status (15 pts): Present/Half-day
        const attendanceScore = att?.status === 'present' ? 15 : att?.status === 'late' ? 12 : att?.status === 'half_day' ? 8 : 0;
        const totalKpiScore = Math.min(100, workingScore + activeScore + idleDisciplineScore + attendanceScore);
        const calculationRules = {
            workingHoursScore: workingScore,
            activeTimeScore: activeScore,
            idleDisciplineScore,
            attendanceScore,
            taskScore: 0,
            total: totalKpiScore,
            basis: '35% Shift duration + 30% Active time proportion + 20% Idle discipline (<15% target) + 15% Attendance & punctuality',
        };
        // 9. Persist into employee_daily_kpis
        await execute(`INSERT INTO employee_daily_kpis (
        employee_id, report_date, first_login_at, last_logout_at, total_session_seconds,
        active_working_seconds, idle_seconds, break_seconds, locked_seconds, attendance_status,
        leave_type_code, kpi_score, application_summary, browser_tab_summary, domain_summary,
        calculation_rules
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        first_login_at = VALUES(first_login_at),
        last_logout_at = VALUES(last_logout_at),
        total_session_seconds = VALUES(total_session_seconds),
        active_working_seconds = VALUES(active_working_seconds),
        idle_seconds = VALUES(idle_seconds),
        break_seconds = VALUES(break_seconds),
        locked_seconds = VALUES(locked_seconds),
        attendance_status = VALUES(attendance_status),
        leave_type_code = VALUES(leave_type_code),
        kpi_score = VALUES(kpi_score),
        application_summary = VALUES(application_summary),
        browser_tab_summary = VALUES(browser_tab_summary),
        domain_summary = VALUES(domain_summary),
        calculation_rules = VALUES(calculation_rules)`, [
            employeeId,
            targetDateIso,
            firstLoginUtc ? new Date(firstLoginUtc) : null,
            lastLogoutUtc ? new Date(lastLogoutUtc) : null,
            totalSessionSec,
            activeSec,
            idleSec,
            breakSec,
            lockedSec,
            att?.status ?? (leaveRow ? 'on_leave' : 'absent'),
            leaveRow?.code ?? null,
            totalKpiScore,
            JSON.stringify(applications),
            JSON.stringify(chromeTabs),
            JSON.stringify(websites),
            JSON.stringify(calculationRules),
        ]);
        return {
            employeeId,
            employeeCode: emp.employee_code,
            fullName: emp.full_name,
            department: emp.department_name ?? 'Operations',
            designation: emp.designation_title ?? 'Employee',
            location: emp.location_name ?? 'Head Office',
            reportDate: formatDmy(targetDateIso),
            reportDateIso: targetDateIso,
            firstLoginTime: format12Hour(firstLoginUtc),
            lastLogoutTime: format12Hour(lastLogoutUtc),
            totalSessionDuration: formatDurationText(totalSessionSec),
            totalSessionSeconds: totalSessionSec,
            activeWorkingHours: formatDurationText(activeSec),
            activeWorkingSeconds: activeSec,
            idleHours: formatDurationText(idleSec),
            idleSeconds: idleSec,
            breakHours: formatDurationText(breakSec),
            breakSeconds: breakSec,
            lockedHours: formatDurationText(lockedSec),
            lockedSeconds: lockedSec,
            attendanceStatus: att?.status ?? (leaveRow ? 'On Leave' : 'Absent'),
            leaveInfo: leaveRow ? `${leaveRow.leave_name} (${leaveRow.code})` : null,
            weekOffInfo: null,
            monitoringStatus,
            applications,
            chromeTabs,
            websites,
            kpiScore: totalKpiScore,
            calculationRules,
        };
    }
    /**
     * Generates or calculates the Weekly KPI Report for an employee.
     */
    static async getWeeklyKPI(employeeId, weekStartIso) {
        const weekEndIso = addDays(weekStartIso, 6);
        const emp = await queryOne(`SELECT e.id, e.full_name, e.employee_code,
              d.name AS department_name, dg.title AS designation_title,
              l.name AS location_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`, [employeeId]);
        if (!emp)
            throw ApiError.notFound('Employee not found.');
        const dailyResults = [];
        const idleDays = [];
        let totalWorkingSec = 0;
        let totalIdleSec = 0;
        let totalBreakSec = 0;
        let attendedDaysCount = 0;
        let absentDaysCount = 0;
        let leaveDaysCount = 0;
        let weekOffDaysCount = 0;
        let incompleteSessionsCount = 0;
        for (let offset = 0; offset < 7; offset += 1) {
            const curDateIso = addDays(weekStartIso, offset);
            const day = await AutomatedKPIService.getDailyKPI(employeeId, curDateIso);
            dailyResults.push(day);
            totalWorkingSec += day.activeWorkingSeconds;
            totalIdleSec += day.idleSeconds;
            totalBreakSec += day.breakSeconds;
            if (day.idleSeconds > 0) {
                idleDays.push({
                    date: curDateIso,
                    dateDmy: formatDmy(curDateIso),
                    idleSeconds: day.idleSeconds,
                    idleDurationText: formatDurationText(day.idleSeconds),
                });
            }
            if (day.attendanceStatus === 'present' || day.attendanceStatus === 'late' || day.attendanceStatus === 'half_day') {
                attendedDaysCount += 1;
            }
            else if (day.leaveInfo) {
                leaveDaysCount += 1;
            }
            else {
                absentDaysCount += 1;
            }
            // Check if session had login but no logout recorded
            if (day.firstLoginTime !== '—' && day.lastLogoutTime === '—') {
                incompleteSessionsCount += 1;
            }
        }
        const scheduledWorkingDays = 6;
        const attendancePct = Math.round((attendedDaysCount / scheduledWorkingDays) * 100);
        const avgWorkingDaily = attendedDaysCount > 0 ? Math.round(totalWorkingSec / attendedDaysCount) : 0;
        const avgIdleDaily = attendedDaysCount > 0 ? Math.round(totalIdleSec / attendedDaysCount) : 0;
        const avgDailyScore = dailyResults.reduce((acc, d) => acc + d.kpiScore, 0) / 7;
        const weeklyKpiScore = Math.round(avgDailyScore);
        // Aggregate applications
        const appMap = new Map();
        for (const d of dailyResults) {
            for (const a of d.applications) {
                appMap.set(a.app, (appMap.get(a.app) ?? 0) + a.seconds);
            }
        }
        const topApplications = Array.from(appMap.entries())
            .map(([app, sec]) => ({ app, seconds: sec, durationText: formatDurationText(sec) }))
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 8);
        const dailyBreakdown = dailyResults.map((d) => ({
            date: d.reportDateIso,
            dateDmy: d.reportDate,
            status: d.attendanceStatus,
            workingHours: d.activeWorkingHours,
            idleHours: d.idleHours,
            score: d.kpiScore,
        }));
        // Persist to employee_weekly_kpis
        await execute(`INSERT INTO employee_weekly_kpis (
        employee_id, week_start, week_end, scheduled_days, attended_days, absent_days,
        leave_days, weekoff_days, total_working_seconds, total_idle_seconds, total_break_seconds,
        avg_daily_working_seconds, avg_daily_idle_seconds, attendance_pct, weekly_kpi_score,
        app_usage_summary, daily_breakdown
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        scheduled_days = VALUES(scheduled_days),
        attended_days = VALUES(attended_days),
        absent_days = VALUES(absent_days),
        leave_days = VALUES(leave_days),
        weekoff_days = VALUES(weekoff_days),
        total_working_seconds = VALUES(total_working_seconds),
        total_idle_seconds = VALUES(total_idle_seconds),
        total_break_seconds = VALUES(total_break_seconds),
        avg_daily_working_seconds = VALUES(avg_daily_working_seconds),
        avg_daily_idle_seconds = VALUES(avg_daily_idle_seconds),
        attendance_pct = VALUES(attendance_pct),
        weekly_kpi_score = VALUES(weekly_kpi_score),
        app_usage_summary = VALUES(app_usage_summary),
        daily_breakdown = VALUES(daily_breakdown)`, [
            employeeId,
            weekStartIso,
            weekEndIso,
            scheduledWorkingDays,
            attendedDaysCount,
            absentDaysCount,
            leaveDaysCount,
            weekOffDaysCount,
            totalWorkingSec,
            totalIdleSec,
            totalBreakSec,
            avgWorkingDaily,
            avgIdleDaily,
            attendancePct,
            weeklyKpiScore,
            JSON.stringify(topApplications),
            JSON.stringify(dailyBreakdown),
        ]);
        return {
            employeeId,
            employeeCode: emp.employee_code,
            fullName: emp.full_name,
            department: emp.department_name ?? 'Operations',
            designation: emp.designation_title ?? 'Employee',
            location: emp.location_name ?? 'Head Office',
            weekStart: formatDmy(weekStartIso),
            weekEnd: formatDmy(weekEndIso),
            weekStartIso,
            weekEndIso,
            scheduledWorkingDays,
            daysAttended: attendedDaysCount,
            absentDays: absentDaysCount,
            approvedLeaveDays: leaveDaysCount,
            weekOffDays: weekOffDaysCount,
            totalWorkingHours: formatDurationText(totalWorkingSec),
            totalWorkingSeconds: totalWorkingSec,
            totalIdleHours: formatDurationText(totalIdleSec),
            totalIdleSeconds: totalIdleSec,
            totalBreakHours: formatDurationText(totalBreakSec),
            totalBreakSeconds: totalBreakSec,
            avgDailyWorkingHours: formatDurationText(avgWorkingDaily),
            avgDailyIdleHours: formatDurationText(avgIdleDaily),
            attendancePercentage: attendancePct,
            weeklyKpiScore,
            incompleteSessionsCount,
            idleDays,
            topApplications,
            dailyBreakdown,
        };
    }
    /**
     * Generates or calculates the Monthly KPI Report for an employee.
     */
    static async getMonthlyKPI(employeeId, period) {
        const [yearStr, monthStr] = period.split('-');
        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10);
        const emp = await queryOne(`SELECT e.id, e.full_name, e.employee_code,
              d.name AS department_name, dg.title AS designation_title,
              l.name AS location_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`, [employeeId]);
        if (!emp)
            throw ApiError.notFound('Employee not found.');
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const startDate = `${period}-01`;
        const endDate = `${period}-${String(daysInMonth).padStart(2, '0')}`;
        // Get all attendance days in month
        const attList = await query(`SELECT work_date, status, check_in_at, check_out_at, total_minutes, break_minutes
       FROM attendance
       WHERE employee_id = ? AND work_date BETWEEN ? AND ?
       ORDER BY work_date ASC`, [employeeId, startDate, endDate]);
        const attMap = new Map();
        for (const a of attList)
            attMap.set(String(a.work_date).slice(0, 10), a);
        // Get all events in month
        const eventStats = await query(`SELECT work_date, state, SUM(duration_seconds) AS total_duration
       FROM tracking_events
       WHERE employee_id = ? AND work_date BETWEEN ? AND ?
       GROUP BY work_date, state`, [employeeId, startDate, endDate]);
        const dayEventMap = new Map();
        for (const ev of eventStats) {
            const d = String(ev.work_date).slice(0, 10);
            const curr = dayEventMap.get(d) ?? { active: 0, idle: 0, locked: 0 };
            const dur = Number(ev.total_duration || 0);
            if (ev.state === 'active')
                curr.active += dur;
            else if (ev.state === 'idle')
                curr.idle += dur;
            else if (ev.state === 'locked')
                curr.locked += dur;
            dayEventMap.set(d, curr);
        }
        let attendanceDays = 0;
        let absentDays = 0;
        let approvedLeaveDays = 0;
        let weekOffDays = 0;
        let holidayDays = 0;
        let totalWorkingSec = 0;
        let totalActiveSec = 0;
        let totalIdleSec = 0;
        let totalBreakSec = 0;
        let totalSessionSec = 0;
        let highestIdleSec = 0;
        let highestIdleDate = null;
        const dailyLog = [];
        for (let day = 1; day <= daysInMonth; day += 1) {
            const curDateIso = `${period}-${String(day).padStart(2, '0')}`;
            const attRow = attMap.get(curDateIso);
            const evRow = dayEventMap.get(curDateIso) ?? { active: 0, idle: 0, locked: 0 };
            totalActiveSec += evRow.active;
            totalIdleSec += evRow.idle;
            if (evRow.idle > highestIdleSec) {
                highestIdleSec = evRow.idle;
                highestIdleDate = curDateIso;
            }
            const brSec = attRow?.break_minutes ? attRow.break_minutes * 60 : 0;
            totalBreakSec += brSec;
            let loginTimeStr = '—';
            let logoutTimeStr = '—';
            if (attRow?.check_in_at)
                loginTimeStr = format12Hour(attRow.check_in_at);
            if (attRow?.check_out_at)
                logoutTimeStr = format12Hour(attRow.check_out_at);
            const dayWorkSec = evRow.active + (attRow?.total_minutes ? attRow.total_minutes * 60 : 0);
            totalWorkingSec += dayWorkSec;
            if (attRow?.status === 'present' || attRow?.status === 'late' || attRow?.status === 'half_day') {
                attendanceDays += 1;
            }
            else if (attRow?.status === 'weekly_off') {
                weekOffDays += 1;
            }
            else if (attRow?.status === 'holiday') {
                holidayDays += 1;
            }
            else if (attRow?.status === 'on_leave') {
                approvedLeaveDays += 1;
            }
            else {
                absentDays += 1;
            }
            dailyLog.push({
                date: curDateIso,
                dateDmy: formatDmy(curDateIso),
                loginTime: loginTimeStr,
                logoutTime: logoutTimeStr,
                status: attRow?.status ?? 'absent',
                workingHours: formatDurationText(dayWorkSec),
            });
        }
        totalSessionSec = totalWorkingSec + totalIdleSec + totalBreakSec;
        const scheduledDays = Math.max(1, daysInMonth - weekOffDays - holidayDays);
        const attendancePercentage = Math.round((attendanceDays / scheduledDays) * 100);
        const avgWorkingPerDay = attendanceDays > 0 ? Number(((totalWorkingSec / 3600) / attendanceDays).toFixed(2)) : 0;
        const avgIdlePerDay = attendanceDays > 0 ? Number(((totalIdleSec / 3600) / attendanceDays).toFixed(2)) : 0;
        const idlePercentage = (totalActiveSec + totalIdleSec) > 0 ? Number(((totalIdleSec / (totalActiveSec + totalIdleSec)) * 100).toFixed(1)) : 0;
        // Applications in month
        const appStats = await query(`SELECT COALESCE(app_name, 'Other') AS app_name, SUM(duration_seconds) AS total_sec
       FROM tracking_events
       WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND app_name IS NOT NULL AND state = 'active'
       GROUP BY app_name ORDER BY total_sec DESC LIMIT 10`, [employeeId, startDate, endDate]);
        const topApplications = appStats.map((a) => {
            const sec = Number(a.total_sec || 0);
            return {
                app: a.app_name,
                seconds: sec,
                durationText: formatDurationText(sec),
                percentage: totalActiveSec > 0 ? Math.round((sec / totalActiveSec) * 100) : 0,
            };
        });
        // Domains in month
        const domainStats = await query(`SELECT domain, SUM(duration_seconds) AS total_sec
       FROM tracking_events
       WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND domain IS NOT NULL
       GROUP BY domain ORDER BY total_sec DESC LIMIT 10`, [employeeId, startDate, endDate]);
        let chromeUsageSec = 0;
        const domains = domainStats.map((d) => {
            const sec = Number(d.total_sec || 0);
            chromeUsageSec += sec;
            return {
                domain: d.domain,
                seconds: sec,
                durationText: formatDurationText(sec),
                percentage: totalActiveSec > 0 ? Math.round((sec / totalActiveSec) * 100) : 0,
            };
        });
        // KPI Summary
        const attendanceKpi = Math.min(100, attendancePercentage);
        const workingHoursKpi = Math.min(100, Math.round((avgWorkingPerDay / 8) * 100));
        const activeTimeKpi = (totalActiveSec + totalIdleSec) > 0 ? Math.round((totalActiveSec / (totalActiveSec + totalIdleSec)) * 100) : 0;
        const idleTimeKpi = idlePercentage <= 15 ? 100 : Math.max(0, Math.round(100 - ((idlePercentage - 15) / 85) * 100));
        const taskCompletionKpi = 85; // baseline task completion
        const overallKpiScore = Math.round(attendanceKpi * 0.25 + workingHoursKpi * 0.25 + activeTimeKpi * 0.2 + idleTimeKpi * 0.15 + taskCompletionKpi * 0.15);
        // Compare with previous month
        const prevMonthDate = new Date(Date.UTC(year, month - 2, 1));
        const prevPeriod = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
        const prevRecord = await queryOne('SELECT overall_kpi_score FROM employee_monthly_kpis WHERE employee_id = ? AND period = ?', [employeeId, prevPeriod]);
        const prevScore = prevRecord ? Number(prevRecord.overall_kpi_score) : null;
        const scoreDiff = prevScore !== null ? Number((overallKpiScore - prevScore).toFixed(1)) : null;
        const grade = overallKpiScore >= 90 ? 'A+ (Outstanding)' :
            overallKpiScore >= 80 ? 'A (Excellent)' :
                overallKpiScore >= 70 ? 'B (Good)' :
                    overallKpiScore >= 60 ? 'C (Satisfactory)' : 'D (Needs Improvement)';
        // Persist to employee_monthly_kpis
        await execute(`INSERT INTO employee_monthly_kpis (
        employee_id, period, year, month, total_attendance_days, total_absent_days,
        approved_leave_days, week_off_days, holiday_days, attendance_pct, total_session_seconds,
        total_working_seconds, total_active_seconds, total_idle_seconds, total_break_seconds,
        avg_working_hours_per_day, avg_idle_hours_per_day, highest_idle_day, highest_idle_seconds,
        idle_pct, attendance_kpi, working_hours_kpi, active_time_kpi, idle_time_kpi,
        task_completion_kpi, overall_kpi_score, previous_month_score, app_usage_json,
        domain_usage_json, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        total_attendance_days = VALUES(total_attendance_days),
        total_absent_days = VALUES(total_absent_days),
        approved_leave_days = VALUES(approved_leave_days),
        week_off_days = VALUES(week_off_days),
        holiday_days = VALUES(holiday_days),
        attendance_pct = VALUES(attendance_pct),
        total_session_seconds = VALUES(total_session_seconds),
        total_working_seconds = VALUES(total_working_seconds),
        total_active_seconds = VALUES(total_active_seconds),
        total_idle_seconds = VALUES(total_idle_seconds),
        total_break_seconds = VALUES(total_break_seconds),
        avg_working_hours_per_day = VALUES(avg_working_hours_per_day),
        avg_idle_hours_per_day = VALUES(avg_idle_hours_per_day),
        highest_idle_day = VALUES(highest_idle_day),
        highest_idle_seconds = VALUES(highest_idle_seconds),
        idle_pct = VALUES(idle_pct),
        attendance_kpi = VALUES(attendance_kpi),
        working_hours_kpi = VALUES(working_hours_kpi),
        active_time_kpi = VALUES(active_time_kpi),
        idle_time_kpi = VALUES(idle_time_kpi),
        task_completion_kpi = VALUES(task_completion_kpi),
        overall_kpi_score = VALUES(overall_kpi_score),
        previous_month_score = VALUES(previous_month_score),
        app_usage_json = VALUES(app_usage_json),
        domain_usage_json = VALUES(domain_usage_json),
        metrics_json = VALUES(metrics_json)`, [
            employeeId,
            period,
            year,
            month,
            attendanceDays,
            absentDays,
            approvedLeaveDays,
            weekOffDays,
            holidayDays,
            attendancePercentage,
            totalSessionSec,
            totalWorkingSec,
            totalActiveSec,
            totalIdleSec,
            totalBreakSec,
            avgWorkingPerDay,
            avgIdlePerDay,
            highestIdleDate,
            highestIdleSec,
            idlePercentage,
            attendanceKpi,
            workingHoursKpi,
            activeTimeKpi,
            idleTimeKpi,
            taskCompletionKpi,
            overallKpiScore,
            prevScore,
            JSON.stringify(topApplications),
            JSON.stringify(domains),
            JSON.stringify({ grade, scoreDiff }),
        ]);
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return {
            employeeId,
            employeeCode: emp.employee_code,
            fullName: emp.full_name,
            department: emp.department_name ?? 'Operations',
            designation: emp.designation_title ?? 'Employee',
            location: emp.location_name ?? 'Head Office',
            period,
            periodLabel: `${monthNames[month - 1]} ${year}`,
            attendance: {
                totalScheduledDays: scheduledDays,
                attendanceDays,
                absentDays,
                approvedLeaveDays,
                weekOffDays,
                holidays: holidayDays,
                attendancePercentage,
                dailyLog,
            },
            workingHours: {
                totalWorkingSeconds: totalWorkingSec,
                totalWorkingHours: formatDurationText(totalWorkingSec),
                totalActiveSeconds: totalActiveSec,
                totalActiveHours: formatDurationText(totalActiveSec),
                totalSessionSeconds: totalSessionSec,
                totalSessionDuration: formatDurationText(totalSessionSec),
                avgWorkingHoursPerDay: avgWorkingPerDay,
                weeklyBreakdown: [],
            },
            idleTime: {
                totalIdleSeconds: totalIdleSec,
                totalIdleHours: formatDurationText(totalIdleSec),
                avgDailyIdleHours: avgIdlePerDay,
                highestIdleDay: highestIdleDate ? { date: highestIdleDate, dateDmy: formatDmy(highestIdleDate), idleHours: formatDurationText(highestIdleSec) } : null,
                idlePercentage,
            },
            applicationAndBrowserUsage: {
                topApplications,
                chromeUsageSeconds: chromeUsageSec,
                chromeUsageDuration: formatDurationText(chromeUsageSec),
                chromeTabs: [],
                domains,
                totalAppSwitches: 0,
            },
            kpiSummary: {
                attendanceKpi,
                workingHoursKpi,
                activeTimeKpi,
                idleTimeKpi,
                taskCompletionKpi,
                overallKpiScore,
                previousMonthScore: prevScore,
                scoreDiff,
                grade,
            },
        };
    }
    /**
     * Generates a PDF Monthly KPI Report for an individual employee or consolidated.
     */
    static async exportMonthlyPdf(data) {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);
            // Header
            doc.fontSize(18).fillColor('#0f766e').text('BSC TEXTILES PVT LTD', { align: 'center' });
            doc.fontSize(12).fillColor('#334155').text('EMPLOYEE MONTHLY KPI & PERFORMANCE REPORT', { align: 'center' });
            doc.fontSize(10).fillColor('#64748b').text(`Reporting Period: ${data.periodLabel} (Asia/Kolkata)`, { align: 'center' });
            doc.moveDown(1);
            // Employee Information Box
            doc.roundedRect(40, doc.y, 515, 65, 4).fillAndStroke('#f8fafc', '#cbd5e1');
            const startY = doc.y + 8;
            doc.fillColor('#0f172a').fontSize(9);
            doc.text(`Employee Name: ${data.fullName}`, 50, startY);
            doc.text(`Employee Code: ${data.employeeCode}`, 50, startY + 16);
            doc.text(`Department: ${data.department}`, 50, startY + 32);
            doc.text(`Designation: ${data.designation}`, 300, startY);
            doc.text(`Store / Location: ${data.location}`, 300, startY + 16);
            doc.text(`Report Period: ${data.period}`, 300, startY + 32);
            doc.y = startY + 58;
            doc.moveDown(1);
            // KPI Score Summary Box
            doc.roundedRect(40, doc.y, 515, 55, 4).fillAndStroke('#f0fdf4', '#86efac');
            const kpiY = doc.y + 10;
            doc.fillColor('#166534').fontSize(11).font('Helvetica-Bold');
            doc.text(`Monthly KPI Score: ${data.kpiSummary.overallKpiScore} / 100  ·  ${data.kpiSummary.grade}`, 50, kpiY);
            doc.fontSize(9).font('Helvetica').fillColor('#14532d');
            doc.text(`Attendance: ${data.kpiSummary.attendanceKpi}%  |  Work Hours: ${data.kpiSummary.workingHoursKpi}%  |  Active Ratio: ${data.kpiSummary.activeTimeKpi}%  |  Idle Discipline: ${data.kpiSummary.idleTimeKpi}%`, 50, kpiY + 20);
            doc.y = kpiY + 45;
            doc.moveDown(1);
            // Section: Attendance Summary
            doc.fillColor('#0f766e').fontSize(11).font('Helvetica-Bold').text('1. Attendance & Working Hours Summary');
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
            doc.text(`Total Scheduled Days: ${data.attendance.totalScheduledDays}    |    Attended: ${data.attendance.attendanceDays} days (${data.attendance.attendancePercentage}%)`);
            doc.text(`Approved Leave: ${data.attendance.approvedLeaveDays} days    |    Weekly Offs: ${data.attendance.weekOffDays} days    |    Holidays: ${data.attendance.holidays} days`);
            doc.text(`Total Working Duration: ${data.workingHours.totalWorkingHours}    |    Average Working Hours/Day: ${data.workingHours.avgWorkingHoursPerDay} hrs`);
            doc.text(`Total Idle Duration: ${data.idleTime.totalIdleHours} (${data.idleTime.idlePercentage}%)    |    Highest Idle Date: ${data.idleTime.highestIdleDay ? `${data.idleTime.highestIdleDay.dateDmy} (${data.idleTime.highestIdleDay.idleHours})` : 'None'}`);
            doc.moveDown(1);
            // Section: Top Applications
            doc.fillColor('#0f766e').fontSize(11).font('Helvetica-Bold').text('2. Application & Browser Usage');
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
            if (data.applicationAndBrowserUsage.topApplications.length > 0) {
                for (const app of data.applicationAndBrowserUsage.topApplications.slice(0, 5)) {
                    doc.text(`• ${app.app}: ${app.durationText} (${app.percentage}%)`);
                }
            }
            else {
                doc.text('No desktop application records logged.');
            }
            doc.moveDown(0.5);
            // Top Domains
            if (data.applicationAndBrowserUsage.domains.length > 0) {
                doc.font('Helvetica-Bold').fontSize(9).text('Top Browser Websites / Domains:');
                doc.font('Helvetica');
                for (const dom of data.applicationAndBrowserUsage.domains.slice(0, 5)) {
                    doc.text(`• ${dom.domain}: ${dom.durationText} (${dom.percentage}%)`);
                }
            }
            doc.moveDown(1);
            // Footer
            doc.fontSize(8).fillColor('#94a3b8').text('Generated automatically by BSC Textiles Enterprise HRMS Tracking System · Confidential', { align: 'center' });
            doc.end();
        });
    }
    /**
     * Generates Excel (.xlsx) Monthly KPI Report with formatted sheets.
     */
    static async exportMonthlyExcel(data) {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'BSC Textiles HRMS';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Monthly KPI');
        sheet.columns = [
            { header: 'Date (DD-MM-YYYY)', key: 'date', width: 18 },
            { header: 'Status', key: 'status', width: 14 },
            { header: 'Login Time (12-hr)', key: 'login', width: 18 },
            { header: 'Logout Time (12-hr)', key: 'logout', width: 18 },
            { header: 'Working Hours', key: 'workingHours', width: 22 },
        ];
        // Header styling
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
        for (const log of data.attendance.dailyLog) {
            sheet.addRow({
                date: log.dateDmy,
                status: log.status.toUpperCase(),
                login: log.loginTime,
                logout: log.logoutTime,
                workingHours: log.workingHours,
            });
        }
        const summarySheet = workbook.addWorksheet('KPI Summary');
        summarySheet.columns = [
            { header: 'Metric', key: 'metric', width: 30 },
            { header: 'Value', key: 'value', width: 30 },
        ];
        summarySheet.getRow(1).font = { bold: true };
        summarySheet.addRow({ metric: 'Employee Name', value: data.fullName });
        summarySheet.addRow({ metric: 'Employee Code', value: data.employeeCode });
        summarySheet.addRow({ metric: 'Department', value: data.department });
        summarySheet.addRow({ metric: 'Designation', value: data.designation });
        summarySheet.addRow({ metric: 'Location', value: data.location });
        summarySheet.addRow({ metric: 'Period', value: data.periodLabel });
        summarySheet.addRow({ metric: 'Overall KPI Score', value: `${data.kpiSummary.overallKpiScore} / 100 (${data.kpiSummary.grade})` });
        summarySheet.addRow({ metric: 'Attendance Rate', value: `${data.attendance.attendancePercentage}%` });
        summarySheet.addRow({ metric: 'Total Working Hours', value: data.workingHours.totalWorkingHours });
        summarySheet.addRow({ metric: 'Total Idle Hours', value: data.idleTime.totalIdleHours });
        summarySheet.addRow({ metric: 'Idle Percentage', value: `${data.idleTime.idlePercentage}%` });
        summarySheet.addRow({ metric: 'Average Working Hours/Day', value: `${data.workingHours.avgWorkingHoursPerDay} hrs` });
        const buffer = await workbook.xlsx.writeBuffer();
        return Buffer.from(buffer);
    }
    /**
     * Generates CSV string for Monthly KPI Report.
     */
    static exportMonthlyCsv(data) {
        const lines = [
            `"BSC TEXTILES - MONTHLY KPI REPORT - ${data.periodLabel}"`,
            `"Employee:","${data.fullName} (${data.employeeCode})"`,
            `"Department:","${data.department}"`,
            `"Location:","${data.location}"`,
            `"Overall KPI Score:","${data.kpiSummary.overallKpiScore} / 100 (${data.kpiSummary.grade})"`,
            `"Attendance Rate:","${data.attendance.attendancePercentage}%"`,
            `"Total Working Duration:","${data.workingHours.totalWorkingHours}"`,
            `"Total Idle Duration:","${data.idleTime.totalIdleHours}"`,
            '',
            '"Date (DD-MM-YYYY)","Status","Login Time (12-hr)","Logout Time (12-hr)","Working Hours"',
        ];
        for (const log of data.attendance.dailyLog) {
            lines.push(`"${log.dateDmy}","${log.status}","${log.loginTime}","${log.logoutTime}","${log.workingHours}"`);
        }
        return lines.join('\n');
    }
    /**
     * Consolidated Monthly KPI Report across all employees in location or whole company.
     */
    static async getConsolidatedMonthlyKPI(user, period, locationId) {
        const allowed = await allowedLocationIds(user);
        const where = ["e.status = 'active'"];
        const params = [];
        if (locationId) {
            where.push('e.location_id = ?');
            params.push(locationId);
        }
        else if (allowed !== null) {
            if (allowed.length === 0)
                return { period, totalEmployees: 0, avgScore: 0, employees: [] };
            where.push(`e.location_id IN (${allowed.map(() => '?').join(',')})`);
            params.push(...allowed);
        }
        const empRows = await query(`SELECT e.id FROM employees e WHERE ${where.join(' AND ')} ORDER BY e.full_name ASC LIMIT 100`, params);
        const employees = [];
        let sumScore = 0;
        for (const r of empRows) {
            const rep = await AutomatedKPIService.getMonthlyKPI(Number(r.id), period);
            employees.push(rep);
            sumScore += rep.kpiSummary.overallKpiScore;
        }
        return {
            period,
            totalEmployees: employees.length,
            avgScore: employees.length > 0 ? Math.round(sumScore / employees.length) : 0,
            employees,
        };
    }
}
//# sourceMappingURL=AutomatedKPIService.js.map