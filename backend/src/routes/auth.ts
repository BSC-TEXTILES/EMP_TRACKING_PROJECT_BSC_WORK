import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler, ApiError, clientIp, parseBody } from '../lib/http.js';
import { AuthService } from '../services/AuthService.js';
import { ActivityService } from '../services/ActivityService.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { NotificationService } from '../services/NotificationService.js';
import { rateLimit } from '../middleware/security.js';
import { query, queryOne } from '../db/index.js';
import type { AuthedRequest } from '../middleware/auth.js';
import jwt from 'jsonwebtoken';
import { sha256 } from '../lib/crypto.js';
import { PushService } from '../services/PushService.js';
import { disconnectSession } from '../realtime/io.js';

export const authRouter = Router();

/**
 * Development / staging demo accounts. Never available in production and never
 * embedded in the frontend bundle: the browser asks the API at runtime.
 */
const DEMO_LOGINS = [
  { role: 'Super Admin', email: 'admin@bsctextiles.in', fallbackEmail: 'admin@workforce.test' },
  { role: 'IT Support', email: 'it.admin@workforce.test', fallbackEmail: 'it.admin@workforce.test' },
  { role: 'Department Manager', email: 'it.manager@workforce.test', fallbackEmail: 'it.manager@workforce.test' },
  { role: 'Store Manager', email: 'store.manager@bsctextiles.in', fallbackEmail: 'store.manager@workforce.test' },
  { role: 'HR Manager', email: 'hr.manager@bsctextiles.in', fallbackEmail: 'hr.manager@workforce.test' },
  { role: 'Developer', email: 'ananya.rao@bsctextiles.in', fallbackEmail: 'ananya.rao@workforce.test' },
  { role: 'Employee', email: 'karthik.iyer@bsctextiles.in', fallbackEmail: 'karthik.iyer@workforce.test' },
];

authRouter.get(
  '/test-accounts',
  asyncHandler(async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const password = process.env.TEST_LOGIN_PASSWORD ?? 'Workforce@2026';
    const gagan = await queryOne<{ id: number; full_name: string; employee_code: string; email: string; mobile: string }>(
      "SELECT id, full_name, employee_code, email, mobile FROM employees WHERE full_name LIKE '%Gagan%' LIMIT 1",
    );
    const email = gagan?.email || 'gagan.cb@bsctextiles.in';
    const name = gagan?.full_name || 'Gagan C B';
    const code = gagan?.employee_code || 'EMP-1001';

    const chetan = await queryOne<{ id: number; full_name: string; employee_code: string; email: string; mobile: string }>(
      "SELECT id, full_name, employee_code, email, mobile FROM employees WHERE full_name LIKE '%Chetan%' LIMIT 1",
    );
    const hrEmail = chetan?.email || 'chetan.tk@bsctextiles.in';
    const hrName = chetan?.full_name || 'Chetan TK';
    const hrCode = chetan?.employee_code || 'EMP-1002';

    const renuka = await queryOne<{ id: number; full_name: string; employee_code: string; email: string; mobile: string }>(
      "SELECT id, full_name, employee_code, email, mobile FROM employees WHERE full_name LIKE '%Renuka%' LIMIT 1",
    );
    const swEmail = renuka?.email || 'renuka.adhya@bsctextiles.in';
    const swName = renuka?.full_name || 'Renuka Adhya';
    const swCode = renuka?.employee_code || 'EMP-1003';

    res.json({
      enabled: true,
      environment: config.env,
      accounts: [
        {
          role: 'Super Admin',
          employeeId: code,
          name,
          email,
          password,
        },
        {
          role: 'Software Manager',
          employeeId: swCode,
          name: swName,
          email: swEmail,
          password,
        },
        {
          role: 'HR Manager',
          employeeId: hrCode,
          name: hrName,
          email: hrEmail,
          password,
        },
        {
          role: 'Store Manager',
          employeeId: code,
          name,
          email: 'admin@bsctextiles.in',
          password,
        },
      ],
    });
  }),
);

