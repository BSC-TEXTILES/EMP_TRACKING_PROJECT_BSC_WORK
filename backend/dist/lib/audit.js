import { execute, query, queryOne } from '../db/index.js';
/**
 * Append-only audit trail. Never throws into the caller's business flow.
 */
export async function recordAudit(input) {
    try {
        await execute(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            input.actorId ?? null,
            input.action,
            input.entityType,
            input.entityId ?? null,
            input.before === undefined ? null : JSON.stringify(input.before),
            input.after === undefined ? null : JSON.stringify(input.after),
            input.ip ?? null,
            input.userAgent ? input.userAgent.slice(0, 250) : null,
        ]);
    }
    catch (error) {
        console.error('[audit] failed to persist audit entry', error);
    }
}
export async function getSetting(key, fallback = '') {
    const row = await queryOne('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
    return row?.setting_value ?? fallback;
}
export async function getSettings(keys) {
    if (keys.length === 0)
        return {};
    const placeholders = keys.map(() => '?').join(',');
    const rows = await query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${placeholders})`, keys);
    return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value ?? '']));
}
export async function setSetting(key, value, updatedBy) {
    await execute(`INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`, [key, value, updatedBy ?? null]);
}
export const SETTING_DEFAULTS = {
    work_start_time: '09:30',
    work_end_time: '18:30',
    late_grace_minutes: '10',
    half_day_hours: '4',
    full_day_hours: '9',
    overtime_after_hours: '9',
    work_days: '1,2,3,4,5,6',
    missing_checkout_grace_minutes: '120',
    daily_report_reminder_time: '18:00',
    lunch_start_time: '13:00',
    lunch_end_time: '14:00',
    break_duration_minutes: '60',
    shifts_catalog_json: '',
    location_shifts_json: '',
    kpi_publish_day: '3',
    sla_hours_low: '72',
    sla_hours_medium: '48',
    sla_hours_high: '24',
    sla_hours_critical: '4',
    allow_self_registration: 'true',
    require_otp_on_login: 'false',
    company_name: 'Workforce Enterprise',
};
//# sourceMappingURL=audit.js.map