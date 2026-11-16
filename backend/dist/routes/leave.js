import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { LeaveService } from '../services/LeaveService.js';
import { assertEmployeeAccess } from '../lib/scope.js';
import { addDays, endOfMonth, startOfMonth, today } from '../lib/dates.js';
export const leaveRouter = Router();
leaveRouter.use(authenticate);
leaveRouter.get('/types', asyncHandler(async (_req, res) => {
    res.json({ types: await LeaveService.types() });
}));
leaveRouter.get('/balances', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    await assertEmployeeAccess(user, employeeId, 'leave');
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    res.json({ balances: await LeaveService.balancesForAdmin(employeeId, year), year });
}));
leaveRouter.get('/holidays', asyncHandler(async (req, res) => {
    const from = String(req.query.from ?? startOfMonth(today()));
    const to = String(req.query.to ?? endOfMonth(addDays(today(), 120)));
    res.json({ holidays: await LeaveService.holidays(from, to) });
}));
leaveRouter.get('/', requireAny('leave.view.own', 'leave.view.team', 'leave.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await LeaveService.list(user, {
        status: req.query.status ? String(req.query.status) : undefined,
        scope: req.query.scope ?? 'mine',
        employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
    }));
}));
leaveRouter.post('/', requireAny('leave.apply'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        leaveTypeId: z.number().int().positive(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().min(10).max(2000),
        documentFileId: z.number().int().positive().nullable().optional(),
    }), req.body);
    const result = await LeaveService.apply(user.id, body, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(result);
}));
leaveRouter.post('/:id/decide', requireAny('leave.approve.manager', 'leave.approve.hr'), asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ approve: z.boolean(), note: z.string().max(500).optional(), stage: z.enum(['manager', 'hr']) }), req.body);
    await LeaveService.decide(id, user, body, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.json({ ok: true });
}));
leaveRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    await LeaveService.cancel(id, user.id);
    res.json({ ok: true });
}));
//# sourceMappingURL=leave.js.map