# Deadlock prevention and recovery
transaction(work, { retryDeadlocks: true }) retries ER_LOCK_DEADLOCK at most twice after the initial attempt, with exponential delay and jitter. Each failed attempt rolls back and releases its connection. A new attempt acquires a new pooled connection. Connection loss, lock-wait timeouts and ambiguous commit outcomes are not retried.

Only opt in for callbacks containing replay-safe database operations. Do not put email, filesystem operations or broadcasts inside retried callbacks. Refresh rotations lock the session before the refresh row. Keep transactions short and use a consistent row locking order.

Regression tests inject recognized errors after real database writes to verify rollback/retry. They are not a real concurrent InnoDB deadlock workload. Deadlocks cannot be eliminated; production lock-wait/slow-query monitoring and load tests remain required.
