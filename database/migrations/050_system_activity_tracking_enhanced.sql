-- 050_system_activity_tracking_enhanced.sql
-- Enhanced System Activity Tracking
-- Separate foreground application duration from keyboard/mouse idle time.
-- Support window title, idle seconds, foreground seconds, lock status.

SET @has_idle := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_usage_logs' AND COLUMN_NAME = 'idle_seconds');
SET @sql := IF(@has_idle = 0, 'ALTER TABLE application_usage_logs ADD COLUMN idle_seconds INT UNSIGNED NOT NULL DEFAULT 0 AFTER active_seconds', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_fg := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_usage_logs' AND COLUMN_NAME = 'foreground_seconds');
SET @sql := IF(@has_fg = 0, 'ALTER TABLE application_usage_logs ADD COLUMN foreground_seconds INT UNSIGNED NOT NULL DEFAULT 0 AFTER idle_seconds', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_lock := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_usage_logs' AND COLUMN_NAME = 'is_locked');
SET @sql := IF(@has_lock = 0, 'ALTER TABLE application_usage_logs ADD COLUMN is_locked TINYINT(1) NOT NULL DEFAULT 0 AFTER foreground_seconds', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_title := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_usage_logs' AND COLUMN_NAME = 'window_title');
SET @sql := IF(@has_title = 0, 'ALTER TABLE application_usage_logs ADD COLUMN window_title VARCHAR(255) NULL AFTER is_locked', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_sess_lock := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_sessions' AND COLUMN_NAME = 'is_locked');
SET @sql := IF(@has_sess_lock = 0, 'ALTER TABLE monitoring_sessions ADD COLUMN is_locked TINYINT(1) NOT NULL DEFAULT 0 AFTER idle_seconds', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_sess_active := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_sessions' AND COLUMN_NAME = 'active_seconds');
SET @sql := IF(@has_sess_active = 0, 'ALTER TABLE monitoring_sessions ADD COLUMN active_seconds INT UNSIGNED NOT NULL DEFAULT 0 AFTER is_locked', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
