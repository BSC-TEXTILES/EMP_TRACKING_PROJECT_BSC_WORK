import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Modal, PageHeader, PriorityBadge, ProgressBar, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatTime } from '../lib/format';
import type { LeaveItem, MeetingSummary, TaskSummary } from '../lib/types';

interface Holiday {
  id: number;
  name: string;
  holiday_date: string;
  is_optional: number;
}

type View = 'month' | 'week' | 'day';

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Sunday = calendar weekly off. Parsed as UTC so the browser timezone never shifts the weekday. */
function isWeeklyOffDay(day: string) {
  return new Date(`${day}T00:00:00Z`).getUTCDay() === 0;
}

function iso(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export default function Calendar() {
  useDocumentTitle('Calendar');
  const toast = useToast();
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => iso(new Date()));
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [leaves, setLeaves] = useState<LeaveItem[]>([]);

  // Date Tasks Detail Modal state
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const [dayTasksLoading, setDayTasksLoading] = useState(false);
  const [taskSearch, setTaskSearch] = useState('');
  const [taskStatusFilter, setTaskStatusFilter] = useState<'all' | 'pending' | 'in_progress' | 'completed'>('all');

  const range = useMemo(() => {
    const base = startOfMonth(cursor);
    const gridStart = new Date(base);
    gridStart.setDate(base.getDate() - base.getDay());
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridStart.getDate() + 41);
    return { from: iso(gridStart), to: iso(gridEnd) };
  }, [cursor]);

  useEffect(() => {
    Promise.all([
      api.get<{ items: TaskSummary[] }>(`/tasks?view=all&dueFrom=${range.from}&dueTo=${range.to}&pageSize=500`),
      api.get<{ meetings: MeetingSummary[] }>(`/meetings?from=${range.from}&to=${range.to}`),
      api.get<{ holidays: Holiday[] }>(`/leave/holidays?from=${range.from}&to=${range.to}`),
      api.get<{ items: LeaveItem[] }>('/leave?scope=mine'),
    ])
      .then(([taskResult, meetingResult, holidayResult, leaveResult]) => {
        setTasks(taskResult.items);
        setMeetings(meetingResult.meetings);
        setHolidays(holidayResult.holidays);
        setLeaves(leaveResult.items);
      })
      .catch((caught) => toast.error(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  // Load all tasks for a specific clicked date to guarantee 100% full detail coverage
  const loadSpecificDayTasks = async (day: string) => {
    setDayTasksLoading(true);
    try {
      const res = await api.get<{ items: TaskSummary[] }>(`/tasks?view=all&dueFrom=${day}&dueTo=${day}&pageSize=500`);
      if (res?.items) {
        setTasks((prev) => {
          const others = (prev ?? []).filter((t) => t.dueDate !== day);
          return [...others, ...res.items];
        });
      }
    } catch {
      /* fallback to already loaded tasks */
    } finally {
      setDayTasksLoading(false);
    }
  };

  const handleOpenDayDetails = (day: string) => {
    setSelected(day);
    setTaskSearch('');
    setTaskStatusFilter('all');
    setDateModalOpen(true);
    void loadSpecificDayTasks(day);
  };

  const days = useMemo(() => {
    const list: string[] = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(`${range.from}T00:00:00`);
      date.setDate(date.getDate() + index);
      list.push(iso(date));
    }
    return list;
  }, [range.from]);

  const eventsFor = (day: string) => {
    const dayTasks = (tasks ?? []).filter((task) => task.dueDate === day);
    const dayMeetings = (meetings ?? []).filter((meeting) => meeting.startAt.slice(0, 10) === day);
    const holiday = holidays.find((item) => item.holiday_date === day);
    const weeklyOff = isWeeklyOffDay(day);
    // Sundays and holidays inside a leave range are not leave days (they are not charged).
    const leave = weeklyOff || holiday ? [] : leaves.filter((item) => item.status === 'approved' && item.startDate <= day && item.endDate >= day);
    const isHalfDay = leave.some((l) => (l as any).isHalfDay || (l as any).is_half_day || l.days === 0.5);
    return { dayTasks, dayMeetings, holiday, leave, weeklyOff, isHalfDay };
  };

  const weekDays = view === 'week' ? days.slice(days.indexOf(selected) - new Date(`${selected}T00:00:00`).getDay(), days.indexOf(selected) - new Date(`${selected}T00:00:00`).getDay() + 7) : [];
  const selectedEvents = eventsFor(selected);
  const monthLabel = cursor.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  // Filter tasks in the detailed view / modal
  const filteredDayTasks = useMemo(() => {
    let list = selectedEvents.dayTasks;
    if (taskStatusFilter === 'completed') {
      list = list.filter((t) => t.status === 'completed');
    } else if (taskStatusFilter === 'in_progress') {
      list = list.filter((t) => ['in_progress', 'accepted', 'started'].includes(t.status));
    } else if (taskStatusFilter === 'pending') {
      list = list.filter((t) => !['completed', 'cancelled', 'rejected'].includes(t.status));
    }

    if (taskSearch.trim()) {
      const query = taskSearch.toLowerCase().trim();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(query) ||
          t.taskNo.toLowerCase().includes(query) ||
          (t.description && t.description.toLowerCase().includes(query)) ||
          (t.assigneeNames && t.assigneeNames.toLowerCase().includes(query)) ||
          (t.projectName && t.projectName.toLowerCase().includes(query)) ||
          (t.departmentName && t.departmentName.toLowerCase().includes(query)) ||
          (t.category && t.category.toLowerCase().includes(query)),
      );
    }
    return list;
  }, [selectedEvents.dayTasks, taskStatusFilter, taskSearch]);

  const completedCount = selectedEvents.dayTasks.filter((t) => t.status === 'completed').length;
  const inProgressCount = selectedEvents.dayTasks.filter((t) => ['in_progress', 'accepted', 'started'].includes(t.status)).length;
  const pendingCount = selectedEvents.dayTasks.filter((t) => !['completed', 'cancelled', 'rejected'].includes(t.status)).length;

  const shift = (delta: number) => {
    if (view === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));
    else {
      const next = new Date(`${selected}T00:00:00`);
      next.setDate(next.getDate() + delta * (view === 'week' ? 7 : 1));
      setSelected(iso(next));
      setCursor(next);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Organisational calendar"
        description="Meetings, task deadlines, approved leave and holidays in one place."
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => shift(-1)} title="Previous">
              <Icon name="chevronLeft" size={15} />
            </button>
            <button type="button" className="btn-secondary btn-sm font-semibold" onClick={() => { setCursor(new Date()); setSelected(iso(new Date())); }}>
              Today
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => shift(1)} title="Next">
              <Icon name="chevronRight" size={15} />
            </button>
          </div>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-ink-900">{monthLabel}</h2>
            {selected && (
              <span className="text-xs text-ink-500 font-medium hidden sm:inline-block">
                · Selected: <strong className="text-brand-600">{formatDate(selected)}</strong>
              </span>
            )}
          </div>
          <Tabs
            tabs={[
              { value: 'month', label: 'Month' },
              { value: 'week', label: 'Week' },
              { value: 'day', label: 'Day' },
            ]}
            value={view}
            onChange={(value) => setView(value as View)}
          />
        </div>

        {!tasks || !meetings ? (
          <div className="p-4">
            <Skeleton lines={8} />
          </div>
        ) : view === 'month' ? (
          <div className="p-3">
            <div className="grid grid-cols-7 pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-400">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, idx) => (
                <span key={day} className={idx === 0 ? 'text-red-600 font-bold' : undefined}>{day}</span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {days.map((day) => {
                const { dayTasks, dayMeetings, holiday, leave, weeklyOff, isHalfDay } = eventsFor(day);
                const inMonth = day.slice(0, 7) === iso(cursor).slice(0, 7);
                const isSelected = selected === day;
                const isToday = day === iso(new Date());
                const totalEvents = dayMeetings.length + dayTasks.length;

                return (
                  <div
                    key={day}
                    onClick={() => handleOpenDayDetails(day)}
                    className={cx(
                      'group relative min-h-[96px] rounded-lg border p-1.5 text-left align-top transition-all cursor-pointer select-none',
                      isSelected
                        ? 'border-brand-500 bg-brand-50/50 shadow-sm ring-2 ring-brand-400/40'
                        : 'border-ink-100 bg-white hover:border-brand-300 hover:shadow-xs hover:bg-slate-50/70',
                      !inMonth && 'opacity-40 bg-slate-50/30',
                      isHalfDay && 'bg-orange-50/70 border-orange-200',
                      weeklyOff && !holiday && 'bg-red-50/60 border-red-200',
                      holiday && 'bg-violet-50/50',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={cx(
                          'text-xs font-semibold px-1 py-0.5 rounded transition',
                          isToday
                            ? 'bg-brand-600 text-white shadow-xs'
                            : isSelected
                            ? 'bg-brand-100 text-brand-800 font-bold'
                            : 'text-ink-700 group-hover:text-ink-900',
                        )}
                      >
                        {Number(day.slice(8, 10))}
                      </span>
                      {totalEvents > 0 && (
                        <span
                          className={cx(
                            'text-[10px] px-1 rounded-full font-bold',
                            isSelected ? 'bg-brand-200 text-brand-800' : 'bg-ink-100 text-ink-600 group-hover:bg-brand-100 group-hover:text-brand-700',
                          )}
                        >
                          {totalEvents}
                        </span>
                      )}
                    </div>

                    <div className="mt-1 space-y-0.5">
                      {weeklyOff && (
                        <p className="truncate rounded bg-red-100 px-1 py-0.5 text-[10px] font-semibold text-red-800">
                          Weekly off
                        </p>
                      )}
                      {isHalfDay && (
                        <p className="truncate rounded bg-orange-100 px-1 py-0.5 text-[10px] font-semibold text-orange-800">
                          Half day
                        </p>
                      )}
                      {holiday && (
                        <p className="truncate rounded bg-violet-100/90 px-1 py-0.5 text-[10px] font-semibold text-violet-800">
                          {holiday.name}
                        </p>
                      )}
                      {leave.length > 0 && (
                        <p className="truncate rounded bg-sky-100/90 px-1 py-0.5 text-[10px] font-semibold text-sky-800">
                          On leave ({leave.length})
                        </p>
                      )}
                      {dayMeetings.slice(0, 2).map((meeting) => (
                        <p
                          key={meeting.id}
                          className="truncate rounded bg-brand-100 px-1 py-0.5 text-[10px] font-medium text-brand-800 hover:bg-brand-200 transition"
                          title={`${formatTime(meeting.startAt)} ${meeting.title}`}
                        >
                          {formatTime(meeting.startAt)} {meeting.title}
                        </p>
                      ))}
                      {dayTasks.slice(0, 2).map((task) => (
                        <p
                          key={task.id}
                          className="truncate rounded bg-amber-100/90 border border-amber-200/50 px-1 py-0.5 text-[10px] font-medium text-amber-900 hover:bg-amber-200 transition"
                          title={task.title}
                        >
                          {task.title}
                        </p>
                      ))}
                      {totalEvents > 4 && (
                        <div
                          className="mt-0.5 flex items-center justify-between rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-700 hover:bg-brand-100 transition shadow-2xs"
                        >
                          <span>+{totalEvents - 4} more</span>
                          <span className="text-[9px] opacity-75">Click to view</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : view === 'week' ? (
          <div className="grid gap-2 p-3 sm:grid-cols-7">
            {weekDays.map((day) => {
              const { dayTasks, dayMeetings, holiday, weeklyOff, isHalfDay } = eventsFor(day);
              const isSelected = selected === day;
              return (
                <div
                  key={day}
                  onClick={() => handleOpenDayDetails(day)}
                  className={cx(
                    'rounded-lg border p-2 cursor-pointer transition hover:border-brand-300 hover:shadow-xs',
                    isSelected ? 'border-brand-400 bg-brand-50/30 ring-2 ring-brand-300/40' : 'border-ink-100 bg-white',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-ink-800">{formatDate(day)}</p>
                    <span className="text-[10px] text-ink-400 font-semibold">{dayTasks.length + dayMeetings.length} items</span>
                  </div>
                  {weeklyOff && <Badge tone="danger" className="mt-1 mr-1 bg-red-100 text-red-800 border-red-200">Weekly off</Badge>}
                  {isHalfDay && <Badge tone="warning" className="mt-1 mr-1 bg-orange-100 text-orange-800 border-orange-200">Half day</Badge>}
                  {holiday && <Badge tone="brand" className="mt-1">{holiday.name}</Badge>}
                  <div className="mt-2 space-y-1">
                    {dayMeetings.map((meeting) => (
                      <div key={meeting.id} className="block rounded bg-brand-50 px-1.5 py-1 text-[11px] text-brand-800 font-medium">
                        {formatTime(meeting.startAt)} · {meeting.title}
                      </div>
                    ))}
                    {dayTasks.map((task) => (
                      <div key={task.id} className="block rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-900 font-medium">
                        {task.title}
                      </div>
                    ))}
                    {dayMeetings.length + dayTasks.length === 0 && <p className="text-[11px] text-ink-400 py-2">No events scheduled</p>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-ink-100">
              <div>
                <h3 className="text-base font-bold text-ink-900">{formatDate(selected)}</h3>
                <p className="text-xs text-ink-500">Full task checklist, deadlines, and schedule for this day</p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  to={`/tasks?create=1&dueDate=${selected}`}
                  className="btn-primary btn-sm inline-flex items-center gap-1.5"
                >
                  <Icon name="plus" size={14} />
                  <span>Create Task on this Date</span>
                </Link>
              </div>
            </div>

            {selectedEvents.dayMeetings.length + selectedEvents.dayTasks.length + (selectedEvents.holiday ? 1 : 0) + selectedEvents.leave.length === 0 ? (
              <div className="py-12">
                <EmptyState
                  compact
                  title="Nothing scheduled on this date"
                  description="No meetings, task deadlines or leaves scheduled for this day."
                  action={
                    <Link to={`/tasks?create=1&dueDate=${selected}`} className="btn-primary btn-sm inline-flex items-center gap-1">
                      <Icon name="plus" size={14} />
                      <span>Create Task for this Date</span>
                    </Link>
                  }
                />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {selectedEvents.weeklyOff && (
                  <div className="flex items-center gap-2.5 rounded-xl bg-red-50 border border-red-200 p-3.5 text-sm text-red-800 font-semibold">
                    <Icon name="calendar" size={18} />
                    <span>Sunday weekly off</span>
                  </div>
                )}
                {selectedEvents.isHalfDay && (
                  <div className="flex items-center gap-2.5 rounded-xl bg-orange-50 border border-orange-200 p-3.5 text-sm text-orange-800 font-semibold">
                    <Icon name="clock" size={18} />
                    <span>Half day leave session</span>
                  </div>
                )}
                {selectedEvents.holiday && (
                  <div className="flex items-center gap-2.5 rounded-xl bg-violet-50 border border-violet-200 p-3.5 text-sm text-violet-800 font-semibold">
                    <Icon name="calendar" size={18} />
                    <span>Company Public Holiday: {selectedEvents.holiday.name}</span>
                  </div>
                )}
                {selectedEvents.leave.map((leave) => (
                  <div key={leave.id} className="flex items-center gap-2.5 rounded-xl bg-sky-50 border border-sky-200 p-3.5 text-sm text-sky-800 font-semibold">
                    <Icon name="leave" size={18} />
                    <span>On Leave · {leave.leaveType} ({formatDate(leave.startDate)} → {formatDate(leave.endDate)})</span>
                  </div>
                ))}

                {selectedEvents.dayMeetings.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-ink-400 flex items-center gap-1.5">
                      <Icon name="video" size={14} className="text-brand-600" />
                      <span>Meetings ({selectedEvents.dayMeetings.length})</span>
                    </h4>
                    {selectedEvents.dayMeetings.map((meeting) => (
                      <div key={meeting.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 bg-white p-3.5 shadow-2xs hover:border-brand-300 transition">
                        <div>
                          <p className="text-sm font-bold text-ink-900">{meeting.title}</p>
                          <p className="text-xs text-ink-500 mt-0.5">
                            {formatTime(meeting.startAt)} – {formatTime(meeting.endAt)} · Organizer: <strong>{meeting.organizerName}</strong> · <StatusBadge status={meeting.status} />
                          </p>
                        </div>
                        <Link to={`/meetings/${meeting.id}/room`} className="btn-secondary btn-sm inline-flex items-center gap-1 font-semibold text-brand-600">
                          <Icon name="video" size={14} />
                          <span>Join Meeting Room</span>
                        </Link>
                      </div>
                    ))}
                  </div>
                )}

                {selectedEvents.dayTasks.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-ink-400 flex items-center gap-1.5">
                      <Icon name="tasks" size={14} className="text-amber-600" />
                      <span>Tasks Due on this Date ({selectedEvents.dayTasks.length})</span>
                    </h4>
                    {selectedEvents.dayTasks.map((task) => (
                      <div key={task.id} className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs hover:border-brand-400 transition space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold bg-ink-100 text-ink-700 px-2 py-0.5 rounded">
                              #{task.taskNo}
                            </span>
                            <PriorityBadge priority={task.priority} />
                            <StatusBadge status={task.status} />
                            {task.dueTime && (
                              <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 font-medium px-2 py-0.5 rounded-full">
                                <Icon name="clock" size={12} />
                                <span>Due {task.dueTime.slice(0, 5)}</span>
                              </span>
                            )}
                          </div>
                          <Link
                            to={`/tasks?task=${task.id}`}
                            className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold text-brand-600 hover:text-brand-700 hover:bg-brand-50"
                          >
                            <Icon name="tasks" size={13} />
                            <span>Open Task</span>
                          </Link>
                        </div>

                        <div>
                          <h5 className="text-sm font-bold text-ink-900 leading-snug">{task.title}</h5>
                          {task.description && (
                            <p className="text-xs text-ink-600 mt-1 line-clamp-2 bg-ink-50/70 p-2 rounded-lg border border-ink-100">
                              {task.description}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-ink-500 border-t border-ink-100">
                          <div className="flex items-center gap-2">
                            {task.assigneeNames ? (
                              <span>Assignees: <strong className="text-ink-800">{task.assigneeNames}</strong></span>
                            ) : (
                              <span>Unassigned</span>
                            )}
                            {task.projectName && (
                              <span className="rounded bg-brand-50 px-1.5 py-0.5 text-brand-700 font-medium text-[11px]">
                                {task.projectName}
                              </span>
                            )}
                          </div>
                          {task.progress > 0 && (
                            <div className="flex items-center gap-2 w-32">
                              <ProgressBar value={task.progress} tone={task.progress === 100 ? 'success' : 'brand'} />
                              <span className="text-[11px] font-bold text-ink-700">{task.progress}%</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-3 border-t border-ink-100 px-4 py-2.5 text-[11px] text-ink-500 bg-slate-50/40">
          <span className="flex items-center gap-1 font-medium"><span className="h-2 w-2 rounded bg-brand-400" /> Meeting</span>
          <span className="flex items-center gap-1 font-medium"><span className="h-2 w-2 rounded bg-amber-400" /> Task deadline</span>
          <span className="flex items-center gap-1 font-medium"><span className="h-2 w-2 rounded bg-emerald-400" /> Weekly off (Sunday)</span>
          <span className="flex items-center gap-1 font-medium"><span className="h-2 w-2 rounded bg-violet-400" /> Holiday</span>
          <span className="flex items-center gap-1 font-medium"><span className="h-2 w-2 rounded bg-sky-400" /> Leave</span>
          <span className="ml-auto text-ink-400 italic">💡 Tip: Click any date cell or "+X more" to inspect full task details</span>
        </div>
      </Card>

      {/* Selected Day Quick Inspector (Persistent below Month calendar) */}
      {view === 'month' && selected && (
        <Card className="card-pad space-y-3.5 border-brand-200 bg-gradient-to-br from-white via-slate-50/40 to-brand-50/20">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-ink-100">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-600 text-white font-bold text-xs">
                  {Number(selected.slice(8, 10))}
                </span>
                <h3 className="text-base font-bold text-ink-900">
                  Full Tasks & Schedule for {formatDate(selected)}
                </h3>
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                {selectedEvents.dayTasks.length} task{selectedEvents.dayTasks.length === 1 ? '' : 's'} · {selectedEvents.dayMeetings.length} meeting{selectedEvents.dayMeetings.length === 1 ? '' : 's'} on this date
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDateModalOpen(true)}
                className="btn-secondary btn-sm inline-flex items-center gap-1 font-semibold cursor-pointer"
              >
                <Icon name="tasks" size={14} />
                <span>Open in Fullscreen Window ({selectedEvents.dayTasks.length})</span>
              </button>
              <Link
                to={`/tasks?create=1&dueDate=${selected}`}
                className="btn-primary btn-sm inline-flex items-center gap-1 font-semibold"
              >
                <Icon name="plus" size={14} />
                <span>Add Task</span>
              </Link>
            </div>
          </div>

          {selectedEvents.dayTasks.length === 0 && selectedEvents.dayMeetings.length === 0 ? (
            <p className="text-xs text-ink-400 py-3 italic">
              No tasks or meetings scheduled on this date. Click "Add Task" to create one.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 pt-1">
              {selectedEvents.dayTasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded-lg border border-ink-200 bg-white p-3 hover:border-brand-400 hover:shadow-xs transition flex flex-col justify-between gap-2"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono text-[10px] font-bold bg-ink-100 px-1.5 py-0.5 rounded text-ink-700">
                        #{task.taskNo}
                      </span>
                      <div className="flex items-center gap-1">
                        <PriorityBadge priority={task.priority} />
                        <StatusBadge status={task.status} />
                      </div>
                    </div>
                    <h5 className="text-xs font-bold text-ink-900 line-clamp-2 mt-1">{task.title}</h5>
                    {task.description && (
                      <p className="text-[11px] text-ink-500 line-clamp-2">{task.description}</p>
                    )}
                  </div>
                  <div className="flex items-center justify-between border-t border-ink-100 pt-1.5 text-[11px] text-ink-500">
                    <span className="truncate max-w-[120px] font-medium text-ink-700">
                      {task.assigneeNames || 'Unassigned'}
                    </span>
                    <Link
                      to={`/tasks?task=${task.id}`}
                      className="font-semibold text-brand-600 hover:text-brand-800 text-[11px]"
                    >
                      View Details →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* FULL DATE TASK DETAILS MODAL (Opens immediately when user clicks any date) */}
      <Modal
        open={dateModalOpen}
        onClose={() => setDateModalOpen(false)}
        title={`Full Task Details · ${formatDate(selected)}`}
        description={`Complete breakdown of all work items, deadlines, checklists and schedule for ${formatDate(selected)}.`}
        size="xl"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-xs text-ink-500">
              Showing <strong>{filteredDayTasks.length}</strong> of <strong>{selectedEvents.dayTasks.length}</strong> total tasks
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setDateModalOpen(false)}
              >
                Close
              </button>
              <Link
                to={`/tasks?create=1&dueDate=${selected}`}
                className="btn-primary btn-sm inline-flex items-center gap-1.5"
              >
                <Icon name="plus" size={14} />
                <span>Create New Task</span>
              </Link>
            </div>
          </div>
        }
      >
        <div className="space-y-4 py-1">
          {/* Top Status & Context Banners */}
          {selectedEvents.weeklyOff && (
            <div className="flex items-center gap-2.5 rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-800 font-semibold">
              <Icon name="calendar" size={16} />
              <span>Sunday weekly off</span>
            </div>
          )}
          {selectedEvents.isHalfDay && (
            <div className="flex items-center gap-2.5 rounded-xl bg-orange-50 border border-orange-200 p-3 text-xs text-orange-800 font-semibold">
              <Icon name="clock" size={16} />
              <span>Half day leave session</span>
            </div>
          )}
          {selectedEvents.holiday && (
            <div className="flex items-center gap-2.5 rounded-xl bg-violet-50 border border-violet-200 p-3 text-xs text-violet-800 font-semibold">
              <Icon name="calendar" size={16} />
              <span>Public Holiday: <strong>{selectedEvents.holiday.name}</strong></span>
            </div>
          )}

          {selectedEvents.leave.length > 0 && (
            <div className="flex items-center gap-2.5 rounded-xl bg-sky-50 border border-sky-200 p-3 text-xs text-sky-800 font-semibold">
              <Icon name="leave" size={16} />
              <span>On Approved Leave: {selectedEvents.leave[0].leaveType} ({formatDate(selectedEvents.leave[0].startDate)} to {formatDate(selectedEvents.leave[0].endDate)})</span>
            </div>
          )}

          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-ink-200 bg-white p-3 text-center shadow-2xs">
              <p className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Total Tasks</p>
              <p className="text-xl font-bold text-ink-900 mt-0.5">{selectedEvents.dayTasks.length}</p>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 text-center shadow-2xs">
              <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Completed</p>
              <p className="text-xl font-bold text-emerald-900 mt-0.5">{completedCount}</p>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3 text-center shadow-2xs">
              <p className="text-[10px] font-bold uppercase tracking-wider text-blue-700">In Progress</p>
              <p className="text-xl font-bold text-blue-900 mt-0.5">{inProgressCount}</p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 text-center shadow-2xs">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Pending</p>
              <p className="text-xl font-bold text-amber-900 mt-0.5">{pendingCount}</p>
            </div>
          </div>

          {/* Search & Filter Controls */}
          <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between pt-1">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-ink-400">
                <Icon name="search" size={14} />
              </span>
              <input
                type="text"
                className="input input-sm pl-8 font-medium w-full"
                placeholder="Search tasks by title, code, assignee, project..."
                value={taskSearch}
                onChange={(e) => setTaskSearch(e.target.value)}
              />
              {taskSearch && (
                <button
                  type="button"
                  onClick={() => setTaskSearch('')}
                  className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-ink-400 hover:text-ink-600"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1 bg-ink-100 p-0.5 rounded-lg text-xs font-semibold shrink-0">
              <button
                type="button"
                onClick={() => setTaskStatusFilter('all')}
                className={cx('px-2.5 py-1 rounded-md transition', taskStatusFilter === 'all' ? 'bg-white text-ink-900 shadow-xs' : 'text-ink-600 hover:text-ink-900')}
              >
                All ({selectedEvents.dayTasks.length})
              </button>
              <button
                type="button"
                onClick={() => setTaskStatusFilter('pending')}
                className={cx('px-2.5 py-1 rounded-md transition', taskStatusFilter === 'pending' ? 'bg-white text-ink-900 shadow-xs' : 'text-ink-600 hover:text-ink-900')}
              >
                Pending ({pendingCount})
              </button>
              <button
                type="button"
                onClick={() => setTaskStatusFilter('in_progress')}
                className={cx('px-2.5 py-1 rounded-md transition', taskStatusFilter === 'in_progress' ? 'bg-white text-ink-900 shadow-xs' : 'text-ink-600 hover:text-ink-900')}
              >
                In Progress ({inProgressCount})
              </button>
              <button
                type="button"
                onClick={() => setTaskStatusFilter('completed')}
                className={cx('px-2.5 py-1 rounded-md transition', taskStatusFilter === 'completed' ? 'bg-white text-ink-900 shadow-xs' : 'text-ink-600 hover:text-ink-900')}
              >
                Completed ({completedCount})
              </button>
            </div>
          </div>

          {/* Task Items List */}
          {dayTasksLoading ? (
            <div className="py-8">
              <Skeleton lines={6} />
            </div>
          ) : filteredDayTasks.length === 0 ? (
            <div className="py-10 text-center rounded-xl border border-dashed border-ink-200 bg-ink-50/50">
              <Icon name="tasks" size={32} className="mx-auto text-ink-300 mb-2" />
              <p className="text-sm font-semibold text-ink-700">No tasks match your filters</p>
              <p className="text-xs text-ink-500 mt-0.5">
                {taskSearch || taskStatusFilter !== 'all'
                  ? 'Try clearing the search query or status filter.'
                  : 'There are no tasks due on this date.'}
              </p>
            </div>
          ) : (
            <div className="max-h-[55vh] overflow-y-auto space-y-3 pr-1 scroll-area">
              {filteredDayTasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs hover:border-brand-400 hover:shadow-xs transition space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-bold bg-ink-100 text-ink-800 px-2 py-0.5 rounded border border-ink-200/60">
                        #{task.taskNo}
                      </span>
                      <PriorityBadge priority={task.priority} />
                      <StatusBadge status={task.status} />
                      {task.category && (
                        <span className="text-[11px] font-medium bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">
                          {task.category}
                        </span>
                      )}
                      {task.dueTime && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-800 bg-amber-50 border border-amber-200 font-semibold px-2 py-0.5 rounded-full">
                          <Icon name="clock" size={12} />
                          <span>Due {task.dueTime.slice(0, 5)}</span>
                        </span>
                      )}
                    </div>

                    <Link
                      to={`/tasks?task=${task.id}`}
                      className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold !text-brand-700 !border-brand-200 hover:!bg-brand-50 cursor-pointer"
                    >
                      <Icon name="tasks" size={13} />
                      <span>Open Task Details →</span>
                    </Link>
                  </div>

                  <div>
                    <h4 className="text-sm font-bold text-ink-900 leading-snug">
                      {task.title}
                    </h4>
                    {task.description && (
                      <div className="mt-1.5 rounded-lg bg-ink-50/70 p-2.5 text-xs text-ink-700 border border-ink-100/80 whitespace-pre-wrap leading-relaxed">
                        {task.description}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-ink-100 text-xs text-ink-600">
                    <div className="flex items-center gap-3">
                      {task.assigneeNames ? (
                        <span className="flex items-center gap-1">
                          <Avatar name={task.assigneeNames} size={20} />
                          <span>Assignee: <strong className="text-ink-800">{task.assigneeNames}</strong></span>
                        </span>
                      ) : (
                        <span className="text-ink-400 italic">Unassigned</span>
                      )}

                      {task.projectName && (
                        <span className="rounded bg-brand-50 px-2 py-0.5 text-brand-700 font-medium text-[11px] border border-brand-100">
                          📁 {task.projectName}
                        </span>
                      )}

                      {task.departmentName && (
                        <span className="text-ink-400 text-[11px]">
                          Dept: {task.departmentName}
                        </span>
                      )}
                    </div>

                    {task.progress > 0 && (
                      <div className="flex items-center gap-2 w-32">
                        <ProgressBar value={task.progress} tone={task.progress === 100 ? 'success' : 'brand'} />
                        <span className="text-[11px] font-bold text-ink-800">{task.progress}%</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Meetings for this day in the modal */}
          {selectedEvents.dayMeetings.length > 0 && (
            <div className="pt-3 border-t border-ink-200 space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-400 flex items-center gap-1.5">
                <Icon name="video" size={14} className="text-brand-600" />
                <span>Scheduled Meetings on this Date ({selectedEvents.dayMeetings.length})</span>
              </h4>
              <div className="grid gap-2 sm:grid-cols-2">
                {selectedEvents.dayMeetings.map((meeting) => (
                  <div key={meeting.id} className="rounded-xl border border-ink-200 bg-white p-3 flex items-center justify-between gap-2 shadow-2xs">
                    <div>
                      <p className="text-xs font-bold text-ink-900 line-clamp-1">{meeting.title}</p>
                      <p className="text-[11px] text-ink-500 mt-0.5">
                        {formatTime(meeting.startAt)} – {formatTime(meeting.endAt)} · {meeting.organizerName}
                      </p>
                    </div>
                    <Link to={`/meetings/${meeting.id}/room`} className="btn-secondary btn-xs shrink-0 font-semibold text-brand-600">
                      Join
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
