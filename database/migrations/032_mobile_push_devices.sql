-- Mobile app (Android / iOS) push notifications.
--
-- push_device_tokens: one row per installed app that registered for Firebase
-- Cloud Messaging. Each row is tied to the login session that registered it, so
-- signing out, a password reset or an admin revoking the session stops pushes to
-- that phone immediately (delivery only uses tokens whose session is still valid).
--
-- notification_preferences: per-employee opt-out of push for a category. A
-- missing row means "on". In-app notifications are always kept; only the phone /
-- browser push is affected.
--
-- Additive only: no existing table or row is changed.

CREATE TABLE IF NOT EXISTS push_device_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  token VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform ENUM('android', 'ios') NOT NULL,
  device_name VARCHAR(120) NULL,
  app_version VARCHAR(40) NULL,
  failure_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(160) NULL,
  last_sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_device_tokens_token (token),
  KEY idx_push_device_tokens_employee (employee_id),
  KEY idx_push_device_tokens_session (session_id),
  CONSTRAINT fk_push_device_tokens_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_push_device_tokens_session FOREIGN KEY (session_id) REFERENCES employee_sessions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_preferences (
  employee_id BIGINT UNSIGNED NOT NULL,
  category VARCHAR(40) NOT NULL,
  push_enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (employee_id, category),
  CONSTRAINT fk_notification_preferences_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
