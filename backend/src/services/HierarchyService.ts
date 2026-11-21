/**
 * Reporting hierarchy, location-wise workforce tracking and attendance analytics.
 *
 * - The Software Manager (role `software_manager`) is the root of the reporting tree:
 *   every active employee's reporting chain ends at them. Existing manager relationships
 *   are kept; only employees whose chain does not reach the root are attached to it.
 * - Visibility is enforced here, not in the UI:
 *     hierarchy.view.all + locations.view.all -> every location
 *     hierarchy.view.all                       -> the viewer's permitted locations
 *     *.view.team                              -> the viewer's reporting subtree
 *     otherwise                                -> only the viewer (and their manager's name)
 * - All figures come from attendance, leave_requests, employee_login_audit and live presence.
 */
import type { PoolConnection } from 'mysql2/promise';
import { query, queryOne, transaction, txExecute, txQuery, txQueryOne } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { addDays, daysBetween, toIso, today } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { allowedLocationIds, locationEmployeeIds, subtreeIds } from '../lib/scope.js';
import { PresenceService, type PresenceEntry } from './PresenceService.js';
import type { AuthUser } from './AuthService.js';

export const ROOT_ROLE_SLUG = 'super_admin';
export const COMPANY_LOCATION_CODES = ['ALL', 'BEL', 'DAV', 'SHI', 'HQ'] as const;
const DEFAULT_LOCATION_CODE = 'HQ';
const MODULE_FRESH_MS = 10 * 60_000;
const MAX_RANGE_DAYS = 93;

export type ScopeMode = 'all' | 'location' | 'team' | 'own';
export interface HierarchyScope {
  mode: ScopeMode;
  /** Employee ids the viewer may see; null = everyone. */
  ids: number[] | null;
  /** Locations the viewer may switch between; null = every location. */
  locationIds: number[] | null;
}

export type WorkState =
  | 'working'
  | 'on_break'
  | 'in_meeting'
  | 'inactive'
  | 'offline'
  | 'checked_out'
  | 'on_leave'
  | 'online_not_checked_in'
  | 'not_logged_in';

interface NodeRow {
  id: number;
  employee_code: string;
  full_name: string;
  email: string | null;
  mobile: string | null;
  photo_url: string | null;
  manager_id: number | null;
  manager_name: string | null;
  department_id: number | null;
  department_name: string | null;
  designation_title: string | null;
  location_id: number | null;
  location_code: string | null;
  location_name: string | null;
  role_slug: string;
  role_name: string;
  role_level: number;
  joining_date: string | null;
  current_module: string | null;
  current_module_at: string | null;
  att_status: string | null;
  check_in_at: string | null;
  check_out_at: string | null;
  is_late: number | null;
  early_departure: number | null;
  total_minutes: number | null;
  break_minutes: number | null;
  last_login_at: string | null;
  last_logout_at: string | null;
  direct_reports: number;
  open_tasks: number;
  managed_locations: string | null;
  heads_departments: string | null;
  on_leave_today: number;
}

export interface HierarchyNode {
  id: number;
  employeeCode: string;
  name: string;
  email: string | null;
  mobile: string | null;
  photoUrl: string | null;
  managerId: number | null;
  managerName: string | null;
  departmentId: number | null;
  department: string | null;
  designation: string | null;
  locationId: number | null;
  locationCode: string | null;
  locationName: string | null;
  roleSlug: string;
  roleName: string;
  roleLevel: number;
  isRoot: boolean;
  directReports: number;
  responsibilities: string[];
  attendance: {
    status: 'present' | 'late' | 'checked_out' | 'on_leave' | 'absent';
    checkInAt: string | null;
    checkOutAt: string | null;
    isLate: boolean;
    earlyDeparture: boolean;
    workedMinutes: number;
  };
  presence: { status: string; label: string; online: boolean; lastActiveAt: string | null; lastSeenAt: string | null } | null;
  workState: WorkState;
  currentModule: string | null;
  lastLoginAt: string | null;
  lastLogoutAt: string | null;
}

function workedMinutes(row: { check_in_at: string | null; check_out_at: string | null; total_minutes: number | null; break_minutes: number | null }, isToday: boolean): number {
  const total = Number(row.total_minutes ?? 0);
  if (total > 0 || !row.check_in_at) return total;
  if (row.check_out_at || !isToday) return total;
  const started = Date.parse(toIso(row.check_in_at) ?? '');
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 60000) - Number(row.break_minutes ?? 0));
}

function deriveWorkState(row: NodeRow, presence: PresenceEntry | undefined): WorkState {
  if (Number(row.on_leave_today) > 0 && !row.check_in_at) return 'on_leave';
  const checkedIn = Boolean(row.check_in_at) && !row.check_out_at;
  const status = presence?.status;
  if (checkedIn) {
    if (status === 'on_break') return 'on_break';
    if (status === 'in_meeting') return 'in_meeting';
    if (presence?.online && status === 'active') return 'working';
    if (presence?.online) return 'inactive';
    return 'offline';
  }
  if (row.check_out_at) return 'checked_out';
  if (presence?.online) return 'online_not_checked_in';
  return 'not_logged_in';
}

function inClause(ids: number[]): string {
  return ids.map(() => '?').join(',');
}

export class HierarchyService {
  // ------------------------------------------------------------------ scope

