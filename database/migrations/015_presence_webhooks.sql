-- Live availability (presence) and outbound webhooks.
-- Additive only: no existing column, row or constraint is modified or removed.

-- ------------------------------ Presence -----------------------------------
-- availability_status holds a status the employee chose manually ('away',
-- 'dnd', 'on_leave'); NULL means "automatic" (derived from live activity).
-- last_active_at is the last time real keyboard/mouse/focus activity was
-- reported by the web app. Keystroke content is never sent or stored.
ALTER TABLE employees
  ADD COLUMN availability_status VARCHAR(24) NULL,
  ADD COLUMN availability_set_at DATETIME(3) NULL,
  ADD COLUMN last_active_at DATETIME(3) NULL;

INSERT INTO system_settings (setting_key, setting_value) VALUES ('presence.idle_away_minutes', '5')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- Status transitions, for the daily report and audit ("when did they go Away").
CREATE TABLE IF NOT EXISTS employee_status_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL,
  previous_status VARCHAR(24) NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'auto',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_status_events_employee (employee_id, created_at),
  CONSTRAINT fk_status_events_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ Webhooks -----------------------------------
CREATE TABLE IF NOT EXISTS webhooks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  url VARCHAR(500) NOT NULL,
  events JSON NOT NULL,
  -- AES-256-GCM under the server master key; never returned to the browser.
  secret_enc TEXT NOT NULL,
  secret_hint VARCHAR(8) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_delivery_at DATETIME(3) NULL,
  last_status VARCHAR(16) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_webhooks_active (is_active),
  CONSTRAINT fk_webhooks_created_by FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (webhook, event). The unique key makes event fan-out idempotent:
-- the same event id is never queued twice for one endpoint.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  webhook_id BIGINT UNSIGNED NOT NULL,
  event_id CHAR(36) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_until DATETIME(3) NULL,
  response_status INT NULL,
  response_body VARCHAR(1000) NULL,
  error VARCHAR(500) NULL,
  duration_ms INT NULL,
  is_test TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_deliveries_event (webhook_id, event_id),
  KEY idx_webhook_deliveries_due (status, next_attempt_at),
  KEY idx_webhook_deliveries_webhook (webhook_id, created_at),
  CONSTRAINT fk_webhook_deliveries_webhook FOREIGN KEY (webhook_id) REFERENCES webhooks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
