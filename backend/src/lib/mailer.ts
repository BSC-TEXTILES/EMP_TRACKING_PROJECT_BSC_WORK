import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { execute, query, queryOne } from '../db/index.js';
import { renderEmail, type EmailTemplateData } from './emailTemplates.js';

/**
 * Email delivery layer.
 *
 * Two paths share one delivery log (`email_deliveries`):
 *  - direct sends for time-critical codes (OTP), which must report success now;
 *  - a durable queue for business notifications, processed by the scheduler with
 *    exponential backoff, so a failing SMTP server can never roll back a task,
 *    ticket or meeting that is already saved.
 */

let transporter: Transporter | null = null;
export function resetMailTransport(): void { transporter?.close(); transporter = null; statusCache = null; }

function buildTransporter(): Transporter | null {
  if (!config.smtp.configured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      requireTLS: config.isProd && !config.smtp.secure,
      disableFileAccess: true,
      disableUrlAccess: true,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      connectionTimeout: 12_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

export interface SmtpStatus {
  configured: boolean;
  reachable: boolean | null;
  host: string;
  port: number;
  secure: boolean;
  auth: boolean;
  from: string;
  replyTo: string | null;
  error: string | null;
  checkedAt: string | null;
}

let statusCache: { value: SmtpStatus; at: number } | null = null;

/** Live SMTP handshake. Cached briefly so the admin page can poll cheaply. */
export async function smtpStatus(force = false): Promise<SmtpStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value;

  const base: SmtpStatus = {
    configured: config.smtp.configured,
    reachable: null,
    host: config.smtp.host || '—',
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: Boolean(config.smtp.user),
    from: config.smtp.from,
    replyTo: config.smtp.replyTo || null,
    error: null,
    checkedAt: new Date().toISOString(),
  };

  const transport = buildTransporter();
  if (!transport) {
    base.reachable = false;
    base.error = 'SMTP is not configured. Set SMTP_HOST, SMTP_PORT and credentials in the environment.';
  } else {
    try {
      await transport.verify();
      base.reachable = true;
    } catch (error) {
      base.reachable = false;
      base.error = 'SMTP verification failed. Check the configured hostname, port, TLS and credentials.';
    }
  }

  statusCache = { value: base, at: Date.now() };
  return base;
}

interface DeliveryInput {
  to: string;
  toName?: string | null;
  template: string;
  data: EmailTemplateData;
  subject?: string;
  dedupeKey?: string | null;
  relatedType?: string | null;
  relatedId?: number | null;
  maxAttempts?: number;
}

/** Records the message and hands it to the queue (no SMTP call here). */
export async function enqueueEmail(input: DeliveryInput): Promise<number | null> {
  const rendered = renderEmail(input.template, { ...input.data, appName: config.appName, appUrl: config.appUrl });
  try {
    const result = await execute(
      `INSERT INTO email_deliveries
         (recipient_email, recipient_name, subject, template, payload, status, next_attempt_at, dedupe_key, related_type, related_id, max_attempts)
       VALUES (?, ?, ?, ?, ?, 'queued', NOW(3), ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        input.to.slice(0, 190),
        input.toName?.slice(0, 150) ?? null,
        (input.subject ?? rendered.subject).slice(0, 255),
        input.template.slice(0, 60),
        JSON.stringify(input.data).slice(0, 60_000),
        input.dedupeKey?.slice(0, 160) ?? null,
        input.relatedType?.slice(0, 40) ?? null,
        input.relatedId ?? null,
        input.maxAttempts ?? 3,
      ],
    );
    return result.insertId || null;
  } catch (error) {
    console.error('[mail] could not queue message', error instanceof Error ? error.message : error);
    return null;
  }
}

async function deliver(row: {
  id: number;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  template: string;
  payload: string | null;
}): Promise<void> {
  const transport = buildTransporter();
  if (!transport) {
    await execute(
      "UPDATE email_deliveries SET status = 'skipped', last_error = ? WHERE id = ?",
      ['SMTP is not configured', row.id],
    );
    console.log(`[mail:dev] ${row.subject} → ${row.recipient_email} (SMTP not configured, not sent)`);
    return;
  }

  let data: EmailTemplateData = {};
  try {
    // payload is a JSON column: mysql2 usually returns it already parsed. Parsing
    // an object threw here and silently emptied every queued email's content.
    const raw = row.payload as unknown;
    data = raw == null ? {} : typeof raw === 'string' ? (JSON.parse(raw) as EmailTemplateData) : (raw as EmailTemplateData);
  } catch {
    data = {};
  }
  const rendered = renderEmail(row.template, { ...data, appName: config.appName, appUrl: config.appUrl });

  try {
    const attachments = await loadAttachments(data.attachments);
    const info = await transport.sendMail({
      from: config.smtp.from,
      replyTo: config.smtp.replyTo || undefined,
      to: row.recipient_name ? `"${row.recipient_name.replace(/"/g, '')}" <${row.recipient_email}>` : row.recipient_email,
      subject: row.subject || rendered.subject,
      text: rendered.text,
      html: rendered.html,
      attachments,
    });
    // Only an address the provider accepted counts as sent.
    if (Array.isArray(info.rejected) && info.rejected.length > 0 && (!info.accepted || info.accepted.length === 0)) {
      throw Object.assign(new Error('Recipient rejected'), { code: 'EENVELOPE' });
    }
    await execute(
      "UPDATE email_deliveries SET status = 'sent', sent_at = NOW(3), message_id = ?, last_error = NULL WHERE id = ?",
      [String(info.messageId ?? '').slice(0, 190) || null, row.id],
    );
  } catch (error) {
    const message = describeSmtpError(error);
    const current = await queryOne<{ attempts: number; max_attempts: number }>(
      'SELECT attempts, max_attempts FROM email_deliveries WHERE id = ?',
      [row.id],
    );
    const attempts = Number(current?.attempts ?? 1);
    const max = Number(current?.max_attempts ?? 3);
    if (attempts >= max) {
      await execute("UPDATE email_deliveries SET status = 'failed', last_error = ? WHERE id = ?", [message, row.id]);
    } else {
      const backoffMinutes = Math.min(60, Math.pow(2, attempts) * 2);
      await execute(
        "UPDATE email_deliveries SET status = 'failed', last_error = ?, next_attempt_at = DATE_ADD(NOW(3), INTERVAL ? MINUTE) WHERE id = ?",
        [message, backoffMinutes, row.id],
      );
    }
    console.error(`[mail] delivery failed for ${row.recipient_email}: ${message}`);
  }
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Loads attachment bytes from permanent storage. Files that are missing or that
 * would push the email over 20 MB (most providers' limit) are left out; the
 * email still links to the message, where they can be downloaded.
 */
async function loadAttachments(list: EmailTemplateData['attachments']): Promise<{ filename: string; content: Buffer; contentType: string }[]> {
  if (!list?.length) return [];
  const { FileService } = await import('../services/FileService.js');
  const fs = await import('node:fs/promises');
  const result: { filename: string; content: Buffer; contentType: string }[] = [];
  let total = 0;
  for (const item of list.slice(0, 10)) {
    const file = await queryOne<{ storage_key: string; original_name: string; mime_type: string; size_bytes: number }>(
      "SELECT storage_key, original_name, mime_type, size_bytes FROM files WHERE id = ? AND scan_status IN ('clean','validated')",
      [item.fileId],
    );
    if (!file || total + Number(file.size_bytes) > MAX_ATTACHMENT_BYTES) continue;
    try {
      const content = await fs.readFile(FileService.absolutePath(file.storage_key));
      total += content.length;
      result.push({ filename: file.original_name, content, contentType: file.mime_type });
    } catch {
      console.error(`[mail] attachment file ${item.fileId} is missing from storage`);
    }
  }
  return result;
}

/** Turns SMTP failures into an administrator-readable reason without exposing credentials. */
export function describeSmtpError(error: unknown): string {
  const err = error as { code?: string; responseCode?: number; command?: string };
  if (err?.code === 'EAUTH' || err?.responseCode === 535) return 'SMTP authentication failed: check the SMTP username and password (for Gmail, use an App Password).';
  if (err?.code === 'ESOCKET' || err?.code === 'ECONNECTION' || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED') return 'Could not connect to the SMTP server: check the host, port and SSL/TLS setting.';
  if (err?.code === 'EENVELOPE' || (err?.responseCode && err.responseCode >= 550 && err.responseCode < 560)) return 'The mail server rejected the recipient or sender address.';
  if (err?.responseCode === 554 || err?.responseCode === 552) return 'The mail server refused the message (size or content policy).';
  return 'SMTP delivery failed.';
}

export function assertNoHeaderInjection(...values: (string | null | undefined)[]): void {
  for (const v of values) {
    if (v && /[\r\n]/.test(v)) {
      throw new Error('Invalid email input: line breaks or header injection characters are not permitted.');
    }
  }
}

export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const clean = email.trim();
  if (clean.length > 254) return false;
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(clean);
}

export interface DirectEmailOptions {
  senderId?: number | null;
  senderName?: string | null;
  senderEmail?: string | null;
  to: string | string[];
  toName?: string | null;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | null;
  subject: string;
  text?: string;
  html?: string;
  template?: string;
  data?: EmailTemplateData;
  attachments?: Array<{
    fileId?: number;
    filename?: string;
    name?: string;
    content?: Buffer;
    contentType?: string;
    mimeType?: string;
    size?: number;
  }>;
  dedupeKey?: string | null;
  relatedType?: string | null;
  relatedId?: number | null;
}

export interface DirectEmailResult {
  status: 'accepted' | 'failed' | 'skipped' | 'queued';
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  deliveryId?: number;
  error: string | null;
}

/**
 * Robust, production-grade direct email sender.
 * Transmits through Nodemailer, records delivery status, CC, BCC, and messageId in the database,
 * and reports true provider acceptance.
 */
export async function sendDirectEmail(options: DirectEmailOptions): Promise<DirectEmailResult> {
  const toList = Array.isArray(options.to) ? options.to : options.to.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const ccList = Array.isArray(options.cc) ? options.cc : (options.cc ? options.cc.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);
  const bccList = Array.isArray(options.bcc) ? options.bcc : (options.bcc ? options.bcc.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);

  assertNoHeaderInjection(options.subject, ...toList, ...ccList, ...bccList, options.replyTo, options.senderName, options.toName);

  const cleanTo = toList.map((e) => e.trim()).filter(Boolean);
  const cleanCc = ccList.map((e) => e.trim()).filter(Boolean);
  const cleanBcc = bccList.map((e) => e.trim()).filter(Boolean);

  if (cleanTo.length === 0) {
    throw new Error('At least one recipient email address is required.');
  }

  for (const addr of [...cleanTo, ...cleanCc, ...cleanBcc]) {
    if (!isValidEmail(addr)) {
      throw new Error(`Invalid email address: ${addr}`);
    }
  }

  const subject = options.subject.trim();
  if (!subject) throw new Error('Email subject is required.');

  let text = options.text?.trim() || '';
  let html = options.html?.trim() || '';

  if (options.template) {
    const rendered = renderEmail(options.template, {
      ...options.data,
      name: options.toName || undefined,
      title: subject,
      body: text,
      appName: config.appName,
      appUrl: config.appUrl,
    });
    if (!html) html = rendered.html;
    if (!text) text = rendered.text;
  } else if (!html && text) {
    html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;background:#1e293b;color:#ffffff;">
      <h2 style="margin:0;font-size:16px;font-weight:600;letter-spacing:-0.01em;">${config.appName}</h2>
    </td></tr>
    <tr><td style="padding:24px;color:#1e293b;font-size:14px;line-height:1.6;white-space:pre-wrap;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #f1f5f9;background:#f8fafc;color:#64748b;font-size:11px;">
      Sent via ${config.appName} Secure Workforce Mailer
    </td></tr>
  </table>
</body>
</html>`;
  }

  // Load attachments safely
  const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  if (options.attachments && options.attachments.length > 0) {
    const { FileService } = await import('../services/FileService.js');
    const fs = await import('node:fs/promises');
    let totalBytes = 0;
    for (const item of options.attachments.slice(0, 10)) {
      if (item.content) {
        totalBytes += item.content.length;
        if (totalBytes > MAX_ATTACHMENT_BYTES) {
          throw new Error('Total attachments size exceeds 20MB limit.');
        }
        attachments.push({
          filename: item.filename || item.name || 'attachment',
          content: item.content,
          contentType: item.contentType || item.mimeType || 'application/octet-stream',
        });
      } else if (item.fileId) {
        const file = await queryOne<{ storage_key: string; original_name: string; mime_type: string; size_bytes: number }>(
          "SELECT storage_key, original_name, mime_type, size_bytes FROM files WHERE id = ? AND scan_status IN ('clean','validated')",
          [item.fileId],
        );
        if (file) {
          totalBytes += Number(file.size_bytes);
          if (totalBytes > MAX_ATTACHMENT_BYTES) {
            throw new Error('Total attachments size exceeds 20MB limit.');
          }
          try {
            const buf = await fs.readFile(FileService.absolutePath(file.storage_key));
            attachments.push({
              filename: file.original_name,
              content: buf,
              contentType: file.mime_type,
            });
          } catch (e) {
            console.error('[mail] attachment file read error:', e);
          }
        }
      }
    }
  }

  const primaryRecipient = cleanTo[0];
  const allToCsv = cleanTo.join(', ');
  const ccCsv = cleanCc.length > 0 ? cleanCc.join(', ') : null;
  const bccCsv = cleanBcc.length > 0 ? cleanBcc.join(', ') : null;

  const deliveryInsert = await execute(
    `INSERT INTO email_deliveries
       (sender_id, recipient_email, recipient_name, cc_emails, bcc_emails, subject, template, body_text, body_html, attachments, status, attempts, dedupe_key, related_type, related_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE attempts = attempts + 1, status = 'sending'`,
    [
      options.senderId ?? null,
      primaryRecipient.slice(0, 190),
      options.toName?.slice(0, 150) ?? null,
      ccCsv,
      bccCsv,
      subject.slice(0, 255),
      options.template || 'direct',
      text.slice(0, 50_000),
      html.slice(0, 100_000),
      options.attachments ? JSON.stringify(options.attachments).slice(0, 10_000) : null,
      options.dedupeKey ?? null,
      options.relatedType ?? null,
      options.relatedId ?? null,
    ],
  );
  const deliveryId = Number(deliveryInsert.insertId);

  const transport = buildTransporter();
  if (!transport) {
    const errorMsg = 'SMTP is not configured on the server. Outgoing emails cannot be sent.';
    await execute(
      "UPDATE email_deliveries SET status = 'skipped', last_error = ? WHERE id = ?",
      [errorMsg, deliveryId],
    ).catch(() => undefined);
    return {
      status: 'skipped',
      messageId: null,
      accepted: [],
      rejected: cleanTo,
      deliveryId,
      error: errorMsg,
    };
  }

  try {
    const senderDisplayName = options.senderName ? `${options.senderName} via ${config.appName}` : config.appName;
    const fromAddress = config.smtp.from.includes('<') ? config.smtp.from : `"${senderDisplayName.replace(/"/g, '')}" <${config.smtp.user || config.smtp.from}>`;

    const info = await transport.sendMail({
      from: fromAddress,
      to: cleanTo,
      cc: cleanCc.length > 0 ? cleanCc : undefined,
      bcc: cleanBcc.length > 0 ? cleanBcc : undefined,
      replyTo: options.replyTo || options.senderEmail || config.smtp.replyTo || undefined,
      subject,
      text,
      html: html || undefined,
      attachments,
    });

    const accepted = Array.isArray(info.accepted) ? info.accepted.map(String) : [];
    const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : [];

    if (accepted.length === 0 && rejected.length > 0) {
      throw Object.assign(new Error('Recipient address was rejected by the SMTP provider'), { code: 'EENVELOPE' });
    }

    const messageId = String(info.messageId || '').slice(0, 190) || null;
    await execute(
      "UPDATE email_deliveries SET status = 'accepted', sent_at = NOW(3), message_id = ?, last_error = NULL WHERE id = ?",
      [messageId, deliveryId],
    );

    return {
      status: 'accepted',
      messageId,
      accepted: accepted.length > 0 ? accepted : cleanTo,
      rejected,
      deliveryId,
      error: null,
    };
  } catch (error) {
    const message = describeSmtpError(error);
    await execute(
      "UPDATE email_deliveries SET status = 'failed', last_error = ? WHERE id = ?",
      [message, deliveryId],
    ).catch(() => undefined);

    console.error(`[mail] Direct email send failed for ${allToCsv}:`, message);
    return {
      status: 'failed',
      messageId: null,
      accepted: [],
      rejected: cleanTo,
      deliveryId,
      error: message,
    };
  }
}

