import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { asyncHandler } from '../lib/http.js';
export const publicDownloadsRouter = Router();
const APK_MIME_TYPE = 'application/vnd.android.package-archive';
const APK_FILES = {
    release: {
        filename: 'bsc-hrms-release.apk',
        label: 'BSC Textiles HRMS (Production Release)',
        path: path.resolve(config.publicDownloadsDir ?? path.join(process.cwd(), 'frontend/public/downloads'), 'bsc-hrms-release.apk'),
        size: 0,
    },
    debug: {
        filename: 'bsc-hrms-debug.apk',
        label: 'BSC Textiles HRMS (Debug Build)',
        path: path.resolve(config.publicDownloadsDir ?? path.join(process.cwd(), 'frontend/public/downloads'), 'bsc-hrms-debug.apk'),
        size: 0,
    },
};
// Initialize file sizes
for (const key of Object.keys(APK_FILES)) {
    try {
        const stats = await fs.stat(APK_FILES[key].path);
        APK_FILES[key].size = stats.size;
    }
    catch {
        APK_FILES[key].size = 0;
    }
}
publicDownloadsRouter.get('/apk/:variant', asyncHandler(async (req, res) => {
    const variant = req.params.variant;
    const apk = APK_FILES[variant];
    if (!apk) {
        res.status(404).json({ error: 'APK variant not found', code: 'not_found' });
        return;
    }
    if (apk.size === 0) {
        res.status(503).json({ error: 'APK file not available', code: 'unavailable' });
        return;
    }
    try {
        await fs.access(apk.path);
    }
    catch {
        res.status(503).json({ error: 'APK file not found on disk', code: 'unavailable' });
        return;
    }
    // Set correct headers for Android APK download
    res.setHeader('Content-Type', APK_MIME_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${apk.filename}"`);
    res.setHeader('Content-Length', apk.size.toString());
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    // Support range requests for large file downloads
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : apk.size - 1;
        const chunkSize = end - start + 1;
        if (start >= 0 && end < apk.size && chunkSize > 0) {
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${apk.size}`);
            res.setHeader('Content-Length', chunkSize.toString());
            const fileHandle = await fs.open(apk.path, 'r');
            const stream = fileHandle.createReadStream({ start, end });
            stream.pipe(res);
            stream.on('error', () => {
                fileHandle.close().catch(() => undefined);
            });
            stream.on('end', () => {
                fileHandle.close().catch(() => undefined);
            });
            return;
        }
    }
    res.sendFile(apk.path);
}));
// Info endpoint to check APK availability
publicDownloadsRouter.get('/apk/info', asyncHandler(async (req, res) => {
    res.json({
        release: {
            filename: APK_FILES.release.filename,
            label: APK_FILES.release.label,
            size: APK_FILES.release.size,
            available: APK_FILES.release.size > 0,
        },
        debug: {
            filename: APK_FILES.debug.filename,
            label: APK_FILES.debug.label,
            size: APK_FILES.debug.size,
            available: APK_FILES.debug.size > 0,
        },
    });
}));
//# sourceMappingURL=publicDownloads.js.map