-- 051_simultaneous_leave_approvals.sql
-- Add independent manager and HR approval status columns to leave_requests idempotently

DROP PROCEDURE IF EXISTS _add_leave_cols;

CREATE PROCEDURE _add_leave_cols()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'manager_status'
  ) THEN
    ALTER TABLE leave_requests ADD COLUMN manager_status varchar(20) NOT NULL DEFAULT 'pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'hr_status'
  ) THEN
    ALTER TABLE leave_requests ADD COLUMN hr_status varchar(20) NOT NULL DEFAULT 'pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'manager_note'
  ) THEN
    ALTER TABLE leave_requests ADD COLUMN manager_note varchar(255) NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'hr_note'
  ) THEN
    ALTER TABLE leave_requests ADD COLUMN hr_note varchar(255) NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'manager_action_by'
  ) THEN
    ALTER TABLE leave_requests ADD COLUMN manager_action_by bigint unsigned NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND COLUMN_NAME = 'hr_action_by'
  ) THEN
    ALTER TABLE leave_requests ADD COLUMN hr_action_by bigint unsigned NULL;
  END IF;
END;

CALL _add_leave_cols();
DROP PROCEDURE IF EXISTS _add_leave_cols;

-- Backfill existing records
UPDATE leave_requests
SET manager_status = 'approved', hr_status = 'approved'
WHERE status = 'approved';

UPDATE leave_requests
SET manager_status = 'pending', hr_status = 'approved'
WHERE status = 'pending_manager';

UPDATE leave_requests
SET manager_status = 'pending', hr_status = 'pending'
WHERE status IN ('pending_hr', 'pending_both');

UPDATE leave_requests
SET manager_status = IF(manager_action_at IS NOT NULL, 'rejected', manager_status),
    hr_status = IF(hr_action_at IS NOT NULL, 'rejected', hr_status)
WHERE status = 'rejected';
