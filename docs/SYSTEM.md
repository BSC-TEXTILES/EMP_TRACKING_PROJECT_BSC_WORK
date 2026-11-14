> Current update (14 November 2026): website-managed first-run setup and encrypted administrator SMTP/OTP configuration are implemented. See WEBSITE_SETUP.md and EMAIL_CONFIGURATION.md; these supersede earlier environment-only SMTP and demo-seeding instructions below. Normal setup creates no sample business records. Dependencies were upgraded; npm audit reports zero known vulnerabilities. 37 tests pass. The full enterprise specification and production deployment are not declared complete.

# System architecture

## 1. Shape of the system

```
Browser (React SPA + PWA)
  │  HTTPS (same origin in production)
  ├─ REST  /api/*            cookie-authenticated JSON
  ├─ WS    /socket.io        cookie-authenticated Socket.IO
  └─ Files /api/files/:id    permission-checked streaming
        │
        ▼
Express application (single Node process)
  ├─ security headers, rate limit, Origin guard, body limits
  ├─ /api routers → services → MySQL pool (transactions)
  ├─ Socket.IO server (presence, chat rooms, meeting rooms)
  ├─ node-cron scheduler (auto-close, reminders, overdue, KPI, cleanup)
  └─ static hosting of frontend/dist in production
        │
        ▼
MySQL 8 (InnoDB, FKs, indexes)
```

Why a single process: one deployable unit, one cookie domain, no cross-service auth, and Socket.IO shares the HTTP server. Services are separated by module so a future split (API + worker) is a deployment change, not a rewrite.

## 2. Module map

| Module | Service | Router | Key tables |
|---|---|---|---|
| Auth & sessions | `AuthService` | `auth` | employees, employee_sessions, login_history, otp_verifications |
| Dashboard | `DashboardService` | `me` | attendance, tasks, kpi, meetings, notifications |
| Attendance | `AttendanceService` | `attendance` | attendance, attendance_breaks, attendance_corrections, holidays |
| Tasks | `TaskService` | `tasks` | tasks, task_assignments, task_subtasks, task_comments, task_time_logs |
| Daily reports | `DailyReportService` | `reports` | daily_work_reports, daily_report_attachments |
| Chat | `ChatService` | `chat` | conversations, conversation_members, messages, message_receipts, message_reactions |
| Tickets | `TicketService` | `tickets` | tickets, ticket_comments, ticket_assignments, ticket_attachments |
| Meetings | `MeetingService` | `meetings` | meetings, meeting_participants, meeting_action_items, meeting_messages |
| KPI | `KpiService` | `kpi` | kpi_templates, kpi_parameters, employee_kpi_records, manager_reviews |
| Leave | `LeaveService` | `leave` | leave_types, leave_balances, leave_requests, holidays |
| Projects | `ProjectService` | `projects` | projects, project_members, project_milestones |
| Employees/HR | `EmployeeService` | `employees` | employees, roles, permissions, departments, designations, locations |
| Notifications | `NotificationService` | `notifications` | notifications, notification_recipients, announcements |
| Analytics | `AnalyticsService` | `analytics` | aggregate queries over all tables |
| Files | `FileService` | `files` | files |
| Exports | `ExportService` | `exports` | reads module data |
| Admin | — | `admin` | system_settings, audit_logs, job_runs |

## 3. API conventions

- Base path `/api`; JSON only (files streamed separately).
- Success: `200/201` with a resource or `{ items, total, page, pageSize }`.
- Errors: `{ "error": "human message", "code": "machine_code", "details": ... }`.
- Common codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `bad_request` (400), `conflict` (409), `rate_limited` (429), `error` (500, message intentionally generic).
- Validation via Zod at the route boundary; services re-check business rules.
- All timestamps are ISO-8601 UTC strings; the browser formats them.
- Lists accept `page`/`pageSize`; caps enforced server-side.

## 4. Authentication flow

```
POST /api/auth/login {identifier, password}
  ├─ rate limit + lockout check
  ├─ resolve employee by code/email/mobile, bcrypt compare
  ├─ if MFA/OTP required → create otp_verification, return {requiresOtp, challenge}
  │     └─ POST /auth/login/otp/send → POST /auth/login/otp/verify
  └─ create session row (hashed token id) → set httpOnly cookie
GET /api/auth/me → user + effective permissions (role ∪ grants − denies)
```

- The JWT carries `sub` (employee id) and `sid` (session id). Middleware verifies the signature and confirms the session row is active and unexpired, so logout/revocation is immediate.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, path `/`.
- The frontend never stores tokens in JS-accessible storage.

