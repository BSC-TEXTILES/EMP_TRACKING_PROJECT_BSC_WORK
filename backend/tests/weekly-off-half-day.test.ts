import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaveService } from '../src/services/LeaveService.js';
import { WeeklyOffService } from '../src/services/WeeklyOffService.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { closePool, execute, query, queryOne } from '../src/db/index.js';
import { today } from '../src/lib/dates.js';
import { dateRange, daysInMonth, isoDate, sundaysInMonth, weekdayOf } from '../src/lib/calendar.js';

/**
 * Weekly-off and half-day requests end to end against the disposable test database:
 * allocation from the joining date, request → manager → HR, balances, calendar,
 * duplicate / overlap guards and month changes.
 */

let employee: AuthUser;
let manager: AuthUser;
let hr: AuthUser;
let year = 0;
let month = 0;
let allSundays: string[] = [];
let eligible: string[] = [];
let halfDayDate = '';

async function person(email: string): Promise<AuthUser> {
  const row = await queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', [email]);
  return (await AuthService.buildUser(row!.id))!;
}

async function approve(id: number) {
  await LeaveService.decide(id, manager, { approve: true, stage: 'manager' }, {});
  await LeaveService.decide(id, hr, { approve: true, stage: 'hr' }, {});
}

beforeAll(async () => {
  // A BEL store employee; manager and HR come from the real approval routing.
  employee = await person('nitin.jadhav@bsctextiles.in');
  const routing = await LeaveService.applicationContext(employee.id);
  manager = (await AuthService.buildUser(routing.manager!.id))!;
  const hrCandidates = await Promise.all(routing.hrApprovers.map((h) => AuthService.buildUser(h.id)));
  hr = hrCandidates.find((u) => u && u.permissions.includes('leave.approve.hr') && u.id !== manager.id)!;
  expect(hr).toBeTruthy();

  // A future month with five Sundays; joining on the 2nd Sunday leaves exactly four eligible.
  const now = today();
  for (let offset = 3; offset < 24; offset += 1) {
    const index = Number(now.slice(0, 4)) * 12 + Number(now.slice(5, 7)) - 1 + offset;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    if (sundaysInMonth(y, m).length === 5) {
      year = y;
      month = m;
      break;
    }
  }
  allSundays = sundaysInMonth(year, month);
  eligible = allSundays.slice(1);
  await execute('UPDATE employees SET joining_date = ?, weekly_off_day = 0 WHERE id = ?', [eligible[0], employee.id]);
  // First working day (Mon–Sat) after joining.
  halfDayDate = dateRange(eligible[0], isoDate(year, month, daysInMonth(year, month))).find((d) => weekdayOf(d) !== 0)!;
});

afterAll(closePool);

describe('weekly-off allocation and requests', () => {
  it('allocates only eligible weekly-off dates on/after joining: 4 allocated, 0 taken, 4 remaining', async () => {
    const balance = await WeeklyOffService.monthBalance(employee.id, year, month);
    expect(balance.allocated).toBe(4);
    expect(balance.taken).toBe(0);
    expect(balance.remaining).toBe(4);
    expect(balance.dates.find((d) => d.date === allSundays[0])?.status).toBe('not_eligible');
    const summary = await WeeklyOffService.monthSummary(employee.id, year, month);
    expect(summary.weeklyOffs).toMatchObject({ allocated: 4, taken: 0, remaining: 4, pending: 0 });
    expect(summary.days.filter((d) => d.isWeeklyOff).every((d) => d.readOnly)).toBe(true);
    const snapshot = await queryOne('SELECT allocated, taken FROM weekly_off_allocations WHERE employee_id = ? AND alloc_year = ? AND alloc_month = ?', [employee.id, year, month]);
    expect(snapshot).toMatchObject({ allocated: 4, taken: 0 });
  });

  it('blocks invalid dates: not the weekly-off day, and a Sunday before joining', async () => {
    await expect(LeaveService.applyWeeklyOff(employee.id, { date: halfDayDate, hrApproverId: hr.id })).rejects.toMatchObject({ status: 400 });
    await expect(LeaveService.applyWeeklyOff(employee.id, { date: allSundays[0], hrApproverId: hr.id })).rejects.toMatchObject({ status: 400 });
  });

  it('submits without a reason, reserves the date, blocks duplicates, and counts as taken only after HR approval', async () => {
    const created = await LeaveService.applyWeeklyOff(employee.id, { date: eligible[0], hrApproverId: hr.id });
    await expect(LeaveService.applyWeeklyOff(employee.id, { date: eligible[0], hrApproverId: hr.id })).rejects.toMatchObject({ status: 409 });

    let balance = await WeeklyOffService.monthBalance(employee.id, year, month);
    expect(balance).toMatchObject({ allocated: 4, taken: 0, pending: 1, remaining: 4, available: 3 });

    await LeaveService.decide(created.id, manager, { approve: true, stage: 'manager' }, {});
    expect(await queryOne('SELECT status FROM leave_requests WHERE id = ?', [created.id])).toMatchObject({ status: 'pending_hr' });
    balance = await WeeklyOffService.monthBalance(employee.id, year, month);
    expect(balance.taken).toBe(0);

    await LeaveService.decide(created.id, hr, { approve: true, stage: 'hr' }, {});
    balance = await WeeklyOffService.monthBalance(employee.id, year, month);
    expect(balance).toMatchObject({ allocated: 4, taken: 1, remaining: 3 });
    expect(await queryOne('SELECT status FROM attendance WHERE employee_id = ? AND work_date = ?', [employee.id, eligible[0]])).toMatchObject({ status: 'weekly_off' });
    const history = await query<{ action: string }>('SELECT action FROM leave_request_history WHERE leave_request_id = ? ORDER BY id', [created.id]);
    expect(history.map((h) => h.action)).toEqual(['submitted', 'manager_approved', 'hr_approved']);
    expect(await queryOne('SELECT taken FROM weekly_off_allocations WHERE employee_id = ? AND alloc_year = ? AND alloc_month = ?', [employee.id, year, month])).toMatchObject({ taken: 1 });
  });

  it('a second approved weekly off leaves 2 remaining; a cancelled request frees its date', async () => {
    const second = await LeaveService.applyWeeklyOff(employee.id, { date: eligible[1], reason: 'Family function', hrApproverId: hr.id });
    await approve(second.id);
    expect(await WeeklyOffService.monthBalance(employee.id, year, month)).toMatchObject({ allocated: 4, taken: 2, remaining: 2 });

    const third = await LeaveService.applyWeeklyOff(employee.id, { date: eligible[2], hrApproverId: hr.id });
    await LeaveService.cancel(third.id, employee.id);
    const balance = await WeeklyOffService.monthBalance(employee.id, year, month);
    expect(balance).toMatchObject({ taken: 2, pending: 0, remaining: 2, available: 2 });
    expect(balance.dates.find((d) => d.date === eligible[2])?.status).toBe('available');
    // The cancelled date can be applied for again (history is kept).
    const again = await LeaveService.applyWeeklyOff(employee.id, { date: eligible[2], hrApproverId: hr.id });
    await LeaveService.decide(again.id, manager, { approve: false, stage: 'manager', note: 'Store stock-take that day' }, {});
    expect(await queryOne('SELECT status FROM leave_requests WHERE id = ?', [again.id])).toMatchObject({ status: 'rejected' });
    expect(await WeeklyOffService.monthBalance(employee.id, year, month)).toMatchObject({ taken: 2, remaining: 2 });
  });

  it('loads the correct balance when the month changes', async () => {
    const nextIndex = year * 12 + month; // following month
    const next = await WeeklyOffService.monthBalance(employee.id, Math.floor(nextIndex / 12), (nextIndex % 12) + 1);
    expect(next.taken).toBe(0);
    expect(next.allocated).toBe(next.allDates.length);
  });
});

