import { AuthService } from './AuthService.js';
import { execute, nextSequence, query, queryOne, transaction } from '../db/index.js';
import { getSettings, recordAudit } from '../lib/audit.js';
import { today, toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { subtreeIds } from '../lib/scope.js';
import { emitToEmployees } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import type { AuthUser } from './AuthService.js';

export const TICKET_CATEGORIES = [
  'Website Issues',
  'Application Errors',
  'Login Issues',
  'Database Issues',
  'Printer Issues',
  'Email Issues',
  'Task Management Issues',
  'Communication Issues',
  'Mobile Application Issues',
  'Performance Issues',
  'Security Issues',
  'Other Technical Issues',

  'IT Issues',
  'Software Issues',
  'Hardware Issues',
  'Network Issues',
  'Attendance Issues',
  'HR Issues',
  'Payroll Issues',
  'Store Operations',
  'Customer Complaints',
  'Infrastructure Issues',
  'General Requests',
] as const;

export const TEAM_BY_CATEGORY: Record<string, string> = {
  'IT Issues': 'IT Support',
  'Software Issues': 'IT Support',
  'Hardware Issues': 'IT Support',
  'Network Issues': 'IT Support',
  'Attendance Issues': 'HR',
  'HR Issues': 'HR',
  'Payroll Issues': 'HR',
  'Store Operations': 'Operations',
  'Customer Complaints': 'Customer Success',
  'Infrastructure Issues': 'Facilities',
  'General Requests': 'Operations',
};

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  new: ['assigned', 'acknowledged', 'in_progress', 'cancelled'],
  assigned: ['acknowledged', 'in_progress', 'waiting_information', 'cancelled'],
  acknowledged: ['in_progress', 'waiting_information', 'resolved'],
  in_progress: ['waiting_information', 'resolved'],
  waiting_information: ['in_progress', 'resolved'],
  resolved: ['closed', 'reopened'],
  closed: ['reopened'],
  reopened: ['assigned', 'acknowledged', 'in_progress'],
  cancelled: [],
};

interface TicketRow {
  id: number;
  ticket_no: string;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  department_id: number | null;
  requester_id: number;
  assigned_team: string | null;
  assignee_id: number | null;
  related_task_id: number | null;
  sla_due_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  resolution: string | null;
  feedback_rating: number | null;
  feedback_comment: string | null;
  created_at: string;
  updated_at: string;
  requester_name?: string;
  assignee_name?: string | null;
  department_name?: string | null;
  issue_details: Record<string, unknown> | string | null;
}

