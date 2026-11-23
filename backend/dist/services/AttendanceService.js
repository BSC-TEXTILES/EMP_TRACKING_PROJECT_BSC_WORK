import { execute, query, queryOne, transaction } from '../db/index.js';
import { assertEmployeeAccess } from '../lib/scope.js';
import { getSettings, recordAudit } from '../lib/audit.js';
import { ApiError } from '../lib/http.js';
import { addDays, daysBetween, endOfMonth, localDate, localTime, parseUtc, startOfMonth, today, toIso, toSqlTimestamp } from '../lib/dates.js';
import { emitToEmployee } from '../realtime/io.js';
import { isWeeklyOff, sundaysBetween } from '../lib/calendar.js';
import { WeeklyOffService } from './WeeklyOffService.js';
import { NotificationService } from './NotificationService.js';
/** Re-evaluates the comp-off credit for a worked Sunday / holiday without failing the attendance action. */
async function syncCompOff(employeeId, workDate) {
    try {
        await WeeklyOffService.syncCompOff(employeeId, workDate);
    }
    catch (error) {
        console.error('[comp-off] sync failed', { employeeId, workDate }, error);
    }
}
/** Keeps monitoring sessions aligned with attendance without failing the attendance action. */
async function syncMonitoring(action) {
    try {
        const { ActivityService } = await import('./ActivityService.js');
        await action(ActivityService);
    }
    catch (error) {
        console.error('[activity] monitoring session sync failed', error);
    }
}
const SETTING_KEYS = ['work_start_time', 'work_end_time', 'late_grace_minutes', 'half_day_hours', 'full_day_hours', 'overtime_after_hours'];
/**
 * Gets the effective office schedule for a location on a specific date.
 * Falls back to company default if no location-specific schedule exists.
 */
async function getLocationSchedule(locationId, date = today()) {
    if (!locationId)
        return null;
    // Find the most recent schedule effective on or before the given date
    const schedule = await queryOne(`SELECT work_start_time, work_end_time, break_start_time, break_end_time,
            second_break_start_time, second_break_end_time, total_working_hours,
            weekly_working_days, weekly_off_day, grace_minutes,
            early_departure_threshold_minutes, is_active
     FROM location_office_schedules
     WHERE location_id = ? AND effective_date <= ? AND is_active = 1
     ORDER BY effective_date DESC LIMIT 1`, [locationId, date]);
    if (!schedule)
        return null;
    let weeklyWorkingDays = [1, 2, 3, 4, 5, 6];
    try {
        weeklyWorkingDays = JSON.parse(schedule.weekly_working_days);
    }
    catch {
        // Use default
    }
    return {
        workStart: schedule.work_start_time.slice(0, 5),
        workEnd: schedule.work_end_time.slice(0, 5),
        breakStart: schedule.break_start_time?.slice(0, 5) ?? null,
        breakEnd: schedule.break_end_time?.slice(0, 5) ?? null,
        secondBreakStart: schedule.second_break_start_time?.slice(0, 5) ?? null,
        secondBreakEnd: schedule.second_break_end_time?.slice(0, 5) ?? null,
        totalWorkingHours: Number(schedule.total_working_hours),
        weeklyWorkingDays,
        weeklyOffDay: schedule.weekly_off_day ?? null,
        graceMinutes: Number(schedule.grace_minutes),
        earlyDepartureThresholdMinutes: Number(schedule.early_departure_threshold_minutes),
    };
}
async function shiftConfig(locationId) {
    const s = await getSettings(SETTING_KEYS);
    let workStart = s.work_start_time || '09:30';
    let workEnd = s.work_end_time || '18:30';
    let graceMinutes = Number(s.late_grace_minutes || 10);
    let halfDayHours = Number(s.half_day_hours || 4);
    let fullDayHours = Number(s.full_day_hours || 9);
    let overtimeAfterHours = Number(s.overtime_after_hours || 9);
    if (locationId) {
        const schedule = await getLocationSchedule(locationId);
        if (schedule) {
            workStart = schedule.workStart;
            workEnd = schedule.workEnd;
            graceMinutes = schedule.graceMinutes;
            // Use schedule's totalWorkingHours if available, otherwise fall back to settings
            if (schedule.totalWorkingHours > 0) {
                fullDayHours = schedule.totalWorkingHours;
                halfDayHours = schedule.totalWorkingHours / 2;
            }
        }
        else {
            // Fallback to legacy system_settings approach for backward compatibility
            const locSettings = await getSettings([
                `loc_work_start_${locationId}`,
                `loc_work_end_${locationId}`,
                `loc_grace_${locationId}`,
                'location_shifts_json',
            ]);
            if (locSettings[`loc_work_start_${locationId}`])
                workStart = locSettings[`loc_work_start_${locationId}`];
            if (locSettings[`loc_work_end_${locationId}`])
                workEnd = locSettings[`loc_work_end_${locationId}`];
            if (locSettings[`loc_grace_${locationId}`])
                graceMinutes = Number(locSettings[`loc_grace_${locationId}`]);
            if (locSettings.location_shifts_json) {
                try {
                    const parsed = JSON.parse(locSettings.location_shifts_json);
                    const match = parsed[String(locationId)];
                    if (match?.workStartTime)
                        workStart = match.workStartTime;
                    if (match?.workEndTime)
                        workEnd = match.workEndTime;
                    if (match?.lateGraceMinutes != null)
                        graceMinutes = Number(match.lateGraceMinutes);
                }
                catch {
                    // Fallback to location keys or general defaults
                }
            }
        }
    }
    return {
        workStart,
        workEnd,
        graceMinutes,
        halfDayHours,
        fullDayHours,
        overtimeAfterHours,
    };
}
function minutesOfDay(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
}
function lateMinutesFor(checkInUtc, shift) {
    const local = localTime(parseUtc(checkInUtc) ?? new Date());
    const diff = minutesOfDay(local) - minutesOfDay(shift.workStart) - shift.graceMinutes;
    return Math.max(0, diff);
}
// ------------------------------------------------------------ office hours
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function assertHours(h, label) {
    if (!TIME_RE.test(h.workStart) || !TIME_RE.test(h.workEnd))
        throw ApiError.badRequest(`${label}: times must be HH:MM (24-hour).`);
    if (minutesOfDay(h.workEnd) <= minutesOfDay(h.workStart))
        throw ApiError.badRequest(`${label}: logout time must be after login time.`);
    if (h.breakStart && h.breakEnd && minutesOfDay(h.breakEnd) <= minutesOfDay(h.breakStart))
        throw ApiError.badRequest(`${label}: break end must be after break start.`);
    if (h.secondBreakStart && h.secondBreakEnd && minutesOfDay(h.secondBreakEnd) <= minutesOfDay(h.secondBreakStart))
        throw ApiError.badRequest(`${label}: second break end must be after second break start.`);
    if (!Number.isInteger(h.graceMinutes) || h.graceMinutes < 0 || h.graceMinutes > 120)
        throw ApiError.badRequest(`${label}: grace must be 0–120 minutes.`);
    if (h.earlyDepartureThresholdMinutes !== undefined && (h.earlyDepartureThresholdMinutes < 0 || h.earlyDepartureThresholdMinutes > 480))
        throw ApiError.badRequest(`${label}: early departure threshold must be 0–480 minutes.`);
    if (h.totalWorkingHours !== undefined && (h.totalWorkingHours <= 0 || h.totalWorkingHours > 24))
        throw ApiError.badRequest(`${label}: total working hours must be 0.25–24.`);
    if (h.weeklyOffDay !== undefined && h.weeklyOffDay !== null && (h.weeklyOffDay < 0 || h.weeklyOffDay > 6))
        throw ApiError.badRequest(`${label}: weekly off day must be 0–6 (Sunday=0).`);
}
/**
 * Office (login / logout) hours: company default plus optional per-location
 * schedules with effective dates, breaks, working hours, and weekly offs.
 * These drive the Late badge at check-in, early-departure at check-out,
 * working hours calculations, and overtime.
 */
