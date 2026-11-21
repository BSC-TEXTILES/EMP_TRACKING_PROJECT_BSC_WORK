import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { LeaveService } from '../services/LeaveService.js';
import { assertEmployeeAccess, locationEmployeeIds } from '../lib/scope.js';
import { WeeklyOffService } from '../services/WeeklyOffService.js';
import type { AuthUser } from '../services/AuthService.js';
import { addDays, endOfMonth, startOfMonth, today } from '../lib/dates.js';

/**
 * Own data always; a manager's reporting subtree; HR / admins org-wide. In every
 * non-own case the employee must also be in one of the viewer's locations (BEL / DAV / SHI).
 */
async function assertLeaveAccess(user: AuthUser, employeeId: number): Promise<void> {
  await assertEmployeeAccess(user, employeeId, 'leave');
  if (employeeId === user.id) return;
  const located = await locationEmployeeIds(user);
  if (located !== null && !located.includes(employeeId)) throw ApiError.forbidden('This employee belongs to a location outside your access.');
}

function yearMonthFrom(query: Record<string, unknown>): { year: number; month: number } {
  const now = today();
  const year = query.year !== undefined ? Number(query.year) : Number(now.slice(0, 4));
  const month = query.month !== undefined ? Number(query.month) : Number(now.slice(5, 7));
  return { year, month };
}
import type { AuthedRequest } from '../middleware/auth.js';

export const leaveRouter = Router();
leaveRouter.use(authenticate);
leaveRouter.get('/application-context', asyncHandler(async (req: AuthedRequest, res) => {
  res.json(await LeaveService.applicationContext(currentUser(req).id));
}));

leaveRouter.get(
  '/types',
  asyncHandler(async (_req, res) => {
    res.json({ types: await LeaveService.types() });
  }),
);

leaveRouter.get(
  '/balances',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    await assertLeaveAccess(user, employeeId);
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    res.json({ balances: await LeaveService.balancesForAdmin(employeeId, year), year });
  }),
);

leaveRouter.get(
  '/holidays',
  asyncHandler(async (req: AuthedRequest, res) => {
    const from = String(req.query.from ?? startOfMonth(today()));
    const to = String(req.query.to ?? endOfMonth(addDays(today(), 120)));
    res.json({ holidays: await LeaveService.holidays(from, to, currentUser(req).id) });
  }),
);

// ------------------------------------------------ calendar-based weekly offs

/** One employee's month: Sundays, weekly offs allocated / taken / remaining, day calendar, balances. */
leaveRouter.get(
  '/weekly-offs',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    await assertLeaveAccess(user, employeeId);
    const { year, month } = yearMonthFrom(req.query);
    const summary = await WeeklyOffService.monthSummary(employeeId, year, month);
    const balances = await LeaveService.balances(employeeId, year);
    res.json({ ...summary, balances });
  }),
);

/** Managers (own team) and HR / admins (their locations): weekly-off counters per employee. */
leaveRouter.get(
  '/weekly-offs/team',
  requireAny('leave.view.team', 'leave.view.all'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const { year, month } = yearMonthFrom(req.query);
    const locationId = req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : null;
    res.json(await WeeklyOffService.teamSummary(user, year, month, locationId));
  }),
);

/** Comp-off credits earned by working Sundays / holidays. */
leaveRouter.get(
  '/comp-off',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const employeeId = req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : user.id;
    await assertLeaveAccess(user, employeeId);
    res.json({ totals: await WeeklyOffService.compOffTotals(employeeId), credits: await WeeklyOffService.compOffCredits(employeeId) });
  }),
);

/** How many days a range would charge (Sundays and holidays excluded) before applying. */
leaveRouter.get(
  '/preview',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const startDate = String(req.query.startDate ?? '');
    const endDate = String(req.query.endDate ?? startDate);
    const isHalfDay = req.query.isHalfDay === 'true' || req.query.isHalfDay === '1';
    let code: string | null = null;
    if (req.query.leaveTypeId) {
      const types = await LeaveService.types();
      code = types.find((type) => Number(type.id) === Number(req.query.leaveTypeId))?.code ?? null;
    }
    res.json(await LeaveService.dayBreakdown(user.id, startDate, endDate, code, isHalfDay));
  }),
);

leaveRouter.get(
  '/policy',
  asyncHandler(async (_req, res) => {
    res.json({ policy: await WeeklyOffService.policy() });
  }),
);

leaveRouter.put(
  '/policy',
  requireAny('leave.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(
      z.object({
        compOffEnabled: z.boolean(),
        compOffOnHolidays: z.boolean(),
        compOffFullDayMinutes: z.number().int().min(60).max(1440),
        compOffHalfDayMinutes: z.number().int().min(0).max(1439),
        compOffExpiryDays: z.number().int().min(0).max(730),
      }),
      req.body,
    );
    res.json({ policy: await WeeklyOffService.updatePolicy(currentUser(req), body) });
  }),
);

leaveRouter.get(
  '/',
  requireAny('leave.view.own', 'leave.view.team', 'leave.view.all'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(
      await LeaveService.list(user, {
        status: req.query.status ? String(req.query.status) : undefined,
        scope: (req.query.scope as 'mine' | 'team' | 'all' | undefined) ?? 'mine',
        employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
      }),
    );
  }),
);

leaveRouter.post(
  '/',
  requireAny('leave.apply'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        hrApproverId: z.number().int().positive().optional(),
        leaveTypeId: z.number().int().positive(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().min(10).max(2000),
        documentFileId: z.number().int().positive().nullable().optional(),
        isHalfDay: z.boolean().optional(),
        halfDaySlot: z.enum(['first_half', 'second_half']).optional(),
      }),
      req.body,
    );
    const result = await LeaveService.apply(user.id, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(result);
  }),
);

leaveRouter.post(
  '/:id/decide',
  requireAny('leave.approve.manager', 'leave.approve.hr'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({ approve: z.boolean(), note: z.string().max(500).optional(), stage: z.enum(['manager', 'hr']) }),
      req.body,
    );
    await LeaveService.decide(id, user, body, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json({ ok: true });
  }),
);

leaveRouter.post(
  '/:id/cancel',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    await LeaveService.cancel(id, user.id);
    res.json({ ok: true });
  }),
);
