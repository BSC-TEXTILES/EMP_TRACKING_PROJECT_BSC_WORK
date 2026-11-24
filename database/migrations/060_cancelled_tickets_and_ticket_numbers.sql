-- Migration 060: Cancelled Tickets and Ticket Numbers Tracking
-- Adds daily cancelled ticket tracking and optional ticket number / PNR reference to daily_ticket_counts

SET @has_cancelled := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_ticket_counts' AND COLUMN_NAME = 'is_cancelled');
SET @sql := IF(@has_cancelled = 0, 'ALTER TABLE daily_ticket_counts ADD COLUMN is_cancelled TINYINT(1) NOT NULL DEFAULT 0 AFTER ticket_count', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_ticket_no := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_ticket_counts' AND COLUMN_NAME = 'ticket_number');
SET @sql := IF(@has_ticket_no = 0, 'ALTER TABLE daily_ticket_counts ADD COLUMN ticket_number VARCHAR(255) NULL AFTER is_cancelled', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Seed an example cancelled ticket entry for today across locations if employees exist
INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, is_cancelled, ticket_number, employee_id, notes, created_at)
SELECT '2026-11-24', 1, 'bus', 2, 1, 'KSRTC-BLG-CNL-01', e.id, 'Meeting cancelled by textile client', '2026-11-24 13:00:00'
FROM employees e WHERE e.id = 25
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO daily_ticket_counts (booking_date, location_id, ticket_type, ticket_count, is_cancelled, ticket_number, employee_id, notes, created_at)
SELECT '2026-11-24', 2, 'train', 1, 1, 'IRCTC-PNR-88492', e.id, 'Vendor trip rescheduled', '2026-11-24 13:30:00'
FROM employees e WHERE e.id = 16
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;
