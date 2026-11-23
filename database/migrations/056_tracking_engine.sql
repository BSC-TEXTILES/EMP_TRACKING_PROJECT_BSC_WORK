-- ============================================================================
-- Migration 056: Employee activity tracking engine (canonical pipeline)
--
-- Additive only. Existing employee, attendance and legacy activity tables are
-- untouched. Device identity reuses employee_devices + device_registrations
-- (hashed tokens); everything the Windows agent and browser extension report is
-- stored in the tracking_* tables below. All DATETIME values are UTC; work_date
-- is the Asia/Kolkata business date of the event.
-- ============================================================================

-- 1. Configuration: one global row plus optional per-location overrides.
--    NULL in a location row means "inherit the global value".
CREATE TABLE IF NOT EXISTS tracking_settings (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scope_key VARCHAR(40) NOT NULL,
  location_id BIGINT UNSIGNED NULL,
  tracking_enabled TINYINT(1) NULL,
  device_registration_enabled TINYINT(1) NULL,
  self_enrollment_enabled TINYINT(1) NULL,
  app_tracking_enabled TINYINT(1) NULL,
  website_tracking_enabled TINYINT(1) NULL,
  window_title_tracking_enabled TINYINT(1) NULL,
  idle_threshold_seconds INT UNSIGNED NULL,
  heartbeat_interval_seconds INT UNSIGNED NULL,
  sync_interval_seconds INT UNSIGNED NULL,
  offline_after_seconds INT UNSIGNED NULL,
  latest_agent_version VARCHAR(20) NULL,
  minimum_agent_version VARCHAR(20) NULL,
  retention_days INT UNSIGNED NULL,
  notice_text TEXT NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tracking_settings_scope (scope_key),
  KEY idx_tracking_settings_location (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO tracking_settings
  (scope_key, location_id, tracking_enabled, device_registration_enabled, self_enrollment_enabled,
   app_tracking_enabled, website_tracking_enabled, window_title_tracking_enabled,
   idle_threshold_seconds, heartbeat_interval_seconds, sync_interval_seconds, offline_after_seconds,
   latest_agent_version, minimum_agent_version, retention_days, notice_text)
VALUES
  ('global', NULL, 1, 1, 0, 1, 1, 0, 300, 60, 30, 180, '2.0.0', '2.0.0', 90,
   'BSC Textiles records work activity on this company computer while you are signed in: the name of the application in the foreground, active and idle time, screen lock and unlock, and (when the browser extension is installed) the website domain of the active tab. It never records keystrokes, passwords, clipboard contents, screenshots, files, page contents, the microphone or the camera. You can see your own recorded activity in the HRMS. Questions: contact HR.');

-- 2. One-time enrollment codes. Only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS tracking_enrollment_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  code_hash CHAR(64) NOT NULL,
  code_hint VARCHAR(8) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  allow_reassign TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  used_device_id BIGINT UNSIGNED NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tracking_enroll_hash (code_hash),
  KEY idx_tracking_enroll_employee (employee_id, created_at),
  CONSTRAINT fk_tracking_enroll_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Live state of every enrolled device (one row per device).
CREATE TABLE IF NOT EXISTS tracking_device_status (
  device_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  agent_version VARCHAR(20) NULL,
  agent_state ENUM('running','disabled','stopped','offline') NOT NULL DEFAULT 'running',
  activity_state ENUM('active','idle','locked','offline','unknown') NOT NULL DEFAULT 'unknown',
  current_app VARCHAR(160) NULL,
  current_browser VARCHAR(60) NULL,
  current_domain VARCHAR(190) NULL,
  hostname VARCHAR(120) NULL,
  os_name VARCHAR(60) NULL,
  os_version VARCHAR(60) NULL,
  ip VARCHAR(64) NULL,
  notice_acknowledged_at DATETIME(3) NULL,
  enrolled_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_heartbeat_at DATETIME(3) NULL,
  last_event_at DATETIME(3) NULL,
  last_sync_at DATETIME(3) NULL,
  last_sync_error VARCHAR(255) NULL,
  last_sync_error_at DATETIME(3) NULL,
  pending_events INT UNSIGNED NOT NULL DEFAULT 0,
  dropped_events INT UNSIGNED NOT NULL DEFAULT 0,
  agent_sync_failures INT UNSIGNED NOT NULL DEFAULT 0,
  connection_failures INT UNSIGNED NOT NULL DEFAULT 0,
  clock_skew_ms INT NOT NULL DEFAULT 0,
  extension_seen_at DATETIME(3) NULL,
  went_offline_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_tracking_status_employee (employee_id),
  KEY idx_tracking_status_heartbeat (last_heartbeat_at),
  CONSTRAINT fk_tracking_status_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_tracking_status_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Tracking sessions: one continuous agent run inside a Windows sign-in.
--    The agent creates the id, so sessions recorded offline replay correctly.
CREATE TABLE IF NOT EXISTS tracking_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  client_session_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  last_seen_at DATETIME(3) NOT NULL,
  end_reason VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tracking_session_client (device_id, client_session_id),
  KEY idx_tracking_session_emp_date (employee_id, work_date),
  KEY idx_tracking_session_open (ended_at, last_seen_at),
  CONSTRAINT fk_tracking_session_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_tracking_session_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Observed events. 'activity' and 'web' rows are intervals (started_at..ended_at)
--    with a state; every other type is a point-in-time event. client_event_id is
--    generated by the agent, so retries and offline replays are idempotent.
CREATE TABLE IF NOT EXISTS tracking_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  session_id BIGINT UNSIGNED NULL,
  client_event_id VARCHAR(64) NOT NULL,
  event_type ENUM('activity','web','session_start','session_end','lock','unlock','idle_start','idle_end',
                  'suspend','resume','agent_start','agent_stop','tracking_disabled','tracking_enabled',
                  'device_offline','device_online','hrms_login','hrms_logout','hrms_page') NOT NULL,
  source ENUM('agent','extension','web','system') NOT NULL DEFAULT 'agent',
  state ENUM('active','idle','locked') NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  app_name VARCHAR(160) NULL,
  process_name VARCHAR(160) NULL,
  window_title VARCHAR(255) NULL,
  browser VARCHAR(60) NULL,
  domain VARCHAR(190) NULL,
  detail VARCHAR(255) NULL,
  work_date DATE NOT NULL,
  batch_id VARCHAR(64) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tracking_event_client (employee_id, client_event_id),
  KEY idx_tracking_event_emp_date (employee_id, work_date, event_type),
  KEY idx_tracking_event_date (work_date, employee_id),
  KEY idx_tracking_event_device (device_id, started_at),
  KEY idx_tracking_event_session (session_id),
  KEY idx_tracking_event_received (received_at),
  CONSTRAINT fk_tracking_event_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Heartbeat history (used for offline-gap and completeness calculations).
CREATE TABLE IF NOT EXISTS tracking_heartbeats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  activity_state ENUM('active','idle','locked','offline','unknown') NOT NULL DEFAULT 'unknown',
  pending_events INT UNSIGNED NOT NULL DEFAULT 0,
  agent_version VARCHAR(20) NULL,
  KEY idx_tracking_hb_device (device_id, received_at),
  KEY idx_tracking_hb_employee (employee_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Upload batches (offline synchronisation record).
CREATE TABLE IF NOT EXISTS tracking_sync_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  batch_id VARCHAR(64) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  event_count INT UNSIGNED NOT NULL DEFAULT 0,
  accepted INT UNSIGNED NOT NULL DEFAULT 0,
  duplicates INT UNSIGNED NOT NULL DEFAULT 0,
  rejected INT UNSIGNED NOT NULL DEFAULT 0,
  oldest_event_at DATETIME(3) NULL,
  newest_event_at DATETIME(3) NULL,
  is_replay TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_tracking_batch (device_id, batch_id),
  KEY idx_tracking_batch_employee (employee_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Device registry metadata for agent-enrolled devices.
ALTER TABLE employee_devices
  ADD COLUMN hostname VARCHAR(120) NULL AFTER device_name,
  ADD COLUMN registered_via VARCHAR(20) NOT NULL DEFAULT 'legacy' AFTER machine_fingerprint;
