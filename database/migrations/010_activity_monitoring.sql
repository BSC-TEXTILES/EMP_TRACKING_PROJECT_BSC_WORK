-- Employee activity monitoring: device-scoped, transparent and consent-based.
-- Only work metadata is stored; keystrokes, clipboard, passwords and private
-- application content are never collected.

CREATE TABLE IF NOT EXISTS monitoring_policies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  policy_text TEXT NOT NULL,
  screenshot_enabled TINYINT(1) NOT NULL DEFAULT 0,
  screenshot_interval_minutes INT NOT NULL DEFAULT 30,
  retention_days INT NOT NULL DEFAULT 90,
  allowed_apps JSON NULL,
  blocked_apps JSON NULL,
  allowed_domains JSON NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  effective_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_monitoring_policy_active (is_active, effective_at),
  CONSTRAINT fk_monitoring_policy_author FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_activity_consents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  policy_id BIGINT UNSIGNED NOT NULL,
  policy_version INT NOT NULL,
  acknowledged_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_consent_employee_policy (employee_id, policy_id, policy_version),
  KEY idx_consent_employee (employee_id, revoked_at),
  CONSTRAINT fk_consent_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_consent_policy FOREIGN KEY (policy_id) REFERENCES monitoring_policies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  os_name VARCHAR(40) NOT NULL,
  os_version VARCHAR(60) NULL,
  agent_version VARCHAR(40) NULL,
  machine_fingerprint VARCHAR(128) NOT NULL,
  status ENUM('active', 'revoked', 'pending') NOT NULL DEFAULT 'active',
  registered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  revoked_reason VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_fingerprint (machine_fingerprint),
  KEY idx_device_employee (employee_id, status),
  CONSTRAINT fk_device_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_registrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_prefix VARCHAR(12) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_registration_token (token_hash),
  KEY idx_registration_device (device_id, revoked_at),
  CONSTRAINT fk_registration_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_registration_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at DATETIME(3) NULL,
  last_heartbeat_at DATETIME(3) NULL,
  status ENUM('active', 'paused', 'ended') NOT NULL DEFAULT 'active',
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_monitoring_session_employee (employee_id, status),
  KEY idx_monitoring_session_date (work_date),
  CONSTRAINT fk_monitoring_session_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_monitoring_session_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_catalog (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  process_pattern VARCHAR(160) NOT NULL,
  category ENUM('Development','Browser','Communication','Design','Data Analytics','Office Productivity','Marketing','Administration','IT Support','Other') NOT NULL DEFAULT 'Other',
  is_approved TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_application_name (name),
  KEY idx_application_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_usage_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  app_name VARCHAR(120) NOT NULL,
  app_category VARCHAR(40) NOT NULL DEFAULT 'Other',
  process_name VARCHAR(160) NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  active_seconds INT NOT NULL DEFAULT 0,
  last_active_at DATETIME(3) NULL,
  client_event_id VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_usage_event (client_event_id),
  KEY idx_app_usage_employee (employee_id, started_at),
  KEY idx_app_usage_session (session_id),
  CONSTRAINT fk_app_usage_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_app_usage_session FOREIGN KEY (session_id) REFERENCES monitoring_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_app_usage_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS browser_usage_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  browser VARCHAR(60) NOT NULL,
  domain VARCHAR(190) NOT NULL,
  tab_title VARCHAR(255) NULL,
  category VARCHAR(40) NOT NULL DEFAULT 'Business Operations',
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  active_seconds INT NOT NULL DEFAULT 0,
  client_event_id VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_browser_usage_event (client_event_id),
  KEY idx_browser_usage_employee (employee_id, started_at),
  CONSTRAINT fk_browser_usage_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_browser_usage_session FOREIGN KEY (session_id) REFERENCES monitoring_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_browser_usage_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS browser_extension_devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  browser VARCHAR(60) NOT NULL,
  extension_version VARCHAR(30) NULL,
  installed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  UNIQUE KEY uq_extension_device_browser (device_id, browser),
  CONSTRAINT fk_extension_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_extension_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS internal_module_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  module VARCHAR(80) NOT NULL,
  page_path VARCHAR(190) NOT NULL,
  entered_at DATETIME(3) NOT NULL,
  exited_at DATETIME(3) NULL,
  active_seconds INT NOT NULL DEFAULT 0,
  related_task_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(40) NOT NULL DEFAULT 'page_view',
  client_event_id VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_module_activity_event (client_event_id),
  KEY idx_module_activity_employee (employee_id, entered_at),
  CONSTRAINT fk_module_activity_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_module_activity_session FOREIGN KEY (session_id) REFERENCES monitoring_sessions (id) ON DELETE SET NULL,
  CONSTRAINT fk_module_activity_task FOREIGN KEY (related_task_id) REFERENCES tasks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS work_activity_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  source_type VARCHAR(40) NOT NULL,
  source_id BIGINT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL,
  detail TEXT NULL,
  keywords JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  client_event_id VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_activity_event (client_event_id),
  KEY idx_work_activity_employee (employee_id, occurred_at),
  CONSTRAINT fk_work_activity_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_work_activity_session FOREIGN KEY (session_id) REFERENCES monitoring_sessions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_keywords (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  keyword VARCHAR(80) NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT 'General',
  weight DECIMAL(5,2) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_activity_keyword (keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_activity_summaries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  summary_date DATE NOT NULL,
  attendance_minutes INT NOT NULL DEFAULT 0,
  break_minutes INT NOT NULL DEFAULT 0,
  active_minutes INT NOT NULL DEFAULT 0,
  app_breakdown JSON NULL,
  module_breakdown JSON NULL,
  task_summary JSON NULL,
  key_activities JSON NULL,
  issues JSON NULL,
  tickets JSON NULL,
  employee_notes TEXT NULL,
  status ENUM('draft', 'submitted', 'approved', 'returned') NOT NULL DEFAULT 'draft',
  submitted_at DATETIME(3) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  manager_note VARCHAR(500) NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_activity (employee_id, summary_date),
  KEY idx_daily_activity_status (status, summary_date),
  CONSTRAINT fk_daily_activity_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_activity_reviewer FOREIGN KEY (reviewed_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS weekly_performance_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  metrics JSON NULL,
  score DECIMAL(5,2) NOT NULL DEFAULT 0,
  grade VARCHAR(20) NOT NULL DEFAULT 'C',
  status ENUM('preliminary', 'final') NOT NULL DEFAULT 'preliminary',
  manager_remarks VARCHAR(1000) NULL,
  employee_feedback VARCHAR(1000) NULL,
  previous_score DECIMAL(5,2) NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_weekly_report (employee_id, week_start),
  KEY idx_weekly_report_status (status, week_start),
  CONSTRAINT fk_weekly_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_weekly_reviewer FOREIGN KEY (reviewed_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS screenshot_evidence (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  file_id BIGINT UNSIGNED NULL,
  app_name VARCHAR(120) NULL,
  reason VARCHAR(120) NOT NULL DEFAULT 'employee_submitted',
  status ENUM('pending', 'stored', 'deleted', 'rejected') NOT NULL DEFAULT 'pending',
  captured_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_screenshot_employee (employee_id, captured_at),
  CONSTRAINT fk_screenshot_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_screenshot_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_screenshot_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS error_incidents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fingerprint CHAR(64) NOT NULL,
  title VARCHAR(200) NOT NULL,
  category VARCHAR(60) NOT NULL,
  application VARCHAR(120) NULL,
  module VARCHAR(80) NULL,
  severity ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
  occurrence_count INT NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  status ENUM('open', 'suggested', 'ticket_created', 'resolved', 'ignored') NOT NULL DEFAULT 'open',
  ticket_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_incident_fingerprint (fingerprint),
  KEY idx_incident_status (status, last_seen_at),
  CONSTRAINT fk_incident_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_error_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  session_id BIGINT UNSIGNED NULL,
  incident_id BIGINT UNSIGNED NULL,
  ticket_id BIGINT UNSIGNED NULL,
  application VARCHAR(120) NULL,
  module VARCHAR(80) NULL,
  category VARCHAR(60) NOT NULL,
  error_code VARCHAR(80) NULL,
  severity ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
  description VARCHAR(1000) NOT NULL,
  diagnostic JSON NULL,
  status ENUM('new', 'grouped', 'ticket_created', 'suggested', 'dismissed') NOT NULL DEFAULT 'new',
  occurred_at DATETIME(3) NOT NULL,
  client_event_id VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_error_event (client_event_id),
  KEY idx_error_employee (employee_id, occurred_at),
  KEY idx_error_incident (incident_id),
  CONSTRAINT fk_error_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_error_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE SET NULL,
  CONSTRAINT fk_error_incident FOREIGN KEY (incident_id) REFERENCES error_incidents (id) ON DELETE SET NULL,
  CONSTRAINT fk_error_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS automatic_ticket_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_id BIGINT UNSIGNED NOT NULL,
  ticket_id BIGINT UNSIGNED NOT NULL,
  rule VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_auto_ticket (incident_id, ticket_id),
  CONSTRAINT fk_auto_link_incident FOREIGN KEY (incident_id) REFERENCES error_incidents (id) ON DELETE CASCADE,
  CONSTRAINT fk_auto_link_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_health_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  cpu_percent DECIMAL(5,2) NULL,
  memory_percent DECIMAL(5,2) NULL,
  disk_free_mb INT NULL,
  agent_version VARCHAR(40) NULL,
  details JSON NULL,
  reported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_device_health (device_id, reported_at),
  CONSTRAINT fk_health_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_health_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  target_employee_id BIGINT UNSIGNED NULL,
  entity_type VARCHAR(60) NULL,
  entity_id BIGINT UNSIGNED NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_activity_audit_employee (target_employee_id, created_at),
  KEY idx_activity_audit_action (action, created_at),
  CONSTRAINT fk_activity_audit_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Default transparent policy: no screenshots, approved work apps and domains only.
INSERT INTO monitoring_policies (name, version, policy_text, screenshot_enabled, screenshot_interval_minutes, retention_days, allowed_apps, blocked_apps, allowed_domains, is_active)
SELECT
  'Employee Activity Monitoring Policy',
  1,
  'This organisation measures work activity only during an authorised attendance session on a company-managed device. It records the foreground application, active duration, approved work domains, internal module usage and technical errors. It never records keystrokes, passwords, OTPs, clipboard contents, private messages, personal accounts or screenshots of excluded applications. Screenshot evidence is disabled. Employees can review their recorded activity, correct inaccurate records and withdraw consent outside an active session.',
  0, 30, 90,
  JSON_ARRAY('Google Chrome','Brave Browser','Microsoft Edge','Firefox','Visual Studio Code','Antigravity','Android Studio','IntelliJ IDEA','Postman','Microsoft Excel','Microsoft Word','PowerPoint','Microsoft Teams'),
  JSON_ARRAY('KeePass','1Password','Bitwarden','LastPass'),
  JSON_ARRAY('github.com','gitlab.com','bitbucket.org','stackoverflow.com','developer.mozilla.org','docs.google.com','notion.so','atlassian.net','figma.com','learn.microsoft.com','npmjs.com','pypi.org','aws.amazon.com','azure.microsoft.com'),
  1
WHERE NOT EXISTS (SELECT 1 FROM monitoring_policies);

INSERT IGNORE INTO application_catalog (name, process_pattern, category) VALUES
  ('Google Chrome', 'chrome', 'Browser'),
  ('Brave Browser', 'brave', 'Browser'),
  ('Microsoft Edge', 'msedge', 'Browser'),
  ('Firefox', 'firefox', 'Browser'),
  ('Visual Studio Code', 'code', 'Development'),
  ('Antigravity', 'antigravity', 'Development'),
  ('Android Studio', 'studio64', 'Development'),
  ('IntelliJ IDEA', 'idea64', 'Development'),
  ('Postman', 'postman', 'Development'),
  ('Microsoft Excel', 'excel', 'Office Productivity'),
  ('Microsoft Word', 'winword', 'Office Productivity'),
  ('PowerPoint', 'powerpnt', 'Office Productivity'),
  ('Microsoft Teams', 'teams', 'Communication');

INSERT IGNORE INTO activity_keywords (keyword, category, weight) VALUES
  ('website development', 'Development', 2),
  ('api integration', 'Development', 2),
  ('database optimization', 'Development', 2),
  ('bug fixing', 'Development', 1.5),
  ('ui improvements', 'Design', 1.5),
  ('testing', 'Quality', 1),
  ('deployment', 'Delivery', 2),
  ('documentation', 'Documentation', 1);

INSERT IGNORE INTO permissions (code, module, action, description) VALUES
  ('activity.view.own', 'activity', 'view.own', 'View own monitored activity'),
  ('activity.view.team', 'activity', 'view.team', 'View team activity and daily summaries'),
  ('activity.view.all', 'activity', 'view.all', 'View organisation-wide activity analytics'),
  ('activity.review', 'activity', 'review', 'Review daily activity summaries and weekly performance'),
  ('activity.devices.manage', 'activity', 'devices.manage', 'Register and revoke monitoring devices'),
  ('activity.policy.manage', 'activity', 'policy.manage', 'Configure monitoring policy and retention');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module = 'activity'
WHERE r.slug IN ('super_admin', 'company_owner');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module = 'activity'
WHERE r.slug IN ('executive', 'general_manager', 'hr_manager')
  AND p.code IN ('activity.view.own', 'activity.view.team', 'activity.view.all', 'activity.review', 'activity.policy.manage');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module = 'activity'
WHERE r.slug IN ('manager', 'department_head', 'store_manager')
  AND p.code IN ('activity.view.own', 'activity.view.team', 'activity.review');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module = 'activity'
WHERE r.slug = 'it_admin';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module = 'activity'
WHERE r.slug IN ('employee', 'hr_executive', 'helpdesk', 'payroll_admin')
  AND p.code IN ('activity.view.own');
