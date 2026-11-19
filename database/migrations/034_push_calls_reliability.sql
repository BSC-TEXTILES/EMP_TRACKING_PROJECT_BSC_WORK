-- Migration 034: reliable push delivery, call ringing states and per-user history deletion.
-- Additive only: no existing row is removed or rewritten.
--
-- 1. push_subscriptions (Web Push / VAPID): per-device identity, link to the login session,
--    "keep notifications after sign-out" opt-in, and delivery health.
-- 2. push_device_tokens (FCM, Capacitor app): same sign-out opt-in.
-- 3. push_delivery_log: one row per push attempt (sent / delivered / failed / expired).
-- 4. calls: end_reason (no_answer, cancelled, declined, busy, completed, disconnected, failed)
--    and per-side soft delete so removing a call from one history never touches the other.
-- 5. message_hidden: per-user "delete for me" of chat messages.

-- ----------------------------------------------------------------- 1. push_subscriptions
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_subscriptions' AND COLUMN_NAME = 'client_device_id');
SET @s := IF(@c = 0, 'ALTER TABLE push_subscriptions
  ADD COLUMN client_device_id VARCHAR(64) NULL AFTER device_id,
  ADD COLUMN session_id BIGINT UNSIGNED NULL AFTER client_device_id,
  ADD COLUMN platform VARCHAR(24) NULL AFTER auth,
  ADD COLUMN user_agent VARCHAR(255) NULL AFTER platform,
  ADD COLUMN keep_after_logout TINYINT(1) NOT NULL DEFAULT 1 AFTER user_agent,
  ADD COLUMN signed_out_at DATETIME(3) NULL AFTER keep_after_logout,
  ADD COLUMN failure_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER signed_out_at,
  ADD COLUMN last_error VARCHAR(160) NULL AFTER failure_count,
  ADD COLUMN last_sent_at DATETIME(3) NULL AFTER last_error,
  ADD KEY idx_push_subscriptions_client_device (client_device_id),
  ADD KEY idx_push_subscriptions_session (session_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 2. push_device_tokens
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_device_tokens' AND COLUMN_NAME = 'keep_after_logout');
SET @s := IF(@c = 0, 'ALTER TABLE push_device_tokens
  ADD COLUMN keep_after_logout TINYINT(1) NOT NULL DEFAULT 0 AFTER app_version,
  ADD COLUMN signed_out_at DATETIME(3) NULL AFTER keep_after_logout', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 3. push_delivery_log
CREATE TABLE IF NOT EXISTS push_delivery_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  channel ENUM('webpush', 'fcm') NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(32) NOT NULL,
  ref VARCHAR(80) NULL,
  status ENUM('sent', 'delivered', 'failed', 'expired') NOT NULL,
  http_status SMALLINT NULL,
  error VARCHAR(255) NULL,
  ack_token CHAR(32) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_push_log_employee (employee_id, created_at),
  KEY idx_push_log_ref (ref),
  KEY idx_push_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- 4. calls
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calls' AND COLUMN_NAME = 'end_reason');
SET @s := IF(@c = 0, 'ALTER TABLE calls
  ADD COLUMN end_reason VARCHAR(24) NULL AFTER status,
  ADD COLUMN caller_deleted_at DATETIME(3) NULL AFTER ended_at,
  ADD COLUMN callee_deleted_at DATETIME(3) NULL AFTER caller_deleted_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 5. message_hidden
CREATE TABLE IF NOT EXISTS message_hidden (
  message_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  hidden_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (message_id, employee_id),
  KEY idx_message_hidden_employee (employee_id),
  CONSTRAINT fk_message_hidden_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_message_hidden_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
