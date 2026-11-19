import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { EmployeeService } from '../services/EmployeeService.js';
import { recordAudit } from '../lib/audit.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const employeesRouter = Router();
employeesRouter.use(authenticate);

const designationSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  code: z.string().trim().min(2).max(32).optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  level: z.number().int().min(1).max(20).optional(),
  reportingDesignationId: z.number().int().positive().nullable().optional(),
  employmentCategory: z.enum(['leadership', 'management', 'professional', 'staff', 'contract', 'intern']).optional(),
  description: z.string().max(255).nullable().optional(),
  locationIds: z.array(z.number().int().positive()).max(50).optional(),
});

employeesRouter.get(
  '/picker',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json({ employees: await EmployeeService.picker(user.id) });
  }),
);

employeesRouter.get(
  '/hierarchy',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ employees: await EmployeeService.hierarchy(currentUser(req)) });
  }),
);

employeesRouter.get(
  '/structure',
  asyncHandler(async (_req, res) => {
    res.json(await EmployeeService.structure());
  }),
);

employeesRouter.get(
  '/roles',
  asyncHandler(async (_req, res) => {
    res.json(await EmployeeService.rolePermissions());
  }),
);

employeesRouter.get(
  '/allowed-locations',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json({ locations: await EmployeeService.getUserAllowedLocations(user) });
  }),
);

employeesRouter.get(
  '/',
  requireAny('employees.view.own', 'employees.view.team', 'employees.view.all'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(
      await EmployeeService.list(user, {
        search: req.query.search ? String(req.query.search) : undefined,
        departmentId: req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined,
        designationId: req.query.designationId ? intParam(String(req.query.designationId), 'designationId') : undefined,
        locationId: req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined,
        groupId: req.query.groupId ? intParam(String(req.query.groupId), 'groupId') : undefined,
        managerId: req.query.managerId ? intParam(String(req.query.managerId), 'managerId') : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        roleId: req.query.roleId ? intParam(String(req.query.roleId), 'roleId') : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 25,
      }),
    );
  }),
);

employeesRouter.post(
  '/',
  requireAny('employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        fullName: z.string().min(2).max(160),
        email: z.string().email(),
        mobile: z.string().trim().regex(/^[0-9]{10}$/, 'Mobile number must be exactly 10 digits'),
        employeeCode: z.string().max(24).optional(),
        roleId: z.number().int().positive(),
        departmentId: z.number().int().positive(),
        designationId: z.number().int().positive().nullable().optional(),
        managerId: z.number().int().positive().nullable().optional(),
        locationId: z.number().int().positive().nullable().optional(),
        groupId: z.number().int().positive().nullable().optional(),
        teamLeaderId: z.number().int().positive().nullable().optional(),
        employmentType: z.string().max(32).optional(),
        password: z.string().min(10).max(200),
      }),
      req.body,
    );
    res.status(201).json(
      await EmployeeService.createByAdmin(user, body, {
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
      }),
    );
  }),
);

employeesRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json(await EmployeeService.detail(id, currentUser(req)));
  }),
);

employeesRouter.patch(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        fullName: z.string().min(2).max(160).optional(),
        mobile: z.string().trim().regex(/^[0-9]{10}$/, 'Mobile number must be exactly 10 digits').optional(),
        address: z.string().max(255).optional(),
        emergencyContact: z.string().max(64).optional(),
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        photoUrl: z.string().max(255).optional(),
      }),
      req.body,
    );
    await EmployeeService.update(id, user, body);
    res.json({ ok: true });
  }),
);

employeesRouter.patch(
  '/:id/org-assignment',
  requireAny('employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        roleId: z.number().int().positive().optional(),
        departmentId: z.number().int().positive().nullable().optional(),
        designationId: z.number().int().positive().nullable().optional(),
        managerId: z.number().int().positive().nullable().optional(),
        locationId: z.number().int().positive().nullable().optional(),
        groupId: z.number().int().positive().nullable().optional(),
        teamLeaderId: z.number().int().positive().nullable().optional(),
        employmentType: z.string().max(32).optional(),
      }),
      req.body,
    );
    await EmployeeService.updateOrgAssignment(id, user, body);
    res.json({ ok: true });
  }),
);

