# Website-managed setup and real business data

The installation page is `/setup`. On this workstation it is http://localhost:4000/setup. The production hostname in the deployment template is https://emp.bsctextiles.in; deployment to that hostname has not been performed here.

## First installation

1. The host operator provides a supported Node.js runtime (22.12+, 24 or 26), HTTPS reverse proxy, a private writable configuration directory and an empty MySQL database. A website cannot provision a hosting account or an external database without hosting-provider access.
2. Copy `.env.production.example` to the server's private `.env.production`. It now contains deployment settings, not database/SMTP credential placeholders. Keep `WEB_SETUP_ENABLED=true` and provision `WORKFORCE_CONFIG_DIR` outside the web root.
3. Start the application. It serves setup without connecting to the old/development database. The server creates `setup-code` in the private configuration directory; only the server operator should be able to read this file. This one-time code prevents public takeover of an unconfigured installation.
4. Open `/setup` and enter that code, company name, database connection, SMTP configuration and the first administrator's real details. SMTP must support implicit TLS or STARTTLS. Setup sends a test email to the administrator and requires SMTP acceptance. It cannot prove delivery to the inbox.
5. Setup installs migrations, permissions, role definitions, configurable system/KPI policies, and only the administrator, department and location supplied in the form. It does not seed employee activity, tasks, attendance, messages, meetings or tickets. Databases containing employees are refused; no existing database is cleared.
6. Sign in. Use **Organization data** for departments, designations, locations and leave policies; **Employees** for actual employees and reporting relationships; the existing business screens for tasks, projects, attendance, tickets, meetings and reports.

The local development database has been preserved. It is not displayed while the current local application is awaiting setup. Do not use its sample records as production records.

## Configuration persistence

Database and SMTP settings entered in the website are encrypted with AES-256-GCM in `settings.enc`. A 32-byte master key comes from `ENCRYPTION_MASTER_KEY` (64 hex characters) or an automatically generated `master.key`. Files are created with owner-only POSIX modes; provision equivalent ACLs on Windows. Credentials and the master key are not returned by any API. The default local directory is `backend/storage/config`, which is git-ignored. A production directory must remain outside the web root and have durable storage.

Back up the encryption key separately from the encrypted settings. Losing the key loses access to saved credentials. Do not copy development private configuration into production. A signing key is derived with a distinct HMAC context if no explicit JWT_SECRET is provided in website-setup mode. Replacing the master key without re-encryption invalidates settings.

An interrupted final installation uses an encrypted pending marker. On restart (or authorized retry), the server checks whether the administrator transaction committed before activating the installation. Do not run setup concurrently across multiple application processes. Run this deployment as a single instance.

## Email settings after installation

Open **Email delivery → Configure email and OTP**. Enter the settings and a test recipient, click **Test configuration**, confirm that the test was received, then click **Save verified configuration**. Test authorization is bound to the administrator and expires after ten minutes. Changing a field invalidates the browser's pending verification. Passwords are never loaded back; leaving the password blank retains it only for the same hostname and account. New delivery attempts immediately use the saved settings.

OTP codes are sent directly and never written to delivery-log payloads or console output. They are not eligible for queued retries, because delayed codes could be expired. Failed delivery returns an error rather than claiming a code was sent. OTP consumption locks the selected row, so a code cannot be consumed twice concurrently. SMS registration still requires an actual SMS provider; self-registration is disabled by default during fresh setup. Administrators can create employees through the website.

## Verification and limits

37 automated tests pass, including a fresh isolated MySQL installation, authorization gating, empty business tables, administrator login, major read APIs, organization creation, encrypted persistence, SMTP test/save flow, concurrent OTP consumption, and secret-free OTP delivery records. SMTP is mocked in the installation test; live Hostinger delivery and remote MySQL connectivity still require the credentials you enter. Uploads still require ClamAV; archive/Office scanning and other advanced enterprise requirements remain tracked in ENTERPRISE_ACCEPTANCE.md.