  static async scope(user: AuthUser): Promise<HierarchyScope> {
    const has = (code: string) => user.permissions.includes(code);
    if (has('hierarchy.view.all')) {
      const locationIds = await allowedLocationIds(user);
      if (locationIds === null) return { mode: 'all', ids: null, locationIds: null };
      const ids = await locationEmployeeIds(user);
      return { mode: 'location', ids, locationIds };
    }
    if (has('employees.view.team') || has('activity.view.team') || has('attendance.view.team')) {
      const ids = await subtreeIds(user.id);
      const locs = ids.length
        ? await query<{ location_id: number }>(`SELECT DISTINCT location_id FROM employees WHERE location_id IS NOT NULL AND id IN (${inClause(ids)})`, ids)
        : [];
      return { mode: 'team', ids, locationIds: locs.map((l) => Number(l.location_id)) };
    }
    return { mode: 'own', ids: [user.id], locationIds: user.locationId ? [user.locationId] : [] };
  }

  static async assertCanView(user: AuthUser, employeeId: number): Promise<HierarchyScope> {
    const scope = await HierarchyService.scope(user);
    if (scope.ids !== null && !scope.ids.includes(employeeId)) {
      throw ApiError.forbidden('You do not have access to this employee.');
    }
    return scope;
  }

  /** Validates ?locationId= against the viewer's scope. Returns null for "all permitted". */
  static async requestedLocation(scope: HierarchyScope, raw: unknown): Promise<number | null> {
    if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('Invalid location filter.');
    if (scope.locationIds !== null && !scope.locationIds.includes(id)) {
      throw ApiError.forbidden('You do not have access to that location.');
    }
    return id;
  }

  // ---------------------------------------------------------------- root

  static async rootId(conn?: PoolConnection): Promise<number | null> {
    const sqlByRole = `SELECT e.id FROM employees e JOIN roles r ON r.id = e.role_id
                       WHERE r.slug = ? AND e.status = 'active' ORDER BY e.id LIMIT 1`;
    const byRole = conn ? await txQueryOne<{ id: number }>(conn, sqlByRole, [ROOT_ROLE_SLUG]) : await queryOne<{ id: number }>(sqlByRole, [ROOT_ROLE_SLUG]);
    if (byRole) return Number(byRole.id);
    const sqlByName = "SELECT id FROM employees WHERE status = 'active' AND (full_name LIKE '%Renuka%' OR full_name LIKE '%Renukaradhya%') ORDER BY id LIMIT 1";
    const byName = conn ? await txQueryOne<{ id: number }>(conn, sqlByName) : await queryOne<{ id: number }>(sqlByName);
    return byName ? Number(byName.id) : null;
  }

