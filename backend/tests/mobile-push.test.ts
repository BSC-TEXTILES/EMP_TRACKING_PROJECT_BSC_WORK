import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

/**
 * Mobile app back end: token login, CORS for the Capacitor origin, device
 * tokens, FCM delivery (Google endpoints are faked) and the socket handshake.
 */

// A throwaway service account so the FCM client is "configured". Its key is
// generated per run; the Google token and FCM endpoints are faked below.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
  project_id: 'bsc-test-project',
  client_email: 'push@bsc-test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

const PASSWORD = 'Workforce@2026';
const MOBILE_ORIGIN = 'capacitor://localhost';
const ANDROID_ORIGIN = 'https://localhost';

interface SentMessage { token: string; notification: { title: string; body?: string }; data: Record<string, string>; android: { priority: string; notification: { channel_id: string } }; apns: { payload: { aps: { badge?: number } } } }
let sent: SentMessage[] = [];
let oauthCalls = 0;
const DEAD_TOKEN_PREFIX = 'deadtoken';

const realFetch = globalThis.fetch;
function fakeGoogle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'https://oauth2.googleapis.com/token') {
    oauthCalls += 1;
    const params = new URLSearchParams(String(init?.body));
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    return Promise.resolve(new Response(JSON.stringify({ access_token: 'fake-google-access', expires_in: 3600 }), { status: 200 }));
  }
  if (url === 'https://fcm.googleapis.com/v1/projects/bsc-test-project/messages:send') {
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer fake-google-access');
    const message = (JSON.parse(String(init?.body)) as { message: SentMessage }).message;
    if (message.token.startsWith(DEAD_TOKEN_PREFIX)) {
      return Promise.resolve(new Response(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 }));
    }
    sent.push(message);
    return Promise.resolve(new Response(JSON.stringify({ name: 'projects/bsc-test-project/messages/1' }), { status: 200 }));
  }
  return realFetch(input, init);
}

let app: Express;
let db: typeof import('../src/db/index.js');
let NotificationService: typeof import('../src/services/NotificationService.js').NotificationService;
let PushService: typeof import('../src/services/PushService.js').PushService;

async function mobileLogin(identifier: string) {
  const response = await request(app).post('/api/auth/mobile/login').set('Origin', MOBILE_ORIGIN).send({ identifier, password: PASSWORD });
  expect(response.status).toBe(200);
  return response;
}

async function employeeId(email: string): Promise<number> {
  const row = await db.queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', [email]);
  if (!row) throw new Error(`seeded employee ${email} missing`);
  return Number(row.id);
}

/** notify() pushes in the background; wait for it to settle. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 25));
}

function token(label: string) {
  return `${label}_${Math.random().toString(36).slice(2)}:APA91b${'x'.repeat(120)}`;
}

/**
 * The demo seed has only two real accounts, so plain employees for these tests
 * are cloned from a seeded one (same password, role 'employee').
 */
