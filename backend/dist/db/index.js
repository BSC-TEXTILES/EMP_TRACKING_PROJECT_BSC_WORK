import mysql from 'mysql2/promise';
import { retryDeadlock } from '../lib/deadlockRetry.js';
import { config } from '../config.js';
function createPool() {
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
export let pool = createPool();
export async function reloadPool() { const old = pool; pool = createPool(); await old.end(); }
export async function query(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
}
export async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows.length > 0 ? rows[0] : null;
}
export async function execute(sql, params = []) {
    const [result] = await pool.query(sql, params);
    return result;
}
export async function txQuery(conn, sql, params = []) {
    const [rows] = await conn.query(sql, params);
    return rows;
}
export async function txQueryOne(conn, sql, params = []) {
    const rows = await txQuery(conn, sql, params);
    return rows.length > 0 ? rows[0] : null;
}
export async function txExecute(conn, sql, params = []) {
    const [result] = await conn.query(sql, params);
    return result;
}
/**
 * Runs a unit of work inside a real MySQL transaction with automatic rollback.
 */
export async function transaction(work, options = {}) {
    return retryDeadlock(() => runTransaction(work), options.retryDeadlocks ? 2 : 0);
}
async function runTransaction(work) {
    const conn = await pool.getConnection();
    try {
        await conn.query("SET time_zone = '+00:00'");
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
    }
    catch (error) {
        try {
            await conn.rollback();
        }
        catch {
            /* connection already broken */
        }
        throw error;
    }
    finally {
        conn.release();
    }
}
/** Atomically increments a named daily-style counter used for human readable IDs. */
export async function nextSequence(conn, key) {
    await conn.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES (?, '0')
     ON DUPLICATE KEY UPDATE setting_value = setting_value`, [key]);
    const rows = await txQuery(conn, 'SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE', [key]);
    const current = Number.parseInt(rows[0]?.setting_value ?? '0', 10) + 1;
    await conn.query('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [String(current), key]);
    return current;
}
export async function closePool() {
    await pool.end();
}
//# sourceMappingURL=index.js.map