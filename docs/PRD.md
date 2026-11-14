> Current update (14 November 2026): website-managed first-run setup and encrypted administrator SMTP/OTP configuration are implemented. See WEBSITE_SETUP.md and EMAIL_CONFIGURATION.md; these supersede earlier environment-only SMTP and demo-seeding instructions below. Normal setup creates no sample business records. Dependencies were upgraded; npm audit reports zero known vulnerabilities. 37 tests pass. The full enterprise specification and production deployment are not declared complete.

# Product Requirements Document (PRD)

## 1. Purpose

Replace scattered attendance registers, spreadsheets of tasks and informal chat with a single enterprise platform that records work as it happens: who is present, what they are doing, how long it takes, what they delivered, who approved it, and how that adds up to a monthly performance evaluation.

## 2. Personas

| Persona | Primary goals | Constraints |
|---|---|---|
| Employee | Check in/out, see assigned work, submit daily report, chat, raise tickets, apply for leave, view KPI | Sees only own records and shared conversations |
| Manager | Allocate work inside the reporting tree, monitor team attendance and workload, review reports, approve tasks, evaluate KPI | Sees only their subtree unless granted org-wide view |
| HR | Maintain employee records and hierarchy, approve registrations and leave, run attendance/report exports | Cannot change system permissions unless granted |
| IT Administrator | Resolve SLA tickets, manage users and roles | No access to HR-only fields unless granted |
| Store Manager | Manage a location's staff | Location-scoped visibility via permissions |
| Super Admin / Directors | Company-wide analytics, KPI publication, settings, audit | All actions are audited |

## 3. Functional requirements

### FR-1 Registration & authentication
- Login with employee code, email or mobile plus password.
- Optional OTP step for privileged or new devices; OTP hashed, expiring, resend cooldown, attempt caps.
- Self-registration captures name, email, mobile, department, designation, manager, location, employment type and password; email and mobile must both be verified; the account stays `pending_approval` until HR approves it.
- Forgot/reset password by OTP; changing a password revokes all other sessions.
- Login history with device/IP, failed-attempt lockout, session listing and revocation.

### FR-2 Hierarchy and RBAC
- Recursive reporting structure; cycle changes rejected server-side.
- Permissions are explicit codes grouped by module; roles map to permissions; per-user grants/denies override roles.
- Every list, detail, export, file and WebSocket room is scoped by the same rules.
- Interactive organisation chart and department/location/role directories.

### FR-3 Attendance
- Check-in/check-out recorded with server UTC timestamps; one open session per employee per day.
- Live timer derived from `serverNow - checkInAt` plus break deductions; survives refresh, logout, reconnect and multiple tabs.
- Breaks, late detection (grace period from settings), early departure, overtime, half-day, auto-close of missing check-outs.
- Attendance correction requests require manager approval and are audited.
- Holiday calendar and leave integration (`on_leave` status).

### FR-4 Tasks
- Rich task creation (category, project, priority, schedule, estimate, checklist, instructions, recurrence, multiple assignees).
- Statuses: not started, assigned, accepted, in progress, on hold, pending approval, completed, rejected, overdue, cancelled.
- Employee actions (accept, start, hold, resume, progress, submit, time log) and manager actions (approve, request changes, reassign, cancel, reopen).
- Automated reminders at 24h and 2h before due; overdue sweep; recurring task copies.
- Reporting-subtree enforcement on allocation and reassignment.

### FR-5 Daily reports
- Per-day report with completed/in-progress/pending counts (pre-filled from live task state), hours, problems, support needed, tomorrow's plan and attachments.
- One report per employee per day; manager approve or request correction; permanent history.

### FR-6 Communication
- Direct chats, groups, department/project channels and announcement groups.
- Text, images, files, voice notes; replies, reactions, edit, delete (audited), read receipts, delivered ticks, typing, presence, last seen, search.
- Messages persist first, then fan out to members online; offline members get notifications and unread counters.

### FR-7 Tickets
- Category-driven automatic team assignment, priority-based SLA, assignment history, internal notes, attachments, escalation, resolution, feedback, reopen.
- Workflow: new → assigned → acknowledged → in progress → waiting for information → resolved → closed/reopened, plus cancellation.

### FR-8 Notifications
- Every assignment, approval, rejection, message, ticket change, meeting invite and KPI publication creates a per-recipient notification (in-app + real-time; email/SMS where configured).
- Bulk announcements to all, department, role, location or selected employees; server resolves the audience.
- Read/unread, bulk read, delete, preference-friendly priority levels.

### FR-9 Calendar & meetings
- Unified month/week/day calendar of meetings, task deadlines, holidays and approved leave.
- Scheduling with participants, agenda, room or online location; invitations and responses; action items; outcome notes; meeting chat; reminders.
- Real WebRTC audio/video with screen sharing, participant list and signalling recovery.

