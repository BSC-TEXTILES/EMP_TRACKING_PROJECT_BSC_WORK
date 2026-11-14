> Current update (14 November 2026): website-managed first-run setup and encrypted administrator SMTP/OTP configuration are implemented. See WEBSITE_SETUP.md and EMAIL_CONFIGURATION.md; these supersede earlier environment-only SMTP and demo-seeding instructions below. Normal setup creates no sample business records. Dependencies were upgraded; npm audit reports zero known vulnerabilities. 37 tests pass. The full enterprise specification and production deployment are not declared complete.

# Email delivery

## 1. Overview

Email is a first-class delivery channel next to in-app notifications and WebSockets:

```
domain action → business write (MySQL) → notification row → Socket.IO emit
                                              ↓
                                        email queued (email_deliveries)
                                              ↓
                                  scheduler processes queue every minute
                                              ↓
                                   SMTP provider → sent / retrying / failed
```

A failing mail server can never roll back the task, ticket, report or meeting that triggered the mail: the business transaction commits first and the message becomes a queue row.

## 2. Configuration

All mail settings come from environment variables. Nothing is stored in the database and no credential is ever sent to the browser.

| Variable | Purpose |
|---|---|
| `APP_NAME` | Sender identity in subjects and templates |
| `APP_URL` / `FRONTEND_URL` | Base for links inside emails |
| `SMTP_HOST` | Provider host; empty disables delivery |
| `SMTP_PORT`, `SMTP_SECURE` | 587 + false (STARTTLS) or 465 + true (implicit TLS) |
| `SMTP_USER`, `SMTP_PASSWORD` | SMTP authentication (optional for relays) |
| `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL` | Composed into the RFC 5322 `From` header |
| `SMTP_REPLY_TO` | Optional reply address |
| `OTP_EXPIRY_MINUTES` | Code lifetime, shown in the email |
| `OTP_RESEND_COOLDOWN_SECONDS` | Minimum gap between code requests |
| `OTP_MAX_ATTEMPTS` | Wrong-code attempts before the code is unusable |

Files:

- `.env.example` — complete template (tracked).
- `.env.local` — local development, git-ignored.
- `.env.production` — server only, git-ignored, `chmod 600`; or inject the same names from a secret manager.
- `backend/.env` — supported for existing installs, lowest precedence.

Load order: environment-specific root file → `backend/.env` → root `.env`. Real environment files never enter Git (`.gitignore` ignores `.env*` and keeps the templates).

### Behaviour without SMTP

Development is fully usable without a provider:

- OTP codes are printed to the API console and returned in a clearly named `devCode` field only when `NODE_ENV !== 'production'`.
- Business notification emails are queued and then marked `skipped`, so the delivery log still shows what would have been sent.
- The admin page reports "Not configured" instead of failing silently.

## 3. Templates

`backend/src/lib/emailTemplates.ts` renders table-based HTML with inline styles, a restrained palette and a single call to action. All user-supplied values are HTML-escaped. No external images or tracking pixels.

| Key | Used for |
|---|---|
| `otp` | Login, registration and password-reset codes |
| `welcome` | Account activation after HR approval |
| `task_assigned` | New allocation, reassignment, deadline change |
| `task_reminder` | Due soon or overdue |
| `report_reminder` | Daily report not submitted |
| `ticket_update` | Assignment, escalation, resolution, reopen |
| `meeting_invite` | Invitation and schedule change |
| `meeting_reminder` | Starting soon |
| `leave_update` | Approval or rejection |
| `kpi_published` | Monthly performance published |
| `announcement` | Administrative announcements |
| `test` | SMTP check from the admin page |

Chat messages deliberately do not generate email — real-time chat belongs in the app.

## 4. Queue, retries and status

`email_deliveries` row lifecycle:

| Status | Meaning |
|---|---|
| `queued` | Waiting for the worker |
| `sending` | Claimed by the worker |
| `sent` | Provider accepted the message (`message_id` stored) |
| `failed` | Attempt failed; `next_attempt_at` holds the backoff time |
| `skipped` | SMTP not configured; content was logged locally |

- Worker: `processEmailQueue()` runs every minute from the scheduler and records a `job_runs` entry.
- Backoff: 2 attempts → 4 minutes, 3 attempts → 8 minutes (capped at 60), default 3 attempts.
- Claiming uses a conditional `UPDATE … WHERE status IN ('queued','failed')` so two workers cannot send the same row.
- Deduplication: `(dedupe_key)` prevents duplicate mail for the same notification/recipient.
- Retrying from the admin page resets the attempt budget and processes immediately.
- OTP mail is sent directly (it must report success synchronously) and is logged in the same table.

## 5. Administration

`Administration → Email delivery` (permission `settings.manage` or `admin.dashboard`):

- SMTP status: configured, reachable (live `verify()`), host/port/TLS, sender, reply-to, last checked.
- Delivery counters: sent, queued, retrying, skipped, last 24h.
- Test message form (delivered immediately and logged).
- Delivery log with filters (All / Queued / Failed / Sent / Skipped), attempts, failure reason, next attempt and a Retry action for failed or skipped rows.
- Template inventory.
- A note explaining that credentials are changed in the environment, not in the UI.

API: `GET /api/admin/email`, `POST /api/admin/email/test`, `POST /api/admin/email/retry/:id`. Secrets are never returned; only the sender address is shown.

## 6. Verification performed

1. Without SMTP: test-send rejected with a clear message; notification mails queued then marked `skipped`; the UI shows "Not configured".
2. With a local SMTP stub: `SMTP_FROM_NAME`/`SMTP_FROM_EMAIL` produced `Workforce <no-reply@workforce.test>`, `SMTP_REPLY_TO` was applied, `verify()` succeeded, a test message was accepted and recorded as `sent` with a `message_id`, and a task allocation produced a `task_assigned` email.
3. Retrying a `skipped` row delivered it and flipped the status to `sent`.
4. Invalid/foreign delivery failures are captured in `last_error` and retried with backoff (no exception escapes to the business request).

What remains unverified in this environment: delivery through a real commercial provider (credentials required) and inbox rendering in Outlook/Gmail. Verify both after configuring production SMTP.

## 7. Operations checklist

- [ ] `SMTP_HOST`, port, TLS mode, user and password set in `.env.production`
- [ ] Sender domain has SPF, DKIM and DMARC records
- [ ] `SMTP_REPLY_TO` monitored by a human
- [ ] Test email received from **Email delivery → Send test**
- [ ] `job_runs` shows `email_queue` succeeding every minute
- [ ] Failed queue is empty or understood
- [ ] No `devCode` appears in production responses
- [ ] `.env.production` is `600`, owned by the app user, outside the repository