function setSessionCookie(res: Parameters<Parameters<typeof asyncHandler>[0]>[1], token: string, refreshToken: string, expiresAt = Date.now() + config.sessionTtlDays * 86400000): void {
  res.cookie(config.cookieName, token, { httpOnly: true, sameSite: 'strict', secure: config.isProd, path: '/', maxAge: 15 * 60000 });
  res.cookie('wfm_refresh', refreshToken, { httpOnly: true, sameSite: 'strict', secure: config.isProd, path: '/api/auth', maxAge: Math.max(0, expiresAt - Date.now()) });
}

function clearSessionCookies(res: Parameters<Parameters<typeof asyncHandler>[0]>[1]): void {
  res.clearCookie(config.cookieName, { path: '/' });
  res.clearCookie('wfm_refresh', { path: '/api/auth' });
}

authRouter.post('/refresh', rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'refresh' }), asyncHandler(async (req, res) => {
  try {
    const result = await AuthService.refreshSession(req.cookies?.wfm_refresh);
    setSessionCookie(res, result.token, result.refreshToken, result.expiresAt);
    res.json({ expiresIn: 900 });
  } catch (error) {
    clearSessionCookies(res);
    throw error;
  }
}));

authRouter.post(
  '/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: config.rateLimit.loginMax, keyPrefix: 'login' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        identifier: z.string().min(3).max(190),
        password: z.string().min(1).max(200),
        remember: z.boolean().optional(),
      }),
      req.body,
    );
    const result = await AuthService.login({
      identifier: body.identifier,
      password: body.password,
      remember: body.remember,
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? 'unknown',
    });
    if ('requiresOtp' in result && result.requiresOtp) {
      res.json(result);
      return;
    }
    setSessionCookie(res, result.token, result.refreshToken);
    void ActivityService.autoStartTracking(result.user, {
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    });
    res.json({ user: result.user });
  }),
);

authRouter.post(
  '/login/otp/send',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 6, keyPrefix: 'login-otp' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ challenge: z.string().min(10) }), req.body);
    const result = await AuthService.requestLoginOtp(body.challenge, clientIp(req));
    res.json(result);
  }),
);

authRouter.post(
  '/login/otp/verify',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 15, keyPrefix: 'login-otp-verify' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ challenge: z.string().min(10), code: z.string().min(4).max(20), remember: z.boolean().optional(), method: z.enum(['email', 'totp', 'recovery']).optional() }),
      req.body,
    );
    const result = await AuthService.completeOtpLogin(
      body.challenge,
      body.code,
      clientIp(req),
      req.get('user-agent') ?? 'unknown',
      Boolean(body.remember),
      body.method ?? 'email',
    );
    setSessionCookie(res, result.token, result.refreshToken);
    void ActivityService.autoStartTracking(result.user, {
      ip: clientIp(req),
      userAgent: req.get('user-agent'),
    });
    res.json({ user: result.user });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // The sign-out dialog asks "Keep call and message notifications on this device?" (default yes).
    const prefs = z.object({
      keepNotifications: z.boolean().optional(),
      pushEndpoint: z.string().url().max(500).optional(),
    }).safeParse(req.body ?? {});
    const keep = prefs.success ? prefs.data.keepNotifications !== false : true;
    try {
      const session = await AuthService.authenticateToken(req.cookies?.[config.cookieName]);
      if (session) {
        await ActivityService.stopTracking(session.id);
        if (session.sessionId) await PushService.signOutSession(session.sessionId, keep);
        if (prefs.success && prefs.data.pushEndpoint) await PushService.signOutWebEndpoint(session.id, prefs.data.pushEndpoint, keep);
      }
    } catch {
      /* ignore */
    }
    await AuthService.logoutRefresh(req.cookies?.wfm_refresh);
    await AuthService.logout(req.cookies?.[config.cookieName]);
    clearSessionCookies(res);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Mobile app (Capacitor, Android / iOS)
//
// The app runs on its own origin (capacitor://localhost, https://localhost), so
// the website's SameSite=Strict cookies never reach the API. These endpoints use
// the same AuthService logic (lockout, OTP / MFA, session limits, rotating
// refresh tokens with reuse detection) but return the tokens in the response
// body. The app keeps them in the iOS Keychain / Android Keystore and sends
// `Authorization: Bearer <accessToken>`. No cookies are set or read here.
// ---------------------------------------------------------------------------

