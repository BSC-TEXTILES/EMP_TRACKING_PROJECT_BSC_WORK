-- Migration 046: Allow nullable employee_id in system_error_events for guest/unauthenticated error telemetry
ALTER TABLE system_error_events MODIFY COLUMN employee_id BIGINT UNSIGNED NULL;
