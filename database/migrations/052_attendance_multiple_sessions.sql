-- 052_attendance_multiple_sessions.sql
-- Support multiple attendance sessions per employee per day
-- Additive: preserves all existing attendance records

-- Add session_number column to attendance table
SET @has_session := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND COLUMN_NAME = 'session_number'
);
SET @sql := IF(@has_session = 0,
  'ALTER TABLE attendance ADD COLUMN session_number TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER work_date',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Update existing records to have session_number = 1
UPDATE attendance SET session_number = 1 WHERE session_number IS NULL OR session_number = 0.

-- Drop foreign key constraints for attendance_breaks
SET @has_fk_breaks := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_breaks' AND CONSTRAINT_NAME = 'fk_attendance_breaks_attendance'
);
SET @sql := IF(@has_fk_breaks > 0,
  'ALTER TABLE attendance_breaks DROP FOREIGN KEY fk_attendance_breaks_attendance',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Drop foreign key constraints for attendance_corrections
SET @has_fk_corrections := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_corrections' AND CONSTRAINT_NAME = 'fk_corrections_attendance'
);
SET @sql := IF(@has_fk_corrections > 0,
  'ALTER TABLE attendance_corrections DROP FOREIGN KEY fk_corrections_attendance',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Drop the old unique key and create new one with session_number
SET @has_old_key := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND INDEX_NAME = 'uq_attendance_employee_date'
);
SET @sql := IF(@has_old_key > 0,
  'ALTER TABLE attendance DROP INDEX uq_attendance_employee_date',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Add new unique key with session_number
SET @has_new_key := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND INDEX_NAME = 'uq_attendance_employee_date_session'
);
SET @sql := IF(@has_new_key = 0,
  'ALTER TABLE attendance ADD UNIQUE KEY uq_attendance_employee_date_session (employee_id, work_date, session_number)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Add index for efficient session queries
SET @has_session_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND INDEX_NAME = 'idx_attendance_employee_date_session'
);
SET @sql := IF(@has_session_idx = 0,
  'ALTER TABLE attendance ADD KEY idx_attendance_employee_date_session (employee_id, work_date, session_number)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Recreate foreign key constraints referencing the primary key (id) for attendance_breaks
SET @sql := 'ALTER TABLE attendance_breaks ADD CONSTRAINT fk_attendance_breaks_attendance FOREIGN KEY (attendance_id) REFERENCES attendance (id) ON DELETE CASCADE';
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Recreate foreign key constraints for attendance_corrections
SET @sql := 'ALTER TABLE attendance_corrections ADD CONSTRAINT fk_corrections_attendance FOREIGN KEY (attendance_id) REFERENCES attendance (id) ON DELETE SET NULL';
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

-- Add session_number to attendance_breaks for session tracking
SET @has_break_session := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_breaks' AND COLUMN_NAME = 'session_number'
);
SET @sql := IF(@has_break_session = 0,
  'ALTER TABLE attendance_breaks ADD COLUMN session_number TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER attendance_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt.

UPDATE attendance_breaks SET session_number = 1 WHERE session_number IS NULL OR session_number = 0.