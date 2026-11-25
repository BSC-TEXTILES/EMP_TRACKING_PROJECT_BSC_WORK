import { config } from '../config.js';
const tz = config.timezone;
/** Parses a MySQL DATETIME string (UTC) into a Date. */
export function parseUtc(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value;
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
    const date = new Date(withZone);
    return Number.isNaN(date.getTime()) ? null : date;
}
/** Serialises a DB timestamp as an ISO-8601 UTC string for API responses. */
export function toIso(value) {
    const date = parseUtc(value);
    return date ? date.toISOString() : null;
}
export function nowIso() {
    return new Date().toISOString();
}
export function zonedParts(date, zone = tz) {
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
    const get = (type) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour') % 24,
        minute: get('minute'),
        second: get('second'),
    };
}
function offsetMinutes(date, zone) {
    const p = zonedParts(date, zone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (asUtc - date.getTime()) / 60000;
}
/** Interprets a wall-clock date/time in the organisation timezone and returns the UTC instant. */
export function zonedToUtc(dateStr, timeStr = '00:00:00', zone = tz) {
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
export function localDate(date = new Date(), zone = tz) {
    const p = zonedParts(date, zone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function localTime(date = new Date(), zone = tz) {
    const p = zonedParts(date, zone);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}
export function today(zone = tz) {
    return localDate(new Date(), zone);
}
export function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
}
export function addMonths(dateStr, months) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCMonth(base.getUTCMonth() + months);
    return base.toISOString().slice(0, 10);
}
export function daysBetween(start, end) {
    const a = Date.UTC(...start.split('-').map(Number));
    const b = Date.UTC(...end.split('-').map(Number));
    return Math.round((b - a) / 86400000);
}
export function startOfMonth(dateStr) {
    return `${dateStr.slice(0, 7)}-01`;
}
export function endOfMonth(dateStr) {
    const [y, m] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
export function periodOf(dateStr) {
    return dateStr.slice(0, 7);
}
export function periodRange(period) {
    const start = `${period}-01`;
    return { start, end: endOfMonth(start) };
}
export function previousPeriod(period) {
    const [y, m] = period.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 2, 1));
    return date.toISOString().slice(0, 7);
}
/** UTC boundaries (as MySQL DATETIME strings) for a local business date. */
export function dayBounds(dateStr, zone = tz) {
    const start = zonedToUtc(dateStr, '00:00:00', zone);
    const end = zonedToUtc(addDays(dateStr, 1), '00:00:00', zone);
    return { start: toSql(start), end: toSql(end) };
}
export function toSql(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}
/** Normalises an ISO/local datetime string into a MySQL DATETIME (UTC). */
export function toSqlTimestamp(value) {
    const date = parseUtc(value ?? null);
    return date ? toSql(date) : null;
}
export function formatLocal(value, zone = tz) {
    const date = parseUtc(value ?? null);
    if (!date)
        return '';
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
export function formatDuration(totalMinutes) {
    const minutes = Math.max(0, Math.round(totalMinutes));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h ${String(rest).padStart(2, '0')}m`;
}
/** Formats duration in hours and minutes: e.g. '10 Hours 30 Minutes' or '9 Hours' */
export function formatWorkingDuration(secondsOrMinutes, unit = 'seconds') {
    const totalSeconds = unit === 'minutes' ? secondsOrMinutes * 60 : secondsOrMinutes;
    const s = Math.max(0, Math.round(totalSeconds || 0));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    if (hours > 0 && minutes > 0) {
        return `${hours} Hour${hours === 1 ? '' : 's'} ${minutes} Minute${minutes === 1 ? '' : 's'}`;
    }
    if (hours > 0) {
        return `${hours} Hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} Minute${minutes === 1 ? '' : 's'}`;
}
const IST_ZONE = 'Asia/Kolkata';
const timeFormatter12 = new Intl.DateTimeFormat('en-US', { timeZone: IST_ZONE, hour: '2-digit', minute: '2-digit', hour12: true });
const dateFormatterDDMMYYYY = new Intl.DateTimeFormat('en-GB', { timeZone: IST_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
/** Formats a timestamp into 12-hour AM/PM format (e.g. '09:00 AM', '07:30 PM') in Asia/Kolkata */
export function formatTime12(value) {
    if (!value)
        return '—';
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
        const [hStr, mStr] = trimmed.split(':');
        let h = parseInt(hStr, 10);
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${String(h).padStart(2, '0')}:${mStr} ${ampm}`;
    }
    const date = parseUtc(value);
    if (!date)
        return '—';
    return timeFormatter12.format(date);
}
/** Formats a timestamp into DD-MM-YYYY in Asia/Kolkata */
export function formatDateDDMMYYYY(value) {
    if (!value)
        return '—';
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const [y, m, d] = trimmed.split('-');
        return `${d}-${m}-${y}`;
    }
    const date = parseUtc(value);
    if (!date)
        return '—';
    return dateFormatterDDMMYYYY.format(date).replace(/\//g, '-');
}
export function weekRange(dateStr) {
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
//# sourceMappingURL=dates.js.map