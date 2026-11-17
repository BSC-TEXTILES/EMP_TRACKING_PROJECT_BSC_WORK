import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { emitToConversation, emitToEmployee, emitToEmployees, isOnline, joinConversationRoom } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
import type { AuthUser } from './AuthService.js';

interface MessageRow {
  id: number;
  conversation_id: number;
  sender_id: number;
  sender_name: string;
  sender_photo: string | null;
  body: string | null;
  message_type: string;
  reply_to_id: number | null;
  client_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  reply_body?: string | null;
  reply_sender?: string | null;
}

interface ReceiptRow {
  message_id: number;
  total: number;
  read_count: number;
}

interface AttachmentRow {
  message_id: number;
  file_id: number;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
}

interface ReactionRow {
  message_id: number;
  employee_id: number;
  full_name: string;
  emoji: string;
}

function mapMessage(
  r: MessageRow,
  attachments: unknown[] = [],
  reactions: unknown[] = [],
  receipts: { recipientCount: number; readCount: number } = { recipientCount: 0, readCount: 0 },
) {
  return {
    id: Number(r.id),
    conversationId: Number(r.conversation_id),
    senderId: Number(r.sender_id),
    senderName: r.sender_name,
    senderPhoto: r.sender_photo,
    body: r.deleted_at ? null : r.body,
    type: r.message_type,
    replyToId: r.reply_to_id ? Number(r.reply_to_id) : null,
    replyToBody: r.reply_body ?? null,
    replyToSender: r.reply_sender ?? null,
    clientId: r.client_id ?? null,
    editedAt: toIso(r.edited_at),
    deleted: Boolean(r.deleted_at),
    createdAt: toIso(r.created_at),
    recipientCount: receipts.recipientCount,
    readCount: receipts.readCount,
    attachments,
    reactions,
  };
}

function mapAttachment(a: AttachmentRow) {
  return {
    fileId: Number(a.file_id),
    original_name: a.original_name,
    mime_type: a.mime_type,
    size_bytes: Number(a.size_bytes),
    duration_seconds: a.duration_seconds,
  };
}

function mapReaction(r: ReactionRow) {
  return {
    employeeId: Number(r.employee_id),
    name: r.full_name,
    emoji: r.emoji,
  };
}

export class ChatService {
  static async isMember(conversationId: number, employeeId: number): Promise<boolean> {
    const row = await queryOne<{ id: number }>(
      'SELECT id FROM conversation_members WHERE conversation_id = ? AND employee_id = ?',
      [conversationId, employeeId],
    );
    return Boolean(row);
  }

  private static async assertMember(conversationId: number, employeeId: number) {
    if (!(await ChatService.isMember(conversationId, employeeId))) {
      throw ApiError.forbidden('You are not a member of this conversation');
    }
  }

  private static async userState(conversationId: number, employeeId: number) {
    return queryOne<{ deleted_at: string | null; cleared_at: string | null }>(
      'SELECT deleted_at, cleared_at FROM conversation_user_state WHERE conversation_id = ? AND employee_id = ?',
      [conversationId, employeeId],
    );
  }

