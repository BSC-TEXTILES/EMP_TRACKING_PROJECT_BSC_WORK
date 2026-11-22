import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaveService } from '../src/services/LeaveService.js';
import { WeeklyOffService } from '../src/services/WeeklyOffService.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { closePool, execute, query, queryOne } from '../src/db/index.js';
import { today } from '../src/lib/dates.js';
import { dateRange, daysInMonth, isoDate, sundaysInMonth } from '../src/lib/calendar.js';

let employee: AuthUser;
let manager: AuthUser;
let hr: AuthUser;
let testYear = 0;
let testMonth = 0;
let sundays: string[] = [];

async function person(email: string): Promise<AuthUser> {
  const row = await queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', [email]);
  return (await AuthService.buildUser(row!.id))!;
}

async function approveRoute(leaveId: number) {
  await LeaveService.decide(leaveId, hr, { approve: true, stage: 'hr' }, {});
  await LeaveService.decide(leaveId, manager, { approve: true, stage: 'manager' }, {});
}

beforeAll(async () => {
  employee = await person('nitin.jadhav@bsctextiles.in');
  const routing = await LeaveService.applicationContext(employee.id);
  manager = (await AuthService.buildUser(routing.manager!.id))!;
  const hrCandidates = await Promise.all(routing.hrApprovers.map((h) => AuthService.buildUser(h.id)));
  hr = hrCandidates.find((u) => u && u.permissions.includes('leave.approve.hr') && u.id !== manager.id)!;
  expect(hr).toBeTruthy();

  // Pick a future month that has exactly 5 Sundays
  const now = today();
  for (let offset = 4; offset < 28; offset += 1) {
    const totalM = Number(now.slice(0, 4)) * 12 + Number(now.slice(5, 7)) - 1 + offset;
    const y = Math.floor(totalM / 12);
    const m = (totalM % 12) + 1;
    if (sundaysInMonth(y, m).length === 5) {
      testYear = y;
      testMonth = m;
      break;
    }
  }
  sundays = sundaysInMonth(testYear, testMonth);
  expect(sundays).toHaveLength(5);

  // Clean test slate
  await execute('DELETE FROM leave_requests WHERE employee_id = ?', [employee.id]);
  await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date >= ?', [employee.id, sundays[0]]);
  await execute('DELETE FROM weekly_off_allocations WHERE employee_id = ? AND alloc_year = ? AND alloc_month = ?', [employee.id, testYear, testMonth]);
  await execute('UPDATE employees SET joining_date = ?, weekly_off_day = 0 WHERE id = ?', [isoDate(testYear, testMonth, 1), employee.id]);
});

afterAll(closePool);

