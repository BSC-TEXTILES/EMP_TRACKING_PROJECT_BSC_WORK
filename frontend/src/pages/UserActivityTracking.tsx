import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useDebounced, useDocumentTitle } from '../lib/hooks';
import { Avatar, Badge, Card, EmptyState, PageHeader, Pagination, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx } from '../lib/format';
import { ExportDialog, StatusPill } from '../components/tracking/common';
import { TrackingDevices } from '../components/tracking/TrackingDevices';
import { TrackingSettings } from '../components/tracking/TrackingSettings';
import { ago, duration, istDateLabel, istDateTime, istTime, istTimeSeconds, istToday, shiftIsoDate, type OverviewItem, type OverviewResponse } from '../lib/tracking';

type Tab = 'employees' | 'devices' | 'alerts' | 'settings';
type SortKey = 'status' | 'code' | 'name' | 'location' | 'device' | 'login' | 'active' | 'idle' | 'lastActivity';
interface Alert { kind: string; severity: 'critical' | 'warning' | 'info'; employeeId: number; employeeName: string; employeeCode: string; locationCode: string | null; message: string; since?: string | null }

const STATUS_CHIPS: { key: keyof OverviewResponse['counts']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'idle', label: 'Idle' },
  { key: 'locked', label: 'Locked' },
  { key: 'offline', label: 'Offline' },
  { key: 'not_installed', label: 'Agent not installed' },
  { key: 'sync_error', label: 'Sync errors' },
  { key: 'disabled', label: 'Tracking disabled' },
];

