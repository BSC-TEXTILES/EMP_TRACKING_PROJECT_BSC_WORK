import { execute, query } from '../../db/index.js';
import { emitToEmployees } from '../../realtime/io.js';

/** Writes to the shared activity audit trail. Never throws (auditing must not break tracking). */
export async function trackingAudit(
  actorId: number | null,
  action: string,
  targetEmployeeId: number | null,
  entityType: string,
  entityId: number | null,
  detail: Record<string, unknown>,
  ip?: string,
): Promise<void> {
  try {
    await execute(
      'INSERT INTO activity_audit_logs (actor_id, action, target_employee_id, entity_type, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [actorId, action, targetEmployeeId, entityType, entityId, JSON.stringify(detail), ip ?? null],
    );
  } catch (error) {
    console.error('[tracking] audit write failed', (error as Error).message);
  }
}

interface Watcher { id: number; locations: Set<number> | null }
let watcherCache: { at: number; watchers: Watcher[] } | null = null;

/** Holders of activity.view.all with the locations they may see (null = all). */
async function orgWatchers(): Promise<Watcher[]> {
  if (watcherCache && Date.now() - watcherCache.at < 2 * 60 * 1000) return watcherCache.watchers;
  const rows = await query<{ id: number; location_id: number | null; loc_code: string | null; all_locations: number }>(
    `SELECT e.id, e.location_id, l.code AS loc_code,
            EXISTS (SELECT 1 FROM role_permissions rp2 JOIN permissions p2 ON p2.id = rp2.permission_id
                    WHERE rp2.role_id = e.role_id AND p2.code = 'locations.view.all') AS all_locations
     FROM employees e
     LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.status = 'active' AND EXISTS (
       SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = e.role_id AND p.code = 'activity.view.all')`,
  );
  const extra = await query<{ employee_id: number; location_id: number }>(
    `SELECT employee_id, location_id FROM employee_locations
     UNION SELECT employee_id, location_id FROM location_hr_assignments`,
  ).catch(() => []);
  const watchers = rows.map((row) => {
    if (Number(row.all_locations) || row.loc_code === 'ALL') return { id: Number(row.id), locations: null };
    const set = new Set<number>(extra.filter((x) => Number(x.employee_id) === Number(row.id)).map((x) => Number(x.location_id)));
    if (row.location_id) set.add(Number(row.location_id));
    return { id: Number(row.id), locations: set };
  });
  watcherCache = { at: Date.now(), watchers };
  return watchers;
}

const chainCache = new Map<number, { at: number; ids: number[]; locationId: number | null }>();

async function employeeContext(employeeId: number) {
  const cached = chainCache.get(employeeId);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;
  const chain = await query<{ id: number }>(
    `WITH RECURSIVE chain AS (
       SELECT manager_id AS id, 1 AS depth FROM employees WHERE id = ? AND manager_id IS NOT NULL
       UNION ALL
       SELECT e.manager_id, c.depth + 1 FROM employees e JOIN chain c ON e.id = c.id
       WHERE e.manager_id IS NOT NULL AND c.depth < 12
     ) SELECT id FROM chain`,
    [employeeId],
  );
  const loc = await query<{ location_id: number | null }>('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
  const value = { at: Date.now(), ids: chain.map((row) => Number(row.id)), locationId: loc[0]?.location_id ? Number(loc[0].location_id) : null };
  chainCache.set(employeeId, value);
  return value;
}

/** Everyone allowed to watch this employee's tracking data (excluding the employee). */
export async function trackingWatchers(employeeId: number): Promise<number[]> {
  const [{ ids: chain, locationId }, watchers] = await Promise.all([employeeContext(employeeId), orgWatchers()]);
  const org = watchers
    .filter((w) => w.locations === null || (locationId !== null && w.locations.has(locationId)))
    .map((w) => w.id);
  return [...new Set([...chain, ...org])].filter((id) => id !== employeeId);
}

/** Pushes a realtime tracking event to the employee and to authorised watchers. Never throws. */
export async function emitTracking(employeeId: number, event: 'tracking:update' | 'tracking:alert', payload: Record<string, unknown>): Promise<void> {
  try {
    const recipients = await trackingWatchers(employeeId);
    emitToEmployees([employeeId, ...recipients], event, { employeeId, ...payload });
  } catch (error) {
    console.error('[tracking] realtime emit failed', (error as Error).message);
  }
}
