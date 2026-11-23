/**
 * End-to-end tests for the activity tracking engine over the real HTTP API
 * against the disposable test database: enrollment, device auth, heartbeat,
 * ingestion (dedup, validation, skew correction, offline replay), calculations,
 * dashboard, details, reports, settings, background worker and RBAC across
 * BEL, DAV and SHI.
 */
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, execute, query, queryOne } from '../src/db/index.js';
import { createApp } from '../src/index.js';
import { hashPassword } from '../src/lib/crypto.js';
import { localDate } from '../src/lib/dates.js';
import { invalidateTrackingSettings } from '../src/services/tracking/TrackingConfig.js';
import { TrackingWorker } from '../src/services/tracking/TrackingWorker.js';

type App = ReturnType<typeof createApp>;
let app: App;
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'Tracking-Test-2026!';
const suffix = crypto.randomBytes(3).toString('hex');
const people: Record<string, { id: number; email: string }> = {};
const agents: Record<string, ReturnType<typeof request.agent>> = {};

async function createEmployee(key: string, roleSlug: string, locationCode: string, managerKey?: string) {
  const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE slug = ?', [roleSlug]);
  const location = await queryOne<{ id: number }>('SELECT id FROM locations WHERE code = ?', [locationCode]);
  if (!role || !location) throw new Error(`Missing role ${roleSlug} or location ${locationCode}`);
  const email = `trk.${key}.${suffix}@workforce.test`;
  const result = await execute(
    `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, manager_id, employment_type, status,
                            joining_date, email_verified_at, must_change_password, mfa_required)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'full_time', 'active', CURDATE(), NOW(3), 0, 0)`,
    [`TRK-${key.toUpperCase()}-${suffix}`.slice(0, 24), `Tracking ${key} ${suffix}`, email, `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      await hashPassword(PASSWORD), role.id, location.id, managerKey ? people[managerKey].id : null],
  );
  people[key] = { id: result.insertId, email };
}

async function signIn(key: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: people[key].email, password: PASSWORD });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.otpRequired).toBeFalsy();
  agents[key] = agent;
  return agent;
}

async function enroll(adminKey: string, employeeKey: string, deviceUid: string, hostname: string) {
  const code = await agents[adminKey].post('/api/tracking/enrollment-codes').set('Origin', ORIGIN).send({ employeeId: people[employeeKey].id });
  expect(code.status, JSON.stringify(code.body)).toBe(200);
  const enrolled = await request(app).post('/api/tracking/agent/enroll').send({
    enrollmentCode: code.body.code, deviceUid, hostname, osName: 'Windows', osVersion: '10.0.26100', agentVersion: '2.0.0',
  });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
  return { token: enrolled.body.deviceToken as string, deviceId: enrolled.body.deviceId as number, code: code.body.code as string, body: enrolled.body };
}

const heartbeat = (token: string, body: Record<string, unknown> = {}) =>
  request(app).post('/api/tracking/agent/heartbeat').set('Authorization', `Bearer ${token}`)
    .send({ state: 'active', currentApp: 'Microsoft Excel', pendingEvents: 0, sentAt: new Date().toISOString(), ...body });

const upload = (token: string, events: unknown[], sentAt = new Date().toISOString(), batchId = crypto.randomUUID()) =>
  request(app).post('/api/tracking/agent/events').set('Authorization', `Bearer ${token}`).send({ batchId, sentAt, events });

const uid = () => crypto.randomBytes(32).toString('hex');
const at = (base: number, seconds: number) => new Date(base + seconds * 1000).toISOString();

let bel: { token: string; deviceId: number };
let dav: { token: string; deviceId: number };
let t0: number;
let workDate: string;
const S1 = `sess-${crypto.randomUUID()}`;

beforeAll(async () => {
  app = createApp();
  // Disposable test database: make sign-in deterministic for the accounts created below.
  await execute('UPDATE roles SET mfa_required = 0');
  await execute("UPDATE system_settings SET setting_value = 'false' WHERE setting_key = 'require_otp_on_login'").catch(() => undefined);
  await createEmployee('admin', 'super_admin', 'HQ');
  await createEmployee('davadmin', 'location_manager', 'DAV');
  await createEmployee('mgr', 'manager', 'DAV');
  await createEmployee('bel', 'employee', 'BEL');
  await createEmployee('dav', 'employee', 'DAV', 'mgr');
  await createEmployee('shi', 'employee', 'SHI');
  for (const key of ['admin', 'davadmin', 'mgr', 'bel', 'dav', 'shi']) await signIn(key);
  // Start 25 minutes ago, aligned to a whole second, so every interval is "today" or a known date.
  t0 = Math.floor((Date.now() - 25 * 60_000) / 1000) * 1000;
  workDate = localDate(new Date(t0));
});

afterAll(async () => {
  await closePool();
});

describe('enrollment and device authentication', () => {
  it('rejects agent calls without a valid device token', async () => {
    const missing = await request(app).post('/api/tracking/agent/heartbeat').send({ sentAt: new Date().toISOString() });
    expect(missing.status).toBe(401);
    const forged = await heartbeat(`bsct_${'0'.repeat(64)}`);
    expect(forged.status).toBe(401);
  });

  it('enrolls devices with single-use codes and maps them to the right employee', async () => {
    bel = await enroll('admin', 'bel', uid(), `BEL-PC-${suffix}`);
    dav = await enroll('admin', 'dav', uid(), `DAV-PC-${suffix}`);
    const row = await queryOne<{ employee_id: number; registered_via: string }>('SELECT employee_id, registered_via FROM employee_devices WHERE id = ?', [bel.deviceId]);
    expect(Number(row?.employee_id)).toBe(people.bel.id);
    expect(row?.registered_via).toBe('enrollment');
    const stored = await queryOne<{ token_hash: string }>('SELECT token_hash FROM device_registrations WHERE device_id = ? AND revoked_at IS NULL', [bel.deviceId]);
    expect(stored?.token_hash).toBe(crypto.createHash('sha256').update(bel.token).digest('hex'));
    expect(stored?.token_hash).not.toContain(bel.token);
  });

  it('refuses to reuse an enrollment code', async () => {
    const code = await agents.admin.post('/api/tracking/enrollment-codes').set('Origin', ORIGIN).send({ employeeId: people.shi.id });
    const first = await request(app).post('/api/tracking/agent/enroll').send({ enrollmentCode: code.body.code, deviceUid: uid(), hostname: 'SHI-TMP', agentVersion: '2.0.0' });
    expect(first.status).toBe(200);
    const again = await request(app).post('/api/tracking/agent/enroll').send({ enrollmentCode: code.body.code, deviceUid: uid(), hostname: 'SHI-TMP2', agentVersion: '2.0.0' });
    expect(again.status).toBe(400);
    // Clean up: SHI must stay "not installed" for later assertions.
    await agents.admin.post(`/api/tracking/devices/${first.body.deviceId}/revoke`).set('Origin', ORIGIN).send({});
  });

  it('only lets device managers create codes for other employees', async () => {
    const denied = await agents.davadmin.post('/api/tracking/enrollment-codes').set('Origin', ORIGIN).send({ employeeId: people.dav.id });
    expect(denied.status).toBe(403);
    const self = await agents.bel.post('/api/tracking/enrollment-codes').set('Origin', ORIGIN).send({ employeeId: people.bel.id });
    expect(self.status).toBe(403); // self-enrollment is off by default
  });
});

describe('heartbeat and ingestion', () => {
  it('rejects events until the monitoring notice is acknowledged', async () => {
    const res = await upload(bel.token, [{ id: `evt-${crypto.randomUUID()}`, type: 'activity', state: 'active', app: 'Excel', start: at(t0, 0), end: at(t0, 30) }]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(0);
    expect(res.body.rejected[0].reason).toBe('notice_not_acknowledged');
    const hb = await heartbeat(bel.token);
    expect(hb.body.noticeRequired).toBe(true);
    for (const token of [bel.token, dav.token]) {
      const ack = await request(app).post('/api/tracking/agent/acknowledge').set('Authorization', `Bearer ${token}`).send({});
      expect(ack.status).toBe(200);
    }
  });

  const belEvents = () => {
    const e = (type: string, s: number, extra: Record<string, unknown> = {}) => ({ id: `bel-${type}-${s}-${suffix}`, type, sessionId: S1, start: at(t0, s), ...extra });
    const act = (state: string, s: number, end: number, app: string | null, extra: Record<string, unknown> = {}) =>
      e('activity', s, { state, end: at(t0, end), ...(app ? { app, process: `${app.toLowerCase().replace(/\s/g, '')}.exe` } : {}), ...extra });
    return [
      e('session_start', 0), e('agent_start', 0),
      act('active', 0, 60, 'Microsoft Excel'),
      act('active', 60, 120, 'Google Chrome', { browser: 'Chrome', domain: 'https://www.mail.google.com/inbox?x=1' }),
      act('active', 120, 180, 'Google Chrome', { browser: 'Chrome', domain: 'mail.google.com' }),
      e('idle_start', 180),
      act('idle', 180, 480, 'Google Chrome', { browser: 'Chrome', domain: 'mail.google.com' }),
      e('idle_end', 480),
      act('active', 480, 540, 'Microsoft Excel'),
      e('lock', 540),
      act('locked', 540, 600, null),
      e('unlock', 600),
      act('active', 600, 660, 'Tally'),
      e('suspend', 670), e('resume', 895),
      act('active', 900, 960, 'Microsoft Excel'),
    ];
  };

  it('stores a realistic BEL day exactly once and reports duplicates on retry', async () => {
    const batchId = crypto.randomUUID();
    const events = belEvents();
    const first = await upload(bel.token, events, new Date().toISOString(), batchId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.rejected).toEqual([]);
    expect(first.body.accepted).toBe(events.length);
    const retry = await upload(bel.token, events, new Date().toISOString(), batchId);
    expect(retry.body.accepted).toBe(0);
    expect(retry.body.duplicates).toBe(events.length);
    const stored = await queryOne<{ n: number }>('SELECT COUNT(*) n FROM tracking_events WHERE device_id = ?', [bel.deviceId]);
    expect(Number(stored?.n)).toBe(events.length);
    const batch = await queryOne<{ attempts: number }>('SELECT attempts FROM tracking_sync_batches WHERE device_id = ? AND batch_id = ?', [bel.deviceId, batchId]);
    expect(Number(batch?.attempts)).toBe(2);
    const domain = await queryOne<{ domain: string }>("SELECT domain FROM tracking_events WHERE client_event_id = ?", [`bel-activity-60-${suffix}`]);
    expect(domain?.domain).toBe('mail.google.com'); // URL reduced to a hostname, path/query never stored
    const session = await queryOne<{ started_at: string; work_date: string }>('SELECT started_at, DATE_FORMAT(work_date, "%Y-%m-%d") work_date FROM tracking_sessions WHERE client_session_id = ?', [S1]);
    expect(session?.work_date).toBe(workDate);
  });

  it('rejects invalid events individually without blocking valid ones', async () => {
    const good = { id: `dav-ok-${suffix}`, type: 'activity', state: 'active', app: 'Microsoft Word', start: at(t0, 0), end: at(t0, 120) };
    const res = await upload(dav.token, [
      good,
      { id: `dav-future-${suffix}`, type: 'activity', state: 'active', app: 'Word', start: at(Date.now(), 3600), end: at(Date.now(), 3660) },
      { id: `dav-long-${suffix}`, type: 'activity', state: 'active', app: 'Word', start: at(t0, -4000), end: at(t0, 0) },
      { id: `dav-nostate-${suffix}`, type: 'activity', app: 'Word', start: at(t0, 0), end: at(t0, 10) },
      { id: 'bad id!', type: 'activity', state: 'active', start: at(t0, 0), end: at(t0, 10) },
      { id: `dav-keylog-${suffix}`, type: 'keystrokes', start: at(t0, 0) },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    const reasons = res.body.rejected.map((r: { reason: string }) => r.reason).sort();
    expect(reasons).toEqual(['future_timestamp', 'interval_too_long', 'invalid_event', 'invalid_event', 'missing_state'].sort());
  });

  it('corrects device clock skew and accepts offline replays', async () => {
    const skewMs = -10 * 60_000; // device clock 10 minutes behind
    const deviceNow = Date.now() + skewMs;
    const start = t0 + 1200 * 1000; // intended real time
    const res = await upload(dav.token, [{
      id: `dav-replay-${suffix}`, type: 'activity', state: 'active', app: 'Microsoft Word',
      start: new Date(start + skewMs).toISOString(), end: new Date(start + skewMs + 60_000).toISOString(),
    }], new Date(deviceNow).toISOString());
    expect(res.body.accepted).toBe(1);
    const row = await queryOne<{ started_at: string }>('SELECT started_at FROM tracking_events WHERE client_event_id = ?', [`dav-replay-${suffix}`]);
    const stored = Date.parse(`${row!.started_at.replace(' ', 'T')}Z`);
    expect(Math.abs(stored - start)).toBeLessThan(5_000);
  });

  it('heartbeat updates live status and returns configuration', async () => {
    const hb = await heartbeat(bel.token, { state: 'idle', currentApp: 'Google Chrome', currentBrowser: 'Chrome', currentDomain: 'mail.google.com', sessionId: S1, sessionStartedAt: at(t0, 0) });
    expect(hb.status).toBe(200);
    expect(hb.body.trackingEnabled).toBe(true);
    expect(hb.body.noticeRequired).toBe(false);
    expect(hb.body.config.idleThresholdSeconds).toBeGreaterThanOrEqual(60);
    const status = await queryOne<{ activity_state: string; current_domain: string }>('SELECT activity_state, current_domain FROM tracking_device_status WHERE device_id = ?', [bel.deviceId]);
    expect(status?.activity_state).toBe('idle');
    expect(status?.current_domain).toBe('mail.google.com');
    await heartbeat(dav.token, { state: 'active', currentApp: 'Microsoft Word' });
  });
});

describe('dashboard and employee details', () => {
  it('computes exact observed durations, apps, websites, gaps and timeline', async () => {
    const res = await agents.admin.get(`/api/tracking/employees/${people.bel.id}?date=${workDate}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body.summary;
    expect(s.activeSeconds).toBe(360);
    expect(s.idleSeconds).toBe(300);
    expect(s.lockedSeconds).toBe(60);
    expect(s.trackedSeconds).toBe(720);
    expect(s.observedSpanSeconds).toBe(960);
    expect(s.offlineSeconds).toBe(240);
    expect(s.completenessPercent).toBe(75);
    expect(s.sessionCount).toBe(1);
    expect(s.longestIdle.seconds).toBe(300);
    expect(s.longestActive.seconds).toBe(180);
    const apps = Object.fromEntries(res.body.applications.map((a: { app: string; activeSeconds: number; idleSeconds: number }) => [a.app, a]));
    expect(apps['Microsoft Excel'].activeSeconds).toBe(180);
    expect(apps['Google Chrome'].activeSeconds).toBe(120);
    expect(apps['Google Chrome'].idleSeconds).toBe(300);
    expect(apps.Tally.activeSeconds).toBe(60);
    expect(res.body.websites).toHaveLength(1);
    expect(res.body.websites[0]).toMatchObject({ domain: 'mail.google.com', browser: 'Chrome', activeSeconds: 120, visits: 1 });
    expect(res.body.gaps).toHaveLength(1);
    expect(res.body.gaps[0]).toMatchObject({ seconds: 240, reason: 'Computer asleep' });
    const types = res.body.timeline.map((t: { type: string }) => t.type);
    for (const type of ['session_start', 'idle_start', 'idle_end', 'lock', 'unlock', 'suspend', 'resume', 'app']) expect(types).toContain(type);
    const times = res.body.timeline.map((t: { at: string }) => Date.parse(t.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(res.body.devices[0]).toMatchObject({ deviceId: bel.deviceId, online: true, agentVersion: '2.0.0' });
  });

  it('lists employees with matching totals, location filters and status buckets', async () => {
    const all = await agents.admin.get(`/api/tracking/overview?date=${workDate}&pageSize=100&search=${suffix}`);
    expect(all.status).toBe(200);
    const byId = Object.fromEntries(all.body.items.map((i: { id: number }) => [i.id, i]));
    expect(byId[people.bel.id]).toMatchObject({ status: 'idle', activeSeconds: 360, idleSeconds: 300, locationCode: 'BEL' });
    expect(byId[people.dav.id]).toMatchObject({ status: 'active', activeSeconds: 180, locationCode: 'DAV' });
    expect(byId[people.shi.id]).toMatchObject({ status: 'not_installed', activeSeconds: 0, locationCode: 'SHI' });
    expect(byId[people.bel.id].loginAt).toBe(at(t0, 0));
    const davOnly = await agents.admin.get(`/api/tracking/overview?date=${workDate}&location=DAV&search=${suffix}`);
    expect(davOnly.body.items.every((i: { locationCode: string }) => i.locationCode === 'DAV')).toBe(true);
    const notInstalled = await agents.admin.get(`/api/tracking/overview?date=${workDate}&status=not_installed&search=${suffix}`);
    expect(notInstalled.body.items.map((i: { id: number }) => i.id)).toContain(people.shi.id);
    expect(notInstalled.body.items.map((i: { id: number }) => i.id)).not.toContain(people.bel.id);
    const sorted = await agents.admin.get(`/api/tracking/overview?date=${workDate}&sort=active&order=desc&search=${suffix}`);
    expect(sorted.body.items[0].id).toBe(people.bel.id);
  });

  it('records HRMS page usage from the web app without counting it as device time', async () => {
    const res = await agents.bel.post('/api/tracking/web/page').set('Origin', ORIGIN)
      .send({ module: 'Attendance', path: '/attendance', startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString(), activeSeconds: 60 });
    expect(res.body.recorded).toBe(true);
    const excluded = await agents.bel.post('/api/tracking/web/page').set('Origin', ORIGIN)
      .send({ module: 'Login', path: '/login', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), activeSeconds: 30 });
    expect(excluded.body.recorded).toBe(false);
  });
});

