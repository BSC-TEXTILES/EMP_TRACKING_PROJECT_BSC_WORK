import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { HrService } from '../services/HrService.js';
export const hrRouter = Router();
hrRouter.use(authenticate);
// HR Dashboard Metrics
hrRouter.get('/dashboard', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'reports.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const data = await HrService.getDashboard(user, locationId);
    res.json(data);
}));
// Employee Documents Management
hrRouter.get('/documents', requireAny('employees.view.all', 'employees.view.team', 'employees.manage', 'employees.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const data = await HrService.listDocuments({
        employeeId: req.query.employeeId ? Number(req.query.employeeId) : undefined,
        locationId: req.query.locationId ? Number(req.query.locationId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        documentType: req.query.documentType ? String(req.query.documentType) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
    }, user);
    res.json({ documents: data });
}));
hrRouter.post('/documents', requireAny('employees.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        employeeId: z.number().int().positive(),
        documentType: z.string().min(2).max(50),
        title: z.string().min(2).max(255),
        fileUrl: z.string().min(2).max(500),
        fileSizeBytes: z.number().int().nonnegative().optional(),
        fileType: z.string().max(100).optional(),
        notes: z.string().max(500).optional(),
    }), req.body);
    const result = await HrService.uploadDocument(user, body);
    res.status(201).json(result);
}));
hrRouter.patch('/documents/:id/verify', requireAny('employees.manage'), asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({
        status: z.enum(['verified', 'rejected']),
        notes: z.string().max(500).optional(),
    }), req.body);
    res.json(await HrService.verifyDocument(id, user, body.status, body.notes));
}));
hrRouter.delete('/documents/:id', requireAny('employees.manage'), asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    res.json(await HrService.deleteDocument(id, user));
}));
// Employee Salaries Management
hrRouter.get('/salaries', requireAny('employees.manage', 'org.manage', 'employees.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const data = await HrService.listSalaries({
        employeeId: req.query.employeeId ? Number(req.query.employeeId) : undefined,
        locationId: req.query.locationId ? Number(req.query.locationId) : undefined,
        departmentId: req.query.departmentId ? Number(req.query.departmentId) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
    }, user);
    res.json({ salaries: data });
}));
hrRouter.put('/salaries/:employeeId', requireAny('employees.manage', 'org.manage'), asyncHandler(async (req, res) => {
    const employeeId = intParam(req.params.employeeId);
    const user = currentUser(req);
    const body = parseBody(z.object({
        basicSalary: z.number().nonnegative(),
        hra: z.number().nonnegative().optional(),
        specialAllowance: z.number().nonnegative().optional(),
        conveyanceAllowance: z.number().nonnegative().optional(),
        medicalAllowance: z.number().nonnegative().optional(),
        epfDeduction: z.number().nonnegative().optional(),
        esiDeduction: z.number().nonnegative().optional(),
        professionalTax: z.number().nonnegative().optional(),
        tdsDeduction: z.number().nonnegative().optional(),
        bankName: z.string().max(100).optional(),
        bankAccountNo: z.string().max(50).optional(),
        bankIfsc: z.string().max(20).optional(),
        panNumber: z.string().max(20).optional(),
        uanNumber: z.string().max(30).optional(),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.body);
    res.json(await HrService.updateSalary(employeeId, body, user));
}));
// Monthly Payroll Management
hrRouter.get('/payroll', requireAny('employees.manage', 'org.manage', 'employees.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const now = new Date();
    const month = req.query.month ? Number(req.query.month) : now.getMonth() + 1;
    const year = req.query.year ? Number(req.query.year) : now.getFullYear();
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const paymentStatus = req.query.paymentStatus ? String(req.query.paymentStatus) : undefined;
    const data = await HrService.listPayrollRecords({ month, year, locationId, employeeId, paymentStatus }, user);
    res.json(data);
}));
hrRouter.post('/payroll/generate', requireAny('employees.manage', 'org.manage'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2020).max(2050),
        locationId: z.number().int().positive().optional(),
    }), req.body);
    const result = await HrService.generateMonthlyPayroll(body.month, body.year, user, body.locationId);
    res.json(result);
}));
hrRouter.patch('/payroll/:id/status', requireAny('employees.manage', 'org.manage'), asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({
        paymentStatus: z.enum(['draft', 'processed', 'paid', 'on_hold']),
        referenceNo: z.string().max(60).optional(),
        notes: z.string().max(500).optional(),
    }), req.body);
    res.json(await HrService.updatePayrollStatus(id, body, user));
}));
//# sourceMappingURL=hr.js.map