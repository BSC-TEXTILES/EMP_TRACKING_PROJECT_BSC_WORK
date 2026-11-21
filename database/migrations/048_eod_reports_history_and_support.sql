-- 048_eod_reports_history_and_support.sql
-- End-of-Day (EOD) work report history, audit trail, and support routing

CREATE TABLE IF NOT EXISTS daily_report_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  summary TEXT NULL,
  problems TEXT NULL,
  support_required TEXT NULL,
  tomorrow_plan TEXT NULL,
  tasks_completed INT NOT NULL DEFAULT 0,
  tasks_in_progress INT NOT NULL DEFAULT 0,
  tasks_pending INT NOT NULL DEFAULT 0,
  review_note TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_drh_report (report_id),
  INDEX idx_drh_actor (actor_id),
  INDEX idx_drh_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @has_dept := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_work_reports' AND COLUMN_NAME = 'support_dept_id');
SET @sql := IF(@has_dept = 0, 'ALTER TABLE daily_work_reports ADD COLUMN support_dept_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_mgr := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_work_reports' AND COLUMN_NAME = 'support_manager_id');
SET @sql := IF(@has_mgr = 0, 'ALTER TABLE daily_work_reports ADD COLUMN support_manager_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
