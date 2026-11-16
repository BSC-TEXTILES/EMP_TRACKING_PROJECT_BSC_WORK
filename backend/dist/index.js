import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configStore } from './lib/configStore.js';
import { setupRouter } from './routes/setup.js';
import { onSetupCompleted, recoverPendingInstallation } from './services/WebsiteSetupService.js';
import { config, needsSetup } from './config.js';
import { apiRouter } from './routes/index.js';
import { initRealtime } from './realtime/io.js';
import { originGuard, rateLimit, securityHeaders } from './middleware/security.js';
import { startJobs } from './jobs/scheduler.js';
import { closePool, queryOne } from './db/index.js';
import { FileService } from './services/FileService.js';
import { logEnvironmentReport, validateEnvironment } from './lib/envValidation.js';
const here = path.dirname(fileURLToPath(import.meta.url));
export function createApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.use(express.json({ limit: '2mb' }));
    app.use(express.urlencoded({ extended: true, limit: '2mb' }));
    app.use(cookieParser());
    app.use(originGuard);
    app.use(rateLimit({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxRequests }));
    app.use('/api/setup', setupRouter);
    app.use('/api', (req, res, next) => {
        if (needsSetup() && req.path !== '/live') {
            res.status(503).json({ error: 'Complete website setup first.', code: 'setup_required' });
            return;
        }
        next();
    });
    app.use('/api', apiRouter);
    // Serve the built SPA when it exists (single-origin production deployment).
    const clientCandidates = [
        process.env.CLIENT_DIR,
        path.resolve(here, '../../frontend/dist'),
        path.resolve(here, '../frontend/dist'),
        path.resolve(process.cwd(), 'frontend/dist'),
        path.resolve(process.cwd(), 'dist'),
        path.resolve(process.cwd(), 'public_html'),
    ].filter((d) => Boolean(d));
    const clientDir = clientCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
    if (clientDir) {
        app.use(express.static(clientDir, {
            index: false,
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
                    res.setHeader('Cache-Control', 'no-cache');
                }
                else {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
            },
        }));
        app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
            res.sendFile(path.join(clientDir, 'index.html'));
        });
    }
    else {
        app.get('/', (_req, res) => {
            res.status(200).send(`<!DOCTYPE html><html><head><title>${config.appName}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,-apple-system,sans-serif;margin:40px;line-height:1.6;color:#1e293b;background:#f8fafc;}h1{color:#0f172a;}code{background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:0.9em;}.card{background:white;padding:24px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);max-width:600px;margin:20px 0;}</style></head><body><h1>${config.appName} Backend is Running</h1><div class="card"><p>The API server is operational, but the frontend client build was not detected at <code>frontend/dist</code>.</p><p>To build the frontend, run: <code>npm run build</code></p><p>API Health Check: <a href="/api/health">/api/health</a></p></div></body></html>`);
        });
    }
    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'Endpoint not found', code: 'not_found' });
    });
    app.use((error, req, res, _next) => {
        const err = error;
        if (err?.type === 'entity.parse.failed') {
            res.status(400).json({ error: 'Malformed JSON body', code: 'bad_request' });
            return;
        }
        if (err?.code === 'ER_DUP_ENTRY') {
            res.status(409).json({ error: 'A record with these details already exists', code: 'conflict' });
            return;
        }
        if (err?.code === 'ER_ROW_IS_REFERENCED_2' || err?.code === 'ER_ROW_IS_REFERENCED') {
            res.status(409).json({ error: 'This record is referenced by other data and cannot be removed', code: 'conflict' });
            return;
        }
        const status = typeof err?.status === 'number' ? err.status : 500;
        if (status >= 500) {
            console.error('[api] unhandled error', {
                path: req.path,
                method: req.method,
                code: err?.code,
                sqlMessage: err?.sqlMessage,
                sql: process.env.NODE_ENV === 'production' ? undefined : err?.sql,
            });
        }
        res.status(status).json({
            error: status >= 500 ? 'Something went wrong. Please try again.' : (err?.message ?? 'Request failed'),
            code: err?.code ?? 'error',
            details: status >= 500 ? undefined : err?.details,
        });
    });
    return app;
}
async function ensureDatabaseReady() {
    try {
        const table = await queryOne("SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'employees'");
        if (!table || Number(table.cnt) === 0) {
            console.log('[startup] Database tables not found. Automatically running migrations and seeding reference data...');
            const { runMigrations } = await import('./db/migrate.js');
            await runMigrations(config.db, false);
            const { seedBasicData } = await import('./db/seed.js');
            await seedBasicData();
            console.log('[startup] Database initialized and reference data seeded successfully.');
        }
        else {
            // Apply any new migration files to an existing database. Only done when the
            // migration ledger exists, so manually imported schemas are never replayed.
            const ledger = await queryOne("SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'");
            if (ledger && Number(ledger.cnt) > 0) {
                const { runMigrations } = await import('./db/migrate.js');
                await runMigrations(config.db, false);
            }
            const empCount = await queryOne('SELECT COUNT(*) AS cnt FROM employees');
            if (!empCount || Number(empCount.cnt) === 0) {
                console.log('[startup] Employees table empty. Seeding initial accounts...');
                const { seedBasicData } = await import('./db/seed.js');
                await seedBasicData();
                console.log('[startup] Initial accounts seeded successfully.');
            }
        }
    }
    catch (err) {
        console.error('[startup] Could not verify/initialize database schema:', err);
    }
}
async function main() {
    process.on('unhandledRejection', (reason) => console.error('[process] unhandled promise rejection', reason));
    try {
        await recoverPendingInstallation();
    }
    catch (err) {
        console.error('[startup] Could not recover pending installation; continuing.', err);
    }
    const app = createApp();
    try {
        await FileService.ensureStorage();
    }
    catch (err) {
        console.error('[startup] Could not prepare upload storage; uploads may fail.', err);
    }
    const server = http.createServer(app);
    initRealtime(server);
    if (needsSetup()) {
        configStore.setupCode();
        console.log(`[setup] Open /setup. Read the one-time installation code from ${path.join(configStore.directory, 'setup-code')}.`);
        onSetupCompleted(startJobs);
    }
    else {
        try {
            await queryOne('SELECT 1 AS ok');
            void ensureDatabaseReady();
            startJobs();
        }
        catch (err) {
            console.error('[startup] MySQL is currently unavailable. Server will continue running and retry connection.', err);
            const interval = setInterval(async () => {
                try {
                    await queryOne('SELECT 1 AS ok');
                    clearInterval(interval);
                    console.log('[startup] MySQL connection established. Background jobs started.');
                    void ensureDatabaseReady();
                    startJobs();
                }
                catch {
                    // retry in background
                }
            }, 10_000);
            interval.unref();
        }
    }
    const envReport = validateEnvironment();
    logEnvironmentReport(envReport);
    if (!envReport.ok && config.isProd && !needsSetup()) {
        console.warn('[startup] Warning: configuration errors detected in environment settings.');
    }
    if (config.smtp.configured) {
        // Never block or crash startup on the SMTP probe.
        void import('./lib/mailer.js')
            .then(({ smtpStatus }) => smtpStatus(true))
            .then((status) => console.log(`  Email: SMTP ${status.reachable ? 'verified' : 'UNREACHABLE'} (${status.host}:${status.port})`))
            .catch((err) => console.error('[startup] SMTP check failed', err));
    }
    else {
        console.log('  Email: SMTP not configured — delivery unavailable');
    }
    const rawPort = process.env.PORT;
    const isPassenger = (typeof global.PhusionPassenger !== 'undefined') ||
        rawPort === 'passenger' ||
        (typeof rawPort === 'string' && (rawPort.startsWith('/') || rawPort.startsWith('\\\\.\\pipe\\')));
    server.on('error', (err) => {
        console.error('[server] HTTP server listen error:', err);
    });
    if (isPassenger) {
        const target = (rawPort && rawPort !== 'passenger') ? rawPort : 'passenger';
        server.listen(target, () => {
            console.log(`\n  ${config.appName} API ready under Passenger / LiteSpeed socket: ${target}`);
            console.log(`  Environment: ${config.env} · Timezone: ${config.timezone}`);
            console.log(`  Health: /api/health\n`);
        });
    }
    else {
        const PORT = Number(process.env.PORT) || config.port || 3000;
        server.listen(PORT, () => {
            console.log(`\n  ${config.appName} API ready on port ${PORT}`);
            console.log(`  Environment: ${config.env} · Timezone: ${config.timezone}`);
            console.log(`  Health: /api/health\n`);
        });
    }
    const shutdown = (signal) => {
        console.log(`\n[shutdown] ${signal} received, closing server`);
        server.close(() => {
            void closePool().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
if (process.env.NODE_ENV !== 'test') {
    main().catch((err) => {
        console.error('[startup] Fatal error while starting the server', err);
        // Never crash or leave reverse proxy with a dead socket (which causes 503)
        try {
            const PORT = Number(process.env.PORT) || 3000;
            const emergencyApp = http.createServer((_req, res) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Application failed to start',
                    code: 'startup_error',
                    message: err?.message || String(err),
                    hint: 'Check database connectivity and hosting panel configuration',
                }));
            });
            emergencyApp.listen(PORT, '0.0.0.0', () => {
                console.error(`[startup] Emergency diagnostic server running on port ${PORT}`);
            });
        }
        catch (listenErr) {
            console.error('[startup] Could not bind emergency server:', listenErr);
        }
    });
}
//# sourceMappingURL=index.js.map