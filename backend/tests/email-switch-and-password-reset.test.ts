/**
 * - Email master switch: when off, nothing is handed to SMTP; messages are recorded as
 *   'skipped' and the existing backlog is retired so it cannot flood out later.
 * - OTP codes are never returned to the browser outside tests / explicit local opt-in, and
 *   the forgot-password response does not reveal whether an account exists.
 * - HR/admin password reset: permission, role-level and self rules; the temporary
 *   password works, the old one stops working, and the user is flagged to change it.
 */
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, execute, queryOne } from '../src/db/index.js';
import { createApp } from '../src/index.js';
import { hashPassword } from '../src/lib/crypto.js';
import { EMAIL_OFF_REASON, enqueueEmail, processEmailQueue } from '../src/lib/mailer.js';
import { showOtpOnScreen } from '../src/services/AuthService.js';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'Reset-Test-2026!x';
const sfx = crypto.randomBytes(3).toString('hex');
const people: Record<string, { id: number; email: string }> = {};
let app: ReturnType<typeof createApp>;

async function createEmployee(key: string, roleSlug: string) {
  const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE slug = ?', [roleSlug]);
  const location = await queryOne<{ id: number }>("SELECT id FROM locations WHERE code = 'BEL'");
  const email = `rst.${key}.${sfx}@workforce.test`;
  const r = await execute(
    `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, employment_type, status,
                            joining_date, email_verified_at, must_change_password, mfa_required)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'full_time', 'active', CURDATE(), NOW(3), 0, 0)`,
    [`RST-${key}-${sfx}`.slice(0, 24), `Reset ${key} ${sfx}`, email, `7${String(crypto.randomInt(1e9)).padStart(9, '0')}`,
      await hashPassword(PASSWORD), role!.id, location!.id],
  );
  people[key] = { id: r.insertId, email };
}

async function signIn(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ identifier: email, password });
  return { agent, res };
}

beforeAll(async () => {
  app = createApp();
  await createEmployee('admin', 'hr_manager');
  await createEmployee('staff', 'employee');
  await createEmployee('peer', 'employee');
});

afterAll(async () => {
  config.email.sendingEnabled = true;
  for (const p of Object.values(people)) {
    await execute('DELETE FROM employee_sessions WHERE employee_id = ?', [p.id]).catch(() => undefined);
    await execute('DELETE FROM employees WHERE id = ?', [p.id]).catch(() => undefined);
  }
  await closePool();
});

describe('email master switch', () => {
  it('records new emails as skipped and retires the backlog when sending is off', async () => {
    config.email.sendingEnabled = true;
    const queuedId = await enqueueEmail({ to: `queued.${sfx}@workforce.test`, template: 'generic', subject: 'q', data: {}, dedupeKey: `q-${sfx}` });
    config.email.sendingEnabled = false;
    try {
      const offId = await enqueueEmail({ to: `off.${sfx}@workforce.test`, template: 'generic', subject: 'o', data: {}, dedupeKey: `o-${sfx}` });
      const off = await queryOne<{ status: string; last_error: string }>('SELECT status, last_error FROM email_deliveries WHERE id = ?', [offId]);
      expect(off).toEqual({ status: 'skipped', last_error: EMAIL_OFF_REASON });

      const result = await processEmailQueue(10);
      expect(result.sent).toBe(0);
      const backlog = await queryOne<{ status: string }>('SELECT status FROM email_deliveries WHERE id = ?', [queuedId]);
      expect(backlog?.status).toBe('skipped');
    } finally {
      config.email.sendingEnabled = true;
    }
  });
});

describe('OTP codes never reach the browser in production', () => {
  const saved = { env: process.env.NODE_ENV, flag: process.env.OTP_SHOW_CODES_ON_SCREEN };
  afterAll(() => {
    process.env.NODE_ENV = saved.env;
    if (saved.flag === undefined) delete process.env.OTP_SHOW_CODES_ON_SCREEN; else process.env.OTP_SHOW_CODES_ON_SCREEN = saved.flag;
  });

  it('only shows codes in tests or with explicit local opt-in', () => {
    process.env.NODE_ENV = 'production';
    process.env.OTP_SHOW_CODES_ON_SCREEN = 'true';
    expect(showOtpOnScreen()).toBe(false);
    process.env.NODE_ENV = 'development';
    delete process.env.OTP_SHOW_CODES_ON_SCREEN;
    expect(showOtpOnScreen()).toBe(false);
    process.env.OTP_SHOW_CODES_ON_SCREEN = 'true';
    expect(showOtpOnScreen()).toBe(true);
    process.env.NODE_ENV = saved.env;
  });

  it('gives the same forgot-password answer for real and unknown accounts', async () => {
    const unknown = await request(app).post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ identifier: `nobody.${sfx}@workforce.test` });
    expect(unknown.status).toBe(200);
    expect(unknown.body).not.toHaveProperty('delivered');
    const real = await request(app).post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ identifier: people.peer.email });
    expect(real.status).toBe(200);
    expect(real.body).not.toHaveProperty('delivered');
    expect(real.body.message).toBe(unknown.body.message);
  });
});

describe('HR/admin password reset', () => {
  it('lets an administrator issue a temporary password that must be changed', async () => {
    const admin = await signIn(people.admin.email, PASSWORD);
    expect(admin.res.status, JSON.stringify(admin.res.body)).toBe(200);
    const reset = await admin.agent.post(`/api/employees/${people.staff.id}/reset-password`).set('Origin', ORIGIN).send({});
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const temp = reset.body.temporaryPassword as string;
    expect(temp).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{14}$/);
    expect(reset.headers['cache-control']).toContain('no-store');

    const old = await signIn(people.staff.email, PASSWORD);
    expect(old.res.status).toBe(401);
    const fresh = await signIn(people.staff.email, temp);
    expect(fresh.res.status, JSON.stringify(fresh.res.body)).toBe(200);
    expect(fresh.res.body.user.temporaryPassword).toBe(true);

    const audit = await queryOne<{ n: number }>("SELECT COUNT(*) n FROM audit_logs WHERE action = 'password.admin_reset' AND entity_id = ?", [people.staff.id]);
    expect(Number(audit?.n)).toBeGreaterThan(0);
    const logged = await queryOne<{ n: number }>('SELECT COUNT(*) n FROM audit_logs WHERE after_data LIKE ? OR before_data LIKE ?', [`%${temp}%`, `%${temp}%`]);
    expect(Number(logged?.n)).toBe(0);
  });

  it('refuses employees without permission, self-resets and resets of higher roles', async () => {
    const peer = await signIn(people.peer.email, PASSWORD);
    expect(peer.res.status).toBe(200);
    const denied = await peer.agent.post(`/api/employees/${people.admin.id}/reset-password`).set('Origin', ORIGIN).send({});
    expect(denied.status).toBe(403);

    const admin = await signIn(people.admin.email, PASSWORD);
    const self = await admin.agent.post(`/api/employees/${people.admin.id}/reset-password`).set('Origin', ORIGIN).send({});
    expect(self.status).toBe(400);
    const superAdmin = await queryOne<{ id: number }>("SELECT e.id FROM employees e JOIN roles r ON r.id = e.role_id WHERE r.slug = 'super_admin' LIMIT 1");
    const up = await admin.agent.post(`/api/employees/${superAdmin!.id}/reset-password`).set('Origin', ORIGIN).send({});
    expect(up.status).toBe(403);
  });
});
