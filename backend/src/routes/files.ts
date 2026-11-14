import { inspectUpload } from '../lib/uploadSecurity.js';
import { recordAudit } from '../lib/audit.js';
import { rateLimit } from '../middleware/security.js';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { ApiError, asyncHandler, intParam } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { FileService } from '../services/FileService.js';
import type { AuthedRequest } from '../middleware/auth.js';

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await FileService.ensureStorage();
      cb(null, FileService.uploadRoot());
    } catch (error) {
      cb(error as Error, FileService.uploadRoot());
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    try {
      FileService.validate(file.originalname, file.mimetype, 0);
      cb(null, true);
    } catch (error) {
      cb(error as Error);
    }
  },
});

export const filesRouter = Router();
filesRouter.use(authenticate);

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
    try {
      FileService.validate(file.originalname, file.mimetype, file.size);
      await inspectUpload(file.path, file.originalname, file.mimetype);
      id = await FileService.register(user.id, {
      storageKey: path.basename(file.path),
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    });
      await recordAudit({ actorId: user.id, action: 'file.scan.clean', entityType: 'file', entityId: id });
    } catch (error) {
      await fs.unlink(file.path).catch(() => undefined);
      await recordAudit({ actorId: user.id, action: 'file.scan.rejected', entityType: 'file', after: { code: error instanceof ApiError ? error.code : 'upload_failed' } });
      throw error;
    }
    res.status(201).json({
      id,
      name: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url: `/api/files/${id}`,
    });
  }),
);

filesRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const file = await FileService.getForUser(id, user);
    const absolute = FileService.absolutePath(file.storage_key);
    try {
      await fs.access(absolute);
    } catch {
      throw ApiError.notFound('File is no longer available on disk');
    }
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
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
