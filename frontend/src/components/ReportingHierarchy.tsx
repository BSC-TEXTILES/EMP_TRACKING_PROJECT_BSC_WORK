import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, Skeleton, StatCard, Tabs } from './ui';
import { BarChart, LineChart } from './Charts';
import { Icon } from './icons';
import { cx, formatDate, formatDateTime, formatTime, minutesToHours, relativeTime, titleize } from '../lib/format';

// ------------------------------------------------------------------ types

type WorkState =
  | 'working' | 'on_break' | 'in_meeting' | 'inactive' | 'offline'
  | 'checked_out' | 'on_leave' | 'online_not_checked_in' | 'not_logged_in';

export interface HierarchyNode {
  id: number;
  employeeCode: string;
  name: string;
  email: string | null;
  mobile: string | null;
  photoUrl: string | null;
  managerId: number | null;
  managerName: string | null;
  departmentId: number | null;
  department: string | null;
  designation: string | null;
  locationId: number | null;
  locationCode: string | null;
  locationName: string | null;
  roleSlug: string;
  roleName: string;
  roleLevel: number;
  isRoot: boolean;
  directReports: number;
  responsibilities: string[];
  attendance: { status: 'present' | 'late' | 'checked_out' | 'on_leave' | 'absent'; checkInAt: string | null; checkOutAt: string | null; isLate: boolean; earlyDeparture: boolean; workedMinutes: number };
  presence: { status: string; label: string; online: boolean; lastActiveAt: string | null; lastSeenAt: string | null } | null;
  workState: WorkState;
  currentModule: string | null;
  lastLoginAt: string | null;
  lastLogoutAt: string | null;
}

interface Summary { total: number; present: number; working: number; onBreak: number; inactive: number; onLeave: number; offline: number; managers: number }
interface LocationSummary extends Summary { id: number; code: string; name: string; city: string | null }

interface Overview {
  scope: { mode: 'all' | 'location' | 'team' | 'own'; canManage: boolean; allLocations: boolean };
  root: Partial<HierarchyNode> | null;
  manager: Partial<HierarchyNode> | null;
  locations: LocationSummary[];
  departments: { id: number; name: string }[];
  summary: Summary;
  employees: HierarchyNode[];
  generatedAt: string;
}

interface Metrics {
  employees: number; present: number; absent: number; onLeave: number; lateArrivals: number; earlyDepartures: number;
  workingNow: number; offlineNow: number; totalWorkedMinutes: number; averageWorkedMinutes: number; attendancePercent: number | null;
}
interface Analytics {
  range: { from: string; to: string; days: number; countedThrough: string | null };
  overall: Metrics;
  locations: (Metrics & { id: number; code: string; name: string })[];
  departments: (Metrics & { locationId: number; department: string })[];
  daily: { date: string; present: number; expected: number; attendancePercent: number | null }[];
  logins: { employeeId: number; name: string; employeeCode: string; locationCode: string | null; loginAt: string | null; logoutAt: string | null; durationMinutes: number; logoutReason: string | null; status: string }[];
}

interface Detail {
  employee: HierarchyNode;
  attendance: { date: string; status: string; checkInAt: string | null; checkOutAt: string | null; workedMinutes: number; isLate: boolean; earlyDeparture: boolean }[];
  sessions: { loginAt: string | null; logoutAt: string | null; durationMinutes: number; browser: string | null; os: string | null; logoutReason: string | null; status: string }[];
  reportingHistory: { managerName: string | null; previousManagerName: string | null; reason: string | null; source: string; from: string | null; to: string | null; assignedBy: string | null }[];
  directReports: { id: number; name: string; employeeCode: string; locationCode: string | null }[];
}

// ---------------------------------------------------------------- helpers

const WORK_STATE: Record<WorkState, { label: string; tone: string; dot: string }> = {
  working: { label: 'Working', tone: 'success', dot: 'bg-emerald-500' },
  on_break: { label: 'On break', tone: 'warning', dot: 'bg-amber-500' },
  in_meeting: { label: 'In a meeting', tone: 'info', dot: 'bg-sky-500' },
  inactive: { label: 'Inactive (idle)', tone: 'warning', dot: 'bg-amber-400' },
  offline: { label: 'Offline · checked in', tone: 'danger', dot: 'bg-red-400' },
  checked_out: { label: 'Checked out', tone: 'neutral', dot: 'bg-ink-300' },
  on_leave: { label: 'On leave', tone: 'brand', dot: 'bg-brand-400' },
  online_not_checked_in: { label: 'Online · not checked in', tone: 'warning', dot: 'bg-amber-300' },
  not_logged_in: { label: 'Not logged in', tone: 'neutral', dot: 'bg-ink-200' },
};

const ATTENDANCE: Record<HierarchyNode['attendance']['status'], { label: string; tone: string }> = {
  present: { label: 'Present', tone: 'success' },
  late: { label: 'Present · late', tone: 'warning' },
  checked_out: { label: 'Present · checked out', tone: 'neutral' },
  on_leave: { label: 'On leave', tone: 'brand' },
  absent: { label: 'Not checked in', tone: 'danger' },
};

function localDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function presetRange(preset: string): { from: string; to: string } {
  const now = new Date();
  if (preset === 'yesterday') return { from: localDay(-1), to: localDay(-1) };
  if (preset === 'week') {
    const back = (now.getDay() + 6) % 7; // Monday start
    return { from: localDay(-back), to: localDay(0) };
  }
  if (preset === 'month') return { from: localDay(-(now.getDate() - 1)), to: localDay(0) };
  return { from: localDay(0), to: localDay(0) };
}

function moduleLabel(module: string | null): string {
  if (!module) return '—';
  return titleize(module.replace(/^admin-/, 'admin ').replace(/-/g, ' '));
}

function pct(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

// -------------------------------------------------------------- component

export default function ReportingHierarchy() {
  const toast = useToast();
  const { user } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<number | 'all'>('all');
  const [view, setView] = useState<'tree' | 'live' | 'analytics'>('tree');
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState<number | 'all'>('all');
  const [groupBy, setGroupBy] = useState<'reporting' | 'department'>('reporting');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<number | null>(null);
  const [managersFor, setManagersFor] = useState<LocationSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<Overview>('/hierarchy/overview');
      setData(result);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live statuses refresh every 30 seconds while the page is visible.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.employees.filter((n) =>
      (location === 'all' || n.locationId === location)
      && (department === 'all' || n.departmentId === department)
      && (!term || `${n.name} ${n.employeeCode} ${n.designation ?? ''}`.toLowerCase().includes(term)));
  }, [data, location, department, search]);

  if (error) return <Card className="card-pad"><EmptyState title="Could not load the reporting hierarchy" description={error} /></Card>;
  if (!data) return <Card className="card-pad"><Skeleton lines={10} /></Card>;

  const isOwn = data.scope.mode === 'own';
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <div className="space-y-4">
      <RootHeader root={data.root} summary={data.summary} mode={data.scope.mode} />

      {isOwn ? (
        <OwnView me={data.employees[0] ?? null} manager={data.manager} onOpen={setDrawer} />
      ) : (
        <>
          <LocationSwitcher
            locations={data.locations}
            total={data.employees.length}
            value={location}
            allLocations={data.scope.allLocations}
            onChange={setLocation}
          />

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Tabs
              tabs={[
                { value: 'tree', label: 'Reporting tree' },
                { value: 'live', label: 'Live tracking', count: data.summary.working },
                { value: 'analytics', label: 'Attendance analytics' },
              ]}
              value={view}
              onChange={(value) => setView(value as typeof view)}
              className="border-b-0"
            />
            {view !== 'analytics' && (
              <div className="flex flex-wrap gap-2">
                <div className="relative">
                  <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                  <input className="input w-56 pl-8" placeholder="Name or employee ID" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search employees" />
                </div>
                <select className="input w-auto" value={department} onChange={(e) => setDepartment(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="Department">
                  <option value="all">All departments</option>
                  {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                {view === 'tree' && (
                  <select className="input w-auto" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)} aria-label="Group by">
                    <option value="reporting">Group by reporting line</option>
                    <option value="department">Group by department</option>
                  </select>
                )}
              </div>
            )}
          </div>

          {view === 'tree' && (
            <TreeView
              data={data}
              nodes={filtered}
              location={location}
              groupBy={groupBy}
              searching={Boolean(search.trim()) || department !== 'all'}
              collapsed={collapsed}
              onToggle={toggle}
              onOpen={setDrawer}
              onManagers={data.scope.canManage ? setManagersFor : undefined}
            />
          )}
          {view === 'live' && <LiveView nodes={filtered} onOpen={setDrawer} generatedAt={data.generatedAt} onRefresh={load} />}
          {view === 'analytics' && <AnalyticsView location={location} />}
        </>
      )}

      {drawer !== null && (
        <ProfileDrawer
          employeeId={drawer}
          canManage={data.scope.canManage && drawer !== user?.id}
          employees={data.employees}
          locations={data.locations}
          onClose={() => setDrawer(null)}
          onChanged={() => {
            void load();
            toast.success('Reporting assignment saved');
          }}
        />
      )}
      {managersFor && (
        <LocationManagersModal location={managersFor} employees={data.employees} onClose={() => setManagersFor(null)} onSaved={load} />
      )}
    </div>
  );
}

// ------------------------------------------------------------- root header

