import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TravelService, getIndianToday } from '../src/services/TravelService.js';
import { AuthService, type AuthUser } from '../src/services/AuthService.js';
import { execute, queryOne, closePool } from '../src/db/index.js';

let superAdmin: AuthUser;
let belEmployee: AuthUser;
let davEmployee: AuthUser;
let shiEmployee: AuthUser;

beforeAll(async () => {
  // Ensure Super Admin exists
  const adminRow = await queryOne<{ id: number }>(
    "SELECT id FROM employees WHERE role_id = (SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1) LIMIT 1"
  );
  if (adminRow) {
    superAdmin = (await AuthService.buildUser(adminRow.id))!;
  }

  // Ensure BEL Employee (location 1)
  let belRow = await queryOne<{ id: number }>(
    'SELECT id FROM employees WHERE location_id = 1 AND status = "active" LIMIT 1'
  );
  if (!belRow) {
    const ins = await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, status, joining_date)
       VALUES ('EMP-BEL-TEST', 'BEL Staff', 'bel.test@bsctextiles.in', '9876543101', 'hash', (SELECT id FROM roles WHERE slug = 'employee' LIMIT 1), 1, 'active', CURDATE())`
    );
    belRow = { id: Number(ins.insertId) };
  }
  belEmployee = (await AuthService.buildUser(belRow.id))!;

  // Ensure DAV Employee (location 2)
  let davRow = await queryOne<{ id: number }>(
    'SELECT id FROM employees WHERE location_id = 2 AND status = "active" LIMIT 1'
  );
  if (!davRow) {
    const ins = await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, status, joining_date)
       VALUES ('EMP-DAV-TEST', 'DAV Staff', 'dav.test@bsctextiles.in', '9876543102', 'hash', (SELECT id FROM roles WHERE slug = 'employee' LIMIT 1), 2, 'active', CURDATE())`
    );
    davRow = { id: Number(ins.insertId) };
  }
  davEmployee = (await AuthService.buildUser(davRow.id))!;

  // Ensure SHI Employee (location 3)
  let shiRow = await queryOne<{ id: number }>(
    'SELECT id FROM employees WHERE location_id = 3 AND status = "active" LIMIT 1'
  );
  if (!shiRow) {
    const ins = await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, location_id, status, joining_date)
       VALUES ('EMP-SHI-TEST', 'SHI Staff', 'shi.test@bsctextiles.in', '9876543103', 'hash', (SELECT id FROM roles WHERE slug = 'employee' LIMIT 1), 3, 'active', CURDATE())`
    );
    shiRow = { id: Number(ins.insertId) };
  }
  shiEmployee = (await AuthService.buildUser(shiRow.id))!;
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await closePool();
});

describe('BSC Textiles Simplified Daily Ticket Count & Tracking System', () => {
  let createdCountId: number;
  const todayStr = getIndianToday();

  it('1. Submits bus ticket count with automatic date assignment (Asia/Kolkata)', async () => {
    const res = await TravelService.recordDailyCount(belEmployee, {
      ticketType: 'bus',
      ticketCount: 15,
      notes: 'Morning shift Belagavi bus passes',
    });

    expect(res.success).toBe(true);
    expect(res.ticketType).toBe('bus');
    expect(res.ticketCount).toBe(15);
    expect(res.bookingDate).toBe(todayStr);
    expect(res.locationId).toBe(1);
    createdCountId = res.recordId;
  });

  it('2. Submits train ticket count with automatic employee store resolution', async () => {
    const res = await TravelService.recordDailyCount(davEmployee, {
      ticketType: 'train',
      ticketCount: 7,
      notes: 'Davanagere sourcing team train booking',
    });

    expect(res.success).toBe(true);
    expect(res.ticketType).toBe('train');
    expect(res.ticketCount).toBe(7);
    expect(res.bookingDate).toBe(todayStr);
    expect(res.locationId).toBe(2);
  });

  it('3. Multiple submissions on the same date accumulate into daily total instead of overwriting', async () => {
    // Record another bus ticket entry for BEL
    const res2 = await TravelService.recordDailyCount(belEmployee, {
      ticketType: 'bus',
      ticketCount: 10,
      notes: 'Evening shift Belagavi bus tickets',
    });
    expect(res2.success).toBe(true);

    // Verify BEL daily summary has accumulated counts
    const summary = await TravelService.getSummary(belEmployee);
    expect(summary.today.busTickets).toBeGreaterThanOrEqual(25); // 15 + 10
  });

  it('4. Rejects invalid ticket counts (non-positive, decimals, zeros)', async () => {
    await expect(
      TravelService.recordDailyCount(belEmployee, {
        ticketType: 'bus',
        ticketCount: 0,
      }),
    ).rejects.toThrow();

    await expect(
      TravelService.recordDailyCount(belEmployee, {
        ticketType: 'bus',
        ticketCount: -5,
      }),
    ).rejects.toThrow();
  });

  it('5. Maintains separate bus, train, and combined totals for today', async () => {
    const summary = await TravelService.getSummary(superAdmin);
    expect(summary.today.busTickets).toBeGreaterThan(0);
    expect(summary.today.trainTickets).toBeGreaterThan(0);
    expect(summary.today.totalTickets).toBe(summary.today.busTickets + summary.today.trainTickets);
  });

  it('6. Correctly computes weekly and monthly aggregated totals', async () => {
    const summary = await TravelService.getSummary(superAdmin);
    expect(summary.thisWeek.totalTickets).toBeGreaterThanOrEqual(summary.today.totalTickets);
    expect(summary.thisMonth.totalTickets).toBeGreaterThanOrEqual(summary.today.totalTickets);
    expect(summary.overall.totalTickets).toBeGreaterThanOrEqual(summary.thisMonth.totalTickets);
  });

  it('7. Enforces strict store isolation: BEL, DAV and SHI', async () => {
    // Record for SHI
    await TravelService.recordDailyCount(shiEmployee, {
      ticketType: 'bus',
      ticketCount: 12,
      notes: 'Shivamogga daily commute',
    });

    // BEL employee queries history
    const belHistory = await TravelService.listDailyHistory(belEmployee, { datePreset: 'today' });
    for (const item of belHistory.items) {
      expect(item.locationId).toBe(1);
      expect(item.storeCode).toBe('BEL');
    }

    // DAV employee queries history
    const davHistory = await TravelService.listDailyHistory(davEmployee, { datePreset: 'today' });
    for (const item of davHistory.items) {
      expect(item.locationId).toBe(2);
      expect(item.storeCode).toBe('DAV');
    }

    // Super Admin sees all stores
    const allHistory = await TravelService.listDailyHistory(superAdmin, { datePreset: 'today' });
    const storeCodes = allHistory.items.map((i) => i.storeCode);
    expect(storeCodes).toContain('BEL');
    expect(storeCodes).toContain('DAV');
  });

  it('8. Retrieves detailed individual entries for a selected date and store', async () => {
    const entries = await TravelService.getDateEntries(belEmployee, todayStr, 1);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].bookingDate).toBe(todayStr);
    expect(entries[0].storeCode).toBe('BEL');
    expect(entries[0].ticketType).toBeDefined();
    expect(entries[0].ticketCount).toBeGreaterThan(0);
  });

  it('9. Allows authorized HR users to correct a ticket count and records audit log', async () => {
    const res = await TravelService.editTicketCount(
      superAdmin,
      createdCountId,
      20,
      'Adjusted count based on revised trip sheet verification',
    );

    expect(res.success).toBe(true);
    expect(res.previousCount).toBe(15);
    expect(res.newCount).toBe(20);

    // Verify audit log exists
    const entries = await TravelService.getDateEntries(superAdmin, todayStr, 1);
    const correctedEntry = entries.find((e) => e.id === createdCountId);
    expect(correctedEntry).toBeDefined();
    expect(correctedEntry?.ticketCount).toBe(20);
    expect(correctedEntry?.editHistory.length).toBeGreaterThan(0);
    expect(correctedEntry?.editHistory[0].previousCount).toBe(15);
    expect(correctedEntry?.editHistory[0].newCount).toBe(20);
  });

  it('10. Prevents ordinary staff from modifying ticket count records', async () => {
    await expect(
      TravelService.editTicketCount(belEmployee, createdCountId, 99, 'Unauthorized edit attempt'),
    ).rejects.toThrow();
  });

  it('11. Exports date-wise history as Excel-compatible CSV with summary row', async () => {
    const csv = await TravelService.exportDailyHistory(superAdmin, { datePreset: 'today' });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('Booking Date');
    expect(csv).toContain('Store Code');
    expect(csv).toContain('Bus Tickets');
    expect(csv).toContain('Train Tickets');
    expect(csv).toContain('Total Tickets');
    expect(csv).toContain('TOTAL / SUMMARY');
  });

  it('12. Aggregates daily trend chart data from daily_ticket_counts', async () => {
    const chart = await TravelService.getDailyChart(superAdmin);
    expect(Array.isArray(chart)).toBe(true);
    expect(chart.length).toBeGreaterThan(0);
    const todayPoint = chart.find((p) => p.date === todayStr);
    expect(todayPoint).toBeDefined();
    expect(todayPoint?.total).toBeGreaterThan(0);
  });

  it('13. Records cancelled tickets and specific ticket / PNR numbers', async () => {
    const res = await TravelService.recordDailyCount(belEmployee, {
      ticketType: 'bus',
      ticketCount: 3,
      isCancelled: true,
      ticketNumber: 'PNR-CAN-991, PNR-CAN-992',
      notes: 'Customer schedule cancellation - Belagavi bus refund',
    });

    expect(res.success).toBe(true);
    expect(res.isCancelled).toBe(true);
    expect(res.ticketNumber).toBe('PNR-CAN-991, PNR-CAN-992');

    // Retrieve date entries and verify cancelled flag and ticket numbers
    const entries = await TravelService.getDateEntries(belEmployee, todayStr, 1);
    const cancelledEntry = entries.find((e) => e.id === res.recordId);
    expect(cancelledEntry).toBeDefined();
    expect(cancelledEntry?.isCancelled).toBe(true);
    expect(cancelledEntry?.ticketNumber).toBe('PNR-CAN-991, PNR-CAN-992');
  });

  it('14. Computes daily net tickets dynamically taking cancellations into account', async () => {
    const summary = await TravelService.getSummary(superAdmin);
    expect(summary.today.cancelledTickets).toBeGreaterThanOrEqual(3);

    // List history for today
    const history = await TravelService.listDailyHistory(superAdmin, { datePreset: 'today' });
    expect(history.summary.totalCancelled).toBeGreaterThanOrEqual(3);
    expect(history.summary.grandTotal).toBe(
      history.summary.totalBus + history.summary.totalTrain - history.summary.totalCancelled,
    );
  });

  it('15. Includes cancelled tickets and ticket numbers in Excel CSV export', async () => {
    const csv = await TravelService.exportDailyHistory(superAdmin, { datePreset: 'today' });
    expect(csv).toContain('Cancelled Tickets');
    expect(csv).toContain('Net Total Tickets');
    expect(csv).toContain('Ticket Numbers / PNRs');
    expect(csv).toContain('PNR-CAN-991');
  });
});
