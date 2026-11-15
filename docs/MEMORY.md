> Current update (14 November 2026): website-managed first-run setup and encrypted administrator SMTP/OTP configuration are implemented. See WEBSITE_SETUP.md and EMAIL_CONFIGURATION.md; these supersede earlier environment-only SMTP and demo-seeding instructions below. Normal setup creates no sample business records. Dependencies were upgraded; npm audit reports zero known vulnerabilities. 37 tests pass. The full enterprise specification and production deployment are not declared complete.

# Project memory

This file is the durable context for anyone (human or agent) continuing the project.

## 1. Original objective

Build an enterprise workforce platform from an empty folder: authentication, hierarchy, attendance, tasks, daily reporting, WhatsApp-style chat, tickets, notifications, calendar, real WebRTC meetings, KPI evaluation, leave, HR, projects, analytics, PWA and full documentation — fully integrated, database-backed, real-time, role-aware and documented. No hardcoded statistics; every action persisted.

## 2. Decisions and why

| Decision | Rationale |
|---|---|
| Express + React SPA (not Next.js) | Single Node process hosts REST + Socket.IO + static SPA; no SSR/HMR complexity; one origin in production |
| npm workspaces (`backend`, `frontend`) | Shared lockfile, simple scripts, clear separation without a monorepo tool |
| MySQL 8 with SQL migrations | Required relational design; FKs/indexes/transactions; migrations are plain, reviewable SQL |
| JWT in httpOnly cookie + DB session row | Stateless verification with immediate revocation; no tokens in JS |
| UTC storage, `Asia/Kolkata` business dates | Avoids DST/timezone drift; `Intl` computes local dates on the server |
| In-process cron instead of BullMQ | Redis was unavailable; `job_runs` provides observability; upgrade path documented |
| In-memory rate limiting | Single instance; documented limitation |
| KPI weight redistribution | Missing data must never be scored as poor performance |
| PWA instead of React Native | Requirement allows PWA; one codebase, same API, installable |
| `@rollup/wasm-node` aliased as `rollup` | This machine's application-control policy blocks Rollup's native binary; wasm keeps build/dev working |

## 3. Conventions

- Services are classes with static methods, one file per domain, no SQL in routes.
- Routes only parse/validate input (Zod), call a service, and shape the response.
- All timestamps ISO UTC from `toIso`; dates `YYYY-MM-DD`.
- Pagination returns `{ items, total, page, pageSize }`.
- Permission codes follow `module.action[.scope]` (`tasks.view.team`, `kpi.publish`).
- Audit every sensitive mutation with `recordAudit({actorId, action, entityType, entityId, before, after, ip})`.
- Socket events use `entity:event` names; payloads mirror REST DTOs.
- Frontend pages own their data fetching; shared DTOs live in `frontend/src/lib/types.ts`.
- Never hardcode counts in UI; render API values, including zero.

## 4. Module status

### Completed
- Schema (≈50 tables) + migrations 001–003, applied.
- Auth: login (code/email/mobile), lockout, failed-attempt tracking, OTP login, MFA flag, sessions, registration + dual OTP verification + HR approval, password reset/change, login history, session revocation.
- Hierarchy, roles, permission matrix, per-user grants, department/designation/location management, org chart.
- Attendance: check-in/out, breaks, heartbeat, today/history/summary, late/early/overtime/half-day, auto-close, corrections + approval, team view, leave marking.
- Tasks: creation with checklist/recurrence/multi-assignee, full action workflow, subtasks, comments, time logs, reminders, overdue sweep, reassignment, calendar view, exports.
- Daily reports: suggestions from live tasks, submit, review, history, exports.
- Chat: direct/group/channel, announcement groups, attachments, replies, reactions, edit/delete, receipts, typing, presence, search, unread counters, group membership management.
- Tickets: categories, SLA by priority, auto team assignment, workflow, comments/internal notes, escalation, feedback, reopen, stats.
- Meetings: schedule/invite/respond, join tracking, action items, outcome, meeting chat, reminders, WebRTC signalling and TURN config.
- KPI: configurable weights, generation, transparent per-parameter scores, review with overrides, publish, comments, history/trend, team/department comparisons.
- Leave: types, balances, apply with validation, two-stage approval, cancel, holidays.
- Projects: create, members, milestones, statuses, linked tasks, project conversation.
- Notifications: per-user notifications, real-time delivery, announcements with audience resolution, read/delete, bulk read.
- Analytics/admin: overview with filters, exports (CSV/XLSX/PDF), settings, audit log, job history, system health.
- Frontend: design system, shell, 19 pages, PWA assets, responsive layouts.
- Email: centralized env configuration, 12 HTML templates, queue with retry/backoff, delivery log, SMTP verification, admin page with test send and retry, notification fan-out (chat excluded), OTP direct delivery.
- Collections: register with derived status, approval workflow, hierarchy scope, dashboard, Excel/PDF export, permissions.
- Environment: `.env.development`/`.env.example`/`.env.production.example`, frontend templates, startup validation service and `/admin/environment`.
- Development login: runtime-only seeded account panel gated out of production; access JWT 15 min with rotating refresh tokens and reuse detection.
- Tests: 50 tests across 5 files passing; typecheck and production build passing.

