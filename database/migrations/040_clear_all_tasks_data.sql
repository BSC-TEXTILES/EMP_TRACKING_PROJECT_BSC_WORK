-- Migration 040: Remove all task data from the project
-- Resets tasks, assignments, comments, attachments, subtasks, logs, and SOP checkpoints to 0.

SET FOREIGN_KEY_CHECKS = 0;

DELETE FROM task_time_logs WHERE id > 0;
DELETE FROM task_attachments WHERE id > 0;
DELETE FROM task_comments WHERE id > 0;
DELETE FROM task_subtasks WHERE id > 0;
DELETE FROM task_assignments WHERE task_id > 0;
DELETE FROM store_daily_checkpoints WHERE id > 0;
DELETE FROM employee_daily_performance WHERE id > 0;
DELETE FROM tasks WHERE id > 0;

UPDATE tickets SET related_task_id = NULL WHERE related_task_id IS NOT NULL;
UPDATE module_activity_logs SET related_task_id = NULL WHERE related_task_id IS NOT NULL;

SET FOREIGN_KEY_CHECKS = 1;
