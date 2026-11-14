import { useEffect, useState } from 'react';
import { api, downloadReport, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useToast } from '../contexts/ToastContext';
import { Card, EmptyState, PageHeader, SectionHeader, Skeleton, StatCard } from '../components/ui';
import { BarChart, Donut, LineChart } from '../components/Charts';
import { Icon } from '../components/icons';
import { formatDate } from '../lib/format';

interface Overview {
  range: { from: string; to: string };
  headcount: { total: number; active: number; pending: number; inactive: number; checkedIn: number; onLeave: number };
  attendanceToday: { present: number; late: number; absent: number; totalMinutes: number };
  tasks: { allocated: number; completed: number; pending: number; overdue: number; awaitingApproval: number };
  tickets: { total: number; open: number; resolved: number; breached: number };
  meetings: { upcoming: number; held: number };
  kpi: { average: number | null; evaluated: number };
  departments: { department: string; employees: number; completedTasks: number; totalTasks: number; completionRate: number | null; averageKpi: number | null; attendancePercent: number | null }[];
  trends: { attendance: { date: string; present: number; late: number; hours: number }[]; productivity: { date: string; completed: number }[] };
  workload: { employeeId: number; name: string; openTasks: number; overdue: number; hours: number }[];
}

interface Structure {
  departments: { id: number; name: string }[];
  locations: { id: number; name: string }[];
}