### Pending / not built
- React Native client (PWA is the mobile deliverable).
- Web Push (needs VAPID keys) and SMS provider credentials.
- Redis cache/queue and distributed rate limiting.
- Payroll calculations, statutory reports, multi-tenant mode.
- Automated browser E2E suite (manual QA matrix documented).

## 5. Known issues / caveats

- OTP, email and SMS fall back to development mode (codes returned in the API response) when SMTP/SMS credentials are absent. Never enable that behaviour in production.
- SMTP delivery was verified end-to-end against a local SMTP stub, not against a commercial provider; sender-domain SPF/DKIM/DMARC and inbox rendering must be checked after configuring production credentials.
- `.env.local` at the workspace root holds non-secret development defaults; `backend/.env` still supplies this machine's database and JWT values. `.env.production` must be created on the server and never committed.
- Seed demo accounts share one password; rotate or delete before real use.
- Meeting media requires HTTPS (or localhost) for camera/microphone; TURN is needed for restrictive networks.
- WebSocket presence is in-memory: a restart clears presence (clients reconnect and resync).
- `job_runs` grows unbounded; add retention cleanup for long deployments.
- The KPI dashboard shows the latest generated period; generating a new month is a deliberate action.
- Local environment needs the Rollup wasm alias (see README) because of the host's application-control policy.

## 6. Operational notes

- Timers **must** be computed from server timestamps; do not "fix" them with `Date.now()` deltas only.
- Do not introduce `PORT=0` handling regressions: invalid/zero ports fall back to 4000.
- MySQL reserved words must be aliased (e.g. `leave_days`, not `leave`).
- JSON columns come back already parsed from mysql2; use safe parse helpers for legacy string rows.
- Sequence counters (`task_no_seq`, `ticket_no_seq`, `project_seq`, `employee_code_seq`) must be seeded/upserted above existing maxima to avoid duplicate human-readable IDs.
- `npm run db:seed -- --reset` wipes only transactional demo data; it never truncates employees or configuration.

## 7. Future improvements

1. Redis + BullMQ for background jobs and rate limiting; move exports to workers.
2. Web Push with per-user subscriptions and notification preferences UI.
3. Geofence enforcement per location (currently opt-in capture only).
4. Attendance payroll export and shift roster planning.
5. Full-text search across messages/tasks/tickets.
6. React Native app reusing the same REST/Socket.IO contracts.
7. Observability: structured logs, metrics, tracing, alerting on job failures and SLA breaches.


## Enterprise security increment — 14 November 2026

This update is not full enterprise acceptance. See ENTERPRISE_ACCEPTANCE.md for the outstanding requirements.
Migrations 005–007 introduce rotating refresh tokens, upload scan state and ticket issue details. Access JWTs last 15 minutes; POST /api/auth/refresh rotates an HttpOnly refresh cookie without extending the session deadline. Existing pre-upgrade sessions must sign in again. GET /api/live is liveness; /api/ready and /api/health provide generic database readiness.
Uploads now fail closed unless ClamAV is configured; existing unscanned files are unavailable. Office/archive uploads are blocked pending bounded inspection. Ticket creation accepts validated issueDetails and up to ten owned, clean attachments. Production NGINX and scanner templates are under deploy/. SMTP remains environment-configured. See the new JWT_SESSION_MANAGEMENT, MALWARE_PROTECTION, HELPDESK_SYSTEM and PRODUCTION_TESTING documents for details.