function mapTicket(r: TicketRow) {
  const slaDue = r.sla_due_at ? new Date(`${String(r.sla_due_at).replace(' ', 'T')}Z`).getTime() : null;
  return {
    issueDetails: typeof r.issue_details === 'string' ? JSON.parse(r.issue_details) : r.issue_details,
    id: Number(r.id),
    ticketNo: r.ticket_no,
    subject: r.subject,
    description: r.description,
    category: r.category,
    priority: r.priority,
    status: r.status,
    departmentId: r.department_id ? Number(r.department_id) : null,
    departmentName: r.department_name ?? null,
    requesterId: Number(r.requester_id),
    requesterName: r.requester_name ?? null,
    assignedTeam: r.assigned_team,
    assigneeId: r.assignee_id ? Number(r.assignee_id) : null,
    assigneeName: r.assignee_name ?? null,
    relatedTaskId: r.related_task_id ? Number(r.related_task_id) : null,
    slaDueAt: toIso(r.sla_due_at),
    slaBreached: slaDue !== null && slaDue < Date.now() && !['resolved', 'closed', 'cancelled'].includes(r.status),
    acknowledgedAt: toIso(r.acknowledged_at),
    resolvedAt: toIso(r.resolved_at),
    closedAt: toIso(r.closed_at),
    resolution: r.resolution,
    feedbackRating: r.feedback_rating,
    feedbackComment: r.feedback_comment,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export class TicketService {
  private static async scope(user: AuthUser): Promise<{ clause: string; params: unknown[] }> {
    if (user.permissions.includes('tickets.view.all')) return { clause: '1 = 1', params: [] };
    if (user.permissions.includes('tickets.view.team')) {
      const ids = await subtreeIds(user.id);
      if (ids.length === 0) return { clause: '1 = 0', params: [] };
      const ph = ids.map(() => '?').join(',');
      return { clause: `(t.requester_id IN (${ph}) OR t.assignee_id IN (${ph}))`, params: [...ids, ...ids] };
    }
    return { clause: '(t.requester_id = ? OR t.assignee_id = ?)', params: [user.id, user.id] };
  }

  private static async slaHours(priority: string): Promise<number> {
    const settings = await getSettings(['sla_hours_low', 'sla_hours_medium', 'sla_hours_high', 'sla_hours_critical']);
    const map: Record<string, number> = {
      low: Number(settings.sla_hours_low || 72),
      medium: Number(settings.sla_hours_medium || 48),
      high: Number(settings.sla_hours_high || 24),
      critical: Number(settings.sla_hours_critical || 4),
    };
    return map[priority] ?? 48;
  }

  /** Least-loaded active employee holding ticket resolution rights. */
  private static async autoAssignee(): Promise<number | null> {
    const row = await queryOne<{ id: number }>(
      `SELECT e.id, COUNT(t.id) AS load
       FROM employees e
       JOIN role_permissions rp ON rp.role_id = e.role_id
       JOIN permissions p ON p.id = rp.permission_id AND p.code = 'tickets.resolve'
       LEFT JOIN tickets t ON t.assignee_id = e.id AND t.status NOT IN ('resolved','closed','cancelled')
       WHERE e.status = 'active'
       GROUP BY e.id
       ORDER BY load ASC, e.id ASC
       LIMIT 1`,
    );
    return row ? Number(row.id) : null;
  }

  static async create(
    actor: AuthUser,
    input: {
      subject: string;
      description: string;
      category: string;
      priority?: string;
      departmentId?: number | null;
      relatedTaskId?: number | null;
      attachmentIds?: number[];
      issueDetails?: Record<string, unknown>;
    },
    context: { ip?: string; userAgent?: string },
  ) {
    if (!input.subject?.trim()) throw ApiError.badRequest('Ticket subject is required.');
    if (!input.description || input.description.trim().length < 10) {
      throw ApiError.badRequest('Describe the issue in at least 10 characters.');
    }
    const priority = input.priority ?? 'medium';
    const slaHours = await TicketService.slaHours(priority);
    const team = TEAM_BY_CATEGORY[input.category] ?? 'IT Support';
    if (!(TICKET_CATEGORIES as readonly string[]).includes(input.category)) throw ApiError.badRequest('Select a valid issue category.');

    const created = await transaction(async (conn) => {
      const seq = await nextSequence(conn, 'ticket_no_seq');
      const ticketNo = `TKT-${String(seq).padStart(5, '0')}`;
      const [result] = await conn.query(
        `INSERT INTO tickets
          (ticket_no, subject, description, category, priority, status, department_id, requester_id, assigned_team, related_task_id, sla_due_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? HOUR))`,
        [
          ticketNo,
          input.subject.trim(),
          input.description.trim(),
          input.category,
          priority,
          input.departmentId ?? actor.departmentId ?? null,
          actor.id,
          team,
          input.relatedTaskId ?? null,
          slaHours,
        ],
      );
      const id = Number((result as { insertId: number }).insertId);
      const issueDetails = { ...input.issueDetails, employeeName: actor.fullName, employeeCode: actor.employeeCode,
        email: actor.email, department: actor.departmentName, designation: actor.designationTitle, location: actor.locationName };
      await conn.query('UPDATE tickets SET issue_details = ? WHERE id = ?', [JSON.stringify(issueDetails), id]);
      for (const fileId of [...new Set(input.attachmentIds ?? [])]) {
        const [files] = await conn.query<any[]>("SELECT id FROM files WHERE id = ? AND owner_id = ? AND scan_status = 'clean'", [fileId, actor.id]);
        if (!files.length) throw ApiError.forbidden('Attachment is not an available file owned by you.');
        await conn.query('INSERT INTO ticket_attachments (ticket_id, file_id) VALUES (?, ?)', [id, fileId]);
      }
      return { id, ticketNo };
    });

    // Automatic assignment rules: route to the least-loaded resolver.
    if (input.category !== 'General Requests') {
      const assignee = await TicketService.autoAssignee();
      if (assignee) {
        await execute(
          "UPDATE tickets SET assignee_id = ?, status = 'assigned' WHERE id = ?",
          [assignee, created.id],
        );
        await execute(
          'INSERT INTO ticket_assignments (ticket_id, employee_id, assigned_by, note) VALUES (?, ?, ?, ?)',
          [created.id, assignee, actor.id, 'Automatic routing by category'],
        );
        await NotificationService.notify({
          employeeIds: [assignee],
          type: 'ticket_assigned',
          title: 'New ticket assigned',
          body: `${created.ticketNo} · ${input.subject.trim()}`,
          link: `/tickets?ticket=${created.id}`,
          priority: priority === 'critical' || priority === 'high' ? 'high' : 'normal',
          actorId: actor.id,
        });
      }
    }

    await recordAudit({
      actorId: actor.id,
      action: 'ticket.created',
      entityType: 'ticket',
      entityId: created.id,
      after: { ticketNo: created.ticketNo, category: input.category, priority },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    emitToEmployees([actor.id], 'ticket:created', { id: created.id, ticketNo: created.ticketNo });
    return created;
  }

  static async list(
    user: AuthUser,
    filters: { status?: string; priority?: string; category?: string; assigneeId?: number; search?: string; page?: number; pageSize?: number; mine?: boolean },
  ) {
    const scope = await TicketService.scope(user);
    const clauses = [scope.clause];
    const params: unknown[] = [...scope.params];
    if (filters.status) {
      clauses.push('t.status = ?');
      params.push(filters.status);
    }
    if (filters.priority) {
      clauses.push('t.priority = ?');
      params.push(filters.priority);
    }
    if (filters.category) {
      clauses.push('t.category = ?');
      params.push(filters.category);
    }
    if (filters.assigneeId) {
      clauses.push('t.assignee_id = ?');
      params.push(filters.assigneeId);
    }
    if (filters.mine) {
      clauses.push('(t.requester_id = ? OR t.assignee_id = ?)');
      params.push(user.id, user.id);
    }
    if (filters.search) {
      clauses.push('(t.subject LIKE ? OR t.ticket_no LIKE ? OR t.description LIKE ?)');
      const term = `%${filters.search}%`;
      params.push(term, term, term);
    }
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));
    const where = clauses.join(' AND ');
    const rows = await query<TicketRow>(
      `SELECT t.*, rq.full_name AS requester_name, asg.full_name AS assignee_name, d.name AS department_name
       FROM tickets t
       JOIN employees rq ON rq.id = t.requester_id
       LEFT JOIN employees asg ON asg.id = t.assignee_id
       LEFT JOIN departments d ON d.id = t.department_id
       WHERE ${where}
       ORDER BY FIELD(t.status, 'new','assigned','acknowledged','in_progress','waiting_information','reopened','resolved','closed','cancelled'),
                FIELD(t.priority, 'critical','high','medium','low'), t.created_at DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const total = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM tickets t WHERE ${where}`, params);
    return { items: rows.map(mapTicket), total: Number(total?.total ?? 0), page, pageSize };
  }

  static async detail(ticketId: number, user: AuthUser) {
    const scope = await TicketService.scope(user);
    const row = await queryOne<TicketRow>(
      `SELECT t.*, rq.full_name AS requester_name, asg.full_name AS assignee_name, d.name AS department_name
       FROM tickets t
       JOIN employees rq ON rq.id = t.requester_id
       LEFT JOIN employees asg ON asg.id = t.assignee_id
       LEFT JOIN departments d ON d.id = t.department_id
       WHERE t.id = ? AND ${scope.clause}`,
      [ticketId, ...scope.params],
    );
    if (!row) throw ApiError.notFound('Ticket not found');
    const canSeeInternal = user.permissions.includes('tickets.resolve') || user.permissions.includes('tickets.view.all');
    const comments = await query<{ id: number; author_id: number; author_name: string; body: string; is_internal: number; created_at: string }>(
      `SELECT tc.id, tc.author_id, e.full_name AS author_name, tc.body, tc.is_internal, tc.created_at
       FROM ticket_comments tc JOIN employees e ON e.id = tc.author_id
       WHERE tc.ticket_id = ? ${canSeeInternal ? '' : 'AND tc.is_internal = 0'}
       ORDER BY tc.created_at ASC`,
      [ticketId],
    );
    const attachments = await query<{ file_id: number; original_name: string; mime_type: string; size_bytes: number }>(
      `SELECT f.id AS file_id, f.original_name, f.mime_type, f.size_bytes
       FROM ticket_attachments ta JOIN files f ON f.id = ta.file_id WHERE ta.ticket_id = ?`,
      [ticketId],
    );
    const history = await query<{
      id: number;
      employee_id: number;
      full_name: string;
      assigned_at: string;
      note: string | null;
    }>(
      `SELECT tas.id, tas.employee_id, e.full_name, tas.assigned_at, tas.note
       FROM ticket_assignments tas JOIN employees e ON e.id = tas.employee_id
       WHERE tas.ticket_id = ? ORDER BY tas.assigned_at ASC`,
      [ticketId],
    );
    return {
      ...mapTicket(row),
      comments: comments.map((c) => ({
        id: Number(c.id),
        authorId: Number(c.author_id),
        authorName: c.author_name,
        body: c.body,
        isInternal: Boolean(c.is_internal),
        createdAt: toIso(c.created_at),
      })),
      attachments,
      assignmentHistory: history.map((h) => ({
        id: Number(h.id),
        employeeId: Number(h.employee_id),
        employeeName: h.full_name,
        assignedAt: toIso(h.assigned_at),
        note: h.note,
      })),
    };
  }

  static async addComment(ticketId: number, user: AuthUser, body: string, isInternal: boolean): Promise<void> {
    await TicketService.detail(ticketId, user);
    if (!body.trim()) throw ApiError.badRequest('Comment cannot be empty.');
    if (isInternal && !user.permissions.includes('tickets.resolve')) {
      throw ApiError.forbidden('Only support staff can add internal notes.');
    }
    await execute('INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?, ?, ?, ?)', [
      ticketId,
      user.id,
      body.trim(),
      isInternal ? 1 : 0,
    ]);
    const ticket = await queryOne<{ requester_id: number; assignee_id: number | null; ticket_no: string; subject: string }>(
      'SELECT requester_id, assignee_id, ticket_no, subject FROM tickets WHERE id = ?',
      [ticketId],
    );
    const recipients = new Set<number>();
    if (!isInternal && ticket) {
      if (Number(ticket.requester_id) !== user.id) recipients.add(Number(ticket.requester_id));
      if (ticket.assignee_id && Number(ticket.assignee_id) !== user.id) recipients.add(Number(ticket.assignee_id));
    }
    if (recipients.size > 0) {
      await NotificationService.notify({
        employeeIds: [...recipients],
        type: 'ticket_comment',
        title: isInternal ? 'Internal note added' : 'New ticket reply',
        body: `${user.fullName} replied on ${ticket?.ticket_no ?? 'a ticket'}.`,
        link: `/tickets?ticket=${ticketId}`,
        actorId: user.id,
      });
    }
    const detail = await TicketService.detail(ticketId, user);
    emitToEmployees([detail.requesterId, ...(detail.assigneeId ? [detail.assigneeId] : [])], 'ticket:updated', {
      id: ticketId,
      status: detail.status,
    });
  }

  static async act(
    ticketId: number,
    user: AuthUser,
    action: 'assign' | 'acknowledge' | 'start' | 'wait_info' | 'resolve' | 'close' | 'reopen' | 'escalate' | 'cancel' | 'feedback',
    payload: { assigneeId?: number; note?: string; resolution?: string; rating?: number },
    context: { ip?: string; userAgent?: string },
  ) {
    await TicketService.detail(ticketId, user);
    const ticket = await queryOne<TicketRow>('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (!ticket) throw ApiError.notFound('Ticket not found');
    const canResolve = user.permissions.includes('tickets.resolve') || user.permissions.includes('tickets.manage');
    const isRequester = Number(ticket.requester_id) === user.id;
    const isAssignee = ticket.assignee_id && Number(ticket.assignee_id) === user.id;

    const setStatus = async (status: string, extra: { resolution?: string } = {}) => {
      const allowed = ALLOWED_TRANSITIONS[ticket.status] ?? [];
      if (!allowed.includes(status) && status !== ticket.status) {
        throw ApiError.badRequest(`Cannot move ticket from ${ticket.status.replace(/_/g, ' ')} to ${status.replace(/_/g, ' ')}.`);
      }
      const changed = await execute(`UPDATE tickets SET status = ?, resolution = COALESCE(?, resolution),
        acknowledged_at = IF(? = 'acknowledged', COALESCE(acknowledged_at, NOW(3)), acknowledged_at),
        resolved_at = CASE WHEN ? = 'resolved' THEN NOW(3) WHEN ? = 'reopened' THEN NULL ELSE resolved_at END,
        closed_at = CASE WHEN ? = 'closed' THEN NOW(3) WHEN ? = 'reopened' THEN NULL ELSE closed_at END,
        sla_due_at = IF(? = 'reopened', DATE_ADD(NOW(3), INTERVAL ? HOUR), sla_due_at)
        WHERE id = ? AND status = ?`,
        [status, extra.resolution ?? null, status, status, status, status, status, status, await TicketService.slaHours(ticket.priority), ticketId, ticket.status]);
      if (!changed.affectedRows) throw ApiError.conflict('Ticket changed. Reload it before updating.');
      await recordAudit({
        actorId: user.id,
        action: `ticket.${status}`,
        entityType: 'ticket',
        entityId: ticketId,
        before: { status: ticket.status, assigneeId: ticket.assignee_id },
        after: { status },
        ip: context.ip,
        userAgent: context.userAgent,
      });
      const recipients = new Set<number>([Number(ticket.requester_id)]);
      if (ticket.assignee_id) recipients.add(Number(ticket.assignee_id));
      recipients.delete(user.id);
      if (recipients.size > 0) {
        await NotificationService.notify({
          employeeIds: [...recipients],
          type: 'ticket_update',
          title: `Ticket ${status.replace(/_/g, ' ')}`,
          body: `${ticket.ticket_no} · ${ticket.subject}`,
          link: `/tickets?ticket=${ticketId}`,
          priority: status === 'resolved' || status === 'closed' ? 'normal' : 'high',
          actorId: user.id,
        });
      }
      emitToEmployees([...recipients, user.id], 'ticket:updated', { id: ticketId, status });
    };

    switch (action) {
      case 'assign': {
        if (!user.permissions.includes('tickets.manage') && !user.permissions.includes('tickets.assign')) throw ApiError.forbidden('You cannot assign tickets.');
        if (!payload.assigneeId) throw ApiError.badRequest('Select an assignee.');
        const target = await queryOne<{ id: number; full_name: string }>("SELECT id, full_name FROM employees WHERE id = ? AND status = 'active'", [
          payload.assigneeId,
        ]);
        if (!target) throw ApiError.badRequest('Select an active employee.');
        const resolver = await AuthService.buildUser(target.id);
        if (!resolver?.permissions.includes('tickets.resolve')) throw ApiError.badRequest('Assignee must have ticket resolution permission.');
        await execute(
          "UPDATE tickets SET assignee_id = ?, status = IF(status = 'new', 'assigned', status), acknowledged_at = acknowledged_at WHERE id = ?",
          [payload.assigneeId, ticketId],
        );
        await execute('INSERT INTO ticket_assignments (ticket_id, employee_id, assigned_by, note) VALUES (?, ?, ?, ?)', [
          ticketId,
          payload.assigneeId,
          user.id,
          payload.note ?? null,
        ]);
        await recordAudit({
          actorId: user.id,
          action: 'ticket.assigned',
          entityType: 'ticket',
          entityId: ticketId,
          before: { assigneeId: ticket.assignee_id },
          after: { assigneeId: payload.assigneeId },
          ip: context.ip,
          userAgent: context.userAgent,
        });
        await NotificationService.notify({
          employeeIds: [payload.assigneeId],
          type: 'ticket_assigned',
          title: 'Ticket assigned to you',
          body: `${ticket.ticket_no} · ${ticket.subject}`,
          link: `/tickets?ticket=${ticketId}`,
          priority: 'high',
          actorId: user.id,
        });
        break;
      }
      case 'acknowledge': {
        if (!canResolve || (!isAssignee && !user.permissions.includes('tickets.manage'))) throw ApiError.forbidden('Only support staff can acknowledge tickets.');
        if (!['new', 'assigned', 'reopened'].includes(ticket.status)) throw ApiError.badRequest('Ticket is already acknowledged.');
        await setStatus('acknowledged');
        return;
      }
      case 'start': {
        if (!canResolve || (!isAssignee && !user.permissions.includes('tickets.manage'))) throw ApiError.forbidden('Only support staff can work on tickets.');
        await setStatus('in_progress');
        return;
      }
      case 'wait_info': {
        if (!canResolve || (!isAssignee && !user.permissions.includes('tickets.manage'))) throw ApiError.forbidden('Only support staff can update ticket state.');
        await setStatus('waiting_information');
        return;
      }
      case 'resolve': {
        if (!canResolve || (!isAssignee && !user.permissions.includes('tickets.manage'))) throw ApiError.forbidden('Only support staff can resolve tickets.');
        if (!payload.resolution || payload.resolution.trim().length < 5) throw ApiError.badRequest('Add a resolution summary.');
        await setStatus('resolved', { resolution: payload.resolution.trim() });
        return;
      }
      case 'close': {
        if (!canResolve && !isRequester) throw ApiError.forbidden('Only the requester or support staff can close this ticket.');
        await setStatus('closed');
        return;
      }
      case 'reopen': {
        if (!canResolve && !isRequester) throw ApiError.forbidden('Only the requester can reopen this ticket.');
        if (!['resolved', 'closed'].includes(ticket.status)) throw ApiError.badRequest('Only resolved or closed tickets can be reopened.');
        await setStatus('reopened');
        return;
      }
      case 'escalate': {
        if (!user.permissions.includes('tickets.view.all') && !canResolve) throw ApiError.forbidden('You cannot escalate this ticket.');
        const target = ticket.assignee_id
          ? await queryOne<{ manager_id: number | null }>('SELECT manager_id FROM employees WHERE id = ?', [ticket.assignee_id])
          : null;
        const managerId = target?.manager_id ? Number(target.manager_id) : null;
        await execute("UPDATE tickets SET priority = 'critical', status = 'assigned' WHERE id = ?", [ticketId]);
        await recordAudit({
          actorId: user.id,
          action: 'ticket.escalated',
          entityType: 'ticket',
          entityId: ticketId,
          after: { managerId, note: payload.note },
          ip: context.ip,
          userAgent: context.userAgent,
        });
        await NotificationService.notify({
          employeeIds: [managerId, Number(ticket.requester_id)].filter((id): id is number => Boolean(id)),
          type: 'ticket_escalated',
          title: 'Ticket escalated',
          body: `${ticket.ticket_no} was escalated${payload.note ? `: ${payload.note}` : '.'}`,
          link: `/tickets?ticket=${ticketId}`,
          priority: 'critical',
          actorId: user.id,
        });
        emitToEmployees(
          [Number(ticket.requester_id), ...(ticket.assignee_id ? [Number(ticket.assignee_id)] : []), ...(managerId ? [managerId] : [])],
          'ticket:updated',
          { id: ticketId, status: 'assigned' },
        );
        return;
      }
      case 'cancel': {
        if (!isRequester && !user.permissions.includes('tickets.manage')) throw ApiError.forbidden('You cannot cancel this ticket.');
        await setStatus('cancelled');
        return;
      }
      case 'feedback': {
        if (!isRequester) throw ApiError.forbidden('Only the requester can rate this ticket.');
        if (!['resolved', 'closed'].includes(ticket.status)) throw ApiError.badRequest('Feedback is available once the ticket is resolved.');
        if (!payload.rating || payload.rating < 1 || payload.rating > 5) throw ApiError.badRequest('Rating must be between 1 and 5.');
        await execute('UPDATE tickets SET feedback_rating = ?, feedback_comment = ? WHERE id = ?', [
          payload.rating,
          payload.note?.slice(0, 255) ?? null,
          ticketId,
        ]);
        return;
      }
      default:
        throw ApiError.badRequest('Unsupported ticket action');
    }

    await recordAudit({
      actorId: user.id,
      action: `ticket.${action}`,
      entityType: 'ticket',
      entityId: ticketId,
      before: { status: ticket.status, assigneeId: ticket.assignee_id },
      after: payload,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  static async stats(user: AuthUser) {
    const scope = await TicketService.scope(user);
    const row = await queryOne<{ total: number; open: number; resolved: number; breached: number; mine: number }>(
      `SELECT COUNT(*) AS total,
              SUM(t.status NOT IN ('resolved','closed','cancelled')) AS open,
              SUM(t.status IN ('resolved','closed')) AS resolved,
              SUM(t.sla_due_at < NOW(3) AND t.status NOT IN ('resolved','closed','cancelled')) AS breached,
              SUM(t.requester_id = ?) AS mine
       FROM tickets t WHERE ${scope.clause}`,
      [user.id, ...scope.params],
    );
    return {
      total: Number(row?.total ?? 0),
      open: Number(row?.open ?? 0),
      resolved: Number(row?.resolved ?? 0),
      breached: Number(row?.breached ?? 0),
      mine: Number(row?.mine ?? 0),
    };
  }

  /** Flags SLA breaches and escalates them to the assignee's manager. */
  static async escalateBreaches(): Promise<number> {
    const rows = await query<{
      id: number;
      ticket_no: string;
      subject: string;
      requester_id: number;
      assignee_id: number | null;
      manager_id: number | null;
    }>(
      `SELECT t.id, t.ticket_no, t.subject, t.requester_id, t.assignee_id, mgr.manager_id
       FROM tickets t LEFT JOIN employees mgr ON mgr.id = t.assignee_id
       WHERE t.sla_due_at < NOW(3) AND t.status NOT IN ('resolved','closed','cancelled')
       LIMIT 200`,
    );
    for (const row of rows) {
      const recipients = new Set<number>([Number(row.requester_id)]);
      if (row.assignee_id) recipients.add(Number(row.assignee_id));
      if (row.manager_id) recipients.add(Number(row.manager_id));
      await NotificationService.notify({
        employeeIds: [...recipients],
        type: 'ticket_sla',
        title: 'SLA breach',
        body: `${row.ticket_no} · ${row.subject} has passed its resolution target.`,
        link: `/tickets?ticket=${row.id}`,
        priority: 'critical',
        dedupeKey: `sla:${row.id}:${today()}`,
      });
    }
    return rows.length;
  }
}
