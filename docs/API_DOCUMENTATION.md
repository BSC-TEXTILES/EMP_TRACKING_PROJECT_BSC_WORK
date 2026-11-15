> Current update (14 November 2026): website-managed first-run setup and encrypted administrator SMTP/OTP configuration are implemented. See WEBSITE_SETUP.md and EMAIL_CONFIGURATION.md; these supersede earlier environment-only SMTP and demo-seeding instructions below. Normal setup creates no sample business records. Dependencies were upgraded; npm audit reports zero known vulnerabilities. 37 tests pass. The full enterprise specification and production deployment are not declared complete.

# API documentation

Base URL: `/api` (dev web proxy: `http://localhost:5173/api` → API `http://localhost:4000/api`).

## 1. Authentication & conventions

- Session cookie `wfm_session` (httpOnly). Obtain it via `POST /auth/login`.
- Send `Origin` on state-changing requests; a foreign origin is rejected with 403.
- Send `Content-Type: application/json` for JSON bodies; multipart for `/files/upload`.
- Errors: `{ "error": string, "code": string, "details"?: unknown }`.

| Status | Meaning |
|---|---|
| 200 / 201 | Success / created |
| 400 | Validation or business rule failure |
| 401 | No or expired session |
| 403 | Authenticated but not permitted (or wrong origin) |
| 404 | Missing or outside your scope |
| 409 | Conflict: duplicate check-in, duplicate report, illegal transition, unique violation |
| 429 | Rate limited |
| 500 | Unexpected error (generic message; details only in server logs) |

## 2. Auth (`/auth`)

| Method | Path | Auth | Body / notes |
|---|---|---|---|
| POST | `/auth/login` | public | `{identifier, password, remember?}` → `{user, permissions}` or `{requiresOtp, challenge}` |
| POST | `/auth/login/otp/send` | public | `{challenge}` → `{delivered, devCode?}` |
| POST | `/auth/login/otp/verify` | public | `{challenge, code, remember?}` → `{user}` |
| POST | `/auth/logout` | session | revokes current session, clears cookie |
| GET | `/auth/me` | session | current user + permissions |
| GET | `/auth/registration-options` | public | departments, designations, locations, managers |
| POST | `/auth/register` | public | registration payload; returns `employeeId`, `employeeCode`, dev OTPs when delivery is unconfigured |
| POST | `/auth/register/verify` | public | `{employeeId, emailCode, mobileCode}` |
| POST | `/auth/register/resend` | public | `{employeeId, channel}` |
| POST | `/auth/password/forgot` | public | `{identifier}` → `{message, delivered, devCode?}` |
| POST | `/auth/password/reset` | public | `{identifier, code, password}` |
| POST | `/auth/password/change` | session | `{currentPassword, newPassword}`; revokes other sessions |
| GET | `/auth/sessions` | session | active devices |
| DELETE | `/auth/sessions/:sessionId` | session | revoke one device |
| POST | `/auth/sessions/revoke-others` | session | revoke all other devices |
| GET | `/auth/login-history` | session | recent login attempts |

## 3. Me / dashboard (`/me`)

| Method | Path | Notes |
|---|---|---|
| GET | `/me/dashboard` | employee, today's attendance state, task counts, tickets, latest KPI, upcoming meetings, unread counts, weekly hours, attendance summary |
| GET | `/me/weekly-summary` | 7-day attendance |
| GET | `/me/team-snapshot` | manager view: team size, checked in, on leave, overdue, approvals, reports pending |

## 4. Attendance (`/attendance`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/attendance/today` | session | authoritative state incl. `serverNow`, `elapsedSeconds` |
| GET | `/attendance/heartbeat` | session | same shape; also refreshes presence |
| POST | `/attendance/check-in` | `attendance.view.own` | optional `{latitude, longitude}`; 409 if already open |
| POST | `/attendance/check-out` | session | closes today's record |
| POST | `/attendance/break/start` / `break/end` | session | break accounting |
| GET | `/attendance/history?from&to` | session | own history |
| GET | `/attendance/summary?period=YYYY-MM` | session | present/late/half/leave/holiday, hours, percentage |
| GET | `/attendance/team` | `attendance.view.team` or `.all` | today's team status |
| POST | `/attendance/corrections` | session | `{workDate, checkInAt?, checkOutAt?, reason}` |
| GET | `/attendance/corrections` | session | own requests, or team/all for approvers |
| POST | `/attendance/corrections/:id/review` | `attendance.corrections.approve` | `{approve, note?}` |

