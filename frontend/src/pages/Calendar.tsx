import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, PageHeader, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
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
      api.get<{ items: TaskSummary[] }>('/tasks?view=all&pageSize=100'),
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
    const leave = leaves.filter((item) => item.status === 'approved' && item.startDate <= day && item.endDate >= day);
    return { dayTasks, dayMeetings, holiday, leave };
  };

  const weekDays = view === 'week' ? days.slice(days.indexOf(selected) - new Date(`${selected}T00:00:00`).getDay(), days.indexOf(selected) - new Date(`${selected}T00:00:00`).getDay() + 7) : [];
  const selectedEvents = eventsFor(selected);
  const monthLabel = cursor.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

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
            <button type="button" className="btn-secondary btn-sm" onClick={() => shift(-1)}>
              <Icon name="chevronLeft" size={15} />
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setCursor(new Date()); setSelected(iso(new Date())); }}>
              Today
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => shift(1)}>
              <Icon name="chevronRight" size={15} />
            </button>
          </div>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
          <h2 className="text-sm font-semibold text-ink-900">{monthLabel}</h2>
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
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {days.map((day) => {
                const { dayTasks, dayMeetings, holiday, leave } = eventsFor(day);
                const inMonth = day.slice(0, 7) === iso(cursor).slice(0, 7);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setSelected(day)}
                    className={cx(
                      'min-h-[86px] rounded-lg border p-1.5 text-left align-top transition',
                      selected === day ? 'border-brand-500 bg-brand-50/50' : 'border-ink-100 hover:border-brand-200',
                      !inMonth && 'opacity-40',
                      holiday && 'bg-violet-50/70',
                    )}
                  >
                    <span className={cx('text-xs font-semibold', day === iso(new Date()) ? 'rounded bg-brand-600 px-1 text-white' : 'text-ink-700')}>
                      {Number(day.slice(8, 10))}
                    </span>
                    <div className="mt-1 space-y-0.5">
                      {holiday && <p className="truncate rounded bg-violet-100 px-1 text-[10px] text-violet-700">{holiday.name}</p>}
                      {leave.length > 0 && <p className="truncate rounded bg-sky-100 px-1 text-[10px] text-sky-700">On leave</p>}
                      {dayMeetings.slice(0, 2).map((meeting) => (
                        <p key={meeting.id} className="truncate rounded bg-brand-100 px-1 text-[10px] text-brand-800">
                          {formatTime(meeting.startAt)} {meeting.title}
                        </p>
                      ))}
                      {dayTasks.slice(0, 2).map((task) => (
                        <p key={task.id} className="truncate rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                          {task.title}
                        </p>
                      ))}
                      {(dayMeetings.length + dayTasks.length) > 4 && (
                        <p className="text-[10px] text-ink-400">+{dayMeetings.length + dayTasks.length - 4} more</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : view === 'week' ? (
          <div className="grid gap-2 p-3 sm:grid-cols-7">
            {weekDays.map((day) => {
              const { dayTasks, dayMeetings, holiday } = eventsFor(day);
              return (
                <div key={day} className={cx('rounded-lg border p-2', selected === day ? 'border-brand-400' : 'border-ink-100')}>
                  <p className="text-xs font-semibold text-ink-700">{formatDate(day)}</p>
                  {holiday && <Badge tone="brand">{holiday.name}</Badge>}
                  <div className="mt-1 space-y-1">
                    {dayMeetings.map((meeting) => (
                      <Link key={meeting.id} to={`/meetings/${meeting.id}/room`} className="block rounded bg-brand-50 px-1.5 py-1 text-[11px] text-brand-800">
                        {formatTime(meeting.startAt)} · {meeting.title}
                      </Link>
                    ))}
                    {dayTasks.map((task) => (
                      <Link key={task.id} to={`/tasks?task=${task.id}`} className="block rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-800">
                        {task.title}
                      </Link>
                    ))}
                    {dayMeetings.length + dayTasks.length === 0 && <p className="text-[11px] text-ink-400">No events</p>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-4">
            <SectionHeader title={formatDate(selected)} description="Everything scheduled for this day" />
            {selectedEvents.dayMeetings.length + selectedEvents.dayTasks.length + (selectedEvents.holiday ? 1 : 0) + selectedEvents.leave.length === 0 ? (
              <EmptyState compact title="Nothing scheduled" description="No meetings, deadlines or leave on this day." />
            ) : (
              <div className="mt-3 space-y-2">
                {selectedEvents.holiday && <div className="rounded-lg bg-violet-50 p-3 text-sm text-violet-800">Holiday · {selectedEvents.holiday.name}</div>}
                {selectedEvents.leave.map((leave) => (
                  <div key={leave.id} className="rounded-lg bg-sky-50 p-3 text-sm text-sky-800">
                    On leave · {leave.leaveType} ({leave.startDate} → {leave.endDate})
                  </div>
                ))}
                {selectedEvents.dayMeetings.map((meeting) => (
                  <div key={meeting.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 p-3">
                    <div>
                      <p className="text-sm font-medium text-ink-800">{meeting.title}</p>
                      <p className="text-xs text-ink-500">
                        {formatTime(meeting.startAt)} – {formatTime(meeting.endAt)} · {meeting.organizerName} · <StatusBadge status={meeting.status} />
                      </p>
                    </div>
                    <Link to={`/meetings/${meeting.id}/room`} className="btn-secondary btn-sm">
                      Open
                    </Link>
                  </div>
                ))}
                {selectedEvents.dayTasks.map((task) => (
                  <div key={task.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 p-3">
                    <div>
                      <p className="text-sm font-medium text-ink-800">{task.title}</p>
                      <p className="text-xs text-ink-500">{task.taskNo} · due {formatTime(`${task.dueDate}T${task.dueTime ?? '18:30'}:00`)}</p>
                    </div>
                    <Link to={`/tasks?task=${task.id}`} className="btn-secondary btn-sm">
                      Open task
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-3 border-t border-ink-100 px-4 py-2 text-[11px] text-ink-500">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-brand-400" /> Meeting</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-amber-400" /> Task deadline</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-violet-400" /> Holiday</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-sky-400" /> Leave</span>
        </div>
      </Card>
    </div>
  );
}
