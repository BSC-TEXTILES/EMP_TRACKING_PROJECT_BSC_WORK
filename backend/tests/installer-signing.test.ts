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
import { closePool, execute, queryOne } from '../src/db/index.js';
import { hashPassword } from '../src/lib/crypto.js';
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
    expect(info?.problems[0]).toMatch(/no release-manifest.json/);
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

  it('gives a signed-in administrator the complete, unmodified installer', async () => {
    stage(goodManifest);
    const role = await queryOne<{ id: number }>("SELECT id FROM roles WHERE slug = 'admin'");
    const sfx = crypto.randomBytes(3).toString('hex');
    const email = `dl.admin.${sfx}@workforce.test`;
    const password = 'Download-Test-2026!';
    const created = await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, employment_type, status,
                              joining_date, email_verified_at, must_change_password, mfa_required)
       VALUES (?, ?, ?, ?, ?, ?, 'full_time', 'active', CURDATE(), NOW(3), 0, 0)`,
      [`DL-${sfx}`, `Download Admin ${sfx}`, email, `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, await hashPassword(password), role!.id],
    );
    try {
      const agent = request.agent(app);
      const login = await agent.post('/api/auth/login').set('Origin', 'http://localhost:5173').send({ identifier: email, password });
      expect(login.status, JSON.stringify(login.body)).toBe(200);

      const info = await agent.get('/api/tracking/agent/info');
      expect(info.status).toBe(200);
      expect(info.body.signature.releaseGrade).toBe(true);

      const download = await agent.get('/api/tracking/agent/download').buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
      expect(download.status).toBe(200);
      expect(download.headers['content-disposition']).toMatch(/attachment; filename="BSC-Activity-Tracker-Setup\.exe"/);
      const body = download.body as Buffer;
      expect(body.length).toBe(info.body.sizeBytes);
      expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(info.body.sha256);
    } finally {
      await execute('DELETE FROM sessions WHERE employee_id = ?', [created.insertId]).catch(() => undefined);
      await execute('DELETE FROM employees WHERE id = ?', [created.insertId]).catch(() => undefined);
    }
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