  static async listConversations(employeeId: number) {
    const rows = await query<{
      id: number;
      conv_type: string;
      name: string | null;
      description: string | null;
      is_announcement: number;
      last_message_at: string | null;
      last_body: string | null;
      last_sender: string | null;
      last_type: string | null;
      unread: number;
      is_muted: number;
      other_name: string | null;
      other_id: number | null;
      other_mobile: string | null;
      other_photo: string | null;
      member_count: number;
    }>(
      `SELECT c.id, c.conv_type, c.name, c.description, c.is_announcement,
              cm.last_read_at, cm.is_muted,
              (SELECT MAX(m.created_at) FROM messages m
                 WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                   AND (cus.cleared_at IS NULL OR m.created_at > cus.cleared_at)) AS last_message_at,
              (SELECT m.body FROM messages m
                 WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                   AND (cus.cleared_at IS NULL OR m.created_at > cus.cleared_at)
                 ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT e.full_name FROM messages m JOIN employees e ON e.id = m.sender_id
                 WHERE m.conversation_id = c.id
                   AND (cus.cleared_at IS NULL OR m.created_at > cus.cleared_at)
                 ORDER BY m.id DESC LIMIT 1) AS last_sender,
              (SELECT m.message_type FROM messages m
                 WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                   AND (cus.cleared_at IS NULL OR m.created_at > cus.cleared_at)
                 ORDER BY m.id DESC LIMIT 1) AS last_type,
              (SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.sender_id <> ?
                   AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
                   AND (cus.cleared_at IS NULL OR m.created_at > cus.cleared_at)) AS unread,
              (SELECT e.full_name FROM conversation_members other
                 JOIN employees e ON e.id = other.employee_id
                 WHERE other.conversation_id = c.id AND other.employee_id <> ? AND c.conv_type = 'direct' LIMIT 1) AS other_name,
              (SELECT other.employee_id FROM conversation_members other
                 WHERE other.conversation_id = c.id AND other.employee_id <> ? AND c.conv_type = 'direct' LIMIT 1) AS other_id,
              (SELECT e.mobile FROM conversation_members other
                 JOIN employees e ON e.id = other.employee_id
                 WHERE other.conversation_id = c.id AND other.employee_id <> ? AND c.conv_type = 'direct' LIMIT 1) AS other_mobile,
              (SELECT e.photo_url FROM conversation_members other
                 JOIN employees e ON e.id = other.employee_id
                 WHERE other.conversation_id = c.id AND other.employee_id <> ? AND c.conv_type = 'direct' LIMIT 1) AS other_photo,
              (SELECT COUNT(*) FROM conversation_members mm WHERE mm.conversation_id = c.id) AS member_count
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       LEFT JOIN conversation_user_state cus
         ON cus.conversation_id = c.id AND cus.employee_id = cm.employee_id
       WHERE cm.employee_id = ?
         AND (
           cus.deleted_at IS NULL
           OR COALESCE((SELECT MAX(m9.created_at) FROM messages m9
                        WHERE m9.conversation_id = c.id AND m9.deleted_at IS NULL), c.created_at) > cus.deleted_at
         )
       ORDER BY COALESCE(last_message_at, c.created_at) DESC`,
      [employeeId, employeeId, employeeId, employeeId, employeeId, employeeId],
    );

    return rows.map((r) => ({
      id: Number(r.id),
      type: r.conv_type,
      name: r.name ?? r.other_name ?? 'Conversation',
      description: r.description,
      isAnnouncement: Boolean(r.is_announcement),
      lastMessageAt: toIso(r.last_message_at),
      lastMessage: r.last_body ?? (r.last_type && r.last_type !== 'text' ? `[${r.last_type}]` : null),
      lastSender: r.last_sender,
      unread: Number(r.unread),
      muted: Boolean(r.is_muted),
      otherEmployeeId: r.other_id ? Number(r.other_id) : null,
      otherMobile: r.other_mobile ?? null,
      otherPhoto: r.other_photo ?? null,
      memberCount: Number(r.member_count),
    }));
  }

  static async ensureDirectConversation(employeeId: number, otherEmployeeId: number): Promise<number> {
    if (employeeId === otherEmployeeId) throw ApiError.badRequest('Choose another employee to chat with.');
    const other = await queryOne<{ id: number }>("SELECT id FROM employees WHERE id = ? AND status = 'active'", [otherEmployeeId]);
    if (!other) throw ApiError.notFound('Employee not found');

    const existing = await queryOne<{ id: number }>(
      `SELECT c.id FROM conversations c
       WHERE c.conv_type = 'direct'
         AND EXISTS (SELECT 1 FROM conversation_members m1 WHERE m1.conversation_id = c.id AND m1.employee_id = ?)
         AND EXISTS (SELECT 1 FROM conversation_members m2 WHERE m2.conversation_id = c.id AND m2.employee_id = ?)
         AND (SELECT COUNT(*) FROM conversation_members m3 WHERE m3.conversation_id = c.id) = 2
       LIMIT 1`,
      [employeeId, otherEmployeeId],
    );
    if (existing) {
      // Opening a chat the employee previously deleted makes it visible again;
      // history cleared by that deletion is intentionally not restored.
      await execute(
        `INSERT INTO conversation_user_state (conversation_id, employee_id, deleted_at)
         VALUES (?, ?, NULL)
         ON DUPLICATE KEY UPDATE deleted_at = NULL`,
        [existing.id, employeeId],
      );
      return Number(existing.id);
    }

    const id = await transaction(async (conn) => {
      const [result] = await conn.query("INSERT INTO conversations (conv_type, created_by) VALUES ('direct', ?)", [employeeId]);
      const convId = Number((result as { insertId: number }).insertId);
      await conn.query('INSERT INTO conversation_members (conversation_id, employee_id) VALUES (?, ?), (?, ?)', [
        convId,
        employeeId,
        convId,
        otherEmployeeId,
      ]);
      return convId;
    });
    await joinConversationRoom(employeeId, id);
    await joinConversationRoom(otherEmployeeId, id);
    return id;
  }