/**
 * Sends one queued email right now (used where the user is waiting for the
 * result, e.g. "Send email"). Returns the real outcome: 'sent' only after the
 * provider accepted the message. Failed rows stay in the queue for retry.
 */
export async function deliverNow(id: number): Promise<{ status: 'accepted' | 'sent' | 'failed' | 'skipped' | 'queued'; error: string | null }> {
  const claimed = await execute(
    "UPDATE email_deliveries SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status IN ('queued','failed') AND attempts < max_attempts",
    [id],
  );
  if (claimed.affectedRows === 1) {
    const row = await queryOne<{ id: number; recipient_email: string; recipient_name: string | null; subject: string; template: string; payload: string | null }>(
      'SELECT id, recipient_email, recipient_name, subject, template, payload FROM email_deliveries WHERE id = ?', [id],
    );
    if (row) await deliver(row);
  }
  const after = await queryOne<{ status: string; last_error: string | null }>('SELECT status, last_error FROM email_deliveries WHERE id = ?', [id]);
  const rawStatus = String(after?.status);
  const status = (['accepted', 'sent', 'failed', 'skipped'].includes(rawStatus) ? rawStatus : 'queued') as 'accepted' | 'sent' | 'failed' | 'skipped' | 'queued';
  return { status, error: (status === 'accepted' || status === 'sent') ? null : after?.last_error ?? null };
}