function RootHeader({ root, summary, mode }: { root: Partial<HierarchyNode> | null; summary: Summary; mode: Overview['scope']['mode'] }) {
  return (
    <Card className="overflow-hidden">
      <div className="bg-gradient-to-r from-brand-700 to-brand-500 px-5 py-5 text-white sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="rounded-full ring-4 ring-white/30">
              <Avatar name={root?.name ?? 'Software Manager'} src={root?.photoUrl ?? null} size={56} online={root?.presence?.online} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-white/70">Primary reporting manager</p>
              <h2 className="truncate text-xl font-semibold sm:text-2xl">
                {root?.name ?? 'Software Manager not assigned'} <span className="font-normal text-white/80">| {root?.designation ?? 'Software Manager'}</span>
              </h2>
              <p className="truncate text-sm text-white/80">
                {[root?.employeeCode, root?.department, root?.locationCode ? `${root.locationCode} – ${root.locationName}` : null].filter(Boolean).join(' · ') || 'All BSC Textiles locations'}
              </p>
            </div>
          </div>
          {mode !== 'own' && (
            <div className="grid grid-cols-4 gap-2 text-center sm:gap-3">
              {[
                ['Employees', summary.total],
                ['Present', summary.present],
                ['Working', summary.working],
                ['On leave', summary.onLeave],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-lg bg-white/15 px-2 py-2 sm:px-3">
                  <p className="text-lg font-semibold leading-none sm:text-xl">{value}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-white/75 sm:text-[11px]">{label}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {mode !== 'all' && mode !== 'own' && (
        <p className="border-t border-ink-100 bg-ink-50 px-5 py-2 text-xs text-ink-500">
          {mode === 'location' ? 'You are seeing the employees of the locations assigned to you.' : 'You are seeing your own reporting team.'}
        </p>
      )}
    </Card>
  );
}

// -------------------------------------------------------- location switcher

function LocationSwitcher({ locations, total, value, allLocations, onChange }: {
  locations: LocationSummary[]; total: number; value: number | 'all'; allLocations: boolean; onChange: (v: number | 'all') => void;
}) {
  const chip = (key: number | 'all', title: string, subtitle: string, count: number, working: number) => (
    <button
      key={String(key)}
      type="button"
      onClick={() => onChange(key)}
      aria-pressed={value === key}
      className={cx(
        'flex min-w-[9.5rem] flex-1 items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition',
        value === key ? 'border-brand-500 bg-brand-50 shadow-sm ring-1 ring-brand-500' : 'border-ink-200 bg-white hover:border-brand-300 hover:bg-ink-50',
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink-900">{title}</span>
        <span className="block truncate text-xs text-ink-500">{subtitle}</span>
      </span>
      <span className="text-right">
        <span className="block text-lg font-semibold leading-none text-ink-900">{count}</span>
        <span className="text-[11px] text-emerald-600">{working} working</span>
      </span>
    </button>
  );
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap" role="group" aria-label="Location">
      {chip('all', allLocations ? 'All locations' : 'All my locations', 'Consolidated view', total, locations.reduce((s, l) => s + l.working, 0))}
      {locations.map((l) => chip(l.id, l.code, l.name, l.total, l.working))}
    </div>
  );
}

// --------------------------------------------------------------- tree view

function NodeRow({ node, depth, hasChildren, isCollapsed, onToggle, onOpen }: {
  node: HierarchyNode; depth: number; hasChildren: boolean; isCollapsed: boolean; onToggle: () => void; onOpen: (id: number) => void;
}) {
  const state = WORK_STATE[node.workState];
  const att = ATTENDANCE[node.attendance.status];
  return (
    <div className={cx('group flex items-center gap-2 rounded-xl border bg-white px-2.5 py-2 transition hover:border-brand-300 hover:shadow-sm', depth === 0 ? 'border-ink-200' : 'border-ink-100')}>
      {hasChildren ? (
        <button type="button" className="rounded p-1 text-ink-500 hover:bg-ink-100" onClick={onToggle} aria-label={isCollapsed ? 'Expand' : 'Collapse'} aria-expanded={!isCollapsed}>
          <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={14} />
        </button>
      ) : (
        <span className="w-6" />
      )}
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => onOpen(node.id)}>
        <span className="relative">
          <Avatar name={node.name} src={node.photoUrl} size={34} />
          <span className={cx('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white', state.dot)} title={state.label} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink-900">{node.name}</span>
            <span className="hidden text-[11px] text-ink-400 sm:inline">{node.employeeCode}</span>
            {node.directReports > 0 && <span className="hidden rounded bg-ink-100 px-1.5 text-[10px] font-medium text-ink-600 md:inline">{node.directReports} reports</span>}
          </span>
          <span className="block truncate text-xs text-ink-500">
            {node.designation ?? node.roleName} · {node.department ?? 'No department'}
            {node.managerName && <span className="hidden lg:inline"> · reports to {node.managerName}</span>}
          </span>
        </span>
      </button>
      <span className="hidden sm:inline-flex"><Badge tone={att.tone}>{att.label}</Badge></span>
      <Badge tone={state.tone}>{state.label}</Badge>
    </div>
  );
}

function TreeView({ data, nodes, location, groupBy, searching, collapsed, onToggle, onOpen, onManagers }: {
  data: Overview; nodes: HierarchyNode[]; location: number | 'all'; groupBy: 'reporting' | 'department'; searching: boolean;
  collapsed: Set<string>; onToggle: (key: string) => void; onOpen: (id: number) => void; onManagers?: (l: LocationSummary) => void;
}) {
  const sections = data.locations.filter((l) => location === 'all' || l.id === location);
  const unassigned = nodes.filter((n) => !n.isRoot && !data.locations.some((l) => l.id === n.locationId));

  const renderReporting = (list: HierarchyNode[], key: string) => {
    const ids = new Set(list.map((n) => n.id));
    const children = new Map<number, HierarchyNode[]>();
    for (const n of list) {
      if (n.managerId !== null && ids.has(n.managerId)) {
        if (!children.has(n.managerId)) children.set(n.managerId, []);
        children.get(n.managerId)!.push(n);
      }
    }
    // Managers first, then by name.
    const order = (a: HierarchyNode, b: HierarchyNode) => (b.directReports > 0 ? 1 : 0) - (a.directReports > 0 ? 1 : 0) || b.roleLevel - a.roleLevel || a.name.localeCompare(b.name);
    const tops = list.filter((n) => n.managerId === null || !ids.has(n.managerId)).sort(order);
    const render = (n: HierarchyNode, depth: number): ReactNode => {
      const kids = (children.get(n.id) ?? []).sort(order);
      const k = `${key}:${n.id}`;
      const isCollapsed = !searching && collapsed.has(k);
      return (
        <div key={n.id}>
          <NodeRow node={n} depth={depth} hasChildren={kids.length > 0} isCollapsed={isCollapsed} onToggle={() => onToggle(k)} onOpen={onOpen} />
          {kids.length > 0 && !isCollapsed && (
            <div className="ml-4 mt-1.5 space-y-1.5 border-l-2 border-dashed border-ink-200 pl-3 sm:ml-6">{kids.map((c) => render(c, depth + 1))}</div>
          )}
        </div>
      );
    };
    return <div className="space-y-1.5">{tops.map((n) => render(n, 0))}</div>;
  };

  const renderDepartments = (list: HierarchyNode[], key: string) => {
    const groups = new Map<string, HierarchyNode[]>();
    for (const n of list) {
      const name = n.department ?? 'No department';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(n);
    }
    return (
      <div className="space-y-3">
        {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, members]) => {
          const k = `${key}:dept:${name}`;
          const isCollapsed = !searching && collapsed.has(k);
          return (
            <div key={name}>
              <button type="button" className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500" onClick={() => onToggle(k)}>
                <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} /> {name} <span className="font-normal normal-case text-ink-400">({members.length})</span>
              </button>
              {!isCollapsed && (
                <div className="space-y-1.5">
                  {members.sort((a, b) => b.roleLevel - a.roleLevel || a.name.localeCompare(b.name)).map((n) => (
                    <NodeRow key={n.id} node={n} depth={0} hasChildren={false} isCollapsed={false} onToggle={() => undefined} onOpen={onOpen} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {sections.map((l) => {
        const members = nodes.filter((n) => n.locationId === l.id && !n.isRoot);
        const key = `loc:${l.id}`;
        const isCollapsed = !searching && collapsed.has(key);
        return (
          <Card key={l.id} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 bg-ink-50/70 px-4 py-3">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onToggle(key)} aria-expanded={!isCollapsed}>
                <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={16} className="text-ink-500" />
                <span className="flex h-9 w-12 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">{l.code}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink-900">{l.code} – {l.name}</span>
                  <span className="block text-xs text-ink-500">{l.total} employees · {l.managers} managers · {l.present} present · {l.working} working · {l.onLeave} on leave</span>
                </span>
              </button>
              {onManagers && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => onManagers(l)}>
                  <Icon name="userCheck" size={14} /> Location managers
                </button>
              )}
            </div>
            {!isCollapsed && (
              <div className="p-3 sm:p-4">
                {members.length === 0
                  ? <p className="py-4 text-center text-sm text-ink-400">{searching ? 'No matching employees here.' : 'No employees assigned to this location yet.'}</p>
                  : groupBy === 'department' ? renderDepartments(members, key) : renderReporting(members, key)}
              </div>
            )}
          </Card>
        );
      })}
      {unassigned.length > 0 && location === 'all' && (
        <Card className="card-pad">
          <p className="mb-2 text-sm font-semibold text-ink-800">Without a location</p>
          {renderReporting(unassigned, 'none')}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- own view

function OwnView({ me, manager, onOpen }: { me: HierarchyNode | null; manager: Partial<HierarchyNode> | null; onOpen: (id: number) => void }) {
  if (!me) return <Card className="card-pad"><EmptyState title="Profile unavailable" description="Your employee record could not be loaded." /></Card>;
  const state = WORK_STATE[me.workState];
  const att = ATTENDANCE[me.attendance.status];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="card-pad">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">My position</p>
        <button type="button" className="mt-3 flex w-full items-center gap-3 text-left" onClick={() => onOpen(me.id)}>
          <Avatar name={me.name} src={me.photoUrl} size={48} />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-ink-900">{me.name}</span>
            <span className="block truncate text-sm text-ink-500">{me.employeeCode} · {me.designation ?? me.roleName}</span>
            <span className="block truncate text-xs text-ink-400">{me.department ?? 'No department'} · {me.locationCode ? `${me.locationCode} – ${me.locationName}` : 'No location'}</span>
          </span>
        </button>
        <div className="mt-4 flex flex-wrap gap-2"><Badge tone={att.tone}>{att.label}</Badge><Badge tone={state.tone}>{state.label}</Badge></div>
        <p className="mt-3 text-xs text-ink-500">Checked in {me.attendance.checkInAt ? formatTime(me.attendance.checkInAt) : '—'} · worked {minutesToHours(me.attendance.workedMinutes)} today</p>
      </Card>
      <Card className="card-pad">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">I report to</p>
        {manager ? (
          <div className="mt-3 flex items-center gap-3">
            <Avatar name={manager.name} src={manager.photoUrl ?? null} size={48} />
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink-900">{manager.name}</p>
              <p className="truncate text-sm text-ink-500">{manager.employeeCode} · {manager.designation ?? '—'}{manager.locationCode ? ` · ${manager.locationCode}` : ''}</p>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-500">No reporting manager assigned.</p>
        )}
      </Card>
    </div>
  );
}

// --------------------------------------------------------------- live view

function LiveView({ nodes, onOpen, generatedAt, onRefresh }: { nodes: HierarchyNode[]; onOpen: (id: number) => void; generatedAt: string; onRefresh: () => void }) {
  const [state, setState] = useState<WorkState | 'all'>('all');
  const counts = useMemo(() => {
    const map = new Map<WorkState, number>();
    for (const n of nodes) map.set(n.workState, (map.get(n.workState) ?? 0) + 1);
    return map;
  }, [nodes]);
  const order: WorkState[] = ['working', 'in_meeting', 'on_break', 'inactive', 'online_not_checked_in', 'offline', 'checked_out', 'on_leave', 'not_logged_in'];
  const list = nodes
    .filter((n) => state === 'all' || n.workState === state)
    .sort((a, b) => order.indexOf(a.workState) - order.indexOf(b.workState) || a.name.localeCompare(b.name));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3">
        <button type="button" className={cx('rounded-full border px-3 py-1 text-xs', state === 'all' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-600')} onClick={() => setState('all')}>
          All ({nodes.length})
        </button>
        {order.filter((s) => counts.get(s)).map((s) => (
          <button key={s} type="button" onClick={() => setState(s)}
            className={cx('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs', state === s ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-600')}>
            <span className={cx('h-2 w-2 rounded-full', WORK_STATE[s].dot)} /> {WORK_STATE[s].label} ({counts.get(s)})
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 text-xs text-ink-400">
          Updated {formatTime(generatedAt)} · refreshes every 30 s
          <button type="button" className="rounded p-1 hover:bg-ink-100" onClick={onRefresh} aria-label="Refresh"><Icon name="refresh" size={14} /></button>
        </span>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No employees" description="Nobody matches these filters." />
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr><th>Employee</th><th>Location</th><th>Status</th><th>Section in use</th><th>Login</th><th>Logout</th><th>Last activity</th><th>Worked today</th></tr>
            </thead>
            <tbody>
              {list.map((n) => (
                <tr key={n.id} className="cursor-pointer hover:bg-ink-50" onClick={() => onOpen(n.id)}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Avatar name={n.name} src={n.photoUrl} size={28} online={n.presence?.online} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink-800">{n.name}</p>
                        <p className="truncate text-[11px] text-ink-400">{n.employeeCode} · {n.designation ?? n.roleName}</p>
                      </div>
                    </div>
                  </td>
                  <td className="text-xs">{n.locationCode ?? '—'}</td>
                  <td><Badge tone={WORK_STATE[n.workState].tone}>{WORK_STATE[n.workState].label}</Badge></td>
                  <td className="text-xs">{moduleLabel(n.currentModule)}</td>
                  <td className="whitespace-nowrap text-xs">{n.attendance.checkInAt ? formatTime(n.attendance.checkInAt) : n.lastLoginAt ? formatDateTime(n.lastLoginAt) : '—'}</td>
                  <td className="whitespace-nowrap text-xs">{n.attendance.checkOutAt ? formatTime(n.attendance.checkOutAt) : n.lastLogoutAt ? formatDateTime(n.lastLogoutAt) : '—'}</td>
                  <td className="whitespace-nowrap text-xs">{n.presence?.lastActiveAt ? relativeTime(n.presence.lastActiveAt) : '—'}</td>
                  <td className="whitespace-nowrap text-xs font-medium">{n.attendance.workedMinutes ? minutesToHours(n.attendance.workedMinutes) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-ink-100 px-4 py-2 text-[11px] text-ink-400">
        Status comes from attendance check-in and the employee's real activity in the app. "Section in use" is the page they have open (updated when they navigate); nothing on the page is recorded.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------- analytics view

function AnalyticsView({ location }: { location: number | 'all' }) {
  const [preset, setPreset] = useState('today');
  const [custom, setCustom] = useState(() => ({ from: localDay(-6), to: localDay(0) }));
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const range = preset === 'custom' ? custom : presetRange(preset);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (location !== 'all') params.set('locationId', String(location));
    api.get<Analytics>(`/hierarchy/analytics?${params.toString()}`)
      .then((result) => { if (!cancelled) { setData(result); setError(null); } })
      .catch((caught) => { if (!cancelled) setError(errorMessage(caught)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range.from, range.to, location]);

  const o = data?.overall;
  return (
    <div className="space-y-4">
      <Card className="card-pad flex flex-wrap items-end gap-3">
        <Field label="Period">
          <select className="input w-auto" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="custom">Custom range</option>
          </select>
        </Field>
        {preset === 'custom' && (
          <>
            <Field label="From"><input type="date" className="input w-auto" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></Field>
            <Field label="To"><input type="date" className="input w-auto" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></Field>
          </>
        )}
        <p className="pb-2 text-xs text-ink-500">
          {formatDate(range.from)}{range.to !== range.from ? ` – ${formatDate(range.to)}` : ''}{location === 'all' ? ' · all permitted locations' : ''}
        </p>
      </Card>

      {error ? <Card className="card-pad"><EmptyState title="Analytics unavailable" description={error} /></Card>
        : !data || !o ? <Card className="card-pad"><Skeleton lines={6} /></Card>
        : (
          <div className={cx('space-y-4', loading && 'opacity-60')}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              <StatCard label="Total employees" value={o.employees} />
              <StatCard label="Present (employee-days)" value={o.present} tone="success" />
              <StatCard label="Absent (employee-days)" value={o.absent} tone="danger" />
              <StatCard label="On leave (employee-days)" value={o.onLeave} tone="brand" />
              <StatCard label="Working now" value={o.workingNow} tone="success" />
              <StatCard label="Offline now" value={o.offlineNow} tone="neutral" />
              <StatCard label="Late arrivals" value={o.lateArrivals} tone="warning" />
              <StatCard label="Early departures" value={o.earlyDepartures} tone="warning" />
              <StatCard label="Total working hours" value={minutesToHours(o.totalWorkedMinutes)} />
              <StatCard label="Average per present day" value={minutesToHours(o.averageWorkedMinutes)} />
              <StatCard label="Attendance" value={pct(o.attendancePercent)} tone="brand" hint="Present ÷ expected working days" />
              <StatCard label="Days in range" value={data.range.days} tone="neutral" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="card-pad">
                <p className="mb-2 text-sm font-semibold text-ink-800">Attendance % by location</p>
                <BarChart data={data.locations.map((l) => ({ label: l.code, value: l.attendancePercent ?? 0 }))} suffix="%" />
              </Card>
              <Card className="card-pad">
                <p className="mb-2 text-sm font-semibold text-ink-800">Daily attendance %</p>
                <LineChart data={data.daily.map((d) => ({ label: d.date.slice(5), value: d.attendancePercent ?? 0 }))} suffix="%" />
              </Card>
            </div>

            <Card>
              <p className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-800">Location comparison</p>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead><tr><th>Location</th><th>Employees</th><th>Present</th><th>Absent</th><th>Leave</th><th>Late</th><th>Early out</th><th>Working now</th><th>Total hours</th><th>Avg / day</th><th>Attendance</th></tr></thead>
                  <tbody>
                    {data.locations.map((l) => (
                      <tr key={l.id}>
                        <td className="font-medium text-ink-800">{l.code} <span className="text-xs font-normal text-ink-400">{l.name}</span></td>
                        <td>{l.employees}</td><td>{l.present}</td><td>{l.absent}</td><td>{l.onLeave}</td><td>{l.lateArrivals}</td><td>{l.earlyDepartures}</td>
                        <td>{l.workingNow}</td><td>{minutesToHours(l.totalWorkedMinutes)}</td><td>{minutesToHours(l.averageWorkedMinutes)}</td>
                        <td className="font-semibold">{pct(l.attendancePercent)}</td>
                      </tr>
                    ))}
                    {data.locations.length > 1 && (
                      <tr className="bg-ink-50 font-semibold">
                        <td>All</td><td>{o.employees}</td><td>{o.present}</td><td>{o.absent}</td><td>{o.onLeave}</td><td>{o.lateArrivals}</td><td>{o.earlyDepartures}</td>
                        <td>{o.workingNow}</td><td>{minutesToHours(o.totalWorkedMinutes)}</td><td>{minutesToHours(o.averageWorkedMinutes)}</td><td>{pct(o.attendancePercent)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <p className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-800">Department-wise attendance</p>
              {data.departments.length === 0 ? <EmptyState title="No data" description="No employees in this selection." /> : (
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead><tr><th>Department</th><th>Location</th><th>Employees</th><th>Present</th><th>Absent</th><th>Leave</th><th>Late</th><th>Avg / day</th><th>Attendance</th></tr></thead>
                    <tbody>
                      {data.departments.map((d) => (
                        <tr key={`${d.locationId}-${d.department}`}>
                          <td className="font-medium text-ink-800">{d.department}</td>
                          <td className="text-xs">{data.locations.find((l) => l.id === d.locationId)?.code ?? '—'}</td>
                          <td>{d.employees}</td><td>{d.present}</td><td>{d.absent}</td><td>{d.onLeave}</td><td>{d.lateArrivals}</td>
                          <td>{minutesToHours(d.averageWorkedMinutes)}</td><td className="font-semibold">{pct(d.attendancePercent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card>
              <p className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-800">Login and logout records <span className="font-normal text-ink-400">({data.logins.length}{data.logins.length === 300 ? ', latest 300' : ''})</span></p>
              {data.logins.length === 0 ? <EmptyState title="No sign-ins" description="Nobody signed in during this period." /> : (
                <div className="max-h-96 overflow-auto">
                  <table className="table-base">
                    <thead><tr><th>Employee</th><th>Location</th><th>Login</th><th>Logout</th><th>Duration</th><th>Ended by</th></tr></thead>
                    <tbody>
                      {data.logins.map((l, i) => (
                        <tr key={`${l.employeeId}-${l.loginAt}-${i}`}>
                          <td><span className="font-medium text-ink-800">{l.name}</span> <span className="text-[11px] text-ink-400">{l.employeeCode}</span></td>
                          <td className="text-xs">{l.locationCode ?? '—'}</td>
                          <td className="whitespace-nowrap text-xs">{formatDateTime(l.loginAt)}</td>
                          <td className="whitespace-nowrap text-xs">{l.logoutAt ? formatDateTime(l.logoutAt) : <Badge tone="success">Signed in</Badge>}</td>
                          <td className="text-xs">{l.logoutAt ? minutesToHours(l.durationMinutes) : '—'}</td>
                          <td className="text-xs">{l.logoutReason ? titleize(l.logoutReason) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <p className="text-[11px] text-ink-400">
              Calculated from attendance records, approved leave and holidays. Expected days count from each employee's joining date up to today;
              today counts as absent until the employee checks in.
            </p>
          </div>
        )}
    </div>
  );
}

// ---------------------------------------------------------- profile drawer

function ProfileDrawer({ employeeId, canManage, employees, locations, onClose, onChanged }: {
  employeeId: number; canManage: boolean; employees: HierarchyNode[]; locations: LocationSummary[]; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managerId, setManagerId] = useState<string>('');
  const [locationId, setLocationId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchDetail = useCallback(() => {
    api.get<Detail>(`/hierarchy/employees/${employeeId}`)
      .then((d) => {
        setDetail(d);
        setManagerId(d.employee.managerId ? String(d.employee.managerId) : '');
        setLocationId(d.employee.locationId ? String(d.employee.locationId) : '');
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, [employeeId]);
  useEffect(() => { setDetail(null); setError(null); fetchDetail(); }, [fetchDetail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!detail) return;
    const body: Record<string, unknown> = { reason: reason.trim() || undefined };
    if (managerId && Number(managerId) !== detail.employee.managerId) body.managerId = Number(managerId);
    if (locationId && Number(locationId) !== detail.employee.locationId) body.locationId = Number(locationId);
    if (!('managerId' in body) && !('locationId' in body)) { toast.info('Nothing changed'); return; }
    setSaving(true);
    try {
      await api.put(`/hierarchy/employees/${employeeId}/assignment`, body);
      setReason('');
      fetchDetail();
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const e = detail?.employee;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Employee profile">
      <button type="button" className="absolute inset-0 bg-ink-900/40" onClick={onClose} aria-label="Close" />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-100 bg-white px-5 py-3">
          <p className="text-sm font-semibold text-ink-800">Employee profile</p>
          <button type="button" className="rounded p-1 text-ink-500 hover:bg-ink-100" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {error ? <div className="p-5"><EmptyState title="Unavailable" description={error} /></div> : !detail || !e ? <div className="p-5"><Skeleton lines={10} /></div> : (
          <div className="space-y-5 p-5">
            <div className="flex items-center gap-3">
              <Avatar name={e.name} src={e.photoUrl} size={56} online={e.presence?.online} />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold text-ink-900">{e.name}</p>
                <p className="truncate text-sm text-ink-500">{e.designation ?? e.roleName}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone={WORK_STATE[e.workState].tone}>{WORK_STATE[e.workState].label}</Badge>
                  <Badge tone={ATTENDANCE[e.attendance.status].tone}>{ATTENDANCE[e.attendance.status].label}</Badge>
                </div>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {[
                ['Employee ID', e.employeeCode],
                ['Role', e.roleName],
                ['Department', e.department ?? '—'],
                ['Location', e.locationCode ? `${e.locationCode} – ${e.locationName}` : '—'],
                ['Reporting manager', e.managerName ?? (e.isRoot ? 'Top of hierarchy' : '—')],
                ['Direct reports', String(e.directReports)],
                ['Checked in', e.attendance.checkInAt ? formatTime(e.attendance.checkInAt) : '—'],
                ['Checked out', e.attendance.checkOutAt ? formatTime(e.attendance.checkOutAt) : '—'],
                ['Last login', e.lastLoginAt ? formatDateTime(e.lastLoginAt) : '—'],
                ['Last logout', e.lastLogoutAt ? formatDateTime(e.lastLogoutAt) : '—'],
                ['Last activity', e.presence?.lastActiveAt ? relativeTime(e.presence.lastActiveAt) : '—'],
                ['Section in use', moduleLabel(e.currentModule)],
                ['Worked today', minutesToHours(e.attendance.workedMinutes)],
                ['Email', e.email ?? '—'],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wide text-ink-400">{label}</dt>
                  <dd className="truncate text-ink-800" title={value}>{value}</dd>
                </div>
              ))}
            </dl>

            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Responsibilities</p>
              <div className="flex flex-wrap gap-1.5">{e.responsibilities.map((r) => <span key={r} className="rounded-full bg-ink-100 px-2.5 py-1 text-xs text-ink-700">{r}</span>)}</div>
            </section>

            {canManage && !e.isRoot && (
              <section className="rounded-xl border border-brand-200 bg-brand-50/40 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Change reporting / location</p>
                <div className="space-y-2">
                  <Field label="Reporting manager">
                    <select className="input" value={managerId} onChange={(ev) => setManagerId(ev.target.value)}>
                      {employees.filter((x) => x.id !== e.id).sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.name.localeCompare(b.name)).map((x) => (
                        <option key={x.id} value={x.id}>{x.name} ({x.employeeCode}{x.locationCode ? ` · ${x.locationCode}` : ''}){x.isRoot ? ' – Software Manager' : ''}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Location">
                    <select className="input" value={locationId} onChange={(ev) => setLocationId(ev.target.value)}>
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.code} – {l.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Reason (kept in history)">
                    <input className="input" value={reason} maxLength={160} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. Transferred to Davanagere store" />
                  </Field>
                  <button type="button" className="btn-primary w-full" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save assignment'}</button>
                </div>
              </section>
            )}

            {detail.directReports.length > 0 && (
              <section>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Direct reports ({detail.directReports.length})</p>
                <ul className="space-y-1 text-sm">{detail.directReports.map((r) => <li key={r.id} className="flex justify-between"><span className="text-ink-800">{r.name}</span><span className="text-xs text-ink-400">{r.employeeCode} · {r.locationCode ?? '—'}</span></li>)}</ul>
              </section>
            )}

            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Attendance – last 14 days</p>
              {detail.attendance.length === 0 ? <p className="text-sm text-ink-400">No attendance records.</p> : (
                <table className="w-full text-xs">
                  <thead className="text-left text-ink-400"><tr><th className="py-1">Date</th><th>In</th><th>Out</th><th>Worked</th><th /></tr></thead>
                  <tbody className="divide-y divide-ink-100">
                    {detail.attendance.map((a) => (
                      <tr key={a.date}>
                        <td className="py-1.5">{formatDate(a.date)}</td><td>{formatTime(a.checkInAt)}</td><td>{a.checkOutAt ? formatTime(a.checkOutAt) : '—'}</td><td>{minutesToHours(a.workedMinutes)}</td>
                        <td className="text-right">{a.isLate && <Badge tone="warning">Late</Badge>} {a.earlyDeparture && <Badge tone="warning">Early</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Recent sessions</p>
              {detail.sessions.length === 0 ? <p className="text-sm text-ink-400">No sign-ins recorded.</p> : (
                <ul className="space-y-1.5 text-xs">
                  {detail.sessions.map((s, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span>{formatDateTime(s.loginAt)} → {s.logoutAt ? formatTime(s.logoutAt) : <span className="text-emerald-600">signed in</span>}</span>
                      <span className="text-ink-400">{[s.browser, s.os].filter(Boolean).join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Reporting history</p>
              {detail.reportingHistory.length === 0 ? <p className="text-sm text-ink-400">No changes recorded.</p> : (
                <ol className="space-y-2 border-l-2 border-ink-100 pl-3 text-xs">
                  {detail.reportingHistory.map((h, i) => (
                    <li key={i}>
                      <p className="text-ink-800">Reports to <b>{h.managerName ?? 'nobody (top)'}</b>{h.previousManagerName ? <span className="text-ink-500"> (was {h.previousManagerName})</span> : null}</p>
                      <p className="text-ink-400">{formatDateTime(h.from)}{h.to ? ` – ${formatDateTime(h.to)}` : ' – current'} · {h.reason ?? titleize(h.source)}{h.assignedBy ? ` · by ${h.assignedBy}` : ''}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

// ------------------------------------------------- location managers modal

function LocationManagersModal({ location, employees, onClose, onSaved }: { location: LocationSummary; employees: HierarchyNode[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ managers: { id: number }[] }>(`/hierarchy/locations/${location.id}/managers`)
      .then((r) => setSelected(new Set(r.managers.map((m) => m.id))))
      .catch((caught) => { toast.error(errorMessage(caught)); setSelected(new Set()); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.id]);

  const candidates = employees
    .filter((e) => !e.isRoot && `${e.name} ${e.employeeCode}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => b.roleLevel - a.roleLevel || a.name.localeCompare(b.name));

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.put(`/hierarchy/locations/${location.id}/managers`, { employeeIds: [...selected] });
      toast.success(`Managers for ${location.code} saved`);
      onSaved();
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Location managers – ${location.code}`}
      description="Selected employees can track this location's employees, attendance and reports. Give them the Location Manager (or Store Manager) role in Employees so they have tracking permissions."
      footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={saving || !selected} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button></>}
    >
      <input className="input mb-3" placeholder="Search employees" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {!selected ? <Skeleton lines={5} /> : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {candidates.map((e) => (
            <li key={e.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-ink-50">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(e.id)) next.delete(e.id);
                  else next.add(e.id);
                  return next;
                })} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-800">{e.name}</span>
                  <span className="block truncate text-[11px] text-ink-400">{e.employeeCode} · {e.roleName} · {e.locationCode ?? '—'}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
