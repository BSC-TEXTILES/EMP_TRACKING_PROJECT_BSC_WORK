import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DailyReportService } from '../src/services/DailyReportService.js';
import { LeaveService } from '../src/services/LeaveService.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { execute, queryOne, closePool } from '../src/db/index.js';

let superAdmin: AuthUser;
let employee: AuthUser;
let reportId: number;

beforeAll(async () => {
  // Ensure Super Admin exists
  const adminRow = await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE role_id = (SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1) LIMIT 1`
  );
  if (adminRow) {
    superAdmin = (await AuthService.buildUser(adminRow.id))!;
  }

  // Use Nitin Jadhav who is an active staff employee with assigned Location & HR
  let empRow = await queryOne<{ id: number }>('SELECT id FROM employees WHERE email = ?', ['nitin.jadhav@bsctextiles.in']);
  if (!empRow) {
    empRow = await queryOne<{ id: number }>('SELECT id FROM employees WHERE status = "active" LIMIT 1');
  }
  employee = (await AuthService.buildUser(empRow!.id))!;
  await execute('DELETE FROM leave_requests WHERE employee_id = ? AND start_date >= CURDATE()', [employee.id]);
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await closePool();
});

describe('EOD Work Report & Leave Workflow Integration', () => {
  it('allows an employee to submit an EOD report with work completed', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Remove any existing report for today in test database
    await execute('DELETE FROM daily_work_reports WHERE employee_id = ? AND report_date = ?', [employee.id, today]);

    const submitResult = await DailyReportService.submit(
      employee.id,
      {
        reportDate: today,
        summary: 'Completed inventory reconciliation for Belagavi retail store and resolved customer tickets.',
        problems: 'Minor network latency during POS sync.',
        supportRequired: 'Need database access for POS reports.',
        tomorrowPlan: 'Follow up on Davanagere shipment.',
        tasksCompleted: 4,
        tasksInProgress: 1,
        tasksPending: 0,
      },
      { ip: '127.0.0.1' }
    );

    expect(submitResult.id).toBeDefined();
    reportId = submitResult.id!;

    const result = await DailyReportService.detail(reportId, employee);
    expect(result).toBeDefined();
    expect(result.status).toBe('submitted');
    expect(result.summary).toContain('Completed inventory reconciliation');
  });

  it('allows manager/admin to request changes with a review note', async () => {
    expect(reportId).toBeDefined();

    await DailyReportService.review(
      reportId,
      superAdmin,
      {
        approve: false,
        note: 'Please provide more details regarding customer tickets resolved.',
      },
      { ip: '127.0.0.1' }
    );

    const updated = await DailyReportService.detail(reportId, superAdmin);
    expect(updated.status).toBe('changes_requested');
    expect(updated.reviewNote).toContain('Please provide more details');
  });

  it('allows the employee to edit report and update status back to submitted', async () => {
    expect(reportId).toBeDefined();

    const result = await DailyReportService.update(
      reportId,
      employee,
      {
        summary: 'Completed inventory reconciliation for Belagavi retail store. Resolved 3 customer tickets for billing adjustments.',
        tasksCompleted: 5,
      },
      { ip: '127.0.0.1' }
    );

    expect(result).toBeDefined();
    expect(result.status).toBe('submitted');
    expect(result.tasksCompleted).toBe(5);
    expect(result.summary).toContain('Resolved 3 customer tickets');
  });

  it('allows manager/admin to approve the edited report', async () => {
    expect(reportId).toBeDefined();

    await DailyReportService.review(
      reportId,
      superAdmin,
      {
        approve: true,
        note: 'Looks good. Approved.',
      },
      { ip: '127.0.0.1' }
    );

    const approved = await DailyReportService.detail(reportId, superAdmin);
    expect(approved.status).toBe('approved');
  });

  it('allows applying for leave without requiring a reason', async () => {
    const leaveType = await queryOne<{ id: number }>('SELECT id FROM leave_types WHERE is_active = 1 AND code = "CL" LIMIT 1');
    if (!leaveType) return;

    const routing = await LeaveService.applicationContext(employee.id);
    const hrApproverId = routing.hrApprovers[0]?.id;

    // Next week Wednesday to Thursday
    const d1 = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);
    const d2 = new Date(Date.now() + 86400000 * 4).toISOString().slice(0, 10);

    const leave = await LeaveService.apply(
      employee.id,
      {
        leaveTypeId: leaveType.id,
        startDate: d1,
        endDate: d2,
        reason: undefined, // Reason is optional!
        hrApproverId,
      },
      { ip: '127.0.0.1' }
    );

    expect(leave).toBeDefined();
    expect(leave.id).toBeGreaterThan(0);
  });
});