describe('role and location access control', () => {
  it('limits a location admin to their own location', async () => {
    const res = await agents.davadmin.get(`/api/tracking/overview?date=${workDate}&pageSize=100`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i: { locationCode: string }) => i.locationCode === 'DAV')).toBe(true);
    expect(res.body.locations.map((l: { code: string }) => l.code)).toEqual(['DAV']);
    expect((await agents.davadmin.get(`/api/tracking/employees/${people.bel.id}`)).status).toBe(403);
    expect((await agents.davadmin.get(`/api/tracking/employees/${people.dav.id}`)).status).toBe(200);
    expect((await agents.davadmin.get(`/api/tracking/reports/export?format=xlsx&location=BEL&from=${workDate}&to=${workDate}`)).status).toBe(403);
    expect((await agents.davadmin.get(`/api/tracking/reports/export?format=xlsx&employeeId=${people.bel.id}&from=${workDate}&to=${workDate}`)).status).toBe(403);
  });

  it('limits a manager to their reporting team', async () => {
    expect((await agents.mgr.get(`/api/tracking/employees/${people.dav.id}`)).status).toBe(200);
    expect((await agents.mgr.get(`/api/tracking/employees/${people.bel.id}`)).status).toBe(403);
    const list = await agents.mgr.get('/api/tracking/overview?pageSize=100');
    expect(list.body.items.map((i: { id: number }) => i.id).sort()).toEqual([people.mgr.id, people.dav.id].sort());
  });

  it('lets employees see only their own data', async () => {
    expect((await agents.bel.get('/api/tracking/overview')).status).toBe(403);
    expect((await agents.bel.get(`/api/tracking/employees/${people.bel.id}?date=${workDate}`)).status).toBe(200);
    expect((await agents.bel.get(`/api/tracking/employees/${people.dav.id}`)).status).toBe(403);
    expect((await agents.bel.get(`/api/tracking/reports/export?format=xlsx&from=${workDate}&to=${workDate}`)).status).toBe(403);
    expect((await agents.bel.get(`/api/tracking/reports/export?format=xlsx&employeeId=${people.bel.id}&from=${workDate}&to=${workDate}`)).status).toBe(200);
    expect((await agents.bel.get('/api/tracking/settings')).status).toBe(403);
    const devices = await agents.bel.get('/api/tracking/devices');
    expect(devices.body.devices.every((d: { employeeId: number }) => d.employeeId === people.bel.id)).toBe(true);
  });

  it('rejects unauthenticated web access', async () => {
    expect((await request(app).get('/api/tracking/overview')).status).toBe(401);
    expect((await request(app).get(`/api/tracking/employees/${people.bel.id}`)).status).toBe(401);
  });
});

