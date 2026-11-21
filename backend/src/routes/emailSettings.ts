import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { configStore, type WebsiteSettings } from '../lib/configStore.js';
import { ApiError, asyncHandler, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requirePermission } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { smtpInput, smtpTransport, storedSmtp } from '../services/WebsiteSetupService.js';
import { resetMailTransport } from '../lib/mailer.js';
import { recordAudit } from '../lib/audit.js';

const pending = new Map<string, { actor: number; expires: number; settings: WebsiteSettings }>();
setInterval(() => { for (const [key, item] of pending) if (item.expires < Date.now()) pending.delete(key); }, 60000).unref();
export const emailSettingsRouter = Router();
emailSettingsRouter.use(authenticate, requirePermission('settings.manage'));

emailSettingsRouter.get('/', (_req, res) => {
  const from = config.smtp.from || 'BSC Textiles Workforce <admin@bsctextiles.in>';
  const match = from.match(/^(.*?)\s*<([^>]+)>$/);
  res.json({
    host: config.smtp.host || 'smtp.hostinger.com',
    port: config.smtp.port || 465,
    secure: config.smtp.secure ?? true,
    user: config.smtp.user || 'admin@bsctextiles.in',
    fromName: match?.[1]?.trim() || config.appName || 'BSC Textiles Workforce',
    fromEmail: match?.[2] || 'admin@bsctextiles.in',
    replyTo: config.smtp.replyTo || 'admin@bsctextiles.in',
    hasPassword: Boolean(config.smtp.password),
    otp: config.otp,
  });
});

emailSettingsRouter.post('/test', rateLimit({ windowMs: 60000, max: 5, keyPrefix: 'smtp-config' }), asyncHandler(async (req, res) => {
  const body = parseBody(z.object({
    smtp: smtpInput.extend({ password: z.string().max(1000).optional() }),
    to: z.string().email().max(190), otp: z.object({
      expiryMinutes: z.number().int().min(1).max(30),
      resendCooldownSeconds: z.number().int().min(30).max(600), maxAttempts: z.number().int().min(1).max(10)
    })
  }), req.body);
  const input = { ...body.smtp };
  // If password not provided, try to use current config password when host/user match
  if (!input.password && input.host === config.smtp.host && input.user === config.smtp.user) {
    input.password = config.smtp.password;
  }
  if (!input.password) throw ApiError.badRequest('Enter the SMTP password.');
  // At this point input.password is guaranteed to be a string
  const inputWithPassword = input as z.infer<typeof smtpInput>;
  const transport = smtpTransport(inputWithPassword);
  try {
    await transport.verify();
    const result = await transport.sendMail({
      from: { name: input.fromName, address: input.fromEmail }, to: body.to,
      replyTo: input.replyTo, subject: 'Workforce email configuration test', text: 'Your proposed SMTP configuration was accepted. Return to Email Settings to save it after confirming receipt.'
    });
    if (!result.accepted?.length) throw new Error('Recipient rejected');
  } catch { throw ApiError.badRequest('SMTP verification or test email failed. Check your settings.'); }
  finally { transport.close(); }
  const actor = currentUser(req).id;
  for (const [key, item] of pending) if (item.actor === actor) pending.delete(key);
  const verification = crypto.randomBytes(32).toString('hex');
  pending.set(verification, { actor, expires: Date.now() + 600000, settings: { smtp: storedSmtp(inputWithPassword), otp: body.otp } });
  await recordAudit({ actorId: actor, action: 'email.configuration_tested', entityType: 'settings', after: { accepted: true } });
  res.json({ accepted: true, verification });
}));

emailSettingsRouter.put('/', asyncHandler(async (req, res) => {
  const actor = currentUser(req).id;
  const verificationSchema = z.object({
    verification: z.string().length(64),
    receivedTest: z.literal(true),
  });
  const directSchema = z.object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().trim().min(1).max(255),
    password: z.string().max(1000).optional(),
    fromName: z.string().trim().min(1).max(100),
    fromEmail: z.string().trim().email().max(190),
    replyTo: z.string().trim().email().max(190).optional().or(z.literal('')),
    otp: z.object({
      expiryMinutes: z.number().int().min(1).max(30),
      resendCooldownSeconds: z.number().int().min(30).max(600),
      maxAttempts: z.number().int().min(1).max(10),
    }).optional(),
  });

  const verificationParsed = verificationSchema.safeParse(req.body);
  if (verificationParsed.success) {
    const item = pending.get(verificationParsed.data.verification);
    if (!item || item.actor !== actor || item.expires < Date.now()) {
      throw ApiError.badRequest('Test the configuration again before saving.');
    }
    configStore.write({ ...configStore.read(), ...item.settings });
    Object.assign(config.smtp, item.settings.smtp);
    Object.assign(config.otp, item.settings.otp);
    resetMailTransport();
    pending.delete(verificationParsed.data.verification);
    await recordAudit({ actorId: actor, action: 'email.configuration_saved', entityType: 'settings', after: { verified: true } });
    return res.json({ saved: true });
  }

  const directParsed = directSchema.safeParse(req.body);
  if (!directParsed.success) {
    throw ApiError.badRequest('Invalid email configuration parameters.');
  }

  const d = directParsed.data;
  const effectivePassword = d.password?.trim() ? d.password : (config.smtp.password || 'Btpldvg@2026');
  const updatedSmtp = storedSmtp({
    host: d.host,
    port: d.port,
    secure: d.secure,
    user: d.user,
    password: effectivePassword,
    fromName: d.fromName,
    fromEmail: d.fromEmail,
    replyTo: d.replyTo || d.fromEmail,
  });

  const currentStore = configStore.read();
  const newSettings: WebsiteSettings = {
    ...currentStore,
    smtp: updatedSmtp,
    ...(d.otp ? { otp: d.otp } : {}),
  };
  configStore.write(newSettings);
  Object.assign(config.smtp, updatedSmtp);
  if (d.otp) Object.assign(config.otp, d.otp);
  resetMailTransport();

  await recordAudit({ actorId: actor, action: 'email.configuration_saved', entityType: 'settings', after: { direct: true } });
  res.json({ saved: true });
}));
