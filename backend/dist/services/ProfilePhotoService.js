import fs from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { execute, queryOne } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { ApiError } from '../lib/http.js';
import { scanBuffer } from '../lib/uploadSecurity.js';
import { AVATAR_MAX_BYTES } from '../lib/imageUpload.js';
import { FileService } from './FileService.js';
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_URL = /^\/api\/files\/(\d+)(?:\?.*)?$/;
/**
 * Profile pictures are content-verified raster images. When ClamAV is configured
 * they are also malware-scanned; otherwise they are stored as `validated` and
 * served only as public avatar images, never as general attachments.
 */
export class ProfilePhotoService {
    static async setPhoto(employeeId, actor, file) {
        if (employeeId !== actor.id && !actor.permissions.includes('employees.manage')) {
            throw ApiError.forbidden('You cannot change this profile photo.');
        }
        try {
            if (!ALLOWED_MIME.has(file.mimetype))
                throw ApiError.badRequest('Choose a PNG, JPEG, WebP or GIF image.');
            if (file.size <= 0)
                throw ApiError.badRequest('The selected image is empty.');
            if (file.size > AVATAR_MAX_BYTES)
                throw ApiError.badRequest('Profile photos must be 5 MB or smaller.');
            const buffer = await fs.readFile(file.path);
            const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
            if (!detected || detected.mime !== file.mimetype || !ALLOWED_MIME.has(detected.mime)) {
                throw ApiError.badRequest('The image content does not match its file type.');
            }
            let scanStatus = 'validated';
            if (process.env.CLAMAV_HOST) {
                await scanBuffer(buffer);
                scanStatus = 'clean';
            }
            const previous = await queryOne('SELECT photo_url FROM employees WHERE id = ?', [employeeId]);
            if (!previous)
                throw ApiError.notFound('Employee not found');
            const fileId = await FileService.register(employeeId, {
                storageKey: path.basename(file.path),
                originalName: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
                isPrivate: false,
                scanStatus,
            });
            const photoUrl = `/api/files/${fileId}?v=${Date.now()}`;
            await execute('UPDATE employees SET photo_url = ? WHERE id = ?', [photoUrl, employeeId]);
            const oldId = Number(previous.photo_url?.match(AVATAR_URL)?.[1] ?? 0);
            if (oldId && oldId !== fileId)
                await FileService.removeOwnedPublicFile(oldId, employeeId);
            await recordAudit({
                actorId: actor.id,
                action: 'employee.photo_updated',
                entityType: 'employee',
                entityId: employeeId,
                before: { photoUrl: previous.photo_url },
                after: { photoUrl, scanStatus },
            });
            return { photoUrl };
        }
        catch (error) {
            await fs.unlink(file.path).catch(() => undefined);
            throw error;
        }
    }
    static async removePhoto(employeeId, actor) {
        if (employeeId !== actor.id && !actor.permissions.includes('employees.manage')) {
            throw ApiError.forbidden('You cannot change this profile photo.');
        }
        const previous = await queryOne('SELECT photo_url FROM employees WHERE id = ?', [employeeId]);
        if (!previous)
            throw ApiError.notFound('Employee not found');
        await execute('UPDATE employees SET photo_url = NULL WHERE id = ?', [employeeId]);
        const oldId = Number(previous.photo_url?.match(AVATAR_URL)?.[1] ?? 0);
        if (oldId)
            await FileService.removeOwnedPublicFile(oldId, employeeId);
        await recordAudit({
            actorId: actor.id,
            action: 'employee.photo_removed',
            entityType: 'employee',
            entityId: employeeId,
            before: { photoUrl: previous.photo_url },
        });
        return { photoUrl: null };
    }
}
//# sourceMappingURL=ProfilePhotoService.js.map