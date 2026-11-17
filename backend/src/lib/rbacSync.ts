import { execute, query } from '../db/index.js';
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from './rbac.js';

/**
 * Brings the live permission catalogue in line with the code on every start.
 *
 * Seed/setup only run once, so permissions and roles added later never reached
 * an existing installation and roles silently lacked access. This is additive:
 *  - missing system roles are created with their full default permissions;
 *  - a permission that is new to this database is granted to every system role
 *    whose definition includes it.
 * Permissions an administrator removed from a role are never re-added, because
 * only permissions created during this run are granted to existing roles.
 */
export async function syncRbac(): Promise<{ newPermissions: string[]; newRoles: string[] }> {
  const existing = new Set((await query<{ code: string }>('SELECT code FROM permissions')).map((p) => p.code));
  const newPermissions: string[] = [];
  for (const permission of PERMISSION_DEFINITIONS) {
    if (existing.has(permission.code)) continue;
    await execute('INSERT IGNORE INTO permissions (code, module, action, description) VALUES (?, ?, ?, ?)', [
      permission.code,
      permission.module,
      permission.action,
      permission.description,
    ]);
    newPermissions.push(permission.code);
  }

  const roleRows = await query<{ id: number; slug: string }>('SELECT id, slug FROM roles');
  const roleIds = new Map(roleRows.map((r) => [r.slug, Number(r.id)]));
  const newRoles: string[] = [];
  for (const role of ROLE_DEFINITIONS) {
    if (roleIds.has(role.slug)) continue;
    const result = await execute(
      'INSERT IGNORE INTO roles (name, slug, category, level, description, is_system) VALUES (?, ?, ?, ?, ?, 1)',
      [role.name, role.slug, role.category, role.level, role.description],
    );
    if (result.insertId) {
      roleIds.set(role.slug, Number(result.insertId));
      newRoles.push(role.slug);
    }
  }

  const permissionIds = new Map(
    (await query<{ id: number; code: string }>('SELECT id, code FROM permissions')).map((p) => [p.code, Number(p.id)]),
  );
  const fresh = new Set(newPermissions);
  for (const role of ROLE_DEFINITIONS) {
    const roleId = roleIds.get(role.slug);
    if (!roleId) continue;
    const isNewRole = newRoles.includes(role.slug);
    for (const code of new Set(role.permissions)) {
      if (!isNewRole && !fresh.has(code)) continue;
      const permissionId = permissionIds.get(code);
      if (permissionId) {
        await execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, permissionId]);
      }
    }
  }
  return { newPermissions, newRoles };
}
