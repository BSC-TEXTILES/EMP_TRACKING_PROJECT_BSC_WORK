import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { configStore } from '../lib/configStore.js';
import { ApiError, asyncHandler, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requirePermission } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { smtpInput, smtpTransport, storedSmtp } from '../services/WebsiteSetupService.js';
import { resetMailTransport } from '../lib/mailer.js';
import { recordAudit } from '../lib/audit.js';
const pending = new Map();
setInterval(() => { for (const [key, item] of pending)
    if (item.expires < Date.now())
        pending.delete(key); }, 60000).unref();
export const emailSettingsRouter = Router();
emailSettingsRouter.use(authenticate, requirePermission('settings.manage'));
emailSettingsRouter.get('/', (_req, res) => {
    const match = config.smtp.from.match(/^(.*?)\s*<([^>]+)>$/);
    res.json({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, user: config.smtp.user,
        fromName: match?.[1]?.trim() || config.appName, fromEmail: match?.[2] || config.smtp.from,
        replyTo: config.smtp.replyTo, hasPassword: Boolean(config.smtp.password), otp: config.otp });
});
emailSettingsRouter.post('/test', rateLimit({ windowMs: 60000, max: 5, keyPrefix: 'smtp-config' }), asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ smtp: smtpInput.extend({ password: z.string().max(1000) }),
        to: z.string().email().max(190), otp: z.object({ expiryMinutes: z.number().int().min(1).max(30),
            resendCooldownSeconds: z.number().int().min(30).max(600), maxAttempts: z.number().int().min(1).max(10) }) }), req.body);
    const input = { ...body.smtp };
    if (!input.password && input.host === config.smtp.host && input.user === config.smtp.user)
        input.password = config.smtp.password;
    if (!input.password)
        throw ApiError.badRequest('Enter the SMTP password.');
    const transport = smtpTransport(input);
    try {
        await transport.verify();
        const result = await transport.sendMail({ from: { name: input.fromName, address: input.fromEmail }, to: body.to,
            replyTo: input.replyTo, subject: 'Workforce email configuration test', text: 'Your proposed SMTP configuration was accepted. Return to Email Settings to save it after confirming receipt.' });
        if (!result.accepted?.length)
            throw new Error('Recipient rejected');
    }
    catch {
        throw ApiError.badRequest('SMTP verification or test email failed. Check your settings.');
    }
    finally {
        transport.close();
    }
    const actor = currentUser(req).id;
    for (const [key, item] of pending)
        if (item.actor === actor)
            pending.delete(key);
    const verification = crypto.randomBytes(32).toString('hex');
    pending.set(verification, { actor, expires: Date.now() + 600000, settings: { smtp: storedSmtp(input), otp: body.otp } });
    await recordAudit({ actorId: actor, action: 'email.configuration_tested', entityType: 'settings', after: { accepted: true } });
    res.json({ accepted: true, verification });
}));
emailSettingsRouter.put('/', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ verification: z.string().length(64), receivedTest: z.literal(true) }), req.body);
    const item = pending.get(body.verification);
    const actor = currentUser(req).id;
    if (!item || item.actor !== actor || item.expires < Date.now())
        throw ApiError.badRequest('Test the configuration again before saving.');
    configStore.write({ ...configStore.read(), ...item.settings });
    Object.assign(config.smtp, item.settings.smtp);
    Object.assign(config.otp, item.settings.otp);
    resetMailTransport();
    pending.delete(body.verification);
    await recordAudit({ actorId: actor, action: 'email.configuration_saved', entityType: 'settings', after: { verified: true } });
    res.json({ saved: true });
}));
//# sourceMappingURL=emailSettings.js.map