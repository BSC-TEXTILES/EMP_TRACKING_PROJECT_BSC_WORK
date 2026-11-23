import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { execute, query, queryOne } from '../../db/index.js';
import { ApiError } from '../../lib/http.js';
import { addDays, parseUtc, toSql, today } from '../../lib/dates.js';
import { allowedLocationIds } from '../../lib/scope.js';
import type { AuthUser } from '../AuthService.js';
import { NotificationService } from '../NotificationService.js';
import { recordSystemEvent } from './TrackingAgentService.js';
import { TrackingConfig, compareVersions } from './TrackingConfig.js';
import { canSeeOthers, deviceLive, devicesByEmployee, trackingScope } from './TrackingQueryService.js';
import { emitTracking, trackingAudit, trackingWatchers } from './trackingAudit.js';

const gzip = promisify(zlib.gzip);
let sweeping = false;

/** Root folder for retention archives (sibling of the uploads folder). */
function archiveRoot(): string {
  return path.resolve(path.dirname(path.resolve(config.uploadDir)), 'tracking-archive');
}

export const TrackingWorker = {
  /**
   * Marks devices whose heartbeats stopped as offline, closes their sessions and
   * raises alerts. Runs every minute from the scheduler (no browser required).
   */
  async sweepOffline(): Promise<number> {
    if (sweeping) return 0;
    sweeping = true;
    try {
      const candidates = await query<Record<string, unknown>>(
        `SELECT s.device_id, s.employee_id, s.last_heartbeat_at, s.agent_state, e.location_id, e.full_name, d.device_name
         FROM tracking_device_status s
         JOIN employee_devices d ON d.id = s.device_id AND d.status = 'active'
         JOIN employees e ON e.id = s.employee_id
         WHERE s.agent_state IN ('running','disabled') AND s.last_heartbeat_at IS NOT NULL
           AND s.last_heartbeat_at < DATE_SUB(NOW(3), INTERVAL 60 SECOND)`,
      );
      let changed = 0;
      for (const row of candidates) {
        const settings = await TrackingConfig.forLocation(row.location_id ? Number(row.location_id) : null);
        const last = parseUtc(String(row.last_heartbeat_at));
        if (!last || Date.now() - last.getTime() <= settings.offlineAfterSeconds * 1000) continue;
        const deviceId = Number(row.device_id);
        const employeeId = Number(row.employee_id);
        const result = await execute(
          `UPDATE tracking_device_status SET agent_state = 'offline', activity_state = 'offline', went_offline_at = last_heartbeat_at,
                  connection_failures = connection_failures + 1
           WHERE device_id = ? AND agent_state IN ('running','disabled')`,
          [deviceId],
        );
        if (!result.affectedRows) continue;
        changed += 1;
        await execute(
          `UPDATE tracking_sessions SET ended_at = last_seen_at, end_reason = 'heartbeat_lost'
           WHERE device_id = ? AND ended_at IS NULL`,
          [deviceId],
        );
        await recordSystemEvent({ deviceId, employeeId }, 'device_offline', 'Device disconnected', `${row.device_name} stopped sending heartbeats`, last);
        void emitTracking(employeeId, 'tracking:alert', {
          kind: 'device_offline', severity: 'warning', deviceId,
          message: `${row.full_name}: tracking agent on ${row.device_name} disconnected.`,
        });
        await notifyIfWorking(employeeId, String(row.full_name), String(row.device_name), deviceId);
      }
      await TrackingWorker.notifySyncFailures();
      return changed;
    } finally {
      sweeping = false;
    }
  },

  /** Persistent notification when a connected device has failed to upload for 30+ minutes. */
  async notifySyncFailures(): Promise<void> {
    const rows = await query<Record<string, unknown>>(
      `SELECT s.device_id, s.employee_id, s.pending_events, s.last_sync_error, e.full_name, d.device_name
       FROM tracking_device_status s
       JOIN employee_devices d ON d.id = s.device_id AND d.status = 'active'
       JOIN employees e ON e.id = s.employee_id
       WHERE s.agent_state = 'running' AND s.last_heartbeat_at > DATE_SUB(NOW(3), INTERVAL 5 MINUTE)
         AND ((s.last_sync_error IS NOT NULL AND s.last_sync_error_at < DATE_SUB(NOW(3), INTERVAL 30 MINUTE))
              OR (s.pending_events > 0 AND (s.last_sync_at IS NULL OR s.last_sync_at < DATE_SUB(NOW(3), INTERVAL 30 MINUTE))))`,
    );
    for (const row of rows) {
      const employeeId = Number(row.employee_id);
      const recipients = await trackingWatchers(employeeId);
      if (!recipients.length) continue;
      await NotificationService.notify({
        employeeIds: recipients,
        type: 'tracking_sync',
        title: `Tracking data not synchronising — ${row.full_name}`,
        body: `${row.device_name} has ${row.pending_events} event(s) waiting to upload${row.last_sync_error ? ` (${String(row.last_sync_error).slice(0, 120)})` : ''}.`,
        link: `/activity-tracking/${employeeId}`,
        priority: 'normal',
        dedupeKey: `tracking-sync:${row.device_id}:${today()}`,
      }).catch(() => undefined);
    }
  },

  /** Records currently needing attention, within the viewer's scope. */
  async alerts(user: AuthUser) {
    if (!canSeeOthers(user)) throw ApiError.forbidden('You do not have access to tracking alerts.');
    const scope = await trackingScope(user);
    const date = today();
    const where = scope === null ? '' : scope.length ? `AND e.id IN (${scope.map(() => '?').join(',')})` : 'AND 1 = 0';
    const employees = await query<Record<string, unknown>>(
      `SELECT e.id, e.full_name, e.employee_code, e.location_id, l.code AS location_code,
              EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.work_date = ? AND a.check_in_at IS NOT NULL AND a.check_out_at IS NULL) AS checked_in
       FROM employees e LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.status = 'active' ${where}`,
      [date, ...(scope ?? [])],
    );
    const devices = await devicesByEmployee(employees.map((e) => Number(e.id)));
    const alerts: { kind: string; severity: 'critical' | 'warning' | 'info'; employeeId: number; employeeName: string; employeeCode: string; locationCode: string | null; deviceId?: number; message: string; since?: string | null }[] = [];
    for (const e of employees) {
      const id = Number(e.id);
      const settings = await TrackingConfig.forLocation(e.location_id ? Number(e.location_id) : null);
      if (!settings.trackingEnabled) continue;
      const base = { employeeId: id, employeeName: String(e.full_name), employeeCode: String(e.employee_code), locationCode: (e.location_code as string | null) ?? null };
      const list = (devices.get(id) ?? []).map((d) => deviceLive(d, settings));
      if (list.length === 0) {
        if (Number(e.checked_in)) alerts.push({ ...base, kind: 'not_installed', severity: 'warning', message: 'Checked in today but no tracking device is registered.' });
        continue;
      }
      for (const d of list) {
        if (!d.online && Number(e.checked_in)) {
          alerts.push({ ...base, kind: 'device_offline', severity: 'critical', deviceId: d.deviceId, since: d.lastHeartbeatAt, message: `Tracking agent on ${d.deviceName} is disconnected while the employee is checked in.` });
        } else if (!d.online && d.agentState === 'stopped') {
          alerts.push({ ...base, kind: 'agent_stopped', severity: 'info', deviceId: d.deviceId, since: d.lastHeartbeatAt, message: `Tracking agent on ${d.deviceName} was stopped.` });
        }
        if (d.syncError) alerts.push({ ...base, kind: 'sync_error', severity: 'warning', deviceId: d.deviceId, since: d.lastSyncAt, message: `${d.deviceName}: ${d.syncError}.` });
        if (d.online && !d.noticeAcknowledgedAt) alerts.push({ ...base, kind: 'notice_pending', severity: 'info', deviceId: d.deviceId, message: `${d.deviceName}: employee has not yet acknowledged the monitoring notice, so no activity is collected.` });
        if (d.agentVersion && compareVersions(d.agentVersion, settings.minimumAgentVersion) < 0) alerts.push({ ...base, kind: 'outdated_agent', severity: 'warning', deviceId: d.deviceId, message: `${d.deviceName} runs agent ${d.agentVersion}; minimum is ${settings.minimumAgentVersion}.` });
      }
    }
    const order = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.employeeName.localeCompare(b.employeeName));
    return { generatedAt: new Date().toISOString(), alerts };
  },

  /**
   * Retention: rows older than each location's retention period are written to a
   * gzip JSON-lines archive and then deleted in small chunks. dryRun only counts.
   */
  async retention(actor: AuthUser | null, dryRun: boolean, ip?: string) {
    if (actor) {
      if (!actor.permissions.includes('activity.policy.manage')) throw ApiError.forbidden('You cannot run tracking retention.');
      if ((await allowedLocationIds(actor)) !== null) throw ApiError.forbidden('Only organisation-wide administrators can run retention.');
    }
    const locations = await query<{ id: number | null }>(
      "SELECT DISTINCT location_id AS id FROM employees",
    );
    const plan: { locationId: number | null; cutoff: string; events: number; heartbeats: number; sessions: number }[] = [];
    for (const { id } of locations) {
      const settings = await TrackingConfig.forLocation(id);
      const cutoff = addDays(today(), -settings.retentionDays);
      const locClause = id === null ? 'location_id IS NULL' : 'location_id = ?';
      const params = id === null ? [] : [id];
      const [events, heartbeats, sessions] = await Promise.all([
        queryOne<{ n: number }>(`SELECT COUNT(*) n FROM tracking_events WHERE work_date < ? AND employee_id IN (SELECT id FROM employees WHERE ${locClause})`, [cutoff, ...params]),
        queryOne<{ n: number }>(`SELECT COUNT(*) n FROM tracking_heartbeats WHERE received_at < ? AND employee_id IN (SELECT id FROM employees WHERE ${locClause})`, [`${cutoff} 00:00:00`, ...params]),
        queryOne<{ n: number }>(`SELECT COUNT(*) n FROM tracking_sessions WHERE work_date < ? AND employee_id IN (SELECT id FROM employees WHERE ${locClause})`, [cutoff, ...params]),
      ]);
      plan.push({ locationId: id, cutoff, events: Number(events?.n ?? 0), heartbeats: Number(heartbeats?.n ?? 0), sessions: Number(sessions?.n ?? 0) });
    }
    if (dryRun) return { dryRun: true, plan };

    const folder = path.join(archiveRoot(), toSql(new Date()).replace(/[: ]/g, '-'));
    const archived: string[] = [];
    for (const item of plan) {
      if (!item.events && !item.heartbeats && !item.sessions) continue;
      const locClause = item.locationId === null ? 'location_id IS NULL' : 'location_id = ?';
      const params = item.locationId === null ? [] : [item.locationId];
      for (const [table, column, value] of [
        ['tracking_events', 'work_date', item.cutoff],
        ['tracking_sessions', 'work_date', item.cutoff],
        ['tracking_heartbeats', 'received_at', `${item.cutoff} 00:00:00`],
      ] as const) {
        let part = 0;
        for (;;) {
          const rows = await query<Record<string, unknown>>(
            `SELECT * FROM ${table} WHERE ${column} < ? AND employee_id IN (SELECT id FROM employees WHERE ${locClause}) ORDER BY id LIMIT 5000`,
            [value, ...params],
          );
          if (!rows.length) break;
          if (table !== 'tracking_heartbeats') {
            await fs.mkdir(folder, { recursive: true });
            const file = path.join(folder, `${table}-loc${item.locationId ?? 'none'}-${String(part).padStart(4, '0')}.jsonl.gz`);
            await fs.writeFile(file, await gzip(rows.map((row) => JSON.stringify(row)).join('\n')), { mode: 0o600 });
            archived.push(path.relative(archiveRoot(), file));
          }
          if (table === 'tracking_sessions') {
            // Events reference sessions; detach any remaining references before deletion.
            await execute(`UPDATE tracking_events SET session_id = NULL WHERE session_id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id));
          }
          await execute(`DELETE FROM ${table} WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id));
          part += 1;
        }
      }
    }
    await execute('DELETE FROM tracking_sync_batches WHERE received_at < DATE_SUB(NOW(3), INTERVAL 400 DAY)');
    await execute('DELETE FROM tracking_enrollment_codes WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 90 DAY)');
    await trackingAudit(actor?.id ?? null, 'tracking.retention_run', null, 'tracking_retention', null, { plan, archiveFiles: archived.length, folder }, ip);
    return { dryRun: false, plan, archiveFolder: archived.length ? folder : null, archiveFiles: archived.length };
  },
};

/** Persistent notification when tracking stops while the employee is checked in for work. */
async function notifyIfWorking(employeeId: number, name: string, device: string, deviceId: number): Promise<void> {
  const working = await queryOne<{ id: number }>(
    'SELECT id FROM attendance WHERE employee_id = ? AND work_date = ? AND check_in_at IS NOT NULL AND check_out_at IS NULL LIMIT 1',
    [employeeId, today()],
  ).catch(() => null);
  if (!working) return;
  const recipients = await trackingWatchers(employeeId);
  if (!recipients.length) return;
  await NotificationService.notify({
    employeeIds: recipients,
    type: 'tracking_offline',
    title: `Tracking agent disconnected — ${name}`,
    body: `${device} stopped reporting while ${name} is checked in.`,
    link: `/activity-tracking/${employeeId}`,
    priority: 'normal',
    dedupeKey: `tracking-offline:${deviceId}:${today()}`,
  }).catch(() => undefined);
}
