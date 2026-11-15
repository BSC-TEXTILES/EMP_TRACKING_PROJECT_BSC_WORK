import { Router } from 'express';
import { asyncHandler, intParam } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { ExportService } from '../services/ExportService.js';
export const exportsRouter = Router();
exportsRouter.use(authenticate);
const VALID_TYPES = ['attendance', 'tasks', 'kpi', 'tickets', 'leave', 'daily-reports', 'employees', 'collections'];
const VALID_FORMATS = ['csv', 'xlsx', 'pdf'];
exportsRouter.get('/', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const type = String(req.query.type ?? '');
    const format = String(req.query.format ?? 'csv');
    if (!VALID_TYPES.includes(type)) {
        res.status(400).json({ error: 'Unsupported report type', code: 'bad_request' });
        return;
    }
    if (!VALID_FORMATS.includes(format)) {
        res.status(400).json({ error: 'Unsupported format', code: 'bad_request' });
        return;
    }
    const file = await ExportService.build(type, format, user, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        departmentId: req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined,
        employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
        period: req.query.period ? String(req.query.period) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        locationId: req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined,
    });
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.buffer);
}));
//# sourceMappingURL=exports.js.map