-- Migration 029: Device telemetry ported from LiveGuard Pro into the Activity module.
--
-- * Device location (Windows Location API + connected Wi-Fi name), opt-in per policy.
--   Off by default; enabling it bumps the policy version so every employee must
--   acknowledge the change before any location is recorded.
-- * Security posture (Windows Defender status) is stored in device_health_logs.details.

SET @has_location := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_policies' AND COLUMN_NAME = 'location_tracking_enabled');
SET @sql_location := IF(@has_location = 0, 'ALTER TABLE monitoring_policies ADD COLUMN location_tracking_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER screenshot_interval_minutes', 'SELECT 1');
PREPARE stmt_location FROM @sql_location; EXECUTE stmt_location; DEALLOCATE PREPARE stmt_location;

SET @has_location_interval := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'monitoring_policies' AND COLUMN_NAME = 'location_interval_minutes');
SET @sql_location_interval := IF(@has_location_interval = 0, 'ALTER TABLE monitoring_policies ADD COLUMN location_interval_minutes INT NOT NULL DEFAULT 15 AFTER location_tracking_enabled', 'SELECT 1');
PREPARE stmt_location_interval FROM @sql_location_interval; EXECUTE stmt_location_interval; DEALLOCATE PREPARE stmt_location_interval;

CREATE TABLE IF NOT EXISTS device_location_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  accuracy_m INT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'windows_location',
  network_name VARCHAR(120) NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_location_device (device_id, recorded_at),
  KEY idx_location_employee (employee_id, recorded_at),
  CONSTRAINT fk_location_device FOREIGN KEY (device_id) REFERENCES employee_devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_location_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
