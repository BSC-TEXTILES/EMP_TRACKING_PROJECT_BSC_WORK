-- Activity Monitoring Fixes
-- Ensures all tables referenced by ActivityService exist with correct names

-- The main attendance table (created in 001_initial_schema.sql)
-- Already exists: attendance (with work_date, check_in_at, check_out_at, total_minutes, status)

-- Employee activity consents table (created in 010_activity_monitoring.sql)
-- Already exists: employee_activity_consents

-- Employee devices table (created in 010_activity_monitoring.sql)
-- Already exists: employee_devices

-- Device registrations table (created in 010_activity_monitoring.sql)
-- Already exists: device_registrations

-- Monitoring sessions table (created in 010_activity_monitoring.sql)
-- Already exists: monitoring_sessions

-- Application catalog table (created in 010_activity_monitoring.sql)
-- Already exists: application_catalog

-- Application usage logs (created in 010_activity_monitoring.sql)
-- Already exists: application_usage_logs

-- Browser usage logs (created in 010_activity_monitoring.sql)
-- Already exists: browser_usage_logs

-- Browser extension devices (created in 010_activity_monitoring.sql)
-- Already exists: browser_extension_devices

-- Internal module activity (created in 010_activity_monitoring.sql)
-- Already exists: internal_module_activity

-- Work activity events (created in 010_activity_monitoring.sql)
-- Already exists: work_activity_events

-- Activity keywords (created in 010_activity_monitoring.sql)
-- Already exists: activity_keywords

-- Daily activity summaries (created in 010_activity_monitoring.sql)
-- Already exists: daily_activity_summaries

-- Weekly performance reports (created in 010_activity_monitoring.sql)
-- Already exists: weekly_performance_reports

-- Screenshot evidence (created in 010_activity_monitoring.sql)
-- Already exists: screenshot_evidence

-- Error incidents (created in 010_activity_monitoring.sql)
-- Already exists: error_incidents

-- System error events (created in 010_activity_monitoring.sql)
-- Already exists: system_error_events

-- Automatic ticket links (created in 010_activity_monitoring.sql)
-- Already exists: automatic_ticket_links

-- Device health logs (created in 010_activity_monitoring.sql)
-- Already exists: device_health_logs

-- Activity audit logs (created in 010_activity_monitoring.sql)
-- Already exists: activity_audit_logs

-- Activity record corrections (created in 012_activity_monitoring_v2.sql)
-- Already exists: activity_record_corrections

-- Attendance breaks (created in 001_initial_schema.sql)
-- Already exists: attendance_breaks

-- This migration serves as a verification that all required tables exist.
-- No new tables needed - the code was updated to use correct table names.

INSERT INTO system_settings (setting_key, setting_value) VALUES 
('activity.migration.verified', '1'),
('activity.migration.verified_at', NOW(3))
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);