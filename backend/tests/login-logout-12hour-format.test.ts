import { describe, expect, it } from 'vitest';
import { formatDateDDMMYYYY, formatTime12, formatWorkingDuration } from '../src/lib/dates.js';

describe('Employee Tracking – Accurate Login & Logout Time (12-Hour Format)', () => {
  it('Test 1 – Normal Working Day: Login 09:00 AM, Logout 07:30 PM, Duration: 10 Hours 30 Minutes', () => {
    // 09:00 AM IST = 03:30:00 UTC
    const loginUtc = '2026-11-24T03:30:00Z';
    // 07:30 PM IST = 14:00:00 UTC
    const logoutUtc = '2026-11-24T14:00:00Z';

    const loginFormatted = formatTime12(loginUtc);
    const logoutFormatted = formatTime12(logoutUtc);
    const dateFormatted = formatDateDDMMYYYY(loginUtc);

    expect(loginFormatted).toBe('09:00 AM');
    expect(logoutFormatted).toBe('07:30 PM');
    expect(dateFormatted).toBe('24-11-2026');

    const durationSeconds = (new Date(logoutUtc).getTime() - new Date(loginUtc).getTime()) / 1000;
    const durationFormatted = formatWorkingDuration(durationSeconds, 'seconds');
    expect(durationFormatted).toBe('10 Hours 30 Minutes');
  });

  it('Test 2 – Afternoon Login: Login 01:15 PM, Logout 09:45 PM, Duration: 8 Hours 30 Minutes', () => {
    // 01:15 PM IST = 07:45:00 UTC
    const loginUtc = '2026-11-24T07:45:00Z';
    // 09:45 PM IST = 16:15:00 UTC
    const logoutUtc = '2026-11-24T16:15:00Z';

    const loginFormatted = formatTime12(loginUtc);
    const logoutFormatted = formatTime12(logoutUtc);

    expect(loginFormatted).toBe('01:15 PM');
    expect(logoutFormatted).toBe('09:45 PM');

    const durationSeconds = (new Date(logoutUtc).getTime() - new Date(loginUtc).getTime()) / 1000;
    const durationFormatted = formatWorkingDuration(durationSeconds, 'seconds');
    expect(durationFormatted).toBe('8 Hours 30 Minutes');
  });

  it('Test 3 – Active Session: Login 09:00 AM, Status: Currently Logged In, Logout: Not Yet Logged Out', () => {
    // 09:00 AM IST = 03:30:00 UTC
    const loginUtc = '2026-11-24T03:30:00Z';
    const logoutUtc = null;

    const loginFormatted = formatTime12(loginUtc);
    const logoutFormatted = logoutUtc ? formatTime12(logoutUtc) : 'Not Yet Logged Out';
    const status = !logoutUtc ? 'Currently Logged In' : 'Logged Out';

    expect(loginFormatted).toBe('09:00 AM');
    expect(logoutFormatted).toBe('Not Yet Logged Out');
    expect(status).toBe('Currently Logged In');
  });

  it('Test 4 – Midnight Session: Login 09:00 PM, Logout 06:00 AM (next day), Duration: 9 Hours', () => {
    // 09:00 PM IST = 15:30:00 UTC on 2026-11-24
    const loginUtc = '2026-11-24T15:30:00Z';
    // 06:00 AM IST = 00:30:00 UTC on 2026-11-25
    const logoutUtc = '2026-11-25T00:30:00Z';

    const loginFormatted = formatTime12(loginUtc);
    const logoutFormatted = formatTime12(logoutUtc);
    const loginDate = formatDateDDMMYYYY(loginUtc);
    const logoutDate = formatDateDDMMYYYY(logoutUtc);

    expect(loginFormatted).toBe('09:00 PM');
    expect(logoutFormatted).toBe('06:00 AM');
    expect(loginDate).toBe('24-11-2026');
    expect(logoutDate).toBe('25-11-2026');

    const durationSeconds = (new Date(logoutUtc).getTime() - new Date(loginUtc).getTime()) / 1000;
    const durationFormatted = formatWorkingDuration(durationSeconds, 'seconds');
    expect(durationFormatted).toBe('9 Hours');
  });

  it('Mandatory 12-Hour format checks for Morning, Afternoon, Evening, Night, Midnight, Noon', () => {
    // Midnight: 12:00 AM IST = 18:30 UTC previous day
    expect(formatTime12('2026-11-24T18:30:00Z')).toBe('12:00 AM');
    // Morning: 09:00 AM IST = 03:30 UTC
    expect(formatTime12('2026-11-25T03:30:00Z')).toBe('09:00 AM');
    // Noon: 12:00 PM IST = 06:30 UTC
    expect(formatTime12('2026-11-25T06:30:00Z')).toBe('12:00 PM');
    // Afternoon: 01:30 PM IST = 08:00 UTC
    expect(formatTime12('2026-11-25T08:00:00Z')).toBe('01:30 PM');
    // Evening: 07:30 PM IST = 14:00 UTC
    expect(formatTime12('2026-11-25T14:00:00Z')).toBe('07:30 PM');
    // Night: 10:15 PM IST = 16:45 UTC
    expect(formatTime12('2026-11-25T16:45:00Z')).toBe('10:15 PM');
  });
});
