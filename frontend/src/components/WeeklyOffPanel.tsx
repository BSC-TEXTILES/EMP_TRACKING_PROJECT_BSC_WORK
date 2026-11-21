import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { Badge, Card, Skeleton } from './ui';
import { Icon } from './icons';
import { cx, minutesToHours } from '../lib/format';

/**
 * Calendar-based Sunday weekly offs for one employee and month.
 * All numbers come from the server, which derives Sundays from the real calendar
 * (4 or 5 per month, leap years included); nothing is hardcoded here.
 */

export interface WeeklyOffBalance {
  leaveTypeId: number;
  name: string;
  code: string;
  allocated: number;
  used: number;
  available: number;
  isPaid: boolean;
}

interface WeeklyOffDay {
  date: string;
  day: number;
  weekday: number;
  isWeeklyOff: boolean;
  isEligibleWeeklyOff: boolean;
  holidayName: string | null;
  isToday: boolean;
  isFuture: boolean;
  attendanceStatus: string | null;
  worked: boolean;
  workedMinutes: number;
  isHalfDay?: boolean;
  halfDaySlot?: string | null;
  leave: { type: string; code: string; status: string; isHalfDay?: boolean; halfDaySlot?: string | null } | null;
  compOffDays: number;
}

export interface WeeklyOffSummary {
  employee: { id: number; name: string; code: string | null; joiningDate: string | null; locationName: string | null; locationCode: string | null };
  year: number;
  month: number;
  monthName: string;
  daysInMonth: number;
  isLeapYear: boolean;
  firstWeekday: number;
  today: string;
  totalSundays: number;
  weeklyOffs: { allocated: number; taken: number; worked: number; remaining: number; notEligible: number };
  publicHolidays: { date: string; name: string; onWeeklyOff: boolean }[];
  workingDays: number;
  leaveDaysThisMonth: number;
  compOff: { earnedThisMonth: number; allocated: number; used: number; available: number };
  policy: { compOffEnabled: boolean; compOffOnHolidays: boolean; compOffFullDayMinutes: number; compOffHalfDayMinutes: number; compOffExpiryDays: number };
  sundays: { date: string; day: number; status: 'taken' | 'worked' | 'upcoming' | 'not_eligible'; holidayName: string | null; workedMinutes: number; compOffDays: number }[];
  days: WeeklyOffDay[];
  balances: WeeklyOffBalance[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REGULAR_CODES = ['CL', 'SL', 'EL'];

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Fetches a month summary and keeps it fresh: socket events, tab focus and day rollover. */
export function useWeeklyOffSummary(employeeId: number | undefined, year: number, month: number) {
  const [data, setData] = useState<WeeklyOffSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const token = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const current = ++token.current;
      if (!quiet) setLoading(true);
      try {
        const params = new URLSearchParams({ year: String(year), month: String(month) });
        if (employeeId) params.set('employeeId', String(employeeId));
        const result = await api.get<WeeklyOffSummary>(`/leave/weekly-offs?${params.toString()}`);
        if (current !== token.current) return;
        setData(result);
        setError('');
      } catch (caught) {
        if (current === token.current) setError(errorMessage(caught));
      } finally {
        if (current === token.current) setLoading(false);
      }
    },
    [employeeId, year, month],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates without a page refresh.
  const refresh = useCallback(() => void load(true), [load]);
  useSocketEvent('attendance:update', refresh);
  useSocketEvent('leave:updated', refresh);
  useSocketEvent('leave:policy', refresh);

  useEffect(() => {
    let day = localToday();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    // A Sunday moves from "remaining" to "taken" at midnight.
    const timer = window.setInterval(() => {
      const next = localToday();
      if (next !== day) {
        day = next;
        refresh();
      }
    }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { data, error, loading, reload: refresh };
}

export function MonthPicker({ year, month, onChange }: { year: number; month: number; onChange: (year: number, month: number) => void }) {
  const shift = (delta: number) => {
    const index = year * 12 + (month - 1) + delta;
    onChange(Math.floor(index / 12), (index % 12) + 1);
  };
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 3 + i);
  if (!years.includes(year)) years.push(year);
  years.sort((a, b) => a - b);
  return (
    <div className="flex items-center gap-1">
      <button type="button" className="btn-ghost btn-sm h-8 w-8 p-0" onClick={() => shift(-1)} aria-label="Previous month">
        <Icon name="chevronLeft" size={16} />
      </button>
      <select className="input h-8 w-auto py-0 text-sm" value={month} onChange={(event) => onChange(year, Number(event.target.value))} aria-label="Month">
        {MONTHS.map((name, index) => (
          <option key={name} value={index + 1}>{name}</option>
        ))}
      </select>
      <select className="input h-8 w-auto py-0 text-sm" value={year} onChange={(event) => onChange(Number(event.target.value), month)} aria-label="Year">
        {years.map((value) => (
          <option key={value} value={value}>{value}</option>
        ))}
      </select>
      <button type="button" className="btn-ghost btn-sm h-8 w-8 p-0" onClick={() => shift(1)} aria-label="Next month">
        <Icon name="chevronRight" size={16} />
      </button>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone: string }) {
  return (
    <div className={cx('rounded-xl border p-3', tone)}>
      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold leading-none">{value}</p>
      {hint && <p className="mt-1 text-[11px] opacity-75">{hint}</p>}
    </div>
  );
}

function dayClasses(day: WeeklyOffDay): string {
  // Half day: MUST BE ORANGE
  if (day.isHalfDay || day.attendanceStatus === 'half_day' || (day.leave && (day.leave as any).isHalfDay) || day.leave?.code === 'HDL') {
    return 'bg-orange-50 text-orange-800 ring-1 ring-orange-300 border-orange-200 font-semibold';
  }
  // Weekly off (Sunday): MUST BE RED
  if (day.isWeeklyOff || day.attendanceStatus === 'weekly_off') {
    if (!day.isEligibleWeeklyOff) return 'bg-ink-50 text-ink-300';
    if (day.worked) return 'bg-amber-50 text-amber-800 ring-1 ring-amber-200 font-semibold';
    return 'bg-red-50 text-red-700 ring-1 ring-red-300 border-red-200 font-semibold';
  }
  if (day.holidayName) return 'bg-violet-50 text-violet-800 ring-1 ring-violet-200';
  if (day.leave) return day.leave.status === 'approved' ? 'bg-sky-50 text-sky-800 ring-1 ring-sky-200' : 'bg-sky-50/50 text-sky-700 ring-1 ring-dashed ring-sky-200';
  if (day.worked) return 'bg-white text-ink-800 ring-1 ring-ink-200';
  if (!day.isFuture && !day.isToday) return 'bg-white text-ink-400 ring-1 ring-ink-100';
  return 'bg-white text-ink-700 ring-1 ring-ink-100';
}

function dayLabel(day: WeeklyOffDay): string {
  if (day.isHalfDay || day.attendanceStatus === 'half_day' || (day.leave && (day.leave as any).isHalfDay) || day.leave?.code === 'HDL') {
    const slot = day.halfDaySlot === 'first_half' ? '1st Half' : day.halfDaySlot === 'second_half' ? '2nd Half' : '';
    return slot ? `Half Day (${slot})` : 'Half Day';
  }
  if (day.isWeeklyOff || day.attendanceStatus === 'weekly_off') {
    if (!day.isEligibleWeeklyOff) return 'Not eligible';
    if (day.worked) return day.compOffDays ? `Worked · +${day.compOffDays} CO` : 'Worked';
    return day.holidayName ? `Weekly off · ${day.holidayName}` : 'Weekly off';
  }
  if (day.holidayName) return day.holidayName;
  if (day.leave) return day.leave.status === 'approved' ? day.leave.code : `${day.leave.code} (pending)`;
  if (day.worked) return day.compOffDays ? `${minutesToHours(day.workedMinutes)} · +${day.compOffDays} CO` : minutesToHours(day.workedMinutes);
  return '';
}

export function WeeklyOffCalendar({ summary }: { summary: WeeklyOffSummary }) {
  const blanks = Array.from({ length: summary.firstWeekday });
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-400 sm:text-[11px]">
        {WEEKDAYS.map((name, index) => (
          <span key={name} className={index === 0 ? 'text-red-600 font-bold' : undefined}>{name}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {blanks.map((_, index) => <span key={`b${index}`} />)}
        {summary.days.map((day) => {
          const label = dayLabel(day);
          return (
            <div
              key={day.date}
              className={cx('min-h-[52px] rounded-lg p-1 text-left sm:min-h-[64px] sm:p-1.5', dayClasses(day), day.isToday && 'outline outline-2 outline-brand-500')}
              title={`${day.date}${label ? ` · ${label}` : ''}`}
            >
              <span className="text-xs font-semibold sm:text-sm">{day.day}</span>
              {label && <span className="mt-0.5 block truncate text-[9px] leading-tight sm:text-[10px]">{label}</span>}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-500">
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-red-500" /> Weekly off (Sunday)</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-orange-500" /> Half day</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-amber-400" /> Worked on weekly off</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-violet-400" /> Public holiday</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-sky-400" /> Leave</span>
      </div>
    </div>
  );
}

/**
 * Full panel: month picker, weekly-off counters, calendar and (optionally) the other
 * leave balances shown separately. `compact` renders just the counters, for dashboards.
 */
export function WeeklyOffPanel({
  employeeId,
  compact = false,
  showBalances = true,
  title = 'Weekly offs (Sundays)',
}: {
  employeeId?: number;
  compact?: boolean;
  showBalances?: boolean;
  title?: string;
}) {
  const now = new Date();
  const [period, setPeriod] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const { data, error, loading, reload } = useWeeklyOffSummary(employeeId, period.year, period.month);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        <p className="text-xs text-ink-500">
          {data
            ? `${data.monthName} ${data.year}: ${data.daysInMonth} days, ${data.totalSundays} Sundays${data.isLeapYear && data.month === 2 ? ' (leap year)' : ''}. Calculated from the calendar.`
            : 'Calculated automatically from the calendar.'}
        </p>
      </div>
      {compact ? (
        <Link to="/leave" className="btn-secondary btn-sm">Details</Link>
      ) : (
        <MonthPicker year={period.year} month={period.month} onChange={(year, month) => setPeriod({ year, month })} />
      )}
    </div>
  );

  if (error && !data) {
    return (
      <Card className="card-pad">
        {header}
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error} <button type="button" className="btn-secondary btn-sm ml-2" onClick={reload}>Retry</button>
        </p>
      </Card>
    );
  }

  if (!data || (loading && data.month !== period.month)) {
    return (
      <Card className="card-pad">
        {header}
        <div className="mt-3"><Skeleton lines={compact ? 2 : 6} /></div>
      </Card>
    );
  }

  const w = data.weeklyOffs;
  const regular = data.balances.filter((balance) => REGULAR_CODES.includes(balance.code));
  const others = data.balances.filter((balance) => !REGULAR_CODES.includes(balance.code) && balance.code !== 'CO' && balance.allocated > 0);

  return (
    <Card className="card-pad space-y-4">
      {header}

      <div className={cx('grid gap-2', compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5')}>
        <Stat label="Sundays this month" value={data.totalSundays} hint={`${data.monthName} ${data.year}`} tone="border-ink-200 bg-ink-50 text-ink-800" />
        <Stat
          label="Weekly offs allocated"
          value={w.allocated}
          hint={w.notEligible ? `${w.notEligible} not eligible` : `${w.allocated} weekly offs this month`}
          tone="border-blue-200 bg-blue-50 text-blue-800"
        />
        <Stat
          label="Weekly offs taken"
          value={w.taken}
          hint={w.taken === 0 ? '0 taken so far' : `${w.taken} taken so far`}
          tone="border-red-200 bg-red-50 text-red-800"
        />
        <Stat
          label="Remaining weekly offs"
          value={w.remaining}
          hint={w.remaining > 0 ? `${w.remaining} remaining this month` : 'All weekly offs taken'}
          tone="border-emerald-200 bg-emerald-50 text-emerald-800"
        />
        {!compact && (
          <Stat
            label="Sundays worked"
            value={w.worked}
            hint={data.policy.compOffEnabled ? `${data.compOff.earnedThisMonth} comp-off earned` : 'Comp-off disabled'}
            tone="border-amber-200 bg-amber-50 text-amber-800"
          />
        )}
      </div>

      {!compact && (
        <>
          <WeeklyOffCalendar summary={data} />

          {data.publicHolidays.length > 0 && (
            <div className="text-xs text-ink-600">
              <span className="font-semibold text-ink-700">Public holidays: </span>
              {data.publicHolidays.map((holiday) => `${holiday.name} (${holiday.date.slice(8)}${holiday.onWeeklyOff ? ', on a Sunday' : ''})`).join(', ')}
            </div>
          )}
          <p className="text-xs text-ink-500">
            {data.workingDays} working days this month. Weekly offs are separate from your leave and are never deducted from CL, SL or EL.
            {data.policy.compOffEnabled &&
              ` Working ${minutesToHours(data.policy.compOffFullDayMinutes)} or more on a Sunday${data.policy.compOffOnHolidays ? ' or public holiday' : ''} earns 1 comp-off day${data.policy.compOffHalfDayMinutes > 0 ? ` (${minutesToHours(data.policy.compOffHalfDayMinutes)}+ earns half a day)` : ''}${data.policy.compOffExpiryDays > 0 ? `, valid for ${data.policy.compOffExpiryDays} days` : ''}.`}
          </p>
        </>
      )}

      {showBalances && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500">Other leave balances ({data.year})</p>
          <div className="flex flex-wrap gap-2">
            {regular.map((balance) => (
              <Badge key={balance.leaveTypeId} tone="neutral" className="px-2.5 py-1 text-xs">
                {balance.code}: <strong className="ml-1">{balance.available}</strong>/{balance.allocated}
              </Badge>
            ))}
            <Badge tone="warning" className="px-2.5 py-1 text-xs">
              Comp-off: <strong className="ml-1">{data.compOff.available}</strong> available
            </Badge>
            {others.map((balance) => (
              <Badge key={balance.leaveTypeId} tone="neutral" className="px-2.5 py-1 text-xs">
                {balance.code}: <strong className="ml-1">{balance.available}</strong>/{balance.allocated}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
