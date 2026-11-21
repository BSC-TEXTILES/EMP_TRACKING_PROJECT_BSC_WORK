import { afterEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ queryOne: vi.fn(), execute: vi.fn(), query: vi.fn() }));
vi.mock('../src/db/index.js', () => ({ ...db, transaction: vi.fn(), nextSequence: vi.fn(), txQuery: vi.fn(), txQueryOne: vi.fn() }));
import { TaskService } from '../src/services/TaskService.js';
import type { AuthUser } from '../src/services/AuthService.js';
afterEach(() => vi.restoreAllMocks());
const user = { id: 7, fullName: 'Test employee', permissions: [] } as unknown as AuthUser;
function prepare(status: string) {
  vi.spyOn(TaskService, 'assertAccess').mockResolvedValue();
  db.queryOne.mockImplementation(async (sql: string) => sql.includes('task_assignments')
    ? { id: 1, employee_id: 7, status }
    : { id: 1, created_by: 2, manager_id: 2, status, progress: 0 });
}
describe('task workflow guards', () => {
  it('requires a hold reason before changing persisted state', async () => {
    prepare('in_progress');
    await expect(TaskService.applyAction(1, 'hold', user, {}, {})).rejects.toMatchObject({ status: 400 });
  });
  it('prevents restarting a completed task', async () => {
    prepare('completed');
    await expect(TaskService.applyAction(1, 'start', user, {}, {})).rejects.toMatchObject({ status: 409 });
  });
  it('prevents duplicate resume time entries', async () => {
    prepare('in_progress');
    await expect(TaskService.applyAction(1, 'resume', user, {}, {})).rejects.toMatchObject({ status: 409 });
  });
  it('does not let a status dropdown bypass completion review', async () => {
    prepare('in_progress');
    await expect(TaskService.applyAction(1, 'set_status', user, { status: 'completed' }, {})).rejects.toMatchObject({ status: 403 });
  });
});
