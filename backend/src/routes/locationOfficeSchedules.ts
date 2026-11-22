import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { query, queryOne, execute, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { today, addDays } from '../lib/dates.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const locationOfficeSchedulesRouter = Router();
locationOfficeSchedulesRouter.use(authenticate, requireAny('settings.manage', 'attendance.admin'));

// Validation schemas
const scheduleSchema = z.object({
  locationId: z.number().int().positive(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  workStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  workEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  breakStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  breakEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  secondBreakStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  secondBreakEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  totalWorkingHours: z.number().positive().max(24).optional(),
  weeklyWorkingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  weeklyOffDay: z.number().int().min(0).max(6).nullable().optional(),
  graceMinutes: z.number().int().min(0).max(120).optional(),
  earlyDepartureThresholdMinutes: z.number().int().min(0).max(480).optional(),
  isActive: z.boolean().optional(),
});

const bulkUpdateSchema = z.object({
  schedules: z.array(scheduleSchema.extend({
    locationId: z.number().int().positive(),
  })).min(1).max(10),
});

// GET all location office schedules
locationOfficeSchedulesRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const { locationId, activeOnly, date } = req.query;
    const targetDate = date ? String(date) : today();

    let whereClause = 'WHERE 1=1';
    const params: unknown[] = [];

    if (locationId) {
      whereClause += ' AND los.location_id = ?';
      params.push(intParam(String(locationId), 'locationId'));
    }

    if (activeOnly === 'true') {
      whereClause += ' AND los.is_active = 1';
    }

    // Get the most recent schedule for each location effective on or before the target date
    const schedules = await query<{
      id: number;
      location_id: number;
      location_code: string;
      location_name: string;
      effective_date: string;
      work_start_time: string;
      work_end_time: string;
      break_start_time: string | null;
      break_end_time: string | null;
      second_break_start_time: string | null;
      second_break_end_time: string | null;
      total_working_hours: number;
      weekly_working_days: string;
      weekly_off_day: number | null;
      grace_minutes: number;
      early_departure_threshold_minutes: number;
      is_active: number;
      created_by: number | null;
      updated_by: number | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT los.*, l.code AS location_code, l.name AS location_name
       FROM location_office_schedules los
       JOIN locations l ON l.id = los.location_id
       ${whereClause}
       AND los.effective_date <= ?
       ORDER BY los.location_id, los.effective_date DESC`,
      [...params, targetDate],
    );

    // Group by location and get the most recent effective schedule for each
    const locationMap = new Map<number, typeof schedules[0]>();
    for (const schedule of schedules) {
      if (!locationMap.has(schedule.location_id)) {
        locationMap.set(schedule.location_id, schedule);
      }
    }

    const result = Array.from(locationMap.values()).map((s) => ({
      id: s.id,
      locationId: s.location_id,
      locationCode: s.location_code,
      locationName: s.location_name,
      effectiveDate: s.effective_date,
      workStartTime: s.work_start_time.slice(0, 5),
      workEndTime: s.work_end_time.slice(0, 5),
      breakStartTime: s.break_start_time?.slice(0, 5) ?? null,
      breakEndTime: s.break_end_time?.slice(0, 5) ?? null,
      secondBreakStartTime: s.second_break_start_time?.slice(0, 5) ?? null,
      secondBreakEndTime: s.second_break_end_time?.slice(0, 5) ?? null,
      totalWorkingHours: Number(s.total_working_hours),
      weeklyWorkingDays: JSON.parse(s.weekly_working_days),
      weeklyOffDay: s.weekly_off_day,
      graceMinutes: Number(s.grace_minutes),
      earlyDepartureThresholdMinutes: Number(s.early_departure_threshold_minutes),
      isActive: Boolean(s.is_active),
      createdBy: s.created_by,
      updatedBy: s.updated_by,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }));

    res.json({ schedules: result });
  }),
);

// GET single location schedule history
locationOfficeSchedulesRouter.get(
  '/:locationId/history',
  asyncHandler(async (req: AuthedRequest, res) => {
    const locationId = intParam(req.params.locationId);
    const schedules = await query<{
      id: number;
      location_id: number;
      effective_date: string;
      work_start_time: string;
      work_end_time: string;
      break_start_time: string | null;
      break_end_time: string | null;
      second_break_start_time: string | null;
      second_break_end_time: string | null;
      total_working_hours: number;
      weekly_working_days: string;
      weekly_off_day: number | null;
      grace_minutes: number;
      early_departure_threshold_minutes: number;
      is_active: number;
      created_by: number | null;
      updated_by: number | null;
      location_code: string;
      location_name: string;
      created_by_name: string | null;
      updated_by_name: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT los.*, l.code AS location_code, l.name AS location_name,
              cb.full_name AS created_by_name, ub.full_name AS updated_by_name
       FROM location_office_schedules los
       JOIN locations l ON l.id = los.location_id
       LEFT JOIN employees cb ON cb.id = los.created_by
       LEFT JOIN employees ub ON ub.id = los.updated_by
       WHERE los.location_id = ?
       ORDER BY los.effective_date DESC, los.id DESC`,
      [locationId],
    );

    res.json({
      schedules: schedules.map((s: any) => ({
        id: s.id,
        locationId: s.location_id,
        locationCode: s.location_code,
        locationName: s.location_name,
        effectiveDate: s.effective_date,
        workStartTime: s.work_start_time.slice(0, 5),
        workEndTime: s.work_end_time.slice(0, 5),
        breakStartTime: s.break_start_time?.slice(0, 5) ?? null,
        breakEndTime: s.break_end_time?.slice(0, 5) ?? null,
        secondBreakStartTime: s.second_break_start_time?.slice(0, 5) ?? null,
        secondBreakEndTime: s.second_break_end_time?.slice(0, 5) ?? null,
        totalWorkingHours: Number(s.total_working_hours),
        weeklyWorkingDays: JSON.parse(s.weekly_working_days),
        weeklyOffDay: s.weekly_off_day,
        graceMinutes: Number(s.grace_minutes),
        earlyDepartureThresholdMinutes: Number(s.early_departure_threshold_minutes),
        isActive: Boolean(s.is_active),
        createdBy: s.created_by,
        updatedBy: s.updated_by,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      })),
    });
  }),
);

