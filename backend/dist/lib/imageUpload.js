import multer from 'multer';
import { fileStorage } from './uploadStorage.js';
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/** Profile pictures: raster images only, capped at 5 MB. */
export const avatarUpload = multer({
    storage: fileStorage,
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
        const extension = `.${file.originalname.split('.').pop()?.toLowerCase() ?? ''}`;
        if (!IMAGE_MIME.has(file.mimetype) || !IMAGE_EXT.has(extension)) {
            cb(new Error('Choose a PNG, JPEG, WebP or GIF image.'));
            return;
        }
        cb(null, true);
    },
});
//# sourceMappingURL=imageUpload.js.map