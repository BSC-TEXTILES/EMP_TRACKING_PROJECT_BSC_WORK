-- Migration 030: company locations, reporting hierarchy history and workforce groups.
--
-- Additive only. No employee, attendance or location row is deleted or moved here:
--  * BEL / DAV / SHI are (re)activated and HQ (Head Office) is added.
--  * Roles and permissions are created by the RBAC sync at startup (backend/src/lib/rbac.ts),
--    so each role receives exactly the permissions defined in code.
--  * Assigning employees under the Software Manager and giving every employee a location is
--    done by HierarchyService.ensureStructure() at startup, which records each change in
--    reporting_assignments / audit_logs.

-- ---------------------------------------------------------------------------
-- 1. Company locations (existing names and addresses are kept)
-- ---------------------------------------------------------------------------
INSERT INTO locations (name, code, city, state, country, timezone, is_active) VALUES
  ('Belagavi', 'BEL', 'Belagavi', 'Karnataka', 'India', 'Asia/Kolkata', 1),
  ('Davanagere', 'DAV', 'Davanagere', 'Karnataka', 'India', 'Asia/Kolkata', 1),
  ('Shivamogga', 'SHI', 'Shivamogga', 'Karnataka', 'India', 'Asia/Kolkata', 1),
  ('Head Office', 'HQ', NULL, 'Karnataka', 'India', 'Asia/Kolkata', 1)
ON DUPLICATE KEY UPDATE is_active = 1;

-- ---------------------------------------------------------------------------
-- 2. Reporting assignment history (who reported to whom, and when)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reporting_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  manager_id BIGINT UNSIGNED NULL,
  previous_manager_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  reason VARCHAR(160) NULL,
  source VARCHAR(24) NOT NULL DEFAULT 'manual',
  assigned_by BIGINT UNSIGNED NULL,
  effective_from DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  effective_to DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_reporting_assignments_employee (employee_id, effective_to),
  KEY idx_reporting_assignments_manager (manager_id, effective_to),
  CONSTRAINT fk_reporting_assignments_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_reporting_assignments_manager FOREIGN KEY (manager_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_reporting_assignments_previous FOREIGN KEY (previous_manager_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_reporting_assignments_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_reporting_assignments_actor FOREIGN KEY (assigned_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Baseline: the current reporting line of every employee becomes the first open assignment.
INSERT INTO reporting_assignments (employee_id, manager_id, location_id, reason, source)
SELECT e.id, e.manager_id, e.location_id, 'Existing reporting line at migration', 'baseline'
FROM employees e
WHERE NOT EXISTS (SELECT 1 FROM reporting_assignments ra WHERE ra.employee_id = e.id);

-- ---------------------------------------------------------------------------
-- 3. Module the employee is currently using (sent by the web app, no content)
-- ---------------------------------------------------------------------------
SET @has_current_module := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'current_module');
SET @sql_current_module := IF(@has_current_module = 0, 'ALTER TABLE employees ADD COLUMN current_module VARCHAR(48) NULL, ADD COLUMN current_module_at DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt_current_module FROM @sql_current_module; EXECUTE stmt_current_module; DEALLOCATE PREPARE stmt_current_module;

-- ---------------------------------------------------------------------------
-- 4. Workforce groups (optional teams inside a location; none are pre-created)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workforce_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  code VARCHAR(64) NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  manager_id BIGINT UNSIGNED NULL,
  team_leader_id BIGINT UNSIGNED NULL,
  description VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_location_group_name (location_id, name),
  KEY idx_workforce_groups_location (location_id),
  KEY idx_workforce_groups_manager (manager_id),
  KEY idx_workforce_groups_team_leader (team_leader_id),
  CONSTRAINT fk_workforce_groups_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_workforce_groups_manager FOREIGN KEY (manager_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_workforce_groups_team_leader FOREIGN KEY (team_leader_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @has_group_id := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'group_id');
SET @sql_group_id := IF(@has_group_id = 0, 'ALTER TABLE employees ADD COLUMN group_id BIGINT UNSIGNED NULL AFTER location_id, ADD CONSTRAINT fk_employees_group FOREIGN KEY (group_id) REFERENCES workforce_groups (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE stmt_group_id FROM @sql_group_id; EXECUTE stmt_group_id; DEALLOCATE PREPARE stmt_group_id;

SET @has_team_leader_id := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'team_leader_id');
SET @sql_team_leader_id := IF(@has_team_leader_id = 0, 'ALTER TABLE employees ADD COLUMN team_leader_id BIGINT UNSIGNED NULL AFTER manager_id, ADD CONSTRAINT fk_employees_team_leader FOREIGN KEY (team_leader_id) REFERENCES employees (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE stmt_team_leader_id FROM @sql_team_leader_id; EXECUTE stmt_team_leader_id; DEALLOCATE PREPARE stmt_team_leader_id;

CREATE TABLE IF NOT EXISTS employee_group_members (
  group_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 1,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  assigned_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (group_id, employee_id),
  KEY idx_egm_employee (employee_id),
  CONSTRAINT fk_egm_group FOREIGN KEY (group_id) REFERENCES workforce_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_egm_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. Location / group change audit (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workforce_location_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id BIGINT UNSIGNED NOT NULL,
  actor_name VARCHAR(160) NOT NULL,
  action VARCHAR(80) NOT NULL,
  target_employee_id BIGINT UNSIGNED NULL,
  target_employee_name VARCHAR(160) NULL,
  group_id BIGINT UNSIGNED NULL,
  group_name VARCHAR(160) NULL,
  from_location_id BIGINT UNSIGNED NULL,
  from_location_name VARCHAR(120) NULL,
  to_location_id BIGINT UNSIGNED NULL,
  to_location_name VARCHAR(120) NULL,
  details JSON NULL,
  ip_address VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_wla_actor (actor_id),
  KEY idx_wla_employee (target_employee_id),
  KEY idx_wla_group (group_id),
  KEY idx_wla_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. Secondary role links written at startup (never created by an earlier migration,
--    so startup failed at this point on databases without it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_roles (
  employee_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (employee_id, role_id),
  KEY idx_employee_roles_role (role_id),
  CONSTRAINT fk_employee_roles_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_employee_roles_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
