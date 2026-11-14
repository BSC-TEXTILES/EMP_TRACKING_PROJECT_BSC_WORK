ALTER TABLE files ADD COLUMN scan_status VARCHAR(20) NOT NULL DEFAULT 'pending';
-- Old files must be scanned before delivery. Old long-lived sessions must reauthenticate.
UPDATE employee_sessions s SET revoked_at = NOW(3), revoked_reason = 'session_security_upgrade'
WHERE revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM session_refresh_tokens r WHERE r.session_id = s.id);
