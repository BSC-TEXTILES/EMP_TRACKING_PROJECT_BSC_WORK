import express, { type NextFunction, type Request, type Response } from 'express';
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
import { ApiError } from './lib/http.js';
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
    if (needsSetup() && req.path !== '/live') { res.status(503).json({ error: 'Complete website setup first.', code: 'setup_required' }); return; }
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
  ].filter((d): d is string => Boolean(d));

  const clientDir = clientCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));

  if (clientDir) {
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  } else {
    app.get('/', (_req: Request, res: Response) => {
      res.status(200).send(`<!DOCTYPE html><html><head><title>${config.appName}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui,-apple-system,sans-serif;margin:40px;line-height:1.6;color:#1e293b;background:#f8fafc;}h1{color:#0f172a;}code{background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:0.9em;}.card{background:white;padding:24px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);max-width:600px;margin:20px 0;}</style></head><body><h1>${config.appName} Backend is Running</h1><div class="card"><p>The API server is operational, but the frontend client build was not detected at <code>frontend/dist</code>.</p><p>To build the frontend, run: <code>npm run build</code></p><p>API Health Check: <a href="/api/health">/api/health</a></p></div></body></html>`);
    });
  }

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found', code: 'not_found' });
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const err = error as { status?: number; code?: string; message?: string; details?: unknown; type?: string };
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
        sqlMessage: (err as { sqlMessage?: string })?.sqlMessage,
        sql: process.env.NODE_ENV === 'production' ? undefined : (err as { sql?: string })?.sql,
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

