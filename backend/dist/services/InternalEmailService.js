import { execute, query, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { toIso } from '../lib/dates.js';
import { NotificationService } from './NotificationService.js';
import { config } from '../config.js';
import { recordAudit } from '../lib/audit.js';
import { FileService } from './FileService.js';
export class InternalEmailService {
    static async inbox(userId, options = {}) {
        const page = Math.max(1, options.page ?? 1);
        const limit = Math.min(50, Math.max(1, options.limit ?? 20));
        const offset = (page - 1) * limit;
        const clauses = ['e.recipient_id = ?', 'e.is_deleted_by_recipient = 0'];
        const params = [userId];
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
        const countRow = await queryOne(`SELECT COUNT(*) AS total FROM internal_emails e
       JOIN employees s ON s.id = e.sender_id
       WHERE ${where}`, params);
        const total = Number(countRow?.total ?? 0);
        const rows = await query(`SELECT e.id, e.sender_id, s.full_name AS sender_name, s.email AS sender_email, s.photo_url AS sender_photo,
              e.recipient_name, e.recipient_email, e.cc_emails, e.bcc_emails,
              e.subject, e.body, e.body_html, e.is_read, e.read_at, e.is_starred_by_recipient,
              e.attachments, e.delivery_status, e.provider_message_id, e.created_at
       FROM internal_emails e
       JOIN employees s ON s.id = e.sender_id
       WHERE ${where}
       ORDER BY e.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`, params);
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
                recipientName: r.recipient_name,
                recipientEmail: r.recipient_email,
                cc: r.cc_emails,
                bcc: r.bcc_emails,
                subject: r.subject,
                body: r.body,
                bodyHtml: r.body_html,
                isRead: Boolean(r.is_read),
                readAt: toIso(r.read_at),
                isStarred: Boolean(r.is_starred_by_recipient),
                attachments: r.attachments ? (typeof r.attachments === 'string' ? JSON.parse(r.attachments) : r.attachments) : [],
                deliveryStatus: r.delivery_status || 'accepted',
                providerMessageId: r.provider_message_id,
                createdAt: toIso(r.created_at),
            })),
        };
    }
    static async sent(userId, options = {}) {
        const page = Math.max(1, options.page ?? 1);
        const limit = Math.min(50, Math.max(1, options.limit ?? 20));
        const offset = (page - 1) * limit;
        const clauses = ['e.sender_id = ?', 'e.is_deleted_by_sender = 0'];
        const params = [userId];
        if (options.search?.trim()) {
            clauses.push('(e.subject LIKE ? OR e.body LIKE ? OR r.full_name LIKE ? OR e.recipient_email LIKE ?)');
            const q = `%${options.search.trim()}%`;
            params.push(q, q, q, q);
        }
        const where = clauses.join(' AND ');
        const countRow = await queryOne(`SELECT COUNT(*) AS total FROM internal_emails e
       LEFT JOIN employees r ON r.id = e.recipient_id
       WHERE ${where}`, params);
        const total = Number(countRow?.total ?? 0);
        const rows = await query(`SELECT e.id, e.recipient_id,
              COALESCE(e.recipient_name, r.full_name, e.recipient_email) AS recipient_name,
              COALESCE(e.recipient_email, r.email) AS recipient_email,
              r.photo_url AS recipient_photo,
              e.cc_emails, e.bcc_emails,
              e.subject, e.body, e.body_html, e.is_read, e.read_at, e.is_starred_by_sender,
              e.attachments, e.delivery_status, e.provider_message_id, e.last_error, e.created_at
       FROM internal_emails e
       LEFT JOIN employees r ON r.id = e.recipient_id
       WHERE ${where}
       ORDER BY e.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`, params);
        return {
            total,
            page,
            limit,
            emails: rows.map((r) => ({
                id: Number(r.id),
                recipientId: r.recipient_id ? Number(r.recipient_id) : null,
                recipientName: r.recipient_name || 'Recipient',
                recipientEmail: r.recipient_email || '',
                recipientPhoto: r.recipient_photo,
                cc: r.cc_emails,
                bcc: r.bcc_emails,
                subject: r.subject,
                body: r.body,
                bodyHtml: r.body_html,
                isRead: Boolean(r.is_read),
                readAt: toIso(r.read_at),
                isStarred: Boolean(r.is_starred_by_sender),
                attachments: r.attachments ? (typeof r.attachments === 'string' ? JSON.parse(r.attachments) : r.attachments) : [],
                deliveryStatus: r.delivery_status || 'accepted',
                providerMessageId: r.provider_message_id,
                lastError: r.last_error,
                createdAt: toIso(r.created_at),
            })),
        };
    }
    static async unreadCount(userId) {
        const row = await queryOne('SELECT COUNT(*) AS total FROM internal_emails WHERE recipient_id = ? AND is_read = 0 AND is_deleted_by_recipient = 0', [userId]);
        return Number(row?.total ?? 0);
    }
    static async get(id, userId) {
        const row = await queryOne(`SELECT e.*,
              s.full_name AS sender_name, s.email AS sender_email, s.photo_url AS sender_photo,
              COALESCE(e.recipient_name, r.full_name, e.recipient_email) AS recipient_name,
              COALESCE(e.recipient_email, r.email) AS recipient_email,
              r.photo_url AS recipient_photo
       FROM internal_emails e
       JOIN employees s ON s.id = e.sender_id
       LEFT JOIN employees r ON r.id = e.recipient_id
       WHERE e.id = ?`, [id]);
        if (!row)
            throw ApiError.notFound('Email not found.');
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
            recipientId: row.recipient_id ? Number(row.recipient_id) : null,
            recipientName: row.recipient_name || 'Recipient',
            recipientEmail: row.recipient_email || '',
            recipientPhoto: row.recipient_photo,
            cc: row.cc_emails,
            bcc: row.bcc_emails,
            subject: row.subject,
            body: row.body,
            bodyHtml: row.body_html,
            isRead: Boolean(row.is_read),
            readAt: toIso(row.read_at),
            isStarred: Number(row.recipient_id) === userId ? Boolean(row.is_starred_by_recipient) : Boolean(row.is_starred_by_sender),
            attachments: row.attachments ? (typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments) : [],
            deliveryStatus: row.delivery_status || 'accepted',
            providerMessageId: row.provider_message_id,
            lastError: row.last_error,
            createdAt: toIso(row.created_at),
        };
    }
    /**
     * Sends an email throughout the application:
     * - Transmits through Nodemailer to recipient inboxes (external or internal)
     * - Records delivery status, provider message ID, and delivery history
     * - Delivers to internal employee mailboxes when recipient is a registered employee
     */
    static async send(sender, input) {
        const subject = input.subject.trim();
        const body = input.body.trim();
        if (!subject)
            throw ApiError.badRequest('Subject is required.');
        if (!body)
            throw ApiError.badRequest('Message body is required.');
        const internalEmpIds = [...new Set((input.recipientIds ?? []).filter((id) => Number.isFinite(id) && id > 0))];
        const externalTo = [...new Set((input.toEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
        const cleanCc = [...new Set((input.ccEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
        const cleanBcc = [...new Set((input.bccEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
        let internalEmployees = [];
        if (internalEmpIds.length > 0) {
            const placeholders = internalEmpIds.map(() => '?').join(',');
            internalEmployees = await query(`SELECT id, email, full_name FROM employees WHERE id IN (${placeholders}) AND status = 'active'`, internalEmpIds);
        }
        const allToAddresses = new Set();
        const internalMap = new Map();
        for (const emp of internalEmployees) {
            if (emp.email) {
                allToAddresses.add(emp.email.toLowerCase());
                internalMap.set(emp.email.toLowerCase(), emp);
            }
        }
        for (const ext of externalTo) {
            allToAddresses.add(ext);
        }
        const finalToList = [...allToAddresses];
        if (finalToList.length === 0) {
            throw ApiError.badRequest('Please enter or select at least one recipient email address.');
        }
        if (finalToList.length + cleanCc.length + cleanBcc.length > 50) {
            throw ApiError.badRequest('Total recipients (To + Cc + Bcc) cannot exceed 50 per email.');
        }
        const { assertNoHeaderInjection, isValidEmail, sendDirectEmail } = await import('../lib/mailer.js');
        assertNoHeaderInjection(subject, ...finalToList, ...cleanCc, ...cleanBcc);
        for (const addr of [...finalToList, ...cleanCc, ...cleanBcc]) {
            if (!isValidEmail(addr)) {
                throw ApiError.badRequest(`Invalid recipient email address format: ${addr}`);
            }
        }
        // Attachments
        const attachments = [];
        for (const item of input.attachments ?? []) {
            const file = await FileService.getForUser(item.fileId, sender);
            attachments.push({
                fileId: Number(file.id),
                name: file.original_name,
                size: Number(file.size_bytes),
                mimeType: file.mime_type,
            });
        }
        const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;
        // Send real email via SMTP
        const sendResult = await sendDirectEmail({
            senderId: sender.id,
            senderName: sender.fullName,
            senderEmail: sender.email,
            to: finalToList,
            cc: cleanCc.length > 0 ? cleanCc : undefined,
            bcc: cleanBcc.length > 0 ? cleanBcc : undefined,
            subject,
            text: body,
            html: input.html,
            attachments: attachments.map((a) => ({ fileId: a.fileId, name: a.name })),
            dedupeKey: input.idempotencyKey ? `user:${sender.id}:${input.idempotencyKey}` : undefined,
        });
        const isAccepted = sendResult.status === 'accepted';
        const deliveryStatus = isAccepted ? 'accepted' : (sendResult.status === 'skipped' ? 'queued' : 'failed');
        const ccCsv = cleanCc.length > 0 ? cleanCc.join(', ') : null;
        const bccCsv = cleanBcc.length > 0 ? cleanBcc.join(', ') : null;
        const createdIds = [];
        // 1. Deliver to internal employee inboxes
        for (const toAddr of finalToList) {
            const emp = internalMap.get(toAddr);
            if (emp && emp.id !== sender.id) {
                const res = await execute(`INSERT INTO internal_emails
             (sender_id, recipient_id, recipient_email, recipient_name, cc_emails, bcc_emails, subject, body, body_html, attachments, delivery_status, provider_message_id, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    sender.id,
                    emp.id,
                    emp.email,
                    emp.full_name,
                    ccCsv,
                    bccCsv,
                    subject,
                    body,
                    input.html ?? null,
                    attachmentsJson,
                    deliveryStatus,
                    sendResult.messageId ?? null,
                    sendResult.error ?? null,
                ]);
                const emailId = Number(res.insertId);
                createdIds.push(emailId);
                await NotificationService.notify({
                    employeeIds: [emp.id],
                    type: 'system',
                    title: `Email from ${sender.fullName}`,
                    body: subject,
                    link: `/mailbox?id=${emailId}`,
                    actorId: sender.id,
                }).catch(() => undefined);
            }
        }
        // 2. Deliver Sent item for the sender
        const toCsv = finalToList.join(', ');
        const sentRecord = await execute(`INSERT INTO internal_emails
         (sender_id, recipient_id, recipient_email, recipient_name, cc_emails, bcc_emails, subject, body, body_html, attachments, delivery_status, provider_message_id, last_error, is_deleted_by_recipient, is_read)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`, [
            sender.id,
            toCsv,
            toCsv,
            ccCsv,
            bccCsv,
            subject,
            body,
            input.html ?? null,
            attachmentsJson,
            deliveryStatus,
            sendResult.messageId ?? null,
            sendResult.error ?? null,
        ]);
        const sentEmailId = Number(sentRecord.insertId);
        createdIds.push(sentEmailId);
        await recordAudit({
            actorId: sender.id,
            action: 'internal_email.sent',
            entityType: 'internal_email',
            entityId: sentEmailId,
            after: {
                to: finalToList,
                cc: cleanCc,
                bcc: cleanBcc,
                deliveryStatus,
                messageId: sendResult.messageId,
            },
        });
        return {
            success: isAccepted,
            status: deliveryStatus,
            messageId: sendResult.messageId,
            emailId: sentEmailId,
            emailIds: createdIds,
            sent: finalToList.length,
            delivered: isAccepted ? finalToList.length : 0,
            deliveryConfigured: config.smtp.configured,
            error: sendResult.error,
            recipients: {
                to: finalToList,
                cc: cleanCc,
                bcc: cleanBcc,
            },
        };
    }
    static async toggleStar(id, userId) {
        const row = await queryOne('SELECT sender_id, recipient_id, is_starred_by_recipient, is_starred_by_sender FROM internal_emails WHERE id = ?', [id]);
        if (!row)
            throw ApiError.notFound('Email not found.');
        if (Number(row.recipient_id) === userId) {
            const next = row.is_starred_by_recipient ? 0 : 1;
            await execute('UPDATE internal_emails SET is_starred_by_recipient = ? WHERE id = ?', [next, id]);
            return { isStarred: Boolean(next) };
        }
        else if (Number(row.sender_id) === userId) {
            const next = row.is_starred_by_sender ? 0 : 1;
            await execute('UPDATE internal_emails SET is_starred_by_sender = ? WHERE id = ?', [next, id]);
            return { isStarred: Boolean(next) };
        }
        throw ApiError.forbidden();
    }
    static async delete(id, userId) {
        const row = await queryOne('SELECT sender_id, recipient_id, is_deleted_by_sender, is_deleted_by_recipient FROM internal_emails WHERE id = ?', [id]);
        if (!row)
            throw ApiError.notFound('Email not found.');
        let isSender = Number(row.sender_id) === userId;
        let isRecipient = Number(row.recipient_id) === userId;
        if (!isSender && !isRecipient)
            throw ApiError.forbidden();
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
//# sourceMappingURL=InternalEmailService.js.map