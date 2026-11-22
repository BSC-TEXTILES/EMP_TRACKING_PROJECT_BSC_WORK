import { describe, it, expect } from 'vitest';
import { AttendanceService } from '../src/services/AttendanceService';
import { queryOne, execute } from '../src/db';

describe('Attendance Multiple Sessions & Flow', () => {
  it('supports multiple sessions per day with accurate state and cumulative minutes', async () => {
    // Pick an active employee for testing
    const emp = await queryOne<{ id: number }>('SELECT id FROM employees WHERE status = "active" LIMIT 1');
    expect(emp).toBeDefined();
    const employeeId = emp!.id;
    const testDate = '2026-11-25'; // future date to isolate test

    // Clean up any test records for this date
    await execute('DELETE FROM attendance_breaks WHERE employee_id = ?', [employeeId]);
    await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, testDate]);

    // 1. Initial state: not checked in
    const initialState = await AttendanceService.stateFor(employeeId, testDate);
    expect(initialState.canCheckIn).toBe(true);
    expect(initialState.canCheckOut).toBe(false);
    expect(initialState.sessions).toHaveLength(0);

    // 2. Check in Session #1 directly via DB mock insertion
    await execute(
      `INSERT INTO attendance (employee_id, work_date, session_number, check_in_at, status, is_late, total_minutes, break_minutes)
       VALUES (?, ?, 1, '2026-11-25 09:00:00', 'present', 0, 0, 0)`,
      [employeeId, testDate],
    );

    const s1ActiveState = await AttendanceService.stateFor(employeeId, testDate);
    expect(s1ActiveState.canCheckIn).toBe(false);
    expect(s1ActiveState.canCheckOut).toBe(true);
    expect(s1ActiveState.sessions).toHaveLength(1);
    expect(s1ActiveState.sessions[0].sessionNumber).toBe(1);
    expect(s1ActiveState.sessions[0].isActive).toBe(true);

    // 3. Check out Session #1 (e.g. 180 minutes worked)
    await execute(
      `UPDATE attendance SET check_out_at = '2026-11-25 12:00:00', total_minutes = 180
       WHERE employee_id = ? AND work_date = ? AND session_number = 1`,
      [employeeId, testDate],
    );

    const s1ClosedState = await AttendanceService.stateFor(employeeId, testDate);
    // CRITICAL: Employee MUST be able to check in again after session 1 check-out!
    expect(s1ClosedState.canCheckIn).toBe(true);
    expect(s1ClosedState.canCheckOut).toBe(false);
    expect(s1ClosedState.totalMinutes).toBe(180);
    expect(s1ClosedState.sessions).toHaveLength(1);
    expect(s1ClosedState.sessions[0].isActive).toBe(false);

    // 4. Check in Session #2 (e.g. afternoon session)
    await execute(
      `INSERT INTO attendance (employee_id, work_date, session_number, check_in_at, status, is_late, total_minutes, break_minutes)
       VALUES (?, ?, 2, '2026-11-25 13:00:00', 'present', 0, 0, 0)`,
      [employeeId, testDate],
    );

    const s2ActiveState = await AttendanceService.stateFor(employeeId, testDate);
    expect(s2ActiveState.canCheckIn).toBe(false);
    expect(s2ActiveState.canCheckOut).toBe(true);
    expect(s2ActiveState.sessions).toHaveLength(2);
    expect(s2ActiveState.sessions[1].sessionNumber).toBe(2);
    expect(s2ActiveState.sessions[1].isActive).toBe(true);

    // 5. Check out Session #2 (e.g. 240 minutes worked)
    await execute(
      `UPDATE attendance SET check_out_at = '2026-11-25 17:00:00', total_minutes = 240
       WHERE employee_id = ? AND work_date = ? AND session_number = 2`,
      [employeeId, testDate],
    );

    const s2ClosedState = await AttendanceService.stateFor(employeeId, testDate);
    expect(s2ClosedState.canCheckIn).toBe(true);
    expect(s2ClosedState.canCheckOut).toBe(false);
    // Cumulative worked minutes must be 180 + 240 = 420
    expect(s2ClosedState.totalMinutes).toBe(420);
    expect(s2ClosedState.sessions).toHaveLength(2);
    expect(s2ClosedState.sessions[0].totalMinutes).toBe(180);
    expect(s2ClosedState.sessions[1].totalMinutes).toBe(240);

    // Clean up
    await execute('DELETE FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, testDate]);
  });
});
