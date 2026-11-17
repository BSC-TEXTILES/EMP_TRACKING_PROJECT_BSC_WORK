-- Migration 026: Remove all legacy and demo employee records, keeping only Gagan C B
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Find Gagan C B's ID
SET @gagan_id := (SELECT id FROM employees WHERE full_name LIKE '%Gagan%' ORDER BY id DESC LIMIT 1);

-- If Gagan C B is not present, create the record
INSERT INTO employees (id, employee_code, full_name, email, mobile, password_hash, role_id, status, joining_date, email_verified_at, mobile_verified_at)
SELECT 20, 'EMP-1020', 'Gagan C B', 'gagan.cb@bsctextiles.in', '9876543210',
       '$2b$10$wT0qFj6w1kZqGvNq3.1zU.wM8Yd6N3b8Yd6N3b8Yd6N3b8Yd6N3b8',
       (SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1), 'active', CURDATE(), NOW(3), NOW(3)
FROM DUAL
WHERE @gagan_id IS NULL;

SET @gagan_id := (SELECT id FROM employees WHERE full_name LIKE '%Gagan%' ORDER BY id DESC LIMIT 1);

-- 2. Upgrade Gagan C B to Super Admin and set top of hierarchy
UPDATE employees 
SET manager_id = NULL,
    status = 'active',
    failed_login_attempts = 0,
    locked_until = NULL,
    password_hash = '$2a$10$X7y6huEHiPUp8I/jTxyZJenYgazAJwzdifd9dtz588WDnd92ydv9m',
    role_id = COALESCE((SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1), role_id)
WHERE id = @gagan_id;

-- 3. Ensure Gagan C B has Super Admin and Store Manager roles in employee_roles
INSERT IGNORE INTO employee_roles (employee_id, role_id)
SELECT @gagan_id, id FROM roles WHERE slug IN ('super_admin', 'admin', 'store_manager');

-- 4. Reassign all department head references to Gagan C B
UPDATE departments SET head_employee_id = @gagan_id WHERE @gagan_id IS NOT NULL;

-- 5. Delete dependent records for all other non-Gagan employees
DELETE FROM employee_sessions WHERE employee_id <> @gagan_id;
DELETE FROM employee_login_audit WHERE employee_id <> @gagan_id;
DELETE FROM attendance WHERE employee_id <> @gagan_id;
DELETE FROM attendance_records WHERE employee_id <> @gagan_id;
DELETE FROM attendance_breaks WHERE employee_id <> @gagan_id;
DELETE FROM attendance_corrections WHERE employee_id <> @gagan_id;
DELETE FROM daily_reports WHERE employee_id <> @gagan_id;
DELETE FROM daily_work_reports WHERE employee_id <> @gagan_id;
DELETE FROM task_assignments WHERE employee_id <> @gagan_id;
DELETE FROM task_time_logs WHERE employee_id <> @gagan_id;
DELETE FROM task_comments WHERE author_id <> @gagan_id;
DELETE FROM tasks WHERE created_by <> @gagan_id;
DELETE FROM ticket_assignments WHERE employee_id <> @gagan_id;
DELETE FROM ticket_comments WHERE author_id <> @gagan_id;
DELETE FROM tickets WHERE requester_id <> @gagan_id;
DELETE FROM conversation_members WHERE employee_id <> @gagan_id;
DELETE FROM conversation_user_state WHERE employee_id <> @gagan_id;
DELETE FROM messages WHERE sender_id <> @gagan_id;
DELETE FROM internal_emails WHERE sender_id <> @gagan_id AND recipient_id <> @gagan_id;
DELETE FROM employee_activities WHERE employee_id <> @gagan_id;
DELETE FROM employee_daily_performance WHERE employee_id <> @gagan_id;
DELETE FROM employee_roles WHERE employee_id <> @gagan_id;
DELETE FROM user_permissions WHERE employee_id <> @gagan_id;
DELETE FROM otp_codes WHERE employee_id <> @gagan_id;
DELETE FROM employee_devices WHERE employee_id <> @gagan_id;
DELETE FROM employee_preferences WHERE employee_id <> @gagan_id;
DELETE FROM employee_activity_consents WHERE employee_id <> @gagan_id;
DELETE FROM login_history WHERE employee_id <> @gagan_id;

-- 6. Delete all other employees from the database
DELETE FROM employees WHERE id <> @gagan_id AND full_name NOT LIKE '%Gagan%';

SET FOREIGN_KEY_CHECKS = 1;
