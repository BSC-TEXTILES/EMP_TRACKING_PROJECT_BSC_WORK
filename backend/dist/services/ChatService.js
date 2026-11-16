import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { emitToConversation, isOnline, joinConversationRoom } from '../realtime/io.js';
import { NotificationService } from './NotificationService.js';
function mapMessage(r, attachments = [], reactions = []) {
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
        editedAt: toIso(r.edited_at),
        deleted: Boolean(r.deleted_at),
        createdAt: toIso(r.created_at),
        attachments,
        reactions,
    };
}
export class ChatService {
    static async isMember(conversationId, employeeId) {
        const row = await queryOne('SELECT id FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, employeeId]);
        return Boolean(row);
    }
    static async assertMember(conversationId, employeeId) {
        if (!(await ChatService.isMember(conversationId, employeeId))) {
            throw ApiError.forbidden('You are not a member of this conversation');
        }
    }
    static async listConversations(employeeId) {
        const rows = await query(`SELECT c.id, c.conv_type, c.name, c.description, c.is_announcement,
              cm.last_read_at, cm.is_muted,
              (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS last_message_at,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT e.full_name FROM messages m JOIN employees e ON e.id = m.sender_id WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
              (SELECT m.message_type FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_type,
              (SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.sender_id <> ?
                   AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)) AS unread,
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
       WHERE cm.employee_id = ?
       ORDER BY COALESCE(last_message_at, c.created_at) DESC`, [employeeId, employeeId, employeeId, employeeId, employeeId, employeeId]);
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
    static async ensureDirectConversation(employeeId, otherEmployeeId) {
        if (employeeId === otherEmployeeId)
            throw ApiError.badRequest('Choose another employee to chat with.');
        const other = await queryOne("SELECT id FROM employees WHERE id = ? AND status = 'active'", [otherEmployeeId]);
        if (!other)
            throw ApiError.notFound('Employee not found');
        const existing = await queryOne(`SELECT c.id FROM conversations c
       WHERE c.conv_type = 'direct'
         AND EXISTS (SELECT 1 FROM conversation_members m1 WHERE m1.conversation_id = c.id AND m1.employee_id = ?)
         AND EXISTS (SELECT 1 FROM conversation_members m2 WHERE m2.conversation_id = c.id AND m2.employee_id = ?)
         AND (SELECT COUNT(*) FROM conversation_members m3 WHERE m3.conversation_id = c.id) = 2
       LIMIT 1`, [employeeId, otherEmployeeId]);
        if (existing)
            return Number(existing.id);
        const id = await transaction(async (conn) => {
            const [result] = await conn.query("INSERT INTO conversations (conv_type, created_by) VALUES ('direct', ?)", [employeeId]);
            const convId = Number(result.insertId);
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
    static async createGroup(actor, input) {
        if (!input.name?.trim())
            throw ApiError.badRequest('Group name is required.');
        const members = [...new Set(input.memberIds.filter((id) => Number.isFinite(id)))];
        if (members.length === 0)
            throw ApiError.badRequest('Add at least one member.');
        const id = await transaction(async (conn) => {
            const [result] = await conn.query("INSERT INTO conversations (conv_type, name, description, department_id, is_announcement, created_by) VALUES ('group', ?, ?, ?, ?, ?)", [input.name.trim(), input.description ?? null, input.departmentId ?? null, input.isAnnouncement ? 1 : 0, actor.id]);
            const convId = Number(result.insertId);
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
    static async conversationDetail(conversationId, employeeId) {
        await ChatService.assertMember(conversationId, employeeId);
        const conversation = await queryOne('SELECT id, conv_type, name, description, is_announcement, created_by FROM conversations WHERE id = ?', [conversationId]);
        if (!conversation)
            throw ApiError.notFound('Conversation not found');
        const members = await query(`SELECT cm.employee_id, e.full_name, e.photo_url, e.mobile, e.email, cm.member_role, dg.title AS designation_title, e.last_seen_at
       FROM conversation_members cm
       JOIN employees e ON e.id = cm.employee_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE cm.conversation_id = ? ORDER BY cm.member_role DESC, e.full_name`, [conversationId]);
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
    static async messages(conversationId, employeeId, options = {}) {
        await ChatService.assertMember(conversationId, employeeId);
        const limit = Math.min(100, Math.max(5, options.limit ?? 40));
        const clauses = ['m.conversation_id = ?'];
        const params = [conversationId];
        if (options.before) {
            clauses.push('m.id < ?');
            params.push(options.before);
        }
        if (options.search) {
            clauses.push('m.body LIKE ?');
            params.push(`%${options.search}%`);
        }
        const rows = await query(`SELECT m.*, e.full_name AS sender_name, e.photo_url AS sender_photo,
              rm.body AS reply_body, re.full_name AS reply_sender
       FROM messages m
       JOIN employees e ON e.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN employees re ON re.id = rm.sender_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY m.id DESC
       LIMIT ${limit}`, params);
        const ids = rows.map((r) => Number(r.id));
        let attachments = [];
        let reactions = [];
        if (ids.length > 0) {
            const ph = ids.map(() => '?').join(',');
            attachments = await query(`SELECT ma.message_id, f.id AS file_id, f.original_name, f.mime_type, f.size_bytes, ma.duration_seconds
         FROM message_attachments ma JOIN files f ON f.id = ma.file_id WHERE ma.message_id IN (${ph})`, ids);
            reactions = await query(`SELECT mr.message_id, mr.employee_id, e.full_name, mr.emoji
         FROM message_reactions mr JOIN employees e ON e.id = mr.employee_id WHERE mr.message_id IN (${ph})`, ids);
        }
        return rows
            .map((r) => mapMessage(r, attachments.filter((a) => Number(a.message_id) === Number(r.id)).map((a) => ({ ...a, fileId: Number(a.file_id) })), reactions.filter((x) => Number(x.message_id) === Number(r.id)).map((x) => ({
            employeeId: Number(x.employee_id),
            name: x.full_name,
            emoji: x.emoji,
        }))))
            .reverse();
    }
    static async sendMessage(conversationId, sender, input) {
        await ChatService.assertMember(conversationId, sender.id);
        const conversation = await queryOne('SELECT is_announcement, name FROM conversations WHERE id = ?', [conversationId]);
        if (!conversation)
            throw ApiError.notFound('Conversation not found');
        const membership = await queryOne('SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, sender.id]);
        const memberCount = await queryOne('SELECT COUNT(*) AS total FROM conversation_members WHERE conversation_id = ?', [conversationId]);
        const isSmallGroup = Number(memberCount?.total ?? 0) <= 3;
        const canAnnounce = !conversation.is_announcement ||
            membership?.member_role === 'admin' ||
            sender.permissions.includes('notifications.send') ||
            sender.roleLevel >= 60 ||
            isSmallGroup;
        const body = input.body?.trim() ?? '';
        const fileIds = (input.fileIds ?? []).filter((id) => Number.isFinite(id));
        if (!body && fileIds.length === 0)
            throw ApiError.badRequest('Message cannot be empty.');
        const files = fileIds.length
            ? await query(`SELECT id, owner_id FROM files WHERE id IN (${fileIds.map(() => '?').join(',')})`, fileIds)
            : [];
        if (files.length !== fileIds.length)
            throw ApiError.badRequest('One or more attachments are invalid.');
        let type = input.type ?? (fileIds.length > 0 ? 'file' : 'text');
        if (fileIds.length > 0 && !['image', 'file', 'voice'].includes(type))
            type = 'file';
        if (conversation.is_announcement && !canAnnounce) {
            throw ApiError.forbidden('Only group administrators can post in this announcement channel.');
        }
        const created = await transaction(async (conn) => {
            const [result] = await conn.query('INSERT INTO messages (conversation_id, sender_id, body, message_type, reply_to_id) VALUES (?, ?, ?, ?, ?)', [conversationId, sender.id, body || null, type, input.replyToId ?? null]);
            const messageId = Number(result.insertId);
            for (const fileId of fileIds) {
                await conn.query('INSERT INTO message_attachments (message_id, file_id, duration_seconds) VALUES (?, ?, ?)', [
                    messageId,
                    fileId,
                    input.durationSeconds ?? null,
                ]);
            }
            const members = await conn.query('SELECT employee_id FROM conversation_members WHERE conversation_id = ?', [conversationId]);
            for (const member of members[0]) {
                await conn.query('INSERT INTO message_receipts (message_id, employee_id, delivered_at) VALUES (?, ?, NOW(3)) ON DUPLICATE KEY UPDATE delivered_at = VALUES(delivered_at)', [messageId, member.employee_id]);
            }
            await conn.query('UPDATE conversations SET updated_at = NOW(3) WHERE id = ?', [conversationId]);
            return messageId;
        });
        const message = await queryOne(`SELECT m.*, e.full_name AS sender_name, e.photo_url AS sender_photo, rm.body AS reply_body, re.full_name AS reply_sender
       FROM messages m JOIN employees e ON e.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id LEFT JOIN employees re ON re.id = rm.sender_id
       WHERE m.id = ?`, [created]);
        const attachments = await query(`SELECT f.id AS file_id, f.original_name, f.mime_type, f.size_bytes, ma.duration_seconds
       FROM message_attachments ma JOIN files f ON f.id = ma.file_id WHERE ma.message_id = ?`, [created]);
        const payload = mapMessage(message, attachments.map((a) => ({ ...a, fileId: Number(a.file_id) })));
        emitToConversation(conversationId, 'message:new', payload);
        const others = await query('SELECT cm.employee_id, cm.is_muted FROM conversation_members cm WHERE cm.conversation_id = ? AND cm.employee_id <> ?', [conversationId, sender.id]);
        const offline = others
            .filter((m) => !isOnline(Number(m.employee_id)) && !m.is_muted)
            .map((m) => Number(m.employee_id));
        if (offline.length > 0) {
            await NotificationService.notify({
                employeeIds: offline,
                type: 'chat_message',
                title: conversation.name ? `${sender.fullName} · ${conversation.name}` : sender.fullName,
                body: body.slice(0, 160) || `[${type}]`,
                link: `/chat?conversation=${conversationId}`,
                actorId: sender.id,
            });
        }
        return payload;
    }
    static async markRead(conversationId, employeeId) {
        await ChatService.assertMember(conversationId, employeeId);
        await execute('UPDATE conversation_members SET last_read_at = NOW(3) WHERE conversation_id = ? AND employee_id = ?', [
            conversationId,
            employeeId,
        ]);
        await execute(`UPDATE message_receipts mr JOIN messages m ON m.id = mr.message_id
       SET mr.read_at = NOW(3)
       WHERE m.conversation_id = ? AND mr.employee_id = ? AND mr.read_at IS NULL`, [conversationId, employeeId]);
        emitToConversation(conversationId, 'message:read', { conversationId, employeeId, readAt: new Date().toISOString() });
    }
    static async editMessage(messageId, employeeId, body) {
        const message = await queryOne('SELECT id, sender_id, conversation_id, deleted_at FROM messages WHERE id = ?', [messageId]);
        if (!message)
            throw ApiError.notFound('Message not found');
        if (Number(message.sender_id) !== employeeId)
            throw ApiError.forbidden('You can only edit your own messages.');
        if (message.deleted_at)
            throw ApiError.badRequest('This message was deleted.');
        if (!body.trim())
            throw ApiError.badRequest('Message cannot be empty.');
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
    static async deleteMessage(messageId, actor) {
        const message = await queryOne('SELECT id, sender_id, conversation_id, deleted_at FROM messages WHERE id = ?', [messageId]);
        if (!message)
            throw ApiError.notFound('Message not found');
        const isOwner = Number(message.sender_id) === actor.id;
        if (!isOwner && !actor.permissions.includes('chat.moderate')) {
            throw ApiError.forbidden('You cannot delete this message.');
        }
        if (message.deleted_at)
            return;
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
    static async react(messageId, employeeId, emoji) {
        const message = await queryOne('SELECT conversation_id FROM messages WHERE id = ?', [messageId]);
        if (!message)
            throw ApiError.notFound('Message not found');
        if (!(await ChatService.isMember(Number(message.conversation_id), employeeId)))
            throw ApiError.forbidden();
        const existing = await queryOne('SELECT id FROM message_reactions WHERE message_id = ? AND employee_id = ? AND emoji = ?', [messageId, employeeId, emoji]);
        if (existing) {
            await execute('DELETE FROM message_reactions WHERE id = ?', [existing.id]);
        }
        else {
            await execute('INSERT INTO message_reactions (message_id, employee_id, emoji) VALUES (?, ?, ?)', [messageId, employeeId, emoji.slice(0, 8)]);
        }
        const reactions = await query(`SELECT mr.employee_id, e.full_name, mr.emoji FROM message_reactions mr JOIN employees e ON e.id = mr.employee_id
       WHERE mr.message_id = ?`, [messageId]);
        emitToConversation(Number(message.conversation_id), 'message:reaction', {
            messageId,
            conversationId: Number(message.conversation_id),
            reactions: reactions.map((r) => ({ employeeId: Number(r.employee_id), name: r.full_name, emoji: r.emoji })),
        });
    }
    static async unreadTotal(employeeId) {
        const row = await queryOne(`SELECT COUNT(*) AS total
       FROM conversation_members cm
       JOIN messages m ON m.conversation_id = cm.conversation_id AND m.deleted_at IS NULL AND m.sender_id <> cm.employee_id
       WHERE cm.employee_id = ? AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)`, [employeeId]);
        return Number(row?.total ?? 0);
    }
    static async addMembers(conversationId, actor, memberIds) {
        await ChatService.assertMember(conversationId, actor.id);
        const conversation = await queryOne('SELECT conv_type FROM conversations WHERE id = ?', [conversationId]);
        if (!conversation || conversation.conv_type === 'direct')
            throw ApiError.badRequest('Members can only be added to groups.');
        const membership = await queryOne('SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
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
            link: `/chat?conversation=${conversationId}`,
            actorId: actor.id,
        });
    }
    static async removeMember(conversationId, actor, memberId) {
        const membership = await queryOne('SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
        if (!membership)
            throw ApiError.forbidden();
        if (membership.member_role !== 'admin' && !actor.permissions.includes('chat.groups.manage') && actor.id !== memberId) {
            throw ApiError.forbidden('Only group administrators can remove members.');
        }
        await execute('DELETE FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, memberId]);
    }
    static async contacts(employeeId) {
        return query(`SELECT e.id, e.full_name, e.mobile AS phone, e.email, dg.title AS designation_title, d.name AS department_name, e.photo_url
       FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active' AND e.id <> ?
       ORDER BY e.full_name LIMIT 500`, [employeeId]);
    }
    static async renameConversation(conversationId, actor, name, description) {
        await ChatService.assertMember(conversationId, actor.id);
        const conv = await queryOne('SELECT conv_type, created_by FROM conversations WHERE id = ?', [conversationId]);
        if (!conv)
            throw ApiError.notFound('Conversation not found');
        const membership = await queryOne('SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
        const canEdit = conv.conv_type === 'direct' ||
            membership?.member_role === 'admin' ||
            Number(conv.created_by) === actor.id ||
            actor.roleLevel >= 50 ||
            actor.permissions.includes('chat.groups.manage');
        if (!canEdit)
            throw ApiError.forbidden('Only group administrators or creators can rename this conversation.');
        if (!name.trim())
            throw ApiError.badRequest('Conversation name cannot be empty.');
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
    static async deleteConversation(conversationId, actor) {
        await ChatService.assertMember(conversationId, actor.id);
        const conv = await queryOne('SELECT conv_type, created_by FROM conversations WHERE id = ?', [conversationId]);
        if (!conv)
            throw ApiError.notFound('Conversation not found');
        const membership = await queryOne('SELECT member_role FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
        const isAdmin = conv.conv_type === 'direct' ||
            membership?.member_role === 'admin' ||
            Number(conv.created_by) === actor.id ||
            actor.roleLevel >= 50 ||
            actor.permissions.includes('chat.groups.manage');
        if (isAdmin) {
            await transaction(async (conn) => {
                const [messages] = await conn.query('SELECT id FROM messages WHERE conversation_id = ?', [conversationId]);
                const msgIds = messages.map((m) => m.id);
                if (msgIds.length > 0) {
                    const ph = msgIds.map(() => '?').join(',');
                    await conn.query(`DELETE FROM message_reactions WHERE message_id IN (${ph})`, msgIds);
                    await conn.query(`DELETE FROM message_attachments WHERE message_id IN (${ph})`, msgIds);
                    await conn.query(`DELETE FROM message_receipts WHERE message_id IN (${ph})`, msgIds);
                    await conn.query(`DELETE FROM messages WHERE conversation_id = ?`, [conversationId]);
                }
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
            return { deleted: true, left: false };
        }
        else {
            // Leave group
            await execute('DELETE FROM conversation_members WHERE conversation_id = ? AND employee_id = ?', [conversationId, actor.id]);
            emitToConversation(conversationId, 'conversation:members_changed', { conversationId });
            return { deleted: false, left: true };
        }
    }
    static async emptyOrEnsureGeneral(employeeId, departmentId) {
        // New employees are automatically added to general and department channels.
        const channels = await query("SELECT id, department_id FROM conversations WHERE conv_type = 'channel'");
        for (const channel of channels) {
            if (channel.department_id === null || (departmentId && Number(channel.department_id) === departmentId)) {
                await execute('INSERT IGNORE INTO conversation_members (conversation_id, employee_id) VALUES (?, ?)', [channel.id, employeeId]);
            }
        }
    }
}
//# sourceMappingURL=ChatService.js.map