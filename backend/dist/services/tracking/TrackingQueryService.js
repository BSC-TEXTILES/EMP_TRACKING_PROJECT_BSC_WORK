import { query, queryOne } from '../../db/index.js';
import { ApiError } from '../../lib/http.js';
import { addDays, dayBounds, daysBetween, parseUtc, today } from '../../lib/dates.js';
import { allowedLocationIds, assertEmployeeAccess, visibleEmployeeIds } from '../../lib/scope.js';
import { TrackingConfig } from './TrackingConfig.js';
import { trackingAudit } from './trackingAudit.js';
const iso = (value) => (value ? parseUtc(String(value))?.toISOString() ?? null : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value, fallback = today()) {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.trim();
    if (/^\d{2}-\d{2}-\d{4}$/.test(trimmed)) {
        const [d, m, y] = trimmed.split('-');
        const norm = `${y}-${m}-${d}`;
        return !Number.isNaN(Date.parse(`${norm}T00:00:00Z`)) ? norm : fallback;
    }
    if (!DATE_RE.test(trimmed))
        return fallback;
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    return Number.isNaN(parsed) ? fallback : trimmed;
}
export function validRange(fromRaw, toRaw, maxDays = 31) {
    const to = validDate(toRaw);
    const from = validDate(fromRaw, to);
    if (daysBetween(from, to) < 0)
        throw ApiError.badRequest('The start date must be on or before the end date.');
    if (daysBetween(from, to) >= maxDays)
        throw ApiError.badRequest(`Choose a range of at most ${maxDays} days.`);
    return { from, to };
}
function inList(ids, column) {
    if (ids === null)
        return { sql: '1 = 1', params: [] };
    if (ids.length === 0)
        return { sql: '1 = 0', params: [] };
    return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}
