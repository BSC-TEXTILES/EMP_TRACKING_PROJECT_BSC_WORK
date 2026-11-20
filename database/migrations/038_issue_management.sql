-- Migration 038: Issue Management & Automatic Escalation.
-- Additive only: creates new tables and seeds default escalation rules. No existing table or row is changed.
-- Rollback (manual, destroys issue data only): database/rollback/038_issue_management.down.sql

CREATE TABLE IF NOT EXISTS issues (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_no VARCHAR(32) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(64) NOT NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'medium',
  status VARCHAR(24) NOT NULL DEFAULT 'new',
  affected_module VARCHAR(120) NULL,
  reporter_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NULL,
  department_id BIGINT UNSIGNED NULL,
  routing_mode VARCHAR(32) NOT NULL DEFAULT 'auto',
  assigned_to BIGINT UNSIGNED NULL,
  current_assignment_id BIGINT UNSIGNED NULL,
  escalation_level SMALLINT NOT NULL DEFAULT 0,
  -- Set when automatic escalation found no higher authorised manager (stops the engine retrying every minute).
  escalation_exhausted TINYINT(1) NOT NULL DEFAULT 0,
  acknowledged_at DATETIME(3) NULL,
  due_at DATETIME(3) NULL,
  last_escalated_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  resolved_by BIGINT UNSIGNED NULL,
  resolution TEXT NULL,
  reopen_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_issues_no (issue_no),
  KEY idx_issues_reporter (reporter_id, created_at),
  KEY idx_issues_assigned (assigned_to, status),
  KEY idx_issues_status (status, priority),
  KEY idx_issues_location (location_id, status),
  KEY idx_issues_due (status, due_at),
  KEY idx_issues_created (created_at),
  CONSTRAINT fk_issues_reporter FOREIGN KEY (reporter_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_issues_assigned FOREIGN KEY (assigned_to) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_issues_resolved_by FOREIGN KEY (resolved_by) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_issues_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_issues_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every hand-over of an issue. Exactly one row per issue is active (issues.current_assignment_id).
CREATE TABLE IF NOT EXISTS issue_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id BIGINT UNSIGNED NOT NULL,
  assigned_to BIGINT UNSIGNED NOT NULL,
  assigned_by BIGINT UNSIGNED NULL,
  reason VARCHAR(32) NOT NULL,
  level SMALLINT NOT NULL DEFAULT 0,
  note VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  acknowledged_at DATETIME(3) NULL,
  reminder_sent_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_issue_assignments_issue (issue_id, assigned_at),
  KEY idx_issue_assignments_employee (assigned_to, is_active),
  CONSTRAINT fk_issue_assignments_issue FOREIGN KEY (issue_id) REFERENCES issues (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_assignments_to FOREIGN KEY (assigned_to) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_assignments_by FOREIGN KEY (assigned_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'comment',
  body TEXT NOT NULL,
  is_internal TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_issue_comments_issue (issue_id, created_at),
  CONSTRAINT fk_issue_comments_issue FOREIGN KEY (issue_id) REFERENCES issues (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_comments_author FOREIGN KEY (author_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id BIGINT UNSIGNED NOT NULL,
  comment_id BIGINT UNSIGNED NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  is_internal TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_issue_attachments_file (issue_id, file_id),
  KEY idx_issue_attachments_file (file_id),
  CONSTRAINT fk_issue_attachments_issue FOREIGN KEY (issue_id) REFERENCES issues (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_attachments_comment FOREIGN KEY (comment_id) REFERENCES issue_comments (id) ON DELETE SET NULL,
  CONSTRAINT fk_issue_attachments_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_attachments_by FOREIGN KEY (uploaded_by) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per priority. Timings are edited by administrators in the app (never hardcoded in the frontend).
CREATE TABLE IF NOT EXISTS issue_escalation_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  priority VARCHAR(16) NOT NULL,
  ack_reminder_minutes INT NOT NULL,
  escalate_after_minutes INT NOT NULL,
  resolve_within_hours INT NOT NULL,
  overdue_repeat_minutes INT NOT NULL,
  max_level SMALLINT NOT NULL DEFAULT 3,
  notify_higher_immediately TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_issue_escalation_rules_priority (priority),
  CONSTRAINT fk_issue_escalation_rules_by FOREIGN KEY (updated_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO issue_escalation_rules
  (priority, ack_reminder_minutes, escalate_after_minutes, resolve_within_hours, overdue_repeat_minutes, max_level, notify_higher_immediately)
VALUES
  ('low', 120, 480, 72, 480, 3, 0),
  ('medium', 30, 60, 48, 240, 3, 0),
  ('high', 15, 30, 24, 120, 3, 0),
  ('critical', 10, 20, 8, 60, 4, 1);

CREATE TABLE IF NOT EXISTS issue_escalation_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id BIGINT UNSIGNED NOT NULL,
  from_employee_id BIGINT UNSIGNED NULL,
  to_employee_id BIGINT UNSIGNED NOT NULL,
  from_level SMALLINT NOT NULL,
  to_level SMALLINT NOT NULL,
  escalation_type VARCHAR(16) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  escalated_by BIGINT UNSIGNED NULL,
  notification_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_issue_escalation_history_issue (issue_id, created_at),
  CONSTRAINT fk_issue_escalation_history_issue FOREIGN KEY (issue_id) REFERENCES issues (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_escalation_history_from FOREIGN KEY (from_employee_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_issue_escalation_history_to FOREIGN KEY (to_employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_escalation_history_by FOREIGN KEY (escalated_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Permanent, append-only change log of every issue.
CREATE TABLE IF NOT EXISTS issue_activity_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NULL,
  details JSON NULL,
  is_internal TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_issue_activity_issue (issue_id, created_at),
  CONSTRAINT fk_issue_activity_issue FOREIGN KEY (issue_id) REFERENCES issues (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_activity_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delivery ledger for issue notifications. dedupe_key prevents duplicates; failed rows are retried by the job.
CREATE TABLE IF NOT EXISTS issue_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id BIGINT UNSIGNED NOT NULL,
  recipient_id BIGINT UNSIGNED NOT NULL,
  event VARCHAR(40) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body VARCHAR(500) NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  dedupe_key VARCHAR(160) NOT NULL,
  notification_id BIGINT UNSIGNED NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_issue_notifications_dedupe (dedupe_key),
  KEY idx_issue_notifications_issue (issue_id),
  KEY idx_issue_notifications_retry (status, attempts),
  CONSTRAINT fk_issue_notifications_issue FOREIGN KEY (issue_id) REFERENCES issues (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_notifications_recipient FOREIGN KEY (recipient_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES ('issues.routing_mode', 'auto_with_escalation');