describe('half-day leave', () => {
  let firstHalfId = 0;

  it('records exactly 0.5 day with the First Half session, without a reason', async () => {
    const result = await LeaveService.applyHalfDay(employee.id, { date: halfDayDate, slot: 'first_half', hrApproverId: hr.id });
    firstHalfId = result.id;
    const row = await queryOne<{ days: number; is_half_day: number; half_day_slot: string; request_kind: string; reason: string }>(
      'SELECT days, is_half_day, half_day_slot, request_kind, reason FROM leave_requests WHERE id = ?',
      [result.id],
    );
    expect(row).toMatchObject({ days: 0.5, is_half_day: 1, half_day_slot: 'first_half', request_kind: 'half_day', reason: '' });
  });

  it('saves the Second Half session and blocks a duplicate session on the same date', async () => {
    await expect(LeaveService.applyHalfDay(employee.id, { date: halfDayDate, slot: 'first_half', hrApproverId: hr.id })).rejects.toMatchObject({ status: 409 });
    const second = await LeaveService.applyHalfDay(employee.id, { date: halfDayDate, slot: 'second_half', hrApproverId: hr.id });
    expect(await queryOne('SELECT half_day_slot FROM leave_requests WHERE id = ?', [second.id])).toMatchObject({ half_day_slot: 'second_half' });
    await LeaveService.cancel(second.id, employee.id);
  });

  it('blocks a full-day request overlapping the half day, and a half day on a weekly off', async () => {
    const type = (await LeaveService.types()).find((t) => t.code === 'CL')!;
    await expect(
      LeaveService.apply(employee.id, { leaveTypeId: type.id, startDate: halfDayDate, endDate: halfDayDate, hrApproverId: hr.id }, {}),
    ).rejects.toMatchObject({ status: 409 });
    await expect(LeaveService.applyHalfDay(employee.id, { date: eligible[3], slot: 'first_half', hrApproverId: hr.id })).rejects.toMatchObject({ status: 400 });
  });

  it('deducts 0.5 from the leave balance only after HR approval and never touches weekly offs', async () => {
    const before = (await LeaveService.balances(employee.id, year)).find((b) => b.code === 'CL')!;
    await LeaveService.decide(firstHalfId, manager, { approve: true, stage: 'manager' }, {});
    expect((await LeaveService.balances(employee.id, year)).find((b) => b.code === 'CL')!.used).toBe(before.used);
    await LeaveService.decide(firstHalfId, hr, { approve: true, stage: 'hr' }, {});
    const after = (await LeaveService.balances(employee.id, year)).find((b) => b.code === 'CL')!;
    expect(after.used).toBeCloseTo(before.used + 0.5);
    const summary = await WeeklyOffService.monthSummary(employee.id, year, month);
    expect(summary.halfDays).toMatchObject({ taken: 1, deducted: 0.5 });
    expect(summary.weeklyOffs).toMatchObject({ allocated: 4, taken: 2, remaining: 2 });
    expect(await queryOne('SELECT status FROM attendance WHERE employee_id = ? AND work_date = ?', [employee.id, halfDayDate])).toMatchObject({ status: 'half_day' });
  });

  it('lists only the employee’s own requests in the "mine" scope', async () => {
    const mine = await LeaveService.list(employee, { scope: 'mine', pageSize: 100 });
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((item) => item.employeeId === employee.id)).toBe(true);
    expect(mine.items.some((item) => item.requestKind === 'weekly_off')).toBe(true);
    expect(mine.items.some((item) => item.requestKind === 'half_day')).toBe(true);
  });
});