async function ensureDatabaseReady(): Promise<void> {
  try {
    const table = await queryOne<{ cnt: number | string }>(
      "SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'employees'",
    );
    if (!table || Number(table.cnt) === 0) {
      console.log('[startup] Database tables not found. Automatically running migrations and seeding reference data...');
      const { runMigrations } = await import('./db/migrate.js');
      await runMigrations(config.db, false);
      const { seedBasicData } = await import('./db/seed.js');
      await seedBasicData();
      console.log('[startup] Database initialized and reference data seeded successfully.');
    } else {
      try {
        const { runMigrations } = await import('./db/migrate.js');
        await runMigrations(config.db, false);
      } catch (err) {
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

        // Retain only Gagan C B and purge all other demo/legacy employee records
        const { pool } = await import('./db/index.js');
        const dbConn = await pool.getConnection();
        try {
          await dbConn.query('SET FOREIGN_KEY_CHECKS = 0');

          const [gaganRows] = await dbConn.query<any[]>(
            "SELECT id, employee_code, email FROM employees WHERE full_name LIKE '%Gagan%' ORDER BY id DESC LIMIT 1"
          );
          let gaganId: number;
          const { hashPassword } = await import('./lib/crypto.js');
          const validHash = await hashPassword('Workforce@2026');

          if (gaganRows.length > 0) {
            gaganId = Number(gaganRows[0].id);
            await dbConn.query(
              `UPDATE employees 
               SET full_name = 'Gagan C B',
                   email = 'gagan.cb@bsctextiles.in',
                   mobile = '9876543210',
                   manager_id = NULL,
                   status = 'active',
                   failed_login_attempts = 0,
                   locked_until = NULL,
                   password_hash = ?
               WHERE id = ?`,
              [validHash, gaganId]
            );
          } else {
            const [superAdminRole] = await dbConn.query<any[]>("SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1");
            const roleId = superAdminRole.length > 0 ? Number(superAdminRole[0].id) : 1;
            const [insertRes]: any = await dbConn.query(
              `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, status, joining_date, email_verified_at, mobile_verified_at)
               VALUES ('EMP-1001', 'Gagan C B', 'gagan.cb@bsctextiles.in', '9876543210', ?, ?, 'active', CURDATE(), NOW(3), NOW(3))`,
              [validHash, roleId]
            );
            gaganId = Number(insertRes.insertId);
          }

          // Ensure Chetan TK exists as active HR Manager
          const [chetanRows] = await dbConn.query<any[]>(
            "SELECT id, employee_code, email FROM employees WHERE full_name LIKE '%Chetan%' ORDER BY id DESC LIMIT 1"
          );
          let chetanId: number;
          const [hrRole] = await dbConn.query<any[]>("SELECT id FROM roles WHERE slug = 'hr_manager' LIMIT 1");
          const hrRoleId = hrRole.length > 0 ? Number(hrRole[0].id) : 4;
          const [hrDept] = await dbConn.query<any[]>("SELECT id FROM departments WHERE code = 'HR' LIMIT 1");
          const hrDeptId = hrDept.length > 0 ? Number(hrDept[0].id) : null;
          const [hrDesig] = await dbConn.query<any[]>("SELECT id FROM designations WHERE title LIKE '%HR Manager%' OR title LIKE '%HR%' LIMIT 1");
          const hrDesigId = hrDesig.length > 0 ? Number(hrDesig[0].id) : null;

          if (chetanRows.length > 0) {
            chetanId = Number(chetanRows[0].id);
            await dbConn.query(
              `UPDATE employees 
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
               WHERE id = ?`,
              [gaganId, hrRoleId, hrDeptId, hrDesigId, validHash, chetanId]
            );
          } else {
            const [chetanInsert]: any = await dbConn.query(
              `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, designation_id, manager_id, status, joining_date, email_verified_at, mobile_verified_at)
               VALUES ('EMP-1002', 'Chetan TK', 'chetan.tk@bsctextiles.in', '9876543211', ?, ?, ?, ?, ?, 'active', CURDATE(), NOW(3), NOW(3))`,
              [validHash, hrRoleId, hrDeptId, hrDesigId, gaganId]
            );
            chetanId = Number(chetanInsert.insertId);
          }

          // Assign HR Manager role to Chetan TK
          await dbConn.query(
            `INSERT IGNORE INTO employee_roles (employee_id, role_id)
             SELECT ?, id FROM roles WHERE slug IN ('hr_manager', 'manager')`,
            [chetanId]
          );

          // Safe foreign-key nullification and reassignment to Gagan C B and Chetan TK
          try { await dbConn.query('UPDATE employees SET manager_id = ? WHERE id = ?', [gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE departments SET head_employee_id = ? WHERE code <> "HR"', [gaganId]); } catch { }
          try { await dbConn.query('UPDATE departments SET head_employee_id = ? WHERE code = "HR"', [chetanId]); } catch { }
          try { await dbConn.query('UPDATE projects SET manager_id = ?, created_by = ?', [gaganId, gaganId]); } catch { }
          try { await dbConn.query('UPDATE tasks SET created_by = ?, manager_id = ?, approved_by = ? WHERE created_by NOT IN (?, ?)', [gaganId, gaganId, gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE task_assignments SET assigned_by = ? WHERE assigned_by NOT IN (?, ?)', [gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE daily_reports SET reviewed_by = ? WHERE reviewed_by NOT IN (?, ?)', [gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE tickets SET requester_id = ?, assignee_id = ? WHERE requester_id NOT IN (?, ?)', [gaganId, gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE conversations SET created_by = ? WHERE created_by NOT IN (?, ?)', [gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE meetings SET host_id = ? WHERE host_id NOT IN (?, ?)', [gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE files SET owner_id = ? WHERE owner_id NOT IN (?, ?)', [gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE announcements SET created_by = ? WHERE created_by NOT IN (?, ?)', [gaganId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('UPDATE leave_requests SET reviewed_by = ?, hr_approver_id = ? WHERE employee_id NOT IN (?, ?)', [gaganId, chetanId, gaganId, chetanId]); } catch { }

          // Delete all records of non-Gagan, non-Chetan employees across all dependent tables
          const tablesWithEmpId = [
            'employee_sessions',
            'employee_login_audit',
            'attendance',
            'attendance_records',
            'attendance_breaks',
            'attendance_corrections',
            'daily_reports',
            'daily_work_reports',
            'task_assignments',
            'task_time_logs',
            'ticket_assignments',
            'conversation_members',
            'conversation_user_state',
            'employee_activities',
            'employee_daily_performance',
            'employee_roles',
            'user_permissions',
            'otp_codes',
            'employee_devices',
            'employee_preferences',
            'employee_activity_consents',
            'login_history',
            'store_daily_checkpoints',
            'project_members',
            'announcement_acknowledgements',
            'leave_requests',
            'leave_balances',
            'kpi_evaluations',
            'meeting_participants',
            'activity_work_logs',
            'activity_daily_summaries',
            'activity_weekly_summaries',
            'activity_screenshots',
            'activity_errors',
            'activity_health_checks',
            'employee_locations',
            'employee_mfa',
            'mfa_recovery_codes',
            'mfa_attempts',
            'status_events',
            'push_subscriptions',
            'upload_sessions',
            'message_receipts'
          ];

          for (const tbl of tablesWithEmpId) {
            try {
              await dbConn.query(`DELETE FROM \`${tbl}\` WHERE employee_id NOT IN (?, ?)`, [gaganId, chetanId]);
            } catch {
              // Ignore if table does not exist
            }
          }

          try { await dbConn.query('DELETE FROM task_comments WHERE author_id NOT IN (?, ?)', [gaganId, chetanId]); } catch { }
          try { await dbConn.query('DELETE FROM tasks WHERE created_by NOT IN (?, ?) AND NOT EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = tasks.id AND ta.employee_id IN (?, ?))', [gaganId, chetanId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('DELETE FROM ticket_comments WHERE author_id NOT IN (?, ?)', [gaganId, chetanId]); } catch { }
          try { await dbConn.query('DELETE FROM tickets WHERE requester_id NOT IN (?, ?)', [gaganId, chetanId]); } catch { }
          try { await dbConn.query('DELETE FROM messages WHERE sender_id NOT IN (?, ?)', [gaganId, chetanId]); } catch { }
          try { await dbConn.query('DELETE FROM internal_emails WHERE sender_id NOT IN (?, ?) AND recipient_id NOT IN (?, ?)', [gaganId, chetanId, gaganId, chetanId]); } catch { }
          try { await dbConn.query('DELETE FROM activity_audit_logs WHERE actor_id NOT IN (?, ?)', [gaganId, chetanId]); } catch { }
          try { await dbConn.query('DELETE FROM calls WHERE caller_id NOT IN (?, ?) AND callee_id NOT IN (?, ?)', [gaganId, chetanId, gaganId, chetanId]); } catch { }

          // Delete all other employees except Gagan C B and Chetan TK
          await dbConn.query('DELETE FROM employees WHERE id NOT IN (?, ?)', [gaganId, chetanId]);

          // Ensure Gagan has Super Admin and Store Manager roles in employee_roles
          await dbConn.query(
            `INSERT IGNORE INTO employee_roles (employee_id, role_id)
             SELECT ?, id FROM roles WHERE slug IN ('super_admin', 'admin', 'store_manager', 'general_manager', 'executive')`,
            [gaganId]
          );

          await dbConn.query('SET FOREIGN_KEY_CHECKS = 1');
          console.log(`[startup] Retained Gagan C B (ID: ${gaganId}) and Chetan TK (ID: ${chetanId}) and reset credentials to Workforce@2026.`);
        } finally {
          try { await dbConn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch { }
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
          const { DailyTaskService } = await import('./services/DailyTaskService.js');
          await DailyTaskService.ensureTemplatesExist();
        } catch (tplErr) {
          console.warn('[startup] Master SOP task template check note:', tplErr);
        }
        // Ensure email delivery and mailbox schema readiness
        try {
          const colCheckDeliveries = await queryOne<{ cnt: number | string }>(
            "SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'email_deliveries' AND column_name = 'sender_id'",
          );
          if (!colCheckDeliveries || Number(colCheckDeliveries.cnt) === 0) {
            await execute(
              "ALTER TABLE email_deliveries MODIFY status ENUM('queued', 'sending', 'sent', 'accepted', 'failed', 'skipped', 'delivered') NOT NULL DEFAULT 'queued'",
            );
            await execute(`ALTER TABLE email_deliveries
              ADD COLUMN sender_id BIGINT UNSIGNED NULL AFTER id,
              ADD COLUMN cc_emails TEXT NULL AFTER recipient_name,
              ADD COLUMN bcc_emails TEXT NULL AFTER cc_emails,
              ADD COLUMN body_text MEDIUMTEXT NULL AFTER payload,
              ADD COLUMN body_html MEDIUMTEXT NULL AFTER body_text,
              ADD COLUMN attachments JSON NULL AFTER body_html`);
            await execute('CREATE INDEX idx_email_sender_created ON email_deliveries (sender_id, created_at)');
          }
        } catch (e) {
          console.warn('[startup] email_deliveries schema update note:', e);
        }

        try {
          const colCheckInternal = await queryOne<{ cnt: number | string }>(
            "SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'internal_emails' AND column_name = 'recipient_email'",
          );
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
        } catch (e) {
          console.warn('[startup] internal_emails schema update note:', e);
        }
      } catch (schemaErr) {
        console.warn('[startup] Schema readiness note:', schemaErr);
      }
      if (config.isProd) {
        const { findDemoPasswordAccounts } = await import('./db/seed.js');
        const exposed = await findDemoPasswordAccounts();
        if (exposed.length) {
          console.error(`[startup] SECURITY: ${exposed.length} active account(s) still use the published demo password (${exposed.join(', ')}). Change these passwords or deactivate the accounts immediately.`);
        }
      }
      const empCount = await queryOne<{ cnt: number | string }>('SELECT COUNT(*) AS cnt FROM employees');
      if (!empCount || Number(empCount.cnt) === 0) {
        console.log('[startup] Employees table empty. Seeding initial accounts...');
        const { seedBasicData } = await import('./db/seed.js');
        await seedBasicData();
        console.log('[startup] Initial accounts seeded successfully.');
      }
    }
  } catch (err) {
    console.error('[startup] Could not verify/initialize database schema:', err);
  }
}

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => console.error('[process] unhandled promise rejection', reason));
  try {
    await recoverPendingInstallation();
  } catch (err) {
    console.error('[startup] Could not recover pending installation; continuing.', err);
  }
  const app = createApp();
  try {
    await FileService.ensureStorage();
  } catch (err) {
    console.error('[startup] Could not prepare upload storage; uploads may fail.', err);
  }

  const server = http.createServer(app);
  initRealtime(server);

  if (needsSetup()) {
    configStore.setupCode();
    console.log(`[setup] Open /setup. Read the one-time installation code from ${path.join(configStore.directory, 'setup-code')}.`);
    onSetupCompleted(startJobs);
  } else {
    try {
      await queryOne('SELECT 1 AS ok');
      void ensureDatabaseReady();
      startJobs();
    } catch (err) {
      console.error('[startup] MySQL is currently unavailable. Server will continue running and retry connection.', err);
      const interval = setInterval(async () => {
        try {
          await queryOne('SELECT 1 AS ok');
          clearInterval(interval);
          console.log('[startup] MySQL connection established. Background jobs started.');
          void ensureDatabaseReady();
          startJobs();
        } catch {
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
  } else {
    console.log('  Email: SMTP not configured — delivery unavailable');
  }

  const rawPort = process.env.PORT;
  const isPassenger = (typeof (global as any).PhusionPassenger !== 'undefined') ||
    rawPort === 'passenger' ||
    (typeof rawPort === 'string' && (rawPort.startsWith('/') || rawPort.startsWith('\\\\.\\pipe\\')));

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[server] HTTP server listen error:', err);
  });

  if (isPassenger) {
    const target = (rawPort && rawPort !== 'passenger') ? rawPort : 'passenger';
    server.listen(target, () => {
      console.log(`\n  ${config.appName} API ready under Passenger / LiteSpeed socket: ${target}`);
      console.log(`  Environment: ${config.env} · Timezone: ${config.timezone}`);
      console.log(`  Health: /api/health\n`);
    });
  } else {
    const PORT = Number(process.env.PORT) || config.port || 3000;
    server.listen(PORT, () => {
      console.log(`\n  ${config.appName} API ready on port ${PORT}`);
      console.log(`  Environment: ${config.env} · Timezone: ${config.timezone}`);
      console.log(`  Health: /api/health\n`);
    });
  }

  const shutdown = (signal: string) => {
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
    } catch (listenErr) {
      console.error('[startup] Could not bind emergency server:', listenErr);
    }
  });
}
