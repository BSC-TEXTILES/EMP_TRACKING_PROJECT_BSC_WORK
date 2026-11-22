import { query, queryOne, execute } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { today } from '../lib/dates.js';
export class EmployeeActivityDetailsService {
    /**
     * Asserts whether currentUser is permitted to view the activity profile of targetEmployeeId.
     */
    static async assertAccess(currentUser, targetEmployeeId) {
        if (currentUser.id === targetEmployeeId)
            return;
        // Super Admin / Org Admin
        if (currentUser.permissions.includes('activity.view.all') ||
            currentUser.permissions.includes('employees.view.all') ||
            (currentUser.roleLevel && currentUser.roleLevel >= 90)) {
            return;
        }
        // Location HR: check assigned locations
        if (currentUser.permissions.includes('employees.view.location') || (currentUser.roleLevel && currentUser.roleLevel >= 70)) {
            const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [targetEmployeeId]);
            if (emp?.location_id && currentUser.locationId && emp.location_id === currentUser.locationId) {
                return;
            }
            // Check multi-location assignments if applicable
            const multi = await queryOne('SELECT id FROM employee_locations WHERE employee_id = ? AND location_id = ?', [currentUser.id, emp?.location_id ?? 0]);
            if (multi)
                return;
        }
        // Reporting Manager: check direct report
        if (currentUser.permissions.includes('activity.view.team') || (currentUser.roleLevel && currentUser.roleLevel >= 50)) {
            const isReport = await queryOne('SELECT id FROM employees WHERE id = ? AND manager_id = ?', [
                targetEmployeeId,
                currentUser.id,
            ]);
            if (isReport)
                return;
        }
        throw ApiError.forbidden('You are not authorized to view this employee activity dashboard.');
    }
    /**
     * Records an audit entry when an authorized administrative user inspects an employee's profile.
     */
    static async logAudit(actorId, targetEmployeeId, action, ip) {
        try {
            await execute(`INSERT INTO employee_tracking_audit_logs (actor_id, target_employee_id, action, view_name, ip_address, created_at)
         VALUES (?, ?, ?, 'user_details', ?, NOW(3))`, [actorId, targetEmployeeId, action, ip ?? null]);
        }
        catch {
            // Non-blocking error
        }
    }
    /**
     * Generates the complete comprehensive employee activity dashboard data.
     */
    static async getComprehensiveDashboard(currentUser, targetEmployeeId, date = today(), ip) {
        await this.assertAccess(currentUser, targetEmployeeId);
        if (currentUser.id !== targetEmployeeId) {
            await this.logAudit(currentUser.id, targetEmployeeId, 'view_user_details', ip);
        }
        // 1. Fetch Complete Employee Profile
        const empRow = await queryOne(`SELECT e.id, e.full_name, e.employee_code, e.photo_url, e.mobile, e.email,
              e.department_id, d.name AS department_name,
              e.designation_id, dg.title AS designation_title,
              e.location_id, l.code AS location_code, l.name AS location_name,
              e.manager_id, m.full_name AS manager_name,
              e.hr_representative_id, hr.full_name AS hr_name,
              e.status, e.employment_type, e.joining_date
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN employees hr ON hr.id = e.hr_representative_id
       WHERE e.id = ?`, [targetEmployeeId]);
        if (!empRow) {
            throw ApiError.notFound('Employee record not found.');
        }
        const profile = {
            id: Number(empRow.id),
            fullName: String(empRow.full_name),
            employeeCode: String(empRow.employee_code),
            photoUrl: empRow.photo_url ? String(empRow.photo_url) : null,
            mobile: empRow.mobile ? String(empRow.mobile) : null,
            email: String(empRow.email),
            departmentId: empRow.department_id ? Number(empRow.department_id) : null,
            departmentName: empRow.department_name ? String(empRow.department_name) : null,
            designationId: empRow.designation_id ? Number(empRow.designation_id) : null,
            designationTitle: empRow.designation_title ? String(empRow.designation_title) : null,
            locationId: empRow.location_id ? Number(empRow.location_id) : null,
            locationCode: empRow.location_code ? String(empRow.location_code) : null,
            locationName: empRow.location_name ? String(empRow.location_name) : null,
            managerId: empRow.manager_id ? Number(empRow.manager_id) : null,
            managerName: empRow.manager_name ? String(empRow.manager_name) : null,
            hrId: empRow.hr_representative_id ? Number(empRow.hr_representative_id) : null,
            hrName: empRow.hr_name ? String(empRow.hr_name) : null,
            status: String(empRow.status),
            employmentType: String(empRow.employment_type || 'full_time'),
            joiningDate: empRow.joining_date ? String(empRow.joining_date).slice(0, 10) : null,
        };
        // 2. Fetch Attendance for the target date
        const attendanceRows = await query(`SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? ORDER BY session_number ASC`, [targetEmployeeId, date]);
        let totalWorkingMinutes = 0;
        let totalBreakMinutes = 0;
        let totalOvertimeMinutes = 0;
        let checkInAt = null;
        let checkOutAt = null;
        let attendanceStatus = 'absent';
        let isLate = false;
        let lateMinutes = 0;
        const sessions = attendanceRows.map((r, idx) => {
            const worked = Number(r.total_minutes || 0);
            const bMins = Number(r.break_minutes || 0);
            totalWorkingMinutes += worked;
            totalBreakMinutes += bMins;
            totalOvertimeMinutes += Number(r.overtime_minutes || 0);
            if (idx === 0) {
                checkInAt = r.check_in_at ? new Date(String(r.check_in_at)).toISOString() : null;
                attendanceStatus = String(r.status || 'present');
                isLate = Boolean(r.is_late);
            }
            if (r.check_out_at) {
                checkOutAt = new Date(String(r.check_out_at)).toISOString();
            }
            return {
                id: Number(r.id),
                sessionNumber: Number(r.session_number || 1),
                checkInAt: r.check_in_at ? new Date(String(r.check_in_at)).toISOString() : null,
                checkOutAt: r.check_out_at ? new Date(String(r.check_out_at)).toISOString() : null,
                totalMinutes: worked,
                breakMinutes: bMins,
                isActive: Boolean(r.check_in_at && !r.check_out_at),
            };
        });
        const attendance = {
            date,
            status: attendanceStatus,
            checkInAt,
            checkOutAt,
            totalWorkingMinutes,
            breakMinutes: totalBreakMinutes,
            overtimeMinutes: totalOvertimeMinutes,
            isLate,
            lateMinutes,
            shiftStart: '09:30',
            shiftEnd: '18:30',
            shiftSchedule: '09:30 - 18:30',
            sessions,
        };
        // 3. Fetch Real-time Status Cache and Registered Devices
        const trackingStatusRow = await queryOne(`SELECT * FROM employee_tracking_status WHERE employee_id = ?`, [targetEmployeeId]);
        const deviceRow = await queryOne(`SELECT d.device_name, d.agent_version, d.last_sync_at, d.tracking_status
       FROM employee_device_registry d
       WHERE d.employee_id = ? AND d.is_authorized = 1
       ORDER BY d.last_sync_at DESC LIMIT 1`, [targetEmployeeId]);
        const isOnline = Boolean(trackingStatusRow?.is_online);
        const isActive = Boolean(trackingStatusRow?.is_active);
        const isIdle = Boolean(trackingStatusRow?.is_idle);
        const isOnBreak = Boolean(trackingStatusRow?.is_on_break);
        let currentWorkingStatus = 'Offline';
        if (isOnBreak)
            currentWorkingStatus = 'On Break';
        else if (isActive)
            currentWorkingStatus = 'Active Working';
        else if (isIdle)
            currentWorkingStatus = 'Idle';
        else if (isOnline)
            currentWorkingStatus = 'Active Working';
        else if (checkInAt && !checkOutAt)
            currentWorkingStatus = 'Active Working';
        const status = {
            currentWorkingStatus,
            isOnline,
            isActive,
            isIdle,
            isOnBreak,
            currentApp: trackingStatusRow?.current_app ? String(trackingStatusRow.current_app) : null,
            currentDomain: trackingStatusRow?.current_domain ? String(trackingStatusRow.current_domain) : null,
            lastActiveAt: trackingStatusRow?.last_event_at ? new Date(String(trackingStatusRow.last_event_at)).toISOString() : null,
            lastHeartbeatAt: trackingStatusRow?.last_heartbeat_at ? new Date(String(trackingStatusRow.last_heartbeat_at)).toISOString() : null,
            agentConnected: isOnline || Boolean(deviceRow?.last_sync_at),
            agentVersion: deviceRow?.agent_version ? String(deviceRow.agent_version) : '1.0.0',
            deviceName: deviceRow?.device_name ? String(deviceRow.device_name) : 'Company Workstation',
        };
        // 4. Fetch Applications Usage (from employee_application_usage or application_usage_logs)
        const appRows = await query(`SELECT id, app_name, app_category, window_title, total_seconds, launch_count, launched_at, closed_at
       FROM employee_application_usage
       WHERE employee_id = ? AND work_date = ?
       ORDER BY total_seconds DESC`, [targetEmployeeId, date]);
        let dailyApps = appRows.map((r) => ({
            id: Number(r.id),
            appName: String(r.app_name),
            appCategory: String(r.app_category || 'General'),
            windowTitle: r.window_title ? String(r.window_title) : null,
            totalSeconds: Number(r.total_seconds || 0),
            totalMinutes: Math.round(Number(r.total_seconds || 0) / 60),
            launchCount: Number(r.launch_count || 1),
            launchedAt: r.launched_at ? new Date(String(r.launched_at)).toISOString() : null,
            closedAt: r.closed_at ? new Date(String(r.closed_at)).toISOString() : null,
            lastUsedAt: r.closed_at ? new Date(String(r.closed_at)).toISOString() : null,
        }));
        // Fallback to legacy application_usage_logs if employee_application_usage is empty
        if (dailyApps.length === 0) {
            const legacyAppRows = await query(`SELECT MIN(l.id) AS id, l.app_name, COALESCE(l.app_category, 'General') AS app_category,
                SUM(l.active_seconds) AS total_seconds, COUNT(*) AS launch_count,
                MAX(l.ended_at) AS last_used_at, MIN(l.started_at) AS launched_at
         FROM application_usage_logs l
         WHERE l.employee_id = ? AND DATE(l.started_at) = ? AND l.deleted_at IS NULL
         GROUP BY l.app_name, l.app_category
         ORDER BY total_seconds DESC LIMIT 25`, [targetEmployeeId, date]);
            dailyApps = legacyAppRows.map((r, i) => ({
                id: Number(r.id || i + 1),
                appName: String(r.app_name),
                appCategory: String(r.app_category),
                windowTitle: null,
                totalSeconds: Number(r.total_seconds || 0),
                totalMinutes: Math.round(Number(r.total_seconds || 0) / 60),
                launchCount: Number(r.launch_count || 1),
                launchedAt: r.launched_at ? new Date(String(r.launched_at)).toISOString() : null,
                closedAt: r.last_used_at ? new Date(String(r.last_used_at)).toISOString() : null,
                lastUsedAt: r.last_used_at ? new Date(String(r.last_used_at)).toISOString() : null,
            }));
        }
        // Weekly & Monthly App summaries
        let weeklyApps = await query(`SELECT app_name, app_category AS category, ROUND(SUM(total_seconds) / 60) AS total_minutes
       FROM employee_application_usage
       WHERE employee_id = ? AND work_date >= DATE_SUB(?, INTERVAL 7 DAY)
       GROUP BY app_name, app_category
       ORDER BY total_minutes DESC LIMIT 10`, [targetEmployeeId, date]).then((rows) => rows.map((r) => ({
            appName: String(r.app_name),
            category: String(r.category || 'General'),
            totalMinutes: Number(r.total_minutes || 0),
        })));
        if (weeklyApps.length === 0) {
            weeklyApps = await query(`SELECT app_name, COALESCE(app_category, 'General') AS category, ROUND(SUM(active_seconds) / 60) AS total_minutes
         FROM application_usage_logs
         WHERE employee_id = ? AND started_at >= DATE_SUB(?, INTERVAL 7 DAY) AND deleted_at IS NULL
         GROUP BY app_name, app_category
         ORDER BY total_minutes DESC LIMIT 10`, [targetEmployeeId, date]).then((rows) => rows.map((r) => ({
                appName: String(r.app_name),
                category: String(r.category || 'General'),
                totalMinutes: Number(r.total_minutes || 0),
            })));
        }
        let monthlyApps = await query(`SELECT app_name, app_category AS category, ROUND(SUM(total_seconds) / 60) AS total_minutes
       FROM employee_application_usage
       WHERE employee_id = ? AND work_date >= DATE_SUB(?, INTERVAL 30 DAY)
       GROUP BY app_name, app_category
       ORDER BY total_minutes DESC LIMIT 10`, [targetEmployeeId, date]).then((rows) => rows.map((r) => ({
            appName: String(r.app_name),
            category: String(r.category || 'General'),
            totalMinutes: Number(r.total_minutes || 0),
        })));
        if (monthlyApps.length === 0) {
            monthlyApps = await query(`SELECT app_name, COALESCE(app_category, 'General') AS category, ROUND(SUM(active_seconds) / 60) AS total_minutes
         FROM application_usage_logs
         WHERE employee_id = ? AND started_at >= DATE_SUB(?, INTERVAL 30 DAY) AND deleted_at IS NULL
         GROUP BY app_name, app_category
         ORDER BY total_minutes DESC LIMIT 10`, [targetEmployeeId, date]).then((rows) => rows.map((r) => ({
                appName: String(r.app_name),
                category: String(r.category || 'General'),
                totalMinutes: Number(r.total_minutes || 0),
            })));
        }
        // 5. Fetch Websites Usage (from employee_website_usage or browser_usage_logs)
        const webRows = await query(`SELECT id, domain, page_title, url, category, browser_name, total_seconds, visit_count, first_accessed_at, last_accessed_at
       FROM employee_website_usage
       WHERE employee_id = ? AND work_date = ?
       ORDER BY total_seconds DESC`, [targetEmployeeId, date]);
        let dailyWebsites = webRows.map((r) => ({
            id: Number(r.id),
            domain: String(r.domain),
            pageTitle: r.page_title ? String(r.page_title) : null,
            url: r.url ? String(r.url) : null,
            category: String(r.category || 'Work-related'),
            browserName: String(r.browser_name || 'Chrome'),
            totalSeconds: Number(r.total_seconds || 0),
            totalMinutes: Math.round(Number(r.total_seconds || 0) / 60),
            visitCount: Number(r.visit_count || 1),
            firstAccessedAt: r.first_accessed_at ? new Date(String(r.first_accessed_at)).toISOString() : null,
            lastAccessedAt: r.last_accessed_at ? new Date(String(r.last_accessed_at)).toISOString() : null,
        }));
        if (dailyWebsites.length === 0) {
            const legacyWebRows = await query(`SELECT MIN(id) AS id, domain, category, SUM(active_seconds) AS total_seconds, COUNT(*) AS visit_count,
                MIN(started_at) AS first_accessed, MAX(ended_at) AS last_accessed
         FROM browser_usage_logs
         WHERE employee_id = ? AND DATE(started_at) = ? AND deleted_at IS NULL
         GROUP BY domain, category
         ORDER BY total_seconds DESC LIMIT 25`, [targetEmployeeId, date]);
            dailyWebsites = legacyWebRows.map((r, i) => ({
                id: Number(r.id || i + 1),
                domain: String(r.domain),
                pageTitle: String(r.domain),
                url: `https://${r.domain}`,
                category: String(r.category || 'Work-related'),
                browserName: 'Chrome',
                totalSeconds: Number(r.total_seconds || 0),
                totalMinutes: Math.round(Number(r.total_seconds || 0) / 60),
                visitCount: Number(r.visit_count || 1),
                firstAccessedAt: r.first_accessed ? new Date(String(r.first_accessed)).toISOString() : null,
                lastAccessedAt: r.last_accessed ? new Date(String(r.last_accessed)).toISOString() : null,
            }));
        }
        // Website category breakdown
        const categoryMap = new Map();
        for (const site of dailyWebsites) {
            const existing = categoryMap.get(site.category) || { count: 0, totalMinutes: 0 };
            existing.count += site.visitCount;
            existing.totalMinutes += site.totalMinutes;
            categoryMap.set(site.category, existing);
        }
        const webCategories = Array.from(categoryMap.entries()).map(([cat, val]) => ({
            category: cat,
            count: val.count,
            totalMinutes: val.totalMinutes,
        }));
        // 6. Fetch Idle Sessions
        const idleRows = await query(`SELECT id, started_at, ended_at, duration_seconds, idle_type, reason
       FROM employee_idle_sessions
       WHERE employee_id = ? AND work_date = ?
       ORDER BY started_at DESC`, [targetEmployeeId, date]);
        const idleSessions = idleRows.map((r) => {
            const secs = Number(r.duration_seconds || 0);
            return {
                id: Number(r.id),
                startedAt: new Date(String(r.started_at)).toISOString(),
                endedAt: r.ended_at ? new Date(String(r.ended_at)).toISOString() : null,
                durationSeconds: secs,
                durationMinutes: Math.round(secs / 60),
                idleType: r.idle_type || 'short_idle',
                reason: r.reason ? String(r.reason) : null,
            };
        });
        let normalIdleMinutes = 0;
        let shortIdleMinutes = 0;
        let extendedIdleMinutes = 0;
        let longIdleMinutes = 0;
        for (const idle of idleSessions) {
            if (idle.durationMinutes <= 5)
                normalIdleMinutes += idle.durationMinutes;
            else if (idle.durationMinutes <= 15)
                shortIdleMinutes += idle.durationMinutes;
            else if (idle.durationMinutes <= 30)
                extendedIdleMinutes += idle.durationMinutes;
            else
                longIdleMinutes += idle.durationMinutes;
        }
        // 7. Fetch Timeline Events (Chronological feed)
        const timelineRows = await query(`SELECT id, event_type, event_category, title, details, source, duration_seconds, occurred_at
       FROM employee_activity_events
       WHERE employee_id = ? AND DATE(occurred_at) = ?
       ORDER BY occurred_at ASC LIMIT 100`, [targetEmployeeId, date]);
        let timeline = timelineRows.map((r) => ({
            id: Number(r.id),
            eventType: String(r.event_type),
            eventCategory: String(r.event_category),
            title: String(r.title),
            details: r.details ? String(r.details) : null,
            source: r.source || 'desktop_agent',
            occurredAt: new Date(String(r.occurred_at)).toISOString(),
            durationSeconds: Number(r.duration_seconds || 0),
        }));
        // If timeline is empty, generate from work_activity_events and login history
        if (timeline.length === 0) {
            const legacyEvents = await query(`SELECT id, source_type AS event_type, title, detail, occurred_at
         FROM work_activity_events
         WHERE employee_id = ? AND DATE(occurred_at) = ? AND deleted_at IS NULL
         ORDER BY occurred_at ASC LIMIT 50`, [targetEmployeeId, date]);
            timeline = legacyEvents.map((r) => ({
                id: Number(r.id),
                eventType: String(r.event_type || 'activity'),
                eventCategory: 'Work',
                title: String(r.title || 'Work Activity'),
                details: r.detail ? String(r.detail) : null,
                source: 'desktop_agent',
                occurredAt: new Date(String(r.occurred_at)).toISOString(),
                durationSeconds: 0,
            }));
        }
        // 8. Fetch Login History
        const loginRows = await query(`SELECT id, login_at, logout_at, duration_seconds, ip_address, user_agent, device_name, login_status
       FROM employee_login_history
       WHERE employee_id = ? AND DATE(login_at) = ?
       ORDER BY login_at DESC LIMIT 20`, [targetEmployeeId, date]);
        let loginHistory = loginRows.map((r) => ({
            id: Number(r.id),
            loginAt: new Date(String(r.login_at)).toISOString(),
            logoutAt: r.logout_at ? new Date(String(r.logout_at)).toISOString() : null,
            durationMinutes: Math.round(Number(r.duration_seconds || 0) / 60),
            ipAddress: r.ip_address ? String(r.ip_address) : null,
            userAgent: r.user_agent ? String(r.user_agent) : null,
            deviceName: r.device_name ? String(r.device_name) : 'Authorized Device',
            locationName: profile.locationName,
            status: String(r.login_status || 'success'),
        }));
        if (loginHistory.length === 0) {
            const legacyLogins = await query(`SELECT id, login_at, logout_at, duration_minutes, ip AS ip_address, user_agent, login_status
         FROM employee_login_audit
         WHERE employee_id = ? AND DATE(login_at) = ?
         ORDER BY login_at DESC LIMIT 10`, [targetEmployeeId, date]);
            loginHistory = legacyLogins.map((r) => ({
                id: Number(r.id),
                loginAt: new Date(String(r.login_at)).toISOString(),
                logoutAt: r.logout_at ? new Date(String(r.logout_at)).toISOString() : null,
                durationMinutes: Number(r.duration_minutes || 0),
                ipAddress: r.ip_address ? String(r.ip_address) : null,
                userAgent: r.user_agent ? String(r.user_agent) : null,
                deviceName: 'Authorized Device',
                locationName: profile.locationName,
                status: String(r.login_status || 'success'),
            }));
        }
        // 9. Aggregate Complete Metrics
        const totalAppMinutes = dailyApps.reduce((sum, a) => sum + a.totalMinutes, 0);
        const totalWebMinutes = dailyWebsites.reduce((sum, w) => sum + w.totalMinutes, 0);
        const totalIdleMinutes = idleSessions.reduce((sum, i) => sum + i.durationMinutes, 0);
        const totalActiveMinutes = Math.max(totalAppMinutes, Math.max(0, totalWorkingMinutes - totalIdleMinutes - totalBreakMinutes));
        const totalSystemMinutes = Math.max(totalWorkingMinutes, totalActiveMinutes + totalIdleMinutes);
        const activePercentage = totalSystemMinutes > 0 ? Math.min(100, Math.round((totalActiveMinutes / totalSystemMinutes) * 100)) : 0;
        const idlePercentage = totalSystemMinutes > 0 ? Math.max(0, 100 - activePercentage) : 0;
        const activeToIdleRatio = `${activePercentage}% / ${idlePercentage}%`;
        const longestIdleMinutes = idleSessions.length > 0 ? Math.max(...idleSessions.map((i) => i.durationMinutes)) : 0;
        const averageIdleMinutes = idleSessions.length > 0 ? Math.round(totalIdleMinutes / idleSessions.length) : 0;
        const unaccountedMinutes = Math.max(0, totalWorkingMinutes - (totalActiveMinutes + totalIdleMinutes + totalBreakMinutes));
        const metrics = {
            totalSystemMinutes,
            totalActiveMinutes,
            totalIdleMinutes,
            totalAppMinutes,
            totalWebMinutes,
            appsOpenedCount: dailyApps.length,
            websitesAccessedCount: dailyWebsites.length,
            appSessionsCount: dailyApps.reduce((sum, a) => sum + a.launchCount, 0),
            browserSessionsCount: dailyWebsites.reduce((sum, w) => sum + w.visitCount, 0),
            idleSessionsCount: idleSessions.length,
            loginSessionsCount: loginHistory.length,
            activePercentage,
            idlePercentage,
            activeToIdleRatio,
            longestIdleMinutes,
            averageIdleMinutes,
            unaccountedMinutes,
        };
        // 10. Reports Summary
        const productivityScore = Math.min(100, Math.max(0, Math.round((totalActiveMinutes / Math.max(480, totalSystemMinutes || 480)) * 100)));
        const reports = {
            periodSummary: {
                date,
                workedHours: `${Math.floor(totalWorkingMinutes / 60)}h ${totalWorkingMinutes % 60}m`,
                activeHours: `${Math.floor(totalActiveMinutes / 60)}h ${totalActiveMinutes % 60}m`,
                idleHours: `${Math.floor(totalIdleMinutes / 60)}h ${totalIdleMinutes % 60}m`,
                appHours: `${Math.floor(totalAppMinutes / 60)}h ${totalAppMinutes % 60}m`,
                webHours: `${Math.floor(totalWebMinutes / 60)}h ${totalWebMinutes % 60}m`,
                productivityScore,
            },
        };
        const overview = {
            workingStatus: status.currentWorkingStatus,
            currentWorkingStatus: status.currentWorkingStatus,
            attendanceMinutes: totalWorkingMinutes,
            activeMinutes: totalActiveMinutes,
            idleMinutes: totalIdleMinutes,
            ...metrics,
        };
        const timelineData = timeline;
        timelineData.events = timeline;
        return {
            profile,
            status,
            overview,
            attendance,
            metrics,
            timeline: timelineData,
            applications: {
                daily: dailyApps,
                weekly: weeklyApps,
                monthly: monthlyApps,
                summary: {
                    totalAppsCount: dailyApps.length,
                    totalDurationMinutes: totalAppMinutes,
                },
            },
            websites: {
                daily: dailyWebsites,
                items: dailyWebsites,
                categories: webCategories,
                categoryBreakdown: webCategories,
            },
            idle: {
                sessions: idleSessions,
                thresholds: {
                    normalMinutes: normalIdleMinutes,
                    shortIdleMinutes: shortIdleMinutes,
                    extendedIdleMinutes: extendedIdleMinutes,
                    longIdleMinutes: longIdleMinutes,
                },
            },
            loginHistory,
            logins: {
                history: loginHistory,
            },
            reports: {
                ...reports,
                executiveSummary: reports.periodSummary,
            },
        };
    }
    /**
     * Generates a CSV export of comprehensive employee activity.
     */
    static async exportUserActivity(user, employeeId, targetDate) {
        const data = await EmployeeActivityDetailsService.getComprehensiveDashboard(user, employeeId, targetDate);
        const date = targetDate || today();
        const lines = [];
        lines.push('"BSC TEXTILES HRMS - EMPLOYEE ACTIVITY & DETAILS REPORT"');
        lines.push(`"Generated At","${new Date().toISOString()}"`);
        lines.push(`"Target Date","${date}"`);
        lines.push('');
        lines.push(`"Employee ID","${data.profile.employeeCode}"`);
        lines.push(`"Full Name","${data.profile.fullName}"`);
        lines.push(`"Department","${data.profile.departmentName ?? ''}"`);
        lines.push(`"Designation","${data.profile.designationTitle ?? ''}"`);
        lines.push(`"Location","${data.profile.locationName ?? ''}"`);
        lines.push(`"Reporting Manager","${data.profile.managerName ?? ''}"`);
        lines.push(`"HR Manager","${data.profile.hrName ?? ''}"`);
        lines.push('');
        lines.push('"Summary Metrics"');
        lines.push(`"Total Working Duration","${data.reports.periodSummary.workedHours}"`);
        lines.push(`"Total Active Working Time","${data.reports.periodSummary.activeHours}"`);
        lines.push(`"Total Idle Time","${data.reports.periodSummary.idleHours}"`);
        lines.push(`"Application Time","${data.reports.periodSummary.appHours}"`);
        lines.push(`"Website Time","${data.reports.periodSummary.webHours}"`);
        lines.push(`"Active/Idle Ratio","${data.metrics.activeToIdleRatio}"`);
        lines.push(`"Productivity Score","${data.reports.periodSummary.productivityScore}%"`);
        lines.push('');
        lines.push('"ATTENDANCE SESSIONS"');
        lines.push('"Session #","Check In","Check Out","Duration (Mins)","Late Arrival (Mins)"');
        for (const session of data.attendance.sessions) {
            lines.push(`"${session.sessionNumber}","${session.checkInAt}","${session.checkOutAt ?? 'Active'}","${session.totalMinutes}","${data.attendance.lateMinutes}"`);
        }
        lines.push('');
        lines.push('"APPLICATION USAGE"');
        lines.push('"Application","Category","Duration (Mins)","Launches","Last Used"');
        for (const app of data.applications.daily) {
            lines.push(`"${app.appName}","${app.appCategory}","${app.totalMinutes}","${app.launchCount}","${app.lastUsedAt ?? ''}"`);
        }
        lines.push('');
        lines.push('"WEBSITE USAGE"');
        lines.push('"Domain","Category","Duration (Mins)","Visits","Browser"');
        for (const site of data.websites.daily) {
            lines.push(`"${site.domain}","${site.category}","${site.totalMinutes}","${site.visitCount}","${site.browserName}"`);
        }
        lines.push('');
        lines.push('"IDLE SESSIONS"');
        lines.push('"Started At","Ended At","Duration (Mins)","Type","Reason"');
        for (const idle of data.idle.sessions) {
            lines.push(`"${idle.startedAt}","${idle.endedAt ?? 'Ongoing'}","${idle.durationMinutes}","${idle.idleType}","${idle.reason ?? 'Inactive'}"`);
        }
        return lines.join('\n');
    }
    /**
     * Ingests synchronized tracking events from desktop agent & browser extension with offline queue & deduplication.
     */
    static async ingestAgentEvents(employeeId, eventsOrDeviceId, maybeEvents) {
        const events = (Array.isArray(eventsOrDeviceId) ? eventsOrDeviceId : Array.isArray(maybeEvents) ? maybeEvents : []);
        let inserted = 0;
        for (const evt of events) {
            try {
                const occurredAt = evt.timestamp ? new Date(evt.timestamp) : evt.occurredAt ? new Date(evt.occurredAt) : new Date();
                const duration = Number(evt.durationSeconds || 0);
                await execute(`INSERT INTO employee_activity_events (employee_id, event_type, event_category, title, details, source, duration_seconds, occurred_at, meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    employeeId,
                    evt.type,
                    evt.category || 'General',
                    (evt.title || evt.appName || evt.domain || 'Activity').slice(0, 255),
                    evt.details ? evt.details.slice(0, 1000) : null,
                    evt.source || 'desktop_agent',
                    duration,
                    occurredAt,
                    evt.meta ? JSON.stringify(evt.meta) : null,
                ]);
                // Update real-time status cache
                const isIdle = evt.type === 'idle_start' || evt.type === 'screen_lock' || evt.type === 'system_sleep';
                const isActive = evt.type === 'app_focus' || evt.type === 'app_launch' || evt.type === 'website_visit' || evt.type === 'idle_end';
                const currentApp = evt.type === 'app_focus' || evt.type === 'app_launch' ? (evt.appName || evt.title) : null;
                const currentDomain = evt.type === 'website_visit' ? (evt.domain || evt.title) : null;
                await execute(`INSERT INTO employee_tracking_status (employee_id, is_online, is_active, is_idle, current_app, current_domain, last_event_at, last_heartbeat_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, NOW(3))
           ON DUPLICATE KEY UPDATE
             is_online = 1,
             is_active = IF(VALUES(is_active) = 1, 1, IF(VALUES(is_idle) = 1, 0, is_active)),
             is_idle = IF(VALUES(is_idle) = 1, 1, IF(VALUES(is_active) = 1, 0, is_idle)),
             current_app = COALESCE(VALUES(current_app), current_app),
             current_domain = COALESCE(VALUES(current_domain), current_domain),
             last_event_at = VALUES(last_event_at),
             last_heartbeat_at = NOW(3)`, [employeeId, isActive ? 1 : 0, isIdle ? 1 : 0, currentApp, currentDomain, occurredAt]);
                inserted += 1;
            }
            catch {
                // Skip duplicate or malformed events
            }
        }
        return { processed: events.length, inserted };
    }
}
//# sourceMappingURL=EmployeeActivityDetailsService.js.map