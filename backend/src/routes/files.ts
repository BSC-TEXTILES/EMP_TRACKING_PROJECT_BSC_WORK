import express, { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { inspectUpload } from '../lib/uploadSecurity.js';
import { recordAudit } from '../lib/audit.js';
import { rateLimit } from '../middleware/security.js';
import { config } from '../config.js';
import { execute } from '../db/index.js';
import { ApiError, asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { FileService, contentDisposition } from '../services/FileService.js';
import { fileStorage } from '../lib/uploadStorage.js';
import type { AuthedRequest } from '../middleware/auth.js';

const upload = multer({
  storage: fileStorage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    try {
      // Size is checked again after the bytes are written.
      FileService.validate(file.originalname, file.mimetype, 1);
      cb(null, true);
    } catch (error) {
      cb(error as Error);
    }
  },
});

export const filesRouter = Router();
filesRouter.use(authenticate);

function fileResponse(file: { id: number; name: string; mimeType: string; size: number; sha256?: string | null }) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256 ?? null,
    url: `/api/files/${file.id}`,
    downloadUrl: `/api/files/${file.id}?download=1`,
  };
}

// ------------------------------ Single upload ------------------------------

filesRouter.post(
  '/upload',
  rateLimit({ windowMs: 60000, max: 15, keyPrefix: 'uploads' }),
  (req, res, next) => {
    upload.single('file')(req, res, (error) => {
      if (error) {
        next(ApiError.badRequest(error instanceof Error ? error.message : 'Upload failed'));
        return;
      }
      next();
    });
  },
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const file = req.file;
    if (!file) throw ApiError.badRequest('No file received.');
    let id: number;
    let checksum: string;
    try {
      FileService.validate(file.originalname, file.mimetype, file.size);
      await inspectUpload(file.path, file.originalname, file.mimetype);
      checksum = await FileService.sha256File(file.path);
      // The browser sends the checksum it computed before uploading. Comparing
      // it with the bytes actually stored proves the transfer was not altered.
      const declared = await FileService.isValidSha256(String(req.body?.sha256 ?? '').trim() || undefined);
      if (declared && declared !== checksum) {
        throw ApiError.badRequest('Integrity check failed: the file checksum does not match the uploaded bytes.');
      }
      id = await FileService.register(user.id, {
        storageKey: path.basename(file.path),
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        sha256: checksum,
      });
      await recordAudit({ actorId: user.id, action: 'file.scan.clean', entityType: 'file', entityId: id });
    } catch (error) {
      await fs.unlink(file.path).catch(() => undefined);
      await recordAudit({
        actorId: user.id,
        action: 'file.scan.rejected',
        entityType: 'file',
        after: { code: error instanceof ApiError ? error.code : 'upload_failed' },
      });
      throw error;
    }
    res.status(201).json(
      fileResponse({ id, name: file.originalname, mimeType: file.mimetype, size: file.size, sha256: checksum }),
    );
  }),
);

// --------------------------- Resumable uploads -----------------------------

filesRouter.post(
  '/chunked/start',
  rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'upload-start' }),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        name: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(160),
        size: z.number().int().positive(),
        sha256: z.string().length(64).optional(),
      }),
      req.body,
    );
    const sha256 = await FileService.isValidSha256(body.sha256);
    const session = await FileService.createSession(user.id, {
      originalName: body.name,
      mimeType: body.mimeType,
      size: body.size,
    });
    if (sha256) {
      await execute('UPDATE upload_sessions SET sha256 = ? WHERE id = ?', [sha256, session.uploadId]);
    }
    res.status(201).json({ ...session, maxChunkedUploadMb: config.maxChunkedUploadMb });
  }),
);

filesRouter.get(
  '/chunked/:uploadId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(await FileService.sessionStatus(String(req.params.uploadId), user.id));
  }),
);

filesRouter.put(
  '/chunked/:uploadId/chunk/:index',
  rateLimit({ windowMs: 60000, max: 600, keyPrefix: 'upload-chunk' }),
  express.raw({ type: () => true, limit: config.chunkSizeMb * 1024 * 1024 + 1024 * 1024 }),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const index = Number.parseInt(String(req.params.index), 10);
    if (!Buffer.isBuffer(req.body)) throw ApiError.badRequest('Chunk body must be raw binary data.');
    const result = await FileService.writeChunk(String(req.params.uploadId), user.id, index, req.body);
    res.json(result);
  }),
);

filesRouter.post(
  '/chunked/:uploadId/complete',
  rateLimit({ windowMs: 60000, max: 60, keyPrefix: 'upload-complete' }),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ sha256: z.string().length(64).optional() }), req.body ?? {});
    const result = await FileService.completeSession(String(req.params.uploadId), user, body.sha256);
    await recordAudit({ actorId: user.id, action: 'file.scan.clean', entityType: 'file', entityId: result.id });
    res.status(201).json(fileResponse(result));
  }),
);

filesRouter.delete(
  '/chunked/:uploadId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    await FileService.abortSession(String(req.params.uploadId), user.id);
    res.json({ ok: true });
  }),
);

// -------------------------------- Download ---------------------------------

filesRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    let file;
    try {
      file = await FileService.getForUser(id, user);
    } catch {
      if (req.query.v || req.headers.accept?.includes('image/')) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e2e8f0"/><circle cx="32" cy="24" r="12" fill="#94a3b8"/><path d="M16 52 C16 40 48 40 48 52 Z" fill="#94a3b8"/></svg>');
        return;
      }
      throw ApiError.notFound('File not found');
    }

    const absolute = FileService.absolutePath(file.storage_key);
    try {
      await fs.access(absolute);
    } catch {
      if (file.mime_type.startsWith('image/') || req.query.v) {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e2e8f0"/><circle cx="32" cy="24" r="12" fill="#94a3b8"/><path d="M16 52 C16 40 48 40 48 52 Z" fill="#94a3b8"/></svg>');
        return;
      }
      throw ApiError.notFound('File is no longer available on disk');
    }
    const inlineImage = file.mime_type.startsWith('image/') && req.query.download !== '1';
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', contentDisposition(file.original_name, inlineImage));
    res.setHeader('Cache-Control', Number(file.is_private) === 0 ? 'private, max-age=3600' : 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.sha256) {
      res.setHeader('ETag', `"${file.sha256}"`);
      res.setHeader('Digest', `sha-256=${Buffer.from(file.sha256, 'hex').toString('base64')}`);
    }
    res.sendFile(absolute);
  }),
);

filesRouter.delete(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    await FileService.removeFile(id, currentUser(req));
    res.json({ ok: true });
  }),
);
