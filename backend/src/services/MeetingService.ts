import crypto from 'node:crypto';
import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { emitToEmployees, emitToMeeting } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import type { AuthUser } from './AuthService.js';

export class MeetingService {
  static async create(
    actor: AuthUser,
    input: {
      title: string;
      description?: string;
      agenda?: string;
      participantIds: number[];
      startAt: string;
      endAt: string;
      locationType?: 'online' | 'room';
      roomName?: string;
      departmentId?: number | null;
    },
    context: { ip?: string; userAgent?: string },
  ) {
    if (!input.title?.trim()) throw ApiError.badRequest('Meeting title is required.');
    const start = new Date(input.startAt);
    const end = new Date(input.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw ApiError.badRequest('Provide valid start and end times.');
    if (end <= start) throw ApiError.badRequest('Meeting end time must be after the start time.');

    const participantIds = [...new Set([actor.id, ...input.participantIds])];
    const code = crypto.randomUUID();

    const meetingId = await transaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO meetings (title, description, agenda, organizer_id, department_id, location_type, room_name, start_at, end_at, meeting_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.title.trim(),
          input.description ?? null,
          input.agenda ?? null,
          actor.id,
          input.departmentId ?? actor.departmentId ?? null,
          input.locationType ?? 'online',
          input.roomName ?? null,
          start.toISOString().slice(0, 19).replace('T', ' '),
          end.toISOString().slice(0, 19).replace('T', ' '),
          code,
        ],
      );
      const id = Number((result as { insertId: number }).insertId);
      for (const participant of participantIds) {
        await conn.query(
          "INSERT IGNORE INTO meeting_participants (meeting_id, employee_id, response) VALUES (?, ?, 'pending')",
          [id, participant],
        );
      }
      return id;
    });

    await NotificationService.notify({
      employeeIds: participantIds.filter((id) => id !== actor.id),
      type: 'meeting',
      title: 'Meeting invitation',
      body: `${actor.fullName} invited you to "${input.title.trim()}".`,
      link: `/meetings?meeting=${meetingId}`,
      priority: 'normal',
      actorId: actor.id,
    });
    await recordAudit({
      actorId: actor.id,
      action: 'meeting.created',
      entityType: 'meeting',
      entityId: meetingId,
      after: { title: input.title, participantIds, startAt: input.startAt },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    emitToEmployees(participantIds, 'meeting:created', { id: meetingId, title: input.title });
    return { id: meetingId, code };
  }

  static async list(user: AuthUser, filters: { from?: string; to?: string; upcoming?: boolean; limit?: number }) {
    const clauses = ['mp.employee_id = ?'];
    const params: unknown[] = [user.id];
    if (filters.from) {
      clauses.push('m.start_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('m.start_at <= ?');
      params.push(filters.to);
    }
    if (filters.upcoming) {
      clauses.push('m.end_at >= NOW(3)');
    }
    const limit = Math.min(200, filters.limit ?? 100);
    const rows = await query<{
      id: number;
      title: string;
      description: string | null;
      start_at: string;
      end_at: string;
      status: string;
      location_type: string;
      room_name: string | null;
      meeting_code: string;
      organizer_name: string;
      organizer_id: number;
      my_response: string;
      participant_count: number;
      accepted_count: number;
      department_name: string | null;
    }>(
      `SELECT m.id, m.title, m.description, m.start_at, m.end_at, m.status, m.location_type, m.room_name, m.meeting_code,
              o.full_name AS organizer_name, m.organizer_id, mp.response AS my_response, d.name AS department_name,
              (SELECT COUNT(*) FROM meeting_participants x WHERE x.meeting_id = m.id) AS participant_count,
              (SELECT COUNT(*) FROM meeting_participants x WHERE x.meeting_id = m.id AND x.response = 'accepted') AS accepted_count
       FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       JOIN employees o ON o.id = m.organizer_id
       LEFT JOIN departments d ON d.id = m.department_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY m.start_at ASC
       LIMIT ${limit}`,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      description: r.description,
      startAt: toIso(r.start_at),
      endAt: toIso(r.end_at),
      status: r.status,
      locationType: r.location_type,
      roomName: r.room_name,
      meetingCode: r.meeting_code,
      organizerId: Number(r.organizer_id),
      organizerName: r.organizer_name,
      myResponse: r.my_response,
      participantCount: Number(r.participant_count),
      acceptedCount: Number(r.accepted_count),
      departmentName: r.department_name,
    }));
  }

  static async detail(meetingId: number, user: AuthUser) {
    const meeting = await queryOne<{
      id: number;
      title: string;
      description: string | null;
      agenda: string | null;
      organizer_id: number;
      organizer_name: string;
      start_at: string;
      end_at: string;
      status: string;
      location_type: string;
      room_name: string | null;
      meeting_code: string;
      outcome: string | null;
      department_name: string | null;
      my_response: string | null;
    }>(
      `SELECT m.*, o.full_name AS organizer_name, d.name AS department_name, mp.response AS my_response
       FROM meetings m
       JOIN employees o ON o.id = m.organizer_id
       LEFT JOIN departments d ON d.id = m.department_id
       LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.employee_id = ?
       WHERE m.id = ?`,
      [user.id, meetingId],
    );
    if (!meeting) throw ApiError.notFound('Meeting not found');
    const isParticipant = Boolean(meeting.my_response) || Number(meeting.organizer_id) === user.id;
    if (!isParticipant && !user.permissions.includes('meetings.manage')) throw ApiError.forbidden('You are not invited to this meeting.');

    const [participants, actionItems, messages] = await Promise.all([
      query<{
        employee_id: number;
        full_name: string;
        photo_url: string | null;
        response: string;
        attended: number;
        joined_at: string | null;
        designation_title: string | null;
      }>(
        `SELECT mp.employee_id, e.full_name, e.photo_url, mp.response, mp.attended, mp.joined_at, dg.title AS designation_title
         FROM meeting_participants mp
         JOIN employees e ON e.id = mp.employee_id
         LEFT JOIN designations dg ON dg.id = e.designation_id
         WHERE mp.meeting_id = ? ORDER BY mp.response, e.full_name`,
        [meetingId],
      ),
      query<{ id: number; title: string; assignee_id: number | null; assignee_name: string | null; due_date: string | null; status: string }>(
        `SELECT mai.id, mai.title, mai.assignee_id, e.full_name AS assignee_name, mai.due_date, mai.status
         FROM meeting_action_items mai LEFT JOIN employees e ON e.id = mai.assignee_id
         WHERE mai.meeting_id = ? ORDER BY mai.id`,
        [meetingId],
      ),
      query<{ id: number; employee_id: number; full_name: string; body: string; created_at: string }>(
        `SELECT mm.id, mm.employee_id, e.full_name, mm.body, mm.created_at
         FROM meeting_messages mm JOIN employees e ON e.id = mm.employee_id
         WHERE mm.meeting_id = ? ORDER BY mm.id ASC LIMIT 200`,
        [meetingId],
      ),
    ]);

    return {
      id: Number(meeting.id),
      title: meeting.title,
      description: meeting.description,
      agenda: meeting.agenda,
      organizerId: Number(meeting.organizer_id),
      organizerName: meeting.organizer_name,
      startAt: toIso(meeting.start_at),
      endAt: toIso(meeting.end_at),
      status: meeting.status,
      locationType: meeting.location_type,
      roomName: meeting.room_name,
      meetingCode: meeting.meeting_code,
      outcome: meeting.outcome,
      departmentName: meeting.department_name,
      myResponse: meeting.my_response,
      isOrganizer: Number(meeting.organizer_id) === user.id,
      participants: participants.map((p) => ({
        employeeId: Number(p.employee_id),
        name: p.full_name,
        photoUrl: p.photo_url,
        designation: p.designation_title,
        response: p.response,
        attended: Boolean(p.attended),
        joinedAt: toIso(p.joined_at),
      })),
      actionItems: actionItems.map((a) => ({
        id: Number(a.id),
        title: a.title,
        assigneeId: a.assignee_id ? Number(a.assignee_id) : null,
        assigneeName: a.assignee_name,
        dueDate: a.due_date,
        status: a.status,
      })),
      messages: messages.map((m) => ({
        id: Number(m.id),
        employeeId: Number(m.employee_id),
        name: m.full_name,
        body: m.body,
        createdAt: toIso(m.created_at),
      })),
    };
  }

  static async respond(meetingId: number, user: AuthUser, response: 'accepted' | 'declined') {
    const participant = await queryOne<{ id: number }>(
      'SELECT id FROM meeting_participants WHERE meeting_id = ? AND employee_id = ?',
      [meetingId, user.id],
    );
    if (!participant) throw ApiError.forbidden('You are not invited to this meeting.');
    await execute('UPDATE meeting_participants SET response = ? WHERE id = ?', [response, participant.id]);
    const meeting = await queryOne<{ organizer_id: number; title: string }>('SELECT organizer_id, title FROM meetings WHERE id = ?', [meetingId]);
    if (meeting && Number(meeting.organizer_id) !== user.id) {
      await NotificationService.notify({
        employeeIds: [Number(meeting.organizer_id)],
        type: 'meeting',
        title: `Invitation ${response}`,
        body: `${user.fullName} ${response} "${meeting.title}".`,
        link: `/meetings?meeting=${meetingId}`,
        actorId: user.id,
      });
    }
    emitToEmployees([Number(meeting?.organizer_id ?? 0), user.id], 'meeting:response', { id: meetingId, employeeId: user.id, response });
  }

  static async markJoined(meetingId: number, user: AuthUser) {
    const meeting = await queryOne<{ meeting_code: string; organizer_id: number }>('SELECT meeting_code, organizer_id FROM meetings WHERE id = ?', [meetingId]);
    if (!meeting) throw ApiError.notFound('Meeting not found');
    const isParticipant = await queryOne<{ id: number }>(
      'SELECT id FROM meeting_participants WHERE meeting_id = ? AND employee_id = ?',
      [meetingId, user.id],
    );
    if (!isParticipant && Number(meeting.organizer_id) !== user.id) throw ApiError.forbidden('You are not invited to this meeting.');
    await execute(
      `UPDATE meeting_participants SET joined_at = COALESCE(joined_at, NOW(3)), attended = 1, response = IF(response = 'declined', 'accepted', response)
       WHERE meeting_id = ? AND employee_id = ?`,
      [meetingId, user.id],
    );
    await execute("UPDATE meetings SET status = IF(status = 'scheduled', 'ongoing', status) WHERE id = ?", [meetingId]);
    emitToMeeting(meeting.meeting_code, 'meeting:attendance', { meetingId, employeeId: user.id, joined: true });
    return meeting.meeting_code;
  }

  static async addActionItem(meetingId: number, user: AuthUser, input: { title: string; assigneeId?: number | null; dueDate?: string | null }) {
    const meeting = await queryOne<{ organizer_id: number; title: string }>('SELECT organizer_id, title FROM meetings WHERE id = ?', [meetingId]);
    if (!meeting) throw ApiError.notFound('Meeting not found');
    if (Number(meeting.organizer_id) !== user.id && !user.permissions.includes('meetings.manage')) {
      throw ApiError.forbidden('Only the organizer can add action items.');
    }
    if (!input.title?.trim()) throw ApiError.badRequest('Action item title is required.');
    const result = await execute('INSERT INTO meeting_action_items (meeting_id, title, assignee_id, due_date) VALUES (?, ?, ?, ?)', [
      meetingId,
      input.title.trim(),
      input.assigneeId ?? null,
      input.dueDate ?? null,
    ]);
    if (input.assigneeId && input.assigneeId !== user.id) {
      await NotificationService.notify({
        employeeIds: [input.assigneeId],
        type: 'meeting',
        title: 'Meeting action item assigned',
        body: `${input.title.trim()} — from "${meeting.title}".`,
        link: `/meetings?meeting=${meetingId}`,
        actorId: user.id,
      });
    }
    return result.insertId;
  }

  static async toggleActionItem(meetingId: number, itemId: number, user: AuthUser) {
    const item = await queryOne<{ assignee_id: number | null; status: string }>(
      'SELECT assignee_id, status FROM meeting_action_items WHERE id = ? AND meeting_id = ?',
      [itemId, meetingId],
    );
    if (!item) throw ApiError.notFound('Action item not found');
    const allowed = Number(item.assignee_id) === user.id || user.permissions.includes('meetings.manage');
    if (!allowed) throw ApiError.forbidden('You cannot update this action item.');
    await execute("UPDATE meeting_action_items SET status = IF(status = 'open', 'done', 'open'), completed_at = IF(status = 'open', NOW(3), NULL) WHERE id = ?", [
      itemId,
    ]);
  }

  static async saveOutcome(meetingId: number, user: AuthUser, outcome: string) {
    const meeting = await queryOne<{ organizer_id: number }>('SELECT organizer_id FROM meetings WHERE id = ?', [meetingId]);
    if (!meeting) throw ApiError.notFound('Meeting not found');
    if (Number(meeting.organizer_id) !== user.id && !user.permissions.includes('meetings.manage')) {
      throw ApiError.forbidden('Only the organizer can record the outcome.');
    }
    await execute("UPDATE meetings SET outcome = ?, status = 'completed' WHERE id = ?", [outcome, meetingId]);
    await recordAudit({ actorId: user.id, action: 'meeting.outcome_recorded', entityType: 'meeting', entityId: meetingId, after: { outcome } });
  }

  static async cancel(meetingId: number, user: AuthUser, reason: string) {
    const meeting = await queryOne<{ organizer_id: number; title: string }>('SELECT organizer_id, title FROM meetings WHERE id = ?', [meetingId]);
    if (!meeting) throw ApiError.notFound('Meeting not found');
    if (Number(meeting.organizer_id) !== user.id && !user.permissions.includes('meetings.manage')) {
      throw ApiError.forbidden('Only the organizer can cancel this meeting.');
    }
    await execute("UPDATE meetings SET status = 'cancelled' WHERE id = ?", [meetingId]);
    const participants = await query<{ employee_id: number }>('SELECT employee_id FROM meeting_participants WHERE meeting_id = ?', [meetingId]);
    await NotificationService.notify({
      employeeIds: participants.map((p) => Number(p.employee_id)),
      type: 'meeting',
      title: 'Meeting cancelled',
      body: `"${meeting.title}" was cancelled${reason ? `: ${reason}` : '.'}`,
      link: '/meetings',
      priority: 'high',
      actorId: user.id,
    });
    await recordAudit({ actorId: user.id, action: 'meeting.cancelled', entityType: 'meeting', entityId: meetingId, after: { reason } });
  }

  static async addMessage(meetingId: number, user: AuthUser, body: string) {
    const meeting = await queryOne<{ meeting_code: string; organizer_id: number }>('SELECT meeting_code, organizer_id FROM meetings WHERE id = ?', [meetingId]);
    if (!meeting) throw ApiError.notFound('Meeting not found');
    const participant = await queryOne<{ id: number }>('SELECT id FROM meeting_participants WHERE meeting_id = ? AND employee_id = ?', [
      meetingId,
      user.id,
    ]);
    if (!participant && Number(meeting.organizer_id) !== user.id) throw ApiError.forbidden('You are not in this meeting.');
    if (!body.trim()) throw ApiError.badRequest('Message cannot be empty.');
    const result = await execute('INSERT INTO meeting_messages (meeting_id, employee_id, body) VALUES (?, ?, ?)', [
      meetingId,
      user.id,
      body.trim().slice(0, 1000),
    ]);
    const payload = {
      id: result.insertId,
      meetingId,
      employeeId: user.id,
      name: user.fullName,
      body: body.trim(),
      createdAt: new Date().toISOString(),
    };
    emitToMeeting(meeting.meeting_code, 'meeting:message', payload);
    return payload;
  }

  static async upcoming(user: AuthUser, limit = 5) {
    return query<{ id: number; title: string; start_at: string; end_at: string; organizer_name: string; location_type: string }>(
      `SELECT m.id, m.title, m.start_at, m.end_at, o.full_name AS organizer_name, m.location_type
       FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.employee_id = ?
       JOIN employees o ON o.id = m.organizer_id
       WHERE m.end_at >= NOW(3) AND m.status IN ('scheduled','ongoing')
       ORDER BY m.start_at ASC LIMIT ?`,
      [user.id, limit],
    );
  }

  static async reminderJob(): Promise<number> {
    const rows = await query<{ id: number; title: string; employee_id: number; start_at: string }>(
      `SELECT m.id, m.title, mp.employee_id, m.start_at
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE m.status = 'scheduled' AND m.start_at BETWEEN NOW(3) AND DATE_ADD(NOW(3), INTERVAL 15 MINUTE)`,
    );
    for (const row of rows) {
      await NotificationService.notify({
        employeeIds: [Number(row.employee_id)],
        type: 'meeting',
        title: 'Meeting starting soon',
        body: `"${row.title}" starts in 15 minutes.`,
        link: `/meetings?meeting=${row.id}`,
        priority: 'high',
        dedupeKey: `meeting_reminder:${row.id}:${row.employee_id}`,
      });
    }
    return rows.length;
  }
}
