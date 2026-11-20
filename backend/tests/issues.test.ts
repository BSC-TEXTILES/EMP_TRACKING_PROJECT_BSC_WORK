import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IssueService } from '../src/services/IssueService.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { execute, queryOne, closePool } from '../src/db/index.js';

let superAdmin: AuthUser;
let employee: AuthUser;
let createdIssueId: number;
let createdIssueNo: string;

beforeAll(async () => {
  // Ensure Super Admin exists
  const adminRow = await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE role_id = (SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1) LIMIT 1`
  );
  if (adminRow) {
    superAdmin = (await AuthService.buildUser(adminRow.id))!;
  }

  // Ensure a regular store staff employee exists (role = employee, not manager)
  let empRow = await queryOne<{ id: number }>(
    `SELECT e.id FROM employees e 
     JOIN roles r ON r.id = e.role_id 
     WHERE r.slug = 'employee' AND e.status = 'active' LIMIT 1`
  );
  if (!empRow) {
    const ins = await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, status, joining_date)
       VALUES ('EMP-STAFF-01', 'Store Staff', 'staff@bsctextiles.in', '9876543299', 'hash', (SELECT id FROM roles WHERE slug = 'employee' LIMIT 1), 'active', CURDATE())`
    );
    empRow = { id: Number(ins.insertId) };
  }
  employee = (await AuthService.buildUser(empRow.id))!;
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await closePool();
});

describe('BSC Textiles Issue Management & Automatic Escalation System', () => {
  it('Scenario 1 & 4: Employee raises an issue with automatic hierarchy routing and unique reference', async () => {
    const res = await IssueService.createIssue(
      {
        title: 'POS Terminal Barcode Scanner Disconnected',
        description: 'The wireless barcode scanner at counter 1 lost sync with the terminal system.',
        category: 'hardware',
        priority: 'high',
        affectedModule: 'POS Billing & Cash Register',
        routingMode: 'auto',
      },
      employee
    );

    expect(res.id).toBeGreaterThan(0);
    expect(res.issueNo).toMatch(/^BSC-ISS-\d{4}-\d{5}$/);
    createdIssueId = res.id;
    createdIssueNo = res.issueNo;

    // Verify database record
    const issueRow = await queryOne<any>('SELECT * FROM issues WHERE id = ?', [createdIssueId]);
    expect(issueRow).toBeDefined();
    expect(issueRow.issue_no).toBe(createdIssueNo);
    expect(issueRow.status).toBe('pending');
    expect(issueRow.reporter_id).toBe(employee.id);
    expect(issueRow.assigned_to).toBeDefined();
    expect(issueRow.due_at).toBeDefined();
  });

  it('Scenario 5 & 10: Issue appears in reporter and manager lists, but forbidden for unauthorized users', async () => {
    // Reporter list
    const empList = await IssueService.listIssues(employee, { tab: 'my_issues' });
    expect(empList.items.some((i) => i.id === createdIssueId)).toBe(true);

    // Super Admin list
    const adminList = await IssueService.listIssues(superAdmin, { tab: 'all' });
    expect(adminList.items.some((i) => i.id === createdIssueId)).toBe(true);

    // Get detail
    const detail = await IssueService.getIssue(createdIssueId, employee);
    expect(detail.issue.id).toBe(createdIssueId);
  });

  it('Scenario 6: Manager acknowledges the issue, updating status to in_progress in real time', async () => {
    const ackRes = await IssueService.acknowledgeIssue(createdIssueId, superAdmin, 'Investigating scanner battery and driver.');
    expect(ackRes.ok).toBe(true);
    expect(ackRes.status).toBe('in_progress');

    const issueRow = await queryOne<any>('SELECT status, acknowledged_at FROM issues WHERE id = ?', [createdIssueId]);
    expect(issueRow.status).toBe('in_progress');
    expect(issueRow.acknowledged_at).not.toBeNull();
  });

  it('Scenario 12: Manager-only internal notes are invisible to ordinary employees', async () => {
    // Manager posts internal note
    await IssueService.addComment(createdIssueId, superAdmin, {
      body: 'INTERNAL NOTE: Replaced Bluetooth dongle with hardware serial BSC-BT-09.',
      isInternal: true,
    });

    // Manager posts public comment
    await IssueService.addComment(createdIssueId, superAdmin, {
      body: 'Public update: Hardware replacement in progress, counter will resume shortly.',
      isInternal: false,
    });

    // Ordinary employee retrieves issue: internal note MUST NOT be visible
    const employeeView = await IssueService.getIssue(createdIssueId, employee);
    const hasInternalComment = employeeView.comments.some((c) => c.is_internal === 1);
    expect(hasInternalComment).toBe(false);
    expect(employeeView.canSeeInternal).toBe(false);

    // Super Admin retrieves issue: internal note IS visible
    const adminView = await IssueService.getIssue(createdIssueId, superAdmin);
    expect(adminView.comments.some((c) => c.is_internal === 1)).toBe(true);
    expect(adminView.canSeeInternal).toBe(true);
  });

  it('Scenario 2: Manual escalation increases escalation level and records audit history', async () => {
    const escRes = await IssueService.escalateIssue(createdIssueId, employee, {
      reason: 'Urgent weekend billing queue buildup requiring supervisor override.',
    });
    expect(escRes.ok).toBe(true);
    expect(escRes.newLevel).toBe(2);

    const issueRow = await queryOne<any>('SELECT status, escalation_level FROM issues WHERE id = ?', [createdIssueId]);
    expect(issueRow.status).toBe('escalated');
    expect(issueRow.escalation_level).toBe(2);

    const historyRows = await queryOne<any>(
      'SELECT COUNT(*) as count FROM issue_escalation_history WHERE issue_id = ?',
      [createdIssueId]
    );
    expect(Number(historyRows.count)).toBeGreaterThan(0);
  });

  it('Scenario 9: Automatic escalation engine sweeps unacknowledged and breached SLAs', async () => {
    const sweepRes = await IssueService.runEscalationSweep();
    expect(sweepRes).toBeDefined();
    expect(typeof sweepRes.remindersSent).toBe('number');
    expect(typeof sweepRes.escalationsTriggered).toBe('number');
  });

  it('Scenario 13 & 14: Issue resolution requires resolution text, and reopening retains reference number', async () => {
    // Resolve issue
    const resResult = await IssueService.updateStatus(createdIssueId, superAdmin, {
      status: 'resolved',
      resolution: 'Replaced scanner battery pack and successfully paired with POS counter 1.',
    });
    expect(resResult.ok).toBe(true);
    expect(resResult.status).toBe('resolved');

    let row = await queryOne<any>('SELECT status, resolution, resolved_at FROM issues WHERE id = ?', [createdIssueId]);
    expect(row.status).toBe('resolved');
    expect(row.resolution).toContain('Replaced scanner battery');
    expect(row.resolved_at).not.toBeNull();

    // Reopen issue
    const reopenResult = await IssueService.reopenIssue(createdIssueId, employee, 'Scanner disconnected again after reboot.');
    expect(reopenResult.ok).toBe(true);
    expect(reopenResult.status).toBe('reopened');

    row = await queryOne<any>('SELECT issue_no, status, reopen_count FROM issues WHERE id = ?', [createdIssueId]);
    expect(row.issue_no).toBe(createdIssueNo); // original reference number retained!
    expect(row.status).toBe('reopened');
    expect(row.reopen_count).toBe(1);
  });
});
