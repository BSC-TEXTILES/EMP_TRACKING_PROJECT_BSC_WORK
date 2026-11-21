import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { closePool, queryOne } from '../src/db/index.js';
import { resetMailTransport } from '../src/lib/mailer.js';

/**
 * Proves the mailbox "Send Email" button produces a real SMTP message (with the
 * recipient, subject, body and attached file) and reports the true outcome.
 * A local SMTP server stands in for the provider (Hostinger/Gmail); production
 * uses the same nodemailer code path with the configured SMTP_* settings.
 */
let app: Express;
const PASSWORD = 'Workforce@2026';
const ORIGIN = 'http://localhost:5173';

interface Captured { from: string; to: string[]; data: string }
let captured: Captured[] = [];
let smtp: net.Server;
let smtpPort = 0;
let rejectAll = false;

function startSmtp(): Promise<void> {
  smtp = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current: Captured = { from: '', to: [], data: '' };
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          captured.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-test\r\n250 8BITMIME\r\n');
        else if (verb === 'MAIL') { current.from = line; socket.write('250 ok\r\n'); }
        else if (verb === 'RCPT') {
          if (rejectAll) socket.write('550 5.1.1 mailbox unavailable\r\n');
          else { current.to.push(line); socket.write('250 ok\r\n'); }
        } else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); return; }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => smtp.listen(0, '127.0.0.1', () => {
    smtpPort = (smtp.address() as net.AddressInfo).port;
    resolve();
  }));
}

async function login(identifier: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ identifier, password: PASSWORD });
  expect(response.status).toBe(200);
  return { agent, id: Number(response.body.user.id) };
}

const original = { ...config.smtp };
function useSmtp(enabled: boolean) {
  Object.assign(config.smtp, enabled
    ? { host: '127.0.0.1', port: smtpPort, secure: false, user: '', password: '', from: 'Workforce <no-reply@bsc.test>' }
    : { host: '' });
  vi.spyOn(config.smtp, 'configured', 'get').mockReturnValue(enabled);
  resetMailTransport();
}

beforeAll(async () => {
  app = createApp();
  await startSmtp();
});
afterEach(() => { captured = []; rejectAll = false; });
afterAll(async () => {
  Object.assign(config.smtp, { host: original.host, port: original.port, secure: original.secure, user: original.user, password: original.password, from: original.from });
  resetMailTransport();
  vi.restoreAllMocks();
  smtp.close();
  await closePool();
});

describe('mailbox email delivery', () => {
  it('delivers a real SMTP email with the attachment, and the recipient can download the file', async () => {
    useSmtp(true);
    const sender = await login('ananya.rao@workforce.test');
    const recipient = await login('karthik.iyer@workforce.test');
    const recipientEmail = (await queryOne<{ email: string }>('SELECT email FROM employees WHERE id = ?', [recipient.id]))!.email;

    const upload = await sender.agent.post('/api/files/upload').set('Origin', ORIGIN)
      .attach('file', Buffer.from('quarterly figures,100\n', 'utf8'), { filename: 'figures.csv', contentType: 'text/csv' });
    expect(upload.status).toBe(201);
    const fileId = Number(upload.body.id);

    const subject = `Stock report ${Date.now()}`;
    const send = await sender.agent.post('/api/emails/send').set('Origin', ORIGIN).send({
      recipientIds: [recipient.id],
      subject,
      body: 'Hello,\nPlease find the figures attached.',
      // Browser-supplied names are ignored; the server uses the stored file metadata.
      attachments: [{ fileId, name: 'spoofed.exe', size: 1, mimeType: 'application/x-msdownload' }],
    });
    expect(send.status, JSON.stringify(send.body)).toBe(201);
    expect(send.body.deliveryConfigured).toBe(true);
    expect(send.body.delivered).toBe(1);
    expect(send.body.recipients.to).toContain(recipientEmail);
    expect(send.body.status).toBe('accepted');

    expect(captured).toHaveLength(1);
    const message = captured[0];
    expect(message.to.join(' ')).toContain(recipientEmail);
    expect(message.data).toContain(subject);
    // The real content must arrive, not an empty template (regression: JSON payload was dropped).
    expect(message.data).toContain('Please find the figures attached.');
    expect(message.data).toMatch(/filename="?figures\.csv/);
    expect(message.data).not.toContain('spoofed.exe');

    const row = await queryOne<{ status: string; template: string }>(
      "SELECT status, template FROM email_deliveries WHERE message_id = ?",
      [send.body.messageId],
    );
    expect(row).toMatchObject({ status: 'accepted', template: 'direct' });

    // The recipient can open and download the attachment from their mailbox.
    const download = await recipient.agent.get(`/api/files/${fileId}?download=1`);
    expect(download.status).toBe(200);
    expect(download.text).toBe('quarterly figures,100\n');

    // Someone outside the email cannot.
    const outsider = await login('meera.joshi@workforce.test');
    expect((await outsider.agent.get(`/api/files/${fileId}?download=1`)).status).toBe(404);
  });

  it('refuses to attach a file the sender cannot access', async () => {
    useSmtp(true);
    const owner = await login('ananya.rao@workforce.test');
    const thief = await login('meera.joshi@workforce.test');
    const target = await login('karthik.iyer@workforce.test');
    const upload = await owner.agent.post('/api/files/upload').set('Origin', ORIGIN)
      .attach('file', Buffer.from('private salary sheet', 'utf8'), { filename: 'private.txt', contentType: 'text/plain' });
    expect(upload.status).toBe(201);
    const send = await thief.agent.post('/api/emails/send').set('Origin', ORIGIN).send({
      recipientIds: [target.id], subject: 'look', body: 'see attached',
      attachments: [{ fileId: Number(upload.body.id), name: 'x', size: 1, mimeType: 'text/plain' }],
    });
    expect(send.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it('reports a provider rejection honestly instead of claiming success', async () => {
    useSmtp(true);
    rejectAll = true;
    const sender = await login('ananya.rao@workforce.test');
    const recipient = await login('karthik.iyer@workforce.test');
    const send = await sender.agent.post('/api/emails/send').set('Origin', ORIGIN).send({
      recipientIds: [recipient.id], subject: `Rejected ${Date.now()}`, body: 'test',
    });
    expect(send.status).toBe(201);
    expect(send.body.delivered).toBe(0);
    expect(send.body.status).toBe('failed');
    expect(String(send.body.error)).toMatch(/rejected|unavailable/i);
    // Still saved in the Workforce mailbox.
    const inbox = await recipient.agent.get('/api/emails/inbox');
    expect(inbox.status).toBe(200);
  });

  it('tells the user when outgoing email is not configured', async () => {
    useSmtp(false);
    const sender = await login('ananya.rao@workforce.test');
    const recipient = await login('karthik.iyer@workforce.test');
    const send = await sender.agent.post('/api/emails/send').set('Origin', ORIGIN).send({
      recipientIds: [recipient.id], subject: `No SMTP ${Date.now()}`, body: 'test',
    });
    expect(send.status).toBe(201);
    expect(send.body.deliveryConfigured).toBe(false);
    expect(send.body.success).toBe(false);
    expect(send.body.error).toMatch(/not configured/i);
    expect(captured).toHaveLength(0);
  });
});