export default function UserActivityTracking() {
  useDocumentTitle('User Activity Tracking · BSC Textiles HRMS');
  const { canAny, has } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'employees';
  const date = params.get('date') || istToday();
  const location = params.get('location') || 'all';
  const status = params.get('status') || 'all';
  const sort = (params.get('sort') as SortKey) || 'status';
  const order = params.get('order') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const debouncedSearch = useDebounced(search, 300);

  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const requestId = useRef(0);

  const canSettings = canAny('activity.policy.manage', 'activity.view.all');
  const canManageDevices = has('activity.devices.manage');
  const isToday = date === istToday();

  const update = useCallback((patch: Record<string, string | null>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
      if (!('page' in patch)) next.delete('page');
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => { if ((params.get('q') ?? '') !== debouncedSearch) update({ q: debouncedSearch || null }); }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (silent = false) => {
    const id = ++requestId.current;
    if (!silent) setLoading(true);
    try {
      const q = new URLSearchParams({ date, location, status, sort, order, page: String(page), pageSize: '25' });
      if (debouncedSearch.trim()) q.set('search', debouncedSearch.trim());
      const result = await api.get<OverviewResponse>(`/tracking/overview?${q.toString()}`);
      if (id !== requestId.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      if (id === requestId.current) setError(errorMessage(e));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [date, location, status, sort, order, page, debouncedSearch]);

  const loadAlerts = useCallback(async () => {
    try { setAlerts((await api.get<{ alerts: Alert[] }>('/tracking/alerts')).alerts); } catch { setAlerts([]); }
  }, []);

  useEffect(() => { if (tab === 'employees') void load(); }, [load, tab]);
  useEffect(() => { void loadAlerts(); }, [loadAlerts]);

  // Live refresh: realtime pushes from the server, plus a polling fallback.
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = setTimeout(() => { void load(true); void loadAlerts(); }, 1500);
  }, [load, loadAlerts]);
  useSocketEvent('tracking:update', () => { if (tab === 'employees' && isToday) scheduleRefresh(); });
  useSocketEvent('tracking:alert', () => { void loadAlerts(); });
  useEffect(() => {
    if (tab !== 'employees' || !isToday) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, 30_000);
    return () => clearInterval(timer);
  }, [tab, isToday, load]);
  useEffect(() => () => clearTimeout(pending.current), []);

  const toggleSort = (key: SortKey) => {
    if (sort === key) update({ order: order === 'asc' ? 'desc' : 'asc' });
    else update({ sort: key, order: ['active', 'idle', 'lastActivity', 'login'].includes(key) ? 'desc' : 'asc' });
  };

  const tabs = useMemo(() => [
    { value: 'employees', label: 'Employees', count: data?.counts.all },
    { value: 'devices', label: 'Devices & enrollment' },
    { value: 'alerts', label: 'Alerts', count: alerts?.filter((a) => a.severity !== 'info').length },
    ...(canSettings ? [{ value: 'settings', label: 'Settings' }] : []),
  ], [data, alerts, canSettings]);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="User Activity Tracking"
        description="Activity observed by registered BSC Activity Tracker agents. All times are IST."
        actions={(
          <>
            {tab === 'employees' && (
              <div className="flex items-center gap-1">
                <button type="button" className="btn-secondary btn-sm" aria-label="Previous day" onClick={() => update({ date: shiftIsoDate(date, -1) })}><Icon name="chevronLeft" size={16} /></button>
                <input type="date" className="input h-9 w-40" value={date} max={istToday()} onChange={(e) => update({ date: e.target.value || null })} aria-label="Date" />
                <button type="button" className="btn-secondary btn-sm" aria-label="Next day" disabled={isToday} onClick={() => update({ date: shiftIsoDate(date, 1) })}><Icon name="chevronRight" size={16} /></button>
                {!isToday && <button type="button" className="btn-ghost btn-sm" onClick={() => update({ date: null })}>Today</button>}
              </div>
            )}
            <button type="button" className="btn-primary" onClick={() => setExportOpen(true)}><Icon name="download" size={16} /> Reports</button>
          </>
        )}
      />

      <Tabs tabs={tabs} value={tab} onChange={(value) => update({ tab: value === 'employees' ? null : value })} className="mb-5" />

      {tab === 'employees' && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Chip active={location === 'all'} onClick={() => update({ location: null })} label="All locations" count={data?.locations.reduce((a, l) => a + l.count, 0)} />
            {data?.locations.map((l) => (
              <Chip key={l.code} active={location.toUpperCase() === l.code} onClick={() => update({ location: l.code })} label={l.code} title={l.name} count={l.count} />
            ))}
          </div>

          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3">
              {STATUS_CHIPS.filter((c) => c.key !== 'disabled' || (data?.counts.disabled ?? 0) > 0).map((c) => (
                <Chip key={c.key} small active={status === c.key} onClick={() => update({ status: c.key === 'all' ? null : c.key })} label={c.label} count={data?.counts[c.key]}
                  tone={c.key === 'offline' || c.key === 'sync_error' ? 'warn' : undefined} />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="relative w-full max-w-sm">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"><Icon name="search" size={16} /></span>
                <input className="input pl-9" placeholder="Search name, employee ID or device" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search employees" />
              </div>
              <div className="flex items-center gap-3 text-xs text-ink-500">
                {data && <span>Active today: <strong className="text-ink-800">{duration(data.totals.activeSeconds)}</strong> · Idle: <strong className="text-ink-800">{duration(data.totals.idleSeconds)}</strong></span>}
                {isToday && updatedAt && (
                  <span className="inline-flex items-center gap-1.5" title="Updates automatically">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Live · {istTimeSeconds(updatedAt.toISOString())}
                  </span>
                )}
                {!isToday && <Badge tone="info">{istDateLabel(date)}</Badge>}
              </div>
            </div>
          </Card>

          <Card>
            {error ? (
              <div className="flex flex-col items-center gap-3 p-10 text-center">
                <p className="text-sm text-red-600">{error}</p>
                <button type="button" className="btn-secondary" onClick={() => void load()}>Try again</button>
              </div>
            ) : loading && !data ? (
              <div className="p-5"><Skeleton lines={8} /></div>
            ) : !data || data.items.length === 0 ? (
              <EmptyState title="No employees match" description={debouncedSearch || status !== 'all' || location !== 'all' ? 'Clear the filters or search to see more employees.' : 'No employees are within your access.'} />
            ) : (
              <>
                <div className={cx('hidden lg:block', loading && 'opacity-60 transition-opacity')}>
                  <table className="w-full text-sm">
                    <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                      <tr>
                        <Th label="Employee ID" k="code" sort={sort} order={order} onSort={toggleSort} />
                        <Th label="Employee Name" k="name" sort={sort} order={order} onSort={toggleSort} />
                        <Th label="Location" k="location" sort={sort} order={order} onSort={toggleSort} />
                        <Th label="Device" k="device" sort={sort} order={order} onSort={toggleSort} />
                        <Th label="Login Time (12-hr)" k="login" sort={sort} order={order} onSort={toggleSort} />
                        <Th label="Logout Time (12-hr)" k="login" sort={sort} order={order} onSort={toggleSort} />
                        <Th label="Total Duration" k="active" sort={sort} order={order} onSort={toggleSort} right />
                        <Th label="Active Time" k="active" sort={sort} order={order} onSort={toggleSort} right />
                        <Th label="Idle Time" k="idle" sort={sort} order={order} onSort={toggleSort} right />
                        <Th label="Last Activity" k="lastActivity" sort={sort} order={order} onSort={toggleSort} />
                        <Th label="Current Status" k="status" sort={sort} order={order} onSort={toggleSort} />
                        <th className="px-4 py-2.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {data.items.map((item) => (
                        <tr key={item.id} className="cursor-pointer hover:bg-ink-50/60" onClick={() => navigate(`/activity-tracking/${item.id}?date=${date}`)}>
                          <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-ink-600">{item.employeeCode}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <Avatar name={item.fullName} src={item.photoUrl} size={30} />
                              <div className="min-w-0">
                                <div className="truncate font-medium text-ink-900">{item.fullName}</div>
                                {item.currentApp && isToday && <div className="truncate text-xs text-ink-500" title="Current foreground application">{item.currentApp}{item.currentDomain ? ` · ${item.currentDomain}` : ''}</div>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5" title={item.locationName ?? undefined}>{item.locationCode ?? '—'}</td>
                          <td className="whitespace-nowrap px-3 py-2.5">{item.device ? <span title={item.device.os}>{item.device.name}{item.deviceCount > 1 && <span className="text-ink-400"> +{item.deviceCount - 1}</span>}</span> : <span className="text-ink-400">—</span>}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-medium text-ink-900">{item.loginAt ? istTime(item.loginAt) : (item.hrmsLoginAt ? istTime(item.hrmsLoginAt) : <span className="text-ink-400">—</span>)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            {item.logoutAt ? (
                              <span className="font-medium text-ink-700">{istTime(item.logoutAt)}</span>
                            ) : item.loginAt || item.status === 'active' ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-200">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> Currently Logged In
                              </span>
                            ) : (
                              <span className="text-ink-400">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums font-semibold text-ink-900">{item.hasData ? duration(item.activeSeconds + item.idleSeconds) : <span className="text-ink-400">—</span>}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums font-medium text-emerald-700">{item.hasData ? duration(item.activeSeconds) : <span className="text-ink-400">—</span>}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-amber-700">{item.hasData ? duration(item.idleSeconds) : <span className="text-ink-400">—</span>}</td>
                          <td className="whitespace-nowrap px-3 py-2.5" title={istDateTime(item.lastActivityAt)}>{item.lastActivityAt ? (isToday ? ago(item.lastActivityAt) : istTime(item.lastActivityAt)) : <span className="text-ink-400">—</span>}</td>
                          <td className="whitespace-nowrap px-3 py-2.5"><StatusPill status={item.status} syncError={item.syncError} /></td>
                          <td className="px-4 py-2.5 text-right">
                            <Link to={`/activity-tracking/${item.id}?date=${date}`} onClick={(e) => e.stopPropagation()} className="btn-ghost btn-sm">View</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="divide-y divide-ink-100 lg:hidden">
                  {data.items.map((item) => <MobileRow key={item.id} item={item} date={date} isToday={isToday} />)}
                </ul>
                <Pagination page={data.pagination.page} pageSize={data.pagination.pageSize} total={data.pagination.total} onPage={(p) => update({ page: String(p) })} />
              </>
            )}
          </Card>
          <p className="mt-3 text-xs text-ink-500">
            Active and idle times are observed by the agent on the employee’s registered computer; “—” means no tracking data was recorded for that day. Hours when the computer was off, asleep, offline or the agent was not running are reported as untracked time, never estimated.
          </p>
        </>
      )}

      {tab === 'devices' && <TrackingDevices canManage={canManageDevices} />}
      {tab === 'alerts' && <AlertsPanel alerts={alerts} onRefresh={loadAlerts} />}
      {tab === 'settings' && canSettings && <TrackingSettings />}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} locations={data?.locations} defaultDate={date} />
    </div>
  );
}

function Chip({ active, onClick, label, count, title, small, tone }: { active: boolean; onClick: () => void; label: string; count?: number; title?: string; small?: boolean; tone?: 'warn' }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active}
      className={cx('inline-flex items-center gap-1.5 rounded-full border font-medium transition', small ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
        active ? 'border-brand-700 bg-brand-700 text-white' : 'border-ink-200 bg-white text-ink-700 hover:border-ink-300')}>
      {label}
      {count !== undefined && (
        <span className={cx('rounded-full px-1.5 text-[11px] font-semibold', active ? 'bg-white/20' : tone === 'warn' && count > 0 ? 'bg-amber-100 text-amber-800' : 'bg-ink-100 text-ink-600')}>{count}</span>
      )}
    </button>
  );
}

