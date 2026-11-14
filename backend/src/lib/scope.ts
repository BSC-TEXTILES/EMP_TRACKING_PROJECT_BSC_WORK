import { query } from '../db/index.js';
import { ApiError } from './http.js';
import type { AuthUser } from '../services/AuthService.js';

/** All employee ids in the reporting subtree rooted at the given manager (inclusive). */
export async function subtreeIds(rootId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM employees WHERE id = ?
       UNION ALL
       SELECT e.id FROM employees e JOIN subtree s ON e.manager_id = s.id
     )
     SELECT id FROM subtree`,
    [rootId],
  );
  return rows.map((r) => Number(r.id));
}

export async function isInSubtree(managerId: number, employeeId: number): Promise<boolean> {
  const ids = await subtreeIds(managerId);
  return ids.includes(employeeId);
}

export type Visibility = 'own' | 'team' | 'all';

/**
 * Resolves the effective employee visibility for a module from the permission set.
 * Returns `null` for unrestricted (organisation-wide) visibility.
 */
export async function visibleEmployeeIds(user: AuthUser, module: string): Promise<number[] | null> {
  if (user.permissions.includes(`${module}.view.all`)) return null;
  if (user.permissions.includes(`${module}.view.team`)) return subtreeIds(user.id);
  return [user.id];
}

export function canViewAll(user: AuthUser, module: string): boolean {
  return user.permissions.includes(`${module}.view.all`);
}

/**
 * Asserts the actor may act on the target employee's data. Managers are limited
 * to their own reporting subtree unless they hold organisation-wide permission.
 */
export async function assertEmployeeAccess(user: AuthUser, targetId: number, module = 'employees'): Promise<void> {
  if (canViewAll(user, module) || targetId === user.id) return;
  if (user.permissions.includes(`${module}.view.team`)) {
    if (await isInSubtree(user.id, targetId)) return;
  }
  throw ApiError.forbidden('You do not have access to this employee record');
}

/** Managers may allocate work only inside their authorised reporting structure. */
export async function assertCanAllocateTo(user: AuthUser, targetId: number): Promise<void> {
  if (user.permissions.includes('tasks.view.all')) return;
  if (!user.permissions.includes('tasks.assign')) throw ApiError.forbidden('You cannot allocate tasks');
  if (targetId === user.id) return;
  if (await isInSubtree(user.id, targetId)) return;
  throw ApiError.forbidden('You can only allocate work within your reporting structure');
}

export function idsFilterSql(ids: number[] | null, column: string): { clause: string; params: unknown[] } {
  if (ids === null) return { clause: '', params: [] };
  if (ids.length === 0) return { clause: ' AND 1 = 0', params: [] };
  return { clause: ` AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}
