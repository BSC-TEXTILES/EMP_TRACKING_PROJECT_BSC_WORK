-- Migration 036: Complete Employee Activity Soft Deletion, Audit Trail & Recycle Bin
-- Non-destructive additive migration.
-- Preserves all login audits, forensic security records and raw system logs.

-- 1. Add soft-deletion columns to application_usage_logs
SET @c_app := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_usage_logs' AND COLUMN_NAME = 'deleted_at');
SET @s_app := IF(@c_app = 0, 'ALTER TABLE application_usage_logs
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER created_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL AFTER deleted_at,
  ADD COLUMN delete_reason VARCHAR(255) NULL AFTER deleted_by,
  ADD KEY idx_app_usage_deleted_at (deleted_at)', 'SELECT 1');
PREPARE st_app FROM @s_app; EXECUTE st_app; DEALLOCATE PREPARE st_app;

-- 2. Add soft-deletion columns to browser_usage_logs
SET @c_brw := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'browser_usage_logs' AND COLUMN_NAME = 'deleted_at');
SET @s_brw := IF(@c_brw = 0, 'ALTER TABLE browser_usage_logs
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER created_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL AFTER deleted_at,
  ADD COLUMN delete_reason VARCHAR(255) NULL AFTER deleted_by,
  ADD KEY idx_browser_usage_deleted_at (deleted_at)', 'SELECT 1');
PREPARE st_brw FROM @s_brw; EXECUTE st_brw; DEALLOCATE PREPARE st_brw;

-- 3. Add soft-deletion columns to internal_module_activity
SET @c_mod := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'internal_module_activity' AND COLUMN_NAME = 'deleted_at');
SET @s_mod := IF(@c_mod = 0, 'ALTER TABLE internal_module_activity
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER created_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL AFTER deleted_at,
  ADD COLUMN delete_reason VARCHAR(255) NULL AFTER deleted_by,
  ADD KEY idx_module_activity_deleted_at (deleted_at)', 'SELECT 1');
PREPARE st_mod FROM @s_mod; EXECUTE st_mod; DEALLOCATE PREPARE st_mod;

-- 4. Add soft-deletion columns to work_activity_events
SET @c_wrk := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_activity_events' AND COLUMN_NAME = 'deleted_at');
SET @s_wrk := IF(@c_wrk = 0, 'ALTER TABLE work_activity_events
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER created_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL AFTER deleted_at,
  ADD COLUMN delete_reason VARCHAR(255) NULL AFTER deleted_by,
  ADD KEY idx_work_activity_deleted_at (deleted_at)', 'SELECT 1');
PREPARE st_wrk FROM @s_wrk; EXECUTE st_wrk; DEALLOCATE PREPARE st_wrk;

-- 5. Add soft-deletion columns to monitoring_sessions
SET @c_ses := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_sessions' AND COLUMN_NAME = 'deleted_at');
SET @s_ses := IF(@c_ses = 0, 'ALTER TABLE monitoring_sessions
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER created_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL AFTER deleted_at,
  ADD COLUMN delete_reason VARCHAR(255) NULL AFTER deleted_by,
  ADD KEY idx_monitoring_sessions_deleted_at (deleted_at)', 'SELECT 1');
PREPARE st_ses FROM @s_ses; EXECUTE st_ses; DEALLOCATE PREPARE st_ses;

-- 6. Add soft-deletion columns to daily_activity_summaries
SET @c_dly := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_activity_summaries' AND COLUMN_NAME = 'deleted_at');
SET @s_dly := IF(@c_dly = 0, 'ALTER TABLE daily_activity_summaries
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER updated_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL AFTER deleted_at,
  ADD COLUMN delete_reason VARCHAR(255) NULL AFTER deleted_by,
  ADD KEY idx_daily_summaries_deleted_at (deleted_at)', 'SELECT 1');
PREPARE st_dly FROM @s_dly; EXECUTE st_dly; DEALLOCATE PREPARE st_dly;

-- 7. Register new activity deletion & restore permissions
INSERT INTO permissions (code, module, action, description) VALUES
('activity.delete', 'activity', 'delete', 'Delete activity monitoring records (soft delete)'),
('activity.restore', 'activity', 'restore', 'Restore soft-deleted activity records from Recycle Bin'),
('activity.delete.permanent', 'activity', 'delete.permanent', 'Permanently purge soft-deleted activity records')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- 8. Assign permissions to authorized roles
-- Super Admin gets delete, restore, permanent
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
CROSS JOIN permissions p
WHERE r.slug = 'super_admin' AND p.code IN ('activity.delete', 'activity.restore', 'activity.delete.permanent')
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id);

-- Admin (roles with slug 'admin' or role_id = 2) gets delete, restore
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('admin', 'general_manager') AND p.code IN ('activity.delete', 'activity.restore')
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id);

-- HR Manager (roles with slug 'hr') gets delete
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('hr') AND p.code IN ('activity.delete')
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id);
