# Environment configuration

All configuration is read from environment variables. No credential, SMTP password, API key or signing secret is stored in source code, the database or the frontend bundle.

## 1. Files

| File | Tracked | Purpose |
|---|---|---|
| `.env.example` | Yes | Complete reference of every supported variable |
| `.env.development` | Yes | Non-secret development defaults (`TEST_LOGIN_*`, URLs, rate limits) |
| `.env.local` | No (git-ignored) | Machine-specific development overrides |
| `.env.production` | No (git-ignored) | Server secrets; `chmod 600`, owned by the app user, or injected by a secret manager |
| `.env.production.example` | Yes | Production template with placeholders |
| `backend/.env` | No | Legacy location, supported for existing installations, lowest precedence |
| `frontend/.env.example` | Yes | Build-time client variables (`VITE_*`) — **never secrets** |

Load order (first value wins): environment-specific root file → `backend/.env` → root `.env`. In production, `.env.production` is selected even when `NODE_ENV` is only defined inside it.

`.gitignore` ignores `.env`, `.env.*`, `backend/.env*` and `frontend/.env`, while keeping the templates (`!.env.example`, `!.env.production.example`, `!.env.development`, `!frontend/.env.example`).

## 2. Variable groups

| Group | Variables |
|---|---|
| Application | `NODE_ENV`, `PORT`, `APP_NAME`, `APP_URL`, `FRONTEND_URL`, `BACKEND_URL`, `APP_ORIGIN`, `APP_TIMEZONE`, `LOG_LEVEL` |
| Database | `DATABASE_URL` or `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_POOL_SIZE` |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`, `SMTP_REPLY_TO` |
| OTP | `OTP_EXPIRY_MINUTES`, `OTP_RESEND_COOLDOWN_SECONDS`, `OTP_MAX_ATTEMPTS` |
| Sessions | `JWT_SECRET`, `SESSION_SECRET`, `COOKIE_SECRET`, `SESSION_TTL_DAYS`, `INTERNAL_JOB_SECRET` |
| Redis | `REDIS_URL` (optional; single-instance fallback documented) |
| WebSocket | `WEBSOCKET_URL` (empty = same origin) |
| Storage | `STORAGE_PROVIDER`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `UPLOAD_DIR`, `MAX_UPLOAD_MB` |
| Web push | `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` (reserved) |
| Rate limiting | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` |
| Meetings | `MEETING_PROVIDER`, `MEETING_API_KEY`, `MEETING_API_SECRET`, `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` |
| Development login | `TEST_LOGIN_ENABLED`, `TEST_LOGIN_PASSWORD` (ignored in production) |

`JWT_REFRESH_SECRET` is reserved: refresh tokens are opaque random values whose SHA-256 hashes are stored server-side, so no second signing key is required.

## 3. Validation

`backend/src/lib/envValidation.ts` runs at startup and on `GET /api/admin/environment` (permissioned). It reports one of `ok`, `warn`, `error` per capability:

- database host/name/user present, password warning in production;
- JWT secret strength (≥ 32 chars, not the development default);
- SMTP configured, parseable sender, authentication warning;
- Redis URL scheme when set, warning when unused;
- upload directory exists and is writable;
- application URL absolute and HTTPS in production, origins valid and not localhost in production;
- explicit WebSocket URL scheme when set;
- development login disabled in production.

The report contains labels and remediation text only — never values. Production with any `error` refuses to start; development logs warnings and continues. Startup prints a one-line summary plus each warning/error.

## 4. Test login

`GET /api/auth/test-accounts` returns seven seeded demo accounts (Super Admin, HR Manager, Department Manager, IT Support, Developer, Employee, Store Manager) with employee code, name, email and the development password. It returns `404` when `NODE_ENV=production` or `TEST_LOGIN_ENABLED=false`. The login page fetches it at runtime, so no password is compiled into the frontend bundle, and the panel is absent whenever the endpoint is unavailable.

## 5. Production secret management

1. Create `.env.production` on the server from `.env.production.example`; `chmod 600`, owned by the service user, outside the repository.
2. Generate independent secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
3. Alternatively inject the same names from your platform's secret manager and skip the file.
4. Set `TEST_LOGIN_ENABLED=false` (the API ignores it in production anyway).
5. Confirm `GET /api/admin/environment` reports 0 errors after deployment.
6. Rotate `JWT_SECRET`/`SESSION_SECRET`/`COOKIE_SECRET` by deploying the new value and accepting that existing sessions are invalidated.

Never commit `.env*` files, print their contents in chat, or expose them through the SPA. The built frontend only contains `VITE_*` values, which must never be secrets.