/** Processes due queue rows. Returns counters for the job log. */
export async function processEmailQueue(limit = 20): Promise<{ sent: number; failed: number; skipped: number }> {
  const rows = await query<{
    id: number;
    recipient_email: string;
    recipient_name: string | null;
    subject: string;
    template: string;
    payload: string | null;
  }>(
    `SELECT id, recipient_email, recipient_name, subject, template, payload
       FROM email_deliveries
      WHERE status IN ('queued', 'failed')
        AND template <> 'otp'
        AND attempts < max_attempts
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3))
      ORDER BY id
      LIMIT ${Math.max(1, Math.min(100, limit))}`,
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    const claimed = await execute(
      "UPDATE email_deliveries SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status IN ('queued','failed')",
      [row.id],
    );
    if (claimed.affectedRows === 0) continue;

    const before = await queryOne<{ status: string }>('SELECT status FROM email_deliveries WHERE id = ?', [row.id]);
    await deliver(row);
    const after = await queryOne<{ status: string }>('SELECT status FROM email_deliveries WHERE id = ?', [row.id]);
    if (after?.status === 'sent') sent += 1;
    else if (after?.status === 'skipped') skipped += 1;
    else if (after?.status === 'failed') failed += 1;
    else if (before?.status === 'sending') failed += 1;
  }
  return { sent, failed, skipped };
}

