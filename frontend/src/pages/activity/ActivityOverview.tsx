import React from 'react';
import { Avatar } from '../../components/ui';
import { Icon } from '../../components/icons';
import { cx, formatDateTime } from '../../lib/format';
import type { PickerEmployee } from '../../lib/types';
import { formatMinutes, type Device, type SelfDashboard } from './activityTypes';

interface ActivityOverviewProps {
  self: SelfDashboard | null;
  selectedEmployeeId?: number | null;
  employees?: PickerEmployee[];
  canSwitchEmployee?: boolean;
  onSelectEmployee?: (id: number | null) => void;
  date: string;
  onDateChange: (date: string) => void;
  loading: boolean;
  busy: boolean;
  connected: boolean;
  onRefresh: () => void;
  onOpenForensic: () => void;
  onExport: () => void;
  // Monitoring controls
  deviceId: number | '';
  onDeviceIdChange: (id: number | '') => void;
  onRegisterDevice: () => void;
  onStartSession: () => void;
  onStopSession: () => void;
  onAcknowledgeConsent: () => void;
  onOpenPolicy: () => void;
  onRevokeDevice: (device: Device) => void;
  onSummaryCardClick?: (targetTab: string) => void;
}

export function ActivityOverview({
  self,
  selectedEmployeeId,
  employees = [],
  canSwitchEmployee = false,
  onSelectEmployee,
  date,
  onDateChange,
  loading,
  busy,
  connected,
  onRefresh,
  onOpenForensic,
  onExport,
  deviceId,
  onDeviceIdChange,
  onRegisterDevice,
  onStartSession,
  onStopSession,
  onAcknowledgeConsent,
  onOpenPolicy,
  onRevokeDevice,
  onSummaryCardClick,
}: ActivityOverviewProps) {
  const activeEmployeeName = self?.targetEmployee?.full_name ?? self?.daily?.employee?.full_name ?? 'My Activity';
  const activeEmployeeCode = self?.targetEmployee?.employee_code ?? self?.daily?.employee?.employee_code ?? 'EMP-AUTH';
  const activeDepartment = self?.targetEmployee?.department_name ?? self?.daily?.employee?.department_name ?? 'Store Operations';
  const activeDesignation = self?.targetEmployee?.designation_title ?? self?.daily?.employee?.designation_title ?? 'Employee';
  const activeLocation = self?.targetEmployee?.location_name ?? 'Belagavi Flagship Store';

  // Summary counts
  const activeMinutes = self?.daily?.activeMinutes ?? 0;
  const attendanceMinutes = self?.daily?.attendanceMinutes ?? 0;
  const tasksCompleted = self?.daily?.taskSummary?.completed ?? 0;
  const tasksPending = self?.daily?.taskSummary?.pending ?? 0;
  const issuesCount = self?.daily?.issues?.length ?? 0;
  const weeklyScore = self?.weekly?.[0]?.score ?? null;
  const weeklyGrade = self?.weekly?.[0]?.grade ?? null;

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------------ Enterprise Header */}
      <header className="card p-4 sm:p-5 shadow-sm border-ink-200/90">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded bg-brand-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                Workforce Enterprise Suite · Activity & Productivity
              </span>
            </div>
            <h1 className="mt-1.5 text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
              Employee Activity & Work Session Monitoring
            </h1>
            <p className="mt-1 text-xs text-ink-500 max-w-3xl">
              Real-time application telemetry, store activity timelines, transparent weekly performance scores, and forensic audit dossiers.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs sm:text-sm text-ink-600">
              {/* Employee display: strictly their own user name */}
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink-900">
                <Icon name="user" size={15} className="text-brand-600" />
                <span>{activeEmployeeName}</span>
                <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-mono text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                  {activeEmployeeCode}
                </span>
              </span>

              {/* Department & Designation */}
              <span className="hidden sm:inline-flex items-center gap-1 text-ink-500">
                <span>{activeDesignation}</span>
                <span>·</span>
                <span>{activeDepartment}</span>
              </span>

              {/* Location */}
              <span className="inline-flex items-center gap-1.5 font-medium text-ink-700">
                <Icon name="building" size={15} className="text-ink-400" />
                {activeLocation}
              </span>

              {/* Date Input */}
              <label className="inline-flex items-center gap-1.5">
                <Icon name="calendar" size={15} className="text-ink-400" />
                <input
                  type="date"
                  className="h-8 rounded-md border border-ink-200 bg-surface px-2 text-xs font-medium text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  value={date}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(event) => onDateChange(event.target.value)}
                  aria-label="Activity date"
                />
              </label>

              {/* Live Status indicator */}
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 font-medium',
                  connected ? 'text-emerald-700' : 'text-amber-700',
                )}
                title={connected ? 'Real-time telemetry stream active' : 'Reconnecting to activity socket'}
              >
                <span className="relative flex h-2 w-2">
                  {connected && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  )}
                  <span
                    className={cx(
                      'relative inline-flex h-2 w-2 rounded-full',
                      connected ? 'bg-emerald-500' : 'bg-amber-500',
                    )}
                  />
                </span>
                {connected ? 'Live Sync' : 'Reconnecting…'}
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary h-9 px-3 text-xs"
              onClick={onRefresh}
              disabled={loading || busy}
              title="Refresh activity logs and metrics"
            >
              <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>

            <button
              type="button"
              className="btn-secondary h-9 px-3 text-xs"
              onClick={onExport}
              title="Export employee activity report as CSV"
            >
              <Icon name="download" size={14} />
              <span>Export CSV</span>
            </button>

            <button
              type="button"
              className="btn-primary h-9 px-3.5 text-xs inline-flex items-center gap-1.5 !bg-brand-700 hover:!bg-brand-800 text-white shadow-sm"
              onClick={onOpenForensic}
              title="Generate forensic workstation audit dossier"
            >
              <Icon name="shield" size={14} />
              <span>Forensic Audit Dossier</span>
            </button>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------ Monitoring Status Card */}
      {self && (
        <div className="rounded-xl border border-ink-200/90 bg-surface p-4 shadow-sm">
          {!self.consent.acknowledged && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/80 p-3.5 text-amber-900 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <Icon name="alertTriangle" size={18} className="mt-0.5 text-amber-600 shrink-0" />
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wide">Monitoring Policy Acknowledgement Required</h2>
                  <p className="mt-0.5 text-xs text-amber-800 leading-relaxed">
                    Consent-based monitoring requires policy acknowledgment before work sessions can be recorded.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-secondary btn-sm text-xs" onClick={onOpenPolicy}>
                  Read Policy
                </button>
                <button
                  type="button"
                  className="btn-primary btn-sm text-xs !bg-amber-700 hover:!bg-amber-800 text-white"
                  disabled={busy}
                  onClick={onAcknowledgeConsent}
                >
                  I Acknowledge
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3.5">
              <Avatar name={activeEmployeeName} size={48} />
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-ink-900">Workstation Monitoring State</h2>
                  <span
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-wide uppercase',
                      self.session
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-400',
                    )}
                  >
                    <span
                      className={cx(
                        'h-2 w-2 rounded-full',
                        self.session ? 'bg-emerald-500 animate-pulse' : 'bg-ink-400',
                      )}
                    />
                    {self.session ? 'Monitoring Active' : 'Not Monitoring'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {self.session
                    ? `${self.session.deviceName} · Work session active since ${formatDateTime(self.session.startedAt)}`
                    : 'Monitoring runs strictly during active office attendance with an authorised desktop agent or browser extension.'}
                </p>
              </div>
            </div>

            {/* Monitoring session controls */}
            <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
              <select
                className="h-9 rounded-lg border border-ink-200 bg-surface px-2.5 text-xs font-medium text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-500/30 min-w-[160px]"
                value={deviceId}
                onChange={(event) => onDeviceIdChange(event.target.value ? Number(event.target.value) : '')}
                aria-label="Monitoring device"
              >
                <option value="">Select registered device…</option>
                {self.devices
                  .filter((device) => device.status === 'active')
                  .map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.deviceName} · {device.osName}
                    </option>
                  ))}
              </select>

              <button
                type="button"
                className="btn-secondary h-9 px-3 text-xs"
                disabled={busy}
                onClick={onRegisterDevice}
                title="Register this browser or desktop machine"
              >
                <Icon name="plus" size={14} />
                <span>Register Device</span>
              </button>

              {self.session ? (
                <button
                  type="button"
                  className="btn-danger h-9 px-3.5 text-xs font-semibold inline-flex items-center gap-1.5"
                  disabled={busy}
                  onClick={onStopSession}
                >
                  <Icon name="pause" size={14} />
                  <span>Stop Work Session</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary h-9 px-3.5 text-xs font-semibold inline-flex items-center gap-1.5"
                  disabled={busy || !self.consent.acknowledged}
                  onClick={onStartSession}
                >
                  <Icon name="play" size={14} />
                  <span>Start Work Session</span>
                </button>
              )}
            </div>
          </div>

          {/* Device pills */}
          {self.devices.length > 0 && (
            <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3 dark:border-ink-800/80">
              <span className="text-[11px] font-semibold text-ink-500 uppercase tracking-wider">Registered Devices:</span>
              {self.devices.map((device) => (
                <span
                  key={device.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-ink-50/60 px-2.5 py-0.5 text-xs font-medium text-ink-700 dark:border-ink-700 dark:bg-ink-800/60 dark:text-ink-200"
                >
                  <Icon name="monitor" size={13} className="text-brand-600" />
                  <span>{device.deviceName}</span>
                  <span className="text-[10px] text-ink-400 font-mono">({device.osName})</span>
                  <button
                    type="button"
                    className="ml-1 text-ink-400 hover:text-red-600"
                    aria-label={`Revoke ${device.deviceName}`}
                    onClick={() => onRevokeDevice(device)}
                    title="Revoke device"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------ 6 Metric Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {/* 1. Active Time */}
        <button
          type="button"
          onClick={() => onSummaryCardClick?.('today')}
          className="group relative flex flex-col justify-between rounded-xl border border-ink-200/90 bg-surface p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-brand-400 shadow-xs"
        >
          <div className="flex items-center justify-between">
            <span className="rounded bg-brand-50 p-2 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              <Icon name="activity" size={18} strokeWidth={2.2} />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400 group-hover:text-brand-600">
              Foreground
            </span>
          </div>
          <div className="mt-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Active Time</p>
            <p className="mt-0.5 text-2xl font-black text-ink-900 tabular-nums">
              {formatMinutes(activeMinutes)}
            </p>
            <p className="mt-1 truncate text-xs text-ink-500">Active application work</p>
          </div>
        </button>

        {/* 2. Attendance Duration */}
        <button
          type="button"
          onClick={() => onSummaryCardClick?.('timeline')}
          className="group relative flex flex-col justify-between rounded-xl border border-ink-200/90 bg-surface p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-emerald-400 shadow-xs"
        >
          <div className="flex items-center justify-between">
            <span className="rounded bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Icon name="clock" size={18} strokeWidth={2.2} />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
              On Duty
            </span>
          </div>
          <div className="mt-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Attendance</p>
            <p className="mt-0.5 text-2xl font-black text-ink-900 tabular-nums">
              {formatMinutes(attendanceMinutes)}
            </p>
            <p className="mt-1 truncate text-xs text-ink-500">
              Break: {self?.daily?.breakMinutes ?? 0}m
            </p>
          </div>
        </button>

        {/* 3. Tasks Completed */}
        <button
          type="button"
          onClick={() => onSummaryCardClick?.('today')}
          className="group relative flex flex-col justify-between rounded-xl border border-ink-200/90 bg-surface p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-sky-400 shadow-xs"
        >
          <div className="flex items-center justify-between">
            <span className="rounded bg-sky-50 p-2 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
              <Icon name="checkCircle" size={18} strokeWidth={2.2} />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-700">
              Verified
            </span>
          </div>
          <div className="mt-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Tasks Completed</p>
            <p className="mt-0.5 text-2xl font-black text-ink-900 tabular-nums">
              {tasksCompleted}
            </p>
            <p className="mt-1 truncate text-xs text-ink-500">Store SOP milestones done</p>
          </div>
        </button>

        {/* 4. Pending Tasks */}
        <button
          type="button"
          onClick={() => onSummaryCardClick?.('today')}
          className="group relative flex flex-col justify-between rounded-xl border border-ink-200/90 bg-surface p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-amber-400 shadow-xs"
        >
          <div className="flex items-center justify-between">
            <span className="rounded bg-amber-50 p-2 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <Icon name="tasks" size={18} strokeWidth={2.2} />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
              Action Req.
            </span>
          </div>
          <div className="mt-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Pending Tasks</p>
            <p className="mt-0.5 text-2xl font-black text-ink-900 tabular-nums">
              {tasksPending}
            </p>
            <p className="mt-1 truncate text-xs text-ink-500">Scheduled for completion</p>
          </div>
        </button>

        {/* 5. Technical Issues */}
        <button
          type="button"
          onClick={() => onSummaryCardClick?.('today')}
          className="group relative flex flex-col justify-between rounded-xl border border-ink-200/90 bg-surface p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-rose-400 shadow-xs"
        >
          <div className="flex items-center justify-between">
            <span className="rounded bg-rose-50 p-2 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              <Icon name="ticket" size={18} strokeWidth={2.2} />
            </span>
            <span className={cx('text-[10px] font-bold uppercase tracking-wider', issuesCount > 0 ? 'text-rose-700' : 'text-ink-400')}>
              {issuesCount > 0 ? 'Incident' : 'Optimal'}
            </span>
          </div>
          <div className="mt-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Technical Issues</p>
            <p className="mt-0.5 text-2xl font-black text-ink-900 tabular-nums">
              {issuesCount}
            </p>
            <p className="mt-1 truncate text-xs text-ink-500">
              {self?.daily?.tickets?.length ?? 0} tickets raised
            </p>
          </div>
        </button>

        {/* 6. Weekly Performance */}
        <button
          type="button"
          onClick={() => onSummaryCardClick?.('weekly')}
          className="group relative flex flex-col justify-between rounded-xl border border-ink-200/90 bg-surface p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-indigo-400 shadow-xs"
        >
          <div className="flex items-center justify-between">
            <span className="rounded bg-indigo-50 p-2 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
              <Icon name="kpi" size={18} strokeWidth={2.2} />
            </span>
            {weeklyGrade && (
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-800">
                Grade {weeklyGrade}
              </span>
            )}
          </div>
          <div className="mt-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Weekly Score</p>
            <p className="mt-0.5 text-2xl font-black text-ink-900 tabular-nums">
              {weeklyScore !== null ? `${weeklyScore}/100` : '—'}
            </p>
            <p className="mt-1 truncate text-xs text-ink-500">
              {self?.weekly?.[0] ? 'Preliminary calculation' : 'Not calculated yet'}
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
