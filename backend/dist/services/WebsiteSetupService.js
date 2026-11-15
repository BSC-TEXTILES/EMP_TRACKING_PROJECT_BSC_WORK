import mysql from 'mysql2/promise';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { config, needsSetup } from '../config.js';
import { configStore } from '../lib/configStore.js';
import { ApiError } from '../lib/http.js';
import { hashPassword, passwordIssues, safeEqual } from '../lib/crypto.js';
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from '../lib/rbac.js';
import { SETTING_DEFAULTS } from '../lib/audit.js';
import { runMigrations } from '../db/migrate.js';
import { KpiService } from './KpiService.js';
import { reloadPool } from '../db/index.js';
export const smtpInput = z.object({
    host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().min(1).max(190),
    password: z.string().min(1).max(1000),
    fromName: z.string().min(1).max(120).regex(/^[^\r\n<>]+$/),
    fromEmail: z.string().email().max(190),
    replyTo: z.string().email().max(190),
}).strict();
export const setupInput = z.object({
    appName: z.string().min(2).max(120),
    database: z.object({
        host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/),
        port: z.number().int().min(1).max(65535),
        user: z.string().min(1).max(128), password: z.string().min(1).max(1000),
        database: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/),
    }).strict(),
    smtp: smtpInput,
    admin: z.object({
        name: z.string().min(2).max(160), email: z.string().email().max(190),
        mobile: z.string().min(7).max(20), password: z.string().min(10).max(72),
        department: z.string().min(2).max(120), location: z.string().min(2).max(120),
    }).strict(),
}).strict();
export function smtpTransport(input) {
    return nodemailer.createTransport({ host: input.host, port: input.port, secure: input.secure,
        requireTLS: !input.secure, auth: { user: input.user, pass: input.password },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
        disableFileAccess: true, disableUrlAccess: true });
}
export function storedSmtp(input) {
    return { host: input.host, port: input.port, secure: input.secure, user: input.user, password: input.password,
        from: `${input.fromName} <${input.fromEmail}>`, replyTo: input.replyTo };
}
let installing = false;
let onCompleted;
export function onSetupCompleted(callback) { onCompleted = callback; }
export function authorizeSetup(code) {
    if (!needsSetup())
        throw ApiError.notFound();
    if (typeof code !== 'string' || code.length > 200 || !safeEqual(code, configStore.setupCode()))
        throw ApiError.forbidden('Invalid installation code.');
}
export async function recoverPendingInstallation() {
    const saved = configStore.read();
    if (!saved.installationPending || !saved.db)
        return false;
    const connection = await mysql.createConnection({ ...saved.db, connectTimeout: 10000 });
    let committed = false;
    try {
        const [rows] = await connection.query("SELECT COUNT(*) AS count FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.employee_code = 'EMP-0001' AND r.slug = 'super_admin'");
        committed = Number(rows[0].count) > 0;
    }
    finally {
        await connection.end();
    }
    if (!committed) {
        configStore.write({ ...saved, setupComplete: false, installationPending: false });
        return false;
    }
    Object.assign(config.db, saved.db);
    Object.assign(config.smtp, saved.smtp);
    config.appName = saved.appName || config.appName;
    await reloadPool();
    await KpiService.ensureTemplate();
    configStore.write({ ...saved, setupComplete: true, installationPending: false });
    configStore.removeSetupCode();
    return true;
}
export async function installWebsite(input) {
    if (installing)
        throw ApiError.conflict('Installation is already in progress.');
    if (!needsSetup())
        throw ApiError.notFound();
    const issues = passwordIssues(input.admin.password);
    if (issues.length)
        throw ApiError.badRequest(`Administrator password must contain ${issues.join(', ')}.`);
    installing = true;
    try {
        if (await recoverPendingInstallation()) {
            onCompleted?.();
            return;
        }
        const db = { ...input.database, connectionLimit: config.db.connectionLimit };
        let probe;
        try {
            probe = await mysql.createConnection({ ...input.database, connectTimeout: 10000 });
            const [tables] = await probe.query('SHOW TABLES');
            // Never attach an existing sample or live database through an unauthenticated setup flow.
            if (tables.some(row => Object.values(row).includes('employees'))) {
                const [rows] = await probe.query('SELECT COUNT(*) AS count FROM employees');
                if (Number(rows[0].count))
                    throw ApiError.conflict('This database already contains employees. Choose an empty database; existing data will not be deleted.');
            }
        }
        catch (error) {
            if (error instanceof ApiError)
                throw error;
            throw ApiError.badRequest('Cannot connect to the database. Check the host, database name, credentials and remote-access permissions.');
        }
        finally {
            await probe?.end();
        }
        const transport = smtpTransport(input.smtp);
        try {
            await transport.verify();
            const result = await transport.sendMail({ from: { name: input.smtp.fromName, address: input.smtp.fromEmail },
                to: input.admin.email, subject: 'Workforce installation email test', text: 'Your email server accepted the Workforce installation test. No password or verification code is included.' });
            if (!result.accepted?.length)
                throw new Error('Recipient rejected');
        }
        catch {
            throw ApiError.badRequest('SMTP verification or test email failed. Check the settings and recipient address.');
        }
        finally {
            transport.close();
        }
        await runMigrations(db, false);
        const connection = await mysql.createConnection({ ...input.database, connectTimeout: 10000 });
        try {
            await connection.beginTransaction();
            for (const permission of PERMISSION_DEFINITIONS) {
                await connection.query('INSERT IGNORE INTO permissions (code, module, action, description) VALUES (?, ?, ?, ?)', [permission.code, permission.module, permission.action, permission.description]);
            }
            for (const role of ROLE_DEFINITIONS) {
                await connection.query('INSERT IGNORE INTO roles (name, slug, category, level, description, is_system) VALUES (?, ?, ?, ?, ?, 1)', [role.name, role.slug, role.category, role.level, role.description]);
                for (const code of role.permissions)
                    await connection.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ? WHERE r.slug = ?`, [code, role.slug]);
            }
            for (const [key, value] of Object.entries({ ...SETTING_DEFAULTS, company_name: input.appName, allow_self_registration: 'false' })) {
                await connection.query('INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
            }
            const [department] = await connection.query('INSERT INTO departments (code, name) VALUES (?, ?)', ['ADMIN', input.admin.department]);
            const [location] = await connection.query('INSERT INTO locations (code, name) VALUES (?, ?)', ['MAIN', input.admin.location]);
            await connection.query(`INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, location_id, status)
        SELECT 'EMP-0001', ?, ?, ?, ?, id, ?, ?, 'active' FROM roles WHERE slug = 'super_admin'`, [input.admin.name, input.admin.email.toLowerCase(), input.admin.mobile, await hashPassword(input.admin.password), department.insertId, location.insertId]);
            // Persist a pending marker so restart can resolve an ambiguous transaction outcome.
            const previous = configStore.read();
            configStore.write({ ...previous, setupComplete: true, installationPending: true, appName: input.appName, db, smtp: storedSmtp(input.smtp) });
            // Retain the pending record on ambiguous commit failure; recovery checks MySQL.
            await connection.commit();
        }
        catch (error) {
            await connection.rollback();
            throw error;
        }
        finally {
            await connection.end();
        }
        Object.assign(config.db, db);
        Object.assign(config.smtp, storedSmtp(input.smtp));
        config.appName = input.appName;
        await reloadPool();
        await KpiService.ensureTemplate();
        configStore.write({ ...configStore.read(), installationPending: false });
        configStore.removeSetupCode();
        onCompleted?.();
    }
    finally {
        installing = false;
    }
}
//# sourceMappingURL=WebsiteSetupService.js.map