async function createTestEmployees() {
  const template = await db.queryOne<{ password_hash: string; department_id: number | null; location_id: number | null }>(
    "SELECT password_hash, department_id, location_id FROM employees WHERE status = 'active' ORDER BY id LIMIT 1",
  );
  const role = await db.queryOne<{ id: number }>("SELECT id FROM roles WHERE slug = 'employee'");
  if (!template || !role) throw new Error('seeded employee and employee role are required');
  for (const [i, letter] of ['a', 'b', 'c', 'd'].entries()) {
    await db.execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, location_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE status = 'active', failed_login_attempts = 0, locked_until = NULL`,
      [`MOB-90${i}`, `Mobile Test ${letter.toUpperCase()}`, `mobile.${letter}@workforce.test`, `900000000${i}`, template.password_hash, role.id, template.department_id, template.location_id],
    );
  }
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(fakeGoogle));
  const index = await import('../src/index.js');
  db = await import('../src/db/index.js');
  ({ NotificationService } = await import('../src/services/NotificationService.js'));
  ({ PushService } = await import('../src/services/PushService.js'));
  app = index.createApp();
  await createTestEmployees();
});

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.closePool();
});

describe('mobile sign-in', () => {
  it('returns tokens in the body and sets no cookies', async () => {
    const response = await mobileLogin('mobile.a@workforce.test');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(response.body.accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(response.body.user.email).toBe('mobile.a@workforce.test');
    expect(response.headers['access-control-allow-origin']).toBe(MOBILE_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();

    const me = await request(app).get('/api/auth/me').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${response.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('mobile.a@workforce.test');
  });

  it('rejects a wrong password with the normal error', async () => {
    const response = await request(app).post('/api/auth/mobile/login').set('Origin', MOBILE_ORIGIN).send({ identifier: 'mobile.a@workforce.test', password: 'nope' });
    expect(response.status).toBe(401);
    expect(response.body.accessToken).toBeUndefined();
  });

  it('rotates refresh tokens and revokes the session when an old one is reused', async () => {
    const login = await mobileLogin('mobile.a@workforce.test');
    const rotated = await request(app).post('/api/auth/mobile/refresh').set('Origin', MOBILE_ORIGIN).send({ refreshToken: login.body.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(login.body.refreshToken);
    expect(rotated.body.sessionExpiresAt).toBeGreaterThan(Date.now());

    const reused = await request(app).post('/api/auth/mobile/refresh').set('Origin', MOBILE_ORIGIN).send({ refreshToken: login.body.refreshToken });
    expect(reused.status).toBe(401);
    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${rotated.body.accessToken}`);
    expect(after.status).toBe(401);
  });
});

