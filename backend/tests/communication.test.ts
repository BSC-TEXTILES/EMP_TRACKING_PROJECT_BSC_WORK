import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { closePool, execute, queryOne } from '../src/db/index.js';
import { sweepStaleCalls } from '../src/routes/calls.js';

/**
 * End-to-end API tests for calling, resumable uploads, presence, access control
 * and location scoping. They run against the dedicated test database with real
 * seeded employee accounts (see tests/global-setup.ts).
 */
let app: Express;
const PASSWORD = 'Workforce@2026';

async function login(identifier: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').set('Origin', 'http://localhost:5173').send({ identifier, password: PASSWORD });
  expect(response.status).toBe(200);
  // supertest agents keep cookies; state-changing requests need the app origin.
  const wrap = (method: 'get' | 'post' | 'put' | 'delete') => (url: string) => agent[method](url).set('Origin', 'http://localhost:5173');
  return { agent: { get: wrap('get'), post: wrap('post'), put: wrap('put'), delete: wrap('delete') }, id: Number(response.body.user.id) };
}

/** No test may leave a live call behind, or later "busy" checks become flaky. */
async function clearCalls(...ids: number[]) {
  await execute(
    `UPDATE calls SET status = 'completed', ended_at = NOW(3) WHERE status IN ('ringing','active')
     AND (caller_id IN (${ids.map(() => '?').join(',')}) OR callee_id IN (${ids.map(() => '?').join(',')}))`,
    [...ids, ...ids],
  );
}

beforeAll(() => { app = createApp(); });
afterAll(async () => { await closePool(); });