// GET current effective schedule for a location
locationOfficeSchedulesRouter.get(
  '/:locationId/current',
  asyncHandler(async (req: AuthedRequest, res) => {
    const locationId = intParam(req.params.locationId);
    const targetDate = req.query.date ? String(req.query.date) : today();

    const schedule = await queryOne<{
      id: number;
      location_id: number;
      effective_date: string;
      work_start_time: string;
      work_end_time: string;
      break_start_time: string | null;
      break_end_time: string | null;
      second_break_start_time: string | null;
      second_break_end_time: string | null;
      total_working_hours: number;
      weekly_working_days: string;
      weekly_off_day: number | null;
      grace_minutes: number;
      early_departure_threshold_minutes: number;
      is_active: number;
    }>(
      `SELECT * FROM location_office_schedules
       WHERE location_id = ? AND effective_date <= ? AND is_active = 1
       ORDER BY effective_date DESC, id DESC LIMIT 1`,
      [locationId, targetDate],
    );

    if (!schedule) {
      res.status(404).json({ error: 'No active schedule found for this location', code: 'not_found' });
      return;
    }

    res.json({
      id: schedule.id,
      locationId: schedule.location_id,
      effectiveDate: schedule.effective_date,
      workStartTime: schedule.work_start_time.slice(0, 5),
      workEndTime: schedule.work_end_time.slice(0, 5),
      breakStartTime: schedule.break_start_time?.slice(0, 5) ?? null,
      breakEndTime: schedule.break_end_time?.slice(0, 5) ?? null,
      secondBreakStartTime: schedule.second_break_start_time?.slice(0, 5) ?? null,
      secondBreakEndTime: schedule.second_break_end_time?.slice(0, 5) ?? null,
      totalWorkingHours: Number(schedule.total_working_hours),
      weeklyWorkingDays: JSON.parse(schedule.weekly_working_days),
      weeklyOffDay: schedule.weekly_off_day,
      graceMinutes: Number(schedule.grace_minutes),
      earlyDepartureThresholdMinutes: Number(schedule.early_departure_threshold_minutes),
      isActive: Boolean(schedule.is_active),
    });
  }),
);