employeesRouter.post(
  '/:id/transfer',
  requireAny('employees.manage', 'employees.transfer'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        locationId: z.number().int().positive(),
        groupId: z.number().int().positive().nullable().optional(),
        teamLeaderId: z.number().int().positive().nullable().optional(),
        reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    await EmployeeService.transferLocation(user, id, body, {
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.json({ ok: true });
  }),
);

employeesRouter.post(
  '/:id/approve',
  requireAny('employees.approve', 'employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        roleId: z.number().int().positive().optional(),
        departmentId: z.number().int().positive().optional(),
        designationId: z.number().int().positive().optional(),
        managerId: z.number().int().positive().optional(),
        locationId: z.number().int().positive().optional(),
      }),
      req.body,
    );
    await EmployeeService.approveRegistration(id, user, body);
    res.json({ ok: true });
  }),
);

employeesRouter.post(
  '/:id/reject',
  requireAny('employees.approve', 'employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().min(5).max(500) }), req.body);
    await EmployeeService.rejectRegistration(id, user, body.reason);
    res.json({ ok: true });
  }),
);

employeesRouter.post(
  '/:id/status',
  requireAny('employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ status: z.enum(['active', 'inactive']), reason: z.string().max(500).optional() }), req.body);
    await EmployeeService.setStatus(id, user, body.status, body.reason);
    res.json({ ok: true });
  }),
);

employeesRouter.delete(
  '/:id',
  requireAny('employees.delete', 'employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    const result = await EmployeeService.remove(id, user, body.reason);
    res.json({ ok: true, ...result });
  }),
);

employeesRouter.put(
  '/roles/:id/permissions',
  requireAny('roles.manage', 'roles.edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ permissionIds: z.array(z.number().int().positive()) }), req.body);
    await EmployeeService.updateRolePermissions(id, user, body.permissionIds);
    res.json({ ok: true });
  }),
);

employeesRouter.post(
  '/roles',
  requireAny('roles.manage', 'roles.create', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({ name: z.string().min(2).max(120), slug: z.string().min(2).max(80), category: z.string().max(64).optional(), level: z.number().int().min(1).max(100).optional(), description: z.string().max(255).optional() }),
      req.body,
    );
    res.status(201).json({ id: await EmployeeService.createRole(user, body) });
  }),
);

employeesRouter.patch(
  '/roles/:id',
  requireAny('roles.manage', 'roles.edit', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({ name: z.string().min(2).max(120).optional(), slug: z.string().min(2).max(80).optional(), description: z.string().max(255).optional(), level: z.number().int().min(1).max(100).optional() }),
      req.body,
    );
    await EmployeeService.updateRoleDetails(user, id, body);
    res.json({ ok: true });
  }),
);

employeesRouter.delete(
  '/roles/:id',
  requireAny('roles.manage', 'roles.delete', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const raw = req.query.moveTo ?? (req.body as { moveToRoleId?: unknown } | undefined)?.moveToRoleId;
    const moveTo = raw === undefined || raw === '' ? undefined : Number(raw);
    if (moveTo !== undefined && (!Number.isInteger(moveTo) || moveTo <= 0)) throw ApiError.badRequest('Invalid target replacement role.');
    res.json(await EmployeeService.deleteRole(currentUser(req), intParam(req.params.id), moveTo, clientIp(req)));
  }),
);

employeesRouter.post(
  '/roles/:id/duplicate',
  requireAny('roles.manage', 'roles.create', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    res.status(201).json(await EmployeeService.duplicateRole(user, id, clientIp(req)));
  }),
);

employeesRouter.get(
  '/roles/audit-logs',
  requireAny('roles.manage', 'roles.view', 'audit.view', 'admin.dashboard'),
  asyncHandler(async (_req: AuthedRequest, res) => {
    res.json({ logs: await EmployeeService.getPermissionAuditLogs() });
  }),
);

employeesRouter.get(
  '/roles/:id/employees',
  requireAny('roles.manage', 'roles.view', 'org.manage', 'employees.manage', 'employees.view.all'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json({ employees: await EmployeeService.getRoleEmployees(id) });
  }),
);

employeesRouter.post(
  '/roles/:id/employees',
  requireAny('roles.manage', 'roles.edit', 'org.manage', 'employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ employeeId: z.number().int().positive() }), req.body);
    res.json(await EmployeeService.assignEmployeeToRole(user, id, body.employeeId, clientIp(req)));
  }),
);

employeesRouter.delete(
  '/roles/:id/employees/:employeeId',
  requireAny('roles.manage', 'roles.edit', 'org.manage', 'employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const roleId = intParam(req.params.id);
    const employeeId = intParam(req.params.employeeId);
    const user = currentUser(req);
    res.json(await EmployeeService.unassignEmployeeFromRole(user, roleId, employeeId, undefined, clientIp(req)));
  }),
);

