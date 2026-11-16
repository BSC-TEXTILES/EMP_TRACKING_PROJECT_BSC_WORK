import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { MfaService } from '../services/MfaService.js';
/** Self-service MFA (authenticator app, email OTP, recovery codes) and admin policy. */
export const mfaRouter = Router();
mfaRouter.use(authenticate);
const sensitive = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'mfa-sensitive' });
mfaRouter.get('/', asyncHandler(async (req, res) => {
    res.json(await MfaService.status(currentUser(req)));
}));
mfaRouter.post('/totp/setup', sensitive, asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ password: z.string().min(1).max(200) }), req.body);
    res.json(await MfaService.startTotpEnrollment(currentUser(req), body.password));
}));
mfaRouter.post('/totp/confirm', sensitive, asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ code: z.string().min(6).max(8) }), req.body);
    res.json(await MfaService.confirmTotpEnrollment(currentUser(req), body.code, clientIp(req)));
}));
mfaRouter.post('/email/setup', sensitive, asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ password: z.string().min(1).max(200) }), req.body);
    res.json(await MfaService.startEmailEnrollment(currentUser(req), body.password, clientIp(req)));
}));
mfaRouter.post('/email/confirm', sensitive, asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ code: z.string().min(4).max(10) }), req.body);
    res.json(await MfaService.confirmEmailEnrollment(currentUser(req), body.code, clientIp(req)));
}));
mfaRouter.post('/preferred', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ method: z.enum(['email', 'totp']) }), req.body);
    await MfaService.setPreferred(currentUser(req), body.method);
    res.json(await MfaService.status(currentUser(req)));
}));
mfaRouter.post('/recovery-codes', sensitive, asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ password: z.string().min(1).max(200) }), req.body);
    res.json(await MfaService.regenerateRecoveryCodes(currentUser(req), body.password, clientIp(req)));
}));
mfaRouter.post('/disable/code', sensitive, asyncHandler(async (req, res) => {
    res.json(await MfaService.sendDisableCode(currentUser(req), clientIp(req)));
}));
mfaRouter.post('/disable', sensitive, asyncHandler(async (req, res) => {
    const body = parseBody(z.object({
        method: z.enum(['email', 'totp']),
        password: z.string().min(1).max(200),
        code: z.string().min(4).max(20),
        codeMethod: z.enum(['email', 'totp', 'recovery']),
    }), req.body);
    res.json(await MfaService.disable(currentUser(req), body, clientIp(req)));
}));
// ------------------------------- Administration ------------------------------
mfaRouter.get('/policy', asyncHandler(async (req, res) => {
    res.json({ roles: await MfaService.policyOverview(currentUser(req)) });
}));
mfaRouter.put('/policy/roles/:id', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ required: z.boolean() }), req.body);
    await MfaService.setRoleRequirement(currentUser(req), intParam(req.params.id), body.required, clientIp(req));
    res.json({ ok: true });
}));
mfaRouter.put('/policy/employees/:id', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ required: z.boolean() }), req.body);
    await MfaService.setEmployeeRequirement(currentUser(req), intParam(req.params.id), body.required, clientIp(req));
    res.json({ ok: true });
}));
mfaRouter.post('/reset/:employeeId', sensitive, asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().min(10).max(300) }), req.body);
    await MfaService.adminReset(currentUser(req), intParam(req.params.employeeId), body.reason, clientIp(req));
    res.json({ ok: true });
}));
//# sourceMappingURL=mfa.js.map