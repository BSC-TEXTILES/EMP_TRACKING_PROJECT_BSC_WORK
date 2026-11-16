import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prepares the dedicated test database (TEST_DATABASE_URL, name must contain
 * "test"): creates it when permitted, applies every migration and loads the
 * disposable demo dataset the API tests rely on. Never touches real data —
 * src/config.ts refuses to start in test mode without a test database.
 */
export default function setup(): void {
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tsx = path.resolve(backendDir, '../node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  execFileSync(tsx, ['src/db/seed.ts', '--demo'], {
    cwd: backendDir,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
