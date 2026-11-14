# TESTING.md — test strategy and results

## 1. Layers

| Layer | Tooling | Scope |
|---|---|---|
| Type checking | `tsc --noEmit` (both workspaces) | Compile-time safety across API and UI |
| Integration/API | Vitest + Supertest against the real app and MySQL | Auth, RBAC, workflows, persistence, audit |
| Build | `vite build`, backend `tsc` | Production bundling and server compilation |
| Manual QA | Browser walkthrough | Rendering, navigation, realtime, responsive layout |

## 2. Running the suite

```bash
# prerequisites: MySQL running, migrations + seed applied, backend/.env configured
npm --workspace backend run test
npm run typecheck
npm run build
```

The suite boots the Express app in-process (`NODE_ENV=test` skips the listener and cron), uses the same services and database as production code, and cleans up records it creates. The test environment raises only the login rate-limit ceiling (`LOGIN_RATE_LIMIT_MAX=200` in `vitest.config.ts`) because the suite performs many sign-ins from one address; production keeps the stricter default.

## 3. Automated tests (18, all passing)

`backend/tests/api.test.ts` — 19 cases, all passing:

**Authentication & session security**
- rejects unauthenticated dashboard access
- rejects an invalid password without revealing whether the account exists
- rejects state-changing requests from a foreign origin
- issues a session that can be revoked by logging out
- blocks an employee from administration endpoints

**RBAC and hierarchy scope**
- limits a manager to their own reporting subtree when listing employees
- prevents a manager from allocating work outside the reporting structure

**Attendance**
- refuses a second check-in while a session is already open
- resumes the elapsed timer from persisted server timestamps
- returns a numeric attendance summary with a real percentage

**Tasks**
- runs allocate → accept → start → submit → approve with persistence
- rejects an invalid workflow transition

**KPI**
- exposes weighted parameters totalling 100%
- returns per-parameter scores and excludes unavailable metrics

**Reports, tickets, chat, audit**
- returns live task suggestions for the daily report form
- shows employees only their own or assigned tickets
- rejects a non-member from reading a conversation
- records an audit entry for privileged settings changes and lists it
- queues, processes and reports a transactional email without exposing credentials

Latest run: `Test Files 1 passed (1)` · `Tests 19 passed (19)` · duration ≈ 9 s.

## 4. Manual QA matrix

| Area | Check | Status |
|---|---|---|
| Login | password login, demo account, invalid password message | Verified |
| Dashboard | server attendance state, running timer, team snapshot, KPI card, notifications | Verified |
| Navigation | SPA route changes between modules | Verified (programmatic) |
| Attendance | check-in/out, refresh recovery, duplicate prevention | Verified (API + UI state) |
| Tasks | create, accept, progress, submit, approve | Verified (API) |
| Reports | suggestions, submit, manager review | Verified (API) |
| Chat | send/receive, unread counters, attachments | API + WebSocket paths verified; two-peer UI not exercised |
| Tickets | create, assign, resolve, feedback | Verified (API) |
| Meetings | schedule, invite, join, signalling | Signalling and ICE config verified; live two-party media not exercised in this environment |
| KPI | generate, review, publish | Verified (API) |
| Exports | CSV/XLSX/PDF download | Endpoint verified |
| Responsive UI | 360px → desktop layouts | Layout implemented; not exhaustively click-tested |
| PWA | manifest, service worker, install prompt | Assets served; install flow not exercised |

## 4a. Email verification (this delivery)

| Check | Result |
|---|---|
| SMTP variables load from the environment and compose the sender (`SMTP_FROM_NAME` + `SMTP_FROM_EMAIL`) | Verified |
| Live SMTP handshake (`verify()`) reported on the admin page and at startup | Verified against a local SMTP stub |
| Test message delivered, recorded as `sent` with `message_id` | Verified |
| Task allocation queued a `task_assigned` email for the assignee | Verified |
| Queue worker processed messages; without SMTP they became `skipped` with a reason | Verified |
| Retry of a skipped message delivered it and flipped it to `sent` | Verified |
| Failure is contained: business write succeeded before any mail attempt | Verified |
| Real commercial provider + inbox rendering (Outlook/Gmail) | Not verified — needs production credentials |

Reproduce locally with the bundled stub:

```bash
node backend/tests/smtp-stub.mjs 2525
# then run the API with SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_FROM_EMAIL=no-reply@workforce.test
```

## 5. Gaps and how to close them

- **Two-browser realtime/WebRTC test:** open two authenticated sessions, place a call, confirm audio/video and screen share. Requires two devices or two browser profiles with camera permissions.
- **Email/SMS delivery:** requires real SMTP/SMS credentials; without them the API returns development codes.
- **Load/performance:** run k6/artillery against dashboard, attendance heartbeat and chat send with seeded data; target p95 < 300 ms at 200 concurrent users.
- **Browser E2E:** add Playwright against the built app for login → check-in → task lifecycle. Not included in this delivery.
- **Accessibility:** axe-core scan and keyboard-only pass on the main dashboards.

## 6. Known environment limitation

The host's application-control policy blocks Rollup's native binary, so the repository aliases `rollup` to `@rollup/wasm-node`. Builds and the dev server work; if your environment permits native modules you may remove the alias and reinstall for faster builds.

## 7. Definition of done used for this delivery

- Type checks pass for backend and frontend.
- Production build completes.
- All automated tests pass against a live MySQL database.
- Every module writes to the database, and dashboards read from it.
- Documentation covers setup, schema, API, RBAC, workflows, security, deployment, testing and mobile.
- Remaining unverified items are stated explicitly rather than claimed as tested.
