import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
const c = await mysql.createConnection({host:config.db.host,port:config.db.port,user:config.db.user,password:config.db.password,database:config.db.database,connectTimeout:5000});
try {
 const [tables] = await c.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('employee_sessions','employee_login_audit','monitoring_sessions','leave_requests','schema_migrations')");
 console.log(JSON.stringify(tables));
 const [migrations] = await c.query('SELECT filename FROM schema_migrations ORDER BY filename'); console.log(JSON.stringify(migrations));
} finally { await c.end(); }
