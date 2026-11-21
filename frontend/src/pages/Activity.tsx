import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime, useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, ProgressBar, SectionHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime, titleize } from '../lib/format';
import type { PickerEmployee } from '../lib/types';

// LiveGuard and Monitor Components
import { LiveTrackingMap } from '../components/liveguard/LiveTrackingMap';
import { SystemGuardian } from '../components/liveguard/SystemGuardian';
import { SystemMonitor } from '../components/liveguard/SystemMonitor';
import { ForensicReportModal } from '../components/liveguard/ForensicReportModal';
import { LiveDevicesPanel } from '../components/LiveDevicesPanel';

// Modular Activity Components
import { ActivityOverview } from './activity/ActivityOverview';
import { ActivityTodayPanel } from './activity/ActivityTodayPanel';
import { ActivityRecycleBin } from './activity/ActivityRecycleBin';
import { ActivityErrorTracking } from './activity/ActivityErrorTracking';
import { ActivityDeleteModal, PermanentPurgeModal } from './activity/ActivityDeleteModal';
import {
  formatMinutes,
  type SelfDashboard,
  type DailySummary,
  type WeeklyReport,
  type TeamOverview,
  type TeamRow,
  type MonthlyDashboard,
  type LoginHistoryResponse,
  type TimelineSegment,
  type TrashItem,
  type TrashResponse,
  type ActivityRecordType,
  type Device,
} from './activity/activityTypes';

interface SoftDeleteTarget {
  type: ActivityRecordType;
  id: number;
  title: string;
  detail?: string;
  isBulk?: boolean;
  bulkItems?: { type: string; id: number }[];
}