function Th({ label, k, sort, order, onSort, right }: { label: string; k: SortKey; sort: SortKey; order: string; onSort: (k: SortKey) => void; right?: boolean }) {
  const activeSort = sort === k;
  return (
    <th className={cx('px-3 py-2.5 first:px-4', right && 'text-right')} aria-sort={activeSort ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} className={cx('inline-flex items-center gap-1 uppercase hover:text-ink-800', activeSort && 'text-ink-800')}>
        {label}
        <Icon name={activeSort && order === 'desc' ? 'chevronDown' : 'chevronUp'} size={12} className={activeSort ? '' : 'opacity-30'} />
      </button>
    </th>
  );
}

function MobileRow({ item, date, isToday }: { item: OverviewItem; date: string; isToday: boolean }) {
  return (
    <li>
      <Link to={`/activity-tracking/${item.id}?date=${date}`} className="block px-4 py-3 hover:bg-ink-50">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={item.fullName} src={item.photoUrl} size={34} />
            <div className="min-w-0">
              <div className="truncate font-medium text-ink-900">{item.fullName}</div>
              <div className="text-xs text-ink-500">{item.employeeCode} · {item.locationCode ?? '—'}{item.device ? ` · ${item.device.name}` : ''}</div>
            </div>
          </div>
          <StatusPill status={item.status} syncError={item.syncError} />
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
          <Mini label="Login" value={item.loginAt ? istTime(item.loginAt) : '—'} />
          <Mini label="Active" value={item.hasData ? duration(item.activeSeconds) : '—'} />
          <Mini label="Idle" value={item.hasData ? duration(item.idleSeconds) : '—'} />
          <Mini label="Last" value={item.lastActivityAt ? (isToday ? ago(item.lastActivityAt) : istTime(item.lastActivityAt)) : '—'} />
        </div>
      </Link>
    </li>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div><div className="text-ink-400">{label}</div><div className="font-medium text-ink-800">{value}</div></div>;
}

function AlertsPanel({ alerts, onRefresh }: { alerts: Alert[] | null; onRefresh: () => void }) {
  if (!alerts) return <Card className="card-pad"><Skeleton lines={5} /></Card>;
  const tone = { critical: 'danger', warning: 'warning', info: 'info' } as const;
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-800">Needs attention ({alerts.length})</h2>
        <button type="button" className="btn-secondary btn-sm" onClick={onRefresh}><Icon name="refresh" size={14} /> Refresh</button>
      </div>
      {alerts.length === 0 ? (
        <EmptyState title="Everything is reporting normally" description="Disconnected agents, synchronisation problems, unregistered devices and outdated agents appear here." />
      ) : (
        <ul className="divide-y divide-ink-100">
          {alerts.map((a, i) => (
            <li key={`${a.kind}-${a.employeeId}-${i}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <Badge tone={tone[a.severity]}>{a.severity === 'critical' ? 'Critical' : a.severity === 'warning' ? 'Warning' : 'Info'}</Badge>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink-900">{a.employeeName} <span className="font-normal text-ink-500">· {a.employeeCode} · {a.locationCode ?? '—'}</span></div>
                  <div className="text-sm text-ink-600">{a.message}{a.since ? ` (since ${istDateTime(a.since)})` : ''}</div>
                </div>
              </div>
              <Link to={`/activity-tracking/${a.employeeId}`} className="btn-ghost btn-sm">Open</Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
