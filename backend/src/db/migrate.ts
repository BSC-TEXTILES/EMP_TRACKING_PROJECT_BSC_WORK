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
