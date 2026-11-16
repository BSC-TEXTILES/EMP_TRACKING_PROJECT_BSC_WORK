-- Employee Preferences Table
-- Additive only: no existing column, row or constraint is modified or removed.

CREATE TABLE IF NOT EXISTS employee_preferences (
  employee_id BIGINT UNSIGNED NOT NULL,
  preferences JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (employee_id),
  CONSTRAINT fk_employee_preferences_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;