  /** Closes the open assignment and opens a new one, inside the caller's transaction. */
  static async recordManagerChange(
    conn: PoolConnection,
    input: { employeeId: number; managerId: number | null; previousManagerId: number | null; locationId: number | null; reason: string; source: string; actorId: number | null },
  ): Promise<void> {
    await txExecute(conn, 'UPDATE reporting_assignments SET effective_to = NOW(3) WHERE employee_id = ? AND effective_to IS NULL', [input.employeeId]);
    await txExecute(
      conn,
      `INSERT INTO reporting_assignments (employee_id, manager_id, previous_manager_id, location_id, reason, source, assigned_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.employeeId, input.managerId, input.previousManagerId, input.locationId, input.reason.slice(0, 160), input.source, input.actorId],
    );
  }

  /**
   * Makes the Software Manager the root of the tree and gives every employee a location.
   * Idempotent; safe to run on every start and after organisational changes.
   */
  static async ensureStructure(actorId: number | null = null): Promise<{ rootId: number | null; reassigned: number; locationsAssigned: number }> {
    return transaction(async (conn) => {
      const rootId = await HierarchyService.rootId(conn);
      if (!rootId) return { rootId: null, reassigned: 0, locationsAssigned: 0 };

      // The root's role, designation and department.
      const role = await txQueryOne<{ id: number }>(conn, 'SELECT id FROM roles WHERE slug = ? LIMIT 1', [ROOT_ROLE_SLUG]);
      const dept = await txQueryOne<{ id: number }>(conn, "SELECT id FROM departments WHERE code = 'EXEC' OR code = 'IT' ORDER BY code = 'EXEC' DESC LIMIT 1");
      const designation = await txQueryOne<{ id: number }>(conn, "SELECT id FROM designations WHERE title = 'Managing Director' OR title LIKE '%Director%' ORDER BY title = 'Managing Director' DESC LIMIT 1");
      const root = await txQueryOne<{ manager_id: number | null; location_id: number | null }>(conn, 'SELECT manager_id, location_id FROM employees WHERE id = ?', [rootId]);
      await txExecute(
        conn,
        `UPDATE employees SET role_id = COALESCE(?, role_id), designation_id = COALESCE(?, designation_id), department_id = COALESCE(?, department_id), manager_id = NULL WHERE id = ?`,
        [role?.id ?? 1, designation?.id ?? null, dept?.id ?? null, rootId],
      );
      if (role) await txExecute(conn, 'INSERT IGNORE INTO employee_roles (employee_id, role_id) VALUES (?, ?)', [rootId, role.id]).catch(() => undefined);
      if (root?.manager_id) {
        await HierarchyService.recordManagerChange(conn, {
          employeeId: rootId, managerId: null, previousManagerId: Number(root.manager_id), locationId: root.location_id,
          reason: 'Super Admin is the top of the reporting hierarchy', source: 'auto', actorId,
        });
      }

      // Every employee needs a location.
      let locationsAssigned = 0;
      const hq = await txQueryOne<{ id: number }>(
        conn,
        `SELECT id FROM locations WHERE is_active = 1
         ORDER BY code = ? DESC, id = (SELECT location_id FROM employees WHERE id = ?) DESC, id LIMIT 1`,
        [DEFAULT_LOCATION_CODE, rootId],
      );
      if (hq) {
        const missing = await txQuery<{ id: number }>(conn, "SELECT id FROM employees WHERE location_id IS NULL AND status NOT IN ('deleted','rejected')");
        if (missing.length) {
          const ids = missing.map((m) => Number(m.id));
          await txExecute(conn, `UPDATE employees SET location_id = ? WHERE id IN (${inClause(ids)})`, [hq.id, ...ids]);
          locationsAssigned = ids.length;
          await recordAudit({ actorId, action: 'hierarchy.location_defaulted', entityType: 'employee', after: { employeeIds: ids, locationCode: DEFAULT_LOCATION_CODE } });
        }
      }

      // Attach only the top of every chain that does not reach the root (no manager, a manager who
      // left, or a reporting cycle). Everyone below keeps their existing manager.
      const people = await txQuery<{ id: number; manager_id: number | null; location_id: number | null }>(
        conn,
        "SELECT id, manager_id, location_id FROM employees WHERE status NOT IN ('deleted','rejected')",
      );
      const managerOf = new Map(people.map((p) => [Number(p.id), p.manager_id ? Number(p.manager_id) : null]));
      const reaches = (id: number): boolean => {
        const seen = new Set<number>();
        let current: number | null = id;
        while (current !== null) {
          if (current === rootId) return true;
          if (seen.has(current) || !managerOf.has(current)) return false;
          seen.add(current);
          current = managerOf.get(current) ?? null;
        }
        return false;
      };
      let reassigned = 0;
      for (const person of people.sort((a, b) => Number(a.id) - Number(b.id))) {
        const id = Number(person.id);
        if (id === rootId || reaches(id)) continue;
        // Walk up to the break: the last valid person before a missing manager or a repeat.
        const seen = new Set<number>();
        let top = id;
        while (true) {
          seen.add(top);
          const next = managerOf.get(top) ?? null;
          if (next === null || !managerOf.has(next) || seen.has(next)) break;
          top = next;
        }
        const previous = managerOf.get(top) ?? null;
        managerOf.set(top, rootId);
        const row = people.find((p) => Number(p.id) === top);
        await txExecute(conn, 'UPDATE employees SET manager_id = ? WHERE id = ?', [rootId, top]);
        await HierarchyService.recordManagerChange(conn, {
          employeeId: top, managerId: rootId, previousManagerId: previous, locationId: row?.location_id ?? null,
          reason: previous === null ? 'Reporting line attached to the Software Manager' : 'Broken or circular reporting line attached to the Software Manager',
          source: 'auto', actorId,
        });
        reassigned += 1;
      }
      if (reassigned) {
        await recordAudit({ actorId, action: 'hierarchy.attached_to_root', entityType: 'employee', entityId: rootId, after: { reassigned } });
      }
      return { rootId, reassigned, locationsAssigned };
    });
  }

  // --------------------------------------------------------------- nodes

  private static async nodes(scope: HierarchyScope, filters: { locationId?: number | null; ids?: number[] } = {}): Promise<HierarchyNode[]> {
    const day = today();
    const clauses = ["e.status = 'active'"];
    const params: unknown[] = [day, day, day];
    const ids = filters.ids ?? scope.ids;
    if (ids !== null) {
      if (ids.length === 0) return [];
      clauses.push(`e.id IN (${inClause(ids)})`);
      params.push(...ids);
    }
    if (filters.locationId) {
      clauses.push('e.location_id = ?');
      params.push(filters.locationId);
    }
    const rows = await query<NodeRow>(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.mobile, e.photo_url, e.manager_id, m.full_name AS manager_name,
              e.department_id, d.name AS department_name, dg.title AS designation_title,
              e.location_id, l.code AS location_code, l.name AS location_name,
              r.slug AS role_slug, r.name AS role_name, r.level AS role_level, e.joining_date,
              e.current_module, e.current_module_at,
              a.status AS att_status, a.check_in_at, a.check_out_at, a.is_late, a.early_departure, a.total_minutes, a.break_minutes,
              (SELECT MAX(la.login_at) FROM employee_login_audit la WHERE la.employee_id = e.id) AS last_login_at,
              (SELECT MAX(la.logout_at) FROM employee_login_audit la WHERE la.employee_id = e.id) AS last_logout_at,
              (SELECT COUNT(*) FROM employees c WHERE c.manager_id = e.id AND c.status = 'active') AS direct_reports,
              (SELECT COUNT(*) FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
                WHERE ta.employee_id = e.id AND t.status IN ('assigned','accepted','in_progress','on_hold','pending_approval')) AS open_tasks,
              (SELECT GROUP_CONCAT(ml.code ORDER BY ml.code) FROM employee_locations el JOIN locations ml ON ml.id = el.location_id WHERE el.employee_id = e.id) AS managed_locations,
              (SELECT GROUP_CONCAT(hd.name ORDER BY hd.name) FROM departments hd WHERE hd.head_employee_id = e.id) AS heads_departments,
              (SELECT COUNT(*) FROM leave_requests lr WHERE lr.employee_id = e.id AND lr.status = 'approved' AND lr.start_date <= ? AND lr.end_date >= ?) AS on_leave_today
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.level DESC, e.full_name`,
      params,
    );
    const rootId = await HierarchyService.rootId();
    const presence = new Map(
      (rows.length ? await PresenceService.list(rows.map((r) => Number(r.id))) : []).map((p) => [p.employeeId, p]),
    );
    return rows.map((row) => {
      const p = presence.get(Number(row.id));
      const moduleFresh = row.current_module && row.current_module_at && Date.now() - Date.parse(toIso(row.current_module_at) ?? '') < MODULE_FRESH_MS;
      const responsibilities = [row.role_name];
      if (Number(row.direct_reports) > 0) responsibilities.push(`${row.direct_reports} direct report${Number(row.direct_reports) === 1 ? '' : 's'}`);
      if (row.managed_locations) responsibilities.push(`Manages ${row.managed_locations.split(',').join(', ')}`);
      if (row.heads_departments) responsibilities.push(`Heads ${row.heads_departments}`);
      if (Number(row.open_tasks) > 0) responsibilities.push(`${row.open_tasks} open task${Number(row.open_tasks) === 1 ? '' : 's'}`);
      const attendanceStatus: HierarchyNode['attendance']['status'] = row.check_in_at
        ? row.check_out_at ? 'checked_out' : Number(row.is_late) ? 'late' : 'present'
        : Number(row.on_leave_today) > 0 ? 'on_leave' : 'absent';
      return {
        id: Number(row.id),
        employeeCode: row.employee_code,
        name: row.full_name,
        email: row.email,
        mobile: row.mobile,
        photoUrl: row.photo_url,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        departmentId: row.department_id ? Number(row.department_id) : null,
        department: row.department_name,
        designation: row.designation_title,
        locationId: row.location_id ? Number(row.location_id) : null,
        locationCode: row.location_code,
        locationName: row.location_name,
        roleSlug: row.role_slug,
        roleName: row.role_name,
        roleLevel: Number(row.role_level),
        isRoot: Number(row.id) === rootId,
        directReports: Number(row.direct_reports),
        responsibilities,
        attendance: {
          status: attendanceStatus,
          checkInAt: toIso(row.check_in_at),
          checkOutAt: toIso(row.check_out_at),
          isLate: Boolean(Number(row.is_late)),
          earlyDeparture: Boolean(Number(row.early_departure)),
          workedMinutes: workedMinutes(row, true),
        },
        presence: p ? { status: p.status, label: p.label, online: p.online, lastActiveAt: p.lastActiveAt, lastSeenAt: p.lastSeenAt } : null,
        workState: deriveWorkState(row, p),
        currentModule: moduleFresh && p?.online ? row.current_module : null,
        lastLoginAt: toIso(row.last_login_at),
        lastLogoutAt: toIso(row.last_logout_at),
      };
    });
  }

