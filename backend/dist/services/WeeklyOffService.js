import { execute, query, queryOne } from '../db/index.js';
import { getSettings, recordAudit, setSetting } from '../lib/audit.js';
import { MONTH_NAMES, dateRange, datesInMonth, daysInMonth, isLeapYear, isWeeklyOff, isoDate, sundaysInMonth, weekdayOf, } from '../lib/calendar.js';
import { addDays, today } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { allowedLocationIds, locationEmployeeIds, subtreeIds } from '../lib/scope.js';
import { emitToEmployee, getIO } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
const POLICY_KEYS = {
    compOffEnabled: 'leave_policy.comp_off_enabled',
    compOffOnHolidays: 'leave_policy.comp_off_on_holidays',
    compOffFullDayMinutes: 'leave_policy.comp_off_full_minutes',
    compOffHalfDayMinutes: 'leave_policy.comp_off_half_minutes',
    compOffExpiryDays: 'leave_policy.comp_off_expiry_days',
};
const DEFAULT_POLICY = {
    compOffEnabled: true,
    compOffOnHolidays: true,
    compOffFullDayMinutes: 360,
    compOffHalfDayMinutes: 180,
    compOffExpiryDays: 90,
};
function toInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}
function toBool(value, fallback) {
    if (value === undefined || value === '')
        return fallback;
    return value === '1' || value === 'true';
}
export function assertYearMonth(year, month) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
        throw ApiError.badRequest('Select a year between 2000 and 2100.');
    if (!Number.isInteger(month) || month < 1 || month > 12)
        throw ApiError.badRequest('Select a month between 1 and 12.');
}
export class WeeklyOffService {
    // ------------------------------------------------------------------ policy
    static async policy() {
        const raw = await getSettings(Object.values(POLICY_KEYS));
        return {
            compOffEnabled: toBool(raw[POLICY_KEYS.compOffEnabled], DEFAULT_POLICY.compOffEnabled),
            compOffOnHolidays: toBool(raw[POLICY_KEYS.compOffOnHolidays], DEFAULT_POLICY.compOffOnHolidays),
            compOffFullDayMinutes: toInt(raw[POLICY_KEYS.compOffFullDayMinutes], DEFAULT_POLICY.compOffFullDayMinutes),
            compOffHalfDayMinutes: toInt(raw[POLICY_KEYS.compOffHalfDayMinutes], DEFAULT_POLICY.compOffHalfDayMinutes),
            compOffExpiryDays: toInt(raw[POLICY_KEYS.compOffExpiryDays], DEFAULT_POLICY.compOffExpiryDays),
        };
    }
    /** Super Admin / HR only (permission `leave.manage`). */
    static async updatePolicy(actor, input) {
        if (!actor.permissions.includes('leave.manage'))
            throw ApiError.forbidden('Only HR or a Super Admin can change the leave policy.');
        if (input.compOffFullDayMinutes < 60 || input.compOffFullDayMinutes > 1440) {
            throw ApiError.badRequest('Full-day comp-off threshold must be between 60 and 1440 minutes.');
        }
        if (input.compOffHalfDayMinutes < 0 || input.compOffHalfDayMinutes >= input.compOffFullDayMinutes) {
            throw ApiError.badRequest('Half-day threshold must be 0 (disabled) or less than the full-day threshold.');
        }
        if (input.compOffExpiryDays < 0 || input.compOffExpiryDays > 730)
            throw ApiError.badRequest('Comp-off expiry must be between 0 and 730 days.');
        const before = await WeeklyOffService.policy();
        await setSetting(POLICY_KEYS.compOffEnabled, input.compOffEnabled ? '1' : '0', actor.id);
        await setSetting(POLICY_KEYS.compOffOnHolidays, input.compOffOnHolidays ? '1' : '0', actor.id);
        await setSetting(POLICY_KEYS.compOffFullDayMinutes, String(input.compOffFullDayMinutes), actor.id);
        await setSetting(POLICY_KEYS.compOffHalfDayMinutes, String(input.compOffHalfDayMinutes), actor.id);
        await setSetting(POLICY_KEYS.compOffExpiryDays, String(input.compOffExpiryDays), actor.id);
        await recordAudit({ actorId: actor.id, action: 'leave.policy_updated', entityType: 'leave_policy', entityId: null, before, after: input });
        const after = await WeeklyOffService.policy();
        getIO()?.emit('leave:policy', after);
        return after;
    }
    // ---------------------------------------------------------------- holidays
    /** Public holidays that apply to the employee (organisation-wide or their own location). */
    static async employeeHolidays(employeeId, from, to) {
        const rows = await query(`SELECT h.holiday_date, h.name FROM holidays h
       WHERE h.holiday_date BETWEEN ? AND ?
         AND (h.location_id IS NULL OR h.location_id = (SELECT location_id FROM employees WHERE id = ?))
       ORDER BY h.holiday_date, h.id`, [from, to, employeeId]);
        const map = new Map();
        for (const row of rows) {
            const date = String(row.holiday_date).slice(0, 10);
            // Two entries on the same date are shown once (no duplicate holiday).
            map.set(date, map.has(date) ? `${map.get(date)} / ${row.name}` : row.name);
        }
        return map;
    }
    // ---------------------------------------------------------------- comp-off
    /** Comp-off balance across years (credits do not reset on 1 January; they expire by policy). */
    static async compOffTotals(employeeId) {
        const credits = await queryOne(`SELECT SUM(days - expired_days) AS earned FROM comp_off_credits WHERE employee_id = ? AND status IN ('earned', 'expired')`, [employeeId]);
        const ledger = await queryOne(`SELECT SUM(b.allocated) AS manual, SUM(b.used) AS used
       FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
       WHERE b.employee_id = ? AND t.code = 'CO'`, [employeeId]);
        const earned = Number(credits?.earned ?? 0);
        const manual = Number(ledger?.manual ?? 0);
        const used = Number(ledger?.used ?? 0);
        const allocated = earned + manual;
        return { earned, manual, allocated, used, available: Math.max(0, allocated - used) };
    }
    static async compOffCredits(employeeId, limit = 50) {
        const rows = await query(`SELECT id, work_date, source, worked_minutes, days, expired_days, status, expires_on, note
       FROM comp_off_credits WHERE employee_id = ? ORDER BY work_date DESC LIMIT ${Math.min(200, Math.max(1, limit))}`, [employeeId]);
        return rows.map((row) => ({
            id: Number(row.id),
            workDate: String(row.work_date).slice(0, 10),
            source: row.source,
            workedMinutes: Number(row.worked_minutes),
            days: Number(row.days),
            expiredDays: Number(row.expired_days),
            status: row.status,
            expiresOn: row.expires_on ? String(row.expires_on).slice(0, 10) : null,
            note: row.note,
        }));
    }
    /**
     * Re-evaluates the comp-off credit for one employee-day from the attendance row.
     * Idempotent: safe to call after check-out, correction approval, auto-close and
     * from the nightly reconciliation. Never creates a second credit for the same day.
     */
    static async syncCompOff(employeeId, workDate) {
        const date = workDate.slice(0, 10);
        const policy = await WeeklyOffService.policy();
        if (!policy.compOffEnabled)
            return;
        let source = null;
        if (isWeeklyOff(date))
            source = 'sunday';
        else if (policy.compOffOnHolidays && (await WeeklyOffService.employeeHolidays(employeeId, date, date)).has(date))
            source = 'holiday';
        const existing = await queryOne('SELECT id, days, status FROM comp_off_credits WHERE employee_id = ? AND work_date = ?', [employeeId, date]);
        if (!source)
            return;
        const attendance = await queryOne('SELECT id, total_minutes, check_in_at, check_out_at FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, date]);
        if (attendance?.check_in_at && !attendance.check_out_at)
            return; // still working: decide at check-out
        const minutes = Number(attendance?.total_minutes ?? 0);
        const days = minutes >= policy.compOffFullDayMinutes ? 1 : policy.compOffHalfDayMinutes > 0 && minutes >= policy.compOffHalfDayMinutes ? 0.5 : 0;
        const expiresOn = policy.compOffExpiryDays > 0 ? addDays(date, policy.compOffExpiryDays) : null;
        const label = source === 'sunday' ? 'Sunday weekly off' : 'public holiday';
        if (!existing) {
            if (days === 0)
                return;
            const result = await execute(`INSERT IGNORE INTO comp_off_credits (employee_id, work_date, source, attendance_id, worked_minutes, days, expires_on, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [employeeId, date, source, attendance?.id ?? null, minutes, days, expiresOn, `Worked on ${label}`]);
            if (result.affectedRows) {
                await recordAudit({ actorId: null, action: 'leave.comp_off_credited', entityType: 'comp_off_credit', entityId: result.insertId, after: { employeeId, date, source, minutes, days } });
                await NotificationService.notify({
                    employeeIds: [employeeId],
                    type: 'leave',
                    title: 'Compensatory off credited',
                    body: `You worked on a ${label} (${date}). ${days === 1 ? '1 day' : 'Half a day'} of comp-off was added${expiresOn ? `, usable until ${expiresOn}` : ''}.`,
                    link: '/leave',
                    dedupeKey: `comp_off:${employeeId}:${date}`,
                });
                emitToEmployee(employeeId, 'leave:updated', { reason: 'comp_off', date });
            }
            return;
        }
        if (existing.status === 'expired')
            return; // history is never rewritten after expiry
        const currentDays = existing.status === 'revoked' ? 0 : Number(existing.days);
        if (currentDays === days)
            return;
        if (days === 0) {
            await execute("UPDATE comp_off_credits SET status = 'revoked', worked_minutes = ?, note = ? WHERE id = ?", [minutes, 'Worked time below the comp-off threshold after attendance update', existing.id]);
        }
        else {
            await execute("UPDATE comp_off_credits SET status = 'earned', days = ?, worked_minutes = ?, attendance_id = ?, note = ? WHERE id = ?", [days, minutes, attendance?.id ?? null, `Worked on ${label} (updated)`, existing.id]);
        }
        await recordAudit({ actorId: null, action: 'leave.comp_off_adjusted', entityType: 'comp_off_credit', entityId: Number(existing.id), before: { days: currentDays }, after: { days, minutes } });
        emitToEmployee(employeeId, 'leave:updated', { reason: 'comp_off', date });
    }
    /** Nightly catch-up so a missed hook (crash, manual DB fix) still credits comp-offs. */
    static async reconcileRecent(days = 7) {
        const from = addDays(today(), -days);
        const rows = await query(`SELECT a.employee_id, a.work_date FROM attendance a
       WHERE a.work_date >= ? AND a.check_in_at IS NOT NULL AND a.check_out_at IS NOT NULL
         AND (DAYOFWEEK(a.work_date) = 1 OR EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = a.work_date)
              OR EXISTS (SELECT 1 FROM comp_off_credits c WHERE c.employee_id = a.employee_id AND c.work_date = a.work_date))`, [from]);
        for (const row of rows) {
            try {
                await WeeklyOffService.syncCompOff(Number(row.employee_id), String(row.work_date));
            }
            catch (error) {
                console.error('[comp-off] reconcile failed', row, error);
            }
        }
        return rows.length;
    }
    /**
     * Lapses unused comp-off past its expiry. Usage is applied oldest-credit-first, so
     * only the part of an expired credit that was never used is lapsed.
     */
    static async expireCompOffs() {
        const due = await query("SELECT DISTINCT employee_id FROM comp_off_credits WHERE status = 'earned' AND expires_on IS NOT NULL AND expires_on < ?", [today()]);
        let lapsed = 0;
        for (const { employee_id } of due) {
            const employeeId = Number(employee_id);
            const totals = await WeeklyOffService.compOffTotals(employeeId);
            let remainingUsed = totals.used;
            const credits = await query("SELECT id, days, expired_days, status, expires_on FROM comp_off_credits WHERE employee_id = ? AND status IN ('earned','expired') ORDER BY work_date, id", [employeeId]);
            for (const credit of credits) {
                const net = Number(credit.days) - Number(credit.expired_days);
                const consumed = Math.min(net, Math.max(0, remainingUsed));
                remainingUsed -= consumed;
                if (credit.status !== 'earned' || !credit.expires_on || String(credit.expires_on).slice(0, 10) >= today())
                    continue;
                const unused = net - consumed;
                await execute("UPDATE comp_off_credits SET status = 'expired', expired_days = expired_days + ? WHERE id = ? AND status = 'earned'", [unused, credit.id]);
                if (unused > 0)
                    lapsed += 1;
            }
            emitToEmployee(employeeId, 'leave:updated', { reason: 'comp_off_expired' });
        }
        return lapsed;
    }
    // ------------------------------------------------------------- summaries
    static async employee(employeeId) {
        const row = await queryOne(`SELECT e.id, e.full_name, e.employee_code, e.joining_date, e.deactivated_at, e.location_id,
              l.name AS location_name, l.code AS location_code, d.name AS department_name
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`, [employeeId]);
        if (!row)
            throw ApiError.notFound('Employee not found');
        return row;
    }
    /** Full month view for one employee: Sundays, weekly-off counters and a day-by-day calendar. */
    static async monthSummary(employeeId, year, month) {
        assertYearMonth(year, month);
        const employee = await WeeklyOffService.employee(employeeId);
        const start = isoDate(year, month, 1);
        const end = isoDate(year, month, daysInMonth(year, month));
        const now = today();
        const [holidays, attendanceRows, leaveRows, credits, policy] = await Promise.all([
            WeeklyOffService.employeeHolidays(employeeId, start, end),
            query('SELECT work_date, status, check_in_at, total_minutes FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?', [employeeId, start, end]),
            query(`SELECT l.start_date, l.end_date, t.name AS type_name, t.code, l.status, l.is_half_day, l.half_day_slot
         FROM leave_requests l JOIN leave_types t ON t.id = l.leave_type_id
         WHERE l.employee_id = ? AND l.status IN ('approved','pending_manager','pending_hr') AND l.start_date <= ? AND l.end_date >= ?`, [employeeId, end, start]),
            query('SELECT work_date, days, status FROM comp_off_credits WHERE employee_id = ? AND work_date BETWEEN ? AND ?', [employeeId, start, end]),
            WeeklyOffService.policy(),
        ]);
        const attendance = new Map(attendanceRows.map((row) => [String(row.work_date).slice(0, 10), row]));
        const creditByDate = new Map(credits.map((row) => [String(row.work_date).slice(0, 10), row]));
        const leaveByDate = new Map();
        for (const leave of leaveRows) {
            const from = String(leave.start_date).slice(0, 10) < start ? start : String(leave.start_date).slice(0, 10);
            const to = String(leave.end_date).slice(0, 10) > end ? end : String(leave.end_date).slice(0, 10);
            for (const date of dateRange(from, to)) {
                if (!leaveByDate.has(date) || leave.status === 'approved') {
                    leaveByDate.set(date, {
                        type: leave.type_name,
                        code: leave.code,
                        status: leave.status,
                        isHalfDay: Boolean(leave.is_half_day),
                        halfDaySlot: leave.half_day_slot ?? null,
                    });
                }
            }
        }
        const joining = employee.joining_date ? String(employee.joining_date).slice(0, 10) : null;
        const exit = employee.deactivated_at ? String(employee.deactivated_at).slice(0, 10) : null;
        const allSundays = sundaysInMonth(year, month);
        // Active employees are entitled to all weekly offs in the month
        const eligible = new Set(allSundays.filter((date) => !exit || date <= exit.slice(0, 10)));
        const sundays = allSundays.map((date) => {
            const row = attendance.get(date);
            const worked = Boolean(row?.check_in_at);
            const status = !eligible.has(date) ? 'not_eligible' : worked ? 'worked' : date <= now ? 'taken' : 'upcoming';
            const credit = creditByDate.get(date);
            return {
                date,
                day: Number(date.slice(8, 10)),
                status,
                holidayName: holidays.get(date) ?? null,
                workedMinutes: worked ? Number(row?.total_minutes ?? 0) : 0,
                compOffDays: credit && credit.status !== 'revoked' ? Number(credit.days) : 0,
            };
        });
        const days = datesInMonth(year, month).map((date) => {
            const row = attendance.get(date);
            const leave = leaveByDate.get(date) ?? null;
            const weeklyOff = isWeeklyOff(date);
            const holidayName = holidays.get(date) ?? null;
            const credit = creditByDate.get(date);
            const isHalfDay = Boolean(row?.status === 'half_day' || leave?.isHalfDay);
            return {
                date,
                day: Number(date.slice(8, 10)),
                weekday: weekdayOf(date),
                isWeeklyOff: weeklyOff,
                isEligibleWeeklyOff: weeklyOff && eligible.has(date),
                holidayName,
                isToday: date === now,
                isFuture: date > now,
                attendanceStatus: row ? row.status : null,
                worked: Boolean(row?.check_in_at),
                workedMinutes: Number(row?.total_minutes ?? 0),
                isHalfDay,
                halfDaySlot: leave?.halfDaySlot ?? null,
                // Leave never "consumes" a Sunday or holiday, so those days do not show the leave.
                leave: leave && !weeklyOff && !holidayName ? leave : null,
                compOffDays: credit && credit.status !== 'revoked' ? Number(credit.days) : 0,
            };
        });
        const count = (status) => sundays.filter((item) => item.status === status).length;
        const holidaysOnWorkdays = [...holidays.keys()].filter((date) => !isWeeklyOff(date)).length;
        const compOff = await WeeklyOffService.compOffTotals(employeeId);
        return {
            employee: {
                id: Number(employee.id),
                name: employee.full_name,
                code: employee.employee_code,
                joiningDate: joining,
                locationId: employee.location_id ? Number(employee.location_id) : null,
                locationName: employee.location_name,
                locationCode: employee.location_code,
                departmentName: employee.department_name,
            },
            year,
            month,
            monthName: MONTH_NAMES[month - 1],
            daysInMonth: daysInMonth(year, month),
            isLeapYear: isLeapYear(year),
            firstWeekday: weekdayOf(start),
            today: now,
            totalSundays: allSundays.length,
            weeklyOffs: {
                allocated: eligible.size,
                taken: count('taken'),
                worked: count('worked'),
                remaining: count('upcoming'),
                notEligible: count('not_eligible'),
            },
            publicHolidays: [...holidays.entries()].map(([date, name]) => ({ date, name, onWeeklyOff: isWeeklyOff(date) })),
            workingDays: daysInMonth(year, month) - allSundays.length - holidaysOnWorkdays,
            leaveDaysThisMonth: days.filter((day) => day.leave?.status === 'approved').length,
            compOff: {
                earnedThisMonth: credits.filter((row) => row.status !== 'revoked').reduce((sum, row) => sum + Number(row.days), 0),
                ...compOff,
            },
            policy,
            sundays,
            days,
        };
    }
    /** Employees whose weekly-off and leave details the user may see, with location scoping (BEL / DAV / SHI). */
    static async visibleEmployees(user, locationId) {
        let ids;
        if (user.permissions.includes('leave.view.all')) {
            ids = await locationEmployeeIds(user);
        }
        else if (user.permissions.includes('leave.view.team')) {
            const team = await subtreeIds(user.id);
            const located = await locationEmployeeIds(user);
            ids = located === null ? team : team.filter((id) => located.includes(id));
        }
        else {
            throw ApiError.forbidden('You can only view your own weekly offs.');
        }
        if (locationId) {
            const allowed = await allowedLocationIds(user);
            if (allowed !== null && !allowed.includes(locationId))
                throw ApiError.forbidden('That location is outside your access.');
        }
        if (ids !== null && ids.length === 0)
            return [];
        const clauses = ["e.status = 'active'"];
        const params = [];
        if (ids !== null) {
            clauses.push(`e.id IN (${ids.map(() => '?').join(',')})`);
            params.push(...ids);
        }
        if (locationId) {
            clauses.push('e.location_id = ?');
            params.push(locationId);
        }
        return query(`SELECT e.id, e.full_name, e.employee_code, e.joining_date, e.deactivated_at, e.location_id,
              l.name AS location_name, l.code AS location_code, d.name AS department_name
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY l.code, e.full_name
       LIMIT 1000`, params);
    }
    /** Manager / HR view: weekly-off counters for every visible employee in a month. */
    static async teamSummary(user, year, month, locationId) {
        assertYearMonth(year, month);
        const employees = await WeeklyOffService.visibleEmployees(user, locationId);
        const start = isoDate(year, month, 1);
        const end = isoDate(year, month, daysInMonth(year, month));
        const allSundays = sundaysInMonth(year, month);
        const now = today();
        if (employees.length === 0) {
            return { year, month, monthName: MONTH_NAMES[month - 1], totalSundays: allSundays.length, sundays: allSundays, employees: [] };
        }
        const ids = employees.map((employee) => Number(employee.id));
        const placeholders = ids.map(() => '?').join(',');
        const [worked, leaveDays, credits, coLedger] = await Promise.all([
            query(`SELECT employee_id, work_date FROM attendance
         WHERE employee_id IN (${placeholders}) AND work_date BETWEEN ? AND ? AND DAYOFWEEK(work_date) = 1 AND check_in_at IS NOT NULL`, [...ids, start, end]),
            query(`SELECT employee_id, COUNT(*) AS total FROM attendance
         WHERE employee_id IN (${placeholders}) AND work_date BETWEEN ? AND ? AND status = 'on_leave' AND DAYOFWEEK(work_date) <> 1
         GROUP BY employee_id`, [...ids, start, end]),
            query(`SELECT employee_id, SUM(days - expired_days) AS earned FROM comp_off_credits
         WHERE employee_id IN (${placeholders}) AND status IN ('earned','expired') GROUP BY employee_id`, ids),
            query(`SELECT b.employee_id, SUM(b.allocated) AS manual, SUM(b.used) AS used
         FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
         WHERE b.employee_id IN (${placeholders}) AND t.code = 'CO' GROUP BY b.employee_id`, ids),
        ]);
        const workedSet = new Set(worked.map((row) => `${row.employee_id}:${String(row.work_date).slice(0, 10)}`));
        const leaveMap = new Map(leaveDays.map((row) => [Number(row.employee_id), Number(row.total)]));
        const earnedMap = new Map(credits.map((row) => [Number(row.employee_id), Number(row.earned ?? 0)]));
        const ledgerMap = new Map(coLedger.map((row) => [Number(row.employee_id), row]));
        return {
            year,
            month,
            monthName: MONTH_NAMES[month - 1],
            totalSundays: allSundays.length,
            sundays: allSundays,
            employees: employees.map((employee) => {
                const id = Number(employee.id);
                const eligible = allSundays.filter((date) => !employee.deactivated_at || date <= String(employee.deactivated_at).slice(0, 10));
                let taken = 0;
                let workedCount = 0;
                let remaining = 0;
                for (const date of eligible) {
                    if (workedSet.has(`${id}:${date}`))
                        workedCount += 1;
                    else if (date <= now)
                        taken += 1;
                    else
                        remaining += 1;
                }
                const ledger = ledgerMap.get(id);
                const allocatedCo = (earnedMap.get(id) ?? 0) + Number(ledger?.manual ?? 0);
                return {
                    employeeId: id,
                    name: employee.full_name,
                    code: employee.employee_code,
                    locationCode: employee.location_code,
                    locationName: employee.location_name,
                    departmentName: employee.department_name,
                    allocated: eligible.length,
                    taken,
                    worked: workedCount,
                    remaining,
                    leaveDaysThisMonth: leaveMap.get(id) ?? 0,
                    compOffAvailable: Math.max(0, allocatedCo - Number(ledger?.used ?? 0)),
                };
            }),
        };
    }
}
//# sourceMappingURL=WeeklyOffService.js.map