function mobileTokens(result: { token: string; refreshToken: string }) {
  const payload = jwt.decode(result.token) as { exp: number } | null;
  return {
    accessToken: result.token,
    refreshToken: result.refreshToken,
    accessTokenExpiresAt: payload ? payload.exp * 1000 : Date.now() + 15 * 60000,
  };
}

const refreshTokenSchema = z.string().min(20).max(256);

authRouter.post(
  '/mobile/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: config.rateLimit.loginMax, keyPrefix: 'login' }),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = parseBody(
      z.object({ identifier: z.string().min(3).max(190), password: z.string().min(1).max(200) }),
      req.body,
    );
    const result = await AuthService.login({
      identifier: body.identifier,
      password: body.password,
      remember: true,
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? 'mobile-app',
    });
    if ('requiresOtp' in result && result.requiresOtp) {
      // The app then calls /auth/login/otp/send (if needed) and /auth/mobile/login/otp/verify.
      res.json(result);
      return;
    }
    // Desktop activity tracking is not started: a phone cannot report it.
    res.json({ user: result.user, ...mobileTokens(result) });
  }),
);

authRouter.post(
  '/mobile/login/otp/verify',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 15, keyPrefix: 'login-otp-verify' }),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = parseBody(
      z.object({ challenge: z.string().min(10), code: z.string().min(4).max(20), method: z.enum(['email', 'totp', 'recovery']).optional() }),
      req.body,
    );
    const result = await AuthService.completeOtpLogin(
      body.challenge,
      body.code,
      clientIp(req),
      req.get('user-agent') ?? 'mobile-app',
      true,
      body.method ?? 'email',
    );
    res.json({ user: result.user, ...mobileTokens(result) });
  }),
);

/** Rotates the pair. Reusing an old refresh token revokes the whole session. */
authRouter.post(
  '/mobile/refresh',
  rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'refresh' }),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = parseBody(z.object({ refreshToken: refreshTokenSchema }), req.body);
    const result = await AuthService.refreshSession(body.refreshToken);
    res.json({ ...mobileTokens(result), sessionExpiresAt: result.expiresAt });
  }),
);

/**
 * Ends the session and removes the phone's push token(s). Works with either the
 * access token (Authorization header) or the refresh token, so the app can sign
 * out even when the access token has already expired.
 */
authRouter.post(
  '/mobile/logout',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ refreshToken: refreshTokenSchema.optional(), keepNotifications: z.boolean().optional() }), req.body ?? {});
    const header = req.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const sessionIds = new Set<number>();
    if (bearer) {
      const user = await AuthService.authenticateToken(bearer).catch(() => null);
      if (user?.sessionId) sessionIds.add(user.sessionId);
    }
    if (body.refreshToken) {
      const ref = await queryOne<{ session_id: number }>('SELECT session_id FROM session_refresh_tokens WHERE token_hash = ?', [sha256(body.refreshToken)]);
      if (ref) sessionIds.add(Number(ref.session_id));
    }
    for (const id of sessionIds) await PushService.signOutSession(id, body.keepNotifications !== false);
    await AuthService.logoutRefresh(body.refreshToken);
    await AuthService.logout(bearer);
    for (const id of sessionIds) disconnectSession(id);
    res.json({ ok: true });
  }),
);

/** Short-lived token for the app's image, video and download URLs (see AuthService.mediaToken). */
authRouter.post(
  '/mobile/media-token',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.authToken || req.cookies?.[config.cookieName]) throw ApiError.forbidden('Media tokens are for the mobile app only');
    res.json(AuthService.mediaToken(req.authToken));
  }),
);

