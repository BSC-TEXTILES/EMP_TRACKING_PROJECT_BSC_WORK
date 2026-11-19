import { describe, expect, it } from 'vitest';
import {
  chargeableDays,
  daysInMonth,
  eligibleSundays,
  isLeapYear,
  isValidIsoDate,
  isWeeklyOff,
  sundaysBetween,
  sundaysInMonth,
} from '../src/lib/calendar.js';

/** Independent brute-force reference: walk every day with the platform Date API. */
function referenceSundays(year: number, month: number): string[] {
  const result: string[] = [];
  const cursor = new Date(Date.UTC(year, month - 1, 1));
  while (cursor.getUTCMonth() === month - 1) {
    if (cursor.getUTCDay() === 0) result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

describe('calendar-based weekly offs', () => {
  it('matches the examples in the requirement (2027)', () => {
    expect(sundaysInMonth(2027, 1)).toEqual(['2027-01-03', '2027-01-10', '2027-01-17', '2027-01-24', '2027-01-31']);
    expect(sundaysInMonth(2027, 2)).toHaveLength(4);
    expect(sundaysInMonth(2027, 3)).toHaveLength(4);
  });

  it('agrees with a day-by-day reference for every month from 1999 to 2101', () => {
    for (let year = 1999; year <= 2101; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        expect(sundaysInMonth(year, month)).toEqual(referenceSundays(year, month));
      }
    }
  });

  it('handles leap years and month lengths', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2027, 4)).toBe(30);
    expect(daysInMonth(2027, 12)).toBe(31);
    // February 2026 starts on a Sunday and has exactly 4; a leap February starting on Sunday has 5.
    expect(sundaysInMonth(2026, 2)).toHaveLength(4);
    expect(sundaysInMonth(2032, 2)).toEqual(['2032-02-01', '2032-02-08', '2032-02-15', '2032-02-22', '2032-02-29']);
  });

  it('crosses year boundaries', () => {
    expect(sundaysBetween('2026-12-25', '2027-01-05')).toEqual(['2026-12-27', '2027-01-03']);
  });

  it('never charges Sundays or holidays to a leave balance, and counts a Sunday holiday once', () => {
    // Mon 2027-01-04 .. Sun 2027-01-17 with a holiday on Tue 01-12 and one on Sun 01-10.
    const split = chargeableDays('2027-01-04', '2027-01-17', ['2027-01-12', '2027-01-10']);
    expect(split.calendarDays).toBe(14);
    expect(split.weeklyOffs).toEqual(['2027-01-10', '2027-01-17']);
    expect(split.publicHolidays).toEqual(['2027-01-12']);
    expect(split.charged).toHaveLength(11);
  });

  it('only counts Sundays on or after the joining date', () => {
    expect(eligibleSundays(2027, 1, '2027-01-15')).toEqual(['2027-01-17', '2027-01-24', '2027-01-31']);
    expect(eligibleSundays(2027, 1, '2026-06-01', '2027-01-20')).toEqual(['2027-01-03', '2027-01-10', '2027-01-17']);
  });

  it('validates dates strictly', () => {
    expect(isValidIsoDate('2027-02-29')).toBe(false);
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isWeeklyOff('2027-01-03')).toBe(true);
    expect(isWeeklyOff('2027-01-04')).toBe(false);
  });
});
