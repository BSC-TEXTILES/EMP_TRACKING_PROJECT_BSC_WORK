-- ============================================================================
-- Migration 061: Complete Employee Tracking, Activity Monitoring & Automated KPI System
--
-- Adds structured tables for:
--  - employee_browser_sessions & employee_browser_tabs (Chrome tab tracking)
--  - employee_idle_periods & employee_breaks (Idle & break time reconciliation)
--  - employee_daily_kpis, employee_weekly_kpis, employee_monthly_kpis (KPI reports)
--  - monitoring_agent_status & report_generation_history (Live status & downloads)
--  - Relational views for employee_attendance, employee_leave_records, employee_weekoff_records
-- ============================================================================

-- 1. Browser sessions and active Chrome tab activity tracking
CREATE TABLE IF NOT EXISTS employee_browser_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  session_id BIGINT UNSIGNED NULL,
  browser VARCHAR(60) NOT NULL DEFAULT 'chrome',
  browser_version VARCHAR(40) NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  total_active_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_tabs_opened INT UNSIGNED NOT NULL DEFAULT 0,
  total_tab_switches INT UNSIGNED NOT NULL DEFAULT 0,
  work_date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_browser_sess_emp_date (employee_id, work_date),
  KEY idx_browser_sess_device (device_id),
  CONSTRAINT fk_browser_sess_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_browser_tabs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  browser_session_id BIGINT UNSIGNED NULL,
  tab_id VARCHAR(64) NULL,
  window_id VARCHAR(64) NULL,
  tab_title VARCHAR(255) NULL,
  domain VARCHAR(190) NOT NULL,
  url_protocol VARCHAR(16) NULL DEFAULT 'https',
  opened_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  active_duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  switch_count INT UNSIGNED NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  work_date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_browser_tab_emp_date (employee_id, work_date),
  KEY idx_browser_tab_domain (domain),
  CONSTRAINT fk_browser_tab_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Idle periods with reason and strict active/idle/break reconciliation
CREATE TABLE IF NOT EXISTS employee_idle_periods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  session_id BIGINT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  reason ENUM('keyboard_mouse_inactive', 'screen_locked', 'system_sleep', 'manual') NOT NULL DEFAULT 'keyboard_mouse_inactive',
  work_date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_idle_emp_date (employee_id, work_date),
  KEY idx_idle_device (device_id),
  CONSTRAINT fk_idle_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_breaks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  break_type VARCHAR(40) NOT NULL DEFAULT 'regular',
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  notes VARCHAR(255) NULL,
  status ENUM('ongoing', 'completed') NOT NULL DEFAULT 'completed',
  work_date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_break_emp_date (employee_id, work_date),
  CONSTRAINT fk_break_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Daily KPI Reports
