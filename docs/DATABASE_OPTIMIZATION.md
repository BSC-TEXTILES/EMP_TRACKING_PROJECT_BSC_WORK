# Database optimization
The existing MySQL schema uses InnoDB, foreign keys, indexes, unique constraints and pooled connections. SQL inputs are bound parameters. Migrations 005–007 add refresh-token history, upload scan state and ticket issue detail storage. Run npm run db:migrate before starting the updated service.

Transactions use UTC timestamps and rollback on failure. Deadlock retries are opt-in and currently enabled for session creation/rotation. Other workflows require side-effect/idempotency review before enabling replay. No database monitoring dashboard, slow-query collection or production load benchmark is implemented by this update.
