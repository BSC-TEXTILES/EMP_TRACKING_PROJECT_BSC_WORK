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
    data = row.payload ? (JSON.parse(row.payload) as EmailTemplateData) : {};
  } catch {
    data = {};
  }
  const rendered = renderEmail(row.template, { ...data, appName: config.appName, appUrl: config.appUrl });

  try {
    const info = await transport.sendMail({
      from: config.smtp.from,
      replyTo: config.smtp.replyTo || undefined,
      to: row.recipient_name ? `"${row.recipient_name}" <${row.recipient_email}>` : row.recipient_email,
      subject: row.subject || rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    await execute(
      "UPDATE email_deliveries SET status = 'sent', sent_at = NOW(3), message_id = ?, last_error = NULL WHERE id = ?",
      [String(info.messageId ?? '').slice(0, 190) || null, row.id],
    );
  } catch (error) {
    const message = 'SMTP delivery failed';
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
  const stats: Record<string, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) stats[row.status] = Number(row.total);
  return stats;
}

export interface DeliveryRow {
  id: number;
  recipient: string;
  recipientName: string | null;
  subject: string;
  template: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export async function listDeliveries(options: { status?: string; search?: string; limit?: number }): Promise<DeliveryRow[]> {
  const clauses: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (options.status && ['queued', 'sending', 'sent', 'failed', 'skipped'].includes(options.status)) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.search) {
    clauses.push('(recipient_email LIKE ? OR subject LIKE ? OR template LIKE ?)');
    const term = `%${options.search}%`;
    params.push(term, term, term);
  }
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const rows = await query<{
    id: number;
    recipient_email: string;
    recipient_name: string | null;
    subject: string;
    template: string;
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    next_attempt_at: string | null;
    sent_at: string | null;
    created_at: string;
  }>(
    `SELECT id, recipient_email, recipient_name, subject, template, status, attempts, max_attempts,
            last_error, next_attempt_at, sent_at, created_at
       FROM email_deliveries WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    recipient: row.recipient_email,
    recipientName: row.recipient_name,
    subject: row.subject,
    template: row.template,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error,
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
    const message = 'SMTP delivery failed';
    await execute(
      `INSERT INTO email_deliveries (recipient_email, subject, template, status, attempts, last_error)
       VALUES (?, ?, 'test', 'failed', 1, ?)`,
      [to.slice(0, 190), rendered.subject, message],
    ).catch(() => undefined);
    return { delivered: false, error: message };
  }
}
