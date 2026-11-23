import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { execute, query, queryOne, transaction, txExecute, txQueryOne } from '../../db/index.js';
import { ApiError } from '../../lib/http.js';
import { localDate, toSql } from '../../lib/dates.js';
import { assertEmployeeAccess } from '../../lib/scope.js';
import { TrackingConfig, compareVersions } from './TrackingConfig.js';
import { emitTracking, trackingAudit } from './trackingAudit.js';
export const DEVICE_TOKEN_PREFIX = 'bsct_';
const TOKEN_TTL_DAYS = 730;
const TOKEN_ROTATE_WITHIN_DAYS = 30;
const ENROLLMENT_TTL_HOURS = 72;
const MAX_BATCH = 500;
/**
 * Longest single interval accepted. The agent rolls intervals over every 60 s, but an
 * active interval stays open while input is absent (it may still become idle), so it
 * can last up to the idle threshold (max 3600 s) plus one roll-over period.
 */
const MAX_INTERVAL_SECONDS = 3900;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const INSTALLER_NAME = 'BSC-Activity-Tracker-Setup.exe';
const serviceDir = path.dirname(fileURLToPath(import.meta.url));
/** Locates the built installer (TRACKING_AGENT_INSTALLER overrides). */
export function installerPath() {
    const candidates = [
        process.env.TRACKING_AGENT_INSTALLER,
        path.resolve(serviceDir, '../../../../tracking-agent/dist', INSTALLER_NAME),
        path.resolve(process.cwd(), 'tracking-agent/dist', INSTALLER_NAME),
        path.resolve(process.cwd(), '../tracking-agent/dist', INSTALLER_NAME),
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}
let cachedInstaller = null;
/**
 * Hash, size and signing status of the installer. Signing status comes from the
 * release-manifest.json written by the build's release gate and is only trusted when the
 * manifest's hash matches the installer actually on disk.
 */
export function getInstallerInfo() {
    const found = installerPath();
    if (!found)
        return null;
    try {
        const stat = fs.statSync(found);
        const manifestFile = path.join(path.dirname(found), 'release-manifest.json');
        const manifestStat = fs.existsSync(manifestFile) ? fs.statSync(manifestFile) : null;
        const key = `${found}:${stat.mtimeMs}:${stat.size}:${manifestStat?.mtimeMs ?? 0}`;
        if (cachedInstaller?.key === key)
            return cachedInstaller.info;
        const hash = crypto.createHash('sha256').update(fs.readFileSync(found)).digest('hex');
        let manifest = null;
        if (manifestStat) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^﻿/, ''));
            }
            catch {
                manifest = null;
            }
        }
        const matches = manifest?.sha256?.setup?.toLowerCase() === hash;
        const info = {
            sha256: hash,
            size: stat.size,
            version: matches ? String(manifest.version ?? '') || null : null,
            releaseGrade: Boolean(matches && manifest.kind === 'release' && manifest.releaseGrade === true),
            signer: matches ? manifest.setup?.signer ?? null : null,
            issuer: matches ? manifest.setup?.issuer ?? null : null,
            timestamped: Boolean(matches && manifest.setup?.timestamp),
            problems: !manifest ? ['No release manifest: this installer was not produced by the signed release pipeline (tracking-agent/build.ps1).']
                : !matches ? ['release-manifest.json does not match the installer on disk.']
                    : Array.isArray(manifest.problems) ? manifest.problems.map(String).slice(0, 20) : [],
        };
        cachedInstaller = { key, info };
        return info;
    }
    catch {
        return null;
    }
}
function normaliseCode(code) {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function generateCode() {
    const bytes = crypto.randomBytes(10);
    let out = '';
    for (const byte of bytes)
        out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return out;
}
/** Strips anything that is not a plain hostname; returns null for invalid input. */
export function cleanDomain(raw) {
    if (typeof raw !== 'string')
        return null;
    let host = raw.trim().toLowerCase();
    if (!host)
        return null;
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '');
    if (host.length > 190 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') && host !== 'localhost')
        return null;
    return host;
}
function clip(value, max) {
    if (typeof value !== 'string')
        return null;
    // Control characters are removed so log/CSV/PDF output cannot be corrupted.
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text ? text.slice(0, max) : null;
}
const iso = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid timestamp');
export const enrollSchema = z.object({
    enrollmentCode: z.string().trim().min(8).max(24),
    deviceUid: z.string().trim().regex(/^[a-f0-9]{32,64}$/i, 'Invalid device id'),
    hostname: z.string().trim().min(1).max(120),
    osName: z.string().trim().max(60).optional(),
    osVersion: z.string().trim().max(60).optional(),
    agentVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/),
});
export const heartbeatSchema = z.object({
    state: z.enum(['active', 'idle', 'locked']).default('active'),
    currentApp: z.string().max(200).nullable().optional(),
    currentBrowser: z.string().max(60).nullable().optional(),
    currentDomain: z.string().max(250).nullable().optional(),
    pendingEvents: z.number().int().min(0).max(10_000_000).default(0),
    droppedEvents: z.number().int().min(0).max(10_000_000).default(0),
    syncFailures: z.number().int().min(0).max(10_000_000).default(0),
    lastError: z.string().max(300).nullable().optional(),
    agentVersion: z.string().max(20).optional(),
    osVersion: z.string().max(60).optional(),
    sessionId: z.string().max(64).optional(),
    sessionStartedAt: iso.optional(),
    extensionSeenAt: iso.nullable().optional(),
    trackingPaused: z.boolean().optional(),
    sentAt: iso,
});
const EVENT_TYPES = ['activity', 'web', 'session_start', 'session_end', 'lock', 'unlock', 'idle_start', 'idle_end',
    'suspend', 'resume', 'agent_start', 'agent_stop', 'tracking_disabled', 'tracking_enabled'];