export const OfficeHoursService = {
    async get() {
        // Get company default from system_settings
        const s = await getSettings(['work_start_time', 'work_end_time', 'late_grace_minutes']);
        const def = {
            workStart: s.work_start_time || '09:30',
            workEnd: s.work_end_time || '18:30',
            graceMinutes: Number(s.late_grace_minutes || 10),
        };
        const locations = await query('SELECT id, code, name FROM locations WHERE is_active = 1 ORDER BY name');
        const rows = await Promise.all(locations.map(async (l) => {
            const schedule = await getLocationSchedule(Number(l.id));
            if (schedule) {
                return {
                    locationId: Number(l.id),
                    code: l.code,
                    name: l.name,
                    workStart: schedule.workStart,
                    workEnd: schedule.workEnd,
                    breakStart: schedule.breakStart,
                    breakEnd: schedule.breakEnd,
                    secondBreakStart: schedule.secondBreakStart,
                    secondBreakEnd: schedule.secondBreakEnd,
                    totalWorkingHours: schedule.totalWorkingHours,
                    weeklyWorkingDays: schedule.weeklyWorkingDays,
                    weeklyOffDay: schedule.weeklyOffDay,
                    graceMinutes: schedule.graceMinutes,
                    earlyDepartureThresholdMinutes: schedule.earlyDepartureThresholdMinutes,
                    usesDefault: false,
                };
            }
            // No location-specific schedule, use default
            return {
                locationId: Number(l.id),
                code: l.code,
                name: l.name,
                workStart: def.workStart,
                workEnd: def.workEnd,
                breakStart: null,
                breakEnd: null,
                secondBreakStart: null,
                secondBreakEnd: null,
                totalWorkingHours: Number(s.full_day_hours || 9),
                weeklyWorkingDays: [1, 2, 3, 4, 5, 6],
                weeklyOffDay: 0,
                graceMinutes: def.graceMinutes,
                earlyDepartureThresholdMinutes: 0,
                usesDefault: true,
            };
        }));
        return { default: def, locations: rows };
    },
    async set(actor, input, ip) {
        if (input.default)
            assertHours(input.default, 'Company hours');
        const known = new Set((await query('SELECT id FROM locations')).map((l) => Number(l.id)));
        for (const loc of input.locations ?? []) {
            if (!known.has(loc.locationId))
                throw ApiError.badRequest(`Unknown location ${loc.locationId}.`);
            if (!loc.inherit)
                assertHours(loc, `Location ${loc.locationId}`);
        }
        const before = await OfficeHoursService.get();
        const def = before.default;
        await transaction(async (conn) => {
            const put = (key, value) => conn.query(`INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`, [key, value, actor.id]);
            if (input.default) {
                await put('work_start_time', input.default.workStart);
                await put('work_end_time', input.default.workEnd);
                await put('late_grace_minutes', String(input.default.graceMinutes));
            }
            if (input.locations?.length) {
                for (const loc of input.locations) {
                    if (loc.inherit) {
                        // Remove any existing schedule for this location
                        await conn.query('DELETE FROM location_office_schedules WHERE location_id = ?', [loc.locationId]);
                    }
                    else {
                        // Upsert the schedule with today as effective date
                        const todayStr = today();
                        await conn.query(`INSERT INTO location_office_schedules
               (location_id, effective_date, work_start_time, work_end_time,
                break_start_time, break_end_time, total_working_hours,
                weekly_working_days, weekly_off_day, grace_minutes,
                early_departure_threshold_minutes, is_active, created_by, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
               ON DUPLICATE KEY UPDATE
                 work_start_time = VALUES(work_start_time),
                 work_end_time = VALUES(work_end_time),
                 break_start_time = VALUES(break_start_time),
                 break_end_time = VALUES(break_end_time),
                 total_working_hours = VALUES(total_working_hours),
                 weekly_working_days = VALUES(weekly_working_days),
                 weekly_off_day = VALUES(weekly_off_day),
                 grace_minutes = VALUES(grace_minutes),
                 early_departure_threshold_minutes = VALUES(early_departure_threshold_minutes),
                 is_active = VALUES(is_active),
                 updated_by = VALUES(updated_by),
                 updated_at = CURRENT_TIMESTAMP(3)`, [
                            loc.locationId, todayStr,
                            loc.workStart || def.workStart,
                            loc.workEnd || def.workEnd,
                            loc.breakStart ?? null,
                            loc.breakEnd ?? null,
                            loc.totalWorkingHours ?? 9,
                            JSON.stringify(loc.weeklyWorkingDays ?? [1, 2, 3, 4, 5, 6]),
                            loc.weeklyOffDay ?? 0,
                            loc.graceMinutes ?? def.graceMinutes,
                            loc.earlyDepartureThresholdMinutes ?? 0,
                            actor.id,
                            actor.id,
                        ]);
                    }
                }
            }
        });
        const after = await OfficeHoursService.get();
        await recordAudit({ actorId: actor.id, action: 'office_hours.updated', entityType: 'location_office_schedules', before, after, ip });
        return after;
    },
};
export class AttendanceService {
    static async stateFor(employeeId, date = today()) {
        const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
        const shift = await shiftConfig(emp?.location_id);
        const rows = await query(`SELECT a.*, NOW(3) AS server_now,
              (SELECT b.id FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.session_number = a.session_number AND b.ended_at IS NULL ORDER BY b.id DESC LIMIT 1) AS open_break_id,
              (SELECT b.started_at FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.session_number = a.session_number AND b.ended_at IS NULL ORDER BY b.id DESC LIMIT 1) AS open_break_start
       FROM attendance a WHERE a.employee_id = ? AND a.work_date = ? ORDER BY a.session_number ASC`, [employeeId, date]);
        const holiday = await queryOne(`SELECT h.name FROM holidays h
       WHERE h.holiday_date = ?
         AND (h.location_id IS NULL OR h.location_id = (SELECT location_id FROM employees WHERE id = ?))
       LIMIT 1`, [date, employeeId]);
        const serverNow = rows[0]?.server_now ?? (await queryOne('SELECT NOW(3) AS now'))?.now ?? localDate();
        // Identify active session if one exists (checked in, not checked out)
        const activeRow = rows.find((r) => r.check_in_at && !r.check_out_at);
        // Target session for current controls: active session or latest closed session
        const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;
        const targetRow = activeRow ?? latestRow;
        let elapsedSeconds = 0;
        if (activeRow?.check_in_at) {
            const checkIn = parseUtc(activeRow.check_in_at).getTime();
            const end = parseUtc(serverNow).getTime();
            const breakMs = Number(activeRow.break_minutes) * 60000;
            const openBreakMs = activeRow.open_break_start ? parseUtc(serverNow).getTime() - parseUtc(activeRow.open_break_start).getTime() : 0;
            elapsedSeconds = Math.max(0, Math.floor((end - checkIn - breakMs - openBreakMs) / 1000));
        }
        else if (latestRow?.check_in_at && latestRow.check_out_at) {
            elapsedSeconds = Math.max(0, Math.floor(Number(latestRow.total_minutes) * 60));
        }
        let totalWorkedMinutes = 0;
        let totalBreakMinutes = 0;
        let totalOvertimeMinutes = 0;
        const sessions = rows.map((r) => {
            const isActive = Boolean(r.check_in_at && !r.check_out_at);
            let sessionWorkedMinutes = Number(r.total_minutes || 0);
            let sessionBreakMinutes = Number(r.break_minutes || 0);
            if (isActive && r.check_in_at) {
                const checkIn = parseUtc(r.check_in_at).getTime();
                const now = parseUtc(serverNow).getTime();
                const breakMs = sessionBreakMinutes * 60000;
                const openBreakMs = r.open_break_start ? now - parseUtc(r.open_break_start).getTime() : 0;
                sessionWorkedMinutes = Math.max(0, Math.floor((now - checkIn - breakMs - openBreakMs) / 60000));
                if (r.open_break_start) {
                    sessionBreakMinutes += Math.max(0, Math.floor(openBreakMs / 60000));
                }
            }
            totalWorkedMinutes += sessionWorkedMinutes;
            totalBreakMinutes += sessionBreakMinutes;
            totalOvertimeMinutes += Number(r.overtime_minutes || 0);
            return {
                id: Number(r.id),
                sessionNumber: Number(r.session_number),
                checkInAt: toIso(r.check_in_at),
                checkOutAt: toIso(r.check_out_at),
                totalMinutes: sessionWorkedMinutes,
                breakMinutes: sessionBreakMinutes,
                status: r.status,
                isLate: Boolean(r.is_late),
                isActive,
            };
        });
        const lateMinutes = targetRow?.check_in_at ? lateMinutesFor(targetRow.check_in_at, shift) : 0;
        // Check-in is ALWAYS available when there is no active session!
        const canCheckIn = !activeRow;
        const canCheckOut = Boolean(activeRow);
        const canBreak = Boolean(activeRow);
        return {
            id: targetRow ? Number(targetRow.id) : null,
            sessionNumber: targetRow ? Number(targetRow.session_number) : 1,
            date,
            checkInAt: toIso(targetRow?.check_in_at ?? null),
            checkOutAt: toIso(targetRow?.check_out_at ?? null),
            status: targetRow?.status ?? (isWeeklyOff(date) ? 'weekly_off' : holiday ? 'holiday' : 'absent'),
            totalMinutes: totalWorkedMinutes,
            breakMinutes: totalBreakMinutes,
            overtimeMinutes: totalOvertimeMinutes,
            isLate: Boolean(targetRow?.is_late),
            lateMinutes,
            earlyDeparture: Boolean(targetRow?.early_departure),
            autoClosed: Boolean(targetRow?.auto_closed),
            isOnBreak: Boolean(activeRow?.open_break_start),
            breakStartedAt: toIso(activeRow?.open_break_start ?? null),
            elapsedSeconds,
            serverNow: toIso(serverNow) ?? new Date().toISOString(),
            workStart: shift.workStart,
            workEnd: shift.workEnd,
            isHoliday: Boolean(holiday),
            holidayName: holiday?.name ?? null,
            isWeeklyOff: isWeeklyOff(date),
            canCheckIn,
            canCheckOut,
            canBreak,
            sessions,
            activeSessionId: activeRow ? Number(activeRow.id) : null,
        };
    }
    static async checkIn(employeeId, input) {
        const date = today();
        const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
        const shift = await shiftConfig(emp?.location_id);
        const nowTime = localTime();
        const late = minutesOfDay(nowTime) > minutesOfDay(shift.workStart) + shift.graceMinutes;
        await transaction(async (conn) => {
            // Lock all sessions for today to check for active session and get max session_number
            const [locked] = await conn.query('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? FOR UPDATE', [
                employeeId,
                date,
            ]);
            const existing = locked;
            // Check if there's an active session (checked in but not checked out)
            const activeSession = existing.find((s) => s.check_in_at && !s.check_out_at);
            if (activeSession) {
                throw ApiError.conflict('You have already checked in. Please check out first.');
            }
            // Determine the next session number
            const maxSession = existing.length > 0 ? Math.max(...existing.map((s) => Number(s.session_number))) : 0;
            const nextSession = maxSession + 1;
            // Create new attendance session
            await conn.query(`INSERT INTO attendance (employee_id, work_date, session_number, check_in_at, status, is_late, source, notes)
         VALUES (?, ?, ?, NOW(3), ?, ?, ?, ?)`, [employeeId, date, nextSession, late ? 'late' : 'present', late ? 1 : 0, input.source ?? 'web', input.notes ?? null]);
        });
        const state = await AttendanceService.stateFor(employeeId, date);
        await recordAudit({
            actorId: employeeId,
            action: 'attendance.check_in',
            entityType: 'attendance',
            entityId: state.id,
            after: { date, checkInAt: state.checkInAt, late: state.isLate },
            ip: input.ip,
            userAgent: input.userAgent,
        });
        if (late) {
            const employee = await queryOne('SELECT manager_id, full_name FROM employees WHERE id = ?', [employeeId]);
            if (employee?.manager_id) {
                await NotificationService.notify({
                    employeeIds: [Number(employee.manager_id)],
                    type: 'attendance',
                    title: 'Late check-in',
                    body: `${employee.full_name} checked in late (${lateMinutesFor(state.checkInAt, shift)} minutes after grace period).`,
                    link: '/attendance?tab=team',
                    actorId: employeeId,
                    dedupeKey: `late:${employeeId}:${date}`,
                });
            }
        }
        emitToEmployee(employeeId, 'attendance:update', state);
        return state;
    }
    static async checkOut(employeeId, input) {
        const date = today();
        const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
        const shift = await shiftConfig(emp?.location_id);
        // Get the active session (checked in but not checked out)
        const row = await queryOne('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? AND check_in_at IS NOT NULL AND check_out_at IS NULL ORDER BY session_number DESC LIMIT 1', [employeeId, date]);
        if (!row?.check_in_at)
            throw ApiError.badRequest('You have not checked in or have already checked out.');
        await transaction(async (conn) => {
            await conn.query('UPDATE attendance_breaks SET ended_at = NOW(3), minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, started_at, NOW(3))) WHERE attendance_id = ? AND session_number = ? AND ended_at IS NULL', [row.id, row.session_number]);
            const [breakRows] = await conn.query('SELECT COALESCE(SUM(minutes), 0) AS total FROM attendance_breaks WHERE attendance_id = ? AND session_number = ?', [
                row.id,
                row.session_number,
            ]);
            const breakMinutes = Number(breakRows[0]?.total ?? 0);
            const [totals] = await conn.query('SELECT GREATEST(0, TIMESTAMPDIFF(MINUTE, check_in_at, NOW(3)) - ?) AS worked, NOW(3) AS now FROM attendance WHERE id = ?', [breakMinutes, row.id]);
            const worked = Number(totals[0]?.worked ?? 0);
            const nowLocal = localTime();
            const early = minutesOfDay(nowLocal) < minutesOfDay(shift.workEnd);
            const overtime = Math.max(0, worked - shift.overtimeAfterHours * 60);
            const halfDay = worked > 0 && worked < shift.halfDayHours * 60;
            await conn.query(`UPDATE attendance SET check_out_at = NOW(3), break_minutes = ?, total_minutes = ?, overtime_minutes = ?,
                early_departure = ?, status = ?, notes = COALESCE(?, notes)
         WHERE id = ?`, [breakMinutes, worked, overtime, early ? 1 : 0, halfDay ? 'half_day' : row.is_late ? 'late' : 'present', input.notes ?? null, row.id]);
        });
        const state = await AttendanceService.stateFor(employeeId, date);
        await recordAudit({
            actorId: employeeId,
            action: 'attendance.check_out',
            entityType: 'attendance',
            entityId: state.id,
            after: { date, checkOutAt: state.checkOutAt, totalMinutes: state.totalMinutes, breakMinutes: state.breakMinutes },
            ip: input.ip,
            userAgent: input.userAgent,
        });
        // Monitoring is only authorised during attendance: checking out ends it.
        await syncMonitoring((service) => service.endSessionsForEmployee(employeeId, 'attendance_checkout'));
        await syncCompOff(employeeId, date);
        emitToEmployee(employeeId, 'attendance:update', state);
        return state;
    }
    static async startBreak(employeeId) {
        const date = today();
        const row = await queryOne('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? AND check_in_at IS NOT NULL AND check_out_at IS NULL ORDER BY session_number DESC LIMIT 1', [employeeId, date]);
        if (!row?.check_in_at)
            throw ApiError.badRequest('Check in before starting a break.');
        if (row.check_out_at)
            throw ApiError.badRequest('Your work session is already closed.');
        const open = await queryOne('SELECT id FROM attendance_breaks WHERE attendance_id = ? AND session_number = ? AND ended_at IS NULL', [row.id, row.session_number]);
        if (open)
            throw ApiError.conflict('A break is already running.');
        await execute('INSERT INTO attendance_breaks (attendance_id, session_number, employee_id, started_at) VALUES (?, ?, ?, NOW(3))', [row.id, row.session_number, employeeId]);
        await syncMonitoring((service) => service.setBreakState(employeeId, true));
        const state = await AttendanceService.stateFor(employeeId, date);
        emitToEmployee(employeeId, 'attendance:update', state);
        return state;
    }
    static async endBreak(employeeId) {
        const date = today();
        const row = await queryOne('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? AND check_in_at IS NOT NULL AND check_out_at IS NULL ORDER BY session_number DESC LIMIT 1', [employeeId, date]);
        if (!row)
            throw ApiError.badRequest('No active attendance session for today.');
        const open = await queryOne('SELECT id FROM attendance_breaks WHERE attendance_id = ? AND session_number = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [row.id, row.session_number]);
        if (!open)
            throw ApiError.badRequest('No break is currently running.');
        await execute('UPDATE attendance_breaks SET ended_at = NOW(3), minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, started_at, NOW(3))) WHERE id = ?', [open.id]);
        await execute('UPDATE attendance SET break_minutes = (SELECT COALESCE(SUM(minutes),0) FROM attendance_breaks WHERE attendance_id = ?) WHERE id = ?', [row.id, row.id]);
        await syncMonitoring((service) => service.setBreakState(employeeId, false));
        const state = await AttendanceService.stateFor(employeeId, date);
        emitToEmployee(employeeId, 'attendance:update', state);
        return state;
    }
    /** Lightweight polling endpoint: authoritative server time + live state. */
    static async heartbeat(employeeId) {
        return AttendanceService.stateFor(employeeId);
    }
    static async history(employeeId, from, to) {
        const rows = await query(`SELECT * FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date DESC, session_number DESC`, [employeeId, from, to]);
        return rows.map((r) => ({
            id: Number(r.id),
            date: r.work_date,
            sessionNumber: Number(r.session_number),
            checkInAt: toIso(r.check_in_at),
            checkOutAt: toIso(r.check_out_at),
            status: r.status,
            totalMinutes: Number(r.total_minutes),
            breakMinutes: Number(r.break_minutes),
            overtimeMinutes: Number(r.overtime_minutes),
            isLate: Boolean(r.is_late),
            earlyDeparture: Boolean(r.early_departure),
            autoClosed: Boolean(r.auto_closed),
            source: r.source,
        }));
    }
    static async summary(employeeId, period) {
        const start = startOfMonth(`${period}-01`);
        const end = endOfMonth(start);
        const rows = await query(`SELECT status, COUNT(*) AS total, COALESCE(SUM(total_minutes),0) AS minutes, SUM(is_late) AS late
       FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? GROUP BY status`, [employeeId, start, end]);
        const holidayRows = await query(`SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ? AND location_id IS NULL`, [start, end]);
        const holidays = { total: holidayRows.length };
        const present = rows.filter((r) => ['present', 'late', 'half_day'].includes(r.status));
        const presentDays = present.reduce((sum, r) => sum + Number(r.total), 0);
        const totalMinutes = present.reduce((sum, r) => sum + Number(r.minutes), 0);
        const lateDays = rows.reduce((sum, r) => sum + Number(r.late ?? 0), 0);
        const onLeave = rows.find((r) => r.status === 'on_leave')?.total ?? 0;
        // Attendance percentage is measured against working days elapsed in the period,
        // excluding weekends and holidays, so an in-progress month is not penalised.
        const settings = await getSettings(['work_days']);
        const workDays = new Set(String(settings.work_days ?? '1,2,3,4,5,6')
            .split(',')
            .map((day) => Number(day.trim()))
            .filter((day) => Number.isFinite(day)));
        const holidaySet = new Set(holidayRows.map((row) => String(row.holiday_date).slice(0, 10)));
        const periodEnd = end < localDate() ? end : localDate();
        let elapsedWorkingDays = 0;
        for (let cursor = start; cursor <= periodEnd; cursor = addDays(cursor, 1)) {
            const weekday = new Date(`${cursor}T00:00:00Z`).getUTCDay();
            if (workDays.has(weekday) && !holidaySet.has(cursor))
                elapsedWorkingDays += 1;
        }
        const attendancePercent = elapsedWorkingDays > 0 ? Math.min(100, Math.round((presentDays / elapsedWorkingDays) * 100)) : 0;
        const sundays = sundaysBetween(start, end);
        return {
            period,
            weeklyOffCount: sundays.length,
            weeklyOffDates: sundays,
            presentDays,
            lateDays: Number(lateDays),
            halfDays: Number(rows.find((r) => r.status === 'half_day')?.total ?? 0),
            onLeaveDays: Number(onLeave),
            holidayCount: Number(holidays?.total ?? 0),
            totalMinutes: Number(totalMinutes),
            averageMinutesPerDay: presentDays > 0 ? Math.round(Number(totalMinutes) / Number(presentDays)) : 0,
            attendancePercent,
            breakdown: rows.map((r) => ({ status: r.status, count: Number(r.total), minutes: Number(r.minutes) })),
        };
    }
    static async teamToday(employeeIds) {
        if (employeeIds.length === 0)
            return [];
        const placeholders = employeeIds.map(() => '?').join(',');
        const rows = await query(`SELECT e.id AS employee_id, e.full_name, dg.title AS designation_title,
              COALESCE(a.status, 'absent') AS status, a.check_in_at, a.check_out_at, COALESCE(a.total_minutes, 0) AS total_minutes,
              COALESCE(a.break_minutes, 0) AS break_minutes, COALESCE(a.is_late, 0) AS is_late
       FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
       WHERE e.id IN (${placeholders}) AND e.status = 'active'
       ORDER BY e.full_name`, [today(), ...employeeIds]);
        const now = Date.now();
        // DATETIME columns are UTC but carry no zone marker; return ISO-8601 (with "Z") so
        // clients render the correct local (IST) time. Open sessions show worked time so far.
        return rows.map(({ break_minutes: breakMinutes, ...row }) => {
            const checkIn = parseUtc(row.check_in_at);
            const open = checkIn && !row.check_out_at;
            return {
                ...row,
                check_in_at: toIso(row.check_in_at),
                check_out_at: toIso(row.check_out_at),
                total_minutes: open
                    ? Math.max(0, Math.floor((now - checkIn.getTime()) / 60000) - Number(breakMinutes || 0))
                    : Number(row.total_minutes || 0),
            };
        });
    }
    static async requestCorrection(employeeId, input) {
        const attendance = await queryOne('SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?', [
            employeeId,
            input.workDate,
        ]);
        const result = await execute(`INSERT INTO attendance_corrections (attendance_id, employee_id, work_date, requested_check_in, requested_check_out, reason)
       VALUES (?, ?, ?, ?, ?, ?)`, [
            attendance?.id ?? null,
            employeeId,
            input.workDate,
            toSqlTimestamp(input.checkInAt),
            toSqlTimestamp(input.checkOutAt),
            input.reason?.trim() || 'Attendance correction requested',
        ]);
        await recordAudit({
            actorId: employeeId,
            action: 'attendance.correction_requested',
            entityType: 'attendance_correction',
            entityId: result.insertId,
            after: input,
            ip: input.ip,
            userAgent: input.userAgent,
        });
        return result.insertId;
    }
    static async correctionsFor(employeeIds, status) {
        const clauses = ['1 = 1'];
        const params = [];
        if (employeeIds !== null) {
            if (employeeIds.length === 0)
                return [];
            clauses.push(`c.employee_id IN (${employeeIds.map(() => '?').join(',')})`);
            params.push(...employeeIds);
        }
        if (status) {
            clauses.push('c.status = ?');
            params.push(status);
        }
        return query(`SELECT c.id, c.employee_id, e.full_name, c.work_date, c.requested_check_in, c.requested_check_out, c.reason, c.status, c.created_at
       FROM attendance_corrections c JOIN employees e ON e.id = c.employee_id
       WHERE ${clauses.join(' AND ')} ORDER BY c.created_at DESC LIMIT 100`, params);
    }
    static async reviewCorrection(correctionId, reviewer, approve, note, context) {
        const correction = await queryOne('SELECT * FROM attendance_corrections WHERE id = ?', [correctionId]);
        if (!correction)
            throw ApiError.notFound('Correction request not found');
        await assertEmployeeAccess(reviewer, correction.employee_id, 'attendance');
        if (correction.status !== 'pending')
            throw ApiError.conflict('This correction has already been reviewed.');
        if (approve) {
            const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [correction.employee_id]);
            const shift = await shiftConfig(emp?.location_id);
            await transaction(async (conn) => {
                const [existingRows] = await conn.query('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? FOR UPDATE', [
                    correction.employee_id,
                    correction.work_date,
                ]);
                const existing = existingRows[0];
                const checkIn = correction.requested_check_in ?? existing?.check_in_at ?? null;
                const checkOut = correction.requested_check_out ?? existing?.check_out_at ?? null;
                let totalMinutes = existing ? Number(existing.total_minutes) : 0;
                let overtime = 0;
                if (checkIn && checkOut) {
                    const minutes = Math.max(0, Math.floor((parseUtc(checkOut).getTime() - parseUtc(checkIn).getTime()) / 60000));
                    totalMinutes = Math.max(0, minutes - (existing ? Number(existing.break_minutes) : 0));
                    overtime = Math.max(0, totalMinutes - shift.overtimeAfterHours * 60);
                }
                const status = totalMinutes > 0 && totalMinutes < shift.halfDayHours * 60 ? 'half_day' : 'present';
                if (existing) {
                    await conn.query(`UPDATE attendance SET check_in_at = ?, check_out_at = ?, total_minutes = ?, overtime_minutes = ?,
                    status = ?, is_late = ?, source = 'correction', auto_closed = 0 WHERE id = ?`, [checkIn, checkOut, totalMinutes, overtime, status, existing.is_late, existing.id]);
                }
                else {
                    await conn.query(`INSERT INTO attendance (employee_id, work_date, check_in_at, check_out_at, total_minutes, overtime_minutes, status, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'correction')`, [correction.employee_id, correction.work_date, checkIn, checkOut, totalMinutes, overtime, status]);
                }
                await conn.query('UPDATE attendance_corrections SET status = ?, reviewed_by = ?, reviewed_at = NOW(3), review_note = ? WHERE id = ?', [approve ? 'approved' : 'rejected', reviewer.id, note ?? null, correctionId]);
            });
        }
        else {
            await execute('UPDATE attendance_corrections SET status = ?, reviewed_by = ?, reviewed_at = NOW(3), review_note = ? WHERE id = ?', ['rejected', reviewer.id, note ?? null, correctionId]);
        }
        if (approve)
            await syncCompOff(Number(correction.employee_id), String(correction.work_date));
        await recordAudit({
            actorId: reviewer.id,
            action: approve ? 'attendance.correction_approved' : 'attendance.correction_rejected',
            entityType: 'attendance_correction',
            entityId: correctionId,
            before: { status: correction.status },
            after: { status: approve ? 'approved' : 'rejected', note },
            ip: context.ip,
            userAgent: context.userAgent,
        });
        await NotificationService.notify({
            employeeIds: [Number(correction.employee_id)],
            type: 'attendance',
            title: approve ? 'Attendance correction approved' : 'Attendance correction rejected',
            body: `Your correction request for ${correction.work_date} was ${approve ? 'approved' : 'rejected'}${note ? `: ${note}` : '.'}`,
            link: '/attendance',
            priority: 'high',
            actorId: reviewer.id,
            dedupeKey: `correction:${correctionId}:${approve ? 'approved' : 'rejected'}`,
        });
    }
    /** Closes sessions left open past the grace window. Never silently edits history: marks auto_closed and audits. */
    static async autoCloseStaleSessions(graceHours = 16) {
        const rows = await query(`SELECT id, employee_id, work_date FROM attendance
       WHERE check_in_at IS NOT NULL AND check_out_at IS NULL
         AND check_in_at < DATE_SUB(NOW(3), INTERVAL ? HOUR)`, [graceHours]);
        for (const row of rows) {
            await execute(`UPDATE attendance SET check_out_at = check_in_at + INTERVAL (COALESCE(total_minutes,0) + COALESCE(break_minutes,0)) MINUTE,
                auto_closed = 1, notes = CONCAT(COALESCE(notes, ''), ' [auto-closed: missing checkout]')
         WHERE id = ?`, [row.id]);
            await recordAudit({
                actorId: null,
                action: 'attendance.auto_closed',
                entityType: 'attendance',
                entityId: Number(row.id),
                after: { reason: 'missing_checkout', graceHours },
            });
            await syncMonitoring((service) => service.endSessionsForEmployee(Number(row.employee_id), 'attendance_autoclosed'));
            await syncCompOff(Number(row.employee_id), String(row.work_date));
            await NotificationService.notify({
                employeeIds: [Number(row.employee_id)],
                type: 'attendance',
                title: 'Missing check-out detected',
                body: `Your attendance for ${row.work_date} was closed automatically. Submit a correction request if your hours are wrong.`,
                link: '/attendance',
                priority: 'high',
                dedupeKey: `auto_closed:${row.employee_id}:${row.work_date}`,
            });
        }
        return rows.length;
    }
    /** Marks approved leave days so dashboards and KPI attendance stay accurate. */
    static async markLeaveRange(employeeId, startDate, endDate, halfDayOptions) {
        const start = String(startDate).slice(0, 10);
        const end = String(endDate).slice(0, 10);
        // Sundays and public holidays inside a leave range stay weekly offs / holidays:
        // they are not leave days and were not charged to the balance.
        const holidays = await WeeklyOffService.employeeHolidays(employeeId, start, end);
        const weeklyOffDay = await WeeklyOffService.employeeWeekday(employeeId);
        const total = daysBetween(start, end);
        const isHalf = Boolean(halfDayOptions?.isHalfDay);
        const slotText = halfDayOptions?.halfDaySlot === 'second_half' ? 'Second Half' : 'First Half';
        const status = isHalf ? 'half_day' : 'on_leave';
        const note = isHalf ? `Approved half-day leave (${slotText})` : 'Approved leave';
        for (let i = 0; i <= total; i += 1) {
            const date = addDays(start, i);
            if (isWeeklyOff(date, weeklyOffDay) || holidays.has(date))
                continue;
            await execute(`INSERT INTO attendance (employee_id, work_date, status, notes)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = IF(check_in_at IS NULL, VALUES(status), status), notes = VALUES(notes)`, [employeeId, date, status, note]);
        }
    }
    /** Hours actually worked across a range, used by KPI and reporting. */
    static async workedMinutes(employeeId, from, to) {
        const row = await queryOne('SELECT COALESCE(SUM(total_minutes),0) AS total FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?', [employeeId, from, to]);
        return Number(row?.total ?? 0);
    }
}
//# sourceMappingURL=AttendanceService.js.map