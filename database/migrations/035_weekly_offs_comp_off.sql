-- Migration 035: calendar-based Sunday weekly offs and compensatory-off credits.
-- Additive only: no existing employee, attendance, leave request or balance row is removed or rewritten.
--
-- Sundays are NOT stored anywhere: they are derived from the real calendar at run time
-- (backend/src/lib/calendar.ts), so there is nothing for HR to enter and nothing to go stale.
--
-- 1. comp_off_credits: one row per employee per worked Sunday / public holiday.
--    The unique key makes crediting idempotent (no duplicate comp-offs for the same day).
-- 2. leave_requests: how many weekly offs / holidays inside the range were NOT charged
--    to the balance (NULL for historic requests, which keep their original day count).
-- 3. Compensatory Off leave type, created only if the installation does not have one yet.

-- ----------------------------------------------------------------- 1. comp_off_credits
CREATE TABLE IF NOT EXISTS comp_off_credits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  source ENUM('sunday', 'holiday') NOT NULL,
  attendance_id BIGINT UNSIGNED NULL,
  worked_minutes INT NOT NULL DEFAULT 0,
  days DECIMAL(3, 1) NOT NULL DEFAULT 1.0,
  expired_days DECIMAL(3, 1) NOT NULL DEFAULT 0.0,
  status ENUM('earned', 'expired', 'revoked') NOT NULL DEFAULT 'earned',
  expires_on DATE NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_comp_off_employee_date (employee_id, work_date),
  KEY idx_comp_off_status_expiry (status, expires_on),
  CONSTRAINT fk_comp_off_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_comp_off_attendance FOREIGN KEY (attendance_id) REFERENCES attendance (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- 2. leave_requests
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'weekly_off_days');
SET @s := IF(@c = 0, 'ALTER TABLE leave_requests
  ADD COLUMN weekly_off_days DECIMAL(5, 1) NULL AFTER days,
  ADD COLUMN holiday_days DECIMAL(5, 1) NULL AFTER weekly_off_days', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 3. Compensatory Off type
INSERT INTO leave_types (name, code, annual_quota, is_paid, requires_document, is_active)
SELECT 'Compensatory Off', 'CO', 0, 1, 0, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM leave_types WHERE code = 'CO');
