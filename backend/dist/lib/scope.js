import { query } from '../db/index.js';
import { ApiError } from './http.js';
/** All employee ids in the reporting subtree rooted at the given manager (inclusive). */
export async function subtreeIds(rootId) {
    const rows = await query(`WITH RECURSIVE subtree AS (
       SELECT id FROM employees WHERE id = ?
       UNION
       SELECT e.id FROM employees e JOIN subtree s ON e.manager_id = s.id
     )
     SELECT id FROM subtree`, [rootId]);
    return rows.map((r) => Number(r.id));
}
export async function isInSubtree(managerId, employeeId) {
    const ids = await subtreeIds(managerId);
    return ids.includes(employeeId);
}
/**
 * Resolves the effective employee visibility for a module from the permission set.
 * Returns `null` for unrestricted (organisation-wide) visibility.
 */
export async function visibleEmployeeIds(user, module) {
    if (user.permissions.includes(`${module}.view.all`))
        return locationEmployeeIds(user);
    if (user.permissions.includes(`${module}.view.team`))
        return subtreeIds(user.id);
    return [user.id];
}
export function canViewAll(user, module) {
    return user.permissions.includes(`${module}.view.all`);
}
/**
 * Asserts the actor may act on the target employee's data. Managers are limited
 * to their own reporting subtree unless they hold organisation-wide permission.
 */
export async function assertEmployeeAccess(user, targetId, module = 'employees') {
    if (targetId === user.id)
        return;
    if (canViewAll(user, module)) {
        const ids = await locationEmployeeIds(user);
        if (ids === null || ids.includes(targetId))
            return;
        throw ApiError.forbidden('This employee belongs to a location outside your access.');
    }
    if (user.permissions.includes(`${module}.view.team`)) {
        if (await isInSubtree(user.id, targetId))
            return;
    }
    throw ApiError.forbidden('You do not have access to this employee record');
}
/** Managers may allocate work only inside their authorised reporting structure. */
export async function assertCanAllocateTo(user, targetId) {
    if (user.permissions.includes('tasks.view.all'))
        return;
    if (!user.permissions.includes('tasks.assign'))
        throw ApiError.forbidden('You cannot allocate tasks');
    if (targetId === user.id)
        return;
    if (await isInSubtree(user.id, targetId))
        return;
    throw ApiError.forbidden('You can only allocate work within your reporting structure');
}
export function idsFilterSql(ids, column) {
    if (ids === null)
        return { clause: '', params: [] };
    if (ids.length === 0)
        return { clause: ' AND 1 = 0', params: [] };
    return { clause: ` AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}
// ------------------------------ Location scope ------------------------------
/**
 * Locations whose organisation-wide data the user may see. `null` means every
 * location (permission `locations.view.all`). Otherwise the user's primary
 * location plus any additional locations granted in employee_locations.
 */
export async function allowedLocationIds(user) {
    if (user.permissions.includes('locations.view.all'))
        return null;
    const rows = await query('SELECT location_id FROM employee_locations WHERE employee_id = ?', [user.id]);
    const ids = new Set(rows.map((row) => Number(row.location_id)));
    if (user.locationId)
        ids.add(Number(user.locationId));
    return [...ids];
}
/**
 * SQL restricting an employee-id column to the user's permitted locations, for
 * "view all" permission holders. Without any location the user sees only
 * themselves, never the whole organisation.
 */
export async function locationEmployeeClause(user, column) {
    const ids = await allowedLocationIds(user);
    if (ids === null)
        return { clause: '1 = 1', params: [] };
    if (ids.length === 0)
        return { clause: `${column} = ?`, params: [user.id] };
    return {
        clause: `${column} IN (SELECT le.id FROM employees le WHERE le.location_id IN (${ids.map(() => '?').join(',')}))`,
        params: ids,
    };
}
/** Employee ids inside the user's permitted locations (null = unrestricted). */
export async function locationEmployeeIds(user) {
    const ids = await allowedLocationIds(user);
    if (ids === null)
        return null;
    if (ids.length === 0)
        return [user.id];
    const rows = await query(`SELECT id FROM employees WHERE location_id IN (${ids.map(() => '?').join(',')})`, ids);
    return [...new Set([user.id, ...rows.map((row) => Number(row.id))])];
}
/**
 * Validates an explicit location filter (e.g. ?locationId=). Returns the id to
 * filter on, or null for "All Locations". Requesting a location outside the
 * user's scope is rejected rather than silently widened.
 */
export async function requestedLocation(user, raw) {
    if (raw === undefined || raw === null || raw === '' || raw === 'all')
        return null;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0)
        throw ApiError.badRequest('Invalid location filter.');
    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(id))
        throw ApiError.forbidden('You do not have access to that location.');
    return id;
}
//# sourceMappingURL=scope.js.map