  static async createGroup(
    actor: AuthUser,
    input: { name: string; description?: string; memberIds: number[]; departmentId?: number | null; isAnnouncement?: boolean },
  ): Promise<number> {
    if (!input.name?.trim()) throw ApiError.badRequest('Group name is required.');
    const members = [...new Set(input.memberIds.filter((id) => Number.isFinite(id)))];
    if (members.length === 0) throw ApiError.badRequest('Add at least one member.');

    const id = await transaction(async (conn) => {
      const [result] = await conn.query(
        "INSERT INTO conversations (conv_type, name, description, department_id, is_announcement, created_by) VALUES ('group', ?, ?, ?, ?, ?)",
        [input.name.trim(), input.description ?? null, input.departmentId ?? null, input.isAnnouncement ? 1 : 0, actor.id],
      );
      const convId = Number((result as { insertId: number }).insertId);
      await conn.query("INSERT INTO conversation_members (conversation_id, employee_id, member_role) VALUES (?, ?, 'admin')", [
        convId,
        actor.id,
      ]);
      for (const memberId of members.filter((m) => m !== actor.id)) {
        await conn.query('INSERT IGNORE INTO conversation_members (conversation_id, employee_id) VALUES (?, ?)', [convId, memberId]);
      }
      return convId;
    });

    for (const memberId of [actor.id, ...members]) {
      await joinConversationRoom(memberId, id);
    }
    await NotificationService.notify({
      employeeIds: members.filter((m) => m !== actor.id),
      type: 'chat_group',
      title: 'Added to a group',
      body: `${actor.fullName} added you to "${input.name.trim()}".`,
      link: `/chat?conversation=${id}`,
      actorId: actor.id,
    });
    await recordAudit({
      actorId: actor.id,
      action: 'chat.group_created',
      entityType: 'conversation',
      entityId: id,
      after: { name: input.name, members },
    });
    return id;
  }

  static async conversationDetail(conversationId: number, employeeId: number) {
    await ChatService.assertMember(conversationId, employeeId);
    const conversation = await queryOne<{
      id: number;
      conv_type: string;
      name: string | null;
      description: string | null;
      is_announcement: number;
      created_by: number | null;
    }>('SELECT id, conv_type, name, description, is_announcement, created_by FROM conversations WHERE id = ?', [conversationId]);
    if (!conversation) throw ApiError.notFound('Conversation not found');
    const members = await query<{
      employee_id: number;
      full_name: string;
      photo_url: string | null;
      mobile: string | null;
      email: string | null;
      member_role: string;
      designation_title: string | null;
      last_seen_at: string | null;
    }>(
      `SELECT cm.employee_id, e.full_name, e.photo_url, e.mobile, e.email, cm.member_role, dg.title AS designation_title, e.last_seen_at
       FROM conversation_members cm
       JOIN employees e ON e.id = cm.employee_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE cm.conversation_id = ? ORDER BY cm.member_role DESC, e.full_name`,
      [conversationId],
    );
    const membership = members.find((m) => Number(m.employee_id) === employeeId);
    const other = members.find((m) => Number(m.employee_id) !== employeeId);
    return {
      id: Number(conversation.id),
      type: conversation.conv_type,
      name: conversation.name ?? other?.full_name ?? 'Conversation',
      description: conversation.description,
      isAnnouncement: Boolean(conversation.is_announcement),
      createdBy: conversation.created_by ? Number(conversation.created_by) : null,
      myRole: membership?.member_role ?? 'member',
      otherEmployee: other ? {
        id: Number(other.employee_id),
        name: other.full_name,
        photoUrl: other.photo_url,
        phone: other.mobile,
        email: other.email,
        designation: other.designation_title,
        online: isOnline(Number(other.employee_id)),
      } : null,
      members: members.map((m) => ({
        employeeId: Number(m.employee_id),
        name: m.full_name,
        photoUrl: m.photo_url,
        phone: m.mobile,
        email: m.email,
        role: m.member_role,
        designation: m.designation_title,
        online: isOnline(Number(m.employee_id)),
        lastSeenAt: toIso(m.last_seen_at),
      })),
    };
  }

