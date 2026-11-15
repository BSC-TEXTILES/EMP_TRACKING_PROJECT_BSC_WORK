/**
 * Root entrypoint for hosting platforms (Hostinger Node.js, cPanel, etc.)
 * Starts the compiled Workforce backend application.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distFile = path.resolve(here, 'backend/dist/index.js');

if (fs.existsSync(distFile)) {
  await import('./backend/dist/index.js');
} else {
  console.error('[server] Fatal error: backend/dist/index.js does not exist.');
  console.error('[server] Please run: npm run build');
}
