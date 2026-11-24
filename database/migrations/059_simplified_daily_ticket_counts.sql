-- Migration 059: Simplified Daily Ticket Counts & Date-Wise Tracking
-- Implements single-step ticket count entry (Bus/Train), automatic Indian timezone (Asia/Kolkata)
-- date logging, automatic employee store association, multi-entry daily aggregation, and correction audit log.

CREATE TABLE IF NOT EXISTS daily_ticket_counts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_date DATE NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  ticket_type ENUM('bus', 'train') NOT NULL,
  ticket_count INT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  notes VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dtc_date (booking_date),
  INDEX idx_dtc_loc (location_id),
  INDEX idx_dtc_type (ticket_type),
  INDEX idx_dtc_emp (employee_id),
  INDEX idx_dtc_date_loc (booking_date, location_id),
  CONSTRAINT fk_dtc_loc FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_dtc_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_ticket_count_edits (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_count_id BIGINT UNSIGNED NOT NULL,
  editor_id BIGINT UNSIGNED NOT NULL,
  previous_count INT UNSIGNED NOT NULL,
  new_count INT UNSIGNED NOT NULL,
  reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dtce_count (ticket_count_id),
  INDEX idx_dtce_editor (editor_id),
  CONSTRAINT fk_dtce_count FOREIGN KEY (ticket_count_id) REFERENCES daily_ticket_counts (id) ON DELETE CASCADE,
  CONSTRAINT fk_dtce_editor FOREIGN KEY (editor_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migrate existing non-cancelled bookings from travel_bookings into daily_ticket_counts
INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, employee_id, notes, created_at, updated_at)
SELECT b.booking_date, b.location_id, b.transport_type, b.passenger_count, b.employee_id, COALESCE(b.purpose, 'Migrated booking record'), b.created_at, b.updated_at
FROM travel_bookings b
WHERE b.status != 'cancelled'
  AND NOT EXISTS (
    SELECT 1 FROM daily_ticket_counts d
    WHERE d.booking_date = b.booking_date
      AND d.location_id = b.location_id
      AND d.ticket_type = b.transport_type
      AND d.employee_id = b.employee_id
  );

-- Seed realistic operational ticket entries across stores if employees exist
INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, employee_id, notes, created_at)
SELECT '2026-11-24', 1, 'bus', 12, e.id, 'Daily store team bus travel', '2026-11-24 09:30:00'
FROM employees e WHERE e.id = 25
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, employee_id, notes, created_at)
SELECT '2026-11-24', 1, 'train', 8, e.id, 'Train tickets for purchase team', '2026-11-24 10:15:00'
FROM employees e WHERE e.id = 25
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, employee_id, notes, created_at)
SELECT '2026-11-24', 2, 'bus', 10, e.id, 'Store staff commute bus passes', '2026-11-24 11:00:00'
FROM employees e WHERE e.id = 16
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, employee_id, notes, created_at)
SELECT '2026-11-24', 2, 'train', 5, e.id, 'Davanagere sourcing team train booking', '2026-11-24 11:30:00'
FROM employees e WHERE e.id = 16
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, employee_id, notes, created_at)
SELECT '2026-11-24', 3, 'bus', 6, e.id, 'Shivamogga operations bus tickets', '2026-11-24 12:00:00'
FROM employees e WHERE e.id = 16
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, employee_id, notes, created_at)
SELECT '2026-11-24', 3, 'train', 7, e.id, 'Shivamogga to Bengaluru train tickets', '2026-11-24 12:45:00'
FROM employees e WHERE e.id = 16
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;
