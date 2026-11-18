import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, hasPermission, requireAny } from '../middleware/auth.js';
import { AttendanceService, OfficeHoursService } from '../services/AttendanceService.js';
import { assertEmployeeAccess, locationEmployeeIds, visibleEmployeeIds } from '../lib/scope.js';
import { addDays, endOfMonth, periodOf, startOfMonth, today } from '../lib/dates.js';
import { LeaveService } from '../services/LeaveService.js';
import { query } from '../db/index.js';
export const attendanceRouter = Router();
attendanceRouter.use(authenticate);
/** Office (login / logout) hours: company default and per location. Everyone can read them. */
attendanceRouter.get('/office-hours', asyncHandler(async (req, res) => {
    res.json({ ...(await OfficeHoursService.get()), canEdit: hasPermission(currentUser(req), 'settings.manage') });
}));
const hoursSchema = z.object({
    workStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    workEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    graceMinutes: z.number().int().min(0).max(120),
});
attendanceRouter.put('/office-hours', requireAny('settings.manage'), asyncHandler(async (req, res) => {
    const body = parseBody(z.object({
        default: hoursSchema.optional(),
        locations: z.array(z.union([
            z.object({ locationId: z.number().int().positive(), inherit: z.literal(true) }),
            hoursSchema.extend({ locationId: z.number().int().positive(), inherit: z.literal(false).optional() }),
        ])).max(100).optional(),
    }), req.body);
    res.json({ ...(await OfficeHoursService.set(currentUser(req), body, clientIp(req))), canEdit: true });
}));
attendanceRouter.get('/today', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await AttendanceService.stateFor(user.id));
}));
attendanceRouter.get('/heartbeat', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await AttendanceService.stateFor(user.id));
}));
attendanceRouter.post('/check-in', requireAny('attendance.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        notes: z.string().max(255).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
    }), req.body);
    const state = await AttendanceService.checkIn(user.id, {
        notes: body.notes,
        latitude: body.latitude,
        longitude: body.longitude,
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
        source: 'web',
    });
    res.status(201).json(state);
}));
attendanceRouter.post('/check-out', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const state = await AttendanceService.checkOut(user.id, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.json(state);
}));
attendanceRouter.post('/break/start', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await AttendanceService.startBreak(user.id));
}));
attendanceRouter.post('/break/end', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await AttendanceService.endBreak(user.id));
}));
attendanceRouter.get('/history', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    await assertEmployeeAccess(user, employeeId, 'attendance');
    const to = String(req.query.to ?? today());
    const from = String(req.query.from ?? addDays(to, -30));
    res.json({ records: await AttendanceService.history(employeeId, from, to), from, to });
}));
attendanceRouter.get('/summary', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    await assertEmployeeAccess(user, employeeId, 'attendance');
    const period = String(req.query.period ?? periodOf(today()));
    const summary = await AttendanceService.summary(employeeId, period);
    const presentTarget = summary.presentDays + Number(summary.onLeaveDays) + summary.holidayCount;
    res.json({ ...summary, attendancePercent: presentTarget > 0 ? Math.round((summary.presentDays / presentTarget) * 100) : 0 });
}));
attendanceRouter.get('/team', requireAny('attendance.view.team', 'attendance.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ids = await visibleEmployeeIds(user, 'attendance');
    let employeeIds;
    if (ids === null) {
        const rows = await query("SELECT id FROM employees WHERE status = 'active'");
        employeeIds = rows.map((r) => Number(r.id));
    }
    else {
        employeeIds = ids;
    }
    res.json({ records: await AttendanceService.teamToday(employeeIds), scope: ids === null ? 'all' : 'team' });
}));
attendanceRouter.post('/corrections', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        checkInAt: z.string().optional(),
        checkOutAt: z.string().optional(),
        reason: z.string().min(10).max(2000),
    }), req.body);
    if (body.workDate > today())
        throw ApiError.badRequest('Corrections can only be requested for past or present dates.');
    const id = await AttendanceService.requestCorrection(user.id, {
        ...body,
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json({ id });
}));
attendanceRouter.get('/corrections', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const scopeAll = hasPermission(user, 'attendance.corrections.approve') || hasPermission(user, 'attendance.view.all');
    const ids = scopeAll ? await locationEmployeeIds(user) : [user.id];
    const rows = await AttendanceService.correctionsFor(ids, req.query.status ? String(req.query.status) : undefined);
    res.json({ records: rows });
}));
attendanceRouter.post('/corrections/:id/review', requireAny('attendance.corrections.approve'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(z.object({ approve: z.boolean(), note: z.string().max(255).optional() }), req.body);
    await AttendanceService.reviewCorrection(id, user, body.approve, body.note, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.json({ ok: true });
}));
attendanceRouter.get('/holidays', asyncHandler(async (req, res) => {
    const to = String(req.query.to ?? endOfMonth(startOfMonth(today())));
    const from = String(req.query.from ?? startOfMonth(today()));
    res.json({ holidays: await LeaveService.holidays(from, to) });
}));
//# sourceMappingURL=attendance.js.map