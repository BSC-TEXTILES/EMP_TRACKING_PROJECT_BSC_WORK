import { describe, it, expect } from 'vitest';
import { query, queryOne } from '../src/db/index.js';
import { ApiError } from '../src/lib/http.js';
import { EmployeeService } from '../src/services/EmployeeService.js';
import { HrService } from '../src/services/HrService.js';
import { DailyReportService } from '../src/services/DailyReportService.js';
import { ActivityAnalyticsService } from '../src/services/ActivityAnalyticsService.js';
import { TaskService } from '../src/services/TaskService.js';
import type { AuthUser } from '../src/services/AuthService.js';

describe('Employee Data Privacy and Role-Based Access Control (RBAC)', () => {
  it('enforces strict employee profile isolation and prevents IDOR', async () => {
    const emps = await query<{ id: number; full_name: string; email: string; location_id: number | null; manager_id: number | null }>(
      `SELECT id, full_name, email, location_id, manager_id FROM employees WHERE status = 'active' ORDER BY id ASC LIMIT 5`,
    );
    expect(emps.length).toBeGreaterThanOrEqual(2);

    const emp1 = emps[0];
    const emp2 = emps[1];

    const emp1User: AuthUser = {
      id: emp1.id,
      email: emp1.email,
      roleId: 4,
      roleName: 'Employee',
      roleSlug: 'employee',
      roleLevel: 10,
      permissions: ['employees.view.own'],
      locationId: emp1.location_id,
      departmentId: 1,
    };

    // 1. Employee can access their own profile
    const ownProfile = await EmployeeService.detail(emp1.id, emp1User);
    expect(ownProfile).toBeDefined();
    expect(ownProfile.id).toBe(emp1.id);
    expect(ownProfile.fullName).toBe(emp1.full_name);

    // 2. Employee cannot access another employee profile (HTTP 403)
    await expect(EmployeeService.detail(emp2.id, emp1User)).rejects.toThrow(ApiError);
    try {
      await EmployeeService.detail(emp2.id, emp1User);
    } catch (e: any) {
      expect(e.status).toBe(403);
      expect(e.message).toContain('You do not have access to this employee record');
    }

    // 3. Employee cannot update another employee profile (HTTP 403)
    await expect(
      EmployeeService.update(emp2.id, emp1User, { fullName: 'Hacked Name' }),
    ).rejects.toThrow(ApiError);
    try {
      await EmployeeService.update(emp2.id, emp1User, { fullName: 'Hacked Name' });
    } catch (e: any) {
      expect(e.status).toBe(403);
    }
  });

  it('restricts employee picker to self, manager, and HR for ordinary employees', async () => {
    const emps = await query<{ id: number; full_name: string; email: string; location_id: number | null; manager_id: number | null }>(
      `SELECT id, full_name, email, location_id, manager_id FROM employees WHERE status = 'active' ORDER BY id ASC LIMIT 5`,
    );
    const emp1 = emps[0];

    const emp1User: AuthUser = {
      id: emp1.id,
      email: emp1.email,
      roleId: 4,
      roleName: 'Employee',
      roleSlug: 'employee',
      roleLevel: 10,
      permissions: ['employees.view.own'],
      locationId: emp1.location_id,
      departmentId: 1,
    };

    const pickerList = await EmployeeService.picker(emp1User);
    expect(pickerList).toBeDefined();

    // Verify ordinary employee only sees their permitted contacts (never company-wide directory)
    const pickerIds = pickerList.map((p) => p.id);
    expect(pickerIds).toContain(emp1.id);

    // All returned picker entries must be self, their manager, or their HR rep
    for (const item of pickerList) {
      const isSelf = item.id === emp1.id;
      const isManager = emp1.manager_id && item.id === emp1.manager_id;
      // Should not contain random other employees
      expect(isSelf || isManager || item.roleName?.toLowerCase().includes('hr')).toBeTruthy();
    }
  });

  it('enforces privacy for HR documents and salary compensation', async () => {
    const emps = await query<{ id: number; full_name: string; email: string; location_id: number | null }>(
      `SELECT id, full_name, email, location_id FROM employees WHERE status = 'active' ORDER BY id ASC LIMIT 5`,
    );
    const emp1 = emps[0];
    const emp2 = emps[1];

    const emp1User: AuthUser = {
      id: emp1.id,
      email: emp1.email,
      roleId: 4,
      roleName: 'Employee',
      roleSlug: 'employee',
      roleLevel: 10,
      permissions: ['employees.view.own'],
      locationId: emp1.location_id,
      departmentId: 1,
    };

    // 1. Employee cannot view another employee's documents
    await expect(HrService.listDocuments({ employeeId: emp2.id }, emp1User)).rejects.toThrow(ApiError);
    try {
      await HrService.listDocuments({ employeeId: emp2.id }, emp1User);
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // 2. Employee cannot view another employee's salary
    await expect(HrService.listSalaries({ employeeId: emp2.id }, emp1User)).rejects.toThrow(ApiError);
    try {
      await HrService.listSalaries({ employeeId: emp2.id }, emp1User);
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // 3. Employee cannot view another employee's payroll records
    await expect(
      HrService.listPayrollRecords({ month: 11, year: 2026, employeeId: emp2.id }, emp1User),
    ).rejects.toThrow(ApiError);
    try {
      await HrService.listPayrollRecords({ month: 11, year: 2026, employeeId: emp2.id }, emp1User);
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // 4. Listing salaries without employeeId filter automatically restricts to own record
    const ownSalaries = await HrService.listSalaries({}, emp1User);
    for (const s of ownSalaries) {
      expect(s.employeeId).toBe(emp1.id);
    }
  });

  it('enforces daily work reports and activity analytics privacy', async () => {
    const emps = await query<{ id: number; full_name: string; email: string; location_id: number | null }>(
      `SELECT id, full_name, email, location_id FROM employees WHERE status = 'active' ORDER BY id ASC LIMIT 5`,
    );
    const emp1 = emps[0];
    const emp2 = emps[1];

    const emp1User: AuthUser = {
      id: emp1.id,
      email: emp1.email,
      roleId: 4,
      roleName: 'Employee',
      roleSlug: 'employee',
      roleLevel: 10,
      permissions: ['reports.view.own', 'activity.view.own', 'tasks.view.own'],
      locationId: emp1.location_id,
      departmentId: 1,
    };

    // 1. Employee cannot filter reports by another employee
    await expect(DailyReportService.list(emp1User, { employeeId: emp2.id })).rejects.toThrow(ApiError);
    try {
      await DailyReportService.list(emp1User, { employeeId: emp2.id });
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // 2. Employee cannot inspect daily activity of another employee
    await expect(ActivityAnalyticsService.daily(emp1User, emp2.id, '2026-11-20')).rejects.toThrow(ApiError);
    try {
      await ActivityAnalyticsService.daily(emp1User, emp2.id, '2026-11-20');
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // 3. Employee cannot target another employee in selfDashboard
    await expect(ActivityAnalyticsService.selfDashboard(emp1User, '2026-11-20', emp2.id)).rejects.toThrow(ApiError);
    try {
      await ActivityAnalyticsService.selfDashboard(emp1User, '2026-11-20', emp2.id);
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // 4. Employee cannot query tasks assigned to another employee
    await expect(TaskService.list(emp1User, { assigneeId: emp2.id })).rejects.toThrow(ApiError);
    try {
      await TaskService.list(emp1User, { assigneeId: emp2.id });
    } catch (e: any) {
      expect(e.status).toBe(403);
    }
  });

  it('enforces store-location boundaries for Location HR', async () => {
    // Find locations
    const locations = await query<{ id: number; code: string }>('SELECT id, code FROM locations ORDER BY id ASC LIMIT 3');
    if (locations.length < 2) return;

    const locA = locations[0];
    const locB = locations[1];

    const empInLocB = await queryOne<{ id: number; full_name: string; email: string }>(
      'SELECT id, full_name, email FROM employees WHERE location_id = ? AND status = "active" LIMIT 1',
      [locB.id],
    );
    if (!empInLocB) return;

    // Location HR for Store A only
    const hrLocA: AuthUser = {
      id: 99999,
      email: 'hr.loca@bsctextiles.com',
      roleId: 2,
      roleName: 'HR Manager',
      roleSlug: 'hr_manager',
      roleLevel: 80,
      permissions: ['employees.view.all', 'employees.manage', 'reports.view.all', 'activity.view.all'],
      locationId: locA.id,
      departmentId: 1,
    };

    // HR of Store A cannot access employee in Store B (HTTP 403)
    await expect(EmployeeService.detail(empInLocB.id, hrLocA)).rejects.toThrow(ApiError);
    try {
      await EmployeeService.detail(empInLocB.id, hrLocA);
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // HR of Store A cannot view documents of employee in Store B
    await expect(HrService.listDocuments({ employeeId: empInLocB.id }, hrLocA)).rejects.toThrow(ApiError);
    try {
      await HrService.listDocuments({ employeeId: empInLocB.id }, hrLocA);
    } catch (e: any) {
      expect(e.status).toBe(403);
    }

    // HR of Store A cannot generate payroll for Store B
    await expect(HrService.generateMonthlyPayroll(11, 2026, hrLocA, locB.id)).rejects.toThrow(ApiError);
    try {
      await HrService.generateMonthlyPayroll(11, 2026, hrLocA, locB.id);
    } catch (e: any) {
      expect(e.status).toBe(403);
    }
  });
});