## 5. Tasks (`/tasks`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/tasks?view=mine\|allocated\|all&status&priority&overdue&search&page&pageSize` | `tasks.view.*` | scoped list |
| POST | `/tasks` | `tasks.create` | title, description, priority, dueDate/dueTime, estimatedMinutes, projectId, category, recurrence, instructions, assigneeIds[], subtasks[] |
| GET | `/tasks/:id` | scoped | full detail: assignments, subtasks, comments, time logs, attachments |
| POST | `/tasks/:id/action` | actor rules | `{action}`: accept, start, hold, resume, progress, submit, approve, request_changes, reassign, cancel, reopen |
| POST | `/tasks/:id/comments` | scoped | `{body}` |
| POST | `/tasks/:id/subtasks` | scoped | `{title}` |
| PATCH | `/tasks/:id/subtasks/:subtaskId` | scoped | toggle completion |
| POST | `/tasks/:id/time-logs` | assignee | `{minutes, note?}` |
| GET | `/tasks/meta/assignable` | `tasks.assign` | employees inside your reporting structure |
| GET | `/tasks/stats` | scoped | counts by status |
| GET | `/tasks/categories` | session | category list |

## 6. Daily reports (`/reports`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/reports/suggestions?date` | session | live counts from tasks + attendance |
| GET | `/reports/today` | session | today's report or null |
| GET | `/reports?status&from&to&employeeId&page` | `reports.view.*` | scoped list |
| POST | `/reports` | session | `{reportDate, summary, problems?, supportRequired?, tomorrowPlan?, totalMinutes?, tasksCompleted?, tasksInProgress?, tasksPending?}` |
| GET | `/reports/:id` | scoped | detail |
| POST | `/reports/:id/review` | `reports.review` | `{approve, note?}` |

## 7. Chat (`/chat`)

| Method | Path | Notes |
|---|---|---|
| GET | `/chat/conversations` | list with last message, unread count, member count |
| GET | `/chat/unread` | total unread |
| GET | `/chat/contacts` | active employees for new chats |
| POST | `/chat/conversations/direct` | `{employeeId}` → `{id}` (idempotent) |
| POST | `/chat/conversations/group` | `{name, description?, memberIds[], isAnnouncement?}` |
| GET | `/chat/conversations/:id` | detail + members + my role |
| GET | `/chat/conversations/:id/messages?before&limit&search` | history |
| POST | `/chat/conversations/:id/messages` | `{body?, type?, replyToId?, fileIds?, durationSeconds?}` |
| POST | `/chat/conversations/:id/read` | marks read |
| POST | `/chat/conversations/:id/members` | `{memberIds[]}` (admins) |
| DELETE | `/chat/conversations/:id/members/:employeeId` | (admins) |
| PATCH | `/chat/messages/:id` | `{body}` own message |
| DELETE | `/chat/messages/:id` | own or moderator |
| POST | `/chat/messages/:id/reactions` | `{emoji}` toggles |

## 8. Tickets (`/tickets`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/tickets/categories` | session | 11 categories |
| GET | `/tickets/stats` | scoped | total/open/resolved/breached/mine |
| GET | `/tickets?status&priority&category&search&mine&page` | scoped | list |
| POST | `/tickets` | `tickets.create` | `{subject, description, category, priority?, departmentId?, relatedTaskId?, attachmentIds?}` |
| GET | `/tickets/:id` | scoped | detail with comments and history |
| POST | `/tickets/:id/comments` | scoped | `{body, isInternal?}` |
| POST | `/tickets/:id/action` | role rules | assign, acknowledge, start, wait_info, resolve, close, reopen, escalate, cancel, feedback (`{rating}`) |

## 9. Meetings (`/meetings`)

| Method | Path | Notes |
|---|---|---|
| GET | `/meetings?from&to&upcoming` | meetings I organise or attend |
| POST | `/meetings` | `{title, startAt, endAt, participantIds[], description?, agenda?, locationType?, roomName?}` (`meetings.create`) |
| GET | `/meetings/:id` | detail, participants, action items, chat |
| POST | `/meetings/:id/respond` | `{response: accepted\|declined}` |
| POST | `/meetings/:id/join` | marks attendance, returns `meetingCode` |
| GET | `/meetings/:id/rtc-config` | ICE servers (STUN + optional TURN) |
| POST | `/meetings/:id/action-items` | `{title, assigneeId?, dueDate?}` |
| PATCH | `/meetings/:id/action-items/:itemId` | toggle |
| POST | `/meetings/:id/outcome` | `{outcome}` |
| POST | `/meetings/:id/cancel` | `{reason?}` |
| POST | `/meetings/:id/messages` | `{body}` meeting chat |

