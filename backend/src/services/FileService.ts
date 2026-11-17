import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { config } from '../config.js';
import { execute, query, queryOne, transaction } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { inspectUpload } from '../lib/uploadSecurity.js';
import type { AuthUser } from './AuthService.js';

/**
 * Extension → accepted MIME types.
 *
 * Browsers do not agree on the MIME type they send for Office files, CSV and
 * some media containers (Windows commonly reports `application/octet-stream`).
 * The extension list below is the allowlist; the MIME list only narrows it, and
 * the authoritative check is always the byte-signature inspection performed by
 * `inspectUpload` before a file row is created.
 */
const EXTENSION_MIME: Record<string, string[]> = {
  '.png': ['image/png'],
  '.jpg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  '.jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  '.webp': ['image/webp'],
  '.gif': ['image/gif'],
  '.pdf': ['application/pdf', 'application/x-pdf', 'application/acrobat', 'application/vnd.pdf', 'text/pdf', 'text/x-pdf'],
  '.txt': ['text/plain', 'text/csv'],
  '.csv': ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.doc': ['application/msword', 'application/vnd.ms-word', 'application/x-msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  '.xls': ['application/vnd.ms-excel', 'application/msexcel', 'application/x-msexcel', 'application/x-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  '.ppt': ['application/vnd.ms-powerpoint', 'application/mspowerpoint', 'application/powerpoint', 'application/x-mspowerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'],
  '.zip': ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip'],
  '.webm': ['video/webm', 'audio/webm'],
  '.ogg': ['audio/ogg', 'application/ogg', 'video/ogg'],
  '.mp3': ['audio/mpeg', 'audio/mp3', 'audio/x-mpeg', 'audio/x-mp3'],
  '.m4a': ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
  '.wav': ['audio/wav', 'audio/x-wav', 'audio/wave'],
  '.mp4': ['video/mp4', 'application/mp4'],
  '.m4v': ['video/x-m4v', 'video/mp4'],
};

const GENERIC_MIME = new Set(['application/octet-stream', 'binary/octet-stream', '']);

const SAFE_EXT = new Set(Object.keys(EXTENSION_MIME));

const DANGEROUS_NAME = /\.(exe|bat|cmd|com|scr|pif|msi|dll|sh|bash|ps1|php|jsp|asp|aspx|cgi|js|mjs|vbs|wsf|hta|jar)(?:\.|$)/i;

/** Filenames are display metadata only; storage names are always generated. */
export function sanitizeFilename(original: string): string {
  const base = path.basename(String(original ?? '').replace(/\\/g, '/'));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 200);
  return cleaned || 'file';
}

/** RFC 5987/6266 Content-Disposition with an ASCII fallback for old clients. */
export function contentDisposition(filename: string, inline: boolean): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface FileRow {
  id: number;
  owner_id: number | null;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  is_private: number;
  sha256?: string | null;
}

export interface UploadSessionRow {
  id: string;
  employee_id: number;
  original_name: string;
  mime_type: string;
  expected_size: number;
  received_bytes: number;
  chunk_size: number;
  total_chunks: number;
  received_chunks: string | null;
  status: 'uploading' | 'completed' | 'aborted' | 'expired';
  sha256: string | null;
  storage_key: string | null;
  expires_at: string;
}

export class FileService {
  static uploadRoot(): string {
    return path.isAbsolute(config.uploadDir) ? config.uploadDir : path.resolve(process.cwd(), config.uploadDir);
  }

  static chunkRoot(): string {
    return path.join(FileService.uploadRoot(), '.chunks');
  }

  static async ensureStorage(): Promise<void> {
    await fs.mkdir(FileService.uploadRoot(), { recursive: true });
    await fs.mkdir(FileService.chunkRoot(), { recursive: true });
  }

  static maxBytes(chunked = false): number {
    return (chunked ? config.maxChunkedUploadMb : config.maxUploadMb) * 1024 * 1024;
  }

  static chunkBytes(): number {
    return config.chunkSizeMb * 1024 * 1024;
  }

