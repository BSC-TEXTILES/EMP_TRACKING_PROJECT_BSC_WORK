import { execute, query, queryOne, transaction, txExecute, type PoolConnection } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { allowedLocationIds, requestedLocation } from '../lib/scope.js';
import { broadcastEvent } from '../realtime/io.js';
import type { AuthUser } from './AuthService.js';

export function getIndianToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function getIndianYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export interface TravelSummary {
  today: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalEntries: number;
    pendingBookings: number;
    confirmedBookings: number;
    cancelledBookings: number;
  };
  thisWeek: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalEntries: number;
  };
  thisMonth: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalEntries: number;
    totalAmount: number;
  };
  overall: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalEntries: number;
  };
  byStatus: {
    requested: number;
    pending: number;
    confirmed: number;
    cancelled: number;
    rejected: number;
    completed: number;
  };
  byStore: Array<{
    locationId: number;
    code: string;
    name: string;
    todayTickets: number;
    todayBus: number;
    todayTrain: number;
    weekTickets: number;
    monthTickets: number;
    totalTickets: number;
    totalEntries: number;
    activeBookings: number;
  }>;
  serverToday: string;
  userStore: {
    id: number;
    code: string;
    name: string;
  } | null;
}

export interface DailyHistoryFilters {
  datePreset?: 'today' | 'yesterday' | 'this_week' | 'this_month' | 'custom' | 'all';
  startDate?: string;
  endDate?: string;
  ticketType?: 'bus' | 'train' | 'all';
  locationId?: number;
  search?: string;
  page?: number;
  limit?: number;
}

export interface DailyHistoryItem {
  bookingDate: string;
  locationId: number;
  storeCode: string;
  storeName: string;
  busTickets: number;
  trainTickets: number;
  totalTickets: number;
  entryCount: number;
  latestUpdatedAt: string;
  updatedByEmployeeName: string;
  updatedByEmployeeCode: string;
}

export interface DailyTicketEntryItem {
  id: number;
  bookingDate: string;
  locationId: number;
  storeCode: string;
  storeName: string;
  ticketType: 'bus' | 'train';
  ticketCount: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  editHistory: Array<{
    id: number;
    editorName: string;
    editorCode: string;
    previousCount: number;
    newCount: number;
    reason: string | null;
    createdAt: string;
  }>;
}

export interface TravelPassengerInput {
  passengerName: string;
  age?: number | null;
  gender?: 'male' | 'female' | 'other' | null;
  seatBerth?: string | null;
  ticketNumber?: string | null;
  status?: 'confirmed' | 'cancelled' | 'waitlisted' | 'rac';
}

export interface CreateBookingInput {
  employeeId: number;
  locationId?: number;
  transportType: 'bus' | 'train';
  status?: 'requested' | 'pending' | 'confirmed' | 'cancelled' | 'rejected' | 'completed';
  bookingDate?: string;
  journeyDate: string;
  journeyTime?: string | null;
  returnDate?: string | null;
  sourceLocation: string;
  destinationLocation: string;
  boardingPoint?: string | null;
  droppingPoint?: string | null;
  operatorOrTrainName?: string | null;
  trainNumber?: string | null;
  pnrOrTicketNumber?: string | null;
  seatClass?: string | null;
  seatNumbers?: string | null;
  totalAmount?: number;
  purpose?: string | null;
  notes?: string | null;
  attachmentUrl?: string | null;
  passengers: TravelPassengerInput[];
}

export interface UpdateBookingInput {
  transportType?: 'bus' | 'train';
  status?: 'requested' | 'pending' | 'confirmed' | 'cancelled' | 'rejected' | 'completed';
  bookingDate?: string;
  journeyDate?: string;
  journeyTime?: string | null;
  returnDate?: string | null;
  sourceLocation?: string;
  destinationLocation?: string;
  boardingPoint?: string | null;
  droppingPoint?: string | null;
  operatorOrTrainName?: string | null;
  trainNumber?: string | null;
  pnrOrTicketNumber?: string | null;
  seatClass?: string | null;
  seatNumbers?: string | null;
  totalAmount?: number;
  purpose?: string | null;
  notes?: string | null;
  attachmentUrl?: string | null;
  cancellationReason?: string | null;
  passengers?: TravelPassengerInput[];
}