  static async messages(
    conversationId: number,
    employeeId: number,
    options: { before?: number; limit?: number; search?: string } = {},
  ) {
    await ChatService.assertMember(conversationId, employeeId);
    const limit = Math.min(100, Math.max(5, options.limit ?? 40));
    const clauses = ['m.conversation_id = ?'];
    const params: unknown[] = [conversationId];

    const state = await ChatService.userState(conversationId, employeeId);
    if (state?.cleared_at) {
      clauses.push('m.created_at > ?');
      params.push(state.cleared_at);
    }
    if (options.before) {
      clauses.push('m.id < ?');
      params.push(options.before);
    }
    if (options.search) {
      clauses.push('m.body LIKE ?');
      params.push(`%${options.search}%`);
    }

    // Query one extra row so the caller knows whether older messages exist.
    const rows = await query<MessageRow>(
      `SELECT m.*, e.full_name AS sender_name, e.photo_url AS sender_photo,
              rm.body AS reply_body, re.full_name AS reply_sender
       FROM messages m
       JOIN employees e ON e.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN employees re ON re.id = rm.sender_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY m.id DESC
       LIMIT ${limit + 1}`,
      params,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map((r) => Number(r.id));

    let attachments: AttachmentRow[] = [];
    let reactions: ReactionRow[] = [];
    let receipts: ReceiptRow[] = [];
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      [attachments, reactions, receipts] = await Promise.all([
        query<AttachmentRow>(
          `SELECT ma.message_id, f.id AS file_id, f.original_name, f.mime_type, f.size_bytes, ma.duration_seconds
           FROM message_attachments ma JOIN files f ON f.id = ma.file_id WHERE ma.message_id IN (${ph})`,
          ids,
        ),
        query<ReactionRow>(
          `SELECT mr.message_id, mr.employee_id, e.full_name, mr.emoji
           FROM message_reactions mr JOIN employees e ON e.id = mr.employee_id WHERE mr.message_id IN (${ph})`,
          ids,
        ),
        query<ReceiptRow>(
          `SELECT message_id, COUNT(*) AS total, COALESCE(SUM(read_at IS NOT NULL), 0) AS read_count
           FROM message_receipts WHERE message_id IN (${ph}) GROUP BY message_id`,
          ids,
        ),
      ]);
    }

    const messages = page
      .map((r) => {
        const receipt = receipts.find((x) => Number(x.message_id) === Number(r.id));
        return mapMessage(
          r,
          attachments.filter((a) => Number(a.message_id) === Number(r.id)).map(mapAttachment),
          reactions.filter((x) => Number(x.message_id) === Number(r.id)).map(mapReaction),
          { recipientCount: Number(receipt?.total ?? 0), readCount: Number(receipt?.read_count ?? 0) },
        );
      })
      .reverse();

    return {
      messages,
      hasMore,
      nextBefore: messages.length > 0 ? messages[0].id : null,
    };
  }

