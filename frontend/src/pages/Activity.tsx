import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { LiveDevicesPanel } from '../components/LiveDevicesPanel';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, ProgressBar, SectionHeader, Skeleton, StatCard, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime, titleize } from '../lib/format';

interface Policy {
  id: number;
  name: string;
  version: number;
  policyText: string;
  screenshotEnabled: boolean;
  screenshotIntervalMinutes: number;
  locationTrackingEnabled?: boolean;
  locationIntervalMinutes?: number;
  retentionDays: number;
  allowedApps: string[];
  allowedDomains: string[];
}

interface Device {
  id: number;
  deviceName: string;
  osName: string;
  status: string;
  lastSeenAt: string | null;
  agentVersion?: string | null;
}

interface AppUsage { app: string; category: string; minutes: number; seconds: number }
interface ModuleUsage { module: string; seconds: number; visits: number }
interface KeyIssue { title: string; severity: string; category: string; ticketId: number | null }
interface DailySummary {
  id: number | null;
  date: string;
  attendanceMinutes: number;
  breakMinutes: number;
  activeMinutes: number;
  appBreakdown: AppUsage[];
  moduleBreakdown: ModuleUsage[];
  taskSummary: { assigned?: number; pending?: number; completed?: number; loggedMinutes?: number; completedItems?: { id: number; taskNo: string; title: string; project: string | null }[] };
  keyActivities: string[];
  issues: KeyIssue[];
  tickets: { id: number; ticket_no: string; subject: string; status: string; priority: string }[];
  employeeNotes: string | null;
  status: string;
  managerNote: string | null;
  employee?: { full_name: string; employee_code: string; department_name: string | null; designation_title: string | null } | null;
}

interface WeeklyReport {
  id: number;
  weekStart: string;
  weekEnd: string;
  score: number;
  grade: string;
  status: string;
  previousScore: number | null;
  metrics: Record<string, number | string | { category: string; minutes: number }[] | Record<string, number>>;
  managerRemarks: string | null;
  employeeFeedback: string | null;
}

interface SelfDashboard {
  date: string;
  policy: Policy;
  consent: { acknowledged: boolean; acknowledgedAt: string | null };
  session: { id: number; deviceName: string; startedAt: string } | null;
  devices: Device[];
  daily: DailySummary;
  errors: { id: number; description: string; severity: string; ticketId: number | null; occurredAt: string }[];
  tickets: { id: number; ticket_no: string; subject: string; status: string; priority: string; created_at: string }[];
  browser: { domain: string; category: string; minutes: number }[];
  weekly: WeeklyReport[];
  sessions: { id: number; started_at: string; ended_at: string | null; status: string; device_name: string }[];
}

interface TeamRow {
  id: number;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  department: string | null;
  designation: string | null;
  location?: string | null;
  active: boolean;
  sessionStartedAt: string | null;
  lastHeartbeatAt?: string | null;
  currentApp?: string | null;
  currentCategory?: string | null;
  idleSeconds?: number;
  activeMinutes: number;
  tasksCompleted: number;
  dailyStatus: string | null;
  keyActivities: string[];
  weeklyScore: number | null;
  weeklyGrade: string | null;
  needsAssistance: boolean;
}

interface MonthlyApplication { app: string; category: string; minutes: number; seconds: number; sessions: number }
interface MonthlyDashboard {
  month: string;
  self: {
    month: string;
    start: string;
    end: string;
    employee: { id: number; name: string; employeeCode: string; department: string | null; designation: string | null; manager: string | null; location: string | null };
    totals: { attendanceDays: number; attendanceMinutes: number; activeMinutes: number; tasksAssigned: number; tasksCompleted: number; daysMonitored: number; daysSubmitted: number; daysApproved: number; incidents: number; tickets: number; averageWeeklyScore: number | null };
    applications: MonthlyApplication[];
    days: { date: string; status: string; activeMinutes: number; attendanceMinutes: number; tasksCompleted: number }[];
    weekly: { weekStart: string; weekEnd: string; score: number; grade: string; status: string }[];
    completedTasks: { id: number; taskNo: string; title: string; project: string | null; completedAt: string }[];
    pendingTasks: { id: number; taskNo: string; title: string; dueDate: string; priority: string; project: string | null }[];
    keyActivities: string[];
  };
  team: {
    scope: 'team' | 'all';
    employees: { id: number; name: string; employeeCode: string; department: string | null; designation: string | null; activeMinutes: number; attendanceDays: number; tasksCompleted: number; submittedDays: number; averageWeeklyScore: number | null }[];
    totals: { employees: number; activeMinutes: number; tasksCompleted: number; submittedDays: number; averageWeeklyScore: number | null };
  } | null;
}

interface TeamOverview {
  scope: 'team' | 'all';
  date: string;
  employees?: TeamRow[];
  totals: Record<string, number | null>;
  departments?: { department: string; employees: number; minutes: number }[];
  applications?: { app: string; category: string; minutes: number }[];
  incidents?: { id: number; title: string; severity: string; status: string; occurrences: number; lastSeenAt: string; ticketNo: string | null }[];
  devices?: { id: number; device_name: string; os_name: string; status: string; last_seen_at: string | null; full_name?: string }[];
  activeSessions?: { id: number; full_name: string; device_name: string; started_at: string; last_heartbeat_at: string | null }[];
}

interface LoginAuditItem {
  id: number;
  sessionId: number | null;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  location: string;
  loginAt: string;
  logoutAt: string | null;
  durationMinutes: number;
  browser: string;
  os: string;
  ip: string | null;
  loginStatus: string;
  logoutReason: string;
  terminationStatus: string;
}

interface LoginHistoryResponse {
  total: number;
  summary: { total: number; active: number; ended: number; avgDurationMinutes: number };
  items: LoginAuditItem[];
}

interface TimelineSegment {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  startedAt: string;
  endedAt?: string | null;
  durationMinutes?: number;
  category?: string;
  status?: string;
}

