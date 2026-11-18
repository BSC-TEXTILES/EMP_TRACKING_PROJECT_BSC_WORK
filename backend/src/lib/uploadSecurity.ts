import net from 'node:net';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { ApiError } from './http.js';

const ZIP_SIGNATURES = [0x04034b50, 0x06054b50, 0x08074b50];
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ARCHIVE_EXTS = new Set(['zip', 'docx', 'xlsx', 'pptx']);
const OLE_EXTS = new Set(['doc', 'xls', 'ppt']);
const TEXT_EXTS = new Set(['txt', 'csv']);

function scannerUnavailable(): ApiError {
  return new ApiError(503, 'File scanning is unavailable. Try again later.', 'scanner_unavailable');
}

export type UploadVerdict = 'clean' | 'validated';

/** True when a ClamAV daemon is configured for this server. */
export function scannerConfigured(): boolean {
  return Boolean(process.env.CLAMAV_HOST?.trim());
}

/**
 * UPLOAD_SCAN_MODE:
 *  - "required": every upload must pass ClamAV; without a scanner uploads are refused.
 *  - "when_available" (default): files are always content-verified (signature, Office
 *    structure, text checks, executable block-list) and additionally virus-scanned when
 *    CLAMAV_HOST is set. Without a scanner they are stored as "validated".
 * A configured scanner that is down still fails closed: it never counts as clean.
 */
export function scanMode(): 'required' | 'when_available' {
  return process.env.UPLOAD_SCAN_MODE?.trim().toLowerCase() === 'required' ? 'required' : 'when_available';
}

/** A scanner failure must never be treated as a clean verdict. */
function finishAvailable(finish: (error?: Error) => void): void {
  finish(scannerUnavailable());
}

/** INSTREAM avoids granting the scanner filesystem access to application storage. */
export function scanBuffer(data: Buffer, host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT || 3310)): Promise<void> {
  if (!host) return Promise.reject(scannerUnavailable());
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = '';
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const deadline = setTimeout(() => finishAvailable(finish), 30000);
    socket.on('error', () => finishAvailable(finish));
    socket.on('end', () => { if (!finished) finishAvailable(finish); });
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      if (reply.length > 4096) return finishAvailable(finish);
      if (!reply.includes('\0') && !reply.includes('\n')) return;
      const line = reply.split(/[\0\n]/)[0];
      if (line === 'stream: OK') finish();
      else if (line.endsWith(' FOUND')) finish(new ApiError(422, 'The file was rejected by security scanning.', 'malware_detected'));
      else finishAvailable(finish);
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

/** Streams a file from disk to ClamAV without loading it into memory. */
export function scanFile(
  filePath: string,
  host = process.env.CLAMAV_HOST,
  port = Number(process.env.CLAMAV_PORT || 3310),
): Promise<void> {
  if (!host) {
    // Explicit local-development escape hatch only; production must never
    // accept unscanned bytes silently.
    if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_UNSCANNED_UPLOADS === 'true') return Promise.resolve();
    return Promise.reject(scannerUnavailable());
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = '';
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const deadline = setTimeout(() => finishAvailable(finish), 120000);
    socket.on('error', () => finishAvailable(finish));
    socket.on('end', () => { if (!finished) finishAvailable(finish); });
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      if (reply.length > 4096) return finishAvailable(finish);
      if (!reply.includes('\0') && !reply.includes('\n')) return;
      const line = reply.split(/[\0\n]/)[0];
      if (line === 'stream: OK') finish();
      else if (line.endsWith(' FOUND')) finish(new ApiError(422, 'The file was rejected by security scanning.', 'malware_detected'));
      else finishAvailable(finish);
    });
    socket.on('connect', async () => {
      try {
        socket.write('zINSTREAM\0');
        for await (const raw of createReadStream(filePath, { highWaterMark: 65536 })) {
          if (finished) return;
          const chunk = raw as Buffer;
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          const lengthWritten = socket.write(length);
          const chunkWritten = socket.write(chunk);
          if (!lengthWritten || !chunkWritten) await once(socket, 'drain');
        }
        socket.write(Buffer.alloc(4));
      } catch (error) {
        finish(error instanceof Error ? error : new ApiError(500, 'File scan failed'));
      }
    });
  });
}

async function readHead(filePath: string, size = 65536): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function assertZipSignature(head: Buffer): void {
  if (head.length < 4) throw ApiError.badRequest('Archive is empty or truncated.');
  const signature = head.readUInt32LE(0);
  if (!ZIP_SIGNATURES.includes(signature)) {
    throw ApiError.badRequest('File content does not match its declared type.');
  }
}

function assertOleSignature(head: Buffer): void {
  if (head.length < OLE_SIGNATURE.length || !head.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)) {
    throw ApiError.badRequest('File content does not match its declared type.');
  }
}

