import { execute, query, queryOne, transaction } from '../db/index.js';
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
async function shiftConfig(locationId) {
    const s = await getSettings(SETTING_KEYS);
    let workStart = s.work_start_time || '09:30';
    let workEnd = s.work_end_time || '18:30';
    let graceMinutes = Number(s.late_grace_minutes || 10);
    if (locationId) {
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
    return {
        workStart,
        workEnd,
        graceMinutes,
        halfDayHours: Number(s.half_day_hours || 4),
        fullDayHours: Number(s.full_day_hours || 9),
        overtimeAfterHours: Number(s.overtime_after_hours || 9),
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
    if (!Number.isInteger(h.graceMinutes) || h.graceMinutes < 0 || h.graceMinutes > 120)
        throw ApiError.badRequest(`${label}: grace must be 0–120 minutes.`);
}
/**
 * Office (login / logout) hours: one company default plus optional per-location
 * hours. These drive the Late badge at check-in and early-departure at check-out.
 */
export const OfficeHoursService = {
    async get() {
        const s = await getSettings(['work_start_time', 'work_end_time', 'late_grace_minutes']);
        const def = {
            workStart: s.work_start_time || '09:30',
            workEnd: s.work_end_time || '18:30',
            graceMinutes: Number(s.late_grace_minutes || 10),
        };
        const locations = await query('SELECT id, code, name FROM locations WHERE is_active = 1 ORDER BY name');
        const rows = await Promise.all(locations.map(async (l) => {
            const effective = await shiftConfig(Number(l.id));
            const own = effective.workStart !== def.workStart || effective.workEnd !== def.workEnd || effective.graceMinutes !== def.graceMinutes;
            return {
                locationId: Number(l.id),
                code: l.code,
                name: l.name,
                workStart: effective.workStart,
                workEnd: effective.workEnd,
                graceMinutes: effective.graceMinutes,
                usesDefault: !own,
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
        await transaction(async (conn) => {
            const put = (key, value) => conn.query(`INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`, [key, value, actor.id]);
            if (input.default) {
                await put('work_start_time', input.default.workStart);
                await put('work_end_time', input.default.workEnd);
                await put('late_grace_minutes', String(input.default.graceMinutes));
            }
            if (input.locations?.length) {
                // The older JSON map takes precedence over per-location keys; drop the
                // edited locations from it so the values saved here are the ones used.
                const [jsonRows] = await conn.query("SELECT setting_value FROM system_settings WHERE setting_key = 'location_shifts_json' FOR UPDATE");
                const raw = jsonRows[0]?.setting_value;
                let map = {};
                try {
                    map = raw ? JSON.parse(raw) : {};
                }
                catch {
                    map = {};
                }
                for (const loc of input.locations) {
                    delete map[String(loc.locationId)];
                    const keys = [`loc_work_start_${loc.locationId}`, `loc_work_end_${loc.locationId}`, `loc_grace_${loc.locationId}`];
                    if (loc.inherit) {
                        await conn.query('DELETE FROM system_settings WHERE setting_key IN (?, ?, ?)', keys);
                    }
                    else {
                        await put(keys[0], loc.workStart);
                        await put(keys[1], loc.workEnd);
                        await put(keys[2], String(loc.graceMinutes));
                    }
                }
                if (raw !== undefined && raw !== null)
                    await put('location_shifts_json', JSON.stringify(map));
            }
        });
        const after = await OfficeHoursService.get();
        await recordAudit({ actorId: actor.id, action: 'office_hours.updated', entityType: 'system_settings', before, after, ip });
        return after;
    },
};
export class AttendanceService {
    static async stateFor(employeeId, date = today()) {
        const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
        const shift = await shiftConfig(emp?.location_id);
        const row = await queryOne(`SELECT a.*, NOW(3) AS server_now,
              (SELECT b.id FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.ended_at IS NULL ORDER BY b.id DESC LIMIT 1) AS open_break_id,
              (SELECT b.started_at FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.ended_at IS NULL ORDER BY b.id DESC LIMIT 1) AS open_break_start
       FROM attendance a WHERE a.employee_id = ? AND a.work_date = ?`, [employeeId, date]);
        const holiday = await queryOne(`SELECT h.name FROM holidays h
       WHERE h.holiday_date = ?
         AND (h.location_id IS NULL OR h.location_id = (SELECT location_id FROM employees WHERE id = ?))
       LIMIT 1`, [date, employeeId]);
        const serverNow = row?.server_now ?? (await queryOne('SELECT NOW(3) AS now'))?.now ?? localDate();
        let elapsedSeconds = 0;
        if (row?.check_in_at) {
            const checkIn = parseUtc(row.check_in_at).getTime();
            const end = row.check_out_at ? parseUtc(row.check_out_at).getTime() : parseUtc(serverNow).getTime();
            const breakMs = Number(row.break_minutes) * 60000;
            const openBreakMs = row.open_break_start ? parseUtc(serverNow).getTime() - parseUtc(row.open_break_start).getTime() : 0;
            elapsedSeconds = Math.max(0, Math.floor((end - checkIn - breakMs - openBreakMs) / 1000));
        }
        const lateMinutes = row?.check_in_at ? lateMinutesFor(row.check_in_at, shift) : 0;
        return {
            id: row ? Number(row.id) : null,
            date,
            checkInAt: toIso(row?.check_in_at ?? null),
            checkOutAt: toIso(row?.check_out_at ?? null),
            status: row?.status ?? (isWeeklyOff(date) ? 'weekly_off' : holiday ? 'holiday' : 'absent'),
            totalMinutes: row ? Number(row.total_minutes) : 0,
            breakMinutes: row ? Number(row.break_minutes) : 0,
            overtimeMinutes: row ? Number(row.overtime_minutes) : 0,
            isLate: Boolean(row?.is_late),
            lateMinutes,
            earlyDeparture: Boolean(row?.early_departure),
            autoClosed: Boolean(row?.auto_closed),
            isOnBreak: Boolean(row?.open_break_start),
            breakStartedAt: toIso(row?.open_break_start ?? null),
            elapsedSeconds,
            serverNow: toIso(serverNow) ?? new Date().toISOString(),
            workStart: shift.workStart,
            workEnd: shift.workEnd,
            isHoliday: Boolean(holiday),
            holidayName: holiday?.name ?? null,
            isWeeklyOff: isWeeklyOff(date),
            canCheckIn: !row?.check_in_at,
            canCheckOut: Boolean(row?.check_in_at) && !row?.check_out_at,
            canBreak: Boolean(row?.check_in_at) && !row?.check_out_at,
        };
    }
    static async checkIn(employeeId, input) {
        const date = today();
        const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
        const shift = await shiftConfig(emp?.location_id);
        const nowTime = localTime();
        const late = minutesOfDay(nowTime) > minutesOfDay(shift.workStart) + shift.graceMinutes;
        await transaction(async (conn) => {
            const [locked] = await conn.query('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ? FOR UPDATE', [
                employeeId,
                date,
            ]);
            const existing = locked[0];
            if (existing?.check_in_at) {
                throw ApiError.conflict('You have already checked in for today.');
            }
            if (existing) {
                await conn.query(`UPDATE attendance SET check_in_at = NOW(3), status = ?, is_late = ?, source = ?, notes = ?, auto_closed = 0
           WHERE id = ?`, [late ? 'late' : 'present', late ? 1 : 0, input.source ?? 'web', input.notes ?? null, existing.id]);
            }
            else {
                await conn.query(`INSERT INTO attendance (employee_id, work_date, check_in_at, status, is_late, source, notes)
           VALUES (?, ?, NOW(3), ?, ?, ?, ?)`, [employeeId, date, late ? 'late' : 'present', late ? 1 : 0, input.source ?? 'web', input.notes ?? null]);
            }
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
        const row = await queryOne('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, date]);
        if (!row?.check_in_at)
            throw ApiError.badRequest('You have not checked in today.');
        if (row.check_out_at)
            throw ApiError.conflict('You have already checked out today.');
        await transaction(async (conn) => {
            await conn.query('UPDATE attendance_breaks SET ended_at = NOW(3), minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, started_at, NOW(3))) WHERE attendance_id = ? AND ended_at IS NULL', [row.id]);
            const [breakRows] = await conn.query('SELECT COALESCE(SUM(minutes), 0) AS total FROM attendance_breaks WHERE attendance_id = ?', [
                row.id,
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
        const row = await queryOne('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, date]);
        if (!row?.check_in_at)
            throw ApiError.badRequest('Check in before starting a break.');
        if (row.check_out_at)
            throw ApiError.badRequest('Your work day is already closed.');
        const open = await queryOne('SELECT id FROM attendance_breaks WHERE attendance_id = ? AND ended_at IS NULL', [row.id]);
        if (open)
            throw ApiError.conflict('A break is already running.');
        await execute('INSERT INTO attendance_breaks (attendance_id, employee_id, started_at) VALUES (?, ?, NOW(3))', [row.id, employeeId]);
        await syncMonitoring((service) => service.setBreakState(employeeId, true));
        const state = await AttendanceService.stateFor(employeeId, date);
        emitToEmployee(employeeId, 'attendance:update', state);
        return state;
    }
    static async endBreak(employeeId) {
        const date = today();
        const row = await queryOne('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, date]);
        if (!row)
            throw ApiError.badRequest('No attendance record for today.');
        const open = await queryOne('SELECT id FROM attendance_breaks WHERE attendance_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [row.id]);
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
        const rows = await query(`SELECT * FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date DESC`, [employeeId, from, to]);
        return rows.map((r) => ({
            id: Number(r.id),
            date: r.work_date,
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
        return query(`SELECT e.id AS employee_id, e.full_name, dg.title AS designation_title,
              COALESCE(a.status, 'absent') AS status, a.check_in_at, a.check_out_at, COALESCE(a.total_minutes, 0) AS total_minutes,
              COALESCE(a.is_late, 0) AS is_late
       FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
       WHERE e.id IN (${placeholders}) AND e.status = 'active'
       ORDER BY e.full_name`, [today(), ...employeeIds]);
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