describe('Continuous & Single-Day Week-Off Management Logic', () => {
  it('calculates monthly entitlement dynamically based on Sundays (5 allocated, 0 taken, 5 remaining)', async () => {
    const bal = await WeeklyOffService.monthBalance(employee.id, testYear, testMonth);
    expect(bal.allocated).toBe(5);
    expect(bal.taken).toBe(0);
    expect(bal.remaining).toBe(5);
    expect(bal.available).toBe(5);
  });

  it('deducts exactly ONE day when a single week-off is taken and approved', async () => {
    const singleDate = sundays[1]; // 2nd Sunday
    const res = await LeaveService.applyWeeklyOff(employee.id, {
      date: singleDate,
      reason: 'Scheduled Sunday off',
      hrApproverId: hr.id,
    });
    expect(res.id).toBeGreaterThan(0);

    // Pending state
    let bal = await WeeklyOffService.monthBalance(employee.id, testYear, testMonth);
    expect(bal.allocated).toBe(5);
    expect(bal.taken).toBe(0);
    expect(bal.pending).toBe(1);
    expect(bal.remaining).toBe(5);
    expect(bal.available).toBe(4);

    // Approve through 2-stage workflow (HR -> Manager)
    await approveRoute(res.id);

    // After approval: exactly 1 day deducted
    bal = await WeeklyOffService.monthBalance(employee.id, testYear, testMonth);
    expect(bal.allocated).toBe(5);
    expect(bal.taken).toBe(1);
    expect(bal.remaining).toBe(4);
    expect(bal.available).toBe(4);
    expect(bal.takenDates).toContain(singleDate);

    // Verify attendance is marked as weekly_off on that date
    const att = await queryOne<{ status: string; notes: string }>(
      'SELECT status, notes FROM attendance WHERE employee_id = ? AND work_date = ?',
      [employee.id, singleDate],
    );
    expect(att?.status).toBe('weekly_off');
  });

  it('allows continuous week-off usage across consecutive dates and deducts the exact number of days', async () => {
    // Pick 3 consecutive days in the test month (e.g. Wednesday to Friday)
    // Find consecutive days not overlapping sundays[1]
    const monthDates = dateRange(isoDate(testYear, testMonth, 1), isoDate(testYear, testMonth, daysInMonth(testYear, testMonth)))
      .filter((d) => d !== sundays[1]);
    const startRange = monthDates[10];
    const endRange = monthDates[12]; // 3 days
    const rangeDays = dateRange(startRange, endRange);
    expect(rangeDays).toHaveLength(3);

    const res = await LeaveService.applyWeeklyOff(employee.id, {
      startDate: startRange,
      endDate: endRange,
      consecutive: true,
      reason: 'Consecutive accumulated week-offs',
      hrApproverId: hr.id,
    });
    expect(res.id).toBeGreaterThan(0);
    expect(res.days).toBe(3);

    // Approve the request
    await approveRoute(res.id);

    // Balances: 1 previously taken + 3 taken now = 4 taken, remaining = 5 - 4 = 1
    const bal = await WeeklyOffService.monthBalance(employee.id, testYear, testMonth);
    expect(bal.allocated).toBe(5);
    expect(bal.taken).toBe(4);
    expect(bal.remaining).toBe(1);
    expect(bal.available).toBe(1);

    // Verify attendance for ALL 3 dates in the range are marked as weekly_off
    for (const d of rangeDays) {
      const att = await queryOne<{ status: string }>(
        'SELECT status FROM attendance WHERE employee_id = ? AND work_date = ?',
        [employee.id, d],
      );
      expect(att?.status).toBe('weekly_off');
    }
  });

  it('rejects an application that exceeds available week-off entitlement', async () => {
    // Only 1 day is remaining now. Attempting to take 2 consecutive days must fail.
    const monthDates = dateRange(isoDate(testYear, testMonth, 1), isoDate(testYear, testMonth, daysInMonth(testYear, testMonth)))
      .filter((d) => d > sundays[2]);
    const s = monthDates[0];
    const e = monthDates[1]; // 2 days

    await expect(
      LeaveService.applyWeeklyOff(employee.id, {
        startDate: s,
        endDate: e,
        consecutive: true,
        reason: 'Over quota',
        hrApproverId: hr.id,
      }),
    ).rejects.toThrow(/Insufficient weekly-off balance/);
  });

  it('consumes the final available week-off reaching 0 remaining', async () => {
    // Take the 5th week off on 4th Sunday
    const finalDate = sundays[3];
    const res = await LeaveService.applyWeeklyOff(employee.id, {
      date: finalDate,
      reason: 'Final remaining week off',
      hrApproverId: hr.id,
    });
    await approveRoute(res.id);

    const bal = await WeeklyOffService.monthBalance(employee.id, testYear, testMonth);
    expect(bal.allocated).toBe(5);
    expect(bal.taken).toBe(5);
    expect(bal.remaining).toBe(0);
    expect(bal.available).toBe(0);
  });

  it('accurately reports the multi-day deductions in teamSummary for HR and Manager dashboards', async () => {
    const summary = await WeeklyOffService.teamSummary(hr, testYear, testMonth, null);
    const empRow = summary.employees.find((e) => e.employeeId === employee.id);
    expect(empRow).toBeDefined();
    expect(empRow!.allocated).toBe(5);
    expect(empRow!.taken).toBe(5);
    expect(empRow!.remaining).toBe(0);
  });
});