/**
 * Immediate send for time-critical codes. The delivery attempt is still logged.
 */
export async function sendOtpEmail(input: {
  to: string;
  name: string;
  code: string;
  purpose: string;
  expiresMinutes: number;
}): Promise<boolean> {
  const data: EmailTemplateData = {
    name: input.name,
    code: input.code,
    purpose: input.purpose,
    expiresMinutes: input.expiresMinutes,
    appName: config.appName,
    appUrl: config.appUrl,
  };
  const rendered = renderEmail('otp', data);
  const transport = buildTransporter();
  if (!transport) {
    console.warn('[mail] OTP delivery unavailable: SMTP is not configured');
    await execute(
      `INSERT INTO email_deliveries (recipient_email, recipient_name, subject, template, payload, status, attempts, last_error)
       VALUES (?, ?, ?, 'otp', ?, 'skipped', 1, ?)`,
      [input.to.slice(0, 190), input.name.slice(0, 150), rendered.subject, JSON.stringify({ purpose: input.purpose, expiresMinutes: input.expiresMinutes }), 'SMTP is not configured'],
    ).catch(() => undefined);
    return false;
  }

  const delivery = await execute(
    `INSERT INTO email_deliveries (recipient_email, recipient_name, subject, template, payload, status, attempts)
     VALUES (?, ?, ?, 'otp', ?, 'sending', 1)`,
    [input.to.slice(0, 190), input.name.slice(0, 150), rendered.subject, JSON.stringify({ purpose: input.purpose, expiresMinutes: input.expiresMinutes })],
  );

  try {
    const info = await transport.sendMail({
      from: config.smtp.from,
      replyTo: config.smtp.replyTo || undefined,
      to: input.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    await execute(
      "UPDATE email_deliveries SET status = 'sent', sent_at = NOW(3), message_id = ? WHERE id = ?",
      [String(info.messageId ?? '').slice(0, 190) || null, delivery.insertId],
    );
    return true;
  } catch (error) {
    const message = 'SMTP rejected the OTP delivery attempt';
    await execute(
      "UPDATE email_deliveries SET status = 'failed', last_error = ?, next_attempt_at = DATE_ADD(NOW(3), INTERVAL 2 MINUTE) WHERE id = ?",
      [message, delivery.insertId],
    ).catch(() => undefined);
    console.error('[mail] OTP delivery failed', message);
    return false;
  }
}

export async function emailStats(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; total: number }>(
    'SELECT status, COUNT(*) AS total FROM email_deliveries GROUP BY status',
  );
  const stats: Record<string, number> = { queued: 0, sending: 0, sent: 0, accepted: 0, failed: 0, skipped: 0, delivered: 0 };
  for (const row of rows) stats[row.status] = Number(row.total);
  return stats;
}

export interface DeliveryRow {
  id: number;
  senderId?: number | null;
  recipient: string;
  recipientName: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  template: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  messageId?: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export async function listDeliveries(options: { status?: string; search?: string; limit?: number; senderId?: number }): Promise<DeliveryRow[]> {
  const clauses: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (options.status && ['queued', 'sending', 'sent', 'accepted', 'failed', 'skipped', 'delivered'].includes(options.status)) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.senderId) {
    clauses.push('sender_id = ?');
    params.push(options.senderId);
  }
  if (options.search) {
    clauses.push('(recipient_email LIKE ? OR subject LIKE ? OR template LIKE ? OR message_id LIKE ?)');
    const term = `%${options.search}%`;
    params.push(term, term, term, term);
  }
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const rows = await query<{
    id: number;
    sender_id: number | null;
    recipient_email: string;
    recipient_name: string | null;
    cc_emails: string | null;
    bcc_emails: string | null;
    subject: string;
    template: string;
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    message_id: string | null;
    next_attempt_at: string | null;
    sent_at: string | null;
    created_at: string;
  }>(
    `SELECT id, sender_id, recipient_email, recipient_name, cc_emails, bcc_emails, subject, template, status, attempts, max_attempts,
            last_error, message_id, next_attempt_at, sent_at, created_at
       FROM email_deliveries WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    senderId: row.sender_id ? Number(row.sender_id) : null,
    recipient: row.recipient_email,
    recipientName: row.recipient_name,
    cc: row.cc_emails,
    bcc: row.bcc_emails,
    subject: row.subject,
    template: row.template,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error,
    messageId: row.message_id,
    nextAttemptAt: row.next_attempt_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  }));
}

/** Requeues a failed/skipped message with a fresh retry budget. */
export async function retryDelivery(id: number): Promise<boolean> {
  const result = await execute(
    `UPDATE email_deliveries
        SET status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = NOW(3)
      WHERE id = ? AND template <> 'otp' AND status IN ('failed', 'skipped')`,
    [id],
  );
  return result.affectedRows > 0;
}

export async function sendTestEmail(to: string): Promise<{ delivered: boolean; error?: string }> {
  const transport = buildTransporter();
  if (!transport) return { delivered: false, error: 'SMTP is not configured. Set the SMTP_* variables and restart the server.' };
  const rendered = renderEmail('test', { appName: config.appName, appUrl: config.appUrl });
  try {
    const info = await transport.sendMail({
      from: config.smtp.from,
      replyTo: config.smtp.replyTo || undefined,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    await execute(
      `INSERT INTO email_deliveries (recipient_email, subject, template, status, attempts, message_id, sent_at)
       VALUES (?, ?, 'test', 'sent', 1, ?, NOW(3))`,
      [to.slice(0, 190), rendered.subject, String(info.messageId ?? '').slice(0, 190) || null],
    ).catch(() => undefined);
    return { delivered: true };
  } catch (error) {
    const message = describeSmtpError(error);
    await execute(
      `INSERT INTO email_deliveries (recipient_email, subject, template, status, attempts, last_error)
       VALUES (?, ?, 'test', 'failed', 1, ?)`,
      [to.slice(0, 190), rendered.subject, message],
    ).catch(() => undefined);
    return { delivered: false, error: message };
  }
}
