import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { TravelService } from '../services/TravelService.js';
export const travelRouter = Router();
travelRouter.use(authenticate);
// 1. Dashboard summary (Real-time live metrics)
travelRouter.get('/dashboard', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'reports.view.all', 'travel.view.all', 'travel.view.team', 'travel.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const summary = await TravelService.getSummary(user, locationId);
    res.json(summary);
}));
// 2. Record simplified daily ticket count (Bus or Train)
const RecordDailyCountSchema = z.object({
    ticketType: z.enum(['bus', 'train']),
    ticketCount: z.number().int().positive('Total ticket count must be a positive whole number (minimum 1)'),
    notes: z.string().max(255).optional().nullable(),
    locationId: z.number().int().positive().optional(),
});
travelRouter.post('/counts', requireAny('employees.manage', 'travel.manage', 'travel.view.own', 'travel.view.team', 'travel.view.all', 'admin.dashboard'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(RecordDailyCountSchema, req.body);
    const result = await TravelService.recordDailyCount(user, {
        ticketType: body.ticketType,
        ticketCount: body.ticketCount,
        notes: body.notes || undefined,
        locationId: body.locationId,
    });
    res.status(201).json(result);
}));
// 3. List Date-Wise Ticket Booking History
travelRouter.get('/daily-history', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'reports.view.all', 'travel.view.all', 'travel.view.team', 'travel.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const datePreset = req.query.datePreset;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const ticketType = req.query.ticketType;
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const result = await TravelService.listDailyHistory(user, {
        datePreset,
        startDate,
        endDate,
        ticketType,
        locationId,
        search,
        page,
        limit,
    });
    res.json(result);
}));
// 4. Get detailed individual entries for a specific date and store
travelRouter.get('/daily-history/entries', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'reports.view.all', 'travel.view.all', 'travel.view.team', 'travel.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const date = req.query.date ? String(req.query.date) : undefined;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw ApiError.badRequest('A valid date in YYYY-MM-DD format is required.');
    }
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const entries = await TravelService.getDateEntries(user, date, locationId);
    res.json(entries);
}));
// 5. Edit and correct a previously entered ticket count (HR / Admin only)
const EditTicketCountSchema = z.object({
    ticketCount: z.number().int().positive('Corrected ticket count must be a positive whole number (minimum 1)'),
    reason: z.string().max(255).optional(),
});
travelRouter.patch('/counts/:id', requireAny('employees.manage', 'travel.manage', 'admin.dashboard'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(EditTicketCountSchema, req.body);
    const result = await TravelService.editTicketCount(user, id, body.ticketCount, body.reason);
    res.json(result);
}));
// 6. Export Date-Wise History to Excel CSV
travelRouter.get('/daily-history/export', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'reports.view.all', 'travel.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const datePreset = req.query.datePreset;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const ticketType = req.query.ticketType;
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const csv = await TravelService.exportDailyHistory(user, {
        datePreset,
        startDate,
        endDate,
        ticketType,
        locationId,
        search,
    });
    const filename = `BSC_Daily_Ticket_Booking_Report_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
}));
// 7. Daily chart trend
travelRouter.get('/reports/chart', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'travel.view.all', 'travel.view.team', 'reports.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const chart = await TravelService.getDailyChart(user, { locationId, startDate, endDate });
    res.json(chart);
}));
// =========================================================================
// Legacy Booking Endpoints
// =========================================================================
travelRouter.get('/bookings', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'reports.view.all', 'travel.view.all', 'travel.view.team', 'travel.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const transportType = req.query.transportType;
    const status = req.query.status ? String(req.query.status) : undefined;
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const datePreset = req.query.datePreset;
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
}));
travelRouter.get('/bookings/:id', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'travel.view.all', 'travel.view.team', 'travel.view.own'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const booking = await TravelService.getBooking(user, id);
    res.json(booking);
}));
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
travelRouter.post('/bookings', requireAny('employees.manage', 'travel.manage', 'admin.dashboard', 'reports.review'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(CreateBookingSchema, req.body);
    const result = await TravelService.createBooking(user, body);
    res.status(201).json(result);
}));
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
travelRouter.put('/bookings/:id', requireAny('employees.manage', 'travel.manage', 'admin.dashboard', 'reports.review'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(UpdateBookingSchema, req.body);
    const result = await TravelService.updateBooking(user, id, body);
    res.json(result);
}));
const StatusSchema = z.object({
    status: z.enum(['requested', 'pending', 'confirmed', 'cancelled', 'rejected', 'completed']),
    cancellationReason: z.string().max(255).optional(),
    remarks: z.string().max(500).optional(),
});
travelRouter.patch('/bookings/:id/status', requireAny('employees.manage', 'travel.manage', 'admin.dashboard', 'reports.review'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = intParam(req.params.id);
    const body = parseBody(StatusSchema, req.body);
    const result = await TravelService.changeStatus(user, id, body.status, body.cancellationReason, body.remarks);
    res.json(result);
}));
travelRouter.get('/reports/export', requireAny('admin.dashboard', 'employees.view.all', 'employees.view.team', 'employees.manage', 'travel.view.all', 'reports.view.all'), asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const transportType = req.query.transportType;
    const status = req.query.status ? String(req.query.status) : undefined;
    const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    const datePreset = req.query.datePreset;
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
}));
//# sourceMappingURL=travel.js.map