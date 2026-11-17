-- Migration 025: Workforce Master Activity & Login/Logout Tracking
-- Additive migration for BSC Textiles Automatic Employee Live Tracking & Workforce Management

-- 1. Ensure columns exist on employee_sessions for login/logout auditing
SET @has_sess_browser := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_sessions' AND COLUMN_NAME = 'browser');
SET @sql_sess_browser := IF(@has_sess_browser = 0, 'ALTER TABLE employee_sessions ADD COLUMN browser VARCHAR(120) NULL AFTER user_agent', 'SELECT 1');
PREPARE stmt1 FROM @sql_sess_browser; EXECUTE stmt1; DEALLOCATE PREPARE stmt1;

SET @has_sess_os := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_sessions' AND COLUMN_NAME = 'os');
SET @sql_sess_os := IF(@has_sess_os = 0, 'ALTER TABLE employee_sessions ADD COLUMN os VARCHAR(60) NULL AFTER browser', 'SELECT 1');
PREPARE stmt2 FROM @sql_sess_os; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

SET @has_sess_dev_id := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_sessions' AND COLUMN_NAME = 'device_id');
SET @sql_sess_dev_id := IF(@has_sess_dev_id = 0, 'ALTER TABLE employee_sessions ADD COLUMN device_id BIGINT UNSIGNED NULL AFTER os', 'SELECT 1');
PREPARE stmt3 FROM @sql_sess_dev_id; EXECUTE stmt3; DEALLOCATE PREPARE stmt3;

SET @has_sess_dur := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_sessions' AND COLUMN_NAME = 'duration_minutes');
SET @sql_sess_dur := IF(@has_sess_dur = 0, 'ALTER TABLE employee_sessions ADD COLUMN duration_minutes INT NOT NULL DEFAULT 0 AFTER revoked_reason', 'SELECT 1');
PREPARE stmt4 FROM @sql_sess_dur; EXECUTE stmt4; DEALLOCATE PREPARE stmt4;

SET @has_sess_term := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_sessions' AND COLUMN_NAME = 'termination_status');
SET @sql_sess_term := IF(@has_sess_term = 0, "ALTER TABLE employee_sessions ADD COLUMN termination_status VARCHAR(24) NOT NULL DEFAULT 'active' AFTER duration_minutes", 'SELECT 1');
PREPARE stmt5 FROM @sql_sess_term; EXECUTE stmt5; DEALLOCATE PREPARE stmt5;

-- 2. Dedicated employee_login_audit table for permanent login/logout records
CREATE TABLE IF NOT EXISTS employee_login_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  employee_code VARCHAR(40) NULL,
  full_name VARCHAR(120) NULL,
  location_name VARCHAR(120) NULL,
  login_at DATETIME(3) NOT NULL,
  logout_at DATETIME(3) NULL,
  last_heartbeat_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  duration_minutes INT NOT NULL DEFAULT 0,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  browser VARCHAR(120) NULL,
  os VARCHAR(60) NULL,
  device_id BIGINT UNSIGNED NULL,
  login_status VARCHAR(24) NOT NULL DEFAULT 'success',
  logout_reason VARCHAR(120) NULL,
  termination_status VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_login_audit_emp_date (employee_id, login_at),
  KEY idx_login_audit_login_at (login_at),
  KEY idx_login_audit_status (termination_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Startup configurations table for agent auto-launch bindings
CREATE TABLE IF NOT EXISTS agent_startup_configs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  machine_fingerprint VARCHAR(120) NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  auto_start_enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_auto_started_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_startup (machine_fingerprint),
  KEY idx_agent_startup_emp (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
