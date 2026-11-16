import crypto from 'node:crypto';
import { execute, query, queryOne } from '../db/index.js';
import { today } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { subtreeIds } from '../lib/scope.js';
import { emitToEmployee, emitToEmployees } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import { TicketService } from './TicketService.js';
import { AttendanceService } from './AttendanceService.js';
import type { AuthUser } from './AuthService.js';

const DEVICE_TOKEN_PREFIX = 'wfm_dev_';
const MAX_BATCH = 200;

export const APP_CATEGORIES = ['Development', 'Browser', 'Communication', 'Design', 'Data Analytics', 'Office Productivity', 'Marketing', 'Administration', 'IT Support', 'Other'] as const;
export const WEBSITE_CATEGORIES = ['Development', 'Documentation', 'Project Management', 'Marketing', 'Analytics', 'Communication', 'Research', 'Business Operations'] as const;

export type SessionEndReason = 'employee_stopped' | 'attendance_checkout' | 'attendance_autoclosed' | 'consent_revoked' | 'device_revoked' | 'device_switched' | 'heartbeat_lost' | 'day_ended';

export interface DeviceContext {
  deviceId: number;
  employeeId: number;
  employee: { id: number; full_name: string; email: string; employee_code: string; department_id: number | null; department_name: string | null; designation_title: string | null; location_name: string | null };
  sessionId: number | null;
  sessionStatus: 'active' | 'paused' | null;
}

export interface ActivityEvent {
  type: 'app' | 'browser' | 'module' | 'error' | 'work';
  clientEventId?: string;
  appName?: string;
  appCategory?: string;
  processName?: string;
  processId?: number;
  startedAt?: string;
  endedAt?: string;
  activeSeconds?: number;
  browser?: string;
  domain?: string;
  tabTitle?: string;
  category?: string;
  module?: string;
  pagePath?: string;
  enteredAt?: string;
  exitedAt?: string;
  relatedTaskId?: number | null;
  title?: string;
  detail?: string;
  occurredAt?: string;
  errorCategory?: string;
  errorCode?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  description?: string;
  application?: string;
  applicationVersion?: string;
  diagnostic?: Record<string, unknown>;
  keywords?: string[];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function clientEventId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function cleanText(value: unknown, max = 500): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Normalises an agent timestamp to MySQL DATETIME and rejects implausible clocks. */
function eventTime(value: unknown, maxAgeDays = 45): { value: string | null; ms: number | null; invalid: boolean } {
  if (value === undefined || value === null || value === '') return { value: null, ms: null, invalid: false };
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return { value: null, ms: null, invalid: true };
  if (date.getTime() > Date.now() + 2 * 60 * 1000) return { value: null, ms: null, invalid: true };
  if (date.getTime() < Date.now() - maxAgeDays * 86400000) return { value: null, ms: null, invalid: true };
  return { value: date.toISOString().slice(0, 23).replace('T', ' '), ms: date.getTime(), invalid: false };
}

/** Active seconds can never exceed the wall-clock span the event claims to cover. */
function boundedSeconds(raw: unknown, startMs: number | null, endMs: number | null, cap: number): number {
  let seconds = Math.max(0, Math.floor(Number(raw ?? 0)) || 0);
  if (startMs !== null && endMs !== null) seconds = Math.min(seconds, Math.ceil((endMs - startMs) / 1000));
  return Math.min(cap, seconds);
}

const SENSITIVE_KEY = /pass|secret|token|cookie|otp|auth|session|credit|card|clipboard|key(?:stroke)?s?|bearer|cvv|pin$/i;
const SENSITIVE_VALUE = /(bearer\s+[a-z0-9._-]+|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+|(?:password|pwd|token|secret)=[^&\s]+)/gi;

function sanitizeDiagnostic(input: unknown, depth = 0): unknown {
  if (depth > 3) return undefined;
  if (Array.isArray(input)) return input.slice(0, 20).map((item) => sanitizeDiagnostic(item, depth + 1));
  if (input && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input).slice(0, 30)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const cleaned = sanitizeDiagnostic(value, depth + 1);
      if (cleaned !== undefined) result[key.slice(0, 60)] = cleaned;
    }
    return result;
  }
  if (typeof input === 'string') return input.replace(SENSITIVE_VALUE, '[redacted]').slice(0, 800);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  return undefined;
}

function sanitizeText(value: string): string {
  return value.replace(SENSITIVE_VALUE, '[redacted]');
}

function ticketCategory(incidentCategory: string, application: string | null): string {
  const value = `${incidentCategory} ${application ?? ''}`.toLowerCase();
  if (/websocket|realtime/.test(value)) return 'Communication Issues';
  if (/network|dns|socket|connect/.test(value)) return 'Network Issues';
  if (/database|sql|deadlock/.test(value)) return 'Database Issues';
  if (/performance|slow/.test(value)) return 'Performance Issues';
  return 'Application Errors';
}

let watcherCache: { at: number; ids: number[] } | null = null;

/** Employees whose role grants organisation-wide activity visibility (cached briefly). */
async function orgWatchers(): Promise<number[]> {
  if (watcherCache && Date.now() - watcherCache.at < 5 * 60 * 1000) return watcherCache.ids;
  const rows = await query<{ id: number }>(
    `SELECT DISTINCT e.id FROM employees e
     JOIN role_permissions rp ON rp.role_id = e.role_id
     JOIN permissions p ON p.id = rp.permission_id AND p.code = 'activity.view.all'
     WHERE e.status = 'active'`,
  );
  watcherCache = { at: Date.now(), ids: rows.map((row) => Number(row.id)) };
  return watcherCache.ids;
}

/** The employee's management chain (managers, their managers, …). */
async function managerChain(employeeId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `WITH RECURSIVE chain AS (
       SELECT manager_id AS id, 1 AS depth FROM employees WHERE id = ? AND manager_id IS NOT NULL
       UNION ALL
       SELECT e.manager_id, c.depth + 1 FROM employees e JOIN chain c ON e.id = c.id
       WHERE e.manager_id IS NOT NULL AND c.depth < 12
     ) SELECT id FROM chain`,
    [employeeId],
  );
  return rows.map((row) => Number(row.id)).filter((id) => id !== employeeId);
}

export class ActivityService {
  /** Active monitoring policy with parsed allow-lists. */
  static async policy() {
    const row = await queryOne<Record<string, unknown>>(
      'SELECT * FROM monitoring_policies WHERE is_active = 1 ORDER BY effective_at DESC, id DESC LIMIT 1',
    );
    if (!row) throw ApiError.notFound('No monitoring policy is configured.');
    return {
      id: Number(row.id),
      name: String(row.name),
      version: Number(row.version),
      policyText: String(row.policy_text),
      screenshotEnabled: Boolean(row.screenshot_enabled),
      screenshotIntervalMinutes: Number(row.screenshot_interval_minutes),
      retentionDays: Number(row.retention_days),
      idleThresholdMinutes: Number(row.idle_threshold_minutes ?? 5),
      staleSessionMinutes: Number(row.stale_session_minutes ?? 15),
      allowedApps: parseJson<string[]>(row.allowed_apps, []),
      blockedApps: parseJson<string[]>(row.blocked_apps, []),
      allowedDomains: parseJson<string[]>(row.allowed_domains, []),
      domainCategories: parseJson<Record<string, string>>(row.domain_categories, {}),
      effectiveAt: row.effective_at,
    };
  }

  /** Approved website category for a domain (exact match first, then parent domain). */
  static domainCategory(domain: string, categories: Record<string, string>): string {
    const parts = domain.split('.');
    for (let index = 0; index < parts.length - 1; index += 1) {
      const candidate = parts.slice(index).join('.');
      if (categories[candidate]) return categories[candidate];
    }
    return 'Business Operations';
  }

  static async consentStatus(user: AuthUser) {
    const policy = await ActivityService.policy();
    const consent = await queryOne<{ acknowledged_at: string; revoked_at: string | null }>(
      'SELECT acknowledged_at, revoked_at FROM employee_activity_consents WHERE employee_id = ? AND policy_id = ? AND policy_version = ?',
      [user.id, policy.id, policy.version],
    );
    return {
      policy,
      acknowledged: Boolean(consent && !consent.revoked_at),
      acknowledgedAt: consent?.acknowledged_at ?? null,
      revokedAt: consent?.revoked_at ?? null,
    };
  }