describe('mobile origin CORS', () => {
  it('answers preflight for both app origins, without credentials', async () => {
    for (const origin of [MOBILE_ORIGIN, ANDROID_ORIGIN]) {
      const response = await request(app).options('/api/push/devices').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('gives other origins no CORS headers and still blocks their writes', async () => {
    const preflight = await request(app).options('/api/push/devices').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const write = await request(app).post('/api/auth/mobile/login').set('Origin', 'https://evil.example').send({ identifier: 'x', password: 'y' });
    expect(write.status).toBe(403);
  });

  it('refuses a cookie-carrying write from the app origin', async () => {
    const web = await request(app).post('/api/auth/login').set('Origin', 'http://localhost:5173').send({ identifier: 'mobile.a@workforce.test', password: PASSWORD });
    const cookies = (web.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const response = await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Cookie', cookies)
      .send({ token: token('cookie'), platform: 'android' });
    expect(response.status).toBe(403);
  });
});

describe('device tokens and push delivery', () => {
  it('validates the token and platform', async () => {
    const login = await mobileLogin('mobile.a@workforce.test');
    const auth = `Bearer ${login.body.accessToken}`;
    const bad = await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', auth).send({ token: 'short', platform: 'android' });
    expect(bad.status).toBe(400);
    const badPlatform = await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', auth).send({ token: token('p'), platform: 'windows' });
    expect(badPlatform.status).toBe(400);
    const anonymous = await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).send({ token: token('anon'), platform: 'android' });
    expect(anonymous.status).toBe(401);
  });

  it('pushes a stored notification to the phone with deep link, channel and badge', async () => {
    const login = await mobileLogin('mobile.a@workforce.test');
    const phone = token('ananya');
    const reg = await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ token: phone, platform: 'android', deviceName: 'Pixel 8', appVersion: '1.0.0' });
    expect(reg.status).toBe(200);
    expect(reg.body.pushConfigured).toBe(true);

    const ananya = await employeeId('mobile.a@workforce.test');
    const id = await NotificationService.notify({ employeeIds: [ananya], type: 'task_assigned', title: 'New task: Stock count', body: 'Due Friday', link: '/tasks/42', priority: 'high' });
    await settle();
    const mine = sent.filter((m) => m.token === phone);
    expect(mine).toHaveLength(1);
    expect(mine[0].notification.title).toBe('New task: Stock count');
    expect(mine[0].data).toMatchObject({ notificationId: String(id), type: 'task_assigned', category: 'tasks', link: '/tasks/42' });
    expect(mine[0].android.priority).toBe('HIGH');
    expect(mine[0].android.notification.channel_id).toBe('urgent');
    const unread = await NotificationService.unreadCount(ananya);
    expect(mine[0].apns.payload.aps.badge).toBe(unread);
    const row = await db.queryOne<{ last_sent_at: string | null }>('SELECT last_sent_at FROM push_device_tokens WHERE token = ?', [phone]);
    expect(row?.last_sent_at).toBeTruthy();
  });

  it('replaces unsafe links with the notifications screen', async () => {
    const login = await mobileLogin('mobile.b@workforce.test');
    const phone = token('karthik');
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${login.body.accessToken}`).send({ token: phone, platform: 'ios' });
    await NotificationService.notify({ employeeIds: [await employeeId('mobile.b@workforce.test')], type: 'system', title: 'x', link: 'https://evil.example/phish' });
    await settle();
    expect(sent.find((m) => m.token === phone)?.data.link).toBe('/notifications');
  });

  it('respects muted categories but always sends security alerts', async () => {
    const login = await mobileLogin('mobile.c@workforce.test');
    const auth = `Bearer ${login.body.accessToken}`;
    const phone = token('mgr');
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', auth).send({ token: phone, platform: 'android' });

    const unknown = await request(app).put('/api/push/preferences').set('Origin', MOBILE_ORIGIN).set('Authorization', auth).send({ categories: { security: false } });
    expect(unknown.status).toBe(400);
    const prefs = await request(app).put('/api/push/preferences').set('Origin', MOBILE_ORIGIN).set('Authorization', auth).send({ categories: { chat: false } });
    expect(prefs.status).toBe(200);
    expect(prefs.body.categories.find((c: { key: string }) => c.key === 'chat').push).toBe(false);
    expect(prefs.body.categories.find((c: { key: string }) => c.key === 'tasks').push).toBe(true);

    const mgr = await employeeId('mobile.c@workforce.test');
    await NotificationService.notify({ employeeIds: [mgr], type: 'chat_message', title: 'Hi', link: '/chat?c=1' });
    await NotificationService.notify({ employeeIds: [mgr], type: 'security', title: 'New sign-in' });
    await settle();
    const mine = sent.filter((m) => m.token === phone);
    expect(mine.map((m) => m.data.category)).toEqual(['security']);
    // The muted notification is still stored in-app.
    expect((await NotificationService.list(mgr, { limit: 5 })).some((n) => n.title === 'Hi')).toBe(true);
  });

  it('deletes tokens that FCM reports as unregistered', async () => {
    const login = await mobileLogin('mobile.d@workforce.test');
    const dead = `${DEAD_TOKEN_PREFIX}${token('hr')}`;
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${login.body.accessToken}`).send({ token: dead, platform: 'android' });
    const stats = await PushService.deliver([await employeeId('mobile.d@workforce.test')], { notificationId: 1, type: 'leave', title: 'Leave approved', body: null, link: '/leave', priority: 'normal' });
    expect(stats.removed).toBe(1);
    expect(await db.queryOne('SELECT id FROM push_device_tokens WHERE token = ?', [dead])).toBeNull();
  });

  it('moves a token to whoever signs in on the phone next', async () => {
    const phone = token('shared');
    const first = await mobileLogin('mobile.a@workforce.test');
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${first.body.accessToken}`).send({ token: phone, platform: 'android' });
    const second = await mobileLogin('mobile.b@workforce.test');
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${second.body.accessToken}`).send({ token: phone, platform: 'android' });
    const owner = await db.queryOne<{ employee_id: number }>('SELECT employee_id FROM push_device_tokens WHERE token = ?', [phone]);
    expect(Number(owner?.employee_id)).toBe(await employeeId('mobile.b@workforce.test'));
    await NotificationService.notify({ employeeIds: [await employeeId('mobile.a@workforce.test')], type: 'task_update', title: 'for ananya only' });
    await settle();
    expect(sent.some((m) => m.token === phone)).toBe(false);
  });

  it('preserves notification registration by default while revoking login access', async () => {
    const login = await mobileLogin('mobile.b@workforce.test');
    const phone = token('keep-logout');
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${login.body.accessToken}`).send({ token: phone, platform: 'ios' });
    const out = await request(app).post('/api/auth/mobile/logout').set('Origin', MOBILE_ORIGIN).send({ refreshToken: login.body.refreshToken });
    expect(out.status).toBe(200);
    expect(await db.queryOne('SELECT keep_after_logout FROM push_device_tokens WHERE token = ?', [phone])).toMatchObject({ keep_after_logout: 1 });
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`)).status).toBe(401);
  });

  it('stops pushing when requested on logout, even with only the refresh token', async () => {
    const login = await mobileLogin('mobile.b@workforce.test');
    const phone = token('logout');
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${login.body.accessToken}`).send({ token: phone, platform: 'ios' });
    const out = await request(app).post('/api/auth/mobile/logout').set('Origin', MOBILE_ORIGIN).send({ refreshToken: login.body.refreshToken, keepNotifications: false });
    expect(out.status).toBe(200);
    expect(await db.queryOne('SELECT id FROM push_device_tokens WHERE token = ?', [phone])).toBeNull();
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(401);
    const refresh = await request(app).post('/api/auth/mobile/refresh').set('Origin', MOBILE_ORIGIN).send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('does not push to a phone whose session was revoked by an admin', async () => {
    const login = await mobileLogin('mobile.a@workforce.test');
    const phone = token('revoked');
    await request(app).post('/api/push/devices').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${login.body.accessToken}`).send({ token: phone, platform: 'android' });
    await db.execute("UPDATE employee_sessions s JOIN push_device_tokens t ON t.session_id = s.id SET s.revoked_at = NOW(3), s.revoked_reason = 'test' WHERE t.token = ?", [phone]);
    await NotificationService.notify({ employeeIds: [await employeeId('mobile.a@workforce.test')], type: 'task_update', title: 'after revoke' });
    await settle();
    expect(sent.some((m) => m.token === phone)).toBe(false);
  });

  it('only lets senders with notifications.send use /push/send', async () => {
    const employee = await mobileLogin('mobile.b@workforce.test');
    const response = await request(app).post('/api/push/send').set('Origin', MOBILE_ORIGIN).set('Authorization', `Bearer ${employee.body.accessToken}`)
      .send({ employeeIds: [1], title: 'spoof' });
    expect(response.status).toBe(403);
  });

  it('obtained a Google access token once and reused it', () => {
    expect(oauthCalls).toBe(1);
  });
});

describe('realtime with a mobile token', () => {
  it('accepts the access token in the socket handshake and rejects a bad one', async () => {
    const { initRealtime } = await import('../src/realtime/io.js');
    const { io } = await import('socket.io-client');
    const server = http.createServer(app);
    initRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await mobileLogin('mobile.a@workforce.test');

    const connect = (auth: { token: string }) => new Promise<string>((resolve) => {
      const socket = io(url, { transports: ['websocket'], auth, reconnection: false, timeout: 5000 });
      socket.on('connect', () => { socket.close(); resolve('connected'); });
      socket.on('connect_error', (error) => { socket.close(); resolve(error.message); });
    });
    try {
      expect(await connect({ token: login.body.accessToken })).toBe('connected');
      expect(await connect({ token: 'not-a-token' })).toBe('unauthorized');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