export interface BookingFilters {
  transportType?: 'bus' | 'train' | 'all';
  status?: string;
  locationId?: number;
  employeeId?: number;
  datePreset?: 'today' | 'yesterday' | 'this_week' | 'this_month' | 'custom' | 'all';
  startDate?: string;
  endDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export class TravelService {
  /**
   * Resolve location filter clause for SQL queries based on actor's allowed stores
   */
  private static async buildLocationFilter(
    user: AuthUser,
    requestedLocId?: number,
    tablePrefix = 'd',
  ): Promise<{ clause: string; params: unknown[] }> {
    const allowed = await allowedLocationIds(user);
    const params: unknown[] = [];
    let clause = '';

    if (requestedLocId) {
      const valid = await requestedLocation(user, requestedLocId);
      if (!valid) {
        throw ApiError.forbidden('You do not have access to the selected store location.');
      }
      clause = ` AND ${tablePrefix}.location_id = ?`;
      params.push(valid);
    } else if (allowed !== null) {
      if (allowed.length === 0) {
        clause = ` AND ${tablePrefix}.location_id = 0`;
      } else {
        clause = ` AND ${tablePrefix}.location_id IN (${allowed.map(() => '?').join(',')})`;
        params.push(...allowed);
      }
    }

    return { clause, params };
  }

  /**
   * Get Live Travel & Ticket Booking Summary for Dashboard
   */
  static async getSummary(user: AuthUser, locationId?: number): Promise<TravelSummary> {
    const todayStr = getIndianToday();
    const { clause: locClause, params: locParams } = await this.buildLocationFilter(user, locationId, 'd');

    // 1. Today's live stats (Asia/Kolkata date)
    const todayStats = await queryOne<{
      total_tickets: number;
      bus_tickets: number;
      train_tickets: number;
      total_entries: number;
    }>(
      `SELECT
        COALESCE(SUM(d.ticket_count), 0) AS total_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'bus' THEN d.ticket_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'train' THEN d.ticket_count ELSE 0 END), 0) AS train_tickets,
        COUNT(*) AS total_entries
       FROM daily_ticket_counts d
       WHERE d.booking_date = ? ${locClause}`,
      [todayStr, ...locParams],
    );

    // 2. This week stats
    const weekStats = await queryOne<{
      total_tickets: number;
      bus_tickets: number;
      train_tickets: number;
      total_entries: number;
    }>(
      `SELECT
        COALESCE(SUM(d.ticket_count), 0) AS total_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'bus' THEN d.ticket_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'train' THEN d.ticket_count ELSE 0 END), 0) AS train_tickets,
        COUNT(*) AS total_entries
       FROM daily_ticket_counts d
       WHERE d.booking_date >= DATE_SUB(?, INTERVAL WEEKDAY(?) DAY)
         AND d.booking_date <= ? ${locClause}`,
      [todayStr, todayStr, todayStr, ...locParams],
    );

    // 3. This month stats
    const monthStats = await queryOne<{
      total_tickets: number;
      bus_tickets: number;
      train_tickets: number;
      total_entries: number;
    }>(
      `SELECT
        COALESCE(SUM(d.ticket_count), 0) AS total_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'bus' THEN d.ticket_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'train' THEN d.ticket_count ELSE 0 END), 0) AS train_tickets,
        COUNT(*) AS total_entries
       FROM daily_ticket_counts d
       WHERE d.booking_date >= DATE_FORMAT(?, '%Y-%m-01')
         AND d.booking_date <= ? ${locClause}`,
      [todayStr, todayStr, ...locParams],
    );

    // 4. Overall stats
    const overallStats = await queryOne<{
      total_tickets: number;
      bus_tickets: number;
      train_tickets: number;
      total_entries: number;
    }>(
      `SELECT
        COALESCE(SUM(d.ticket_count), 0) AS total_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'bus' THEN d.ticket_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'train' THEN d.ticket_count ELSE 0 END), 0) AS train_tickets,
        COUNT(*) AS total_entries
       FROM daily_ticket_counts d
       WHERE 1 = 1 ${locClause}`,
      locParams,
    );

    // 5. Store breakdown (comparison across BEL, DAV, SHI, HQ)
    const allowed = await allowedLocationIds(user);
    let storeLocFilter = "WHERE l.code IN ('BEL', 'DAV', 'SHI', 'HQ')";
    const storeLocParams: unknown[] = [];
    if (allowed !== null) {
      if (allowed.length === 0) {
        storeLocFilter += ' AND 1 = 0';
      } else {
        storeLocFilter += ` AND l.id IN (${allowed.map(() => '?').join(',')})`;
        storeLocParams.push(...allowed);
      }
    }

    const storeRows = await query<{
      location_id: number;
      code: string;
      name: string;
      today_tickets: number;
      today_bus: number;
      today_train: number;
      week_tickets: number;
      month_tickets: number;
      total_tickets: number;
      total_entries: number;
    }>(
      `SELECT
        l.id AS location_id,
        l.code,
        l.name,
        COALESCE((
          SELECT SUM(d.ticket_count)
          FROM daily_ticket_counts d
          WHERE d.location_id = l.id AND d.booking_date = ?
        ), 0) AS today_tickets,
        COALESCE((
          SELECT SUM(d.ticket_count)
          FROM daily_ticket_counts d
          WHERE d.location_id = l.id AND d.booking_date = ? AND d.ticket_type = 'bus'
        ), 0) AS today_bus,
        COALESCE((
          SELECT SUM(d.ticket_count)
          FROM daily_ticket_counts d
          WHERE d.location_id = l.id AND d.booking_date = ? AND d.ticket_type = 'train'
        ), 0) AS today_train,
        COALESCE((
          SELECT SUM(d.ticket_count)
          FROM daily_ticket_counts d
          WHERE d.location_id = l.id
            AND d.booking_date >= DATE_SUB(?, INTERVAL WEEKDAY(?) DAY)
            AND d.booking_date <= ?
        ), 0) AS week_tickets,
        COALESCE((
          SELECT SUM(d.ticket_count)
          FROM daily_ticket_counts d
          WHERE d.location_id = l.id
            AND d.booking_date >= DATE_FORMAT(?, '%Y-%m-01')
            AND d.booking_date <= ?
        ), 0) AS month_tickets,
        COALESCE((
          SELECT SUM(d.ticket_count)
          FROM daily_ticket_counts d
          WHERE d.location_id = l.id
        ), 0) AS total_tickets,
        COALESCE((
          SELECT COUNT(*)
          FROM daily_ticket_counts d
          WHERE d.location_id = l.id
        ), 0) AS total_entries
       FROM locations l
       ${storeLocFilter}
       ORDER BY l.id ASC`,
      [todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, todayStr, ...storeLocParams],
    );

    // 6. User's assigned store
    const userStoreRow = await queryOne<{ id: number; code: string; name: string }>(
      `SELECT l.id, l.code, l.name
       FROM employees e
       JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`,
      [user.id],
    );

    const totalTodayTickets = Number(todayStats?.total_tickets ?? 0);
    const totalTodayEntries = Number(todayStats?.total_entries ?? 0);

    return {
      today: {
        totalTickets: totalTodayTickets,
        busTickets: Number(todayStats?.bus_tickets ?? 0),
        trainTickets: Number(todayStats?.train_tickets ?? 0),
        totalBookings: totalTodayEntries,
        totalEntries: totalTodayEntries,
        pendingBookings: 0,
        confirmedBookings: totalTodayTickets,
        cancelledBookings: 0,
      },
      thisWeek: {
        totalTickets: Number(weekStats?.total_tickets ?? 0),
        busTickets: Number(weekStats?.bus_tickets ?? 0),
        trainTickets: Number(weekStats?.train_tickets ?? 0),
        totalBookings: Number(weekStats?.total_entries ?? 0),
        totalEntries: Number(weekStats?.total_entries ?? 0),
      },
      thisMonth: {
        totalTickets: Number(monthStats?.total_tickets ?? 0),
        busTickets: Number(monthStats?.bus_tickets ?? 0),
        trainTickets: Number(monthStats?.train_tickets ?? 0),
        totalBookings: Number(monthStats?.total_entries ?? 0),
        totalEntries: Number(monthStats?.total_entries ?? 0),
        totalAmount: 0,
      },
      overall: {
        totalTickets: Number(overallStats?.total_tickets ?? 0),
        busTickets: Number(overallStats?.bus_tickets ?? 0),
        trainTickets: Number(overallStats?.train_tickets ?? 0),
        totalEntries: Number(overallStats?.total_entries ?? 0),
      },
      byStatus: {
        requested: 0,
        pending: 0,
        confirmed: totalTodayTickets,
        cancelled: 0,
        rejected: 0,
        completed: 0,
      },
      byStore: storeRows.map((r) => ({
        locationId: Number(r.location_id),
        code: r.code,
        name: r.name,
        todayTickets: Number(r.today_tickets),
        todayBus: Number(r.today_bus),
        todayTrain: Number(r.today_train),
        weekTickets: Number(r.week_tickets),
        monthTickets: Number(r.month_tickets),
        totalTickets: Number(r.total_tickets),
        totalEntries: Number(r.total_entries),
        activeBookings: Number(r.today_tickets),
      })),
      serverToday: todayStr,
      userStore: userStoreRow
        ? {
            id: Number(userStoreRow.id),
            code: userStoreRow.code,
            name: userStoreRow.name,
          }
        : null,
    };
  }

  /**
   * Record a simplified daily ticket count (Bus or Train)
   * Automatically assigns today's Indian date and employee's store.
   * Multiple submissions on the same day add to the day's total.
   */
  static async recordDailyCount(
    user: AuthUser,
    input: {
      ticketType: 'bus' | 'train';
      ticketCount: number;
      notes?: string | null;
      locationId?: number;
    },
  ) {
    if (!['bus', 'train'].includes(input.ticketType)) {
      throw ApiError.badRequest("Ticket type must be either 'bus' or 'train'.");
    }

    const count = Math.floor(Number(input.ticketCount));
    if (!Number.isFinite(count) || count < 1) {
      throw ApiError.badRequest('Total number of tickets booked must be a positive whole number (minimum 1).');
    }

    // Resolve location
    let targetLocationId: number;
    const allowed = await allowedLocationIds(user);

    if (input.locationId) {
      const valid = await requestedLocation(user, input.locationId);
      if (!valid) {
        throw ApiError.forbidden('You do not have access to record tickets for the specified store location.');
      }
      targetLocationId = valid;
    } else {
      const empRow = await queryOne<{ location_id: number | null }>('SELECT location_id FROM employees WHERE id = ?', [user.id]);
      if (empRow?.location_id) {
        targetLocationId = Number(empRow.location_id);
      } else if (allowed && allowed.length > 0) {
        targetLocationId = allowed[0];
      } else {
        targetLocationId = 1; // Default BEL
      }
    }

    const bookingDate = getIndianToday();
    const notes = input.notes ? input.notes.trim() : null;

    const result = await execute(
      `INSERT INTO daily_ticket_counts (
        booking_date, location_id, ticket_type, ticket_count, employee_id, notes
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [bookingDate, targetLocationId, input.ticketType, count, user.id, notes],
    );

    const insertedId = result.insertId;

    broadcastEvent('travel:updated', {
      action: 'ticket_recorded',
      id: insertedId,
      bookingDate,
      locationId: targetLocationId,
      ticketType: input.ticketType,
      ticketCount: count,
      recordedBy: user.id,
    });

    return {
      success: true,
      message: `Successfully recorded ${count} ${input.ticketType} ticket${count > 1 ? 's' : ''} for today (${bookingDate}).`,
      recordId: insertedId,
      bookingDate,
      locationId: targetLocationId,
      ticketType: input.ticketType,
      ticketCount: count,
    };
  }

  /**
   * List date-wise ticket booking history aggregated by (booking_date, location_id)
   */
  static async listDailyHistory(user: AuthUser, filters: DailyHistoryFilters = {}) {
    const todayStr = getIndianToday();
    const yesterdayStr = getIndianYesterday();
    const { clause: locClause, params: locParams } = await this.buildLocationFilter(user, filters.locationId, 'd');

    const conditions: string[] = ['1 = 1'];
    const params: unknown[] = [...locParams];

    if (locClause) {
      conditions.push(locClause.replace(/^ AND /, ''));
    }

    // Date filters
    if (filters.datePreset === 'today') {
      conditions.push('d.booking_date = ?');
      params.push(todayStr);
    } else if (filters.datePreset === 'yesterday') {
      conditions.push('d.booking_date = ?');
      params.push(yesterdayStr);
    } else if (filters.datePreset === 'this_week') {
      conditions.push('d.booking_date >= DATE_SUB(?, INTERVAL WEEKDAY(?) DAY) AND d.booking_date <= ?');
      params.push(todayStr, todayStr, todayStr);
    } else if (filters.datePreset === 'this_month') {
      conditions.push("d.booking_date >= DATE_FORMAT(?, '%Y-%m-01') AND d.booking_date <= ?");
      params.push(todayStr, todayStr);
    } else if (filters.startDate && filters.endDate) {
      conditions.push('d.booking_date BETWEEN ? AND ?');
      params.push(filters.startDate, filters.endDate);
    } else if (filters.startDate) {
      conditions.push('d.booking_date >= ?');
      params.push(filters.startDate);
    } else if (filters.endDate) {
      conditions.push('d.booking_date <= ?');
      params.push(filters.endDate);
    }

    if (filters.ticketType && filters.ticketType !== 'all') {
      conditions.push('d.ticket_type = ?');
      params.push(filters.ticketType);
    }

    if (filters.search && filters.search.trim()) {
      const q = `%${filters.search.trim()}%`;
      conditions.push('(l.name LIKE ? OR l.code LIKE ?)');
      params.push(q, q);
    }

    const whereClause = conditions.join(' AND ');

    // 1. Overall summary totals for the filtered range
    const summaryRow = await queryOne<{
      total_bus: number;
      total_train: number;
      grand_total: number;
      total_entries: number;
    }>(
      `SELECT
        COALESCE(SUM(CASE WHEN d.ticket_type = 'bus' THEN d.ticket_count ELSE 0 END), 0) AS total_bus,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'train' THEN d.ticket_count ELSE 0 END), 0) AS total_train,
        COALESCE(SUM(d.ticket_count), 0) AS grand_total,
        COUNT(*) AS total_entries
       FROM daily_ticket_counts d
       JOIN locations l ON l.id = d.location_id
       WHERE ${whereClause}`,
      params,
    );

    // 2. Count distinct (booking_date, location_id) groups
    const countRow = await queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT CONCAT(d.booking_date, '-', d.location_id)) AS count
       FROM daily_ticket_counts d
       JOIN locations l ON l.id = d.location_id
       WHERE ${whereClause}`,
      params,
    );
    const totalRows = Number(countRow?.count ?? 0);

