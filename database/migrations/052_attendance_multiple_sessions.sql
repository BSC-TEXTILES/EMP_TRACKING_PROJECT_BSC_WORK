-- 052_attendance_multiple_sessions.sql
-- Support multiple attendance sessions per employee per day
-- Additive: preserves all existing attendance records and data

DROP PROCEDURE IF EXISTS _migrate_attendance_sessions;

CREATE PROCEDURE _migrate_attendance_sessions()
BEGIN
  -- 1. Ensure session_number column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND COLUMN_NAME = 'session_number'
  ) THEN
    ALTER TABLE attendance ADD COLUMN session_number TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER work_date;
  END IF;

  UPDATE attendance SET session_number = 1 WHERE session_number IS NULL OR session_number = 0;

  -- 2. Add standalone index for employee_id to satisfy fk_attendance_employee
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND INDEX_NAME = 'idx_attendance_employee'
  ) THEN
    ALTER TABLE attendance ADD KEY idx_attendance_employee (employee_id);
  END IF;

  -- 3. Add new composite unique key for (employee_id, work_date, session_number)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND INDEX_NAME = 'uq_attendance_employee_date_session'
  ) THEN
    ALTER TABLE attendance ADD UNIQUE KEY uq_attendance_employee_date_session (employee_id, work_date, session_number);
  END IF;

  -- 4. Drop the old single-session unique key if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND INDEX_NAME = 'uq_attendance_employee_date'
  ) THEN
    ALTER TABLE attendance DROP INDEX uq_attendance_employee_date;
  END IF;

  -- 5. Add session_number to attendance_breaks if not present
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_breaks' AND COLUMN_NAME = 'session_number'
  ) THEN
    ALTER TABLE attendance_breaks ADD COLUMN session_number TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER attendance_id;
  END IF;

  UPDATE attendance_breaks SET session_number = 1 WHERE session_number IS NULL OR session_number = 0;
END;

CALL _migrate_attendance_sessions();
DROP PROCEDURE IF EXISTS _migrate_attendance_sessions;