function minutes(value: number): string {
  const hours = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
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
  useDocumentTitle('Employee activity');
  const { user, has, canAny } = useAuth();
  const toast = useToast();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [tab, setTab] = useState<'today' | 'login_history' | 'timeline' | 'weekly' | 'monthly' | 'team' | 'admin' | 'devices' | 'policy'>('today');
  const [self, setSelf] = useState<SelfDashboard | null>(null);
  const [team, setTeam] = useState<TeamOverview | null>(null);
  const [monthly, setMonthly] = useState<MonthlyDashboard | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [feedback, setFeedback] = useState('');
  const [detail, setDetail] = useState<{ employeeId: number; daily: DailySummary; weekly: WeeklyReport[]; name: string } | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyForm, setPolicyForm] = useState({ retentionDays: 90, screenshotEnabled: false, locationTrackingEnabled: false, locationIntervalMinutes: 15, allowedDomains: '' });

  // Login History State
  const [loginHistory, setLoginHistory] = useState<LoginHistoryResponse | null>(null);
  const [loginLocation, setLoginLocation] = useState<string>('ALL');
  const [loginStatus, setLoginStatus] = useState<string>('all');
  const [loginSearch, setLoginSearch] = useState<string>('');
  const [loginDate, setLoginDate] = useState<string>('');

  // Activity Timeline State
  const [timelineSegments, setTimelineSegments] = useState<TimelineSegment[]>([]);
  const [timelineRange, setTimelineRange] = useState<'today' | 'yesterday' | '7days' | '30days' | 'custom'>('today');
  const [customTimelineDate, setCustomTimelineDate] = useState<string>(new Date().toISOString().slice(0, 10));

  const canTeam = canAny('activity.view.team', 'activity.view.all');
  const canAdmin = has('activity.view.all');
  const canReview = has('activity.review');
  const canPolicy = has('activity.policy.manage');

  const load = async () => {
    setLoading(true);
    try {
      if (tab === 'team' && canTeam) {
        setTeam(await api.get<TeamOverview>(`/activity/team?date=${date}`));
      } else if (tab === 'admin' && canAdmin) {
        setTeam(await api.get<TeamOverview>(`/activity/admin?date=${date}`));
      } else if (tab === 'monthly') {
        setMonthly(await api.get<MonthlyDashboard>(`/activity/monthly?month=${month}`));
      } else if (tab === 'login_history') {
        const queryParams = new URLSearchParams();
        if (loginDate) queryParams.set('date', loginDate);
        if (loginLocation !== 'ALL') queryParams.set('location', loginLocation);
        if (loginStatus !== 'all') queryParams.set('status', loginStatus);
        if (loginSearch.trim()) queryParams.set('search', loginSearch.trim());
        const res = await api.get<LoginHistoryResponse>(`/activity/login-history?${queryParams.toString()}`);
        setLoginHistory(res);
      } else if (tab === 'timeline') {
        const queryDate = timelineRange === 'today' ? new Date().toISOString().slice(0, 10)
          : timelineRange === 'yesterday' ? new Date(Date.now() - 86400000).toISOString().slice(0, 10)
          : customTimelineDate;
        const res = await api.get<{ segments: TimelineSegment[] }>(`/activity/timeline?date=${queryDate}`);
        setTimelineSegments(res.segments ?? []);
      } else if (tab === 'today' || tab === 'weekly' || tab === 'policy') {
        const result = await api.get<SelfDashboard>(`/activity/dashboard?date=${date}`);
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
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, date, month, loginDate, loginLocation, loginStatus, timelineRange, customTimelineDate]);

  const [locationFilter, setLocationFilter] = useState<string>('ALL');
  const [liveSearch, setLiveSearch] = useState('');

  useSocketEvent('activity:update', () => { if (tab === 'today' || tab === 'team' || tab === 'admin') void load(); });
  useSocketEvent('activity:heartbeat', () => { if (tab === 'today' || tab === 'team' || tab === 'admin') void load(); });
  useSocketEvent('activity:session', () => void load());
  useSocketEvent('activity:error', () => void load());

  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.post('/activity/consent');
      toast.success('Monitoring policy acknowledged. Sessions can now start.');
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const registerDevice = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ deviceId: number; token: string }>('/activity/devices', {
        deviceName: `Browser · ${navigator.platform || 'this device'}`,
        osName: (navigator.userAgent.includes('Windows') ? 'Windows' : navigator.userAgent.includes('Mac') ? 'macOS' : 'Linux'),
        osVersion: navigator.userAgent.split(')')[0]?.slice(-40),
        agentVersion: 'web-1.0',
        machineFingerprint: browserFingerprint(),
      });
      setDeviceId(result.deviceId);
      toast.success('Device registered. Copy the agent token into the desktop agent or browser extension.');
      await navigator.clipboard?.writeText(result.token).catch(() => undefined);
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const startSession = async () => {
    if (!deviceId) { toast.error('Register or select a device first.'); return; }
    setBusy(true);
    try {
      await api.post('/activity/sessions/start', { deviceId: Number(deviceId) });
      toast.success('Work session monitoring started.');
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const stopSession = async () => {
    setBusy(true);
    try {
      await api.post('/activity/sessions/stop');
      toast.success('Monitoring stopped.');
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const submitDaily = async () => {
    setBusy(true);
    try {
      await api.post('/activity/daily/submit', { date, notes });
      toast.success('Daily activity summary submitted for manager review.');
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const generateWeekly = async () => {
    setBusy(true);
    try {
      await api.post('/activity/weekly/generate', {});
      toast.success('Weekly performance calculated.');
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const reviewWeekly = async (report: WeeklyReport, finalize: boolean) => {
    const remarks = window.prompt('Manager remarks (optional):', report.managerRemarks ?? '') ?? undefined;
    if (remarks === undefined) return;
    setBusy(true);
    try {
      await api.post(`/activity/weekly/${report.id}/review`, { managerRemarks: remarks, finalize });
      toast.success(finalize ? 'Weekly score finalized.' : 'Remarks saved.');
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const sendFeedback = async (report: WeeklyReport) => {
    setBusy(true);
    try {
      await api.post(`/activity/weekly/${report.id}/feedback`, { feedback });
      toast.success('Feedback saved.');
      await load();
    } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
  };

  const openEmployee = async (row: TeamRow) => {
    try {
      const result = await api.get<{ daily: DailySummary; weekly: WeeklyReport[] }>(`/activity/employee/${row.id}?date=${date}`);
      setDetail({ employeeId: row.id, ...result, name: row.name });
    } catch (caught) { toast.error(errorMessage(caught)); }
  };

  const maxAppSeconds = useMemo(() => Math.max(1, ...(self?.daily?.appBreakdown ?? []).map((item) => item.seconds)), [self]);
  const tabs = useMemo(() => [
    { value: 'today', label: 'Today' },
    { value: 'login_history', label: 'Login & Logout History' },
    { value: 'timeline', label: 'Activity Timeline' },
    { value: 'weekly', label: 'Weekly performance' },
    { value: 'monthly', label: 'Monthly report' },
    ...(canTeam ? [{ value: 'team', label: 'Store Team Activity' }] : []),
    ...(canAdmin ? [{ value: 'admin', label: 'Live Store Monitoring' }] : []),
    ...(canTeam ? [{ value: 'devices', label: 'Devices & Location' }] : []),
    { value: 'policy', label: 'Monitoring policy' },
  ], [canTeam, canAdmin]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employee activity"
        description="Consent-based work activity, application usage, technical issues and transparent weekly performance."
        actions={
          <>
            <input type="date" className="input py-1.5" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setDate(event.target.value)} aria-label="Activity date" />
            <button type="button" className="btn-secondary btn-sm" onClick={() => void load()}><Icon name="refresh" size={15} /> Refresh</button>
          </>
        }
      />

      <Tabs tabs={tabs} value={tab} onChange={(value) => setTab(value as typeof tab)} />

      {tab === 'today' && (
        loading || !self ? <Skeleton lines={8} /> : (
          <div className="space-y-5">
            {!self.consent.acknowledged && (
              <Card className="card-pad border-amber-300 bg-amber-50">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="max-w-2xl">
                    <h2 className="text-base font-semibold text-amber-900">Monitoring policy acknowledgement required</h2>
                    <p className="mt-1 text-sm text-amber-800">{self.policy.policyText}</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setPolicyOpen(true)}>Read policy</button>
                    <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void acknowledge()}>I acknowledge</button>
                  </div>
                </div>
              </Card>
            )}

            <Card className="card-pad">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Avatar name={user?.fullName ?? ''} src={user?.photoUrl} size={48} />
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-ink-900">Monitoring status</h2>
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${self.session ? 'bg-emerald-50 text-emerald-700' : 'bg-ink-100 text-ink-600'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${self.session ? 'animate-pulse bg-emerald-500' : 'bg-ink-400'}`} />
                        {self.session ? 'Monitoring active' : 'Not monitoring'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-ink-500">
                      {self.session ? `${self.session.deviceName} · since ${formatDateTime(self.session.startedAt)}` : 'Starts only during office attendance and an authorised work session.'}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select className="input py-1.5 text-sm" value={deviceId} onChange={(event) => setDeviceId(event.target.value ? Number(event.target.value) : '')} aria-label="Monitoring device">
                    <option value="">Select device…</option>
                    {self.devices.filter((device) => device.status === 'active').map((device) => (
                      <option key={device.id} value={device.id}>{device.deviceName} · {device.osName}</option>
                    ))}
                  </select>
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void registerDevice()}>Register device</button>
                  {self.session
                    ? <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={() => void stopSession()}>Stop monitoring</button>
                    : <button type="button" className="btn-primary btn-sm" disabled={busy || !self.consent.acknowledged} onClick={() => void startSession()}>Start work session</button>}
                </div>
              </div>
              {self.devices.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {self.devices.map((device) => (
                    <span key={device.id} className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 px-2.5 py-1 text-xs text-ink-600">
                      {device.deviceName} · {device.status}
                      <button type="button" className="text-ink-400 hover:text-red-600" aria-label={`Revoke ${device.deviceName}`}
                        onClick={async () => {
                          if (!window.confirm(`Revoke ${device.deviceName}? Monitoring stops on this device.`)) return;
                          try { await api.del(`/activity/devices/${device.id}`); toast.success('Device revoked.'); await load(); }
                          catch (caught) { toast.error(errorMessage(caught)); }
                        }}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </Card>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="Active time" value={minutes(self.daily?.activeMinutes ?? 0)} hint="Foreground application time" icon={<Icon name="activity" size={18} />} />
              <StatCard label="Attendance" value={minutes(self.daily?.attendanceMinutes ?? 0)} hint={`Break ${self.daily?.breakMinutes ?? 0}m`} tone="success" icon={<Icon name="clock" size={18} />} />
              <StatCard label="Tasks completed" value={self.daily?.taskSummary?.completed ?? 0} hint={`${self.daily?.taskSummary?.pending ?? 0} pending`} tone="brand" icon={<Icon name="tasks" size={18} />} />
              <StatCard label="Technical issues" value={self.daily?.issues?.length ?? 0} hint={`${self.daily?.tickets?.length ?? 0} tickets raised`} tone={self.daily?.issues?.length ? 'warning' : 'neutral'} icon={<Icon name="ticket" size={18} />} />
              <StatCard label="Weekly score" value={self.weekly[0]?.score ?? '—'} hint={self.weekly[0] ? `${self.weekly[0].grade} · ${titleize(self.weekly[0].status)}` : 'Not calculated yet'} tone="success" icon={<Icon name="kpi" size={18} />} />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionHeader title="Application usage" description="Foreground active time only; background applications are not counted." />
                {!self.daily?.appBreakdown?.length ? <EmptyState compact title="No application activity recorded" description="Install the desktop agent or browser extension and start a monitored work session." /> : (
                  <div className="mt-3 space-y-2.5">
                    {self.daily.appBreakdown.slice(0, 10).map((item) => (
                      <div key={item.app}>
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate text-ink-800">{item.app}</span>
                          <span className="flex shrink-0 items-center gap-2"><Badge tone="neutral">{item.category}</Badge><span className="w-14 text-right text-xs font-medium text-ink-600">{minutes(item.minutes)}</span></span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                          <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(4, Math.round((item.seconds / maxAppSeconds) * 100))}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card className="card-pad">
                <SectionHeader title="Authorised browser activity" description="Approved work domains only; titles, inputs and private browsing are never captured." />
                {!self.browser.length ? <EmptyState compact title="No approved browsing recorded" description="Only domains in the monitoring policy are stored." /> : (
                  <div className="mt-3 divide-y divide-ink-100">
                    {self.browser.map((item) => (
                      <div key={item.domain} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="min-w-0 truncate text-ink-800">{item.domain}</span>
                        <span className="flex shrink-0 items-center gap-2"><Badge tone="info">{item.category}</Badge><span className="text-xs text-ink-500">{minutes(item.minutes)}</span></span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionHeader title="Platform modules" description="Time inside this Workforce platform during the monitored session." />
                {!self.daily?.moduleBreakdown?.length ? <EmptyState compact title="No module activity yet" description="Module usage is recorded automatically while monitoring is active." /> : (
                  <div className="mt-3 divide-y divide-ink-100">
                    {self.daily.moduleBreakdown.map((item) => (
                      <div key={item.module} className="flex items-center justify-between py-2 text-sm">
                        <span className="text-ink-800">{item.module}</span>
                        <span className="text-xs text-ink-500">{minutes(Math.round(item.seconds / 60))} · {item.visits} visits</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card className="card-pad">
                <SectionHeader title="Key activities" description="Derived from your tasks, daily report and approved work events. Correct the summary below if needed." />
                {!self.daily?.keyActivities?.length ? <EmptyState compact title="No key activities extracted" description="Complete tasks or submit a daily work report to populate this summary." /> : (
                  <ol className="mt-3 space-y-1.5 text-sm text-ink-700">
                    {self.daily.keyActivities.map((activity, index) => (
                      <li key={index} className="flex gap-2"><span className="text-ink-400">{index + 1}.</span><span>{activity}</span></li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>

            <Card className="card-pad">
              <SectionHeader title="Daily activity summary" description={`Employee submission for ${formatDate(date)}.`} action={<Badge tone={self.daily?.status === 'approved' ? 'success' : self.daily?.status === 'submitted' ? 'info' : 'neutral'}>{titleize(self.daily?.status ?? 'draft')}</Badge>} />
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Completed tasks">
                  {!self.daily?.taskSummary?.completedItems?.length ? <p className="text-sm text-ink-500">No tasks completed on this date.</p> : (
                    <ul className="space-y-1 text-sm text-ink-700">
                      {self.daily.taskSummary.completedItems.map((task) => <li key={task.id}>{task.taskNo} · {task.title}{task.project ? ` · ${task.project}` : ''}</li>)}
                    </ul>
                  )}
                </Field>
                <Field label="Issues and tickets">
                  {self.daily?.issues?.length ? <ul className="space-y-1 text-sm text-ink-700">{self.daily.issues.map((issue, index) => <li key={index}>{issue.title} <Badge tone="warning">{issue.severity}</Badge>{issue.ticketId ? <span className="ml-1 text-xs text-ink-500">ticket #{issue.ticketId}</span> : null}</li>)}</ul> : <p className="text-sm text-ink-500">No technical issues recorded.</p>}
                </Field>
              </div>
              <Field label="Your notes / corrections" hint="Add missing context before submitting. Managers see these notes.">
                <textarea className="input min-h-[80px]" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Explain offline work, meetings or corrections to the automatic summary…" />
              </Field>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-500">Generated from attendance, monitored applications, tasks, reports and tickets. Application time is context, not a productivity verdict.</p>
                <button type="button" className="btn-primary btn-sm" disabled={busy || self.daily?.status === 'approved'} onClick={() => void submitDaily()}>{self.daily?.status === 'submitted' ? 'Resubmit summary' : 'Submit to manager'}</button>
              </div>
              {self.daily?.managerNote && <p className="mt-2 rounded-lg bg-ink-50 p-2 text-xs text-ink-600">Manager note: {self.daily.managerNote}</p>}
            </Card>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionHeader title="Technical issues" />
                {!self.errors.length ? <EmptyState compact title="No technical issues" description="Detected application or connectivity errors appear here and in the helpdesk." /> : (
                  <ul className="mt-3 divide-y divide-ink-100 text-sm">
                    {self.errors.map((issue) => (
                      <li key={issue.id} className="py-2">
                        <div className="flex items-center justify-between gap-2"><span className="truncate text-ink-800">{issue.description}</span><Badge tone={issue.severity === 'critical' ? 'danger' : 'warning'}>{issue.severity}</Badge></div>
                        <p className="mt-0.5 text-xs text-ink-500">{formatDateTime(issue.occurredAt)}{issue.ticketId ? ` · ticket #${issue.ticketId}` : ''}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card className="card-pad">
                <SectionHeader title="My tickets" action={<a className="text-xs font-medium text-brand-700 hover:underline" href="/tickets">Open helpdesk →</a>} />
                {!self.tickets.length ? <EmptyState compact title="No tickets raised" description="Tickets you raise, including automatic incident tickets, appear here." /> : (
                  <ul className="mt-3 divide-y divide-ink-100 text-sm">
                    {self.tickets.map((ticket) => (
                      <li key={ticket.id} className="flex items-center justify-between gap-2 py-2">
                        <span className="min-w-0 truncate text-ink-800">{ticket.ticket_no} · {ticket.subject}</span>
                        <Badge tone={ticket.status === 'resolved' || ticket.status === 'closed' ? 'success' : 'info'}>{titleize(ticket.status)}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        )
      )}

      {tab === 'login_history' && (
        loading && !loginHistory ? <Skeleton lines={8} /> : (
          <div className="space-y-5">
            {/* KPI Cards */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Total Logins Recorded" value={loginHistory?.summary?.total ?? 0} tone="brand" />
              <StatCard label="Currently Active" value={loginHistory?.summary?.active ?? 0} tone="success" />
              <StatCard label="Sessions Logged Out" value={loginHistory?.summary?.ended ?? 0} tone="neutral" />
              <StatCard label="Average Duration" value={`${loginHistory?.summary?.avgDurationMinutes ?? 0} mins`} tone="brand" />
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
                      className={cx('rounded-lg px-2.5 py-1 text-xs font-medium transition-colors', loginLocation === s.key ? 'bg-brand-600 text-white shadow-xs' : 'bg-ink-100 text-ink-700 hover:bg-ink-200')}
                    >
                      {s.label}
                    </button>
                  ))}

                  <span className="text-xs font-semibold text-ink-500 ml-2">Status:</span>
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'active', label: 'Active Now' },
                    { key: 'normal', label: 'Normal Logout' },
                  ].map((st) => (
                    <button
                      key={st.key}
                      type="button"
                      onClick={() => setLoginStatus(st.key)}
                      className={cx('rounded-lg px-2 py-1 text-xs font-medium transition-colors', loginStatus === st.key ? 'bg-brand-600 text-white shadow-xs' : 'bg-ink-100 text-ink-600 hover:bg-ink-200')}
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
                    <button type="button" onClick={() => setLoginDate('')} className="text-xs text-ink-500 hover:text-ink-800">Clear date</button>
                  )}
                  <input
                    type="text"
                    placeholder="Search name, code, browser..."
                    value={loginSearch}
                    onChange={(e) => setLoginSearch(e.target.value)}
                    className="input py-1 text-xs min-w-[180px]"
                  />
                  <a
                    href={`/api/activity/login-history/export?location=${loginLocation}${loginDate ? `&date=${loginDate}` : ''}`}
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
              <div className="card-pad pb-0 flex items-center justify-between">
                <SectionHeader
                  title="Employee Login & Logout Records"
                  description="Complete immutable audit trail of work sessions, login/logout timestamps, duration, and IP/device details."
                />
              </div>
              {!loginHistory?.items?.length ? (
                <div className="p-6">
                  <EmptyState compact title="No login records found" description="No login/logout records match your selected filters." />
                </div>
              ) : (
                <div className="overflow-x-auto mt-2">
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
                                <p className="text-xs text-ink-500 font-mono">{item.employeeCode}</p>
                              </div>
                            </td>
                            <td>
                              <Badge tone="neutral">{item.location || 'Head Office'}</Badge>
                            </td>
                            <td>
                              <span className="text-xs font-mono text-ink-800">{formatDateTime(item.loginAt)}</span>
                            </td>
                            <td>
                              {isLive ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-pulse" />
                                  Active now
                                </span>
                              ) : (
                                <span className="text-xs font-mono text-ink-800">{item.logoutAt ? formatDateTime(item.logoutAt) : '—'}</span>
                              )}
                            </td>
                            <td>
                              <span className="text-xs font-semibold text-ink-800">{item.durationMinutes ? `${item.durationMinutes} mins` : isLive ? 'Live' : '—'}</span>
                            </td>
                            <td>
                              <p className="text-xs text-ink-700">{item.browser}</p>
                              <p className="text-[11px] text-ink-400">{item.os}{item.ip ? ` · ${item.ip}` : ''}</p>
                            </td>
                            <td>
                              <Badge tone={isLive ? 'success' : item.terminationStatus === 'normal' ? 'neutral' : 'warning'}>
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

      {tab === 'timeline' && (
        loading && timelineSegments.length === 0 ? <Skeleton lines={8} /> : (
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
                      onClick={() => setTimelineRange(r.key as any)}
                      className={cx('rounded-lg px-2.5 py-1 text-xs font-medium transition-colors', timelineRange === r.key ? 'bg-brand-600 text-white shadow-xs' : 'bg-ink-100 text-ink-700 hover:bg-ink-200')}
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
                <EmptyState compact title="No activity recorded for this period" description="No timeline events were captured on this date." />
              ) : (
                <div className="relative mt-6 pl-6 space-y-6 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-ink-200">
                  {timelineSegments.map((seg) => (
                    <div key={seg.id} className="relative flex items-start gap-3">
                      <div className="absolute -left-6 top-1 h-4 w-4 rounded-full border-2 border-white bg-brand-600 shadow-xs" />
                      <div className="flex-1 rounded-xl border border-ink-200 bg-white p-3 shadow-xs">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-sm text-ink-900">{seg.title}</p>
                          <span className="text-xs font-mono text-ink-400">{formatDateTime(seg.startedAt)}</span>
                        </div>
                        {seg.subtitle && <p className="text-xs text-ink-600 mt-0.5">{seg.subtitle}</p>}
                        {seg.category && (
                          <div className="mt-2 flex items-center gap-2 text-xs">
                            <Badge tone="neutral">{seg.category}</Badge>
                            {seg.durationMinutes ? <span className="text-ink-500 font-medium">{seg.durationMinutes} mins</span> : null}
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

      {tab === 'weekly' && (
        loading || !self ? <Skeleton lines={8} /> : (
          <div className="space-y-5">
            <Card className="card-pad">
              <SectionHeader
                title="Weekly performance"
                description="Weighted, transparent score published as preliminary until your manager reviews it."
                action={<button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void generateWeekly()}>Recalculate this week</button>}
              />
              <div className="mt-3 grid gap-2 text-xs text-ink-500 sm:grid-cols-4 lg:grid-cols-7">
                {Object.entries({ 'Task completion': 25, 'On-time delivery': 20, 'Work quality': 20, Attendance: 10, 'Daily reporting': 10, 'Project contribution': 10, Collaboration: 5 }).map(([label, weight]) => (
                  <div key={label} className="rounded-lg bg-ink-50 p-2"><p className="font-semibold text-ink-700">{weight}%</p><p>{label}</p></div>
                ))}
              </div>
            </Card>

            {self.weekly.length === 0 ? <Card className="card-pad"><EmptyState title="No weekly report yet" description="Calculate this week to generate a preliminary score." /></Card> : self.weekly.map((report) => (
              <Card key={report.id} className="card-pad">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-ink-900">{formatDate(report.weekStart)} – {formatDate(report.weekEnd)}</h2>
                    <p className="text-xs text-ink-500">Generated {formatDateTime((report as unknown as { generatedAt: string }).generatedAt)} · {titleize(report.status)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right"><p className="text-3xl font-semibold text-ink-900">{report.score}</p><p className="text-xs text-ink-500">Grade {report.grade}{report.previousScore !== null ? ` · prev ${report.previousScore}` : ''}</p></div>
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
                    <div key={String(label)}><ProgressBar label={String(label)} value={Number(value ?? 0)} /></div>
                  ))}
                </div>
                <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                  <p><span className="text-ink-500">Tasks:</span> {String(report.metrics.completed ?? 0)} completed / {String(report.metrics.assigned ?? 0)} assigned</p>
                  <p><span className="text-ink-500">Reports:</span> {String(report.metrics.reportsSubmitted ?? 0)} submitted</p>
                  <p><span className="text-ink-500">Meetings:</span> {String(report.metrics.meetingsAttended ?? 0)} attended</p>
                </div>
                <p className="mt-2 text-xs text-ink-500">{String(report.metrics.applicationUsageNote ?? '')}</p>
                {report.managerRemarks && <p className="mt-3 rounded-lg bg-brand-50 p-2 text-sm text-brand-900">Manager: {report.managerRemarks}</p>}
                <div className="mt-3">
                  <Field label="Your feedback">
                    <div className="flex gap-2">
                      <input className="input" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Context for your manager (meetings, research, troubleshooting…)" />
                      <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void sendFeedback(report)}>Save</button>
                    </div>
                  </Field>
                </div>
                {canReview && (
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="btn-secondary btn-sm" onClick={() => void reviewWeekly(report, false)}>Leave remarks</button>
                    <button type="button" className="btn-primary btn-sm" disabled={report.status === 'final'} onClick={() => void reviewWeekly(report, true)}>Finalize</button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )
      )}

      {tab === 'monthly' && (
        loading || !monthly ? <Skeleton lines={8} /> : (
          <div className="space-y-5">
            <Card className="card-pad">
              <SectionHeader
                title="Monthly activity report"
                description="Automatic month-to-date summary from attendance, monitored applications, tasks, daily reports and weekly scores."
                action={<input type="month" className="input py-1.5" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(event) => setMonth(event.target.value)} aria-label="Report month" />}
              />
              <p className="mt-2 text-xs text-ink-500">{formatDate(monthly.self.start)} – {formatDate(monthly.self.end)} · {monthly.self.employee.designation ?? '—'} · {monthly.self.employee.department ?? '—'}{monthly.self.employee.manager ? ` · Manager ${monthly.self.employee.manager}` : ''}</p>
            </Card>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="Active time" value={minutes(monthly.self.totals.activeMinutes)} hint={`${monthly.self.totals.daysMonitored} monitored days`} icon={<Icon name="activity" size={18} />} />
              <StatCard label="Attendance" value={`${monthly.self.totals.attendanceDays} days`} hint={minutes(monthly.self.totals.attendanceMinutes)} tone="success" icon={<Icon name="clock" size={18} />} />
              <StatCard label="Tasks completed" value={monthly.self.totals.tasksCompleted} hint={`${monthly.self.totals.tasksAssigned} assigned`} tone="brand" icon={<Icon name="tasks" size={18} />} />
              <StatCard label="Summaries submitted" value={`${monthly.self.totals.daysSubmitted}/${monthly.self.totals.daysMonitored}`} hint={`${monthly.self.totals.daysApproved} approved`} tone="neutral" icon={<Icon name="report" size={18} />} />
              <StatCard label="Average weekly score" value={monthly.self.totals.averageWeeklyScore ?? '—'} hint={`${monthly.self.totals.incidents} issues · ${monthly.self.totals.tickets} tickets`} tone="success" icon={<Icon name="kpi" size={18} />} />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionHeader title="Applications this month" description="Foreground active time, contextual only." />
                {!monthly.self.applications.length ? <EmptyState compact title="No application activity" description="Start an authorised work session with the desktop agent." /> : (
                  <div className="mt-3 divide-y divide-ink-100">
                    {monthly.self.applications.slice(0, 10).map((item) => (
                      <div key={item.app} className="flex items-center justify-between gap-3 py-2 text-sm"><span className="min-w-0 truncate text-ink-800">{item.app}</span><span className="flex shrink-0 items-center gap-2"><Badge tone="neutral">{item.category}</Badge><span className="text-xs text-ink-500">{minutes(item.minutes)}</span></span></div>
                    ))}
                  </div>
                )}
              </Card>
              <Card className="card-pad">
                <SectionHeader title="Weekly scores in this month" description="Preliminary until the manager finalises each week." />
                {!monthly.self.weekly.length ? <EmptyState compact title="No weekly reports" description="Generate a weekly report to include a score here." /> : (
                  <div className="mt-3 divide-y divide-ink-100">
                    {monthly.self.weekly.map((report) => (
                      <div key={report.weekStart} className="flex items-center justify-between py-2 text-sm"><span>{formatDate(report.weekStart)} – {formatDate(report.weekEnd)}</span><span className="flex items-center gap-2"><span className="font-medium">{report.score}</span><Badge tone={report.status === 'final' ? 'success' : 'info'}>{report.grade} · {titleize(report.status)}</Badge></span></div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionHeader title="Key activities" description="Extracted from tasks, daily reports and work updates." />
                {!monthly.self.keyActivities.length ? <EmptyState compact title="No key activities yet" /> : <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-700">{monthly.self.keyActivities.map((activity, index) => <li key={index}>{activity}</li>)}</ol>}
              </Card>
              <Card className="card-pad">
                <SectionHeader title="Pending assignments" />
                {!monthly.self.pendingTasks.length ? <EmptyState compact title="Nothing pending" /> : <ul className="mt-3 divide-y divide-ink-100 text-sm">{monthly.self.pendingTasks.map((task) => <li key={task.id} className="flex items-center justify-between gap-2 py-2"><span className="min-w-0 truncate">{task.taskNo} · {task.title}</span><span className="shrink-0 text-xs text-ink-500">{formatDate(task.dueDate)} · {titleize(task.priority)}</span></li>)}</ul>}
              </Card>
            </div>

            {monthly.team && (
              <Card>
                <div className="card-pad pb-0"><SectionHeader title={monthly.team.scope === 'all' ? 'Organisation monthly overview' : 'Team monthly overview'} description={`${monthly.team.totals.employees} employees · ${minutes(monthly.team.totals.activeMinutes)} monitored time · ${monthly.team.totals.tasksCompleted} tasks completed · average score ${monthly.team.totals.averageWeeklyScore ?? '—'}`} /></div>
                <div className="mt-3 overflow-x-auto">
                  <table className="table">
                    <thead><tr><th>Employee</th><th>Attendance days</th><th>Active time</th><th>Tasks completed</th><th>Summaries</th><th>Avg score</th></tr></thead>
                    <tbody>
                      {monthly.team.employees.map((row) => (
                        <tr key={row.id}>
                          <td><p className="font-medium text-ink-800">{row.name}</p><p className="text-xs text-ink-500">{row.designation ?? '—'} · {row.department ?? '—'}</p></td>
                          <td>{row.attendanceDays}</td><td>{minutes(row.activeMinutes)}</td><td>{row.tasksCompleted}</td><td>{row.submittedDays}</td><td>{row.averageWeeklyScore ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )
      )}

      {tab === 'team' && (
        loading || !team ? <Skeleton lines={8} /> : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="Team members" value={team.totals.employees ?? 0} />
              <StatCard label="Monitoring now" value={team.totals.activeNow ?? 0} tone="success" />
              <StatCard label="Active minutes today" value={minutes(team.totals.activeMinutes ?? 0)} tone="brand" />
              <StatCard label="Tasks completed" value={team.totals.tasksCompleted ?? 0} tone="neutral" />
              <StatCard label="Summaries to review" value={team.totals.pendingReviews ?? 0} tone="warning" />
            </div>

            {/* Location Filters & Live Search */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-ink-200">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-ink-500 mr-1">Store / Location:</span>
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
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
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
                  className="input py-1 pl-8 text-xs w-full"
                />
              </div>
            </div>

            {/* Live Employee Activity Grid */}
            <div>
              <SectionHeader
                title="Live Employee Activity"
                description="Real-time foreground applications, idle detection, and live session updates."
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
                      <EmptyState compact title="No employees match filter" description="Try selecting 'All Stores' or clearing search." />
                    </Card>
                  );
                }

                return (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((row) => (
                      <Card key={row.id} className="card-pad flex flex-col justify-between hover:shadow-md transition-shadow">
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Avatar name={row.name} src={row.photoUrl} size={36} />
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-ink-900">{row.name}</p>
                                <p className="truncate text-xs text-ink-500">{row.designation ?? 'Team Member'}</p>
                              </div>
                            </div>
                            <span
                              className={cx(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase shrink-0',
                                row.active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500',
                              )}
                            >
                              <span className={cx('h-1.5 w-1.5 rounded-full', row.active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400')} />
                              {row.active ? 'Active' : 'Offline'}
                            </span>
                          </div>

                          <div className="mt-3 rounded-lg bg-ink-50 p-2.5 space-y-1.5 text-xs">
                            <div className="flex items-center justify-between">
                              <span className="text-ink-500">Current App:</span>
                              <span className="font-medium text-brand-700 bg-white px-2 py-0.5 rounded border border-ink-200 truncate max-w-[170px]">
                                {row.currentApp || (row.active ? 'Active Session' : 'None')}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-ink-500">Active Duration:</span>
                              <span className="font-semibold text-ink-800">{minutes(row.activeMinutes)}</span>
                            </div>
                            {row.idleSeconds ? (
                              <div className="flex items-center justify-between">
                                <span className="text-ink-500">Idle Status:</span>
                                <span className="text-amber-700 font-medium">{minutes(Math.floor(row.idleSeconds / 60))} idle</span>
                              </div>
                            ) : null}
                            {row.location && (
                              <div className="flex items-center justify-between pt-1 border-t border-ink-200/60 text-[11px] text-ink-500">
                                <span>Store Location:</span>
                                <span className="font-medium text-ink-700">{row.location}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between pt-2 border-t border-ink-100 text-xs">
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

            <Card>
              <div className="card-pad pb-0">
                <SectionHeader title="Employee Activity Table" description="Comprehensive daily logs and compliance reports." />
              </div>
              {!team.employees?.length ? <EmptyState title="No team members in scope" /> : (
                <div className="overflow-x-auto mt-2">
                  <table className="table">
                    <thead><tr><th>Employee</th><th>Status</th><th>Current App</th><th>Active today</th><th>Tasks done</th><th>Daily summary</th><th>Weekly score</th><th /></tr></thead>
                    <tbody>
                      {team.employees.map((row) => (
                        <tr key={row.id}>
                          <td><div className="flex items-center gap-2"><Avatar name={row.name} src={row.photoUrl} size={28} /><div><p className="font-medium text-ink-800">{row.name}</p><p className="text-xs text-ink-500">{row.designation ?? '—'} · {row.location ?? row.department ?? '—'}</p></div></div></td>
                          <td>{row.active ? <Badge tone="success">Monitoring</Badge> : <Badge tone="neutral">Offline</Badge>}{row.needsAssistance && <Badge tone="warning" className="ml-1">Needs support</Badge>}</td>
                          <td><span className="text-xs font-medium text-ink-700">{row.currentApp || '—'}</span></td>
                          <td>{minutes(row.activeMinutes)}</td>
                          <td>{row.tasksCompleted}</td>
                          <td>{row.dailyStatus ? <Badge tone={row.dailyStatus === 'approved' ? 'success' : row.dailyStatus === 'submitted' ? 'info' : 'neutral'}>{titleize(row.dailyStatus)}</Badge> : <span className="text-xs text-ink-400">—</span>}</td>
                          <td>{row.weeklyScore ?? '—'}{row.weeklyGrade ? <span className="ml-1 text-xs text-ink-500">{row.weeklyGrade}</span> : null}</td>
                          <td><button type="button" className="btn-secondary btn-sm" onClick={() => void openEmployee(row)}>Details</button></td>
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

      {tab === 'admin' && (
        loading || !team ? <Skeleton lines={8} /> : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Registered devices" value={team.totals.devices ?? 0} tone="neutral" />
              <StatCard label="Active sessions" value={team.totals.activeSessions ?? 0} tone="success" />
              <StatCard label="Sessions today" value={team.totals.sessionsToday ?? 0} tone="brand" />
              <StatCard label="Open incidents" value={team.totals.openIncidents ?? 0} tone={Number(team.totals.openIncidents) > 0 ? 'danger' : 'neutral'} />
              <StatCard label="Automatic tickets" value={team.totals.automaticTickets ?? 0} tone="warning" />
              <StatCard label="Pending daily reviews" value={team.totals.pendingDailyReviews ?? 0} tone="warning" />
              <StatCard label="Average weekly score" value={team.totals.averageWeeklyScore ?? '—'} tone="success" />
            </div>

            {/* Live Store Location Filtering */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-ink-200">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-ink-500 mr-1">Store / Location:</span>
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
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
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
                  className="input py-1 pl-8 text-xs w-full"
                />
              </div>
            </div>

            {/* Live Workforce Monitoring Cards */}
            <div>
              <SectionHeader
                title="Live Workforce Monitoring"
                description="Real-time view of store employee application activity across Davanagere, Shivamogga, Belagavi and Head Office."
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
                      <EmptyState compact title="No employees active in selected store" description="No active monitoring sessions recorded for this location filter." />
                    </Card>
                  );
                }

                return (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((row) => (
                      <Card key={row.id} className="card-pad flex flex-col justify-between hover:shadow-md transition-shadow">
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Avatar name={row.name} src={row.photoUrl} size={36} />
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-ink-900">{row.name}</p>
                                <p className="truncate text-xs text-ink-500">{row.designation ?? 'Team Member'}</p>
                              </div>
                            </div>
                            <span
                              className={cx(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase shrink-0',
                                row.active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500',
                              )}
                            >
                              <span className={cx('h-1.5 w-1.5 rounded-full', row.active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400')} />
                              {row.active ? 'Active' : 'Offline'}
                            </span>
                          </div>

                          <div className="mt-3 rounded-lg bg-ink-50 p-2.5 space-y-1.5 text-xs">
                            <div className="flex items-center justify-between">
                              <span className="text-ink-500">Current App:</span>
                              <span className="font-medium text-brand-700 bg-white px-2 py-0.5 rounded border border-ink-200 truncate max-w-[170px]">
                                {row.currentApp || (row.active ? 'Active Session' : 'None')}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-ink-500">Active Duration:</span>
                              <span className="font-semibold text-ink-800">{minutes(row.activeMinutes)}</span>
                            </div>
                            {row.idleSeconds ? (
                              <div className="flex items-center justify-between">
                                <span className="text-ink-500">Idle Status:</span>
                                <span className="text-amber-700 font-medium">{minutes(Math.floor(row.idleSeconds / 60))} idle</span>
                              </div>
                            ) : null}
                            {row.location && (
                              <div className="flex items-center justify-between pt-1 border-t border-ink-200/60 text-[11px] text-ink-500">
                                <span>Store Location:</span>
                                <span className="font-medium text-ink-700">{row.location}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between pt-2 border-t border-ink-100 text-xs">
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
            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad"><SectionHeader title="Department activity today" />{!team.departments?.length ? <EmptyState compact title="No activity recorded" /> : <div className="mt-3 divide-y divide-ink-100">{team.departments.map((row) => <div key={row.department} className="flex items-center justify-between py-2 text-sm"><span>{row.department}</span><span className="text-xs text-ink-500">{row.employees} employees · {minutes(row.minutes)}</span></div>)}</div>}</Card>
              <Card className="card-pad"><SectionHeader title="Top applications" />{!team.applications?.length ? <EmptyState compact title="No application data" /> : <div className="mt-3 divide-y divide-ink-100">{team.applications.map((row) => <div key={row.app} className="flex items-center justify-between py-2 text-sm"><span>{row.app}</span><span className="text-xs text-ink-500">{row.category} · {minutes(row.minutes)}</span></div>)}</div>}</Card>
            </div>
            <Card className="card-pad">
              <SectionHeader title="Technical incidents" description="Recurring errors are grouped; high-severity or repeated incidents raise helpdesk tickets automatically." />
              {!team.incidents?.length ? <EmptyState compact title="No incidents" /> : (
                <div className="mt-3 overflow-x-auto"><table className="table"><thead><tr><th>Incident</th><th>Severity</th><th>Occurrences</th><th>Status</th><th>Ticket</th><th>Last seen</th></tr></thead><tbody>
                  {team.incidents.map((row) => <tr key={row.id}><td>{row.title}</td><td><Badge tone={row.severity === 'critical' ? 'danger' : 'warning'}>{row.severity}</Badge></td><td>{row.occurrences}</td><td>{titleize(row.status)}</td><td>{row.ticketNo ?? '—'}</td><td className="text-xs text-ink-500">{formatDateTime(row.lastSeenAt)}</td></tr>)}
                </tbody></table></div>
              )}
            </Card>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="card-pad"><SectionHeader title="Devices" />{!team.devices?.length ? <EmptyState compact title="No devices registered" /> : <div className="mt-3 divide-y divide-ink-100">{team.devices.map((device) =>                 <div key={device.id} className="flex items-center justify-between py-2 text-sm"><span>{device.full_name ?? 'Employee'} · {device.device_name}</span><span className="text-xs text-ink-500">{device.status} · {formatDateTime(device.last_seen_at)}</span></div>)}</div>}</Card>
              <Card className="card-pad"><SectionHeader title="Active sessions" />{!team.activeSessions?.length ? <EmptyState compact title="No active monitoring sessions" /> : <div className="mt-3 divide-y divide-ink-100">{team.activeSessions.map((session) => <div key={session.id} className="flex items-center justify-between py-2 text-sm"><span>{session.full_name} · {session.device_name}</span><span className="text-xs text-ink-500">since {formatDateTime(session.started_at)}</span></div>)}</div>}</Card>
            </div>
          </div>
        )
      )}

      {tab === 'devices' && canTeam && <LiveDevicesPanel />}

      {tab === 'policy' && (
        loading || !self ? <Skeleton lines={6} /> : (
          <Card className="card-pad space-y-4">
            <SectionHeader title={self.policy.name} description={`Version ${self.policy.version} · effective ${formatDate((self.policy as unknown as { effectiveAt: string }).effectiveAt)}`} action={<Badge tone={self.consent.acknowledged ? 'success' : 'warning'}>{self.consent.acknowledged ? 'Acknowledged' : 'Not acknowledged'}</Badge>} />
            <p className="text-sm leading-relaxed text-ink-700">{self.policy.policyText}</p>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-ink-50 p-3"><p className="text-xs text-ink-500">Screenshots</p><p className="font-medium text-ink-800">{self.policy.screenshotEnabled ? `Every ${self.policy.screenshotIntervalMinutes} min` : 'Disabled'}</p></div>
              <div className="rounded-lg bg-ink-50 p-3"><p className="text-xs text-ink-500">Retention</p><p className="font-medium text-ink-800">{self.policy.retentionDays} days</p></div>
              <div className="rounded-lg bg-ink-50 p-3"><p className="text-xs text-ink-500">Device location</p><p className="font-medium text-ink-800">{self.policy.locationTrackingEnabled ? `Every ${self.policy.locationIntervalMinutes ?? 15} min, work sessions only` : 'Not collected'}</p></div>
              <div className="rounded-lg bg-ink-50 p-3"><p className="text-xs text-ink-500">Monitoring window</p><p className="font-medium text-ink-800">Authorised sessions only</p></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><p className="label">Approved applications</p><div className="flex flex-wrap gap-1.5">{self.policy.allowedApps.map((app) => <Badge key={app} tone="neutral">{app}</Badge>)}</div></div>
              <div><p className="label">Approved domains</p><div className="flex flex-wrap gap-1.5">{self.policy.allowedDomains.map((domain) => <Badge key={domain} tone="info">{domain}</Badge>)}</div></div>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
              <button type="button" className="btn-secondary btn-sm" onClick={() => setPolicyOpen(true)}>Full policy text</button>
              {!self.consent.acknowledged && <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void acknowledge()}>Acknowledge policy</button>}
              {self.consent.acknowledged && (
                <button type="button" className="btn-ghost btn-sm text-red-600" disabled={busy} onClick={async () => {
                  if (!window.confirm('Withdraw monitoring consent? Any active session ends and the agent cannot start again until you acknowledge a policy.')) return;
                  setBusy(true);
                  try { await api.post('/activity/consent/revoke'); toast.success('Consent withdrawn. Monitoring stopped.'); await load(); }
                  catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
                }}>Withdraw consent</button>
              )}
            </div>

            {canPolicy && (
              <div className="space-y-3 rounded-lg border border-ink-200 p-3">
                <SectionHeader title="Policy configuration" description="Changes apply to new sessions and are written to the monitoring audit log." />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Retention (days)"><input type="number" min={1} max={3650} className="input" value={policyForm.retentionDays} onChange={(event) => setPolicyForm({ ...policyForm, retentionDays: Number(event.target.value) })} /></Field>
                  <Field label="Screenshot evidence">
                    <label className="flex items-center gap-2 pt-2 text-sm text-ink-700">
                      <input type="checkbox" checked={policyForm.screenshotEnabled} onChange={(event) => setPolicyForm({ ...policyForm, screenshotEnabled: event.target.checked })} />
                      Allow screenshot evidence on supported agents (this build stores no screenshots)
                    </label>
                  </Field>
                  <Field label="Device location" hint="Turning this on creates a new policy version: every employee must acknowledge it again before any location is recorded.">
                    <label className="flex items-center gap-2 pt-2 text-sm text-ink-700">
                      <input type="checkbox" checked={policyForm.locationTrackingEnabled} onChange={(event) => setPolicyForm({ ...policyForm, locationTrackingEnabled: event.target.checked })} />
                      Record device location (Windows Location API) during work sessions
                    </label>
                  </Field>
                  <Field label="Location interval (minutes)">
                    <input type="number" min={5} max={240} className="input" disabled={!policyForm.locationTrackingEnabled} value={policyForm.locationIntervalMinutes} onChange={(event) => setPolicyForm({ ...policyForm, locationIntervalMinutes: Number(event.target.value) })} />
                  </Field>
                </div>
                <Field label="Approved work domains" hint="Comma-separated. Only these domains are stored by the browser bridge.">
                  <textarea className="input min-h-[70px]" value={policyForm.allowedDomains} onChange={(event) => setPolicyForm({ ...policyForm, allowedDomains: event.target.value })} />
                </Field>
                <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    await api.put('/activity/policy', {
                      retentionDays: policyForm.retentionDays,
                      screenshotEnabled: policyForm.screenshotEnabled,
                      locationTrackingEnabled: policyForm.locationTrackingEnabled,
                      locationIntervalMinutes: policyForm.locationIntervalMinutes,
                      allowedDomains: policyForm.allowedDomains.split(',').map((value) => value.trim()).filter(Boolean),
                    });
                    toast.success('Monitoring policy updated.');
                    await load();
                  } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
                }}>Save policy</button>
                <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    const preview = await api.post<{ removed: number; retentionDays: number }>('/activity/retention/purge', { dryRun: true });
                    if (!window.confirm(`Retention cleanup will delete ${preview.removed} monitoring record(s) older than ${preview.retentionDays} days. Tickets, tasks and attendance are kept. Continue?`)) return;
                    const result = await api.post<{ removed: number }>('/activity/retention/purge', { dryRun: false });
                    toast.success(`${result.removed} monitoring record(s) removed.`);
                  } catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
                }}>Run retention cleanup</button>
              </div>
            )}
          </Card>
        )
      )}

      <Modal open={policyOpen} onClose={() => setPolicyOpen(false)} title={self?.policy.name ?? 'Monitoring policy'} size="lg">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{self?.policy.policyText}</p>
        <div className="mt-4 rounded-lg bg-ink-50 p-3 text-xs text-ink-600">
          Collected: foreground application name and duration, approved work domains, internal module usage, task/report/ticket metadata and sanitized technical errors.
          Never collected: passwords, OTPs, keystrokes, clipboard contents, private messages, personal accounts or excluded applications.
        </div>
      </Modal>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.name ?? 'Employee activity'} description={detail ? `Activity for ${formatDate(date)}` : undefined} size="lg">
        {detail && (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-ink-50 p-2"><p className="text-xs text-ink-500">Active time</p><p className="font-semibold">{minutes(detail.daily.activeMinutes)}</p></div>
              <div className="rounded-lg bg-ink-50 p-2"><p className="text-xs text-ink-500">Tasks completed</p><p className="font-semibold">{detail.daily.taskSummary?.completed ?? 0}</p></div>
              <div className="rounded-lg bg-ink-50 p-2"><p className="text-xs text-ink-500">Attendance</p><p className="font-semibold">{minutes(detail.daily.attendanceMinutes)}</p></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <ListBlock title="Applications" items={(detail.daily.appBreakdown ?? []).map((item) => `${item.app} · ${minutes(item.minutes)}`)} empty="No application data" />
              <ListBlock title="Modules" items={(detail.daily.moduleBreakdown ?? []).map((item) => `${item.module} · ${minutes(Math.round(item.seconds / 60))}`)} empty="No module data" />
            </div>
            <ListBlock title="Key activities" items={detail.daily.keyActivities ?? []} empty="No key activities" />
            {canReview && detail.daily.status === 'submitted' && (
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={async () => {
                  const note = window.prompt('Reason for returning this summary:') ?? undefined;
                  if (note === undefined) return;
                  setBusy(true);
                  try { await api.post(`/activity/daily/${detail.daily.id}/review`, { decision: 'returned', note }); toast.success('Summary returned.'); setDetail(null); await load(); }
                  catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
                }}>Return</button>
                <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try { await api.post(`/activity/daily/${detail.daily.id}/review`, { decision: 'approved' }); toast.success('Daily summary approved.'); setDetail(null); await load(); }
                  catch (caught) { toast.error(errorMessage(caught)); } finally { setBusy(false); }
                }}>Approve summary</button>
              </div>
            )}
            <div>
              <p className="label">Recent weekly scores</p>
              {!detail.weekly.length ? <p className="text-sm text-ink-500">No weekly reports yet.</p> : (
                <ul className="space-y-1 text-sm">{detail.weekly.map((week) => <li key={week.id} className="flex justify-between"><span>{formatDate(week.weekStart)} – {formatDate(week.weekEnd)}</span><span>{week.score} · {week.grade} · {titleize(week.status)}</span></li>)}</ul>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ListBlock({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="label">{title}</p>
      {items.length === 0 ? <p className="text-sm text-ink-500">{empty}</p> : <ul className="space-y-1 text-sm text-ink-700">{items.slice(0, 12).map((item, index) => <li key={index}>{item}</li>)}</ul>}
    </div>
  );
}
