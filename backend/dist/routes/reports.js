import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { DailyReportService } from '../services/DailyReportService.js';
export const reportsRouter = Router();
reportsRouter.use(authenticate);
reportsRouter.get('/suggestions', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await DailyReportService.suggestions(user.id, req.query.date ? String(req.query.date) : undefined));
}));
reportsRouter.get('/today', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ report: await DailyReportService.todayStatus(user.id) });
}));
// Compliance & Missing EOD Inspector
reportsRouter.get('/compliance', requireAny('reports.view.own', 'reports.view.team', 'reports.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const date = req.query.date ? String(req.query.date) : undefined;
    const locationId = req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined;
    const departmentId = req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined;
    res.json(await DailyReportService.compliance(user, { date, locationId, departmentId }));
}));
// Trigger missing report reminders
reportsRouter.post('/remind', requireAny('reports.review', 'reports.view.all'), asyncHandler(async (_req, res) => {
    const reminded = await DailyReportService.remindMissing();
    res.json({ ok: true, reminded });
}));
// Export Excel
reportsRouter.get('/export/excel', requireAny('reports.view.team', 'reports.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    const locationId = req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined;
    const buffer = await DailyReportService.exportExcel(user, { from, to, locationId });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="BSC_HRMS_EOD_Reports_${Date.now()}.xlsx"`);
    res.send(Buffer.from(buffer));
}));
// Export PDF
reportsRouter.get('/export/pdf', requireAny('reports.view.team', 'reports.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    const locationId = req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined;
    const pdfBuffer = await DailyReportService.exportPdf(user, { from, to, locationId });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="BSC_HRMS_EOD_Reports_${Date.now()}.pdf"`);
    res.send(pdfBuffer);
}));
reportsRouter.get('/', requireAny('reports.view.own', 'reports.view.team', 'reports.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await DailyReportService.list(user, {
        employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
        locationId: req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
    }));
}));
reportsRouter.post('/', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        summary: z.string().min(10).max(8000),
        problems: z.string().max(4000).optional(),
        supportRequired: z.string().max(4000).optional(),
        supportDeptId: z.number().int().positive().optional(),
        supportManagerId: z.number().int().positive().optional(),
        tomorrowPlan: z.string().max(4000).optional(),
        workStart: z.string().max(8).optional(),
        workEnd: z.string().max(8).optional(),
        totalMinutes: z.number().int().min(0).max(1440).optional(),
        tasksCompleted: z.number().int().min(0).optional(),
        tasksInProgress: z.number().int().min(0).optional(),
        tasksPending: z.number().int().min(0).optional(),
        attachmentIds: z.array(z.number().int().positive()).optional(),
    }), req.body);
    const result = await DailyReportService.submit(user.id, body, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(201).json(result);
}));
reportsRouter.get('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    res.json(await DailyReportService.detail(id, currentUser(req)));
}));
reportsRouter.put('/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({
        summary: z.string().min(10).max(8000).optional(),
        problems: z.string().max(4000).optional(),
        supportRequired: z.string().max(4000).optional(),
        supportDeptId: z.number().int().positive().optional(),
        supportManagerId: z.number().int().positive().optional(),
        tomorrowPlan: z.string().max(4000).optional(),
        workStart: z.string().max(8).optional(),
        workEnd: z.string().max(8).optional(),
        totalMinutes: z.number().int().min(0).max(1440).optional(),
        tasksCompleted: z.number().int().min(0).optional(),
        tasksInProgress: z.number().int().min(0).optional(),
        tasksPending: z.number().int().min(0).optional(),
        status: z.enum(['submitted', 'approved', 'changes_requested']).optional(),
        reviewNote: z.string().max(1000).optional(),
    }), req.body);
    const result = await DailyReportService.update(id, user, body, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.json(result);
}));
reportsRouter.post('/:id/review', requireAny('reports.review'), asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ approve: z.boolean(), note: z.string().max(1000).optional() }), req.body);
    await DailyReportService.review(id, user, body, {
        ip: clientIp(req),
        userAgent: req.get('user-agent') ?? undefined,
    });
    res.json({ ok: true });
}));
//# sourceMappingURL=reports.js.map