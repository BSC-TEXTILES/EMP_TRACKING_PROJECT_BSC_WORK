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

For local development use `.env.local` with `WEB_SETUP_ENABLED=true`. Open http://localhost:4000/setup and read the one-time code from `backend/storage/config/setup-code`. The operator must provide an empty MySQL database and actual SMTP credentials. For production, use `.env.production.example`, HTTPS, a durable private configuration directory and Node 22.12+, 24 or 26. The template uses emptrack.bsctextiles.in; the public deployment has not been verified.

Saved credentials are encrypted outside the web root. The setup flow creates only the administrator and organization records entered by the user, plus system role/permission definitions and editable policy defaults. Backup and recovery instructions are in [WEBSITE_SETUP.md](docs/WEBSITE_SETUP.md).

## Coarena Model API

The backend includes `CoarenaService` for OpenAI-compatible text completions and reply feedback. Set `COARENA_API_KEY` to a real key in `.env.local` for development or the server environment / `.env.production` for deployment, then restart the backend. Never use a `VITE_` variable for this secret. The default model is `gpt-6-luna`; override it with `COARENA_MODEL` using an ID from https://coarena.ai/api/v1/models. Requests use https://coarena.ai/api/v1 with a configurable `COARENA_TIMEOUT_MS` (default 60000).

Use from backend code:

```ts
import { CoarenaService } from './services/CoarenaService.js';

const reply = await CoarenaService.complete([
  { role: 'user', content: 'Help draft a short project update.' },
]);
// Submit only the rating actually selected by the user.
await CoarenaService.feedback({ request_id: reply.requestId, rating: 'up' });
// rating: 'down' gives negative feedback; null removes a previous rating.
```

Feedback also supports provider-defined `tags` and a `note` of at most 2,000 characters. Missing credentials return a configuration error when AI is called, while ordinary app startup remains available. Provider failures are sanitized and requests are not automatically retried. This is a backend integration; no AI screen or automatic transfer of workforce records is enabled. Authenticated live completion and feedback still require a real key. See [Coarena's API documentation](https://coarena.ai/docs).

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

56 tests pass. Coverage includes fresh-database installation with no demo activity, administrator login, business read APIs, organization entry, encrypted configuration, SMTP test/save, OTP logging and concurrency, session rotation and refresh-token reuse detection, ticket persistence, file authorization, collection creation/approval with hierarchy scope, activity monitoring (consent, device registration, session gating, batched ingestion, duplicate rejection, sanitized diagnostics, automatic incident tickets, daily summaries, weekly scoring, monthly reports, timestamp validation, retention dry runs, concurrent employees and permission/device ownership checks), profile photo upload, development-login gating and environment validation. SMTP setup tests use mocks and malware-scanner tests use a protocol stub. Type checks and production builds pass. The dependency audit reports zero known vulnerabilities at this verification; this is not a security certification.

The local setup page was inspected in a browser. Actual provider connectivity, email receipt, deployment TLS, ClamAV, mobile workflows and full enterprise acceptance remain to be verified. See [ENTERPRISE_ACCEPTANCE.md](docs/ENTERPRISE_ACCEPTANCE.md). The complete original specification is not declared finished.

## Deployment files

- `.env.production.example`: server settings for website-managed setup.
- `.env.development`: non-secret development defaults, including the runtime-only test-login panel.
- Profile photos: `POST /api/me/photo` (multipart, ≤5 MB PNG/JPEG/WebP/GIF); the profile page offers click, drag-and-drop and mobile camera capture with client-side square cropping. Uploaded avatars appear across tasks, chat, projects, meetings and the sidebar.
- `docs/ACTIVITY_MONITORING.md`: consent-based activity monitoring, agent, browser bridge, incidents and weekly performance.
- `agent/`: Windows desktop monitoring agent (`npx tsx agent/src/index.ts`, see `agent/README.md`).
- `browser-extension/`: Manifest V3 approved-domain bridge, loaded unpacked on managed browsers.
- `docs/COLLECTIONS.md`: collection register, approval workflow, permissions and exports.
- `docs/ENVIRONMENT.md`: environment files, validation and secret management.
- `deploy/nginx.conf`: HTTPS/API/WebSocket routing template for emptrack.bsctextiles.in.
- `deploy/clamd.conf.example`: private scanner configuration.
- `docs/EMAIL_CONFIGURATION.md`: administrator SMTP and OTP workflow.
- `docs/JWT_SESSION_MANAGEMENT.md`: rotating sessions.
- `docs/MALWARE_PROTECTION.md`: fail-closed uploads and current format restrictions.

Run one application instance until shared rate limits, durable event processing and distributed job coordination are implemented. Existing development records are preserved; the local app is now gated by setup until a fresh database is configured.
