import crypto from 'node:crypto';
import { config } from '../config.js';
import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { configStore } from '../lib/configStore.js';
import { sha256, verifyPassword } from '../lib/crypto.js';
import { ApiError } from '../lib/http.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { NotificationService } from './NotificationService.js';
const RECOVERY_CODE_COUNT = 10;
const MAX_FAILURES_PER_15_MIN = 10;
function recoveryHash(employeeId, code) {
    return sha256(`mfa-recovery|${employeeId}|${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
}
function newRecoveryCode() {
    // 10 characters from an unambiguous alphabet, shown as XXXXX-XXXXX.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(10);
    const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
export class MfaService {
    static async row(employeeId) {
        return queryOne('SELECT * FROM employee_mfa WHERE employee_id = ?', [employeeId]);
    }
    /** Whether MFA is mandatory for this employee (their role or an individual policy). */
    static async isRequired(employeeId) {
        const row = await queryOne(`SELECT e.mfa_required AS employee_required, COALESCE(r.mfa_required, 0) AS role_required
       FROM employees e LEFT JOIN roles r ON r.id = e.role_id WHERE e.id = ?`, [employeeId]);
        return Boolean(row && (Number(row.employee_required) || Number(row.role_required)));
    }
    /** Methods available at login. */
    static async methodsFor(employeeId) {
        const [row, required, recovery] = await Promise.all([
            MfaService.row(employeeId),
            MfaService.isRequired(employeeId),
            queryOne('SELECT COUNT(*) AS total FROM mfa_recovery_codes WHERE employee_id = ? AND used_at IS NULL', [employeeId]),
        ]);
        return {
            email: Boolean(row?.email_enabled),
            totp: Boolean(row?.totp_enabled && row.totp_secret_enc),
            required,
            preferred: row?.preferred_method ?? 'email',
            recovery: Number(recovery?.total ?? 0) > 0,
        };
    }
    static async status(user) {
        const [row, methods, remaining] = await Promise.all([
            MfaService.row(user.id),
            MfaService.methodsFor(user.id),
            queryOne('SELECT COUNT(*) AS total FROM mfa_recovery_codes WHERE employee_id = ? AND used_at IS NULL', [user.id]),
        ]);
        return {
            enabled: methods.email || methods.totp,
            emailEnabled: methods.email,
            totpEnabled: methods.totp,
            preferredMethod: methods.preferred,
            required: methods.required,
            recoveryCodesRemaining: Number(remaining?.total ?? 0),
            enrolledAt: row?.enrolled_at ?? null,
        };
    }
    static async syncFlag(employeeId) {
        await execute(`UPDATE employees e LEFT JOIN employee_mfa m ON m.employee_id = e.id
       SET e.mfa_enabled = IF(COALESCE(m.email_enabled, 0) = 1 OR COALESCE(m.totp_enabled, 0) = 1, 1, 0) WHERE e.id = ?`, [employeeId]);
    }
    static async assertPassword(employeeId, password) {
        const row = await queryOne('SELECT password_hash FROM employees WHERE id = ?', [employeeId]);
        if (!row || !password || !(await verifyPassword(password, row.password_hash))) {
            throw ApiError.unauthorized('Your current password is incorrect.');
        }
    }
    /** Throttles repeated wrong second-factor codes per employee. */
    static async assertNotThrottled(employeeId) {
        const failures = await queryOne('SELECT COUNT(*) AS total FROM mfa_challenge_attempts WHERE employee_id = ? AND success = 0 AND created_at > DATE_SUB(NOW(3), INTERVAL 15 MINUTE)', [employeeId]);
        if (Number(failures?.total ?? 0) >= MAX_FAILURES_PER_15_MIN) {
            throw ApiError.tooMany('Too many incorrect verification codes. Wait 15 minutes and try again.');
        }
    }
    static async recordAttempt(employeeId, method, success, ip) {
        await execute('INSERT INTO mfa_challenge_attempts (employee_id, method, success, ip) VALUES (?, ?, ?, ?)', [employeeId, method, success ? 1 : 0, ip?.slice(0, 60) ?? null]);
    }
    // ----------------------------- Verification -------------------------------
    /** Verifies a TOTP code for an enrolled employee; rejects replays of an already-used time step. */
    static async verifyTotpCode(employeeId, code) {
        const row = await MfaService.row(employeeId);
        if (!row?.totp_enabled || !row.totp_secret_enc)
            return false;
        const step = verifyTotp(configStore.decryptField(row.totp_secret_enc), code);
        if (step === null)
            return false;
        // Atomic: only one request can consume a given time step.
        const updated = await execute('UPDATE employee_mfa SET totp_last_step = ? WHERE employee_id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, employeeId, step]);
        return updated.affectedRows === 1;
    }
    /** Consumes a single-use recovery code. */
    static async useRecoveryCode(employeeId, code) {
        const result = await execute('UPDATE mfa_recovery_codes SET used_at = NOW(3) WHERE employee_id = ? AND code_hash = ? AND used_at IS NULL', [employeeId, recoveryHash(employeeId, code)]);
        if (result.affectedRows !== 1)
            return false;
        const remaining = await queryOne('SELECT COUNT(*) AS total FROM mfa_recovery_codes WHERE employee_id = ? AND used_at IS NULL', [employeeId]);
        await recordAudit({ actorId: employeeId, action: 'mfa.recovery_code_used', entityType: 'employee', entityId: employeeId, after: { remaining: Number(remaining?.total ?? 0) } });
        if (Number(remaining?.total ?? 0) <= 2) {
            await NotificationService.notify({
                employeeIds: [employeeId], type: 'security', priority: 'high',
                title: 'Few MFA recovery codes left',
                body: `You have ${remaining?.total ?? 0} recovery code(s) left. Generate new codes from your profile security settings.`,
                link: '/profile?tab=security',
            });
        }
        return true;
    }
    // ------------------------------ Enrolment ---------------------------------
    static async startTotpEnrollment(user, password) {
        await MfaService.assertPassword(user.id, password);
        const secret = generateTotpSecret();
        await execute(`INSERT INTO employee_mfa (employee_id, totp_pending_enc, totp_pending_expires_at) VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL 15 MINUTE))
       ON DUPLICATE KEY UPDATE totp_pending_enc = VALUES(totp_pending_enc), totp_pending_expires_at = VALUES(totp_pending_expires_at)`, [user.id, configStore.encryptField(secret)]);
        return { secret, otpauthUrl: otpauthUrl(secret, user.email, config.appName), expiresInMinutes: 15 };
    }
    static async confirmTotpEnrollment(user, code, ip) {
        await MfaService.assertNotThrottled(user.id);
        const row = await queryOne('SELECT *, (totp_pending_expires_at > NOW(3)) AS pending_valid FROM employee_mfa WHERE employee_id = ?', [user.id]);
        if (!row?.totp_pending_enc || !Number(row.pending_valid))
            throw ApiError.badRequest('Authenticator setup expired. Start again.');
        const secret = configStore.decryptField(row.totp_pending_enc);
        const step = verifyTotp(secret, code);
        if (step === null) {
            await MfaService.recordAttempt(user.id, 'totp', false, ip);
            throw ApiError.badRequest('That code does not match. Check the time on your phone and try again.');
        }
        await MfaService.recordAttempt(user.id, 'totp', true, ip);
        await execute(`UPDATE employee_mfa SET totp_enabled = 1, totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_pending_expires_at = NULL,
              totp_last_step = ?, preferred_method = 'totp', enrolled_at = COALESCE(enrolled_at, NOW(3)) WHERE employee_id = ?`, [step, user.id]);
        await MfaService.syncFlag(user.id);
        const codes = await MfaService.ensureRecoveryCodes(user.id);
        await recordAudit({ actorId: user.id, action: 'mfa.totp_enrolled', entityType: 'employee', entityId: user.id, ip });
        return { enabled: true, recoveryCodes: codes };
    }
    /** Email OTP enrolment: proves the employee controls the mailbox before enabling. */
    static async startEmailEnrollment(user, password, ip) {
        await MfaService.assertPassword(user.id, password);
        const { AuthService } = await import('./AuthService.js');
        return AuthService.issueOtp({ identifier: user.email, channel: 'email', purpose: 'mfa_enroll', employeeId: user.id, recipient: user.email, name: user.fullName, ip });
    }
    static async confirmEmailEnrollment(user, code, ip) {
        const { AuthService } = await import('./AuthService.js');
        await AuthService.consumeOtp(user.email, 'mfa_enroll', code);
        await execute(`INSERT INTO employee_mfa (employee_id, email_enabled, preferred_method, enrolled_at) VALUES (?, 1, 'email', NOW(3))
       ON DUPLICATE KEY UPDATE email_enabled = 1, enrolled_at = COALESCE(enrolled_at, NOW(3)),
         preferred_method = IF(totp_enabled = 1, preferred_method, 'email')`, [user.id]);
        await MfaService.syncFlag(user.id);
        const codes = await MfaService.ensureRecoveryCodes(user.id);
        await recordAudit({ actorId: user.id, action: 'mfa.email_enrolled', entityType: 'employee', entityId: user.id, ip });
        return { enabled: true, recoveryCodes: codes };
    }
    /** Creates recovery codes only if none are unused; returns the plain codes once (or [] if they already exist). */
    static async ensureRecoveryCodes(employeeId) {
        const existing = await queryOne('SELECT COUNT(*) AS total FROM mfa_recovery_codes WHERE employee_id = ? AND used_at IS NULL', [employeeId]);
        if (Number(existing?.total ?? 0) > 0)
            return [];
        return MfaService.writeRecoveryCodes(employeeId);
    }
    static async writeRecoveryCodes(employeeId) {
        const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
        await transaction(async (conn) => {
            await conn.query('DELETE FROM mfa_recovery_codes WHERE employee_id = ?', [employeeId]);
            for (const code of codes) {
                await conn.query('INSERT INTO mfa_recovery_codes (employee_id, code_hash) VALUES (?, ?)', [employeeId, recoveryHash(employeeId, code)]);
            }
        });
        return codes;
    }
    static async regenerateRecoveryCodes(user, password, ip) {
        await MfaService.assertPassword(user.id, password);
        const methods = await MfaService.methodsFor(user.id);
        if (!methods.email && !methods.totp)
            throw ApiError.badRequest('Turn on MFA before generating recovery codes.');
        const codes = await MfaService.writeRecoveryCodes(user.id);
        await recordAudit({ actorId: user.id, action: 'mfa.recovery_codes_regenerated', entityType: 'employee', entityId: user.id, ip });
        return { recoveryCodes: codes };
    }
    static async setPreferred(user, method) {
        const methods = await MfaService.methodsFor(user.id);
        if (!methods[method])
            throw ApiError.badRequest('Enable that method first.');
        await execute('UPDATE employee_mfa SET preferred_method = ? WHERE employee_id = ?', [method, user.id]);
    }
    /** Disables one method after re-verifying the password and a current second factor. */
    static async disable(user, input, ip) {
        await MfaService.assertPassword(user.id, input.password);
        await MfaService.assertNotThrottled(user.id);
        const methods = await MfaService.methodsFor(user.id);
        if (!methods[input.method])
            throw ApiError.badRequest('That method is not enabled.');
        let verified = false;
        if (input.codeMethod === 'totp')
            verified = await MfaService.verifyTotpCode(user.id, input.code);
        else if (input.codeMethod === 'recovery')
            verified = await MfaService.useRecoveryCode(user.id, input.code);
        else {
            const { AuthService } = await import('./AuthService.js');
            try {
                await AuthService.consumeOtp(user.email, 'mfa_disable', input.code);
                verified = true;
            }
            catch {
                verified = false;
            }
        }
        await MfaService.recordAttempt(user.id, input.codeMethod, verified, ip);
        if (!verified)
            throw ApiError.badRequest('The verification code is incorrect or expired.');
        const remainingAfter = (input.method === 'email' ? methods.totp : methods.email);
        if (methods.required && !remainingAfter)
            throw ApiError.forbidden('Your organisation requires MFA for this account. Enable another method before turning this one off.');
        if (input.method === 'totp') {
            await execute('UPDATE employee_mfa SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL, preferred_method = \'email\' WHERE employee_id = ?', [user.id]);
        }
        else {
            await execute("UPDATE employee_mfa SET email_enabled = 0, preferred_method = 'totp' WHERE employee_id = ?", [user.id]);
        }
        if (!remainingAfter)
            await execute('DELETE FROM mfa_recovery_codes WHERE employee_id = ?', [user.id]);
        await MfaService.syncFlag(user.id);
        await recordAudit({ actorId: user.id, action: `mfa.${input.method}_disabled`, entityType: 'employee', entityId: user.id, ip });
        return MfaService.status(user);
    }
    /** Sends an email code used to confirm disabling MFA. */
    static async sendDisableCode(user, ip) {
        const { AuthService } = await import('./AuthService.js');
        return AuthService.issueOtp({ identifier: user.email, channel: 'email', purpose: 'mfa_disable', employeeId: user.id, recipient: user.email, name: user.fullName, ip });
    }
    // ---------------------------- Administration ------------------------------
    /** Audited administrator reset (lost phone, lost codes). Signs the employee out everywhere. */
    static async adminReset(actor, employeeId, reason, ip) {
        if (!actor.permissions.includes('mfa.manage'))
            throw ApiError.forbidden('You cannot reset MFA.');
        if (actor.id === employeeId)
            throw ApiError.forbidden('Another administrator must reset your own MFA.');
        if (reason.trim().length < 10)
            throw ApiError.badRequest('Record why the reset is needed (identity check performed, ticket number, …).');
        const target = await queryOne('SELECT e.id, r.level AS role_level FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?', [employeeId]);
        if (!target)
            throw ApiError.notFound('Employee not found');
        if (Number(target.role_level) > actor.roleLevel)
            throw ApiError.forbidden('You cannot reset MFA for a more senior role.');
        await transaction(async (conn) => {
            await conn.query(`UPDATE employee_mfa SET email_enabled = 0, totp_enabled = 0, totp_secret_enc = NULL, totp_pending_enc = NULL,
                totp_last_step = NULL, reset_by = ?, reset_at = NOW(3) WHERE employee_id = ?`, [actor.id, employeeId]);
            await conn.query('DELETE FROM mfa_recovery_codes WHERE employee_id = ?', [employeeId]);
            await conn.query('UPDATE employees SET mfa_enabled = 0 WHERE id = ?', [employeeId]);
            await conn.query("UPDATE employee_sessions SET revoked_at = NOW(3), revoked_reason = 'mfa_reset' WHERE employee_id = ? AND revoked_at IS NULL", [employeeId]);
        });
        await recordAudit({ actorId: actor.id, action: 'mfa.admin_reset', entityType: 'employee', entityId: employeeId, after: { reason: reason.trim().slice(0, 300) }, ip });
        await NotificationService.notify({
            employeeIds: [employeeId], type: 'security', priority: 'high',
            title: 'Your MFA was reset by an administrator',
            body: 'Sign in again and set up multi-factor authentication. If you did not request this, contact IT immediately.',
            link: '/profile?tab=security', actorId: actor.id,
        });
    }
    static async setRoleRequirement(actor, roleId, required, ip) {
        if (!actor.permissions.includes('mfa.manage'))
            throw ApiError.forbidden('You cannot change MFA policy.');
        const result = await execute('UPDATE roles SET mfa_required = ? WHERE id = ?', [required ? 1 : 0, roleId]);
        if (!result.affectedRows)
            throw ApiError.notFound('Role not found');
        await recordAudit({ actorId: actor.id, action: 'mfa.role_policy_changed', entityType: 'role', entityId: roleId, after: { required }, ip });
    }
    static async setEmployeeRequirement(actor, employeeId, required, ip) {
        if (!actor.permissions.includes('mfa.manage'))
            throw ApiError.forbidden('You cannot change MFA policy.');
        const result = await execute('UPDATE employees SET mfa_required = ? WHERE id = ?', [required ? 1 : 0, employeeId]);
        if (!result.affectedRows)
            throw ApiError.notFound('Employee not found');
        await recordAudit({ actorId: actor.id, action: 'mfa.employee_policy_changed', entityType: 'employee', entityId: employeeId, after: { required }, ip });
    }
    static async policyOverview(actor) {
        if (!actor.permissions.includes('mfa.manage'))
            throw ApiError.forbidden('You cannot view MFA policy.');
        const roles = await query(`SELECT r.id, r.name, r.slug, r.mfa_required,
              (SELECT COUNT(*) FROM employees e WHERE e.role_id = r.id AND e.status = 'active') AS employees,
              (SELECT COUNT(*) FROM employees e WHERE e.role_id = r.id AND e.status = 'active' AND e.mfa_enabled = 1) AS enrolled
       FROM roles r ORDER BY r.level DESC`);
        return roles.map((row) => ({
            id: Number(row.id), name: row.name, slug: row.slug, required: Boolean(row.mfa_required),
            employees: Number(row.employees), enrolled: Number(row.enrolled),
        }));
    }
}
//# sourceMappingURL=MfaService.js.map