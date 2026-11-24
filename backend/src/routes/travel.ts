import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { TravelService } from '../services/TravelService.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const travelRouter = Router();
travelRouter.use(authenticate);

// 1. Dashboard summary
travelRouter.get(
  '/dashboard',
  requireAny(
    'admin.dashboard',
    'employees.view.all',
    'employees.view.team',
    'employees.manage',
    'reports.view.all',
    'travel.view.all',
    'travel.view.team',
    'travel.view.own',
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const summary = await TravelService.getSummary(user, locationId);
    res.json(summary);
  }),
);

// 2. List bookings with filters
travelRouter.get(
  '/bookings',
  requireAny(
    'admin.dashboard',
    'employees.view.all',
    'employees.view.team',
    'employees.manage',
    'reports.view.all',
    'travel.view.all',
    'travel.view.team',
    'travel.view.own',
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const transportType = req.query.transportType as 'bus' | 'train' | 'all' | undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const datePreset = req.query.datePreset as any;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const result = await TravelService.listBookings(user, {
      transportType,
      status,
      locationId,
      employeeId,
      datePreset,
      startDate,
      endDate,
      search,
      page,
      limit,
    });
    res.json(result);
  }),
);

// 3. Get single booking
travelRouter.get(
  '/bookings/:id',
  requireAny(
    'admin.dashboard',
    'employees.view.all',
    'employees.view.team',
    'employees.manage',
    'travel.view.all',
    'travel.view.team',
    'travel.view.own',
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const booking = await TravelService.getBooking(user, id);
    res.json(booking);
  }),
);

// 4. Create booking
const PassengerSchema = z.object({
  passengerName: z.string().min(2).max(150),
  age: z.number().int().min(1).max(120).optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  seatBerth: z.string().max(32).optional().nullable(),
  ticketNumber: z.string().max(64).optional().nullable(),
  status: z.enum(['confirmed', 'cancelled', 'waitlisted', 'rac']).optional(),
});

const CreateBookingSchema = z.object({
  employeeId: z.number().int().positive(),
  locationId: z.number().int().positive().optional(),
  transportType: z.enum(['bus', 'train']),
  status: z.enum(['requested', 'pending', 'confirmed', 'cancelled', 'rejected', 'completed']).optional(),
  bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  journeyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  journeyTime: z.string().max(20).optional().nullable(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  sourceLocation: z.string().min(2).max(150),
  destinationLocation: z.string().min(2).max(150),
  boardingPoint: z.string().max(150).optional().nullable(),
  droppingPoint: z.string().max(150).optional().nullable(),
  operatorOrTrainName: z.string().max(150).optional().nullable(),
  trainNumber: z.string().max(32).optional().nullable(),
  pnrOrTicketNumber: z.string().max(64).optional().nullable(),
  seatClass: z.string().max(50).optional().nullable(),
  seatNumbers: z.string().max(100).optional().nullable(),
  totalAmount: z.number().nonnegative().optional(),
  purpose: z.string().max(255).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  attachmentUrl: z.string().max(500).optional().nullable(),
  passengers: z.array(PassengerSchema).min(1),
});

travelRouter.post(
  '/bookings',
  requireAny('employees.manage', 'travel.manage', 'admin.dashboard', 'reports.review'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(CreateBookingSchema, req.body);
    const result = await TravelService.createBooking(user, body);
    res.status(201).json(result);
  }),
);

// 5. Update booking
const UpdateBookingSchema = z.object({
  transportType: z.enum(['bus', 'train']).optional(),
  status: z.enum(['requested', 'pending', 'confirmed', 'cancelled', 'rejected', 'completed']).optional(),
  bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  journeyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  journeyTime: z.string().max(20).optional().nullable(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  sourceLocation: z.string().min(2).max(150).optional(),
  destinationLocation: z.string().min(2).max(150).optional(),
  boardingPoint: z.string().max(150).optional().nullable(),
  droppingPoint: z.string().max(150).optional().nullable(),
  operatorOrTrainName: z.string().max(150).optional().nullable(),
  trainNumber: z.string().max(32).optional().nullable(),
  pnrOrTicketNumber: z.string().max(64).optional().nullable(),
  seatClass: z.string().max(50).optional().nullable(),
  seatNumbers: z.string().max(100).optional().nullable(),
  totalAmount: z.number().nonnegative().optional(),
  purpose: z.string().max(255).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  attachmentUrl: z.string().max(500).optional().nullable(),
  cancellationReason: z.string().max(255).optional().nullable(),
  passengers: z.array(PassengerSchema).optional(),
});

travelRouter.put(
  '/bookings/:id',
  requireAny('employees.manage', 'travel.manage', 'admin.dashboard', 'reports.review'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(UpdateBookingSchema, req.body);
    const result = await TravelService.updateBooking(user, id, body);
    res.json(result);
  }),
);

// 6. Update booking status / Cancel booking
const StatusSchema = z.object({
  status: z.enum(['requested', 'pending', 'confirmed', 'cancelled', 'rejected', 'completed']),
  cancellationReason: z.string().max(255).optional(),
  remarks: z.string().max(500).optional(),
});

travelRouter.patch(
  '/bookings/:id/status',
  requireAny('employees.manage', 'travel.manage', 'admin.dashboard', 'reports.review'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(StatusSchema, req.body);
    const result = await TravelService.changeStatus(user, id, body.status, body.cancellationReason, body.remarks);
    res.json(result);
  }),
);

// 7. Daily chart trend
travelRouter.get(
  '/reports/chart',
  requireAny(
    'admin.dashboard',
    'employees.view.all',
    'employees.view.team',
    'employees.manage',
    'travel.view.all',
    'travel.view.team',
    'reports.view.all',
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;

    const chart = await TravelService.getDailyChart(user, { locationId, startDate, endDate });
    res.json(chart);
  }),
);

// 8. Export CSV for Excel reports
travelRouter.get(
  '/reports/export',
  requireAny(
    'admin.dashboard',
    'employees.view.all',
    'employees.view.team',
    'employees.manage',
    'travel.view.all',
    'reports.view.all',
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const transportType = req.query.transportType as 'bus' | 'train' | 'all' | undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const datePreset = req.query.datePreset as any;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;

    const csv = await TravelService.exportBookingsCsv(user, {
      transportType,
      status,
      locationId,
      employeeId,
      datePreset,
      startDate,
      endDate,
      search,
    });

    const filename = `BSC_Travel_Bookings_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }),
);
