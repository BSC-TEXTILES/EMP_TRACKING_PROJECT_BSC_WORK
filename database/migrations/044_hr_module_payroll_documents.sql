-- 044_hr_module_payroll_documents.sql
-- Dedicated HR Module: Document verification, employee salary configuration, monthly payroll records, and HR role definitions

-- 1. Create employee_documents table
CREATE TABLE IF NOT EXISTS employee_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  document_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  file_url VARCHAR(500) NOT NULL,
  file_size_bytes INT UNSIGNED DEFAULT 0,
  file_type VARCHAR(100) DEFAULT 'application/pdf',
  status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
  verified_by BIGINT UNSIGNED NULL,
  verified_at DATETIME NULL,
  notes TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_emp_docs_emp_id (employee_id),
  INDEX idx_emp_docs_status (status),
  CONSTRAINT fk_emp_docs_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_emp_docs_verifier FOREIGN KEY (verified_by) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Create employee_salaries table
CREATE TABLE IF NOT EXISTS employee_salaries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL UNIQUE,
  basic_salary DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  hra DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  special_allowance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  conveyance_allowance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  medical_allowance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  gross_salary DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  epf_deduction DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  esi_deduction DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  professional_tax DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  tds_deduction DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total_deductions DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  net_salary DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  bank_name VARCHAR(100) NULL,
  bank_account_no VARCHAR(50) NULL,
  bank_ifsc VARCHAR(20) NULL,
  pan_number VARCHAR(20) NULL,
  uan_number VARCHAR(30) NULL,
  effective_from DATE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_emp_sal_emp_id (employee_id),
  CONSTRAINT fk_emp_sal_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Create payroll_records table
CREATE TABLE IF NOT EXISTS payroll_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  month TINYINT UNSIGNED NOT NULL,
  year SMALLINT UNSIGNED NOT NULL,
  working_days DECIMAL(4,1) NOT NULL DEFAULT 30.0,
  present_days DECIMAL(4,1) NOT NULL DEFAULT 0.0,
  paid_leaves DECIMAL(4,1) NOT NULL DEFAULT 0.0,
  payable_days DECIMAL(4,1) NOT NULL DEFAULT 0.0,
  gross_earnings DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total_deductions DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  net_pay DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  payment_status ENUM('draft', 'processed', 'paid', 'on_hold') NOT NULL DEFAULT 'draft',
  paid_at DATETIME NULL,
  reference_no VARCHAR(60) NULL,
  notes TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_emp_month_year (employee_id, month, year),
  INDEX idx_payroll_month_year (month, year),
  INDEX idx_payroll_status (payment_status),
  CONSTRAINT fk_payroll_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Ensure Admin and HR system roles exist
INSERT IGNORE INTO roles (name, slug, level, category, description, is_system)
VALUES 
  ('Admin', 'admin', 85, 'management', 'Full system administrative access', 1),
  ('HR', 'hr', 50, 'hr', 'Human Resources management and employee operations', 1);

-- Map permissions to new roles based on template roles
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r_new.id, rp.permission_id
FROM roles r_new
JOIN roles r_src ON r_src.slug = 'hr_manager'
JOIN role_permissions rp ON rp.role_id = r_src.id
WHERE r_new.slug = 'hr';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r_new.id, p.id
FROM roles r_new
CROSS JOIN permissions p
WHERE r_new.slug = 'admin'
  AND p.code NOT LIKE 'audit.delete%'
  AND p.code NOT LIKE 'system.destroy%';

-- 5. Initialize default realistic employee salary structures for existing employees if not present
INSERT IGNORE INTO employee_salaries (
  employee_id, basic_salary, hra, special_allowance, conveyance_allowance, medical_allowance,
  gross_salary, epf_deduction, esi_deduction, professional_tax, tds_deduction, total_deductions,
  net_salary, bank_name, bank_account_no, bank_ifsc, effective_from
)
SELECT 
  e.id,
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 60000.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 45000.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 35000.00
    WHEN r.slug IN ('hr_executive', 'payroll_admin', 'team_leader') THEN 25000.00
    ELSE 18000.00
  END AS basic_salary,
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 24000.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 18000.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 14000.00
    WHEN r.slug IN ('hr_executive', 'payroll_admin', 'team_leader') THEN 10000.00
    ELSE 7200.00
  END AS hra,
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 15000.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 10000.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 8000.00
    ELSE 4000.00
  END AS special_allowance,
  2000.00 AS conveyance_allowance,
  1500.00 AS medical_allowance,
  -- Gross
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 102500.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 76500.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 60500.00
    WHEN r.slug IN ('hr_executive', 'payroll_admin', 'team_leader') THEN 42500.00
    ELSE 32700.00
  END AS gross_salary,
  -- Deductions
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 7200.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 5400.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 4200.00
    ELSE 2160.00
  END AS epf_deduction,
  0.00 AS esi_deduction,
  200.00 AS professional_tax,
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 5000.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 3000.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 1500.00
    ELSE 0.00
  END AS tds_deduction,
  -- Total deductions
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 12400.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 8600.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 5900.00
    ELSE 2360.00
  END AS total_deductions,
  -- Net
  CASE 
    WHEN r.slug IN ('super_admin', 'company_owner', 'executive') THEN 90100.00
    WHEN r.slug IN ('general_manager', 'location_manager', 'department_head') THEN 67900.00
    WHEN r.slug IN ('hr_manager', 'store_manager', 'manager', 'it_admin') THEN 54600.00
    WHEN r.slug IN ('hr_executive', 'payroll_admin', 'team_leader') THEN 38000.00
    ELSE 30340.00
  END AS net_salary,
  'State Bank of India' AS bank_name,
  CONCAT('3098', LPAD(e.id, 8, '0')) AS bank_account_no,
  'SBIN0001234' AS bank_ifsc,
  COALESCE(e.joining_date, '2024-01-01') AS effective_from
FROM employees e
LEFT JOIN roles r ON r.id = e.role_id;
