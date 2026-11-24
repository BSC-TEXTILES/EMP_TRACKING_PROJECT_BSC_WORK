-- 057_organization_hierarchy_enhancements.sql
-- Hierarchy order for employee drag-and-drop & organisation change audit enhancements

SET @has_order := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'hierarchy_order');
SET @sql := IF(@has_order = 0, 'ALTER TABLE employees ADD COLUMN hierarchy_order INT NOT NULL DEFAULT 0 AFTER manager_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_prev_dept := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reporting_assignments' AND COLUMN_NAME = 'previous_department_id');
SET @sql := IF(@has_prev_dept = 0, 'ALTER TABLE reporting_assignments ADD COLUMN previous_department_id BIGINT UNSIGNED NULL AFTER location_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_dept := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reporting_assignments' AND COLUMN_NAME = 'department_id');
SET @sql := IF(@has_dept = 0, 'ALTER TABLE reporting_assignments ADD COLUMN department_id BIGINT UNSIGNED NULL AFTER previous_department_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_prev_loc := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reporting_assignments' AND COLUMN_NAME = 'previous_location_id');
SET @sql := IF(@has_prev_loc = 0, 'ALTER TABLE reporting_assignments ADD COLUMN previous_location_id BIGINT UNSIGNED NULL AFTER department_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
