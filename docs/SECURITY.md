# SECURITY.md — security model

## 1. Authentication

- Passwords hashed with **bcrypt** (cost 12); never logged or returned.
- Login accepts employee code, email or mobile. Unknown identifiers and wrong passwords return the same generic error, so accounts cannot be enumerated.
- On success the server creates `employee_sessions` (hashed session id, device label, IP, user agent, expiry) and signs a JWT (`HS256`, `sub`, `sid`, 7-day default TTL).
- The JWT travels only in the **httpOnly** cookie `wfm_session` (`SameSite=Lax`, `Secure` in production, path `/`). It is unreadable from JavaScript.
- Every request re-validates signature **and** the session row, so logout, device revocation and password changes take effect immediately.
- Remember-device extends session TTL; the shorter default applies otherwise.

## 2. OTP

- Email and mobile OTPs are 6 digits, generated with `crypto.randomInt`, stored **hashed** with expiry, purpose, and attempt counters.
- Resend cooldown per challenge; limited attempts before the challenge is invalidated.
- Used for: registration (email + mobile), login step-up, password reset.
- Without SMTP/SMS configuration, codes are returned to the client **only when `NODE_ENV !== 'production'`** in a clearly named `devCode` field. Production never exposes them.
- Optional TOTP MFA is supported per employee (`mfa_enabled`), with recovery handled by an administrator.

## 3. Authorisation

- Permission-code checks on every route (`requirePermission`, `requireAny`), plus scope filters inside services.
- Object-level checks: detail/list/export/file/history endpoints all apply the same subtree rule, so ID guessing yields 403/404.
- WebSocket: connections authenticate with the cookie; chat rooms require membership; meeting rooms require an invitation.
- Files: `GET /files/:id` verifies the viewer can access the owning record; uploads are private by default.

## 4. Transport & browser protections

| Control | Implementation |
|---|---|
| CSRF | `SameSite=Lax` cookie + `Origin`/`Referer` guard on all state-changing requests; JSON-only bodies (no form posts) |
| CORS | Explicit allow-list from `APP_ORIGIN`, credentials enabled |
| Headers | Helmet: CSP, `X-Content-Type-Options`, `X-Frame-Options`, HSTS in production, referrer policy |
| XSS | React escaping by default; no `dangerouslySetInnerHTML`; user text rendered as text |
| Clickjacking | `frame-ancestors 'none'` / `X-Frame-Options: DENY` |
| Body limits | JSON limited to 1 MB, uploads to `MAX_UPLOAD_MB` |
| Mixed content | Cookies `Secure` and camera/mic only over HTTPS in production |

## 5. Rate limiting & brute force

- Login: per IP + identifier window; repeated failures increment `failed_login_attempts`; the account locks for a cool-down after the configured threshold and unlock is audited.
- OTP send/verify: strict per-challenge and per-IP limits.
- General API: per-IP request budget.
- Exceeding a limit returns `429` with `Retry-After`.
- In-memory counters are per process; use Redis when running multiple instances (`MEMORY.md` lists this as the upgrade path).

## 6. Input validation

- Zod schemas at every route boundary: types, lengths, enums, date formats, ID positivity.
- SQL is exclusively parameterised through `mysql2` (`?` placeholders); no string interpolation of user input, including dynamic `IN` lists and sort columns (whitelisted).
- Uploads: size cap, MIME/extension allow-list, randomised stored filename, original name stored separately, served with `Content-Disposition` and a restrictive `Content-Type`.

## 7. Audit trail

`audit_logs` records `actor_id`, `action`, `entity_type`, `entity_id`, `before_data`, `after_data`, `ip`, `user_agent`, `created_at`. Covered actions include:

- login/logout, failed logins, password change/reset, session revocation;
- employee create/approve/reject/status/org-assignment, role and permission changes;
- attendance corrections and approvals, manual attendance changes;
- task creation, reassignment, cancellation, approval;
- report approval/correction requests;
- ticket assignment, escalation, resolution, reopen;
- KPI configuration, review adjustments, publication;
- settings changes, announcements;
- message deletion by a moderator.

The audit list is read-only and permission-gated (`audit.view`).

## 8. File security

- Files are stored outside the web root in `UPLOAD_DIR` and streamed by the API after an access check.
- Filenames are generated; directory traversal is impossible because only database IDs are used.
- Images are displayed with `Content-Type` from the allow-list; SVG is not accepted (script vector).
- Deleting a file is soft (record retained) so audit references stay valid.

## 9. Secrets & configuration

- All secrets in environment variables; `.env` is git-ignored; `.env.example` contains placeholders only.
- `JWT_SECRET`, `INTERNAL_JOB_SECRET`, DB password and SMTP/SMS keys must be rotated per environment.
- The frontend bundle contains no secrets; only public configuration is exposed via `VITE_*`.
- Error responses hide internals; detailed errors are logged server-side with request context.

## 10. Data protection

- Least privilege database user for the app (no `GRANT`/`DROP` in production).
- TLS for MySQL connections where the network is not trusted.
- Nightly encrypted backups with tested restore (see `DEPLOYMENT.md`).
- Employee deactivation preserves history; personal data removal requests require an explicit, audited administrative process.
- No covert location tracking: coordinates are captured only on an explicit check-in action when the client provides them.
- Meetings media is peer-to-peer (DTLS-SRTP); the server only relays signalling.

## 11. Reporting a vulnerability

Report suspected vulnerabilities privately to the system owner. Do not open public issues containing reproduction details for authorization bugs.
