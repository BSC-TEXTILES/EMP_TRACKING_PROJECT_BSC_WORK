import mysql from 'mysql2/promise';
import { config } from '../config.js';
const dbName = /^[A-Za-z0-9_]+$/.test(config.db.database) ? config.db.database : null;
if (!dbName) {
    throw new Error('DB_NAME must contain only letters, digits and underscores');
}
const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
});
await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await connection.end();
console.log(`[db:create] database ${dbName} ready on ${config.db.host}:${config.db.port}`);
//# sourceMappingURL=create-database.js.map