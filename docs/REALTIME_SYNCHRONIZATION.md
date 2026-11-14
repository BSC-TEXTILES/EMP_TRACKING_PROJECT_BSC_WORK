# Realtime synchronization
The existing Socket.IO integration sends employee/task/ticket/attendance notifications. The frontend reconnects and emits a resynchronization event. Ticket actions emit updates after database writes.

Remaining: durable transactional outbox, replay cursor/deduplication, delivery guarantees after process failure, full subscription reauthorization and comprehensive stale-data reconciliation tests. Existing post-commit emission is not equivalent to database-backed reliable event processing.
