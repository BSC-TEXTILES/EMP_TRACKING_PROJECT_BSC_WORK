-- Activity monitoring v2: website categories, idle threshold, session end
-- reasons, incident lifecycle, employee-edited summaries and record corrections.

ALTER TABLE monitoring_policies
  ADD COLUMN domain_categories JSON NULL AFTER allowed_domains,
  ADD COLUMN idle_threshold_minutes INT NOT NULL DEFAULT 5 AFTER retention_days,
  ADD COLUMN stale_session_minutes INT NOT NULL DEFAULT 15 AFTER idle_threshold_minutes;

ALTER TABLE monitoring_sessions
  ADD COLUMN end_reason VARCHAR(40) NULL AFTER status,
  ADD KEY idx_monitoring_session_heartbeat (status, last_heartbeat_at);

ALTER TABLE daily_activity_summaries
  ADD COLUMN key_activities_edited TINYINT(1) NOT NULL DEFAULT 0 AFTER key_activities;

ALTER TABLE error_incidents
  ADD COLUMN resolved_at DATETIME(3) NULL AFTER ticket_id,
  ADD COLUMN reopened_count INT NOT NULL DEFAULT 0 AFTER resolved_at,
  ADD KEY idx_incident_ticket (ticket_id);

ALTER TABLE application_usage_logs ADD KEY idx_app_usage_started (started_at);
ALTER TABLE browser_usage_logs ADD KEY idx_browser_usage_started (started_at);

CREATE TABLE IF NOT EXISTS activity_record_corrections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  record_type ENUM('app', 'browser', 'module') NOT NULL,
  record_id BIGINT UNSIGNED NOT NULL,
  requested_action ENUM('exclude', 'recategorize') NOT NULL,
  requested_category VARCHAR(40) NULL,
  reason VARCHAR(500) NOT NULL,
  record_snapshot JSON NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  review_note VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_correction_employee (employee_id, status),
  KEY idx_correction_status (status, created_at),
  CONSTRAINT fk_correction_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_correction_reviewer FOREIGN KEY (reviewed_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE monitoring_policies SET domain_categories = JSON_OBJECT(
  'github.com', 'Development', 'gitlab.com', 'Development', 'bitbucket.org', 'Development',
  'stackoverflow.com', 'Research', 'developer.mozilla.org', 'Documentation', 'docs.google.com', 'Documentation',
  'notion.so', 'Documentation', 'atlassian.net', 'Project Management', 'figma.com', 'Development',
  'learn.microsoft.com', 'Documentation', 'npmjs.com', 'Development', 'pypi.org', 'Development',
  'aws.amazon.com', 'Development', 'azure.microsoft.com', 'Development'
) WHERE domain_categories IS NULL;

INSERT IGNORE INTO application_catalog (name, process_pattern, category, is_approved) VALUES
  ('Microsoft Outlook', 'outlook', 'Communication', 0),
  ('Slack', 'slack', 'Communication', 0),
  ('Figma', 'figma', 'Design', 0),
  ('Power BI Desktop', 'pbidesktop', 'Data Analytics', 0),
  ('Windows Terminal', 'windowsterminal', 'Development', 0),
  ('KeePass', 'keepass', 'Other', 0),
  ('1Password', '1password', 'Other', 0),
  ('Bitwarden', 'bitwarden', 'Other', 0);