function browserFingerprint(): string {
  const key = 'wfm_monitor_device';
  let value = localStorage.getItem(key);
  if (!value) {
    value = `${navigator.platform}-${navigator.userAgent.slice(0, 60)}-${crypto.randomUUID()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

export default function Activity() {
  useDocumentTitle('Employee Activity');
  const { user, has, canAny } = useAuth();
  const { connected } = useRealtime();
  const toast = useToast();

  // Root Super Admin check (Renukaradhya EMP-1001 or Super Admin role)
  const isSuperAdmin = user?.roleName === 'Super Admin' || user?.employeeCode === 'EMP-1001';

  // Permissions
  const canTeam = canAny('activity.view.team', 'activity.view.all') || isSuperAdmin;
  const canAdmin = has('activity.view.all') || isSuperAdmin;
  const canReview = has('activity.review') || isSuperAdmin || user?.roleName === 'Admin' || user?.roleName === 'Manager';
  const canPolicy = has('activity.policy.manage') || isSuperAdmin;
  const canDelete = has('activity.delete') || isSuperAdmin || user?.roleName === 'Admin' || user?.roleName === 'HR';
  const canRestore = has('activity.restore') || isSuperAdmin || user?.roleName === 'Admin';
  const canSwitchEmployee = canTeam || canAdmin;

  // Primary State
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [pickerEmployees, setPickerEmployees] = useState<PickerEmployee[]>([]);

  // Navigation tab
  const [tab, setTab] = useState<
    | 'today'
    | 'login_history'
    | 'timeline'
    | 'fleet_map'
    | 'system_guardian'
    | 'hardware_monitor'
    | 'weekly'
    | 'monthly'
    | 'team'
    | 'admin'
    | 'devices'
    | 'trash'
    | 'policy'
    | 'errors'
  >('today');

  // Modals & Panels
  const [forensicReportOpen, setForensicReportOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [detail, setDetail] = useState<{
    employeeId: number;
    daily: DailySummary;
    weekly: WeeklyReport[];
    name: string;
  } | null>(null);

  // Dashboards & Data
  const [self, setSelf] = useState<SelfDashboard | null>(null);
  const [team, setTeam] = useState<TeamOverview | null>(null);
  const [monthly, setMonthly] = useState<MonthlyDashboard | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [feedback, setFeedback] = useState('');
  const [policyForm, setPolicyForm] = useState({
    retentionDays: 90,
    screenshotEnabled: false,
    locationTrackingEnabled: false,
    locationIntervalMinutes: 15,
    allowedDomains: '',
  });

  // Login History State
  const [loginHistory, setLoginHistory] = useState<LoginHistoryResponse | null>(null);
  const [loginLocation, setLoginLocation] = useState<string>('ALL');
  const [loginStatus, setLoginStatus] = useState<string>('all');
  const [loginSearch, setLoginSearch] = useState<string>('');
  const [loginDate, setLoginDate] = useState<string>('');

  // Timeline State
  const [timelineSegments, setTimelineSegments] = useState<TimelineSegment[]>([]);
  const [timelineRange, setTimelineRange] = useState<'today' | 'yesterday' | '7days' | '30days' | 'custom'>('today');
  const [customTimelineDate, setCustomTimelineDate] = useState<string>(new Date().toISOString().slice(0, 10));

  // Store & live filters
  const [locationFilter, setLocationFilter] = useState<string>('ALL');
  const [liveSearch, setLiveSearch] = useState('');

  // Recycle Bin / Trash State
  const [trashData, setTrashData] = useState<TrashResponse>({ items: [], total: 0 });
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashType, setTrashType] = useState('all');
  const [trashSearch, setTrashSearch] = useState('');

  // Deletion Modal Target State
  const [deleteTarget, setDeleteTarget] = useState<SoftDeleteTarget | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashItem | null>(null);
  const [bulkPurgeItems, setBulkPurgeItems] = useState<TrashItem[]>([]);

  // Load employee picker list for authorized managers and admins
  useEffect(() => {
    if (canSwitchEmployee) {
      api.get<PickerEmployee[]>('/employees/picker')
        .then((res) => {
          // Exclude Gagan from manager assignments if appropriate, keep all valid employees
          setPickerEmployees(res);
        })
        .catch(() => undefined);
    }
  }, [canSwitchEmployee]);

  // Main Data Loader
  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'team' && canTeam) {
        setTeam(await api.get<TeamOverview>(`/activity/team?date=${date}`));
      } else if (tab === 'admin' && canAdmin) {
        setTeam(await api.get<TeamOverview>(`/activity/admin?date=${date}`));
      } else if (tab === 'monthly') {
        const empQuery = selectedEmployeeId ? `&employeeId=${selectedEmployeeId}` : '';
        setMonthly(await api.get<MonthlyDashboard>(`/activity/monthly?month=${month}${empQuery}`));
      } else if (tab === 'login_history') {
        const queryParams = new URLSearchParams();
        if (loginDate) queryParams.set('date', loginDate);
        if (loginLocation !== 'ALL') queryParams.set('location', loginLocation);
        if (loginStatus !== 'all') queryParams.set('status', loginStatus);
        if (loginSearch.trim()) queryParams.set('search', loginSearch.trim());
        if (selectedEmployeeId) queryParams.set('employeeId', String(selectedEmployeeId));
        const res = await api.get<LoginHistoryResponse>(`/activity/login-history?${queryParams.toString()}`);
        setLoginHistory(res);
      } else if (tab === 'timeline') {
        const queryDate =
          timelineRange === 'today'
            ? new Date().toISOString().slice(0, 10)
            : timelineRange === 'yesterday'
            ? new Date(Date.now() - 86400000).toISOString().slice(0, 10)
            : customTimelineDate;
        const empQuery = selectedEmployeeId ? `&employeeId=${selectedEmployeeId}` : '';
        const res = await api.get<{ segments: TimelineSegment[] }>(`/activity/timeline?date=${queryDate}${empQuery}`);
        setTimelineSegments(res.segments ?? []);
      } else if (tab === 'trash') {
        setTrashLoading(true);
        try {
          const queryParams = new URLSearchParams();
          if (trashType !== 'all') queryParams.set('type', trashType);
          if (trashSearch.trim()) queryParams.set('search', trashSearch.trim());
          if (selectedEmployeeId) queryParams.set('employeeId', String(selectedEmployeeId));
          const res = await api.get<TrashResponse>(`/activity/trash?${queryParams.toString()}`);
          setTrashData(res);
        } finally {
          setTrashLoading(false);
        }
      } else if (tab === 'today' || tab === 'weekly' || tab === 'policy') {
        const empQuery = selectedEmployeeId ? `&employeeId=${selectedEmployeeId}` : '';
        const result = await api.get<SelfDashboard>(`/activity/dashboard?date=${date}${empQuery}`);
        setSelf(result);
        setNotes(result.daily?.employeeNotes ?? '');
        setDeviceId((current) => current || result.devices.find((device) => device.status === 'active')?.id || '');
        setFeedback(result.weekly[0]?.employeeFeedback ?? '');
        setPolicyForm({
          retentionDays: result.policy.retentionDays,
          screenshotEnabled: result.policy.screenshotEnabled,
          locationTrackingEnabled: Boolean(result.policy.locationTrackingEnabled),
          locationIntervalMinutes: result.policy.locationIntervalMinutes ?? 15,
          allowedDomains: result.policy.allowedDomains.join(', '),
        });
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [
    tab,
    date,
    month,
    selectedEmployeeId,
    loginDate,
    loginLocation,
    loginStatus,
    loginSearch,
    timelineRange,
    customTimelineDate,
    trashType,
    trashSearch,
    canTeam,
    canAdmin,
    toast,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  // Real-time Socket Event Listeners
  useSocketEvent('activity:update', () => {
    if (tab === 'today' || tab === 'team' || tab === 'admin') void load();
  });
  useSocketEvent('activity:heartbeat', () => {
    if (tab === 'today' || tab === 'team' || tab === 'admin') void load();
  });
  useSocketEvent('activity:session', () => void load());
  useSocketEvent('activity:error', () => void load());

  // Policy & Consent Actions
  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.post('/activity/consent');
      toast.success('Monitoring policy acknowledged. Monitored sessions can now start.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const registerDevice = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ deviceId: number; token: string }>('/activity/devices', {
        deviceName: `Browser · ${navigator.platform || 'Workstation'}`,
        osName: navigator.userAgent.includes('Windows')
          ? 'Windows'
          : navigator.userAgent.includes('Mac')
          ? 'macOS'
          : 'Linux',
        osVersion: navigator.userAgent.split(')')[0]?.slice(-40),
        agentVersion: 'web-2.0',
        machineFingerprint: browserFingerprint(),
      });
      setDeviceId(result.deviceId);
      toast.success('Device registered successfully. Copied agent token to clipboard.');
      await navigator.clipboard?.writeText(result.token).catch(() => undefined);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const startSession = async () => {
    if (!deviceId) {
      toast.error('Register or select a workstation device first.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/activity/sessions/start', {
        deviceId: Number(deviceId),
        employeeId: selectedEmployeeId || undefined,
      });
      toast.success('Work session monitoring started.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async () => {
    setBusy(true);
    try {
      await api.post('/activity/sessions/stop', {
        employeeId: selectedEmployeeId || undefined,
        sessionId: self?.session?.id || undefined,
      });
      toast.success('Work session monitoring stopped.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitDaily = async () => {
    setBusy(true);
    try {
      await api.post('/activity/daily/submit', { date, notes });
      toast.success('Daily activity summary submitted for manager review.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const generateWeekly = async () => {
    setBusy(true);
    try {
      await api.post('/activity/weekly/generate', {});
      toast.success('Weekly performance score calculated.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const reviewWeekly = async (report: WeeklyReport, finalize: boolean) => {
    const remarks = window.prompt('Manager remarks (optional):', report.managerRemarks ?? '') ?? undefined;
    if (remarks === undefined) return;
    setBusy(true);
    try {
      await api.post(`/activity/weekly/${report.id}/review`, { managerRemarks: remarks, finalize });
      toast.success(finalize ? 'Weekly performance score finalized.' : 'Manager remarks saved.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async (report: WeeklyReport) => {
    setBusy(true);
    try {
      await api.post(`/activity/weekly/${report.id}/feedback`, { feedback });
      toast.success('Employee feedback submitted.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const openEmployee = async (row: TeamRow) => {
    try {
      const result = await api.get<{ daily: DailySummary; weekly: WeeklyReport[] }>(
        `/activity/employee/${row.id}?date=${date}`
      );
      setDetail({ employeeId: row.id, ...result, name: row.name });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const handleRevokeDevice = async (device: Device) => {
    if (!window.confirm(`Revoke device "${device.deviceName}"? Monitoring will cease on this station.`)) return;
    try {
      await api.del(`/activity/devices/${device.id}`);
      toast.success('Device revoked.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  // Deletion Actions
  const handleRequestDelete = (
    type: ActivityRecordType,
    id: number,
    title: string,
    detail?: string
  ) => {
    setDeleteTarget({ type, id, title, detail });
  };

  const handleBulkDelete = (items: { type: string; id: number }[]) => {
    if (!items.length) return;
    setDeleteTarget({
      type: items[0].type as ActivityRecordType,
      id: 0,
      title: `${items.length} Selected Activity Records`,
      detail: `Bulk deletion of ${items.length} monitored items.`,
      isBulk: true,
      bulkItems: items,
    });
  };

  const handleConfirmDelete = async (
    type: ActivityRecordType,
    id: number,
    reason: string,
    isBulk?: boolean,
    bulkItems?: { type: string; id: number }[]
  ) => {
    setBusy(true);
    try {
      if (isBulk && bulkItems?.length) {
        const res = await api.post<{ success: boolean; affected: number }>('/activity/records/bulk-delete', {
          items: bulkItems,
          reason,
        });
        toast.success(`${res.affected} records moved to Recycle Bin.`);
      } else {
        await api.del(`/activity/records/${type}/${id}${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`);
        toast.success('Record moved to Recycle Bin.');
      }
      setDeleteTarget(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Restore Actions
  const handleRestore = async (item: TrashItem) => {
    setBusy(true);
    try {
      await api.post(`/activity/records/${item.type}/${item.id}/restore`, {});
      toast.success(`Restored "${item.title}" successfully.`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleBulkRestore = async (items: TrashItem[]) => {
    if (!items.length) return;
    setBusy(true);
    try {
      const res = await api.post<{ success: boolean; affected: number }>('/activity/records/bulk-restore', {
        items: items.map((i) => ({ type: i.type, id: i.id })),
      });
      toast.success(`${res.affected} records restored.`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Permanent Purge Actions (Super Admin only)
  const handlePermanentDelete = (item: TrashItem) => {
    setPurgeTarget(item);
    setBulkPurgeItems([]);
  };

  const handleBulkPermanentDelete = (items: TrashItem[]) => {
    setPurgeTarget(null);
    setBulkPurgeItems(items);
  };

  const handleConfirmPermanentPurge = async () => {
    setBusy(true);
    try {
      if (bulkPurgeItems.length) {
        const res = await api.post<{ success: boolean; affected: number }>('/activity/records/bulk-permanent', {
          items: bulkPurgeItems.map((i) => ({ type: i.type, id: i.id })),
        });
        toast.success(`${res.affected} records permanently purged.`);
      } else if (purgeTarget) {
        await api.del(`/activity/records/${purgeTarget.type}/${purgeTarget.id}/permanent`);
        toast.success(`"${purgeTarget.title}" permanently purged.`);
      }
      setPurgeTarget(null);
      setBulkPurgeItems([]);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Summary Card Quick Jump
  const handleSummaryCardClick = (targetTab: string) => {
    if (
      targetTab === 'today' ||
      targetTab === 'login_history' ||
      targetTab === 'timeline' ||
      targetTab === 'weekly' ||
      targetTab === 'monthly' ||
      targetTab === 'team' ||
      targetTab === 'admin'
    ) {
      setTab(targetTab as typeof tab);
    }
  };

  // Tab definitions
  const tabs = useMemo(() => {
    return [
      { value: 'today', label: 'Today' },
      { value: 'login_history', label: 'Login & Logout History' },
      { value: 'timeline', label: 'Activity Timeline' },
      { value: 'fleet_map', label: 'Tactical Fleet GPS' },
      { value: 'system_guardian', label: 'System Guardian & Security' },
      { value: 'hardware_monitor', label: 'Hardware Telemetry & GPU' },
      { value: 'weekly', label: 'Weekly Performance' },
      { value: 'monthly', label: 'Monthly Report' },
      ...(canTeam ? [{ value: 'team', label: 'Store Team Activity' }] : []),
      ...(canAdmin ? [{ value: 'admin', label: 'Live Store Monitoring' }] : []),
      ...(canTeam ? [{ value: 'devices', label: 'Devices & Location' }] : []),
      {
        value: 'trash',
        label: trashData.total > 0 ? `Recycle Bin (${trashData.total})` : 'Recycle Bin',
      },
      { value: 'policy', label: 'Monitoring Policy' },
      { value: 'errors', label: 'Error Tracking & Incidents' },
    ];
  }, [canTeam, canAdmin, trashData.total]);

  return (
    <div className="w-full space-y-5 pb-12">
      {/* 1. Header & Metric Summary Cards */}
      <ActivityOverview
        self={self}
        selectedEmployeeId={selectedEmployeeId}
        employees={pickerEmployees}
        canSwitchEmployee={canSwitchEmployee}
        onSelectEmployee={(id) => setSelectedEmployeeId(id)}
        date={date}
        onDateChange={(d) => setDate(d)}
        loading={loading}
        busy={busy}
        connected={connected}
        onRefresh={() => void load()}
        onOpenForensic={() => setForensicReportOpen(true)}
        onExport={() => {
          const loc = user?.locationCode || 'ALL';
          window.open(`/api/activity/login-history/export?location=${loc}&date=${date}`, '_blank');
        }}
        deviceId={deviceId}
        onDeviceIdChange={(id) => setDeviceId(id)}
        onRegisterDevice={() => void registerDevice()}
        onStartSession={() => void startSession()}
        onStopSession={() => void stopSession()}
        onAcknowledgeConsent={() => void acknowledge()}
        onOpenPolicy={() => setPolicyOpen(true)}
        onRevokeDevice={(dev) => void handleRevokeDevice(dev)}
        onSummaryCardClick={handleSummaryCardClick}
      />

      {/* 2. Navigation Tabs */}
      <div className="rounded-xl border border-ink-200 bg-white p-2 shadow-xs">
        <Tabs tabs={tabs} value={tab} onChange={(value) => setTab(value as typeof tab)} />
      </div>

      {/* 3. Tab Contents */}

      {/* TAB: TODAY */}
      {tab === 'today' && (
        loading || !self ? (
          <Skeleton lines={8} />
        ) : (
          <ActivityTodayPanel
            self={self}
            date={date}
            busy={busy}
            notes={notes}
            onNotesChange={(n) => setNotes(n)}
            onSubmitDaily={() => void submitDaily()}
            canDelete={canDelete}
            onRequestDelete={handleRequestDelete}
            onBulkDelete={handleBulkDelete}
          />
        )
      )}

      {/* TAB: RECYCLE BIN / DELETED RECORDS */}
      {tab === 'trash' && (
        <ActivityRecycleBin
          items={trashData.items}
          total={trashData.total}
          loading={trashLoading}
          busy={busy}
          selectedType={trashType}
          onTypeChange={(t) => setTrashType(t)}
          search={trashSearch}
          onSearchChange={(s) => setTrashSearch(s)}
          onRefresh={() => void load()}
          onRestore={(item) => void handleRestore(item)}
          onPermanentDelete={handlePermanentDelete}
          onBulkRestore={(items) => void handleBulkRestore(items)}
          onBulkPermanentDelete={handleBulkPermanentDelete}
          isSuperAdmin={isSuperAdmin}
        />
      )}

      {/* TAB: LOGIN & LOGOUT HISTORY */}
      {tab === 'login_history' && (
        loading && !loginHistory ? (
          <Skeleton lines={8} />
        ) : (
          <div className="space-y-5">
            {/* KPI Cards */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Total Logins Recorded</p>
                <p className="mt-1 text-2xl font-bold text-ink-900">{loginHistory?.summary?.total ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">Currently Active</p>
                <p className="mt-1 text-2xl font-bold text-emerald-700">{loginHistory?.summary?.active ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Sessions Logged Out</p>
                <p className="mt-1 text-2xl font-bold text-ink-700">{loginHistory?.summary?.ended ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Average Duration</p>
                <p className="mt-1 text-2xl font-bold text-brand-700">
                  {loginHistory?.summary?.avgDurationMinutes ?? 0} mins
                </p>
              </div>
            </div>

            {/* Filter Bar */}
            <Card className="card-pad">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-ink-500">Store:</span>
                  {[
                    { key: 'ALL', label: 'All' },
                    { key: 'DAV', label: 'Davanagere' },
                    { key: 'SHI', label: 'Shivamogga' },
                    { key: 'BEL', label: 'Belagavi' },
                    { key: 'HQ', label: 'Head Office' },
                  ].map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setLoginLocation(s.key)}
                      className={cx(
                        'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                        loginLocation === s.key
                          ? 'bg-brand-600 text-white shadow-xs'
                          : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                      )}
                    >
                      {s.label}
                    </button>
                  ))}

                  <span className="ml-2 text-xs font-semibold text-ink-500">Status:</span>
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'active', label: 'Active Now' },
                    { key: 'normal', label: 'Normal Logout' },
                  ].map((st) => (
                    <button
                      key={st.key}
                      type="button"
                      onClick={() => setLoginStatus(st.key)}
                      className={cx(
                        'rounded-lg px-2 py-1 text-xs font-medium transition-colors',
                        loginStatus === st.key
                          ? 'bg-brand-600 text-white shadow-xs'
                          : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                      )}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={loginDate}
                    onChange={(e) => setLoginDate(e.target.value)}
                    className="input py-1 text-xs"
                    title="Filter by exact date"
                  />
                  {loginDate && (
                    <button
                      type="button"
                      onClick={() => setLoginDate('')}
                      className="text-xs text-ink-500 hover:text-ink-800"
                    >
                      Clear date
                    </button>
                  )}
                  <input
                    type="text"
                    placeholder="Search name, code, browser..."
                    value={loginSearch}
                    onChange={(e) => setLoginSearch(e.target.value)}
                    className="input min-w-[180px] py-1 text-xs"
                  />
                  <a
                    href={`/api/activity/login-history/export?location=${loginLocation}${
                      loginDate ? `&date=${loginDate}` : ''
                    }`}
                    download
                    className="btn-secondary btn-sm"
                  >
                    <Icon name="download" size={14} />
                    <span>Export CSV</span>
                  </a>
                </div>
              </div>
            </Card>

            {/* Audit Table */}
            <Card>
              <div className="card-pad flex items-center justify-between pb-0">
                <SectionHeader
                  title="Employee Login & Logout Records"
                  description="Complete immutable audit trail of work sessions, login/logout timestamps, duration, and IP/device details."
                />
              </div>
              {!loginHistory?.items?.length ? (
                <div className="p-6">
                  <EmptyState
                    compact
                    title="No login records found"
                    description="No login/logout records match your selected filters."
                  />
                </div>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Store Location</th>
                        <th>Login Time</th>
                        <th>Logout Time</th>
                        <th>Session Duration</th>
                        <th>Browser & OS</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loginHistory.items.map((item) => {
                        const isLive = item.terminationStatus === 'active' && !item.logoutAt;
                        return (
                          <tr key={item.id} className={isLive ? 'bg-emerald-50/30' : undefined}>
                            <td>
                              <div>
                                <p className="font-semibold text-ink-900">{item.employeeName}</p>
                                <p className="font-mono text-xs text-ink-500">{item.employeeCode}</p>
                              </div>
                            </td>
                            <td>
                              <Badge tone="neutral">{item.location || 'Head Office'}</Badge>
                            </td>
                            <td>
                              <span className="font-mono text-xs text-ink-800">
                                {formatDateTime(item.loginAt)}
                              </span>
                            </td>
                            <td>
                              {isLive ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />
                                  Active now
                                </span>
                              ) : (
                                <span className="font-mono text-xs text-ink-800">
                                  {item.logoutAt ? formatDateTime(item.logoutAt) : '—'}
                                </span>
                              )}
                            </td>
                            <td>
                              <span className="text-xs font-semibold text-ink-800">
                                {item.durationMinutes ? `${item.durationMinutes} mins` : isLive ? 'Live' : '—'}
                              </span>
                            </td>
                            <td>
                              <p className="text-xs text-ink-700">{item.browser}</p>
                              <p className="text-[11px] text-ink-400">
                                {item.os}
                                {item.ip ? ` · ${item.ip}` : ''}
                              </p>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  isLive
                                    ? 'success'
                                    : item.terminationStatus === 'normal'
                                    ? 'neutral'
                                    : 'warning'
                                }
                              >
                                {isLive ? 'Active' : titleize(item.terminationStatus)}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )
      )}

      {/* TAB: ACTIVITY TIMELINE */}
      {tab === 'timeline' && (
        loading && timelineSegments.length === 0 ? (
          <Skeleton lines={8} />
        ) : (
          <div className="space-y-5">
            <Card className="card-pad">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-ink-500">Date Range:</span>
                  {[
                    { key: 'today', label: 'Today' },
                    { key: 'yesterday', label: 'Yesterday' },
                    { key: '7days', label: 'Last 7 Days' },
                    { key: '30days', label: 'Last 30 Days' },
                    { key: 'custom', label: 'Custom' },
                  ].map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => setTimelineRange(r.key as typeof timelineRange)}
                      className={cx(
                        'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                        timelineRange === r.key
                          ? 'bg-brand-600 text-white shadow-xs'
                          : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                  {timelineRange === 'custom' && (
                    <input
                      type="date"
                      value={customTimelineDate}
                      onChange={(e) => setCustomTimelineDate(e.target.value)}
                      className="input py-1 text-xs"
                    />
                  )}
                </div>
                <button type="button" className="btn-secondary btn-sm" onClick={() => void load()}>
                  <Icon name="refresh" size={14} />
                  <span>Refresh Timeline</span>
                </button>
              </div>
            </Card>

            <Card className="card-pad">
              <SectionHeader
                title="Unified Activity Timeline"
                description="Chronological stream of logins, attendance, monitored applications, breaks, meetings and logout events."
              />
              {timelineSegments.length === 0 ? (
                <EmptyState
                  compact
                  title="No activity recorded for this period"
                  description="No timeline events were captured on this date."
                />
              ) : (
                <div className="relative mt-6 space-y-6 pl-6 before:absolute before:bottom-2 before:left-2 before:top-2 before:w-0.5 before:bg-ink-200">
                  {timelineSegments.map((seg) => (
                    <div key={seg.id} className="relative flex items-start gap-3">
                      <div className="absolute -left-6 top-1 h-4 w-4 rounded-full border-2 border-white bg-brand-600 shadow-xs" />
                      <div className="flex-1 rounded-xl border border-ink-200 bg-white p-3 shadow-xs">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-ink-900">{seg.title}</p>
                          <span className="font-mono text-xs text-ink-400">
                            {formatDateTime(seg.startedAt)}
                          </span>
                        </div>
                        {seg.subtitle && <p className="mt-0.5 text-xs text-ink-600">{seg.subtitle}</p>}
                        {seg.category && (
                          <div className="mt-2 flex items-center gap-2 text-xs">
                            <Badge tone="neutral">{seg.category}</Badge>
                            {seg.durationMinutes ? (
                              <span className="font-medium text-ink-500">{seg.durationMinutes} mins</span>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )
      )}

      {/* TAB: TACTICAL FLEET GPS */}
      {tab === 'fleet_map' && <LiveTrackingMap />}

      {/* TAB: SYSTEM GUARDIAN & SECURITY */}
      {tab === 'system_guardian' && <SystemGuardian />}

      {/* TAB: HARDWARE TELEMETRY & GPU */}
      {tab === 'hardware_monitor' && <SystemMonitor />}

      {/* TAB: WEEKLY PERFORMANCE */}
      {tab === 'weekly' && (
        loading || !self ? (
          <Skeleton lines={8} />
        ) : (
          <div className="space-y-5">
            <Card className="card-pad">
              <SectionHeader
                title="Weekly Performance Scorecard"
                description="Weighted, transparent score published as preliminary until your manager reviews and finalizes it."
                action={
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void generateWeekly()}
                  >
                    Recalculate This Week
                  </button>
                }
              />
              <div className="mt-3 grid gap-2 text-xs text-ink-500 sm:grid-cols-4 lg:grid-cols-7">
                {Object.entries({
                  'Task completion': 25,
                  'On-time delivery': 20,
                  'Work quality': 20,
                  Attendance: 10,
                  'Daily reporting': 10,
                  'Project contribution': 10,
                  Collaboration: 5,
                }).map(([label, weight]) => (
                  <div key={label} className="rounded-lg bg-ink-50 p-2">
                    <p className="font-semibold text-ink-700">{weight}%</p>
                    <p>{label}</p>
                  </div>
                ))}
              </div>
            </Card>

            {self.weekly.length === 0 ? (
              <Card className="card-pad">
                <EmptyState
                  title="No weekly report generated yet"
                  description="Calculate this week to generate an automatic preliminary score."
                />
              </Card>
            ) : (
              self.weekly.map((report) => (
                <Card key={report.id} className="card-pad">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-ink-900">
                        {formatDate(report.weekStart)} – {formatDate(report.weekEnd)}
                      </h2>
                      <p className="text-xs text-ink-500">
                        Generated {formatDateTime((report as unknown as { generatedAt: string }).generatedAt)} ·{' '}
                        {titleize(report.status)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-3xl font-semibold text-ink-900">{report.score}</p>
                        <p className="text-xs text-ink-500">
                          Grade {report.grade}
                          {report.previousScore !== null ? ` · prev ${report.previousScore}` : ''}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      ['Task completion', report.metrics.taskCompletion],
                      ['On-time delivery', report.metrics.onTimeDelivery],
                      ['Work quality', report.metrics.workQuality],
                      ['Attendance', report.metrics.attendance],
                      ['Daily reporting', report.metrics.dailyReporting],
                      ['Project contribution', report.metrics.projectContribution],
                      ['Collaboration', report.metrics.collaboration],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <ProgressBar label={String(label)} value={Number(value ?? 0)} />
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                    <p>
                      <span className="text-ink-500">Tasks:</span> {String(report.metrics.completed ?? 0)}{' '}
                      completed / {String(report.metrics.assigned ?? 0)} assigned
                    </p>
                    <p>
                      <span className="text-ink-500">Reports:</span> {String(report.metrics.reportsSubmitted ?? 0)}{' '}
                      submitted
                    </p>
                    <p>
                      <span className="text-ink-500">Meetings:</span> {String(report.metrics.meetingsAttended ?? 0)}{' '}
                      attended
                    </p>
                  </div>
                  <p className="mt-2 text-xs text-ink-500">{String(report.metrics.applicationUsageNote ?? '')}</p>
                  {report.managerRemarks && (
                    <p className="mt-3 rounded-lg bg-brand-50 p-2.5 text-sm text-brand-900">
                      <strong>Manager:</strong> {report.managerRemarks}
                    </p>
                  )}
                  <div className="mt-3">
                    <Field label="Your feedback">
                      <div className="flex gap-2">
                        <input
                          className="input"
                          value={feedback}
                          onChange={(event) => setFeedback(event.target.value)}
                          placeholder="Context for your manager (meetings, research, troubleshooting…)"
                        />
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => void sendFeedback(report)}
                        >
                          Save
                        </button>
                      </div>
                    </Field>
                  </div>
                  {canReview && (
                    <div className="mt-3 flex gap-2 border-t border-ink-100 pt-2">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => void reviewWeekly(report, false)}
                      >
                        Leave Remarks
                      </button>
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        disabled={report.status === 'final'}
                        onClick={() => void reviewWeekly(report, true)}
                      >
                        Finalize Score
                      </button>
                    </div>
                  )}
                </Card>
              ))
            )}
          </div>
        )
      )}

      {/* TAB: MONTHLY REPORT */}
      {tab === 'monthly' && (
        loading || !monthly ? (
          <Skeleton lines={8} />
        ) : (
          <div className="space-y-5">
            <Card className="card-pad">
              <SectionHeader
                title="Monthly Activity Report"
                description="Automatic month-to-date summary from attendance, monitored applications, tasks, daily reports and weekly scores."
                action={
                  <input
                    type="month"
                    className="input py-1.5"
                    value={month}
                    max={new Date().toISOString().slice(0, 7)}
                    onChange={(event) => setMonth(event.target.value)}
                    aria-label="Report month"
                  />
                }
              />
              <p className="mt-2 text-xs text-ink-500">
                {formatDate(monthly.self.start)} – {formatDate(monthly.self.end)} ·{' '}
                {monthly.self.employee.designation ?? '—'} · {monthly.self.employee.department ?? '—'}
                {monthly.self.employee.manager ? ` · Manager ${monthly.self.employee.manager}` : ''}
              </p>
            </Card>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Active Time</p>
                <p className="mt-1 text-2xl font-bold text-ink-900">
                  {formatMinutes(monthly.self.totals.activeMinutes)}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">{monthly.self.totals.daysMonitored} monitored days</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">Attendance</p>
                <p className="mt-1 text-2xl font-bold text-emerald-700">
                  {monthly.self.totals.attendanceDays} days
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {formatMinutes(monthly.self.totals.attendanceMinutes)}
                </p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Tasks Completed</p>
                <p className="mt-1 text-2xl font-bold text-brand-700">
                  {monthly.self.totals.tasksCompleted}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">{monthly.self.totals.tasksAssigned} assigned</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Summaries Submitted</p>
                <p className="mt-1 text-2xl font-bold text-ink-800">
                  {monthly.self.totals.daysSubmitted}/{monthly.self.totals.daysMonitored}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">{monthly.self.totals.daysApproved} approved</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">Avg Weekly Score</p>
                <p className="mt-1 text-2xl font-bold text-indigo-700">
                  {monthly.self.totals.averageWeeklyScore ?? '—'}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {monthly.self.totals.incidents} issues · {monthly.self.totals.tickets} tickets
                </p>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionHeader
                  title="Applications This Month"
                  description="Foreground active time across monitored days."
                />
                {!monthly.self.applications.length ? (
                  <EmptyState
                    compact
                    title="No application activity"
                    description="Start an authorised work session with the desktop agent."
                  />
                ) : (
                  <div className="mt-3 divide-y divide-ink-100">
                    {monthly.self.applications.slice(0, 10).map((item) => (
                      <div key={item.app} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="min-w-0 truncate text-ink-800">{item.app}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge tone="neutral">{item.category}</Badge>
                          <span className="text-xs text-ink-500">{formatMinutes(item.minutes)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card className="card-pad">
                <SectionHeader
                  title="Weekly Scores in This Month"
                  description="Weekly grades and finalization status."
                />
                {!monthly.self.weekly.length ? (
                  <EmptyState
                    compact
                    title="No weekly reports"
                    description="Generate a weekly report to include a score here."
                  />
                ) : (
                  <div className="mt-3 divide-y divide-ink-100">
                    {monthly.self.weekly.map((rep) => (
                      <div key={rep.weekStart} className="flex items-center justify-between py-2 text-sm">
                        <span>
                          {formatDate(rep.weekStart)} – {formatDate(rep.weekEnd)}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="font-semibold text-ink-900">{rep.score}</span>
                          <Badge tone={rep.status === 'final' ? 'success' : 'info'}>
                            {rep.grade} · {titleize(rep.status)}
                          </Badge>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionHeader
                  title="Key Activities"
                  description="Extracted from tasks, daily reports and work updates."
                />
                {!monthly.self.keyActivities.length ? (
                  <EmptyState compact title="No key activities yet" />
                ) : (
                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-700">
                    {monthly.self.keyActivities.map((activity, index) => (
                      <li key={index}>{activity}</li>
                    ))}
                  </ol>
                )}
              </Card>
              <Card className="card-pad">
                <SectionHeader title="Pending Assignments" />
                {!monthly.self.pendingTasks.length ? (
                  <EmptyState compact title="Nothing pending" />
                ) : (
                  <ul className="mt-3 divide-y divide-ink-100 text-sm">
                    {monthly.self.pendingTasks.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                        <span className="min-w-0 truncate text-ink-800">
                          {t.taskNo} · {t.title}
                        </span>
                        <span className="shrink-0 text-xs text-ink-500">
                          {formatDate(t.dueDate)} · {titleize(t.priority)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        )
      )}

      {/* TAB: STORE TEAM ACTIVITY */}
      {tab === 'team' && (
        loading || !team ? (
          <Skeleton lines={8} />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Team Members</p>
                <p className="mt-1 text-2xl font-bold text-ink-900">{team.totals.employees ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">Monitoring Now</p>
                <p className="mt-1 text-2xl font-bold text-emerald-700">{team.totals.activeNow ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Active Minutes Today</p>
                <p className="mt-1 text-2xl font-bold text-brand-700">
                  {formatMinutes(team.totals.activeMinutes ?? 0)}
                </p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Tasks Completed</p>
                <p className="mt-1 text-2xl font-bold text-ink-800">{team.totals.tasksCompleted ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">Summaries to Review</p>
                <p className="mt-1 text-2xl font-bold text-amber-700">{team.totals.pendingReviews ?? 0}</p>
              </div>
            </div>

            {/* Location Filters & Live Search */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 bg-white p-3.5 shadow-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-semibold text-ink-500">Store / Location:</span>
                {[
                  { key: 'ALL', label: 'All Stores' },
                  { key: 'DAV', label: 'Davanagere (DAV)' },
                  { key: 'SHI', label: 'Shivamogga (SHI)' },
                  { key: 'BEL', label: 'Belagavi (BEL)' },
                  { key: 'HQ', label: 'Head Office (HQ)' },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setLocationFilter(item.key)}
                    className={cx(
                      'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                      locationFilter === item.key
                        ? 'bg-brand-600 text-white shadow-xs'
                        : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="relative min-w-[200px]">
                <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  type="text"
                  placeholder="Filter by name, app or role..."
                  value={liveSearch}
                  onChange={(e) => setLiveSearch(e.target.value)}
                  className="input w-full py-1 pl-8 text-xs"
                />
              </div>
            </div>

            {/* Live Employee Activity Grid */}
            <div>
              <SectionHeader
                title="Live Employee Activity"
                description="Real-time foreground applications, idle status, and live session updates."
              />
              {(() => {
                const filtered = (team.employees ?? []).filter((emp) => {
                  if (locationFilter !== 'ALL') {
                    const loc = (emp.location ?? '').toLowerCase();
                    if (locationFilter === 'DAV' && !loc.includes('davanagere') && !loc.includes('dav')) return false;
                    if (locationFilter === 'SHI' && !loc.includes('shivamogga') && !loc.includes('shi')) return false;
                    if (locationFilter === 'BEL' && !loc.includes('belagavi') && !loc.includes('bel')) return false;
                    if (locationFilter === 'HQ' && !loc.includes('head') && !loc.includes('main') && !loc.includes('hq')) return false;
                  }
                  if (liveSearch.trim()) {
                    const q = liveSearch.toLowerCase();
                    return (
                      emp.name.toLowerCase().includes(q) ||
                      (emp.designation ?? '').toLowerCase().includes(q) ||
                      (emp.currentApp ?? '').toLowerCase().includes(q)
                    );
                  }
                  return true;
                });

                if (filtered.length === 0) {
                  return (
                    <Card className="card-pad mt-3">
                      <EmptyState
                        compact
                        title="No employees match filter"
                        description="Try selecting 'All Stores' or clearing search."
                      />
                    </Card>
                  );
                }

                return (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((row) => (
                      <Card
                        key={row.id}
                        className="card-pad flex flex-col justify-between transition-shadow hover:shadow-md"
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2.5">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                                {row.name.slice(0, 2).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-ink-900">{row.name}</p>
                                <p className="truncate text-xs text-ink-500">
                                  {row.designation ?? 'Team Member'}
                                </p>
                              </div>
                            </div>
                            <span
                              className={cx(
                                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                row.active
                                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                                  : 'bg-slate-100 text-slate-500'
                              )}
                            >
                              <span
                                className={cx(
                                  'h-1.5 w-1.5 rounded-full',
                                  row.active ? 'animate-pulse bg-emerald-500' : 'bg-slate-400'
                                )}
                              />
                              {row.active ? 'Active' : 'Offline'}
                            </span>
                          </div>

                          <div className="mt-3 space-y-1.5 rounded-lg bg-ink-50 p-2.5 text-xs">
                            <div className="flex items-center justify-between">
                              <span className="text-ink-500">Current App:</span>
                              <span className="max-w-[170px] truncate rounded border border-ink-200 bg-white px-2 py-0.5 font-medium text-brand-700">
                                {row.currentApp || (row.active ? 'Active Session' : 'None')}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-ink-500">Active Duration:</span>
                              <span className="font-semibold text-ink-800">
                                {formatMinutes(row.activeMinutes)}
                              </span>
                            </div>
                            {row.idleSeconds ? (
                              <div className="flex items-center justify-between">
                                <span className="text-ink-500">Idle Status:</span>
                                <span className="font-medium text-amber-700">
                                  {formatMinutes(Math.floor(row.idleSeconds / 60))} idle
                                </span>
                              </div>
                            ) : null}
                            {row.location && (
                              <div className="flex items-center justify-between border-t border-ink-200/60 pt-1 text-[11px] text-ink-500">
                                <span>Store Location:</span>
                                <span className="font-medium text-ink-700">{row.location}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between border-t border-ink-100 pt-2 text-xs">
                          <span className="text-ink-400">Score: {row.weeklyScore ?? '—'}</span>
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            onClick={() => void openEmployee(row)}
                          >
                            View Details
                          </button>
                        </div>
                      </Card>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Comprehensive Table */}
            <Card>
              <div className="card-pad pb-0">
                <SectionHeader
                  title="Employee Activity Table"
                  description="Comprehensive daily logs and compliance reports."
                />
              </div>
              {!team.employees?.length ? (
                <EmptyState title="No team members in scope" />
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Status</th>
                        <th>Current App</th>
                        <th>Active Today</th>
                        <th>Tasks Done</th>
                        <th>Daily Summary</th>
                        <th>Weekly Score</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {team.employees.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <div className="flex items-center gap-2">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-bold text-brand-700">
                                {row.name.slice(0, 2).toUpperCase()}
                              </div>
                              <div>
                                <p className="font-medium text-ink-800">{row.name}</p>
                                <p className="text-xs text-ink-500">
                                  {row.designation ?? '—'} · {row.location ?? row.department ?? '—'}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td>
                            {row.active ? (
                              <Badge tone="success">Monitoring</Badge>
                            ) : (
                              <Badge tone="neutral">Offline</Badge>
                            )}
                            {row.needsAssistance && (
                              <Badge tone="warning" className="ml-1">
                                Needs support
                              </Badge>
                            )}
                          </td>
                          <td>
                            <span className="text-xs font-medium text-ink-700">{row.currentApp || '—'}</span>
                          </td>
                          <td>{formatMinutes(row.activeMinutes)}</td>
                          <td>{row.tasksCompleted}</td>
                          <td>
                            {row.dailyStatus ? (
                              <Badge
                                tone={
                                  row.dailyStatus === 'approved'
                                    ? 'success'
                                    : row.dailyStatus === 'submitted'
                                    ? 'info'
                                    : 'neutral'
                                }
                              >
                                {titleize(row.dailyStatus)}
                              </Badge>
                            ) : (
                              <span className="text-xs text-ink-400">—</span>
                            )}
                          </td>
                          <td>
                            {row.weeklyScore ?? '—'}
                            {row.weeklyGrade ? (
                              <span className="ml-1 text-xs text-ink-500">{row.weeklyGrade}</span>
                            ) : null}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={() => void openEmployee(row)}
                            >
                              Details
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )
      )}

      {/* TAB: LIVE STORE MONITORING (ADMIN ONLY) */}
      {tab === 'admin' && (
        loading || !team ? (
          <Skeleton lines={8} />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Registered Devices</p>
                <p className="mt-1 text-2xl font-bold text-ink-900">{team.totals.devices ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">Active Sessions</p>
                <p className="mt-1 text-2xl font-bold text-emerald-700">{team.totals.activeSessions ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Sessions Today</p>
                <p className="mt-1 text-2xl font-bold text-brand-700">{team.totals.sessionsToday ?? 0}</p>
              </div>
              <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
                <p className="text-xs font-semibold uppercase tracking-wider text-rose-600">Open Incidents</p>
                <p className="mt-1 text-2xl font-bold text-rose-700">{team.totals.openIncidents ?? 0}</p>
              </div>
            </div>

            {/* Live Store Location Filtering */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 bg-white p-3.5 shadow-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-semibold text-ink-500">Store / Location:</span>
                {[
                  { key: 'ALL', label: 'All Stores' },
                  { key: 'DAV', label: 'Davanagere (DAV)' },
                  { key: 'SHI', label: 'Shivamogga (SHI)' },
                  { key: 'BEL', label: 'Belagavi (BEL)' },
                  { key: 'HQ', label: 'Head Office (HQ)' },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setLocationFilter(item.key)}
                    className={cx(
                      'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                      locationFilter === item.key
                        ? 'bg-brand-600 text-white shadow-xs'
                        : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="relative min-w-[200px]">
                <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  type="text"
                  placeholder="Search live employees..."
                  value={liveSearch}
                  onChange={(e) => setLiveSearch(e.target.value)}
                  className="input w-full py-1 pl-8 text-xs"
                />
              </div>
            </div>

            <Card className="card-pad">
              <SectionHeader
                title="Live Workforce Monitoring"
                description="Real-time view of store employee application activity across Davanagere, Shivamogga, Belagavi and Head Office."
              />
              <div className="mt-3 grid gap-5 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink-900">Active Work Sessions</h3>
                  {!team.activeSessions?.length ? (
                    <EmptyState compact title="No active monitoring sessions" />
                  ) : (
                    <div className="divide-y divide-ink-100">
                      {team.activeSessions.map((session) => (
                        <div key={session.id} className="flex items-center justify-between py-2 text-sm">
                          <div>
                            <p className="font-semibold text-ink-800">{session.full_name}</p>
                            <p className="text-xs text-ink-500">{session.device_name}</p>
                          </div>
                          <span className="text-xs text-ink-500">
                            since {formatDateTime(session.started_at)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink-900">Technical Incidents</h3>
                  {!team.incidents?.length ? (
                    <EmptyState compact title="No incidents reported" />
                  ) : (
                    <div className="divide-y divide-ink-100">
                      {team.incidents.slice(0, 6).map((row) => (
                        <div key={row.id} className="flex items-center justify-between py-2 text-sm">
                          <div>
                            <p className="font-semibold text-ink-800">{row.title}</p>
                            <p className="text-xs text-ink-500">{formatDateTime(row.lastSeenAt)}</p>
                          </div>
                          <Badge tone={row.severity === 'critical' ? 'danger' : 'warning'}>
                            {row.severity}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          </div>
        )
      )}

      {/* TAB: DEVICES & LOCATION */}
      {tab === 'devices' && canTeam && <LiveDevicesPanel />}

      {/* TAB: MONITORING POLICY */}
      {tab === 'policy' && (
        loading || !self ? (
          <Skeleton lines={6} />
        ) : (
          <Card className="card-pad space-y-4">
            <SectionHeader
              title={self.policy.name}
              description={`Version ${self.policy.version} · effective ${formatDate(
                (self.policy as unknown as { effectiveAt: string }).effectiveAt
              )}`}
              action={
                <Badge tone={self.consent.acknowledged ? 'success' : 'warning'}>
                  {self.consent.acknowledged ? 'Acknowledged' : 'Not acknowledged'}
                </Badge>
              }
            />
            <p className="text-sm leading-relaxed text-ink-700">{self.policy.policyText}</p>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">Screenshots</p>
                <p className="font-medium text-ink-800">
                  {self.policy.screenshotEnabled
                    ? `Every ${self.policy.screenshotIntervalMinutes} min`
                    : 'Disabled'}
                </p>
              </div>
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">Retention</p>
                <p className="font-medium text-ink-800">{self.policy.retentionDays} days</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">Device location</p>
                <p className="font-medium text-ink-800">
                  {self.policy.locationTrackingEnabled
                    ? `Every ${self.policy.locationIntervalMinutes ?? 15} min, work sessions only`
                    : 'Not collected'}
                </p>
              </div>
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">Monitoring window</p>
                <p className="font-medium text-ink-800">Authorised sessions only</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="label">Approved applications</p>
                <div className="flex flex-wrap gap-1.5">
                  {self.policy.allowedApps.map((app) => (
                    <Badge key={app} tone="neutral">
                      {app}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="label">Approved domains</p>
                <div className="flex flex-wrap gap-1.5">
                  {self.policy.allowedDomains.map((domain) => (
                    <Badge key={domain} tone="info">
                      {domain}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setPolicyOpen(true)}
              >
                Full policy text
              </button>
              {!self.consent.acknowledged && (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void acknowledge()}
                >
                  Acknowledge policy
                </button>
              )}
              {self.consent.acknowledged && (
                <button
                  type="button"
                  className="btn-ghost btn-sm text-red-600"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        'Withdraw monitoring consent? Any active session ends and the agent cannot start again until you acknowledge a policy.'
                      )
                    )
                      return;
                    setBusy(true);
                    try {
                      await api.post('/activity/consent/revoke');
                      toast.success('Consent withdrawn. Monitoring stopped.');
                      await load();
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Withdraw consent
                </button>
              )}
            </div>

            {canPolicy && (
              <div className="space-y-3 rounded-lg border border-ink-200 p-3">
                <SectionHeader
                  title="Policy configuration"
                  description="Changes apply to new sessions and are written to the monitoring audit log."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Retention (days)">
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      className="input"
                      value={policyForm.retentionDays}
                      onChange={(event) =>
                        setPolicyForm({ ...policyForm, retentionDays: Number(event.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Screenshot evidence">
                    <label className="flex items-center gap-2 pt-2 text-sm text-ink-700">
                      <input
                        type="checkbox"
                        checked={policyForm.screenshotEnabled}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, screenshotEnabled: event.target.checked })
                        }
                      />
                      Allow screenshot evidence on supported agents (this build stores no screenshots)
                    </label>
                  </Field>
                  <Field
                    label="Device location"
                    hint="Turning this on creates a new policy version: every employee must acknowledge it again before any location is recorded."
                  >
                    <label className="flex items-center gap-2 pt-2 text-sm text-ink-700">
                      <input
                        type="checkbox"
                        checked={policyForm.locationTrackingEnabled}
                        onChange={(event) =>
                          setPolicyForm({
                            ...policyForm,
                            locationTrackingEnabled: event.target.checked,
                          })
                        }
                      />
                      Record device location (Windows Location API) during work sessions
                    </label>
                  </Field>
                  <Field label="Location interval (minutes)">
                    <input
                      type="number"
                      min={5}
                      max={240}
                      className="input"
                      disabled={!policyForm.locationTrackingEnabled}
                      value={policyForm.locationIntervalMinutes}
                      onChange={(event) =>
                        setPolicyForm({
                          ...policyForm,
                          locationIntervalMinutes: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                </div>
                <Field
                  label="Approved work domains"
                  hint="Comma-separated. Only these domains are stored by the browser bridge."
                >
                  <textarea
                    className="input min-h-[70px]"
                    value={policyForm.allowedDomains}
                    onChange={(event) =>
                      setPolicyForm({ ...policyForm, allowedDomains: event.target.value })
                    }
                  />
                </Field>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.put('/activity/policy', {
                        retentionDays: policyForm.retentionDays,
                        screenshotEnabled: policyForm.screenshotEnabled,
                        locationTrackingEnabled: policyForm.locationTrackingEnabled,
                        locationIntervalMinutes: policyForm.locationIntervalMinutes,
                        allowedDomains: policyForm.allowedDomains
                          .split(',')
                          .map((val) => val.trim())
                          .filter(Boolean),
                      });
                      toast.success('Monitoring policy updated.');
                      await load();
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Save Policy
                </button>
              </div>
            )}
          </Card>
        )
      )}

      {/* TAB: ERROR TRACKING & INCIDENTS */}
      {tab === 'errors' && <ActivityErrorTracking />}

      {/* POLICY MODAL */}
      <Modal
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        title={self?.policy.name ?? 'Monitoring Policy'}
        size="lg"
      >
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">
          {self?.policy.policyText}
        </p>
        <div className="mt-4 rounded-lg bg-ink-50 p-3 text-xs text-ink-600">
          Collected: foreground application name and duration, approved work domains, internal module usage,
          task/report/ticket metadata and sanitized technical errors. Never collected: passwords, OTPs,
          keystrokes, clipboard contents, private messages, personal accounts or excluded applications.
        </div>
      </Modal>

      {/* EMPLOYEE DETAIL MODAL */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.name ?? 'Employee Activity'}
        description={detail ? `Activity for ${formatDate(date)}` : undefined}
        size="lg"
      >
        {detail && (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-ink-50 p-2">
                <p className="text-xs text-ink-500">Active time</p>
                <p className="font-semibold">{formatMinutes(detail.daily.activeMinutes)}</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-2">
                <p className="text-xs text-ink-500">Tasks completed</p>
                <p className="font-semibold">{detail.daily.taskSummary?.completed ?? 0}</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-2">
                <p className="text-xs text-ink-500">Attendance</p>
                <p className="font-semibold">{formatMinutes(detail.daily.attendanceMinutes)}</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="label">Applications</p>
                {!(detail.daily.appBreakdown ?? []).length ? (
                  <p className="text-sm text-ink-500">No application data</p>
                ) : (
                  <ul className="space-y-1 text-sm text-ink-700">
                    {(detail.daily.appBreakdown ?? []).slice(0, 10).map((item, idx) => (
                      <li key={idx}>
                        {item.app} · {formatMinutes(item.minutes)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="label">Modules</p>
                {!(detail.daily.moduleBreakdown ?? []).length ? (
                  <p className="text-sm text-ink-500">No module data</p>
                ) : (
                  <ul className="space-y-1 text-sm text-ink-700">
                    {(detail.daily.moduleBreakdown ?? []).slice(0, 10).map((item, idx) => (
                      <li key={idx}>
                        {item.module} · {formatMinutes(Math.round(item.seconds / 60))}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            {canReview && detail.daily.status === 'submitted' && (
              <div className="flex justify-end gap-2 border-t border-ink-100 pt-3">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    const note = window.prompt('Reason for returning this summary:') ?? undefined;
                    if (note === undefined) return;
                    setBusy(true);
                    try {
                      await api.post(`/activity/daily/${detail.daily.id}/review`, {
                        decision: 'returned',
                        note,
                      });
                      toast.success('Summary returned.');
                      setDetail(null);
                      await load();
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Return
                </button>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.post(`/activity/daily/${detail.daily.id}/review`, {
                        decision: 'approved',
                      });
                      toast.success('Daily summary approved.');
                      setDetail(null);
                      await load();
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Approve Summary
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* FORENSIC AUDIT DOSSIER MODAL */}
      <ForensicReportModal
        open={forensicReportOpen}
        onClose={() => setForensicReportOpen(false)}
        employeeName={self?.daily?.employee?.full_name ?? user?.fullName ?? 'Authenticated Employee'}
        employeeCode={self?.daily?.employee?.employee_code ?? user?.employeeCode ?? 'EMP-LIVE'}
        departmentName={
          self?.daily?.employee?.department_name ?? user?.departmentName ?? 'Enterprise Operations'
        }
        locationName={user?.locationName ?? 'Belagavi Flagship Store'}
        date={date}
        activeMinutes={self?.daily?.activeMinutes ?? 442}
        idleMinutes={self?.daily?.breakMinutes ?? 38}
        apps={self?.daily?.appBreakdown}
      />

      {/* SOFT DELETE CONFIRMATION MODAL */}
      <ActivityDeleteModal
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        busy={busy}
      />

      {/* PERMANENT PURGE MODAL (Super Admin Only) */}
      <PermanentPurgeModal
        target={purgeTarget}
        bulkItems={bulkPurgeItems}
        onClose={() => {
          setPurgeTarget(null);
          setBulkPurgeItems([]);
        }}
        onConfirm={() => void handleConfirmPermanentPurge()}
        busy={busy}
      />
    </div>
  );
}
