import { describe, it, expect } from 'vitest';
import { EmployeeActivityDetailsService } from '../src/services/EmployeeActivityDetailsService.js';
import { query, queryOne, execute } from '../src/db/index.js';
import type { AuthUser } from '../src/services/AuthService.js';
import { ApiError } from '../src/lib/http.js';

describe('Employee Activity Details & User Details Module', () => {
  it('enforces strict RBAC for user details and activity inspection', async () => {
    // Fetch active employees
    const employees = await query<{ id: number; full_name: string; email: string; role_name: string; location_id: number; manager_id: number | null }>(
      `SELECT e.id, e.full_name, e.email, r.name AS role_name, e.location_id, e.manager_id
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       WHERE e.status = 'active'
       ORDER BY e.id ASC LIMIT 5`,
    );
    expect(employees.length).toBeGreaterThanOrEqual(2);

    const emp1 = employees[0];
    const emp2 = employees[1];

    const emp1User: AuthUser = {
      id: emp1.id,
      email: emp1.email,
      roleId: 4,
      roleName: 'Employee',
      roleLevel: 10,
      permissions: ['activity.view.self'],
      locationId: emp1.location_id,
      departmentId: 1,
    };

    const adminUser: AuthUser = {
      id: 1,
      email: 'admin@bsctextiles.com',
      roleId: 1,
      roleName: 'Super Admin',
      roleLevel: 100,
      permissions: ['*'],
      locationId: null,
      departmentId: null,
    };

    // 1. Employee accessing self succeeds
    const selfDashboard = await EmployeeActivityDetailsService.getComprehensiveDashboard(emp1User, emp1.id);
    expect(selfDashboard).toBeDefined();
    expect(selfDashboard.profile.id).toBe(emp1.id);
    expect(selfDashboard.profile.fullName).toBe(emp1.full_name);

    // 2. Employee accessing another employee is strictly blocked with 403 Forbidden
    await expect(
      EmployeeActivityDetailsService.getComprehensiveDashboard(emp1User, emp2.id),
    ).rejects.toThrow(ApiError);

    // 3. Super Admin accessing employee succeeds
    const adminView = await EmployeeActivityDetailsService.getComprehensiveDashboard(adminUser, emp2.id);
    expect(adminView).toBeDefined();
    expect(adminView.profile.id).toBe(emp2.id);
  });

  it('provides all 8 comprehensive tabs in dashboard payload', async () => {
    const adminUser: AuthUser = {
      id: 1,
      email: 'admin@bsctextiles.com',
      roleId: 1,
      roleName: 'Super Admin',
      roleLevel: 100,
      permissions: ['*'],
      locationId: null,
      departmentId: null,
    };

    const emp = await queryOne<{ id: number }>('SELECT id FROM employees WHERE status = "active" LIMIT 1');
    expect(emp).toBeDefined();

    const dashboard = await EmployeeActivityDetailsService.getComprehensiveDashboard(adminUser, emp!.id);

    // Tab 1: Profile & Overview
    expect(dashboard.profile).toBeDefined();
    expect(dashboard.profile.id).toBe(emp!.id);
    expect(dashboard.overview).toBeDefined();
    expect(dashboard.overview.workingStatus).toBeDefined();
    expect(typeof dashboard.overview.attendanceMinutes).toBe('number');
    expect(typeof dashboard.overview.activeMinutes).toBe('number');
    expect(typeof dashboard.overview.idleMinutes).toBe('number');

    // Tab 2: Attendance
    expect(dashboard.attendance).toBeDefined();
    expect(dashboard.attendance.shiftSchedule).toBeDefined();
    expect(Array.isArray(dashboard.attendance.sessions)).toBe(true);

    // Tab 3: Activity Timeline
    expect(dashboard.timeline).toBeDefined();
    expect(Array.isArray(dashboard.timeline.events)).toBe(true);

    // Tab 4: Application Usage
    expect(dashboard.applications).toBeDefined();
    expect(Array.isArray(dashboard.applications.daily)).toBe(true);
    expect(dashboard.applications.summary).toBeDefined();

    // Tab 5: Website Usage
    expect(dashboard.websites).toBeDefined();
    expect(Array.isArray(dashboard.websites.items)).toBe(true);
    expect(dashboard.websites.categoryBreakdown).toBeDefined();

    // Tab 6: Idle Time
    expect(dashboard.idle).toBeDefined();
    expect(dashboard.idle.thresholds).toBeDefined();
    expect(Array.isArray(dashboard.idle.sessions)).toBe(true);

    // Tab 7: Login History
    expect(dashboard.logins).toBeDefined();
    expect(Array.isArray(dashboard.logins.history)).toBe(true);

    // Tab 8: Reports & Analytics
    expect(dashboard.reports).toBeDefined();
    expect(dashboard.reports.executiveSummary).toBeDefined();
  });

  it('ingests live agent events and reflects in real-time tracking status', async () => {
    const emp = await queryOne<{ id: number }>('SELECT id FROM employees WHERE status = "active" LIMIT 1');
    expect(emp).toBeDefined();
    const employeeId = emp!.id;
    const testDate = '2026-11-26';

    const events = [
      {
        type: 'app_launch',
        category: 'Development',
        title: 'Launched VS Code',
        details: 'Editing project files',
        appName: 'Visual Studio Code',
        windowTitle: 'E:/EMP_TRACKING - VS Code',
        source: 'desktop_agent',
        durationSeconds: 120,
        occurredAt: `${testDate} 10:00:00`,
      },
      {
        type: 'website_visit',
        category: 'Work-related',
        title: 'Visited GitHub',
        details: 'Pull requests',
        domain: 'github.com',
        url: 'https://github.com/bsc/hrms',
        source: 'browser_extension',
        durationSeconds: 90,
        occurredAt: `${testDate} 10:05:00`,
      },
      {
        type: 'idle_start',
        category: 'System',
        title: 'User Idle',
        details: 'Short break',
        source: 'desktop_agent',
        durationSeconds: 350,
        occurredAt: `${testDate} 10:15:00`,
      },
    ];

    const result = await EmployeeActivityDetailsService.ingestAgentEvents(employeeId, 1, events);
    expect(result.processed).toBe(3);

    // Verify tracking status was updated
    const status = await queryOne<{ employee_id: number; current_app: string; current_domain: string }>(
      'SELECT employee_id, current_app, current_domain FROM employee_tracking_status WHERE employee_id = ?',
      [employeeId],
    );
    expect(status).toBeDefined();
    expect(status!.current_app).toBe('Visual Studio Code');
    expect(status!.current_domain).toBe('github.com');
  });

  it('generates a well-structured CSV export of the employee activity report', async () => {
    const adminUser: AuthUser = {
      id: 1,
      email: 'admin@bsctextiles.com',
      roleId: 1,
      roleName: 'Super Admin',
      roleLevel: 100,
      permissions: ['*'],
      locationId: null,
      departmentId: null,
    };

    const emp = await queryOne<{ id: number }>('SELECT id FROM employees WHERE status = "active" LIMIT 1');
    expect(emp).toBeDefined();

    const csv = await EmployeeActivityDetailsService.exportUserActivity(adminUser, emp!.id);
    expect(typeof csv).toBe('string');
    expect(csv).toContain('BSC TEXTILES HRMS - EMPLOYEE ACTIVITY & DETAILS REPORT');
    expect(csv).toContain('ATTENDANCE SESSIONS');
    expect(csv).toContain('APPLICATION USAGE');
    expect(csv).toContain('WEBSITE USAGE');
    expect(csv).toContain('IDLE SESSIONS');
  });
});
