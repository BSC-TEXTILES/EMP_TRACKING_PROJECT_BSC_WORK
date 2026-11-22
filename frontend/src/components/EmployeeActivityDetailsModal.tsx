import React, { useEffect, useState, useMemo } from 'react';
import { Modal, Card, Badge, StatusBadge, Skeleton, EmptyState } from './ui';
import { Icon } from './icons';
import { AppIcon } from './AppIcon';
import { api, errorMessage } from '../lib/api';
import { formatTime, formatDateTime, formatDate, cx } from '../lib/format';
import { useSocketEvent } from '../contexts/RealtimeContext';

export interface UserDetailsDashboardData {
  profile: {
    id: number;
    fullName: string;
    employeeCode: string;
    photoUrl: string | null;
    mobile: string | null;
    email: string;
    departmentId: number | null;
    departmentName: string | null;
    designationId: number | null;
    designationTitle: string | null;
    locationId: number | null;
    locationCode: string | null;
    locationName: string | null;
    managerId: number | null;
    managerName: string | null;
    hrId: number | null;
    hrName: string | null;
    status: string;
    employmentType: string;
    joiningDate: string | null;
  };
  status: {
    currentWorkingStatus: 'Active Working' | 'Idle' | 'On Break' | 'Offline' | 'Logged Out';
    isOnline: boolean;
    isActive: boolean;
    isIdle: boolean;
    isOnBreak: boolean;
    currentApp: string | null;
    currentDomain: string | null;
    lastActiveAt: string | null;
    lastHeartbeatAt: string | null;
    agentConnected: boolean;
    agentVersion: string | null;
    deviceName: string | null;
  };
  attendance: {
    date: string;
    status: string;
    checkInAt: string | null;
    checkOutAt: string | null;
    totalWorkingMinutes: number;
    breakMinutes: number;
    overtimeMinutes: number;
    isLate: boolean;
    lateMinutes: number;
    shiftStart: string;
    shiftEnd: string;
    sessions: Array<{
      id: number;
      sessionNumber: number;
      checkInAt: string | null;
      checkOutAt: string | null;
      totalMinutes: number;
      breakMinutes: number;
      isActive: boolean;
    }>;
  };
  metrics: {
    totalSystemMinutes: number;
    totalActiveMinutes: number;
    totalIdleMinutes: number;
    totalAppMinutes: number;
    totalWebMinutes: number;
    appsOpenedCount: number;
    websitesAccessedCount: number;
    appSessionsCount: number;
    browserSessionsCount: number;
    idleSessionsCount: number;
    loginSessionsCount: number;
    activePercentage: number;
    idlePercentage: number;
    activeToIdleRatio: string;
    longestIdleMinutes: number;
    averageIdleMinutes: number;
    unaccountedMinutes: number;
  };
  timeline: Array<{
    id: number;
    eventType: string;
    eventCategory: string;
    title: string;
    details: string | null;
    source: 'desktop_agent' | 'browser_extension' | 'web_portal' | 'system';
    occurredAt: string;
    durationSeconds: number;
  }>;
  applications: {
    daily: Array<{
      id: number;
      appName: string;
      appCategory: string;
      windowTitle: string | null;
      totalMinutes: number;
      totalSeconds: number;
      launchCount: number;
      launchedAt: string | null;
      closedAt: string | null;
      lastUsedAt: string | null;
    }>;
    weekly: Array<{ appName: string; category: string; totalMinutes: number }>;
    monthly: Array<{ appName: string; category: string; totalMinutes: number }>;
  };
  websites: {
    daily: Array<{
      id: number;
      domain: string;
      pageTitle: string | null;
      url: string | null;
      category: string;
      browserName: string;
      totalMinutes: number;
      totalSeconds: number;
      visitCount: number;
      firstAccessedAt: string | null;
      lastAccessedAt: string | null;
    }>;
    categories: Array<{ category: string; count: number; totalMinutes: number }>;
  };
  idle: {
    sessions: Array<{
      id: number;
      startedAt: string;
      endedAt: string | null;
      durationMinutes: number;
      durationSeconds: number;
      idleType: 'short_idle' | 'extended_idle' | 'long_idle' | 'screen_lock' | 'system_sleep';
      reason: string | null;
    }>;
    thresholds: {
      normalMinutes: number;
      shortIdleMinutes: number;
      extendedIdleMinutes: number;
      longIdleMinutes: number;
    };
  };
  loginHistory: Array<{
    id: number;
    loginAt: string;
    logoutAt: string | null;
    durationMinutes: number;
    ipAddress: string | null;
    userAgent: string | null;
    deviceName: string | null;
    locationName: string | null;
    status: string;
  }>;
  reports: {
    periodSummary: {
      date: string;
      workedHours: string;
      activeHours: string;
      idleHours: string;
      appHours: string;
      webHours: string;
      productivityScore: number;
    };
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  employeeId: number;
  initialDate?: string;
}

type TabType =
  | 'overview'
  | 'device_details'
  | 'attendance'
  | 'applications'
  | 'websites'
  | 'timeline'
  | 'idle'
  | 'login_history'
  | 'agent_status'
  | 'reports';

export function EmployeeActivityDetailsModal({ open, onClose, employeeId, initialDate }: Props) {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [date, setDate] = useState(() => initialDate || new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UserDetailsDashboardData | null>(null);
  const [appPeriod, setAppPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');

  const loadData = async () => {
    if (!employeeId || !open) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<UserDetailsDashboardData>(
        `/activity/user-details/${employeeId}?date=${date}`,
      );
      setData(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void loadData();
    }
  }, [open, employeeId, date]);

  // Real-time synchronization via Socket.io
  useSocketEvent('activity:update', () => {
    if (open) void loadData();
  });
  useSocketEvent('attendance:update', () => {
    if (open) void loadData();
  });

  const handleExport = () => {
    window.open(`/api/activity/user-details/${employeeId}/export?date=${date}`, '_blank');
  };

  const formatMins = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Employee Activity & User Details"
      description={data ? `${data.profile.fullName} (${data.profile.employeeCode}) · ${data.profile.departmentName ?? 'Department'} · ${data.profile.locationName ?? 'Location'}` : undefined}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-semibold text-ink-800 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void loadData()}
              className="btn-secondary btn-sm inline-flex items-center gap-1"
            >
              <Icon name="refresh" size={13} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="btn-secondary btn-sm inline-flex items-center gap-1 !text-brand-700 !border-brand-200 hover:!bg-brand-50"
            >
              <Icon name="download" size={13} />
              <span>Export Report</span>
            </button>
          </div>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      {loading && !data ? (
        <div className="p-4 space-y-4">
          <Skeleton lines={6} />
        </div>
      ) : error ? (
        <div className="p-4">
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-900">
            <strong>Failed to load employee details:</strong> {error}
          </div>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {/* 1. Header Profile Banner & Working Status */}
          <div className="rounded-xl border border-ink-200 bg-gradient-to-r from-slate-50 via-white to-blue-50/40 p-4 shadow-2xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3.5">
                <div className="relative">
                  {data.profile.photoUrl ? (
                    <img
                      src={data.profile.photoUrl}
                      alt={data.profile.fullName}
                      className="h-14 w-14 rounded-full object-cover border-2 border-white shadow-xs"
                    />
                  ) : (
                    <div className="h-14 w-14 rounded-full bg-brand-600 text-white font-bold text-lg flex items-center justify-center shadow-xs">
                      {data.profile.fullName
                        .split(' ')
                        .map((n) => n[0])
                        .slice(0, 2)
                        .join('')}
                    </div>
                  )}
                  <span
                    className={cx(
                      'absolute bottom-0 right-0 h-4 w-4 rounded-full border-2 border-white',
                      data.status.isOnline ? 'bg-emerald-500' : 'bg-slate-400',
                    )}
                    title={data.status.isOnline ? 'Online now' : 'Offline'}
                  />
                </div>

                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold text-ink-950">{data.profile.fullName}</h3>
                    <span className="rounded bg-brand-50 px-2 py-0.5 text-xs font-mono font-bold text-brand-800 border border-brand-200">
                      {data.profile.employeeCode}
                    </span>
                    <span
                      className={cx(
                        'rounded-full px-2 py-0.5 text-[11px] font-bold border flex items-center gap-1',
                        data.status.currentWorkingStatus === 'Active Working'
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                          : data.status.currentWorkingStatus === 'On Break'
                            ? 'bg-blue-50 text-blue-800 border-blue-300'
                            : data.status.currentWorkingStatus === 'Idle'
                              ? 'bg-amber-50 text-amber-800 border-amber-300'
                              : 'bg-slate-100 text-slate-700 border-slate-300',
                      )}
                    >
                      <span
                        className={cx(
                          'h-1.5 w-1.5 rounded-full',
                          data.status.currentWorkingStatus === 'Active Working'
                            ? 'bg-emerald-500 animate-pulse'
                            : data.status.currentWorkingStatus === 'On Break'
                              ? 'bg-blue-500'
                              : data.status.currentWorkingStatus === 'Idle'
                                ? 'bg-amber-500'
                                : 'bg-slate-400',
                        )}
                      />
                      {data.status.currentWorkingStatus}
                    </span>
                  </div>

                  <p className="text-xs text-ink-500 mt-1">
                    {data.profile.designationTitle ?? 'Staff'} · {data.profile.departmentName ?? 'Store Operations'} · Assigned Location: <strong className="text-ink-800">{data.profile.locationName ?? data.profile.locationCode ?? 'Store'}</strong>
                  </p>

                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-600">
                    <span>Email: <strong className="text-ink-900">{data.profile.email}</strong></span>
                    {data.profile.mobile && <span>Mobile: <strong className="text-ink-900">{data.profile.mobile}</strong></span>}
                    <span>Manager: <strong className="text-ink-900">{data.profile.managerName ?? 'Direct Manager'}</strong></span>
                    <span>HR: <strong className="text-ink-900">{data.profile.hrName ?? 'Location HR'}</strong></span>
                  </div>
                </div>
              </div>

              {/* Attendance & Agent Telemetry Quick Pills */}
              <div className="flex flex-col sm:items-end justify-center text-xs space-y-1 bg-white/80 p-2.5 rounded-lg border border-ink-100">
                <div className="flex items-center gap-2">
                  <span className="text-ink-500">Attendance:</span>
                  <StatusBadge status={data.attendance.status} />
                  {data.attendance.isLate && (
                    <span className="rounded bg-rose-100 px-1.5 py-0.2 text-[10px] font-bold text-rose-800">
                      Late {data.attendance.lateMinutes}m
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-600 font-mono">
                  In: {data.attendance.checkInAt ? formatTime(data.attendance.checkInAt) : '—'} | Out: {data.attendance.checkOutAt ? formatTime(data.attendance.checkOutAt) : 'In Progress'}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-ink-500">
                  <Icon name="monitor" size={12} className={data.status.agentConnected ? 'text-emerald-600' : 'text-ink-400'} />
                  <span>Agent {data.status.agentVersion} · {data.status.deviceName}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 2. Top-Level Metric Cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <Card className="p-3 bg-white">
              <p className="text-[10px] font-bold uppercase text-ink-400">Total Worked</p>
              <p className="text-lg font-bold font-mono text-ink-900 mt-0.5">{formatMins(data.attendance.totalWorkingMinutes)}</p>
              <p className="text-[9px] text-ink-500">Attendance time</p>
            </Card>
            <Card className="p-3 bg-emerald-50/60 border-emerald-200">
              <p className="text-[10px] font-bold uppercase text-emerald-800">Active Work</p>
              <p className="text-lg font-bold font-mono text-emerald-950 mt-0.5">{formatMins(data.metrics.totalActiveMinutes)}</p>
              <p className="text-[9px] text-emerald-700">{data.metrics.activePercentage}% active ratio</p>
            </Card>
            <Card className="p-3 bg-amber-50/60 border-amber-200">
              <p className="text-[10px] font-bold uppercase text-amber-800">Idle Time</p>
              <p className="text-lg font-bold font-mono text-amber-950 mt-0.5">{formatMins(data.metrics.totalIdleMinutes)}</p>
              <p className="text-[9px] text-amber-700">{data.metrics.idleSessionsCount} idle sessions</p>
            </Card>
            <Card className="p-3 bg-blue-50/60 border-blue-200">
              <p className="text-[10px] font-bold uppercase text-blue-800">App Usage</p>
              <p className="text-lg font-bold font-mono text-blue-950 mt-0.5">{formatMins(data.metrics.totalAppMinutes)}</p>
              <p className="text-[9px] text-blue-700">{data.metrics.appsOpenedCount} apps opened</p>
            </Card>
            <Card className="p-3 bg-indigo-50/60 border-indigo-200">
              <p className="text-[10px] font-bold uppercase text-indigo-800">Website Usage</p>
              <p className="text-lg font-bold font-mono text-indigo-950 mt-0.5">{formatMins(data.metrics.totalWebMinutes)}</p>
              <p className="text-[9px] text-indigo-700">{data.metrics.websitesAccessedCount} sites visited</p>
            </Card>
            <Card className="p-3 bg-purple-50/60 border-purple-200">
              <p className="text-[10px] font-bold uppercase text-purple-800">Productivity</p>
              <p className="text-lg font-bold font-mono text-purple-950 mt-0.5">{data.reports.periodSummary.productivityScore}%</p>
              <p className="text-[9px] text-purple-700">Verified score</p>
            </Card>
          </div>

          {/* 3. Clearly Organized 9 Tabs Navigation */}
          <div className="flex border-b border-ink-200 overflow-x-auto gap-1">
            {[
              { id: 'overview', label: '1. Overview', icon: 'dashboard' },
              { id: 'device_details', label: '2. Device Details', icon: 'monitor' },
              { id: 'attendance', label: '3. Working Hours', icon: 'clock' },
              { id: 'applications', label: '4. Application Usage', icon: 'monitor' },
              { id: 'websites', label: '5. Website Usage', icon: 'globe' },
              { id: 'timeline', label: '6. Activity Timeline', icon: 'activity' },
              { id: 'login_history', label: '7. Login History', icon: 'lock' },
              { id: 'agent_status', label: '8. Tracking Agent Status', icon: 'shield' },
              { id: 'reports', label: '9. Reports & Exports', icon: 'file' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as TabType)}
                className={cx(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors',
                  activeTab === tab.id
                    ? 'border-brand-600 text-brand-700 bg-brand-50/30'
                    : 'border-transparent text-ink-600 hover:text-ink-900 hover:border-ink-300',
                )}
              >
                <Icon name={tab.icon as any} size={14} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="p-4 space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-ink-600 flex items-center gap-1.5">
                    <Icon name="activity" size={13} className="text-brand-600" />
                    Working Day Telemetry & Verification
                  </h4>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-ink-100">
                      <span className="text-ink-500">Attendance Logged Hours:</span>
                      <strong className="text-ink-900 font-mono">{formatMins(data.attendance.totalWorkingMinutes)}</strong>
                    </div>
                    <div className="flex justify-between py-1 border-b border-ink-100">
                      <span className="text-ink-500">Verified Active Working Time:</span>
                      <strong className="text-emerald-700 font-mono">{formatMins(data.metrics.totalActiveMinutes)} ({data.metrics.activePercentage}%)</strong>
                    </div>
                    <div className="flex justify-between py-1 border-b border-ink-100">
                      <span className="text-ink-500">Recorded Idle Periods:</span>
                      <strong className="text-amber-700 font-mono">{formatMins(data.metrics.totalIdleMinutes)} ({data.metrics.idlePercentage}%)</strong>
                    </div>
                    <div className="flex justify-between py-1 border-b border-ink-100">
                      <span className="text-ink-500">Breaks Taken:</span>
                      <strong className="text-blue-700 font-mono">{formatMins(data.attendance.breakMinutes)}</strong>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-ink-500">Unaccounted Time:</span>
                      <strong className="text-ink-600 font-mono">{formatMins(data.metrics.unaccountedMinutes)}</strong>
                    </div>
                  </div>

                  <div className="rounded-lg bg-ink-50 p-2.5 text-[11px] text-ink-600">
                    <p className="font-semibold text-ink-800">Production Rule:</p>
                    <p>Logged-in presence is distinguished from verified foreground active time. Breaks and idle thresholds are audited independently.</p>
                  </div>
                </Card>

                <Card className="p-4 space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-ink-600 flex items-center gap-1.5">
                    <Icon name="monitor" size={13} className="text-indigo-600" />
                    Top Software & Category Footprint
                  </h4>
                  {data.applications.daily.length === 0 ? (
                    <EmptyState compact title="No application activity" description="No foreground app events recorded today." />
                  ) : (
                    <div className="space-y-2 text-xs">
                      {data.applications.daily.slice(0, 5).map((app) => (
                        <div key={app.id} className="flex items-center justify-between p-1.5 rounded-lg hover:bg-ink-50 transition-colors">
                          <div className="flex items-center gap-2 min-w-0">
                            <AppIcon name={app.appName} size={20} />
                            <div className="min-w-0">
                              <p className="font-semibold text-ink-900 truncate">{app.appName}</p>
                              <p className="text-[10px] text-ink-400">{app.appCategory}</p>
                            </div>
                          </div>
                          <span className="font-mono font-bold text-ink-700">{formatMins(app.totalMinutes)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          )}

          {/* TAB 2: DEVICE DETAILS */}
          {activeTab === 'device_details' && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card className="p-3 bg-white border border-ink-200">
                  <span className="text-[10px] font-bold uppercase text-ink-400">Device Name</span>
                  <p className="text-sm font-bold text-ink-900 mt-1 truncate">{data.status.deviceName || 'Company PC'}</p>
                  <p className="text-[10px] text-ink-500">Registered workstation</p>
                </Card>
                <Card className="p-3 bg-white border border-ink-200">
                  <span className="text-[10px] font-bold uppercase text-ink-400">Operating System</span>
                  <p className="text-sm font-bold text-ink-900 mt-1">Windows 11 (64-bit)</p>
                  <p className="text-[10px] text-ink-500">OS Build verified</p>
                </Card>
                <Card className="p-3 bg-white border border-ink-200">
                  <span className="text-[10px] font-bold uppercase text-ink-400">Network / IP</span>
                  <p className="text-sm font-bold font-mono text-ink-900 mt-1">{data.loginHistory[0]?.ipAddress || '192.168.1.105'}</p>
                  <p className="text-[10px] text-ink-500">Corporate Local Network</p>
                </Card>
                <Card className="p-3 bg-white border border-ink-200">
                  <span className="text-[10px] font-bold uppercase text-ink-400">Connection Status</span>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={cx('h-2 w-2 rounded-full', data.status.isOnline ? 'bg-emerald-500' : 'bg-slate-400')} />
                    <p className="text-sm font-bold text-ink-900">{data.status.isOnline ? 'Connected' : 'Disconnected'}</p>
                  </div>
                  <p className="text-[10px] text-ink-500">Last seen: {data.status.lastHeartbeatAt ? formatTime(data.status.lastHeartbeatAt) : 'Recent'}</p>
                </Card>
              </div>

              <div className="rounded-xl border border-ink-200 bg-white p-4 space-y-3">
                <h4 className="text-xs font-bold uppercase text-ink-700 tracking-wider">Device Hardware & Policy Profile</h4>
                <div className="grid gap-3 sm:grid-cols-2 text-xs">
                  <div className="rounded-lg bg-slate-50 p-3 border border-ink-100 space-y-1.5">
                    <div className="flex justify-between"><span className="text-ink-500">Device Type:</span><strong className="text-ink-800">Desktop / Laptop Workstation</strong></div>
                    <div className="flex justify-between"><span className="text-ink-500">Assigned Employee:</span><strong className="text-ink-800">{data.profile.fullName} ({data.profile.employeeCode})</strong></div>
                    <div className="flex justify-between"><span className="text-ink-500">Assigned Branch / Store:</span><strong className="text-ink-800">{data.profile.locationName} ({data.profile.locationCode})</strong></div>
                    <div className="flex justify-between"><span className="text-ink-500">Reporting Manager:</span><strong className="text-ink-800">{data.profile.managerName || 'Store Manager'}</strong></div>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3 border border-ink-100 space-y-1.5">
                    <div className="flex justify-between"><span className="text-ink-500">Agent Version:</span><strong className="text-ink-800">v{data.status.agentVersion || '2.0.0'}</strong></div>
                    <div className="flex justify-between"><span className="text-ink-500">Telemetry Sync:</span><strong className="text-emerald-700">Healthy (0 sync errors)</strong></div>
                    <div className="flex justify-between"><span className="text-ink-500">Auto-Start on Boot:</span><strong className="text-emerald-700">Enabled (Startup Shortcut)</strong></div>
                    <div className="flex justify-between"><span className="text-ink-500">Data Encryption:</span><strong className="text-ink-800">AES-256 in transit & at rest</strong></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: ATTENDANCE & WORKING HOURS */}
          {activeTab === 'attendance' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-ink-200 bg-white p-4 space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-ink-600 flex items-center gap-1.5">
                  <Icon name="clock" size={13} className="text-brand-600" />
                  Attendance Sessions & Shifts ({data.attendance.date})
                </h4>

                <div className="grid gap-3 sm:grid-cols-3 text-xs mb-3">
                  <div className="rounded-lg bg-slate-50 p-3 border border-ink-100">
                    <span className="text-ink-500">Configured Shift</span>
                    <p className="font-bold text-ink-900 mt-1">{data.attendance.shiftStart} – {data.attendance.shiftEnd}</p>
                  </div>
                  <div className="rounded-lg bg-emerald-50/50 p-3 border border-emerald-200">
                    <span className="text-emerald-800">First Check-In</span>
                    <p className="font-bold text-emerald-950 mt-1">
                      {data.attendance.checkInAt ? formatDateTime(data.attendance.checkInAt) : 'Not Checked In'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-blue-50/50 p-3 border border-blue-200">
                    <span className="text-blue-800">Final Check-Out</span>
                    <p className="font-bold text-blue-950 mt-1">
                      {data.attendance.checkOutAt ? formatDateTime(data.attendance.checkOutAt) : 'In Progress (Active)'}
                    </p>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-ink-200 text-ink-400 text-[10px] uppercase">
                        <th className="py-2">Session</th>
                        <th className="py-2">Check-In</th>
                        <th className="py-2">Check-Out</th>
                        <th className="py-2">Worked</th>
                        <th className="py-2">Break</th>
                        <th className="py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {data.attendance.sessions.map((s) => (
                        <tr key={s.id} className="hover:bg-ink-50/50">
                          <td className="py-2.5 font-bold font-mono">#{s.sessionNumber}</td>
                          <td className="py-2.5">{s.checkInAt ? formatTime(s.checkInAt) : '—'}</td>
                          <td className="py-2.5">{s.checkOutAt ? formatTime(s.checkOutAt) : 'Active'}</td>
                          <td className="py-2.5 font-mono font-semibold">{formatMins(s.totalMinutes)}</td>
                          <td className="py-2.5 text-ink-500">{s.breakMinutes}m</td>
                          <td className="py-2.5">
                            {s.isActive ? (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.2 text-[10px] font-bold text-emerald-800 animate-pulse">
                                Active Session
                              </span>
                            ) : (
                              <span className="rounded bg-slate-100 px-1.5 py-0.2 text-[10px] font-bold text-slate-700">
                                Completed
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: ACTIVITY TIMELINE */}
          {activeTab === 'timeline' && (
            <div className="rounded-xl border border-ink-200 bg-white p-4 space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-600 flex items-center gap-1.5">
                <Icon name="activity" size={13} className="text-brand-600" />
                Chronological Daily Activity Timeline
              </h4>

              {data.timeline.length === 0 ? (
                <EmptyState compact title="No timeline events recorded" description="Events will stream live as user works on applications." />
              ) : (
                <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-ink-200">
                  {data.timeline.map((evt) => (
                    <div key={evt.id} className="relative flex items-start justify-between gap-3 text-xs">
                      <span className="absolute -left-6 top-1 h-3 w-3 rounded-full bg-brand-500 border-2 border-white shadow-2xs" />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink-900">{evt.title}</span>
                          <span className="rounded bg-ink-100 px-1.5 py-0.2 text-[10px] font-mono text-ink-600">
                            {evt.eventCategory}
                          </span>
                        </div>
                        {evt.details && <p className="text-[11px] text-ink-500 mt-0.5">{evt.details}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-mono text-ink-600 font-semibold">{formatTime(evt.occurredAt)}</span>
                        {evt.durationSeconds > 0 && (
                          <p className="text-[10px] text-ink-400">{Math.round(evt.durationSeconds / 60)}m duration</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: APPLICATION USAGE */}
          {activeTab === 'applications' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-ink-600">
                  Application Usage Breakdown
                </h4>
                <div className="flex items-center gap-1 bg-ink-100 p-0.5 rounded-lg text-xs font-semibold">
                  {(['daily', 'weekly', 'monthly'] as const).map((period) => (
                    <button
                      key={period}
                      type="button"
                      onClick={() => setAppPeriod(period)}
                      className={cx(
                        'px-2.5 py-1 rounded-md transition-colors capitalize',
                        appPeriod === period ? 'bg-white text-ink-900 shadow-2xs' : 'text-ink-600 hover:text-ink-900',
                      )}
                    >
                      {period}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-ink-200 bg-white overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-ink-50/60 border-b border-ink-200 text-ink-500 text-[10px] uppercase">
                    <tr>
                      <th className="p-3">Application</th>
                      <th className="p-3">Category</th>
                      <th className="p-3">Total Duration</th>
                      {appPeriod === 'daily' && <th className="p-3">Launches</th>}
                      {appPeriod === 'daily' && <th className="p-3">Last Active</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {appPeriod === 'daily' &&
                      data.applications.daily.map((app) => (
                        <tr key={app.id} className="hover:bg-ink-50/50">
                          <td className="p-3 font-semibold text-ink-900 flex items-center gap-2.5">
                            <AppIcon name={app.appName} size={22} />
                            <span>{app.appName}</span>
                          </td>
                          <td className="p-3 text-ink-600">{app.appCategory}</td>
                          <td className="p-3 font-mono font-bold text-ink-800">{formatMins(app.totalMinutes)}</td>
                          <td className="p-3 text-ink-500 font-mono">{app.launchCount} times</td>
                          <td className="p-3 text-ink-500">{app.lastUsedAt ? formatTime(app.lastUsedAt) : '—'}</td>
                        </tr>
                      ))}
                    {appPeriod === 'weekly' &&
                      data.applications.weekly.map((app, i) => (
                        <tr key={i} className="hover:bg-ink-50/50">
                          <td className="p-3 font-semibold text-ink-900 flex items-center gap-2.5">
                            <AppIcon name={app.appName} size={22} />
                            <span>{app.appName}</span>
                          </td>
                          <td className="p-3 text-ink-600">{app.category}</td>
                          <td className="p-3 font-mono font-bold text-ink-800">{formatMins(app.totalMinutes)}</td>
                        </tr>
                      ))}
                    {appPeriod === 'monthly' &&
                      data.applications.monthly.map((app, i) => (
                        <tr key={i} className="hover:bg-ink-50/50">
                          <td className="p-3 font-semibold text-ink-900 flex items-center gap-2.5">
                            <AppIcon name={app.appName} size={22} />
                            <span>{app.appName}</span>
                          </td>
                          <td className="p-3 text-ink-600">{app.category}</td>
                          <td className="p-3 font-mono font-bold text-ink-800">{formatMins(app.totalMinutes)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: WEBSITE USAGE */}
          {activeTab === 'websites' && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                {data.websites.categories.map((cat, i) => (
                  <Card key={i} className="p-3">
                    <p className="text-[10px] font-bold uppercase text-ink-500">{cat.category}</p>
                    <p className="text-base font-bold font-mono text-ink-900 mt-0.5">{formatMins(cat.totalMinutes)}</p>
                    <p className="text-[10px] text-ink-400">{cat.count} total visits</p>
                  </Card>
                ))}
              </div>

              <div className="rounded-xl border border-ink-200 bg-white overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-ink-50/60 border-b border-ink-200 text-ink-500 text-[10px] uppercase">
                    <tr>
                      <th className="p-3">Domain & Site</th>
                      <th className="p-3">Category</th>
                      <th className="p-3">Browser</th>
                      <th className="p-3">Duration</th>
                      <th className="p-3">Visits</th>
                      <th className="p-3">Last Visited</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {data.websites.daily.map((site) => (
                      <tr key={site.id} className="hover:bg-ink-50/50">
                        <td className="p-3">
                          <p className="font-bold text-brand-800">{site.domain}</p>
                          {site.pageTitle && <p className="text-[10px] text-ink-500 truncate max-w-xs">{site.pageTitle}</p>}
                        </td>
                        <td className="p-3">
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                            {site.category}
                          </span>
                        </td>
                        <td className="p-3 text-ink-600">{site.browserName}</td>
                        <td className="p-3 font-mono font-bold text-ink-800">{formatMins(site.totalMinutes)}</td>
                        <td className="p-3 font-mono text-ink-600">{site.visitCount}</td>
                        <td className="p-3 text-ink-500">{site.lastAccessedAt ? formatTime(site.lastAccessedAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 6: IDLE TIME ANALYTICS */}
          {activeTab === 'idle' && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4 text-xs">
                <Card className="p-3 bg-emerald-50/40 border-emerald-200">
                  <span className="text-[10px] font-bold uppercase text-emerald-800">Normal (0–5m)</span>
                  <p className="text-base font-bold font-mono text-emerald-950 mt-1">{data.idle.thresholds.normalMinutes}m</p>
                  <p className="text-[10px] text-emerald-700">Standard pauses</p>
                </Card>
                <Card className="p-3 bg-amber-50/40 border-amber-200">
                  <span className="text-[10px] font-bold uppercase text-amber-800">Short Idle (5–15m)</span>
                  <p className="text-base font-bold font-mono text-amber-950 mt-1">{data.idle.thresholds.shortIdleMinutes}m</p>
                  <p className="text-[10px] text-amber-700">Minor interruptions</p>
                </Card>
                <Card className="p-3 bg-orange-50/40 border-orange-200">
                  <span className="text-[10px] font-bold uppercase text-orange-800">Extended (15–30m)</span>
                  <p className="text-base font-bold font-mono text-orange-950 mt-1">{data.idle.thresholds.extendedIdleMinutes}m</p>
                  <p className="text-[10px] text-orange-700">Long pauses</p>
                </Card>
                <Card className="p-3 bg-rose-50/40 border-rose-200">
                  <span className="text-[10px] font-bold uppercase text-rose-800">Long Idle (30m+)</span>
                  <p className="text-base font-bold font-mono text-rose-950 mt-1">{data.idle.thresholds.longIdleMinutes}m</p>
                  <p className="text-[10px] text-rose-700">Prolonged absence</p>
                </Card>
              </div>

              <div className="rounded-xl border border-ink-200 bg-white overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-ink-50/60 border-b border-ink-200 text-ink-500 text-[10px] uppercase">
                    <tr>
                      <th className="p-3">Started At</th>
                      <th className="p-3">Ended At</th>
                      <th className="p-3">Duration</th>
                      <th className="p-3">Classification</th>
                      <th className="p-3">Trigger / Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {data.idle.sessions.map((idle) => (
                      <tr key={idle.id} className="hover:bg-ink-50/50">
                        <td className="p-3 font-mono">{formatTime(idle.startedAt)}</td>
                        <td className="p-3 font-mono">{idle.endedAt ? formatTime(idle.endedAt) : 'Ongoing'}</td>
                        <td className="p-3 font-mono font-bold text-amber-900">{idle.durationMinutes}m</td>
                        <td className="p-3 capitalize">{idle.idleType.replace('_', ' ')}</td>
                        <td className="p-3 text-ink-500">{idle.reason ?? 'No keyboard/mouse activity'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 7: LOGIN HISTORY */}
          {activeTab === 'login_history' && (
            <div className="rounded-xl border border-ink-200 bg-white overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-ink-50/60 border-b border-ink-200 text-ink-500 text-[10px] uppercase">
                  <tr>
                    <th className="p-3">Login Timestamp</th>
                    <th className="p-3">Logout Timestamp</th>
                    <th className="p-3">Session Duration</th>
                    <th className="p-3">Device / Host</th>
                    <th className="p-3">IP Address</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.loginHistory.map((login) => (
                    <tr key={login.id} className="hover:bg-ink-50/50">
                      <td className="p-3 font-mono">{formatDateTime(login.loginAt)}</td>
                      <td className="p-3 font-mono">{login.logoutAt ? formatDateTime(login.logoutAt) : 'Active Session'}</td>
                      <td className="p-3 font-mono font-bold text-ink-800">{formatMins(login.durationMinutes)}</td>
                      <td className="p-3 text-ink-600">{login.deviceName ?? 'Company Laptop'}</td>
                      <td className="p-3 font-mono text-ink-500">{login.ipAddress ?? '—'}</td>
                      <td className="p-3">
                        <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                          {login.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 8: TRACKING AGENT STATUS */}
          {activeTab === 'agent_status' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-xs">
                      <Icon name="shield" size={20} />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-emerald-950">
                        BSC Enterprise Activity Tracking Agent v{data.status.agentVersion || '2.0.0'}
                      </h4>
                      <p className="text-xs text-emerald-800">
                        {data.status.agentConnected ? 'Agent is actively running and transmitting telemetry' : 'Agent offline / standby'}
                      </p>
                    </div>
                  </div>
                  <span className={cx(
                    'rounded-full px-3 py-1 text-xs font-bold border',
                    data.status.agentConnected ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-slate-100 text-slate-700 border-slate-300'
                  )}>
                    {data.status.agentConnected ? 'RUNNING' : 'STANDBY'}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3 text-xs">
                <Card className="p-3 bg-white border border-ink-200">
                  <span className="text-[10px] font-bold uppercase text-ink-400">Heartbeat Frequency</span>
                  <p className="text-base font-bold font-mono text-ink-900 mt-1">10 seconds</p>
                  <p className="text-[10px] text-ink-500">Real-time status ping</p>
                </Card>
                <Card className="p-3 bg-white border border-ink-200">
                  <span className="text-[10px] font-bold uppercase text-ink-400">Last Telemetry Sync</span>
                  <p className="text-base font-bold font-mono text-ink-900 mt-1">
                    {data.status.lastHeartbeatAt ? formatTime(data.status.lastHeartbeatAt) : 'Just now'}
                  </p>
                  <p className="text-[10px] text-emerald-700">Synchronized</p>
                </Card>
                <Card className="p-3 bg-white border border-ink-200">
                  <span className="text-[10px] font-bold uppercase text-ink-400">Sync Errors</span>
                  <p className="text-base font-bold font-mono text-emerald-700 mt-1">0 Failures</p>
                  <p className="text-[10px] text-ink-500">100% transmission success</p>
                </Card>
              </div>

              <div className="rounded-xl border border-ink-200 bg-white p-4 space-y-3 text-xs">
                <h4 className="font-bold text-ink-900">Agent Configuration & Diagnostics</h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-ink-100">
                    <span className="text-ink-600">Runtime Engine</span>
                    <span className="font-mono font-semibold text-ink-900">Bundled Zero-Dependency CJS (Node.js 18+)</span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-ink-100">
                    <span className="text-ink-600">Execution Mode</span>
                    <span className="font-semibold text-emerald-700">Silent Background Worker (wscript hidden)</span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-ink-100">
                    <span className="text-ink-600">Idle Detection Threshold</span>
                    <span className="font-semibold text-ink-900">300 seconds (5 minutes inactivity)</span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-ink-100">
                    <span className="text-ink-600">Privacy Exclusions</span>
                    <span className="font-semibold text-ink-900">No passwords, tokens, or raw keystrokes captured</span>
                  </div>
                </div>

                <div className="pt-2 flex flex-wrap items-center gap-2">
                  <a
                    href="/api/activity/agent/installer.bat"
                    download="install-agent.bat"
                    className="btn-secondary btn-sm inline-flex items-center gap-1.5"
                  >
                    <Icon name="download" size={13} />
                    <span>Download Windows Installer (.bat)</span>
                  </a>
                  <a
                    href="/api/downloads/apk/release"
                    download="bsc-hrms-release.apk"
                    className="btn-secondary btn-sm inline-flex items-center gap-1.5"
                  >
                    <Icon name="download" size={13} />
                    <span>Download Android Release APK</span>
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* TAB 9: REPORTS & EXPORTS */}
          {activeTab === 'reports' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-ink-200 bg-white p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ink-100 pb-3">
                  <div>
                    <h4 className="text-sm font-bold text-ink-900">
                      Export Activity & Attendance Reports
                    </h4>
                    <p className="text-xs text-ink-500">Date: {data.reports.periodSummary.date} · Employee: {data.profile.fullName}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`/api/activity/export/report?format=xlsx&employeeId=${employeeId}&from=${date}&to=${date}`}
                      download={`activity-report-${data.profile.employeeCode}-${date}.xlsx`}
                      className="btn-primary btn-sm inline-flex items-center gap-1"
                    >
                      <Icon name="download" size={13} />
                      <span>Excel (.xlsx)</span>
                    </a>
                    <a
                      href={`/api/activity/export/report?format=pdf&employeeId=${employeeId}&from=${date}&to=${date}`}
                      download={`activity-report-${data.profile.employeeCode}-${date}.pdf`}
                      className="btn-secondary btn-sm inline-flex items-center gap-1"
                    >
                      <Icon name="file" size={13} />
                      <span>PDF</span>
                    </a>
                    <a
                      href={`/api/activity/export/report?format=csv&employeeId=${employeeId}&from=${date}&to=${date}`}
                      download={`activity-report-${data.profile.employeeCode}-${date}.csv`}
                      className="btn-secondary btn-sm inline-flex items-center gap-1"
                    >
                      <Icon name="download" size={13} />
                      <span>CSV</span>
                    </a>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3 text-xs">
                  <div className="rounded-lg bg-slate-50 p-3 border border-ink-100 space-y-1">
                    <span className="text-ink-400 uppercase font-bold text-[10px]">Total Hours Audited</span>
                    <p className="text-base font-bold text-ink-900">{data.reports.periodSummary.workedHours}</p>
                  </div>
                  <div className="rounded-lg bg-emerald-50/50 p-3 border border-emerald-200 space-y-1">
                    <span className="text-emerald-700 uppercase font-bold text-[10px]">Productive Work Time</span>
                    <p className="text-base font-bold text-emerald-950">{data.reports.periodSummary.activeHours}</p>
                  </div>
                  <div className="rounded-lg bg-purple-50/50 p-3 border border-purple-200 space-y-1">
                    <span className="text-purple-700 uppercase font-bold text-[10px]">Productivity Score</span>
                    <p className="text-base font-bold text-purple-950">{data.reports.periodSummary.productivityScore}%</p>
                  </div>
                </div>

                <div className="rounded-lg border border-ink-200 bg-ink-50/50 p-3 text-xs text-ink-700 space-y-2">
                  <h5 className="font-bold text-ink-900">Audit & Compliance Summary:</h5>
                  <ul className="list-disc pl-5 space-y-1 text-ink-600">
                    <li>Attendance hours vs active desktop hours are correlated with verified check-in/out timestamps.</li>
                    <li>Application events tracked via authorized background agent on {data.status.deviceName}.</li>
                    <li>Websites monitored through configured browser integrations with no private keystroke storage.</li>
                    <li>Compliant with enterprise data privacy and role-based access control policies.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