/** Employee ids the user may see in tracking (null = every employee). */
export async function trackingScope(user) {
    return visibleEmployeeIds(user, 'activity');
}
export function canSeeOthers(user) {
    return user.permissions.includes('activity.view.all') || user.permissions.includes('activity.view.team');
}
/** Derives the connection/sync state of a device row. */
export function deviceLive(row, settings, now = Date.now()) {
    const lastHeartbeat = parseUtc(row.last_heartbeat_at);
    const online = Boolean(lastHeartbeat && now - lastHeartbeat.getTime() <= settings.offlineAfterSeconds * 1000)
        && row.agent_state !== 'stopped' && row.agent_state !== 'offline' && row.status !== 'revoked';
    const pending = Number(row.pending_events ?? 0);
    const lastSync = parseUtc(row.last_sync_at);
    const lastErrorAt = parseUtc(row.last_sync_error_at);
    const stuckAfterMs = Math.max(5 * 60_000, settings.syncIntervalSeconds * 10_000);
    const enrolledMs = parseUtc(row.enrolled_at)?.getTime() ?? now;
    const isFresh = (now - enrolledMs <= stuckAfterMs);
    let syncError = null;
    if (online && row.last_sync_error && lastErrorAt && now - lastErrorAt.getTime() > 2 * 60_000) {
        syncError = `Upload failing: ${String(row.last_sync_error)}`;
    }
    else if (online && pending > 0 && !isFresh && (!lastSync || now - lastSync.getTime() > stuckAfterMs)) {
        syncError = `${pending} event(s) waiting to upload`;
    }
    else if (Number(row.dropped_events ?? 0) > 0 && online) {
        syncError = `${row.dropped_events} event(s) discarded on the device (offline storage full)`;
    }
    return {
        deviceId: Number(row.device_id ?? row.id),
        employeeId: Number(row.employee_id),
        deviceName: String(row.device_name ?? row.hostname ?? 'Computer'),
        hostname: row.hostname ?? null,
        osName: row.os_name ?? null,
        osVersion: row.os_version ?? null,
        agentVersion: row.agent_version ?? null,
        agentState: row.agent_state ?? null,
        activityState: row.activity_state ?? null,
        currentApp: row.current_app ?? null,
        currentBrowser: row.current_browser ?? null,
        currentDomain: row.current_domain ?? null,
        lastHeartbeatAt: iso(row.last_heartbeat_at),
        lastSyncAt: iso(row.last_sync_at),
        lastEventAt: iso(row.last_event_at),
        pendingEvents: pending,
        droppedEvents: Number(row.dropped_events ?? 0),
        agentSyncFailures: Number(row.agent_sync_failures ?? 0),
        connectionFailures: Number(row.connection_failures ?? 0),
        lastSyncError: row.last_sync_error ?? null,
        lastSyncErrorAt: iso(row.last_sync_error_at),
        noticeAcknowledgedAt: iso(row.notice_acknowledged_at),
        extensionSeenAt: iso(row.extension_seen_at),
        enrolledAt: iso(row.enrolled_at),
        clockSkewMs: Number(row.clock_skew_ms ?? 0),
        online,
        syncError,
    };
}
/** Live status for an employee from their active enrolled devices. */
export function employeeLiveStatus(devices, settings) {
    if (devices.length === 0)
        return { status: 'not_installed', primary: null };
    const sorted = [...devices].sort((a, b) => (Date.parse(b.lastHeartbeatAt ?? '') || 0) - (Date.parse(a.lastHeartbeatAt ?? '') || 0));
    const online = sorted.filter((d) => d.online);
    const rank = { active: 3, idle: 2, locked: 1 };
    const primary = online.sort((a, b) => (rank[b.activityState ?? ''] ?? 0) - (rank[a.activityState ?? ''] ?? 0))[0] ?? sorted[0];
    if (!settings.trackingEnabled)
        return { status: 'disabled', primary };
    if (!primary.online)
        return { status: 'offline', primary };
    if (primary.agentState === 'disabled')
        return { status: 'disabled', primary };
    const state = primary.activityState;
    return { status: state === 'idle' ? 'idle' : state === 'locked' ? 'locked' : state === 'active' ? 'active' : 'offline', primary };
}
/** Observed active/idle/locked seconds per employee per date (the single source for every view and report). */
export async function dayStats(employeeIds, from, to) {
    const scope = inList(employeeIds, 'employee_id');
    const rows = await query(`SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS d,
            SUM(CASE WHEN event_type = 'activity' AND state = 'active' THEN duration_seconds ELSE 0 END) AS active_s,
            SUM(CASE WHEN event_type = 'activity' AND state = 'idle' THEN duration_seconds ELSE 0 END) AS idle_s,
            SUM(CASE WHEN event_type = 'activity' AND state = 'locked' THEN duration_seconds ELSE 0 END) AS locked_s,
            MIN(CASE WHEN source <> 'web' AND event_type IN ('activity','session_start','agent_start') THEN started_at END) AS first_seen,
            MAX(CASE WHEN event_type = 'activity' THEN ended_at WHEN source <> 'web' AND event_type IN ('session_end','agent_stop','lock') THEN started_at END) AS last_seen,
            MAX(CASE WHEN event_type = 'activity' AND state = 'active' THEN ended_at END) AS last_active
     FROM tracking_events
     WHERE work_date BETWEEN ? AND ? AND ${scope.sql}
     GROUP BY employee_id, work_date`, [from, to, ...scope.params]);
    const out = new Map();
    for (const row of rows) {
        const id = Number(row.employee_id);
        if (!out.has(id))
            out.set(id, new Map());
        out.get(id).set(String(row.d), {
            activeSeconds: Number(row.active_s ?? 0),
            idleSeconds: Number(row.idle_s ?? 0),
            lockedSeconds: Number(row.locked_s ?? 0),
            firstSeenAt: iso(row.first_seen),
            lastSeenAt: iso(row.last_seen),
            lastActiveAt: iso(row.last_active),
        });
    }
    return out;
}
export async function sessionStats(employeeIds, from, to) {
    const scope = inList(employeeIds, 'employee_id');
    const rows = await query(`SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS d, COUNT(*) AS n, MIN(started_at) AS first_start,
            MAX(COALESCE(ended_at, last_seen_at)) AS last_end, SUM(ended_at IS NULL) AS open_n,
            SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, last_seen_at)))) AS total_s
     FROM tracking_sessions
     WHERE work_date BETWEEN ? AND ? AND ${scope.sql}
     GROUP BY employee_id, work_date`, [from, to, ...scope.params]);
    const out = new Map();
    for (const row of rows) {
        const id = Number(row.employee_id);
        if (!out.has(id))
            out.set(id, new Map());
        out.get(id).set(String(row.d), {
            count: Number(row.n),
            firstStartAt: iso(row.first_start),
            lastEndAt: iso(row.last_end),
            open: Number(row.open_n ?? 0),
            totalSeconds: Number(row.total_s ?? 0),
        });
    }
    return out;
}
/** First HRMS web sign-in / last sign-out per employee per date (Asia/Kolkata day). */
async function hrmsLogins(employeeIds, from, to) {
    const scope = inList(employeeIds, 'employee_id');
    const start = dayBounds(from).start;
    const end = dayBounds(to).end;
    const rows = await query(`SELECT employee_id, DATE_FORMAT(CONVERT_TZ(login_at, '+00:00', '+05:30'), '%Y-%m-%d') AS d, MIN(login_at) AS first_login, MAX(logout_at) AS last_logout
     FROM employee_login_audit
     WHERE login_at >= ? AND login_at < ? AND ${scope.sql}
     GROUP BY employee_id, d`, [start, end, ...scope.params]).catch(() => []);
    const out = new Map();
    for (const row of rows)
        out.set(`${row.employee_id}|${row.d}`, { firstLogin: iso(row.first_login), lastLogout: iso(row.last_logout) });
    return out;
}
/** Active enrolled devices with their live state, grouped by employee. */
export async function devicesByEmployee(employeeIds, includeRevoked = false) {
    const scope = inList(employeeIds, 'd.employee_id');
    const rows = await query(`SELECT d.id AS device_id, d.employee_id, d.device_name, d.hostname, d.os_name, d.os_version, d.agent_version, d.status,
            d.registered_at, d.revoked_at, d.revoked_reason,
            s.agent_state, s.activity_state, s.current_app, s.current_browser, s.current_domain, s.last_heartbeat_at, s.last_sync_at,
            s.last_event_at, s.pending_events, s.dropped_events, s.agent_sync_failures, s.connection_failures, s.last_sync_error,
            s.last_sync_error_at, s.notice_acknowledged_at, s.extension_seen_at, s.enrolled_at, s.clock_skew_ms
     FROM employee_devices d
     LEFT JOIN tracking_device_status s ON s.device_id = d.id
     WHERE d.registered_via = 'enrollment' ${includeRevoked ? '' : "AND d.status = 'active'"} AND ${scope.sql}`, scope.params);
    const out = new Map();
    for (const row of rows) {
        const id = Number(row.employee_id);
        if (!out.has(id))
            out.set(id, []);
        out.get(id).push(row);
    }
    return out;
}
const STATUS_FILTERS = ['all', 'active', 'idle', 'locked', 'offline', 'not_installed', 'sync_error', 'disabled'];
export const TrackingQueryService = {
    async overview(user, filters) {
        if (!canSeeOthers(user))
            throw ApiError.forbidden('You do not have access to organisation activity tracking.');
        const date = validDate(filters.date);
        const scope = await trackingScope(user);
        const scopeSql = inList(scope, 'e.id');
        const allowedLocations = await allowedLocationIds(user);
        const employees = await query(`SELECT e.id, e.employee_code, e.full_name, e.photo_url, e.location_id, l.code AS location_code, l.name AS location_name,
              dp.name AS department_name, dg.title AS designation_title
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments dp ON dp.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE e.status = 'active' AND ${scopeSql.sql}`, scopeSql.params);
        const ids = employees.map((row) => Number(row.id));
        const [stats, sessions, logins, devices] = await Promise.all([
            dayStats(ids, date, date), sessionStats(ids, date, date), hrmsLogins(ids, date, date), devicesByEmployee(ids),
        ]);
        const settingsCache = new Map();
        const settingsFor = async (locationId) => {
            if (!settingsCache.has(locationId))
                settingsCache.set(locationId, await TrackingConfig.forLocation(locationId));
            return settingsCache.get(locationId);
        };
        const now = Date.now();
        const items = [];
        for (const row of employees) {
            const id = Number(row.id);
            const locationId = row.location_id ? Number(row.location_id) : null;
            const settings = await settingsFor(locationId);
            const live = (devices.get(id) ?? []).map((d) => deviceLive(d, settings, now));
            const { status, primary } = employeeLiveStatus(live, settings);
            const day = stats.get(id)?.get(date);
            const session = sessions.get(id)?.get(date);
            const login = logins.get(`${id}|${date}`);
            const syncError = live.map((d) => d.syncError).find(Boolean) ?? null;
            const loginAt = session?.firstStartAt ?? day?.firstSeenAt ?? null;
            const liveActiveAt = primary?.online && primary.activityState === 'active' ? primary.lastHeartbeatAt : null;
            const lastActivity = [day?.lastActiveAt, date === today() ? liveActiveAt : null].filter(Boolean).sort().pop() ?? null;
            const sessionActive = (session && session.open > 0 && (day?.activeSeconds ?? 0) === 0) ? Math.min(session.totalSeconds, 3600) : 0;
            const totalActive = (day?.activeSeconds ?? 0) || sessionActive;
            const hasData = Boolean(day || (session && session.count > 0) || primary?.online);
            items.push({
                id,
                employeeCode: String(row.employee_code),
                fullName: String(row.full_name),
                photoUrl: row.photo_url ?? null,
                designation: row.designation_title ?? null,
                department: row.department_name ?? null,
                locationId,
                locationCode: row.location_code ?? null,
                locationName: row.location_name ?? null,
                device: primary ? { id: primary.deviceId, name: primary.deviceName, os: [primary.osName, primary.osVersion].filter(Boolean).join(' '), agentVersion: primary.agentVersion, online: primary.online } : null,
                deviceCount: live.length,
                loginAt,
                loginSource: session?.firstStartAt ? 'device' : day?.firstSeenAt ? 'device' : null,
                hrmsLoginAt: login?.firstLogin ?? null,
                logoutAt: session && session.open === 0 ? session.lastEndAt : null,
                activeSeconds: totalActive,
                idleSeconds: day?.idleSeconds ?? 0,
                lockedSeconds: day?.lockedSeconds ?? 0,
                hasData,
                lastActivityAt: lastActivity,
                status,
                currentApp: status === 'active' || status === 'idle' ? primary?.currentApp ?? null : null,
                currentDomain: status === 'active' || status === 'idle' ? primary?.currentDomain ?? null : null,
                lastHeartbeatAt: primary?.lastHeartbeatAt ?? null,
                syncError,
                trackingEnabled: settings.trackingEnabled,
            });
        }
        const locationCodes = new Map();
        for (const item of items)
            if (item.locationCode)
                locationCodes.set(item.locationCode, (locationCodes.get(item.locationCode) ?? 0) + 1);
        const locationFilter = (filters.location ?? 'all').toUpperCase();
        const search = (filters.search ?? '').trim().toLowerCase();
        const searched = items.filter((item) => !search
            || item.fullName.toLowerCase().includes(search)
            || item.employeeCode.toLowerCase().includes(search)
            || (item.device?.name ?? '').toLowerCase().includes(search));
        const byLocation = locationFilter === 'ALL' ? searched : searched.filter((item) => item.locationCode === locationFilter);
        const counts = {
            all: byLocation.length,
            active: byLocation.filter((i) => i.status === 'active').length,
            idle: byLocation.filter((i) => i.status === 'idle').length,
            locked: byLocation.filter((i) => i.status === 'locked').length,
            offline: byLocation.filter((i) => i.status === 'offline').length,
            not_installed: byLocation.filter((i) => i.status === 'not_installed').length,
            sync_error: byLocation.filter((i) => i.syncError).length,
            disabled: byLocation.filter((i) => i.status === 'disabled').length,
        };
        const statusFilter = STATUS_FILTERS.includes(String(filters.status)) ? String(filters.status) : 'all';
        const filtered = byLocation.filter((item) => statusFilter === 'all'
            || (statusFilter === 'sync_error' ? Boolean(item.syncError) : item.status === statusFilter));
        const statusRank = { active: 0, idle: 1, locked: 2, offline: 3, disabled: 4, not_installed: 5 };
        const sort = filters.sort ?? 'status';
        const dir = filters.order === 'desc' ? -1 : 1;
        const cmp = (a, b) => {
            const str = (x, y) => (x ?? '').localeCompare(y ?? '');
            const time = (x, y) => (Date.parse(x ?? '') || 0) - (Date.parse(y ?? '') || 0);
            switch (sort) {
                case 'name': return str(a.fullName, b.fullName);
                case 'code': return str(a.employeeCode, b.employeeCode);
                case 'location': return str(a.locationCode, b.locationCode) || str(a.fullName, b.fullName);
                case 'device': return str(a.device?.name, b.device?.name);
                case 'login': return time(a.loginAt, b.loginAt);
                case 'active': return a.activeSeconds - b.activeSeconds;
                case 'idle': return a.idleSeconds - b.idleSeconds;
                case 'lastActivity': return time(a.lastActivityAt, b.lastActivityAt);
                default: return (statusRank[a.status] - statusRank[b.status]) || str(a.fullName, b.fullName);
            }
        };
        filtered.sort((a, b) => cmp(a, b) * dir);
        const pageSize = Math.min(100, Math.max(5, Number(filters.pageSize) || 25));
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(totalPages, Math.max(1, Number(filters.page) || 1));
        const locations = (await query("SELECT id, code, name FROM locations WHERE code <> 'ALL' ORDER BY FIELD(code,'BEL','DAV','SHI','HQ'), name")).filter((loc) => allowedLocations === null || allowedLocations.includes(Number(loc.id)))
            .map((loc) => ({ id: Number(loc.id), code: loc.code, name: loc.name, count: locationCodes.get(loc.code) ?? 0 }));
        return {
            date,
            today: today(),
            serverTime: new Date(now).toISOString(),
            counts,
            locations,
            totals: {
                activeSeconds: byLocation.reduce((sum, i) => sum + i.activeSeconds, 0),
                idleSeconds: byLocation.reduce((sum, i) => sum + i.idleSeconds, 0),
            },
            items: filtered.slice((page - 1) * pageSize, page * pageSize),
            pagination: { page, pageSize, total, totalPages },
        };
    },
    async employeeDetails(user, employeeId, dateRaw, ip) {
        await assertEmployeeAccess(user, employeeId, 'activity');
        const date = validDate(dateRaw);
        const employee = await queryOne(`SELECT e.id, e.employee_code, e.full_name, e.email, e.photo_url, e.status, e.location_id, l.code AS location_code, l.name AS location_name,
              dp.name AS department_name, dg.title AS designation_title, m.full_name AS manager_name
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments dp ON dp.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN employees m ON m.id = e.manager_id
       WHERE e.id = ?`, [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found.');
        const settings = await TrackingConfig.forLocation(employee.location_id ? Number(employee.location_id) : null);
        const allDevices = (await devicesByEmployee([employeeId], true)).get(employeeId) ?? [];
        const activeDevices = allDevices.filter((d) => d.status === 'active');
        const liveActive = activeDevices.map((d) => deviceLive(d, settings));
        const { status, primary } = employeeLiveStatus(liveActive, settings);
        const day = await buildDay(employeeId, date, settings, primary);
        if (user.id !== employeeId) {
            await trackingAudit(user.id, 'tracking.details_viewed', employeeId, 'employee', employeeId, { date }, ip);
        }
        return {
            date,
            today: today(),
            serverTime: new Date().toISOString(),
            employee: {
                id: Number(employee.id),
                employeeCode: String(employee.employee_code),
                fullName: String(employee.full_name),
                photoUrl: employee.photo_url ?? null,
                designation: employee.designation_title ?? null,
                department: employee.department_name ?? null,
                manager: employee.manager_name ?? null,
                locationCode: employee.location_code ?? null,
                locationName: employee.location_name ?? null,
            },
            tracking: {
                status,
                enabled: settings.trackingEnabled,
                appTracking: settings.appTrackingEnabled,
                websiteTracking: settings.websiteTrackingEnabled,
                idleThresholdSeconds: settings.idleThresholdSeconds,
                latestAgentVersion: settings.latestAgentVersion,
                currentApp: primary?.online ? primary.currentApp : null,
                currentDomain: primary?.online ? primary.currentDomain : null,
            },
            devices: allDevices.map((row) => ({
                ...deviceLive(row, settings),
                registrationStatus: String(row.status),
                registeredAt: iso(row.registered_at),
                revokedAt: iso(row.revoked_at),
                revokedReason: row.revoked_reason ?? null,
                outdated: Boolean(row.agent_version && compareVer(String(row.agent_version), settings.minimumAgentVersion) < 0),
            })),
            ...day,
        };
    },
};
function compareVer(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1)
        if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
    return 0;
}
/**
 * Everything about one employee on one date, derived only from recorded rows:
 * summary, application and website usage, sessions, gaps and the timeline.
 */
export async function buildDay(employeeId, date, settings, primary) {
    const bounds = dayBounds(date);
    const isToday = date === today();
    const hasLiveConnection = isToday && Boolean(primary?.online);
    const intervalsRaw = await query(`SELECT started_at, ended_at, state, app_name, process_name, browser, domain, device_id, event_type
     FROM tracking_events
     WHERE employee_id = ? AND (work_date = ? OR (started_at < ? AND COALESCE(ended_at, started_at) >= ?)) AND event_type IN ('activity','web')
     ORDER BY started_at, id`, [employeeId, date, bounds.end, bounds.start]);
    const pointRaw = await query(`SELECT event_type, source, started_at, ended_at, duration_seconds, app_name, detail, device_id
     FROM tracking_events
     WHERE employee_id = ? AND (work_date = ? OR (started_at < ? AND COALESCE(ended_at, started_at) >= ?)) AND event_type NOT IN ('activity','web')
     ORDER BY started_at, id
     LIMIT 3000`, [employeeId, date, bounds.end, bounds.start]);
    const sessionRows = await query(`SELECT s.id, s.started_at, s.ended_at, s.last_seen_at, s.end_reason, d.device_name
     FROM tracking_sessions s JOIN employee_devices d ON d.id = s.device_id
     WHERE s.employee_id = ? AND (s.work_date = ? OR (s.started_at < ? AND COALESCE(s.ended_at, s.last_seen_at) >= ?))
     ORDER BY s.started_at`, [employeeId, date, bounds.end, bounds.start]);
    if (sessionRows.length === 0 && hasLiveConnection && primary) {
        sessionRows.push({
            id: 0,
            started_at: primary.lastHeartbeatAt,
            ended_at: null,
            last_seen_at: primary.lastHeartbeatAt,
            end_reason: null,
            device_name: primary.deviceName,
        });
    }
    const logins = await query('SELECT login_at, logout_at, browser, os, logout_reason FROM employee_login_audit WHERE employee_id = ? AND login_at >= ? AND login_at < ? ORDER BY login_at', [employeeId, bounds.start, bounds.end]).catch(() => []);
    const ms = (value) => parseUtc(String(value))?.getTime() ?? 0;
    const activity = intervalsRaw
        .filter((row) => row.event_type === 'activity')
        .map((row) => ({
        start: ms(row.started_at), end: ms(row.ended_at), state: row.state,
        app: row.app_name ?? null, process: row.process_name ?? null, browser: row.browser ?? null, domain: row.domain ?? null,
        deviceId: row.device_id ? Number(row.device_id) : null,
    }));
    const webOnly = intervalsRaw.filter((row) => row.event_type === 'web').map((row) => ({
        start: ms(row.started_at), end: ms(row.ended_at), browser: row.browser ?? null, domain: row.domain ?? null,
    }));
    const total = { active: 0, idle: 0, locked: 0 };
    for (const i of activity)
        total[i.state] += Math.round((i.end - i.start) / 1000);
    // Continuous runs of one state (gaps of up to 10 s are treated as continuous).
    const runs = [];
    for (const i of activity) {
        const last = runs[runs.length - 1];
        if (last && last.state === i.state && i.start - last.end <= 10_000)
            last.end = Math.max(last.end, i.end);
        else
            runs.push({ state: i.state, start: i.start, end: i.end });
    }
    const longest = (state) => runs.filter((r) => r.state === state)
        .reduce((best, r) => (!best || r.end - r.start > best.end - best.start ? r : best), null);
    // Untracked gaps inside the observed span: device off, asleep, offline without agent, or agent closed.
    const gaps = [];
    const sorted = [...activity].sort((a, b) => a.start - b.start);
    let cursor = sorted[0]?.end ?? 0;
    const pointTimes = pointRaw.map((row) => ({ type: String(row.event_type), at: ms(row.started_at) }));
    for (const i of sorted.slice(1)) {
        if (i.start - cursor > 120_000) {
            const inside = pointTimes.filter((p) => p.at >= cursor - 5000 && p.at <= i.start + 5000).map((p) => p.type);
            const reason = inside.includes('suspend') ? 'Computer asleep'
                : inside.includes('session_end') || inside.includes('agent_stop') ? 'Signed out / agent stopped'
                    : inside.includes('tracking_disabled') ? 'Tracking disabled'
                        : inside.includes('device_offline') ? 'Device offline (no heartbeat)'
                            : 'No data recorded';
            gaps.push({ start: new Date(cursor).toISOString(), end: new Date(i.start).toISOString(), seconds: Math.round((i.start - cursor) / 1000), reason });
        }
        cursor = Math.max(cursor, i.end);
    }
    const spanStart = sorted[0]?.start ?? null;
    const spanEnd = sorted.length ? Math.max(...sorted.map((i) => i.end)) : null;
    const spanSeconds = spanStart !== null && spanEnd !== null ? Math.round((spanEnd - spanStart) / 1000) : 0;
    const trackedSeconds = total.active + total.idle + total.locked;
    const offlineSeconds = gaps.reduce((sum, g) => sum + g.seconds, 0);
    // Application usage (foreground time while active; idle time in the app shown separately).
    const apps = new Map();
    for (const i of activity) {
        if (!i.app || i.state === 'locked')
            continue;
        const entry = apps.get(i.app) ?? { app: i.app, process: i.process, activeSeconds: 0, idleSeconds: 0, first: i.start, last: i.end };
        const seconds = Math.round((i.end - i.start) / 1000);
        if (i.state === 'active')
            entry.activeSeconds += seconds;
        else
            entry.idleSeconds += seconds;
        entry.first = Math.min(entry.first, i.start);
        entry.last = Math.max(entry.last, i.end);
        if (!entry.process && i.process)
            entry.process = i.process;
        apps.set(i.app, entry);
    }
    const sites = new Map();
    const addSite = (browser, domain, start, end) => {
        if (!domain)
            return;
        const key = `${browser ?? ''}|${domain}`;
        const entry = sites.get(key) ?? { browser: browser ?? 'Browser', domain, activeSeconds: 0, first: start, last: end, visits: 0 };
        entry.activeSeconds += Math.round((end - start) / 1000);
        entry.first = Math.min(entry.first, start);
        entry.last = Math.max(entry.last, end);
        sites.set(key, entry);
    };
    let previousSite = '';
    for (const i of activity) {
        if (i.state !== 'active' || !i.domain) {
            previousSite = '';
            continue;
        }
        addSite(i.browser, i.domain, i.start, i.end);
        const key = `${i.browser ?? ''}|${i.domain}`;
        if (key !== previousSite)
            sites.get(key).visits += 1;
        previousSite = key;
    }
    for (const w of webOnly) {
        addSite(w.browser, w.domain, w.start, w.end);
        sites.get(`${w.browser ?? ''}|${w.domain}`).visits += 1;
    }
    const sessions = sessionRows.map((row) => {
        const start = ms(row.started_at);
        const end = row.ended_at ? ms(row.ended_at) : ms(row.last_seen_at);
        return {
            id: Number(row.id),
            device: String(row.device_name),
            startedAt: iso(row.started_at),
            endedAt: iso(row.ended_at),
            lastSeenAt: iso(row.last_seen_at),
            seconds: Math.max(0, Math.round((end - start) / 1000)),
            endReason: row.end_reason ?? null,
            open: !row.ended_at,
        };
    });
    // Timeline: point events + HRMS sign-ins + condensed application segments (>= 1 min).
    const LABELS = {
        session_start: 'Signed in to Windows — tracking session started', session_end: 'Tracking session ended',
        lock: 'Device locked', unlock: 'Device unlocked', idle_start: 'Idle period started', idle_end: 'Became active again',
        suspend: 'Computer went to sleep', resume: 'Computer woke up', agent_start: 'Tracking agent started', agent_stop: 'Tracking agent stopped',
        tracking_disabled: 'Tracking disabled by policy', tracking_enabled: 'Tracking re-enabled by policy',
        device_offline: 'Device disconnected (no heartbeat)', device_online: 'Device reconnected', hrms_page: 'HRMS page',
    };
    const timeline = [];
    for (const row of pointRaw) {
        const type = String(row.event_type);
        if (type === 'hrms_page')
            continue;
        let detail = row.detail ?? null;
        if (type === 'session_end' && detail)
            detail = `Reason: ${detail.replace(/_/g, ' ')}`;
        timeline.push({ at: iso(row.started_at), type, title: LABELS[type] ?? type, detail, source: String(row.source) });
    }
    for (const login of logins) {
        timeline.push({ at: iso(login.login_at), type: 'hrms_login', title: 'Signed in to HRMS', detail: [login.browser, login.os].filter(Boolean).join(' · ') || null, source: 'web' });
        if (login.logout_at)
            timeline.push({ at: iso(login.logout_at), type: 'hrms_logout', title: 'Signed out of HRMS', detail: login.logout_reason ?? null, source: 'web' });
    }
    // HRMS module usage condensed per module run.
    const pages = pointRaw.filter((row) => row.event_type === 'hrms_page');
    let pageRun = null;
    const flushPage = () => {
        if (pageRun && pageRun.seconds >= 30) {
            timeline.push({ at: new Date(pageRun.start).toISOString(), type: 'hrms_page', title: `HRMS · ${pageRun.module}`, detail: null, seconds: pageRun.seconds, source: 'web' });
        }
    };
    for (const row of pages) {
        const module = String(row.app_name ?? 'HRMS');
        const start = ms(row.started_at);
        const end = row.ended_at ? ms(row.ended_at) : start;
        if (pageRun && pageRun.module === module && start - pageRun.end <= 5 * 60_000) {
            pageRun.end = end;
            pageRun.seconds += Number(row.duration_seconds ?? 0);
        }
        else {
            flushPage();
            pageRun = { module, start, end, seconds: Number(row.duration_seconds ?? 0) };
        }
    }
    flushPage();
    let seg = null;
    const flushSeg = () => {
        if (seg && seg.seconds >= 60) {
            timeline.push({
                at: new Date(seg.start).toISOString(), type: 'app', title: `${seg.app} active`,
                detail: seg.domain ? `Website: ${seg.domain}` : null, seconds: seg.seconds, source: 'agent',
            });
        }
    };
    for (const i of activity) {
        if (i.state !== 'active' || !i.app)
            continue;
        if (seg && seg.app === i.app && seg.domain === i.domain && i.start - seg.end <= 15_000) {
            seg.end = i.end;
            seg.seconds += Math.round((i.end - i.start) / 1000);
        }
        else {
            flushSeg();
            seg = { app: i.app, domain: i.domain, start: i.start, end: i.end, seconds: Math.round((i.end - i.start) / 1000) };
        }
    }
    flushSeg();
    timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const firstLogin = [sessions[0]?.startedAt, spanStart !== null ? new Date(spanStart).toISOString() : null, logins[0] ? iso(logins[0].login_at) : null]
        .filter(Boolean).sort()[0] ?? null;
    const allSessionsEnded = sessions.length > 0 && sessions.every((s) => !s.open);
    const lastLogout = allSessionsEnded ? sessions.map((s) => s.endedAt).filter(Boolean).sort().pop() ?? null : null;
    const lActive = longest('active');
    const lIdle = longest('idle');
    const toIso = (value) => new Date(value).toISOString();
    const openSessionDuration = sessions.filter((s) => s.open).reduce((sum, s) => {
        const startMs = s.startedAt ? (parseUtc(s.startedAt)?.getTime() ?? 0) : 0;
        return sum + (startMs > 0 ? Math.max(0, Math.round((Date.now() - startMs) / 1000)) : 0);
    }, 0);
    const totalSessionSeconds = sessions.reduce((sum, s) => sum + s.seconds, 0) || openSessionDuration;
    const activeSec = total.active > 0 ? total.active : (activity.length === 0 && openSessionDuration > 0 ? Math.min(openSessionDuration, 3600) : 0);
    if (apps.size === 0 && hasLiveConnection && primary?.currentApp) {
        apps.set(primary.currentApp, {
            app: primary.currentApp,
            process: null,
            activeSeconds: totalSessionSeconds || 60,
            idleSeconds: 0,
            first: Date.now() - (totalSessionSeconds || 60) * 1000,
            last: Date.now(),
        });
    }
    if (timeline.length === 0 && hasLiveConnection) {
        timeline.push({
            at: primary?.lastHeartbeatAt ?? new Date().toISOString(),
            type: 'device_online',
            title: 'Tracking active · device connected',
            detail: primary?.currentApp ? `Current application: ${primary.currentApp}` : null,
            source: 'agent',
        });
    }
    return {
        summary: {
            hasData: activity.length > 0 || sessions.length > 0 || pointRaw.length > 0 || hasLiveConnection,
            firstLoginAt: firstLogin,
            lastLogoutAt: lastLogout,
            stillSignedIn: sessions.some((s) => s.open),
            sessionSeconds: totalSessionSeconds,
            activeSeconds: activeSec,
            idleSeconds: total.idle,
            lockedSeconds: total.locked,
            sessionCount: sessions.length,
            longestActive: lActive ? { start: toIso(lActive.start), end: toIso(lActive.end), seconds: Math.round((lActive.end - lActive.start) / 1000) } : null,
            longestIdle: lIdle ? { start: toIso(lIdle.start), end: toIso(lIdle.end), seconds: Math.round((lIdle.end - lIdle.start) / 1000) } : null,
            observedSpanSeconds: spanSeconds,
            trackedSeconds,
            offlineSeconds,
            completenessPercent: spanSeconds > 0 ? Math.min(100, Math.round((trackedSeconds / spanSeconds) * 1000) / 10) : null,
            idleThresholdSeconds: settings.idleThresholdSeconds,
        },
        applications: [...apps.values()].sort((a, b) => b.activeSeconds - a.activeSeconds).map((a) => ({
            app: a.app, process: a.process, activeSeconds: a.activeSeconds, idleSeconds: a.idleSeconds, firstUsedAt: toIso(a.first), lastUsedAt: toIso(a.last),
        })),
        websites: [...sites.values()].sort((a, b) => b.activeSeconds - a.activeSeconds).map((s) => ({
            browser: s.browser, domain: s.domain, activeSeconds: s.activeSeconds, visits: s.visits, firstVisitedAt: toIso(s.first), lastVisitedAt: toIso(s.last),
        })),
        sessions,
        gaps,
        timeline: timeline.slice(0, 2000),
        timelineTruncated: timeline.length > 2000,
    };
}
/** Dates (inclusive) between two business dates. */
export function dateList(from, to) {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1))
        out.push(d);
    return out;
}
//# sourceMappingURL=TrackingQueryService.js.map