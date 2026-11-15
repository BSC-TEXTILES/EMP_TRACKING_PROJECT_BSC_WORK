import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { FileService } from '../services/FileService.js';

/** Generated, non-guessable file names inside the configured upload directory. */
export const fileStorage = multer.diskStorage({
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
