import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Avatar, Badge, Card, EmptyState, KeyValue, Modal, ProgressBar, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { cx } from '../lib/format';
import { ExportDialog, StatusPill } from '../components/tracking/common';
import { ago, duration, istDateLabel, istDateTime, istTime, istToday, shiftIsoDate, type DetailsResponse } from '../lib/tracking';

const TIMELINE_STYLE: Record<string, { dot: string; icon: string }> = {
  session_start: { dot: 'bg-emerald-500', icon: 'logOut' }, session_end: { dot: 'bg-ink-400', icon: 'logout' },
  hrms_login: { dot: 'bg-brand-600', icon: 'userCheck' }, hrms_logout: { dot: 'bg-ink-400', icon: 'logout' },
  lock: { dot: 'bg-slate-500', icon: 'lock' }, unlock: { dot: 'bg-slate-400', icon: 'unlock' },
  idle_start: { dot: 'bg-amber-500', icon: 'pause' }, idle_end: { dot: 'bg-emerald-500', icon: 'play' },
  suspend: { dot: 'bg-ink-400', icon: 'moreVertical' }, resume: { dot: 'bg-ink-400', icon: 'refresh' },
  device_offline: { dot: 'bg-red-500', icon: 'wifiOff' }, device_online: { dot: 'bg-emerald-500', icon: 'wifi' },
  agent_start: { dot: 'bg-brand-500', icon: 'shield' }, agent_stop: { dot: 'bg-red-400', icon: 'shield' },
  tracking_disabled: { dot: 'bg-ink-400', icon: 'eyeOff' }, tracking_enabled: { dot: 'bg-brand-500', icon: 'eye' },
  app: { dot: 'bg-sky-500', icon: 'monitor' }, hrms_page: { dot: 'bg-brand-400', icon: 'dashboard' },
};

