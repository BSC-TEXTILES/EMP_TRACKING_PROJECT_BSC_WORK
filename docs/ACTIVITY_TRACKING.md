# User Activity Tracking — engine, API, deployment and test report

This module replaces the previous, non-functional tracking pipeline. It covers the
Windows tracking agent, the browser connector, the backend engine, the database and
the **User Activity Tracking** pages in the HRMS.

Related: [TRACKING_AGENT.md](TRACKING_AGENT.md) (build, install, update, repair and
uninstall the Windows agent) and [browser-extension/README.md](../browser-extension/README.md).

---

## 1. Root-cause analysis (why tracking did not work)

Before this change, no activity had ever been stored: `application_usage_logs`,
`employee_activity_events`, `employee_devices` and every related table had 0 rows.

| # | Defect | Effect |
|---|--------|--------|
| 1 | The agent's foreground-window sampler used the PowerShell 7 ternary operator `?:`, but the agent calls Windows PowerShell 5.1. Each sample failed to parse and the error was swallowed. | No application was ever detected, so no application events were produced. |
| 2 | The installer wrote `agent-data/config.json`, but the agent never read it. The agent required `WORKFORCE_EMAIL`/`WORKFORCE_PASSWORD` environment variables and depended on a web-session cookie on every tick. | An installed agent exited at start-up. A manually started one stopped when the session cookie expired. |
| 3 | The local state was encrypted with a key derived from the token stored inside it. | After a restart the agent could not read its own token. It re-registered, and earlier offline events became unreadable. |
| 4 | A batch with any rejected event was kept forever (e.g. "Microsoft PowerPoint" vs the allow-list's "PowerPoint"). | One unapproved application blocked the upload queue permanently. |
| 5 | Ingestion required a session started from the web app, plus attendance check-in, and rejected events older than the current session. | Events replayed after going offline were rejected. |
| 6 | The heartbeat updated five columns of `employee_tracking_status` that do not exist, inside a `catch {}`. | Live status was never updated, so everyone appeared offline. |
| 7 | The dashboard derived "active" time from attendance minutes, used `web = active × 0.4` and always showed 0 idle. It ignored the date filter and reported 0 sync errors. | The dashboard showed made-up numbers. |
| 8 | `POST /activity/user-details/:id/sync-events` let a browser session insert "agent" activity for itself, or for anyone if the caller was an administrator. `/activity/liveguard/*` returned hard-coded CPU figures and invented malware detections. | Fabricated data could appear as real data. |
| 9 | HRMS page tracking posted to an endpoint that discarded data unless a legacy session existed (it never did). | HRMS navigation was never recorded. |

**Changes:** the fabricated endpoints were removed and the broken legacy installers
now return `410 Gone`. The legacy heartbeat column bug was fixed. The old details
modal now redirects to the new details page. The new pipeline described below
replaces the rest.

## 2. Architecture

```
Windows PC (per Windows user)                       HRMS server                         Browser (HR/Admin)
┌──────────────────────────────┐   HTTPS + device   ┌───────────────────────────────┐   session   ┌─────────────────────┐
│ BSCActivityTracker.exe (tray)│ ─ token (Bearer) ─▶│ /api/tracking/agent/*         │ ◀── auth ──▶│ /activity-tracking  │
│  • 1 s native sampling       │                    │  enroll · heartbeat · events  │             │  list · details     │
│  • idle/lock/sleep detection │                    │  acknowledge · unenroll       │  Socket.IO  │  devices · alerts   │
│  • DPAPI offline queue       │                    │ TrackingWorker (cron, 1 min)  │ ──────────▶ │  settings · reports │
│  • 127.0.0.1:47613 bridge ◀──┼── Browser connector│  offline sweep · alerts       │             └─────────────────────┘
└──────────────────────────────┘   (domain only)    │  retention + archive (nightly)│
                                                    │ MySQL: tracking_* tables      │
                                                    └───────────────────────────────┘
```

* **Intervals, not samples.** The agent emits contiguous, non-overlapping intervals
  `activity{state: active|idle|locked, app, browser, domain}`, normally rolled over
  every 60 s, plus point events: session start/end, lock/unlock, idle start/end,
  suspend/resume and agent start/stop. Idle time is back-dated to the last keyboard
  or mouse input, so durations are exact rather than shifted by the threshold.
* **The server computes durations** from timestamps and never trusts client-supplied
  totals. A device clock that is more than 60 s off is corrected using the batch's `sentAt`.
* **Idempotency.** Each event carries an agent-generated id. `UNIQUE (employee_id,
  client_event_id)` together with `INSERT IGNORE` means a retried upload or an offline
  replay is counted once and reported as `duplicates`.
* **Per-event rejection.** An invalid event is rejected with a reason and dropped by
  the agent. It can never block the queue.
* **One source of truth.** The dashboard, details page and Excel/PDF reports use the
  same query functions (`dayStats`, `buildDay`), so exported figures match the screen.
* **Background processing.** The scheduler runs `tracking_offline_sweep` every minute.
  It marks devices whose heartbeat stopped as offline, closes their sessions, writes
  `device_offline` timeline events and sends notifications. Retention runs nightly
  at 02:40 IST. No dashboard tab needs to be open.

## 3. Data collected, and what is never collected

| Collected (when enabled by policy) | Never collected |
|---|---|
| Foreground application name and process name | Keystrokes or key counts |
| Active, idle and locked intervals | Passwords, clipboard, form data |
| Lock/unlock, sleep/wake and Windows sign-in/out | Screenshots, screen contents, files |
| Website **domain** of the active tab (with the browser connector) | Full URLs, paths, queries, page titles, page contents |
| HRMS page (route) and active seconds | Microphone, camera, incognito tabs |
| Window titles: **off by default** (`windowTitleTrackingEnabled`) | |

Collection starts only after the employee acknowledges the monitoring notice on the
device. The server rejects events from devices that have not acknowledged it. The tray
icon is always visible while the agent runs. Employees can see their own data at
`/activity-tracking/<their id>`.

## 4. Database (migration `056_tracking_engine.sql`)

The migration is **additive only**: no existing table is dropped, truncated or rewritten.

| Table | Purpose | Key indexes |
|---|---|---|
| `tracking_settings` | Global row plus per-location overrides (`NULL` = inherit) | `scope_key` unique, `location_id` |
| `tracking_enrollment_codes` | One-time codes (SHA-256 hash only, 72 h) | `code_hash` unique, `(employee_id, created_at)` |
| `employee_devices` *(existing, +`hostname`, +`registered_via`)* | Device registry and device→employee mapping | `machine_fingerprint` unique |
| `device_registrations` *(existing)* | Hashed device tokens (730 days, auto-rotated) | `token_hash` unique |
| `tracking_device_status` | Live state per device: heartbeat, sync, pending, failures, notice | `employee_id`, `last_heartbeat_at` |
| `tracking_sessions` | Agent sessions, with agent-generated ids (safe for offline replay) | `(device_id, client_session_id)` unique, `(employee_id, work_date)` |
| `tracking_events` | Observed intervals and point events | `(employee_id, client_event_id)` unique, `(employee_id, work_date, event_type)`, `(work_date, employee_id)`, `(device_id, started_at)`, `session_id` |
| `tracking_heartbeats` | Heartbeat history | `(device_id, received_at)`, `(employee_id, received_at)` |
| `tracking_sync_batches` | Upload/offline-replay record (attempts, accepted, duplicates, rejected) | `(device_id, batch_id)` unique |
| `activity_audit_logs` *(existing)* | Audit of enrollment, revocation, settings, detail views, exports, retention | |

All `DATETIME` values are UTC (the pool forces `time_zone = '+00:00'`). `work_date` is
the Asia/Kolkata date of the event, and the UI always renders times in IST.

**Migration guide:** migrations run automatically at API start-up
(`npm run db:migrate` runs them manually). Back up the database first. No downtime is
needed. The only `ALTER` adds two nullable/defaulted columns to `employee_devices`.

## 5. Access control

Tracking reuses the HRMS permission model for every view, detail page and export:

| Role (default) | Scope |
|---|---|
| Super Admin / Company Owner (`activity.view.all` + `locations.view.all`) | All locations |
| HR / Location Manager (`activity.view.all`, no `locations.view.all`) | Their location(s), plus any extra locations in `employee_locations` / `location_hr_assignments` |
| Manager (`activity.view.team`) | Their reporting subtree |
| Employee (`activity.view.own`) | Only their own details and report |
| Device management | `activity.devices.manage`: enrollment codes, revoke (default: IT Admin, Super Admin) |
| Settings | `activity.policy.manage`. Global settings and retention also require all-location access. |

Realtime events (`tracking:update`, `tracking:alert`) are sent only to the employee,
their management chain, and `view.all` holders whose locations include the employee.

## 6. API

### Agent (device token: `Authorization: Bearer bsct_…`)

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/tracking/agent/enroll` | `{enrollmentCode, deviceUid, hostname, osName?, osVersion?, agentVersion}` → `{deviceId, deviceToken, employee, config, noticeText}`. No token needed. Rate-limited to 20 per 10 min per IP. |
| POST | `/api/tracking/agent/acknowledge` | Records the employee's acknowledgement of the monitoring notice |
| POST | `/api/tracking/agent/heartbeat` | `{state, currentApp?, currentBrowser?, currentDomain?, pendingEvents, droppedEvents, syncFailures, lastError?, agentVersion, sessionId?, sessionStartedAt?, extensionSeenAt?, trackingPaused?, sentAt}` → `{trackingEnabled, noticeRequired, noticeText, config, employee, update, newToken?}` |
| POST | `/api/tracking/agent/events` | `{batchId, sentAt, events[≤500]}`. Each event is `{id, type, sessionId?, start, end?, state?, app?, process?, title?, browser?, domain?, detail?}` → `{accepted, duplicates, rejected:[{id, reason}]}` |
| POST | `/api/tracking/agent/unenroll` | Called by the uninstaller; retires the token |

Event `type`: `activity`, `web`, `session_start`, `session_end`, `lock`, `unlock`,
`idle_start`, `idle_end`, `suspend`, `resume`, `agent_start`, `agent_stop`,
`tracking_disabled`, `tracking_enabled`.

Rejection reasons: `invalid_event`, `future_timestamp`, `too_old`, `invalid_interval`,
`interval_too_long` (more than 3,900 s), `missing_state`, `invalid_domain`,
`website_tracking_disabled`, `notice_not_acknowledged`.

### Web (HRMS session)

| Method | Path | Permission |
|---|---|---|
| GET | `/api/tracking/overview?date&location&status&search&sort&order&page&pageSize` | `view.team` / `view.all` (scoped) |
| GET | `/api/tracking/employees/:id?date` | Self, team or permitted location (audited) |
| GET | `/api/tracking/alerts` | `view.team` / `view.all` |
| GET | `/api/tracking/devices[?employeeId]` · POST `/api/tracking/devices/:id/revoke` | Scoped / `devices.manage` |
| GET/POST/DELETE | `/api/tracking/enrollment-codes[/:id]` | `devices.manage` (or self when self-enrollment is on) |
| GET/PUT | `/api/tracking/settings` | `view.all` / `policy.manage` |
| GET | `/api/tracking/reports/export?format=xlsx\|pdf&from&to&employeeId\|location` | Scoped; at most 31 days and 2,500 employee-days |
| POST | `/api/tracking/retention` `{dryRun}` | `policy.manage` with all-location access |
| POST | `/api/tracking/web/page` | Any signed-in user (own HRMS page usage) |
| GET | `/api/tracking/agent/download` | Signed-in; serves the built installer |

`status` filters: `active`, `idle`, `locked`, `offline`, `not_installed`, `sync_error`, `disabled`.

## 7. Configuration

**Admin UI:** *User Activity Tracking → Settings*. Settings are global, with optional
per-location overrides, and every change goes through a confirmation dialog and is
audited. The settings are: tracking on/off, device registration, self-enrollment,
application tracking, website tracking, window titles, idle threshold (60–3600 s),
heartbeat (15–600 s), sync (10–600 s), offline-after, latest and minimum agent
version, retention (7–1095 days) and the monitoring notice text. Agents pick up
changes at their next heartbeat.

**Environment** (see `.env.example`): `TRACKING_AGENT_INSTALLER` is an optional path to
the installer served by `/api/tracking/agent/download`. It defaults to
`tracking-agent/dist/BSC-Activity-Tracker-Setup.exe`.

**Retention:** a nightly job archives expired rows to
`storage/tracking-archive/<timestamp>/*.jsonl.gz` and then deletes them in chunks.
Use Settings → Retention → Preview to see what would be affected first.

## 8. Notifications

* **Top-right toasts** (existing HRMS toast design) appear for supervisors when an
  employee's agent disconnects, at most one per employee every 10 minutes.
* **Persistent HRMS notifications** are sent for: an agent disconnected while the
  employee is checked in, and uploads failing for 30 minutes or more. Each is
  deduplicated per device per day.
* **The Alerts tab** lists: disconnected agents, stopped agents, sync errors,
  checked-in employees with no registered device, outdated agents, and unacknowledged
  notices.
* **Logs:** the server logs rejection counts by reason (never event content). The
  agent logs states, counts and errors only, with no application names, domains or
  tokens, and keeps 14 days.

## 9. Production deployment checklist

1. Back up the database. Deploy the backend; migration 056 applies on start.
2. `npm run build` builds the frontend and backend.
3. Build the agent: `powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1 -Server https://emptrack.bsctextiles.in -SignCertThumbprint <thumbprint>`.
   **Code signing is required in practice:** Windows Smart App Control and WDAC
   block unsigned executables (verified on the development PC).
4. Copy `tracking-agent/dist/BSC-Activity-Tracker-Setup.exe` to the server, at the
   default path or the one set in `TRACKING_AGENT_INSTALLER`.
5. Serve the API over HTTPS. The agent refuses non-HTTPS servers except loopback.
6. Deploy the agent (`Setup.exe /install /quiet`) and the browser connector (Chrome/Edge
   enterprise policy), then issue enrollment codes from *Devices & enrollment*.

## 10. Testing report

### Automated (all passing)

**Command:** `npm --workspace backend run test`. **Result: 28 test files, 205 tests
passed**, including the existing HRMS suites (leave, attendance, RBAC, tasks, email
and others), which confirms no regressions.

`backend/tests/tracking-engine.test.ts` has 28 tracking tests. They run over the real
HTTP API against the disposable test database, with test employees in BEL, DAV and SHI:

* **Authentication.** Missing or forged tokens get 401. Enrollment maps the device to
  the right employee. Tokens are stored only as hashes. A used code cannot be reused.
  Only device managers can issue codes for other employees, and self-enrollment is
  off by default.
* **Ingestion.** Events are rejected until the notice is acknowledged. A full work day
  is stored exactly once, and a retried batch reports every event as a duplicate.
  URLs are reduced to hostnames. Invalid events (future, too long, missing state,
  malformed, unknown type such as keystrokes) are rejected individually while valid
  ones are accepted. A 10-minute device clock skew is corrected. Offline replay is
  accepted.
* **Calculations.** Exact active, idle and locked seconds; observed span; untracked
  gap with reason ("Computer asleep"); 75% completeness; longest active and idle
  runs; per-application active and idle-in-app time; website domain, time and visits;
  timeline order.
* **Dashboard.** Status buckets (idle, active, not installed), location filter,
  sorting, and login time all match the details page.
* **RBAC.**
  * A location admin sees only DAV, and gets 403 on BEL details and BEL reports.
  * A manager sees only their team.
  * An employee sees only themselves, gets 403 on the overview, others' data,
    location reports and settings, and can download their own report.
  * Unauthenticated requests get 401.
* **Reports.** The Excel workbook has 7 sheets, and its *Active (seconds)*, *Idle
  (seconds)* and *Completeness* values equal the dashboard's. PDF generation works,
  and range validation rejects bad ranges.
* **Settings.** Only policy managers can change them, and values are validated. A
  location override disables tracking for DAV only and can be cleared again. Every
  change is audited.
* **Worker and device lifecycle.**
  * A silent device becomes offline, its session closes with `heartbeat_lost`, and a
    `device_offline` event is written. On the next heartbeat the device recovers, the
    session reopens and `device_online` is written.
  * Alerts are scoped.
  * Reassigning a device needs an administrator-issued code (409 otherwise).
  * A revoked device is refused immediately.
  * Retention dry run deletes nothing.
  * Uninstall unenrolls the device.

### Builds

* Frontend production build: passed (`vite build`).
* Backend production build: passed (`tsc`).
* Frontend typecheck: passed.
* Windows agent and installer: compiled with the .NET Framework 4.8 C# compiler (`build.ps1`).

### UI verification (headless Chrome, test database)

The UI was checked against the disposable test database, populated through the real
HTTP pipeline (enroll → acknowledge → upload → heartbeat) for 10 employees across BEL,
DAV and SHI:

* The list, details, devices, alerts and settings pages render with no console errors
  and no horizontal overflow at 1440 px and 390 px.
* Figures shown on the list page match the details page.

### Not verified, and why

| Item | Reason |
|---|---|
| Running the Windows agent and installer on a real PC: foreground detection, idle, lock/unlock, sleep, offline queue, restart, install/repair/uninstall | **Smart App Control is On** on the development PC and blocked the unsigned executable (`Code Integrity event 3077`). Bypassing a security policy was not attempted. Sign the build (`-SignCertThumbprint`) and run the checklist in [TRACKING_AGENT.md](TRACKING_AGENT.md#test-checklist) on a company PC. The server side of these flows is covered by the tests above. |
| Browser connector in Chrome/Edge | Needs the agent running. Verify with the same checklist. |
| Load with many devices | Not load-tested. On-the-fly aggregation is indexed and suited to the current scale (around 60 employees). |

## 11. Known limitations

* **Windows only.** There is no macOS or Linux agent.
* **Overlapping devices.** If one employee is active on two computers at the same
  moment, both are counted.
* **Day boundary.** An interval that crosses midnight IST is assigned to the day it
  started. The error is at most one interval, normally 60 s or less.
* **Website domains need the browser connector.** It covers Chromium browsers
  (Chrome, Edge, Brave, Opera, Vivaldi). Without the connector, browser time still
  appears as application time. On shared PCs with several simultaneous Windows
  sessions, only the first session's agent receives connector reports.
* **No silent auto-update.** Agents are told when an update is available or required;
  re-run the signed installer (`/install /quiet`) to update.
* **Employees can exit the tray app.** This is a deliberate transparency choice. The
  exit is recorded as `agent_stop`, and the device then shows as offline with an alert.
* **Legacy tables are untouched.** The pre-existing tables from migrations 010–053 and
  the legacy `agent/` remain for history but are no longer used by User Activity Tracking.