    const page = Math.max(1, Number(filters.page || 1));
    const limit = Math.min(100, Math.max(1, Number(filters.limit || 20)));
    const offset = (page - 1) * limit;

    // 3. Paginated items
    const rows = await query<{
      booking_date: string;
      location_id: number;
      store_code: string;
      store_name: string;
      bus_tickets: number;
      train_tickets: number;
      total_tickets: number;
      entry_count: number;
      latest_updated_at: string;
      updated_by_name: string | null;
      updated_by_code: string | null;
    }>(
      `SELECT
        DATE_FORMAT(d.booking_date, '%Y-%m-%d') AS booking_date,
        d.location_id,
        l.code AS store_code,
        l.name AS store_name,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'bus' THEN d.ticket_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'train' THEN d.ticket_count ELSE 0 END), 0) AS train_tickets,
        COALESCE(SUM(d.ticket_count), 0) AS total_tickets,
        COUNT(*) AS entry_count,
        DATE_FORMAT(MAX(d.updated_at), '%Y-%m-%d %H:%i:%s') AS latest_updated_at,
        (
          SELECT e2.full_name
          FROM daily_ticket_counts d2
          JOIN employees e2 ON e2.id = d2.employee_id
          WHERE d2.booking_date = d.booking_date AND d2.location_id = d.location_id
          ORDER BY d2.updated_at DESC, d2.id DESC
          LIMIT 1
        ) AS updated_by_name,
        (
          SELECT e2.employee_code
          FROM daily_ticket_counts d2
          JOIN employees e2 ON e2.id = d2.employee_id
          WHERE d2.booking_date = d.booking_date AND d2.location_id = d.location_id
          ORDER BY d2.updated_at DESC, d2.id DESC
          LIMIT 1
        ) AS updated_by_code
       FROM daily_ticket_counts d
       JOIN locations l ON l.id = d.location_id
       WHERE ${whereClause}
       GROUP BY d.booking_date, d.location_id, l.code, l.name
       ORDER BY d.booking_date DESC, d.location_id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const items: DailyHistoryItem[] = rows.map((r) => ({
      bookingDate: r.booking_date,
      locationId: Number(r.location_id),
      storeCode: r.store_code,
      storeName: r.store_name,
      busTickets: Number(r.bus_tickets),
      trainTickets: Number(r.train_tickets),
      totalTickets: Number(r.total_tickets),
      entryCount: Number(r.entry_count),
      latestUpdatedAt: r.latest_updated_at,
      updatedByEmployeeName: r.updated_by_name || 'System',
      updatedByEmployeeCode: r.updated_by_code || '',
    }));

    return {
      summary: {
        totalBus: Number(summaryRow?.total_bus ?? 0),
        totalTrain: Number(summaryRow?.total_train ?? 0),
        grandTotal: Number(summaryRow?.grand_total ?? 0),
        totalEntries: Number(summaryRow?.total_entries ?? 0),
      },
      items,
      totalRows,
      page,
      limit,
      totalPages: Math.ceil(totalRows / limit) || 1,
    };
  }

  /**
   * Get detailed individual entries for a specific date and store
   */
  static async getDateEntries(
    user: AuthUser,
    bookingDate: string,
    locationId?: number,
  ): Promise<DailyTicketEntryItem[]> {
    const { clause: locClause, params: locParams } = await this.buildLocationFilter(user, locationId, 'd');

    const rows = await query<{
      id: number;
      booking_date: string;
      location_id: number;
      store_code: string;
      store_name: string;
      ticket_type: 'bus' | 'train';
      ticket_count: number;
      employee_id: number;
      employee_name: string;
      employee_code: string;
      notes: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT
        d.id,
        DATE_FORMAT(d.booking_date, '%Y-%m-%d') AS booking_date,
        d.location_id,
        l.code AS store_code,
        l.name AS store_name,
        d.ticket_type,
        d.ticket_count,
        d.employee_id,
        e.full_name AS employee_name,
        e.employee_code,
        d.notes,
        DATE_FORMAT(d.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(d.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM daily_ticket_counts d
       JOIN locations l ON l.id = d.location_id
       JOIN employees e ON e.id = d.employee_id
       WHERE d.booking_date = ? ${locClause}
       ORDER BY d.id DESC`,
      [bookingDate, ...locParams],
    );

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const editRows = await query<{
      id: number;
      ticket_count_id: number;
      editor_name: string;
      editor_code: string;
      previous_count: number;
      new_count: number;
      reason: string | null;
      created_at: string;
    }>(
      `SELECT
        ed.id,
        ed.ticket_count_id,
        emp.full_name AS editor_name,
        emp.employee_code AS editor_code,
        ed.previous_count,
        ed.new_count,
        ed.reason,
        DATE_FORMAT(ed.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM daily_ticket_count_edits ed
       JOIN employees emp ON emp.id = ed.editor_id
       WHERE ed.ticket_count_id IN (${ids.map(() => '?').join(',')})
       ORDER BY ed.id ASC`,
      ids,
    );