describe('reports', () => {
  it('exports Excel that matches the dashboard figures', async () => {
    const res = await agents.admin.get(`/api/tracking/reports/export?format=xlsx&location=BEL&from=${workDate}&to=${workDate}`)
      .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body as Buffer);
    expect(book.worksheets.map((w) => w.name)).toEqual(['Report', 'Daily Summary', 'Applications', 'Websites', 'Sessions', 'Missing Data', 'Devices']);
    const summary = book.getWorksheet('Daily Summary')!;
    const header = (summary.getRow(1).values as string[]);
    let found = false;
    summary.eachRow((row, n) => {
      if (n === 1) return;
      const v = row.values as unknown[];
      if (v[header.indexOf('Employee ID')] === `TRK-BEL-${suffix}`) {
        found = true;
        expect(v[header.indexOf('Active (seconds)')]).toBe(360);
        expect(v[header.indexOf('Idle (seconds)')]).toBe(300);
        expect(v[header.indexOf('Data Completeness %')]).toBe(75);
      }
      expect(v[header.indexOf('Location')]).toBe('BEL');
    });
    expect(found).toBe(true);
    const gaps = book.getWorksheet('Missing Data')!;
    expect(gaps.rowCount).toBeGreaterThanOrEqual(2);
  });

  it('exports a PDF', async () => {
    const res = await agents.admin.get(`/api/tracking/reports/export?format=pdf&employeeId=${people.bel.id}&from=${workDate}&to=${workDate}`)
      .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('validates report ranges', async () => {
    expect((await agents.admin.get('/api/tracking/reports/export?format=xlsx&from=2026-01-01&to=2026-03-01')).status).toBe(400);
    expect((await agents.admin.get('/api/tracking/reports/export?format=xlsx&from=2026-03-02&to=2026-03-01')).status).toBe(400);
  });
});

describe('configuration', () => {
  it('lets only policy managers change settings and validates values', async () => {
    expect((await agents.davadmin.put('/api/tracking/settings').set('Origin', ORIGIN).send({ locationId: null, settings: { idleThresholdSeconds: 600 } })).status).toBe(403);
    expect((await agents.admin.put('/api/tracking/settings').set('Origin', ORIGIN).send({ locationId: null, settings: { idleThresholdSeconds: 5 } })).status).toBe(400);
    const ok = await agents.admin.put('/api/tracking/settings').set('Origin', ORIGIN).send({ locationId: null, settings: { idleThresholdSeconds: 240 } });
    expect(ok.status).toBe(200);
    expect(ok.body.global.idleThresholdSeconds).toBe(240);
    const hb = await heartbeat(bel.token);
    expect(hb.body.config.idleThresholdSeconds).toBe(240);
  });

  it('disabling tracking for a location pauses collection there only', async () => {
    const davLoc = await queryOne<{ id: number }>("SELECT id FROM locations WHERE code = 'DAV'");
    const off = await agents.admin.put('/api/tracking/settings').set('Origin', ORIGIN).send({ locationId: Number(davLoc!.id), settings: { trackingEnabled: false } });
    expect(off.status).toBe(200);
    expect((await heartbeat(dav.token)).body.trackingEnabled).toBe(false);
    expect((await heartbeat(bel.token)).body.trackingEnabled).toBe(true);
    const list = await agents.admin.get(`/api/tracking/overview?search=${suffix}&pageSize=100`);
    const davItem = list.body.items.find((i: { id: number }) => i.id === people.dav.id);
    expect(davItem.status).toBe('disabled');
    await agents.admin.put('/api/tracking/settings').set('Origin', ORIGIN).send({ locationId: Number(davLoc!.id), settings: { trackingEnabled: null } });
    invalidateTrackingSettings();
    expect((await heartbeat(dav.token)).body.trackingEnabled).toBe(true);
  });

  it('records configuration changes in the audit log', async () => {
    const row = await queryOne<{ n: number }>("SELECT COUNT(*) n FROM activity_audit_logs WHERE action = 'tracking.settings_updated' AND actor_id = ?", [people.admin.id]);
    expect(Number(row?.n)).toBeGreaterThanOrEqual(3);
  });
});

describe('background worker and device lifecycle', () => {
  it('marks silent devices offline, closes their session, and recovers on the next heartbeat', async () => {
    await execute('UPDATE tracking_device_status SET last_heartbeat_at = DATE_SUB(NOW(3), INTERVAL 15 MINUTE) WHERE device_id = ?', [bel.deviceId]);
    const changed = await TrackingWorker.sweepOffline();
    expect(changed).toBeGreaterThanOrEqual(1);
    const status = await queryOne<{ agent_state: string; connection_failures: number }>('SELECT agent_state, connection_failures FROM tracking_device_status WHERE device_id = ?', [bel.deviceId]);
    expect(status).toMatchObject({ agent_state: 'offline', connection_failures: 1 });
    const session = await queryOne<{ end_reason: string }>('SELECT end_reason FROM tracking_sessions WHERE client_session_id = ?', [S1]);
    expect(session?.end_reason).toBe('heartbeat_lost');
    const list = await agents.admin.get(`/api/tracking/overview?search=${suffix}`);
    expect(list.body.items.find((i: { id: number }) => i.id === people.bel.id).status).toBe('offline');

    await heartbeat(bel.token, { sessionId: S1 });
    const back = await queryOne<{ agent_state: string }>('SELECT agent_state FROM tracking_device_status WHERE device_id = ?', [bel.deviceId]);
    expect(back?.agent_state).toBe('running');
    const reopened = await queryOne<{ ended_at: string | null }>('SELECT ended_at FROM tracking_sessions WHERE client_session_id = ?', [S1]);
    expect(reopened?.ended_at).toBeNull();
    const events = await query<{ event_type: string }>("SELECT event_type FROM tracking_events WHERE device_id = ? AND source = 'system' ORDER BY id", [bel.deviceId]);
    expect(events.map((e) => e.event_type)).toEqual(['device_offline', 'device_online']);
  });

  it('reports alerts for offline/unregistered devices within scope', async () => {
    const res = await agents.admin.get('/api/tracking/alerts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.alerts)).toBe(true);
    expect((await agents.bel.get('/api/tracking/alerts')).status).toBe(403);
  });

  it('blocks reassignment of a device to another employee without an administrator code', async () => {
    const uidShared = uid();
    await enroll('admin', 'shi', uidShared, 'SHARED-PC');
    const shiDevice = await queryOne<{ id: number }>('SELECT id FROM employee_devices WHERE machine_fingerprint = ?', [`trk:${uidShared}`]);
    await agents.admin.put('/api/tracking/settings').set('Origin', ORIGIN).send({ locationId: null, settings: { selfEnrollmentEnabled: true } });
    const own = await agents.dav.post('/api/tracking/enrollment-codes').set('Origin', ORIGIN).send({ employeeId: people.dav.id });
    expect(own.status).toBe(200);
    const conflict = await request(app).post('/api/tracking/agent/enroll').send({ enrollmentCode: own.body.code, deviceUid: uidShared, hostname: 'SHARED-PC', agentVersion: '2.0.0' });
    expect(conflict.status).toBe(409);
    await agents.admin.put('/api/tracking/settings').set('Origin', ORIGIN).send({ locationId: null, settings: { selfEnrollmentEnabled: false } });
    await agents.admin.post(`/api/tracking/devices/${shiDevice!.id}/revoke`).set('Origin', ORIGIN).send({});
  });

  it('revoked devices are refused immediately', async () => {
    const res = await agents.admin.post(`/api/tracking/devices/${dav.deviceId}/revoke`).set('Origin', ORIGIN).send({});
    expect(res.status).toBe(200);
    expect((await heartbeat(dav.token)).status).toBe(401);
    expect((await upload(dav.token, [])).status).toBe(401);
  });

  it('retention dry run reports a plan without deleting', async () => {
    const before = await queryOne<{ n: number }>('SELECT COUNT(*) n FROM tracking_events');
    const res = await agents.admin.post('/api/tracking/retention').set('Origin', ORIGIN).send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    const after = await queryOne<{ n: number }>('SELECT COUNT(*) n FROM tracking_events');
    expect(after?.n).toBe(before?.n);
    expect((await agents.davadmin.post('/api/tracking/retention').set('Origin', ORIGIN).send({ dryRun: true })).status).toBe(403);
  });

  it('unenroll from the uninstaller retires the token', async () => {
    const res = await request(app).post('/api/tracking/agent/unenroll').set('Authorization', `Bearer ${bel.token}`).send({});
    expect(res.status).toBe(200);
    expect((await heartbeat(bel.token)).status).toBe(401);
  });
});
