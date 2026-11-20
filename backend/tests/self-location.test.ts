import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { closePool, execute, query, queryOne } from '../src/db/index.js';

/** Admins and managers can change their own primary location; ordinary employees cannot. */

const PASSWORD = 'Workforce@2026';
const ORIGIN = 'capacitor://localhost';
let app: Express;
let locations: Array<{ id: number }> = [];

async function bearer(identifier: string): Promise<string> {
  const res = await request(app).post('/api/auth/mobile/login').set('Origin', ORIGIN).send({ identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return `Bearer ${res.body.accessToken}`;
}

beforeAll(async () => {
  app = createApp();
  locations = await query<{ id: number }>('SELECT id FROM locations WHERE is_active = 1 ORDER BY id LIMIT 2');
  const template = await queryOne<{ password_hash: string }>("SELECT password_hash FROM employees WHERE status = 'active' ORDER BY id LIMIT 1");
  const staffRole = await queryOne<{ id: number }>("SELECT id FROM roles WHERE slug = 'employee'");
  const managerRole = await queryOne<{ id: number }>("SELECT id FROM roles WHERE slug = 'manager'");
  for (const [code, name, email, mobile, roleId] of [
    ['SL-001', 'Self Location Staff', 'sl.staff@workforce.test', '9000000201', staffRole!.id],
    ['SL-002', 'Self Location Manager', 'sl.manager@workforce.test', '9000000202', managerRole!.id],
  ] as const) {
    await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE status = 'active', role_id = VALUES(role_id), location_id = VALUES(location_id)`,
      [code, name, email, mobile, template!.password_hash, roleId, locations[0]!.id],
    );
  }
});

afterAll(closePool);

describe('self-service location change', () => {
  it('denies ordinary employees', async () => {
    const staff = await bearer('sl.staff@workforce.test');
    const info = await request(app).get('/api/employees/me/location').set('Authorization', staff);
    expect(info.status).toBe(200);
    expect(info.body.canChange).toBe(false);
    expect(info.body.locations).toEqual([]);
    const denied = await request(app).patch('/api/employees/me/location').set('Origin', ORIGIN).set('Authorization', staff)
      .send({ locationId: locations[1]?.id ?? locations[0]!.id });
    expect(denied.status).toBe(403);
  });

  it('lets a manager move their own location, audits it, and reflects it in the session', async () => {
    if (locations.length < 2) return;
    const manager = await bearer('sl.manager@workforce.test');
    const info = await request(app).get('/api/employees/me/location').set('Authorization', manager);
    expect(info.body.canChange).toBe(true);
    expect(info.body.currentLocationId).toBe(locations[0]!.id);
    expect(info.body.locations.map((l: { id: number }) => l.id)).toContain(locations[1]!.id);

    const changed = await request(app).patch('/api/employees/me/location').set('Origin', ORIGIN).set('Authorization', manager)
      .send({ locationId: locations[1]!.id, reason: 'Covering another store' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ ok: true, changed: true, location: { id: locations[1]!.id } });

    const me = await request(app).get('/api/auth/me').set('Authorization', manager);
    expect(me.status).toBe(200);
    expect((me.body.user ?? me.body).locationId).toBe(locations[1]!.id);

    const again = await request(app).patch('/api/employees/me/location').set('Origin', ORIGIN).set('Authorization', manager)
      .send({ locationId: locations[1]!.id });
    expect(again.body.changed).toBe(false);

    const audit = await queryOne("SELECT id FROM audit_logs WHERE action = 'employee.own_location_changed' ORDER BY id DESC LIMIT 1");
    expect(audit).not.toBeNull();
  });

  it('rejects unknown locations', async () => {
    const manager = await bearer('sl.manager@workforce.test');
    const bad = await request(app).patch('/api/employees/me/location').set('Origin', ORIGIN).set('Authorization', manager)
      .send({ locationId: 99999999 });
    expect(bad.status).toBe(400);
  });
});
