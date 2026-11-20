import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Socket } from 'socket.io-client';

/**
 * Real-time calling: honest "Calling / Ringing" states, unreachable detection, the native
 * Android delivery receipt, multi-device answer sync and the missed-call summary that a
 * callee gets when their connection comes back. Runs a real Socket.IO server.
 */

// Short confirmation window so the "silent device" scenario runs in a few seconds.
process.env.CALL_UNREACHABLE_SECONDS = '5';

const PASSWORD = 'Workforce@2026';
const ORIGIN = 'capacitor://localhost';

let app: Express;
let server: http.Server;
let url = '';
let db: typeof import('../src/db/index.js');
let push: typeof import('../src/services/PushService.js');
const sockets: Socket[] = [];
const users: Record<'caller' | 'callee', { id: number; token: string }> = { caller: { id: 0, token: '' }, callee: { id: 0, token: '' } };

async function mobileLogin(identifier: string) {
  const res = await request(app).post('/api/auth/mobile/login').set('Origin', ORIGIN).send({ identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return { id: Number(res.body.user.id), token: String(res.body.accessToken) };
}

function api(who: 'caller' | 'callee') {
  const auth = `Bearer ${users[who].token}`;
  return {
    get: (path: string) => request(app).get(`/api${path}`).set('Authorization', auth),
    post: (path: string, body?: object) => request(app).post(`/api${path}`).set('Origin', ORIGIN).set('Authorization', auth).send(body ?? {}),
  };
}

async function connect(who: 'caller' | 'callee', opts: { deviceId?: string; ack?: boolean } = {}): Promise<Socket> {
  const { io } = await import('socket.io-client');
  const socket = io(url, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    auth: { token: users[who].token, ...(opts.ack === false ? {} : { caps: ['call_ack'] }), ...(opts.deviceId ? { deviceId: opts.deviceId } : {}) },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error));
  });
  return socket;
}

function next<T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => { clearTimeout(timer); resolve(payload); });
  });
}

function none(socket: Socket, event: string, windowMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { socket.off(event, handler); resolve(true); }, windowMs);
    socket.once(event, handler);
  });
}

async function closeAll() {
  while (sockets.length) sockets.pop()!.close();
  await new Promise((r) => setTimeout(r, 150));
}

async function clearCalls() {
  await db.execute(
    "UPDATE calls SET status = 'completed', ended_at = NOW(3), callee_notified_at = NOW(3) WHERE status IN ('ringing','active') AND (caller_id IN (?, ?) OR callee_id IN (?, ?))",
    [users.caller.id, users.callee.id, users.caller.id, users.callee.id],
  );
  await db.execute('UPDATE calls SET callee_notified_at = NOW(3) WHERE callee_id = ? AND callee_notified_at IS NULL', [users.callee.id]);
}

beforeAll(async () => {
  const { createApp } = await import('../src/index.js');
  const { initRealtime } = await import('../src/realtime/io.js');
  db = await import('../src/db/index.js');
  push = await import('../src/services/PushService.js');
  app = createApp();
  server = http.createServer(app);
  initRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A role that may both make and receive calls (granted here: the seed rebuilds role permissions), and one shared location.
  for (const code of ['calls.make', 'calls.receive']) {
    await db.execute(
      "INSERT INTO permissions (code, module, action, description) VALUES (?, 'calls', ?, ?) ON DUPLICATE KEY UPDATE code = code",
      [code, code.split('.')[1], `Test: ${code}`],
    );
  }
  await db.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('calls.make', 'calls.receive') WHERE r.slug = 'store_manager'`,
  );
  const role = await db.queryOne<{ role_id: number }>("SELECT id AS role_id FROM roles WHERE slug = 'store_manager'");
  const template = await db.queryOne<{ password_hash: string; location_id: number | null }>(
    "SELECT password_hash, location_id FROM employees WHERE status = 'active' AND location_id IS NOT NULL ORDER BY id LIMIT 1",
  );
  expect(role).toBeTruthy();
  for (const [code, name, email, mobile] of [
    ['CR-001', 'Call Reach Caller', 'cr.caller@workforce.test', '9000000301'],
    ['CR-002', 'Call Reach Callee', 'cr.callee@workforce.test', '9000000302'],
  ] as const) {
    await db.execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE status = 'active', role_id = VALUES(role_id), location_id = VALUES(location_id)`,
      [code, name, email, mobile, template!.password_hash, role!.role_id, template!.location_id],
    );
  }
  users.caller = await mobileLogin('cr.caller@workforce.test');
  users.callee = await mobileLogin('cr.callee@workforce.test');
  // No phone / browser push registrations: reachability depends only on what each test connects.
  await db.execute('DELETE FROM push_device_tokens WHERE employee_id IN (?, ?)', [users.caller.id, users.callee.id]);
  await db.execute('DELETE FROM push_subscriptions WHERE employee_id IN (?, ?)', [users.caller.id, users.callee.id]);
});