  /**
   * Validates an upload against the extension allowlist before any bytes are
   * written. The MIME check is deliberately tolerant of browser variants;
   * `inspectUpload` verifies the real content afterwards.
   */
  static validate(originalName: string, mimeType: string, size: number, options: { chunked?: boolean } = {}): void {
    const name = String(originalName ?? '');
    if (DANGEROUS_NAME.test(name)) throw ApiError.badRequest('Executable files are not permitted.');
    const ext = path.extname(path.basename(name)).toLowerCase();
    if (!SAFE_EXT.has(ext)) {
      throw ApiError.badRequest('Unsupported file type. Upload images, PDFs, Office documents, archives, audio or video.');
    }
    const normalized = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
    if (!GENERIC_MIME.has(normalized) && !EXTENSION_MIME[ext].includes(normalized)) {
      throw ApiError.badRequest(`The file type "${normalized}" does not match the .${ext.slice(1)} extension.`);
    }
    if (!Number.isFinite(size) || size <= 0) throw ApiError.badRequest('The uploaded file is empty.');
    const max = FileService.maxBytes(options.chunked);
    if (size > max) {
      const limit = options.chunked ? `${config.maxChunkedUploadMb}MB` : `${config.maxUploadMb}MB`;
      throw ApiError.badRequest(`File exceeds the ${limit} limit.`);
    }
  }

  static async isValidSha256(value: string | undefined | null): Promise<string | null> {
    if (!value) return null;
    const digest = String(value).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw ApiError.badRequest('Invalid checksum supplied.');
    return digest;
  }

  static async sha256File(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await pipeline(createReadStream(filePath), hash);
    return hash.digest('hex');
  }

