import { execute, query, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { toIso } from '../lib/dates.js';
import { NotificationService } from './NotificationService.js';
import { enqueueEmail } from '../lib/mailer.js';
import type { AuthUser } from './AuthService.js';

export interface EmailAttachment {
  fileId: number;
  name: string;
  size: number;
  mimeType: string;
}

export class InternalEmailService {
  static async inbox(
    userId: number,
    options: { page?: number; limit?: number; search?: string; starredOnly?: boolean; unreadOnly?: boolean } = {},
  ) {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const offset = (page - 1) * limit;

    const clauses = ['e.recipient_id = ?', 'e.is_deleted_by_recipient = 0'];
    const params: unknown[] = [userId];

    if (options.starredOnly) {
      clauses.push('e.is_starred_by_recipient = 1');
    }
    if (options.unreadOnly) {
      clauses.push('e.is_read = 0');
    }
    if (options.search?.trim()) {
      clauses.push('(e.subject LIKE ? OR e.body LIKE ? OR s.full_name LIKE ?)');
      const q = `%${options.search.trim()}%`;
      params.push(q, q, q);
    }

    const where = clauses.join(' AND ');
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM internal_emails e
       JOIN employees s ON s.id = e.sender_id
       WHERE ${where}`,
      params,
    );
    const total = Number(countRow?.total ?? 0);

    const rows = await query<{
      id: number;
      sender_id: number;
      sender_name: string;
      sender_email: string;
      sender_photo: string | null;
      subject: string;
      body: string;
      is_read: number;
      read_at: string | null;
      is_starred_by_recipient: number;
      attachments: string | null;
      created_at: string;
    }>(
      `SELECT e.id, e.sender_id, s.full_name AS sender_name, s.email AS sender_email, s.photo_url AS sender_photo,
              e.subject, e.body, e.is_read, e.read_at, e.is_starred_by_recipient, e.attachments, e.created_at
       FROM internal_emails e
       JOIN employees s ON s.id = e.sender_id
       WHERE ${where}
       ORDER BY e.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return {
      total,
      page,
      limit,
      emails: rows.map((r) => ({
        id: Number(r.id),
        senderId: Number(r.sender_id),
        senderName: r.sender_name,
        senderEmail: r.sender_email,
        senderPhoto: r.sender_photo,
        subject: r.subject,
        body: r.body,
        isRead: Boolean(r.is_read),
        readAt: toIso(r.read_at),
        isStarred: Boolean(r.is_starred_by_recipient),
        attachments: r.attachments ? (typeof r.attachments === 'string' ? JSON.parse(r.attachments) : r.attachments) : [],
        createdAt: toIso(r.created_at),
      })),
    };
  }

  static async sent(
    userId: number,
    options: { page?: number; limit?: number; search?: string } = {},
  ) {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const offset = (page - 1) * limit;

    const clauses = ['e.sender_id = ?', 'e.is_deleted_by_sender = 0'];
    const params: unknown[] = [userId];

    if (options.search?.trim()) {
      clauses.push('(e.subject LIKE ? OR e.body LIKE ? OR r.full_name LIKE ?)');
      const q = `%${options.search.trim()}%`;
      params.push(q, q, q);
    }

    const where = clauses.join(' AND ');
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM internal_emails e
       JOIN employees r ON r.id = e.recipient_id
       WHERE ${where}`,
      params,
    );
    const total = Number(countRow?.total ?? 0);

    const rows = await query<{
      id: number;
      recipient_id: number;
      recipient_name: string;
      recipient_email: string;
      recipient_photo: string | null;
      subject: string;
      body: string;
      is_read: number;
      read_at: string | null;
      is_starred_by_sender: number;
      attachments: string | null;
      created_at: string;
    }>(
      `SELECT e.id, e.recipient_id, r.full_name AS recipient_name, r.email AS recipient_email, r.photo_url AS recipient_photo,
              e.subject, e.body, e.is_read, e.read_at, e.is_starred_by_sender, e.attachments, e.created_at
       FROM internal_emails e
       JOIN employees r ON r.id = e.recipient_id
       WHERE ${where}
       ORDER BY e.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return {
      total,
      page,
      limit,
      emails: rows.map((r) => ({
        id: Number(r.id),
        recipientId: Number(r.recipient_id),
        recipientName: r.recipient_name,
        recipientEmail: r.recipient_email,
        recipientPhoto: r.recipient_photo,
        subject: r.subject,
        body: r.body,
        isRead: Boolean(r.is_read),
        readAt: toIso(r.read_at),
        isStarred: Boolean(r.is_starred_by_sender),
        attachments: r.attachments ? (typeof r.attachments === 'string' ? JSON.parse(r.attachments) : r.attachments) : [],
        createdAt: toIso(r.created_at),
      })),
    };
  }

  static async unreadCount(userId: number): Promise<number> {
    const row = await queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM internal_emails WHERE recipient_id = ? AND is_read = 0 AND is_deleted_by_recipient = 0',
      [userId],
    );
    return Number(row?.total ?? 0);
  }

  static async get(id: number, userId: number) {
    const row = await queryOne<{
      id: number;
      sender_id: number;
      recipient_id: number;
      sender_name: string;
      sender_email: string;
      sender_photo: string | null;
      recipient_name: string;
      recipient_email: string;
      recipient_photo: string | null;
      subject: string;
      body: string;
      is_read: number;
      read_at: string | null;
      is_starred_by_recipient: number;
      is_starred_by_sender: number;
      is_deleted_by_sender: number;
      is_deleted_by_recipient: number;
      attachments: string | null;
      created_at: string;
    }>(
      `SELECT e.*,
              s.full_name AS sender_name, s.email AS sender_email, s.photo_url AS sender_photo,
              r.full_name AS recipient_name, r.email AS recipient_email, r.photo_url AS recipient_photo
       FROM internal_emails e
       JOIN employees s ON s.id = e.sender_id
       JOIN employees r ON r.id = e.recipient_id
       WHERE e.id = ?`,
      [id],
    );
    if (!row) throw ApiError.notFound('Email not found.');
    if (Number(row.sender_id) !== userId && Number(row.recipient_id) !== userId) {
      throw ApiError.forbidden('You do not have access to this email.');
    }

    if (Number(row.recipient_id) === userId && !row.is_read) {
      await execute('UPDATE internal_emails SET is_read = 1, read_at = NOW(3) WHERE id = ?', [id]);
      row.is_read = 1;
      row.read_at = new Date().toISOString();
    }

    return {
      id: Number(row.id),
      senderId: Number(row.sender_id),
      senderName: row.sender_name,
      senderEmail: row.sender_email,
      senderPhoto: row.sender_photo,
      recipientId: Number(row.recipient_id),
      recipientName: row.recipient_name,
      recipientEmail: row.recipient_email,
      recipientPhoto: row.recipient_photo,
      subject: row.subject,
      body: row.body,
      isRead: Boolean(row.is_read),
      readAt: toIso(row.read_at),
      isStarred: Number(row.recipient_id) === userId ? Boolean(row.is_starred_by_recipient) : Boolean(row.is_starred_by_sender),
      attachments: row.attachments ? (typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments) : [],
      createdAt: toIso(row.created_at),
    };
  }

  static async send(
    sender: AuthUser,
    input: { recipientIds: number[]; subject: string; body: string; attachments?: EmailAttachment[] },
  ) {
    if (!input.subject.trim()) throw ApiError.badRequest('Subject is required.');
    if (!input.body.trim()) throw ApiError.badRequest('Message body is required.');
    const recipients = [...new Set(input.recipientIds.filter((id) => Number.isFinite(id) && id > 0))];
    if (recipients.length === 0) throw ApiError.badRequest('Select at least one recipient.');

    const createdIds: number[] = [];
    const attachmentsJson = input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null;

    for (const recipientId of recipients) {
      const recipient = await queryOne<{ id: number; email: string; full_name: string }>(
        "SELECT id, email, full_name FROM employees WHERE id = ? AND status = 'active'",
        [recipientId],
      );
      if (!recipient) continue;

      const res = await execute(
        `INSERT INTO internal_emails (sender_id, recipient_id, subject, body, attachments)
         VALUES (?, ?, ?, ?, ?)`,
        [sender.id, recipientId, input.subject.trim(), input.body.trim(), attachmentsJson],
      );
      const emailId = res.insertId;
      createdIds.push(emailId);

      // In-app notification
      await NotificationService.notify({
        employeeIds: [recipientId],
        type: 'system',
        title: `Email from ${sender.fullName}`,
        body: input.subject.trim(),
        link: `/mailbox?id=${emailId}`,
        actorId: sender.id,
      });

      // Best-effort SMTP forwarding if external mail is desired
      try {
        await enqueueEmail({
          to: recipient.email,
          template: 'ticket_update',
          subject: `[Workforce] ${input.subject.trim()}`,
          data: {
            title: input.subject.trim(),
            body: input.body.trim(),
            name: recipient.full_name,
            link: `/mailbox?id=${emailId}`,
            linkLabel: 'View Email in Workforce',
          },
        }).catch(() => null);
      } catch {
        /* Ignore SMTP failure for internal email */
      }
    }

    return { sent: createdIds.length, emailIds: createdIds };
  }

  static async toggleStar(id: number, userId: number): Promise<{ isStarred: boolean }> {
    const row = await queryOne<{ sender_id: number; recipient_id: number; is_starred_by_recipient: number; is_starred_by_sender: number }>(
      'SELECT sender_id, recipient_id, is_starred_by_recipient, is_starred_by_sender FROM internal_emails WHERE id = ?',
      [id],
    );
    if (!row) throw ApiError.notFound('Email not found.');
    if (Number(row.recipient_id) === userId) {
      const next = row.is_starred_by_recipient ? 0 : 1;
      await execute('UPDATE internal_emails SET is_starred_by_recipient = ? WHERE id = ?', [next, id]);
      return { isStarred: Boolean(next) };
    } else if (Number(row.sender_id) === userId) {
      const next = row.is_starred_by_sender ? 0 : 1;
      await execute('UPDATE internal_emails SET is_starred_by_sender = ? WHERE id = ?', [next, id]);
      return { isStarred: Boolean(next) };
    }
    throw ApiError.forbidden();
  }

  static async delete(id: number, userId: number): Promise<{ deleted: boolean }> {
    const row = await queryOne<{ sender_id: number; recipient_id: number; is_deleted_by_sender: number; is_deleted_by_recipient: number }>(
      'SELECT sender_id, recipient_id, is_deleted_by_sender, is_deleted_by_recipient FROM internal_emails WHERE id = ?',
      [id],
    );
    if (!row) throw ApiError.notFound('Email not found.');
    let isSender = Number(row.sender_id) === userId;
    let isRecipient = Number(row.recipient_id) === userId;
    if (!isSender && !isRecipient) throw ApiError.forbidden();

    if (isRecipient) {
      await execute('UPDATE internal_emails SET is_deleted_by_recipient = 1 WHERE id = ?', [id]);
    }
    if (isSender) {
      await execute('UPDATE internal_emails SET is_deleted_by_sender = 1 WHERE id = ?', [id]);
    }

    // If deleted by both sides, permanently prune
    await execute('DELETE FROM internal_emails WHERE id = ? AND is_deleted_by_sender = 1 AND is_deleted_by_recipient = 1', [id]);
    return { deleted: true };
  }
}
