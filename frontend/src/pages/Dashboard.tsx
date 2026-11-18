import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useApi, useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { useAttendance } from '../lib/useAttendance';
import { AttendanceTimer } from '../components/AttendanceTimer';
import { Avatar, Badge, Card, EmptyState, ProgressBar, SectionHeader, Skeleton, StatCard, StatusBadge } from '../components/ui';
import { BarChart, Donut } from '../components/Charts';
import { Icon } from '../components/icons';
import { formatDate, formatTime, minutesToHours, titleize, weekday } from '../lib/format';
import type { DashboardData } from '../lib/types';

interface TeamSnapshot {
  size: number;
  checkedIn: number;
  onLeave: number;
  overdueTasks: number;
  pendingApprovals: number;
  reportsPending: number;
}

export default function Dashboard() {
  useDocumentTitle('Dashboard');
  const { user, has, canAny } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi<DashboardData>('/me/dashboard');
  const attendance = useAttendance({ poll: true });
  const [team, setTeam] = useState<TeamSnapshot | null>(null);
  const [groupSummary, setGroupSummary] = useState<Array<{
    groupId: number;
    groupName: string;
    groupCode: string;
    total: number;
    present: number;
  }>>([]);
  const [dashboardLocationId, setDashboardLocationId] = useState<number | null>(user?.locationId ?? null);

  const isManager = canAny('employees.view.team', 'tasks.view.team', 'reports.view.team');

  useEffect(() => {
    if (!isManager) return;
    api
      .get<TeamSnapshot>('/me/team-snapshot')
      .then(setTeam)
      .catch(() => undefined);
  }, [isManager]);

  useEffect(() => {
    const locParam = dashboardLocationId ? `?locationId=${dashboardLocationId}` : '';
    api.get<{ summary: { groupBreakdown: Array<{ groupId: number; groupName: string; groupCode: string; total: number; present: number }> } }>(
      `/groups/dashboard/summary${locParam}`,
    )
      .then((res) => setGroupSummary(res.summary?.groupBreakdown ?? []))
      .catch(() => setGroupSummary([]));
  }, [dashboardLocationId]);

  useSocketEvent('task:updated', () => void reload());
  useSocketEvent('task:created', () => void reload());
  useSocketEvent('attendance:update', () => void attendance.refresh());
  useSocketEvent('report:updated', () => void reload());

  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  const submitReport = async () => {
    try {
      const suggestions = await api.get<{
        tasksCompleted: number;
        tasksInProgress: number;
        tasksPending: number;
        attendance: { check_in_at: string | null; check_out_at: string | null; total_minutes: number } | null;
      }>('/reports/suggestions');
      const summary = window.prompt('Describe the work you completed today (min 10 characters):');
      if (!summary) return;
      await api.post('/reports', {
        reportDate: new Date().toISOString().slice(0, 10),
        summary,
        tasksCompleted: suggestions.tasksCompleted,
        tasksInProgress: suggestions.tasksInProgress,
        tasksPending: suggestions.tasksPending,
        totalMinutes: suggestions.attendance?.total_minutes ?? attendance.state?.elapsedSeconds ? Math.round((attendance.state?.elapsedSeconds ?? 0) / 60) : 0,
      });
      toast.success('Daily report submitted for review.');
      void reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton lines={3} />
        <div className="card p-5">
          <Skeleton lines={6} />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card className="card-pad">
        <EmptyState title="Dashboard could not load" description={error} action={<button className="btn-primary" onClick={() => void reload()}>Retry</button>} />
      </Card>
    );
  }

  if (!data) return null;

  const attendanceSegments = [
    { label: 'Present', value: data.attendanceSummary.breakdown.find((b) => b.status === 'present')?.count ?? 0, color: '#059669' },
    { label: 'Late', value: data.attendanceSummary.breakdown.find((b) => b.status === 'late')?.count ?? 0, color: '#d97706' },
    { label: 'Half day', value: data.attendanceSummary.breakdown.find((b) => b.status === 'half_day')?.count ?? 0, color: '#ea8c00' },
    { label: 'Leave', value: data.attendanceSummary.breakdown.find((b) => b.status === 'on_leave')?.count ?? 0, color: '#0284c7' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Avatar name={data.employee.name} src={data.employee.photoUrl} size={52} />
          <div>
            <h1 className="text-xl font-semibold text-ink-900 sm:text-2xl">
              {greeting}, {data.employee.name.split(' ')[0]}
            </h1>
            <p className="text-sm text-ink-500">
              {data.employee.designation} · {data.employee.department} · {formatDate(new Date().toISOString())}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {user?.allowedLocations && user.allowedLocations.length > 1 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs shadow-2xs">
              <Icon name="building" size={13} className="text-blue-600" />
              <select
                className="bg-transparent font-semibold text-ink-800 outline-none cursor-pointer"
                value={dashboardLocationId ?? ''}
                onChange={(e) => setDashboardLocationId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">All Stores</option>
                {user.allowedLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} – {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {user?.locationCode && (
            <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700 border border-blue-200">
              <Icon name="building" size={12} />
              {user.locationCode}
            </span>
          )}
          {data.employee.manager && <Badge tone="neutral">Reports to {data.employee.manager}</Badge>}
          <Badge tone="brand">{titleize(data.employee.employmentType)}</Badge>
          <Link to="/profile" className="btn-secondary btn-sm">
            My profile
          </Link>
        </div>
      </div>

      {data.today.isHoliday && (
        <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-800">
          Today is a company holiday — {data.today.holidayName}. Attendance is not required.
        </div>
      )}

      <AttendanceTimer
        state={attendance.state ?? data.today.attendance}
        loading={attendance.loading}
        pending={attendance.pending}
        onAction={attendance.act}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active tasks"
          value={data.tasks.active}
          hint={`${data.tasks.completedThisMonth} completed this month`}
          icon={<Icon name="tasks" size={18} />}
          onClick={() => navigate('/tasks?view=mine')}
        />
        <StatCard
          label="Pending approvals"
          value={data.tasks.awaitingApproval}
          hint="Submitted work awaiting manager review"
          tone="warning"
          icon={<Icon name="check" size={18} />}
          onClick={() => navigate('/tasks?status=pending_approval')}
        />
        <StatCard
          label="Overdue"
          value={data.tasks.overdue}
          hint="Past due date and not completed"
          tone="danger"
          icon={<Icon name="clock" size={18} />}
          onClick={() => navigate('/tasks?overdue=true')}
        />
        <StatCard
          label="Unread messages"
          value={data.unreadChat}
          hint={`${data.unreadNotifications} unread notification(s)`}
          tone="neutral"
          icon={<Icon name="chat" size={18} />}
          onClick={() => navigate('/chat')}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="card-pad lg:col-span-2">
          <SectionHeader
            title="Weekly working hours"
            description="Hours recorded from server-timestamped attendance"
            action={<Link to="/attendance" className="btn-ghost btn-sm">View attendance</Link>}
          />
          <div className="mt-4">
            <BarChart
              data={data.weeklyHours.map((item) => ({ label: weekday(item.date), value: item.hours }))}
              suffix="h"
              height={170}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-500">
            <span>Total this week: <strong className="text-ink-800">{data.weeklyHours.reduce((sum, item) => sum + item.hours, 0).toFixed(1)}h</strong></span>
            <span>Average/day: <strong className="text-ink-800">{minutesToHours(data.attendanceSummary.averageMinutesPerDay)}</strong></span>
          </div>
        </Card>

        <Card className="card-pad">
          <SectionHeader title="Monthly attendance" description={`Period ${data.attendanceSummary.period}`} />
          <div className="mt-3">
            <Donut
              segments={attendanceSegments}
              centerValue={`${data.attendanceSummary.attendancePercent}%`}
              centerLabel="Attendance"
              size={124}
            />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-ink-50 p-2">
              <dt className="text-ink-500">Present days</dt>
              <dd className="font-semibold text-ink-900">{data.attendanceSummary.presentDays}</dd>
            </div>
            <div className="rounded-lg bg-ink-50 p-2">
              <dt className="text-ink-500">Late days</dt>
              <dd className="font-semibold text-ink-900">{data.attendanceSummary.lateDays}</dd>
            </div>
            <div className="rounded-lg bg-ink-50 p-2">
              <dt className="text-ink-500">Leave days</dt>
              <dd className="font-semibold text-ink-900">{data.attendanceSummary.onLeaveDays}</dd>
            </div>
            <div className="rounded-lg bg-ink-50 p-2">
              <dt className="text-ink-500">Hours logged</dt>
              <dd className="font-semibold text-ink-900">{minutesToHours(data.attendanceSummary.totalMinutes)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="card-pad">
          <SectionHeader
            title="Performance"
            description={data.kpi ? `${data.kpi.period} evaluation` : 'Monthly KPI'}
            action={<Link to="/kpi" className="btn-ghost btn-sm">Details</Link>}
          />
          {data.kpi ? (
            <div className="mt-4">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-4xl font-semibold text-ink-900">{data.kpi.score.toFixed(1)}<span className="text-lg text-ink-400">/100</span></p>
                  <Badge className={`mt-2 ${data.kpi.category === 'Excellent' ? 'bg-emerald-100 text-emerald-700' : 'bg-brand-100 text-brand-700'}`}>{data.kpi.category}</Badge>
                </div>
                <StatusBadge status={data.kpi.status} />
              </div>
              <div className="mt-4">
                <ProgressBar value={data.kpi.score} label="Weighted KPI score" />
              </div>
              <p className="mt-3 text-xs text-ink-500">
                Scores are computed from tasks, attendance, reporting discipline and collaboration, then reviewed by your manager before publishing.
              </p>
            </div>
          ) : (
            <EmptyState compact title="No evaluation yet" description="Your first monthly KPI will appear after the evaluation cycle closes." />
          )}
        </Card>

        <Card className="card-pad">
          <SectionHeader
            title="Upcoming meetings"
            action={<Link to="/meetings" className="btn-ghost btn-sm">All meetings</Link>}
          />
          <div className="mt-3 space-y-2">
            {data.meetings.length === 0 ? (
              <EmptyState compact title="No upcoming meetings" description="Schedule a meeting from the calendar." />
            ) : (
              data.meetings.map((meeting) => (
                <div key={meeting.id} className="flex items-start gap-3 rounded-lg border border-ink-200 p-3">
                  <div className="flex h-9 w-9 flex-col items-center justify-center rounded-lg bg-brand-50 text-[10px] font-semibold text-brand-700">
                    <span>{new Date(meeting.startAt).getDate()}</span>
                    <span className="uppercase">{new Date(meeting.startAt).toLocaleString('en-GB', { month: 'short' })}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-800">{meeting.title}</p>
                    <p className="text-xs text-ink-500">
                      {formatTime(meeting.startAt)} – {formatTime(meeting.endAt)} · {meeting.organizerName}
                    </p>
                  </div>
                  <Link to={`/meetings/${meeting.id}/room`} className="btn-secondary btn-sm">
                    Join
                  </Link>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="card-pad">
          <SectionHeader title="Daily work report" description="Submitted before you sign off" />
          <div className="mt-4">
            {data.today.report ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <StatusBadge status={data.today.report.status} />
                  <span className="text-xs text-ink-500">{formatTime(data.today.report.submittedAt)}</span>
                </div>
                <p className="line-clamp-3 text-sm text-ink-600">{data.today.report.summary}</p>
                <Link to="/reports" className="btn-secondary btn-sm w-full">
                  Open report
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink-500">
                  You have not submitted today&apos;s report yet. Managers use it to compare planned versus delivered work.
                </p>
                <button type="button" className="btn-primary w-full" onClick={() => void submitReport()}>
                  <Icon name="report" size={16} /> Submit daily report
                </button>
              </div>
            )}
          </div>
          <div className="mt-4 border-t border-ink-100 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Quick links</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Link to="/tasks" className="btn-secondary btn-sm">Tasks</Link>
              <Link to="/chat" className="btn-secondary btn-sm">Messages</Link>
              <Link to="/tickets" className="btn-secondary btn-sm">Raise ticket</Link>
              <Link to="/leave" className="btn-secondary btn-sm">Apply leave</Link>
            </div>
          </div>
        </Card>
      </div>

      {isManager && team && (
        <Card className="card-pad">
          <SectionHeader
            title="My team today"
            description={`${team.size} direct and indirect reports`}
            action={<Link to="/attendance?tab=team" className="btn-ghost btn-sm">Team attendance</Link>}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              { label: 'Checked in', value: team.checkedIn, tone: 'success' as const },
              { label: 'On leave', value: team.onLeave, tone: 'brand' as const },
              { label: 'Overdue tasks', value: team.overdueTasks, tone: 'danger' as const },
              { label: 'Approvals waiting', value: team.pendingApprovals, tone: 'warning' as const },
              { label: 'Reports to review', value: team.reportsPending, tone: 'neutral' as const },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-ink-200 p-3">
                <p className="text-xs text-ink-500">{item.label}</p>
                <p className="mt-1 text-2xl font-semibold text-ink-900">{item.value}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {has('tasks.create') && (
              <Link to="/tasks?create=1" className="btn-primary btn-sm">
                <Icon name="plus" size={14} /> Allocate task
              </Link>
            )}
            {has('reports.review') && (
              <Link to="/reports?tab=team" className="btn-secondary btn-sm">
                Review reports
              </Link>
            )}
            {has('kpi.view.team') && (
              <Link to="/kpi?tab=team" className="btn-secondary btn-sm">
                Team performance
              </Link>
            )}
          </div>
        </Card>
      )}

      {groupSummary.length > 0 && (
        <Card className="card-pad">
          <SectionHeader
            title="Workforce Groups & Presence"
            description="Active shift breakdown across floor sales, cashiering, and inventory teams"
            action={
              <Link to="/groups" className="btn-ghost btn-sm font-semibold text-blue-700">
                Manage Groups <Icon name="chevronRight" size={13} className="ml-1 inline" />
              </Link>
            }
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {groupSummary.map((grp) => {
              const pct = grp.total > 0 ? Math.round((grp.present / grp.total) * 100) : 0;
              return (
                <div key={grp.groupId} className="rounded-xl border border-ink-200 bg-white p-3.5 shadow-2xs">
                  <div className="flex items-center justify-between gap-1 mb-1.5">
                    <span className="font-mono text-[10px] uppercase font-bold text-blue-700 bg-blue-50 px-1.5 py-0.2 rounded border border-blue-200">
                      {grp.groupCode}
                    </span>
                    <span className="text-xs font-semibold text-emerald-700">
                      {grp.present} / {grp.total} present
                    </span>
                  </div>
                  <p className="text-sm font-bold text-ink-900 truncate">{grp.groupName}</p>
                  <div className="mt-2.5">
                    <div className="flex items-center justify-between text-[11px] text-ink-500 mb-1">
                      <span>Shift Attendance</span>
                      <span className="font-semibold">{pct}%</span>
                    </div>
                    <ProgressBar value={pct} tone={pct >= 70 ? 'success' : pct >= 40 ? 'warning' : 'danger'} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