  static async register(
    ownerId: number,
    input: { storageKey: string; originalName: string; mimeType: string; size: number; isPrivate?: boolean; scanStatus?: 'clean' | 'validated'; sha256?: string | null },
  ): Promise<number> {
    const result = await execute(
      'INSERT INTO files (owner_id, storage_key, original_name, mime_type, size_bytes, is_private, scan_status, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        ownerId,
        input.storageKey,
        sanitizeFilename(input.originalName),
        input.mimeType,
        input.size,
        input.isPrivate === false ? 0 : 1,
        input.scanStatus ?? 'clean',
        input.sha256 ?? null,
      ],
    );
    return result.insertId;
  }

  /**
   * Private attachment access: owner, an employee with file administration, or
   * someone linked to the owning task, report, ticket or conversation. Message
   * attachments therefore inherit the conversation's membership rules.
   */
  static async getForUser(fileId: number, user: AuthUser): Promise<FileRow> {
    const file = await queryOne<FileRow>(
      "SELECT id, owner_id, storage_key, original_name, mime_type, size_bytes, is_private, sha256 FROM files WHERE id = ? AND (scan_status = 'clean' OR (scan_status = 'validated' AND is_private = 0))",
      [fileId],
    );
    if (!file) throw ApiError.notFound('File not found');
    // Public images (profile photos) may be viewed by any signed-in employee.
    if (Number(file.is_private) === 0) return file;
    if (Number(file.owner_id) === user.id) return file;

    const [taskLink, reportLink, ticketLink, messageLink, mailLink] = await Promise.all([
      queryOne<{ id: number }>(
        `SELECT ta.id FROM task_attachments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.file_id = ? AND (t.created_by = ? OR t.manager_id = ?
           OR EXISTS (SELECT 1 FROM task_assignments x WHERE x.task_id = t.id AND x.employee_id = ?)) LIMIT 1`,
        [fileId, user.id, user.id, user.id],
      ),
      queryOne<{ id: number }>(
        `SELECT ra.id FROM daily_report_attachments ra JOIN daily_work_reports r ON r.id = ra.report_id
         WHERE ra.file_id = ? AND (r.employee_id = ? OR r.reviewed_by = ?) LIMIT 1`,
        [fileId, user.id, user.id],
      ),
      queryOne<{ id: number }>(
        `SELECT x.id FROM ticket_attachments x JOIN tickets t ON t.id = x.ticket_id
         WHERE x.file_id = ? AND (t.requester_id = ? OR t.assignee_id = ?) LIMIT 1`,
        [fileId, user.id, user.id],
      ),
      queryOne<{ id: number }>(
        `SELECT x.id FROM message_attachments x JOIN messages m ON m.id = x.message_id
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.employee_id = ?
         WHERE x.file_id = ? LIMIT 1`,
        [user.id, fileId],
      ),
      // Files attached to an internal (mailbox) email: its sender and recipient may download them.
      queryOne<{ id: number }>(
        `SELECT e.id FROM internal_emails e
         WHERE (e.sender_id = ? OR e.recipient_id = ?) AND e.attachments IS NOT NULL
           AND JSON_CONTAINS(e.attachments, JSON_OBJECT('fileId', ?)) LIMIT 1`,
        [user.id, user.id, fileId],
      ).catch(() => null),
    ]);
    if (taskLink || reportLink || ticketLink || messageLink || mailLink) return file;
    throw ApiError.forbidden('You do not have access to this file.');
  }

  static absolutePath(storageKey: string): string {
    const root = FileService.uploadRoot();
    const resolved = path.resolve(root, storageKey);
    if (resolved !== root && !resolved.startsWith(path.resolve(root) + path.sep)) {
      throw ApiError.forbidden('Invalid file path');
    }
    return resolved;
  }

  /** Removes a profile image owned by the employee, including its bytes and row. */
  static async removeOwnedPublicFile(fileId: number, ownerId: number): Promise<void> {
    const file = await queryOne<{ storage_key: string }>('SELECT storage_key FROM files WHERE id = ? AND owner_id = ? AND is_private = 0', [fileId, ownerId]);
    if (!file) return;
    await fs.unlink(FileService.absolutePath(file.storage_key)).catch(() => undefined);
    await execute('DELETE FROM files WHERE id = ?', [fileId]);
  }

  static async removeFile(fileId: number, user: AuthUser): Promise<void> {
    const file = await FileService.getForUser(fileId, user);
    if (Number(file.owner_id) !== user.id && !user.permissions.includes('employees.manage')) {
      throw ApiError.forbidden('You cannot delete this file.');
    }
    await fs.unlink(FileService.absolutePath(file.storage_key)).catch(() => undefined);
    await execute('DELETE FROM files WHERE id = ?', [fileId]);
  }

  static async stats(): Promise<{ files: number; bytes: number }> {
    const row = await queryOne<{ files: number; bytes: number }>('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM files');
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  // --------------------------- Chunked uploads -----------------------------

  static sessionDir(uploadId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw ApiError.badRequest('Invalid upload session.');
    return path.join(FileService.chunkRoot(), uploadId);
  }

  static chunkPath(uploadId: string, index: number): string {
    return path.join(FileService.sessionDir(uploadId), `${index}.part`);
  }

  static async createSession(
    employeeId: number,
    input: { originalName: string; mimeType: string; size: number },
  ): Promise<{ uploadId: string; chunkSize: number; totalChunks: number; expiresAt: string }> {
    const name = sanitizeFilename(input.originalName);
    const mimeType = String(input.mimeType ?? 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 150) || 'application/octet-stream';
    FileService.validate(name, mimeType, input.size, { chunked: true });

    const chunkSize = FileService.chunkBytes();
    const totalChunks = Math.ceil(input.size / chunkSize);
    if (totalChunks < 1 || totalChunks > 10_000) throw ApiError.badRequest('File is too large to upload.');

    const uploadId = crypto.randomUUID();
    await fs.mkdir(FileService.sessionDir(uploadId), { recursive: true });
    const ttlHours = config.chunkSessionTtlHours;
    await execute(
      `INSERT INTO upload_sessions
         (id, employee_id, original_name, mime_type, expected_size, received_bytes, chunk_size, total_chunks, received_chunks, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, '[]', 'uploading', DATE_ADD(NOW(3), INTERVAL ? HOUR))`,
      [uploadId, employeeId, name, mimeType, input.size, chunkSize, totalChunks, ttlHours],
    );
    return {
      uploadId,
      chunkSize,
      totalChunks,
      expiresAt: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
    };
  }

  static async getSession(uploadId: string, employeeId: number): Promise<UploadSessionRow> {
    const session = await queryOne<UploadSessionRow>(
      `SELECT id, employee_id, original_name, mime_type, expected_size, received_bytes, chunk_size, total_chunks,
              received_chunks, status, sha256, storage_key, expires_at
       FROM upload_sessions WHERE id = ?`,
      [uploadId],
    );
    if (!session) throw ApiError.notFound('Upload session not found');
    if (Number(session.employee_id) !== employeeId) throw ApiError.forbidden('This upload belongs to another employee.');
    return session;
  }

  private static async chunkIndexes(uploadId: string): Promise<number[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(FileService.sessionDir(uploadId));
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith('.part'))
      .map((name) => Number.parseInt(name, 10))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
  }

  private static async chunkTotalBytes(uploadId: string): Promise<number> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(FileService.sessionDir(uploadId));
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of entries) {
      if (!name.endsWith('.part')) continue;
      const stat = await fs.stat(path.join(FileService.sessionDir(uploadId), name)).catch(() => null);
      if (stat) total += stat.size;
    }
    return total;
  }

  static async writeChunk(
    uploadId: string,
    employeeId: number,
    index: number,
    data: Buffer,
  ): Promise<{ receivedChunks: number; totalChunks: number; receivedBytes: number }> {
    const session = await FileService.getSession(uploadId, employeeId);
    if (session.status !== 'uploading') throw ApiError.conflict('This upload session is no longer active.', { status: session.status });
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await execute("UPDATE upload_sessions SET status = 'expired' WHERE id = ?", [uploadId]);
      throw ApiError.conflict('This upload session has expired. Start the upload again.', { status: 'expired' });
    }
    const totalChunks = Number(session.total_chunks);
    const chunkSize = Number(session.chunk_size);
    if (!Number.isInteger(index) || index < 0 || index >= totalChunks) throw ApiError.badRequest('Invalid chunk index.');
    if (!data || data.length === 0) throw ApiError.badRequest('Empty chunk.');
    if (data.length > chunkSize) throw ApiError.badRequest('Chunk is larger than the negotiated size.');

    // Refuse chunks that would push the staged file beyond its declared size.
    const previousBytes = await FileService.chunkTotalBytes(uploadId);
    const previousChunkSize = await fs.stat(FileService.chunkPath(uploadId, index)).then((s) => s.size).catch(() => 0);
    if (previousBytes - previousChunkSize + data.length > Number(session.expected_size)) {
      throw ApiError.badRequest('Uploaded data exceeds the declared file size.');
    }

    const target = FileService.chunkPath(uploadId, index);
    const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, target);

    const indexes = await FileService.chunkIndexes(uploadId);
    const receivedBytes = await FileService.chunkTotalBytes(uploadId);
    await execute(
      'UPDATE upload_sessions SET received_bytes = ?, received_chunks = ? WHERE id = ?',
      [receivedBytes, JSON.stringify(indexes), uploadId],
    );
    return { receivedChunks: indexes.length, totalChunks, receivedBytes };
  }

  static async sessionStatus(uploadId: string, employeeId: number) {
    const session = await FileService.getSession(uploadId, employeeId);
    const indexes = await FileService.chunkIndexes(uploadId);
    return {
      uploadId,
      name: session.original_name,
      mimeType: session.mime_type,
      size: Number(session.expected_size),
      chunkSize: Number(session.chunk_size),
      totalChunks: Number(session.total_chunks),
      uploadedChunks: indexes,
      receivedBytes: Number(session.received_bytes ?? 0),
      status: session.status,
      expiresAt: session.expires_at,
    };
  }

  /**
   * Concatenates all chunks in order, verifies the byte count and optional
   * SHA-256, runs content/signature/malware inspection, then registers the
   * file. The staging directory is removed on both success and failure.
   */
  static async completeSession(
    uploadId: string,
    owner: AuthUser,
    providedSha256?: string | null,
  ): Promise<{ id: number; name: string; mimeType: string; size: number; sha256: string }> {
    const session = await FileService.getSession(uploadId, owner.id);
    if (session.status === 'completed') {
      const existing = await queryOne<FileRow>(
        'SELECT id, original_name, mime_type, size_bytes, sha256 FROM files WHERE owner_id = ? AND storage_key = ?',
        [owner.id, session.storage_key],
      );
      if (existing) {
        return {
          id: Number(existing.id),
          name: existing.original_name,
          mimeType: existing.mime_type,
          size: Number(existing.size_bytes),
          sha256: existing.sha256 ?? '',
        };
      }
      throw ApiError.conflict('This upload session was already completed.', { status: 'completed' });
    }
    if (session.status !== 'uploading') throw ApiError.conflict('This upload session is no longer active.', { status: session.status });

    const indexes = await FileService.chunkIndexes(uploadId);
    const totalChunks = Number(session.total_chunks);
    if (indexes.length !== totalChunks) {
      const missing: number[] = [];
      for (let i = 0; i < totalChunks; i += 1) if (!indexes.includes(i)) missing.push(i);
      throw ApiError.badRequest(`Upload is incomplete: ${missing.length} chunk(s) are missing.`, { missing });
    }

    const digest = await FileService.isValidSha256(providedSha256 ?? session.sha256 ?? undefined);
    const ext = path.extname(session.original_name).toLowerCase();
    const storageKey = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
    const finalPath = FileService.absolutePath(storageKey);

    const output = createWriteStream(finalPath, { flags: 'wx' });
    try {
      for (let i = 0; i < totalChunks; i += 1) {
        await pipeline(createReadStream(FileService.chunkPath(uploadId, i)), output, { end: false });
      }
      await new Promise<void>((resolve, reject) => {
        output.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      output.destroy();
      await fs.unlink(finalPath).catch(() => undefined);
      throw error instanceof ApiError ? error : new ApiError(500, 'The file could not be assembled. Try uploading again.');
    }

    const stat = await fs.stat(finalPath).catch(() => null);
    const bytes = stat?.size ?? 0;
    if (bytes !== Number(session.expected_size)) {
      await fs.unlink(finalPath).catch(() => undefined);
      await execute("UPDATE upload_sessions SET status = 'aborted' WHERE id = ?", [uploadId]);
      throw ApiError.badRequest(`Integrity check failed: expected ${session.expected_size} bytes but received ${bytes}.`);
    }
    const checksum = await FileService.sha256File(finalPath);
    if (digest && digest !== checksum) {
      await fs.unlink(finalPath).catch(() => undefined);
      await execute("UPDATE upload_sessions SET status = 'aborted' WHERE id = ?", [uploadId]);
      throw ApiError.badRequest('Integrity check failed: the file checksum does not match.', { expected: digest, actual: checksum });
    }

    try {
      FileService.validate(session.original_name, session.mime_type, bytes, { chunked: true });
      await inspectUpload(finalPath, session.original_name, session.mime_type);
      const id = await FileService.register(owner.id, {
        storageKey,
        originalName: session.original_name,
        mimeType: session.mime_type,
        size: bytes,
        sha256: checksum,
      });
      await execute("UPDATE upload_sessions SET status = 'completed', received_bytes = ?, sha256 = ?, storage_key = ? WHERE id = ?", [
        bytes,
        checksum,
        storageKey,
        uploadId,
      ]);
      await fs.rm(FileService.sessionDir(uploadId), { recursive: true, force: true }).catch(() => undefined);
      return { id, name: sanitizeFilename(session.original_name), mimeType: session.mime_type, size: bytes, sha256: checksum };
    } catch (error) {
      await fs.unlink(finalPath).catch(() => undefined);
      await execute("UPDATE upload_sessions SET status = 'aborted' WHERE id = ?", [uploadId]);
      throw error;
    }
  }

  static async abortSession(uploadId: string, employeeId: number): Promise<void> {
    const session = await FileService.getSession(uploadId, employeeId);
    if (session.status === 'completed') throw ApiError.conflict('This upload already completed.');
    await execute("UPDATE upload_sessions SET status = 'aborted' WHERE id = ?", [uploadId]);
    await fs.rm(FileService.sessionDir(uploadId), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Housekeeping for abandoned sessions; only staged chunk data is removed. */
  static async cleanupExpiredSessions(): Promise<number> {
    const rows = await query<{ id: string }>(
      "SELECT id FROM upload_sessions WHERE status IN ('uploading','expired') AND expires_at < NOW(3) LIMIT 500",
    );
    for (const row of rows) {
      await fs.rm(FileService.sessionDir(row.id), { recursive: true, force: true }).catch(() => undefined);
    }
    if (rows.length > 0) {
      const ids = rows.map(() => '?').join(',');
      await execute(`UPDATE upload_sessions SET status = 'expired' WHERE id IN (${ids})`, rows.map((r) => r.id));
    }
    return rows.length;
  }
}
