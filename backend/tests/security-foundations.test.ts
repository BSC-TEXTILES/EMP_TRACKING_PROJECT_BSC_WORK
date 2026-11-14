import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import net from 'node:net';
import fs from 'node:fs/promises';
import { createApp } from '../src/index.js';
import { AuthService } from '../src/services/AuthService.js';
import { FileService } from '../src/services/FileService.js';
import { retryDeadlock } from '../src/lib/deadlockRetry.js';
import { scanBuffer } from '../src/lib/uploadSecurity.js';
import { closePool, execute, queryOne, transaction } from '../src/db/index.js';

afterAll(closePool);

describe('rotating sessions', () => {
  const app = createApp();
  async function employeeId() {
    const row = await queryOne<{ id: number }>("SELECT id FROM employees WHERE status = 'active' ORDER BY id LIMIT 1");
    if (!row) throw new Error('An active seeded employee is required');
    return row.id;
  }
  it('expires access after 15 minutes and revokes the family on refresh reuse', async () => {
    const pair = await AuthService.createSession(await employeeId(), '127.0.0.1', 'security regression', false);
    const payload = jwt.decode(pair.token) as { exp: number; iat: number };
    expect(payload.exp - payload.iat).toBe(900);
    const rotated = await AuthService.refreshSession(pair.refreshToken);
    expect(rotated.refreshToken).not.toBe(pair.refreshToken);
    expect(await AuthService.authenticateToken(rotated.token)).not.toBeNull();
    await expect(AuthService.refreshSession(pair.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(await AuthService.authenticateToken(rotated.token)).toBeNull();
    await expect(AuthService.refreshSession(rotated.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
  it('does not extend the maximum session deadline', async () => {
    const pair = await AuthService.createSession(await employeeId(), '127.0.0.1', 'deadline regression', true);
    const user = await AuthService.authenticateToken(pair.token);
    await execute('UPDATE employee_sessions SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?', [user!.sessionId]);
    await expect(AuthService.refreshSession(pair.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(await AuthService.authenticateToken(pair.token)).toBeNull();
  });
  it('sets HttpOnly cookies and clears both when refresh fails', async () => {
    const pair = await AuthService.createSession(await employeeId(), '127.0.0.1', 'cookie regression', false);
    const response = await request(app).post('/api/auth/refresh').set('Cookie', `wfm_refresh=${pair.refreshToken}`);
    expect(response.status).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies.every(value => value.includes('HttpOnly') && value.includes('SameSite=Strict'))).toBe(true);
    const failed = await request(app).post('/api/auth/refresh').set('Cookie', `wfm_refresh=${pair.refreshToken}`);
    expect(failed.status).toBe(401);
    expect(failed.headers['set-cookie']).toHaveLength(2);
  });
  it('allows only one concurrent rotation and revokes the raced family', async () => {
    const pair = await AuthService.createSession(await employeeId(), '127.0.0.1', 'race regression', false);
    const results = await Promise.allSettled([AuthService.refreshSession(pair.refreshToken), AuthService.refreshSession(pair.refreshToken)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await AuthService.authenticateToken(pair.token)).toBeNull();
  });
});

describe('database recovery', () => {
  it('retries recognized deadlocks with a strict bound', async () => {
    let attempts = 0;
    await expect(retryDeadlock(async () => { attempts++; throw { code: 'ER_LOCK_DEADLOCK' }; })).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    expect(attempts).toBe(3);
  });
  it('never replays an ambiguous connection or commit failure', async () => {
    let attempts = 0;
    await expect(retryDeadlock(async () => { attempts++; throw { code: 'ECONNRESET' }; })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(attempts).toBe(1);
  });
  it('rolls back real database writes before retrying', async () => {
    const key = `retry_regression_${Date.now()}`;
    let attempts = 0;
    try {
      await transaction(async conn => {
        await conn.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, 'once']);
        if (++attempts === 1) throw { code: 'ER_LOCK_DEADLOCK' };
      }, { retryDeadlocks: true });
      expect(attempts).toBe(2);
      expect(await queryOne('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key])).toMatchObject({ setting_value: 'once' });
    } finally { await execute('DELETE FROM system_settings WHERE setting_key = ?', [key]); }
  });
});

describe('upload boundaries', () => {
  it('rejects executable double extensions and sibling-directory traversal', () => {
    expect(() => FileService.validate('payload.exe.png', 'image/png', 10)).toThrow();
    expect(() => FileService.absolutePath('../uploads-other/private.txt')).toThrow();
  });
  it('fails closed without a scanner', async () => {
    await expect(scanBuffer(Buffer.from('test'), '')).rejects.toMatchObject({ code: 'scanner_unavailable' });
  });
  it.each([['stream: OK\0', null], ['stream: Eicar-Test-Signature FOUND\0', 'malware_detected'], ['stream: ERROR\0', 'scanner_unavailable']])('handles scanner verdict %s', async (reply, code) => {
    const server = net.createServer(socket => { socket.once('data', () => socket.write(reply!)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const result = scanBuffer(Buffer.from('test fixture'), '127.0.0.1', port);
      if (code) await expect(result).rejects.toMatchObject({ code });
      else await expect(result).resolves.toBeUndefined();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe('helpdesk persistence and attachment authorization', () => {
  const app = createApp();
  async function employeeSession(email: string) {
    const row = await queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', [email]);
    if (!row) throw new Error('Seeded employee is required');
    const pair = await AuthService.createSession(row.id, '127.0.0.1', 'ticket regression', false);
    return { id: row.id, cookie: `wfm_session=${pair.token}`, refreshToken: pair.refreshToken };
  }
  it('persists issue detail and clean attachments, rejects stolen attachments and unauthorized actions', async () => {
    const employee = await employeeSession('ananya.rao@workforce.test');
    const other = await employeeSession('admin@workforce.test');
    const server = net.createServer(socket => socket.once('data', () => socket.write('stream: OK\0')));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const previousHost = process.env.CLAMAV_HOST;
    const previousPort = process.env.CLAMAV_PORT;
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String((server.address() as net.AddressInfo).port);
    let fileId: number | undefined;
    let ticketId: number | undefined;
    try {
      const uploaded = await request(app).post('/api/files/upload').set('Cookie', employee.cookie)
        .attach('file', Buffer.from('A safe UTF-8 diagnostic note.'), { filename: 'diagnostic.txt', contentType: 'text/plain' });
      expect(uploaded.status).toBe(201);
      fileId = uploaded.body.id;
      const input = { subject: 'Regression issue details', description: 'A reproducible test issue for regression verification.', category: 'General Requests',
        attachmentIds: [fileId], issueDetails: { affectedModule: 'Attendance', expectedResult: 'Check in succeeds', impact: 'individual', diagnosticsConsent: true,
          diagnostics: { online: true, viewportWidth: 1200, viewportHeight: 800 } } };
      const stolen = await request(app).post('/api/tickets').set('Cookie', other.cookie).send(input);
      expect(stolen.status).toBe(403);
      const created = await request(app).post('/api/tickets').set('Cookie', employee.cookie).send(input);
      expect(created.status).toBe(201);
      ticketId = created.body.id;
      expect(created.body.issueDetails).toMatchObject({ affectedModule: 'Attendance', employeeName: 'Ananya Rao' });
      expect(created.body.attachments[0].file_id).toBe(fileId);
      const downloaded = await request(app).get(`/api/files/${fileId}`).set('Cookie', employee.cookie);
      expect(downloaded.status).toBe(200);
      const forbidden = await request(app).get(`/api/files/${fileId}`).set('Cookie', other.cookie);
      expect(forbidden.status).toBe(403);
      const action = await request(app).post(`/api/tickets/${ticketId}/action`).set('Cookie', employee.cookie)
        .send({ action: 'resolve', resolution: 'Unauthorized resolution' });
      expect(action.status).toBe(403);
      const illegal = await request(app).post(`/api/tickets/${ticketId}/action`).set('Cookie', other.cookie)
        .send({ action: 'close' });
      expect(illegal.status).toBe(400);
      expect(await queryOne('SELECT closed_at FROM tickets WHERE id = ?', [ticketId])).toMatchObject({ closed_at: null });
      const noConsent = await request(app).post('/api/tickets').set('Cookie', employee.cookie)
        .send({ ...input, issueDetails: { ...input.issueDetails, diagnosticsConsent: false } });
      expect(noConsent.status).toBe(400);
    } finally {
      if (ticketId) await execute('DELETE FROM tickets WHERE id = ?', [ticketId]);
      if (fileId) {
        const file = await queryOne<{ storage_key: string }>('SELECT storage_key FROM files WHERE id = ?', [fileId]);
        if (file) await fs.unlink(FileService.absolutePath(file.storage_key));
        await execute('DELETE FROM files WHERE id = ?', [fileId]);
      }
      await AuthService.logoutRefresh(employee.refreshToken);
      await AuthService.logoutRefresh(other.refreshToken);
      if (previousHost === undefined) delete process.env.CLAMAV_HOST; else process.env.CLAMAV_HOST = previousHost;
      if (previousPort === undefined) delete process.env.CLAMAV_PORT; else process.env.CLAMAV_PORT = previousPort;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
