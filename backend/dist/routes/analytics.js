import { Router } from 'express';
import { asyncHandler, intParam } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { KpiService } from '../services/KpiService.js';
import { today } from '../lib/dates.js';
export const analyticsRouter = Router();
analyticsRouter.use(authenticate, requireAny('analytics.view', 'analytics.view.all', 'admin.dashboard'));
analyticsRouter.get('/overview', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json(await AnalyticsService.overview(user, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        departmentId: req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined,
        designationId: req.query.designationId ? intParam(String(req.query.designationId), 'designationId') : undefined,
        locationId: req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined,
        managerId: req.query.managerId ? intParam(String(req.query.managerId), 'managerId') : undefined,
    }));
}));
analyticsRouter.get('/employee/:id/performance', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const period = String(req.query.period ?? today().slice(0, 7));
    res.json(await AnalyticsService.employeePerformance(id, period));
}));
analyticsRouter.get('/kpi/departments', asyncHandler(async (req, res) => {
    const period = String(req.query.period ?? today().slice(0, 7));
    res.json({ period, departments: await KpiService.departmentAverages(period) });
}));
//# sourceMappingURL=analytics.js.map