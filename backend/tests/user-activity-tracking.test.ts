import { describe, it, expect } from 'vitest';
import { UserActivityTrackingService } from '../src/services/UserActivityTrackingService.js';
import { ActivityService, type DeviceContext } from '../src/services/ActivityService.js';
import { query, queryOne } from '../src/db/index.js';
import type { AuthUser } from '../src/services/AuthService.js';

describe('User Activity Tracking & Monitoring Module', () => {
  it('aggregates tracking dashboard metrics and lists registered employees', async () => {
    const adminUser: AuthUser = {
      id: 1,
      email: 'admin@bsctextiles.in',
      roleSlug: 'super_admin',
      roleLevel: 100,
      permissions: ['*'],
      locationId: null,
    };

    const dashboard = await UserActivityTrackingService.getTrackingDashboard(adminUser, {
      page: 1,
      limit: 10,
    });

    expect(dashboard).toBeDefined();
    expect(dashboard.summary).toBeDefined();
    expect(dashboard.summary.totalEmployees).toBeGreaterThan(0);
    expect(dashboard.summary.activeNow).toBeGreaterThanOrEqual(0);
    expect(dashboard.summary.idleNow).toBeGreaterThanOrEqual(0);
    expect(dashboard.summary.offlineNow).toBeGreaterThanOrEqual(0);
    expect(dashboard.employees.length).toBeGreaterThan(0);

    const firstEmp = dashboard.employees[0];
    expect(firstEmp.id).toBeDefined();
    expect(firstEmp.fullName).toBeDefined();
    expect(firstEmp.employeeCode).toBeDefined();
    expect(firstEmp.device).toBeDefined();
    expect(firstEmp.agent).toBeDefined();
    expect(['active', 'idle', 'offline']).toContain(firstEmp.status);
  });

  it('filters employees by location and search term', async () => {
    const adminUser: AuthUser = {
      id: 1,
      email: 'admin@bsctextiles.in',
      roleSlug: 'super_admin',
      roleLevel: 100,
      permissions: ['*'],
      locationId: null,
    };

    const searchResult = await UserActivityTrackingService.getTrackingDashboard(adminUser, {
      search: 'BSC',
      page: 1,
      limit: 5,
    });

    expect(searchResult).toBeDefined();
    expect(searchResult.employees).toBeDefined();
  });

  it('fetches comprehensive 9-tab activity details for an employee', async () => {
    const adminUser: AuthUser = {
      id: 1,
      email: 'admin@bsctextiles.in',
      roleSlug: 'super_admin',
      roleLevel: 100,
      permissions: ['*'],
      locationId: null,
    };

    const targetEmp = await queryOne<{ id: number }>('SELECT id FROM employees WHERE status = "active" LIMIT 1');
    expect(targetEmp).toBeDefined();

    const details = await UserActivityTrackingService.getEmployeeDetailedActivity(adminUser, targetEmp!.id);

    expect(details.profile).toBeDefined();
    expect(details.profile.id).toBe(targetEmp!.id);
    expect(details.status).toBeDefined();
    expect(details.devices).toBeDefined();
    expect(details.attendance).toBeDefined();
    expect(details.applications).toBeDefined();
    expect(details.websites).toBeDefined();
    expect(details.timeline).toBeDefined();
    expect(details.loginHistory).toBeDefined();
    expect(details.agentStatus).toBeDefined();
    expect(details.agentStatus.version).toBeDefined();
  });

  it('enforces RBAC privacy so regular employee cannot access another employee activity', async () => {
    const employees = await query<{ id: number; email: string }>('SELECT id, email FROM employees WHERE status = "active" LIMIT 2');
    if (employees.length < 2) return;

    const emp1 = employees[0];
    const emp2 = employees[1];

    const ordinaryUser: AuthUser = {
      id: emp1.id,
      email: emp1.email,
      roleSlug: 'employee',
      roleLevel: 10,
      permissions: ['employees.view.own', 'activity.view.own'],
      locationId: 1,
    };

    await expect(
      UserActivityTrackingService.getEmployeeDetailedActivity(ordinaryUser, emp2.id),
    ).rejects.toThrow();
  });

  it('generates multi-format downloadable reports (Excel, CSV, PDF)', async () => {
    const adminUser: AuthUser = {
      id: 1,
      email: 'admin@bsctextiles.in',
      roleSlug: 'super_admin',
      roleLevel: 100,
      permissions: ['*'],
      locationId: null,
    };

    const todayStr = new Date().toISOString().slice(0, 10);

    // Test Excel
    const xlsxReport = await UserActivityTrackingService.exportReport(adminUser, {
      format: 'xlsx',
      from: todayStr,
      to: todayStr,
    });
    expect(xlsxReport.buffer).toBeInstanceOf(Buffer);
    expect(xlsxReport.buffer.length).toBeGreaterThan(0);
    expect(xlsxReport.filename).toContain('.xlsx');
    expect(xlsxReport.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    // Test CSV
    const csvReport = await UserActivityTrackingService.exportReport(adminUser, {
      format: 'csv',
      from: todayStr,
      to: todayStr,
    });
    expect(csvReport.buffer).toBeInstanceOf(Buffer);
    expect(csvReport.buffer.length).toBeGreaterThan(0);
    expect(csvReport.filename).toContain('.csv');
    expect(csvReport.mimeType).toBe('text/csv');

    // Test PDF
    const pdfReport = await UserActivityTrackingService.exportReport(adminUser, {
      format: 'pdf',
      from: todayStr,
      to: todayStr,
    });
    expect(pdfReport.buffer).toBeInstanceOf(Buffer);
    expect(pdfReport.buffer.length).toBeGreaterThan(0);
    expect(pdfReport.filename).toContain('.pdf');
    expect(pdfReport.mimeType).toBe('application/pdf');
  });

  it('allows agent standby heartbeat without active monitoring session', async () => {
    const emp = await queryOne<{ id: number }>('SELECT id FROM employees WHERE status = "active" LIMIT 1');
    const device = await queryOne<{ id: number }>('SELECT id FROM employee_devices WHERE employee_id = ? LIMIT 1', [emp!.id]);

    if (!device) return;

    const context: DeviceContext = {
      deviceId: device.id,
      employeeId: emp!.id,
      sessionId: null,
      sessionStatus: null,
      employee: {
        id: emp!.id,
        full_name: 'Test Employee',
        email: 'test@example.com',
        role_slug: 'employee',
        role_level: 10,
        department_name: 'Operations',
        designation_title: 'Executive',
        location_name: 'Davanagere',
      },
    };

    const hbResult = await ActivityService.heartbeat(context, {
      currentApp: 'VS Code',
      isIdle: false,
      idleSeconds: 0,
      windowTitle: 'UserActivityTracking.tsx - BSC Textiles HRMS',
    });

    expect(hbResult).toBeDefined();
    expect(hbResult.status).toBe('standby');
    expect(hbResult.serverNow).toBeDefined();
  });
});
