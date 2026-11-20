-- Rollback for migration 038 (Issue Management). Run manually, only if the module must be removed.
-- WARNING: this permanently deletes every issue, comment, escalation and notification-ledger row.
-- Take a backup first:  mysqldump <db> issues issue_assignments issue_comments issue_attachments \
--   issue_escalation_rules issue_escalation_history issue_activity_logs issue_notifications > issues_backup.sql
-- Uploaded files stay in `files`; notifications already delivered stay in `notifications`.

DROP TABLE IF EXISTS issue_notifications;
DROP TABLE IF EXISTS issue_activity_logs;
DROP TABLE IF EXISTS issue_escalation_history;
DROP TABLE IF EXISTS issue_escalation_rules;
DROP TABLE IF EXISTS issue_attachments;
DROP TABLE IF EXISTS issue_comments;
DROP TABLE IF EXISTS issue_assignments;
DROP TABLE IF EXISTS issues;
DELETE FROM system_settings WHERE setting_key = 'issues.routing_mode' OR setting_key LIKE 'seq.issue.%';
DELETE FROM schema_migrations WHERE filename = '038_issue_management.sql';
