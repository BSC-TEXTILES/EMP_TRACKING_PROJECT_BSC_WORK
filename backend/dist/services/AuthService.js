import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { execute, nextSequence, query, queryOne, transaction, txQueryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { generateOtp, hashOtp, hashPassword, passwordIssues, randomToken, sha256, verifyPassword, } from '../lib/crypto.js';
import { sendOtpEmail } from '../lib/mailer.js';
import { sendSms } from '../lib/sms.js';
import { recordAudit } from '../lib/audit.js';
const EMPLOYEE_SELECT = `
  SELECT e.*, r.slug AS role_slug, r.name AS role_name, r.level AS role_level,
         d.name AS department_name, dg.title AS designation_title,
         m.full_name AS manager_name, l.name AS location_name
  FROM employees e
  JOIN roles r ON r.id = e.role_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN designations dg ON dg.id = e.designation_id
  LEFT JOIN employees m ON m.id = e.manager_id
  LEFT JOIN locations l ON l.id = e.location_id
`;
const OTP_WINDOW_MAX = 5;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
function deviceFromUserAgent(ua) {
    if (/android/i.test(ua))
        return 'Android';
    if (/iphone|ipad|ipod/i.test(ua))
        return 'iOS';
    if (/windows/i.test(ua))
        return 'Windows';
    if (/macintosh|mac os/i.test(ua))
        return 'macOS';
    if (/linux/i.test(ua))
        return 'Linux';
    return 'Unknown';
}
function normalizeIdentifier(raw) {
    return raw.trim().slice(0, 190);
}
export class AuthService {
    /** Loads the canonical auth principal for an employee, including permissions. */
    static async buildUser(employeeId, sessionId = 0) {
        const row = await queryOne(`${EMPLOYEE_SELECT} WHERE e.id = ?`, [employeeId]);
        if (!row)
            return null;
        const permissions = await AuthService.permissionsFor(Number(row.id), Number(row.role_id));
        return {
            id: Number(row.id),
            employeeCode: row.employee_code,
            fullName: row.full_name,
            email: row.email,
            mobile: row.mobile,
            photoUrl: row.photo_url,
            status: row.status,
            roleId: Number(row.role_id),
            roleSlug: row.role_slug,
            roleName: row.role_name,
            roleLevel: Number(row.role_level),
            departmentId: row.department_id ? Number(row.department_id) : null,
            departmentName: row.department_name,
            designationId: row.designation_id ? Number(row.designation_id) : null,
            designationTitle: row.designation_title,
            managerId: row.manager_id ? Number(row.manager_id) : null,
            managerName: row.manager_name,
            locationId: row.location_id ? Number(row.location_id) : null,
            locationName: row.location_name,
            employmentType: row.employment_type,
            joiningDate: row.joining_date,
            permissions,
            sessionId,
            mustChangePassword: Boolean(row.must_change_password),
            mfaEnabled: Boolean(row.mfa_enabled),
            lastLoginAt: row.last_login_at,
        };
    }
    static async permissionsFor(employeeId, roleId) {
        const rows = await query(`SELECT p.code, 'grant' AS effect
         FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ?
       UNION ALL
       SELECT p.code, up.effect
         FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
        WHERE up.employee_id = ?`, [roleId, employeeId]);
        const set = new Set();
        const denied = new Set();
        for (const row of rows) {
            if (row.effect === 'deny')
                denied.add(row.code);
            else
                set.add(row.code);
        }
        for (const code of denied)
            set.delete(code);
        return [...set].sort();
    }
    static async logAttempt(input) {
        await execute(`INSERT INTO login_history (employee_id, identifier, success, ip, user_agent, device, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            input.employeeId,
            input.identifier.slice(0, 190),
            input.success ? 1 : 0,
            input.ip.slice(0, 60),
            input.userAgent.slice(0, 250),
            deviceFromUserAgent(input.userAgent),
            input.failureReason?.slice(0, 120) ?? null,
        ]);
    }
    static async login(input) {
        const identifier = normalizeIdentifier(input.identifier);
        const emailCandidate = identifier.toLowerCase();
        const recentFailures = await queryOne(`SELECT COUNT(*) AS total FROM login_history
       WHERE success = 0 AND created_at > DATE_SUB(NOW(3), INTERVAL 15 MINUTE)
         AND (identifier = ? OR ip = ?)`, [identifier, input.ip]);
        if (Number(recentFailures?.total ?? 0) >= 20) {
            throw ApiError.tooMany('Too many failed attempts. Please wait 15 minutes before trying again.');
        }
        const employee = await queryOne(`${EMPLOYEE_SELECT} WHERE e.employee_code = ? OR e.email = ? OR e.mobile = ? LIMIT 1`, [identifier, emailCandidate, identifier]);
        if (!employee) {
            await AuthService.logAttempt({
                employeeId: null,
                identifier,
                success: false,
                ip: input.ip,
                userAgent: input.userAgent,
                failureReason: 'unknown_identifier',
            });
            throw ApiError.unauthorized('Invalid credentials');
        }
        if (employee.locked_until && new Date(`${employee.locked_until.replace(' ', 'T')}Z`).getTime() > Date.now()) {
            throw new ApiError(423, 'Account temporarily locked after repeated failed logins. Try again later.', 'account_locked');
        }
        if (!(await verifyPassword(input.password, employee.password_hash))) {
            const attempts = Number(employee.failed_login_attempts) + 1;
            const lock = attempts >= MAX_FAILED_LOGINS;
            await execute(`UPDATE employees SET failed_login_attempts = ?, locked_until = ${lock ? 'DATE_ADD(NOW(3), INTERVAL ? MINUTE)' : 'NULL'} WHERE id = ?`, lock ? [attempts, LOCK_MINUTES, employee.id] : [attempts, employee.id]);
            await AuthService.logAttempt({
                employeeId: Number(employee.id),
                identifier,
                success: false,
                ip: input.ip,
                userAgent: input.userAgent,
                failureReason: 'invalid_password',
            });
            if (lock) {
                throw new ApiError(423, `Account locked for ${LOCK_MINUTES} minutes after ${MAX_FAILED_LOGINS} failed attempts.`, 'account_locked');
            }
            throw ApiError.unauthorized('Invalid credentials');
        }
        if (employee.status !== 'active') {
            await AuthService.logAttempt({
                employeeId: Number(employee.id),
                identifier,
                success: false,
                ip: input.ip,
                userAgent: input.userAgent,
                failureReason: `status_${employee.status}`,
            });
            if (employee.status === 'pending_verification') {
                throw new ApiError(403, 'Your account is not verified yet. Complete email and mobile verification.', 'pending_verification');
            }
            if (employee.status === 'pending_approval') {
                throw new ApiError(403, 'Your registration is awaiting HR approval.', 'pending_approval');
            }
            throw new ApiError(403, 'This account is inactive. Contact your administrator.', 'account_inactive');
        }
        const requireOtp = Boolean(employee.mfa_enabled) || (await AuthService.settingEnabled('require_otp_on_login'));
        if (requireOtp) {
            await AuthService.issueOtp({
                identifier: employee.email,
                channel: 'email',
                purpose: 'login',
                employeeId: Number(employee.id),
                recipient: employee.email,
                name: employee.full_name,
                ip: input.ip,
            });
            await AuthService.logAttempt({
                employeeId: Number(employee.id),
                identifier,
                success: false,
                ip: input.ip,
                userAgent: input.userAgent,
                failureReason: 'otp_required',
            });
            return {
                requiresOtp: true,
                challenge: AuthService.signChallenge(Number(employee.id)),
                channels: ['email'],
            };
        }
        const token = await AuthService.createSession(Number(employee.id), input.ip, input.userAgent, Boolean(input.remember));
        await AuthService.logAttempt({
            employeeId: Number(employee.id),
            identifier,
            success: true,
            ip: input.ip,
            userAgent: input.userAgent,
        });
        const user = await AuthService.buildUser(Number(employee.id));
        if (!user)
            throw ApiError.unauthorized();
        return { ...token, user };
    }
    static async settingEnabled(key) {
        const row = await queryOne('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
        return row?.setting_value === 'true';
    }
    static signChallenge(employeeId) {
        return jwt.sign({ sub: String(employeeId), typ: 'mfa' }, config.jwtSecret, { expiresIn: '10m' });
    }
    static verifyChallenge(challenge) {
        try {
            const payload = jwt.verify(challenge, config.jwtSecret);
            if (payload.typ !== 'mfa' || !payload.sub)
                throw new Error('bad challenge');
            return Number(payload.sub);
        }
        catch {
            throw ApiError.unauthorized('Verification session expired. Please sign in again.');
        }
    }
    static async requestLoginOtp(challenge, ip) {
        const employeeId = AuthService.verifyChallenge(challenge);
        const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [employeeId]);
        if (!employee || employee.status !== 'active')
            throw ApiError.unauthorized();
        const result = await AuthService.issueOtp({
            identifier: employee.email,
            channel: 'email',
            purpose: 'login',
            employeeId,
            recipient: employee.email,
            name: employee.full_name,
            ip,
        });
        return result;
    }
    static async completeOtpLogin(challenge, code, ip, userAgent, remember = false) {
        const employeeId = AuthService.verifyChallenge(challenge);
        const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [employeeId]);
        if (!employee || employee.status !== 'active')
            throw ApiError.unauthorized();
        await AuthService.consumeOtp(employee.email, 'login', code);
        const token = await AuthService.createSession(employeeId, ip, userAgent, remember);
        await AuthService.logAttempt({
            employeeId,
            identifier: employee.email,
            success: true,
            ip,
            userAgent,
        });
        const user = await AuthService.buildUser(employeeId);
        if (!user)
            throw ApiError.unauthorized();
        return { ...token, user };
    }
    static async createSession(employeeId, ip, userAgent, _remember) {
        const sid = randomToken(32);
        const refreshToken = randomToken(48);
        await transaction(async (conn) => {
            const [result] = await conn.query(`INSERT INTO employee_sessions (employee_id, token_hash, user_agent, ip, device, expires_at)
         VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? DAY))`, [employeeId, sha256(sid), userAgent.slice(0, 250), ip.slice(0, 60), deviceFromUserAgent(userAgent), config.sessionTtlDays]);
            await conn.query('INSERT INTO session_refresh_tokens (token_hash, session_id, access_sid) VALUES (?, ?, ?)', [sha256(refreshToken), result.insertId, sid]);
            await conn.query('UPDATE employees SET last_login_at = NOW(3), failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [employeeId]);
        }, { retryDeadlocks: true });
        return { token: AuthService.accessToken(employeeId, sid), refreshToken };
    }
    static accessToken(employeeId, sid) {
        return jwt.sign({ sid, sub: String(employeeId), typ: 'session' }, config.jwtSecret, { expiresIn: '15m' });
    }
    static async refreshSession(raw) {
        if (!raw || raw.length > 256)
            throw ApiError.unauthorized();
        const result = await transaction(async (conn) => {
            const ref = await txQueryOne(conn, 'SELECT session_id FROM session_refresh_tokens WHERE token_hash = ?', [sha256(raw)]);
            if (!ref)
                return null;
            const session = await txQueryOne(conn, 'SELECT id, employee_id, expires_at, (revoked_at IS NULL AND expires_at > NOW(3)) AS valid FROM employee_sessions WHERE id = ? FOR UPDATE', [ref.session_id]);
            if (!session?.valid)
                return null;
            const old = await txQueryOne(conn, 'SELECT used_at, access_sid FROM session_refresh_tokens WHERE token_hash = ? FOR UPDATE', [sha256(raw)]);
            if (!old || old.used_at) {
                await conn.query("UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = 'refresh_token_reuse' WHERE id = ?", [session.id]);
                return null;
            }
            const employee = await txQueryOne(conn, 'SELECT status FROM employees WHERE id = ?', [session.employee_id]);
            if (employee?.status !== 'active')
                return null;
            const refreshToken = randomToken(48);
            await conn.query('UPDATE session_refresh_tokens SET used_at = NOW(3) WHERE token_hash = ?', [sha256(raw)]);
            await conn.query('INSERT INTO session_refresh_tokens (token_hash, session_id, access_sid) VALUES (?, ?, ?)', [sha256(refreshToken), session.id, old.access_sid]);
            return { token: AuthService.accessToken(session.employee_id, old.access_sid), refreshToken,
                expiresAt: new Date(session.expires_at.replace(' ', 'T') + 'Z').getTime() };
        }, { retryDeadlocks: true });
        if (!result)
            throw ApiError.unauthorized('Your session has expired. Please sign in again.');
        return result;
    }
    static async logoutRefresh(raw) {
        if (!raw)
            return;
        await execute(`UPDATE employee_sessions s JOIN session_refresh_tokens r ON r.session_id = s.id
      SET s.revoked_at = NOW(3), s.revoked_reason = 'logout' WHERE r.token_hash = ? AND s.revoked_at IS NULL`, [sha256(raw)]);
    }
    static async authenticateToken(token) {
        let payload;
        try {
            payload = jwt.verify(token, config.jwtSecret);
        }
        catch {
            return null;
        }
        if (!payload?.sid || !payload.sub || payload.typ !== 'session')
            return null;
        const session = await queryOne('SELECT id, employee_id FROM employee_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW(3)', [sha256(payload.sid)]);
        if (!session || Number(session.employee_id) !== Number(payload.sub))
            return null;
        const user = await AuthService.buildUser(Number(payload.sub), Number(session.id));
        if (!user || user.status !== 'active') {
            await execute('UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE id = ?', [
                'account_inactive',
                session.id,
            ]);
            return null;
        }
        // Touch presence at most once per minute to avoid write amplification.
        const lastTouch = AuthService.lastSeenCache.get(user.id) ?? 0;
        if (Date.now() - lastTouch > 60_000) {
            AuthService.lastSeenCache.set(user.id, Date.now());
            execute('UPDATE employee_sessions SET last_seen_at = NOW(3) WHERE id = ?', [session.id]).catch(() => undefined);
            execute('UPDATE employees SET last_seen_at = NOW(3) WHERE id = ?', [user.id]).catch(() => undefined);
        }
        return user;
    }
    static lastSeenCache = new Map();
    static async logout(token) {
        if (!token)
            return;
        try {
            const payload = jwt.verify(token, config.jwtSecret);
            if (payload?.sid) {
                await execute('UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL', ['logout', sha256(payload.sid)]);
            }
        }
        catch {
            /* expired token: nothing to revoke */
        }
    }
    static async sessions(employeeId) {
        return query(`SELECT id, device, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at
       FROM employee_sessions WHERE employee_id = ? ORDER BY created_at DESC LIMIT 40`, [employeeId]);
    }
    static async revokeSession(employeeId, sessionId, reason = 'user_revoked') {
        await execute('UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE id = ? AND employee_id = ? AND revoked_at IS NULL', [reason, sessionId, employeeId]);
    }
    static async revokeOtherSessions(employeeId, keepSessionId) {
        await execute('UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE employee_id = ? AND id <> ? AND revoked_at IS NULL', ['revoked_other_devices', employeeId, keepSessionId]);
    }
    static async loginHistory(employeeId, limit = 20) {
        return query(`SELECT id, identifier, success, ip, device, failure_reason, created_at
       FROM login_history WHERE employee_id = ? ORDER BY created_at DESC LIMIT ?`, [employeeId, limit]);
    }
    // ----------------------------- OTP -------------------------------------
    static async issueOtp(params) {
        const identifier = params.identifier.toLowerCase().slice(0, 190);
        const recent = await queryOne(`SELECT created_at FROM otp_verifications
       WHERE identifier = ? AND purpose = ? AND created_at > DATE_SUB(NOW(3), INTERVAL ? SECOND)
       ORDER BY id DESC LIMIT 1`, [identifier, params.purpose, config.otp.resendCooldownSeconds]);
        if (recent) {
            throw ApiError.tooMany('Please wait a minute before requesting another verification code.');
        }
        const count = await queryOne(`SELECT COUNT(*) AS total FROM otp_verifications
       WHERE identifier = ? AND created_at > DATE_SUB(NOW(3), INTERVAL 30 MINUTE)`, [identifier]);
        if (Number(count?.total ?? 0) >= OTP_WINDOW_MAX * 2) {
            throw ApiError.tooMany('Too many verification codes requested. Try again later.');
        }
        const code = generateOtp();
        await execute(`INSERT INTO otp_verifications (employee_id, identifier, channel, purpose, code_hash, expires_at, ip)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? MINUTE), ?)`, [
            params.employeeId ?? null,
            identifier,
            params.channel,
            params.purpose,
            hashOtp(identifier, code),
            config.otp.expiryMinutes,
            params.ip?.slice(0, 60) ?? null,
        ]);
        let delivered = false;
        if (params.channel === 'email') {
            delivered = await sendOtpEmail({
                to: params.recipient,
                name: params.name,
                code,
                purpose: params.purpose,
                expiresMinutes: config.otp.expiryMinutes,
            });
        }
        else {
            delivered = await sendSms(params.recipient, `${config.appName} ${params.purpose.replace(/_/g, ' ')} code: ${code}. Valid for ${config.otp.expiryMinutes} minutes.`);
        }
        if (!delivered)
            throw new ApiError(503, 'Verification delivery is unavailable. Contact your administrator.', 'delivery_unavailable');
        return { delivered: true };
    }
    static async consumeOtp(identifier, purpose, code) {
        const normalized = identifier.toLowerCase().slice(0, 190);
        const failure = await transaction(async (conn) => {
            const row = await txQueryOne(conn, `SELECT id, code_hash, attempts, (expires_at > NOW(3)) AS valid FROM otp_verifications
         WHERE identifier = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`, [normalized, purpose]);
            if (!row)
                return 'missing';
            if (Number(row.attempts) >= config.otp.maxAttempts)
                return 'attempts';
            if (!row.valid)
                return 'expired';
            if (hashOtp(normalized, code.trim()) !== row.code_hash) {
                await conn.query('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?', [row.id]);
                return 'incorrect';
            }
            await conn.query('UPDATE otp_verifications SET consumed_at = NOW(3) WHERE id = ?', [row.id]);
            return null;
        });
        if (failure === 'attempts')
            throw ApiError.tooMany('Too many incorrect attempts. Request a new verification code.');
        if (failure)
            throw ApiError.badRequest(failure === 'expired' ? 'Verification code expired. Request a new one.' : failure === 'incorrect' ? 'Incorrect verification code.' : 'No active verification code. Request a new one.');
    }
    // -------------------------- Registration --------------------------------
    static async register(input) {
        const allow = await queryOne("SELECT setting_value FROM system_settings WHERE setting_key = 'allow_self_registration'");
        if (allow?.setting_value === 'false') {
            throw ApiError.forbidden('Self registration is disabled. Contact your HR administrator.');
        }
        const issues = passwordIssues(input.password);
        if (issues.length > 0) {
            throw ApiError.badRequest(`Password must contain ${issues.join(', ')}.`);
        }
        const email = input.email.trim().toLowerCase();
        const mobile = input.mobile.trim();
        const duplicate = await queryOne('SELECT email, mobile FROM employees WHERE email = ? OR mobile = ? LIMIT 1', [email, mobile]);
        if (duplicate) {
            throw ApiError.conflict('An account already exists with this email or mobile number.');
        }
        const role = await queryOne("SELECT id FROM roles WHERE slug = 'employee' LIMIT 1");
        if (!role)
            throw new ApiError(500, 'Employee role is not configured');
        const department = await queryOne('SELECT id FROM departments WHERE id = ?', [input.departmentId]);
        if (!department)
            throw ApiError.badRequest('Select a valid department');
        if (input.managerId) {
            const manager = await queryOne("SELECT id FROM employees WHERE id = ? AND status = 'active'", [input.managerId]);
            if (!manager)
                throw ApiError.badRequest('Select a valid reporting manager');
        }
        const passwordHash = await hashPassword(input.password);
        const created = await transaction(async (conn) => {
            let code = input.employeeCode?.trim();
            if (code) {
                const exists = await conn.query('SELECT id FROM employees WHERE employee_code = ?', [code]);
                if (exists[0].length > 0)
                    throw ApiError.conflict('That employee ID is already in use.');
            }
            else {
                const seq = await nextSequence(conn, 'employee_code_seq');
                code = `EMP-${String(1000 + seq)}`;
            }
            const [result] = await conn.query(`INSERT INTO employees
          (employee_code, full_name, email, mobile, password_hash, role_id, department_id, designation_id, manager_id, location_id, employment_type, status, joining_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_verification', ?)`, [
                code,
                input.fullName.trim(),
                email,
                mobile,
                passwordHash,
                role.id,
                input.departmentId,
                input.designationId ?? null,
                input.managerId ?? null,
                input.locationId ?? null,
                input.employmentType ?? 'full_time',
                new Date().toISOString().slice(0, 10),
            ]);
            return { id: Number(result.insertId), code };
        });
        await recordAudit({
            actorId: created.id,
            action: 'employee.registered',
            entityType: 'employee',
            entityId: created.id,
            after: { email, departmentId: input.departmentId, designationId: input.designationId ?? null },
        });
        const emailOtp = await AuthService.issueOtp({
            identifier: email,
            channel: 'email',
            purpose: 'registration_email',
            employeeId: created.id,
            recipient: email,
            name: input.fullName,
        });
        const mobileOtp = await AuthService.issueOtp({
            identifier: mobile,
            channel: 'sms',
            purpose: 'registration_mobile',
            employeeId: created.id,
            recipient: mobile,
            name: input.fullName,
        });
        return {
            employeeId: created.id,
            employeeCode: created.code,
            devEmailCode: emailOtp.devCode,
            devMobileCode: mobileOtp.devCode,
            emailDelivered: emailOtp.delivered,
            mobileDelivered: mobileOtp.delivered,
        };
    }
    static async verifyRegistration(employeeId, emailCode, mobileCode) {
        const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [employeeId]);
        if (!employee)
            throw ApiError.notFound('Registration not found');
        if (employee.status !== 'pending_verification') {
            throw ApiError.badRequest('This registration is no longer awaiting verification.');
        }
        await AuthService.consumeOtp(employee.email, 'registration_email', emailCode);
        await AuthService.consumeOtp(employee.mobile, 'registration_mobile', mobileCode);
        await execute(`UPDATE employees SET email_verified_at = NOW(3), mobile_verified_at = NOW(3), status = 'pending_approval' WHERE id = ?`, [employeeId]);
        await recordAudit({
            actorId: employeeId,
            action: 'employee.verified',
            entityType: 'employee',
            entityId: employeeId,
            after: { status: 'pending_approval' },
        });
    }
    static async resendRegistrationOtp(employeeId, channel) {
        const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [employeeId]);
        if (!employee || employee.status !== 'pending_verification') {
            throw ApiError.badRequest('No pending registration for this account.');
        }
        const target = channel === 'email' ? employee.email : employee.mobile;
        return AuthService.issueOtp({
            identifier: target,
            channel,
            purpose: channel === 'email' ? 'registration_email' : 'registration_mobile',
            employeeId,
            recipient: target,
            name: employee.full_name,
        });
    }
    // -------------------------- Password flows ------------------------------
    static async changePassword(employeeId, currentPassword, newPassword) {
        const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [employeeId]);
        if (!employee)
            throw ApiError.notFound();
        if (!(await verifyPassword(currentPassword, employee.password_hash))) {
            throw ApiError.badRequest('Your current password is incorrect.');
        }
        const issues = passwordIssues(newPassword);
        if (issues.length > 0)
            throw ApiError.badRequest(`Password must contain ${issues.join(', ')}.`);
        if (currentPassword === newPassword)
            throw ApiError.badRequest('Choose a password different from your current one.');
        await execute('UPDATE employees SET password_hash = ?, must_change_password = 0 WHERE id = ?', [await hashPassword(newPassword), employeeId]);
        await execute("UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = 'password_changed' WHERE employee_id = ? AND revoked_at IS NULL", [employeeId]);
        await recordAudit({ actorId: employeeId, action: 'password.changed', entityType: 'employee', entityId: employeeId });
    }
    static async requestPasswordReset(identifierRaw, ip) {
        const identifier = normalizeIdentifier(identifierRaw);
        const employee = await queryOne('SELECT * FROM employees WHERE email = ? OR mobile = ? OR employee_code = ? LIMIT 1', [identifier.toLowerCase(), identifier, identifier]);
        // Do not disclose whether the account exists.
        if (!employee) {
            return { delivered: false };
        }
        const isEmail = employee.email.toLowerCase() === identifier.toLowerCase() || employee.employee_code === identifier;
        const target = isEmail ? employee.email : employee.mobile;
        return AuthService.issueOtp({
            identifier: target,
            channel: isEmail ? 'email' : 'sms',
            purpose: 'password_reset',
            employeeId: Number(employee.id),
            recipient: target,
            name: employee.full_name,
            ip,
        });
    }
    static async resetPassword(identifierRaw, code, newPassword) {
        const identifier = normalizeIdentifier(identifierRaw);
        const employee = await queryOne('SELECT * FROM employees WHERE email = ? OR mobile = ? OR employee_code = ? LIMIT 1', [identifier.toLowerCase(), identifier, identifier]);
        if (!employee)
            throw ApiError.badRequest('Unable to reset this account with the provided details.');
        const isEmail = employee.email.toLowerCase() === identifier.toLowerCase() || employee.employee_code === identifier;
        await AuthService.consumeOtp(isEmail ? employee.email : employee.mobile, 'password_reset', code);
        const issues = passwordIssues(newPassword);
        if (issues.length > 0)
            throw ApiError.badRequest(`Password must contain ${issues.join(', ')}.`);
        await execute('UPDATE employees SET password_hash = ?, must_change_password = 0 WHERE id = ?', [
            await hashPassword(newPassword),
            employee.id,
        ]);
        await execute('UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE employee_id = ? AND revoked_at IS NULL', ['password_reset', employee.id]);
        await recordAudit({
            actorId: Number(employee.id),
            action: 'password.reset',
            entityType: 'employee',
            entityId: Number(employee.id),
        });
    }
}
//# sourceMappingURL=AuthService.js.map