  private static async hydrate(messageId: number) {
    const message = await queryOne<MessageRow>(
      `SELECT m.*, e.full_name AS sender_name, e.photo_url AS sender_photo, rm.body AS reply_body, re.full_name AS reply_sender
       FROM messages m JOIN employees e ON e.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id LEFT JOIN employees re ON re.id = rm.sender_id
       WHERE m.id = ?`,
      [messageId],
    );
    if (!message) throw ApiError.notFound('Message not found');
    const [attachments, reactions, receipts] = await Promise.all([
      query<AttachmentRow>(
        `SELECT 0 AS message_id, f.id AS file_id, f.original_name, f.mime_type, f.size_bytes, ma.duration_seconds
         FROM message_attachments ma JOIN files f ON f.id = ma.file_id WHERE ma.message_id = ?`,
        [messageId],
      ),
      query<ReactionRow>(
        `SELECT ? AS message_id, mr.employee_id, e.full_name, mr.emoji
         FROM message_reactions mr JOIN employees e ON e.id = mr.employee_id WHERE mr.message_id = ?`,
        [messageId, messageId],
      ),
      queryOne<ReceiptRow>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(read_at IS NOT NULL), 0) AS read_count
         FROM message_receipts WHERE message_id = ?`,
        [messageId],
      ),
    ]);
    return mapMessage(message, attachments.map(mapAttachment), reactions.map(mapReaction), {
      recipientCount: Number(receipts?.total ?? 0),
      readCount: Number(receipts?.read_count ?? 0),
    });
  }

  static async sendMessage(
    conversationId: number,
    sender: AuthUser,
    input: { body?: string; type?: string; replyToId?: number; fileIds?: number[]; durationSeconds?: number; clientId?: string },
  ) {
    await ChatService.assertMember(conversationId, sender.id);
    const conversation = await queryOne<{ is_announcement: number; name: string | null }>(
      'SELECT is_announcement, name FROM conversations WHERE id = ?',
      [conversationId],
    );
    if (!conversation) throw ApiError.notFound('Conversation not found');
    const membership = await queryOne<{ member_role: string }>(
      'SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?',
      [conversationId, sender.id],
    );
    const memberCount = await queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM conversation_members WHERE conversation_id = ?',
      [conversationId],
    );
    const isSmallGroup = Number(memberCount?.total ?? 0) <= 3;
    const canAnnounce =
      !conversation.is_announcement ||
      membership?.member_role === 'admin' ||
      sender.permissions.includes('notifications.send') ||
      sender.roleLevel >= 60 ||
      isSmallGroup;

    const body = input.body?.trim() ?? '';
    const fileIds = [...new Set((input.fileIds ?? []).filter((id) => Number.isFinite(id)))];
    const clientId = input.clientId?.trim().slice(0, 64) || null;
    if (!body && fileIds.length === 0) throw ApiError.badRequest('Message cannot be empty.');
    if (body.length > 8000) throw ApiError.badRequest('Message is too long.');

    // Fast idempotency path: a retried POST returns the already stored message.
    if (clientId) {
      const existing = await queryOne<{ id: number }>(
        'SELECT id FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?',
        [conversationId, sender.id, clientId],
      );
      if (existing) return ChatService.hydrate(Number(existing.id));
    }

    const files = fileIds.length
      ? await query<{ id: number; owner_id: number | null }>(
        `SELECT id, owner_id FROM files WHERE id IN (${fileIds.map(() => '?').join(',')})`,
        fileIds,
      )
      : [];
    if (files.length !== fileIds.length) throw ApiError.badRequest('One or more attachments are invalid.');
    if (files.some((f) => f.owner_id !== null && Number(f.owner_id) !== sender.id)) {
      throw ApiError.forbidden('You can only attach files you uploaded.');
    }

    let type = input.type ?? (fileIds.length > 0 ? 'file' : 'text');
    if (fileIds.length > 0 && !['image', 'file', 'voice'].includes(type)) type = 'file';
    if (conversation.is_announcement && !canAnnounce) {
      throw ApiError.forbidden('Only group administrators can post in this announcement channel.');
    }

    const created = await transaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO messages (conversation_id, sender_id, body, message_type, reply_to_id, client_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [conversationId, sender.id, body || null, type, input.replyToId ?? null, clientId],
      );
      const header = result as { insertId: number; affectedRows: number };
      const messageId = Number(header.insertId);
      const inserted = header.affectedRows === 1;
      if (inserted) {
        for (const fileId of fileIds) {
          await conn.query('INSERT INTO message_attachments (message_id, file_id, duration_seconds) VALUES (?, ?, ?)', [
            messageId,
            fileId,
            input.durationSeconds ?? null,
          ]);
        }
        const members = await conn.query('SELECT employee_id FROM conversation_members WHERE conversation_id = ?', [conversationId]);
        for (const member of members[0] as { employee_id: number }[]) {
          await conn.query(
            'INSERT INTO message_receipts (message_id, employee_id, delivered_at) VALUES (?, ?, NOW(3)) ON DUPLICATE KEY UPDATE delivered_at = VALUES(delivered_at)',
            [messageId, member.employee_id],
          );
        }
        await conn.query('UPDATE conversations SET updated_at = NOW(3) WHERE id = ?', [conversationId]);
      }
      // Sending a message makes the conversation visible again for its author.
      await conn.query(
        `INSERT INTO conversation_user_state (conversation_id, employee_id, deleted_at)
         VALUES (?, ?, NULL)
         ON DUPLICATE KEY UPDATE deleted_at = NULL`,
        [conversationId, sender.id],
      );
      return { messageId, inserted };
    });

    const payload = await ChatService.hydrate(created.messageId);

    if (created.inserted) {
      emitToConversation(conversationId, 'message:new', payload);

      const others = await query<{ employee_id: number; is_muted: number }>(
        'SELECT cm.employee_id, cm.is_muted FROM conversation_members cm WHERE cm.conversation_id = ? AND cm.employee_id <> ?',
        [conversationId, sender.id],
      );
      const offline = others
        .filter((m) => !isOnline(Number(m.employee_id)) && !m.is_muted)
        .map((m) => Number(m.employee_id));
      if (offline.length > 0) {
        await NotificationService.notify({
          employeeIds: offline,
          type: 'chat_message',
          title: conversation.name ? `${sender.fullName} · ${conversation.name}` : sender.fullName,
          body: body.slice(0, 160) || `[${type}]`,
          link: `/chat?c=${conversationId}`,
          actorId: sender.id,
        });
      }
    }

    return payload;
  }

  static async markRead(conversationId: number, employeeId: number): Promise<void> {
    await ChatService.assertMember(conversationId, employeeId);
    await execute('UPDATE conversation_members SET last_read_at = NOW(3) WHERE conversation_id = ? AND employee_id = ?', [
      conversationId,
      employeeId,
    ]);
    await execute(
      `UPDATE message_receipts mr JOIN messages m ON m.id = mr.message_id
       SET mr.read_at = NOW(3)
       WHERE m.conversation_id = ? AND mr.employee_id = ? AND mr.read_at IS NULL`,
      [conversationId, employeeId],
    );
    emitToConversation(conversationId, 'message:read', { conversationId, employeeId, readAt: new Date().toISOString() });
  }

  static async editMessage(messageId: number, employeeId: number, body: string): Promise<void> {
    const message = await queryOne<{ id: number; sender_id: number; conversation_id: number; deleted_at: string | null }>(
      'SELECT id, sender_id, conversation_id, deleted_at FROM messages WHERE id = ?',
      [messageId],
    );
    if (!message) throw ApiError.notFound('Message not found');
    if (Number(message.sender_id) !== employeeId) throw ApiError.forbidden('You can only edit your own messages.');
    if (message.deleted_at) throw ApiError.badRequest('This message was deleted.');
    if (!body.trim()) throw ApiError.badRequest('Message cannot be empty.');
    await execute('UPDATE messages SET body = ?, edited_at = NOW(3) WHERE id = ?', [body.trim(), messageId]);
    emitToConversation(Number(message.conversation_id), 'message:edited', {
      id: messageId,
      conversationId: Number(message.conversation_id),
      body: body.trim(),
      editedAt: new Date().toISOString(),
    });
    await recordAudit({
      actorId: employeeId,
      action: 'chat.message_edited',
      entityType: 'message',
      entityId: messageId,
      after: { body: body.trim() },
    });
  }

  static async deleteMessage(messageId: number, actor: AuthUser): Promise<void> {
    const message = await queryOne<{ id: number; sender_id: number; conversation_id: number; deleted_at: string | null }>(
      'SELECT id, sender_id, conversation_id, deleted_at FROM messages WHERE id = ?',
      [messageId],
    );
    if (!message) throw ApiError.notFound('Message not found');
    const isOwner = Number(message.sender_id) === actor.id;
    if (!isOwner && !actor.permissions.includes('chat.moderate')) {
      throw ApiError.forbidden('You cannot delete this message.');
    }
    if (message.deleted_at) return;
    await execute('UPDATE messages SET deleted_at = NOW(3), deleted_by = ?, body = NULL WHERE id = ?', [actor.id, messageId]);
    emitToConversation(Number(message.conversation_id), 'message:deleted', {
      id: messageId,
      conversationId: Number(message.conversation_id),
    });
    // Moderation of others' messages is always auditable.
    await recordAudit({
      actorId: actor.id,
      action: isOwner ? 'chat.message_deleted' : 'chat.message_moderated',
      entityType: 'message',
      entityId: messageId,
      before: { senderId: Number(message.sender_id) },
    });
  }

  static async react(messageId: number, employeeId: number, emoji: string): Promise<void> {
    const message = await queryOne<{ conversation_id: number }>('SELECT conversation_id FROM messages WHERE id = ?', [messageId]);
    if (!message) throw ApiError.notFound('Message not found');
    if (!(await ChatService.isMember(Number(message.conversation_id), employeeId))) throw ApiError.forbidden();
    const existing = await queryOne<{ id: number }>(
      'SELECT id FROM message_reactions WHERE message_id = ? AND employee_id = ? AND emoji = ?',
      [messageId, employeeId, emoji],
    );
    if (existing) {
      await execute('DELETE FROM message_reactions WHERE id = ?', [existing.id]);
    } else {
      await execute('INSERT INTO message_reactions (message_id, employee_id, emoji) VALUES (?, ?, ?)', [messageId, employeeId, emoji.slice(0, 8)]);
    }
    const reactions = await query<{ employee_id: number; full_name: string; emoji: string }>(
      `SELECT mr.employee_id, e.full_name, mr.emoji FROM message_reactions mr JOIN employees e ON e.id = mr.employee_id
       WHERE mr.message_id = ?`,
      [messageId],
    );
    emitToConversation(Number(message.conversation_id), 'message:reaction', {
      messageId,
      conversationId: Number(message.conversation_id),
      reactions: reactions.map((r) => ({ employeeId: Number(r.employee_id), name: r.full_name, emoji: r.emoji })),
    });
  }

  static async unreadTotal(employeeId: number): Promise<number> {
    const row = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM conversation_members cm
       LEFT JOIN conversation_user_state cus
         ON cus.conversation_id = cm.conversation_id AND cus.employee_id = cm.employee_id
       JOIN messages m ON m.conversation_id = cm.conversation_id AND m.deleted_at IS NULL AND m.sender_id <> cm.employee_id
       WHERE cm.employee_id = ? AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
         AND (cus.cleared_at IS NULL OR m.created_at > cus.cleared_at)
         AND (cus.deleted_at IS NULL OR m.created_at > cus.deleted_at)`,
      [employeeId],
    );
    return Number(row?.total ?? 0);
  }

