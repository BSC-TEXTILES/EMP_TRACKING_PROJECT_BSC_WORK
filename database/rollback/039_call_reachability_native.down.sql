-- Manual rollback of 039_call_reachability_native.sql. Run only if you must revert;
-- 'unreachable' calls are first stored as 'missed' so the ENUM change keeps every row.
UPDATE calls SET status = 'missed' WHERE status = 'unreachable';
ALTER TABLE calls MODIFY status ENUM('ringing', 'active', 'completed', 'declined', 'missed', 'busy', 'failed') NOT NULL DEFAULT 'ringing';
ALTER TABLE calls DROP KEY idx_calls_callee_unnotified, DROP COLUMN delivered_at, DROP COLUMN delivered_via,
  DROP COLUMN connected_at, DROP COLUMN answered_device, DROP COLUMN callee_notified_at;
DROP TABLE IF EXISTS call_events;
ALTER TABLE push_device_tokens DROP COLUMN native_calls, DROP COLUMN client_device_id, DROP COLUMN last_ack_at;
ALTER TABLE push_subscriptions DROP COLUMN last_ack_at;
