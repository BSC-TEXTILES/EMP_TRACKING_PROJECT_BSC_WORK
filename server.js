/**
 * Root entrypoint for hosting platforms (Hostinger Node.js, cPanel, etc.)
 * Starts the Workforce backend application with fail-safe error diagnostics.
 */
import http from 'node:http';
import fs from 'node:fs';

const rawPort = process.env.PORT;
const port = rawPort && !isNaN(Number(rawPort)) ? Number(rawPort) : (rawPort || 4000);

try {
  const entry = new URL('./backend/dist/index.js', import.meta.url);
  if (!fs.existsSync(entry)) {
    throw new Error('backend/dist/index.js not found on server disk.');
  }
  await import(entry.href);
} catch (startupError) {
  const errMessage = startupError?.stack || String(startupError);
  console.error('[server] Fatal backend startup error:\n', errMessage);
  
  try {
    fs.writeFileSync('server-error.log', `[${new Date().toISOString()}]\n${errMessage}\n`);
  } catch {
    // Ignore log write failure
  }

  // Start emergency diagnostic server so the host never receives a 503
  try {
    const diagnosticServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url && req.url.startsWith('/api/')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Backend startup failure on hosting server',
          code: 'startup_failure',
          message: startupError?.message || String(startupError),
          hint: 'Check database connectivity and hosting panel environment variables.',
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Workforce Startup Error</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:40px;background:#f8fafc;color:#1e293b;}h1{color:#dc2626;}pre{background:#1e293b;color:#f8fafc;padding:16px;border-radius:8px;overflow-x:auto;}</style></head><body><h1>Workforce Backend Startup Error</h1><p>The application encountered an error while starting:</p><pre>${errMessage}</pre></body></html>`);
      }
    });

    if (typeof port === 'string' && (port === 'passenger' || port.startsWith('/') || port.startsWith('\\\\.\\pipe\\'))) {
      diagnosticServer.listen(port);
    } else {
      diagnosticServer.listen(Number(port));
    }
    console.log(`[server] Emergency diagnostic server running on port/socket: ${port}`);
  } catch (listenError) {
    console.error('[server] Could not start diagnostic server:', listenError);
  }
}
