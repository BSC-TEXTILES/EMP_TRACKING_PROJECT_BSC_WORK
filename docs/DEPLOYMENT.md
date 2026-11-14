# Production deployment

The application requires Node 22.12+, 24 or 26, MySQL 8, HTTPS and persistent private disk storage. Use one application instance. Configure actual DNS and TLS for `emp.bsctextiles.in`; a domain in the template does not mean the site is deployed.

1. Install dependencies and build with `npm ci` and `npm run build`.
2. Copy `.env.production.example` to `.env.production` on the server only. Keep WEB_SETUP_ENABLED=true. Provision /srv/workforce/private-config (owner-only directory) and /srv/workforce/storage for the application account. The application generates a private master key and setup code unless an external master key is supplied.
3. Run `node backend/dist/index.js` under a service manager with NODE_ENV=production. Bind it to 127.0.0.1 behind the same-host reverse proxy.
4. Install `deploy/nginx.conf`, configure actual certificates, run `nginx -t`, and verify HTTPS/API/Socket.IO routing. The setup route permits a longer response timeout for schema installation.
5. Read the server's private setup-code file and enter that code at https://emp.bsctextiles.in/setup. Enter the real database, SMTP and administrator data there. The database must exist and be empty of employees. Schema installation requires CREATE/ALTER/INDEX/REFERENCES plus application read/write privileges; no CREATE DATABASE privilege is needed by the website installer.
6. Confirm email receipt and use the website to enter organization and employee records. Do not seed demo data. Existing databases are never cleared by setup.
7. Install and update a private ClamAV service before enabling uploads. No unscanned uploads are accepted. Optional TURN and SMS services require actual providers; no fake connectivity is reported.
8. Back up MySQL, private uploads, settings.enc and the encryption key. Protect the key separately and test recovery. Restrict private directory permissions on Linux or equivalent Windows ACLs.

Actual provider connectivity, remote database transport security, certificates, ClamAV and host capabilities require deployment verification. Shared hosting must explicitly support a persistent Node process and the necessary services; PHP-only hosting is insufficient. See WEBSITE_SETUP.md and ENTERPRISE_ACCEPTANCE.md for the remaining verification work.
