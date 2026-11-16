-- Calls, Device Registration, and Web Push Subscriptions
-- Additive only: no existing column, row or constraint is modified or removed.

-- ------------------------------ Calls ----------------------------------------
CREATE TABLE IF NOT EXISTS calls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  call_id VARCHAR(64) NOT NULL,
  caller_id BIGINT UNSIGNED NOT NULL,
  callee_id BIGINT UNSIGNED NOT NULL,
  type ENUM('audio', 'video') NOT NULL,
  status ENUM('ringing', 'active', 'completed', 'declined', 'missed', 'busy', 'failed') NOT NULL DEFAULT 'ringing',
  direction ENUM('incoming', 'outgoing') NOT NULL,
  meeting_code VARCHAR(32) NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  accepted_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_calls_call_id (call_id),
  KEY idx_calls_caller (caller_id, started_at),
  KEY idx_calls_callee (callee_id, started_at),
  KEY idx_calls_status (status),
  CONSTRAINT fk_calls_caller FOREIGN KEY (caller_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_calls_callee FOREIGN KEY (callee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ Devices --------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  fingerprint VARCHAR(64) NOT NULL,
  device_type VARCHAR(24) NOT NULL,
  browser VARCHAR(24) NOT NULL,
  os VARCHAR(100) NOT NULL,
  user_agent VARCHAR(500) NOT NULL DEFAULT '',
  is_installed TINYINT(1) NOT NULL DEFAULT 0,
  is_standalone TINYINT(1) NOT NULL DEFAULT 0,
  screen_width INT UNSIGNED NULL,
  screen_height INT UNSIGNED NULL,
  pixel_ratio DECIMAL(4,2) NULL,
  push_endpoint VARCHAR(500) NULL,
  push_keys JSON NULL,
  last_active_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_devices_employee_fingerprint (employee_id, fingerprint),
  KEY idx_devices_employee (employee_id, last_active_at),
  CONSTRAINT fk_devices_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ Push Subscriptions ---------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  endpoint VARCHAR(500) NOT NULL,
  p256dh VARCHAR(200) NOT NULL,
  auth VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint),
  KEY idx_push_subscriptions_employee (employee_id),
  KEY idx_push_subscriptions_device (device_id),
  CONSTRAINT fk_push_subscriptions_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_push_subscriptions_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Index for notification_recipients dedupe_key (if not exists)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(160) NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications (dedupe_key);

-- Add webhook settings for push notifications
INSERT INTO system_settings (setting_key, setting_value) VALUES 
('push.vapid_subject', 'mailto:admin@bsctextiles.com'),
('push.enabled', '1')
ON DUPLICATE KEY UPDATE setting_value = setting_value;