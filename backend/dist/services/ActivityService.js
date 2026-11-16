import crypto from 'node:crypto';
import { execute, query, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { emitToEmployee, emitToEmployees } from '../realtime/io.js';
import { TicketService } from './TicketService.js';
const DEVICE_TOKEN_PREFIX = 'wfm_dev_';
const MAX_BATCH = 200;
function parseJson(value, fallback) {
    if (value === null || value === undefined)
        return fallback;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        }
        catch {
            return fallback;
        }
    }
    return value;
}
function hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function clientEventId(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
}
function cleanText(value, max = 500) {
    if (typeof value !== 'string')
        return '';
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Normalises an agent timestamp to MySQL DATETIME and rejects implausible clocks. */
function eventTime(value, maxAgeDays = 45) {
    if (value === undefined || value === null || value === '')
        return { value: null, invalid: false };
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime()))
        return { value: null, invalid: true };
    if (date.getTime() > Date.now() + 2 * 60 * 1000)
        return { value: null, invalid: true };
    if (date.getTime() < Date.now() - maxAgeDays * 86400000)
        return { value: null, invalid: true };
    return { value: date.toISOString().slice(0, 23).replace('T', ' '), invalid: false };
}
function sanitizeDiagnostic(input, depth = 0) {
    if (depth > 3)
        return undefined;
    if (Array.isArray(input))
        return input.slice(0, 20).map((item) => sanitizeDiagnostic(item, depth + 1));
    if (input && typeof input === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(input).slice(0, 30)) {
            if (/pass|secret|token|cookie|otp|auth|session|credit|card|clipboard|key(?:stroke)?s?/i.test(key))
                continue;
            const cleaned = sanitizeDiagnostic(value, depth + 1);
            if (cleaned !== undefined)
                result[key.slice(0, 60)] = typeof cleaned === 'string' ? cleaned.slice(0, 800) : cleaned;
        }
        return result;
    }
    if (typeof input === 'string')
        return input.slice(0, 800);
    if (typeof input === 'number' || typeof input === 'boolean')
        return input;
    return undefined;
}
function ticketCategory(incidentCategory, application) {
    const value = `${incidentCategory} ${application ?? ''}`.toLowerCase();
    if (/network|dns|socket|connect/.test(value))
        return 'Network Issues';
    if (/database|sql|deadlock/.test(value))
        return 'Database Issues';
    if (/websocket|realtime/.test(value))
        return 'Communication Issues';
    if (/performance|slow/.test(value))
        return 'Performance Issues';
    return 'Application Errors';
}
export class ActivityService {
    /** Active monitoring policy with parsed allow-lists. */
    static async policy() {
        const row = await queryOne('SELECT * FROM monitoring_policies WHERE is_active = 1 ORDER BY effective_at DESC, id DESC LIMIT 1');
        if (!row)
            throw ApiError.notFound('No monitoring policy is configured.');
        return {
            id: Number(row.id),
            name: String(row.name),
            version: Number(row.version),
            policyText: String(row.policy_text),
            screenshotEnabled: Boolean(row.screenshot_enabled),
            screenshotIntervalMinutes: Number(row.screenshot_interval_minutes),
            retentionDays: Number(row.retention_days),
            allowedApps: parseJson(row.allowed_apps, []),
            blockedApps: parseJson(row.blocked_apps, []),
            allowedDomains: parseJson(row.allowed_domains, []),
            effectiveAt: row.effective_at,
        };
    }
    static async consentStatus(user) {
        const policy = await ActivityService.policy();
        const consent = await queryOne('SELECT acknowledged_at, revoked_at FROM employee_activity_consents WHERE employee_id = ? AND policy_id = ? AND policy_version = ?', [user.id, policy.id, policy.version]);
        return {
            policy,
            acknowledged: Boolean(consent && !consent.revoked_at),
            acknowledgedAt: consent?.acknowledged_at ?? null,
            revokedAt: consent?.revoked_at ?? null,
        };
    }
    static async acknowledge(user, context) {
        const policy = await ActivityService.policy();
        await execute(`INSERT INTO employee_activity_consents (employee_id, policy_id, policy_version, ip, user_agent)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE acknowledged_at = NOW(3), revoked_at = NULL, ip = VALUES(ip), user_agent = VALUES(user_agent)`, [user.id, policy.id, policy.version, context.ip ?? null, context.userAgent?.slice(0, 250) ?? null]);
        await ActivityService.audit(user.id, 'activity.consent_acknowledged', user.id, 'monitoring_policy', policy.id, { version: policy.version }, context.ip);
        return ActivityService.consentStatus(user);
    }
    static async revokeConsent(user, context) {
        const policy = await ActivityService.policy();
        await execute('UPDATE employee_activity_consents SET revoked_at = NOW(3) WHERE employee_id = ? AND policy_id = ? AND policy_version = ? AND revoked_at IS NULL', [user.id, policy.id, policy.version]);
        await execute("UPDATE monitoring_sessions SET status = 'ended', ended_at = NOW(3) WHERE employee_id = ? AND status = 'active'", [user.id]);
        await ActivityService.audit(user.id, 'activity.consent_revoked', user.id, 'monitoring_policy', policy.id, {}, context.ip);
        return ActivityService.consentStatus(user);
    }
    static async listDevices(user) {
        const rows = await query(`SELECT d.*, (SELECT MAX(r.last_used_at) FROM device_registrations r WHERE r.device_id = d.id) AS last_token_used
       FROM employee_devices d WHERE d.employee_id = ? ORDER BY d.registered_at DESC`, [user.id]);
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
    static async registerDevice(user, input) {
        const fingerprint = cleanText(input.machineFingerprint, 120);
        const deviceName = cleanText(input.deviceName, 120) || 'Company device';
        const osName = cleanText(input.osName, 40) || 'Windows';
        if (fingerprint.length < 8)
            throw ApiError.badRequest('A stable machine fingerprint is required.');
        const existing = await queryOne('SELECT id, employee_id, status FROM employee_devices WHERE machine_fingerprint = ?', [fingerprint]);
        if (existing && Number(existing.employee_id) !== user.id) {
            throw ApiError.conflict('This device is already registered to another employee.');
        }
        let deviceId;
        if (existing) {
            deviceId = Number(existing.id);
            await execute(`UPDATE employee_devices SET device_name = ?, os_name = ?, os_version = ?, agent_version = ?, status = 'active',
                revoked_at = NULL, revoked_reason = NULL WHERE id = ?`, [deviceName, osName, input.osVersion ?? null, input.agentVersion ?? null, deviceId]);
            await execute('UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [deviceId]);
        }
        else {
            const result = await execute(`INSERT INTO employee_devices (employee_id, device_name, os_name, os_version, agent_version, machine_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)`, [user.id, deviceName, osName, input.osVersion ?? null, input.agentVersion ?? null, fingerprint]);
            deviceId = result.insertId;
        }
        const token = `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
        await execute('INSERT INTO device_registrations (device_id, employee_id, token_hash, token_prefix, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL 180 DAY))', [deviceId, user.id, hash(token), token.slice(0, 12)]);
        await ActivityService.audit(user.id, 'activity.device_registered', user.id, 'employee_device', deviceId, { deviceName, osName });
        return { deviceId, token, expiresInDays: 180 };
    }
    static async revokeDevice(user, deviceId) {
        const device = await queryOne('SELECT id, employee_id FROM employee_devices WHERE id = ?', [deviceId]);
        if (!device)
            throw ApiError.notFound('Device not found');
        const canManageAll = user.permissions.includes('activity.devices.manage');
        if (Number(device.employee_id) !== user.id && !canManageAll)
            throw ApiError.forbidden('You cannot revoke this device.');
        await execute("UPDATE employee_devices SET status = 'revoked', revoked_at = NOW(3), revoked_reason = ? WHERE id = ?", ['Revoked by user', deviceId]);
        await execute('UPDATE device_registrations SET revoked_at = NOW(3) WHERE device_id = ? AND revoked_at IS NULL', [deviceId]);
        await execute("UPDATE monitoring_sessions SET status = 'ended', ended_at = NOW(3) WHERE device_id = ? AND status = 'active'", [deviceId]);
        await ActivityService.audit(user.id, 'activity.device_revoked', Number(device.employee_id), 'employee_device', deviceId, {});
    }
    /** Authenticates an agent request by its device token. */
    static async deviceFromToken(token) {
        if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX))
            throw ApiError.unauthorized('A valid device token is required.');
        const row = await queryOne(`SELECT r.id AS registration_id, r.employee_id, d.id AS device_id, d.status AS device_status,
              e.full_name, e.email, e.employee_code, e.department_id, e.status AS employee_status,
              dp.name AS department_name, dg.title AS designation_title, l.name AS location_name
       FROM device_registrations r
       JOIN employee_devices d ON d.id = r.device_id
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN departments dp ON dp.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE r.token_hash = ? AND r.revoked_at IS NULL AND r.expires_at > NOW(3)`, [hash(token)]);
        if (!row)
            throw ApiError.unauthorized('Device token is invalid or expired.');
        if (row.device_status !== 'active')
            throw ApiError.forbidden('This device has been revoked.');
        if (row.employee_status !== 'active')
            throw ApiError.forbidden('This employee account is not active.');
        await execute('UPDATE device_registrations SET last_used_at = NOW(3) WHERE id = ?', [Number(row.registration_id)]);
        await execute('UPDATE employee_devices SET last_seen_at = NOW(3) WHERE id = ?', [Number(row.device_id)]);
        const session = await queryOne("SELECT id FROM monitoring_sessions WHERE employee_id = ? AND device_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [Number(row.employee_id), Number(row.device_id)]);
        return {
            deviceId: Number(row.device_id),
            employeeId: Number(row.employee_id),
            employee: {
                id: Number(row.employee_id),
                full_name: String(row.full_name),
                email: String(row.email),
                employee_code: String(row.employee_code),
                department_id: row.department_id ? Number(row.department_id) : null,
                department_name: row.department_name ?? null,
                designation_title: row.designation_title ?? null,
                location_name: row.location_name ?? null,
            },
            sessionId: session ? Number(session.id) : null,
        };
    }
    static async startSession(user, deviceId, context) {
        const device = await queryOne('SELECT id, status FROM employee_devices WHERE id = ? AND employee_id = ?', [deviceId, user.id]);
        if (!device)
            throw ApiError.notFound('Register this device before starting monitoring.');
        if (device.status !== 'active')
            throw ApiError.forbidden('This device has been revoked.');
        const consent = await ActivityService.consentStatus(user);
        if (!consent.acknowledged)
            throw ApiError.forbidden('Acknowledge the monitoring policy before starting a session.');
        const attendance = await queryOne('SELECT id, check_in_at, check_out_at FROM attendance WHERE employee_id = ? AND work_date = CURDATE()', [user.id]);
        if (!attendance?.check_in_at || attendance.check_out_at) {
            throw ApiError.badRequest('Start your office attendance before monitoring can begin.');
        }
        const active = await queryOne("SELECT id, device_id FROM monitoring_sessions WHERE employee_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [user.id]);
        if (active && Number(active.device_id) === deviceId) {
            await execute('UPDATE monitoring_sessions SET last_heartbeat_at = NOW(3) WHERE id = ?', [Number(active.id)]);
            return { sessionId: Number(active.id), resumed: true };
        }
        if (active) {
            // The employee moved to another registered device: the old session ends
            // so events can never be attributed to the wrong device.
            await execute("UPDATE monitoring_sessions SET status = 'ended', ended_at = NOW(3) WHERE id = ?", [Number(active.id)]);
        }
        const result = await execute("INSERT INTO monitoring_sessions (employee_id, device_id, work_date, ip, user_agent, last_heartbeat_at) VALUES (?, ?, CURDATE(), ?, ?, NOW(3))", [user.id, deviceId, context.ip ?? null, context.userAgent?.slice(0, 250) ?? null]);
        await ActivityService.audit(user.id, 'activity.session_started', user.id, 'monitoring_session', result.insertId, { deviceId });
        emitToEmployee(user.id, 'activity:session', { status: 'active', sessionId: result.insertId });
        return { sessionId: result.insertId, resumed: false };
    }
    static async stopSession(user) {
        const active = await queryOne("SELECT id FROM monitoring_sessions WHERE employee_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [user.id]);
        if (!active)
            return { stopped: false };
        await execute("UPDATE monitoring_sessions SET status = 'ended', ended_at = NOW(3) WHERE id = ?", [Number(active.id)]);
        await ActivityService.audit(user.id, 'activity.session_stopped', user.id, 'monitoring_session', Number(active.id), {});
        emitToEmployee(user.id, 'activity:session', { status: 'ended', sessionId: Number(active.id) });
        return { stopped: true };
    }
    static async currentSession(user) {
        const row = await queryOne(`SELECT s.*, d.device_name, d.os_name FROM monitoring_sessions s JOIN employee_devices d ON d.id = s.device_id
       WHERE s.employee_id = ? AND s.status = 'active' ORDER BY s.id DESC LIMIT 1`, [user.id]);
        if (!row)
            return null;
        return {
            id: Number(row.id),
            deviceId: Number(row.device_id),
            deviceName: row.device_name,
            osName: row.os_name,
            startedAt: row.started_at,
            lastHeartbeatAt: row.last_heartbeat_at,
            workDate: row.work_date,
        };
    }
    static async heartbeat(context) {
        if (!context.sessionId)
            throw ApiError.badRequest('No active work session. Start attendance and monitoring first.');
        await execute('UPDATE monitoring_sessions SET last_heartbeat_at = NOW(3) WHERE id = ?', [context.sessionId]);
        await execute('UPDATE employee_devices SET last_seen_at = NOW(3) WHERE id = ?', [context.deviceId]);
        return { sessionId: context.sessionId, serverNow: new Date().toISOString() };
    }
    static async moduleActivity(user, input) {
        const session = await queryOne("SELECT id FROM monitoring_sessions WHERE employee_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [user.id]);
        if (!session)
            return { recorded: false, reason: 'no_active_session' };
        const path = cleanText(input.pagePath, 180) || '/';
        if (!path.startsWith('/') || path.startsWith('/login') || path.startsWith('/setup'))
            return { recorded: false, reason: 'excluded_page' };
        const seconds = Math.min(1800, Math.max(0, Math.floor(input.activeSeconds ?? 0)));
        await execute(`INSERT IGNORE INTO internal_module_activity
        (employee_id, session_id, module, page_path, entered_at, exited_at, active_seconds, related_task_id, event_type, client_event_id)
       VALUES (?, ?, ?, ?, COALESCE(?, NOW(3)), ?, ?, ?, 'page_view', ?)`, [
            user.id,
            Number(session.id),
            cleanText(input.module, 60) || 'Platform',
            path,
            input.enteredAt ?? null,
            input.exitedAt ?? null,
            seconds,
            input.relatedTaskId ?? null,
            clientEventId('mod'),
        ]);
        emitToEmployee(user.id, 'activity:update', { module: input.module, path });
        return { recorded: true };
    }
    /** Idempotent batch ingestion from the desktop agent or browser extension. */
    static async ingest(context, events) {
        if (!Array.isArray(events) || events.length === 0)
            return { accepted: 0, duplicates: 0, rejected: 0 };
        if (events.length > MAX_BATCH)
            throw ApiError.badRequest(`Send at most ${MAX_BATCH} events per batch.`);
        if (!context.sessionId)
            throw ApiError.badRequest('Monitoring is not active. Start an attendance session first.');
        const policy = await ActivityService.policy();
        const allowedApps = new Set(policy.allowedApps.map((value) => value.toLowerCase()));
        const allowedDomains = new Set(policy.allowedDomains.map((value) => value.toLowerCase()));
        const session = await queryOne('SELECT id, employee_id, device_id, status, work_date FROM monitoring_sessions WHERE id = ?', [context.sessionId]);
        if (!session || session.status !== 'active')
            throw ApiError.badRequest('This monitoring session has ended.');
        if (Number(session.employee_id) !== context.employeeId || Number(session.device_id) !== context.deviceId) {
            throw ApiError.forbidden('The session does not belong to this device.');
        }
        let accepted = 0;
        let duplicates = 0;
        let rejected = 0;
        for (const event of events) {
            const eventId = cleanText(event.clientEventId, 80).replace(/[^a-zA-Z0-9_.:-]/g, '') || clientEventId(event.type);
            try {
                if (event.type === 'app') {
                    const appName = cleanText(event.appName, 120);
                    if (!appName) {
                        rejected += 1;
                        continue;
                    }
                    if (policy.blockedApps.some((app) => app.toLowerCase() === appName.toLowerCase())) {
                        rejected += 1;
                        continue;
                    }
                    if (allowedApps.size > 0 && !allowedApps.has(appName.toLowerCase())) {
                        rejected += 1;
                        continue;
                    }
                    const started = eventTime(event.startedAt);
                    const ended = eventTime(event.endedAt);
                    if (started.invalid || ended.invalid || (started.value && ended.value && ended.value < started.value)) {
                        rejected += 1;
                        continue;
                    }
                    const seconds = Math.min(6 * 3600, Math.max(0, Math.floor(Number(event.activeSeconds ?? 0))));
                    const result = await execute(`INSERT IGNORE INTO application_usage_logs
              (session_id, employee_id, device_id, app_name, app_category, process_name, process_id, started_at, ended_at, active_seconds, last_active_at, client_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)), ?, ?, NOW(3), ?)`, [
                        context.sessionId, context.employeeId, context.deviceId, appName,
                        cleanText(event.appCategory, 40) || 'Other', cleanText(event.processName, 160) || null,
                        Number.isFinite(Number(event.processId)) && Number(event.processId) > 0 ? Math.floor(Number(event.processId)) : null,
                        started.value, ended.value, seconds, eventId,
                    ]);
                    if (result.affectedRows > 0)
                        accepted += 1;
                    else
                        duplicates += 1;
                }
                else if (event.type === 'browser') {
                    const domain = cleanText(event.domain, 190).toLowerCase().replace(/^www\./, '');
                    if (!domain || (!allowedDomains.has(domain) && ![...allowedDomains].some((allowed) => domain.endsWith(`.${allowed}`)))) {
                        rejected += 1;
                        continue;
                    }
                    const browserStart = eventTime(event.startedAt);
                    const browserEnd = eventTime(event.endedAt);
                    if (browserStart.invalid || browserEnd.invalid || (browserStart.value && browserEnd.value && browserEnd.value < browserStart.value)) {
                        rejected += 1;
                        continue;
                    }
                    const result = await execute(`INSERT IGNORE INTO browser_usage_logs
              (session_id, employee_id, device_id, browser, domain, tab_title, category, started_at, ended_at, active_seconds, client_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)), ?, ?, ?)`, [
                        context.sessionId, context.employeeId, context.deviceId,
                        cleanText(event.browser, 60) || 'Browser', domain, cleanText(event.tabTitle, 240) || null,
                        cleanText(event.category, 40) || 'Business Operations', browserStart.value, browserEnd.value,
                        Math.min(6 * 3600, Math.max(0, Math.floor(Number(event.activeSeconds ?? 0)))), eventId,
                    ]);
                    if (result.affectedRows > 0)
                        accepted += 1;
                    else
                        duplicates += 1;
                }
                else if (event.type === 'module') {
                    const path = cleanText(event.pagePath, 180);
                    if (!path.startsWith('/')) {
                        rejected += 1;
                        continue;
                    }
                    const entered = eventTime(event.enteredAt);
                    const exited = eventTime(event.exitedAt);
                    if (entered.invalid || exited.invalid || (entered.value && exited.value && exited.value < entered.value)) {
                        rejected += 1;
                        continue;
                    }
                    const result = await execute(`INSERT IGNORE INTO internal_module_activity
              (employee_id, session_id, module, page_path, entered_at, exited_at, active_seconds, related_task_id, event_type, client_event_id)
             VALUES (?, ?, ?, ?, COALESCE(?, NOW(3)), ?, ?, ?, 'agent', ?)`, [
                        context.employeeId, context.sessionId, cleanText(event.module, 60) || 'Platform', path,
                        entered.value, exited.value,
                        Math.min(3600, Math.max(0, Math.floor(Number(event.activeSeconds ?? 0)))), event.relatedTaskId ?? null, eventId,
                    ]);
                    if (result.affectedRows > 0)
                        accepted += 1;
                    else
                        duplicates += 1;
                }
                else if (event.type === 'work') {
                    const title = cleanText(event.title, 240);
                    if (!title) {
                        rejected += 1;
                        continue;
                    }
                    const occurred = eventTime(event.occurredAt);
                    if (occurred.invalid) {
                        rejected += 1;
                        continue;
                    }
                    const result = await execute(`INSERT IGNORE INTO work_activity_events (employee_id, session_id, source_type, title, detail, keywords, occurred_at, client_event_id)
             VALUES (?, ?, 'agent', ?, ?, ?, COALESCE(?, NOW(3)), ?)`, [context.employeeId, context.sessionId, title, cleanText(event.detail, 1000) || null, JSON.stringify(event.keywords ?? []), occurred.value, eventId]);
                    if (result.affectedRows > 0)
                        accepted += 1;
                    else
                        duplicates += 1;
                }
                else if (event.type === 'error') {
                    const occurred = eventTime(event.occurredAt);
                    if (occurred.invalid) {
                        rejected += 1;
                        continue;
                    }
                    const created = await ActivityService.recordError(context.employeeId, context.deviceId, context.sessionId, {
                        ...event,
                        occurredAt: occurred.value ?? undefined,
                        clientEventId: eventId,
                    });
                    if (created)
                        accepted += 1;
                    else
                        duplicates += 1;
                }
                else {
                    rejected += 1;
                }
            }
            catch {
                rejected += 1;
            }
        }
        await execute('UPDATE monitoring_sessions SET last_heartbeat_at = NOW(3) WHERE id = ?', [context.sessionId]);
        emitToEmployees([context.employeeId], 'activity:update', { sessionId: context.sessionId, accepted });
        return { accepted, duplicates, rejected };
    }
    /** Creates or groups a technical error and opens a ticket when justified. */
    static async recordError(employeeId, deviceId, sessionId, event) {
        const description = cleanText(event.description, 900);
        if (!description)
            return false;
        const category = cleanText(event.errorCategory, 60) || 'Application error';
        const application = cleanText(event.application, 120) || cleanText(event.appName, 120) || null;
        const module = cleanText(event.module, 60) || null;
        const errorCode = cleanText(event.errorCode, 80) || null;
        const severity = ['low', 'medium', 'high', 'critical'].includes(event.severity) ? event.severity : 'medium';
        const eventId = event.clientEventId ?? clientEventId('err');
        const fingerprint = hash([category, application ?? '', errorCode ?? '', module ?? '', description.slice(0, 120)].join('|'));
        const existingEvent = await queryOne('SELECT id FROM system_error_events WHERE client_event_id = ?', [eventId]);
        if (existingEvent)
            return false;
        const diagnostic = JSON.stringify(sanitizeDiagnostic(event.diagnostic ?? {}));
        const incident = await queryOne('SELECT * FROM error_incidents WHERE fingerprint = ?', [fingerprint]);
        let incidentId;
        let count = 1;
        if (incident) {
            incidentId = Number(incident.id);
            count = Number(incident.occurrence_count) + 1;
            await execute("UPDATE error_incidents SET occurrence_count = ?, last_seen_at = NOW(3), severity = ? WHERE id = ?", [count, severity, incidentId]);
        }
        else {
            const result = await execute(`INSERT INTO error_incidents (fingerprint, title, category, application, module, severity, first_seen_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3), 'open')`, [fingerprint, description.slice(0, 190), category, application, module, severity]);
            incidentId = result.insertId;
        }
        const inserted = await execute(`INSERT IGNORE INTO system_error_events
        (employee_id, device_id, session_id, incident_id, application, module, category, error_code, severity, description, diagnostic, occurred_at, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)), ?)`, [employeeId, deviceId, sessionId, incidentId, application, module, category, errorCode, severity, description, diagnostic, event.occurredAt ?? null, eventId]);
        if (inserted.affectedRows === 0)
            return false;
        const incidentRow = await queryOne('SELECT status, ticket_id FROM error_incidents WHERE id = ?', [incidentId]);
        const needsTicket = !incidentRow?.ticket_id && (severity === 'high' || severity === 'critical' || count >= 3);
        if (needsTicket) {
            await ActivityService.createIncidentTicket(incidentId);
        }
        else if (!incidentRow?.ticket_id && incidentRow?.status === 'open') {
            await execute("UPDATE error_incidents SET status = 'suggested' WHERE id = ?", [incidentId]);
            await execute("UPDATE system_error_events SET status = 'suggested' WHERE incident_id = ?", [incidentId]);
        }
        emitToEmployees([employeeId], 'activity:error', { incidentId, severity });
        return true;
    }
    /** Opens a real helpdesk ticket for an incident and routes it to IT. */
    static async createIncidentTicket(incidentId) {
        const incident = await queryOne('SELECT * FROM error_incidents WHERE id = ?', [incidentId]);
        if (!incident)
            throw ApiError.notFound('Incident not found');
        if (incident.ticket_id)
            return { ticketId: Number(incident.ticket_id), existed: true };
        const event = await queryOne('SELECT * FROM system_error_events WHERE incident_id = ? ORDER BY id ASC LIMIT 1', [incidentId]);
        if (!event)
            throw ApiError.badRequest('This incident has no recorded error event.');
        const employee = await queryOne(`SELECT e.id, e.full_name, e.email, e.employee_code, e.department_id, d.name AS department_name, dg.title AS designation_title, l.name AS location_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?`, [Number(event.employee_id)]);
        if (!employee)
            throw ApiError.notFound('Employee not found');
        const actor = {
            id: Number(employee.id),
            employeeCode: String(employee.employee_code),
            fullName: String(employee.full_name),
            email: String(employee.email),
            mobile: '',
            photoUrl: null,
            status: 'active',
            roleId: 0,
            roleSlug: 'employee',
            roleName: 'Employee',
            roleLevel: 0,
            departmentId: employee.department_id ? Number(employee.department_id) : null,
            departmentName: employee.department_name ?? null,
            designationId: null,
            designationTitle: employee.designation_title ?? null,
            managerId: null,
            managerName: null,
            locationId: null,
            locationName: employee.location_name ?? null,
            employmentType: 'full_time',
            joiningDate: null,
            permissions: ['tickets.create'],
            sessionId: 0,
            mustChangePassword: false,
            mfaEnabled: false,
        };
        const created = await TicketService.create(actor, {
            subject: `Automatic: ${String(incident.title).slice(0, 170)}`,
            description: [
                String(event.description),
                `Application: ${event.application ?? 'Unknown'}`,
                `Module: ${event.module ?? 'Unknown'}`,
                `Error code: ${event.error_code ?? 'n/a'}`,
                `Occurrences: ${incident.occurrence_count}`,
                'Raised automatically from the employee monitoring agent after sanitising diagnostics.',
            ].join('\n'),
            category: ticketCategory(String(incident.category), incident.application ?? null),
            priority: String(incident.severity),
            issueDetails: {
                source: 'activity_monitor',
                incidentId,
                deviceId: event.device_id,
                errorEventId: event.id,
                diagnostic: parseJson(event.diagnostic, {}),
            },
        }, {});
        await execute("UPDATE error_incidents SET status = 'ticket_created', ticket_id = ? WHERE id = ?", [created.id, incidentId]);
        await execute("UPDATE system_error_events SET status = 'ticket_created', ticket_id = ? WHERE incident_id = ?", [created.id, incidentId]);
        await execute("INSERT IGNORE INTO automatic_ticket_links (incident_id, ticket_id, rule) VALUES (?, ?, ?)", [incidentId, created.id, 'automatic_severity_or_recurrence']);
        await ActivityService.audit(null, 'activity.error_ticket_created', Number(event.employee_id), 'ticket', created.id, { incidentId });
        return { ticketId: created.id, ticketNo: created.ticketNo, existed: false };
    }
    static async listErrors(user) {
        const all = user.permissions.includes('activity.view.all');
        const team = user.permissions.includes('activity.view.team');
        let clause = 'e.employee_id = ?';
        const params = [user.id];
        if (all) {
            clause = '1 = 1';
            params.length = 0;
        }
        else if (team) {
            const { subtreeIds } = await import('../lib/scope.js');
            const ids = await subtreeIds(user.id);
            if (ids.length === 0)
                return [];
            clause = `e.employee_id IN (${ids.map(() => '?').join(',')})`;
            params.splice(0, params.length, ...ids);
        }
        const rows = await query(`SELECT e.*, i.title AS incident_title, i.status AS incident_status, i.occurrence_count,
              emp.full_name AS employee_name, t.ticket_no
       FROM system_error_events e
       JOIN error_incidents i ON i.id = e.incident_id
       JOIN employees emp ON emp.id = e.employee_id
       LEFT JOIN tickets t ON t.id = e.ticket_id
       WHERE ${clause}
       ORDER BY e.occurred_at DESC LIMIT 100`, params);
        return rows.map((row) => ({
            id: Number(row.id),
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
        }));
    }
    /**
     * Enforces the configured retention window. Only monitoring data older than the
     * policy limit is removed; tickets, task history and attendance are not touched.
     */
    static async purgeExpired(actorId, dryRun = false) {
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
            { key: 'sessions', table: 'monitoring_sessions', column: 'ended_at', extra: "AND status = 'ended'" },
        ];
        const counts = {};
        for (const definition of definitions) {
            const extra = 'extra' in definition ? definition.extra : '';
            const where = `${definition.column} IS NOT NULL AND ${definition.column} < DATE_SUB(NOW(3), INTERVAL ${days} DAY) ${extra}`;
            const row = await queryOne(`SELECT COUNT(*) AS total FROM ${definition.table} WHERE ${where}`);
            counts[definition.key] = Number(row?.total ?? 0);
            if (!dryRun && counts[definition.key] > 0) {
                await execute(`DELETE FROM ${definition.table} WHERE ${where}`);
            }
        }
        const evidence = await queryOne(`SELECT COUNT(*) AS total FROM screenshot_evidence
       WHERE captured_at < DATE_SUB(NOW(3), INTERVAL ${days} DAY) AND status IN ('pending','stored')`);
        counts.screenshot_evidence = Number(evidence?.total ?? 0);
        if (!dryRun && counts.screenshot_evidence > 0) {
            await execute(`UPDATE screenshot_evidence SET status = 'deleted', deleted_at = NOW(3)
         WHERE captured_at < DATE_SUB(NOW(3), INTERVAL ${days} DAY) AND status IN ('pending','stored')`);
        }
        const auditCutoff = Math.max(365, days);
        const audit = await queryOne(`SELECT COUNT(*) AS total FROM activity_audit_logs WHERE created_at < DATE_SUB(NOW(3), INTERVAL ${auditCutoff} DAY)`);
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
    static async updatePolicy(user, input) {
        if (!user.permissions.includes('activity.policy.manage'))
            throw ApiError.forbidden('You cannot change the monitoring policy.');
        const current = await queryOne('SELECT * FROM monitoring_policies WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
        if (!current)
            throw ApiError.notFound('No policy found');
        const screenshotEnabled = input.screenshotEnabled === undefined ? Boolean(current.screenshot_enabled) : Boolean(input.screenshotEnabled);
        await execute(`UPDATE monitoring_policies SET screenshot_enabled = ?, screenshot_interval_minutes = ?, retention_days = ?,
              allowed_apps = COALESCE(?, allowed_apps), allowed_domains = COALESCE(?, allowed_domains), updated_at = NOW(3) WHERE id = ?`, [
            screenshotEnabled ? 1 : 0,
            Math.min(240, Math.max(5, Number(input.screenshotIntervalMinutes ?? current.screenshot_interval_minutes))),
            Math.min(3650, Math.max(1, Number(input.retentionDays ?? current.retention_days))),
            Array.isArray(input.allowedApps) ? JSON.stringify(input.allowedApps.map((value) => cleanText(value, 120)).filter(Boolean)) : null,
            Array.isArray(input.allowedDomains) ? JSON.stringify(input.allowedDomains.map((value) => cleanText(value, 190).toLowerCase()).filter(Boolean)) : null,
            Number(current.id),
        ]);
        await ActivityService.audit(user.id, 'activity.policy_updated', null, 'monitoring_policy', Number(current.id), { screenshotEnabled });
        return ActivityService.policy();
    }
    static async audit(actorId, action, targetEmployeeId, entityType, entityId, detail, ip) {
        await execute('INSERT INTO activity_audit_logs (actor_id, action, target_employee_id, entity_type, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)', [actorId, action, targetEmployeeId, entityType, entityId, JSON.stringify(detail), ip ?? null]);
    }
}
export { parseJson, cleanText };
//# sourceMappingURL=ActivityService.js.map