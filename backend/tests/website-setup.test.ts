import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import request from 'supertest';
import nodemailer from 'nodemailer';
import type { Express } from 'express';

let app: Express;
let root: mysql.Connection;
let temporary: string;
let store: import('../src/lib/configStore.js').ConfigStore;
let closePool: () => Promise<void>;
const database = `wfm_setup_test_${Date.now()}`;
const username = `wfm_test_${crypto.randomBytes(5).toString('hex')}`;
const dbPassword = crypto.randomBytes(24).toString('hex');
const adminPassword = `Setup!${crypto.randomBytes(12).toString('hex')}A`;
let host: string;
let port: number;

beforeAll(async () => {
  const { config } = await import('../src/config.js');
  host = config.db.host; port = config.db.port;
  root = await mysql.createConnection({ ...config.db });
  await root.query(`CREATE DATABASE \`${database}\``);
  await root.query('CREATE USER ?@? IDENTIFIED BY ?', [username, 'localhost', dbPassword]);
  await root.query(`GRANT ALL ON \`${database}\`.* TO ?@?`, [username, 'localhost']);
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workforce-setup-'));
  vi.stubEnv('WORKFORCE_CONFIG_DIR', temporary);
  vi.stubEnv('WEB_SETUP_ENABLED', 'true');
  vi.resetModules();
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ verify: async () => true,
    sendMail: async () => ({ accepted: ['owner@business.test'], messageId: 'test-message' }), close: () => undefined } as never);
  const index = await import('../src/index.js');
  app = index.createApp();
  store = (await import('../src/lib/configStore.js')).configStore;
  closePool = (await import('../src/db/index.js')).closePool;
});

afterAll(async () => {
  await closePool?.();
  if (root) {
    // Only the uniquely named database/user created by this test are removed.
    await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await root.query('DROP USER IF EXISTS ?@?', [username, 'localhost']);
    await root.end();
  }
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('website-only installation', () => {
  it('gates setup behind a one-time server code and blocks normal APIs', async () => {
    expect((await request(app).get('/api/setup/status')).body.required).toBe(true);
    expect((await request(app).get('/api/me/dashboard')).body.code).toBe('setup_required');
    expect((await request(app).post('/api/setup/install').send({})).status).toBe(403);
  });
  it('installs an empty live database without demo records and disables setup afterwards', async () => {
    const code = store.setupCode();
    const response = await request(app).post('/api/setup/install').set('X-Setup-Code', code).send({
      appName: 'Test business', database: { host, port, user: username, password: dbPassword, database },
      smtp: { host: 'smtp.business.test', port: 587, secure: false, user: 'owner@business.test', password: 'fixture-smtp-password',
        fromName: 'Test business', fromEmail: 'owner@business.test', replyTo: 'owner@business.test' },
      admin: { name: 'Test Owner', email: 'owner@business.test', mobile: '9990001234', password: adminPassword, department: 'Operations', location: 'Office' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [rows] = await root.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS total FROM \`${database}\`.employees WHERE email = 'owner@business.test'`);
    expect(Number(rows[0].total)).toBe(1);
    for (const table of ['tasks', 'attendance', 'tickets', 'messages', 'meetings']) {
      const [counts] = await root.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS total FROM \`${database}\`.${table}`);
      expect(Number(counts[0].total)).toBe(0);
    }
    const raw = await fs.readFile(path.join(temporary, 'settings.enc'));
    expect(raw.toString()).not.toContain(dbPassword);
    expect(raw.toString()).not.toContain('fixture-smtp-password');
    expect(store.read().db?.database).toBe(database);
    expect((await request(app).get('/api/setup/status')).body.required).toBe(false);
    expect((await request(app).post('/api/setup/install').set('X-Setup-Code', code).send({})).status).toBe(404);
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ identifier: 'owner@business.test', password: adminPassword })).status).toBe(200);
    expect((await agent.get('/api/me/dashboard')).status).toBe(200);
    for (const route of ['/api/tasks', '/api/tickets', '/api/projects', '/api/meetings', '/api/leave', '/api/kpi/parameters', '/api/kpi', '/api/reports', '/api/employees/structure']) {
      const result = await agent.get(route);
      expect(result.status, route + ': ' + JSON.stringify(result.body)).toBe(200);
    }
    const department = await agent.post('/api/employees/departments').send({ name: 'Weaving', code: 'WEAVE' });
    expect(department.status).toBe(201);
    expect((await agent.post('/api/employees/designations').send({ title: 'Supervisor', departmentId: department.body.id, level: 8 })).status).toBe(201);
    expect((await agent.post('/api/employees/locations').send({ name: 'Factory', code: 'FACT', city: 'Coimbatore' })).status).toBe(201);
    expect((await agent.post('/api/admin/leave-types').send({ name: 'Annual Leave', code: 'ANNUAL', annualQuota: 12, isPaid: true, requiresDocument: false })).status).toBe(201);
    const { AuthService } = await import('../src/services/AuthService.js');
    const { hashOtp } = await import('../src/lib/crypto.js');
    await root.query(`INSERT INTO \`${database}\`.otp_verifications (identifier, channel, purpose, code_hash, expires_at) VALUES (?, 'email', 'race-test', ?, DATE_ADD(NOW(3), INTERVAL 10 MINUTE))`, ['owner@business.test', hashOtp('owner@business.test', '123456')]);
    const attempts = await Promise.allSettled([AuthService.consumeOtp('owner@business.test', 'race-test', '123456'), AuthService.consumeOtp('owner@business.test', 'race-test', '123456')]);
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const { sendOtpEmail } = await import('../src/lib/mailer.js');
    expect(await sendOtpEmail({ to: 'owner@business.test', name: 'Owner', code: '987654', purpose: 'login', expiresMinutes: 10 })).toBe(true);
    const [delivery] = await root.query<mysql.RowDataPacket[]>(`SELECT payload FROM \`${database}\`.email_deliveries WHERE template = 'otp' ORDER BY id DESC LIMIT 1`);
    expect(JSON.stringify(delivery)).not.toContain('987654');
    const settings = await agent.get('/api/admin/email/configuration');
    expect(settings.status).toBe(200);
    expect(settings.body.hasPassword).toBe(true);
    expect(settings.body.password).toBeUndefined();
    const smtp = { host: 'smtp.business.test', port: 587, secure: false, user: 'owner@business.test', password: '',
      fromName: 'Updated sender', fromEmail: 'owner@business.test', replyTo: 'owner@business.test' };
    const tested = await agent.post('/api/admin/email/configuration/test').send({ smtp, to: 'owner@business.test', otp: { expiryMinutes: 5, resendCooldownSeconds: 45, maxAttempts: 3 } });
    expect(tested.status).toBe(200);
    expect((await agent.put('/api/admin/email/configuration').send({ verification: tested.body.verification, receivedTest: true })).status).toBe(200);
    expect(store.read().otp?.expiryMinutes).toBe(5);
    expect((await agent.put('/api/admin/email/configuration').send({ verification: tested.body.verification, receivedTest: true })).status).toBe(400);
  }, 60000);
});
