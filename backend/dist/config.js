import dotenv from 'dotenv';
import { configStore } from './lib/configStore.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../..');
const productionFile = path.join(rootDir, '.env.production');
const localFile = path.join(rootDir, '.env.local');
// Default to production when deployed with .env.production on hosting servers
if (!process.env.NODE_ENV) {
    if (fs.existsSync(productionFile) && !fs.existsSync(localFile)) {
        process.env.NODE_ENV = 'production';
    }
    else {
        process.env.NODE_ENV = 'development';
    }
}
const isProdEnv = process.env.NODE_ENV === 'production';
// Primary environment file:
if (process.env.NODE_ENV === 'production') {
    if (fs.existsSync(productionFile))
        dotenv.config({ path: productionFile });
}
else if (process.env.NODE_ENV === 'test') {
    // Tests read only their own file so they can never inherit live credentials.
    const testFile = path.resolve(here, '../.env.test');
    if (fs.existsSync(testFile))
        dotenv.config({ path: testFile });
}
else {
    if (fs.existsSync(localFile))
        dotenv.config({ path: localFile });
    if (fs.existsSync(path.join(rootDir, '.env.development'))) {
        dotenv.config({ path: path.join(rootDir, '.env.development') });
    }
}
// Fallback environment files (for values not yet set). The production file is
// never used as a fallback: a development or test run must not reach live data.
const smtpKeysBeforeFallback = new Set(Object.keys(process.env).filter((key) => key.startsWith('SMTP_')));
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.join(rootDir, '.env') });
if (process.env.NODE_ENV === 'test') {
    // Tests must never send through the real mailbox: drop SMTP settings that came only
    // from the fallback .env files (backend/.env holds live credentials).
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('SMTP_') && !smtpKeysBeforeFallback.has(key))
            delete process.env[key];
    }
}
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
    const name = process.env.SMTP_FROM_NAME?.trim() || 'BSC Textiles Workforce';
    const email = process.env.SMTP_FROM_EMAIL?.trim() || 'admin@bsctextiles.in';
    if (name && email)
        return `${name} <${email}>`;
    if (email)
        return email;
    return process.env.SMTP_FROM ?? 'BSC Textiles Workforce <admin@bsctextiles.in>';
}
function required(name, fallback) {
    const value = process.env[name] ?? fallback;
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
/**
 * Production fallback when JWT_SECRET is not provided (e.g. a git-based deploy
 * where the git-ignored .env.production is absent). Uses a random key persisted
 * in the private config directory so sessions survive restarts instead of the
 * process crashing at import time.
 */
function persistedSigningKey() {
    if (process.env.JWT_SECRET)
        return undefined;
    try {
        const key = configStore.signingKey();
        if (process.env.NODE_ENV === 'production') {
            console.warn(`[config] JWT_SECRET is not set; using a generated key stored in ${configStore.directory}. Set JWT_SECRET in the hosting panel.`);
        }
        return key;
    }
    catch (error) {
        console.error('[config] Could not create a persisted signing key', error);
        return undefined;
    }
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
// Tests use a dedicated database only: TEST_DATABASE_URL (backend/.env.test).
// The database name must contain "test" so the suite can never write to real data.
const testDbUrl = process.env.NODE_ENV === 'test' ? parseDatabaseUrl(process.env.TEST_DATABASE_URL) : null;
if (process.env.NODE_ENV === 'test' && (!testDbUrl || !/test/i.test(testDbUrl.database))) {
    throw new Error('Tests require TEST_DATABASE_URL=mysql://user:pass@host:3306/<name containing "test"> (set it in backend/.env.test). Refusing to run against a non-test database.');
}
const dbUrl = testDbUrl ?? parseDatabaseUrl(process.env.DATABASE_URL);
const rawAppUrl = process.env.APP_URL?.trim() || process.env.FRONTEND_URL?.trim() || process.env.APP_ORIGIN?.trim();
const appUrl = (rawAppUrl && !rawAppUrl.includes('localhost')
    ? rawAppUrl
    : (isProdEnv || process.env.NODE_ENV === 'production' || !rawAppUrl ? 'https://emptrack.bsctextiles.in' : 'http://localhost:5173')).replace(/\/+$/, '');
const configuredOrigins = (process.env.APP_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
if (appUrl && !configuredOrigins.includes(appUrl))
    configuredOrigins.push(appUrl);
if (!configuredOrigins.includes('https://emptrack.bsctextiles.in'))
    configuredOrigins.push('https://emptrack.bsctextiles.in');
if (process.env.FRONTEND_URL) {
    const feUrl = process.env.FRONTEND_URL.trim().replace(/\/+$/, '');
    if (feUrl && !configuredOrigins.includes(feUrl))
        configuredOrigins.push(feUrl);
}
export const config = {
    env: process.env.NODE_ENV ?? 'development',
    isProd,
    isTest: process.env.NODE_ENV === 'test',
    port: int('PORT', 3000),
    appOrigin: configuredOrigins.join(',') || appUrl,
    appUrl,
    backendUrl: (process.env.BACKEND_URL ?? `http://localhost:${int('PORT', 4000)}`).replace(/\/+$/, ''),
    appName: websiteSettings.appName ?? process.env.APP_NAME ?? 'Workforce',
    timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
    logLevel: process.env.LOG_LEVEL ?? (isProdEnv ? 'info' : 'debug'),
    db: {
        host: (process.env.NODE_ENV === 'test' ? testDbUrl?.host : null) ?? websiteSettings.db?.host ?? dbUrl?.host ?? process.env.DB_HOST ?? '127.0.0.1',
        port: (process.env.NODE_ENV === 'test' ? testDbUrl?.port : null) ?? websiteSettings.db?.port ?? dbUrl?.port ?? int('DB_PORT', 3306),
        user: (process.env.NODE_ENV === 'test' ? testDbUrl?.user : null) ?? websiteSettings.db?.user ?? dbUrl?.user ?? process.env.DB_USER ?? 'root',
        password: (process.env.NODE_ENV === 'test' ? testDbUrl?.password : null) ?? websiteSettings.db?.password ?? dbUrl?.password ?? process.env.DB_PASSWORD ?? '',
        database: (process.env.NODE_ENV === 'test' ? testDbUrl?.database : null) ?? websiteSettings.db?.database ?? dbUrl?.database ?? process.env.DB_NAME ?? 'emp_tracking',
        connectionLimit: int('DB_POOL_SIZE', 12),
    },
    jwtSecret: required('JWT_SECRET', webSetupEnabled || isProd ? persistedSigningKey() : process.env.SESSION_SECRET ?? 'development-only-insecure-secret-change-me'),
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
    email: {
        /**
         * Master switch for notification and mailbox email. OFF unless EMAIL_SENDING_ENABLED=true.
         * Login and password-reset codes are still emailed so nobody is locked out.
         */
        sendingEnabled: process.env.EMAIL_SENDING_ENABLED === 'true',
    },
    smtp: {
        // Host/user defaults only. The password must come from the website settings or the
        // SMTP_PASSWORD environment variable; it is never stored in source code.
        host: websiteSettings.smtp?.host || process.env.SMTP_HOST?.trim() || 'smtp.hostinger.com',
        port: websiteSettings.smtp?.host ? websiteSettings.smtp.port : (process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465),
        secure: websiteSettings.smtp?.host ? websiteSettings.smtp.secure : (process.env.SMTP_SECURE === 'false' ? false : true),
        user: websiteSettings.smtp?.user || process.env.SMTP_USER?.trim() || 'admin@bsctextiles.in',
        password: websiteSettings.smtp?.password || process.env.SMTP_PASSWORD || '',
        from: websiteSettings.smtp?.from || senderHeader(),
        replyTo: websiteSettings.smtp?.replyTo || process.env.SMTP_REPLY_TO?.trim() || 'admin@bsctextiles.in',
        get configured() {
            return Boolean(this.host && this.user && this.password);
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
    get vapidPublicKey() {
        return process.env.VAPID_PUBLIC_KEY || configStore.vapidKeys().publicKey;
    },
    get vapidPrivateKey() {
        return process.env.VAPID_PRIVATE_KEY || configStore.vapidKeys().privateKey;
    },
    /**
     * Firebase Cloud Messaging for the Android / iOS app. Server-side only: the
     * service-account key never ships in the app. Either a path to the JSON key
     * file or the JSON itself (optionally base64-encoded) may be given.
     */
    fcm: {
        serviceAccountFile: process.env.FCM_SERVICE_ACCOUNT_FILE ?? '',
        serviceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '',
    },
    /**
     * Origins the Capacitor app runs on (Android: https://localhost, iOS:
     * capacitor://localhost). Allowed for cookie-less, Bearer-token requests only.
     */
    mobileOrigins: (process.env.MOBILE_APP_ORIGINS ?? 'capacitor://localhost,https://localhost')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    uploadDir: process.env.UPLOAD_DIR ?? 'storage/uploads',
    maxUploadMb: int('MAX_UPLOAD_MB', 15),
    /** Chunked/resumable uploads support large archives up to 1 GB by default. */
    maxChunkedUploadMb: int('MAX_CHUNKED_UPLOAD_MB', 1024),
    chunkSizeMb: Math.min(32, Math.max(1, int('UPLOAD_CHUNK_SIZE_MB', 8))),
    chunkSessionTtlHours: int('UPLOAD_SESSION_TTL_HOURS', 24),
    redisUrl: process.env.REDIS_URL ?? '',
    websocketUrl: process.env.WEBSOCKET_URL ?? '',
    cookieName: 'wfm_session',
    /** Directory containing public APK downloads (default: frontend/public/downloads). */
    publicDownloadsDir: process.env.PUBLIC_DOWNLOADS_DIR ?? path.join(rootDir, 'frontend/public/downloads'),
};
if (config.isProd && (config.jwtSecret.length < 32 || config.jwtSecret.includes('development-only')))
    throw new Error('Production JWT_SECRET must be a strong secret of at least 32 characters');
export function needsSetup() { const saved = configStore.read(); return webSetupEnabled && (!saved.setupComplete || Boolean(saved.installationPending)); }
//# sourceMappingURL=config.js.map