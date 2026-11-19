import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaveService } from '../src/services/LeaveService.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { execute, queryOne, closePool } from '../src/db/index.js';
import { addDays, today } from '../src/lib/dates.js';
import { isWeeklyOff } from '../src/lib/calendar.js';
let employee: AuthUser; let manager: AuthUser; let hr: AuthUser; let other: AuthUser;
let requestId: number;
beforeAll(async () => {
  async function person(email: string) { const row = await queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', [email]); return (await AuthService.buildUser(row!.id))!; }
  employee = await person('ananya.rao@workforce.test');
  manager = await person('it.manager@workforce.test');
  hr = await person('hr.manager@workforce.test');
  other = await person('store.manager@workforce.test');
  await execute('INSERT IGNORE INTO employee_locations (employee_id, location_id) VALUES (?, ?)', [hr.id, employee.locationId]);
});
afterAll(closePool);
describe('location leave approval workflow', () => {
  it('shows the assigned manager and only HR assigned to the employee location', async () => {
    const context = await LeaveService.applicationContext(employee.id);
    expect(context.canApply).toBe(true);
    expect(context.manager?.id).toBe(manager.id);
    expect(context.hrApprovers.map((p) => p.id)).toContain(hr.id);
    expect(context.hrApprovers.map((p) => p.id)).not.toContain(other.id);
  });
  it('rejects forged HR selection and persists the valid route', async () => {
    const type = (await LeaveService.types()).find((t) => !t.requires_document)!;
    // A working day: Sundays are weekly offs and a Sunday-only request is (correctly) refused.
    let leaveDay = addDays(today(), 45);
    if (isWeeklyOff(leaveDay)) leaveDay = addDays(leaveDay, 1);
    const input = { leaveTypeId: type.id, startDate: leaveDay, endDate: leaveDay, reason: 'Local workflow test request', hrApproverId: other.id };
    await expect(LeaveService.apply(employee.id, input, {})).rejects.toMatchObject({ status: 400 });
    const result = await LeaveService.apply(employee.id, { ...input, hrApproverId: hr.id }, {});
    requestId = result.id;
    const row = await queryOne('SELECT manager_id, hr_approver_id, request_location_id FROM leave_requests WHERE id = ?', [requestId]);
    expect(row).toMatchObject({ manager_id: manager.id, hr_approver_id: hr.id, request_location_id: employee.locationId });
  });
  it('blocks cross-location and out-of-order approval, then completes manager → HR exactly once', async () => {
    await expect(LeaveService.decide(requestId, other, { approve: true, stage: 'manager' }, {})).rejects.toMatchObject({ status: 403 });
    await expect(LeaveService.decide(requestId, hr, { approve: true, stage: 'hr' }, {})).rejects.toMatchObject({ status: 409 });
    await LeaveService.decide(requestId, manager, { approve: true, stage: 'manager' }, {});
    await LeaveService.decide(requestId, hr, { approve: true, stage: 'hr' }, {});
    await expect(LeaveService.decide(requestId, hr, { approve: true, stage: 'hr' }, {})).rejects.toMatchObject({ status: 409 });
    expect(await queryOne('SELECT status FROM leave_requests WHERE id = ?', [requestId])).toMatchObject({ status: 'approved' });
  });
});
