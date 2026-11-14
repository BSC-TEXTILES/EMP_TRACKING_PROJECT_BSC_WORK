# EMP_TRACKING_PROJECT_BSC_WORK

# Workforce — employee management

React/TypeScript frontend, Express API and MySQL persistence for employee records, attendance, tasks, projects, daily reports, communication, tickets, meetings, leave and KPI workflows.

## Configure through the website

Use [the setup guide](docs/WEBSITE_SETUP.md). Database, SMTP, company and first-administrator details are entered at `/setup`. After installation, enter departments, designations, locations, leave policies and employees through the website. No demo accounts appear on the login page, and normal setup does not seed sample business records.

```sh
npm install
npm run build
npm start
```

For local development use `.env.local` with `WEB_SETUP_ENABLED=true`. Open http://localhost:4000/setup and read the one-time code from `backend/storage/config/setup-code`. The operator must provide an empty MySQL database and actual SMTP credentials. For production, use `.env.production.example`, HTTPS, a durable private configuration directory and Node 22.12+, 24 or 26. The template uses emp.bsctextiles.in; the public deployment has not been verified.

Saved credentials are encrypted outside the web root. The setup flow creates only the administrator and organization records entered by the user, plus system role/permission definitions and editable policy defaults. Backup and recovery instructions are in [WEBSITE_SETUP.md](docs/WEBSITE_SETUP.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | API and frontend development servers |
| `npm run build` | Compile both applications |
| `npm start` | Serve compiled frontend and API |
| `npm run typecheck` | Type-check both workspaces |
| `npm test` | Automated tests; use an isolated local test database |
| `npm run db:migrate` | Apply migrations to an already configured installation |
| `npm run db:setup` | Create schema only; no sample records |
| `npm run db:seed:demo` | Explicit sample data for disposable development databases only; production is blocked |

## Verification

37 tests pass. Coverage includes fresh-database installation with no demo activity, administrator login, business read APIs, organization entry, encrypted configuration, SMTP test/save, OTP logging and concurrency, session rotation, ticket persistence and file authorization. SMTP setup tests use mocks and malware-scanner tests use a protocol stub. Type checks and production builds pass. The dependency audit reports zero known vulnerabilities at this verification; this is not a security certification.

The local setup page was inspected in a browser. Actual provider connectivity, email receipt, deployment TLS, ClamAV, mobile workflows and full enterprise acceptance remain to be verified. See [ENTERPRISE_ACCEPTANCE.md](docs/ENTERPRISE_ACCEPTANCE.md). The complete original specification is not declared finished.

## Deployment files

- `.env.production.example`: server settings for website-managed setup.
- `deploy/nginx.conf`: HTTPS/API/WebSocket routing template for emp.bsctextiles.in.
- `deploy/clamd.conf.example`: private scanner configuration.
- `docs/EMAIL_CONFIGURATION.md`: administrator SMTP and OTP workflow.
- `docs/JWT_SESSION_MANAGEMENT.md`: rotating sessions.
- `docs/MALWARE_PROTECTION.md`: fail-closed uploads and current format restrictions.

Run one application instance until shared rate limits, durable event processing and distributed job coordination are implemented. Existing development records are preserved; the local app is now gated by setup until a fresh database is configured.
