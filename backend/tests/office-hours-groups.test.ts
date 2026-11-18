import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { closePool, execute, queryOne } from '../src/db/index.js';

/** Office (login / logout) hours and the camelCase group API used by the Employees / Groups pages. */

const PASSWORD = 'Workforce@2026';
const ORIGIN = 'capacitor://localhost';
let app: Express;

async function bearer(identifier: string): Promise<string> {
  const res = await request(app).post('/api/auth/mobile/login').set('Origin', ORIGIN).send({ identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return `Bearer ${res.body.accessToken}`;
}

beforeAll(async () => {
  app = createApp();
  const template = await queryOne<{ password_hash: string; location_id: number | null }>(
    "SELECT password_hash, location_id FROM employees WHERE status = 'active' ORDER BY id LIMIT 1",
  );
  const role = await queryOne<{ id: number }>("SELECT id FROM roles WHERE slug = 'employee'");
  await execute(
    `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, status)
     VALUES ('OH-001', 'Office Hours Staff', 'oh.staff@workforce.test', '9000000101', ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE status = 'active'`,
    [template!.password_hash, role!.id, template!.location_id],
  );
});

afterAll(closePool);

describe('office hours', () => {
  it('lets everyone read them and only admins change them', async () => {
    const staff = await bearer('oh.staff@workforce.test');
    const read = await request(app).get('/api/attendance/office-hours').set('Authorization', staff);
    expect(read.status).toBe(200);
    expect(read.body.default).toMatchObject({ workStart: expect.stringMatching(/^\d\d:\d\d$/), workEnd: expect.stringMatching(/^\d\d:\d\d$/) });
    expect(read.body.canEdit).toBe(false);
    const denied = await request(app).put('/api/attendance/office-hours').set('Origin', ORIGIN).set('Authorization', staff)
      .send({ default: { workStart: '08:00', workEnd: '17:00', graceMinutes: 5 } });
    expect(denied.status).toBe(403);
  });

  it('saves company and per-location hours, validates them, and restores the default', async () => {
    const admin = await bearer('gagan.cb@bsctextiles.in');
    const start = await request(app).get('/api/attendance/office-hours').set('Authorization', admin);
    expect(start.body.canEdit).toBe(true);
    const loc = start.body.locations[0];

    const bad = await request(app).put('/api/attendance/office-hours').set('Origin', ORIGIN).set('Authorization', admin)
      .send({ default: { workStart: '18:00', workEnd: '09:00', graceMinutes: 5 } });
    expect(bad.status).toBe(400);

    const saved = await request(app).put('/api/attendance/office-hours').set('Origin', ORIGIN).set('Authorization', admin).send({
      default: { workStart: '09:00', workEnd: '18:00', graceMinutes: 15 },
      locations: [{ locationId: loc.locationId, workStart: '10:00', workEnd: '19:30', graceMinutes: 5 }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.default).toEqual({ workStart: '09:00', workEnd: '18:00', graceMinutes: 15 });
    const own = saved.body.locations.find((l: { locationId: number }) => l.locationId === loc.locationId);
    expect(own).toMatchObject({ workStart: '10:00', workEnd: '19:30', graceMinutes: 5, usesDefault: false });

    // The attendance screen uses the same hours.
    const today = await request(app).get('/api/attendance/today').set('Authorization', admin);
    expect(today.status).toBe(200);

    const reset = await request(app).put('/api/attendance/office-hours').set('Origin', ORIGIN).set('Authorization', admin)
      .send({ locations: [{ locationId: loc.locationId, inherit: true }] });
    expect(reset.status).toBe(200);
    expect(reset.body.locations.find((l: { locationId: number }) => l.locationId === loc.locationId)).toMatchObject({ workStart: '09:00', usesDefault: true });
    const audit = await queryOne("SELECT id FROM audit_logs WHERE action = 'office_hours.updated' ORDER BY id DESC LIMIT 1");
    expect(audit).not.toBeNull();
  });
});

describe('groups API shape', () => {
  it('returns items, group, members and summary in the shape the pages read', async () => {
    const admin = await bearer('gagan.cb@bsctextiles.in');
    const locations = await request(app).get('/api/attendance/office-hours').set('Authorization', admin);
    const locationId = locations.body.locations[0].locationId;
    const groupName = `Shape Test ${Date.now()}`;
    const created = await request(app).post('/api/groups').set('Origin', ORIGIN).set('Authorization', admin)
      .send({ name: groupName, code: `SHAPE${Date.now() % 100000}`, locationId });
    expect([200, 201]).toContain(created.status);

    const list = await request(app).get(`/api/groups?locationId=${locationId}`).set('Authorization', admin);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    const group = list.body.items.find((g: { name: string }) => g.name === groupName);
    expect(group).toMatchObject({ id: expect.any(Number), locationId, code: expect.any(String), isActive: true, memberCount: expect.any(Number) });

    const detail = await request(app).get(`/api/groups/${group.id}`).set('Authorization', admin);
    expect(detail.status).toBe(200);
    expect(detail.body.group).toMatchObject({ id: group.id, name: groupName, locationCode: expect.any(String) });
    expect(Array.isArray(detail.body.members)).toBe(true);

    const summary = await request(app).get('/api/groups/dashboard/summary').set('Authorization', admin);
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toMatchObject({ totalEmployees: expect.any(Number), presentEmployees: expect.any(Number) });
  });
});
