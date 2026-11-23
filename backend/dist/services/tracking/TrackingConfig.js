import { z } from 'zod';
import { execute, query, queryOne } from '../../db/index.js';
import { ApiError } from '../../lib/http.js';
import { allowedLocationIds } from '../../lib/scope.js';
import { trackingAudit } from './trackingAudit.js';
const COLUMNS = {
    trackingEnabled: 'tracking_enabled',
    deviceRegistrationEnabled: 'device_registration_enabled',
    selfEnrollmentEnabled: 'self_enrollment_enabled',
    appTrackingEnabled: 'app_tracking_enabled',
    websiteTrackingEnabled: 'website_tracking_enabled',
    windowTitleTrackingEnabled: 'window_title_tracking_enabled',
    idleThresholdSeconds: 'idle_threshold_seconds',
    heartbeatIntervalSeconds: 'heartbeat_interval_seconds',
    syncIntervalSeconds: 'sync_interval_seconds',
    offlineAfterSeconds: 'offline_after_seconds',
    latestAgentVersion: 'latest_agent_version',
    minimumAgentVersion: 'minimum_agent_version',
    retentionDays: 'retention_days',
    noticeText: 'notice_text',
};
const BOOLEAN_KEYS = [
    'trackingEnabled', 'deviceRegistrationEnabled', 'selfEnrollmentEnabled',
    'appTrackingEnabled', 'websiteTrackingEnabled', 'windowTitleTrackingEnabled',
];
/** Safe defaults used if the settings row is missing (e.g. before migrations ran). */
export const DEFAULT_SETTINGS = {
    trackingEnabled: true,
    deviceRegistrationEnabled: true,
    selfEnrollmentEnabled: false,
    appTrackingEnabled: true,
    websiteTrackingEnabled: true,
    windowTitleTrackingEnabled: false,
    idleThresholdSeconds: 300,
    heartbeatIntervalSeconds: 60,
    syncIntervalSeconds: 30,
    offlineAfterSeconds: 180,
    latestAgentVersion: '2.0.0',
    minimumAgentVersion: '2.0.0',
    retentionDays: 90,
    noticeText: 'BSC Textiles records work activity on this company computer while you are signed in.',
};
const version = z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'Use a version such as 2.0.0');
/** Every field optional: a location override may set any subset; `null` = inherit. */
export const settingsPatchSchema = z.object({
    trackingEnabled: z.boolean().nullable().optional(),
    deviceRegistrationEnabled: z.boolean().nullable().optional(),
    selfEnrollmentEnabled: z.boolean().nullable().optional(),
    appTrackingEnabled: z.boolean().nullable().optional(),
    websiteTrackingEnabled: z.boolean().nullable().optional(),
    windowTitleTrackingEnabled: z.boolean().nullable().optional(),
    idleThresholdSeconds: z.number().int().min(60).max(3600).nullable().optional(),
    heartbeatIntervalSeconds: z.number().int().min(15).max(600).nullable().optional(),
    syncIntervalSeconds: z.number().int().min(10).max(600).nullable().optional(),
    offlineAfterSeconds: z.number().int().min(60).max(3600).nullable().optional(),
    latestAgentVersion: version.nullable().optional(),
    minimumAgentVersion: version.nullable().optional(),
    retentionDays: z.number().int().min(7).max(1095).nullable().optional(),
    noticeText: z.string().trim().min(40).max(4000).nullable().optional(),
}).strict();
function rowToPartial(row) {
    const out = {};
    if (!row)
        return out;
    for (const [key, column] of Object.entries(COLUMNS)) {
        const value = row[column];
        if (value === null || value === undefined)
            continue;
        if (BOOLEAN_KEYS.includes(key))
            out[key] = Boolean(Number(value));
        else if (typeof DEFAULT_SETTINGS[key] === 'number')
            out[key] = Number(value);
        else
            out[key] = String(value);
    }
    return out;
}
let cache = null;
const CACHE_MS = 15_000;
async function load() {
    if (cache && Date.now() - cache.at < CACHE_MS)
        return cache;
    const rows = await query('SELECT * FROM tracking_settings').catch(() => []);
    const global = rowToPartial(rows.find((row) => row.scope_key === 'global') ?? null);
    const byLocation = new Map();
    for (const row of rows) {
        if (row.scope_key !== 'global' && row.location_id)
            byLocation.set(Number(row.location_id), rowToPartial(row));
    }
    cache = { at: Date.now(), global, byLocation };
    return cache;
}
export function invalidateTrackingSettings() {
    cache = null;
}
/** Ensures derived constraints hold whatever combination was configured. */
function normalise(settings) {
    const offline = Math.max(settings.offlineAfterSeconds, settings.heartbeatIntervalSeconds * 2 + 15);
    return { ...settings, offlineAfterSeconds: offline };
}
export const TrackingConfig = {
    async global() {
        const { global } = await load();
        return normalise({ ...DEFAULT_SETTINGS, ...global });
    },
    /** Global settings with the location override applied. */
    async forLocation(locationId) {
        const { global, byLocation } = await load();
        const override = locationId ? byLocation.get(Number(locationId)) ?? {} : {};
        return normalise({ ...DEFAULT_SETTINGS, ...global, ...override });
    },
    async forEmployee(employeeId) {
        const row = await queryOne('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
        return TrackingConfig.forLocation(row?.location_id ?? null);
    },
    /** Settings screen payload: the global row, each permitted location's override and its effective result. */
    async describe(user) {
        const { global, byLocation } = await load();
        const allowed = await allowedLocationIds(user);
        const locations = await query("SELECT id, code, name FROM locations WHERE code <> 'ALL' ORDER BY FIELD(code,'BEL','DAV','SHI','HQ'), name");
        const visible = locations.filter((loc) => allowed === null || allowed.includes(Number(loc.id)));
        return {
            global: normalise({ ...DEFAULT_SETTINGS, ...global }),
            canEditGlobal: allowed === null,
            locations: await Promise.all(visible.map(async (loc) => ({
                id: Number(loc.id),
                code: loc.code,
                name: loc.name,
                overrides: byLocation.get(Number(loc.id)) ?? {},
                effective: await TrackingConfig.forLocation(Number(loc.id)),
            }))),
        };
    },
    /** Updates the global row (locationId null) or a location override. Audited. */
    async update(user, locationId, patch, ip) {
        if (!user.permissions.includes('activity.policy.manage'))
            throw ApiError.forbidden('You cannot change tracking settings.');
        const allowed = await allowedLocationIds(user);
        if (locationId === null && allowed !== null)
            throw ApiError.forbidden('Only organisation-wide administrators can change global tracking settings.');
        if (locationId !== null) {
            const location = await queryOne('SELECT id, code FROM locations WHERE id = ?', [locationId]);
            if (!location || location.code === 'ALL')
                throw ApiError.notFound('Location not found.');
            if (allowed !== null && !allowed.includes(locationId))
                throw ApiError.forbidden('That location is outside your access.');
        }
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
        if (entries.length === 0)
            throw ApiError.badRequest('No settings were provided.');
        if (locationId === null && entries.some(([, value]) => value === null)) {
            throw ApiError.badRequest('Global settings cannot be cleared; provide a value.');
        }
        const current = await TrackingConfig.forLocation(locationId);
        const prospective = { ...current, ...Object.fromEntries(entries.filter(([, value]) => value !== null)) };
        if (compareVersions(prospective.minimumAgentVersion, prospective.latestAgentVersion) > 0) {
            throw ApiError.badRequest('The minimum agent version cannot be newer than the latest agent version.');
        }
        const scopeKey = locationId === null ? 'global' : `location:${locationId}`;
        await execute('INSERT IGNORE INTO tracking_settings (scope_key, location_id) VALUES (?, ?)', [scopeKey, locationId]);
        const before = await queryOne('SELECT * FROM tracking_settings WHERE scope_key = ?', [scopeKey]);
        const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`);
        const values = entries.map(([key, value]) => (value === null ? null : BOOLEAN_KEYS.includes(key) ? (value ? 1 : 0) : value));
        await execute(`UPDATE tracking_settings SET ${sets.join(', ')}, updated_by = ? WHERE scope_key = ?`, [...values, user.id, scopeKey]);
        invalidateTrackingSettings();
        await trackingAudit(user.id, 'tracking.settings_updated', null, 'tracking_settings', null, {
            scope: scopeKey,
            changes: Object.fromEntries(entries.map(([key, value]) => [key, { from: rowToPartial(before)[key] ?? null, to: value }])),
        }, ip);
        return TrackingConfig.describe(user);
    },
};
/** Compares dotted numeric versions. */
export function compareVersions(a, b) {
    const pa = a.split('.').map((part) => Number(part) || 0);
    const pb = b.split('.').map((part) => Number(part) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0)
            return diff > 0 ? 1 : -1;
    }
    return 0;
}
//# sourceMappingURL=TrackingConfig.js.map