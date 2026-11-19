import { execute, query, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { assertEmployeeAccess } from '../lib/scope.js';
const RECORD_TABLES = {
    app: {
        table: 'application_usage_logs',
        label: 'Application Usage',
        titleCol: 'app_name',
        detailCol: 'app_category',
        timeCol: 'started_at',
        secCol: 'active_seconds',
    },
    browser: {
        table: 'browser_usage_logs',
        label: 'Browser Activity',
        titleCol: 'domain',
        detailCol: 'category',
        timeCol: 'started_at',
        secCol: 'active_seconds',
    },
    module: {
        table: 'internal_module_activity',
        label: 'Platform Module',
        titleCol: 'module',
        detailCol: 'page_path',
        timeCol: 'entered_at',
        secCol: 'active_seconds',
    },
    work: {
        table: 'work_activity_events',
        label: 'Work Activity Event',
        titleCol: 'title',
        detailCol: 'source_type',
        timeCol: 'occurred_at',
    },
    session: {
        table: 'monitoring_sessions',
        label: 'Monitoring Work Session',
        titleCol: "CONCAT('Session on ', work_date, ' (', status, ')')",
        detailCol: 'status',
        timeCol: 'started_at',
    },
    summary: {
        table: 'daily_activity_summaries',
        label: 'Daily Activity Summary',
        titleCol: "CONCAT('Summary for ', summary_date)",
        detailCol: 'status',
        timeCol: 'generated_at',
    },
};
export class ActivityDeletionService {
    static canDelete(user) {
        return ((user.roleLevel !== undefined && user.roleLevel >= 70) ||
            user.permissions.includes('activity.delete') ||
            user.permissions.includes('activity.view.all'));
    }
    static canRestore(user) {
        return ((user.roleLevel !== undefined && user.roleLevel >= 80) ||
            user.permissions.includes('activity.restore') ||
            user.permissions.includes('activity.view.all'));
    }
    static canPermanent(user) {
        // Only Super Admin (Level 100) or explicit permanent deletion permission
        return ((user.roleLevel !== undefined && user.roleLevel >= 100) ||
            user.permissions.includes('activity.delete.permanent'));
    }
    static validateType(type) {
        if (['login_audit', 'security', 'audit_log'].includes(type)) {
            throw ApiError.forbidden('Security audit trails and login history are immutable and protected by retention policy.');
        }
        if (!(type in RECORD_TABLES)) {
            throw ApiError.badRequest(`Invalid activity record type "${type}". Allowed types: ${Object.keys(RECORD_TABLES).join(', ')}`);
        }
        return type;
    }
    /** Soft delete an individual activity record with audit logging. */
    static async softDeleteRecord(user, typeRaw, id, reason, ip) {
        if (!ActivityDeletionService.canDelete(user)) {
            throw ApiError.forbidden('You do not have permission to delete employee activity records.');
        }
        const type = ActivityDeletionService.validateType(typeRaw);
        const meta = RECORD_TABLES[type];
        const record = await queryOne(`SELECT id, employee_id, deleted_at FROM ${meta.table} WHERE id = ?`, [id]);
        if (!record) {
            throw ApiError.notFound(`Activity record (${meta.label} #${id}) not found.`);
        }
        if (record.deleted_at) {
            return { ok: true, type, id, message: 'Record is already moved to Recycle Bin.' };
        }
        await assertEmployeeAccess(user, Number(record.employee_id), 'activity');
        const cleanReason = (reason || 'Deleted by administrator').slice(0, 255);
        await execute(`UPDATE ${meta.table} SET deleted_at = NOW(3), deleted_by = ?, delete_reason = ? WHERE id = ? AND deleted_at IS NULL`, [user.id, cleanReason, id]);
        // Write audit trail
        await execute(`INSERT INTO activity_audit_logs (actor_id, action, target_employee_id, entity_type, entity_id, detail, ip)
       VALUES (?, 'record.soft_deleted', ?, ?, ?, ?, ?)`, [
            user.id,
            record.employee_id,
            type,
            id,
            JSON.stringify({ label: meta.label, reason: cleanReason }),
            ip?.slice(0, 60) ?? null,
        ]).catch(() => undefined);
        return { ok: true, type, id, message: `${meta.label} #${id} moved to Recycle Bin.` };
    }
    /** Bulk soft delete multiple activity records. */
    static async bulkSoftDelete(user, items, reason, ip) {
        if (!ActivityDeletionService.canDelete(user)) {
            throw ApiError.forbidden('You do not have permission to delete employee activity records.');
        }
        if (!items || items.length === 0) {
            throw ApiError.badRequest('No activity records provided for deletion.');
        }
        let count = 0;
        let failed = 0;
        for (const item of items.slice(0, 100)) {
            try {
                await ActivityDeletionService.softDeleteRecord(user, item.type, item.id, reason, ip);
                count++;
            }
            catch (err) {
                failed++;
            }
        }
        return { ok: true, count, failed };
    }
    /** Retrieve soft-deleted activity records for the Recycle Bin / Trash view. */
    static async listTrash(user, filters = {}) {
        if (!ActivityDeletionService.canDelete(user) && !ActivityDeletionService.canRestore(user)) {
            throw ApiError.forbidden('You do not have permission to access the Activity Recycle Bin.');
        }
        const typesToQuery = filters.type && filters.type !== 'all'
            ? [ActivityDeletionService.validateType(filters.type)]
            : Object.keys(RECORD_TABLES);
        const unionQueries = [];
        const params = [];
        for (const t of typesToQuery) {
            const meta = RECORD_TABLES[t];
            const titleExp = meta.titleCol.includes('(') ? meta.titleCol : `t.${meta.titleCol}`;
            const detailExp = meta.detailCol ? `t.${meta.detailCol}` : "''";
            const timeExp = meta.timeCol ? `t.${meta.timeCol}` : 'NULL';
            const secExp = meta.secCol ? `ROUND(t.${meta.secCol} / 60)` : '0';
            let whereClause = 'WHERE t.deleted_at IS NOT NULL';
            if (filters.employeeId) {
                whereClause += ' AND t.employee_id = ?';
                params.push(filters.employeeId);
            }
            unionQueries.push(`
        SELECT 
          t.id,
          '${t}' AS record_type,
          '${meta.label}' AS type_label,
          t.employee_id,
          e.full_name AS employee_name,
          e.employee_code,
          ${titleExp} AS record_title,
          ${detailExp} AS record_detail,
          ${secExp} AS duration_minutes,
          ${timeExp} AS recorded_at,
          t.deleted_at,
          t.deleted_by,
          d.full_name AS deleted_by_name,
          t.delete_reason
        FROM ${meta.table} t
        LEFT JOIN employees e ON e.id = t.employee_id
        LEFT JOIN employees d ON d.id = t.deleted_by
        ${whereClause}
      `);
        }
        const combinedSql = unionQueries.join(' UNION ALL ') + ' ORDER BY deleted_at DESC LIMIT ? OFFSET ?';
        const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
        const offset = Math.max(0, filters.offset ?? 0);
        params.push(limit, offset);
        const rows = await query(combinedSql, params);
        // Get total count
        let total = 0;
        for (const t of typesToQuery) {
            const meta = RECORD_TABLES[t];
            const countRes = await queryOne(`SELECT COUNT(*) AS count FROM ${meta.table} WHERE deleted_at IS NOT NULL ${filters.employeeId ? 'AND employee_id = ?' : ''}`, filters.employeeId ? [filters.employeeId] : []);
            total += Number(countRes?.count ?? 0);
        }
        const items = rows.map((r) => ({
            id: Number(r.id),
            type: r.record_type,
            typeLabel: String(r.type_label ?? ''),
            employeeId: Number(r.employee_id),
            employeeName: String(r.employee_name ?? 'Unknown Employee'),
            employeeCode: String(r.employee_code ?? 'EMP'),
            title: String(r.record_title ?? 'Untitled'),
            detail: String(r.record_detail ?? ''),
            durationMinutes: Number(r.duration_minutes ?? 0),
            recordedAt: r.recorded_at ? String(r.recorded_at) : null,
            deletedAt: String(r.deleted_at ?? ''),
            deletedBy: r.deleted_by ? { id: Number(r.deleted_by), name: String(r.deleted_by_name ?? 'Administrator') } : null,
            deleteReason: r.delete_reason ? String(r.delete_reason) : null,
        }));
        return { items, total };
    }
    /** Restore a soft-deleted activity record from the Recycle Bin. */
    static async restoreRecord(user, typeRaw, id, ip) {
        if (!ActivityDeletionService.canRestore(user)) {
            throw ApiError.forbidden('You do not have permission to restore deleted activity records.');
        }
        const type = ActivityDeletionService.validateType(typeRaw);
        const meta = RECORD_TABLES[type];
        const record = await queryOne(`SELECT id, employee_id, deleted_at FROM ${meta.table} WHERE id = ?`, [id]);
        if (!record) {
            throw ApiError.notFound(`Activity record (${meta.label} #${id}) not found.`);
        }
        if (!record.deleted_at) {
            return { ok: true, type, id, message: 'Record is already active and not in Recycle Bin.' };
        }
        await assertEmployeeAccess(user, Number(record.employee_id), 'activity');
        await execute(`UPDATE ${meta.table} SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = ?`, [id]);
        // Write audit trail
        await execute(`INSERT INTO activity_audit_logs (actor_id, action, target_employee_id, entity_type, entity_id, detail, ip)
       VALUES (?, 'record.restored', ?, ?, ?, ?, ?)`, [
            user.id,
            record.employee_id,
            type,
            id,
            JSON.stringify({ label: meta.label, action: 'Restored from Recycle Bin' }),
            ip?.slice(0, 60) ?? null,
        ]).catch(() => undefined);
        return { ok: true, type, id, message: `${meta.label} #${id} restored successfully.` };
    }
    /** Bulk restore multiple records. */
    static async bulkRestore(user, items, ip) {
        if (!ActivityDeletionService.canRestore(user)) {
            throw ApiError.forbidden('You do not have permission to restore deleted activity records.');
        }
        if (!items || items.length === 0) {
            throw ApiError.badRequest('No records provided for restore.');
        }
        let count = 0;
        let failed = 0;
        for (const item of items.slice(0, 100)) {
            try {
                await ActivityDeletionService.restoreRecord(user, item.type, item.id, ip);
                count++;
            }
            catch {
                failed++;
            }
        }
        return { ok: true, count, failed };
    }
    /** Permanently purge a soft-deleted record (Super Admin only). */
    static async permanentDeleteRecord(user, typeRaw, id, ip) {
        if (!ActivityDeletionService.canPermanent(user)) {
            throw ApiError.forbidden('Permanent deletion is restricted to Super Admin under organisation data retention policy.');
        }
        const type = ActivityDeletionService.validateType(typeRaw);
        const meta = RECORD_TABLES[type];
        const record = await queryOne(`SELECT id, employee_id, deleted_at FROM ${meta.table} WHERE id = ?`, [id]);
        if (!record) {
            throw ApiError.notFound(`Activity record (${meta.label} #${id}) not found.`);
        }
        // Record MUST be in trash first to prevent accidental permanent deletion
        if (!record.deleted_at) {
            throw ApiError.badRequest('Record must be soft-deleted and placed in the Recycle Bin before permanent deletion.');
        }
        await execute(`DELETE FROM ${meta.table} WHERE id = ? AND deleted_at IS NOT NULL`, [id]);
        // Record immutable audit trail
        await execute(`INSERT INTO activity_audit_logs (actor_id, action, target_employee_id, entity_type, entity_id, detail, ip)
       VALUES (?, 'record.permanently_purged', ?, ?, ?, ?, ?)`, [
            user.id,
            record.employee_id,
            type,
            id,
            JSON.stringify({ label: meta.label, action: 'Permanent purge from Recycle Bin' }),
            ip?.slice(0, 60) ?? null,
        ]).catch(() => undefined);
        return { ok: true, type, id, message: `${meta.label} #${id} permanently purged.` };
    }
    /** Bulk permanent purge (Super Admin only). */
    static async bulkPermanentDelete(user, items, ip) {
        if (!ActivityDeletionService.canPermanent(user)) {
            throw ApiError.forbidden('Permanent deletion is restricted to Super Admin under organisation data retention policy.');
        }
        if (!items || items.length === 0) {
            throw ApiError.badRequest('No records provided for permanent deletion.');
        }
        let count = 0;
        let failed = 0;
        for (const item of items.slice(0, 100)) {
            try {
                await ActivityDeletionService.permanentDeleteRecord(user, item.type, item.id, ip);
                count++;
            }
            catch {
                failed++;
            }
        }
        return { ok: true, count, failed };
    }
}
//# sourceMappingURL=ActivityDeletionService.js.map