const eventSchema = z.object({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{8,64}$/),
    type: z.enum(EVENT_TYPES),
    sessionId: z.string().regex(/^[A-Za-z0-9_.:-]{8,64}$/).optional(),
    start: iso,
    end: iso.optional(),
    state: z.enum(['active', 'idle', 'locked']).optional(),
    app: z.string().max(300).optional(),
    process: z.string().max(300).optional(),
    title: z.string().max(1000).optional(),
    browser: z.string().max(100).optional(),
    domain: z.string().max(500).optional(),
    detail: z.string().max(500).optional(),
});
export const batchSchema = z.object({
    batchId: z.string().regex(/^[A-Za-z0-9_.:-]{8,64}$/),
    sentAt: iso,
    events: z.array(z.unknown()).max(MAX_BATCH),
});
let tokenCache = new Map();
export const TrackingAgentService = {
    // ------------------------------------------------------------ enrollment
    /** Creates a single-use enrollment code for an employee. The raw code is returned once. */
    async createEnrollmentCode(user, employeeId, ip) {
        const isSelf = employeeId === user.id;
        const canManage = user.permissions.includes('activity.devices.manage');
        const settings = await TrackingConfig.forEmployee(employeeId);
        if (!canManage) {
            if (!isSelf || !settings.selfEnrollmentEnabled)
                throw ApiError.forbidden('You cannot register tracking devices for this employee.');
        }
        else {
            await assertEmployeeAccess(user, employeeId, 'activity');
        }
        if (!settings.deviceRegistrationEnabled)
            throw ApiError.forbidden('Device registration is disabled for this employee\'s location.');
        const employee = await queryOne('SELECT id, status, full_name, employee_code FROM employees WHERE id = ?', [employeeId]);
        if (!employee || employee.status !== 'active')
            throw ApiError.notFound('Active employee not found.');
        const code = generateCode();
        const expires = new Date(Date.now() + ENROLLMENT_TTL_HOURS * 3600 * 1000);
        const result = await execute(`INSERT INTO tracking_enrollment_codes (employee_id, code_hash, code_hint, created_by, allow_reassign, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [employeeId, sha256(code), code.slice(-4), user.id, canManage ? 1 : 0, toSql(expires)]);
        await trackingAudit(user.id, 'tracking.enrollment_code_created', employeeId, 'tracking_enrollment_code', result.insertId, { hint: code.slice(-4) }, ip);
        return {
            id: result.insertId,
            code: `${code.slice(0, 5)}-${code.slice(5)}`,
            expiresAt: expires.toISOString(),
            employee: { id: Number(employee.id), name: employee.full_name, code: employee.employee_code },
        };
    },
    async revokeEnrollmentCode(user, codeId, ip) {
        const row = await queryOne('SELECT id, employee_id, created_by FROM tracking_enrollment_codes WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL', [codeId]);
        if (!row)
            throw ApiError.notFound('Enrollment code not found or already used.');
        if (Number(row.created_by) !== user.id) {
            if (!user.permissions.includes('activity.devices.manage'))
                throw ApiError.forbidden('You cannot revoke this code.');
            await assertEmployeeAccess(user, Number(row.employee_id), 'activity');
        }
        await execute('UPDATE tracking_enrollment_codes SET revoked_at = NOW(3) WHERE id = ?', [codeId]);
        await trackingAudit(user.id, 'tracking.enrollment_code_revoked', Number(row.employee_id), 'tracking_enrollment_code', codeId, {}, ip);
    },
    /** Agent enrollment: exchanges a one-time code for a long-lived device token. */
    async enroll(input, ip) {
        const codeHash = sha256(normaliseCode(input.enrollmentCode));
        const outcome = await transaction(async (conn) => {
            const code = await txQueryOne(conn, `SELECT id, employee_id, allow_reassign, created_by FROM tracking_enrollment_codes
         WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW(3) FOR UPDATE`, [codeHash]);
            if (!code)
                throw ApiError.badRequest('This enrollment code is invalid, expired or already used. Ask HR/IT for a new code.');
            const employeeId = Number(code.employee_id);
            const employee = await txQueryOne(conn, `SELECT e.id, e.status, e.full_name, e.employee_code, e.location_id, l.name AS location_name, l.code AS location_code
         FROM employees e LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`, [employeeId]);
            if (!employee || employee.status !== 'active')
                throw ApiError.forbidden('The employee for this code is not active.');
            const settings = await TrackingConfig.forLocation(employee.location_id);
            if (!settings.deviceRegistrationEnabled)
                throw ApiError.forbidden('Device registration is disabled for this location.');
            const fingerprint = `trk:${input.deviceUid.toLowerCase()}`;
            const deviceName = `${input.hostname}`.slice(0, 120);
            const existing = await txQueryOne(conn, 'SELECT id, employee_id, status FROM employee_devices WHERE machine_fingerprint = ? FOR UPDATE', [fingerprint]);
            let deviceId;
            let reassignedFrom = null;
            if (existing) {
                deviceId = Number(existing.id);
                if (Number(existing.employee_id) !== employeeId) {
                    if (existing.status === 'active' && !Number(code.allow_reassign)) {
                        throw ApiError.conflict('This computer is registered to another employee. An administrator must issue the code to reassign it.');
                    }
                    reassignedFrom = Number(existing.employee_id);
                }
                await txExecute(conn, `UPDATE employee_devices SET employee_id = ?, device_name = ?, hostname = ?, os_name = ?, os_version = ?, agent_version = ?,
                  status = 'active', revoked_at = NULL, revoked_reason = NULL, registered_via = 'enrollment', last_seen_at = NOW(3)
           WHERE id = ?`, [employeeId, deviceName, input.hostname, input.osName ?? 'Windows', input.osVersion ?? null, input.agentVersion, deviceId]);
                await txExecute(conn, 'UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [deviceId]);
            }
            else {
                const inserted = await txExecute(conn, `INSERT INTO employee_devices (employee_id, device_name, hostname, os_name, os_version, agent_version, machine_fingerprint, registered_via, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'enrollment', NOW(3))`, [employeeId, deviceName, input.hostname, input.osName ?? 'Windows', input.osVersion ?? null, input.agentVersion, fingerprint]);
                deviceId = inserted.insertId;
            }
            const token = `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
            await txExecute(conn, `INSERT INTO device_registrations (device_id, employee_id, token_hash, token_prefix, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ${TOKEN_TTL_DAYS} DAY))`, [deviceId, employeeId, sha256(token), token.slice(0, 12)]);
            await txExecute(conn, 'UPDATE tracking_enrollment_codes SET used_at = NOW(3), used_device_id = ? WHERE id = ?', [deviceId, Number(code.id)]);
            await txExecute(conn, `INSERT INTO tracking_device_status (device_id, employee_id, agent_version, agent_state, activity_state, hostname, os_name, os_version, ip, enrolled_at, notice_acknowledged_at)
         VALUES (?, ?, ?, 'running', 'unknown', ?, ?, ?, ?, NOW(3), NULL)
         ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), agent_version = VALUES(agent_version), agent_state = 'running',
           activity_state = 'unknown', hostname = VALUES(hostname), os_name = VALUES(os_name), os_version = VALUES(os_version), ip = VALUES(ip),
           enrolled_at = NOW(3), notice_acknowledged_at = NULL, pending_events = 0, last_sync_error = NULL, went_offline_at = NULL`, [deviceId, employeeId, input.agentVersion, input.hostname, input.osName ?? 'Windows', input.osVersion ?? null, ip ?? null]);
            return { deviceId, token, employee, settings, reassignedFrom, createdBy: code.created_by ? Number(code.created_by) : null };
        });
        tokenCache = new Map();
        await trackingAudit(outcome.createdBy, 'tracking.device_enrolled', Number(outcome.employee.id), 'employee_device', outcome.deviceId, {
            hostname: input.hostname, agentVersion: input.agentVersion, reassignedFrom: outcome.reassignedFrom,
        }, ip);
        void emitTracking(Number(outcome.employee.id), 'tracking:update', { reason: 'enrolled', deviceId: outcome.deviceId });
        return {
            deviceId: outcome.deviceId,
            deviceToken: outcome.token,
            employee: {
                id: Number(outcome.employee.id),
                name: outcome.employee.full_name,
                code: outcome.employee.employee_code,
                location: outcome.employee.location_name,
                locationCode: outcome.employee.location_code,
            },
            config: agentConfig(outcome.settings),
            noticeRequired: true,
            noticeText: outcome.settings.noticeText,
        };
    },
    // ---------------------------------------------------------- authentication
    async authenticate(rawToken) {
        const token = (rawToken ?? '').trim();
        if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length !== DEVICE_TOKEN_PREFIX.length + 64) {
            throw ApiError.unauthorized('A valid device token is required.');
        }
        const hash = sha256(token);
        const cached = tokenCache.get(hash);
        if (cached && Date.now() - cached.at < 15_000)
            return cached.device;
        const row = await queryOne(`SELECT r.id AS registration_id, r.expires_at, d.id AS device_id, d.status AS device_status, d.employee_id AS device_employee,
              r.employee_id, e.status AS employee_status, e.location_id, s.notice_acknowledged_at
       FROM device_registrations r
       JOIN employee_devices d ON d.id = r.device_id
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN tracking_device_status s ON s.device_id = d.id
       WHERE r.token_hash = ? AND r.revoked_at IS NULL AND r.expires_at > NOW(3)`, [hash]);
        if (!row)
            throw ApiError.unauthorized('This device is not registered or its registration was revoked.');
        if (row.device_status !== 'active' || Number(row.device_employee) !== Number(row.employee_id)) {
            throw ApiError.unauthorized('This device registration was revoked by an administrator.');
        }
        if (row.employee_status !== 'active')
            throw ApiError.forbidden('The employee account for this device is not active.');
        const device = {
            deviceId: Number(row.device_id),
            employeeId: Number(row.employee_id),
            registrationId: Number(row.registration_id),
            locationId: row.location_id ? Number(row.location_id) : null,
            tokenExpiresAt: String(row.expires_at),
            noticeAcknowledged: Boolean(row.notice_acknowledged_at),
        };
        if (tokenCache.size > 5000)
            tokenCache = new Map();
        tokenCache.set(hash, { at: Date.now(), device });
        return device;
    },
    async acknowledgeNotice(device, ip) {
        await execute('UPDATE tracking_device_status SET notice_acknowledged_at = COALESCE(notice_acknowledged_at, NOW(3)) WHERE device_id = ?', [device.deviceId]);
        tokenCache = new Map();
        await trackingAudit(device.employeeId, 'tracking.notice_acknowledged', device.employeeId, 'employee_device', device.deviceId, {}, ip);
        return { acknowledged: true };
    },
    /** Called by the uninstaller: retires the token so the device stops appearing as "offline". */
    async unenroll(device, ip) {
        await execute('UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [device.deviceId]);
        await execute("UPDATE employee_devices SET status = 'revoked', revoked_at = NOW(3), revoked_reason = 'Agent uninstalled' WHERE id = ?", [device.deviceId]);
        await execute("UPDATE tracking_device_status SET agent_state = 'stopped', activity_state = 'offline' WHERE device_id = ?", [device.deviceId]);
        await execute("UPDATE tracking_sessions SET ended_at = COALESCE(ended_at, NOW(3)), end_reason = COALESCE(end_reason, 'uninstalled') WHERE device_id = ? AND ended_at IS NULL", [device.deviceId]);
        tokenCache = new Map();
        await trackingAudit(device.employeeId, 'tracking.device_unenrolled', device.employeeId, 'employee_device', device.deviceId, {}, ip);
        void emitTracking(device.employeeId, 'tracking:update', { reason: 'unenrolled', deviceId: device.deviceId });
        return { ok: true };
    },
    async revokeDevice(user, deviceId, ip) {
        const device = await queryOne('SELECT id, employee_id FROM employee_devices WHERE id = ?', [deviceId]);
        if (!device)
            throw ApiError.notFound('Device not found.');
        if (!user.permissions.includes('activity.devices.manage'))
            throw ApiError.forbidden('You cannot revoke tracking devices.');
        await assertEmployeeAccess(user, Number(device.employee_id), 'activity');
        await execute("UPDATE employee_devices SET status = 'revoked', revoked_at = NOW(3), revoked_reason = ? WHERE id = ?", [`Revoked by ${user.fullName}`.slice(0, 250), deviceId]);
        await execute('UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [deviceId]);
        await execute("UPDATE tracking_device_status SET agent_state = 'stopped', activity_state = 'offline' WHERE device_id = ?", [deviceId]);
        await execute("UPDATE tracking_sessions SET ended_at = COALESCE(ended_at, NOW(3)), end_reason = COALESCE(end_reason, 'device_revoked') WHERE device_id = ? AND ended_at IS NULL", [deviceId]);
        tokenCache = new Map();
        await trackingAudit(user.id, 'tracking.device_revoked', Number(device.employee_id), 'employee_device', deviceId, {}, ip);
        void emitTracking(Number(device.employee_id), 'tracking:update', { reason: 'revoked', deviceId });
        return { ok: true };
    },
    // --------------------------------------------------------------- heartbeat
    async heartbeat(device, input, ip) {
        const settings = await TrackingConfig.forLocation(device.locationId);
        const now = Date.now();
        const skew = now - Date.parse(input.sentAt);
        const previous = await queryOne('SELECT activity_state, agent_state, current_app, went_offline_at FROM tracking_device_status WHERE device_id = ?', [device.deviceId]);
        const paused = !settings.trackingEnabled || input.trackingPaused === true;
        const state = paused ? 'unknown' : input.state;
        const app = settings.appTrackingEnabled ? clip(input.currentApp, 160) : null;
        const domain = settings.websiteTrackingEnabled ? cleanDomain(input.currentDomain) : null;
        const extensionSeen = input.extensionSeenAt ? toSql(new Date(Date.parse(input.extensionSeenAt) + skew)) : null;
        await execute(`INSERT INTO tracking_device_status (device_id, employee_id, agent_version, agent_state, activity_state, current_app, current_browser, current_domain,
                                           os_version, ip, last_heartbeat_at, pending_events, dropped_events, agent_sync_failures, last_sync_error,
                                           last_sync_error_at, clock_skew_ms, extension_seen_at, went_offline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), ?, ?, ?, ?, IF(? IS NULL, NULL, NOW(3)), ?, ?, NULL)
       ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), agent_version = COALESCE(VALUES(agent_version), agent_version),
         agent_state = VALUES(agent_state), activity_state = VALUES(activity_state), current_app = VALUES(current_app),
         current_browser = VALUES(current_browser), current_domain = VALUES(current_domain), os_version = COALESCE(VALUES(os_version), os_version),
         ip = VALUES(ip), last_heartbeat_at = NOW(3), pending_events = VALUES(pending_events), dropped_events = VALUES(dropped_events),
         agent_sync_failures = VALUES(agent_sync_failures),
         last_sync_error_at = IF(VALUES(agent_sync_failures) = 0 OR VALUES(last_sync_error) IS NULL, NULL, COALESCE(IF(last_sync_error <=> VALUES(last_sync_error), last_sync_error_at, NULL), NOW(3))),
         last_sync_error = IF(VALUES(agent_sync_failures) = 0, NULL, VALUES(last_sync_error)),
         clock_skew_ms = VALUES(clock_skew_ms), extension_seen_at = COALESCE(VALUES(extension_seen_at), extension_seen_at), went_offline_at = NULL`, [
            device.deviceId, device.employeeId, clip(input.agentVersion, 20), paused ? 'disabled' : 'running', state, app,
            clip(input.currentBrowser, 60), domain, clip(input.osVersion, 60), ip ?? null, input.pendingEvents, input.droppedEvents,
            input.syncFailures, clip(input.lastError, 255), clip(input.lastError, 255), Math.max(-2_000_000_000, Math.min(2_000_000_000, skew)), extensionSeen,
        ]);
        await execute('INSERT INTO tracking_heartbeats (device_id, employee_id, activity_state, pending_events, agent_version) VALUES (?, ?, ?, ?, ?)', [device.deviceId, device.employeeId, state, input.pendingEvents, clip(input.agentVersion, 20)]);
        await execute('UPDATE employee_devices SET last_seen_at = NOW(3), agent_version = COALESCE(?, agent_version) WHERE id = ?', [clip(input.agentVersion, 20), device.deviceId]);
        if (input.sessionId && /^[A-Za-z0-9_.:-]{8,64}$/.test(input.sessionId) && !paused) {
            const startedAt = input.sessionStartedAt ? new Date(Date.parse(input.sessionStartedAt) + skew) : new Date(now);
            await execute(`INSERT INTO tracking_sessions (employee_id, device_id, client_session_id, work_date, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE last_seen_at = NOW(3),
           ended_at = IF(end_reason = 'heartbeat_lost', NULL, ended_at),
           end_reason = IF(end_reason = 'heartbeat_lost', NULL, end_reason)`, [device.employeeId, device.deviceId, input.sessionId, localDate(startedAt), toSql(startedAt)]);
        }
        const cameBack = previous && (previous.activity_state === 'offline' || previous.agent_state === 'offline');
        if (cameBack) {
            await recordSystemEvent(device, 'device_online', 'Device reconnected', previous.went_offline_at
                ? `Offline since ${new Date(`${previous.went_offline_at.replace(' ', 'T')}Z`).toISOString()}` : null);
            void emitTracking(device.employeeId, 'tracking:alert', { kind: 'device_online', severity: 'info', deviceId: device.deviceId });
        }
        if (!previous || cameBack || previous.activity_state !== state || previous.current_app !== app) {
            void emitTracking(device.employeeId, 'tracking:update', { reason: 'heartbeat', deviceId: device.deviceId, state, currentApp: app });
        }
        // Rotate the token shortly before it expires; the old one stays valid for 7 days.
        let newToken;
        const expiresAt = new Date(`${device.tokenExpiresAt.replace(' ', 'T')}Z`).getTime();
        if (expiresAt - now < TOKEN_ROTATE_WITHIN_DAYS * 86400_000) {
            newToken = `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
            await execute(`INSERT INTO device_registrations (device_id, employee_id, token_hash, token_prefix, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ${TOKEN_TTL_DAYS} DAY))`, [device.deviceId, device.employeeId, sha256(newToken), newToken.slice(0, 12)]);
            await execute('UPDATE device_registrations SET expires_at = LEAST(expires_at, DATE_ADD(NOW(3), INTERVAL 7 DAY)) WHERE id = ?', [device.registrationId]);
            tokenCache = new Map();
        }
        const employee = await queryOne('SELECT e.full_name, e.employee_code, l.name AS location_name FROM employees e LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?', [device.employeeId]);
        const version = clip(input.agentVersion, 20);
        const hasUpdate = Boolean(version && compareVersions(version, settings.latestAgentVersion) < 0);
        let update = null;
        if (hasUpdate) {
            // An update is only offered when a release-grade (trusted-CA signed, timestamped)
            // installer is published; the agent re-verifies hash, Authenticode and publisher.
            const installer = getInstallerInfo();
            if (installer?.releaseGrade) {
                update = {
                    latestVersion: settings.latestAgentVersion,
                    required: compareVersions(version, settings.minimumAgentVersion) < 0,
                    downloadPath: '/api/tracking/agent/update/download',
                    publisher: installer.signer ?? 'BSC Textiles Pvt Ltd',
                    sha256: installer.sha256,
                };
            }
        }
        return {
            serverTime: new Date(now).toISOString(),
            trackingEnabled: settings.trackingEnabled,
            noticeRequired: !device.noticeAcknowledged,
            noticeText: settings.noticeText,
            employee: employee ? { name: employee.full_name, code: employee.employee_code, location: employee.location_name } : null,
            config: agentConfig(settings),
            update,
            ...(newToken ? { newToken } : {}),
        };
    },
    // ---------------------------------------------------------------- ingestion
    async ingest(device, body, ip) {
        const settings = await TrackingConfig.forLocation(device.locationId);
        const nowMs = Date.now();
        const rawSkew = nowMs - Date.parse(body.sentAt);
        // Correct device clocks that are more than a minute off; small drift is left alone.
        const skew = Math.abs(rawSkew) > 60_000 ? rawSkew : 0;
        const oldestAllowed = nowMs - Math.min(settings.retentionDays, 30) * 86400_000;
        const rejected = [];
        const reject = (id, reason) => rejected.push({ id: typeof id === 'string' ? id.slice(0, 64) : '', reason });
        if (!device.noticeAcknowledged) {
            for (const raw of body.events)
                reject(raw?.id, 'notice_not_acknowledged');
            await recordBatch(device, body.batchId, body.events.length, 0, 0, rejected.length, null, null);
            return { accepted: 0, duplicates: 0, rejected, serverTime: new Date(nowMs).toISOString() };
        }
        const parsed = [];
        for (const raw of body.events) {
            const result = eventSchema.safeParse(raw);
            if (!result.success) {
                reject(raw?.id, 'invalid_event');
                continue;
            }
            const e = result.data;
            const start = new Date(Date.parse(e.start) + skew);
            const end = e.end ? new Date(Date.parse(e.end) + skew) : null;
            if (start.getTime() > nowMs + 120_000 || (end && end.getTime() > nowMs + 120_000)) {
                reject(e.id, 'future_timestamp');
                continue;
            }
            if (start.getTime() < oldestAllowed) {
                reject(e.id, 'too_old');
                continue;
            }
            if (e.type === 'activity' || e.type === 'web') {
                if (!end || end.getTime() < start.getTime()) {
                    reject(e.id, 'invalid_interval');
                    continue;
                }
                if ((end.getTime() - start.getTime()) / 1000 > MAX_INTERVAL_SECONDS) {
                    reject(e.id, 'interval_too_long');
                    continue;
                }
                if (e.type === 'activity' && !e.state) {
                    reject(e.id, 'missing_state');
                    continue;
                }
                if (e.type === 'web') {
                    if (!settings.websiteTrackingEnabled) {
                        reject(e.id, 'website_tracking_disabled');
                        continue;
                    }
                    if (!cleanDomain(e.domain)) {
                        reject(e.id, 'invalid_domain');
                        continue;
                    }
                }
            }
            parsed.push({ e, start, end });
        }
        // Resolve (or create) the agent sessions referenced by this batch.
        const sessionIds = new Map();
        const sessionSpans = new Map();
        for (const { e, start, end } of parsed) {
            if (!e.sessionId)
                continue;
            const span = sessionSpans.get(e.sessionId) ?? { min: start, max: end ?? start, ended: null, reason: null };
            if (start < span.min)
                span.min = start;
            if ((end ?? start) > span.max)
                span.max = end ?? start;
            if (e.type === 'session_start' && start < span.min)
                span.min = start;
            if (e.type === 'session_end') {
                span.ended = start;
                span.reason = clip(e.detail, 40) ?? 'signed_out';
            }
            sessionSpans.set(e.sessionId, span);
        }
        for (const [clientId, span] of sessionSpans) {
            await execute(`INSERT INTO tracking_sessions (employee_id, device_id, client_session_id, work_date, started_at, last_seen_at, ended_at, end_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           started_at = LEAST(started_at, VALUES(started_at)),
           last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at)),
           ended_at = CASE WHEN VALUES(ended_at) IS NOT NULL THEN VALUES(ended_at)
                           WHEN end_reason = 'heartbeat_lost' THEN GREATEST(ended_at, VALUES(last_seen_at))
                           ELSE ended_at END,
           end_reason = COALESCE(VALUES(end_reason), end_reason)`, [device.employeeId, device.deviceId, clientId, localDate(span.min), toSql(span.min), toSql(span.max), span.ended ? toSql(span.ended) : null, span.reason]);
            const row = await queryOne('SELECT id FROM tracking_sessions WHERE device_id = ? AND client_session_id = ?', [device.deviceId, clientId]);
            if (row)
                sessionIds.set(clientId, Number(row.id));
        }
        const rows = [];
        let oldest = null;
        let newest = null;
        for (const { e, start, end } of parsed) {
            const isInterval = e.type === 'activity' || e.type === 'web';
            const duration = isInterval && end ? Math.round((end.getTime() - start.getTime()) / 1000) : 0;
            const trackApps = settings.appTrackingEnabled;
            const state = e.type === 'activity' ? e.state ?? null : e.type === 'web' ? 'active' : null;
            const app = trackApps && state !== 'locked' ? clip(e.app, 160) : null;
            const processName = trackApps && state !== 'locked' ? clip(e.process, 160) : null;
            const title = trackApps && settings.windowTitleTrackingEnabled && state === 'active' ? clip(e.title, 255) : null;
            const domain = settings.websiteTrackingEnabled ? cleanDomain(e.domain) : null;
            const browser = settings.websiteTrackingEnabled ? clip(e.browser, 60) : null;
            rows.push([
                device.employeeId, device.deviceId, e.sessionId ? sessionIds.get(e.sessionId) ?? null : null, e.id, e.type,
                e.type === 'web' ? 'extension' : 'agent', state, toSql(start), end ? toSql(end) : null, duration,
                app, processName, title, browser, domain, clip(e.detail, 255), localDate(start), body.batchId,
            ]);
            if (!oldest || start < oldest)
                oldest = start;
            const last = end ?? start;
            if (!newest || last > newest)
                newest = last;
        }
        let accepted = 0;
        for (let i = 0; i < rows.length; i += 250) {
            const chunk = rows.slice(i, i + 250);
            const result = await execute(`INSERT IGNORE INTO tracking_events
          (employee_id, device_id, session_id, client_event_id, event_type, source, state, started_at, ended_at, duration_seconds,
           app_name, process_name, window_title, browser, domain, detail, work_date, batch_id)
         VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, chunk.flat());
            accepted += result.affectedRows;
        }
        const duplicates = rows.length - accepted;
        await recordBatch(device, body.batchId, body.events.length, accepted, duplicates, rejected.length, oldest, newest);
        await execute(`UPDATE tracking_device_status SET last_sync_at = NOW(3), last_sync_error = NULL, last_sync_error_at = NULL,
         last_event_at = GREATEST(COALESCE(last_event_at, '1970-01-01'), COALESCE(?, '1970-01-01'))
       WHERE device_id = ?`, [newest ? toSql(newest) : null, device.deviceId]);
        if (rejected.length) {
            const reasons = rejected.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] ?? 0) + 1; return acc; }, {});
            console.warn(`[tracking] device ${device.deviceId}: ${rejected.length} event(s) rejected`, reasons);
        }
        if (accepted > 0)
            void emitTracking(device.employeeId, 'tracking:update', { reason: 'events', deviceId: device.deviceId, accepted });
        void ip;
        return { accepted, duplicates, rejected, serverTime: new Date(nowMs).toISOString() };
    },
    // ------------------------------------------------------------ web portal
    /** HRMS page usage reported by the signed-in web app (not counted in device active/idle totals). */
    async recordHrmsPage(user, input) {
        const settings = await TrackingConfig.forLocation(user.locationId);
        if (!settings.trackingEnabled)
            return { recorded: false, reason: 'tracking_disabled' };
        const path = clip(input.path, 180) ?? '/';
        if (!path.startsWith('/') || /^\/(login|setup|forgot-password|register)/.test(path))
            return { recorded: false, reason: 'excluded_page' };
        const end = new Date(Math.min(Date.now(), Date.parse(input.endedAt) || Date.now()));
        const seconds = Math.max(0, Math.min(1800, Math.floor(input.activeSeconds)));
        if (seconds < 5)
            return { recorded: false, reason: 'too_short' };
        const start = new Date(Math.max(Date.parse(input.startedAt) || end.getTime() - seconds * 1000, Date.now() - 2 * 86400_000));
        await execute(`INSERT IGNORE INTO tracking_events (employee_id, client_event_id, event_type, source, state, started_at, ended_at, duration_seconds, app_name, detail, work_date)
       VALUES (?, ?, 'hrms_page', 'web', 'active', ?, ?, ?, ?, ?, ?)`, [user.id, `web-${crypto.randomUUID()}`, toSql(start), toSql(end), seconds, clip(input.module, 60) ?? 'HRMS', path, localDate(start)]);
        return { recorded: true };
    },
};
/** Subset of settings the agent needs. */
export function agentConfig(settings) {
    return {
        trackingEnabled: settings.trackingEnabled,
        appTracking: settings.appTrackingEnabled,
        websiteTracking: settings.websiteTrackingEnabled,
        windowTitles: settings.appTrackingEnabled && settings.windowTitleTrackingEnabled,
        idleThresholdSeconds: settings.idleThresholdSeconds,
        heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
        syncIntervalSeconds: settings.syncIntervalSeconds,
        latestAgentVersion: settings.latestAgentVersion,
        minimumAgentVersion: settings.minimumAgentVersion,
    };
}
async function recordBatch(device, batchId, count, accepted, duplicates, rejected, oldest, newest) {
    const replay = oldest ? Date.now() - oldest.getTime() > 5 * 60 * 1000 : false;
    await execute(`INSERT INTO tracking_sync_batches (device_id, employee_id, batch_id, event_count, accepted, duplicates, rejected, oldest_event_at, newest_event_at, is_replay)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE attempts = attempts + 1, accepted = accepted + VALUES(accepted), duplicates = VALUES(duplicates),
       rejected = VALUES(rejected), received_at = NOW(3)`, [device.deviceId, device.employeeId, batchId, count, accepted, duplicates, rejected, oldest ? toSql(oldest) : null, newest ? toSql(newest) : null, replay ? 1 : 0]);
}
/** Server-generated timeline event (e.g. device went offline / came back). */
export async function recordSystemEvent(device, type, title, detail, at = new Date()) {
    await execute(`INSERT IGNORE INTO tracking_events (employee_id, device_id, client_event_id, event_type, source, started_at, detail, app_name, work_date)
     VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)`, [device.employeeId, device.deviceId, `sys-${crypto.randomUUID()}`, type, toSql(at), detail ? detail.slice(0, 255) : null, title.slice(0, 160), localDate(at)]);
}
/** Lists the devices the user may see (scoped like every other tracking view). */
export async function listTrackingDevices(user, employeeIds) {
    const where = employeeIds === null ? '' : employeeIds.length ? `AND d.employee_id IN (${employeeIds.map(() => '?').join(',')})` : 'AND 1 = 0';
    const rows = await query(`SELECT d.id, d.employee_id, d.device_name, d.hostname, d.os_name, d.os_version, d.agent_version, d.status, d.registered_at, d.last_seen_at,
            d.revoked_at, d.revoked_reason, d.registered_via,
            e.full_name, e.employee_code, e.location_id, l.code AS location_code, l.name AS location_name,
            s.agent_state, s.activity_state, s.last_heartbeat_at, s.last_sync_at, s.pending_events, s.dropped_events, s.agent_sync_failures,
            s.connection_failures, s.last_sync_error, s.last_sync_error_at, s.notice_acknowledged_at, s.extension_seen_at, s.clock_skew_ms, s.enrolled_at
     FROM employee_devices d
     JOIN employees e ON e.id = d.employee_id
     LEFT JOIN locations l ON l.id = e.location_id
     LEFT JOIN tracking_device_status s ON s.device_id = d.id
     WHERE d.registered_via = 'enrollment' ${where}
     ORDER BY d.status = 'active' DESC, s.last_heartbeat_at DESC, d.id DESC
     LIMIT 1000`, employeeIds ?? []);
    void user;
    return rows;
}
//# sourceMappingURL=TrackingAgentService.js.map