  static async addMembers(conversationId: number, actor: AuthUser, memberIds: number[]): Promise<void> {
    await ChatService.assertMember(conversationId, actor.id);
    const conversation = await queryOne<{ conv_type: string }>('SELECT conv_type FROM conversations WHERE id = ?', [conversationId]);
    if (!conversation || conversation.conv_type === 'direct') throw ApiError.badRequest('Members can only be added to groups.');
    const membership = await queryOne<{ member_role: string }>(
      'SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?',
      [conversationId, actor.id],
    );
    if (membership?.member_role !== 'admin' && !actor.permissions.includes('chat.groups.manage')) {
      throw ApiError.forbidden('Only group administrators can add members.');
    }
    for (const id of memberIds) {
      await execute('INSERT IGNORE INTO conversation_members (conversation_id, employee_id) VALUES (?, ?)', [conversationId, id]);
      await joinConversationRoom(id, conversationId);
    }
    await NotificationService.notify({
      employeeIds: memberIds.filter((id) => id !== actor.id),
      type: 'chat_group',
      title: 'Added to a group',
      body: `${actor.fullName} added you to a group conversation.`,
      link: `/chat?c=${conversationId}`,
      actorId: actor.id,
    });
  }

  static async removeMember(conversationId: number, actor: AuthUser, memberId: number): Promise<void> {
    const membership = await queryOne<{ member_role: string }>(
      'SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?',
      [conversationId, actor.id],
    );
    if (!membership) throw ApiError.forbidden();
    if (membership.member_role !== 'admin' && !actor.permissions.includes('chat.groups.manage') && actor.id !== memberId) {
      throw ApiError.forbidden('Only group administrators can remove members.');
    }
    await execute('DELETE FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, memberId]);
  }

  static async contacts(employeeId: number) {
    return query<{ id: number; full_name: string; phone: string | null; email: string | null; designation_title: string | null; department_name: string | null; photo_url: string | null }>(
      `SELECT e.id, e.full_name, e.mobile AS phone, e.email, dg.title AS designation_title, d.name AS department_name, e.photo_url
       FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active' AND e.id <> ?
       ORDER BY e.full_name LIMIT 500`,
      [employeeId],
    );
  }

  static async renameConversation(conversationId: number, actor: AuthUser, name: string, description?: string): Promise<void> {
    await ChatService.assertMember(conversationId, actor.id);
    const conv = await queryOne<{ conv_type: string; created_by: number | null }>('SELECT conv_type, created_by FROM conversations WHERE id = ?', [conversationId]);
    if (!conv) throw ApiError.notFound('Conversation not found');

    const membership = await queryOne<{ member_role: string }>('SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
    const canEdit = conv.conv_type === 'direct' ||
      membership?.member_role === 'admin' ||
      Number(conv.created_by) === actor.id ||
      actor.roleLevel >= 50 ||
      actor.permissions.includes('chat.groups.manage');

    if (!canEdit) throw ApiError.forbidden('Only group administrators or creators can rename this conversation.');
    if (!name.trim()) throw ApiError.badRequest('Conversation name cannot be empty.');

    await execute('UPDATE conversations SET name = ?, description = COALESCE(?, description), updated_at = NOW(3) WHERE id = ?', [
      name.trim(),
      description !== undefined ? description.trim() : null,
      conversationId,
    ]);

    emitToConversation(conversationId, 'conversation:updated', { conversationId, name: name.trim(), description: description?.trim() });
    await recordAudit({
      actorId: actor.id,
      action: 'chat.conversation_renamed',
      entityType: 'conversation',
      entityId: conversationId,
      after: { name: name.trim(), description },
    });
  }

  /**
   * Deletes a conversation for the caller.
   *
   * Direct chats are hidden and cleared per user only: the other participant's
   * messages, attachments and history remain intact. Group administrators keep
   * the existing organisation-wide delete behaviour for groups they manage.
   */
  static async deleteConversation(conversationId: number, actor: AuthUser): Promise<{ deleted: boolean; left: boolean; hidden: boolean }> {
    await ChatService.assertMember(conversationId, actor.id);
    const conv = await queryOne<{ conv_type: string; created_by: number | null }>('SELECT conv_type, created_by FROM conversations WHERE id = ?', [conversationId]);
    if (!conv) throw ApiError.notFound('Conversation not found');

    if (conv.conv_type === 'direct') {
      const isFullAdmin = actor.roleLevel >= 60 || actor.permissions.includes('chat.groups.manage');
      if (isFullAdmin) {
        await transaction(async (conn) => {
          const [messages] = await conn.query('SELECT id FROM messages WHERE conversation_id = ?', [conversationId]);
          const msgIds = (messages as { id: number }[]).map((m) => m.id);
          if (msgIds.length > 0) {
            const ph = msgIds.map(() => '?').join(',');
            await conn.query(`DELETE FROM message_reactions WHERE message_id IN (${ph})`, msgIds);
            await conn.query(`DELETE FROM message_attachments WHERE message_id IN (${ph})`, msgIds);
            await conn.query(`DELETE FROM message_receipts WHERE message_id IN (${ph})`, msgIds);
            await conn.query('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
          }
          await conn.query('DELETE FROM conversation_user_state WHERE conversation_id = ?', [conversationId]);
          await conn.query('DELETE FROM conversation_members WHERE conversation_id = ?', [conversationId]);
          await conn.query('DELETE FROM conversations WHERE id = ?', [conversationId]);
        });
        emitToConversation(conversationId, 'conversation:deleted', { conversationId });
        await recordAudit({
          actorId: actor.id,
          action: 'chat.conversation_deleted',
          entityType: 'conversation',
          entityId: conversationId,
        });
        return { deleted: true, left: false, hidden: false };
      }

      await execute(
        `INSERT INTO conversation_user_state (conversation_id, employee_id, deleted_at, cleared_at)
         VALUES (?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE deleted_at = NOW(3), cleared_at = NOW(3)`,
        [conversationId, actor.id],
      );
      emitToEmployee(actor.id, 'conversation:hidden', { conversationId });
      emitToEmployees([actor.id], 'conversation:deleted', { conversationId });
      await recordAudit({
        actorId: actor.id,
        action: 'chat.conversation_hidden',
        entityType: 'conversation',
        entityId: conversationId,
        after: { scope: 'self' },
      });
      return { deleted: false, left: false, hidden: true };
    }

    const membership = await queryOne<{ member_role: string }>('SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
    const isAdmin = membership?.member_role === 'admin' ||
      Number(conv.created_by) === actor.id ||
      actor.roleLevel >= 50 ||
      actor.permissions.includes('chat.groups.manage');

    if (isAdmin) {
      await transaction(async (conn) => {
        const [messages] = await conn.query('SELECT id FROM messages WHERE conversation_id = ?', [conversationId]);
        const msgIds = (messages as { id: number }[]).map((m) => m.id);
        if (msgIds.length > 0) {
          const ph = msgIds.map(() => '?').join(',');
          await conn.query(`DELETE FROM message_reactions WHERE message_id IN (${ph})`, msgIds);
          await conn.query(`DELETE FROM message_attachments WHERE message_id IN (${ph})`, msgIds);
          await conn.query(`DELETE FROM message_receipts WHERE message_id IN (${ph})`, msgIds);
          await conn.query('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
        }
        await conn.query('DELETE FROM conversation_user_state WHERE conversation_id = ?', [conversationId]);
        await conn.query('DELETE FROM conversation_members WHERE conversation_id = ?', [conversationId]);
        await conn.query('DELETE FROM conversations WHERE id = ?', [conversationId]);
      });
      emitToConversation(conversationId, 'conversation:deleted', { conversationId });
      await recordAudit({
        actorId: actor.id,
        action: 'chat.conversation_deleted',
        entityType: 'conversation',
        entityId: conversationId,
      });
      return { deleted: true, left: false, hidden: false };
    }

    // Leave group
    await execute('DELETE FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
    emitToConversation(conversationId, 'conversation:members_changed', { conversationId });
    return { deleted: false, left: true, hidden: false };
  }

  static async emptyOrEnsureGeneral(employeeId: number, departmentId: number | null): Promise<void> {
    // New employees are automatically added to general and department channels.
    const channels = await query<{ id: number; department_id: number | null }>(
      "SELECT id, department_id FROM conversations WHERE conv_type = 'channel'",
    );
    for (const channel of channels) {
      if (channel.department_id === null || (departmentId && Number(channel.department_id) === departmentId)) {
        await execute('INSERT IGNORE INTO conversation_members (conversation_id, employee_id) VALUES (?, ?)', [channel.id, employeeId]);
      }
    }
  }
}