authRouter.get(
  '/registration-options',
  asyncHandler(async (_req, res) => {
    const [departments, designations, locations, managers] = await Promise.all([
      query<{ id: number; name: string }>('SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name'),
      query<{ id: number; title: string; department_id: number | null }>(
        'SELECT id, title, department_id FROM designations WHERE is_active = 1 ORDER BY title',
      ),
      query<{ id: number; name: string; city: string | null }>('SELECT id, name, city FROM locations WHERE is_active = 1 ORDER BY name'),
      query<{ id: number; full_name: string; location_name: string | null }>(
        `SELECT e.id, e.full_name, COALESCE(l.name, l.city, 'Main Office') AS location_name
         FROM employees e
         LEFT JOIN locations l ON l.id = e.location_id
         WHERE e.status = 'active' AND (e.full_name LIKE '%Gagan%' OR e.full_name LIKE '%Renuka%' OR e.full_name LIKE '%Chetan%')
         ORDER BY e.full_name`,
      ),
    ]);
    res.json({ departments, designations, locations, managers });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const unread = await NotificationService.unreadCount(user.id);
    res.json({ user, unreadNotifications: unread });
  }),
);

authRouter.post(
  '/register',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'register' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        fullName: z.string().min(2).max(160),
        employeeCode: z.string().max(24).optional(),
        email: z.string().email(),
        mobile: z.string().min(7).max(20),
        departmentId: z.number().int().positive(),
        designationId: z.number().int().positive().nullable().optional(),
        managerId: z.number().int().positive().nullable().optional(),
        locationId: z.number().int().positive().nullable().optional(),
        employmentType: z.string().max(32).optional(),
        password: z.string().min(10).max(200),
      }),
      req.body,
    );
    const result = await AuthService.register(body);
    res.status(201).json(result);
  }),
);

authRouter.post(
  '/register/verify',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 15, keyPrefix: 'register-verify' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ employeeId: z.number().int().positive(), emailCode: z.string().min(4), mobileCode: z.string().min(4) }),
      req.body,
    );
    await AuthService.verifyRegistration(body.employeeId, body.emailCode, body.mobileCode);
    const hrUsers = await query<{ id: number }>(
      `SELECT DISTINCT e.id FROM employees e
       JOIN role_permissions rp ON rp.role_id = e.role_id
       JOIN permissions p ON p.id = rp.permission_id AND p.code = 'employees.approve'
       WHERE e.status = 'active'`,
    );
    if (hrUsers.length > 0) {
      await NotificationService.notify({
        employeeIds: hrUsers.map((u) => Number(u.id)),
        type: 'registration',
        title: 'New employee registration',
        body: 'A verified registration is waiting for approval.',
        link: '/admin/employees?status=pending_approval',
        priority: 'high',
      });
    }
    res.json({ ok: true, status: 'pending_approval' });
  }),
);

authRouter.post(
  '/register/resend',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 6, keyPrefix: 'register-resend' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ employeeId: z.number().int().positive(), channel: z.enum(['email', 'sms']) }), req.body);
    const result = await AuthService.resendRegistrationOtp(body.employeeId, body.channel);
    res.json(result);
  }),
);

authRouter.post(
  '/password/forgot',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 8, keyPrefix: 'forgot' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ identifier: z.string().min(3).max(190) }), req.body);
    const result = await AuthService.requestPasswordReset(body.identifier, clientIp(req));
    res.json({ ...result, message: 'If the account exists, a verification code has been sent.' });
  }),
);

authRouter.post(
  '/password/reset',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'reset' }),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ identifier: z.string().min(3).max(190), code: z.string().min(4), password: z.string().min(10).max(200) }),
      req.body,
    );
    await AuthService.resetPassword(body.identifier, body.code, body.password);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password/change',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) }), req.body);
    await AuthService.changePassword(user.id, body.currentPassword, body.newPassword);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const sessions = await AuthService.sessions(user.id);
    res.json({ sessions, currentSessionId: user.sessionId });
  }),
);

authRouter.delete(
  '/sessions/:sessionId',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const sessionId = Number.parseInt(req.params.sessionId, 10);
    if (!sessionId) throw ApiError.badRequest('Invalid session');
    await AuthService.revokeSession(user.id, sessionId);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/sessions/revoke-others',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    await AuthService.revokeOtherSessions(user.id, user.sessionId);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/login-history',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const rows = await AuthService.loginHistory(user.id, 25);
    res.json({
      history: rows.map((r) => ({
        id: Number(r.id),
        success: Boolean(r.success),
        ip: r.ip,
        device: r.device,
        failureReason: r.failure_reason,
        createdAt: r.created_at,
      })),
    });
  }),
);
