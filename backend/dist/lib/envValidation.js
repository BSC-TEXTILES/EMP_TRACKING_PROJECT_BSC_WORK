import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
function checkDatabase() {
    const checks = [];
    const missing = [!config.db.host && 'DB_HOST', !config.db.database && 'DB_NAME', !config.db.user && 'DB_USER'].filter(Boolean);
    checks.push({
        key: 'database',
        label: 'Database',
        status: missing.length ? 'error' : 'ok',
        message: missing.length ? `Missing database settings: ${missing.join(', ')}` : `MySQL target ${config.db.database} configured`,
    });
    if (config.isProd && !config.db.password) {
        checks.push({ key: 'database.password', label: 'Database credentials', status: 'warn', message: 'No database password supplied (socket or IAM authentication assumed)' });
    }
    return checks;
}
function checkJwt() {
    const weak = config.jwtSecret.length < 32 || config.jwtSecret.includes('development-only');
    return [
        {
            key: 'jwt',
            label: 'JWT signing',
            status: config.isProd && weak ? 'error' : weak ? 'warn' : 'ok',
            message: weak ? 'JWT secret is weak; generate at least 32 random characters' : 'Access/refresh signing configured',
        },
    ];
}
function checkSmtp() {
    if (!config.smtp.configured) {
        return [
            {
                key: 'smtp',
                label: 'Email delivery',
                status: config.isProd ? 'error' : 'warn',
                message: 'SMTP is not configured; verification codes will not be emailed',
            },
        ];
    }
    const checks = [];
    const fromLooksValid = /<[^<>\s]+@[^<>\s]+>$/.test(config.smtp.from) || /^[^@\s]+@[^@\s]+$/.test(config.smtp.from);
    checks.push({
        key: 'smtp',
        label: 'Email delivery',
        status: fromLooksValid ? 'ok' : 'warn',
        message: fromLooksValid ? `SMTP host ${config.smtp.host} configured with sender identity` : 'Sender address could not be parsed; set SMTP_FROM_NAME and SMTP_FROM_EMAIL',
    });
    if (config.smtp.configured && !config.smtp.user) {
        checks.push({ key: 'smtp.auth', label: 'SMTP authentication', status: 'warn', message: 'No SMTP user supplied; only use this for trusted relays' });
    }
    return checks;
}
function checkRedis() {
    if (!config.redisUrl) {
        return [{ key: 'redis', label: 'Redis', status: 'warn', message: 'Redis is not configured; single-instance scheduler and in-memory rate limits are used' }];
    }
    let valid = false;
    try {
        valid = /^rediss?:$/.test(new URL(config.redisUrl).protocol);
    }
    catch {
        valid = false;
    }
    return [{ key: 'redis', label: 'Redis', status: valid ? 'ok' : 'error', message: valid ? 'Redis URL is valid' : 'REDIS_URL must start with redis:// or rediss://' }];
}
function checkStorage() {
    try {
        const target = path.isAbsolute(config.uploadDir) ? config.uploadDir : path.resolve(process.cwd(), config.uploadDir);
        fs.mkdirSync(target, { recursive: true });
        fs.accessSync(target, fs.constants.W_OK);
        return [{ key: 'storage', label: 'File storage', status: 'ok', message: `Upload directory is writable (${config.uploadDir})` }];
    }
    catch {
        return [{ key: 'storage', label: 'File storage', status: 'error', message: `Upload directory is not writable: ${config.uploadDir}` }];
    }
}
function checkUrls() {
    const checks = [];
    checks.push({
        key: 'app.url',
        label: 'Application URL',
        status: isHttpUrl(config.appUrl) && (!config.isProd || config.appUrl.startsWith('https://')) ? 'ok' : 'error',
        message: isHttpUrl(config.appUrl) ? `Public URL configured (${config.appUrl})` : 'APP_URL must be an absolute http(s) URL',
    });
    const origins = config.appOrigin.split(',').map((value) => value.trim()).filter(Boolean);
    const invalidOrigin = origins.find((origin) => !isHttpUrl(origin));
    const localhostInProd = config.isProd && origins.some((origin) => /localhost|127\.0\.0\.1/.test(origin));
    checks.push({
        key: 'app.origin',
        label: 'Allowed origins',
        status: invalidOrigin || localhostInProd ? 'error' : 'ok',
        message: invalidOrigin
            ? 'APP_ORIGIN contains an invalid URL'
            : localhostInProd
                ? 'APP_ORIGIN still points at localhost in production'
                : `${origins.length} origin(s) allowed`,
    });
    if (config.websocketUrl) {
        const valid = /^wss?:/.test(config.websocketUrl);
        checks.push({
            key: 'websocket',
            label: 'WebSocket',
            status: valid ? 'ok' : 'error',
            message: valid ? 'Explicit WebSocket endpoint configured' : 'WEBSOCKET_URL must start with ws:// or wss://',
        });
    }
    else {
        checks.push({ key: 'websocket', label: 'WebSocket', status: 'ok', message: 'Same-origin Socket.IO endpoint (recommended)' });
    }
    return checks;
}
function checkSecurity() {
    const checks = [];
    if (config.isProd) {
        checks.push({
            key: 'security.test-login',
            label: 'Test login',
            status: process.env.TEST_LOGIN_ENABLED === 'true' ? 'error' : 'ok',
            message: process.env.TEST_LOGIN_ENABLED === 'true' ? 'Test login must never be enabled in production' : 'Development login is disabled in production',
        });
    }
    else {
        checks.push({
            key: 'security.test-login',
            label: 'Test login',
            status: 'ok',
            message: 'Development login available with seeded demo accounts only',
        });
    }
    return checks;
}
export function validateEnvironment() {
    const checks = [...checkDatabase(), ...checkJwt(), ...checkSmtp(), ...checkRedis(), ...checkStorage(), ...checkUrls(), ...checkSecurity()];
    const errors = checks.filter((check) => check.status === 'error').length;
    const warnings = checks.filter((check) => check.status === 'warn').length;
    return { environment: config.env, ok: errors === 0, errors, warnings, checks };
}
/** Logs a compact, secret-free summary at boot. */
export function logEnvironmentReport(report) {
    console.log(`  Config: ${report.checks.length - report.errors - report.warnings} ok · ${report.warnings} warning(s) · ${report.errors} error(s)`);
    for (const check of report.checks) {
        if (check.status === 'ok')
            continue;
        console.log(`   [${check.status}] ${check.label}: ${check.message}`);
    }
}
//# sourceMappingURL=envValidation.js.map