> Current update (14 November 2026): website-managed first-run setup and encrypted administrator SMTP/OTP configuration are implemented. See WEBSITE_SETUP.md and EMAIL_CONFIGURATION.md; these supersede earlier environment-only SMTP and demo-seeding instructions below. Normal setup creates no sample business records. Dependencies were upgraded; npm audit reports zero known vulnerabilities. 37 tests pass. The full enterprise specification and production deployment are not declared complete.

# Production testing
Run npm run db:migrate, npm run typecheck, npm run build and npm test. Tests operate against the configured local MySQL database and create workflow records; use an isolated seeded database in CI.

Security regression coverage includes access TTL, refresh rotation/reuse, concurrent refresh, absolute expiry, cookie flags, deadlock retry bounds, rollback of real writes, refusal to retry connection failures, scanner outage/verdicts, double-extension rejection and path containment. Scanner verdict tests use a local protocol stub. SMTP tests skip real delivery without credentials. No actual malware daemon, production NGINX host, browser device matrix or load generator has been verified.

Release requires all open items in ENTERPRISE_ACCEPTANCE.md, real email/OTP/password-reset delivery tests, scanner malware tests, UI/mobile accessibility testing, actual MySQL concurrency/outage tests, WebSocket load/replay authorization tests and dependency remediation.

Latest local verification: 19 existing API tests plus 13 security/helpdesk tests passed (32 total). Type checking and production builds passed. A desktop browser smoke check confirmed employee sign-in, ticket listing and the expanded ticket form. Mobile and full interactive workflow verification remain outstanding.