/** Reads the bounded central directory of a ZIP container and returns entry names. */
async function zipEntryNames(filePath: string, size: number): Promise<string[]> {
  if (size < 22) throw ApiError.badRequest('Archive is truncated.');
  const tailLength = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLength);
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.read(tail, 0, tailLength, size - tailLength);
  } finally {
    await handle.close();
  }

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw ApiError.badRequest('Archive directory is missing.');

  const entryCount = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  // ZIP64 archives use sentinel values here. The signature already passed; a
  // bounded entry-name check is not required for generic ZIP downloads.
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) return [];
  if (entryCount === 0) throw ApiError.badRequest('Archive is empty.');
  if (directorySize > 8 * 1024 * 1024 || directoryOffset + directorySize > size) {
    throw ApiError.badRequest('Archive directory is invalid.');
  }

  const directory = Buffer.alloc(directorySize);
  const reader = await fs.open(filePath, 'r');
  try {
    await reader.read(directory, 0, directorySize, directoryOffset);
  } finally {
    await reader.close();
  }

  const names: string[] = [];
  let offset = 0;
  while (offset + 46 <= directory.length) {
    if (directory.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const start = offset + 46;
    const end = start + nameLength;
    if (end > directory.length) throw ApiError.badRequest('Archive directory is invalid.');
    const name = directory.subarray(start, end).toString('utf8');
    if (name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) {
      throw ApiError.badRequest('Archive contains an unsafe path.');
    }
    names.push(name);
    offset = end + extraLength + commentLength;
  }
  return names;
}

async function validateTextContent(filePath: string): Promise<void> {
  let total = 0;
  let controls = 0;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let replacements = 0;
  for await (const raw of createReadStream(filePath, { highWaterMark: 65536 })) {
    const chunk = raw as Buffer;
    if (chunk.includes(0)) throw ApiError.badRequest('File content does not match its declared type.');
    total += chunk.length;
    const text = decoder.decode(chunk, { stream: true });
    replacements += (text.match(/\uFFFD/g) ?? []).length;
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls += 1;
    }
  }
  const tail = decoder.decode();
  replacements += (tail.match(/\uFFFD/g) ?? []).length;
  // Reject binary content but accept legacy (e.g. cp1252) spreadsheet exports.
  if (total > 0 && controls / total > 0.01) {
    throw ApiError.badRequest('File content does not match its declared type.');
  }
  if (total > 0 && replacements / total > 0.02) {
    throw ApiError.badRequest('Text attachments must contain readable text.');
  }
}

export async function inspectUpload(filePath: string, originalName: string, mimeType: string): Promise<UploadVerdict> {
  const ext = path.extname(originalName).toLowerCase().slice(1);
  const stat = await fs.stat(filePath);
  if (stat.size === 0) throw ApiError.badRequest('The uploaded file is empty.');
  const head = await readHead(filePath);

  if (TEXT_EXTS.has(ext)) {
    const expected = ext === 'txt' ? 'text/plain' : 'text/csv';
    const compatible = mimeType === expected || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/octet-stream';
    if (!compatible) throw ApiError.badRequest('File content does not match its declared type.');
    await validateTextContent(filePath);
  } else if (ARCHIVE_EXTS.has(ext)) {
    assertZipSignature(head);
    const names = await zipEntryNames(filePath, stat.size);
    if (ext !== 'zip') {
      if (!names.includes('[Content_Types].xml')) {
        throw ApiError.badRequest('The Office document is not a valid Open XML package.');
      }
      const prefix = ext === 'docx' ? 'word/' : ext === 'xlsx' ? 'xl/' : 'ppt/';
      if (!names.some((name) => name.startsWith(prefix))) {
        throw ApiError.badRequest('The Office document does not contain the expected content.');
      }
    }
  } else if (OLE_EXTS.has(ext)) {
    assertOleSignature(head);
  } else {
    let detected;
    try {
      detected = await fileTypeFromBuffer(head);
    } catch {
      throw ApiError.badRequest('Invalid file content.');
    }
    const canonicalExt = ext === 'jpeg' ? 'jpg' : ext;
    const compatibleMime = detected?.mime === mimeType
      || (mimeType === 'application/octet-stream' && detected?.ext === canonicalExt)
      || (ext === 'webm' && mimeType === 'audio/webm' && detected?.mime === 'video/webm');
    if (!detected || detected.ext !== canonicalExt || !compatibleMime) {
      throw ApiError.badRequest('File content does not match its declared type.');
    }
  }

  if (scannerConfigured()) {
    await scanFile(filePath);
    return 'clean';
  }
  if (scanMode() === 'required') {
    throw new ApiError(503, 'File uploads are disabled until the virus scanner (ClamAV) is configured on the server.', 'scanner_unavailable');
  }
  return 'validated';
}