describe('in-app calling', () => {
  it('rings, is accepted only by the callee, connects and records a server-side duration', async () => {
    const caller = await login('ananya.rao@workforce.test');
    const callee = await login('karthik.iyer@workforce.test');
    const outsider = await login('meera.joshi@workforce.test');
    await clearCalls(caller.id, callee.id, outsider.id);

    const config = await caller.agent.get('/api/calls/config');
    expect(config.status).toBe(200);
    expect(config.body.iceServers.length).toBeGreaterThan(0);
    for (const server of config.body.iceServers as { urls: string }[]) expect(server.urls).toMatch(/^(stun|turns?):/);

    const start = await caller.agent.post('/api/calls/start').send({ targetEmployeeId: callee.id, type: 'audio' });
    expect(start.status).toBe(201);
    const callId = String(start.body.callId);

    expect((await outsider.agent.post(`/api/calls/${callId}/accept`)).status).toBe(403);
    expect((await caller.agent.post(`/api/calls/${callId}/accept`)).status).toBe(403);
    expect((await outsider.agent.get(`/api/calls/detail/${callId}`)).status).toBe(403);

    const incoming = await callee.agent.get(`/api/calls/detail/${callId}`);
    expect(incoming.status).toBe(200);
    expect(incoming.body.status).toBe('ringing');
    expect(incoming.body.direction).toBe('incoming');

    expect((await callee.agent.post(`/api/calls/${callId}/accept`)).status).toBe(200);
    // A second accept (e.g. from another tab) must not reopen or reset the call.
    expect((await callee.agent.post(`/api/calls/${callId}/accept`)).status).toBe(409);

    // A third employee calling either party gets "busy", never a parallel ring.
    const busy = await outsider.agent.post('/api/calls/start').send({ targetEmployeeId: callee.id, type: 'audio' });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('busy');

    await execute('UPDATE calls SET accepted_at = DATE_SUB(NOW(3), INTERVAL 7 SECOND) WHERE call_id = ?', [callId]);
    const ended = await caller.agent.post(`/api/calls/${callId}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('completed');
    expect(ended.body.duration).toBeGreaterThanOrEqual(6);
    expect(ended.body.duration).toBeLessThan(60);

    const row = await queryOne<{ status: string; duration_seconds: number; caller_id: number; callee_id: number }>(
      'SELECT status, duration_seconds, caller_id, callee_id FROM calls WHERE call_id = ?', [callId],
    );
    expect(row).toMatchObject({ status: 'completed', caller_id: caller.id, callee_id: callee.id });

    const history = await callee.agent.get('/api/calls/history?limit=abc&offset=-3');
    expect(history.status).toBe(200);
    const entry = (history.body.calls as { callId: string; direction: string; status: string }[]).find((call) => call.callId === callId);
    expect(entry).toMatchObject({ direction: 'incoming', status: 'completed' });
  });

  it('records rejected calls and cannot accept a call that was already rejected', async () => {
    const caller = await login('ananya.rao@workforce.test');
    const callee = await login('karthik.iyer@workforce.test');
    await clearCalls(caller.id, callee.id);
    const start = await caller.agent.post('/api/calls/start').send({ targetEmployeeId: callee.id, type: 'audio' });
    expect(start.status).toBe(201);
    expect((await callee.agent.post(`/api/calls/${start.body.callId}/reject`)).status).toBe(200);
    expect((await callee.agent.post(`/api/calls/${start.body.callId}/accept`)).status).toBe(409);
    const row = await queryOne<{ status: string }>('SELECT status FROM calls WHERE call_id = ?', [start.body.callId]);
    expect(row?.status).toBe('declined');
  });

  it('turns an unanswered call into a missed call with a notification for the callee', async () => {
    const caller = await login('ananya.rao@workforce.test');
    const callee = await login('karthik.iyer@workforce.test');
    await clearCalls(caller.id, callee.id);
    const start = await caller.agent.post('/api/calls/start').send({ targetEmployeeId: callee.id, type: 'audio' });
    expect(start.status).toBe(201);
    const callId = String(start.body.callId);
    // Simulate the caller closing the app while it rings: nobody calls /cancel.
    await execute('UPDATE calls SET started_at = DATE_SUB(NOW(3), INTERVAL 3 MINUTE) WHERE call_id = ?', [callId]);
    const swept = await sweepStaleCalls();
    expect(swept.missed).toBeGreaterThanOrEqual(1);

    const row = await queryOne<{ status: string; ended_at: string | null }>('SELECT status, ended_at FROM calls WHERE call_id = ?', [callId]);
    expect(row?.status).toBe('missed');
    expect(row?.ended_at).toBeTruthy();
    const notification = await queryOne<{ id: number }>(
      `SELECT n.id FROM notifications n JOIN notification_recipients r ON r.notification_id = n.id
       WHERE n.dedupe_key = ? AND r.employee_id = ?`, [`missed_${callId}`, callee.id],
    );
    expect(notification).toBeTruthy();
    const history = await callee.agent.get('/api/calls/history');
    const entry = (history.body.calls as { callId: string; status: string; read: boolean }[]).find((call) => call.callId === callId);
    expect(entry).toMatchObject({ status: 'missed', read: false });
  });

  it('requires authentication for calling', async () => {
    expect((await request(app).get('/api/calls/history')).status).toBe(401);
    expect((await request(app).post('/api/calls/start').set('Origin', 'http://localhost:5173').send({ targetEmployeeId: 1, type: 'audio' })).status).toBe(401);
  });
});

describe('resumable chunked uploads', () => {
  it('uploads in chunks, survives a resume, verifies integrity and downloads byte-identical content', async () => {
    const owner = await login('ananya.rao@workforce.test');
    // A real (minimal) PDF so signature validation passes; padded to span several chunks.
    const header = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n', 'latin1');
    const padding = crypto.randomBytes(2 * 1024 * 1024 + 12345);
    const trailer = Buffer.from('\n%%EOF\n', 'latin1');
    const content = Buffer.concat([header, padding, trailer]);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    const start = await owner.agent.post('/api/files/chunked/start').send({ name: 'Quarterly report (final).pdf', mimeType: 'application/pdf', size: content.length, sha256 });
    expect(start.status).toBe(201);
    const { uploadId, chunkSize, totalChunks } = start.body as { uploadId: string; chunkSize: number; totalChunks: number };
    expect(totalChunks).toBeGreaterThanOrEqual(1);

    // Send all but the last chunk, then "reconnect" and ask what the server has.
    for (let index = 0; index < totalChunks - 1; index += 1) {
      const chunk = content.subarray(index * chunkSize, (index + 1) * chunkSize);
      const put = await owner.agent.put(`/api/files/chunked/${uploadId}/chunk/${index}`).set('Content-Type', 'application/octet-stream').send(chunk);
      expect(put.status).toBe(200);
    }
    const status = await owner.agent.get(`/api/files/chunked/${uploadId}`);
    expect(status.status).toBe(200);

    // Another employee cannot inspect or complete someone else's upload session.
    const intruder = await login('karthik.iyer@workforce.test');
    expect((await intruder.agent.get(`/api/files/chunked/${uploadId}`)).status).toBeGreaterThanOrEqual(403);

    const last = totalChunks - 1;
    const finalPut = await owner.agent.put(`/api/files/chunked/${uploadId}/chunk/${last}`).set('Content-Type', 'application/octet-stream').send(content.subarray(last * chunkSize));
    expect(finalPut.status).toBe(200);
    const complete = await owner.agent.post(`/api/files/chunked/${uploadId}/complete`).send({ sha256 });
    expect(complete.status).toBe(201);
    const fileId = Number(complete.body.id);

    const download = await owner.agent.get(`/api/files/${fileId}?download=1`).buffer(true).parse((res, done) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => done(null, Buffer.concat(parts)));
    });
    expect(download.status).toBe(200);
    expect(crypto.createHash('sha256').update(download.body as Buffer).digest('hex')).toBe(sha256);
    expect(String(download.headers['content-disposition'])).toContain('attachment');
    expect(String(download.headers['content-disposition'])).toMatch(/Quarterly/);
  });

  it('rejects a completed upload whose content does not match the declared checksum', async () => {
    const owner = await login('ananya.rao@workforce.test');
    const content = Buffer.from('plain text payload for checksum test\n', 'utf8');
    const start = await owner.agent.post('/api/files/chunked/start').send({ name: 'notes.txt', mimeType: 'text/plain', size: content.length, sha256: 'a'.repeat(64) });
    expect(start.status).toBe(201);
    const put = await owner.agent.put(`/api/files/chunked/${start.body.uploadId}/chunk/0`).set('Content-Type', 'application/octet-stream').send(content);
    expect(put.status).toBe(200);
    const complete = await owner.agent.post(`/api/files/chunked/${start.body.uploadId}/complete`).send({});
    expect(complete.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a file whose bytes do not match its claimed type', async () => {
    const owner = await login('ananya.rao@workforce.test');
    const fake = Buffer.from('MZ this is not really a pdf', 'latin1');
    const upload = await owner.agent.post('/api/files/upload').attach('file', fake, { filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBeGreaterThanOrEqual(400);
  });
});

describe('presence and session tracking', () => {
  it('marks an employee active on activity and logged out after an explicit logout', async () => {
    const employee = await login('pooja.reddy@workforce.test');
    const ping = await employee.agent.post('/api/presence/ping');
    expect(ping.status).toBe(200);
    expect(['active', 'online']).toContain(ping.body.presence.status);

    const logout = await employee.agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);
    const viewer = await login('admin@workforce.test');
    const list = await viewer.agent.get(`/api/presence?ids=${employee.id}`);
    expect(list.status).toBe(200);
    const entry = (list.body.items as { employeeId: number; status: string }[]).find((item) => item.employeeId === employee.id);
    expect(entry).toBeDefined();
    expect(entry!.status).not.toBe('active');
    // The revoked session can no longer reach protected APIs.
    expect((await employee.agent.get('/api/me/dashboard')).status).toBe(401);
  });
});

describe('access control fixes', () => {
  it('stops an employee reading a colleague\'s KPI history and leave balances', async () => {
    const employee = await login('ananya.rao@workforce.test');
    const colleague = await queryOne<{ id: number }>("SELECT id FROM employees WHERE email = 'karthik.iyer@workforce.test'");
    expect((await employee.agent.get(`/api/kpi/history?employeeId=${colleague!.id}`)).status).toBe(403);
    expect((await employee.agent.get(`/api/leave/balances?employeeId=${colleague!.id}`)).status).toBe(403);
    expect((await employee.agent.get(`/api/kpi?employeeId=${colleague!.id}`)).status).toBe(403);
    expect((await employee.agent.get(`/api/kpi/history?employeeId=${employee.id}`)).status).toBe(200);
  });
});

describe('location scoping', () => {
  it('limits an organisation-wide role without All Locations access to its own location', async () => {
    const locations = new Map<string, number>();
    for (const code of ['BEL', 'DAV', 'SHI']) {
      const row = await queryOne<{ id: number }>('SELECT id FROM locations WHERE code = ? AND is_active = 1', [code]);
      expect(row, `location ${code} must exist`).toBeTruthy();
      locations.set(code, Number(row!.id));
    }
    await execute("UPDATE employees SET location_id = ? WHERE email = 'hr.exec@workforce.test'", [locations.get('BEL')]);
    await execute("UPDATE employees SET location_id = ? WHERE email = 'meera.joshi@workforce.test'", [locations.get('DAV')]);
    const davEmployee = await queryOne<{ id: number }>("SELECT id FROM employees WHERE email = 'meera.joshi@workforce.test'");

    const hrExec = await login('hr.exec@workforce.test');
    const list = await hrExec.agent.get('/api/employees?pageSize=200');
    expect(list.status).toBe(200);
    const items = list.body.items as { id: number; locationId?: number | null; location_id?: number | null }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.id === davEmployee!.id)).toBe(false);

    const admin = await login('admin@workforce.test');
    const all = await admin.agent.get('/api/employees?pageSize=200');
    expect((all.body.items as { id: number }[]).some((item) => item.id === davEmployee!.id)).toBe(true);

    const structure = await admin.agent.get('/api/employees/structure');
    const codes = (structure.body.locations as { code: string; isActive: boolean }[]).filter((l) => l.isActive).map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(['BEL', 'DAV', 'SHI']));
  });

  it('rejects a duplicate location code and a designation reporting cycle', async () => {
    const admin = await login('admin@workforce.test');
    const duplicate = await admin.agent.post('/api/employees/locations').send({ name: `Belagavi copy ${Date.now()}`, code: 'BEL' });
    expect(duplicate.status).toBe(409);

    const structure = await admin.agent.get('/api/employees/structure');
    const designations = structure.body.designations as { id: number; title: string; reportingDesignationId: number | null }[];
    const manager = designations.find((d) => d.title === 'HR Manager');
    const executive = designations.find((d) => d.title === 'HR Executive' && d.reportingDesignationId === manager?.id);
    expect(manager && executive).toBeTruthy();
    const response = await request(app).patch(`/api/employees/designations/${manager!.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', (await adminCookie()))
      .send({ reportingDesignationId: executive!.id });
    expect(response.status).toBe(400);
  });
});

async function adminCookie(): Promise<string[]> {
  const response = await request(app).post('/api/auth/login').set('Origin', 'http://localhost:5173').send({ identifier: 'admin@workforce.test', password: PASSWORD });
  return (response.headers['set-cookie'] as unknown as string[]).map((cookie) => cookie.split(';')[0]);
}
