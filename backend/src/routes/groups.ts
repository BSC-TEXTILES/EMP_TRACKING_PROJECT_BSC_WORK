import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireAny, type AuthedRequest } from '../middleware/auth.js';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { GroupService, type GroupMemberRow, type GroupRow } from '../services/GroupService.js';

/*
 * Response shapes. The service returns database rows (snake_case); the web app
 * (Groups and Employees pages) reads camelCase under `items` / `group` /
 * `members` / `summary` / `logs`. The raw rows used to be sent as-is, so those
 * pages received undefined lists and crashed ("Cannot read properties of
 * undefined (reading 'map')").
 */
function groupDto(g: GroupRow) {
  return {
    id: Number(g.id),
    locationId: Number(g.location_id),
    code: g.code ?? '',
    name: g.name,
    description: g.description,
    managerId: g.manager_id === null ? null : Number(g.manager_id),
    teamLeaderId: g.team_leader_id === null ? null : Number(g.team_leader_id),
    isActive: Boolean(Number(g.is_active)),
    locationName: g.location_name,
    locationCode: g.location_code,
    managerName: g.manager_name,
    managerCode: g.manager_code,
    teamLeaderName: g.team_leader_name,
    teamLeaderCode: g.team_leader_code,
    memberCount: Number(g.member_count ?? 0),
    presentTodayCount: Number(g.present_count ?? 0),
    createdAt: g.created_at,
  };
}

function memberDto(groupId: number, m: GroupMemberRow) {
  return {
    id: Number(m.employee_id),
    groupId,
    employeeId: Number(m.employee_id),
    role: m.role,
    fullName: m.full_name,
    employeeCode: m.employee_code,
    email: m.email,
    mobile: '',
    designationTitle: m.designation_title,
    departmentName: m.department_name,
    photoUrl: m.photo_url,
    status: 'active',
    attendanceStatus: m.attendance_status,
    checkInAt: null,
    isOnline: Boolean(Number(m.is_online ?? 0)),
    joinedAt: m.joined_at,
  };
}

function auditDto(row: Record<string, unknown>) {
  let details: Record<string, unknown> = {};
  try {
    details = typeof row.details === 'string' ? JSON.parse(row.details) : ((row.details as Record<string, unknown>) ?? {});
  } catch {
    details = {};
  }
  const text = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    id: Number(row.id),
    actorName: String(row.actor_name ?? ''),
    action: String(row.action ?? ''),
    entityType: row.target_employee_id ? 'employee' : 'group',
    targetEmployeeName: text(row.target_employee_name),
    fromLocationCode: text(row.from_location_name),
    toLocationCode: text(row.to_location_name),
    fromGroupName: text(details.fromGroupName ?? details.from_group_name),
    toGroupName: text(details.toGroupName ?? details.to_group_name ?? row.group_name),
    reason: text(details.reason),
    createdAt: row.created_at,
  };
}

export const groupsRouter = Router();

groupsRouter.use(authenticate);

// Get location-based dashboard summary
groupsRouter.get(
  '/dashboard/summary',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const summary = await GroupService.dashboardSummary(user, locationId);
    // `summary` is what the Groups page reads; the full breakdown stays alongside.
    res.json({ ...summary, summary: summary.totals });
  }),
);

// Get location audit logs
groupsRouter.get(
  '/audit/logs',
  requireAny('locations.manage', 'locations.view.all'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const logs = await GroupService.auditLogs(user, { locationId, limit });
    res.json({ logs: logs.map(auditDto) });
  }),
);

// List groups
groupsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const isActive = req.query.isActive !== undefined ? req.query.isActive === 'true' || req.query.isActive === '1' : undefined;
    const groups = await GroupService.list(user, { locationId, search, isActive });
    const items = groups.map(groupDto);
    res.json({ items, groups: items });
  }),
);

// Get group by ID
groupsRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const result = await GroupService.get(user, id);
    res.json({ group: groupDto(result.group), members: result.members.map((m) => memberDto(id, m)) });
  }),
);

// Create a new group
groupsRouter.post(
  '/',
  requireAny('groups.manage', 'locations.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        name: z.string().min(2).max(160),
        code: z.string().max(64).nullable().optional(),
        locationId: z.number().int().positive(),
        managerId: z.number().int().positive().nullable().optional(),
        teamLeaderId: z.number().int().positive().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
      }),
      req.body,
    );
    const id = await GroupService.create(user, body, { ip: req.ip });
    res.status(201).json({ id });
  }),
);

// Update a group
groupsRouter.patch(
  '/:id',
  requireAny('groups.manage', 'locations.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(
      z.object({
        name: z.string().min(2).max(160).optional(),
        code: z.string().max(64).nullable().optional(),
        locationId: z.number().int().positive().optional(),
        managerId: z.number().int().positive().nullable().optional(),
        teamLeaderId: z.number().int().positive().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        isActive: z.boolean().optional(),
      }),
      req.body,
    );
    await GroupService.update(user, id, body, { ip: req.ip });
    res.json({ ok: true });
  }),
);

// Delete group
groupsRouter.delete(
  '/:id',
  requireAny('groups.manage', 'locations.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    await GroupService.delete(user, id, { ip: req.ip });
    res.json({ ok: true });
  }),
);

// Add member to group
groupsRouter.post(
  '/:id/members',
  requireAny('groups.manage', 'employees.manage', 'locations.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(
      z.object({
        employeeId: z.number().int().positive(),
        role: z.enum(['member', 'team_leader', 'manager']).default('member'),
      }),
      req.body,
    );
    await GroupService.addMember(user, id, body.employeeId, body.role, { ip: req.ip });
    res.status(201).json({ ok: true });
  }),
);

// Remove member from group
groupsRouter.delete(
  '/:id/members/:employeeId',
  requireAny('groups.manage', 'employees.manage', 'locations.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const employeeId = intParam(req.params.employeeId, 'employeeId');
    await GroupService.removeMember(user, id, employeeId, { ip: req.ip });
    res.json({ ok: true });
  }),
);