employeesRouter.get(
  '/roles/:id/locations',
  requireAny('roles.manage', 'roles.view', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    res.json({ locationIds: await EmployeeService.getRoleLocations(id) });
  }),
);

employeesRouter.put(
  '/roles/:id/locations',
  requireAny('roles.manage', 'roles.edit', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ locationIds: z.array(z.number().int().positive()) }), req.body);
    const updated = await EmployeeService.setRoleLocations(user, id, body.locationIds, clientIp(req));
    res.json({ locationIds: updated });
  }),
);

employeesRouter.post(
  '/:id/permissions',
  requireAny('roles.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(
      z.object({ permissionId: z.number().int().positive(), effect: z.enum(['grant', 'deny', 'clear']) }),
      req.body,
    );
    await EmployeeService.setUserPermission(id, user, body.permissionId, body.effect);
    res.json({ ok: true });
  }),
);

employeesRouter.post(
  '/departments',
  requireAny('org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({ name: z.string().min(2).max(120), code: z.string().min(2).max(24), description: z.string().max(255).optional(), headEmployeeId: z.number().int().positive().nullable().optional() }),
      req.body,
    );
    const id = await EmployeeService.createDepartment(user, body);
    await recordAudit({ actorId: user.id, action: 'department.created', entityType: 'department', entityId: id, after: body, ip: clientIp(req) });
    res.status(201).json({ id });
  }),
);

employeesRouter.post(
  '/designations',
  requireAny('org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(designationSchema.extend({ title: z.string().trim().min(2).max(120) }), req.body);
    res.status(201).json({ id: await EmployeeService.createDesignation(user, body) });
  }),
);

employeesRouter.patch(
  '/designations/:id',
  requireAny('org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(designationSchema.extend({ isActive: z.boolean().optional() }), req.body);
    await EmployeeService.updateDesignation(currentUser(req), intParam(req.params.id), body);
    res.json({ ok: true });
  }),
);

employeesRouter.get(
  '/designations/:id/history',
  requireAny('org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ history: await EmployeeService.designationHistory(intParam(req.params.id)) });
  }),
);

employeesRouter.patch(
  '/locations/:id',
  requireAny('locations.manage', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        code: z.string().trim().min(2).max(12).optional(),
        city: z.string().max(80).nullable().optional(),
        state: z.string().max(80).nullable().optional(),
        address: z.string().max(255).nullable().optional(),
        timezone: z.string().max(64).optional(),
        latitude: z.number().min(-90).max(90).nullable().optional(),
        longitude: z.number().min(-180).max(180).nullable().optional(),
        geofenceRadiusM: z.number().int().min(50).max(5000).nullable().optional(),
        isActive: z.boolean().optional(),
      }),
      req.body,
    );
    await EmployeeService.updateLocation(currentUser(req), intParam(req.params.id), body);
    res.json({ ok: true });
  }),
);

employeesRouter.get(
  '/:id/locations',
  requireAny('org.manage', 'employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ locationIds: await EmployeeService.employeeLocations(intParam(req.params.id)) });
  }),
);

employeesRouter.put(
  '/:id/locations',
  requireAny('org.manage', 'employees.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(z.object({ locationIds: z.array(z.number().int().positive()).max(50) }), req.body);
    res.json({ locationIds: await EmployeeService.setEmployeeLocations(currentUser(req), intParam(req.params.id), body.locationIds) });
  }),
);

employeesRouter.delete(
  '/locations/:id',
  requireAny('locations.manage', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const raw = req.query.moveTo ?? (req.body as { moveToLocationId?: unknown } | undefined)?.moveToLocationId;
    const moveTo = raw === undefined || raw === '' ? undefined : Number(raw);
    if (moveTo !== undefined && (!Number.isInteger(moveTo) || moveTo <= 0)) throw ApiError.badRequest('Invalid target location.');
    res.json(await EmployeeService.deleteLocation(currentUser(req), intParam(req.params.id), moveTo, clientIp(req)));
  }),
);

employeesRouter.post(
  '/locations',
  requireAny('locations.manage', 'org.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(120),
        code: z.string().trim().min(2).max(12),
        city: z.string().max(80).optional(),
        state: z.string().max(80).optional(),
        address: z.string().max(255).optional(),
        timezone: z.string().max(64).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        geofenceRadiusM: z.number().int().min(50).max(5000).optional(),
      }),
      req.body,
    );
    res.status(201).json({ id: await EmployeeService.createLocation(user, body) });
  }),
);
