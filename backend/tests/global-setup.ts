import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runTsx(args: string[]): void {
  const tsx = path.resolve(backendDir, '../node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  execFileSync(process.platform === 'win32' ? `"${tsx}"` : tsx, args, {
    cwd: backendDir,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

/**
 * Rebuilds the dedicated test database (TEST_DATABASE_URL; its name must
 * contain "test") from scratch on every run: drop, create, apply every
 * migration and load the disposable demo dataset. Each run therefore starts
 * from a known state, and src/config.ts refuses to start in test mode against
 * any non-test database, so real data can never be touched.
 */
export default function setup(): void {
  runTsx(['tests/reset-test-db.ts']);
  runTsx(['src/db/seed.ts', '--demo']);
}
