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
import { mobileCors, originGuard, rateLimit, securityHeaders } from './middleware/security.js';
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
    app.use(mobileCors);
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
            try {
                const { runMigrations } = await import('./db/migrate.js');
                await runMigrations(config.db, false);
            }
            catch (err) {
                console.warn('[startup] Migration check note:', err);
            }
            try {
                const { execute } = await import('./db/index.js');
                await execute(`CREATE TABLE IF NOT EXISTS employee_login_audit (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          session_id BIGINT UNSIGNED NULL,
          employee_id BIGINT UNSIGNED NOT NULL,
          employee_code VARCHAR(40) NULL,
          full_name VARCHAR(120) NULL,
          location_name VARCHAR(120) NULL,
          login_at DATETIME(3) NOT NULL,
          logout_at DATETIME(3) NULL,
          last_heartbeat_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          duration_minutes INT NOT NULL DEFAULT 0,
          ip VARCHAR(64) NULL,
          user_agent VARCHAR(255) NULL,
          browser VARCHAR(120) NULL,
          os VARCHAR(60) NULL,
          device_id BIGINT UNSIGNED NULL,
          login_status VARCHAR(24) NOT NULL DEFAULT 'success',
          logout_reason VARCHAR(120) NULL,
          termination_status VARCHAR(24) NOT NULL DEFAULT 'active',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          KEY idx_login_audit_emp_date (employee_id, login_at),
          KEY idx_login_audit_login_at (login_at),
          KEY idx_login_audit_status (termination_status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
                // Ensure all employee emails use official @bsctextiles.in domain format
                await execute(`UPDATE employees 
          SET email = CONCAT(LOWER(REPLACE(TRIM(full_name), ' ', '.')), '@bsctextiles.in')
          WHERE email LIKE '%@workforce.test' OR email IS NULL OR email = ''`);
                // Configure Renukaradhya as the ONLY Super Admin and root of hierarchy
                const { pool } = await import('./db/index.js');
                const dbConn = await pool.getConnection();
                try {
                    await dbConn.query('SET FOREIGN_KEY_CHECKS = 0');
                    const { hashPassword } = await import('./lib/crypto.js');
                    const validHash = await hashPassword('Workforce@2026');
                    const [superAdminRole] = await dbConn.query("SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1");
                    const superAdminRoleId = superAdminRole.length > 0 ? Number(superAdminRole[0].id) : 1;
                    // Ensure Renukaradhya is the sole Super Admin (EMP-1001)
                    const [renukaRows] = await dbConn.query("SELECT id, employee_code, email FROM employees WHERE full_name LIKE '%Renuka%' OR employee_code = 'EMP-1001' ORDER BY id ASC LIMIT 1");
                    let renukaId;
                    if (renukaRows.length > 0) {
                        renukaId = Number(renukaRows[0].id);
                        await dbConn.query(`UPDATE employees 
               SET employee_code = 'EMP-1001',
                   full_name = 'Renukaradhya',
                   email = 'renuka.adhya@bsctextiles.in',
                   mobile = '9876543210',
                   manager_id = NULL,
                   role_id = ?,
                   status = 'active',
                   failed_login_attempts = 0,
                   locked_until = NULL,
                   password_hash = ?
               WHERE id = ?`, [superAdminRoleId, validHash, renukaId]);
                    }
                    else {
                        const [insertRes] = await dbConn.query(`INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, manager_id, status, joining_date, email_verified_at, mobile_verified_at)
               VALUES ('EMP-1001', 'Renukaradhya', 'renuka.adhya@bsctextiles.in', '9876543210', ?, ?, NULL, 'active', CURDATE(), NOW(3), NOW(3))`, [validHash, superAdminRoleId]);
                        renukaId = Number(insertRes.insertId);
                    }
                    // Strip super_admin role from all other employees
                    await dbConn.query(`UPDATE employees SET role_id = (SELECT id FROM roles WHERE slug = 'employee' LIMIT 1) WHERE id != ? AND role_id = ?`, [renukaId, superAdminRoleId]);
                    // Ensure Chetan TK exists as active HR Manager reporting to Renukaradhya
                    const [chetanRows] = await dbConn.query("SELECT id, employee_code, email FROM employees WHERE full_name LIKE '%Chetan%' ORDER BY id DESC LIMIT 1");
                    let chetanId;
                    const [hrRole] = await dbConn.query("SELECT id FROM roles WHERE slug = 'hr_manager' LIMIT 1");
                    const hrRoleId = hrRole.length > 0 ? Number(hrRole[0].id) : 7;
                    const [hrDept] = await dbConn.query("SELECT id FROM departments WHERE code = 'HR' LIMIT 1");
                    const hrDeptId = hrDept.length > 0 ? Number(hrDept[0].id) : null;
                    const [hrDesig] = await dbConn.query("SELECT id FROM designations WHERE title LIKE '%HR Manager%' OR title LIKE '%HR%' LIMIT 1");
                    const hrDesigId = hrDesig.length > 0 ? Number(hrDesig[0].id) : null;
                    if (chetanRows.length > 0) {
                        chetanId = Number(chetanRows[0].id);
                        await dbConn.query(`UPDATE employees 
               SET full_name = 'Chetan TK',
                   email = 'chetan.tk@bsctextiles.in',
                   mobile = '9876543211',
                   manager_id = ?,
                   role_id = ?,
                   department_id = COALESCE(?, department_id),
                   designation_id = COALESCE(?, designation_id),
                   status = 'active',
                   failed_login_attempts = 0,
                   locked_until = NULL,
                   password_hash = ?
               WHERE id = ?`, [renukaId, hrRoleId, hrDeptId, hrDesigId, validHash, chetanId]);
                    }
                    else {
                        const [chetanInsert] = await dbConn.query(`INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, designation_id, manager_id, status, joining_date, email_verified_at, mobile_verified_at)
               VALUES ('EMP-1002', 'Chetan TK', 'chetan.tk@bsctextiles.in', '9876543211', ?, ?, ?, ?, ?, 'active', CURDATE(), NOW(3), NOW(3))`, [validHash, hrRoleId, hrDeptId, hrDesigId, renukaId]);
                        chetanId = Number(chetanInsert.insertId);
                    }
                    // If Gagan exists, ensure Gagan is not a manager or super admin and does not act as reporting manager
                    await dbConn.query(`UPDATE employees 
             SET role_id = (SELECT id FROM roles WHERE slug = 'employee' LIMIT 1),
                 manager_id = ?
             WHERE full_name LIKE '%Gagan%' AND id != ?`, [renukaId, renukaId]);
                    // Reassign any employees currently reporting to Gagan to Renukaradhya
                    await dbConn.query(`UPDATE employees 
             SET manager_id = ?
             WHERE manager_id IN (SELECT id FROM (SELECT id FROM employees WHERE full_name LIKE '%Gagan%') AS g)`, [renukaId]);
                    // Purge deprecated mock/test accounts with @workforce.test domain
                    try {
                        await dbConn.query("DELETE FROM employees WHERE email LIKE '%@workforce.test'");
                    }
                    catch { }
                    await dbConn.query('SET FOREIGN_KEY_CHECKS = 1');
                    console.log(`[startup] Verified Renukaradhya (ID: ${renukaId}, Super Admin) and Chetan TK (ID: ${chetanId}, HR Manager) ready.`);
                }
                finally {
                    try {
                        await dbConn.query('SET FOREIGN_KEY_CHECKS = 1');
                    }
                    catch { }
                    dbConn.release();
                }
                // Ensure task management tables exist
                await execute(`CREATE TABLE IF NOT EXISTS store_daily_checkpoints (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          employee_id BIGINT UNSIGNED NOT NULL,
          store_id BIGINT UNSIGNED NULL,
          checkpoint_date DATE NOT NULL,
          time_slot VARCHAR(32) NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'pending',
          summary TEXT NULL,
          issues_identified TEXT NULL,
          escalated_to BIGINT UNSIGNED NULL,
          submitted_at DATETIME(3) NULL,
          verified_at DATETIME(3) NULL,
          verified_by BIGINT UNSIGNED NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uq_store_checkpoint_emp (employee_id, checkpoint_date, time_slot),
          KEY idx_store_checkpoint_date (checkpoint_date, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
                await execute(`CREATE TABLE IF NOT EXISTS employee_daily_performance (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          employee_id BIGINT UNSIGNED NOT NULL,
          evaluation_date DATE NOT NULL,
          task_completion_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          timely_completion_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          quality_accuracy_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          reporting_doc_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          attendance_punctuality_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          team_coordination_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          escalation_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          total_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          rating VARCHAR(32) NOT NULL DEFAULT 'Good',
          evaluated_by BIGINT UNSIGNED NULL,
          remarks TEXT NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uq_emp_daily_perf (employee_id, evaluation_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
                await execute(`CREATE TABLE IF NOT EXISTS task_templates (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          designation_title VARCHAR(100) NOT NULL,
          role_level INT NOT NULL DEFAULT 1,
          time_slot VARCHAR(32) NOT NULL DEFAULT 'operations',
          task_order INT NOT NULL DEFAULT 1,
          title VARCHAR(200) NOT NULL,
          description TEXT NULL,
          priority VARCHAR(16) NOT NULL DEFAULT 'medium',
          requires_evidence TINYINT(1) NOT NULL DEFAULT 0,
          evidence_type VARCHAR(64) NULL,
          requires_metric TINYINT(1) NOT NULL DEFAULT 0,
          metric_label VARCHAR(64) NULL,
          metric_unit VARCHAR(24) NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
                try {
                    const { syncRbac } = await import('./lib/rbacSync.js');
                    const synced = await syncRbac();
                    if (synced.newPermissions.length || synced.newRoles.length) {
                        console.log(`[startup] RBAC synced: ${synced.newPermissions.length} new permission(s), ${synced.newRoles.length} new role(s)`);
                    }
                }
                catch (rbacErr) {
                    console.warn('[startup] RBAC sync note:', rbacErr);
                }
                try {
                    const { HierarchyService } = await import('./services/HierarchyService.js');
                    const structure = await HierarchyService.ensureStructure();
                    console.log(`[startup] Reporting hierarchy: root employee ${structure.rootId ?? 'not found'}, ${structure.reassigned} attached to root, ${structure.locationsAssigned} given a default location`);
                }
                catch (hierErr) {
                    console.warn('[startup] Reporting hierarchy check note:', hierErr);
                }
                try {
                    const { DailyTaskService } = await import('./services/DailyTaskService.js');
                    await DailyTaskService.ensureTemplatesExist();
                }
                catch (tplErr) {
                    console.warn('[startup] Master SOP task template check note:', tplErr);
                }
                // Ensure email delivery and mailbox schema readiness
                try {
                    const colCheckDeliveries = await queryOne("SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'email_deliveries' AND column_name = 'sender_id'");
                    if (!colCheckDeliveries || Number(colCheckDeliveries.cnt) === 0) {
                        await execute("ALTER TABLE email_deliveries MODIFY status ENUM('queued', 'sending', 'sent', 'accepted', 'failed', 'skipped', 'delivered') NOT NULL DEFAULT 'queued'");
                        await execute(`ALTER TABLE email_deliveries
              ADD COLUMN sender_id BIGINT UNSIGNED NULL AFTER id,
              ADD COLUMN cc_emails TEXT NULL AFTER recipient_name,
              ADD COLUMN bcc_emails TEXT NULL AFTER cc_emails,
              ADD COLUMN body_text MEDIUMTEXT NULL AFTER payload,
              ADD COLUMN body_html MEDIUMTEXT NULL AFTER body_text,
              ADD COLUMN attachments JSON NULL AFTER body_html`);
                        await execute('CREATE INDEX idx_email_sender_created ON email_deliveries (sender_id, created_at)');
                    }
                }
                catch (e) {
                    console.warn('[startup] email_deliveries schema update note:', e);
                }
                try {
                    const colCheckInternal = await queryOne("SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'internal_emails' AND column_name = 'recipient_email'");
                    if (!colCheckInternal || Number(colCheckInternal.cnt) === 0) {
                        await execute('ALTER TABLE internal_emails MODIFY recipient_id BIGINT UNSIGNED NULL');
                        await execute(`ALTER TABLE internal_emails
              ADD COLUMN recipient_email VARCHAR(190) NULL AFTER recipient_id,
              ADD COLUMN recipient_name VARCHAR(150) NULL AFTER recipient_email,
              ADD COLUMN cc_emails TEXT NULL AFTER recipient_name,
              ADD COLUMN bcc_emails TEXT NULL AFTER cc_emails,
              ADD COLUMN body_html MEDIUMTEXT NULL AFTER body,
              ADD COLUMN delivery_status ENUM('queued', 'sending', 'accepted', 'failed', 'delivered') NOT NULL DEFAULT 'accepted' AFTER attachments,
              ADD COLUMN provider_message_id VARCHAR(190) NULL AFTER delivery_status,
              ADD COLUMN last_error VARCHAR(500) NULL AFTER provider_message_id`);
                        await execute('CREATE INDEX idx_internal_emails_recipient_email ON internal_emails (recipient_email, created_at)');
                    }
                }
                catch (e) {
                    console.warn('[startup] internal_emails schema update note:', e);
                }
            }
            catch (schemaErr) {
                console.warn('[startup] Schema readiness note:', schemaErr);
            }
            if (config.isProd) {
                const { findDemoPasswordAccounts } = await import('./db/seed.js');
                const exposed = await findDemoPasswordAccounts();
                if (exposed.length) {
                    console.error(`[startup] SECURITY: ${exposed.length} active account(s) still use the published demo password (${exposed.join(', ')}). Change these passwords or deactivate the accounts immediately.`);
                }
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
    void import('./lib/uploadSecurity.js').then(({ scannerConfigured, scanMode }) => {
        if (scannerConfigured())
            console.log(`  Uploads: content-verified + ClamAV scanned (${process.env.CLAMAV_HOST})`);
        else if (scanMode() === 'required')
            console.warn('  Uploads: DISABLED — UPLOAD_SCAN_MODE=required but CLAMAV_HOST is not set');
        else
            console.log('  Uploads: content-verified (set CLAMAV_HOST to add virus scanning)');
    }).catch(() => undefined);
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