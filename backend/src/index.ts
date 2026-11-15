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
  app.set('trust proxy', process.env.TRUST_PROXY === 'loopback' ? 'loopback' : false);
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
  const clientDir = path.resolve(here, '../../frontend/dist');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
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

async function main(): Promise<void> {
  await recoverPendingInstallation();
  const app = createApp();
  await FileService.ensureStorage();

  const server = http.createServer(app);
  initRealtime(server);

  if (needsSetup()) {
    configStore.setupCode();
    console.log(`[setup] Open /setup. Read the one-time installation code from ${path.join(configStore.directory, 'setup-code')}.`);
    onSetupCompleted(startJobs);
  } else {
    try { await queryOne('SELECT 1 AS ok'); }
    catch { console.error('[startup] MySQL is unavailable. Verify server configuration.'); process.exit(1); }
    startJobs();
  }

  const envReport = validateEnvironment();
  logEnvironmentReport(envReport);
  if (!envReport.ok && config.isProd && !needsSetup()) {
    console.error('[startup] configuration errors must be fixed before serving production traffic');
    process.exit(1);
  }

  if (config.smtp.configured) {
    const { smtpStatus } = await import('./lib/mailer.js');
    const status = await smtpStatus(true);
    console.log(`  Email: SMTP ${status.reachable ? 'verified' : 'UNREACHABLE'} (${status.host}:${status.port})`);
  } else {
    console.log('  Email: SMTP not configured — delivery unavailable');
  }

  server.listen(config.port, process.env.BIND_HOST ?? '127.0.0.1', () => {
    console.log(`\n  ${config.appName} API ready on http://localhost:${config.port}`);
    console.log(`  Environment: ${config.env} · Timezone: ${config.timezone}`);
    console.log(`  Health: http://localhost:${config.port}/api/health\n`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n[shutdown] ${signal} received, closing server`);
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => console.error('[process] unhandled promise rejection', reason));
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
