import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { execute, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
const ALLOWED_MIME = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'audio/webm',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp4',
    'video/webm',
    'video/mp4',
]);
const ALLOWED_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.webm', '.ogg', '.mp3', '.m4a', '.mp4',
]);
export class FileService {
    static uploadRoot() {
        return path.isAbsolute(config.uploadDir) ? config.uploadDir : path.resolve(process.cwd(), config.uploadDir);
    }
    static async ensureStorage() {
        await fs.mkdir(FileService.uploadRoot(), { recursive: true });
    }
    static validate(originalName, mimeType, size) {
        const ext = path.extname(originalName).toLowerCase();
        if (!ALLOWED_EXT.has(ext) || !ALLOWED_MIME.has(mimeType)) {
            throw ApiError.badRequest('Unsupported file type. Upload images, PDFs, Office documents, archives or audio.');
        }
        if (size > config.maxUploadMb * 1024 * 1024) {
            throw ApiError.badRequest(`File exceeds the ${config.maxUploadMb}MB limit.`);
        }
        if (/\.(exe|bat|cmd|sh|php|js|msi|dll)(?:\.|$)/i.test(originalName)) {
            throw ApiError.badRequest('Executable files are not permitted.');
        }
    }
    static async register(ownerId, input) {
        const result = await execute('INSERT INTO files (owner_id, storage_key, original_name, mime_type, size_bytes, is_private, scan_status) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            ownerId,
            input.storageKey,
            input.originalName.slice(0, 250),
            input.mimeType,
            input.size,
            input.isPrivate === false ? 0 : 1,
            input.scanStatus ?? 'clean',
        ]);
        return result.insertId;
    }
    /**
     * Private attachment access: owner, or someone linked to the owning task,
     * report, ticket or conversation.
     */
    static async getForUser(fileId, user) {
        const file = await queryOne("SELECT id, owner_id, storage_key, original_name, mime_type, size_bytes, is_private FROM files WHERE id = ? AND (scan_status = 'clean' OR (scan_status = 'validated' AND is_private = 0))", [fileId]);
        if (!file)
            throw ApiError.notFound('File not found');
        // Public images (profile photos) may be viewed by any signed-in employee.
        if (Number(file.is_private) === 0)
            return file;
        if (Number(file.owner_id) === user.id)
            return file;
        const [taskLink, reportLink, ticketLink, messageLink] = await Promise.all([
            queryOne(`SELECT ta.id FROM task_attachments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.file_id = ? AND (t.created_by = ? OR t.manager_id = ?
           OR EXISTS (SELECT 1 FROM task_assignments x WHERE x.task_id = t.id AND x.employee_id = ?)) LIMIT 1`, [fileId, user.id, user.id, user.id]),
            queryOne(`SELECT ra.id FROM daily_report_attachments ra JOIN daily_work_reports r ON r.id = ra.report_id
         WHERE ra.file_id = ? AND (r.employee_id = ? OR r.reviewed_by = ?) LIMIT 1`, [fileId, user.id, user.id]),
            queryOne(`SELECT x.id FROM ticket_attachments x JOIN tickets t ON t.id = x.ticket_id
         WHERE x.file_id = ? AND (t.requester_id = ? OR t.assignee_id = ?) LIMIT 1`, [fileId, user.id, user.id]),
            queryOne(`SELECT x.id FROM message_attachments x JOIN messages m ON m.id = x.message_id
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.employee_id = ?
         WHERE x.file_id = ? LIMIT 1`, [user.id, fileId]),
        ]);
        if (taskLink || reportLink || ticketLink || messageLink)
            return file;
        throw ApiError.forbidden('You do not have access to this file.');
    }
    static absolutePath(storageKey) {
        const root = FileService.uploadRoot();
        const resolved = path.resolve(root, storageKey);
        if (resolved !== root && !resolved.startsWith(path.resolve(root) + path.sep)) {
            throw ApiError.forbidden('Invalid file path');
        }
        return resolved;
    }
    /** Removes a profile image owned by the employee, including its bytes and row. */
    static async removeOwnedPublicFile(fileId, ownerId) {
        const file = await queryOne('SELECT storage_key FROM files WHERE id = ? AND owner_id = ? AND is_private = 0', [fileId, ownerId]);
        if (!file)
            return;
        await fs.unlink(FileService.absolutePath(file.storage_key)).catch(() => undefined);
        await execute('DELETE FROM files WHERE id = ?', [fileId]);
    }
    static async removeFile(fileId, user) {
        const file = await FileService.getForUser(fileId, user);
        if (Number(file.owner_id) !== user.id && !user.permissions.includes('employees.manage')) {
            throw ApiError.forbidden('You cannot delete this file.');
        }
        await fs.unlink(FileService.absolutePath(file.storage_key)).catch(() => undefined);
        await execute('DELETE FROM files WHERE id = ?', [fileId]);
    }
    static async stats() {
        const row = await queryOne('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM files');
        return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
    }
}
//# sourceMappingURL=FileService.js.map