/**
 * Pure calendar arithmetic for weekly offs and chargeable leave days.
 *
 * Everything works on ISO `YYYY-MM-DD` strings in UTC so results never depend on
 * the server's timezone or daylight saving. Sundays are always derived from the
 * real calendar — nothing here (or in the database) stores a fixed monthly count.
 */

/** Day-of-week index used for the weekly off (0 = Sunday, per JavaScript `getUTCDay`). */
export const WEEKLY_OFF_WEEKDAY = 0;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Number of days in a month (`month` is 1-12). Handles leap-year February. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeeklyOff(isoDate: string): boolean {
  return weekdayOf(isoDate) === WEEKLY_OFF_WEEKDAY;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Every date of the month (`month` is 1-12). */
export function datesInMonth(year: number, month: number): string[] {
  const total = daysInMonth(year, month);
  return Array.from({ length: total }, (_, index) => isoDate(year, month, index + 1));
}

/** All Sundays of the given month, computed from the actual calendar. */
export function sundaysInMonth(year: number, month: number): string[] {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - first + WEEKLY_OFF_WEEKDAY) % 7);
  const total = daysInMonth(year, month);
  const result: string[] = [];
  for (let day = firstSunday; day <= total; day += 7) result.push(isoDate(year, month, day));
  return result;
}

/** Inclusive list of dates between two ISO dates (empty when `end < start`). */
export function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  const [y, m, d] = start.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  for (let guard = 0; guard < 1000; guard += 1) {
    const value = cursor.toISOString().slice(0, 10);
    if (value > end) break;
    result.push(value);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

/** Sundays inside an inclusive date range. */
export function sundaysBetween(start: string, end: string): string[] {
  return dateRange(start, end).filter(isWeeklyOff);
}

/**
 * Splits a leave range into days charged to the leave balance and days that are
 * free because they are a weekly off (Sunday) or a public holiday. A public
 * holiday that falls on a Sunday is reported once, as a weekly off.
 */
export function chargeableDays(start: string, end: string, holidayDates: Iterable<string>) {
  const holidays = new Set(holidayDates);
  const charged: string[] = [];
  const weeklyOffs: string[] = [];
  const publicHolidays: string[] = [];
  for (const date of dateRange(start, end)) {
    if (isWeeklyOff(date)) weeklyOffs.push(date);
    else if (holidays.has(date)) publicHolidays.push(date);
    else charged.push(date);
  }
  return { charged, weeklyOffs, publicHolidays, calendarDays: charged.length + weeklyOffs.length + publicHolidays.length };
}

/**
 * Sundays an employee is eligible for in a month: only those on or after the
 * joining date (and on or before the exit date, when one is known).
 */
export function eligibleSundays(year: number, month: number, joiningDate?: string | null, exitDate?: string | null): string[] {
  return sundaysInMonth(year, month).filter(
    (date) => (!joiningDate || date >= joiningDate.slice(0, 10)) && (!exitDate || date <= exitDate.slice(0, 10)),
  );
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
