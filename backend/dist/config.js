import dotenv from 'dotenv';
import { configStore } from './lib/configStore.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const isProdEnv = process.env.NODE_ENV === 'production';
// Load order matters: dotenv never overrides an existing value, so the most
// specific file wins. Environment-specific files sit at the workspace root and
// are git-ignored; backend/.env remains supported for existing installations.
// A production host has no .env.local, so .env.production is selected even when
// NODE_ENV is only defined inside that file.
const rootDir = path.resolve(here, '../..');
const productionFile = path.join(rootDir, '.env.production');
const localFile = path.join(rootDir, '.env.local');
// Primary environment file:
if (process.env.NODE_ENV === 'production') {
    if (fs.existsSync(productionFile))
        dotenv.config({ path: productionFile });
}
else {
    if (fs.existsSync(localFile))
        dotenv.config({ path: localFile });
    if (fs.existsSync(path.join(rootDir, '.env.development'))) {
        dotenv.config({ path: path.join(rootDir, '.env.development') });
    }
}
// Fallback environment files (for values not yet set):
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.join(rootDir, '.env') });
if (fs.existsSync(productionFile))
    dotenv.config({ path: productionFile });
/** Parses mysql://user:pass@host:port/database when DATABASE_URL is provided. */
function parseDatabaseUrl(raw) {
    if (!raw)
        return null;
    try {
        const url = new URL(raw);
        if (!/^mysql:/.test(url.protocol))
            return null;
        return {
            host: url.hostname || '127.0.0.1',
            port: url.port ? Number(url.port) : 3306,
            user: decodeURIComponent(url.username || 'root'),
            password: decodeURIComponent(url.password || ''),
            database: decodeURIComponent(url.pathname.replace(/^\//, '') || 'emp_tracking'),
        };
    }
    catch {
        console.warn('[config] DATABASE_URL is not a valid mysql:// URL; falling back to DB_* variables');
        return null;
    }
}
/** Builds the RFC-style From header from the granular sender variables. */
function senderHeader() {
    const name = process.env.SMTP_FROM_NAME?.trim();
    const email = process.env.SMTP_FROM_EMAIL?.trim();
    if (name && email)
        return `${name} <${email}>`;
    if (email)
        return email;
    return process.env.SMTP_FROM ?? 'Workforce <no-reply@example.com>';
}
function required(name, fallback) {
    const value = process.env[name] ?? fallback;
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function int(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    // Ignore ambient `PORT=0` style values injected by tooling; 0 is never a
    // meaningful fixed port for this service.
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const isProd = process.env.NODE_ENV === 'production';
// Ordinary tests must not pick up website-managed production credentials.
const websiteSettings = process.env.NODE_ENV === 'test' && !process.env.WORKFORCE_CONFIG_DIR ? {} : configStore.read();
const webSetupEnabled = process.env.WEB_SETUP_ENABLED === 'true';
const dbUrl = parseDatabaseUrl(process.env.DATABASE_URL);
const appUrl = (process.env.APP_URL ?? process.env.FRONTEND_URL ?? process.env.APP_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
const configuredOrigins = (process.env.APP_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
if (appUrl && !configuredOrigins.includes(appUrl))
    configuredOrigins.push(appUrl);
if (process.env.FRONTEND_URL) {
    const feUrl = process.env.FRONTEND_URL.trim().replace(/\/+$/, '');
    if (feUrl && !configuredOrigins.includes(feUrl))
        configuredOrigins.push(feUrl);
}
export const config = {
    env: process.env.NODE_ENV ?? 'development',
    isProd,
    isTest: process.env.NODE_ENV === 'test',
    port: int('PORT', 4000),
    appOrigin: configuredOrigins.join(',') || appUrl,
    appUrl,
    backendUrl: (process.env.BACKEND_URL ?? `http://localhost:${int('PORT', 4000)}`).replace(/\/+$/, ''),
    appName: websiteSettings.appName ?? process.env.APP_NAME ?? 'Workforce',
    timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
    logLevel: process.env.LOG_LEVEL ?? (isProdEnv ? 'info' : 'debug'),
    db: {
        host: websiteSettings.db?.host ?? dbUrl?.host ?? process.env.DB_HOST ?? '127.0.0.1',
        port: websiteSettings.db?.port ?? dbUrl?.port ?? int('DB_PORT', 3306),
        user: websiteSettings.db?.user ?? dbUrl?.user ?? process.env.DB_USER ?? 'emptrack',
        password: websiteSettings.db?.password ?? dbUrl?.password ?? process.env.DB_PASSWORD ?? 'Btpldvg@2026',
        database: websiteSettings.db?.database ?? dbUrl?.database ?? process.env.DB_NAME ?? 'emp_tracking',
        connectionLimit: int('DB_POOL_SIZE', 12),
    },
    jwtSecret: process.env.JWT_SECRET || (webSetupEnabled ? configStore.signingKey() : '2e63294fb8eda55f29d24cd912e07c6f4bce0e7c3b6e65ad5907eaa013590fc1bcd3776381b6786b743119a1a5d8d7b6'),
    otp: {
        expiryMinutes: websiteSettings.otp?.expiryMinutes ?? int('OTP_EXPIRY_MINUTES', 10),
        resendCooldownSeconds: websiteSettings.otp?.resendCooldownSeconds ?? int('OTP_RESEND_COOLDOWN_SECONDS', 60),
        maxAttempts: websiteSettings.otp?.maxAttempts ?? int('OTP_MAX_ATTEMPTS', 5),
    },
    rateLimit: {
        windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
        maxRequests: int('RATE_LIMIT_MAX_REQUESTS', 600),
        loginMax: int('LOGIN_RATE_LIMIT_MAX', 20),
    },
    sessionTtlDays: int('SESSION_TTL_DAYS', 7),
    coarena: {
        apiKey: process.env.COARENA_API_KEY?.trim() ?? '',
        baseUrl: 'https://coarena.ai/api/v1',
        model: process.env.COARENA_MODEL?.trim() || 'gpt-6-luna',
        timeoutMs: int('COARENA_TIMEOUT_MS', 60_000),
    },
    internalJobSecret: process.env.INTERNAL_JOB_SECRET ?? '',
    smtp: {
        host: websiteSettings.smtp?.host ?? process.env.SMTP_HOST ?? '',
        port: websiteSettings.smtp?.port ?? int('SMTP_PORT', 587),
        secure: websiteSettings.smtp?.secure ?? (process.env.SMTP_SECURE === 'true'),
        user: websiteSettings.smtp?.user ?? process.env.SMTP_USER ?? '',
        password: websiteSettings.smtp?.password ?? process.env.SMTP_PASSWORD ?? '',
        from: websiteSettings.smtp?.from ?? senderHeader(),
        replyTo: websiteSettings.smtp?.replyTo ?? process.env.SMTP_REPLY_TO ?? '',
        get configured() {
            return Boolean(this.host);
        },
    },
    sms: {
        url: process.env.SMS_PROVIDER_URL ?? '',
        key: process.env.SMS_PROVIDER_KEY ?? '',
        senderId: process.env.SMS_SENDER_ID ?? 'WORKFR',
        get configured() {
            return Boolean(process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_KEY);
        },
    },
    turn: {
        url: process.env.TURN_URL ?? '',
        username: process.env.TURN_USERNAME ?? '',
        credential: process.env.TURN_CREDENTIAL ?? '',
    },
    uploadDir: process.env.UPLOAD_DIR ?? 'storage/uploads',
    maxUploadMb: int('MAX_UPLOAD_MB', 15),
    redisUrl: process.env.REDIS_URL ?? '',
    websocketUrl: process.env.WEBSOCKET_URL ?? '',
    cookieName: 'wfm_session',
};
if (config.isProd && (config.jwtSecret.length < 32 || config.jwtSecret.includes('development-only')))
    throw new Error('Production JWT_SECRET must be a strong secret of at least 32 characters');
export function needsSetup() { const saved = configStore.read(); return webSetupEnabled && (!saved.setupComplete || Boolean(saved.installationPending)); }
//# sourceMappingURL=config.js.map