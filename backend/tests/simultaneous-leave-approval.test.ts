import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaveService } from '../src/services/LeaveService.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { closePool, execute, queryOne } from '../src/db/index.js';
import { today } from '../src/lib/dates.js';
import { isoDate, sundaysInMonth } from '../src/lib/calendar.js';

let employee: AuthUser;
let manager: AuthUser;
let hr: AuthUser;
let testYear = 0;
let testMonth = 0;
let testDates: string[] = [];

async function person(email: string): Promise<AuthUser> {
  const row = await queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', [email]);
  return (await AuthService.buildUser(row!.id))!;
}

beforeAll(async () => {
  employee = await person('nitin.jadhav@bsctextiles.in');
  const routing = await LeaveService.applicationContext(employee.id);
  manager = (await AuthService.buildUser(routing.manager!.id))!;
  const hrCandidates = await Promise.all(routing.hrApprovers.map((h) => AuthService.buildUser(h.id)));
  hr = hrCandidates.find((u) => u && u.permissions.includes('leave.approve.hr') && u.id !== manager.id)!;
  expect(hr).toBeTruthy();

  const now = today();
  for (let offset = 8; offset < 32; offset += 1) {
    const totalM = Number(now.slice(0, 4)) * 12 + Number(now.slice(5, 7)) - 1 + offset;
    const y = Math.floor(totalM / 12);
    const m = (totalM % 12) + 1;
    if (sundaysInMonth(y, m).length === 5) {
      testYear = y;
      testMonth = m;
      break;
    }
  }
  // Find 6 consecutive working days (Monday to Friday, avoid Sundays)
  const weekdays: string[] = [];
  for (let day = 1; day <= 28; day += 1) {
    const d = new Date(testYear, testMonth - 1, day);
    if (d.getDay() !== 0) { // Not Sunday
      weekdays.push(isoDate(testYear, testMonth, day));
      if (weekdays.length === 6) break;
    }
  }
  testDates = weekdays;

  await execute('DELETE FROM leave_requests WHERE employee_id = ? AND start_date >= ?', [employee.id, testDates[0]]);
  await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date >= ?', [employee.id, testDates[0]]);
});

afterAll(closePool);