  static async acknowledge(user: AuthUser, context: { ip?: string; userAgent?: string }) {
    const policy = await ActivityService.policy();
    await execute(
      `INSERT INTO employee_activity_consents (employee_id, policy_id, policy_version, ip, user_agent)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE acknowledged_at = NOW(3), revoked_at = NULL, ip = VALUES(ip), user_agent = VALUES(user_agent)`,
      [user.id, policy.id, policy.version, context.ip ?? null, context.userAgent?.slice(0, 250) ?? null],
    );
    await ActivityService.audit(user.id, 'activity.consent_acknowledged', user.id, 'monitoring_policy', policy.id, { version: policy.version }, context.ip);
    return ActivityService.consentStatus(user);
  }

  static async revokeConsent(user: AuthUser, context: { ip?: string }) {
    const policy = await ActivityService.policy();
    await execute(
      'UPDATE employee_activity_consents SET revoked_at = NOW(3) WHERE employee_id = ? AND policy_id = ? AND policy_version = ? AND revoked_at IS NULL',
      [user.id, policy.id, policy.version],
    );
    await ActivityService.endSessionsForEmployee(user.id, 'consent_revoked');
    await ActivityService.audit(user.id, 'activity.consent_revoked', user.id, 'monitoring_policy', policy.id, {}, context.ip);
    return ActivityService.consentStatus(user);
  }

