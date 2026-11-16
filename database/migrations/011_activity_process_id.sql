-- Process identifier for foreground application records.
-- Existing rows keep NULL; new agent events carry the Windows process id.
ALTER TABLE application_usage_logs
  ADD COLUMN process_id INT UNSIGNED NULL AFTER process_name;
