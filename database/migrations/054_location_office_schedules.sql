-- 053_location_office_schedules.sql
-- Location-wise office schedule configuration with historical support

-- Location office schedules table
CREATE TABLE IF NOT EXISTS location_office_schedules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id BIGINT UNSIGNED NOT NULL,
  effective_date DATE NOT NULL,
  work_start_time TIME NOT NULL,
  work_end_time TIME NOT NULL,
  break_start_time TIME NULL,
  break_end_time TIME NULL,
  second_break_start_time TIME NULL,
  second_break_end_time TIME NULL,
  total_working_hours DECIMAL(4,2) NOT NULL DEFAULT 9.00,
  weekly_working_days JSON NOT NULL,
  weekly_off_day INT NULL,
  grace_minutes INT UNSIGNED NOT NULL DEFAULT 10,
  early_departure_threshold_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_location_effective (location_id, effective_date),
  KEY idx_location_active (location_id, is_active, effective_date),
  CONSTRAINT fk_schedule_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT fk_schedule_created_by FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_schedule_updated_by FOREIGN KEY (updated_by) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT chk_work_times CHECK (work_end_time > work_start_time),
  CONSTRAINT chk_break_times CHECK (
    break_start_time IS NULL OR break_end_time IS NULL OR break_end_time > break_start_time
  ),
  CONSTRAINT chk_second_break_times CHECK (
    second_break_start_time IS NULL OR second_break_end_time IS NULL OR second_break_end_time > second_break_start_time
  ),
  CONSTRAINT chk_working_hours CHECK (total_working_hours > 0 AND total_working_hours <= 24),
  CONSTRAINT chk_weekly_off_day CHECK (weekly_off_day IS NULL OR (weekly_off_day >= 0 AND weekly_off_day <= 6)),
  CONSTRAINT chk_weekly_working_days CHECK (JSON_VALID(weekly_working_days))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default schedules for existing locations (BEL, DAV, SHI)
-- Using a stored procedure approach to avoid hardcoded IDs
-- We'll insert with effective_date = '2024-01-01' as the initial effective date
-- These will be overridden by admin configuration as needed

-- Insert default schedules using location codes
INSERT INTO location_office_schedules (
  location_id, effective_date, work_start_time, work_end_time,
  break_start_time, break_end_time, total_working_hours,
  weekly_working_days, weekly_off_day, grace_minutes,
  early_departure_threshold_minutes, is_active, created_by
)
SELECT
  l.id,
  '2024-01-01',
  CASE
    WHEN l.code = 'DAV' THEN '10:00:00'
    ELSE '09:30:00'
  END,
  CASE
    WHEN l.code = 'DAV' THEN '19:30:00'
    ELSE '18:30:00'
  END,
  '13:00:00',
  '13:30:00',
  9.00,
  '[1,2,3,4,5,6]',
  0,
  10,
  0,
  1,
  (SELECT id FROM employees WHERE role_id = (SELECT id FROM roles WHERE slug = 'super_admin') LIMIT 1)
FROM locations l
WHERE l.code IN ('BEL', 'DAV', 'SHI') AND l.is_active = 1
ON DUPLICATE KEY UPDATE
  work_start_time = VALUES(work_start_time),
  work_end_time = VALUES(work_end_time),
  updated_at = CURRENT_TIMESTAMP(3);