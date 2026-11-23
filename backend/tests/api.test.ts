import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { execute, query, queryOne, closePool } from '../src/db/index.js';
import { enqueueEmail, processEmailQueue } from '../src/lib/mailer.js';
import { today } from '../src/lib/dates.js';
import { AuthService } from '../src/services/AuthService.js';
import { config } from '../src/config.js';

let app: Express;

const PASSWORD = 'Workforce@2026';

async function login(identifier: string) {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/auth/login')
    .set('Origin', 'http://localhost:5173')
    .send({ identifier, password: PASSWORD });
  return { agent, response };
}

beforeAll(async () => {
  app = createApp();
  const health = await request(app).get('/api/health');
  expect(health.status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe('authentication & session security', () => {
  it('rejects unauthenticated dashboard access', async () => {
    const response = await request(app).get('/api/me/dashboard');
    expect(response.status).toBe(401);
  });

  it('rejects an invalid password without revealing whether the account exists', async () => {
    const { response } = await login('admin@workforce.test');
    expect(response.status).toBe(200);
    const bad = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ identifier: 'admin@workforce.test', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(String(bad.body.error)).not.toMatch(/employee|account|user/i);
  });

  it('returns a development OTP code when delivery is not configured', async () => {
    const result = await AuthService.requestPasswordReset('admin@workforce.test', '127.0.0.1');
    expect(result.delivered).toBe(false);
    expect(result.devCode).toMatch(/^\d{6}$/);
  });

  it('rejects state-changing requests from a foreign origin', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ identifier: 'admin@workforce.test', password: PASSWORD });
    expect(response.status).toBe(403);
  });

  it('issues a session that can be revoked by logging out', async () => {
    const { agent, response } = await login('admin@workforce.test');
    expect(response.status).toBe(200);
    expect(response.body.user.permissions.length).toBeGreaterThan(10);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    await agent.post('/api/auth/logout');
    const afterLogout = await agent.get('/api/auth/me');
    expect(afterLogout.status).toBe(401);
  });
});

