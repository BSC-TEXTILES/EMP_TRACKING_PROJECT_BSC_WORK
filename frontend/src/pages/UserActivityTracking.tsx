import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useDocumentTitle } from '../lib/hooks';
import { Avatar, Badge, Card, Modal, EmptyState, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { formatTime, formatDateTime, formatDate, cx } from '../lib/format';
import { EmployeeActivityDetailsModal } from '../components/EmployeeActivityDetailsModal';

interface TrackingEmployeeItem {
  id: number;
  fullName: string;
  employeeCode: string;
  email: string;
  departmentName: string | null;
  designationTitle: string | null;
  locationId: number | null;
  locationCode: string | null;
  locationName: string | null;
  managerName: string | null;
  device: {
    id: number | null;
    name: string | null;
    os: string | null;
    type: string;
    ip: string | null;
    mac: string | null;
    isConnected: boolean;
    lastSeenAt: string | null;
  };
  agent: {
    isInstalled: boolean;
    version: string | null;
    status: 'running' | 'offline' | 'error' | 'not_installed';
    lastHeartbeatAt: string | null;
    syncErrors: number;
  };
  status: 'active' | 'idle' | 'offline';
  isOnline: boolean;
  currentApp: string | null;
  currentWindow: string | null;
  lastActiveAt: string | null;
  idleDurationSeconds: number;
  todaySummary: {
    workedMinutes: number;
    activeMinutes: number;
    idleMinutes: number;
    appMinutes: number;
    webMinutes: number;
  };
}

interface TrackingDashboardResponse {
  summary: {
    totalEmployees: number;
    activeNow: number;
    idleNow: number;
    offlineNow: number;
    agentInstalled: number;
    agentNotInstalled: number;
    totalActiveHours: number;
    totalIdleHours: number;
    connectedDevices: number;
    syncFailures: number;
  };
  employees: TrackingEmployeeItem[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  locations: Array<{ id: number; code: string; name: string }>;
  departments: Array<{ id: number; name: string }>;
}

export default function UserActivityTracking() {
  useDocumentTitle('User Activity Tracking · BSC Textiles HRMS');
  const { user } = useAuth();

  // Filters & Pagination State
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [locationId, setLocationId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'idle' | 'offline'>('all');
  const [agentFilter, setAgentFilter] = useState<'all' | 'installed' | 'not_installed'>('all');
  const [departmentId, setDepartmentId] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'lastActive' | 'name' | 'workedTime' | 'location'>('lastActive');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  // Data State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TrackingDashboardResponse | null>(null);

  // Modals State
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);

  // Export Form State
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'pdf' | 'csv'>('xlsx');
  const [exportRange, setExportRange] = useState<'today' | 'yesterday' | '7days' | '30days' | 'custom'>('today');
  const [exportCustomFrom, setExportCustomFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [exportCustomTo, setExportCustomTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [exportLocationId, setExportLocationId] = useState<string>('all');
  const [exportDepartmentId, setExportDepartmentId] = useState<string>('all');
  const [exportEmployeeId, setExportEmployeeId] = useState<string>('all');
  const [exporting, setExporting] = useState(false);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch Dashboard Data
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      if (locationId !== 'all') params.set('locationId', locationId);
      if (departmentId !== 'all') params.set('departmentId', departmentId);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (agentFilter === 'installed') params.set('agentInstalled', 'true');
      if (agentFilter === 'not_installed') params.set('agentInstalled', 'false');
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      params.set('page', String(page));
      params.set('limit', String(limit));

      const res = await api.get<TrackingDashboardResponse>(`/activity/employees-tracking?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, locationId, departmentId, statusFilter, agentFilter, sortBy, sortOrder, page, limit]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Real-time synchronization via Socket.io
  useSocketEvent('activity:status_changed', (evt: any) => {
    if (!evt || !evt.employeeId) return;
    setData((prev) => {
      if (!prev) return prev;
      const updatedEmployees = prev.employees.map((emp) => {
        if (emp.id === evt.employeeId) {
          return {
            ...emp,
            status: (evt.status ?? emp.status) as 'active' | 'idle' | 'offline',
            isOnline: evt.status !== 'offline',
            currentApp: evt.currentApp ?? emp.currentApp,
            currentWindow: evt.currentWindow ?? emp.currentWindow,
            lastActiveAt: evt.timestamp ?? new Date().toISOString(),
          };
        }
        return emp;
      });
      return { ...prev, employees: updatedEmployees };
    });
  });

  useSocketEvent('device:heartbeat', (evt: any) => {
    if (!evt || !evt.employeeId) return;
    setData((prev) => {
      if (!prev) return prev;
      const updatedEmployees = prev.employees.map((emp) => {
        if (emp.id === evt.employeeId) {
          return {
            ...emp,
            status: (evt.isIdle ? 'idle' : 'active') as 'active' | 'idle' | 'offline',
            isOnline: true,
            currentApp: evt.currentApp ?? emp.currentApp,
            currentWindow: evt.windowTitle ?? emp.currentWindow,
            lastActiveAt: new Date().toISOString(),
            agent: {
              ...emp.agent,
              isInstalled: true,
              status: 'running' as const,
              lastHeartbeatAt: new Date().toISOString(),
            },
          };
        }
        return emp;
      });
      return { ...prev, employees: updatedEmployees };
    });
  });

  const handleOpenDetails = (employeeId: number) => {
    setSelectedEmployeeId(employeeId);
    setDetailsModalOpen(true);
  };

  const handleExportSubmit = () => {
    setExporting(true);
    let fromDate = new Date().toISOString().slice(0, 10);
    let toDate = new Date().toISOString().slice(0, 10);

    const now = new Date();
    if (exportRange === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      fromDate = y.toISOString().slice(0, 10);
      toDate = fromDate;
    } else if (exportRange === '7days') {
      const past = new Date(now);
      past.setDate(past.getDate() - 7);
      fromDate = past.toISOString().slice(0, 10);
    } else if (exportRange === '30days') {
      const past = new Date(now);
      past.setDate(past.getDate() - 30);
      fromDate = past.toISOString().slice(0, 10);
    } else if (exportRange === 'custom') {
      fromDate = exportCustomFrom;
      toDate = exportCustomTo;
    }

    const params = new URLSearchParams({
      format: exportFormat,
      from: fromDate,
      to: toDate,
    });
    if (exportLocationId !== 'all') params.set('locationId', exportLocationId);
    if (exportDepartmentId !== 'all') params.set('departmentId', exportDepartmentId);
    if (exportEmployeeId !== 'all') params.set('employeeId', exportEmployeeId);

    window.open(`/api/activity/export/report?${params.toString()}`, '_blank');
    setExporting(false);
    setExportModalOpen(false);
  };

  const formatMinutes = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
  };

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      {/* 1. Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
              <Icon name="activity" size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-ink-900 tracking-tight">
                User Activity Tracking
              </h1>
              <p className="text-xs text-ink-500">
                Real-time computer activity, hardware telemetries, application & website monitoring across all locations
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void fetchData()}
            className="btn-secondary btn-sm inline-flex items-center gap-1.5"
            title="Refresh current activity status"
          >
            <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={() => setAgentModalOpen(true)}
            className="btn-secondary btn-sm inline-flex items-center gap-1.5 !text-slate-800 !border-slate-300 hover:!bg-slate-100"
          >
            <Icon name="monitor" size={14} className="text-brand-600" />
            <span>Tracking Agent</span>
          </button>

          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            className="btn-primary btn-sm inline-flex items-center gap-1.5 shadow-xs"
          >
            <Icon name="download" size={14} />
            <span>Export Reports</span>
          </button>
        </div>
      </div>

      {/* 2. Top Summary Stat Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {/* Total Registered */}
        <Card className="p-3 bg-white border border-slate-200">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Registered</span>
          <p className="mt-1 text-xl font-extrabold text-ink-900 font-mono">
            {data?.summary.totalEmployees ?? '—'}
          </p>
          <span className="text-[10px] text-ink-500">Employees total</span>
        </Card>

        {/* Active Now */}
        <Card className="p-3 bg-emerald-50/70 border border-emerald-200">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">Active Now</span>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          </div>
          <p className="mt-1 text-xl font-extrabold text-emerald-950 font-mono">
            {data?.summary.activeNow ?? '—'}
          </p>
          <span className="text-[10px] text-emerald-700">Working actively</span>
        </Card>

        {/* Idle Now */}
        <Card className="p-3 bg-amber-50/70 border border-amber-200">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800">Idle Now</span>
            <span className="h-2 w-2 rounded-full bg-amber-500"></span>
          </div>
          <p className="mt-1 text-xl font-extrabold text-amber-950 font-mono">
            {data?.summary.idleNow ?? '—'}
          </p>
          <span className="text-[10px] text-amber-700">System paused</span>
        </Card>

        {/* Offline Now */}
        <Card className="p-3 bg-slate-50 border border-slate-200">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Offline</span>
          <p className="mt-1 text-xl font-extrabold text-slate-800 font-mono">
            {data?.summary.offlineNow ?? '—'}
          </p>
          <span className="text-[10px] text-slate-500">No active connection</span>
        </Card>

        {/* Agent Installed */}
        <Card className="p-3 bg-blue-50/70 border border-blue-200">
          <span className="text-[10px] font-bold uppercase tracking-wider text-blue-800">Agent Installed</span>
          <p className="mt-1 text-xl font-extrabold text-blue-950 font-mono">
            {data?.summary.agentInstalled ?? '—'}
          </p>
          <span className="text-[10px] text-blue-700">
            {data ? Math.round((data.summary.agentInstalled / (data.summary.totalEmployees || 1)) * 100) : 0}% coverage
          </span>
        </Card>

        {/* Not Installed */}
        <Card className="p-3 bg-rose-50/70 border border-rose-200">
          <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800">Not Installed</span>
          <p className="mt-1 text-xl font-extrabold text-rose-950 font-mono">
            {data?.summary.agentNotInstalled ?? '—'}
          </p>
          <span className="text-[10px] text-rose-700">Needs setup</span>
        </Card>

        {/* Active Hours Today */}
        <Card className="p-3 bg-teal-50/70 border border-teal-200">
          <span className="text-[10px] font-bold uppercase tracking-wider text-teal-800">Active Work</span>
          <p className="mt-1 text-xl font-extrabold text-teal-950 font-mono">
            {data ? `${data.summary.totalActiveHours}h` : '—'}
          </p>
          <span className="text-[10px] text-teal-700">Today aggregate</span>
        </Card>

        {/* Idle Hours Today */}
        <Card className="p-3 bg-orange-50/70 border border-orange-200">
          <span className="text-[10px] font-bold uppercase tracking-wider text-orange-800">Idle Hours</span>
          <p className="mt-1 text-xl font-extrabold text-orange-950 font-mono">
            {data ? `${data.summary.totalIdleHours}h` : '—'}
          </p>
          <span className="text-[10px] text-orange-700">Today aggregate</span>
        </Card>

        {/* Devices Online */}
        <Card className="p-3 bg-indigo-50/70 border border-indigo-200">
          <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-800">Devices</span>
          <p className="mt-1 text-xl font-extrabold text-indigo-950 font-mono">
            {data?.summary.connectedDevices ?? '—'}
          </p>
          <span className="text-[10px] text-indigo-700">Connected PCs</span>
        </Card>
      </div>

      {/* 3. Filters & Search Control Bar */}
      <Card className="p-4 bg-white border border-slate-200 shadow-2xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Search Box */}
          <div className="relative flex-1 min-w-[220px]">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by employee name, code, email, designation..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50/50 py-2 pl-9 pr-3 text-xs text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none"
            />
          </div>

          {/* Filter Dropdowns */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Location Filter */}
            <select
              value={locationId}
              onChange={(e) => {
                setLocationId(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none"
            >
              <option value="all">All Locations (DAV, BEL, SHI, HQ)</option>
              {data?.locations.map((loc) => (
                <option key={loc.id} value={String(loc.id)}>
                  {loc.code} - {loc.name}
                </option>
              ))}
            </select>

            {/* Activity Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as any);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active Working</option>
              <option value="idle">Idle / Paused</option>
              <option value="offline">Offline</option>
            </select>

            {/* Agent Installation Filter */}
            <select
              value={agentFilter}
              onChange={(e) => {
                setAgentFilter(e.target.value as any);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none"
            >
              <option value="all">All Agents</option>
              <option value="installed">Agent Installed</option>
              <option value="not_installed">Not Installed</option>
            </select>

            {/* Department Filter */}
            <select
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none"
            >
              <option value="all">All Departments</option>
              {data?.departments.map((dept) => (
                <option key={dept.id} value={String(dept.id)}>
                  {dept.name}
                </option>
              ))}
            </select>

            {/* Sorting */}
            <select
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value as any);
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none"
            >
              <option value="lastActive">Sort: Last Active</option>
              <option value="name">Sort: Employee Name</option>
              <option value="workedTime">Sort: Worked Duration</option>
              <option value="location">Sort: Location</option>
            </select>

            <button
              type="button"
              onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
              className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
              title={sortOrder === 'asc' ? 'Ascending Order' : 'Descending Order'}
            >
              <Icon name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />
            </button>
          </div>
        </div>
      </Card>

      {/* 4. Tracking Employees Table */}
      <Card className="overflow-hidden border border-slate-200 bg-white shadow-2xs">
        {loading && !data ? (
          <div className="p-6 space-y-4">
            <Skeleton lines={8} />
          </div>
        ) : error ? (
          <div className="p-8 text-center">
            <div className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-900">
              <p className="font-bold">Error loading activity tracking data:</p>
              <p className="mt-1">{error}</p>
              <button
                type="button"
                onClick={() => void fetchData()}
                className="mt-3 btn-secondary btn-sm"
              >
                Retry
              </button>
            </div>
          </div>
        ) : data?.employees.length === 0 ? (
          <div className="p-12 text-center">
            <EmptyState
              title="No employees found"
              description="No registered employees matched your current search filters and parameters."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="py-3 px-4">Employee</th>
                  <th className="py-3 px-4">Department & Role</th>
                  <th className="py-3 px-4">Location</th>
                  <th className="py-3 px-4">Device & Host</th>
                  <th className="py-3 px-4">Agent Status</th>
                  <th className="py-3 px-4">Current Activity</th>
                  <th className="py-3 px-4">Today Work</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data?.employees.map((emp) => {
                  const isBel = emp.locationCode === 'BEL';
                  const isDav = emp.locationCode === 'DAV';
                  const isShi = emp.locationCode === 'SHI';

                  return (
                    <tr
                      key={emp.id}
                      className="hover:bg-slate-50/80 transition-colors group cursor-pointer"
                      onClick={() => handleOpenDetails(emp.id)}
                    >
                      {/* Employee Info */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <Avatar
                            name={emp.fullName}
                            size={34}
                            online={emp.status === 'active'}
                          />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-slate-900 hover:text-brand-600 transition">
                                {emp.fullName}
                              </span>
                              <span className="rounded bg-slate-100 px-1.5 py-0.2 text-[10px] font-mono text-slate-600">
                                {emp.employeeCode}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400 truncate max-w-[180px]">{emp.email}</p>
                          </div>
                        </div>
                      </td>

                      {/* Department & Designation */}
                      <td className="py-3 px-4">
                        <p className="font-semibold text-slate-800">{emp.designationTitle || 'Staff'}</p>
                        <p className="text-[11px] text-slate-500">{emp.departmentName || 'Operations'}</p>
                      </td>

                      {/* Location Badge */}
                      <td className="py-3 px-4">
                        <span
                          className={cx(
                            'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold font-mono tracking-wider',
                            isBel
                              ? 'bg-blue-50 text-blue-700 border border-blue-200'
                              : isDav
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : isShi
                                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                  : 'bg-purple-50 text-purple-700 border border-purple-200',
                          )}
                        >
                          {emp.locationCode || 'HQ'}
                        </span>
                        <p className="text-[10px] text-slate-400 mt-0.5">{emp.locationName}</p>
                      </td>

                      {/* Device & OS */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <Icon
                            name={emp.device.type === 'android' ? 'smartphone' : 'monitor'}
                            size={15}
                            className={emp.device.isConnected ? 'text-brand-600' : 'text-slate-400'}
                          />
                          <div>
                            <p className="font-medium text-slate-800 truncate max-w-[130px]">
                              {emp.device.name || 'Not Registered'}
                            </p>
                            <p className="text-[10px] text-slate-400 font-mono">
                              {emp.device.os || 'Windows 11'} · {emp.device.ip || '—'}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Agent Status */}
                      <td className="py-3 px-4">
                        {emp.agent.isInstalled ? (
                          <div className="flex items-center gap-1.5">
                            <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
                            <span className="font-medium text-emerald-800">
                              v{emp.agent.version || '2.0.0'}
                            </span>
                          </div>
                        ) : (
                          <span className="rounded bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 border border-rose-200">
                            Not Installed
                          </span>
                        )}
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          {emp.agent.lastHeartbeatAt
                            ? `HB: ${formatTime(emp.agent.lastHeartbeatAt)}`
                            : 'No heartbeat'}
                        </p>
                      </td>

                      {/* Current Activity & Active Window */}
                      <td className="py-3 px-4">
                        {emp.status === 'offline' ? (
                          <span className="text-[11px] text-slate-400 italic">Offline</span>
                        ) : (
                          <div className="max-w-[180px]">
                            <p className="font-semibold text-slate-900 truncate">
                              {emp.currentApp || 'Desktop'}
                            </p>
                            <p className="text-[10px] text-slate-500 truncate" title={emp.currentWindow ?? ''}>
                              {emp.currentWindow || 'Foreground Window'}
                            </p>
                          </div>
                        )}
                      </td>

                      {/* Today Work Time */}
                      <td className="py-3 px-4 font-mono">
                        <div className="text-[11px]">
                          <span className="font-bold text-slate-900">
                            {formatMinutes(emp.todaySummary.workedMinutes)}
                          </span>
                          <span className="text-slate-400"> total</span>
                        </div>
                        <div className="text-[10px] text-emerald-700">
                          {formatMinutes(emp.todaySummary.activeMinutes)} active
                        </div>
                      </td>

                      {/* Status Badge */}
                      <td className="py-3 px-4">
                        <span
                          className={cx(
                            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold border',
                            emp.status === 'active'
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                              : emp.status === 'idle'
                                ? 'bg-amber-50 text-amber-800 border-amber-300'
                                : 'bg-slate-100 text-slate-600 border-slate-200',
                          )}
                        >
                          <span
                            className={cx(
                              'h-1.5 w-1.5 rounded-full',
                              emp.status === 'active'
                                ? 'bg-emerald-500 animate-pulse'
                                : emp.status === 'idle'
                                  ? 'bg-amber-500'
                                  : 'bg-slate-400',
                            )}
                          />
                          {emp.status === 'active' ? 'Active' : emp.status === 'idle' ? 'Idle' : 'Offline'}
                        </span>
                        {emp.status === 'idle' && emp.idleDurationSeconds > 0 && (
                          <p className="text-[9px] font-mono text-amber-700 mt-0.5">
                            {Math.round(emp.idleDurationSeconds / 60)}m idle
                          </p>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenDetails(emp.id)}
                            className="btn-secondary btn-sm !px-2 !py-1 text-[11px]"
                            title="View 9-Tab Detailed Monitoring Dashboard"
                          >
                            <Icon name="activity" size={13} className="text-brand-600" />
                            <span>Details</span>
                          </button>

                          {!emp.agent.isInstalled && (
                            <button
                              type="button"
                              onClick={() => setAgentModalOpen(true)}
                              className="btn-secondary btn-sm !px-2 !py-1 text-[11px] !border-amber-200 !text-amber-800 hover:!bg-amber-50"
                              title="Install Tracking Agent on this employee PC"
                            >
                              <Icon name="download" size={13} />
                              <span>Setup</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 5. Pagination Bar */}
        {data && data.pagination.totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 bg-slate-50/50 text-xs">
            <span className="text-slate-500">
              Showing {(page - 1) * limit + 1} to{' '}
              {Math.min(page * limit, data.pagination.total)} of{' '}
              <strong className="text-slate-800">{data.pagination.total}</strong> employees
            </span>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="btn-secondary btn-sm !px-2.5 disabled:opacity-40"
              >
                Previous
              </button>

              {Array.from({ length: Math.min(5, data.pagination.totalPages) }).map((_, i) => {
                const pageNumber = i + 1;
                return (
                  <button
                    key={pageNumber}
                    type="button"
                    onClick={() => setPage(pageNumber)}
                    className={cx(
                      'btn-sm !px-3 font-semibold rounded-lg',
                      page === pageNumber
                        ? 'bg-brand-600 text-white'
                        : 'btn-secondary text-slate-700',
                    )}
                  >
                    {pageNumber}
                  </button>
                );
              })}

              <button
                type="button"
                disabled={page >= data.pagination.totalPages}
                onClick={() => setPage((p) => Math.min(data.pagination.totalPages, p + 1))}
                className="btn-secondary btn-sm !px-2.5 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* 6. Comprehensive 9-Tab Detailed Activity Modal */}
      {selectedEmployeeId && (
        <EmployeeActivityDetailsModal
          open={detailsModalOpen}
          onClose={() => {
            setDetailsModalOpen(false);
            setSelectedEmployeeId(null);
          }}
          employeeId={selectedEmployeeId}
        />
      )}

      {/* 7. Export Reports Modal */}
      <Modal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        size="md"
        title="Export Activity & Tracking Reports"
        description="Download complete attendance, application, website, and idle-time audit reports in Excel, PDF, or CSV format."
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setExportModalOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={exporting}
              className="btn-primary btn-sm inline-flex items-center gap-1.5"
              onClick={handleExportSubmit}
            >
              <Icon name="download" size={14} />
              <span>{exporting ? 'Generating Report…' : 'Download Report'}</span>
            </button>
          </div>
        }
      >
        <div className="space-y-4 py-2 text-xs">
          {/* Format selection */}
          <div>
            <label className="block font-bold text-slate-800 mb-1.5">File Format</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'xlsx', label: 'Excel (.xlsx)', desc: 'Full multi-sheet report' },
                { id: 'csv', label: 'CSV (.csv)', desc: 'Standard raw export' },
                { id: 'pdf', label: 'PDF Document', desc: 'Formatted printable report' },
              ].map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => setExportFormat(fmt.id as any)}
                  className={cx(
                    'p-3 rounded-xl border text-left transition',
                    exportFormat === fmt.id
                      ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-500/20'
                      : 'border-slate-200 bg-white hover:bg-slate-50',
                  )}
                >
                  <p className="font-bold text-slate-900">{fmt.label}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{fmt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Date range presets */}
          <div>
            <label className="block font-bold text-slate-800 mb-1.5">Date Range</label>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              {[
                { id: 'today', label: 'Today' },
                { id: 'yesterday', label: 'Yesterday' },
                { id: '7days', label: 'Last 7 Days' },
                { id: '30days', label: 'Last 30 Days' },
                { id: 'custom', label: 'Custom Range' },
              ].map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setExportRange(r.id as any)}
                  className={cx(
                    'py-2 px-2.5 rounded-lg border text-center font-medium transition',
                    exportRange === r.id
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Date Pickers */}
          {exportRange === 'custom' && (
            <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">From Date</label>
                <input
                  type="date"
                  value={exportCustomFrom}
                  onChange={(e) => setExportCustomFrom(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">To Date</label>
                <input
                  type="date"
                  value={exportCustomTo}
                  onChange={(e) => setExportCustomTo(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* Scope Filters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-800 mb-1">Location Filter</label>
              <select
                value={exportLocationId}
                onChange={(e) => setExportLocationId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-800 focus:outline-none"
              >
                <option value="all">All Locations (BEL, DAV, SHI, HQ)</option>
                {data?.locations.map((loc) => (
                  <option key={loc.id} value={String(loc.id)}>
                    {loc.code} - {loc.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-800 mb-1">Department Filter</label>
              <select
                value={exportDepartmentId}
                onChange={(e) => setExportDepartmentId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-800 focus:outline-none"
              >
                <option value="all">All Departments</option>
                {data?.departments.map((dept) => (
                  <option key={dept.id} value={String(dept.id)}>
                    {dept.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </Modal>

      {/* 8. Agent Setup & Installer Modal */}
      <Modal
        open={agentModalOpen}
        onClose={() => setAgentModalOpen(false)}
        size="lg"
        title="BSC Textiles Activity Tracking Agent Setup"
        description="Standalone zero-dependency desktop agent for Windows and Android mobile application."
        footer={
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setAgentModalOpen(false)}
          >
            Close
          </button>
        }
      >
        <div className="space-y-4 py-2 text-xs">
          {/* Windows Download Options */}
          <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Icon name="monitor" size={18} className="text-blue-600" />
              <h3 className="text-sm font-bold text-blue-950">Windows Desktop Monitoring Agent</h3>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Automated installer that configures background auto-start on computer startup, monitors active applications, window titles, idle time, and securely synchronizes with the HRMS server.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <a
                href="/api/activity/agent/installer.bat"
                download="install-agent.bat"
                className="btn-primary btn-sm inline-flex items-center gap-1.5 shadow-xs"
              >
                <Icon name="download" size={14} />
                <span>Download Windows Installer (.bat)</span>
              </a>
              <a
                href="/api/activity/agent/installer.ps1"
                download="install-agent.ps1"
                className="btn-secondary btn-sm inline-flex items-center gap-1.5"
              >
                <Icon name="code" size={14} />
                <span>PowerShell Installer (.ps1)</span>
              </a>
            </div>
          </div>

          {/* Android Mobile APK Download */}
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Icon name="smartphone" size={18} className="text-emerald-600" />
              <h3 className="text-sm font-bold text-emerald-950">Android Mobile Application (APK)</h3>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Official BSC Textiles HRMS Android application with mobile attendance, meeting support, and field activity synchronization.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <a
                href="/api/downloads/apk/release"
                download="bsc-hrms-release.apk"
                className="btn-primary btn-sm inline-flex items-center gap-1.5 !bg-emerald-600 hover:!bg-emerald-700 shadow-xs"
              >
                <Icon name="download" size={14} />
                <span>Download Android Release APK</span>
              </a>
            </div>
          </div>

          {/* Setup Instructions */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
            <h4 className="font-bold text-slate-900">How to install on an Employee computer:</h4>
            <ol className="list-decimal pl-5 space-y-1 text-slate-600 leading-relaxed">
              <li>Download <strong>install-agent.bat</strong> onto the employee's PC.</li>
              <li>Right-click and select <strong>"Run as administrator"</strong>.</li>
              <li>The installer automatically configures background auto-start and runs silently.</li>
              <li>The device will appear as <strong>Active</strong> in the dashboard within 10 seconds.</li>
            </ol>
          </div>
        </div>
      </Modal>
    </div>
  );
}