CREATE TABLE IF NOT EXISTS employee_daily_kpis (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  report_date DATE NOT NULL,
  first_login_at DATETIME(3) NULL,
  last_logout_at DATETIME(3) NULL,
  total_session_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  active_working_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  idle_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  break_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  locked_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  attendance_status VARCHAR(32) NOT NULL DEFAULT 'present',
  leave_type_code VARCHAR(16) NULL,
  is_weekly_off TINYINT(1) NOT NULL DEFAULT 0,
  kpi_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  task_completion_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  application_summary JSON NULL,
  browser_tab_summary JSON NULL,
  domain_summary JSON NULL,
  calculation_rules JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_emp_daily_kpi (employee_id, report_date),
  KEY idx_daily_kpi_date (report_date),
  CONSTRAINT fk_daily_kpi_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Weekly KPI Reports
CREATE TABLE IF NOT EXISTS employee_weekly_kpis (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  scheduled_days INT UNSIGNED NOT NULL DEFAULT 6,
  attended_days INT UNSIGNED NOT NULL DEFAULT 0,
  absent_days INT UNSIGNED NOT NULL DEFAULT 0,
  leave_days INT UNSIGNED NOT NULL DEFAULT 0,
  weekoff_days INT UNSIGNED NOT NULL DEFAULT 0,
  total_working_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_idle_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_break_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  avg_daily_working_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  avg_daily_idle_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  attendance_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  weekly_kpi_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  app_usage_summary JSON NULL,
  daily_breakdown JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_emp_weekly_kpi (employee_id, week_start),
  KEY idx_weekly_kpi_range (week_start, week_end),
  CONSTRAINT fk_weekly_kpi_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Monthly KPI Reports
CREATE TABLE IF NOT EXISTS employee_monthly_kpis (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  period CHAR(7) NOT NULL,
  year INT UNSIGNED NOT NULL,
  month INT UNSIGNED NOT NULL,
  total_attendance_days INT UNSIGNED NOT NULL DEFAULT 0,
  total_absent_days INT UNSIGNED NOT NULL DEFAULT 0,
  approved_leave_days INT UNSIGNED NOT NULL DEFAULT 0,
  week_off_days INT UNSIGNED NOT NULL DEFAULT 0,
  holiday_days INT UNSIGNED NOT NULL DEFAULT 0,
  attendance_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  total_session_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_working_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_active_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_idle_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  total_break_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  avg_working_hours_per_day DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  avg_idle_hours_per_day DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  highest_idle_day DATE NULL,
  highest_idle_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  idle_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  attendance_kpi DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  working_hours_kpi DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  active_time_kpi DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  idle_time_kpi DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  task_completion_kpi DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  overall_kpi_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  previous_month_score DECIMAL(5,2) NULL,
  app_usage_json JSON NULL,
  domain_usage_json JSON NULL,
  metrics_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_emp_monthly_kpi (employee_id, period),
  KEY idx_monthly_kpi_period (period),
  CONSTRAINT fk_monthly_kpi_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Monitoring Agent Status
CREATE TABLE IF NOT EXISTS monitoring_agent_status (
  device_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  agent_type VARCHAR(32) NOT NULL DEFAULT 'desktop_agent',
  agent_version VARCHAR(24) NULL,
  connection_status ENUM('connected', 'disconnected', 'never_connected') NOT NULL DEFAULT 'never_connected',
  activity_state ENUM('active', 'idle', 'on_break', 'locked', 'offline', 'unknown') NOT NULL DEFAULT 'unknown',
  current_app VARCHAR(160) NULL,
  current_browser VARCHAR(60) NULL,
  current_domain VARCHAR(190) NULL,
  current_tab_title VARCHAR(255) NULL,
  last_heartbeat_at DATETIME(3) NULL,
  last_sync_at DATETIME(3) NULL,
  last_event_at DATETIME(3) NULL,
  pending_events INT UNSIGNED NOT NULL DEFAULT 0,
  dropped_events INT UNSIGNED NOT NULL DEFAULT 0,
  ip VARCHAR(64) NULL,
  os_name VARCHAR(60) NULL,
  os_version VARCHAR(60) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_mon_status_emp (employee_id),
  CONSTRAINT fk_mon_status_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Report Generation History
CREATE TABLE IF NOT EXISTS report_generation_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  report_type ENUM('daily_kpi', 'weekly_kpi', 'monthly_kpi', 'attendance_summary', 'consolidated_monthly') NOT NULL,
  period VARCHAR(32) NOT NULL,
  scope_type ENUM('employee', 'location', 'all') NOT NULL DEFAULT 'all',
  target_id BIGINT UNSIGNED NULL,
  format ENUM('pdf', 'xlsx', 'csv', 'json') NOT NULL,
  file_path VARCHAR(255) NULL,
  file_name VARCHAR(255) NULL,
  status ENUM('scheduled', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'completed',
  generated_by BIGINT UNSIGNED NULL,
  error_message VARCHAR(255) NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_rep_gen_type_period (report_type, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Relational Views for attendance, leave, and weekly-off records
CREATE OR REPLACE VIEW employee_attendance AS
  SELECT a.id, a.employee_id, a.work_date, a.session_number, a.status, a.check_in_at, a.check_out_at,
         a.total_minutes AS total_working_minutes, a.break_minutes AS break_duration_minutes,
         GREATEST(0, COALESCE(a.total_minutes, 0) - COALESCE(a.break_minutes, 0)) AS net_working_minutes,
         a.overtime_minutes, a.is_late, a.early_departure AS is_early_departure, a.auto_closed, a.source,
         a.created_at, a.updated_at
  FROM attendance a;

CREATE OR REPLACE VIEW employee_leave_records AS
  SELECT l.id, l.employee_id, l.leave_type_id, l.request_kind, l.start_date, l.end_date,
         l.days, l.status, l.reason, l.manager_status, l.hr_status, l.created_at, l.updated_at
  FROM leave_requests l;

CREATE OR REPLACE VIEW employee_weekoff_records AS
  SELECT w.id, w.employee_id, w.alloc_year, w.alloc_month, w.weekday, w.allocated, w.taken,
         w.pending, GREATEST(0, w.allocated - w.taken - w.pending) AS remaining, w.computed_at
  FROM weekly_off_allocations w;
