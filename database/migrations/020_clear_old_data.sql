-- Migration 020: Clear legacy mock and demo data for fresh production start
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Chat, Calls & Messaging
DELETE FROM message_reactions WHERE message_id > 0;
DELETE FROM message_receipts WHERE message_id > 0;
DELETE FROM message_attachments WHERE id > 0;
DELETE FROM messages WHERE id > 0;
DELETE FROM conversation_members WHERE conversation_id > 0;
DELETE FROM conversation_user_state WHERE conversation_id > 0;
DELETE FROM conversations WHERE id > 0;
DELETE FROM calls WHERE id > 0;

-- 2. Internal Emails
DELETE FROM internal_emails WHERE id > 0;

-- 3. Tasks, Milestones & Projects
DELETE FROM task_time_logs WHERE id > 0;
DELETE FROM task_attachments WHERE id > 0;
DELETE FROM task_comments WHERE id > 0;
DELETE FROM task_subtasks WHERE id > 0;
DELETE FROM task_assignments WHERE task_id > 0;
DELETE FROM tasks WHERE id > 0;
DELETE FROM project_milestones WHERE id > 0;
DELETE FROM project_members WHERE project_id > 0;
DELETE FROM projects WHERE id > 0;

-- 4. Tickets & Issue details
DELETE FROM ticket_attachments WHERE id > 0;
DELETE FROM ticket_assignments WHERE ticket_id > 0;
DELETE FROM ticket_comments WHERE id > 0;
DELETE FROM automatic_ticket_links WHERE id > 0;
DELETE FROM tickets WHERE id > 0;

-- 5. Daily Work Reports
DELETE FROM daily_report_attachments WHERE id > 0;
DELETE FROM daily_work_reports WHERE id > 0;

-- 6. Attendance & Corrections
DELETE FROM attendance_breaks WHERE id > 0;
DELETE FROM attendance_corrections WHERE id > 0;
DELETE FROM attendance WHERE id > 0;

-- 7. Activity Monitoring & Logs
DELETE FROM system_error_events WHERE id > 0;
DELETE FROM error_incidents WHERE id > 0;
DELETE FROM activity_audit_logs WHERE id > 0;
DELETE FROM monitoring_sessions WHERE id > 0;
DELETE FROM browser_extension_devices WHERE id > 0;
DELETE FROM device_registrations WHERE id > 0;
DELETE FROM employee_devices WHERE id > 0;
DELETE FROM employee_activity_consents WHERE id > 0;
DELETE FROM application_usage_logs WHERE id > 0;
DELETE FROM browser_usage_logs WHERE id > 0;
DELETE FROM internal_module_activity WHERE id > 0;
DELETE FROM work_activity_events WHERE id > 0;
DELETE FROM daily_activity_summaries WHERE id > 0;
DELETE FROM weekly_performance_reports WHERE id > 0;
DELETE FROM screenshot_evidence WHERE id > 0;
DELETE FROM device_health_logs WHERE id > 0;

-- 8. Meetings, KPI, Reviews & Leaves
DELETE FROM meeting_action_items WHERE id > 0;
DELETE FROM meeting_messages WHERE id > 0;
DELETE FROM meeting_participants WHERE meeting_id > 0;
DELETE FROM meetings WHERE id > 0;
DELETE FROM collections WHERE id > 0;
DELETE FROM leave_requests WHERE id > 0;
DELETE FROM leave_balances WHERE id > 0;
DELETE FROM employee_kpi_records WHERE id > 0;
DELETE FROM manager_reviews WHERE id > 0;

-- 9. Notifications, Files, Deliveries & Audit
DELETE FROM notification_recipients WHERE notification_id > 0;
DELETE FROM notifications WHERE id > 0;
DELETE FROM announcements WHERE id > 0;
DELETE FROM email_deliveries WHERE id > 0;
DELETE FROM files WHERE id > 0;
DELETE FROM audit_logs WHERE id > 0;
DELETE FROM job_runs WHERE id > 0;
DELETE FROM employee_status_events WHERE id > 0;
DELETE FROM webhook_deliveries WHERE id > 0;

-- 10. Ensure location_id is linked to primary location if missing
UPDATE employees 
SET location_id = (SELECT id FROM locations WHERE code = 'BEL' LIMIT 1)
WHERE location_id IS NULL;

SET FOREIGN_KEY_CHECKS = 1;
