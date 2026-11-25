export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});
const weekdayFormatter = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const kolkataDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Returns today's ISO date string (YYYY-MM-DD) in Indian Standard Time (Asia/Kolkata) */
export function todayDateString(): string {
  return kolkataDateFormatter.format(new Date());
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

export function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : timeFormatter.format(date);
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date);
}

export function formatDayLabel(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

export function weekday(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '' : weekdayFormatter.format(date);
}

export function relativeTime(value?: string | null): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minute = 60_000;
  if (diff < minute) return 'just now';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}m ago`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}h ago`;
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))}d ago`;
  return formatDate(value);
}

export function minutesToHours(minutes?: number | null): string {
  const total = Math.max(0, Math.round(minutes ?? 0));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

export function secondsToClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function titleize(value?: string | null): string {
  if (!value) return '';
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export const statusTone: Record<string, string> = {
  present: 'bg-emerald-100 text-emerald-700',
  late: 'bg-amber-100 text-amber-700',
  half_day: 'bg-orange-100 text-orange-700',
  absent: 'bg-red-100 text-red-700',
  on_leave: 'bg-sky-100 text-sky-700',
  weekly_off: 'bg-emerald-100 text-emerald-700',
  holiday: 'bg-violet-100 text-violet-700',
  active: 'bg-emerald-100 text-emerald-700',
  inactive: 'bg-ink-200 text-ink-600',
  pending_verification: 'bg-amber-100 text-amber-700',
  pending_approval: 'bg-amber-100 text-amber-700',
  pending_both: 'bg-amber-100 text-amber-800 font-semibold',
  pending_manager: 'bg-indigo-100 text-indigo-800 font-semibold',
  pending_hr: 'bg-sky-100 text-sky-800 font-semibold',
  rejected: 'bg-red-100 text-red-700',
  not_started: 'bg-ink-200 text-ink-600',
  assigned: 'bg-sky-100 text-sky-700',
  accepted: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-blue-100 text-blue-700',
  on_hold: 'bg-amber-100 text-amber-700',
  pending_approval_task: 'bg-violet-100 text-violet-700',
  completed: 'bg-emerald-100 text-emerald-700',
  overdue: 'bg-red-100 text-red-700',
  cancelled: 'bg-ink-200 text-ink-500',
  approved: 'bg-emerald-100 text-emerald-700',
  submitted: 'bg-blue-100 text-blue-700',
  changes_requested: 'bg-amber-100 text-amber-700',
  reviewed: 'bg-violet-100 text-violet-700',
  published: 'bg-emerald-100 text-emerald-700',
  draft: 'bg-ink-200 text-ink-600',
  review: 'bg-violet-100 text-violet-700',
  new: 'bg-sky-100 text-sky-700',
  acknowledged: 'bg-blue-100 text-blue-700',
  waiting_information: 'bg-amber-100 text-amber-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-ink-200 text-ink-600',
  reopened: 'bg-orange-100 text-orange-700',
  planning: 'bg-ink-200 text-ink-600',
  scheduled: 'bg-blue-100 text-blue-700',
  ongoing: 'bg-emerald-100 text-emerald-700',
  Excellent: 'bg-emerald-100 text-emerald-700',
  'Very Good': 'bg-teal-100 text-teal-700',
  Good: 'bg-blue-100 text-blue-700',
  'Needs Improvement': 'bg-amber-100 text-amber-700',
  Unsatisfactory: 'bg-red-100 text-red-700',
};

export const priorityTone: Record<string, string> = {
  low: 'bg-ink-100 text-ink-600',
  medium: 'bg-sky-100 text-sky-700',
  high: 'bg-orange-100 text-orange-700',
  critical: 'bg-red-100 text-red-700',
  normal: 'bg-sky-100 text-sky-700',
};

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

export function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function localInputValue(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
