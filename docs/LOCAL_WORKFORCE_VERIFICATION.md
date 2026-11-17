# Local workforce verification — 17 November 2026

Local test database: emp_tracking_test. Contains 19 synthetic employees and demo records. No production migration or agent installation was performed.

Start the loopback-only API and bundled frontend with `npx tsx backend/tests/local-preview.ts`. Open http://localhost:4000 (or the existing frontend dev server at http://localhost:5173). This uses backend/.env.test, disables website setup and SMTP, and does not start scheduled jobs.

Test administrator: admin@workforce.test
Test employee: ananya.rao@workforce.test
Test password: Workforce@2026

`npm test` rebuilds the disposable test database. Do not use this database for real business records.

Verified: 77 existing tests pass; 2 additional consent/browser-session audit tests pass; project type checks pass. Local HTTP login/logout and activity dashboard, login history, leave overview and meeting overview return successful responses.

The full master specification is NOT accepted as complete. Remaining acceptance includes native agent installation/pairing and Windows restart, device-token-only startup, approved schedule and partial-day leave enforcement, durable per-event offline acknowledgement across ended sessions, accurate accumulated idle time, meeting attendance timelines, and full role/location/export/browser end-to-end verification. Existing monitoring must not be represented as production ready.
