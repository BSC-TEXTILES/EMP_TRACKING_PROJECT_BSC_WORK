import { execute, query, queryOne, transaction, txExecute, type PoolConnection } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { allowedLocationIds, requestedLocation } from '../lib/scope.js';
import { broadcastEvent } from '../realtime/io.js';
import type { AuthUser } from './AuthService.js';

export interface TravelSummary {
  today: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    pendingBookings: number;
    confirmedBookings: number;
    cancelledBookings: number;
  };
  thisWeek: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
  };
  thisMonth: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalAmount: number;
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
    monthTickets: number;
    activeBookings: number;
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
  bookingDate?: string; // YYYY-MM-DD
  journeyDate: string;  // YYYY-MM-DD
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
    tablePrefix = 'b',
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
        clause = ` AND ${tablePrefix}.location_id = 0`; // No access
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
    const { clause: locClause, params: locParams } = await this.buildLocationFilter(user, locationId, 'b');

    // 1. Today's live stats (based on booking_date)
    const todayStats = await queryOne<{
      total_tickets: number;
      bus_tickets: number;
      train_tickets: number;
      total_bookings: number;
      pending_bookings: number;
      confirmed_bookings: number;
      cancelled_bookings: number;
    }>(
      `SELECT
        COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS total_tickets,
        COALESCE(SUM(CASE WHEN b.transport_type = 'bus' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN b.transport_type = 'train' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS train_tickets,
        COUNT(*) AS total_bookings,
        COALESCE(SUM(b.status IN ('pending', 'requested')), 0) AS pending_bookings,
        COALESCE(SUM(b.status = 'confirmed'), 0) AS confirmed_bookings,
        COALESCE(SUM(b.status = 'cancelled'), 0) AS cancelled_bookings
       FROM travel_bookings b
       WHERE b.booking_date = CURDATE() ${locClause}`,
      locParams,
    );

    // 2. This week stats
    const weekStats = await queryOne<{
      total_tickets: number;
      bus_tickets: number;
      train_tickets: number;
      total_bookings: number;
    }>(
      `SELECT
        COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS total_tickets,
        COALESCE(SUM(CASE WHEN b.transport_type = 'bus' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN b.transport_type = 'train' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS train_tickets,
        COUNT(*) AS total_bookings
       FROM travel_bookings b
       WHERE b.booking_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
         AND b.booking_date <= CURDATE() ${locClause}`,
      locParams,
    );

    // 3. This month stats
    const monthStats = await queryOne<{
      total_tickets: number;
      bus_tickets: number;
      train_tickets: number;
      total_bookings: number;
      total_amount: number;
    }>(
      `SELECT
        COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS total_tickets,
        COALESCE(SUM(CASE WHEN b.transport_type = 'bus' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN b.transport_type = 'train' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS train_tickets,
        COUNT(*) AS total_bookings,
        COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.total_amount ELSE 0 END), 0) AS total_amount
       FROM travel_bookings b
       WHERE b.booking_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
         AND b.booking_date <= CURDATE() ${locClause}`,
      locParams,
    );

    // 4. By status breakdown for current month
    const statusRows = await query<{ status: string; count: number }>(
      `SELECT b.status, COUNT(*) AS count
       FROM travel_bookings b
       WHERE b.booking_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01') ${locClause}
       GROUP BY b.status`,
      locParams,
    );
    const byStatus: TravelSummary['byStatus'] = {
      requested: 0,
      pending: 0,
      confirmed: 0,
      cancelled: 0,
      rejected: 0,
      completed: 0,
    };
    for (const row of statusRows) {
      if (row.status in byStatus) {
        byStatus[row.status as keyof typeof byStatus] = Number(row.count);
      }
    }

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
      month_tickets: number;
      active_bookings: number;
    }>(
      `SELECT
        l.id AS location_id,
        l.code,
        l.name,
        COALESCE((
          SELECT SUM(CASE WHEN b.status != 'cancelled' THEN b.passenger_count ELSE 0 END)
          FROM travel_bookings b
          WHERE b.location_id = l.id AND b.booking_date = CURDATE()
        ), 0) AS today_tickets,
        COALESCE((
          SELECT SUM(CASE WHEN b.transport_type = 'bus' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END)
          FROM travel_bookings b
          WHERE b.location_id = l.id AND b.booking_date = CURDATE()
        ), 0) AS today_bus,
        COALESCE((
          SELECT SUM(CASE WHEN b.transport_type = 'train' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END)
          FROM travel_bookings b
          WHERE b.location_id = l.id AND b.booking_date = CURDATE()
        ), 0) AS today_train,
        COALESCE((
          SELECT SUM(CASE WHEN b.status != 'cancelled' THEN b.passenger_count ELSE 0 END)
          FROM travel_bookings b
          WHERE b.location_id = l.id AND b.booking_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        ), 0) AS month_tickets,
        COALESCE((
          SELECT COUNT(*)
          FROM travel_bookings b
          WHERE b.location_id = l.id AND b.status IN ('confirmed', 'pending', 'requested')
        ), 0) AS active_bookings
       FROM locations l
       ${storeLocFilter}
       ORDER BY l.id ASC`,
      storeLocParams,
    );

    return {
      today: {
        totalTickets: Number(todayStats?.total_tickets ?? 0),
        busTickets: Number(todayStats?.bus_tickets ?? 0),
        trainTickets: Number(todayStats?.train_tickets ?? 0),
        totalBookings: Number(todayStats?.total_bookings ?? 0),
        pendingBookings: Number(todayStats?.pending_bookings ?? 0),
        confirmedBookings: Number(todayStats?.confirmed_bookings ?? 0),
        cancelledBookings: Number(todayStats?.cancelled_bookings ?? 0),
      },
      thisWeek: {
        totalTickets: Number(weekStats?.total_tickets ?? 0),
        busTickets: Number(weekStats?.bus_tickets ?? 0),
        trainTickets: Number(weekStats?.train_tickets ?? 0),
        totalBookings: Number(weekStats?.total_bookings ?? 0),
      },
      thisMonth: {
        totalTickets: Number(monthStats?.total_tickets ?? 0),
        busTickets: Number(monthStats?.bus_tickets ?? 0),
        trainTickets: Number(monthStats?.train_tickets ?? 0),
        totalBookings: Number(monthStats?.total_bookings ?? 0),
        totalAmount: Number(monthStats?.total_amount ?? 0),
      },
      byStatus,
      byStore: storeRows.map((r) => ({
        locationId: Number(r.location_id),
        code: r.code,
        name: r.name,
        todayTickets: Number(r.today_tickets),
        todayBus: Number(r.today_bus),
        todayTrain: Number(r.today_train),
        monthTickets: Number(r.month_tickets),
        activeBookings: Number(r.active_bookings),
      })),
    };
  }

  /**
   * List travel bookings with pagination, store isolation, transport type, and date filters
   */
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

    // Date filters (on booking_date)
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

    // Search filter
    if (filters.search && filters.search.trim()) {
      const q = `%${filters.search.trim()}%`;
      conditions.push(`(
        b.booking_reference LIKE ? OR
        b.pnr_or_ticket_number LIKE ? OR
        b.operator_or_train_name LIKE ? OR
        b.source_location LIKE ? OR
        b.destination_location LIKE ? OR
        e.full_name LIKE ? OR
        e.employee_code LIKE ? OR
        EXISTS (SELECT 1 FROM travel_passengers tp WHERE tp.booking_id = b.id AND tp.passenger_name LIKE ?)
      )`);
      params.push(q, q, q, q, q, q, q, q);
    }

    const whereClause = conditions.join(' AND ');

    // Count
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

    // Fetch passenger names snippet for listed bookings
    const bookingIds = rows.map((r) => r.id);
    let passengerMap: Record<number, Array<{ id: number; passengerName: string; seatBerth: string | null; status: string }>> = {};
    if (bookingIds.length > 0) {
      const pRows = await query<{
        id: number;
        booking_id: number;
        passenger_name: string;
        seat_berth: string | null;
        status: string;
      }>(
        `SELECT id, booking_id, passenger_name, seat_berth, status
         FROM travel_passengers
         WHERE booking_id IN (${bookingIds.map(() => '?').join(',')})
         ORDER BY id ASC`,
        bookingIds,
      );
      passengerMap = pRows.reduce((acc, p) => {
        const bid = Number(p.booking_id);
        if (!acc[bid]) acc[bid] = [];
        acc[bid].push({
          id: Number(p.id),
          passengerName: p.passenger_name,
          seatBerth: p.seat_berth,
          status: p.status,
        });
        return acc;
      }, {} as typeof passengerMap);
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
        status: r.status,
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
        passengers: passengerMap[Number(r.id)] ?? [],
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get single booking with all passengers and full activity audit trail
   */
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

    // Assert user has access to this location
    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(Number(row.location_id))) {
      throw ApiError.forbidden('You do not have permission to view bookings for this store location.');
    }

    // Passengers
    const passengers = await query<{
      id: number;
      passenger_name: string;
      age: number | null;
      gender: string | null;
      seat_berth: string | null;
      ticket_number: string | null;
      status: string;
      created_at: string;
    }>(
      `SELECT id, passenger_name, age, gender, seat_berth, ticket_number, status,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM travel_passengers
       WHERE booking_id = ?
       ORDER BY id ASC`,
      [id],
    );

    // Audit logs
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
      status: row.status,
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
        createdAt: p.created_at,
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

  /**
   * Create a new travel booking with multi-passenger support & audit log
   */
  static async createBooking(user: AuthUser, input: CreateBookingInput) {
    // 1. Validate employee & target location
    const emp = await queryOne<{ id: number; location_id: number; full_name: string }>(
      'SELECT id, location_id, full_name FROM employees WHERE id = ?',
      [input.employeeId],
    );
    if (!emp) throw ApiError.badRequest('Selected employee does not exist.');

    const targetLocationId = input.locationId ? Number(input.locationId) : Number(emp.location_id);
    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(targetLocationId)) {
      throw ApiError.forbidden('You cannot book travel for an employee outside your permitted store locations.');
    }

    const passengerCount = Array.isArray(input.passengers) && input.passengers.length > 0 ? input.passengers.length : 1;
    const bookingDate = input.bookingDate || new Date().toISOString().split('T')[0];

    // Generate unique reference
    const dateStr = bookingDate.replace(/-/g, '');
    const randomSuffix = Math.floor(100 + Math.random() * 900);
    const bookingReference = `TRV-${dateStr}-${randomSuffix}`;

    return transaction(async (conn: PoolConnection) => {
      const res = await txExecute(
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
          targetLocationId,
          input.transportType,
          input.status || 'confirmed',
          bookingDate,
          input.journeyDate,
          input.journeyTime || null,
          input.returnDate || null,
          input.sourceLocation,
          input.destinationLocation,
          input.boardingPoint || null,
          input.droppingPoint || null,
          input.operatorOrTrainName || null,
          input.trainNumber || null,
          input.pnrOrTicketNumber || null,
          input.seatClass || null,
          input.seatNumbers || null,
          passengerCount,
          input.totalAmount || 0,
          input.purpose || null,
          user.id,
          input.notes || null,
          input.attachmentUrl || null,
        ],
      );
      const bookingId = Number(res.insertId);

      // Insert passengers
      const passengersToInsert =
        Array.isArray(input.passengers) && input.passengers.length > 0
          ? input.passengers
          : [{ passengerName: emp.full_name, status: input.status === 'cancelled' ? ('cancelled' as const) : ('confirmed' as const) }];

      for (const p of passengersToInsert) {
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
            p.ticketNumber || input.pnrOrTicketNumber || null,
            p.status || (input.status === 'cancelled' ? 'cancelled' : 'confirmed'),
          ],
        );
      }

      // Initial audit log
      await txExecute(
        conn,
        `INSERT INTO travel_booking_logs (
          booking_id, actor_id, action, previous_status, new_status, remarks
        ) VALUES (?, ?, 'created', NULL, ?, ?)`,
        [bookingId, user.id, input.status || 'confirmed', input.notes || 'Booking entered into system'],
      );

      // Broadcast realtime event
      broadcastEvent('travel:updated', {
        bookingId,
        action: 'created',
        locationId: targetLocationId,
        transportType: input.transportType,
      });

      return { bookingId, bookingReference };
    });
  }

  /**
   * Update booking details
   */
  static async updateBooking(user: AuthUser, id: number, input: UpdateBookingInput) {
    const existing = await queryOne<{ id: number; location_id: number; status: string }>(
      'SELECT id, location_id, status FROM travel_bookings WHERE id = ?',
      [id],
    );
    if (!existing) throw ApiError.notFound('Travel booking not found.');

    const allowed = await allowedLocationIds(user);
    if (allowed !== null && !allowed.includes(Number(existing.location_id))) {
      throw ApiError.forbidden('You do not have permission to modify bookings for this location.');
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

        // Replace passengers
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

  /**
   * Change booking status (e.g. Confirm, Cancel, Reject, Complete)
   */
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
        // Also update passengers status to cancelled
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

  /**
   * Get daily trend chart points for bus vs train tickets
   */
  static async getDailyChart(
    user: AuthUser,
    filters: { locationId?: number; startDate?: string; endDate?: string } = {},
  ) {
    const { clause: locClause, params: locParams } = await this.buildLocationFilter(user, filters.locationId, 'b');

    // Default to last 14 days up to today
    let dateFilter = 'b.booking_date >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) AND b.booking_date <= CURDATE()';
    const params: unknown[] = [...locParams];

    if (filters.startDate && filters.endDate) {
      dateFilter = 'b.booking_date BETWEEN ? AND ?';
      params.unshift(filters.startDate, filters.endDate);
    } else if (filters.startDate) {
      dateFilter = 'b.booking_date >= ? AND b.booking_date <= CURDATE()';
      params.unshift(filters.startDate);
    }

    const rows = await query<{
      booking_date: string;
      bus_tickets: number;
      train_tickets: number;
      total_tickets: number;
    }>(
      `SELECT
        DATE_FORMAT(b.booking_date, '%Y-%m-%d') AS booking_date,
        COALESCE(SUM(CASE WHEN b.transport_type = 'bus' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS bus_tickets,
        COALESCE(SUM(CASE WHEN b.transport_type = 'train' AND b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS train_tickets,
        COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.passenger_count ELSE 0 END), 0) AS total_tickets
       FROM travel_bookings b
       WHERE ${dateFilter} ${locClause}
       GROUP BY b.booking_date
       ORDER BY b.booking_date ASC`,
      params,
    );

    return rows.map((r) => ({
      date: r.booking_date,
      bus: Number(r.bus_tickets),
      train: Number(r.train_tickets),
      total: Number(r.total_tickets),
    }));
  }

  /**
   * Export bookings as CSV format for Excel report download
   */
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

    const lines: string[] = [headers.join(',')];

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
