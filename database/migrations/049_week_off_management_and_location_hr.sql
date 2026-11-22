-- 049_week_off_management_and_location_hr.sql
-- Ensure only WEEK OFF (WO) is active; deactivate other leave types
UPDATE leave_types SET is_active = 1 WHERE code = 'WO';
UPDATE leave_types SET is_active = 0 WHERE code <> 'WO';

-- Update default status for leave_requests to 'pending_hr' (HR verification first)
ALTER TABLE leave_requests MODIFY COLUMN status varchar(24) NOT NULL DEFAULT 'pending_hr';

-- Ensure role permissions for Location HR: hr role has leave.approve.hr
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.slug IN ('hr', 'hr_manager', 'super_admin') AND p.code IN ('leave.approve.hr', 'leave.view.all', 'leave.view.team', 'leave.manage');

-- Ensure General Manager has proper permissions
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.slug = 'general_manager' AND p.code IN ('leave.view.all', 'leave.view.team', 'leave.approve.manager', 'employees.view.all', 'employees.view.team', 'dashboard.view');

-- Setup dedicated General Manager account if not exists
INSERT INTO employees (
  employee_code, full_name, email, mobile, password_hash,
  role_id, department_id, designation_id, manager_id, location_id,
  employment_type, status, joining_date, email_verified_at, mobile_verified_at
)
SELECT 'EMP-HQ-1003', 'Anil Kulkarni', 'anil.kulkarni@bsctextiles.in', '9880001003',
  '$2a$12$5blrL1tsZxO0TP.ghDbMLOg6EijV4l7KwdvUJ2FSCoKyzFFmDivvm', -- Workforce@2026
  (SELECT id FROM roles WHERE slug = 'general_manager'),
  (SELECT id FROM departments WHERE code = 'MGT' LIMIT 1),
  (SELECT id FROM designations WHERE code = 'GM' LIMIT 1),
  1, 4, 'full_time', 'active', '2023-01-01', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE employee_code = 'EMP-HQ-1003' OR email = 'anil.kulkarni@bsctextiles.in');

-- Setup dedicated BEL HR account if not exists
INSERT INTO employees (
  employee_code, full_name, email, mobile, password_hash,
  role_id, department_id, designation_id, manager_id, location_id,
  employment_type, status, joining_date, email_verified_at, mobile_verified_at
)
SELECT 'EMP-BLG-HR01', 'Deepak Naik', 'hr.bel@bsctextiles.in', '9880001101',
  '$2a$12$5blrL1tsZxO0TP.ghDbMLOg6EijV4l7KwdvUJ2FSCoKyzFFmDivvm', -- Workforce@2026
  (SELECT id FROM roles WHERE slug = 'hr'),
  (SELECT id FROM departments WHERE code = 'HR' LIMIT 1),
  (SELECT id FROM designations WHERE code = 'HRE' LIMIT 1),
  2, 1, 'full_time', 'active', '2023-01-01', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE employee_code = 'EMP-BLG-HR01' OR email = 'hr.bel@bsctextiles.in');

-- Setup dedicated DAV HR account if not exists
INSERT INTO employees (
  employee_code, full_name, email, mobile, password_hash,
  role_id, department_id, designation_id, manager_id, location_id,
  employment_type, status, joining_date, email_verified_at, mobile_verified_at
)
SELECT 'EMP-DVG-HR01', 'Sudha Murthy', 'hr.dav@bsctextiles.in', '9880001201',
  '$2a$12$5blrL1tsZxO0TP.ghDbMLOg6EijV4l7KwdvUJ2FSCoKyzFFmDivvm', -- Workforce@2026
  (SELECT id FROM roles WHERE slug = 'hr'),
  (SELECT id FROM departments WHERE code = 'HR' LIMIT 1),
  (SELECT id FROM designations WHERE code = 'HRE' LIMIT 1),
  2, 2, 'full_time', 'active', '2023-01-01', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE employee_code = 'EMP-DVG-HR01' OR email = 'hr.dav@bsctextiles.in');

-- Setup dedicated SHI HR account if not exists
INSERT INTO employees (
  employee_code, full_name, email, mobile, password_hash,
  role_id, department_id, designation_id, manager_id, location_id,
  employment_type, status, joining_date, email_verified_at, mobile_verified_at
)
SELECT 'EMP-SMG-HR01', 'Rajeshwari Bhat', 'hr.shi@bsctextiles.in', '9880001301',
  '$2a$12$5blrL1tsZxO0TP.ghDbMLOg6EijV4l7KwdvUJ2FSCoKyzFFmDivvm', -- Workforce@2026
  (SELECT id FROM roles WHERE slug = 'hr'),
  (SELECT id FROM departments WHERE code = 'HR' LIMIT 1),
  (SELECT id FROM designations WHERE code = 'HRE' LIMIT 1),
  2, 3, 'full_time', 'active', '2023-01-01', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE employee_code = 'EMP-SMG-HR01' OR email = 'hr.shi@bsctextiles.in');

-- Map HR to locations in location_hr_assignments
-- BEL HR (location 1)
INSERT IGNORE INTO location_hr_assignments (location_id, employee_id, assigned_by)
SELECT 1, e.id, 1 FROM employees e WHERE e.employee_code = 'EMP-BLG-HR01';

-- DAV HR (location 2)
INSERT IGNORE INTO location_hr_assignments (location_id, employee_id, assigned_by)
SELECT 2, e.id, 1 FROM employees e WHERE e.employee_code = 'EMP-DVG-HR01';

-- SHI HR (location 3)
INSERT IGNORE INTO location_hr_assignments (location_id, employee_id, assigned_by)
SELECT 3, e.id, 1 FROM employees e WHERE e.employee_code = 'EMP-SMG-HR01';

-- HQ HR Chetan TK (location 7 and location 4 ALL)
INSERT IGNORE INTO location_hr_assignments (location_id, employee_id, assigned_by)
SELECT 7, 2, 1 FROM DUAL;
INSERT IGNORE INTO location_hr_assignments (location_id, employee_id, assigned_by)
SELECT 4, 2, 1 FROM DUAL;

-- Also ensure employee_locations has entries for multi-location viewing
INSERT IGNORE INTO employee_locations (employee_id, location_id)
SELECT e.id, 1 FROM employees e WHERE e.employee_code = 'EMP-BLG-HR01';
INSERT IGNORE INTO employee_locations (employee_id, location_id)
SELECT e.id, 2 FROM employees e WHERE e.employee_code = 'EMP-DVG-HR01';
INSERT IGNORE INTO employee_locations (employee_id, location_id)
SELECT e.id, 3 FROM employees e WHERE e.employee_code = 'EMP-SMG-HR01';

-- Ensure General Manager has access to all stores (1, 2, 3, 4, 7)
INSERT IGNORE INTO employee_locations (employee_id, location_id)
SELECT e.id, 1 FROM employees e WHERE e.employee_code = 'EMP-HQ-1003'
UNION SELECT e.id, 2 FROM employees e WHERE e.employee_code = 'EMP-HQ-1003'
UNION SELECT e.id, 3 FROM employees e WHERE e.employee_code = 'EMP-HQ-1003'
UNION SELECT e.id, 4 FROM employees e WHERE e.employee_code = 'EMP-HQ-1003'
UNION SELECT e.id, 7 FROM employees e WHERE e.employee_code = 'EMP-HQ-1003';
