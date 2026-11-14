import { config } from '../config.js';

const tz = config.timezone;

/** Parses a MySQL DATETIME string (UTC) into a Date. */
export function parseUtc(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Serialises a DB timestamp as an ISO-8601 UTC string for API responses. */
export function toIso(value: string | Date | null | undefined): string | null {
  const date = parseUtc(value);
  return date ? date.toISOString() : null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function zonedParts(date: Date, zone = tz): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

function offsetMinutes(date: Date, zone: string): number {
  const p = zonedParts(date, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - date.getTime()) / 60000;
}

/** Interprets a wall-clock date/time in the organisation timezone and returns the UTC instant. */
export function zonedToUtc(dateStr: string, timeStr = '00:00:00', zone = tz): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh = 0, mm = 0, ss = 0] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = new Date(naive);
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMinutes(guess, zone);
    guess = new Date(naive - offset * 60000);
  }
  return guess;
}

export function localDate(date: Date = new Date(), zone = tz): string {
  const p = zonedParts(date, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localTime(date: Date = new Date(), zone = tz): string {
  const p = zonedParts(date, zone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

export function today(zone = tz): string {
  return localDate(new Date(), zone);
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const a = Date.UTC(...(start.split('-').map(Number) as [number, number, number]));
  const b = Date.UTC(...(end.split('-').map(Number) as [number, number, number]));
  return Math.round((b - a) / 86400000);
}

export function startOfMonth(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

export function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function periodOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

export function periodRange(period: string): { start: string; end: string } {
  const start = `${period}-01`;
  return { start, end: endOfMonth(start) };
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 2, 1));
  return date.toISOString().slice(0, 7);
}

/** UTC boundaries (as MySQL DATETIME strings) for a local business date. */
export function dayBounds(dateStr: string, zone = tz): { start: string; end: string } {
  const start = zonedToUtc(dateStr, '00:00:00', zone);
  const end = zonedToUtc(addDays(dateStr, 1), '00:00:00', zone);
  return { start: toSql(start), end: toSql(end) };
}

export function toSql(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Normalises an ISO/local datetime string into a MySQL DATETIME (UTC). */
export function toSqlTimestamp(value: string | Date | null | undefined): string | null {
  const date = parseUtc(value ?? null);
  return date ? toSql(date) : null;
}

export function formatLocal(value: string | Date | null | undefined, zone = tz): string {
  const date = parseUtc(value ?? null);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function formatDuration(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

export function weekRange(dateStr: string): { start: string; end: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const dow = base.getUTCDay(); // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow;
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() + diff);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
