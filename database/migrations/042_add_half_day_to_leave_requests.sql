-- 042_add_half_day_to_leave_requests.sql
-- Add half-day leave support with both First Half and Second Half options

ALTER TABLE leave_requests
ADD COLUMN is_half_day TINYINT(1) NOT NULL DEFAULT 0,
ADD COLUMN half_day_slot ENUM('first_half', 'second_half') NULL DEFAULT NULL;