    const editsByCountId = new Map<number, typeof editRows>();
    for (const e of editRows) {
      const arr = editsByCountId.get(e.ticket_count_id) || [];
      arr.push(e);
      editsByCountId.set(e.ticket_count_id, arr);
    }

    return rows.map((r) => ({
      id: Number(r.id),
      bookingDate: r.booking_date,
      locationId: Number(r.location_id),
      storeCode: r.store_code,
      storeName: r.store_name,
      ticketType: r.ticket_type,
      ticketCount: Number(r.ticket_count),
      employeeId: Number(r.employee_id),
      employeeName: r.employee_name,
      employeeCode: r.employee_code,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      editHistory: (editsByCountId.get(r.id) || []).map((e) => ({
        id: Number(e.id),
        editorName: e.editor_name,
        editorCode: e.editor_code,
        previousCount: Number(e.previous_count),
        newCount: Number(e.new_count),
        reason: e.reason,
        createdAt: e.created_at,
      })),
    }));
  }

  /**
   * Edit and correct a previously entered ticket count
   * Restricted to authorized HR users and store/central admins
   */
  static async editTicketCount(
    user: AuthUser,
    id: number,
    newCount: number,
    reason?: string,
  ) {
    const isAuthorized =
      user.roleSlug === 'admin' ||
      user.roleSlug === 'super_admin' ||
      user.roleSlug === 'hr_manager' ||
      user.roleSlug === 'location_hr' ||
      user.permissions.includes('travel.manage') ||
      user.permissions.includes('employees.manage');

    if (!isAuthorized) {
      throw ApiError.forbidden('Only authorized HR administrators can correct ticket counts.');
    }

    const count = Math.floor(Number(newCount));
    if (!Number.isFinite(count) || count < 1) {
      throw ApiError.badRequest('Corrected ticket count must be a positive whole number (minimum 1).');
    }

    const existing = await queryOne<{
      id: number;
      location_id: number;
      ticket_type: string;
      ticket_count: number;
      booking_date: string;
    }>('SELECT id, location_id, ticket_type, ticket_count, DATE_FORMAT(booking_date, "%Y-%m-%d") AS booking_date FROM daily_ticket_counts WHERE id = ?', [id]);

    if (!existing) {
      throw ApiError.notFound('Ticket count record not found.');
    }

    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(Number(existing.location_id))) {
      throw ApiError.forbidden('You do not have permission to modify ticket records for this store.');
    }

    const prevCount = Number(existing.ticket_count);
    if (prevCount === count) {
      return { success: true, message: 'Ticket count unchanged.' };
    }

    return transaction(async (conn: PoolConnection) => {
      await txExecute(
        conn,
        `INSERT INTO daily_ticket_count_edits (
          ticket_count_id, editor_id, previous_count, new_count, reason
        ) VALUES (?, ?, ?, ?, ?)`,
        [id, user.id, prevCount, count, reason?.trim() || 'Corrected by HR administrator'],
      );

      await txExecute(
        conn,
        'UPDATE daily_ticket_counts SET ticket_count = ?, updated_at = NOW() WHERE id = ?',
        [count, id],
      );

      broadcastEvent('travel:updated', {
        action: 'count_corrected',
        id,
        locationId: Number(existing.location_id),
        previousCount: prevCount,
        newCount: count,
        editorId: user.id,
      });

      return {
        success: true,
        message: `Successfully corrected ticket count from ${prevCount} to ${count}.`,
        recordId: id,
        previousCount: prevCount,
        newCount: count,
      };
    });
  }

  /**
   * Export daily history in Excel-compatible CSV format
   */
  static async exportDailyHistory(
    user: AuthUser,
    filters: DailyHistoryFilters = {},
  ): Promise<string> {
    const result = await this.listDailyHistory(user, { ...filters, limit: 10000, page: 1 });

    const escapeCsv = (val: unknown) => {
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""');
      return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
    };

    const headers = [
      'Booking Date',
      'Store Code',
      'Store Name',
      'Bus Tickets',
      'Train Tickets',
      'Total Tickets',
      'Entries Recorded',
      'Last Updated By',
      'Last Updated At',
    ];

    const lines: string[] = ['\uFEFF' + headers.map(escapeCsv).join(',')];

    for (const item of result.items) {
      lines.push(
        [
          escapeCsv(item.bookingDate),
          escapeCsv(item.storeCode),
          escapeCsv(item.storeName),
          escapeCsv(item.busTickets),
          escapeCsv(item.trainTickets),
          escapeCsv(item.totalTickets),
          escapeCsv(item.entryCount),
          escapeCsv(`${item.updatedByEmployeeName} (${item.updatedByEmployeeCode})`),
          escapeCsv(item.latestUpdatedAt),
        ].join(','),
      );
    }

    // Add summary row at bottom
    lines.push(
      [
        escapeCsv('TOTAL / SUMMARY'),
        escapeCsv(''),
        escapeCsv(''),
        escapeCsv(result.summary.totalBus),
        escapeCsv(result.summary.totalTrain),
        escapeCsv(result.summary.grandTotal),
        escapeCsv(result.summary.totalEntries),
        escapeCsv(''),
        escapeCsv(''),
      ].join(','),
    );

    return lines.join('\n');
  }

  /**
   * Get daily trend chart points for bus vs train tickets from daily_ticket_counts
   */
  static async getDailyChart(
    user: AuthUser,
    filters: { locationId?: number; startDate?: string; endDate?: string } = {},
  ) {
    const todayStr = getIndianToday();
    const { clause: locClause, params: locParams } = await this.buildLocationFilter(user, filters.locationId, 'd');

    let dateFilter = 'd.booking_date >= DATE_SUB(?, INTERVAL 13 DAY) AND d.booking_date <= ?';
    const params: unknown[] = [todayStr, todayStr, ...locParams];

    if (filters.startDate && filters.endDate) {
      dateFilter = 'd.booking_date BETWEEN ? AND ?';
      params.splice(0, 2, filters.startDate, filters.endDate);
    } else if (filters.startDate) {
      dateFilter = 'd.booking_date >= ? AND d.booking_date <= ?';
      params.splice(0, 2, filters.startDate, todayStr);
    }

    const rows = await query<{
      booking_date: string;
      bus_tickets: number;
      train_tickets: number;
      total_tickets: number;
    }>(
      `SELECT
        DATE_FORMAT(d.booking_date, '%Y-%m-%d') AS booking_date,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'bus' THEN d.ticket_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN d.ticket_type = 'train' THEN d.ticket_count ELSE 0 END), 0) AS train_tickets,
        COALESCE(SUM(d.ticket_count), 0) AS total_tickets
       FROM daily_ticket_counts d
       WHERE ${dateFilter} ${locClause}
       GROUP BY d.booking_date
       ORDER BY d.booking_date ASC`,
      params,
    );

    return rows.map((r) => ({
      date: r.booking_date,
      bus: Number(r.bus_tickets),
      train: Number(r.train_tickets),
      total: Number(r.total_tickets),
    }));
  }

  // =========================================================================
  // Legacy Booking Methods (Maintained for backward compatibility and audits)
  // =========================================================================

  static async listBookings(user: AuthUser, filters: BookingFilters = {}) {
    const { clause: locClause, params: locParams } = await this.buildLocationFilter(user, filters.locationId, 'b');
    const conditions: string[] = ['1 = 1'];
    const params: unknown[] = [...locParams];

    if (locClause) {
      conditions.push(locClause.replace(/^ AND /, ''));
    }

    if (filters.transportType && filters.transportType !== 'all') {
      conditions.push('b.transport_type = ?');
      params.push(filters.transportType);
    }

    if (filters.status && filters.status !== 'all') {
      conditions.push('b.status = ?');
      params.push(filters.status);
    }

    if (filters.employeeId) {
      conditions.push('b.employee_id = ?');
      params.push(filters.employeeId);
    }

    if (filters.datePreset === 'today') {
      conditions.push('b.booking_date = CURDATE()');
    } else if (filters.datePreset === 'yesterday') {
      conditions.push('b.booking_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)');
    } else if (filters.datePreset === 'this_week') {
      conditions.push('b.booking_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) AND b.booking_date <= CURDATE()');
    } else if (filters.datePreset === 'this_month') {
      conditions.push("b.booking_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND b.booking_date <= CURDATE()");
    } else if (filters.startDate && filters.endDate) {
      conditions.push('b.booking_date BETWEEN ? AND ?');
      params.push(filters.startDate, filters.endDate);
    } else if (filters.startDate) {
      conditions.push('b.booking_date >= ?');
      params.push(filters.startDate);
    } else if (filters.endDate) {
      conditions.push('b.booking_date <= ?');
      params.push(filters.endDate);
    }

    if (filters.search && filters.search.trim()) {
      const q = `%${filters.search.trim()}%`;
      conditions.push(`(
        b.booking_reference LIKE ? OR
        b.pnr_or_ticket_number LIKE ? OR
        b.operator_or_train_name LIKE ? OR
        b.source_location LIKE ? OR
        b.destination_location LIKE ? OR
        e.full_name LIKE ? OR
        e.employee_code LIKE ?
      )`);
      params.push(q, q, q, q, q, q, q);
    }

    const whereClause = conditions.join(' AND ');

    const totalRow = await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM travel_bookings b
       JOIN employees e ON e.id = b.employee_id
       WHERE ${whereClause}`,
      params,
    );
    const total = Number(totalRow?.count ?? 0);

    const page = Math.max(1, Number(filters.page || 1));
    const limit = Math.min(100, Math.max(1, Number(filters.limit || 20)));
    const offset = (page - 1) * limit;

    const rows = await query<{
      id: number;
      booking_reference: string;
      employee_id: number;
      employee_code: string;
      employee_name: string;
      location_id: number;
      location_code: string;
      location_name: string;
      transport_type: 'bus' | 'train';
      status: string;
      booking_date: string;
      booked_at: string;
      journey_date: string;
      journey_time: string | null;
      return_date: string | null;
      source_location: string;
      destination_location: string;
      boarding_point: string | null;
      dropping_point: string | null;
      operator_or_train_name: string | null;
      train_number: string | null;
      pnr_or_ticket_number: string | null;
      seat_class: string | null;
      seat_numbers: string | null;
      passenger_count: number;
      total_amount: number;
      purpose: string | null;
      booked_by_id: number;
      booked_by_name: string;
      notes: string | null;
      attachment_url: string | null;
      cancellation_reason: string | null;
      cancelled_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT
        b.id,
        b.booking_reference,
        b.employee_id,
        e.employee_code,
        e.full_name AS employee_name,
        b.location_id,
        l.code AS location_code,
        l.name AS location_name,
        b.transport_type,
        b.status,
        DATE_FORMAT(b.booking_date, '%Y-%m-%d') AS booking_date,
        DATE_FORMAT(b.booked_at, '%Y-%m-%d %H:%i:%s') AS booked_at,
        DATE_FORMAT(b.journey_date, '%Y-%m-%d') AS journey_date,
        b.journey_time,
        DATE_FORMAT(b.return_date, '%Y-%m-%d') AS return_date,
        b.source_location,
        b.destination_location,
        b.boarding_point,
        b.dropping_point,
        b.operator_or_train_name,
        b.train_number,
        b.pnr_or_ticket_number,
        b.seat_class,
        b.seat_numbers,
        b.passenger_count,
        b.total_amount,
        b.purpose,
        b.booked_by_id,
        bb.full_name AS booked_by_name,
        b.notes,
        b.attachment_url,
        b.cancellation_reason,
        DATE_FORMAT(b.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelled_at,
        DATE_FORMAT(b.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(b.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM travel_bookings b
       JOIN employees e ON e.id = b.employee_id
       JOIN locations l ON l.id = b.location_id
       JOIN employees bb ON bb.id = b.booked_by_id
       WHERE ${whereClause}
       ORDER BY b.booking_date DESC, b.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const bookingIds = rows.map((r) => r.id);
    let passengers: Array<{
      id: number;
      booking_id: number;
      passenger_name: string;
      age: number | null;
      gender: 'male' | 'female' | 'other' | null;
      seat_berth: string | null;
      ticket_number: string | null;
      status: 'confirmed' | 'cancelled' | 'waitlisted' | 'rac';
    }> = [];

    if (bookingIds.length > 0) {
      passengers = await query(
        `SELECT id, booking_id, passenger_name, age, gender, seat_berth, ticket_number, status
         FROM travel_passengers
         WHERE booking_id IN (${bookingIds.map(() => '?').join(',')})`,
        bookingIds,
      );
    }

    const passByBooking = new Map<number, typeof passengers>();
    for (const p of passengers) {
      const arr = passByBooking.get(p.booking_id) || [];
      arr.push(p);
      passByBooking.set(p.booking_id, arr);
    }

    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        bookingReference: r.booking_reference,
        employeeId: Number(r.employee_id),
        employeeCode: r.employee_code,
        employeeName: r.employee_name,
        locationId: Number(r.location_id),
        locationCode: r.location_code,
        locationName: r.location_name,
        transportType: r.transport_type,
        status: r.status as any,
        bookingDate: r.booking_date,
        bookedAt: r.booked_at,
        journeyDate: r.journey_date,
        journeyTime: r.journey_time,
        returnDate: r.return_date,
        sourceLocation: r.source_location,
        destinationLocation: r.destination_location,
        boardingPoint: r.boarding_point,
        droppingPoint: r.dropping_point,
        operatorOrTrainName: r.operator_or_train_name,
        trainNumber: r.train_number,
        pnrOrTicketNumber: r.pnr_or_ticket_number,
        seatClass: r.seat_class,
        seatNumbers: r.seat_numbers,
        passengerCount: Number(r.passenger_count),
        totalAmount: Number(r.total_amount),
        purpose: r.purpose,
        bookedById: Number(r.booked_by_id),
        bookedByName: r.booked_by_name,
        notes: r.notes,
        attachmentUrl: r.attachment_url,
        cancellationReason: r.cancellation_reason,
        cancelledAt: r.cancelled_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        passengers: (passByBooking.get(r.id) || []).map((p) => ({
          id: Number(p.id),
          passengerName: p.passenger_name,
          age: p.age ? Number(p.age) : null,
          gender: p.gender,
          seatBerth: p.seat_berth,
          ticketNumber: p.ticket_number,
          status: p.status,
        })),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  static async getBooking(user: AuthUser, id: number) {
    const row = await queryOne<{
      id: number;
      booking_reference: string;
      employee_id: number;
      employee_code: string;
      employee_name: string;
      location_id: number;
      location_code: string;
      location_name: string;
      transport_type: 'bus' | 'train';
      status: string;
      booking_date: string;
      booked_at: string;
      journey_date: string;
      journey_time: string | null;
      return_date: string | null;
      source_location: string;
      destination_location: string;
      boarding_point: string | null;
      dropping_point: string | null;
      operator_or_train_name: string | null;
      train_number: string | null;
      pnr_or_ticket_number: string | null;
      seat_class: string | null;
      seat_numbers: string | null;
      passenger_count: number;
      total_amount: number;
      purpose: string | null;
      booked_by_id: number;
      booked_by_name: string;
      notes: string | null;
      attachment_url: string | null;
      cancellation_reason: string | null;
      cancelled_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT
        b.id,
        b.booking_reference,
        b.employee_id,
        e.employee_code,
        e.full_name AS employee_name,
        b.location_id,
        l.code AS location_code,
        l.name AS location_name,
        b.transport_type,
        b.status,
        DATE_FORMAT(b.booking_date, '%Y-%m-%d') AS booking_date,
        DATE_FORMAT(b.booked_at, '%Y-%m-%d %H:%i:%s') AS booked_at,
        DATE_FORMAT(b.journey_date, '%Y-%m-%d') AS journey_date,
        b.journey_time,
        DATE_FORMAT(b.return_date, '%Y-%m-%d') AS return_date,
        b.source_location,
        b.destination_location,
        b.boarding_point,
        b.dropping_point,
        b.operator_or_train_name,
        b.train_number,
        b.pnr_or_ticket_number,
        b.seat_class,
        b.seat_numbers,
        b.passenger_count,
        b.total_amount,
        b.purpose,
        b.booked_by_id,
        bb.full_name AS booked_by_name,
        b.notes,
        b.attachment_url,
        b.cancellation_reason,
        DATE_FORMAT(b.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelled_at,
        DATE_FORMAT(b.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(b.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM travel_bookings b
       JOIN employees e ON e.id = b.employee_id
       JOIN locations l ON l.id = b.location_id
       JOIN employees bb ON bb.id = b.booked_by_id
       WHERE b.id = ?`,
      [id],
    );

    if (!row) throw ApiError.notFound('Travel booking not found.');

    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(Number(row.location_id))) {
      throw ApiError.forbidden('You do not have access to view bookings for this store location.');
    }

    const passengers = await query<{
      id: number;
      booking_id: number;
      passenger_name: string;
      age: number | null;
      gender: 'male' | 'female' | 'other' | null;
      seat_berth: string | null;
      ticket_number: string | null;
      status: 'confirmed' | 'cancelled' | 'waitlisted' | 'rac';
    }>('SELECT * FROM travel_passengers WHERE booking_id = ? ORDER BY id ASC', [id]);

    const logs = await query<{
      id: number;
      actor_id: number;
      actor_name: string;
      actor_code: string;
      action: string;
      previous_status: string | null;
      new_status: string | null;
      remarks: string | null;
      created_at: string;
    }>(
      `SELECT
        l.id,
        l.actor_id,
        e.full_name AS actor_name,
        e.employee_code AS actor_code,
        l.action,
        l.previous_status,
        l.new_status,
        l.remarks,
        DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM travel_booking_logs l
       JOIN employees e ON e.id = l.actor_id
       WHERE l.booking_id = ?
       ORDER BY l.id ASC`,
      [id],
    );

    return {
      id: Number(row.id),
      bookingReference: row.booking_reference,
      employeeId: Number(row.employee_id),
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      locationId: Number(row.location_id),
      locationCode: row.location_code,
      locationName: row.location_name,
      transportType: row.transport_type,
      status: row.status as any,
      bookingDate: row.booking_date,
      bookedAt: row.booked_at,
      journeyDate: row.journey_date,
      journeyTime: row.journey_time,
      returnDate: row.return_date,
      sourceLocation: row.source_location,
      destinationLocation: row.destination_location,
      boardingPoint: row.boarding_point,
      droppingPoint: row.dropping_point,
      operatorOrTrainName: row.operator_or_train_name,
      trainNumber: row.train_number,
      pnrOrTicketNumber: row.pnr_or_ticket_number,
      seatClass: row.seat_class,
      seatNumbers: row.seat_numbers,
      passengerCount: Number(row.passenger_count),
      totalAmount: Number(row.total_amount),
      purpose: row.purpose,
      bookedById: Number(row.booked_by_id),
      bookedByName: row.booked_by_name,
      notes: row.notes,
      attachmentUrl: row.attachment_url,
      cancellationReason: row.cancellation_reason,
      cancelledAt: row.cancelled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      passengers: passengers.map((p) => ({
        id: Number(p.id),
        passengerName: p.passenger_name,
        age: p.age ? Number(p.age) : null,
        gender: p.gender,
        seatBerth: p.seat_berth,
        ticketNumber: p.ticket_number,
        status: p.status,
      })),
      logs: logs.map((l) => ({
        id: Number(l.id),
        actorId: Number(l.actor_id),
        actorName: l.actor_name,
        actorCode: l.actor_code,
        action: l.action,
        previousStatus: l.previous_status,
        newStatus: l.new_status,
        remarks: l.remarks,
        createdAt: l.created_at,
      })),
    };
  }

  static async createBooking(user: AuthUser, input: CreateBookingInput) {
    let locationId = input.locationId;
    if (!locationId) {
      const emp = await queryOne<{ location_id: number }>('SELECT location_id FROM employees WHERE id = ?', [input.employeeId]);
      locationId = emp?.location_id || 1;
    }

    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(Number(locationId))) {
      throw ApiError.forbidden('You do not have permission to book travel for this store location.');
    }

    return transaction(async (conn: PoolConnection) => {
      const refCountRow = await queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM travel_bookings');
      const nextSeq = (Number(refCountRow?.count || 0) + 1).toString().padStart(4, '0');
      const datePart = (input.bookingDate || getIndianToday()).replace(/-/g, '');
      const bookingReference = `TRV-${datePart}-${nextSeq}`;

      const passengerCount = Array.isArray(input.passengers) && input.passengers.length > 0 ? input.passengers.length : 1;
      const status = input.status || 'confirmed';

      const insertResult = await txExecute(
        conn,
        `INSERT INTO travel_bookings (
          booking_reference, employee_id, location_id, transport_type, status,
          booking_date, booked_at, journey_date, journey_time, return_date,
          source_location, destination_location, boarding_point, dropping_point,
          operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
          passenger_count, total_amount, purpose, booked_by_id, notes, attachment_url
        ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bookingReference,
          input.employeeId,
          locationId,
          input.transportType,
          status,
          input.bookingDate || getIndianToday(),
          input.journeyDate,
          input.journeyTime || null,
          input.returnDate || null,
          input.sourceLocation.trim(),
          input.destinationLocation.trim(),
          input.boardingPoint?.trim() || null,
          input.droppingPoint?.trim() || null,
          input.operatorOrTrainName?.trim() || null,
          input.trainNumber?.trim() || null,
          input.pnrOrTicketNumber?.trim() || null,
          input.seatClass?.trim() || null,
          input.seatNumbers?.trim() || null,
          passengerCount,
          input.totalAmount || 0,
          input.purpose?.trim() || null,
          user.id,
          input.notes?.trim() || null,
          input.attachmentUrl || null,
        ],
      );

      const bookingId = insertResult.insertId;

      if (Array.isArray(input.passengers) && input.passengers.length > 0) {
        for (const p of input.passengers) {
          await txExecute(
            conn,
            `INSERT INTO travel_passengers (
              booking_id, passenger_name, age, gender, seat_berth, ticket_number, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              bookingId,
              p.passengerName.trim(),
              p.age || null,
              p.gender || null,
              p.seatBerth || null,
              p.ticketNumber || null,
              p.status || (status === 'confirmed' ? 'confirmed' : 'waitlisted'),
            ],
          );
        }
      }

      await txExecute(
        conn,
        `INSERT INTO travel_booking_logs (
          booking_id, actor_id, action, previous_status, new_status, remarks
        ) VALUES (?, ?, 'created', NULL, ?, 'Travel booking created')`,
        [bookingId, user.id, status],
      );

      // Also sync to daily_ticket_counts for aggregate reporting
      await txExecute(
        conn,
        `INSERT INTO daily_ticket_counts (
          booking_date, location_id, ticket_type, ticket_count, employee_id, notes
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.bookingDate || getIndianToday(),
          locationId,
          input.transportType,
          passengerCount,
          input.employeeId,
          input.purpose || 'HR Booking',
        ],
      );

      broadcastEvent('travel:updated', {
        bookingId,
        action: 'created',
        transportType: input.transportType,
        locationId: Number(locationId),
        passengerCount,
      });

      return {
        id: bookingId,
        bookingReference,
        passengerCount,
        status,
      };
    });
  }

  static async updateBooking(user: AuthUser, id: number, input: UpdateBookingInput) {
    const existing = await queryOne<{ id: number; location_id: number; status: string }>(
      'SELECT id, location_id, status FROM travel_bookings WHERE id = ?',
      [id],
    );
    if (!existing) throw ApiError.notFound('Travel booking not found.');

    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(Number(existing.location_id))) {
      throw ApiError.forbidden('You do not have permission to update bookings for this store location.');
    }

    return transaction(async (conn: PoolConnection) => {
      const updates: string[] = [];
      const params: unknown[] = [];

      if (input.transportType) { updates.push('transport_type = ?'); params.push(input.transportType); }
      if (input.journeyDate) { updates.push('journey_date = ?'); params.push(input.journeyDate); }
      if (input.journeyTime !== undefined) { updates.push('journey_time = ?'); params.push(input.journeyTime); }
      if (input.returnDate !== undefined) { updates.push('return_date = ?'); params.push(input.returnDate); }
      if (input.sourceLocation) { updates.push('source_location = ?'); params.push(input.sourceLocation); }
      if (input.destinationLocation) { updates.push('destination_location = ?'); params.push(input.destinationLocation); }
      if (input.boardingPoint !== undefined) { updates.push('boarding_point = ?'); params.push(input.boardingPoint); }
      if (input.droppingPoint !== undefined) { updates.push('dropping_point = ?'); params.push(input.droppingPoint); }
      if (input.operatorOrTrainName !== undefined) { updates.push('operator_or_train_name = ?'); params.push(input.operatorOrTrainName); }
      if (input.trainNumber !== undefined) { updates.push('train_number = ?'); params.push(input.trainNumber); }
      if (input.pnrOrTicketNumber !== undefined) { updates.push('pnr_or_ticket_number = ?'); params.push(input.pnrOrTicketNumber); }
      if (input.seatClass !== undefined) { updates.push('seat_class = ?'); params.push(input.seatClass); }
      if (input.seatNumbers !== undefined) { updates.push('seat_numbers = ?'); params.push(input.seatNumbers); }
      if (input.totalAmount !== undefined) { updates.push('total_amount = ?'); params.push(input.totalAmount); }
      if (input.purpose !== undefined) { updates.push('purpose = ?'); params.push(input.purpose); }
      if (input.notes !== undefined) { updates.push('notes = ?'); params.push(input.notes); }
      if (input.attachmentUrl !== undefined) { updates.push('attachment_url = ?'); params.push(input.attachmentUrl); }

      if (Array.isArray(input.passengers) && input.passengers.length > 0) {
        updates.push('passenger_count = ?');
        params.push(input.passengers.length);

        await txExecute(conn, 'DELETE FROM travel_passengers WHERE booking_id = ?', [id]);
        for (const p of input.passengers) {
          await txExecute(
            conn,
            `INSERT INTO travel_passengers (
              booking_id, passenger_name, age, gender, seat_berth, ticket_number, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              p.passengerName.trim(),
              p.age || null,
              p.gender || null,
              p.seatBerth || null,
              p.ticketNumber || null,
              p.status || 'confirmed',
            ],
          );
        }
      }

      if (updates.length > 0) {
        params.push(id);
        await txExecute(conn, `UPDATE travel_bookings SET ${updates.join(', ')} WHERE id = ?`, params);
      }

      await txExecute(
        conn,
        `INSERT INTO travel_booking_logs (
          booking_id, actor_id, action, previous_status, new_status, remarks
        ) VALUES (?, ?, 'updated', ?, ?, 'Booking details updated')`,
        [id, user.id, existing.status, existing.status],
      );

      broadcastEvent('travel:updated', {
        bookingId: id,
        action: 'updated',
        locationId: Number(existing.location_id),
      });

      return { success: true };
    });
  }

  static async changeStatus(
    user: AuthUser,
    id: number,
    status: 'requested' | 'pending' | 'confirmed' | 'cancelled' | 'rejected' | 'completed',
    cancellationReason?: string,
    remarks?: string,
  ) {
    const existing = await queryOne<{ id: number; location_id: number; status: string }>(
      'SELECT id, location_id, status FROM travel_bookings WHERE id = ?',
      [id],
    );
    if (!existing) throw ApiError.notFound('Travel booking not found.');

    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(Number(existing.location_id))) {
      throw ApiError.forbidden('You do not have permission to update bookings for this store location.');
    }

    return transaction(async (conn: PoolConnection) => {
      if (status === 'cancelled') {
        await txExecute(
          conn,
          `UPDATE travel_bookings SET
            status = 'cancelled',
            cancellation_reason = ?,
            cancelled_at = NOW(),
            cancelled_by_id = ?
           WHERE id = ?`,
          [cancellationReason || 'Cancelled by manager/HR', user.id, id],
        );
        await txExecute(conn, "UPDATE travel_passengers SET status = 'cancelled' WHERE booking_id = ?", [id]);
      } else {
        await txExecute(conn, 'UPDATE travel_bookings SET status = ? WHERE id = ?', [status, id]);
        if (status === 'confirmed') {
          await txExecute(conn, "UPDATE travel_passengers SET status = 'confirmed' WHERE booking_id = ? AND status != 'cancelled'", [id]);
        }
      }

      await txExecute(
        conn,
        `INSERT INTO travel_booking_logs (
          booking_id, actor_id, action, previous_status, new_status, remarks
        ) VALUES (?, ?, 'status_changed', ?, ?, ?)`,
        [id, user.id, existing.status, status, remarks || cancellationReason || `Status changed to ${status}`],
      );

      broadcastEvent('travel:updated', {
        bookingId: id,
        action: 'status_changed',
        newStatus: status,
        locationId: Number(existing.location_id),
      });

      return { success: true, status };
    });
  }

  static async exportBookingsCsv(user: AuthUser, filters: BookingFilters = {}): Promise<string> {
    const result = await this.listBookings(user, { ...filters, limit: 10000, page: 1 });
    const headers = [
      'Booking ID',
      'Booking Date',
      'Transport Type',
      'Status',
      'Employee Code',
      'Employee Name',
      'Store Location',
      'Source',
      'Destination',
      'Journey Date',
      'Journey Time',
      'Passengers Count',
      'Passenger Names',
      'Operator / Train',
      'Train Number',
      'PNR / Ticket Number',
      'Class',
      'Seat Numbers',
      'Total Amount (INR)',
      'Purpose',
      'Booked By',
      'Cancellation Reason',
    ];

    const escapeCsv = (val: unknown) => {
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""');
      return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
    };

    const lines: string[] = ['\uFEFF' + headers.map(escapeCsv).join(',')];

    for (const b of result.items) {
      const passengerNames = b.passengers.map((p) => p.passengerName).join('; ');
      lines.push(
        [
          escapeCsv(b.bookingReference),
          escapeCsv(b.bookingDate),
          escapeCsv(b.transportType.toUpperCase()),
          escapeCsv(b.status.toUpperCase()),
          escapeCsv(b.employeeCode),
          escapeCsv(b.employeeName),
          escapeCsv(`${b.locationCode} - ${b.locationName}`),
          escapeCsv(b.sourceLocation),
          escapeCsv(b.destinationLocation),
          escapeCsv(b.journeyDate),
          escapeCsv(b.journeyTime || ''),
          escapeCsv(b.passengerCount),
          escapeCsv(passengerNames),
          escapeCsv(b.operatorOrTrainName || ''),
          escapeCsv(b.trainNumber || ''),
          escapeCsv(b.pnrOrTicketNumber || ''),
          escapeCsv(b.seatClass || ''),
          escapeCsv(b.seatNumbers || ''),
          escapeCsv(b.totalAmount.toFixed(2)),
          escapeCsv(b.purpose || ''),
          escapeCsv(b.bookedByName),
          escapeCsv(b.cancellationReason || ''),
        ].join(','),
      );
    }

    return lines.join('\n');
  }
}
