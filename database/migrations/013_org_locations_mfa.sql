-- Organisation master data (designations, three company locations, location
-- access) and multi-factor authentication. Non-destructive: existing employees,
-- attendance and history keep their department, designation and location ids.

-- ------------------------------ Locations ----------------------------------
INSERT INTO locations (name, code, city, state, country, timezone, is_active) VALUES
  ('Belagavi', 'BEL', 'Belagavi', 'Karnataka', 'India', 'Asia/Kolkata', 1),
  ('Davanagere', 'DAV', 'Davanagere', 'Karnataka', 'India', 'Asia/Kolkata', 1),
  ('Shivamogga', 'SHI', 'Shivamogga', 'Karnataka', 'India', 'Asia/Kolkata', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name), city = COALESCE(city, VALUES(city)), state = COALESCE(state, VALUES(state)), is_active = 1;

-- Development placeholder locations are retired only when nothing references them.
UPDATE locations l SET l.is_active = 0
WHERE l.code IN ('HQ', 'AND', 'PUN')
  AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.location_id = l.id);

ALTER TABLE locations
  ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER is_active,
  ADD COLUMN updated_by BIGINT UNSIGNED NULL AFTER created_by;

-- Additional locations an employee may access (their primary location is employees.location_id).
CREATE TABLE IF NOT EXISTS employee_locations (
  employee_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  granted_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (employee_id, location_id),
  KEY idx_employee_locations_location (location_id),
  CONSTRAINT fk_employee_locations_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_employee_locations_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE employees ADD KEY idx_employees_location_status (location_id, status);

-- ----------------------------- Designations --------------------------------
ALTER TABLE designations
  ADD COLUMN code VARCHAR(32) NULL AFTER title,
  ADD COLUMN reporting_designation_id BIGINT UNSIGNED NULL AFTER level,
  ADD COLUMN employment_category VARCHAR(32) NOT NULL DEFAULT 'staff' AFTER reporting_designation_id,
  ADD COLUMN description VARCHAR(255) NULL AFTER employment_category,
  ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER is_active,
  ADD COLUMN updated_by BIGINT UNSIGNED NULL AFTER created_by,
  ADD KEY idx_designations_reporting (reporting_designation_id),
  ADD CONSTRAINT fk_designations_reporting FOREIGN KEY (reporting_designation_id) REFERENCES designations (id) ON DELETE SET NULL;

-- Designations apply to every location unless rows exist here.
CREATE TABLE IF NOT EXISTS designation_locations (
  designation_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (designation_id, location_id),
  KEY idx_designation_locations_location (location_id),
  CONSTRAINT fk_designation_locations_designation FOREIGN KEY (designation_id) REFERENCES designations (id) ON DELETE CASCADE,
  CONSTRAINT fk_designation_locations_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rename near-duplicates to the standard titles (ids, and therefore employee links, are kept).
UPDATE designations d LEFT JOIN designations x ON x.title = 'Owner' AND x.department_id <=> d.department_id SET d.title = 'Owner' WHERE d.title = 'Company Owner' AND x.id IS NULL;
UPDATE designations d LEFT JOIN designations x ON x.title = 'Network Administrator' AND x.department_id <=> d.department_id SET d.title = 'Network Administrator' WHERE d.title = 'Network Engineer' AND x.id IS NULL;
UPDATE designations d LEFT JOIN designations x ON x.title = 'Cybersecurity Engineer' AND x.department_id <=> d.department_id SET d.title = 'Cybersecurity Engineer' WHERE d.title = 'Cybersecurity Analyst' AND x.id IS NULL;
UPDATE designations d LEFT JOIN designations x ON x.title = 'IT Support Executive' AND x.department_id <=> d.department_id SET d.title = 'IT Support Executive' WHERE d.title = 'Technical Support Engineer' AND x.id IS NULL;
UPDATE designations d LEFT JOIN designations x ON x.title = 'Helpdesk Technician' AND x.department_id <=> d.department_id SET d.title = 'Helpdesk Technician' WHERE d.title = 'IT Helpdesk Executive' AND x.id IS NULL;
UPDATE designations d LEFT JOIN designations x ON x.title = 'SEO Executive' AND x.department_id <=> d.department_id SET d.title = 'SEO Executive' WHERE d.title = 'SEO Specialist' AND x.id IS NULL;
UPDATE designations d LEFT JOIN designations x ON x.title = 'Reporting Executive' AND x.department_id <=> d.department_id SET d.title = 'Reporting Executive' WHERE d.title = 'Reporting Analyst' AND x.id IS NULL;
UPDATE designations d LEFT JOIN designations x ON x.title = 'Store Support Executive' AND x.department_id <=> d.department_id SET d.title = 'Store Support Executive' WHERE d.title = 'Store Support Staff' AND x.id IS NULL;

-- Standard designation catalogue (idempotent: unique on title + department).
INSERT IGNORE INTO designations (title, department_id, level, employment_category)
SELECT v.title, d.id, v.level, v.category FROM (
  SELECT 'Owner' AS title, 'EXEC' AS dept, 20 AS level, 'leadership' AS category UNION ALL
  SELECT 'Managing Director', 'EXEC', 20, 'leadership' UNION ALL
  SELECT 'Chief Executive Officer', 'EXEC', 20, 'leadership' UNION ALL
  SELECT 'Chief Operating Officer', 'EXEC', 19, 'leadership' UNION ALL
  SELECT 'Chief Technology Officer', 'EXEC', 19, 'leadership' UNION ALL
  SELECT 'Chief Financial Officer', 'EXEC', 19, 'leadership' UNION ALL
  SELECT 'General Manager', 'EXEC', 17, 'management' UNION ALL
  SELECT 'Deputy General Manager', 'EXEC', 16, 'management' UNION ALL
  SELECT 'Operations Manager', 'OPS', 15, 'management' UNION ALL
  SELECT 'Regional Manager', 'RETAIL', 15, 'management' UNION ALL
  SELECT 'Branch Manager', 'RETAIL', 14, 'management' UNION ALL
  SELECT 'Department Head', 'EXEC', 16, 'management' UNION ALL
  SELECT 'HR Director', 'HR', 18, 'leadership' UNION ALL
  SELECT 'HR Manager', 'HR', 15, 'management' UNION ALL
  SELECT 'HR Executive', 'HR', 9, 'staff' UNION ALL
  SELECT 'HR Recruiter', 'HR', 9, 'staff' UNION ALL
  SELECT 'HR Coordinator', 'HR', 8, 'staff' UNION ALL
  SELECT 'Payroll Manager', 'HR', 13, 'management' UNION ALL
  SELECT 'Payroll Executive', 'HR', 8, 'staff' UNION ALL
  SELECT 'HR Administrator', 'HR', 10, 'staff' UNION ALL
  SELECT 'IT Head', 'IT', 18, 'leadership' UNION ALL
  SELECT 'IT Manager', 'IT', 15, 'management' UNION ALL
  SELECT 'IT Administrator', 'IT', 12, 'professional' UNION ALL
  SELECT 'Software Developer', 'IT', 9, 'professional' UNION ALL
  SELECT 'Frontend Developer', 'IT', 9, 'professional' UNION ALL
  SELECT 'Backend Developer', 'IT', 9, 'professional' UNION ALL
  SELECT 'Full Stack Developer', 'IT', 10, 'professional' UNION ALL
  SELECT 'Mobile App Developer', 'IT', 9, 'professional' UNION ALL
  SELECT 'UI/UX Designer', 'IT', 9, 'professional' UNION ALL
  SELECT 'QA Engineer', 'IT', 8, 'professional' UNION ALL
  SELECT 'Software Tester', 'IT', 7, 'professional' UNION ALL
  SELECT 'DevOps Engineer', 'IT', 11, 'professional' UNION ALL
  SELECT 'Network Administrator', 'IT', 10, 'professional' UNION ALL
  SELECT 'System Administrator', 'IT', 10, 'professional' UNION ALL
  SELECT 'Cybersecurity Engineer', 'IT', 11, 'professional' UNION ALL
  SELECT 'Database Administrator', 'IT', 11, 'professional' UNION ALL
  SELECT 'IT Support Executive', 'IT', 7, 'staff' UNION ALL
  SELECT 'Helpdesk Technician', 'IT', 6, 'staff' UNION ALL
  SELECT 'Digital Marketing Manager', 'MKT', 15, 'management' UNION ALL
  SELECT 'SEO Executive', 'MKT', 8, 'staff' UNION ALL
  SELECT 'Social Media Manager', 'MKT', 11, 'professional' UNION ALL
  SELECT 'Content Writer', 'MKT', 7, 'staff' UNION ALL
  SELECT 'Graphic Designer', 'MKT', 7, 'staff' UNION ALL
  SELECT 'Video Editor', 'MKT', 7, 'staff' UNION ALL
  SELECT 'Performance Marketing Executive', 'MKT', 8, 'staff' UNION ALL
  SELECT 'Business Analyst', 'OPS', 10, 'professional' UNION ALL
  SELECT 'Data Analyst', 'OPS', 9, 'professional' UNION ALL
  SELECT 'MIS Executive', 'OPS', 7, 'staff' UNION ALL
  SELECT 'Reporting Executive', 'OPS', 7, 'staff' UNION ALL
  SELECT 'Business Development Executive', 'OPS', 8, 'staff' UNION ALL
  SELECT 'Customer Support Executive', 'OPS', 6, 'staff' UNION ALL
  SELECT 'CRM Manager', 'OPS', 13, 'management' UNION ALL
  SELECT 'CRM Executive', 'OPS', 7, 'staff' UNION ALL
  SELECT 'Telecaller', 'OPS', 4, 'staff' UNION ALL
  SELECT 'Sales Executive', 'OPS', 6, 'staff' UNION ALL
  SELECT 'Retail Head', 'RETAIL', 18, 'leadership' UNION ALL
  SELECT 'Store Manager', 'RETAIL', 14, 'management' UNION ALL
  SELECT 'Assistant Store Manager', 'RETAIL', 12, 'management' UNION ALL
  SELECT 'Floor Manager', 'RETAIL', 11, 'management' UNION ALL
  SELECT 'Department Manager', 'RETAIL', 11, 'management' UNION ALL
  SELECT 'Sales Manager', 'RETAIL', 13, 'management' UNION ALL
  SELECT 'Sales Executive', 'RETAIL', 6, 'staff' UNION ALL
  SELECT 'Salesman', 'RETAIL', 4, 'staff' UNION ALL
  SELECT 'Cashier', 'RETAIL', 3, 'staff' UNION ALL
  SELECT 'Billing Executive', 'RETAIL', 4, 'staff' UNION ALL
  SELECT 'Stock Manager', 'RETAIL', 9, 'management' UNION ALL
  SELECT 'Inventory Executive', 'RETAIL', 6, 'staff' UNION ALL
  SELECT 'Visual Merchandiser', 'RETAIL', 6, 'staff' UNION ALL
  SELECT 'Customer Relationship Executive', 'RETAIL', 6, 'staff' UNION ALL
  SELECT 'Store Support Executive', 'RETAIL', 3, 'staff'
) v JOIN departments d ON d.code = v.dept;

-- "Super Admin" is a role, not a job title: retire it as a designation when unused.
UPDATE designations g SET g.is_active = 0
WHERE g.title = 'Super Admin' AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.designation_id = g.id);

-- Stable unique codes for every designation.
UPDATE designations g LEFT JOIN departments d ON d.id = g.department_id
SET g.code = CONCAT(COALESCE(d.code, 'GEN'), '-', LPAD(g.id, 4, '0'))
WHERE g.code IS NULL;
ALTER TABLE designations MODIFY code VARCHAR(32) NOT NULL, ADD UNIQUE KEY uq_designations_code (code);

-- Standard reporting lines (designation -> designation it reports to).
UPDATE designations child
JOIN (
  SELECT 'Managing Director' AS child_title, 'EXEC' AS child_dept, 'Owner' AS parent_title, 'EXEC' AS parent_dept UNION ALL
  SELECT 'Chief Executive Officer', 'EXEC', 'Managing Director', 'EXEC' UNION ALL
  SELECT 'Chief Operating Officer', 'EXEC', 'Chief Executive Officer', 'EXEC' UNION ALL
  SELECT 'Chief Technology Officer', 'EXEC', 'Chief Executive Officer', 'EXEC' UNION ALL
  SELECT 'Chief Financial Officer', 'EXEC', 'Chief Executive Officer', 'EXEC' UNION ALL
  SELECT 'General Manager', 'EXEC', 'Chief Operating Officer', 'EXEC' UNION ALL
  SELECT 'Deputy General Manager', 'EXEC', 'General Manager', 'EXEC' UNION ALL
  SELECT 'Operations Manager', 'OPS', 'General Manager', 'EXEC' UNION ALL
  SELECT 'Regional Manager', 'RETAIL', 'Retail Head', 'RETAIL' UNION ALL
  SELECT 'Branch Manager', 'RETAIL', 'Regional Manager', 'RETAIL' UNION ALL
  SELECT 'Department Head', 'EXEC', 'General Manager', 'EXEC' UNION ALL
  SELECT 'HR Director', 'HR', 'Chief Executive Officer', 'EXEC' UNION ALL
  SELECT 'HR Manager', 'HR', 'HR Director', 'HR' UNION ALL
  SELECT 'HR Executive', 'HR', 'HR Manager', 'HR' UNION ALL
  SELECT 'HR Recruiter', 'HR', 'HR Manager', 'HR' UNION ALL
  SELECT 'HR Coordinator', 'HR', 'HR Manager', 'HR' UNION ALL
  SELECT 'HR Administrator', 'HR', 'HR Manager', 'HR' UNION ALL
  SELECT 'Payroll Manager', 'HR', 'HR Director', 'HR' UNION ALL
  SELECT 'Payroll Executive', 'HR', 'Payroll Manager', 'HR' UNION ALL
  SELECT 'IT Head', 'IT', 'Chief Technology Officer', 'EXEC' UNION ALL
  SELECT 'IT Manager', 'IT', 'IT Head', 'IT' UNION ALL
  SELECT 'IT Administrator', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Software Developer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Frontend Developer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Backend Developer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Full Stack Developer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Mobile App Developer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'UI/UX Designer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'QA Engineer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Software Tester', 'IT', 'QA Engineer', 'IT' UNION ALL
  SELECT 'DevOps Engineer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Network Administrator', 'IT', 'IT Administrator', 'IT' UNION ALL
  SELECT 'System Administrator', 'IT', 'IT Administrator', 'IT' UNION ALL
  SELECT 'Cybersecurity Engineer', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'Database Administrator', 'IT', 'IT Manager', 'IT' UNION ALL
  SELECT 'IT Support Executive', 'IT', 'IT Administrator', 'IT' UNION ALL
  SELECT 'Helpdesk Technician', 'IT', 'IT Support Executive', 'IT' UNION ALL
  SELECT 'Digital Marketing Manager', 'MKT', 'General Manager', 'EXEC' UNION ALL
  SELECT 'SEO Executive', 'MKT', 'Digital Marketing Manager', 'MKT' UNION ALL
  SELECT 'Social Media Manager', 'MKT', 'Digital Marketing Manager', 'MKT' UNION ALL
  SELECT 'Content Writer', 'MKT', 'Social Media Manager', 'MKT' UNION ALL
  SELECT 'Graphic Designer', 'MKT', 'Digital Marketing Manager', 'MKT' UNION ALL
  SELECT 'Video Editor', 'MKT', 'Digital Marketing Manager', 'MKT' UNION ALL
  SELECT 'Performance Marketing Executive', 'MKT', 'Digital Marketing Manager', 'MKT' UNION ALL
  SELECT 'Business Analyst', 'OPS', 'Operations Manager', 'OPS' UNION ALL
  SELECT 'Data Analyst', 'OPS', 'Business Analyst', 'OPS' UNION ALL
  SELECT 'MIS Executive', 'OPS', 'Business Analyst', 'OPS' UNION ALL
  SELECT 'Reporting Executive', 'OPS', 'Business Analyst', 'OPS' UNION ALL
  SELECT 'CRM Manager', 'OPS', 'Operations Manager', 'OPS' UNION ALL
  SELECT 'CRM Executive', 'OPS', 'CRM Manager', 'OPS' UNION ALL
  SELECT 'Customer Support Executive', 'OPS', 'CRM Manager', 'OPS' UNION ALL
  SELECT 'Telecaller', 'OPS', 'CRM Manager', 'OPS' UNION ALL
  SELECT 'Business Development Executive', 'OPS', 'Operations Manager', 'OPS' UNION ALL
  SELECT 'Sales Executive', 'OPS', 'CRM Manager', 'OPS' UNION ALL
  SELECT 'Retail Head', 'RETAIL', 'Chief Operating Officer', 'EXEC' UNION ALL
  SELECT 'Store Manager', 'RETAIL', 'Retail Head', 'RETAIL' UNION ALL
  SELECT 'Assistant Store Manager', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Floor Manager', 'RETAIL', 'Assistant Store Manager', 'RETAIL' UNION ALL
  SELECT 'Department Manager', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Sales Manager', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Sales Executive', 'RETAIL', 'Sales Manager', 'RETAIL' UNION ALL
  SELECT 'Salesman', 'RETAIL', 'Floor Manager', 'RETAIL' UNION ALL
  SELECT 'Cashier', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Billing Executive', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Stock Manager', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Inventory Executive', 'RETAIL', 'Stock Manager', 'RETAIL' UNION ALL
  SELECT 'Visual Merchandiser', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Customer Relationship Executive', 'RETAIL', 'Store Manager', 'RETAIL' UNION ALL
  SELECT 'Store Support Executive', 'RETAIL', 'Assistant Store Manager', 'RETAIL'
) map ON map.child_title = child.title
JOIN departments cd ON cd.id = child.department_id AND cd.code = map.child_dept
JOIN departments pd ON pd.code = map.parent_dept
JOIN designations parent ON parent.title = map.parent_title AND parent.department_id = pd.id
SET child.reporting_designation_id = parent.id
WHERE child.reporting_designation_id IS NULL AND parent.id <> child.id;

-- --------------------------- Location permission ---------------------------
INSERT IGNORE INTO permissions (code, module, action, description) VALUES
  ('locations.view.all', 'locations', 'view.all', 'Access organisation-wide data for every location (All Locations)'),
  ('mfa.manage', 'mfa', 'manage', 'Reset employee MFA and configure MFA enforcement');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'locations.view.all'
WHERE r.slug IN ('super_admin', 'company_owner', 'executive', 'general_manager', 'hr_manager', 'it_admin', 'payroll_admin');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'mfa.manage'
WHERE r.slug IN ('super_admin', 'company_owner', 'it_admin');

-- ---------------------------------- MFA -------------------------------------
ALTER TABLE roles ADD COLUMN mfa_required TINYINT(1) NOT NULL DEFAULT 0 AFTER is_system;
ALTER TABLE employees ADD COLUMN mfa_required TINYINT(1) NOT NULL DEFAULT 0 AFTER mfa_enabled;

CREATE TABLE IF NOT EXISTS employee_mfa (
  employee_id BIGINT UNSIGNED NOT NULL,
  email_enabled TINYINT(1) NOT NULL DEFAULT 0,
  totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  totp_secret_enc VARCHAR(255) NULL,
  totp_pending_enc VARCHAR(255) NULL,
  totp_pending_expires_at DATETIME(3) NULL,
  totp_last_step BIGINT NULL,
  preferred_method ENUM('email', 'totp') NOT NULL DEFAULT 'email',
  enrolled_at DATETIME(3) NULL,
  reset_by BIGINT UNSIGNED NULL,
  reset_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (employee_id),
  CONSTRAINT fk_employee_mfa_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_employee_mfa_reset_by FOREIGN KEY (reset_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mfa_recovery_code (code_hash),
  KEY idx_mfa_recovery_employee (employee_id, used_at),
  CONSTRAINT fk_mfa_recovery_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Accounts that already had (email) MFA switched on keep it.
INSERT IGNORE INTO employee_mfa (employee_id, email_enabled, preferred_method, enrolled_at)
SELECT id, 1, 'email', NOW(3) FROM employees WHERE mfa_enabled = 1;

-- Failed second-factor attempts per challenge, for brute-force protection.
CREATE TABLE IF NOT EXISTS mfa_challenge_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  method VARCHAR(16) NOT NULL,
  success TINYINT(1) NOT NULL DEFAULT 0,
  ip VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_mfa_attempts_employee (employee_id, created_at),
  CONSTRAINT fk_mfa_attempts_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