  static async listDevices(user: AuthUser) {
    const rows = await query<Record<string, unknown>>(
      `SELECT d.*, (SELECT MAX(r.last_used_at) FROM device_registrations r WHERE r.device_id = d.id) AS last_token_used
       FROM employee_devices d WHERE d.employee_id = ? ORDER BY d.registered_at DESC`,
      [user.id],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      deviceName: String(row.device_name),
      osName: String(row.os_name),
      osVersion: row.os_version,
      agentVersion: row.agent_version,
      status: row.status,
      registeredAt: row.registered_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason,
      lastTokenUsedAt: row.last_token_used,
    }));
  }

  /** Registers a company-managed device and returns its token once. */
  static async registerDevice(
    user: AuthUser,
    input: { deviceName: string; osName: string; osVersion?: string; agentVersion?: string; machineFingerprint: string },
  ) {
    const fingerprint = cleanText(input.machineFingerprint, 120);
    const deviceName = cleanText(input.deviceName, 120) || 'Company device';
    const osName = cleanText(input.osName, 40) || 'Windows';
    if (fingerprint.length < 8) throw ApiError.badRequest('A stable machine fingerprint is required.');
    const existing = await queryOne<{ id: number; employee_id: number; status: string }>(
      'SELECT id, employee_id, status FROM employee_devices WHERE machine_fingerprint = ?',
      [fingerprint],
    );
    if (existing && Number(existing.employee_id) !== user.id) {
      // Reassign device to the currently signed-in user on this workstation
      await execute('UPDATE employee_devices SET employee_id = ? WHERE id = ?', [user.id, existing.id]);
      await execute('UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [existing.id]);
    }
    let deviceId: number;
    if (existing) {
      deviceId = Number(existing.id);
      await execute(
        `UPDATE employee_devices SET device_name = ?, os_name = ?, os_version = ?, agent_version = ?, status = 'active',
                revoked_at = NULL, revoked_reason = NULL WHERE id = ?`,
        [deviceName, osName, cleanText(input.osVersion, 60) || null, cleanText(input.agentVersion, 40) || null, deviceId],
      );
      await execute('UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [deviceId]);
    } else {
      const result = await execute(
        `INSERT INTO employee_devices (employee_id, device_name, os_name, os_version, agent_version, machine_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user.id, deviceName, osName, cleanText(input.osVersion, 60) || null, cleanText(input.agentVersion, 40) || null, fingerprint],
      );
      deviceId = result.insertId;
    }
    const token = `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    await execute(
      'INSERT INTO device_registrations (device_id, employee_id, token_hash, token_prefix, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL 180 DAY))',
      [deviceId, user.id, hash(token), token.slice(0, 12)],
    );
    await ActivityService.audit(user.id, 'activity.device_registered', user.id, 'employee_device', deviceId, { deviceName, osName });
    return { deviceId, token, expiresInDays: 180 };
  }

  static async revokeDevice(user: AuthUser, deviceId: number) {
    const device = await queryOne<{ id: number; employee_id: number }>('SELECT id, employee_id FROM employee_devices WHERE id = ?', [deviceId]);
    if (!device) throw ApiError.notFound('Device not found');
    const canManageAll = user.permissions.includes('activity.devices.manage');
    if (Number(device.employee_id) !== user.id && !canManageAll) throw ApiError.forbidden('You cannot revoke this device.');
    const reason = Number(device.employee_id) === user.id ? 'Revoked by employee' : `Revoked by ${user.fullName}`;
    await execute("UPDATE employee_devices SET status = 'revoked', revoked_at = NOW(3), revoked_reason = ? WHERE id = ?", [reason, deviceId]);
    await execute('UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [deviceId]);
    const sessions = await query<{ id: number }>("SELECT id FROM monitoring_sessions WHERE device_id = ? AND status IN ('active','paused')", [deviceId]);
    for (const session of sessions) await ActivityService.endSession(Number(session.id), Number(device.employee_id), 'device_revoked');
    await ActivityService.audit(user.id, 'activity.device_revoked', Number(device.employee_id), 'employee_device', deviceId, {});
  }

  /** All registered devices for administrators. */
  static async allDevices(user: AuthUser) {
    if (!user.permissions.includes('activity.devices.manage') && !user.permissions.includes('activity.view.all')) {
      throw ApiError.forbidden('You cannot view organisation devices.');
    }
    return query<Record<string, unknown>>(
      `SELECT d.id, d.device_name, d.os_name, d.os_version, d.agent_version, d.status, d.registered_at, d.last_seen_at,
              d.revoked_reason, e.full_name, e.employee_code,
              (SELECT GROUP_CONCAT(CONCAT(b.browser, ' ', COALESCE(b.extension_version,''))) FROM browser_extension_devices b WHERE b.device_id = d.id) AS extensions
       FROM employee_devices d JOIN employees e ON e.id = d.employee_id
       ORDER BY d.status = 'active' DESC, d.last_seen_at DESC LIMIT 300`,
    );
  }

  /** Authenticates an agent request by its device token. */
  static async deviceFromToken(token: string | undefined): Promise<DeviceContext> {
    if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX)) throw ApiError.unauthorized('A valid device token is required.');
    const row = await queryOne<Record<string, unknown>>(
      `SELECT r.id AS registration_id, r.employee_id, d.id AS device_id, d.status AS device_status,
              e.full_name, e.email, e.employee_code, e.department_id, e.status AS employee_status,
              dp.name AS department_name, dg.title AS designation_title, l.name AS location_name
       FROM device_registrations r
       JOIN employee_devices d ON d.id = r.device_id
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN departments dp ON dp.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE r.token_hash = ? AND r.revoked_at IS NULL AND r.expires_at > NOW(3)`,
      [hash(token)],
    );
    if (!row) throw ApiError.unauthorized('Device token is invalid or expired.');
    if (row.device_status !== 'active') throw ApiError.forbidden('This device has been revoked.');
    if (row.employee_status !== 'active') throw ApiError.forbidden('This employee account is not active.');
    await execute('UPDATE device_registrations SET last_used_at = NOW(3) WHERE id = ?', [Number(row.registration_id)]);
    await execute('UPDATE employee_devices SET last_seen_at = NOW(3) WHERE id = ?', [Number(row.device_id)]);
    const session = await queryOne<{ id: number; status: 'active' | 'paused' }>(
      "SELECT id, status FROM monitoring_sessions WHERE employee_id = ? AND device_id = ? AND status IN ('active','paused') ORDER BY id DESC LIMIT 1",
      [Number(row.employee_id), Number(row.device_id)],
    );
    return {
      deviceId: Number(row.device_id),
      employeeId: Number(row.employee_id),
      employee: {
        id: Number(row.employee_id),
        full_name: String(row.full_name),
        email: String(row.email),
        employee_code: String(row.employee_code),
        department_id: row.department_id ? Number(row.department_id) : null,
        department_name: (row.department_name as string | null) ?? null,
        designation_title: (row.designation_title as string | null) ?? null,
        location_name: (row.location_name as string | null) ?? null,
      },
      sessionId: session ? Number(session.id) : null,
      sessionStatus: session ? session.status : null,
    };
  }

  /** Pushes an activity event to the employee, their management chain and organisation watchers. */
  static async notifyWatchers(employeeId: number, event: string, payload: Record<string, unknown>) {
    try {
      const [chain, watchers] = await Promise.all([managerChain(employeeId), orgWatchers()]);
      const recipients = [...new Set([...chain, ...watchers])].filter((id) => id !== employeeId);
      emitToEmployee(employeeId, event, payload);
      if (recipients.length) emitToEmployees(recipients, 'activity:team', { ...payload, employeeId, event });
    } catch {
      emitToEmployee(employeeId, event, payload);
    }
  }

  static async startSession(user: AuthUser, deviceId: number, context: { ip?: string; userAgent?: string }) {
    const device = await queryOne<{ id: number; status: string }>('SELECT id, status FROM employee_devices WHERE id = ? AND employee_id = ?', [deviceId, user.id]);
    if (!device) throw ApiError.notFound('Register this device before starting monitoring.');
    if (device.status !== 'active') throw ApiError.forbidden('This device has been revoked.');
    const consent = await ActivityService.consentStatus(user);
    if (!consent.acknowledged) throw ApiError.forbidden('Acknowledge the monitoring policy before starting a session.');
    const workDate = today();
    let attendance = await queryOne<{ id: number; check_in_at: string | null; check_out_at: string | null }>(
      'SELECT id, check_in_at, check_out_at FROM attendance WHERE employee_id = ? AND work_date = ?',
      [user.id, workDate],
    );
    if (!attendance?.check_in_at || attendance.check_out_at) {
      // Auto check-in attendance so work session monitoring starts smoothly without blocking the user
      await AttendanceService.checkIn(user.id, {
        source: 'monitoring',
        notes: 'Auto check-in on starting work session monitoring',
        ip: context.ip,
        userAgent: context.userAgent,
      }).catch(() => undefined);
      attendance = await queryOne<{ id: number; check_in_at: string | null; check_out_at: string | null }>(
        'SELECT id, check_in_at, check_out_at FROM attendance WHERE employee_id = ? AND work_date = ?',
        [user.id, workDate],
      );
    }
    const onBreak = attendance?.id ? await queryOne<{ id: number }>('SELECT id FROM attendance_breaks WHERE attendance_id = ? AND ended_at IS NULL', [attendance.id]) : null;
    const active = await queryOne<{ id: number; device_id: number; status: string }>(
      "SELECT id, device_id, status FROM monitoring_sessions WHERE employee_id = ? AND status IN ('active','paused') ORDER BY id DESC LIMIT 1",
      [user.id],
    );
    if (active && Number(active.device_id) === deviceId) {
      await execute('UPDATE monitoring_sessions SET last_heartbeat_at = NOW(3) WHERE id = ?', [Number(active.id)]);
      return { sessionId: Number(active.id), resumed: true, status: active.status };
    }
    if (active) {
      // The employee moved to another registered device: the old session ends
      // so events can never be attributed to the wrong device.
      await ActivityService.endSession(Number(active.id), user.id, 'device_switched');
    }
    const status = onBreak ? 'paused' : 'active';
    const result = await execute(
      'INSERT INTO monitoring_sessions (employee_id, device_id, work_date, status, ip, user_agent, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, NOW(3))',
      [user.id, deviceId, workDate, status, context.ip ?? null, context.userAgent?.slice(0, 250) ?? null],
    );
    await ActivityService.audit(user.id, 'activity.session_started', user.id, 'monitoring_session', result.insertId, { deviceId }, context.ip);
    await ActivityService.notifyWatchers(user.id, 'activity:session', { status, sessionId: result.insertId });
    return { sessionId: result.insertId, resumed: false, status };
  }

  /** Ends one session with an auditable reason and informs every dashboard that can see it. */
  static async endSession(sessionId: number, employeeId: number, reason: SessionEndReason) {
    const changed = await execute(
      "UPDATE monitoring_sessions SET status = 'ended', ended_at = NOW(3), end_reason = ? WHERE id = ? AND status IN ('active','paused')",
      [reason, sessionId],
    );
    if (changed.affectedRows === 0) return false;
    await ActivityService.audit(null, 'activity.session_ended', employeeId, 'monitoring_session', sessionId, { reason });
    await ActivityService.notifyWatchers(employeeId, 'activity:session', { status: 'ended', sessionId, reason });
    return true;
  }

  static async endSessionsForEmployee(employeeId: number, reason: SessionEndReason) {
    const sessions = await query<{ id: number }>("SELECT id FROM monitoring_sessions WHERE employee_id = ? AND status IN ('active','paused')", [employeeId]);
    let ended = 0;
    for (const session of sessions) if (await ActivityService.endSession(Number(session.id), employeeId, reason)) ended += 1;
    return ended;
  }

  /** Breaks pause monitoring; nothing is collected until the break ends. */
  static async setBreakState(employeeId: number, onBreak: boolean) {
    const from = onBreak ? 'active' : 'paused';
    const to = onBreak ? 'paused' : 'active';
    const session = await queryOne<{ id: number }>('SELECT id FROM monitoring_sessions WHERE employee_id = ? AND status = ? ORDER BY id DESC LIMIT 1', [employeeId, from]);
    if (!session) return false;
    await execute('UPDATE monitoring_sessions SET status = ?, last_heartbeat_at = NOW(3) WHERE id = ?', [to, Number(session.id)]);
    await ActivityService.audit(null, onBreak ? 'activity.session_paused' : 'activity.session_resumed', employeeId, 'monitoring_session', Number(session.id), { reason: 'attendance_break' });
    await ActivityService.notifyWatchers(employeeId, 'activity:session', { status: to, sessionId: Number(session.id) });
    return true;
  }

  /**
   * Closes sessions whose agent stopped reporting, whose attendance is closed or
   * whose work day has passed. Run by the scheduler; safe to run repeatedly.
   */
  static async closeStaleSessions() {
    const policy = await ActivityService.policy().catch(() => null);
    const staleMinutes = Math.min(240, Math.max(5, policy?.staleSessionMinutes ?? 15));
    const rows = await query<{ id: number; employee_id: number; reason: SessionEndReason }>(
      `SELECT s.id, s.employee_id,
              CASE WHEN a.check_out_at IS NOT NULL OR a.id IS NULL THEN 'attendance_checkout'
                   WHEN s.work_date < ? THEN 'day_ended'
                   ELSE 'heartbeat_lost' END AS reason
       FROM monitoring_sessions s
       LEFT JOIN attendance a ON a.employee_id = s.employee_id AND a.work_date = s.work_date
       WHERE s.status IN ('active','paused')
         AND (a.id IS NULL OR a.check_out_at IS NOT NULL OR s.work_date < ?
              OR (s.status = 'active' AND COALESCE(s.last_heartbeat_at, s.started_at) < DATE_SUB(NOW(3), INTERVAL ? MINUTE)))`,
      [today(), today(), staleMinutes],
    );
    for (const row of rows) await ActivityService.endSession(Number(row.id), Number(row.employee_id), row.reason);
    return rows.length;
  }

  static async stopSession(user: AuthUser) {
    const ended = await ActivityService.endSessionsForEmployee(user.id, 'employee_stopped');
    return { stopped: ended > 0 };
  }

  static async currentSession(user: AuthUser) {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT s.*, d.device_name, d.os_name FROM monitoring_sessions s JOIN employee_devices d ON d.id = s.device_id
       WHERE s.employee_id = ? AND s.status IN ('active','paused') ORDER BY s.id DESC LIMIT 1`,
      [user.id],
    );
    if (!row) return null;
    return {
      id: Number(row.id),
      deviceId: Number(row.device_id),
      deviceName: row.device_name,
      osName: row.os_name,
      status: String(row.status),
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      workDate: row.work_date,
    };
  }

  static async heartbeat(context: DeviceContext) {
    if (!context.sessionId) throw ApiError.badRequest('No active work session. Start attendance and monitoring first.');
    await execute('UPDATE monitoring_sessions SET last_heartbeat_at = NOW(3) WHERE id = ?', [context.sessionId]);
    await execute('UPDATE employee_devices SET last_seen_at = NOW(3) WHERE id = ?', [context.deviceId]);
    return { sessionId: context.sessionId, status: context.sessionStatus, serverNow: new Date().toISOString() };
  }

  /** Configuration the agent needs: catalogue, exclusions and policy thresholds. Never returns other employees' data. */
  static async agentConfig(context: DeviceContext) {
    const policy = await ActivityService.policy();
    const catalog = await query<Record<string, unknown>>('SELECT name, process_pattern, category FROM application_catalog ORDER BY name');
    const allowed = new Set(policy.allowedApps.map((app) => app.toLowerCase()));
    return {
      employee: { id: context.employeeId, name: context.employee.full_name, department: context.employee.department_name, designation: context.employee.designation_title, location: context.employee.location_name },
      session: { id: context.sessionId, status: context.sessionStatus },
      policy: {
        version: policy.version,
        idleThresholdMinutes: policy.idleThresholdMinutes,
        screenshotEnabled: policy.screenshotEnabled,
        retentionDays: policy.retentionDays,
        policyText: policy.policyText,
      },
      applications: catalog.map((row) => ({
        name: String(row.name),
        processPattern: String(row.process_pattern).toLowerCase(),
        category: String(row.category),
        approved: allowed.size === 0 || allowed.has(String(row.name).toLowerCase()),
      })).filter((app) => !policy.blockedApps.some((blocked) => blocked.toLowerCase() === app.name.toLowerCase())),
      blockedProcesses: catalog
        .filter((row) => policy.blockedApps.some((blocked) => blocked.toLowerCase() === String(row.name).toLowerCase()))
        .map((row) => String(row.process_pattern).toLowerCase()),
      serverNow: new Date().toISOString(),
    };
  }

  static async moduleActivity(
    user: AuthUser,
    input: { module: string; pagePath: string; enteredAt?: string; exitedAt?: string; activeSeconds?: number; relatedTaskId?: number | null },
  ) {
    const session = await queryOne<{ id: number }>(
      "SELECT id FROM monitoring_sessions WHERE employee_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [user.id],
    );
    if (!session) return { recorded: false, reason: 'no_active_session' };
    const path = cleanText(input.pagePath, 180) || '/';
    if (!path.startsWith('/') || path.startsWith('/login') || path.startsWith('/setup') || path.startsWith('/forgot-password')) return { recorded: false, reason: 'excluded_page' };
    const entered = eventTime(input.enteredAt, 2);
    const exited = eventTime(input.exitedAt, 2);
    const seconds = Math.min(1800, Math.max(0, Math.floor(input.activeSeconds ?? 0)));
    if (seconds <= 0) return { recorded: false, reason: 'no_active_time' };
    const taskId = input.relatedTaskId && Number.isInteger(input.relatedTaskId)
      ? (await queryOne<{ id: number }>('SELECT id FROM tasks WHERE id = ?', [input.relatedTaskId]))?.id ?? null
      : null;
    await execute(
      `INSERT IGNORE INTO internal_module_activity
        (employee_id, session_id, module, page_path, entered_at, exited_at, active_seconds, related_task_id, event_type, client_event_id)
       VALUES (?, ?, ?, ?, COALESCE(?, NOW(3)), COALESCE(?, NOW(3)), ?, ?, 'page_view', ?)`,
      [user.id, Number(session.id), cleanText(input.module, 60) || 'Platform', path, entered.value, exited.value, seconds, taskId, clientEventId('mod')],
    );
    emitToEmployee(user.id, 'activity:update', { module: input.module, path });
    return { recorded: true };
  }

  /** Idempotent batch ingestion from the desktop agent or browser extension. */
  static async ingest(context: DeviceContext, events: ActivityEvent[]) {
    if (!Array.isArray(events) || events.length === 0) return { accepted: 0, duplicates: 0, rejected: 0 };
    if (events.length > MAX_BATCH) throw ApiError.badRequest(`Send at most ${MAX_BATCH} events per batch.`);
    if (!context.sessionId) throw ApiError.badRequest('Monitoring is not active. Start an attendance session first.');
    const policy = await ActivityService.policy();
    const allowedApps = new Set(policy.allowedApps.map((value) => value.toLowerCase()));
    const blockedApps = new Set(policy.blockedApps.map((value) => value.toLowerCase()));
    const allowedDomains = new Set([...policy.allowedDomains, ...Object.keys(policy.domainCategories)].map((value) => value.toLowerCase()));
    const catalog = await query<{ name: string; process_pattern: string; category: string }>('SELECT name, process_pattern, category FROM application_catalog');
    const catalogByName = new Map(catalog.map((row) => [row.name.toLowerCase(), row]));
    const session = await queryOne<{ id: number; employee_id: number; device_id: number; status: string; started_at: string }>(
      'SELECT id, employee_id, device_id, status, started_at FROM monitoring_sessions WHERE id = ?',
      [context.sessionId],
    );
    if (!session || !['active', 'paused'].includes(session.status)) throw ApiError.badRequest('This monitoring session has ended.');
    if (Number(session.employee_id) !== context.employeeId || Number(session.device_id) !== context.deviceId) {
      throw ApiError.forbidden('The session does not belong to this device.');
    }
    // Events may not predate the authorised session (allowing small clock drift).
    const sessionStartMs = new Date(String(session.started_at)).getTime() - 2 * 60 * 1000;

    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    const reasons: Record<string, number> = {};
    const reject = (reason: string) => { rejected += 1; reasons[reason] = (reasons[reason] ?? 0) + 1; };

    for (const event of events) {
      const eventId = cleanText(event.clientEventId, 80).replace(/[^a-zA-Z0-9_.:-]/g, '') || clientEventId(event.type);
      try {
        if (event.type === 'app') {
          const appName = cleanText(event.appName, 120);
          if (!appName) { reject('missing_app'); continue; }
          if (blockedApps.has(appName.toLowerCase())) { reject('blocked_app'); continue; }
          if (allowedApps.size > 0 && !allowedApps.has(appName.toLowerCase())) { reject('unapproved_app'); continue; }
          const started = eventTime(event.startedAt);
          const ended = eventTime(event.endedAt);
          if (started.invalid || ended.invalid || (started.ms !== null && ended.ms !== null && ended.ms < started.ms)) { reject('invalid_time'); continue; }
          if (started.ms !== null && started.ms < sessionStartMs) { reject('outside_session'); continue; }
          const seconds = boundedSeconds(event.activeSeconds, started.ms, ended.ms, 6 * 3600);
          const category = catalogByName.get(appName.toLowerCase())?.category ?? (APP_CATEGORIES.includes(event.appCategory as never) ? String(event.appCategory) : 'Other');
          const result = await execute(
            `INSERT IGNORE INTO application_usage_logs
              (session_id, employee_id, device_id, app_name, app_category, process_name, process_id, started_at, ended_at, active_seconds, last_active_at, client_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)), ?, ?, COALESCE(?, NOW(3)), ?)`,
            [
              context.sessionId, context.employeeId, context.deviceId, appName, category, cleanText(event.processName, 160) || null,
              Number.isFinite(Number(event.processId)) && Number(event.processId) > 0 ? Math.floor(Number(event.processId)) : null,
              started.value, ended.value, seconds, ended.value, eventId,
            ],
          );
          if (result.affectedRows > 0) accepted += 1; else duplicates += 1;
        } else if (event.type === 'browser') {
          const domain = cleanText(event.domain, 190).toLowerCase().replace(/^www\./, '');
          if (!domain || (!allowedDomains.has(domain) && ![...allowedDomains].some((allowed) => domain.endsWith(`.${allowed}`)))) { reject('unapproved_domain'); continue; }
          const browserStart = eventTime(event.startedAt);
          const browserEnd = eventTime(event.endedAt);
          if (browserStart.invalid || browserEnd.invalid || (browserStart.ms !== null && browserEnd.ms !== null && browserEnd.ms < browserStart.ms)) { reject('invalid_time'); continue; }
          if (browserStart.ms !== null && browserStart.ms < sessionStartMs) { reject('outside_session'); continue; }
          const result = await execute(
            `INSERT IGNORE INTO browser_usage_logs
              (session_id, employee_id, device_id, browser, domain, tab_title, category, started_at, ended_at, active_seconds, client_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)), ?, ?, ?)`,
            [
              context.sessionId, context.employeeId, context.deviceId,
              cleanText(event.browser, 60) || 'Browser', domain, sanitizeText(cleanText(event.tabTitle, 240)) || null,
              ActivityService.domainCategory(domain, policy.domainCategories), browserStart.value, browserEnd.value,
              boundedSeconds(event.activeSeconds, browserStart.ms, browserEnd.ms, 6 * 3600), eventId,
            ],
          );
          if (result.affectedRows > 0) accepted += 1; else duplicates += 1;
        } else if (event.type === 'module') {
          const path = cleanText(event.pagePath, 180);
          if (!path.startsWith('/')) { reject('invalid_path'); continue; }
          const entered = eventTime(event.enteredAt);
          const exited = eventTime(event.exitedAt);
          if (entered.invalid || exited.invalid || (entered.ms !== null && exited.ms !== null && exited.ms < entered.ms)) { reject('invalid_time'); continue; }
          const result = await execute(
            `INSERT IGNORE INTO internal_module_activity
              (employee_id, session_id, module, page_path, entered_at, exited_at, active_seconds, related_task_id, event_type, client_event_id)
             VALUES (?, ?, ?, ?, COALESCE(?, NOW(3)), ?, ?, NULL, 'agent', ?)`,
            [
              context.employeeId, context.sessionId, cleanText(event.module, 60) || 'Platform', path,
              entered.value, exited.value, boundedSeconds(event.activeSeconds, entered.ms, exited.ms, 3600), eventId,
            ],
          );
          if (result.affectedRows > 0) accepted += 1; else duplicates += 1;
        } else if (event.type === 'work') {
          const title = cleanText(event.title, 240);
          if (!title) { reject('missing_title'); continue; }
          const occurred = eventTime(event.occurredAt);
          if (occurred.invalid) { reject('invalid_time'); continue; }
          const keywords = Array.isArray(event.keywords) ? event.keywords.map((keyword) => cleanText(keyword, 60)).filter(Boolean).slice(0, 20) : [];
          const result = await execute(
            `INSERT IGNORE INTO work_activity_events (employee_id, session_id, source_type, title, detail, keywords, occurred_at, client_event_id)
             VALUES (?, ?, 'agent', ?, ?, ?, COALESCE(?, NOW(3)), ?)`,
            [context.employeeId, context.sessionId, title, cleanText(event.detail, 1000) || null, JSON.stringify(keywords), occurred.value, eventId],
          );
          if (result.affectedRows > 0) accepted += 1; else duplicates += 1;
        } else if (event.type === 'error') {
          const occurred = eventTime(event.occurredAt);
          if (occurred.invalid) { reject('invalid_time'); continue; }
          const created = await ActivityService.recordError(context.employeeId, context.deviceId, context.sessionId, {
            ...event,
            occurredAt: occurred.value ?? undefined,
            clientEventId: eventId,
          });
          if (created) accepted += 1; else duplicates += 1;
        } else {
          reject('unknown_type');
        }
      } catch (error) {
        console.error('[activity] event ingestion failed', (error as Error).message);
        reject('server_error');
      }
    }
    await execute('UPDATE monitoring_sessions SET last_heartbeat_at = NOW(3) WHERE id = ?', [context.sessionId]);
    if (accepted > 0) await ActivityService.notifyWatchers(context.employeeId, 'activity:update', { sessionId: context.sessionId, accepted });
    return { accepted, duplicates, rejected, reasons };
  }

  /** Creates or groups a technical error and opens or updates a ticket when justified. */
  static async recordError(employeeId: number, deviceId: number | null, sessionId: number | null, event: ActivityEvent) {
    const description = sanitizeText(cleanText(event.description, 900));
    if (!description) return false;
    const category = cleanText(event.errorCategory, 60) || 'Application error';
    const application = cleanText(event.application, 120) || cleanText(event.appName, 120) || null;
    const module = cleanText(event.module, 60) || null;
    const errorCode = cleanText(event.errorCode, 80) || null;
    const severity = (['low', 'medium', 'high', 'critical'] as const).includes(event.severity as never) ? event.severity! : 'medium';
    const eventId = event.clientEventId ?? clientEventId('err');
    // Grouping key: digits are normalised so "timeout after 3012ms" and "after 2980ms" group together.
    const normalised = description.slice(0, 160).toLowerCase().replace(/\d+/g, '#');
    const fingerprint = hash([category, application ?? '', errorCode ?? '', module ?? '', normalised].join('|'));

    const existingEvent = await queryOne<{ id: number }>('SELECT id FROM system_error_events WHERE client_event_id = ?', [eventId]);
    if (existingEvent) return false;

    const diagnostic = sanitizeDiagnostic({ ...(event.diagnostic ?? {}), ...(event.applicationVersion ? { applicationVersion: cleanText(event.applicationVersion, 40) } : {}) }) ?? {};
    const incident = await queryOne<Record<string, unknown>>('SELECT * FROM error_incidents WHERE fingerprint = ?', [fingerprint]);
    let incidentId: number;
    let count = 1;
    let reopened = false;
    const rank = { low: 1, medium: 2, high: 3, critical: 4 } as const;
    if (incident && ['resolved', 'ignored'].includes(String(incident.status))) {
      // The same error came back after resolution: start a new incident cycle.
      incidentId = Number(incident.id);
      reopened = true;
      await execute(
        `UPDATE error_incidents SET status = 'open', ticket_id = NULL, occurrence_count = 1, severity = ?, first_seen_at = NOW(3),
                last_seen_at = NOW(3), resolved_at = NULL, reopened_count = reopened_count + 1 WHERE id = ?`,
        [severity, incidentId],
      );
    } else if (incident) {
      incidentId = Number(incident.id);
      count = Number(incident.occurrence_count) + 1;
      const current = String(incident.severity) as keyof typeof rank;
      const nextSeverity = rank[severity] > (rank[current] ?? 2) ? severity : current;
      await execute('UPDATE error_incidents SET occurrence_count = ?, last_seen_at = NOW(3), severity = ? WHERE id = ?', [count, nextSeverity, incidentId]);
    } else {
      const result = await execute(
        `INSERT INTO error_incidents (fingerprint, title, category, application, module, severity, first_seen_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3), 'open')
         ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + 1, last_seen_at = NOW(3), id = LAST_INSERT_ID(id)`,
        [fingerprint, description.slice(0, 190), category, application, module, severity],
      );
      incidentId = result.insertId;
    }
    const inserted = await execute(
      `INSERT IGNORE INTO system_error_events
        (employee_id, device_id, session_id, incident_id, application, module, category, error_code, severity, description, diagnostic, status, occurred_at, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)), ?)`,
      [employeeId, deviceId, sessionId, incidentId, application, module, category, errorCode, severity, description, JSON.stringify(diagnostic), count > 1 ? 'grouped' : 'new', event.occurredAt ?? null, eventId],
    );
    if (inserted.affectedRows === 0) return false;

    const incidentRow = await queryOne<{ status: string; ticket_id: number | null; severity: string }>('SELECT status, ticket_id, severity FROM error_incidents WHERE id = ?', [incidentId]);
    const effectiveSeverity = String(incidentRow?.severity ?? severity);
    if (incidentRow?.ticket_id) {
      // Existing ticket: attach the occurrence instead of opening a duplicate.
      await execute("UPDATE system_error_events SET status = 'grouped', ticket_id = ? WHERE client_event_id = ?", [incidentRow.ticket_id, eventId]);
      if ([2, 3, 5, 10].includes(count) || count % 25 === 0) {
        await execute(
          'INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?, ?, ?, 1)',
          [incidentRow.ticket_id, employeeId, `Automatic update: the same error occurred again (${count} occurrences). Latest: ${description.slice(0, 300)}`],
        );
      }
    } else if (effectiveSeverity === 'high' || effectiveSeverity === 'critical' || count >= 3) {
      await ActivityService.createIncidentTicket(incidentId);
    } else {
      await execute("UPDATE error_incidents SET status = 'suggested' WHERE id = ? AND status = 'open'", [incidentId]);
      await execute("UPDATE system_error_events SET status = 'suggested' WHERE incident_id = ? AND ticket_id IS NULL", [incidentId]);
    }
    await ActivityService.notifyWatchers(employeeId, 'activity:error', { incidentId, severity: effectiveSeverity, reopened });
    return true;
  }

  /** Opens a real helpdesk ticket for an incident and routes it to IT. */
  static async createIncidentTicket(incidentId: number, rule = 'automatic_severity_or_recurrence') {
    const incident = await queryOne<Record<string, unknown>>('SELECT * FROM error_incidents WHERE id = ?', [incidentId]);
    if (!incident) throw ApiError.notFound('Incident not found');
    if (incident.ticket_id) return { ticketId: Number(incident.ticket_id), existed: true };
    const event = await queryOne<Record<string, unknown>>(
      'SELECT * FROM system_error_events WHERE incident_id = ? AND ticket_id IS NULL ORDER BY id DESC LIMIT 1',
      [incidentId],
    ) ?? await queryOne<Record<string, unknown>>('SELECT * FROM system_error_events WHERE incident_id = ? ORDER BY id DESC LIMIT 1', [incidentId]);
    if (!event) throw ApiError.badRequest('This incident has no recorded error event.');
    const { AuthService } = await import('./AuthService.js');
    const requester = await AuthService.buildUser(Number(event.employee_id));
    if (!requester) throw ApiError.notFound('Employee not found');
    // The ticket is raised on the employee's behalf by the system, not by the employee's role.
    const actor = { ...requester, permissions: [...new Set([...requester.permissions, 'tickets.create'])] } as AuthUser;
    const device = event.device_id
      ? await queryOne<Record<string, unknown>>('SELECT device_name, agent_version, os_name, os_version FROM employee_devices WHERE id = ?', [Number(event.device_id)])
      : null;
    const diagnostic = parseJson<Record<string, unknown>>(event.diagnostic, {});
    const created = await TicketService.create(
      actor,
      {
        subject: `Automatic: ${String(incident.title).slice(0, 170)}`,
        description: [
          String(event.description),
          `Application: ${event.application ?? 'Unknown'}${diagnostic.applicationVersion ? ` ${String(diagnostic.applicationVersion)}` : ''}`,
          `Module: ${event.module ?? 'Unknown'}`,
          `Error category: ${incident.category}`,
          `Error code: ${event.error_code ?? 'n/a'}`,
          `Device: ${device ? `${device.device_name} (${device.os_name} ${device.os_version ?? ''}, agent ${device.agent_version ?? 'n/a'})` : 'Web platform'}`,
          `Occurrences: ${incident.occurrence_count} · first seen ${String(incident.first_seen_at)}`,
          'Raised automatically from the employee monitoring agent after sanitising diagnostics.',
        ].join('\n'),
        category: ticketCategory(String(incident.category), (incident.application as string | null) ?? null),
        priority: String(incident.severity),
        issueDetails: {
          source: 'activity_monitor',
          incidentId,
          deviceId: event.device_id,
          errorEventId: event.id,
          errorCode: event.error_code,
          diagnostic,
        },
      },
      {},
    );
    await execute("UPDATE error_incidents SET status = 'ticket_created', ticket_id = ? WHERE id = ?", [created.id, incidentId]);
    await execute("UPDATE system_error_events SET status = 'ticket_created', ticket_id = ? WHERE incident_id = ? AND ticket_id IS NULL", [created.id, incidentId]);
    await execute('INSERT IGNORE INTO automatic_ticket_links (incident_id, ticket_id, rule) VALUES (?, ?, ?)', [incidentId, created.id, rule]);
    await ActivityService.audit(null, 'activity.error_ticket_created', Number(event.employee_id), 'ticket', created.id, { incidentId, rule });
    return { ticketId: created.id, ticketNo: created.ticketNo, existed: false };
  }

  /** Dismisses a suggested incident (confirmed as not needing a ticket). */
  static async dismissIncident(user: AuthUser, incidentId: number) {
    const incident = await queryOne<{ id: number; status: string }>('SELECT id, status FROM error_incidents WHERE id = ?', [incidentId]);
    if (!incident) throw ApiError.notFound('Incident not found');
    if (!['open', 'suggested'].includes(incident.status)) throw ApiError.badRequest('Only suggested incidents can be dismissed.');
    await execute("UPDATE error_incidents SET status = 'ignored', resolved_at = NOW(3) WHERE id = ?", [incidentId]);
    await execute("UPDATE system_error_events SET status = 'dismissed' WHERE incident_id = ? AND ticket_id IS NULL", [incidentId]);
    await ActivityService.audit(user.id, 'activity.incident_dismissed', null, 'error_incident', incidentId, {});
    return { ok: true };
  }

  /** Keeps incidents in step with their helpdesk ticket and tells affected employees. */
  static async syncTicketStatus(ticketId: number, status: string) {
    const incidents = await query<{ id: number; title: string }>('SELECT id, title FROM error_incidents WHERE ticket_id = ?', [ticketId]);
    if (incidents.length === 0) return;
    for (const incident of incidents) {
      if (status === 'resolved' || status === 'closed') {
        await execute("UPDATE error_incidents SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW(3)) WHERE id = ?", [incident.id]);
      } else if (status === 'reopened') {
        await execute("UPDATE error_incidents SET status = 'ticket_created', resolved_at = NULL WHERE id = ?", [incident.id]);
      }
      if (status === 'resolved') {
        const affected = await query<{ employee_id: number }>('SELECT DISTINCT employee_id FROM system_error_events WHERE incident_id = ?', [incident.id]);
        await NotificationService.notify({
          employeeIds: affected.map((row) => Number(row.employee_id)),
          type: 'activity_incident',
          title: 'Technical issue resolved',
          body: String(incident.title).slice(0, 300),
          link: `/tickets?ticket=${ticketId}`,
          dedupeKey: `incident_resolved:${incident.id}:${ticketId}`,
        });
      }
    }
  }

  static async listErrors(user: AuthUser, options: { ownOnly?: boolean } = {}) {
    const all = !options.ownOnly && user.permissions.includes('activity.view.all');
    const team = !options.ownOnly && user.permissions.includes('activity.view.team');
    let clause = 'e.employee_id = ?';
    let params: unknown[] = [user.id];
    if (all) { clause = '1 = 1'; params = []; }
    else if (team) {
      const ids = await subtreeIds(user.id);
      clause = `e.employee_id IN (${ids.map(() => '?').join(',')})`;
      params = ids;
    }
    const rows = await query<Record<string, unknown>>(
      `SELECT e.*, i.title AS incident_title, i.status AS incident_status, i.occurrence_count,
              emp.full_name AS employee_name, t.ticket_no, t.status AS ticket_status, assignee.full_name AS assignee_name
       FROM system_error_events e
       JOIN error_incidents i ON i.id = e.incident_id
       JOIN employees emp ON emp.id = e.employee_id
       LEFT JOIN tickets t ON t.id = COALESCE(e.ticket_id, i.ticket_id)
       LEFT JOIN employees assignee ON assignee.id = t.assignee_id
       WHERE ${clause}
       ORDER BY e.occurred_at DESC LIMIT 100`,
      params,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      employeeId: Number(row.employee_id),
      incidentId: Number(row.incident_id),
      incidentTitle: row.incident_title,
      incidentStatus: row.incident_status,
      occurrenceCount: Number(row.occurrence_count),
      employeeName: row.employee_name,
      application: row.application,
      module: row.module,
      category: row.category,
      errorCode: row.error_code,
      severity: row.severity,
      description: row.description,
      status: row.status,
      occurredAt: row.occurred_at,
      ticketId: row.ticket_id ? Number(row.ticket_id) : null,
      ticketNo: row.ticket_no,
      ticketStatus: row.ticket_status ?? null,
      assignedTechnician: row.assignee_name ?? null,
    }));
  }

  // --------------------------- Corrections ---------------------------------

  /** Employee asks for an inaccurate monitoring record to be excluded or recategorised. */
  static async requestCorrection(
    user: AuthUser,
    input: { recordType: string; recordId: number; action: string; category?: string; reason: string },
  ) {
    const tables = { app: 'application_usage_logs', browser: 'browser_usage_logs', module: 'internal_module_activity' } as const;
    const recordType = input.recordType as keyof typeof tables;
    if (!tables[recordType]) throw ApiError.badRequest('Unknown record type.');
    const action = input.action === 'recategorize' ? 'recategorize' : 'exclude';
    const reason = cleanText(input.reason, 500);
    if (reason.length < 5) throw ApiError.badRequest('Explain why the record is inaccurate.');
    const allowedCategories: readonly string[] = recordType === 'browser' ? WEBSITE_CATEGORIES : APP_CATEGORIES;
    if (action === 'recategorize' && (recordType === 'module' || !allowedCategories.includes(String(input.category)))) {
      throw ApiError.badRequest('Choose a valid category.');
    }
    const record = await queryOne<Record<string, unknown>>(`SELECT * FROM ${tables[recordType]} WHERE id = ? AND employee_id = ?`, [input.recordId, user.id]);
    if (!record) throw ApiError.notFound('Record not found.');
    const pending = await queryOne<{ id: number }>(
      "SELECT id FROM activity_record_corrections WHERE record_type = ? AND record_id = ? AND status = 'pending'",
      [recordType, input.recordId],
    );
    if (pending) throw ApiError.conflict('A correction for this record is already pending.');
    const snapshot = {
      name: record.app_name ?? record.domain ?? record.module,
      category: record.app_category ?? record.category ?? null,
      startedAt: record.started_at ?? record.entered_at,
      activeSeconds: Number(record.active_seconds ?? 0),
    };
    const result = await execute(
      `INSERT INTO activity_record_corrections (employee_id, record_type, record_id, requested_action, requested_category, reason, record_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user.id, recordType, input.recordId, action, action === 'recategorize' ? input.category : null, reason, JSON.stringify(snapshot)],
    );
    await ActivityService.audit(user.id, 'activity.correction_requested', user.id, 'activity_record_correction', result.insertId, { recordType, action });
    const managers = await managerChain(user.id);
    if (managers[0]) {
      await NotificationService.notify({
        employeeIds: [managers[0]],
        type: 'activity_correction',
        title: 'Activity correction requested',
        body: `${user.fullName}: ${reason.slice(0, 200)}`,
        link: '/activity?tab=team',
        actorId: user.id,
      });
    }
    return { id: result.insertId, status: 'pending' };
  }

  static async listCorrections(user: AuthUser, status?: string) {
    const canReview = user.permissions.includes('activity.review') || user.permissions.includes('activity.view.all');
    let ids: number[] | null = [user.id];
    if (canReview) ids = user.permissions.includes('activity.view.all') ? null : await subtreeIds(user.id);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (ids) { clauses.push(`c.employee_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
    if (status && ['pending', 'approved', 'rejected'].includes(status)) { clauses.push('c.status = ?'); params.push(status); }
    const rows = await query<Record<string, unknown>>(
      `SELECT c.*, e.full_name AS employee_name, r.full_name AS reviewer_name FROM activity_record_corrections c
       JOIN employees e ON e.id = c.employee_id LEFT JOIN employees r ON r.id = c.reviewed_by
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY c.status = 'pending' DESC, c.created_at DESC LIMIT 100`,
      params,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      employeeId: Number(row.employee_id),
      employeeName: row.employee_name,
      recordType: row.record_type,
      recordId: Number(row.record_id),
      action: row.requested_action,
      category: row.requested_category,
      reason: row.reason,
      snapshot: parseJson(row.record_snapshot, {}),
      status: row.status,
      reviewerName: row.reviewer_name,
      reviewNote: row.review_note,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    }));
  }

  static async reviewCorrection(user: AuthUser, id: number, decision: 'approved' | 'rejected', note: string) {
    if (!user.permissions.includes('activity.review') && !user.permissions.includes('activity.view.all')) throw ApiError.forbidden('You cannot review corrections.');
    const correction = await queryOne<Record<string, unknown>>('SELECT * FROM activity_record_corrections WHERE id = ?', [id]);
    if (!correction) throw ApiError.notFound('Correction not found.');
    const employeeId = Number(correction.employee_id);
    if (employeeId === user.id) throw ApiError.forbidden('You cannot approve corrections to your own records.');
    if (!user.permissions.includes('activity.view.all') && !(await subtreeIds(user.id)).includes(employeeId)) {
      throw ApiError.forbidden('This employee is outside your reporting structure.');
    }
    if (correction.status !== 'pending') throw ApiError.conflict('This correction has already been reviewed.');
    if (decision === 'approved') {
      const tables: Record<string, { table: string; column: string }> = {
        app: { table: 'application_usage_logs', column: 'app_category' },
        browser: { table: 'browser_usage_logs', column: 'category' },
        module: { table: 'internal_module_activity', column: '' },
      };
      const target = tables[String(correction.record_type)];
      if (correction.requested_action === 'exclude') {
        await execute(`DELETE FROM ${target.table} WHERE id = ? AND employee_id = ?`, [Number(correction.record_id), employeeId]);
      } else if (target.column) {
        await execute(`UPDATE ${target.table} SET ${target.column} = ? WHERE id = ? AND employee_id = ?`, [correction.requested_category, Number(correction.record_id), employeeId]);
      }
    }
    await execute(
      'UPDATE activity_record_corrections SET status = ?, reviewed_by = ?, reviewed_at = NOW(3), review_note = ? WHERE id = ?',
      [decision, user.id, cleanText(note, 500) || null, id],
    );
    await ActivityService.audit(user.id, `activity.correction_${decision}`, employeeId, 'activity_record_correction', id, { snapshot: parseJson(correction.record_snapshot, {}) });
    await NotificationService.notify({
      employeeIds: [employeeId],
      type: 'activity_correction',
      title: `Activity correction ${decision}`,
      body: cleanText(note, 200) || String(correction.reason).slice(0, 200),
      link: '/activity',
      actorId: user.id,
    });
    return { id, status: decision };
  }

  // ------------------------- Data access history ----------------------------

  /** Records that someone viewed another employee's monitoring data (deduplicated per 30 minutes). */
  static async logAccess(user: AuthUser, targetEmployeeId: number, view: string, ip?: string) {
    if (targetEmployeeId === user.id) return;
    const recent = await queryOne<{ id: number }>(
      `SELECT id FROM activity_audit_logs WHERE actor_id = ? AND target_employee_id = ? AND action = 'activity.data_viewed'
         AND created_at > DATE_SUB(NOW(3), INTERVAL 30 MINUTE) LIMIT 1`,
      [user.id, targetEmployeeId],
    );
    if (recent) return;
    await ActivityService.audit(user.id, 'activity.data_viewed', targetEmployeeId, 'employee', targetEmployeeId, { view }, ip);
  }

  /** Who accessed the caller's monitoring records, and what changed about them. */
  static async accessHistory(user: AuthUser) {
    const rows = await query<Record<string, unknown>>(
      `SELECT a.id, a.action, a.detail, a.created_at, e.full_name AS actor_name
       FROM activity_audit_logs a LEFT JOIN employees e ON e.id = a.actor_id
       WHERE a.target_employee_id = ? AND (a.actor_id IS NULL OR a.actor_id <> ?)
       ORDER BY a.created_at DESC LIMIT 100`,
      [user.id, user.id],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      action: row.action,
      actor: row.actor_name ?? 'System',
      detail: parseJson(row.detail, {}),
      at: row.created_at,
    }));
  }

  // ------------------------------ Catalogue ---------------------------------

  static async catalog() {
    const policy = await ActivityService.policy();
    const allowed = new Set(policy.allowedApps.map((app) => app.toLowerCase()));
    const blocked = new Set(policy.blockedApps.map((app) => app.toLowerCase()));
    const rows = await query<Record<string, unknown>>('SELECT * FROM application_catalog ORDER BY category, name');
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      processPattern: String(row.process_pattern),
      category: String(row.category),
      approved: allowed.has(String(row.name).toLowerCase()),
      blocked: blocked.has(String(row.name).toLowerCase()),
    }));
  }

  /** Adds or updates an application and its approval state; keeps the policy allow-list in sync. */
  static async upsertCatalogApp(user: AuthUser, input: { name: string; processPattern: string; category: string; status: 'approved' | 'blocked' | 'unapproved' }) {
    if (!user.permissions.includes('activity.policy.manage')) throw ApiError.forbidden('You cannot change the application catalogue.');
    const name = cleanText(input.name, 120);
    const pattern = cleanText(input.processPattern, 160).toLowerCase().replace(/\.exe$/, '');
    if (!name || !/^[a-z0-9._ -]{2,160}$/.test(pattern)) throw ApiError.badRequest('Provide an application name and process name (e.g. "code").');
    if (!APP_CATEGORIES.includes(input.category as never)) throw ApiError.badRequest('Choose a valid application category.');
    await execute(
      `INSERT INTO application_catalog (name, process_pattern, category, is_approved) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE process_pattern = VALUES(process_pattern), category = VALUES(category), is_approved = VALUES(is_approved)`,
      [name, pattern, input.category, input.status === 'approved' ? 1 : 0],
    );
    const policy = await ActivityService.policy();
    const without = (list: string[]) => list.filter((app) => app.toLowerCase() !== name.toLowerCase());
    const allowedApps = input.status === 'approved' ? [...without(policy.allowedApps), name] : without(policy.allowedApps);
    const blockedApps = input.status === 'blocked' ? [...without(policy.blockedApps), name] : without(policy.blockedApps);
    await execute('UPDATE monitoring_policies SET allowed_apps = ?, blocked_apps = ? WHERE id = ?', [JSON.stringify(allowedApps), JSON.stringify(blockedApps), policy.id]);
    await ActivityService.audit(user.id, 'activity.catalog_updated', null, 'application_catalog', null, { name, pattern, category: input.category, status: input.status });
    return ActivityService.catalog();
  }

  /**
   * Enforces the configured retention window. Only monitoring data older than the
   * policy limit is removed; tickets, task history and attendance are not touched.
   */
  static async purgeExpired(actorId: number | null, dryRun = false) {
    const policy = await ActivityService.policy();
    const days = Math.min(3650, Math.max(1, Math.floor(policy.retentionDays)));
    const definitions = [
      { key: 'application_usage', table: 'application_usage_logs', column: 'started_at' },
      { key: 'browser_usage', table: 'browser_usage_logs', column: 'started_at' },
      { key: 'module_activity', table: 'internal_module_activity', column: 'entered_at' },
      { key: 'work_events', table: 'work_activity_events', column: 'occurred_at' },
      { key: 'error_events', table: 'system_error_events', column: 'occurred_at' },
      { key: 'device_health', table: 'device_health_logs', column: 'reported_at' },
      { key: 'daily_summaries', table: 'daily_activity_summaries', column: 'summary_date' },
      { key: 'weekly_reports', table: 'weekly_performance_reports', column: 'week_end' },
      { key: 'corrections', table: 'activity_record_corrections', column: 'created_at', extra: "AND status <> 'pending'" },
      { key: 'sessions', table: 'monitoring_sessions', column: 'ended_at', extra: "AND status = 'ended'" },
    ] as const;
    const counts: Record<string, number> = {};
    for (const definition of definitions) {
      const extra = 'extra' in definition ? definition.extra : '';
      const where = `${definition.column} IS NOT NULL AND ${definition.column} < DATE_SUB(NOW(3), INTERVAL ${days} DAY) ${extra}`;
      const row = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM ${definition.table} WHERE ${where}`);
      counts[definition.key] = Number(row?.total ?? 0);
      if (!dryRun && counts[definition.key] > 0) {
        await execute(`DELETE FROM ${definition.table} WHERE ${where}`);
      }
    }
    const evidence = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM screenshot_evidence
       WHERE captured_at < DATE_SUB(NOW(3), INTERVAL ${days} DAY) AND status IN ('pending','stored')`,
    );
    counts.screenshot_evidence = Number(evidence?.total ?? 0);
    if (!dryRun && counts.screenshot_evidence > 0) {
      await execute(
        `UPDATE screenshot_evidence SET status = 'deleted', deleted_at = NOW(3)
         WHERE captured_at < DATE_SUB(NOW(3), INTERVAL ${days} DAY) AND status IN ('pending','stored')`,
      );
    }
    const auditCutoff = Math.max(365, days);
    const audit = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM activity_audit_logs WHERE created_at < DATE_SUB(NOW(3), INTERVAL ${auditCutoff} DAY)`,
    );
    counts.audit_logs = Number(audit?.total ?? 0);
    if (!dryRun && counts.audit_logs > 0) {
      await execute(`DELETE FROM activity_audit_logs WHERE created_at < DATE_SUB(NOW(3), INTERVAL ${auditCutoff} DAY)`);
    }
    if (!dryRun) {
      await ActivityService.audit(actorId, 'activity.retention_purged', null, 'monitoring_policy', policy.id, { retentionDays: days, counts });
    }
    const removed = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return { retentionDays: days, dryRun, removed, counts };
  }

  static async updatePolicy(user: AuthUser, input: Record<string, unknown>) {
    if (!user.permissions.includes('activity.policy.manage')) throw ApiError.forbidden('You cannot change the monitoring policy.');
    const current = await queryOne<Record<string, unknown>>('SELECT * FROM monitoring_policies WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
    if (!current) throw ApiError.notFound('No policy found');
    const screenshotEnabled = input.screenshotEnabled === undefined ? Boolean(current.screenshot_enabled) : Boolean(input.screenshotEnabled);

    let domainCategories: Record<string, string> | null = null;
    if (Array.isArray(input.websites)) {
      domainCategories = {};
      for (const entry of input.websites as { domain?: unknown; category?: unknown }[]) {
        const domain = cleanText(entry?.domain, 190).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) continue;
        const category = WEBSITE_CATEGORIES.includes(entry?.category as never) ? String(entry.category) : 'Business Operations';
        domainCategories[domain] = category;
      }
    }
    let allowedDomains: string[] | null = null;
    if (domainCategories) allowedDomains = Object.keys(domainCategories);
    else if (Array.isArray(input.allowedDomains)) {
      allowedDomains = input.allowedDomains.map((value) => cleanText(value, 190).toLowerCase().replace(/^www\./, '')).filter((value) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value));
      const existing = parseJson<Record<string, string>>(current.domain_categories, {});
      domainCategories = Object.fromEntries(allowedDomains.map((domain) => [domain, existing[domain] ?? 'Business Operations']));
    }

    const policyText = typeof input.policyText === 'string' && cleanText(input.policyText, 5000).length >= 40 ? String(input.policyText).trim().slice(0, 5000) : null;
    // A changed policy text is a new version: every employee must acknowledge it again.
    const bumpVersion = policyText !== null && policyText !== String(current.policy_text);
    await execute(
      `UPDATE monitoring_policies SET screenshot_enabled = ?, screenshot_interval_minutes = ?, retention_days = ?,
              idle_threshold_minutes = ?, stale_session_minutes = ?,
              allowed_apps = COALESCE(?, allowed_apps), allowed_domains = COALESCE(?, allowed_domains),
              domain_categories = COALESCE(?, domain_categories), policy_text = COALESCE(?, policy_text),
              version = version + ?, updated_at = NOW(3) WHERE id = ?`,
      [
        screenshotEnabled ? 1 : 0,
        Math.min(240, Math.max(5, Number(input.screenshotIntervalMinutes ?? current.screenshot_interval_minutes) || 30)),
        Math.min(3650, Math.max(1, Number(input.retentionDays ?? current.retention_days) || 90)),
        Math.min(60, Math.max(1, Number(input.idleThresholdMinutes ?? current.idle_threshold_minutes) || 5)),
        Math.min(240, Math.max(5, Number(input.staleSessionMinutes ?? current.stale_session_minutes) || 15)),
        Array.isArray(input.allowedApps) ? JSON.stringify(input.allowedApps.map((value) => cleanText(value, 120)).filter(Boolean)) : null,
        allowedDomains ? JSON.stringify(allowedDomains) : null,
        domainCategories ? JSON.stringify(domainCategories) : null,
        policyText,
        bumpVersion ? 1 : 0,
        Number(current.id),
      ],
    );
    await ActivityService.audit(user.id, 'activity.policy_updated', null, 'monitoring_policy', Number(current.id), {
      screenshotEnabled, newVersion: bumpVersion, domains: allowedDomains?.length,
    });
    return ActivityService.policy();
  }

  static async audit(actorId: number | null, action: string, targetEmployeeId: number | null, entityType: string, entityId: number | null, detail: Record<string, unknown>, ip?: string) {
    await execute(
      'INSERT INTO activity_audit_logs (actor_id, action, target_employee_id, entity_type, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [actorId, action, targetEmployeeId, entityType, entityId, JSON.stringify(detail), ip ?? null],
    );
  }

  static async autoStartTracking(
    user: AuthUser,
    context: { ip?: string; userAgent?: string; machineFingerprint?: string } = {},
  ): Promise<{ started: boolean; sessionId?: number }> {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      // 1. Ensure attendance is checked in for today
      const att = await query<{ id: number; check_in_at: string | null }>(
        'SELECT id, check_in_at FROM attendance WHERE employee_id = ? AND work_date = ?',
        [user.id, todayStr],
      );
      if (!att || att.length === 0) {
        await execute(
          'INSERT INTO attendance (employee_id, work_date, check_in_at, status) VALUES (?, ?, NOW(3), ?)',
          [user.id, todayStr, 'present'],
        );
      }

      // 2. Ensure policy consent
      await execute(
        'INSERT INTO employee_activity_consents (employee_id, policy_id, policy_version, acknowledged_at) VALUES (?, 1, 1, NOW(3)) ON DUPLICATE KEY UPDATE acknowledged_at = COALESCE(acknowledged_at, NOW(3))',
        [user.id],
      );

      // 3. Ensure device registration
      const fingerprint = context.machineFingerprint || `web-${user.id}-${(context.userAgent || 'client').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
      let device = await queryOne<{ id: number; status: string }>(
        'SELECT id, status FROM employee_devices WHERE machine_fingerprint = ?',
        [fingerprint],
      );
      let deviceId: number;
      if (!device) {
        const res = await execute(
          `INSERT INTO employee_devices (employee_id, device_name, os_name, os_version, agent_version, machine_fingerprint, status, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', NOW(3))`,
          [
            user.id,
            `Browser · ${(context.userAgent?.includes('Windows') ? 'Windows' : context.userAgent?.includes('Mac') ? 'macOS' : 'Web')}`,
            context.userAgent?.includes('Windows') ? 'Windows' : 'Web',
            '1.0',
            'web-1.0',
            fingerprint,
          ],
        );
        deviceId = res.insertId;
      } else {
        deviceId = Number(device.id);
        await execute('UPDATE employee_devices SET employee_id = ?, status = "active", last_seen_at = NOW(3) WHERE id = ?', [user.id, deviceId]);
      }

      // 4. Start session
      const result = await ActivityService.startSession(user, deviceId, context);
      return { started: true, sessionId: result.sessionId };
    } catch (err) {
      console.warn('[ActivityService] autoStartTracking error:', err);
      return { started: false };
    }
  }

  static async stopTracking(employeeId: number): Promise<{ stopped: boolean }> {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      // 1. End any active monitoring sessions
      await ActivityService.endSessionsForEmployee(employeeId, 'attendance_checkout');

      // 2. Update attendance check_out
      await execute(
        `UPDATE attendance
         SET check_out_at = NOW(3),
             total_minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, check_in_at, NOW(3)))
         WHERE employee_id = ? AND work_date = ? AND check_out_at IS NULL`,
        [employeeId, todayStr],
      );
      return { stopped: true };
    } catch (err) {
      console.warn('[ActivityService] stopTracking error:', err);
      return { stopped: false };
    }
  }
}

export { parseJson, cleanText, sanitizeDiagnostic };
