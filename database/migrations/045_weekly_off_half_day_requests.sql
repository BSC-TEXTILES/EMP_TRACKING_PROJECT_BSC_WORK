-- Migration 045: request-based weekly offs and stand-alone half-day leave.
-- Additive only: no employee, attendance, leave request, balance or comp-off row is deleted
-- or rewritten. Historic requests keep request_kind = 'leave'.
--
-- 1. employees.weekly_off_day      : the employee's assigned weekly-off weekday (0 = Sunday … 6 = Saturday).
-- 2. leave_requests.request_kind   : 'leave' (historic / generic), 'weekly_off' or 'half_day'.
-- 3. leave_requests.weekly_off_key : generated column + UNIQUE key so the same weekly-off date can
--                                    never be reserved twice while a request is pending or approved.
-- 4. 'Weekly Off' leave type (WO)  : inactive, so it never appears in a leave-type list; it only
--                                    satisfies the leave_type_id foreign key for weekly-off requests.
-- 5. weekly_off_allocations        : monthly allocation snapshot per employee (allocated / taken / pending).
-- 6. leave_request_history         : approval trail (submitted, manager / HR decisions, cancellation).

-- ----------------------------------------------------------------- 1. employees.weekly_off_day
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'weekly_off_day');
SET @s := IF(@c = 0, 'ALTER TABLE employees ADD COLUMN weekly_off_day TINYINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 2. leave_requests.request_kind
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'request_kind');
SET @s := IF(@c = 0, 'ALTER TABLE leave_requests ADD COLUMN request_kind VARCHAR(16) NOT NULL DEFAULT ''leave'' AFTER leave_type_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 3. duplicate guard for weekly offs
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'weekly_off_key');
SET @s := IF(@c = 0, 'ALTER TABLE leave_requests
  ADD COLUMN weekly_off_key VARCHAR(40) GENERATED ALWAYS AS (
    CASE WHEN request_kind = ''weekly_off'' AND status IN (''pending_manager'', ''pending_hr'', ''approved'')
         THEN CONCAT(employee_id, '':'', start_date) ELSE NULL END) STORED,
  ADD UNIQUE KEY uq_leave_requests_weekly_off (weekly_off_key),
  ADD KEY idx_leave_requests_kind (employee_id, request_kind, start_date)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ----------------------------------------------------------------- 4. Weekly Off leave type (hidden)
INSERT INTO leave_types (name, code, annual_quota, is_paid, requires_document, is_active)
SELECT 'Weekly Off', 'WO', 0, 1, 0, 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM leave_types WHERE code = 'WO');

-- ----------------------------------------------------------------- 5. weekly_off_allocations
CREATE TABLE IF NOT EXISTS weekly_off_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  alloc_year SMALLINT UNSIGNED NOT NULL,
  alloc_month TINYINT UNSIGNED NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  allocated TINYINT UNSIGNED NOT NULL DEFAULT 0,
  taken TINYINT UNSIGNED NOT NULL DEFAULT 0,
  pending TINYINT UNSIGNED NOT NULL DEFAULT 0,
  eligible_dates JSON NULL,
  computed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_weekly_off_alloc (employee_id, alloc_year, alloc_month),
  CONSTRAINT fk_weekly_off_alloc_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- 6. leave_request_history
CREATE TABLE IF NOT EXISTS leave_request_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  leave_request_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(32) NOT NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  note VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_leave_history_request (leave_request_id, created_at),
  CONSTRAINT fk_leave_history_request FOREIGN KEY (leave_request_id) REFERENCES leave_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_leave_history_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
