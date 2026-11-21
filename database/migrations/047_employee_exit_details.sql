-- Preserve existing employees while adding fields used by the employee directory.
SET @has_exit_date := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'exit_date');
SET @sql := IF(@has_exit_date = 0, 'ALTER TABLE employees ADD COLUMN exit_date DATE NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_hr := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'hr_representative_id');
SET @sql := IF(@has_hr = 0, 'ALTER TABLE employees ADD COLUMN hr_representative_id BIGINT UNSIGNED NULL, ADD CONSTRAINT fk_employee_hr_representative FOREIGN KEY (hr_representative_id) REFERENCES employees(id) ON DELETE SET NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_exit_reason := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'exit_reason');
SET @sql := IF(@has_exit_reason = 0, 'ALTER TABLE employees ADD COLUMN exit_reason TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