// CREATE a new schedule
locationOfficeSchedulesRouter.post(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(scheduleSchema, req.body);

    // Validate times
    if (body.breakStartTime && body.breakEndTime) {
      const [bSh, bSm] = body.breakStartTime.split(':').map(Number);
      const [bEh, bEm] = body.breakEndTime.split(':').map(Number);
      if (bEh * 60 + bEm <= bSh * 60 + bSm) {
        throw ApiError.badRequest('Break end time must be after break start time.');
      }
    }
    if (body.secondBreakStartTime && body.secondBreakEndTime) {
      const [bSh, bSm] = body.secondBreakStartTime.split(':').map(Number);
      const [bEh, bEm] = body.secondBreakEndTime.split(':').map(Number);
      if (bEh * 60 + bEm <= bSh * 60 + bSm) {
        throw ApiError.badRequest('Second break end time must be after second break start time.');
      }
    }
    const [workSh, workSm] = body.workStartTime.split(':').map(Number);
    const [workEh, workEm] = body.workEndTime.split(':').map(Number);
    if (workEh * 60 + workEm <= workSh * 60 + workSm) {
      throw ApiError.badRequest('Work end time must be after work start time.');
    }

    // Check if location exists and is active
    const location = await queryOne<{ id: number; code: string }>(
      'SELECT id, code FROM locations WHERE id = ? AND is_active = 1',
      [body.locationId],
    );
    if (!location) throw ApiError.notFound('Location not found or inactive.');

    // Check for conflicting schedule (same location and effective date)
    const existing = await queryOne<{ id: number }>(
      'SELECT id FROM location_office_schedules WHERE location_id = ? AND effective_date = ?',
      [body.locationId, body.effectiveDate],
    );
    if (existing) {
      throw ApiError.conflict('A schedule already exists for this location on this effective date.');
    }

    const weeklyWorkingDays = body.weeklyWorkingDays ?? [1, 2, 3, 4, 5, 6];
    const totalWorkingHours = body.totalWorkingHours ?? 9.00;

    const result = await execute(
      `INSERT INTO location_office_schedules
       (location_id, effective_date, work_start_time, work_end_time,
        break_start_time, break_end_time, second_break_start_time, second_break_end_time,
        total_working_hours, weekly_working_days, weekly_off_day, grace_minutes,
        early_departure_threshold_minutes, is_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.locationId,
        body.effectiveDate,
        body.workStartTime,
        body.workEndTime,
        body.breakStartTime ?? null,
        body.breakEndTime ?? null,
        body.secondBreakStartTime ?? null,
        body.secondBreakEndTime ?? null,
        totalWorkingHours,
        JSON.stringify(weeklyWorkingDays),
        body.weeklyOffDay ?? null,
        body.graceMinutes ?? 10,
        body.earlyDepartureThresholdMinutes ?? 0,
        body.isActive ?? true,
        user.id,
        user.id,
      ],
    );

    const newSchedule = await queryOne<{ id: number }>('SELECT id FROM location_office_schedules WHERE id = ?', [result.insertId]);

    await recordAudit({
      actorId: user.id,
      action: 'location_schedule.created',
      entityType: 'location_office_schedule',
      entityId: newSchedule!.id,
      after: body,
      ip: clientIp(req),
    });

    res.status(201).json({ id: newSchedule!.id, message: 'Schedule created successfully.' });
  }),
);

// BULK CREATE/UPDATE schedules
locationOfficeSchedulesRouter.put(
  '/bulk',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(bulkUpdateSchema, req.body);

    const results = [];
    for (const schedule of body.schedules) {
      // Validate times
      if (schedule.breakStartTime && schedule.breakEndTime) {
        const [bSh, bSm] = schedule.breakStartTime.split(':').map(Number);
        const [bEh, bEm] = schedule.breakEndTime.split(':').map(Number);
        if (bEh * 60 + bEm <= bSh * 60 + bSm) {
          throw ApiError.badRequest(`Break end time must be after break start time for location ${schedule.locationId}.`);
        }
      }
      const [workSh, workSm] = schedule.workStartTime.split(':').map(Number);
      const [workEh, workEm] = schedule.workEndTime.split(':').map(Number);
      if (workEh * 60 + workEm <= workSh * 60 + workSm) {
        throw ApiError.badRequest(`Work end time must be after work start time for location ${schedule.locationId}.`);
      }

      const weeklyWorkingDays = schedule.weeklyWorkingDays ?? [1, 2, 3, 4, 5, 6];
      const totalWorkingHours = schedule.totalWorkingHours ?? 9.00;

      await execute(
        `INSERT INTO location_office_schedules
         (location_id, effective_date, work_start_time, work_end_time,
          break_start_time, break_end_time, second_break_start_time, second_break_end_time,
          total_working_hours, weekly_working_days, weekly_off_day, grace_minutes,
          early_departure_threshold_minutes, is_active, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           work_start_time = VALUES(work_start_time),
           work_end_time = VALUES(work_end_time),
           break_start_time = VALUES(break_start_time),
           break_end_time = VALUES(break_end_time),
           second_break_start_time = VALUES(second_break_start_time),
           second_break_end_time = VALUES(second_break_end_time),
           total_working_hours = VALUES(total_working_hours),
           weekly_working_days = VALUES(weekly_working_days),
           weekly_off_day = VALUES(weekly_off_day),
           grace_minutes = VALUES(grace_minutes),
           early_departure_threshold_minutes = VALUES(early_departure_threshold_minutes),
           is_active = VALUES(is_active),
           updated_by = VALUES(updated_by),
           updated_at = CURRENT_TIMESTAMP(3)`,
        [
          schedule.locationId,
          schedule.effectiveDate,
          schedule.workStartTime,
          schedule.workEndTime,
          schedule.breakStartTime ?? null,
          schedule.breakEndTime ?? null,
          schedule.secondBreakStartTime ?? null,
          schedule.secondBreakEndTime ?? null,
          totalWorkingHours,
          JSON.stringify(weeklyWorkingDays),
          schedule.weeklyOffDay ?? null,
          schedule.graceMinutes ?? 10,
          schedule.earlyDepartureThresholdMinutes ?? 0,
          schedule.isActive ?? true,
          user.id,
          user.id,
        ],
      );

      results.push({ locationId: schedule.locationId, effectiveDate: schedule.effectiveDate, status: 'saved' });
    }

    await recordAudit({
      actorId: user.id,
      action: 'location_schedule.bulk_updated',
      entityType: 'location_office_schedule',
      after: { count: results.length },
      ip: clientIp(req),
    });

    res.json({ schedules: results, message: `${results.length} schedule(s) saved successfully.` });
  }),
);

// UPDATE a schedule
locationOfficeSchedulesRouter.put(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const scheduleId = intParam(req.params.id);
    const body = parseBody(scheduleSchema.partial(), req.body);

    const existing = await queryOne<{ id: number; location_id: number }>(
      'SELECT id, location_id FROM location_office_schedules WHERE id = ?',
      [scheduleId],
    );
    if (!existing) throw ApiError.notFound('Schedule not found.');

    // Validate times if provided
    if (body.breakStartTime && body.breakEndTime) {
      const [bSh, bSm] = body.breakStartTime.split(':').map(Number);
      const [bEh, bEm] = body.breakEndTime.split(':').map(Number);
      if (bEh * 60 + bEm <= bSh * 60 + bSm) {
        throw ApiError.badRequest('Break end time must be after break start time.');
      }
    }
    if (body.workStartTime && body.workEndTime) {
      const [workSh, workSm] = body.workStartTime.split(':').map(Number);
      const [workEh, workEm] = body.workEndTime.split(':').map(Number);
      if (workEh * 60 + workEm <= workSh * 60 + workSm) {
        throw ApiError.badRequest('Work end time must be after work start time.');
      }
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    const fieldMap: Record<string, string> = {
      effectiveDate: 'effective_date',
      workStartTime: 'work_start_time',
      workEndTime: 'work_end_time',
      breakStartTime: 'break_start_time',
      breakEndTime: 'break_end_time',
      secondBreakStartTime: 'second_break_start_time',
      secondBreakEndTime: 'second_break_end_time',
      totalWorkingHours: 'total_working_hours',
      weeklyOffDay: 'weekly_off_day',
      graceMinutes: 'grace_minutes',
      earlyDepartureThresholdMinutes: 'early_departure_threshold_minutes',
      isActive: 'is_active',
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (body[key as keyof typeof body] !== undefined) {
        updates.push(`${dbField} = ?`);
        params.push(body[key as keyof typeof body]);
      }
    }

    if (body.weeklyWorkingDays !== undefined) {
      updates.push('weekly_working_days = ?');
      params.push(JSON.stringify(body.weeklyWorkingDays));
    }
    if (body.totalWorkingHours !== undefined) {
      updates.push('total_working_hours = ?');
      params.push(body.totalWorkingHours);
    }

    if (updates.length === 0) {
      throw ApiError.badRequest('No fields to update.');
    }

    updates.push('updated_by = ?', 'updated_at = CURRENT_TIMESTAMP(3)');
    params.push(user.id, scheduleId);

    await execute(`UPDATE location_office_schedules SET ${updates.join(', ')} WHERE id = ?`, params);

    await recordAudit({
      actorId: user.id,
      action: 'location_schedule.updated',
      entityType: 'location_office_schedule',
      entityId: scheduleId,
      after: body,
      ip: clientIp(req),
    });

    res.json({ message: 'Schedule updated successfully.' });
  }),
);

// DELETE a schedule (soft delete - set is_active = 0)
locationOfficeSchedulesRouter.delete(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const scheduleId = intParam(req.params.id);

    const existing = await queryOne<{ id: number }>(
      'SELECT id FROM location_office_schedules WHERE id = ?',
      [scheduleId],
    );
    if (!existing) throw ApiError.notFound('Schedule not found.');

    await execute('UPDATE location_office_schedules SET is_active = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [user.id, scheduleId]);

    await recordAudit({
      actorId: user.id,
      action: 'location_schedule.deleted',
      entityType: 'location_office_schedule',
      entityId: scheduleId,
      ip: clientIp(req),
    });

    res.json({ message: 'Schedule deactivated successfully.' });
  }),
);