  // ------------------------------------------------------------ overview

  static async overview(user: AuthUser, rawLocationId?: unknown) {
    const scope = await HierarchyService.scope(user);
    const locationId = await HierarchyService.requestedLocation(scope, rawLocationId);
    const rootId = await HierarchyService.rootId();

    const locationRows = await query<{ id: number; code: string; name: string; city: string | null }>(
      `SELECT id, code, name, city FROM locations WHERE is_active = 1
       ORDER BY FIELD(code, ${COMPANY_LOCATION_CODES.map(() => '?').join(',')}) = 0, FIELD(code, ${COMPANY_LOCATION_CODES.map(() => '?').join(',')}), name`,
      [...COMPANY_LOCATION_CODES, ...COMPANY_LOCATION_CODES],
    );
    const permittedLocations = locationRows.filter((l) => scope.locationIds === null || scope.locationIds.includes(Number(l.id)));

    let nodes: HierarchyNode[];
    if (scope.mode === 'own') {
      nodes = await HierarchyService.nodes(scope);
    } else {
      nodes = await HierarchyService.nodes(scope, { locationId });
    }

    // The root header is shown to everyone; tracking details only to those in scope.
    let root: Partial<HierarchyNode> | null = nodes.find((n) => n.isRoot) ?? null;
    if (!root && rootId) {
      const basic = await queryOne<{ id: number; employee_code: string; full_name: string; photo_url: string | null; designation: string | null; department: string | null; location_code: string | null; location_name: string | null }>(
        `SELECT e.id, e.employee_code, e.full_name, e.photo_url, dg.title AS designation, d.name AS department, l.code AS location_code, l.name AS location_name
         FROM employees e LEFT JOIN designations dg ON dg.id = e.designation_id LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`,
        [rootId],
      );
      if (basic) {
        root = {
          id: Number(basic.id), employeeCode: basic.employee_code, name: basic.full_name, photoUrl: basic.photo_url,
          designation: basic.designation, department: basic.department, locationCode: basic.location_code, locationName: basic.location_name, isRoot: true,
        };
      }
    }

    // An employee also sees their own reporting manager (name and role only).
    let manager: Partial<HierarchyNode> | null = null;
    if (scope.mode === 'own' && user.managerId) {
      const m = await queryOne<{ id: number; employee_code: string; full_name: string; photo_url: string | null; designation: string | null; location_code: string | null }>(
        `SELECT e.id, e.employee_code, e.full_name, e.photo_url, dg.title AS designation, l.code AS location_code
         FROM employees e LEFT JOIN designations dg ON dg.id = e.designation_id LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`,
        [user.managerId],
      );
      if (m) manager = { id: Number(m.id), employeeCode: m.employee_code, name: m.full_name, photoUrl: m.photo_url, designation: m.designation, locationCode: m.location_code };
    }

    const all = locationId ? await HierarchyService.nodes(scope) : nodes;
    const summarize = (list: HierarchyNode[]) => ({
      total: list.length,
      present: list.filter((n) => ['present', 'late', 'checked_out'].includes(n.attendance.status)).length,
      working: list.filter((n) => n.workState === 'working').length,
      onBreak: list.filter((n) => n.workState === 'on_break' || n.workState === 'in_meeting').length,
      inactive: list.filter((n) => n.workState === 'inactive').length,
      onLeave: list.filter((n) => n.workState === 'on_leave').length,
      offline: list.filter((n) => ['offline', 'not_logged_in', 'checked_out'].includes(n.workState)).length,
      managers: list.filter((n) => n.directReports > 0 && !n.isRoot).length,
    });
    const people = permittedLocations.length
      ? await query<{ location_id: number; kind: string; id: number; full_name: string }>(
          `SELECT el.location_id, 'manager' AS kind, e.id, e.full_name FROM employee_locations el JOIN employees e ON e.id = el.employee_id WHERE e.status = 'active'
           UNION ALL
           SELECT lh.location_id, 'hr' AS kind, e.id, e.full_name FROM location_hr_assignments lh JOIN employees e ON e.id = lh.employee_id WHERE e.status = 'active'`,
        )
      : [];
    const peopleAt = (locationId: number, kind: string) => people
      .filter((p) => Number(p.location_id) === locationId && p.kind === kind)
      .map((p) => ({ id: Number(p.id), name: p.full_name }));
    const locations = permittedLocations.map((l) => ({
      id: Number(l.id),
      code: l.code,
      name: l.name,
      city: l.city,
      locationManagers: peopleAt(Number(l.id), 'manager'),
      hr: peopleAt(Number(l.id), 'hr'),
      ...summarize(all.filter((n) => n.locationId === Number(l.id))),
    }));

    const departments = await query<{ id: number; name: string }>('SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name');

    return {
      scope: {
        mode: scope.mode,
        canManage: user.permissions.includes('hierarchy.manage'),
        canManageLocations: user.permissions.includes('locations.manage'),
        allLocations: scope.locationIds === null,
      },
      root,
      manager,
      locations,
      departments,
      summary: summarize(nodes),
      employees: nodes,
      generatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------- employee detail

  static async employeeDetail(user: AuthUser, employeeId: number) {
    const scope = await HierarchyService.assertCanView(user, employeeId);
    const [node] = await HierarchyService.nodes(scope, { ids: [employeeId] });
    if (!node) throw ApiError.notFound('Employee not found');
    const from = addDays(today(), -13);
    const [attendance, sessions, history, reports] = await Promise.all([
      query<{ work_date: string; status: string; check_in_at: string | null; check_out_at: string | null; total_minutes: number; break_minutes: number; is_late: number; early_departure: number }>(
        `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, status, check_in_at, check_out_at, total_minutes, break_minutes, is_late, early_departure
         FROM attendance WHERE employee_id = ? AND work_date >= ? ORDER BY work_date DESC`,
        [employeeId, from],
      ),
      query<{ login_at: string; logout_at: string | null; duration_minutes: number; browser: string | null; os: string | null; logout_reason: string | null; termination_status: string }>(
        `SELECT login_at, logout_at, duration_minutes, browser, os, logout_reason, termination_status
         FROM employee_login_audit WHERE employee_id = ? ORDER BY login_at DESC LIMIT 15`,
        [employeeId],
      ),
      query<{ manager_name: string | null; previous_manager_name: string | null; reason: string | null; source: string; effective_from: string; effective_to: string | null; assigned_by_name: string | null }>(
        `SELECT m.full_name AS manager_name, pm.full_name AS previous_manager_name, ra.reason, ra.source, ra.effective_from, ra.effective_to, ab.full_name AS assigned_by_name
         FROM reporting_assignments ra
         LEFT JOIN employees m ON m.id = ra.manager_id
         LEFT JOIN employees pm ON pm.id = ra.previous_manager_id
         LEFT JOIN employees ab ON ab.id = ra.assigned_by
         WHERE ra.employee_id = ? ORDER BY ra.effective_from DESC, ra.id DESC LIMIT 20`,
        [employeeId],
      ),
      query<{ id: number; full_name: string; employee_code: string; location_code: string | null }>(
        `SELECT e.id, e.full_name, e.employee_code, l.code AS location_code FROM employees e LEFT JOIN locations l ON l.id = e.location_id
         WHERE e.manager_id = ? AND e.status = 'active' ORDER BY e.full_name`,
        [employeeId],
      ),
    ]);
    const visibleReports = scope.ids === null ? reports : reports.filter((r) => scope.ids!.includes(Number(r.id)));
    return {
      employee: node,
      attendance: attendance.map((a) => ({
        date: a.work_date, status: a.status, checkInAt: toIso(a.check_in_at), checkOutAt: toIso(a.check_out_at),
        workedMinutes: workedMinutes(a, a.work_date === today()), isLate: Boolean(Number(a.is_late)), earlyDeparture: Boolean(Number(a.early_departure)),
      })),
      sessions: sessions.map((s) => ({
        loginAt: toIso(s.login_at), logoutAt: toIso(s.logout_at), durationMinutes: Number(s.duration_minutes),
        browser: s.browser, os: s.os, logoutReason: s.logout_reason, status: s.termination_status,
      })),
      reportingHistory: history.map((h) => ({
        managerName: h.manager_name, previousManagerName: h.previous_manager_name, reason: h.reason, source: h.source,
        from: toIso(h.effective_from), to: toIso(h.effective_to), assignedBy: h.assigned_by_name,
      })),
      directReports: visibleReports.map((r) => ({ id: Number(r.id), name: r.full_name, employeeCode: r.employee_code, locationCode: r.location_code })),
    };
  }

  // ------------------------------------------------------------- analytics

  static async analytics(user: AuthUser, input: { from?: string; to?: string; locationId?: unknown }) {
    const scope = await HierarchyService.scope(user);
    if (scope.mode === 'own') throw ApiError.forbidden('Workforce analytics are available to managers only.');
    const locationId = await HierarchyService.requestedLocation(scope, input.locationId);
    const now = today();
    const isDate = (v?: string) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const from = isDate(input.from) ? input.from! : now;
    const to = isDate(input.to) ? input.to! : from;
    if (to < from) throw ApiError.badRequest('The end date must be on or after the start date.');
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw ApiError.badRequest(`Choose a range of at most ${MAX_RANGE_DAYS} days.`);
    const lastDay = to > now ? now : to;

    const empClauses = ["e.status = 'active'", 'e.location_id IS NOT NULL'];
    const empParams: unknown[] = [];
    if (scope.ids !== null) {
      if (scope.ids.length === 0) empClauses.push('1 = 0');
      else { empClauses.push(`e.id IN (${inClause(scope.ids)})`); empParams.push(...scope.ids); }
    }
    if (locationId) { empClauses.push('e.location_id = ?'); empParams.push(locationId); }
    const employees = await query<{ id: number; location_id: number; department_id: number | null; department_name: string | null; joining_date: string | null }>(
      `SELECT e.id, e.location_id, e.department_id, d.name AS department_name, DATE_FORMAT(e.joining_date, '%Y-%m-%d') AS joining_date
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE ${empClauses.join(' AND ')}`,
      empParams,
    );
    const ids = employees.map((e) => Number(e.id));
    const permitted = (await query<{ id: number; code: string; name: string }>('SELECT id, code, name FROM locations WHERE is_active = 1'))
      .filter((l) => (scope.locationIds === null || scope.locationIds.includes(Number(l.id))) && (!locationId || Number(l.id) === locationId));

    const [attendance, leaves, holidays, logins, presence] = ids.length
      ? await Promise.all([
          query<{ employee_id: number; work_date: string; check_in_at: string | null; check_out_at: string | null; total_minutes: number; break_minutes: number; is_late: number; early_departure: number }>(
            `SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, check_in_at, check_out_at, total_minutes, break_minutes, is_late, early_departure
             FROM attendance WHERE work_date BETWEEN ? AND ? AND employee_id IN (${inClause(ids)})`,
            [from, to, ...ids],
          ),
          query<{ employee_id: number; start_date: string; end_date: string }>(
            `SELECT employee_id, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
             FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ? AND employee_id IN (${inClause(ids)})`,
            [to, from, ...ids],
          ),
          query<{ holiday_date: string; location_id: number | null }>(
            "SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date, location_id FROM holidays WHERE holiday_date BETWEEN ? AND ?",
            [from, to],
          ),
          query<{ employee_id: number; full_name: string; employee_code: string; location_code: string | null; login_at: string; logout_at: string | null; duration_minutes: number; logout_reason: string | null; termination_status: string }>(
            `SELECT la.employee_id, e.full_name, e.employee_code, l.code AS location_code, la.login_at, la.logout_at, la.duration_minutes, la.logout_reason, la.termination_status
             FROM employee_login_audit la JOIN employees e ON e.id = la.employee_id LEFT JOIN locations l ON l.id = e.location_id
             WHERE la.login_at >= ? AND la.login_at < DATE_ADD(?, INTERVAL 1 DAY) AND la.employee_id IN (${inClause(ids)})
             ORDER BY la.login_at DESC LIMIT 300`,
            [from, to, ...ids],
          ),
          PresenceService.list(ids),
        ])
      : [[], [], [], [], []];

    const attByKey = new Map(attendance.map((a) => [`${a.employee_id}|${a.work_date}`, a]));
    const leaveDays = new Set<string>();
    for (const leave of leaves) {
      for (let d = leave.start_date < from ? from : leave.start_date; d <= leave.end_date && d <= to; d = addDays(d, 1)) leaveDays.add(`${leave.employee_id}|${d}`);
    }
    const holidaySet = new Set(holidays.map((h) => `${h.location_id ?? '*'}|${h.holiday_date}`));
    const online = new Map(presence.map((p) => [p.employeeId, p]));

    interface Bucket { employees: number; expected: number; present: number; absent: number; onLeave: number; late: number; early: number; minutes: number; workingNow: number; offlineNow: number }
    const blank = (): Bucket => ({ employees: 0, expected: 0, present: 0, absent: 0, onLeave: 0, late: 0, early: 0, minutes: 0, workingNow: 0, offlineNow: 0 });
    const byLocation = new Map<number, Bucket>();
    const byDept = new Map<string, Bucket & { locationId: number; department: string }>();
    const daily = new Map<string, { present: number; expected: number }>();
    const total = blank();

    for (const employee of employees) {
      const loc = Number(employee.location_id);
      const deptKey = `${loc}|${employee.department_id ?? 0}`;
      if (!byLocation.has(loc)) byLocation.set(loc, blank());
      if (!byDept.has(deptKey)) byDept.set(deptKey, { ...blank(), locationId: loc, department: employee.department_name ?? 'No department' });
      const buckets = [total, byLocation.get(loc)!, byDept.get(deptKey)!];
      for (const b of buckets) b.employees += 1;
      const p = online.get(Number(employee.id));
      const todayRow = attByKey.get(`${employee.id}|${now}`);
      const workingNow = Boolean(todayRow?.check_in_at && !todayRow.check_out_at && p?.online && ['active', 'in_meeting'].includes(p.status));
      for (const b of buckets) { if (workingNow) b.workingNow += 1; else if (!p?.online) b.offlineNow += 1; }

      const start = employee.joining_date && employee.joining_date > from ? employee.joining_date : from;
      for (let d = start; d <= lastDay; d = addDays(d, 1)) {
        if (holidaySet.has(`*|${d}`) || holidaySet.has(`${loc}|${d}`)) continue;
        const row = attByKey.get(`${employee.id}|${d}`);
        const dayBucket = daily.get(d) ?? { present: 0, expected: 0 };
        daily.set(d, dayBucket);
        if (row?.check_in_at) {
          const minutes = workedMinutes(row, d === now);
          for (const b of buckets) {
            b.expected += 1; b.present += 1; b.minutes += minutes;
            if (Number(row.is_late)) b.late += 1;
            if (Number(row.early_departure)) b.early += 1;
          }
          dayBucket.present += 1; dayBucket.expected += 1;
        } else if (leaveDays.has(`${employee.id}|${d}`)) {
          for (const b of buckets) b.onLeave += 1;
        } else {
          for (const b of buckets) { b.expected += 1; b.absent += 1; }
          dayBucket.expected += 1;
        }
      }
    }

    const shape = (b: Bucket) => ({
      employees: b.employees,
      present: b.present,
      absent: b.absent,
      onLeave: b.onLeave,
      lateArrivals: b.late,
      earlyDepartures: b.early,
      workingNow: b.workingNow,
      offlineNow: b.offlineNow,
      totalWorkedMinutes: b.minutes,
      averageWorkedMinutes: b.present ? Math.round(b.minutes / b.present) : 0,
      attendancePercent: b.expected ? Math.round((b.present / b.expected) * 1000) / 10 : null,
    });

    return {
      range: { from, to, days: daysBetween(from, to) + 1, countedThrough: lastDay < from ? null : lastDay },
      overall: shape(total),
      locations: permitted.map((l) => ({ id: Number(l.id), code: l.code, name: l.name, ...shape(byLocation.get(Number(l.id)) ?? blank()) })),
      departments: [...byDept.values()]
        .map((d) => ({ locationId: d.locationId, department: d.department, ...shape(d) }))
        .sort((a, b) => a.department.localeCompare(b.department)),
      daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({
        date, present: v.present, expected: v.expected, attendancePercent: v.expected ? Math.round((v.present / v.expected) * 1000) / 10 : null,
      })),
      logins: logins.map((l) => ({
        employeeId: Number(l.employee_id), name: l.full_name, employeeCode: l.employee_code, locationCode: l.location_code,
        loginAt: toIso(l.login_at), logoutAt: toIso(l.logout_at), durationMinutes: Number(l.duration_minutes),
        logoutReason: l.logout_reason, status: l.termination_status,
      })),
    };
  }

  // ------------------------------------------------------------ management

  static async assign(actor: AuthUser, employeeId: number, input: { managerId?: number | null; locationId?: number; reason?: string }, ip?: string) {
    if (!actor.permissions.includes('hierarchy.manage')) throw ApiError.forbidden('Only a Super Admin can change reporting relationships.');
    if (input.managerId === undefined && input.locationId === undefined) throw ApiError.badRequest('Nothing to update.');
    const reason = (input.reason ?? '').trim() || 'Changed in the reporting hierarchy';
    return transaction(async (conn) => {
      const target = await txQueryOne<{ id: number; full_name: string; manager_id: number | null; location_id: number | null; status: string }>(
        conn, 'SELECT id, full_name, manager_id, location_id, status FROM employees WHERE id = ? FOR UPDATE', [employeeId],
      );
      if (!target || ['deleted', 'rejected'].includes(target.status)) throw ApiError.notFound('Employee not found');
      const rootId = await HierarchyService.rootId(conn);
      const before = { managerId: target.manager_id ? Number(target.manager_id) : null, locationId: target.location_id ? Number(target.location_id) : null };
      const after = { ...before };

      if (input.managerId !== undefined) {
        if (employeeId === rootId) throw ApiError.badRequest('The Software Manager is the top of the hierarchy and does not report to anyone.');
        const managerId = input.managerId ?? rootId;
        if (!managerId) throw ApiError.badRequest('Choose a reporting manager.');
        if (managerId === employeeId) throw ApiError.badRequest('An employee cannot report to themselves.');
        const manager = await txQueryOne<{ id: number }>(conn, "SELECT id FROM employees WHERE id = ? AND status = 'active'", [managerId]);
        if (!manager) throw ApiError.badRequest('The selected manager is not an active employee.');
        const below = await txQuery<{ id: number }>(
          conn,
          `WITH RECURSIVE sub AS (SELECT id FROM employees WHERE id = ? UNION SELECT e.id FROM employees e JOIN sub s ON e.manager_id = s.id) SELECT id FROM sub`,
          [employeeId],
        );
        if (below.some((b) => Number(b.id) === managerId)) throw ApiError.badRequest('That manager reports (directly or indirectly) to this employee.');
        after.managerId = managerId;
      }
      if (input.locationId !== undefined) {
        const loc = await txQueryOne<{ id: number }>(conn, 'SELECT id FROM locations WHERE id = ? AND is_active = 1', [input.locationId]);
        if (!loc) throw ApiError.badRequest('That location does not exist or is inactive.');
        after.locationId = Number(input.locationId);
      }
      if (after.managerId === before.managerId && after.locationId === before.locationId) return { changed: false };

      await txExecute(conn, 'UPDATE employees SET manager_id = ?, location_id = ? WHERE id = ?', [after.managerId, after.locationId, employeeId]);
      if (after.managerId !== before.managerId) {
        await HierarchyService.recordManagerChange(conn, {
          employeeId, managerId: after.managerId, previousManagerId: before.managerId, locationId: after.locationId, reason, source: 'manual', actorId: actor.id,
        });
      }
      await recordAudit({ actorId: actor.id, action: 'hierarchy.assignment_changed', entityType: 'employee', entityId: employeeId, before, after: { ...after, reason }, ip });
      return { changed: true };
    });
  }

  static async locationManagers(user: AuthUser, locationId: number) {
    const scope = await HierarchyService.scope(user);
    if (scope.mode === 'own') throw ApiError.forbidden();
    await HierarchyService.requestedLocation(scope, locationId);
    const rows = await query<{ id: number; full_name: string; employee_code: string; role_name: string }>(
      `SELECT e.id, e.full_name, e.employee_code, r.name AS role_name FROM employee_locations el
       JOIN employees e ON e.id = el.employee_id JOIN roles r ON r.id = e.role_id
       WHERE el.location_id = ? AND e.status = 'active' ORDER BY e.full_name`,
      [locationId],
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.full_name, employeeCode: r.employee_code, roleName: r.role_name }));
  }

  /** Sets which employees manage (and may track) a location, in addition to their own location. */
  static async setLocationManagers(actor: AuthUser, locationId: number, employeeIds: number[], ip?: string) {
    if (!actor.permissions.includes('hierarchy.manage')) throw ApiError.forbidden('Only a Super Admin can assign location managers.');
    const loc = await queryOne<{ id: number; code: string }>('SELECT id, code FROM locations WHERE id = ? AND is_active = 1', [locationId]);
    if (!loc) throw ApiError.notFound('Location not found');
    const unique = [...new Set(employeeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (unique.length) {
      const valid = await query<{ id: number }>(`SELECT id FROM employees WHERE status = 'active' AND id IN (${inClause(unique)})`, unique);
      if (valid.length !== unique.length) throw ApiError.badRequest('Every location manager must be an active employee.');
    }
    const before = (await query<{ employee_id: number }>('SELECT employee_id FROM employee_locations WHERE location_id = ?', [locationId])).map((r) => Number(r.employee_id));
    await transaction(async (conn) => {
      const removed = before.filter((id) => !unique.includes(id));
      if (removed.length) await txExecute(conn, `DELETE FROM employee_locations WHERE location_id = ? AND employee_id IN (${inClause(removed)})`, [locationId, ...removed]);
      for (const id of unique) {
        await txExecute(conn, 'INSERT IGNORE INTO employee_locations (employee_id, location_id, granted_by) VALUES (?, ?, ?)', [id, locationId, actor.id]);
      }
    });
    await recordAudit({ actorId: actor.id, action: 'hierarchy.location_managers_set', entityType: 'location', entityId: locationId, before: { employeeIds: before }, after: { employeeIds: unique }, ip });
    return HierarchyService.locationManagers(actor, locationId);
  }

  static async locationHr(user: AuthUser, locationId: number) {
    const scope = await HierarchyService.scope(user);
    if (scope.mode === 'own') throw ApiError.forbidden();
    await HierarchyService.requestedLocation(scope, locationId);
    const rows = await query<{ id: number; full_name: string; employee_code: string; role_name: string }>(
      `SELECT e.id, e.full_name, e.employee_code, r.name AS role_name FROM location_hr_assignments lh
       JOIN employees e ON e.id = lh.employee_id JOIN roles r ON r.id = e.role_id
       WHERE lh.location_id = ? AND e.status = 'active' ORDER BY e.full_name`,
      [locationId],
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.full_name, employeeCode: r.employee_code, roleName: r.role_name }));
  }

  /**
   * Sets the HR people for one location. They handle that location's leave approvals and see its
   * employees; HR assigned elsewhere no longer receives this location's requests.
   */
  static async setLocationHr(actor: AuthUser, locationId: number, employeeIds: number[], ip?: string) {
    if (!actor.permissions.includes('hierarchy.manage') && !actor.permissions.includes('locations.manage')) {
      throw ApiError.forbidden('Only an administrator can assign HR to a location.');
    }
    const loc = await queryOne<{ id: number }>('SELECT id FROM locations WHERE id = ? AND is_active = 1', [locationId]);
    if (!loc) throw ApiError.notFound('Location not found');
    const unique = [...new Set(employeeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (unique.length) {
      const rows = await query<{ id: number; full_name: string; has_hr: number }>(
        `SELECT e.id, e.full_name,
                (EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.code = 'leave.approve.hr')
                 OR EXISTS (SELECT 1 FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.employee_id = e.id AND up.effect = 'grant' AND p.code = 'leave.approve.hr')) AS has_hr
         FROM employees e WHERE e.status = 'active' AND e.id IN (${inClause(unique)})`,
        unique,
      );
      if (rows.length !== unique.length) throw ApiError.badRequest('Every location HR must be an active employee.');
      const missing = rows.filter((r) => !Number(r.has_hr));
      if (missing.length) throw ApiError.badRequest(`${missing.map((m) => m.full_name).join(', ')} cannot approve leave as HR. Give them the HR Manager role first.`);
    }
    const before = (await query<{ employee_id: number }>('SELECT employee_id FROM location_hr_assignments WHERE location_id = ?', [locationId])).map((r) => Number(r.employee_id));
    await transaction(async (conn) => {
      await txExecute(conn, 'DELETE FROM location_hr_assignments WHERE location_id = ?', [locationId]);
      for (const id of unique) {
        await txExecute(conn, 'INSERT INTO location_hr_assignments (location_id, employee_id, assigned_by) VALUES (?, ?, ?)', [locationId, id, actor.id]);
      }
    });
    await recordAudit({ actorId: actor.id, action: 'hierarchy.location_hr_set', entityType: 'location', entityId: locationId, before: { employeeIds: before }, after: { employeeIds: unique }, ip });
    return HierarchyService.locationHr(actor, locationId);
  }

}