afterAll(async () => {
  await closeAll();
  await new Promise((resolve) => server.close(resolve));
  await db.closePool();
});

describe('call reachability', () => {
  it('reports "offline or unreachable" at once when no device of the callee can be reached, then tells the callee on reconnect', async () => {
    await clearCalls();
    const start = await api('caller').post('/calls/start', { targetEmployeeId: users.callee.id, type: 'audio' });
    expect(start.status).toBe(201);
    expect(start.body.state).toBe('unreachable');
    expect(['offline', 'device_unavailable']).toContain(start.body.reason);
    expect(start.body.message).toMatch(/offline or unreachable|device is unavailable/);
    const callId = String(start.body.callId);

    const row = await db.queryOne<{ status: string; end_reason: string; delivered_at: string | null }>(
      'SELECT status, end_reason, delivered_at FROM calls WHERE call_id = ?', [callId],
    );
    expect(row).toMatchObject({ status: 'unreachable', delivered_at: null });
    // It never pretended to ring: the callee cannot answer a dead call.
    expect((await api('callee').post(`/calls/${callId}/accept`)).status).toBe(409);

    const events = await api('caller').get(`/calls/${callId}/events`);
    expect(events.body.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['initiated', 'unreachable']));

    const failedNote = await db.queryOne("SELECT n.id FROM notifications n JOIN notification_recipients nr ON nr.notification_id = n.id WHERE nr.employee_id = ? AND n.dedupe_key = ?", [users.caller.id, `unreachable_${callId}`]);
    expect(failedNote).not.toBeNull();
    const missedNote = await db.queryOne("SELECT n.id FROM notifications n JOIN notification_recipients nr ON nr.notification_id = n.id WHERE nr.employee_id = ? AND n.dedupe_key = ?", [users.callee.id, `missed_${callId}`]);
    expect(missedNote).not.toBeNull();

    const history = await api('caller').get('/calls/history');
    expect(history.body.calls.find((c: { callId: string }) => c.callId === callId)).toMatchObject({ status: 'unreachable', state: 'unreachable' });

    // The callee's phone comes back online: it is told about the missed call exactly once.
    const { io } = await import('socket.io-client');
    const back = io(url, { transports: ['websocket'], reconnection: false, auth: { token: users.callee.token, caps: ['call_ack'] } });
    sockets.push(back);
    const summary = await next<{ calls: { callId: string; status: string }[] }>(back, 'call:missed_summary');
    expect(summary.calls.map((c) => c.callId)).toContain(callId);
    await closeAll();
    const again = io(url, { transports: ['websocket'], reconnection: false, auth: { token: users.callee.token, caps: ['call_ack'] } });
    sockets.push(again);
    expect(await none(again, 'call:missed_summary', 1200)).toBe(true);
    await closeAll();
  });

  it('shows "Ringing" only after a device confirms, and an answer on one device stops the others', async () => {
    await clearCalls();
    const callerSocket = await connect('caller', { deviceId: 'caller-desktop-1' });
    const phone = await connect('callee', { deviceId: 'callee-phone-01' });
    const laptop = await connect('callee', { deviceId: 'callee-laptop-1' });

    const incomingPhone = next<{ callId: string; caller: { name: string; employeeCode: string } }>(phone, 'call:incoming');
    const incomingLaptop = next(laptop, 'call:incoming');
    const start = await api('caller').post('/calls/start', { targetEmployeeId: users.callee.id, type: 'audio' });
    expect(start.status).toBe(201);
    expect(start.body.state).toBe('calling');
    const callId = String(start.body.callId);
    const ring = await incomingPhone;
    await incomingLaptop;
    expect(ring.caller).toMatchObject({ name: 'Call Reach Caller', employeeCode: 'CR-001' });

    // Not yet confirmed: the caller is still "Calling…".
    expect((await api('caller').get(`/calls/detail/${callId}`)).body.state).toBe('initiating');
    const ringing = next<{ callId: string; via: string }>(callerSocket, 'call:ringing');
    phone.emit('call:ring_ack', { callId });
    laptop.emit('call:ring_ack', { callId }); // duplicate receipts are harmless
    expect(await ringing).toMatchObject({ callId, via: 'socket' });
    expect((await api('caller').get(`/calls/detail/${callId}`)).body.state).toBe('ringing');

    const elsewhere = next<{ callId: string; deviceId: string }>(laptop, 'call:answered_elsewhere');
    const accepted = next(callerSocket, 'call:accepted');
    expect((await api('callee').post(`/calls/${callId}/accept`, { deviceId: 'callee-phone-01' })).status).toBe(200);
    expect(await elsewhere).toMatchObject({ callId, deviceId: 'callee-phone-01' });
    await accepted;
    // The laptop tries to answer too: exactly one device wins.
    expect((await api('callee').post(`/calls/${callId}/accept`, { deviceId: 'callee-laptop-1' })).status).toBe(409);
    expect((await api('caller').get(`/calls/detail/${callId}`)).body.state).toBe('connecting');

    const connected = next(callerSocket, 'call:connected');
    expect((await api('callee').post(`/calls/${callId}/connected`)).body.first).toBe(true);
    expect((await api('caller').post(`/calls/${callId}/connected`)).body.first).toBe(false);
    await connected;
    expect((await api('caller').get(`/calls/detail/${callId}`)).body.state).toBe('connected');

    const end = await api('caller').post(`/calls/${callId}/end`);
    expect(end.body.status).toBe('completed');
    const row = await db.queryOne<{ status: string; answered_device: string; delivered_via: string; connected_at: string | null }>(
      'SELECT status, answered_device, delivered_via, connected_at FROM calls WHERE call_id = ?', [callId],
    );
    expect(row).toMatchObject({ status: 'completed', answered_device: 'callee-phone-01', delivered_via: 'socket' });
    expect(row?.connected_at).not.toBeNull();
    const events = (await api('callee').get(`/calls/${callId}/events`)).body.events.map((e: { event: string }) => e.event);
    expect(events).toEqual(expect.arrayContaining(['initiated', 'ring_confirmed', 'answered', 'media_connected', 'ended']));
    await closeAll();
  });

  it('accepts the native Android ring receipt only with the call-bound token', async () => {
    await clearCalls();
    const callerSocket = await connect('caller');
    // An older app build on the callee's side: it may ring but never confirms by itself.
    await connect('callee', { ack: false });
    const start = await api('caller').post('/calls/start', { targetEmployeeId: users.callee.id, type: 'audio' });
    expect(start.body.state).toBe('calling');
    const callId = String(start.body.callId);

    const forged = await request(app).post('/api/calls/ring-ack').set('Origin', ORIGIN).send({ callId, token: 'x'.repeat(43) });
    expect(forged.status).toBe(403);
    // A token for another employee does not work either.
    const otherToken = push.callActionToken(callId, users.caller.id);
    expect((await request(app).post('/api/calls/ring-ack').set('Origin', ORIGIN).send({ callId, token: otherToken })).status).toBe(403);

    const ringing = next(callerSocket, 'call:ringing');
    const ok = await request(app).post('/api/calls/ring-ack').set('Origin', ORIGIN)
      .send({ callId, token: push.callActionToken(callId, users.callee.id), device: 'Pixel 8' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, first: true, ringing: true });
    expect(await ringing).toMatchObject({ callId, via: 'fcm' });

    // Decline from the native notification (same token): the caller is told immediately.
    const rejected = next(callerSocket, 'call:rejected');
    const decline = await request(app).post('/api/calls/push-action').set('Origin', ORIGIN)
      .send({ callId, token: push.callActionToken(callId, users.callee.id), action: 'decline' });
    expect(decline.status).toBe(200);
    await rejected;
    expect((await db.queryOne<{ status: string }>('SELECT status FROM calls WHERE call_id = ?', [callId]))?.status).toBe('declined');
    await closeAll();
  });

  it('declares a device that never confirms unreachable after the confirmation window, never "ringing"', async () => {
    await clearCalls();
    const callerSocket = await connect('caller');
    // The callee's socket is still registered (phone just switched off / lost network) but never answers.
    const silent = await connect('callee');
    silent.off('call:incoming');
    let sawRinging = false;
    callerSocket.on('call:ringing', () => { sawRinging = true; });
    const unreachable = next<{ callId: string; reason: string; message: string }>(callerSocket, 'call:unreachable', 9000);
    const start = await api('caller').post('/calls/start', { targetEmployeeId: users.callee.id, type: 'audio' });
    expect(start.body.state).toBe('calling');
    const result = await unreachable;
    expect(result).toMatchObject({ callId: start.body.callId, reason: 'offline', message: 'User is offline or unreachable' });
    expect(sawRinging).toBe(false);
    const row = await db.queryOne<{ status: string; end_reason: string }>('SELECT status, end_reason FROM calls WHERE call_id = ?', [start.body.callId]);
    expect(row).toMatchObject({ status: 'unreachable', end_reason: 'offline' });
    await closeAll();
  }, 15000);

  it('exposes the ring timing and TURN status to clients', async () => {
    const config = await api('caller').get('/calls/config');
    expect(config.status).toBe(200);
    expect(config.body.ringTimeoutSeconds).toBeGreaterThanOrEqual(15);
    expect(config.body.unreachableAfterSeconds).toBe(5);
    expect(typeof config.body.turnConfigured).toBe('boolean');
  });
});
