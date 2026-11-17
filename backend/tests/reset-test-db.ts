import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

/** Drops and recreates the TEST database only. Refuses anything not named like a test database. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('reset-test-db runs only with NODE_ENV=test');
  const name = config.db.database;
  if (!/test/i.test(name) || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Refusing to reset "${name}": not a test database name.`);
  const connection = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`[test-db] recreated ${name}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('[test-db] reset failed:', (error as Error).message);
  process.exit(1);
});
