# Employee activity monitoring

Consent-based work activity, application usage, internal module usage, automatic incident tickets, daily activity summaries and transparent weekly performance. Data is written to the same MySQL database as attendance, tasks, reports, projects, tickets and KPI, and is exposed through the **Activity** section of the platform (`/activity`).

## 1. Privacy model

- Monitoring starts **only** when (a) the employee has acknowledged the active policy, (b) office attendance is checked in for today and not checked out, and (c) the employee starts a work session on a registered device.
- Only work metadata is stored: foreground application name/category/active seconds, approved work domains (hostname + title + duration), internal module paths, task/report/ticket metadata and sanitized technical errors.
- Never collected: keystrokes, clipboard contents, passwords, OTPs, private messages, personal accounts, page contents, form inputs or unapproved application content.
- Browser domains and applications are checked server-side against the policy allow-list; anything else is rejected before storage (`rejected` count in ingestion response).
- Diagnostics are recursively sanitized: keys matching `password`, `token`, `secret`, `cookie`, `otp`, `auth`, `session`, `card`, `clipboard` or `key` are removed, and string values are truncated.
- Screenshots are **disabled** and this build stores no image captures. The policy exposes a screenshot setting for future supported agents; evidence currently uses task/report attachments.
- Employees can read the policy, see their recorded activity, add corrections to the daily summary and withdraw consent (which ends the active session immediately).
- Retention is configurable (`retention_days`, default 90) and enforced by a nightly cleanup job; administrators can preview or run it manually. Monitoring stops whenever the work session ends, attendance is checked out, the device is revoked, or consent is withdrawn.

## 2. Database (migration `010_activity_monitoring.sql`)

`monitoring_policies`, `employee_activity_consents`, `employee_devices`, `device_registrations`, `monitoring_sessions`, `application_catalog`, `application_usage_logs`, `browser_usage_logs`, `browser_extension_devices`, `internal_module_activity`, `work_activity_events`, `activity_keywords`, `daily_activity_summaries`, `weekly_performance_reports`, `employee_activity_consents`, `screenshot_evidence`, `system_error_events`, `error_incidents`, `automatic_ticket_links`, `device_health_logs`, `activity_audit_logs`.

Every event row carries a unique `client_event_id`, so agent retries are idempotent (`INSERT IGNORE`; duplicates are reported instead of double-counted). Device tokens are stored as SHA-256 hashes with 180-day expiry; the raw token is returned once.

Seeded data: a default transparent policy (screenshots off, 90-day retention, 13 approved applications, 14 approved domains), an application catalogue and eight work-activity keywords.

## 3. Permissions

| Permission | Purpose |
|---|---|
| `activity.view.own` | Own dashboard, sessions, daily summary and weekly reports |
| `activity.view.team` | Reporting-subtree team activity and employee detail |
| `activity.view.all` | Organisation dashboards, incidents and devices |
| `activity.review` | Approve/return daily summaries, confirm suggested incident tickets, review/finalise weekly scores |
| `activity.devices.manage` | Register/revoke devices for the organisation |
| `activity.policy.manage` | Change retention, screenshot setting and approved domains |

Employees receive `view.own`; managers `view.team` + `review`; HR/executives `view.all`; IT administrators additionally manage devices and policy; super admins hold everything.

## 4. API

Session-authenticated:

| Method | Path | Notes |
|---|---|---|
| GET | `/activity/policy` | Active policy and the caller's consent state |
| POST | `/activity/consent` · `/activity/consent/revoke` | Acknowledge or withdraw consent (revocation ends sessions) |
| GET/POST | `/activity/devices` | List own devices; register returns a one-time `token` |
| DELETE | `/activity/devices/:id` | Revoke device and end its session |
| POST | `/activity/sessions/start` · `/stop` | Requires attendance check-in and consent; switching devices ends the old session |
| GET | `/activity/sessions/current` | Active session for the caller |
| POST | `/activity/module-activity` | Internal page usage while a session is active; excluded/auth pages ignored |
| GET | `/activity/dashboard?date=` | Employee view (session, apps, browser, modules, tasks, issues, tickets, weekly) |
| GET | `/activity/monthly?month=YYYY-MM` | Automatic monthly report for the caller plus visible employees |
| GET | `/activity/team?date=` · `/admin?date=` | Team and organisation views (permission checked) |
| GET | `/activity/employee/:id?date=` | Daily + weekly detail for a scoped employee |
| GET | `/activity/daily` · POST `/activity/daily/submit` · POST `/activity/daily/:id/review` | Generate, submit and review the daily summary |
| GET | `/activity/weekly` · POST `/activity/weekly/generate` · POST `/activity/weekly/:id/review` · POST `/activity/weekly/:id/feedback` | Weekly performance |
| GET | `/activity/errors` · POST `/activity/errors/:incidentId/ticket` | Incidents and manual confirmation of suggested tickets |
| POST | `/activity/client-error` | Sanitized failed platform operation while a session is active |
| POST | `/activity/retention/purge` | Preview/run retention cleanup (dry run by default) |
| PUT | `/activity/policy` | Policy configuration (audited) |
| GET | `/activity/audit` | Monitoring audit trail |

