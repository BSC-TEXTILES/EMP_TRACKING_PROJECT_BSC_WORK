-- Migration 024: Complete Employee Live Activity & Workforce Monitoring System
-- Production-ready schema for Windows Desktop Monitoring across Davanagere (DAV), Shivamogga (SHI), Belagavi (BEL) & HQ.

-- 1. Ensure idle tracking columns exist on daily_activity_summaries and monitoring_sessions
SET @has_idle_sec := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_activity_summaries' AND COLUMN_NAME = 'idle_minutes');
SET @sql_idle_sec := IF(@has_idle_sec = 0, 'ALTER TABLE daily_activity_summaries ADD COLUMN idle_minutes INT NOT NULL DEFAULT 0 AFTER active_minutes', 'SELECT 1');
PREPARE stmt1 FROM @sql_idle_sec; EXECUTE stmt1; DEALLOCATE PREPARE stmt1;

SET @has_sess_idle := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_sessions' AND COLUMN_NAME = 'idle_seconds');
SET @sql_sess_idle := IF(@has_sess_idle = 0, 'ALTER TABLE monitoring_sessions ADD COLUMN idle_seconds INT NOT NULL DEFAULT 0 AFTER last_heartbeat_at', 'SELECT 1');
PREPARE stmt2 FROM @sql_sess_idle; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

SET @has_sess_curr_app := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_sessions' AND COLUMN_NAME = 'current_app');
SET @sql_sess_curr_app := IF(@has_sess_curr_app = 0, 'ALTER TABLE monitoring_sessions ADD COLUMN current_app VARCHAR(120) NULL AFTER idle_seconds', 'SELECT 1');
PREPARE stmt3 FROM @sql_sess_curr_app; EXECUTE stmt3; DEALLOCATE PREPARE stmt3;

SET @has_sess_curr_cat := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_sessions' AND COLUMN_NAME = 'current_category');
SET @sql_sess_curr_cat := IF(@has_sess_curr_cat = 0, 'ALTER TABLE monitoring_sessions ADD COLUMN current_category VARCHAR(60) NULL AFTER current_app', 'SELECT 1');
PREPARE stmt4 FROM @sql_sess_curr_cat; EXECUTE stmt4; DEALLOCATE PREPARE stmt4;

-- 2. Ensure application_catalog includes retail, productivity and office apps
INSERT INTO application_catalog (name, process_pattern, category, is_approved) VALUES
('Microsoft Excel', '%excel%', 'Office Productivity', 1),
('Microsoft Word', '%winword%', 'Office Productivity', 1),
('Microsoft PowerPoint', '%powerpnt%', 'Office Productivity', 1),
('Microsoft Outlook', '%outlook%', 'Communication', 1),
('Microsoft Teams', '%teams%', 'Communication', 1),
('Google Chrome', '%chrome%', 'Browser', 1),
('Microsoft Edge', '%msedge%', 'Browser', 1),
('Mozilla Firefox', '%firefox%', 'Browser', 1),
('WhatsApp Desktop', '%whatsapp%', 'Communication', 1),
('BSC HRMS & Web Portal', '%chrome%emptrack%', 'Office Productivity', 1),
('Visual Studio Code', '%code%', 'Development', 1),
('Notepad & Editor', '%notepad%', 'Office Productivity', 1),
('Windows Calculator', '%calc%', 'Office Productivity', 1),
('File Explorer', '%explorer%', 'Administration', 1),
('Retail POS & Billing Software', '%pos%', 'Office Productivity', 1),
('Tally Accounting', '%tally%', 'Data Analytics', 1),
('Inventory & Stock ERP', '%inventory%', 'Office Productivity', 1),
('Antigravity IDE', '%antigravity%', 'Development', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- 3. Ensure a comprehensive default monitoring policy exists
INSERT INTO monitoring_policies (
  name, version, policy_text, screenshot_enabled, screenshot_interval_minutes,
  retention_days, idle_threshold_minutes, stale_session_minutes,
  allowed_apps, blocked_apps, allowed_domains, domain_categories, effective_at, is_active
) VALUES (
  'BSC Textiles Standard Workforce Monitoring Policy v2.0', 2,
  'Authorised work activity monitoring during office attendance sessions. Tracks foreground application names, active time, idle time, and work domains. No keystrokes, passwords, webcams or personal communications are ever recorded.',
  0, 10, 90, 5, 15,
  '["Microsoft Excel","Microsoft Word","Google Chrome","Microsoft Edge","WhatsApp Desktop","BSC HRMS & Web Portal","Visual Studio Code","Retail POS & Billing Software","Tally Accounting","Inventory & Stock ERP","Windows Calculator","File Explorer","Notepad & Editor"]',
  '["torrent","steam","epicgames","netflix","youtube"]',
  '["bsctextiles.in","emptrack.bsctextiles.in","google.com","drive.google.com","docs.google.com","github.com"]',
  '{"bsctextiles.in":"Business Operations","emptrack.bsctextiles.in":"HRMS Platform","google.com":"Search & Research","github.com":"Development"}',
  NOW(3), 1
) ON DUPLICATE KEY UPDATE name = VALUES(name);
