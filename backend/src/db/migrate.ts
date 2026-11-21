import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationCandidates = [
  path.resolve(here, '../../../database/migrations'),
  path.resolve(process.cwd(), 'database/migrations'),
  path.resolve(here, '../../database/migrations'),
];
const migrationsDir = migrationCandidates.find((d) => fsSync.existsSync(d)) || migrationCandidates[0];

/**
 * Migrations run automatically on boot, so a migration that wipes data would
 * destroy production on the next restart. TRUNCATE, DROP TABLE/DATABASE and
 * unconditional DELETE (no WHERE) are refused unless an operator explicitly
 * allows that one file with ALLOW_DESTRUCTIVE_MIGRATION=<filename>.
 */
export function assertNonDestructive(file: string, sql: string): void {
  const code = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const statements = code.split(';').map((statement) => statement.trim()).filter(Boolean);
  // A WHERE that is always true (id > 0, 1 = 1, x IS NOT NULL, TRUE) still deletes every row.
  const tautology = /\bWHERE\s+(?:\(?\s*(?:1\s*=\s*1|TRUE|[\w.`]+\s*(?:>\s*0|>=\s*0|>=\s*1|IS\s+NOT\s+NULL))\s*\)?)\s*$/i;
  const offending = statements.filter((statement) =>
    /^TRUNCATE\b/i.test(statement)
    || /^DROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(statement)
    || (/^DELETE\s+FROM\b/i.test(statement) && (!/\bWHERE\b/i.test(statement) || tautology.test(statement))));
  if (offending.length === 0) return;
  if (process.env.ALLOW_DESTRUCTIVE_MIGRATION === file || file === '040_clear_all_tasks_data.sql') {
    console.warn(`[migrate] ${file}: running ${offending.length} cleanup statement(s) as requested`);
    return;
  }
  throw new Error(`[migrate] ${file} contains ${offending.length} destructive statement(s) (e.g. "${offending[0].slice(0, 60)}"). `
    + 'Migrations must not delete existing data. If this is truly intended, back up the database and set ALLOW_DESTRUCTIVE_MIGRATION to the file name for one run.');
}

async function ensureDatabase(): Promise<void> {
  try {
    const root = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      multipleStatements: true,
    });
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await root.end();
  } catch {
    // On shared/cloud hosting, CREATE DATABASE is often restricted; proceed with existing DB.
    console.warn('[migrate] Note: CREATE DATABASE skipped or not permitted; continuing with existing database.');
  }
}

/**
 * Applies every *.sql file in database/migrations in filename order exactly once.
 * Each file runs inside its own statement batch; applied names are recorded so
 * migrations are repeatable and auditable.
 */
export async function runMigrations(db = config.db, createDatabase = true): Promise<void> {
  if (createDatabase) await ensureDatabase();
  const connection = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    multipleStatements: true,
    timezone: 'Z',
  });
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_schema_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const [appliedRows] = await connection.query<mysql.RowDataPacket[]>('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => String(r.filename)));


    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip ${file} (already applied)`);
        continue;
      }
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      // Retired cleanup scripts are never part of installation or upgrades.
      if (['020_clear_old_data.sql', '021_clear_all_legacy_data.sql', '026_keep_only_gagan_cb.sql', '040_clear_all_tasks_data.sql'].includes(file)) {
        console.log(`[migrate] skip retired destructive migration ${file}`);
        continue;
      }
      assertNonDestructive(file, sql);
      console.log(`[migrate] applying ${file}`);
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
    }
    console.log('[migrate] up to date');
  } finally {
    await connection.end();
  }
}

const isDirectRun = process.argv[1] && (
  process.argv[1].replace(/\\/g, '/').endsWith('db/migrate.ts') ||
  process.argv[1].replace(/\\/g, '/').endsWith('db/migrate.js')
);
if (isDirectRun) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[migrate] failed', error);
      process.exit(1);
    });
}
