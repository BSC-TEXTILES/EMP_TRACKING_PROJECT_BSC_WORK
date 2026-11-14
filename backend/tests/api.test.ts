import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { execute, query, queryOne, closePool } from '../src/db/index.js';
import { enqueueEmail, processEmailQueue } from '../src/lib/mailer.js';

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

describe('attendance timer and duplicate prevention', () => {
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

  it('rejects a non-member from reading a conversation', async () => {
    const admin = await login('admin@workforce.test');
    const conversations = await admin.agent.get('/api/chat/conversations');
    const outsider = await login('ananya.rao@workforce.test');
    const mine = await outsider.agent.get('/api/chat/conversations');
    const myIds = new Set((mine.body.conversations as { id: number }[]).map((item) => item.id));
    const foreign = (conversations.body.conversations as { id: number }[]).find((item) => !myIds.has(item.id));
    expect(foreign).toBeDefined();
    const response = await outsider.agent.get(`/api/chat/conversations/${foreign!.id}/messages`);
    expect(response.status).toBe(403);
  });
});

describe('email delivery', () => {
  it('queues, processes and reports a transactional email without exposing credentials', async () => {
    const admin = await login('admin@workforce.test');
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