## 10. KPI (`/kpi`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/kpi/parameters?templateId` | `kpi.view.*` | template + weights + descriptions |
| PUT | `/kpi/parameters` | `kpi.configure` | `{templateId, weights[{key, weight}]}` |
| GET | `/kpi?period&scope=mine\|team\|all&employeeId` | `kpi.view.*` | list |
| GET | `/kpi/history?employeeId` | scoped | history + trend |
| GET | `/kpi/comparison?period` | `kpi.view.team\|all` | team + department averages |
| POST | `/kpi/generate` | configure/review/publish | `{period, employeeIds?}` |
| POST | `/kpi/publish` | `kpi.publish` | `{period}` |
| GET | `/kpi/:id` | scoped | per-parameter scores, metrics, comments |
| POST | `/kpi/:id/review` | `kpi.review` | `{scores?, strengths?, improvements?, managerComment?}` |
| POST | `/kpi/:id/comment` | self | `{comment}` employee response |

## 11. Leave (`/leave`)

| Method | Path | Notes |
|---|---|---|
| GET | `/leave/types` | active types |
| GET | `/leave/balances?employeeId&year` | balances |
| GET | `/leave/holidays?from&to` | holiday calendar |
| GET | `/leave?scope=mine\|team\|all&status` | requests |
| POST | `/leave` | `{leaveTypeId, startDate, endDate, reason, documentFileId?}` |
| POST | `/leave/:id/decide` | `{approve, note?, stage: manager\|hr}` |
| POST | `/leave/:id/cancel` | own pending request |

## 12. Projects (`/projects`)

`GET /` list · `POST /` create (name, code?, description?, managerId?, departmentId?, startDate?, endDate?, memberIds[]) · `GET /:id` detail · `POST /:id/status` `{status}` · `POST /:id/milestones` · `PATCH /:id/milestones/:milestoneId` · `POST /:id/members` `{employeeId}` · `DELETE /:id/members/:employeeId`.

## 13. Employees & organisation (`/employees`)

`GET /picker` names only · `GET /hierarchy` org tree · `GET /structure` departments/designations/locations/roles · `GET /roles` role+permission matrix · `GET /` list (scoped) · `POST /` create (`employees.manage`) · `GET /:id` detail + stats · `PATCH /:id` profile fields · `PATCH /:id/org-assignment` · `POST /:id/approve` / `:id/reject` / `:id/status` · `PUT /roles/:id/permissions` · `POST /roles` · `PATCH /roles/:id` · `POST /:id/permissions` · `POST /departments|designations|locations`.

## 14. Notifications (`/notifications`)

`GET /` inbox (`unread`, `limit`, `offset`) · `GET /unread-count` · `POST /read-all` · `POST /:id/read` · `DELETE /:id` · `POST /announcements` (`notifications.send`, audience resolved server-side) · `GET /announcements` · `GET /audience-options`.

## 15. Analytics, admin, files, exports

- `GET /analytics/overview?from&to&departmentId&designationId&locationId&managerId`
- `GET /analytics/employee/:id/performance?period`
- `GET /analytics/kpi/departments?period`
- `GET /admin/settings` · `PUT /admin/settings` · `GET /admin/audit?action&entityType&actorId&from&to&limit` · `GET /admin/jobs` · `GET /admin/system`
- `GET /admin/email?status&search&limit` — SMTP status (no secrets), delivery counters, template list and the delivery log (`settings.manage` / `admin.dashboard`)
- `POST /admin/email/test` `{to}` — immediate test message; returns `400` with the provider error when delivery fails (`settings.manage`)
- `POST /admin/email/retry/:id` — requeues a failed/skipped message and processes it immediately (`settings.manage`)
- `POST /files/upload` (multipart `file`) · `GET /files/:id` (permission-checked) · `DELETE /files/:id`
- `GET /exports?type=attendance|tasks|reports|kpi|tickets|working_hours|productivity|meetings|login_history|leave&format=csv|xlsx|pdf&from&to...`

## 16. Socket.IO events

Client → server: `conversation:join`, `conversation:leave`, `chat:typing`, `meeting:join` `{code}`, `meeting:signal` `{code, target, signal}`, `meeting:leave` `{code}`.

Server → client: `presence:list`, `presence:update`, `message:new`, `message:read`, `message:edited`, `message:deleted`, `message:reaction`, `chat:typing`, `notification:new`, `task:created`, `task:updated`, `report:updated`, `ticket:created`, `ticket:updated`, `attendance:update`, `meeting:participants`, `meeting:signal`, `meeting:response`, `meeting:created`, `conversation:members_changed`.