export default function Analytics() {
  useDocumentTitle('Analytics');
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [filters, setFilters] = useState({ from: '', to: '', departmentId: '' });

  const load = async () => {
    try {
      const query = new URLSearchParams();
      if (filters.from) query.set('from', filters.from);
      if (filters.to) query.set('to', filters.to);
      if (filters.departmentId) query.set('departmentId', filters.departmentId);
      setOverview(await api.get<Overview>(`/analytics/overview?${query.toString()}`));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    api.get<Structure>('/employees/structure').then(setStructure).catch(() => undefined);
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Advanced analytics"
        description="Company-wide operational and performance intelligence computed live from the database."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'productivity', format: 'xlsx', from: filters.from, to: filters.to })}>Excel</button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'attendance', format: 'pdf', from: filters.from, to: filters.to })}>PDF</button>
          </>
        }
      />

      <Card className="card-pad">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">From</span>
            <input type="date" className="input w-auto" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </label>
          <label className="block">
            <span className="label">To</span>
            <input type="date" className="input w-auto" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </label>
          <label className="block">
            <span className="label">Department</span>
            <select className="input w-auto" value={filters.departmentId} onChange={(event) => setFilters({ ...filters, departmentId: event.target.value })}>
              <option value="">All departments</option>
              {structure?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </label>
          <span className="pb-2 text-xs text-ink-500">{overview ? `${formatDate(overview.range.from)} → ${formatDate(overview.range.to)}` : ''}</span>
        </div>
      </Card>

      {!overview ? (
        <Card className="card-pad"><Skeleton lines={10} /></Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Active employees" value={overview.headcount.active} hint={`${overview.headcount.pending} pending · ${overview.headcount.inactive} inactive`} icon={<Icon name="users" size={18} />} />
            <StatCard label="Present today" value={overview.attendanceToday.present} hint={`${overview.attendanceToday.late} late · ${overview.headcount.checkedIn} checked in`} tone="success" icon={<Icon name="clock" size={18} />} />
            <StatCard label="Open tasks" value={overview.tasks.pending} hint={`${overview.tasks.overdue} overdue · ${overview.tasks.awaitingApproval} awaiting approval`} tone="warning" icon={<Icon name="tasks" size={18} />} />
            <StatCard label="KPI average" value={overview.kpi.average !== null ? overview.kpi.average.toFixed(1) : '—'} hint={`${overview.kpi.evaluated} evaluations this period`} tone="brand" icon={<Icon name="kpi" size={18} />} />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="card-pad lg:col-span-2">
              <SectionHeader title="Attendance trend" description={`${overview.range.from} → ${overview.range.to}`} />
              <div className="mt-3">
                {overview.trends.attendance.length === 0 ? (
                  <EmptyState compact title="No attendance data" />
                ) : (
                  <LineChart data={overview.trends.attendance.map((point) => ({ label: point.date.slice(5), value: point.present }))} height={190} />
                )}
              </div>
            </Card>
            <Card className="card-pad">
              <SectionHeader title="Today's attendance mix" />
              <div className="mt-3">
                <Donut
                  segments={[
                    { label: 'Present', value: overview.attendanceToday.present, color: '#059669' },
                    { label: 'Late', value: overview.attendanceToday.late, color: '#d97706' },
                    { label: 'Absent', value: overview.attendanceToday.absent, color: '#dc2626' },
                    { label: 'On leave', value: overview.headcount.onLeave, color: '#0284c7' },
                  ]}
                  centerValue={String(overview.headcount.active)}
                  centerLabel="Headcount"
                  size={130}
                />
              </div>
              <p className="mt-2 text-xs text-ink-500">Hours recorded today: {(overview.attendanceToday.totalMinutes / 60).toFixed(1)}h</p>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="card-pad">
              <SectionHeader title="Task completion trend" />
              <div className="mt-3">
                {overview.trends.productivity.length === 0 ? (
                  <EmptyState compact title="No task completions in range" />
                ) : (
                  <BarChart data={overview.trends.productivity.map((point) => ({ label: point.date.slice(5), value: point.completed }))} height={180} />
                )}
              </div>
            </Card>
            <Card className="card-pad">
              <SectionHeader title="Department performance" />
              <div className="mt-3 overflow-x-auto">
                <table className="table-base">
                  <thead><tr><th>Department</th><th>Staff</th><th>Completion</th><th>Attendance</th><th>KPI</th></tr></thead>
                  <tbody>
                    {overview.departments.map((department) => (
                      <tr key={department.department}>
                        <td className="font-medium text-ink-800">{department.department}</td>
                        <td>{department.employees}</td>
                        <td>{department.completionRate !== null ? `${department.completionRate}%` : '—'}</td>
                        <td>{department.attendancePercent !== null ? `${department.attendancePercent}%` : '—'}</td>
                        <td>{department.averageKpi ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="card-pad lg:col-span-2">
              <SectionHeader title="Workload distribution" description="Open tasks and logged hours by employee" />
              <div className="mt-3 overflow-x-auto">
                <table className="table-base">
                  <thead><tr><th>Employee</th><th>Open tasks</th><th>Overdue</th><th>Hours logged</th></tr></thead>
                  <tbody>
                    {overview.workload.slice(0, 12).map((row) => (
                      <tr key={row.employeeId}>
                        <td className="font-medium text-ink-800">{row.name}</td>
                        <td>{row.openTasks}</td>
                        <td className={row.overdue > 0 ? 'font-medium text-red-600' : ''}>{row.overdue}</td>
                        <td>{row.hours}h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card className="card-pad">
              <SectionHeader title="Operational summary" />
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-ink-500">Tasks allocated</dt><dd className="font-semibold text-ink-900">{overview.tasks.allocated}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-500">Tasks completed</dt><dd className="font-semibold text-ink-900">{overview.tasks.completed}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-500">Tickets open</dt><dd className="font-semibold text-ink-900">{overview.tickets.open}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-500">SLA breached</dt><dd className="font-semibold text-red-600">{overview.tickets.breached}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-500">Meetings upcoming</dt><dd className="font-semibold text-ink-900">{overview.meetings.upcoming}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-500">Meetings held</dt><dd className="font-semibold text-ink-900">{overview.meetings.held}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-1.5">
                <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'tickets', format: 'csv' })}>Ticket report</button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'kpi', format: 'xlsx' })}>KPI report</button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'working_hours', format: 'xlsx', from: filters.from, to: filters.to })}>Working hours</button>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
