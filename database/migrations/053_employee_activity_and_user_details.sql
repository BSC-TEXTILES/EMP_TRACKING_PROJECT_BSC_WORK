-- ============================================================================
-- Migration 053: Complete Employee Activity Tracking & User Details Module
-- BSC Textiles HRMS - Production-Ready Architecture
-- ============================================================================

-- 1. Employee Device Registry
CREATE TABLE IF NOT EXISTS employee_device_registry (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_identifier VARCHAR(191) NOT NULL,
  device_name VARCHAR(191) NOT NULL DEFAULT 'Workstation',
  os_name VARCHAR(64) NOT NULL DEFAULT 'Windows',
  os_version VARCHAR(64) NULL,
  agent_version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  tracking_status ENUM('active', 'paused', 'revoked', 'offline') NOT NULL DEFAULT 'active',
  last_sync_at DATETIME(3) NULL,
  is_authorized TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_edr_employee (employee_id),
  UNIQUE KEY uq_edr_emp_identifier (employee_id, device_identifier),
  CONSTRAINT fk_edr_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Employee Activity Sessions
CREATE TABLE IF NOT EXISTS employee_activity_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  work_date DATE NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  active_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  idle_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('active', 'idle', 'on_break', 'closed', 'crashed') NOT NULL DEFAULT 'active',
  ip_address VARCHAR(45) NULL,
  end_reason VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_eas_emp_date (employee_id, work_date),
  KEY idx_eas_started (started_at),
  KEY idx_eas_status (status),
  CONSTRAINT fk_eas_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Employee Activity Events (Timeline Stream)
CREATE TABLE IF NOT EXISTS employee_activity_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  event_type ENUM(
    'login', 'logout', 'app_launch', 'app_close', 'app_focus',
    'website_visit', 'idle_start', 'idle_end', 'screen_lock', 'screen_unlock',
    'system_sleep', 'system_wake', 'break_start', 'break_end', 'module_visit'
  ) NOT NULL,
  event_category VARCHAR(64) NOT NULL DEFAULT 'General',
  title VARCHAR(255) NOT NULL,
  details VARCHAR(1000) NULL,
  source ENUM('desktop_agent', 'browser_extension', 'web_portal', 'system') NOT NULL DEFAULT 'desktop_agent',
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  occurred_at DATETIME(3) NOT NULL,
  meta_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_eae_emp_time (employee_id, occurred_at),
  KEY idx_eae_session (session_id),
  KEY idx_eae_type (event_type),
  CONSTRAINT fk_eae_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Employee Idle Sessions
CREATE TABLE IF NOT EXISTS employee_idle_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  work_date DATE NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  idle_type ENUM('short_idle', 'extended_idle', 'long_idle', 'screen_lock', 'system_sleep') NOT NULL DEFAULT 'short_idle',
  reason VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_eis_emp_date (employee_id, work_date),
  KEY idx_eis_started (started_at),
  CONSTRAINT fk_eis_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Employee Application Usage
CREATE TABLE IF NOT EXISTS employee_application_usage (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  work_date DATE NOT NULL,
  app_name VARCHAR(191) NOT NULL,
  app_category VARCHAR(64) NOT NULL DEFAULT 'Unclassified',
  window_title VARCHAR(255) NULL,
  launched_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  total_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  launch_count INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_eau_emp_date (employee_id, work_date),
  KEY idx_eau_app_name (app_name),
  KEY idx_eau_category (app_category),
  CONSTRAINT fk_eau_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Employee Website Usage
CREATE TABLE IF NOT EXISTS employee_website_usage (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  work_date DATE NOT NULL,
  domain VARCHAR(191) NOT NULL,
  url VARCHAR(1000) NULL,
  page_title VARCHAR(255) NULL,
  category ENUM('Work-related', 'Communication', 'Productivity', 'Research', 'Entertainment', 'Other') NOT NULL DEFAULT 'Work-related',
  browser_name VARCHAR(64) NOT NULL DEFAULT 'Chrome',
  first_accessed_at DATETIME(3) NOT NULL,
  last_accessed_at DATETIME(3) NOT NULL,
  total_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  visit_count INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_ewu_emp_date (employee_id, work_date),
  KEY idx_ewu_domain (domain),
  KEY idx_ewu_category (category),
  CONSTRAINT fk_ewu_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Employee Login History
CREATE TABLE IF NOT EXISTS employee_login_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  login_at DATETIME(3) NOT NULL,
  logout_at DATETIME(3) NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  device_name VARCHAR(191) NULL,
  location_id INT UNSIGNED NULL,
  login_status ENUM('success', 'failed', 'active', 'terminated') NOT NULL DEFAULT 'success',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_elh_emp (employee_id),
  KEY idx_elh_login_at (login_at),
  CONSTRAINT fk_elh_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Employee Tracking Status (Real-Time State Cache)
CREATE TABLE IF NOT EXISTS employee_tracking_status (
  employee_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  is_online TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  is_idle TINYINT(1) NOT NULL DEFAULT 0,
  is_on_break TINYINT(1) NOT NULL DEFAULT 0,
  current_app VARCHAR(191) NULL,
  current_domain VARCHAR(191) NULL,
  current_session_id BIGINT UNSIGNED NULL,
  last_event_at DATETIME(3) NULL,
  last_heartbeat_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ets_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Employee Activity Daily Summary
CREATE TABLE IF NOT EXISTS employee_activity_daily_summary (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  total_system_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_active_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_idle_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_app_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_web_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  apps_count INT UNSIGNED NOT NULL DEFAULT 0,
  websites_count INT UNSIGNED NOT NULL DEFAULT 0,
  idle_sessions_count INT UNSIGNED NOT NULL DEFAULT 0,
  login_sessions_count INT UNSIGNED NOT NULL DEFAULT 0,
  active_idle_ratio DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  last_synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_eads_emp_date (employee_id, work_date),
  KEY idx_eads_date (work_date),
  CONSTRAINT fk_eads_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Employee Tracking Audit Logs
CREATE TABLE IF NOT EXISTS employee_tracking_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_id BIGINT UNSIGNED NOT NULL,
  target_employee_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(64) NOT NULL,
  view_name VARCHAR(64) NOT NULL DEFAULT 'user_details',
  ip_address VARCHAR(45) NULL,
  details_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_etal_target (target_employee_id),
  KEY idx_etal_actor (actor_id),
  KEY idx_etal_created (created_at),
  CONSTRAINT fk_etal_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_etal_target FOREIGN KEY (target_employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initial sync of tracking status cache for all active employees
INSERT IGNORE INTO employee_tracking_status (employee_id, is_online, is_active, is_idle, is_on_break, last_heartbeat_at)
SELECT id, 0, 0, 0, 0, NOW(3) FROM employees WHERE status = 'active';