Device-authenticated (`X-Device-Token`, no employee session):

| Method | Path | Notes |
|---|---|---|
| POST | `/activity/agent/heartbeat` | Updates session/device liveness |
| POST | `/activity/agent/events` | Batch ingestion (max 200) of `app`, `browser`, `module`, `work`, `error` events |
| POST | `/activity/agent/health` | Device CPU/memory/disk snapshot |
| POST | `/activity/agent/extension` | Registers the browser bridge version |

## 5. Automatic technical errors and tickets

1. Agent sends a sanitized `error` event.
2. The server fingerprints `category|application|errorCode|module|description` and either creates an `error_incidents` row or increments the existing one.
3. A medium/low first occurrence is stored as `suggested` for employee/admin confirmation. **High/critical severity or the third occurrence** automatically opens a ticket through the existing helpdesk service with category mapping, SLA, least-loaded resolver assignment and technician notification.
4. The incident, error events and ticket are linked via `automatic_ticket_links`, `ticket_id` columns and `issue_details` (`source: activity_monitor`, sanitized diagnostics).

## 6. Daily, weekly and monthly calculations

Daily summary (regenerated on demand, preserving employee notes and review status):
attendance minutes from `attendance`, active minutes from foreground application events, module breakdown, tasks assigned/completed/pending and logged minutes, report summary lines, matched keywords, technical issues and tickets. The employee submits it; a manager approves or returns it.

Monthly report: aggregates the month's attendance days, monitored application time, completed tasks, submitted/approved daily summaries, incidents, tickets, key activities and weekly scores. Managers and administrators see the same figures for every employee in their permission scope. It is derived live, so a corrected task or report is reflected immediately.

Weekly score (weights match the specification): task completion 25, on-time delivery 20, work quality 20, attendance 10, daily reporting 10, project contribution 10, collaboration 5. Metrics come from `task_assignments`/`tasks`, `attendance`, `daily_work_reports`, `meeting_participants`, `messages` and project-linked tasks. Application duration is included as **context only** and explicitly excluded from the score. Preliminary reports are published for manager review; finalising sets status `final`.

## 7. Agent and browser bridge

- `agent/` — Windows-first TypeScript CLI agent (`npm start`): employee sign-in, device registration, attendance gate, foreground-application sampling via PowerShell `GetForegroundWindow` (process name and PID), AES-256-GCM encrypted local offline queue, heartbeat, Windows application-error detection, network-failure incidents, retry and automatic stop when the session/attendance ends. Rejected batches are dropped instead of retrying forever.
- `browser-extension/` — Manifest V3 bridge for Chrome/Brave/Edge/Firefox (Chromium load-unpacked): sends only active-tab hostname, title and duration with the device token; the server drops unapproved domains.
- Real-time: session start/stop, ingestion and error events emit Socket.IO events (`activity:session`, `activity:update`, `activity:error`) and the Activity page reloads accordingly.

## 8. Verification status

Verified in this environment (Windows host, development database):

- Attendance check-in → policy acknowledgement → device registration → session start → batch ingestion (accepted/rejected/duplicates) → dashboard/daily/weekly API → automatic ticket → manager review → session stop.
- Application foreground aggregation, process-id persistence, approved-domain filtering, blocked password-manager rejection, sanitized diagnostics (password/token removed), idempotent retries, future-timestamp rejection and invalid device token rejection are covered by `backend/tests/api.test.ts` (56 tests total).
- Monthly report totals, retention dry run, employee permission denial and cross-employee device registration conflicts are tested.
- Activity UI renders employee, weekly, monthly, team, organisation and policy tabs with real data; monitoring indicator, stop/start controls and the monthly team table work.
- The real agent was run on this Windows host after the changes: sign-in, encrypted device registration, policy/attendance gates, session start/stop and encrypted local state all succeeded. Foreground sampling correctly ignored the unapproved foreground application.

**Not verified:** the packaged desktop executable or signed installer on a real employee laptop, Windows foreground-window accuracy across elevated apps, extension behaviour inside a managed enterprise browser policy, macOS/Linux agents, continuous screenshot capture (intentionally absent), multi-employee concurrency under production load, and long-run offline replay. Do not represent those as tested until they are exercised on managed devices.