All socket connections authenticate with the session cookie; room membership is checked server-side before joining meeting rooms.

## 17. Collections (`/collections`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/collections?search&status&approvalStatus&employeeId&departmentId&locationId&from&to&page&pageSize` | any `collections.view.*` | Hierarchy-scoped register |
| GET | `/collections/dashboard?from&to` | any `collections.view.*` | Totals, status mix, department comparison, recent records |
| GET | `/collections/meta` | authenticated | Status, approval and payment-mode options |
| GET | `/collections/:id` | scoped | Record detail |
| POST | `/collections` | `collections.create` | Returns `{ id, referenceNo }`; server derives status |
| PATCH | `/collections/:id` | `collections.edit` | Partial update; status recalculated |
| POST | `/collections/:id/decision` | `collections.approve` | `{ approve, reason? }`; rejection requires a reason |
| DELETE | `/collections/:id` | `collections.delete` | Soft delete, audited |
| GET | `/exports?type=collections&format=csv\|xlsx\|pdf` | any `collections.view.*` | Honours the register filters |

## 18. Session refresh and development login

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/refresh` | Rotates the refresh token and issues a new 15-minute access cookie; reuse of a consumed token revokes the session family |
| GET | `/auth/test-accounts` | Development/staging only (404 in production): seven seeded demo accounts with employee code and password; never bundled into the frontend |
| GET | `/admin/environment` | Sanitized configuration validation report (`settings.manage` / `admin.dashboard`) |
| POST | `/me/photo` | Multipart `file`: PNG, JPEG, WebP or GIF up to 5 MB. Content-verified, downscaled client-side, returns `{ photoUrl }`; replace removes the previous image |
| DELETE | `/me/photo` | Removes the uploaded profile photo and its stored file |
| GET | `/files/:id` | Serves an uploaded file. Images are `inline`; public profile photos are readable by any signed-in employee, other files stay owner/linked-record only |

## 19. Email side effects

Notifications created by any module also queue a transactional email when SMTP is configured. Chat messages are excluded by design. Delivery is asynchronous and tracked in `email_deliveries`; see `EMAIL.md` and the admin endpoints above. A mail failure never changes the HTTP response of the business action.

## 17. Example

```http
POST /api/tasks
Cookie: wfm_session=…
Origin: https://workforce.example.com
Content-Type: application/json

{
  "title": "Prepare October KPI pack",
  "description": "Consolidate team scores and commentary.",
  "priority": "high",
  "dueDate": "2026-11-18",
  "dueTime": "18:30",
  "estimatedMinutes": 180,
  "assigneeIds": [9],
  "subtasks": ["Export scores", "Draft commentary"]
}
```

```json
201 Created
{ "id": 46, "taskNo": "TSK-00016", "status": "assigned", "progress": 0 }
```

```json
403 Forbidden
{ "error": "You can only allocate work within your reporting structure", "code": "forbidden" }
```


## Enterprise security increment — 14 November 2026

This update is not full enterprise acceptance. See ENTERPRISE_ACCEPTANCE.md for the outstanding requirements.
Migrations 005–007 introduce rotating refresh tokens, upload scan state and ticket issue details. Access JWTs last 15 minutes; POST /api/auth/refresh rotates an HttpOnly refresh cookie without extending the session deadline. Existing pre-upgrade sessions must sign in again. GET /api/live is liveness; /api/ready and /api/health provide generic database readiness.
Uploads now fail closed unless ClamAV is configured; existing unscanned files are unavailable. Office/archive uploads are blocked pending bounded inspection. Ticket creation accepts validated issueDetails and up to ten owned, clean attachments. Production NGINX and scanner templates are under deploy/. SMTP remains environment-configured. See the new JWT_SESSION_MANAGEMENT, MALWARE_PROTECTION, HELPDESK_SYSTEM and PRODUCTION_TESTING documents for details.

## Website setup and email settings

- GET /api/setup/status: public `{required}` only; no secrets.
- POST /api/setup/install: first-run only; X-Setup-Code required, input validated, rate-limited; installs an empty database and first administrator.
- GET /api/admin/email/configuration: settings.manage; redacted SMTP details, hasPassword flag and OTP policy.
- POST /api/admin/email/configuration/test: settings.manage; verify SMTP, send a test, return an expiring actor-bound verification handle.
- PUT /api/admin/email/configuration: settings.manage; verification handle plus receivedTest=true; activate encrypted configuration.
- POST /api/admin/leave-types: org.manage; user-defined leave policy.
- Existing POST /api/employees/departments, /designations and /locations are connected to the Organization data page.
