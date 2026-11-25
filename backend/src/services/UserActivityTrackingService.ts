import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { execute, query, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { today } from '../lib/dates.js';
import { allowedLocationIds, assertEmployeeAccess, locationEmployeeClause, subtreeIds } from '../lib/scope.js';
import { broadcastEvent } from '../realtime/io.js';
import type { AuthUser } from './AuthService.js';

export interface TrackingFilterOptions {
  search?: string;
  locationId?: number;
  locationCode?: string;
  status?: string; // 'Active' | 'Idle' | 'Offline' | 'On Break'
  agentInstalled?: boolean;
  departmentId?: number;
  sortBy?: 'lastActive' | 'name' | 'workedTime' | 'location';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  limit?: number;
  date?: string;
}

export interface EmployeeTrackingSummary {
  totalRegistered: number;
  currentlyActive: number;
  idleEmployees: number;
  offlineEmployees: number;
  agentInstalled: number;
  agentNotInstalled: number;
  totalActiveWorkingHours: number;
  totalIdleHours: number;
  connectedDevices: number;
  syncFailures: number;
}

export interface EmployeeTrackingItem {
  id: number;
  fullName: string;
  employeeCode: string;
  photoUrl: string | null;
  email: string;
  mobile: string | null;
  departmentId: number | null;
  departmentName: string | null;
  designationId: number | null;
  designationTitle: string | null;
  locationId: number | null;
  locationCode: string | null;
  locationName: string | null;
  managerId: number | null;
  managerName: string | null;
  deviceId: number | null;
  deviceName: string;
  deviceType: string;
  osName: string;
  osVersion: string | null;
  agentVersion: string | null;
  deviceConnectionStatus: 'connected' | 'disconnected' | 'never_connected';
  agentInstallationStatus: 'installed' | 'not_installed';
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  currentActivityStatus: 'Active' | 'Idle' | 'On Break' | 'Offline';
  currentApp: string | null;
  currentDomain: string | null;
  lastActiveAt: string | null;
  activeMinutesToday: number;
  idleMinutesToday: number;
  checkInAt: string | null;
  checkOutAt: string | null;
  status?: 'active' | 'idle' | 'offline';
  isOnline?: boolean;
  currentWindow?: string | null;
  idleDurationSeconds?: number;
  device?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  todaySummary?: Record<string, unknown>;
}

export class UserActivityTrackingService {
  /**
   * Returns list of employees with real-time tracking, device and status indicators.
   */
  static async getTrackingDashboard(
    currentUser: AuthUser,
    filters: TrackingFilterOptions = {},
  ): Promise<{
    summary: EmployeeTrackingSummary & {
      totalEmployees: number;
      activeNow: number;
      idleNow: number;
      offlineNow: number;
      totalActiveHours: number;
      totalIdleHours: number;
    };
    items: EmployeeTrackingItem[];
    employees: EmployeeTrackingItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
    locations: Array<{ id: number; code: string; name: string }>;
    departments: Array<{ id: number; name: string }>;
  }> {
    const isSuperAdmin = currentUser.roleSlug === 'super_admin' || (currentUser.roleLevel ?? 0) >= 100;
    const isHr = currentUser.permissions.includes('employees.manage') || currentUser.permissions.includes('activity.view.all');
    const isManager = currentUser.permissions.includes('employees.view.team') || currentUser.permissions.includes('activity.view.team');

    const whereClauses: string[] = ["e.status = 'active'"];
    const params: unknown[] = [];

    // RBAC Scoping
    if (!isSuperAdmin) {
      if (isHr) {
        const locClause = await locationEmployeeClause(currentUser, 'e.id');
        whereClauses.push(locClause.clause);
        params.push(...locClause.params);
      } else if (isManager) {
        const ids = await subtreeIds(currentUser.id);
        if (ids.length === 0) {
          return {
            summary: {
              totalRegistered: 0,
              totalEmployees: 0,
              currentlyActive: 0,
              activeNow: 0,
              idleEmployees: 0,
              idleNow: 0,
              offlineEmployees: 0,
              offlineNow: 0,
              agentInstalled: 0,
              agentNotInstalled: 0,
              totalActiveWorkingHours: 0,
              totalActiveHours: 0,
              totalIdleHours: 0,
              connectedDevices: 0,
              syncFailures: 0,
            },
            items: [],
            employees: [],
            total: 0,
            page: 1,
            pageSize: 25,
            totalPages: 0,
            pagination: { total: 0, page: 1, limit: 25, totalPages: 0 },
            locations: [],
            departments: [],
          };
        }
        whereClauses.push(`e.id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      } else {
        whereClauses.push('e.id = ?');
        params.push(currentUser.id);
      }
    }

    // Filters
    if (filters.locationId) {
      whereClauses.push('e.location_id = ?');
      params.push(filters.locationId);
    }
    if (filters.locationCode) {
      whereClauses.push('l.code = ?');
      params.push(filters.locationCode.toUpperCase());
    }
    if (filters.departmentId) {
      whereClauses.push('e.department_id = ?');
      params.push(filters.departmentId);
    }
    if (filters.search) {
      const term = `%${filters.search.trim()}%`;
      whereClauses.push('(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR ed.device_name LIKE ?)');
      params.push(term, term, term, term);
    }

    const whereSql = whereClauses.join(' AND ');
    const targetDate = today();

    // Query all matching employees with device & live tracking joins
    const sql = `
      SELECT 
        e.id, e.full_name, e.employee_code, e.photo_url, e.email, e.mobile,
        e.department_id, d.name AS department_name,
        e.designation_id, des.title AS designation_title,
        e.location_id, l.code AS location_code, l.name AS location_name,
        e.manager_id, m.full_name AS manager_name,
        ed.id AS device_id,
        COALESCE(ed.device_name, edr.device_name, 'No Device') AS device_name,
        COALESCE(ed.os_name, edr.os_name, 'Unknown') AS os_name,
        COALESCE(ed.os_version, edr.os_version) AS os_version,
        COALESCE(ed.agent_version, edr.agent_version) AS agent_version,
        ed.status AS device_status,
        ed.last_seen_at,
        edr.last_sync_at,
        ts.is_online, ts.is_active, ts.is_idle, ts.is_on_break,
        ts.current_app, ts.current_domain,
        ts.last_event_at, ts.last_heartbeat_at,
        att.check_in_at, att.check_out_at,
        COALESCE(att.total_minutes, 0) AS total_minutes,
        COALESCE(att.break_minutes, 0) AS break_minutes
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN locations l ON l.id = e.location_id
      LEFT JOIN employees m ON m.id = e.manager_id
      LEFT JOIN (
        SELECT ed1.*
        FROM employee_devices ed1
        INNER JOIN (
          SELECT employee_id, MAX(id) AS max_id
          FROM employee_devices
          WHERE status != 'revoked'
          GROUP BY employee_id
        ) ed_max ON ed1.id = ed_max.max_id
      ) ed ON ed.employee_id = e.id
      LEFT JOIN (
        SELECT edr1.*
        FROM employee_device_registry edr1
        INNER JOIN (
          SELECT employee_id, MAX(id) AS max_id
          FROM employee_device_registry
          WHERE is_authorized = 1
          GROUP BY employee_id
        ) edr_max ON edr1.id = edr_max.max_id
      ) edr ON edr.employee_id = e.id
      LEFT JOIN employee_tracking_status ts ON ts.employee_id = e.id
      LEFT JOIN (
        SELECT employee_id, MIN(check_in_at) AS check_in_at, MAX(check_out_at) AS check_out_at,
               SUM(total_minutes) AS total_minutes, SUM(break_minutes) AS break_minutes
        FROM attendance
        WHERE work_date = ?
        GROUP BY employee_id
      ) att ON att.employee_id = e.id
      WHERE ${whereSql}
      ORDER BY 
        (ts.is_active = 1 OR ts.is_online = 1) DESC,
        ts.last_event_at DESC,
        e.full_name ASC
    `;

    const allRows = await query<Record<string, unknown>>(sql, [targetDate, ...params]);

    const now = Date.now();
    let currentlyActive = 0;
    let idleEmployees = 0;
    let offlineEmployees = 0;
    let agentInstalled = 0;
    let agentNotInstalled = 0;
    let totalActiveMinutes = 0;
    let totalIdleMinutes = 0;
    let connectedDevices = 0;

    const mappedItems: EmployeeTrackingItem[] = allRows.map((r) => {
      const isOnline = Boolean(r.is_online);
      const isActive = Boolean(r.is_active);
      const isIdle = Boolean(r.is_idle);
      const isOnBreak = Boolean(r.is_on_break);

      const lastSeen = r.last_seen_at ? new Date(String(r.last_seen_at)) : null;
      const lastSync = r.last_sync_at ? new Date(String(r.last_sync_at)) : null;
      const lastHeartbeat = r.last_heartbeat_at ? new Date(String(r.last_heartbeat_at)) : null;

      // Connected if seen within the last 5 minutes
      const hasRecentConnection = (lastSeen && now - lastSeen.getTime() < 5 * 60 * 1000) ||
                                  (lastHeartbeat && now - lastHeartbeat.getTime() < 5 * 60 * 1000);

      let connectionStatus: 'connected' | 'disconnected' | 'never_connected' = 'never_connected';
      if (hasRecentConnection) {
        connectionStatus = 'connected';
        connectedDevices++;
      } else if (lastSeen || lastSync) {
        connectionStatus = 'disconnected';
      }

      // Agent installation status
      const hasAgent = Boolean(r.agent_version) && r.device_status !== 'revoked';
      if (hasAgent) {
        agentInstalled++;
      } else {
        agentNotInstalled++;
      }

      // Activity status
      let currentActivityStatus: 'Active' | 'Idle' | 'On Break' | 'Offline' = 'Offline';
      if (isOnBreak) {
        currentActivityStatus = 'On Break';
      } else if (isActive || (hasRecentConnection && !isIdle)) {
        currentActivityStatus = 'Active';
        currentlyActive++;
      } else if (isIdle && hasRecentConnection) {
        currentActivityStatus = 'Idle';
        idleEmployees++;
      } else if (r.check_in_at && !r.check_out_at && hasRecentConnection) {
        currentActivityStatus = 'Active';
        currentlyActive++;
      } else {
        currentActivityStatus = 'Offline';
        offlineEmployees++;
      }

      // Device Type determination
      const rawOs = String(r.os_name || '').toLowerCase();
      let deviceType = 'Windows';
      if (rawOs.includes('android')) deviceType = 'Android';
      else if (rawOs.includes('mac') || rawOs.includes('darwin') || rawOs.includes('ios')) deviceType = 'macOS';
      else if (rawOs.includes('linux')) deviceType = 'Linux';

      const workedMins = Number(r.total_minutes || 0);
      const breakMins = Number(r.break_minutes || 0);
      const idleMins = isIdle ? Math.round(Number(r.idle_seconds || 0) / 60) : 0;
      const activeMins = Math.max(0, workedMins - breakMins);

      totalActiveMinutes += activeMins;
      totalIdleMinutes += idleMins;

      const statusKey: 'active' | 'idle' | 'offline' =
        currentActivityStatus === 'Active' ? 'active' : currentActivityStatus === 'Idle' ? 'idle' : 'offline';

      return {
        id: Number(r.id),
        fullName: String(r.full_name),
        employeeCode: String(r.employee_code),
        photoUrl: r.photo_url ? String(r.photo_url) : null,
        email: String(r.email),
        mobile: r.mobile ? String(r.mobile) : null,
        departmentId: r.department_id ? Number(r.department_id) : null,
        departmentName: r.department_name ? String(r.department_name) : null,
        designationId: r.designation_id ? Number(r.designation_id) : null,
        designationTitle: r.designation_title ? String(r.designation_title) : null,
        locationId: r.location_id ? Number(r.location_id) : null,
        locationCode: r.location_code ? String(r.location_code) : null,
        locationName: r.location_name ? String(r.location_name) : null,
        managerId: r.manager_id ? Number(r.manager_id) : null,
        managerName: r.manager_name ? String(r.manager_name) : null,
        deviceId: r.device_id ? Number(r.device_id) : null,
        deviceName: String(r.device_name || 'No Device'),
        deviceType,
        osName: String(r.os_name || 'Unknown'),
        osVersion: r.os_version ? String(r.os_version) : null,
        agentVersion: r.agent_version ? String(r.agent_version) : null,
        deviceConnectionStatus: connectionStatus,
        agentInstallationStatus: hasAgent ? 'installed' : 'not_installed',
        lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
        lastSyncAt: lastSync ? lastSync.toISOString() : null,
        currentActivityStatus,
        currentApp: r.current_app ? String(r.current_app) : null,
        currentDomain: r.current_domain ? String(r.current_domain) : null,
        lastActiveAt: r.last_event_at ? new Date(String(r.last_event_at)).toISOString() : null,
        activeMinutesToday: activeMins,
        idleMinutesToday: idleMins,
        checkInAt: r.check_in_at ? new Date(String(r.check_in_at)).toISOString() : null,
        checkOutAt: r.check_out_at ? new Date(String(r.check_out_at)).toISOString() : null,
        status: statusKey,
        isOnline: currentActivityStatus !== 'Offline',
        currentWindow: r.window_title ? String(r.window_title) : null,
        idleDurationSeconds: Number(r.idle_seconds || 0),
        device: {
          id: r.device_id ? Number(r.device_id) : null,
          name: r.device_name ? String(r.device_name) : null,
          os: r.os_name ? String(r.os_name) : 'Windows',
          type: deviceType.toLowerCase(),
          ip: r.ip_address ? String(r.ip_address) : null,
          mac: r.mac_address ? String(r.mac_address) : null,
          isConnected: connectionStatus === 'connected',
          lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
        },
        agent: {
          isInstalled: hasAgent,
          version: r.agent_version ? String(r.agent_version) : null,
          status: (hasAgent && connectionStatus === 'connected' ? 'running' : hasAgent ? 'offline' : 'not_installed') as 'running' | 'offline' | 'error' | 'not_installed',
          lastHeartbeatAt: r.last_heartbeat_at ? new Date(String(r.last_heartbeat_at)).toISOString() : null,
          syncErrors: 0,
        },
        todaySummary: {
          workedMinutes: workedMins,
          activeMinutes: activeMins,
          idleMinutes: idleMins,
          appMinutes: activeMins,
          webMinutes: Math.round(activeMins * 0.4),
        },
      };
    });

    // Apply in-memory filters for status & agent installation if requested
    let filteredItems = mappedItems;
    if (filters.status && filters.status.toLowerCase() !== 'all') {
      filteredItems = filteredItems.filter((item) =>
        item.currentActivityStatus.toLowerCase() === filters.status!.toLowerCase() ||
        item.status === filters.status!.toLowerCase()
      );
    }
    if (filters.agentInstalled !== undefined) {
      filteredItems = filteredItems.filter((item) => (filters.agentInstalled ? item.agentInstallationStatus === 'installed' : item.agentInstallationStatus === 'not_installed'));
    }

    const page = Math.max(1, Number(filters.page || 1));
    const pageSize = Math.min(100, Math.max(5, Number(filters.pageSize || filters.limit || 25)));
    const total = filteredItems.length;
    const totalPages = Math.ceil(total / pageSize);
    const paginatedItems = filteredItems.slice((page - 1) * pageSize, page * pageSize);

    const summary: EmployeeTrackingSummary = {
      totalRegistered: allRows.length,
      currentlyActive,
      idleEmployees,
      offlineEmployees,
      agentInstalled,
      agentNotInstalled,
      totalActiveWorkingHours: Math.round((totalActiveMinutes / 60) * 10) / 10,
      totalIdleHours: Math.round((totalIdleMinutes / 60) * 10) / 10,
      connectedDevices,
      syncFailures: Math.max(0, agentInstalled - connectedDevices),
    };

    const enhancedSummary = {
      ...summary,
      totalEmployees: summary.totalRegistered,
      activeNow: summary.currentlyActive,
      idleNow: summary.idleEmployees,
      offlineNow: summary.offlineEmployees,
      totalActiveHours: summary.totalActiveWorkingHours,
      totalIdleHours: summary.totalIdleHours,
    };

    const locations = await query<{ id: number; code: string; name: string }>('SELECT id, code, name FROM locations ORDER BY code ASC');
    const departments = await query<{ id: number; name: string }>('SELECT id, name FROM departments ORDER BY name ASC');

    return {
      summary: enhancedSummary,
      items: paginatedItems,
      employees: paginatedItems,
      total,
      page,
      pageSize,
      totalPages,
      pagination: {
        total,
        page,
        limit: pageSize,
        totalPages,
      },
      locations,
      departments,
    };
  }

  /**
   * Returns comprehensive 9-tab activity details for a specific employee.
   */
  static async getEmployeeDetailedActivity(
    currentUser: AuthUser,
    employeeId: number,
    options: { date?: string; from?: string; to?: string } = {},
  ) {
    await assertEmployeeAccess(currentUser, employeeId, 'activity');

    const targetDate = options.date || today();
    const fromDate = options.from || targetDate;
    const toDate = options.to || targetDate;

    // 1. Employee Profile
    const emp = await queryOne<Record<string, unknown>>(
      `SELECT e.id, e.full_name, e.employee_code, e.photo_url, e.mobile, e.email,
              e.department_id, d.name AS department_name,
              e.designation_id, dg.title AS designation_title,
              e.location_id, l.code AS location_code, l.name AS location_name,
              e.manager_id, m.full_name AS manager_name,
              e.status, e.employment_type, e.joining_date
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN employees m ON m.id = e.manager_id
       WHERE e.id = ?`,
      [employeeId],
    );
    if (!emp) throw ApiError.notFound('Employee not found');

    // 2. Devices (from both employee_devices & employee_device_registry)
    const devices = await query<Record<string, unknown>>(
      `SELECT d.id, d.device_name, d.os_name, d.os_version, d.agent_version, d.machine_fingerprint,
              d.status, d.registered_at, d.last_seen_at
       FROM employee_devices d
       WHERE d.employee_id = ?
       ORDER BY d.last_seen_at DESC, d.id DESC`,
      [employeeId],
    );

    const primaryDevice = devices[0] || null;

    // Telemetry & Health from device_health_logs or memory
    const healthLog = primaryDevice ? await queryOne<Record<string, unknown>>(
      `SELECT * FROM device_health_logs WHERE device_id = ? ORDER BY id DESC LIMIT 1`,
      [primaryDevice.id],
    ) : null;

    // 3. Working Hours & Attendance
    const attendanceRows = await query<Record<string, unknown>>(
      `SELECT * FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date DESC, session_number ASC`,
      [employeeId, fromDate, toDate],
    );

    // 4. Applications Usage
    const appRows = await query<Record<string, unknown>>(
      `SELECT app_name, app_category, window_title, SUM(active_seconds) AS total_seconds,
              COUNT(*) AS launch_count, MIN(started_at) AS first_used, MAX(ended_at) AS last_used
       FROM application_usage_logs
       WHERE employee_id = ? AND DATE(started_at) BETWEEN ? AND ? AND deleted_at IS NULL
       GROUP BY app_name, app_category, window_title
       ORDER BY total_seconds DESC LIMIT 50`,
      [employeeId, fromDate, toDate],
    );

    // 5. Website Usage
    const websiteRows = await query<Record<string, unknown>>(
      `SELECT domain, tab_title, browser, category, SUM(active_seconds) AS total_seconds,
              MIN(started_at) AS first_visited, MAX(ended_at) AS last_visited
       FROM browser_usage_logs
       WHERE employee_id = ? AND DATE(started_at) BETWEEN ? AND ? AND deleted_at IS NULL
       GROUP BY domain, tab_title, browser, category
       ORDER BY total_seconds DESC LIMIT 50`,
      [employeeId, fromDate, toDate],
    );

    // 6. Chronological Activity Events Timeline
    const timelineEvents = await query<Record<string, unknown>>(
      `SELECT 'app' AS event_type, app_name AS title, window_title AS description,
              app_category AS category, active_seconds AS duration, started_at AS occurred_at
       FROM application_usage_logs
       WHERE employee_id = ? AND DATE(started_at) BETWEEN ? AND ? AND deleted_at IS NULL
       UNION ALL
       SELECT 'browser' AS event_type, domain AS title, tab_title AS description,
              category AS category, active_seconds AS duration, started_at AS occurred_at
       FROM browser_usage_logs
       WHERE employee_id = ? AND DATE(started_at) BETWEEN ? AND ? AND deleted_at IS NULL
       UNION ALL
       SELECT 'work_event' AS event_type, title, detail AS description,
              source_type AS category, 0 AS duration, occurred_at
       FROM work_activity_events
       WHERE employee_id = ? AND DATE(occurred_at) BETWEEN ? AND ? AND deleted_at IS NULL
       ORDER BY occurred_at DESC LIMIT 100`,
      [employeeId, fromDate, toDate, employeeId, fromDate, toDate, employeeId, fromDate, toDate],
    );

    // 7. Login Audit History
    const loginHistory = await query<Record<string, unknown>>(
      `SELECT id, login_at, logout_at, last_heartbeat_at, duration_minutes, ip, user_agent, browser, os, login_status, logout_reason
       FROM employee_login_audit
       WHERE employee_id = ? AND DATE(login_at) BETWEEN ? AND ?
       ORDER BY login_at DESC LIMIT 30`,
      [employeeId, fromDate, toDate],
    );

    // 8. Tracking Status Cache
    const trackingStatus = await queryOne<Record<string, unknown>>(
      'SELECT * FROM employee_tracking_status WHERE employee_id = ?',
      [employeeId],
    );

    return {
      profile: {
        id: Number(emp.id),
        fullName: String(emp.full_name),
        employeeCode: String(emp.employee_code),
        photoUrl: emp.photo_url ? String(emp.photo_url) : null,
        email: String(emp.email),
        mobile: emp.mobile ? String(emp.mobile) : null,
        departmentName: emp.department_name ? String(emp.department_name) : null,
        designationTitle: emp.designation_title ? String(emp.designation_title) : null,
        locationCode: emp.location_code ? String(emp.location_code) : null,
        locationName: emp.location_name ? String(emp.location_name) : null,
        managerName: emp.manager_name ? String(emp.manager_name) : null,
        status: String(emp.status),
        employmentType: String(emp.employment_type || 'full_time'),
        joiningDate: emp.joining_date ? String(emp.joining_date).slice(0, 10) : null,
      },
      status: {
        currentWorkingStatus: (Boolean(trackingStatus?.is_online)
          ? (Boolean(trackingStatus?.is_idle) ? 'Idle' : 'Active Working')
          : 'Offline') as 'Active Working' | 'Idle' | 'On Break' | 'Offline' | 'Logged Out',
        isOnline: Boolean(trackingStatus?.is_online),
        isActive: Boolean(trackingStatus?.is_active),
        isIdle: Boolean(trackingStatus?.is_idle),
        isOnBreak: Boolean(trackingStatus?.is_on_break),
        currentApp: trackingStatus?.current_app ? String(trackingStatus.current_app) : null,
        currentDomain: trackingStatus?.current_domain ? String(trackingStatus.current_domain) : null,
        lastActiveAt: trackingStatus?.last_event_at ? new Date(String(trackingStatus.last_event_at)).toISOString() : null,
        lastHeartbeatAt: trackingStatus?.last_heartbeat_at ? new Date(String(trackingStatus.last_heartbeat_at)).toISOString() : null,
        agentConnected: Boolean(trackingStatus?.is_online),
        agentVersion: primaryDevice?.agent_version ? String(primaryDevice.agent_version) : '2.0.0',
        deviceName: primaryDevice?.device_name ? String(primaryDevice.device_name) : 'Company Workstation',
      },
      currentStatus: {
        isOnline: Boolean(trackingStatus?.is_online),
        isActive: Boolean(trackingStatus?.is_active),
        isIdle: Boolean(trackingStatus?.is_idle),
        isOnBreak: Boolean(trackingStatus?.is_on_break),
        currentApp: trackingStatus?.current_app ? String(trackingStatus.current_app) : null,
        currentDomain: trackingStatus?.current_domain ? String(trackingStatus.current_domain) : null,
        lastEventAt: trackingStatus?.last_event_at ? new Date(String(trackingStatus.last_event_at)).toISOString() : null,
        lastHeartbeatAt: trackingStatus?.last_heartbeat_at ? new Date(String(trackingStatus.last_heartbeat_at)).toISOString() : null,
      },
      devices: devices.map((d) => ({
        id: Number(d.id),
        deviceName: String(d.device_name || 'Workstation'),
        osName: String(d.os_name || 'Windows'),
        osVersion: d.os_version ? String(d.os_version) : null,
        agentVersion: d.agent_version ? String(d.agent_version) : null,
        status: String(d.status),
        registeredAt: d.registered_at ? new Date(String(d.registered_at)).toISOString() : null,
        lastSeenAt: d.last_seen_at ? new Date(String(d.last_seen_at)).toISOString() : null,
      })),
      telemetry: healthLog ? {
        cpuPercent: Number(healthLog.cpu_percent || 0),
        memoryPercent: Number(healthLog.memory_percent || 0),
        diskFreeMb: Number(healthLog.disk_free_mb || 0),
        uptimeMinutes: Number(healthLog.uptime_minutes || 0),
        antivirusEnabled: Boolean(healthLog.antivirus_enabled),
        firewallEnabled: Boolean(healthLog.firewall_enabled),
      } : null,
      attendance: attendanceRows.map((a) => ({
        id: Number(a.id),
        workDate: String(a.work_date).slice(0, 10),
        status: String(a.status),
        checkInAt: a.check_in_at ? new Date(String(a.check_in_at)).toISOString() : null,
        checkOutAt: a.check_out_at ? new Date(String(a.check_out_at)).toISOString() : null,
        totalMinutes: Number(a.total_minutes || 0),
        breakMinutes: Number(a.break_minutes || 0),
        isLate: Boolean(a.is_late),
      })),
      applications: appRows.map((app) => ({
        appName: String(app.app_name),
        category: String(app.app_category || 'General'),
        windowTitle: app.window_title ? String(app.window_title) : null,
        totalSeconds: Number(app.total_seconds || 0),
        totalMinutes: Math.round(Number(app.total_seconds || 0) / 60),
        launchCount: Number(app.launch_count || 1),
        firstUsed: app.first_used ? new Date(String(app.first_used)).toISOString() : null,
        lastUsed: app.last_used ? new Date(String(app.last_used)).toISOString() : null,
      })),
      websites: websiteRows.map((w) => ({
        domain: String(w.domain),
        tabTitle: w.tab_title ? String(w.tab_title) : null,
        browser: String(w.browser || 'Browser'),
        category: String(w.category || 'General'),
        totalSeconds: Number(w.total_seconds || 0),
        totalMinutes: Math.round(Number(w.total_seconds || 0) / 60),
        firstVisited: w.first_visited ? new Date(String(w.first_visited)).toISOString() : null,
        lastVisited: w.last_visited ? new Date(String(w.last_visited)).toISOString() : null,
      })),
      timeline: timelineEvents.map((e, idx) => ({
        id: idx + 1,
        eventType: String(e.event_type),
        title: String(e.title || 'Activity Event'),
        description: e.description ? String(e.description) : null,
        category: String(e.category || 'General'),
        durationSeconds: Number(e.duration || 0),
        occurredAt: e.occurredAt ? new Date(String(e.occurredAt)).toISOString() : new Date().toISOString(),
      })),
      loginHistory: loginHistory.map((l) => ({
        id: Number(l.id),
        loginAt: new Date(String(l.login_at)).toISOString(),
        logoutAt: l.logout_at ? new Date(String(l.logout_at)).toISOString() : null,
        durationMinutes: Number(l.duration_minutes || 0),
        ip: l.ip ? String(l.ip) : null,
        browser: l.browser ? String(l.browser) : null,
        os: l.os ? String(l.os) : null,
        status: String(l.login_status || 'completed'),
        logoutReason: l.logout_reason ? String(l.logout_reason) : null,
      })),
      agentStatus: {
        isInstalled: devices.length > 0,
        version: primaryDevice?.agent_version ? String(primaryDevice.agent_version) : '2.0.0',
        status: trackingStatus?.is_online ? 'running' : 'offline',
        lastHeartbeat: trackingStatus?.last_heartbeat_at ? new Date(String(trackingStatus.last_heartbeat_at)).toISOString() : null,
        syncErrors: 0,
        autoStartConfigured: true,
      },
      dateRange: { from: fromDate, to: toDate, targetDate },
    };
  }

  /**
   * Generates downloadable Activity Reports in Excel (XLSX), PDF, or CSV format.
   */
  static async exportReport(
    currentUser: AuthUser,
    options: {
      format: 'pdf' | 'xlsx' | 'csv';
      employeeId?: number;
      locationId?: number;
      departmentId?: number;
      from: string;
      to: string;
    },
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const isSuperAdmin = currentUser.roleSlug === 'super_admin' || (currentUser.roleLevel ?? 0) >= 100;
    const isHr = currentUser.permissions.includes('employees.manage') || currentUser.permissions.includes('activity.view.all');

    if (!isSuperAdmin && !isHr && !currentUser.permissions.includes('reports.export') && !currentUser.permissions.includes('activity.view.team')) {
      throw ApiError.forbidden('You do not have permission to export activity reports.');
    }

    if (options.employeeId) {
      await assertEmployeeAccess(currentUser, options.employeeId, 'activity');
    }

    const whereClauses: string[] = ["e.status = 'active'"];
    const params: unknown[] = [];

    if (options.employeeId) {
      whereClauses.push('e.id = ?');
      params.push(options.employeeId);
    } else if (!isSuperAdmin) {
      const locClause = await locationEmployeeClause(currentUser, 'e.id');
      whereClauses.push(locClause.clause);
      params.push(...locClause.params);
    }

    if (options.locationId) {
      whereClauses.push('e.location_id = ?');
      params.push(options.locationId);
    }
    if (options.departmentId) {
      whereClauses.push('e.department_id = ?');
      params.push(options.departmentId);
    }

    const employees = await query<Record<string, unknown>>(
      `SELECT e.id, e.full_name, e.employee_code, d.name AS department_name, dg.title AS designation_title,
              l.code AS location_code, l.name AS location_name, m.full_name AS manager_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN employees m ON m.id = e.manager_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY e.full_name ASC`,
      params,
    );

    const empIds = employees.map((e) => Number(e.id));
    if (empIds.length === 0) {
      throw ApiError.notFound('No employee records found matching export criteria.');
    }

    const placeholders = empIds.map(() => '?').join(',');

    // Fetch working hours & attendance in date range
    const attendance = await query<Record<string, unknown>>(
      `SELECT a.employee_id, a.work_date, a.status, a.check_in_at, a.check_out_at,
              COALESCE(a.total_minutes, 0) AS total_minutes, COALESCE(a.break_minutes, 0) AS break_minutes
       FROM attendance a
       WHERE a.employee_id IN (${placeholders}) AND a.work_date BETWEEN ? AND ?
       ORDER BY a.work_date DESC`,
      [...empIds, options.from, options.to],
    );

    // Fetch top applications
    const apps = await query<Record<string, unknown>>(
      `SELECT employee_id, app_name, app_category, SUM(active_seconds) AS total_seconds
       FROM application_usage_logs
       WHERE employee_id IN (${placeholders}) AND DATE(started_at) BETWEEN ? AND ? AND deleted_at IS NULL
       GROUP BY employee_id, app_name, app_category
       ORDER BY total_seconds DESC`,
      [...empIds, options.from, options.to],
    );

    // Fetch top websites
    const websites = await query<Record<string, unknown>>(
      `SELECT employee_id, domain, category, SUM(active_seconds) AS total_seconds
       FROM browser_usage_logs
       WHERE employee_id IN (${placeholders}) AND DATE(started_at) BETWEEN ? AND ? AND deleted_at IS NULL
       GROUP BY employee_id, domain, category
       ORDER BY total_seconds DESC`,
      [...empIds, options.from, options.to],
    );

    // Fetch devices
    const devices = await query<Record<string, unknown>>(
      `SELECT employee_id, device_name, os_name, os_version, agent_version, status, last_seen_at
       FROM employee_devices
       WHERE employee_id IN (${placeholders}) AND status != 'revoked'
       ORDER BY last_seen_at DESC`,
      empIds,
    );

    const filename = `BSC_HRMS_Activity_Report_${options.from}_to_${options.to}.${options.format}`;

    if (options.format === 'csv' || options.format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'BSC Textiles HRMS Activity Monitoring';
      workbook.created = new Date();

      // Sheet 1: Employee Working Hours
      const sheet1 = workbook.addWorksheet('Working Hours & Attendance');
      sheet1.columns = [
        { header: 'Employee ID', key: 'code', width: 14 },
        { header: 'Employee Name', key: 'name', width: 24 },
        { header: 'Location', key: 'location', width: 12 },
        { header: 'Department', key: 'dept', width: 20 },
        { header: 'Date', key: 'date', width: 14 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Login Time', key: 'checkIn', width: 16 },
        { header: 'Logout Time', key: 'checkOut', width: 16 },
        { header: 'Total Working Duration', key: 'totalHours', width: 24 },
        { header: 'Active Duration', key: 'activeHours', width: 20 },
        { header: 'Break Duration', key: 'breakHours', width: 20 },
      ];

      for (const a of attendance) {
        const emp = employees.find((e) => Number(e.id) === Number(a.employee_id));
        const totalMins = Number(a.total_minutes || 0);
        const breakMins = Number(a.break_minutes || 0);
        const activeMins = Math.max(0, totalMins - breakMins);

        const formatDateStr = (dStr: string) => {
          if (/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
            const [y, m, d] = dStr.split('-');
            return `${d}-${m}-${y}`;
          }
          return dStr;
        };

        const formatTimeStr = (val?: unknown) => {
          if (!val) return '—';
          const dt = new Date(String(val));
          if (Number.isNaN(dt.getTime())) return '—';
          return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(dt);
        };

        const formatDur = (mins: number) => {
          const h = Math.floor(mins / 60);
          const m = mins % 60;
          if (h > 0 && m > 0) return `${h} Hours ${m} Minutes`;
          if (h > 0) return `${h} Hours`;
          return `${m} Minutes`;
        };

        sheet1.addRow({
          code: emp?.employee_code || '',
          name: emp?.full_name || '',
          location: emp?.location_code || '',
          dept: emp?.department_name || '',
          date: formatDateStr(String(a.work_date).slice(0, 10)),
          status: String(a.status || 'present'),
          checkIn: a.check_in_at ? formatTimeStr(a.check_in_at) : '—',
          checkOut: a.check_out_at ? formatTimeStr(a.check_out_at) : 'Active Session',
          totalHours: formatDur(totalMins),
          activeHours: formatDur(activeMins),
          breakHours: formatDur(breakMins),
        });
      }

      // Sheet 2: Application Usage
      const sheet2 = workbook.addWorksheet('Application Usage');
      sheet2.columns = [
        { header: 'Employee ID', key: 'code', width: 14 },
        { header: 'Employee Name', key: 'name', width: 24 },
        { header: 'Application', key: 'app', width: 26 },
        { header: 'Category', key: 'category', width: 18 },
        { header: 'Total Minutes', key: 'minutes', width: 14 },
        { header: 'Total Hours', key: 'hours', width: 14 },
      ];

      for (const app of apps) {
        const emp = employees.find((e) => Number(e.id) === Number(app.employee_id));
        const mins = Math.round(Number(app.total_seconds || 0) / 60);
        sheet2.addRow({
          code: emp?.employee_code || '',
          name: emp?.full_name || '',
          app: String(app.app_name),
          category: String(app.app_category || 'General'),
          minutes: mins,
          hours: (mins / 60).toFixed(2),
        });
      }

      // Sheet 3: Website Usage
      const sheet3 = workbook.addWorksheet('Website Browsing');
      sheet3.columns = [
        { header: 'Employee ID', key: 'code', width: 14 },
        { header: 'Employee Name', key: 'name', width: 24 },
        { header: 'Website Domain', key: 'domain', width: 28 },
        { header: 'Category', key: 'category', width: 18 },
        { header: 'Total Minutes', key: 'minutes', width: 14 },
      ];

      for (const web of websites) {
        const emp = employees.find((e) => Number(e.id) === Number(web.employee_id));
        sheet3.addRow({
          code: emp?.employee_code || '',
          name: emp?.full_name || '',
          domain: String(web.domain),
          category: String(web.category || 'General'),
          minutes: Math.round(Number(web.total_seconds || 0) / 60),
        });
      }

      // Sheet 4: Device & Agent Status
      const sheet4 = workbook.addWorksheet('Devices & Agent Status');
      sheet4.columns = [
        { header: 'Employee ID', key: 'code', width: 14 },
        { header: 'Employee Name', key: 'name', width: 24 },
        { header: 'Device Name', key: 'device', width: 26 },
        { header: 'Operating System', key: 'os', width: 18 },
        { header: 'Agent Version', key: 'version', width: 14 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Last Active', key: 'lastSeen', width: 20 },
      ];

      for (const dev of devices) {
        const emp = employees.find((e) => Number(e.id) === Number(dev.employee_id));
        sheet4.addRow({
          code: emp?.employee_code || '',
          name: emp?.full_name || '',
          device: String(dev.device_name || 'Workstation'),
          os: String(dev.os_name || 'Windows'),
          version: dev.agent_version ? String(dev.agent_version) : 'Not Installed',
          status: String(dev.status),
          lastSeen: dev.last_seen_at ? new Date(String(dev.last_seen_at)).toISOString().slice(0, 19).replace('T', ' ') : 'Never',
        });
      }

      if (options.format === 'csv') {
        const csv = await workbook.csv.writeBuffer();
        return { buffer: Buffer.from(csv), filename, mimeType: 'text/csv' };
      }

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      return {
        buffer,
        filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }

    // PDF Export
    return new Promise<{ buffer: Buffer; filename: string; mimeType: string }>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename, mimeType: 'application/pdf' }));
      doc.on('error', reject);

      // Title & Header
      const formatPeriodDate = (dStr: string) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
          const [y, m, d] = dStr.split('-');
          return `${d}-${m}-${y}`;
        }
        return dStr;
      };
      const genTimeStr = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date());
      const genDateStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()).replace(/\//g, '-');
      doc.fontSize(18).fillColor('#1e293b').text('BSC TEXTILES – EMPLOYEE ACTIVITY & TRACKING REPORT', { align: 'center' });
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#64748b').text(`Report Period: ${formatPeriodDate(options.from)} to ${formatPeriodDate(options.to)}  |  Generated on: ${genDateStr} ${genTimeStr} (IST)`, { align: 'center' });
      doc.moveDown(1);

      doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(1);

      // Summary
      doc.fontSize(12).fillColor('#0f172a').text('Summary of Tracked Employees');
      doc.moveDown(0.5);

      for (const emp of employees.slice(0, 15)) {
        const dev = devices.find((d) => Number(d.employee_id) === Number(emp.id));
        const empAtt = attendance.filter((a) => Number(a.employee_id) === Number(emp.id));
        const totalWorked = empAtt.reduce((sum, a) => sum + Number(a.total_minutes || 0), 0);

        doc.fontSize(10).fillColor('#1e293b').text(`${emp.full_name} (${emp.employee_code}) - Location: ${emp.location_code || 'HQ'} - Dept: ${emp.department_name || 'General'}`);
        doc.fontSize(9).fillColor('#64748b').text(`  Device: ${dev?.device_name || 'No Device'} (${dev?.os_name || 'Windows'})  |  Agent: ${dev?.agent_version || 'Not Installed'}  |  Logged: ${(totalWorked / 60).toFixed(1)} hrs`);
        doc.moveDown(0.3);
      }

      if (employees.length > 15) {
        doc.fontSize(9).fillColor('#94a3b8').text(`... and ${employees.length - 15} more employee records included in digital database.`);
      }

      doc.end();
    });
  }
}
