/**
 * Installer trust and secure-update guards:
 *  - the backend only reports an installer as release-grade when the signed release
 *    pipeline's manifest exists, says "release", passed the gate AND matches the file on disk;
 *  - the agent update download requires a device token;
 *  - SMTP provider throttling is recognised so it never burns delivery retries.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/index.js';
import { createApp } from '../src/index.js';
import { isSmtpRateLimit } from '../src/lib/mailer.js';
import { getInstallerInfo } from '../src/services/tracking/TrackingAgentService.js';

const previous = process.env.TRACKING_AGENT_INSTALLER;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-installer-'));
let n = 0;

function stage(manifest: ((sha: string) => Record<string, unknown>) | null): void {
  const dir = path.join(root, String(++n));
  fs.mkdirSync(dir);
  const bytes = crypto.randomBytes(2048);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = path.join(dir, 'BSC-Activity-Tracker-Setup.exe');
  fs.writeFileSync(file, bytes);
  if (manifest) fs.writeFileSync(path.join(dir, 'release-manifest.json'), '﻿' + JSON.stringify(manifest(sha)));
  process.env.TRACKING_AGENT_INSTALLER = file;
}

const goodManifest = (sha: string) => ({
  kind: 'release', releaseGrade: true, version: '2.1.0', problems: [],
  setup: { signer: 'CN=BSC Textiles Pvt Ltd, O=BSC Textiles Pvt Ltd, C=IN', issuer: 'CN=Some Public CA', timestamp: 'CN=TSA' },
  sha256: { setup: sha.toUpperCase(), agent: 'x' },
});

afterAll(async () => {
  if (previous === undefined) delete process.env.TRACKING_AGENT_INSTALLER; else process.env.TRACKING_AGENT_INSTALLER = previous;
  fs.rmSync(root, { recursive: true, force: true });
  await closePool();
});

describe('installer release-grade detection', () => {
  it('treats an installer without a release manifest as untrusted', () => {
    stage(null);
    const info = getInstallerInfo();
    expect(info?.releaseGrade).toBe(false);
    expect(info?.problems[0]).toMatch(/No release manifest/);
  });

  it('rejects a manifest that does not match the installer on disk (swapped file)', () => {
    stage((sha) => ({ ...goodManifest(sha), sha256: { setup: 'f'.repeat(64) } }));
    const info = getInstallerInfo();
    expect(info?.releaseGrade).toBe(false);
    expect(info?.signer).toBeNull();
  });

  it('rejects dev-signed builds and builds that failed the gate', () => {
    stage((sha) => ({ ...goodManifest(sha), kind: 'dev-signed' }));
    expect(getInstallerInfo()?.releaseGrade).toBe(false);
    stage((sha) => ({ ...goodManifest(sha), releaseGrade: false, problems: ['Setup: certificate is SELF-SIGNED'] }));
    const failed = getInstallerInfo();
    expect(failed?.releaseGrade).toBe(false);
    expect(failed?.problems).toContain('Setup: certificate is SELF-SIGNED');
  });

  it('accepts a release-grade manifest whose hash matches', () => {
    stage(goodManifest);
    const info = getInstallerInfo();
    expect(info?.releaseGrade).toBe(true);
    expect(info?.version).toBe('2.1.0');
    expect(info?.timestamped).toBe(true);
  });
});

describe('agent update download', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => { app = createApp(); });

  it('requires a device token', async () => {
    stage(goodManifest);
    const anonymous = await request(app).get('/api/tracking/agent/update/download');
    expect(anonymous.status).toBe(401);
    const forged = await request(app).get('/api/tracking/agent/update/download').set('Authorization', `Bearer bsct_${'a'.repeat(40)}`);
    expect(forged.status).toBe(401);
  });

  it('keeps the web download behind an employee session', async () => {
    const anonymous = await request(app).get('/api/tracking/agent/download');
    expect(anonymous.status).toBe(401);
  });
});

describe('SMTP throttling classification', () => {
  it('recognises provider rate limits', () => {
    expect(isSmtpRateLimit({ responseCode: 451, message: '451 4.7.1 Ratelimit exceeded for mailbox' })).toBe(true);
    expect(isSmtpRateLimit({ responseCode: 421, response: '421 Too many messages, slow down' })).toBe(true);
  });
  it('does not misclassify other failures', () => {
    expect(isSmtpRateLimit({ responseCode: 451, message: 'Temporary local problem' })).toBe(false);
    expect(isSmtpRateLimit({ responseCode: 535, message: 'auth failed rate limit' })).toBe(false);
    expect(isSmtpRateLimit(new Error('ECONNREFUSED'))).toBe(false);
  });
});
