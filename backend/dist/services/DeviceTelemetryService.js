import { execute, query, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { locationEmployeeClause } from '../lib/scope.js';
import { ActivityService } from './ActivityService.js';
/**
 * Device telemetry ported from LiveGuard Pro into the Activity module:
 * live device health (CPU / memory / disk / network / Windows Defender posture)
 * and opt-in device location, both tied to the authenticated agent and the
 * employee's acknowledged monitoring policy.
 */
const num = (value, min, max) => {
    if (value === undefined || value === null || value === '')
        return null;
    const n = Number(value);
    if (!Number.isFinite(n))
        return null;
    return Math.min(max, Math.max(min, n));
};
const text = (value, max) => {
    if (typeof value !== 'string')
        return null;
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return clean ? clean.slice(0, max) : null;
};
const bool = (value) => (typeof value === 'boolean' ? value : null);
export class DeviceTelemetryService {
    /** Stores a health sample. Only numeric hardware metrics and Defender status, never file or app content. */
    static async recordHealth(device, body) {
        const security = (body.security ?? {});
        const posture = {
            antivirusEnabled: bool(security.antivirusEnabled),
            realTimeProtection: bool(security.realTimeProtection),
            signatureAgeDays: num(security.signatureAgeDays, 0, 3650),
            recentThreats: num(security.recentThreats, 0, 10000),
            threatNames: Array.isArray(security.threatNames)
                ? security.threatNames.map((name) => text(name, 120)).filter((name) => Boolean(name)).slice(0, 10)
                : [],
            firewallEnabled: bool(security.firewallEnabled),
        };
        const details = {
            source: 'agent',
            memoryTotalMb: num(body.memoryTotalMb, 0, 10_000_000),
            diskTotalMb: num(body.diskTotalMb, 0, 1_000_000_000),
            uptimeMinutes: num(body.uptimeMinutes, 0, 10_000_000),
            cpuModel: text(body.cpuModel, 120),
            cpuCores: num(body.cpuCores, 0, 1024),
            networkName: text(body.networkName, 120),
            networkType: text(body.networkType, 30),
            security: posture,
        };
        await execute(`INSERT INTO device_health_logs (device_id, employee_id, cpu_percent, memory_percent, disk_free_mb, agent_version, details, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`, [
            device.deviceId,
            device.employeeId,
            num(body.cpuPercent, 0, 100),
            num(body.memoryPercent, 0, 100),
            num(body.diskFreeMb, 0, 2_000_000_000),
            text(body.agentVersion, 40),
            JSON.stringify(details),
        ]);
        // A real threat reported by Windows Defender is raised as a security incident
        // through the existing error pipeline, so it can become a support ticket.
        if (posture.recentThreats && posture.recentThreats > 0 && posture.threatNames.length > 0) {
            await ActivityService.ingest(device, [{
                    type: 'error',
                    clientEventId: `defender-${device.deviceId}-${posture.threatNames.join('|').slice(0, 80)}`,
                    errorCategory: 'Security threat detected',
                    application: 'Windows Defender',
                    module: 'Device security',
                    errorCode: 'DEFENDER_THREAT',
                    severity: 'high',
                    description: `Windows Defender reported ${posture.recentThreats} threat(s) in the last 7 days: ${posture.threatNames.join(', ')}`.slice(0, 400),
                    occurredAt: new Date().toISOString(),
                    diagnostic: { source: 'windows_defender', threats: posture.threatNames },
                }]).catch(() => undefined);
        }
        // Keep the session alive without overwriting the idle state the heartbeat reports.
        if (device.sessionId)
            await execute('UPDATE monitoring_sessions SET last_heartbeat_at = NOW(3) WHERE id = ?', [device.sessionId]);
        return { ok: true, deviceId: device.deviceId, sessionId: device.sessionId };
    }
    /** Stores a device location sample when the policy allows it and a work session is open. */
    static async recordLocation(device, body) {
        const policy = await DeviceTelemetryService.locationPolicy();
        if (!policy.enabled)
            return { accepted: false, reason: 'location_tracking_disabled' };
        if (!device.sessionId || device.sessionStatus !== 'active')
            return { accepted: false, reason: 'no_active_session' };
        const latitude = num(body.latitude, -90, 90);
        const longitude = num(body.longitude, -180, 180);
        if (latitude === null || longitude === null || (latitude === 0 && longitude === 0)) {
            throw ApiError.badRequest('A valid latitude and longitude are required.');
        }
        const accuracy = num(body.accuracyM, 0, 1_000_000);
        // Reject IP-level guesses (> 50 km): they place people in the wrong city.
        if (accuracy !== null && accuracy > 50_000)
            return { accepted: false, reason: 'accuracy_too_low' };
        const source = ['windows_location', 'wifi', 'manual'].includes(String(body.source)) ? String(body.source) : 'windows_location';
        await execute(`INSERT INTO device_location_logs (device_id, employee_id, session_id, latitude, longitude, accuracy_m, source, network_name, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`, [device.deviceId, device.employeeId, device.sessionId, latitude, longitude, accuracy === null ? null : Math.round(accuracy), source, text(body.networkName, 120)]);
        await ActivityService.notifyWatchers(device.employeeId, 'activity:location', { deviceId: device.deviceId }).catch(() => undefined);
        return { accepted: true, intervalMinutes: policy.intervalMinutes };
    }
    static async locationPolicy() {
        const row = await queryOne('SELECT location_tracking_enabled, location_interval_minutes FROM monitoring_policies WHERE is_active = 1 ORDER BY effective_at DESC, id DESC LIMIT 1').catch(() => null);
        return {
            enabled: Boolean(row?.location_tracking_enabled),
            intervalMinutes: Math.min(240, Math.max(5, Number(row?.location_interval_minutes ?? 15) || 15)),
        };
    }
    static assertViewer(user) {
        if (!user.permissions.includes('activity.view.all') && !user.permissions.includes('activity.devices.manage') && !user.permissions.includes('activity.view.team')) {
            throw ApiError.forbidden('You cannot view device tracking.');
        }
    }
    /** Scope: organisation-wide viewers see everyone; team viewers see their location's employees. */
    static async scope(user) {
        if (user.permissions.includes('activity.view.all') || user.permissions.includes('activity.devices.manage'))
            return { clause: '1 = 1', params: [] };
        return locationEmployeeClause(user, 'e.id');
    }
    /** Live device board: latest health, security posture and location per active device. */
    static async liveDevices(user) {
        DeviceTelemetryService.assertViewer(user);
        const scope = await DeviceTelemetryService.scope(user);
        const rows = await query(`SELECT d.id AS device_id, d.device_name, d.os_name, d.os_version, d.agent_version, d.last_seen_at,
              e.id AS employee_id, e.full_name, e.employee_code, e.photo_url,
              dp.name AS department_name, l.name AS location_name,
              s.status AS session_status, s.current_app, s.idle_seconds,
              h.cpu_percent, h.memory_percent, h.disk_free_mb, h.details AS health_details, h.reported_at AS health_at,
              g.latitude, g.longitude, g.accuracy_m, g.network_name, g.recorded_at AS location_at
         FROM employee_devices d
         JOIN employees e ON e.id = d.employee_id
         LEFT JOIN departments dp ON dp.id = e.department_id
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN monitoring_sessions s ON s.id = (
              SELECT ms.id FROM monitoring_sessions ms WHERE ms.device_id = d.id AND ms.status IN ('active','paused') ORDER BY ms.id DESC LIMIT 1)
         LEFT JOIN device_health_logs h ON h.id = (
              SELECT hl.id FROM device_health_logs hl WHERE hl.device_id = d.id ORDER BY hl.reported_at DESC LIMIT 1)
         LEFT JOIN device_location_logs g ON g.id = (
              SELECT gl.id FROM device_location_logs gl WHERE gl.device_id = d.id ORDER BY gl.recorded_at DESC LIMIT 1)
        WHERE d.status = 'active' AND e.status = 'active' AND ${scope.clause}
        ORDER BY (s.status = 'active') DESC, d.last_seen_at DESC
        LIMIT 300`, scope.params);
        const policy = await DeviceTelemetryService.locationPolicy();
        return {
            locationTrackingEnabled: policy.enabled,
            devices: rows.map((row) => {
                let details = {};
                try {
                    details = typeof row.health_details === 'string' ? JSON.parse(row.health_details) : (row.health_details ?? {});
                }
                catch {
                    details = {};
                }
                const lastSeen = row.last_seen_at ? new Date(String(row.last_seen_at)) : null;
                const online = Boolean(lastSeen && Date.now() - lastSeen.getTime() < 3 * 60 * 1000);
                return {
                    deviceId: Number(row.device_id),
                    deviceName: row.device_name,
                    os: [row.os_name, row.os_version].filter(Boolean).join(' '),
                    agentVersion: row.agent_version,
                    lastSeenAt: row.last_seen_at,
                    online,
                    employee: {
                        id: Number(row.employee_id),
                        name: row.full_name,
                        code: row.employee_code,
                        photoUrl: row.photo_url,
                        department: row.department_name,
                        location: row.location_name,
                    },
                    session: row.session_status ? { status: row.session_status, currentApp: row.current_app ?? null, isIdle: Number(row.idle_seconds ?? 0) >= 300 } : null,
                    health: row.health_at
                        ? {
                            cpuPercent: row.cpu_percent === null ? null : Number(row.cpu_percent),
                            memoryPercent: row.memory_percent === null ? null : Number(row.memory_percent),
                            diskFreeMb: row.disk_free_mb === null ? null : Number(row.disk_free_mb),
                            memoryTotalMb: details.memoryTotalMb ?? null,
                            diskTotalMb: details.diskTotalMb ?? null,
                            uptimeMinutes: details.uptimeMinutes ?? null,
                            cpuModel: details.cpuModel ?? null,
                            cpuCores: details.cpuCores ?? null,
                            networkName: details.networkName ?? null,
                            networkType: details.networkType ?? null,
                            security: details.security ?? null,
                            reportedAt: row.health_at,
                        }
                        : null,
                    location: row.location_at
                        ? {
                            latitude: Number(row.latitude),
                            longitude: Number(row.longitude),
                            accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
                            networkName: row.network_name,
                            recordedAt: row.location_at,
                        }
                        : null,
                };
            }),
        };
    }
    /** Location trail for one device on one day (for the map history). */
    static async locationTrail(user, deviceId, date) {
        DeviceTelemetryService.assertViewer(user);
        const scope = await DeviceTelemetryService.scope(user);
        const device = await queryOne(`SELECT d.id FROM employee_devices d JOIN employees e ON e.id = d.employee_id WHERE d.id = ? AND ${scope.clause}`, [deviceId, ...scope.params]);
        if (!device)
            throw ApiError.notFound('Device not found');
        const points = await query(`SELECT latitude, longitude, accuracy_m, network_name, recorded_at FROM device_location_logs
        WHERE device_id = ? AND recorded_at >= ? AND recorded_at < DATE_ADD(?, INTERVAL 1 DAY)
        ORDER BY recorded_at LIMIT 2000`, [deviceId, date, date]);
        await ActivityService.audit(user.id, 'activity.location_viewed', null, 'device', deviceId, { date });
        return {
            points: points.map((p) => ({
                latitude: Number(p.latitude),
                longitude: Number(p.longitude),
                accuracyM: p.accuracy_m === null ? null : Number(p.accuracy_m),
                networkName: p.network_name,
                recordedAt: p.recorded_at,
            })),
        };
    }
}
//# sourceMappingURL=DeviceTelemetryService.js.map