describe('role-based access control and hierarchy scope', () => {
  it('blocks an employee from administration endpoints', async () => {
    const { agent, response } = await login('ananya.rao@workforce.test');
    expect(response.status).toBe(200);
    expect((await agent.get('/api/admin/settings')).status).toBe(403);
    expect((await agent.get('/api/admin/audit')).status).toBe(403);
    expect((await agent.get('/api/analytics/overview')).status).toBe(403);
    expect((await agent.get('/api/employees/roles')).status).toBe(200);
  });

  it('limits a manager to their own reporting subtree when listing employees', async () => {
    const admin = await login('admin@workforce.test');
    const hierarchy = await admin.agent.get('/api/employees/hierarchy');
    const nodes = hierarchy.body.employees as { id: number; managerId: number | null }[];
    const manager = await login('it.manager@workforce.test');
    expect(manager.response.status).toBe(200);
    const managerId = manager.response.body.user.id as number;

    const subtree = new Set<number>([managerId]);
    let added = true;
    while (added) {
      added = false;
      for (const node of nodes) {
        if (node.managerId && subtree.has(node.managerId) && !subtree.has(node.id)) {
          subtree.add(node.id);
          added = true;
        }
      }
    }

    const list = await manager.agent.get('/api/employees?pageSize=100');
    expect(list.status).toBe(200);
    const ids = (list.body.items as { id: number }[]).map((item) => item.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(subtree.has(id)).toBe(true);
  });

  it('prevents a manager from allocating work outside the reporting structure', async () => {
    const manager = await login('hr.manager@workforce.test');
    const outsider = await queryOne<{ id: number }>(
      "SELECT id FROM employees WHERE department_id = (SELECT id FROM departments WHERE code = 'IT') AND status = 'active' LIMIT 1",
    );
    const response = await manager.agent.post('/api/tasks').send({
      title: 'Unauthorised cross-department allocation',
      assigneeIds: [outsider?.id ?? 0],
      priority: 'low',
    });
    expect(response.status).toBe(403);
  });
});

describe('employee activity monitoring', () => {
  const activityDeviceFingerprint = `automated-activity-device-${Date.now()}`;
  it('runs the consented session, ingestion, daily summary and weekly score workflow', async () => {
    const { agent, response } = await login('admin@workforce.test');
    expect(response.status).toBe(200);

    await agent.post('/api/attendance/check-in').send({});
    const consent = await agent.post('/api/activity/consent').send({});
    expect(consent.status).toBe(200);
    expect(consent.body.acknowledged).toBe(true);

    const device = await agent.post('/api/activity/devices').send({
      deviceName: 'Automated test device',
      osName: 'Windows',
      machineFingerprint: activityDeviceFingerprint,
    });
    expect([200, 201]).toContain(device.status);
    const token = String(device.body.token);
    expect(token.startsWith('wfm_dev_')).toBe(true);

    const start = await agent.post('/api/activity/sessions/start').send({ deviceId: device.body.deviceId });
    expect(start.status).toBe(201);
    expect(start.body.sessionId).toBeTruthy();

    const runId = Date.now().toString(36);
    const events = [
      { type: 'app', clientEventId: `test-app-1-${runId}`, appName: 'Visual Studio Code', appCategory: 'Development', processName: 'code.exe', processId: 4242, startedAt: new Date(Date.now() - 15 * 60000).toISOString(), endedAt: new Date().toISOString(), activeSeconds: 900 },
      { type: 'app', clientEventId: `test-app-2-${runId}`, appName: 'Google Chrome', appCategory: 'Browser', activeSeconds: 600 },
      { type: 'app', clientEventId: `test-app-blocked-${runId}`, appName: 'KeePass', appCategory: 'Other', activeSeconds: 300 },
      { type: 'browser', clientEventId: `test-web-1-${runId}`, browser: 'Google Chrome', domain: 'github.com', category: 'Development', activeSeconds: 300 },
      { type: 'browser', clientEventId: `test-web-blocked-${runId}`, browser: 'Google Chrome', domain: 'example.com', activeSeconds: 120 },
      { type: 'module', clientEventId: `test-module-1-${runId}`, module: 'Task Management', pagePath: '/tasks', activeSeconds: 120 },
      { type: 'work', clientEventId: `test-work-1-${runId}`, title: 'Automated worker completed API integration testing' },
      { type: 'error', clientEventId: `test-error-1-${runId}`, errorCategory: 'Application crash', application: 'Visual Studio Code', errorCode: 'TEST_CRASH', severity: 'medium', description: 'Automated test crash while saving a record', diagnostic: { stack: 'at save (test.js:1)', password: 'never-store' } },
    ];
    const ingest = await request(app)
      .post('/api/activity/agent/events')
      .set('X-Device-Token', token)
      .send({ events });
    expect(ingest.status).toBe(200);
    expect(ingest.body.accepted).toBeGreaterThanOrEqual(5);
    expect(ingest.body.rejected).toBeGreaterThanOrEqual(2);
    const processRow = await queryOne<{ process_id: number }>(
      "SELECT process_id FROM application_usage_logs WHERE client_event_id = ?",
      [`test-app-1-${runId}`],
    );
    expect(Number(processRow?.process_id)).toBe(4242);

    const repeated = await request(app)
      .post('/api/activity/agent/events')
      .set('X-Device-Token', token)
      .send({ events });
    expect(repeated.body.accepted).toBe(0);
    expect(repeated.body.duplicates).toBeGreaterThanOrEqual(5);

    const denied = await request(app).post('/api/activity/agent/events').set('X-Device-Token', 'wfm_dev_invalid').send({ events });
    expect(denied.status).toBe(401);

    const dashboard = await agent.get('/api/activity/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.session).toBeTruthy();
    expect(dashboard.body.daily.activeMinutes).toBeGreaterThanOrEqual(20);
    expect(dashboard.body.daily.appBreakdown.some((item: { app: string }) => item.app === 'Visual Studio Code')).toBe(true);
    expect(dashboard.body.daily.keyActivities.length).toBeGreaterThan(0);

    const errors = await agent.get('/api/activity/errors');
    expect(errors.status).toBe(200);
    const incident = errors.body.errors.find((row: { errorCode: string }) => row.errorCode === 'TEST_CRASH');
    expect(incident).toBeTruthy();
    const ticket = await agent.post(`/api/activity/errors/${incident.incidentId}/ticket`).send({});
    expect(ticket.status).toBe(201);
    expect(ticket.body.ticketId).toBeTruthy();

    const weekly = await agent.post('/api/activity/weekly/generate').send({});
    expect(weekly.status).toBe(200);
    expect(weekly.body.status).toBe('preliminary');
    expect(weekly.body.metrics.applicationUsageNote).toContain('contextual');

    const month = new Date().toISOString().slice(0, 7);
    const monthly = await agent.get(`/api/activity/monthly?month=${month}`);
    expect(monthly.status).toBe(200);
    expect(monthly.body.self.totals.activeMinutes).toBeGreaterThanOrEqual(20);
    expect(monthly.body.self.totals.tasksCompleted).toBeGreaterThanOrEqual(0);
    expect(monthly.body.self.applications.some((item: { app: string }) => item.app === 'Visual Studio Code')).toBe(true);
    expect(Array.isArray(monthly.body.team?.employees)).toBe(true);

    const retention = await agent.post('/api/activity/retention/purge').send({ dryRun: true });
    expect(retention.status).toBe(200);
    expect(retention.body.dryRun).toBe(true);
    expect(retention.body.retentionDays).toBeGreaterThanOrEqual(1);

    const future = await request(app)
      .post('/api/activity/agent/events')
      .set('X-Device-Token', token)
      .send({ events: [{ type: 'app', clientEventId: `future-${runId}`, appName: 'Visual Studio Code', activeSeconds: 60, startedAt: '2099-01-01T00:00:00.000Z' }] });
    expect(future.status).toBe(200);
    expect(future.body.rejected).toBeGreaterThanOrEqual(1);

    const daily = await agent.post('/api/activity/daily/submit').send({ notes: 'Automated verification notes' });
    expect(daily.status).toBe(200);
    expect(daily.body.status).toBe('submitted');
    const selfReview = await agent.post(`/api/activity/daily/${daily.body.id}/review`).send({ decision: 'approved', note: 'Verified' });
    expect(selfReview.status).toBe(403);

    const stop = await agent.post('/api/activity/sessions/stop').send({});
    expect(stop.status).toBe(200);

    const offlineHealth = await request(app)
      .post('/api/activity/agent/health')
      .set('X-Device-Token', token)
      .send({ cpuPercent: 10, memoryPercent: 40, diskFreeMb: 50000 });
    expect(offlineHealth.status).toBe(200);
    expect(offlineHealth.body.sessionId).toBeNull();
  });

  it('monitors two employees concurrently without mixing their events', async () => {
    const ananya = await queryOne<{ id: number }>(
      "SELECT id FROM employees WHERE email = 'ananya.rao@workforce.test'",
    );
    expect(ananya?.id).toBeTruthy();
    const existingAttendance = await queryOne<{ id: number }>(
      'SELECT id FROM attendance WHERE employee_id = ? AND work_date = CURDATE()',
      [ananya!.id],
    );
    if (!existingAttendance) {
      await execute(
        "INSERT INTO attendance (employee_id, work_date, check_in_at, status, source) VALUES (?, CURDATE(), NOW(3), 'present', 'test')",
        [ananya!.id],
      );
    }
    try {
      const employee = await login('ananya.rao@workforce.test');
      await employee.agent.post('/api/activity/consent').send({});
      const employeeDevice = await employee.agent.post('/api/activity/devices').send({
        deviceName: 'Concurrent employee device', osName: 'Windows', machineFingerprint: 'concurrent-employee-device-0001',
      });
      const employeeStart = await employee.agent.post('/api/activity/sessions/start').send({ deviceId: employeeDevice.body.deviceId });
      expect([200, 201]).toContain(employeeStart.status);

      const admin = await login('admin@workforce.test');
      const adminDevice = await admin.agent.post('/api/activity/devices').send({
        deviceName: 'Concurrent admin device', osName: 'Windows', machineFingerprint: 'concurrent-admin-device-0001',
      });
      const adminStart = await admin.agent.post('/api/activity/sessions/start').send({ deviceId: adminDevice.body.deviceId });
      expect([200, 201]).toContain(adminStart.status);

      const runId = Date.now().toString(36);
      const [employeeIngest, adminIngest] = await Promise.all([
        request(app).post('/api/activity/agent/events').set('X-Device-Token', String(employeeDevice.body.token)).send({
          events: [{ type: 'app', clientEventId: `concurrent-employee-${runId}`, appName: 'Visual Studio Code', appCategory: 'Development', activeSeconds: 300 }],
        }),
        request(app).post('/api/activity/agent/events').set('X-Device-Token', String(adminDevice.body.token)).send({
          events: [{ type: 'app', clientEventId: `concurrent-admin-${runId}`, appName: 'Visual Studio Code', appCategory: 'Development', activeSeconds: 300 }],
        }),
      ]);
      expect(employeeIngest.body.accepted).toBe(1);
      expect(adminIngest.body.accepted).toBe(1);

      const employeeDashboard = await employee.agent.get('/api/activity/dashboard');
      const adminDashboard = await admin.agent.get('/api/activity/dashboard');
      expect(employeeDashboard.body.session.id).not.toBe(adminDashboard.body.session.id);
      expect(employeeDashboard.body.daily.appBreakdown.some((row: { app: string }) => row.app === 'Visual Studio Code')).toBe(true);
      expect(adminDashboard.body.daily.appBreakdown.some((row: { app: string }) => row.app === 'Google Chrome')).toBe(true);

      await employee.agent.post('/api/activity/sessions/stop').send({});
      await admin.agent.post('/api/activity/sessions/stop').send({});
    } finally {
      if (!existingAttendance) {
        await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date = CURDATE()', [ananya!.id]);
      }
    }
  });

  it('enforces activity permissions and device ownership', async () => {
    const employee = await login('ananya.rao@workforce.test');
    const team = await employee.agent.get('/api/activity/team');
    expect(team.status).toBe(403);
    const organisation = await employee.agent.get('/api/activity/admin');
    expect(organisation.status).toBe(403);
    const collision = await employee.agent.post('/api/activity/devices').send({
      deviceName: 'Conflicting device',
      osName: 'Windows',
      machineFingerprint: activityDeviceFingerprint,
    });
    expect(collision.status).toBe(409);
  });

  it('blocks monitoring when attendance has not started', async () => {
    const ananya = await queryOne<{ id: number }>("SELECT id FROM employees WHERE email = 'ananya.rao@workforce.test'");
    await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date = CURDATE()', [Number(ananya?.id ?? 0)]);
    const { agent } = await login('ananya.rao@workforce.test');
    const consent = await agent.post('/api/activity/consent').send({});
    expect(consent.status).toBe(200);
    const device = await agent.post('/api/activity/devices').send({
      deviceName: 'Unattended device',
      osName: 'Windows',
      machineFingerprint: 'automated-activity-device-0002',
    });
    const start = await agent.post('/api/activity/sessions/start').send({ deviceId: device.body.deviceId });
    expect([400, 409]).toContain(start.status);
  });
});

describe('profile photo upload', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('uploads, serves and removes a profile photo', async () => {
    const { agent, response } = await login('admin@workforce.test');
    expect(response.status).toBe(200);

    const upload = await agent.post('/api/me/photo').attach('file', png, { filename: 'avatar.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    const photoUrl = String(upload.body.photoUrl);
    expect(photoUrl).toMatch(/^\/api\/files\/\d+\?v=\d+$/);

    const me = await agent.get('/api/auth/me');
    expect(me.body.user.photoUrl).toBe(photoUrl);

    const image = await agent.get(photoUrl.split('?')[0]);
    expect(image.status).toBe(200);
    expect(String(image.headers['content-type'])).toContain('image/png');

    const disguised = await agent
      .post('/api/me/photo')
      .attach('file', Buffer.from('this is not an image'), { filename: 'avatar.png', contentType: 'image/png' });
    expect(disguised.status).toBe(400);

    const removal = await agent.delete('/api/me/photo');
    expect(removal.status).toBe(200);
    expect(removal.body.photoUrl).toBeNull();
    expect((await agent.get(photoUrl.split('?')[0])).status).toBe(404);
  });
});

describe('attendance timer and duplicate prevention', () => {
  let adminId = 0;

  beforeAll(async () => {
    const admin = await queryOne<{ id: number }>("SELECT id FROM employees WHERE email = 'admin@workforce.test'");
    adminId = Number(admin?.id ?? 0);
    await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date = ?', [adminId, today()]);
    await execute(
      "INSERT INTO attendance (employee_id, work_date, check_in_at, status) VALUES (?, ?, NOW(3) - INTERVAL 45 MINUTE, 'present')",
      [adminId, today()],
    );
  });

  afterAll(async () => {
    await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date = ?', [adminId, today()]);
  });

  it('refuses a second check-in while a session is already open', async () => {
    const { agent, response } = await login('admin@workforce.test');
    expect(response.status).toBe(200);
    const again = await agent.post('/api/attendance/check-in').send({});
    expect(again.status).toBe(409);
    const state = await agent.get('/api/attendance/today');
    expect(state.status).toBe(200);
    expect(state.body.checkInAt).toBeTruthy();
    expect(state.body.checkOutAt).toBeNull();
    expect(state.body.serverNow).toBeTruthy();
  });

  it('resumes the elapsed timer from persisted server timestamps', async () => {
    const { agent } = await login('admin@workforce.test');
    const state = await agent.get('/api/attendance/today');
    const serverNow = new Date(state.body.serverNow).getTime();
    const checkIn = new Date(state.body.checkInAt).getTime();
    expect(Math.abs(state.body.elapsedSeconds - Math.floor((serverNow - checkIn) / 1000))).toBeLessThan(120);
  });

  it('closes the day and records the worked minutes', async () => {
    const { agent } = await login('admin@workforce.test');
    const response = await agent.post('/api/attendance/check-out').send({});
    expect(response.status).toBe(200);
    expect(response.body.checkOutAt).toBeTruthy();
    expect(response.body.totalMinutes).toBeGreaterThanOrEqual(44);
    expect(response.body.canCheckOut).toBe(false);
  });

  it('returns a numeric attendance summary with a real percentage', async () => {
    const { agent } = await login('admin@workforce.test');
    const summary = await agent.get('/api/attendance/summary?period=2026-11');
    expect(summary.status).toBe(200);
    expect(summary.body.presentDays).toBeGreaterThan(0);
    expect(summary.body.attendancePercent).toBeGreaterThan(0);
    expect(summary.body.attendancePercent).toBeLessThanOrEqual(100);
  });
});

describe('task allocation workflow', () => {
  it('runs allocate → accept → start → submit → approve with persistence', async () => {
    const manager = await login('it.manager@workforce.test');
    expect(manager.response.status).toBe(200);
    const picker = await manager.agent.get('/api/tasks/meta/assignable');
    expect(picker.status).toBe(200);
    const assignee = (picker.body.employees as { id: number; email?: string; full_name: string }[])[0];
    expect(assignee).toBeDefined();

    const dueDate = new Date().toISOString().slice(0, 10);
    const created = await manager.agent.post('/api/tasks').send({
      title: 'Integration test task — verify assignment lifecycle',
      description: 'Created by the automated test suite and removed afterwards.',
      assigneeIds: [assignee.id],
      priority: 'medium',
      dueDate,
      estimatedMinutes: 60,
      subtasks: ['First checklist item'],
    });
    expect(created.status).toBe(201);
    const taskId = created.body.id ?? created.body.taskId;
    expect(taskId).toBeTruthy();

    const employeeRow = await queryOne<{ email: string }>('SELECT email FROM employees WHERE id = ?', [assignee.id]);
    const employee = await login(employeeRow!.email);
    expect(employee.response.status).toBe(200);

    const detail = await employee.agent.get(`/api/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.assigneeIds).toContain(assignee.id);

    expect((await employee.agent.post(`/api/tasks/${taskId}/action`).send({ action: 'accept' })).status).toBe(200);
    expect((await employee.agent.post(`/api/tasks/${taskId}/action`).send({ action: 'start' })).status).toBe(200);
    expect(
      (await employee.agent.post(`/api/tasks/${taskId}/action`).send({ action: 'progress', progress: 60, note: 'Halfway' })).status,
    ).toBe(200);
    expect(
      (await employee.agent.post(`/api/tasks/${taskId}/action`).send({ action: 'submit', completionNote: 'Completed in the test run' })).status,
    ).toBe(200);

    const pending = await manager.agent.get(`/api/tasks/${taskId}`);
    expect(pending.body.status).toBe('pending_approval');
    expect((await manager.agent.post(`/api/tasks/${taskId}/action`).send({ action: 'approve' })).status).toBe(200);

    const approved = await manager.agent.get(`/api/tasks/${taskId}`);
    expect(approved.body.status).toBe('completed');
    expect(approved.body.progress).toBe(100);
    expect(approved.body.approvedAt).toBeTruthy();

    await execute('DELETE FROM task_comments WHERE task_id = ?', [taskId]);
    await execute('DELETE FROM task_subtasks WHERE task_id = ?', [taskId]);
    await execute('DELETE FROM task_time_logs WHERE task_id = ?', [taskId]);
    await execute('DELETE FROM task_assignments WHERE task_id = ?', [taskId]);
    await execute('DELETE FROM tasks WHERE id = ?', [taskId]);
  });

  it('rejects an invalid workflow transition', async () => {
    const employee = await login('ananya.rao@workforce.test');
    const tasks = await employee.agent.get('/api/tasks?view=mine&pageSize=10');
    expect(tasks.status).toBe(200);
    const task = (tasks.body.items as { id: number; status: string }[]).find((item) => item.status === 'completed');
    if (!task) return;
    const response = await employee.agent.post(`/api/tasks/${task.id}/action`).send({ action: 'approve' });
    expect([403, 409]).toContain(response.status);
  });
});

describe('KPI configuration and transparency', () => {
  it('exposes weighted parameters totalling 100%', async () => {
    const { agent } = await login('admin@workforce.test');
    const response = await agent.get('/api/kpi/parameters');
    expect(response.status).toBe(200);
    const total = (response.body.parameters as { weight: number }[]).reduce((sum, item) => sum + Number(item.weight), 0);
    expect(total).toBe(100);
  });

  it('returns per-parameter scores and excludes unavailable metrics', async () => {
    const { agent } = await login('admin@workforce.test');
    const list = await agent.get('/api/kpi?period=2026-10');
    expect(list.status).toBe(200);
    const record = (list.body.items as { id: number }[])[0];
    expect(record).toBeDefined();
    const detail = await agent.get(`/api/kpi/${record.id}`);
    expect(detail.status).toBe(200);
    const scores = detail.body.scores as { available: boolean; weight: number; weighted: number }[];
    expect(scores.length).toBeGreaterThan(0);
    for (const score of scores) {
      if (!score.available) expect(score.weighted).toBe(0);
    }
    expect(detail.body.totalScore).toBeGreaterThanOrEqual(0);
    expect(detail.body.totalScore).toBeLessThanOrEqual(100);
  });
});

describe('daily reports, tickets and chat', () => {
  it('returns live task suggestions for the daily report form', async () => {
    const { agent } = await login('ananya.rao@workforce.test');
    const response = await agent.get('/api/reports/suggestions');
    expect(response.status).toBe(200);
    expect(typeof response.body.tasksCompleted).toBe('number');
    expect(response.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows employees only their own or assigned tickets', async () => {
    const { agent, response } = await login('ananya.rao@workforce.test');
    const userId = response.body.user.id as number;
    const list = await agent.get('/api/tickets?pageSize=50');
    expect(list.status).toBe(200);
    for (const ticket of list.body.items as { requesterId: number; assigneeId: number | null }[]) {
      expect([ticket.requesterId, ticket.assigneeId]).toContain(userId);
    }
  });

  it('persists ordered messages, serves attachments and hides a deleted chat only for the caller', async () => {
    const admin = await login('admin@workforce.test');
    const employee = await login('ananya.rao@workforce.test');
    const employeeId = employee.response.body.user.id as number;
    const runId = Date.now().toString(36);

    const conversation = await admin.agent.post('/api/chat/conversations/direct').send({ employeeId });
    expect(conversation.status).toBe(201);
    const conversationId = Number(conversation.body.id);

    const first = await admin.agent.post(`/api/chat/conversations/${conversationId}/messages`).send({
      body: `first message ${runId}`, clientId: `chat-first-${runId}`,
    });
    expect(first.status).toBe(201);
    const second = await admin.agent.post(`/api/chat/conversations/${conversationId}/messages`).send({
      body: `second message\nwith a new line ${runId} 🙂`, clientId: `chat-second-${runId}`,
    });
    expect(second.status).toBe(201);
    expect(Number(second.body.id)).toBeGreaterThan(Number(first.body.id));

    const duplicate = await admin.agent.post(`/api/chat/conversations/${conversationId}/messages`).send({
      body: `first message ${runId}`, clientId: `chat-first-${runId}`,
    });
    expect(duplicate.status).toBe(201);
    expect(Number(duplicate.body.id)).toBe(Number(first.body.id));

    const reply = await employee.agent.post(`/api/chat/conversations/${conversationId}/messages`).send({
      body: `reply ${runId}`, clientId: `chat-reply-${runId}`, replyToId: Number(first.body.id),
    });
    expect(reply.status).toBe(201);

    const listed = await employee.agent.get(`/api/chat/conversations/${conversationId}/messages?limit=100`);
    expect(listed.status).toBe(200);
    const sent = (listed.body.messages as { id: number; body: string; senderId: number }[])
      .filter((message) => message.body?.includes(runId));
    expect(sent.map((message) => message.body)).toEqual([
      `first message ${runId}`,
      `second message\nwith a new line ${runId} 🙂`,
      `reply ${runId}`,
    ]);
    expect(sent[2].senderId).toBe(employeeId);

    const upload = await admin.agent
      .post('/api/files/upload')
      .attach('file', Buffer.from('persistent chat attachment', 'utf8'), { filename: 'chat-note.txt', contentType: 'text/plain' });
    expect(upload.status).toBe(201);
    const fileId = Number(upload.body.id);
    const withFile = await admin.agent.post(`/api/chat/conversations/${conversationId}/messages`).send({
      body: `attachment ${runId}`, type: 'file', fileIds: [fileId], clientId: `chat-file-${runId}`,
    });
    expect(withFile.status).toBe(201);
    expect(withFile.body.attachments).toHaveLength(1);
    expect(withFile.body.attachments[0].fileId).toBe(fileId);

    const download = await employee.agent.get(`/api/files/${fileId}?download=1`);
    expect(download.status).toBe(200);
    expect(download.text).toBe('persistent chat attachment');
    expect(String(download.headers['content-disposition'])).toContain('attachment');

    const deleted = await employee.agent.delete(`/api/chat/conversations/${conversationId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.hidden).toBe(true);

    const employeeList = await employee.agent.get('/api/chat/conversations');
    expect((employeeList.body.conversations as { id: number }[]).some((row) => row.id === conversationId)).toBe(false);
    const adminList = await admin.agent.get('/api/chat/conversations');
    expect((adminList.body.conversations as { id: number }[]).some((row) => row.id === conversationId)).toBe(true);
    const stillReadable = await admin.agent.get(`/api/chat/conversations/${conversationId}/messages?limit=100`);
    expect(stillReadable.status).toBe(200);
  });

  it('rejects a non-member from reading a conversation', async () => {
    const admin = await login('admin@workforce.test');
    const member = await login('ananya.rao@workforce.test');
    const outsider = await login('karthik.iyer@workforce.test');
    const conversation = await admin.agent.post('/api/chat/conversations/direct').send({
      employeeId: member.response.body.user.id,
    });
    expect(conversation.status).toBe(201);
    const response = await outsider.agent.get(`/api/chat/conversations/${conversation.body.id}/messages`);
    expect(response.status).toBe(403);
  });
});

describe('email delivery', () => {
  it('queues, processes and reports a transactional email without exposing credentials', async () => {
    const admin = await login('admin@workforce.test');
    await execute("UPDATE email_deliveries SET status = 'skipped' WHERE status IN ('queued', 'failed')");
    const id = await enqueueEmail({
      to: 'qa.email@workforce.test',
      toName: 'QA Mailbox',
      template: 'test',
      data: { name: 'QA Mailbox' },
      dedupeKey: `qa-email-${Date.now()}`,
    });
    expect(id).toBeTruthy();

    await processEmailQueue(50);

    const overview = await admin.agent.get('/api/admin/email?limit=50');
    expect(overview.status).toBe(200);
    expect(overview.body.status).not.toHaveProperty('password');
    expect(overview.body.templates.length).toBeGreaterThan(5);

    const row = (overview.body.deliveries as { id: number; status: string; template: string; attempts: number }[]).find(
      (entry) => entry.id === id,
    );
    expect(row).toBeDefined();
    expect(row!.template).toBe('test');
    expect(row!.attempts).toBeGreaterThan(0);
    expect(['sent', 'skipped', 'failed']).toContain(row!.status);

    const stored = await queryOne<{ status: string }>('SELECT status FROM email_deliveries WHERE id = ?', [id]);
    expect(stored?.status).toBe(row!.status);
  });
});

describe('collection module', () => {
  const customer = `QA Collection ${Date.now()}`;
  let collectionId = 0;

  afterAll(async () => {
    await execute('DELETE FROM collections WHERE customer_name LIKE ?', ['QA Collection%']);
  });

  it('creates a collection record and scopes it to the collector', async () => {
    const { agent, response } = await login('ananya.rao@workforce.test');
    const create = await agent.post('/api/collections').send({
      customerName: customer,
      amountDue: 1250.5,
      amountCollected: 250.5,
      dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      notes: 'QA verification record',
    });
    expect(create.status).toBe(201);
    expect(create.body.referenceNo).toMatch(/^COL-\d{4}-\d+$/);
    collectionId = create.body.id;

    const list = await agent.get('/api/collections?search=QA%20Collection');
    expect(list.status).toBe(200);
    const row = (list.body.items as { id: number; status: string; approvalStatus: string; employeeId: number }[]).find(
      (item) => item.id === collectionId,
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe('partial');
    expect(row!.approvalStatus).toBe('pending');
    expect(row!.employeeId).toBe(response.body.user.id);
  });

  it('rejects an employee attempting to approve a record', async () => {
    const { agent } = await login('ananya.rao@workforce.test');
    const response = await agent.post(`/api/collections/${collectionId}/decision`).send({ approve: true });
    expect(response.status).toBe(403);
  });

  it('lets a manager approve a team collection record', async () => {
    const manager = await login('it.manager@workforce.test');
    const list = await manager.agent.get('/api/collections?search=QA%20Collection');
    expect(list.status).toBe(200);
    expect((list.body.items as { id: number }[]).some((item) => item.id === collectionId)).toBe(true);

    const decide = await manager.agent.post(`/api/collections/${collectionId}/decision`).send({ approve: true });
    expect(decide.status).toBe(200);
    expect(decide.body.approvalStatus).toBe('approved');

    const employee = await login('ananya.rao@workforce.test');
    const detail = await employee.agent.get(`/api/collections/${collectionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.approvalStatus).toBe('approved');
  });

  it('exposes collection dashboard totals and status metadata', async () => {
    const { agent } = await login('it.manager@workforce.test');
    const dashboard = await agent.get('/api/collections/dashboard');
    expect(dashboard.status).toBe(200);
    expect(typeof dashboard.body.summary.outstanding).toBe('number');
    expect(Array.isArray(dashboard.body.byStatus)).toBe(true);
    const meta = await agent.get('/api/collections/meta');
    expect(meta.status).toBe(200);
    expect(meta.body.statuses.length).toBe(4);
  });
});

describe('development test login', () => {
  it('never exposes demo credentials in production', async () => {
    const previous = config.isProd;
    try {
      config.isProd = true;
      const response = await request(app).get('/api/auth/test-accounts');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ enabled: false, accounts: [] });
      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    } finally {
      config.isProd = previous;
    }
  });
  it('returns seeded demo accounts outside production only', async () => {
    const response = await request(app).get('/api/auth/test-accounts');
    expect(response.status).toBe(200);
    const body = response.body as { enabled: boolean; environment: string; accounts: { role: string; employeeId: string; password: string }[] };
    expect(body.enabled).toBe(true);
    expect(body.environment).toBe('test');
    expect(body.accounts.length).toBe(7);
    expect(body.accounts.map((account) => account.role)).toEqual(
      expect.arrayContaining(['Super Admin', 'HR Manager', 'Department Manager', 'IT Support', 'Developer', 'Employee', 'Store Manager']),
    );
    expect(body.accounts.every((account) => account.employeeId.startsWith('EMP-'))).toBe(true);
  });
});

describe('refresh token rotation', () => {
  function refreshCookie(headers: Record<string, unknown>): string | undefined {
    const raw = headers['set-cookie'] as string[] | undefined;
    return raw?.find((cookie) => cookie.startsWith('wfm_refresh='))?.split(';')[0];
  }

  it('rotates refresh tokens and detects reuse of a consumed token', async () => {
    const agent = request.agent(app);
    const loginResponse = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ identifier: 'karthik.iyer@workforce.test', password: PASSWORD });
    expect(loginResponse.status).toBe(200);
    const originalRefresh = refreshCookie(loginResponse.headers as Record<string, unknown>);
    expect(originalRefresh).toBeTruthy();

    const refreshed = await agent.post('/api/auth/refresh').set('Origin', 'http://localhost:5173');
    expect(refreshed.status).toBe(200);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('karthik.iyer@workforce.test');
    const rotatedRefresh = refreshCookie(refreshed.headers as Record<string, unknown>);
    expect(rotatedRefresh).toBeTruthy();
    expect(rotatedRefresh).not.toBe(originalRefresh);

    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', originalRefresh!);
    expect(replay.status).toBe(401);

    const afterReuse = await request(app).get('/api/auth/me').set('Cookie', rotatedRefresh!);
    expect(afterReuse.status).toBe(401);
    await agent.post('/api/auth/logout');
  });
});

describe('audit trail', () => {
  it('records an audit entry for privileged settings changes and lists it', async () => {
    const { agent } = await login('admin@workforce.test');
    const before = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM audit_logs');
    const current = await agent.get('/api/admin/settings');
    expect(current.status).toBe(200);
    const save = await agent
      .put('/api/admin/settings')
      .send({ settings: { late_grace_minutes: current.body.settings.late_grace_minutes ?? '10' } });
    expect(save.status).toBe(200);
    const after = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM audit_logs');
    expect(Number(after?.total ?? 0)).toBeGreaterThan(Number(before?.total ?? 0));
    const audit = await agent.get('/api/admin/audit?limit=10');
    expect(audit.status).toBe(200);
    expect((audit.body.entries as { action: string }[]).some((entry) => entry.action.includes('settings'))).toBe(true);
  });
});
