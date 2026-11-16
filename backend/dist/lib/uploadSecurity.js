import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { ApiError } from './http.js';
/** INSTREAM avoids granting the scanner filesystem access to application storage. */
export function scanBuffer(data, host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT || 3310)) {
    if (!host) {
        // ClamAV scanner is not configured; file type and extension checks passed.
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        let reply = '';
        let finished = false;
        const finish = (error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(deadline);
            socket.destroy();
            if (error)
                reject(error);
            else
                resolve();
        };
        const unavailable = () => {
            // If ClamAV daemon is unreachable on cloud host, do not block users unless strict mode is set
            if (process.env.STRICT_MALWARE_SCAN === 'true') {
                finish(new ApiError(503, 'File scanning is unavailable. Try again later.', 'scanner_unavailable'));
            }
            else {
                finish();
            }
        };
        const deadline = setTimeout(unavailable, 30000);
        socket.on('error', unavailable);
        socket.on('end', () => { if (!finished)
            unavailable(); });
        socket.on('data', (chunk) => {
            reply += chunk.toString('utf8');
            if (reply.length > 4096)
                return unavailable();
            if (!reply.includes('\0') && !reply.includes('\n'))
                return;
            const line = reply.split(/[\0\n]/)[0];
            if (line === 'stream: OK')
                finish();
            else if (line.endsWith(' FOUND'))
                finish(new ApiError(422, 'The file was rejected by security scanning.', 'malware_detected'));
            else
                unavailable();
        });
        socket.on('connect', () => {
            socket.write('zINSTREAM\0');
            for (let offset = 0; offset < data.length; offset += 65536) {
                const chunk = data.subarray(offset, offset + 65536);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(chunk.length);
                socket.write(length);
                socket.write(chunk);
            }
            socket.write(Buffer.alloc(4));
        });
    });
}
export async function inspectUpload(filePath, originalName, mimeType) {
    const data = await fs.readFile(filePath);
    const ext = path.extname(originalName).toLowerCase().slice(1);
    // Generic archives and legacy containers remain blocked until a bounded archive
    // inspection policy is implemented. Never accept them on extension alone.
    if (['zip', 'doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx'].includes(ext)) {
        throw ApiError.badRequest('Archive and Office attachments are currently disabled. Export the document as PDF.');
    }
    if (['txt', 'csv'].includes(ext)) {
        if (mimeType !== (ext === 'txt' ? 'text/plain' : 'text/csv') || data.includes(0))
            throw ApiError.badRequest('File content does not match its declared type.');
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(data);
        }
        catch {
            throw ApiError.badRequest('Text attachments must use UTF-8 encoding.');
        }
    }
    else {
        let detected;
        try {
            detected = await fileTypeFromBuffer(data);
        }
        catch {
            throw ApiError.badRequest('Invalid file content.');
        }
        const canonicalExt = ext === 'jpeg' ? 'jpg' : ext;
        const compatibleMime = detected?.mime === mimeType || (ext === 'webm' && mimeType === 'audio/webm' && detected?.mime === 'video/webm');
        if (!detected || detected.ext !== canonicalExt || !compatibleMime)
            throw ApiError.badRequest('File content does not match its declared type.');
    }
    await scanBuffer(data);
}
//# sourceMappingURL=uploadSecurity.js.map