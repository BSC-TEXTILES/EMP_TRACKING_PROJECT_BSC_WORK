-- Migration 039: honest call states, device reachability and native Android ringing.
-- Additive only: no existing table, column value or row is removed or rewritten.
-- Rollback (manual): database/rollback/039_call_reachability_native.down.sql
--
-- 1. calls
--    - status gains 'unreachable' (the callee's devices never confirmed the ring).
--    - delivered_at / delivered_via: first device that confirmed it is ringing (socket, webpush, fcm).
--      Until then the caller sees "Calling…", never a fake "Ringing…".
--    - connected_at: first time both ends reported a connected WebRTC media path.
--    - answered_device: which device (client id) answered, for multi-device audits.
--    - callee_notified_at: when a callee who was offline was told about the missed / unreachable call.
-- 2. call_events: append-only log of every state transition and device signal of a call.
-- 3. push_device_tokens: native call capability flag and last confirmed delivery.
-- 4. push_subscriptions: last confirmed delivery.

-- ----------------------------------------------------------------- 1. calls
SET @t := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calls' AND COLUMN_NAME = 'status');
SET @s := IF(@t NOT LIKE '%unreachable%',
  "ALTER TABLE calls MODIFY status ENUM('ringing', 'active', 'completed', 'declined', 'missed', 'busy', 'failed', 'unreachable') NOT NULL DEFAULT 'ringing'",
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calls' AND COLUMN_NAME = 'delivered_at');
SET @s := IF(@c = 0, 'ALTER TABLE calls
  ADD COLUMN delivered_at DATETIME(3) NULL AFTER started_at,
  ADD COLUMN delivered_via VARCHAR(16) NULL AFTER delivered_at,
  ADD COLUMN connected_at DATETIME(3) NULL AFTER accepted_at,
  ADD COLUMN answered_device VARCHAR(64) NULL AFTER connected_at,
  ADD COLUMN callee_notified_at DATETIME(3) NULL AFTER ended_at,
  ADD KEY idx_calls_callee_unnotified (callee_id, callee_notified_at, status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Calls that ended before this migration were already shown to their callee.
UPDATE calls SET callee_notified_at = COALESCE(ended_at, started_at)
WHERE callee_notified_at IS NULL AND status IN ('missed', 'declined', 'completed', 'busy', 'failed');

-- ----------------------------------------------------------------- 2. call_events
CREATE TABLE IF NOT EXISTS call_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  call_id VARCHAR(64) NOT NULL,
  employee_id BIGINT UNSIGNED NULL,
  event VARCHAR(40) NOT NULL,
  device VARCHAR(64) NULL,
  detail JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_call_events_call (call_id, id),
  KEY idx_call_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- 3. push_device_tokens
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_device_tokens' AND COLUMN_NAME = 'native_calls');
SET @s := IF(@c = 0, 'ALTER TABLE push_device_tokens
  ADD COLUMN native_calls TINYINT(1) NOT NULL DEFAULT 0 AFTER app_version,
  ADD COLUMN client_device_id VARCHAR(64) NULL AFTER native_calls,
  ADD COLUMN last_ack_at DATETIME(3) NULL AFTER last_sent_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 4. push_subscriptions
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_subscriptions' AND COLUMN_NAME = 'last_ack_at');
SET @s := IF(@c = 0, 'ALTER TABLE push_subscriptions ADD COLUMN last_ack_at DATETIME(3) NULL AFTER last_sent_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
