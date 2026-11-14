import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { retryDeadlock } from '../lib/deadlockRetry.js';
import { config } from '../config.js';

function createPool(): Pool {
 const result = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true,
  decimalNumbers: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Every pooled connection runs with a UTC session so NOW()/CURRENT_TIMESTAMP
// always produce trusted UTC server timestamps regardless of host timezone.
result.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

return result;
}
export let pool: Pool = createPool();
export async function reloadPool(): Promise<void> { const old = pool; pool = createPool(); await old.end(); }

export type SqlParams = ReadonlyArray<unknown>;

export async function query<T = RowDataPacket>(sql: string, params: SqlParams = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params as unknown[]);
  return rows as T[];
}

export async function queryOne<T = RowDataPacket>(sql: string, params: SqlParams = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function execute(sql: string, params: SqlParams = []): Promise<ResultSetHeader> {
  const [result] = await pool.query(sql, params as unknown[]);
  return result as ResultSetHeader;
}

export async function txQuery<T = RowDataPacket>(conn: PoolConnection, sql: string, params: SqlParams = []): Promise<T[]> {
  const [rows] = await conn.query(sql, params as unknown[]);
  return rows as T[];
}

export async function txQueryOne<T = RowDataPacket>(conn: PoolConnection, sql: string, params: SqlParams = []): Promise<T | null> {
  const rows = await txQuery<T>(conn, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function txExecute(conn: PoolConnection, sql: string, params: SqlParams = []): Promise<ResultSetHeader> {
  const [result] = await conn.query(sql, params as unknown[]);
  return result as ResultSetHeader;
}

/**
 * Runs a unit of work inside a real MySQL transaction with automatic rollback.
 */
export async function transaction<T>(work: (conn: PoolConnection) => Promise<T>, options: { retryDeadlocks?: boolean } = {}): Promise<T> {
  return retryDeadlock(() => runTransaction(work), options.retryDeadlocks ? 2 : 0);
}

async function runTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      /* connection already broken */
    }
    throw error;
  } finally {
    conn.release();
  }
}

/** Atomically increments a named daily-style counter used for human readable IDs. */
export async function nextSequence(conn: PoolConnection, key: string): Promise<number> {
  await conn.query(
    `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, '0')
     ON DUPLICATE KEY UPDATE setting_value = setting_value`,
    [key],
  );
  const rows = await txQuery<{ setting_value: string }>(conn, 'SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE', [key]);
  const current = Number.parseInt(rows[0]?.setting_value ?? '0', 10) + 1;
  await conn.query('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [String(current), key]);
  return current;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