### FR-10 KPI
- Configurable weighted parameters (default: task completion 25, quality 20, attendance 15, timeliness 15, productivity 10, collaboration 10, reporting 5).
- Metrics normalised 0–100; unavailable metrics excluded with weights redistributed.
- Manager review can adjust scores with a recorded reason before publication; employee comment; publish locks the record.
- Team, department and organisation comparisons plus month-over-month trend.

### FR-11 Leave
- Configurable leave types and yearly balances; document requirement; overlap and balance validation; manager then HR approval; cancellation; holiday calendar.

### FR-12 HR & profile
- Complete employee profile with contact, organisational placement, statistics and history.
- Employees may edit allowed fields; organisational changes require HR permission and are audited.
- Deactivation never deletes historical records.

### FR-13 Projects
- Projects with manager, members, milestones, linked tasks, progress and a project conversation; grid/list/Kanban views.

### FR-14 Analytics & exports
- Company/team dashboards with date, department, designation, location and manager filters.
- CSV, XLSX and PDF exports for attendance, working hours, tasks, reports, KPI, tickets, meetings, login history, productivity and leave.

### FR-15 Administration
- System settings (shift times, grace, half/full day, overtime, work days, SLA hours, retention), audit log, job run history, runtime/database/storage/realtime health.
- Role and permission matrix editor with audit of before/after grants.

## 4. Non-functional requirements

| Area | Requirement |
|---|---|
| Correctness | Trusted server timestamps; transactional writes; idempotent checks (no duplicate check-in, no duplicate daily report, no duplicate direct conversation) |
| Security | Hashed passwords, revocable sessions, CSRF-resistant cookies, Origin guard, rate limits, parameterised SQL, upload validation, private file access, full audit |
| Performance | Indexed foreign keys and hot filters; pagination on all lists; aggregate queries for dashboards; per-module code splitting |
| Availability | Graceful shutdown, pool keep-alive, automatic reconnection of WebSocket clients, resync on reconnect |
| Usability | Responsive 360px→desktop; loading skeletons, empty states, inline errors, accessible labels and focus rings |
| Operability | Environment-driven config, migration runner, seed with `--reset`, job history, health endpoint, audit trail |
| Privacy | No covert location tracking; optional geolocation only on explicit check-in with consent; no secrets in the client |

## 5. Acceptance criteria (selected)

1. Signing in shows a dashboard whose attendance timer matches the server-derived elapsed time within seconds, and keeps ticking without refresh.
2. A second check-in on the same day returns HTTP 409 and does not create a record.
3. A manager cannot allocate a task to an employee outside their subtree (HTTP 403); their employee list never contains outsiders.
4. A task moved through accept → start → submit → approve ends `completed` with 100% progress, `approvedAt` set and the manager notified.
5. KPI parameter weights always total 100%; unavailable metrics carry zero weight contribution and are visibly marked.
6. Chat messages appear for other online members without refresh; non-members receive 403.
7. A ticket created by an employee is visible to its requester and assignee only unless the viewer holds team/all ticket permissions.
8. Every privileged change (settings, permissions, org assignment, attendance correction, KPI review) appears in the audit log with actor and before/after values.
9. Exports download real rows for the selected filters.
10. The PWA installs and serves the app shell; API calls fail gracefully when offline.

## 6. Out of scope (documented, not hidden)

- Native React Native binaries (the PWA covers mobile installability and uses the same API).
- Web Push delivery (requires VAPID key management); in-app real-time notifications are implemented.
- Payroll processing and statutory filings; payroll tickets exist but no salary engine.
- Multi-tenant isolation (single organisation per deployment).


## Enterprise security increment — 14 November 2026

This update is not full enterprise acceptance. See ENTERPRISE_ACCEPTANCE.md for the outstanding requirements.
Migrations 005–007 introduce rotating refresh tokens, upload scan state and ticket issue details. Access JWTs last 15 minutes; POST /api/auth/refresh rotates an HttpOnly refresh cookie without extending the session deadline. Existing pre-upgrade sessions must sign in again. GET /api/live is liveness; /api/ready and /api/health provide generic database readiness.
Uploads now fail closed unless ClamAV is configured; existing unscanned files are unavailable. Office/archive uploads are blocked pending bounded inspection. Ticket creation accepts validated issueDetails and up to ten owned, clean attachments. Production NGINX and scanner templates are under deploy/. SMTP remains environment-configured. See the new JWT_SESSION_MANAGEMENT, MALWARE_PROTECTION, HELPDESK_SYSTEM and PRODUCTION_TESTING documents for details.
