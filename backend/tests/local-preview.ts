// Local-only preview using the isolated test database; never starts production jobs.
process.env.NODE_ENV = 'test';
process.env.WEB_SETUP_ENABLED = 'false';
process.env.APP_ORIGIN = 'http://localhost:4000,http://localhost:3000,http://localhost:5173';
process.env.SMTP_HOST = '';
const { createApp } = await import('../src/index.js');
const { initRealtime } = await import('../src/realtime/io.js');
const { createServer } = await import('node:http');
const server = createServer(createApp());
initRealtime(server);
server.listen(4000, '127.0.0.1', () => console.log('Local test app: http://localhost:4000 — isolated test data only'));