export default function TrackingEmployeeDetails() {
  const { id } = useParams();
  const employeeId = Number(id);
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || istToday();
  const { user, canAny, has } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<DetailsResponse | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'events' | 'apps'>('all');
  const requestId = useRef(0);
  const isToday = date === istToday();
  const canSeeOthers = canAny('activity.view.all', 'activity.view.team');
  useDocumentTitle(`${data?.employee.fullName ?? 'Employee'} · Activity Tracking`);

  const load = useCallback(async (silent = false) => {
    const rid = ++requestId.current;
    if (!silent) setLoading(true);
    try {
      const result = await api.get<DetailsResponse>(`/tracking/employees/${employeeId}?date=${date}`);
      if (rid !== requestId.current) return;
      setData(result);
      setError(null);
    } catch (e) {
      if (rid === requestId.current) setError({ status: (e as { status?: number }).status, message: errorMessage(e) });
    } finally {
      if (rid === requestId.current) setLoading(false);
    }
  }, [employeeId, date]);

  useEffect(() => { void load(); }, [load]);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useSocketEvent('tracking:update', (payload) => {
    if (!isToday || (payload as { employeeId?: number })?.employeeId !== employeeId) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(true), 1500);
  });
  useEffect(() => {
    if (!isToday) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, 60_000);
    return () => { clearInterval(timer); clearTimeout(debounce.current); };
  }, [isToday, load]);

  const setDate = (value: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (value) n.set('date', value); else n.delete('date'); return n; }, { replace: true });

  const revoke = async () => {
    if (!revoking) return;
    try {
      await api.post(`/tracking/devices/${revoking}/revoke`, {});
      toast.success('Device revoked. It can no longer send tracking data.');
      setRevoking(null);
      await load(true);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  if (!Number.isInteger(employeeId) || employeeId <= 0) return <EmptyState title="Employee not found" />;
  if (error && !data) {
    return (
      <Card className="mx-auto mt-6 max-w-xl card-pad text-center">
        <p className="font-medium text-ink-900">{error.status === 403 ? 'You do not have access to this employee’s activity.' : 'Activity details could not be loaded.'}</p>
        <p className="mt-1 text-sm text-ink-500">{error.message}</p>
        <div className="mt-4 flex justify-center gap-2">
          {error.status !== 403 && <button type="button" className="btn-secondary" onClick={() => void load()}>Try again</button>}
          {canSeeOthers && <Link to="/activity-tracking" className="btn-ghost">Back to list</Link>}
        </div>
      </Card>
    );
  }
  if (!data) return <div className="mx-auto max-w-[1400px] space-y-4"><Skeleton lines={3} /><Card className="card-pad"><Skeleton lines={10} /></Card></div>;

  const { employee, tracking, summary } = data;
  const activeDevices = data.devices.filter((d) => d.registrationStatus === 'active');
  const primary = activeDevices.find((d) => d.online) ?? activeDevices[0];
  const totalApp = data.applications.reduce((a, x) => a + x.activeSeconds, 0) || 1;
  const totalWeb = data.websites.reduce((a, x) => a + x.activeSeconds, 0) || 1;
  const timeline = data.timeline.filter((t) => timelineFilter === 'all' || (timelineFilter === 'apps' ? t.type === 'app' || t.type === 'hrms_page' : t.type !== 'app' && t.type !== 'hrms_page'));
  const extensionSeen = data.devices.some((d) => d.extensionSeenAt);

  return (
    <div className={cx('mx-auto max-w-[1400px] space-y-5', loading && 'opacity-80')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {canSeeOthers && <Link to={`/activity-tracking?date=${date}`} className="btn-ghost btn-sm" aria-label="Back"><Icon name="chevronLeft" size={18} /></Link>}
          <Avatar name={employee.fullName} src={employee.photoUrl} size={48} />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-ink-900 sm:text-2xl">{employee.fullName}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-500">
              <span className="font-mono">{employee.employeeCode}</span><span>·</span><span>{employee.locationCode ?? '—'}</span>
              <StatusPill status={tracking.status} syncError={activeDevices.map((d) => d.syncError).find(Boolean)} />
              {isToday && tracking.currentApp && <span className="truncate">Now: {tracking.currentApp}{tracking.currentDomain ? ` · ${tracking.currentDomain}` : ''}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className="btn-secondary btn-sm" aria-label="Previous day" onClick={() => setDate(shiftIsoDate(date, -1))}><Icon name="chevronLeft" size={16} /></button>
          <input type="date" className="input h-9 w-40" value={date} max={istToday()} onChange={(e) => setDate(e.target.value || null)} aria-label="Date" />
          <button type="button" className="btn-secondary btn-sm" aria-label="Next day" disabled={isToday} onClick={() => setDate(shiftIsoDate(date, 1))}><Icon name="chevronRight" size={16} /></button>
          <button type="button" className="btn-primary ml-1" onClick={() => setExportOpen(true)}><Icon name="download" size={16} /> Report</button>
        </div>
      </div>

      {!tracking.enabled && <Banner tone="warn">Tracking is disabled by policy for this employee’s location. No new activity is collected.</Banner>}
      {tracking.status === 'not_installed' && <Banner tone="info">No tracking device is registered for this employee, so no device activity is available. {has('activity.devices.manage') && <Link className="font-medium underline" to="/activity-tracking?tab=devices">Register a device</Link>}</Banner>}
      {activeDevices.some((d) => !d.noticeAcknowledgedAt) && <Banner tone="info">A registered device is waiting for the employee to acknowledge the monitoring notice. Nothing is collected on it until they do.</Banner>}

      {/* A. Employee information */}
      <Section title="Employee information" letter="A">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KeyValue label="Employee name" value={employee.fullName} />
          <KeyValue label="Employee code" value={employee.employeeCode} />
          <KeyValue label="Designation" value={employee.designation ?? '—'} />
          <KeyValue label="Department" value={employee.department ?? '—'} />
          <KeyValue label="Assigned location" value={employee.locationName ? `${employee.locationName} (${employee.locationCode})` : '—'} />
          <KeyValue label="Registered devices" value={activeDevices.length ? activeDevices.map((d) => d.deviceName).join(', ') : 'None'} />
          <KeyValue label="Tracking agent version" value={primary?.agentVersion ? <>{primary.agentVersion}{primary.outdated && <Badge tone="warning" className="ml-2">Outdated</Badge>}</> : '—'} />
          <KeyValue label="Current connection" value={primary ? (primary.online ? <span className="text-emerald-700">Connected · {ago(primary.lastHeartbeatAt)}</span> : <span className="text-red-600">Disconnected{primary.lastHeartbeatAt ? ` · last seen ${ago(primary.lastHeartbeatAt)}` : ''}</span>) : '—'} />
        </dl>
      </Section>

      {/* B. Daily summary */}
      <Section title={`Daily activity summary — ${istDateLabel(date)}`} letter="B"
        aside={<span className="text-xs text-ink-500">Idle after {duration(summary.idleThresholdSeconds)} without input</span>}>
        {!summary.hasData ? (
          <EmptyState compact title="No tracking data recorded for this day" description={tracking.status === 'not_installed' ? 'The agent is not installed for this employee.' : 'The computer may have been off, or the agent was not running or not yet synchronised.'} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="First login" value={istTime(summary.firstLoginAt)} />
              <Stat label="Last logout" value={summary.stillSignedIn ? 'Signed in' : istTime(summary.lastLogoutAt)} hint={summary.stillSignedIn ? 'Session still open' : undefined} />
              <Stat label="Total session" value={duration(summary.sessionSeconds)} hint={`${summary.sessionCount} session${summary.sessionCount === 1 ? '' : 's'}`} />
              <Stat label="Observed active" value={duration(summary.activeSeconds)} tone="success" />
              <Stat label="Observed idle" value={duration(summary.idleSeconds)} tone="warning" />
              <Stat label="Locked" value={duration(summary.lockedSeconds)} />
              <Stat label="Longest active run" value={summary.longestActive ? duration(summary.longestActive.seconds) : '—'} hint={summary.longestActive ? `${istTime(summary.longestActive.start)}–${istTime(summary.longestActive.end)}` : undefined} />
              <Stat label="Longest idle run" value={summary.longestIdle ? duration(summary.longestIdle.seconds) : '—'} hint={summary.longestIdle ? `${istTime(summary.longestIdle.start)}–${istTime(summary.longestIdle.end)}` : undefined} />
              <Stat label="Untracked / offline" value={duration(summary.offlineSeconds)} hint="Within the observed span" tone={summary.offlineSeconds > 0 ? 'danger' : undefined} />
              <Stat label="Observed span" value={duration(summary.observedSpanSeconds)} hint="First to last recorded activity" />
            </div>
            <div className="mt-4 max-w-xl">
              <ProgressBar value={summary.completenessPercent ?? 0} tone={(summary.completenessPercent ?? 0) >= 90 ? 'success' : (summary.completenessPercent ?? 0) >= 70 ? 'warning' : 'danger'} label="Tracking data completeness" />
              <p className="mt-1 text-xs text-ink-500">Share of the observed span covered by recorded active, idle or locked time. Gaps are listed under “Missing data”.</p>
            </div>
          </>
        )}
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* C. Application usage */}
        <Section title="Application usage" letter="C" flush>
          {!tracking.appTracking && <p className="px-4 pt-3 text-sm text-amber-700">Application tracking is disabled by policy.</p>}
          {data.applications.length === 0 ? <EmptyState compact title="No application activity recorded" /> : (
            <TableWrap>
              <thead><tr><th>Application</th><th>First used</th><th>Last used</th><th className="text-right">Active</th><th className="text-right">Idle in app</th></tr></thead>
              <tbody>
                {data.applications.map((a) => (
                  <tr key={a.app}>
                    <td>
                      <div className="font-medium text-ink-900">
                        {a.app}
                        {a.process && a.process.toLowerCase() !== a.app.toLowerCase() ? (
                          <span className="ml-1.5 text-xs font-mono font-normal text-ink-400">({a.process}.exe)</span>
                        ) : null}
                      </div>
                      <div className="mt-1 h-1.5 w-full max-w-[220px] rounded-full bg-ink-100"><div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.max(2, (a.activeSeconds / totalApp) * 100)}%` }} /></div>
                    </td>
                    <td>{istTime(a.firstUsedAt)}</td><td>{istTime(a.lastUsedAt)}</td>
                    <td className="text-right font-medium tabular-nums">{duration(a.activeSeconds)}</td><td className="text-right tabular-nums text-ink-500">{duration(a.idleSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>

        {/* D. Website usage */}
        <Section title="Website usage" letter="D" flush>
          {!tracking.websiteTracking ? <p className="px-4 pt-3 text-sm text-amber-700">Website tracking is disabled by policy.</p>
            : !extensionSeen && <p className="px-4 pt-3 text-xs text-ink-500">The browser connector has not been detected on this employee’s computer, so website domains are unavailable (browser time still appears under applications).</p>}
          {data.websites.length === 0 ? <EmptyState compact title="No website activity recorded" description="Only the domain of the active tab is recorded — never page contents, full addresses or form data." /> : (
            <TableWrap>
              <thead><tr><th>Domain</th><th>Browser</th><th>First visited</th><th>Last visited</th><th className="text-right">Active</th><th className="text-right">Visits</th></tr></thead>
              <tbody>
                {data.websites.map((w) => (
                  <tr key={`${w.browser}|${w.domain}`}>
                    <td><div className="font-medium text-ink-900">{w.domain}</div><div className="mt-1 h-1.5 w-full max-w-[200px] rounded-full bg-ink-100"><div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.max(2, (w.activeSeconds / totalWeb) * 100)}%` }} /></div></td>
                    <td>{w.browser}</td><td>{istTime(w.firstVisitedAt)}</td><td>{istTime(w.lastVisitedAt)}</td>
                    <td className="text-right font-medium tabular-nums">{duration(w.activeSeconds)}</td><td className="text-right tabular-nums">{w.visits}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* E. Timeline */}
        <Section title="Activity timeline" letter="E" flush
          aside={(
            <div className="flex gap-1 text-xs">
              {(['all', 'events', 'apps'] as const).map((f) => (
                <button key={f} type="button" onClick={() => setTimelineFilter(f)} className={cx('rounded-full px-2.5 py-1', timelineFilter === f ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200')}>
                  {f === 'all' ? 'All' : f === 'events' ? 'Events' : 'Applications'}
                </button>
              ))}
            </div>
          )}>
          {timeline.length === 0 ? <EmptyState compact title="No events recorded" /> : (
            <ol className="relative max-h-[560px] overflow-y-auto px-4 py-3">
              {timeline.map((t, i) => {
                const style = TIMELINE_STYLE[t.type] ?? { dot: 'bg-ink-400', icon: 'info' };
                return (
                  <li key={`${t.at}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
                    <div className="w-[78px] shrink-0 pt-0.5 text-right font-mono text-xs text-ink-500">{istTime(t.at)}</div>
                    <div className="relative flex flex-col items-center">
                      <span className={cx('mt-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white', style.dot)} />
                      {i < timeline.length - 1 && <span className="absolute top-4 h-full w-px bg-ink-200" />}
                    </div>
                    <div className="min-w-0 pb-1">
                      <div className="text-sm text-ink-900">{t.title}{t.seconds ? <span className="text-ink-500"> · {duration(t.seconds)}</span> : null}</div>
                      {t.detail && <div className="truncate text-xs text-ink-500">{t.detail}</div>}
                    </div>
                  </li>
                );
              })}
              {data.timelineTruncated && <li className="pt-2 text-center text-xs text-ink-500">Showing the first 2,000 entries. Download the report for the complete record.</li>}
            </ol>
          )}
        </Section>

        <div className="space-y-5">
          <Section title="Sessions" flush>
            {data.sessions.length === 0 ? <EmptyState compact title="No tracking sessions" /> : (
              <TableWrap>
                <thead><tr><th>Started</th><th>Ended</th><th className="text-right">Duration</th><th>Device</th></tr></thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr key={s.id}><td>{istTime(s.startedAt)}</td><td>{s.open ? <Badge tone="success">Open</Badge> : <span title={s.endReason ?? ''}>{istTime(s.endedAt)}<span className="block text-xs text-ink-500">{(s.endReason ?? '').replace(/_/g, ' ')}</span></span>}</td><td className="text-right tabular-nums">{duration(s.seconds)}</td><td className="text-xs">{s.device}</td></tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Section>
          <Section title="Missing data / offline periods" flush>
            {data.gaps.length === 0 ? <EmptyState compact title={summary.hasData ? 'No gaps longer than 2 minutes' : 'No data recorded'} /> : (
              <TableWrap>
                <thead><tr><th>From</th><th>To</th><th className="text-right">Duration</th><th>Likely reason</th></tr></thead>
                <tbody>{data.gaps.map((g) => <tr key={g.start}><td>{istTime(g.start)}</td><td>{istTime(g.end)}</td><td className="text-right tabular-nums">{duration(g.seconds)}</td><td className="text-xs">{g.reason}</td></tr>)}</tbody>
              </TableWrap>
            )}
          </Section>
        </div>
      </div>

      {/* F. Device information */}
      <Section title="Device information" letter="F">
        {data.devices.length === 0 ? <EmptyState compact title="No tracking device registered" /> : (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.devices.map((d) => (
              <div key={d.deviceId} className={cx('rounded-xl border p-4', d.registrationStatus === 'active' ? 'border-ink-200' : 'border-dashed border-ink-200 opacity-70')}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-ink-900">{d.deviceName}</div>
                    <div className="text-xs text-ink-500">{[d.osName, d.osVersion].filter(Boolean).join(' ')} · device #{d.deviceId}</div>
                  </div>
                  {d.registrationStatus !== 'active' ? <Badge>Revoked</Badge> : d.online ? <Badge tone="success">Connected</Badge> : <Badge tone="danger">Disconnected</Badge>}
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <KeyValue label="Registration" value={d.registrationStatus === 'active' ? `Active since ${istDateTime(d.enrolledAt ?? d.registeredAt)}` : `Revoked ${istDateTime(d.revokedAt)}`} />
                  <KeyValue label="Agent version" value={<>{d.agentVersion ?? '—'}{d.outdated && <Badge tone="warning" className="ml-2">Outdated</Badge>}</>} />
                  <KeyValue label="Last heartbeat" value={d.lastHeartbeatAt ? `${istDateTime(d.lastHeartbeatAt)} (${ago(d.lastHeartbeatAt)})` : 'Never'} />
                  <KeyValue label="Last synchronisation" value={d.lastSyncAt ? `${istDateTime(d.lastSyncAt)} (${ago(d.lastSyncAt)})` : 'Never'} />
                  <KeyValue label="Pending events" value={<span className={d.pendingEvents > 0 ? 'text-amber-700' : undefined}>{d.pendingEvents}{d.droppedEvents > 0 ? ` (${d.droppedEvents} discarded)` : ''}</span>} />
                  <KeyValue label="Connection failures" value={d.connectionFailures} />
                  <KeyValue label="Monitoring notice" value={d.noticeAcknowledgedAt ? `Acknowledged ${istDateTime(d.noticeAcknowledgedAt)}` : <span className="text-amber-700">Not acknowledged</span>} />
                  <KeyValue label="Browser connector" value={d.extensionSeenAt ? `Seen ${ago(d.extensionSeenAt)}` : 'Not detected'} />
                </dl>
                {(d.syncError || d.lastSyncError) && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{d.syncError ?? `Last error: ${d.lastSyncError}`}</p>}
                {Math.abs(d.clockSkewMs) > 120_000 && <p className="mt-2 text-xs text-ink-500">Device clock differs from the server by {Math.round(Math.abs(d.clockSkewMs) / 60000)} min; timestamps are corrected automatically.</p>}
                {has('activity.devices.manage') && d.registrationStatus === 'active' && user?.id !== employee.id && (
                  <div className="mt-3 text-right"><button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => setRevoking(d.deviceId)}>Revoke device</button></div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} employeeId={employee.id} employeeName={employee.fullName} defaultDate={date} />
      <Modal open={revoking !== null} onClose={() => setRevoking(null)} title="Revoke tracking device?"
        footer={<><button type="button" className="btn-secondary" onClick={() => setRevoking(null)}>Cancel</button><button type="button" className="btn-danger" onClick={revoke}>Revoke device</button></>}>
        <p className="text-sm text-ink-600">The agent on this computer stops tracking immediately. Recorded history is kept.</p>
      </Modal>
    </div>
  );
}

function Section({ title, letter, aside, children, flush }: { title: string; letter?: string; aside?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
          {letter && <span className="flex h-5 w-5 items-center justify-center rounded bg-brand-50 text-[11px] font-bold text-brand-700">{letter}</span>}
          {title}
        </h2>
        {aside}
      </div>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </Card>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'success' | 'warning' | 'danger' }) {
  const tones = { success: 'text-emerald-700', warning: 'text-amber-700', danger: 'text-red-600' };
  return (
    <div className="rounded-xl border border-ink-100 bg-ink-50/50 px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{label}</div>
      <div className={cx('mt-0.5 text-lg font-semibold tabular-nums text-ink-900', tone && tones[tone])}>{value}</div>
      {hint && <div className="text-[11px] text-ink-500">{hint}</div>}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  return <div className={cx('rounded-xl border px-4 py-3 text-sm', tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800')}>{children}</div>;
}

function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm [&_td:not(:first-child)]:whitespace-nowrap [&_td]:px-4 [&_td]:py-2.5 [&_th]:px-4 [&_th]:py-2 [&_th:not(.text-right)]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-ink-500 [&_thead]:bg-ink-50 [&_tbody_tr]:border-t [&_tbody_tr]:border-ink-100">
        {children}
      </table>
    </div>
  );
}