## 5. Attendance flow

```
POST /attendance/check-in   → reject if an open record exists for today
                            → insert (work_date, check_in_at = NOW(3), status, is_late)
POST /attendance/break/start|end → attendance_breaks rows; break minutes subtracted
POST /attendance/heartbeat  → returns authoritative state (serverNow, elapsedSeconds)
GET  /attendance/today      → same state shape used by the timer
POST /attendance/check-out  → total_minutes, overtime, early departure, status
cron  attendance_autoclose  → closes stale sessions after the grace window (flagged)
```

The browser computes `elapsed = elapsedSeconds + (Date.now() - receivedAt)/1000`, re-anchored on every heartbeat. Closing the tab, refreshing or reconnecting never resets the timer because the source of truth is `check_in_at`.

## 6. Task allocation flow

```
Manager → POST /tasks
  ├─ assertCanAllocateTo(manager, each assignee)   // subtree or tasks.view.all
  ├─ insert task (task_no from sequence) + assignments
  ├─ notification per assignee + socket 'task:created'
Employee → POST /tasks/:id/action {accept|start|hold|resume|progress|submit}
  ├─ validates actor is assignee and transition is legal
  ├─ writes assignment status, time logs, progress
  └─ notifies creator/manager + 'task:updated'
Manager → approve | request_changes | reassign | cancel | reopen
  └─ completed tasks feed KPI task metrics and daily report suggestions
```

## 7. Notification flow

```
domain service → NotificationService.notify({employeeIds, type, title, body, link, priority})
  ├─ insert notifications row
  ├─ insert notification_recipients per employee (read=false)
  ├─ emitToEmployees(ids, 'notification:new', payload)   // live popup + badge
  └─ optional SMTP/SMS delivery
```

Announcements resolve their audience on the server (`all`, `employees`, `department`, `role`, `location`, `manager`) and fan out through the same path, so they appear instantly and persist.

## 8. KPI calculation flow

```
cron / POST /kpi/generate {period}
  for each employee:
    collect raw metrics (tasks, attendance, reports, tickets, quality, collaboration)
    for each configured parameter:
      normalise to 0..100 and mark available=false when there is no data
    score = Σ(score × weight) / Σ(weight of available parameters)
    category = Excellent ≥85, Very Good ≥70, Good ≥55, Needs Improvement ≥40, else Unsatisfactory
    upsert employee_kpi_records (draft)
Manager review → adjust scores (reason recorded) + strengths/improvements/comment
POST /kpi/publish → status=published, notifications, record locked
```

## 9. Real-time design

- Sockets authenticate with the same cookie; the server validates the session.
- Rooms: `user:{id}` (personal), `conv:{id}` (chat membership), `meeting:{code}` (participants only).
- Chat: persist → emit `message:new` to the conversation room; receipts and reactions emit deltas; typing is ephemeral.
- Meetings: `meeting:join` joins the room and broadcasts the participant list; `meeting:signal` relays offers/answers/ICE between peers; `meeting:leave` updates the list.
- Reconnection: the client reconnects with backoff and dispatches `realtime:resync`, and list pages refetch, so missed events are reconciled from the database.

## 10. Failure handling

- Every write that spans tables uses a transaction.
- Unique constraints back idempotency (one attendance/day, one report/day, one direct conversation per pair, unique employee code/email/mobile).
- `job_runs` records each scheduled execution and its outcome.
- Graceful shutdown closes the HTTP server and the MySQL pool; the scheduler is stopped first.
- Errors are logged with path/method/code; responses never leak stack traces or SQL.


## Enterprise security increment — 14 November 2026

This update is not full enterprise acceptance. See ENTERPRISE_ACCEPTANCE.md for the outstanding requirements.
Migrations 005–007 introduce rotating refresh tokens, upload scan state and ticket issue details. Access JWTs last 15 minutes; POST /api/auth/refresh rotates an HttpOnly refresh cookie without extending the session deadline. Existing pre-upgrade sessions must sign in again. GET /api/live is liveness; /api/ready and /api/health provide generic database readiness.
Uploads now fail closed unless ClamAV is configured; existing unscanned files are unavailable. Office/archive uploads are blocked pending bounded inspection. Ticket creation accepts validated issueDetails and up to ten owned, clean attachments. Production NGINX and scanner templates are under deploy/. SMTP remains environment-configured. See the new JWT_SESSION_MANAGEMENT, MALWARE_PROTECTION, HELPDESK_SYSTEM and PRODUCTION_TESTING documents for details.