describe('Simultaneous HR & Manager Leave Approval Workflow', () => {
  it('submits a leave request with pending_both, manager pending, and hr pending', async () => {
    const types = await LeaveService.types();
    const cl = types.find((t) => t.code === 'CL') ?? types[0];

    const result = await LeaveService.apply(employee.id, {
      leaveTypeId: cl.id,
      startDate: testDates[0],
      endDate: testDates[0],
      hrApproverId: hr.id,
      reason: 'Doctor checkup',
    });

    expect(result.id).toBeGreaterThan(0);

    const record = await queryOne<{ status: string; manager_status: string; hr_status: string }>(
      'SELECT status, manager_status, hr_status FROM leave_requests WHERE id = ?',
      [result.id],
    );
    expect(record?.status).toBe('pending_both');
    expect(record?.manager_status).toBe('pending');
    expect(record?.hr_status).toBe('pending');
  });

  it('allows manager to approve first, transitioning to pending_hr while manager_status is approved', async () => {
    const types = await LeaveService.types();
    const cl = types.find((t) => t.code === 'CL') ?? types[0];

    const result = await LeaveService.apply(employee.id, {
      leaveTypeId: cl.id,
      startDate: testDates[1],
      endDate: testDates[1],
      hrApproverId: hr.id,
      reason: 'Personal work',
    });

    // Manager approves first
    await LeaveService.decide(result.id, manager, { approve: true, note: 'Approved by manager', stage: 'manager' });

    let record = await queryOne<{ status: string; manager_status: string; hr_status: string }>(
      'SELECT status, manager_status, hr_status FROM leave_requests WHERE id = ?',
      [result.id],
    );
    expect(record?.status).toBe('pending_hr');
    expect(record?.manager_status).toBe('approved');
    expect(record?.hr_status).toBe('pending');

    // HR approves second -> Final status becomes approved
    await LeaveService.decide(result.id, hr, { approve: true, note: 'Verified by HR', stage: 'hr' });

    record = await queryOne<{ status: string; manager_status: string; hr_status: string }>(
      'SELECT status, manager_status, hr_status FROM leave_requests WHERE id = ?',
      [result.id],
    );
    expect(record?.status).toBe('approved');
    expect(record?.manager_status).toBe('approved');
    expect(record?.hr_status).toBe('approved');
  });

  it('allows HR to verify first, transitioning to pending_manager while hr_status is approved', async () => {
    const types = await LeaveService.types();
    const cl = types.find((t) => t.code === 'CL') ?? types[0];

    const result = await LeaveService.apply(employee.id, {
      leaveTypeId: cl.id,
      startDate: testDates[2],
      endDate: testDates[2],
      hrApproverId: hr.id,
      reason: 'Family event',
    });

    // HR approves first
    await LeaveService.decide(result.id, hr, { approve: true, note: 'HR verified documents', stage: 'hr' });

    let record = await queryOne<{ status: string; manager_status: string; hr_status: string }>(
      'SELECT status, manager_status, hr_status FROM leave_requests WHERE id = ?',
      [result.id],
    );
    expect(record?.status).toBe('pending_manager');
    expect(record?.hr_status).toBe('approved');
    expect(record?.manager_status).toBe('pending');

    // Manager approves second -> Final status becomes approved
    await LeaveService.decide(result.id, manager, { approve: true, note: 'Manager confirmed roster', stage: 'manager' });

    record = await queryOne<{ status: string; manager_status: string; hr_status: string }>(
      'SELECT status, manager_status, hr_status FROM leave_requests WHERE id = ?',
      [result.id],
    );
    expect(record?.status).toBe('approved');
    expect(record?.manager_status).toBe('approved');
    expect(record?.hr_status).toBe('approved');
  });

  it('rejects the request immediately if either manager or HR rejects', async () => {
    const types = await LeaveService.types();
    const cl = types.find((t) => t.code === 'CL') ?? types[0];

    const result = await LeaveService.apply(employee.id, {
      leaveTypeId: cl.id,
      startDate: testDates[3],
      endDate: testDates[3],
      hrApproverId: hr.id,
      reason: 'Critical day off',
    });

    // Manager rejects
    await LeaveService.decide(result.id, manager, { approve: false, note: 'Staff shortage on this date', stage: 'manager' });

    const record = await queryOne<{ status: string; manager_status: string; hr_status: string }>(
      'SELECT status, manager_status, hr_status FROM leave_requests WHERE id = ?',
      [result.id],
    );
    expect(record?.status).toBe('rejected');
    expect(record?.manager_status).toBe('rejected');
  });

  it('processes bulk approvals for multiple requests simultaneously', async () => {
    const types = await LeaveService.types();
    const cl = types.find((t) => t.code === 'CL') ?? types[0];

    const req1 = await LeaveService.apply(employee.id, {
      leaveTypeId: cl.id,
      startDate: testDates[4],
      endDate: testDates[4],
      hrApproverId: hr.id,
      reason: 'Batch item 1',
    });

    const req2 = await LeaveService.apply(employee.id, {
      leaveTypeId: cl.id,
      startDate: testDates[5],
      endDate: testDates[5],
      hrApproverId: hr.id,
      reason: 'Batch item 2',
    });

    const bulkResult = await LeaveService.bulkDecide([req1.id, req2.id], hr, {
      approve: true,
      note: 'Bulk HR verification batch',
      stage: 'hr',
    });

    expect(bulkResult.successCount).toBe(2);
    expect(bulkResult.failCount).toBe(0);

    const r1 = await queryOne<{ hr_status: string }>('SELECT hr_status FROM leave_requests WHERE id = ?', [req1.id]);
    const r2 = await queryOne<{ hr_status: string }>('SELECT hr_status FROM leave_requests WHERE id = ?', [req2.id]);
    expect(r1?.hr_status).toBe('approved');
    expect(r2?.hr_status).toBe('approved');
  });
});
