/**
 * Root entrypoint for hosting platforms (Hostinger Node.js, cPanel, etc.)
 * Starts the compiled Workforce backend application.
 */
import fs from 'node:fs';

const entry = new URL('./backend/dist/index.js', import.meta.url);
if (!fs.existsSync(entry)) {
  console.error('[server] backend/dist/index.js not found. Set the build command to "npm run build" in the hosting panel.');
  process.exit(1);
}

import(entry.href).catch((err) => {
  console.error('[server] Failed to start backend:', err);
  process.exit(1);
});
