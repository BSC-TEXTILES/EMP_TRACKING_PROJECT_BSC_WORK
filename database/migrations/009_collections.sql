-- Collection module: customer payment collections tracked by the organisation.
-- Records are scoped by the same reporting hierarchy used by tasks and tickets.

CREATE TABLE IF NOT EXISTS collections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference_no VARCHAR(32) NOT NULL,
  customer_name VARCHAR(160) NOT NULL,
  customer_contact VARCHAR(40) NULL,
  invoice_no VARCHAR(80) NULL,
  amount_due DECIMAL(14, 2) NOT NULL,
  amount_collected DECIMAL(14, 2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  payment_mode ENUM('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') NULL,
  status ENUM('pending', 'partial', 'collected', 'cancelled') NOT NULL DEFAULT 'pending',
  approval_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  due_date DATE NOT NULL,
  collected_on DATE NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  notes VARCHAR(1000) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(3) NULL,
  rejection_reason VARCHAR(400) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_reference (reference_no),
  KEY idx_collection_status (status, due_date),
  KEY idx_collection_approval (approval_status),
  KEY idx_collection_employee (employee_id),
  KEY idx_collection_department (department_id),
  KEY idx_collection_location (location_id),
  KEY idx_collection_due (due_date),
  KEY idx_collection_created (created_at),
  CONSTRAINT fk_collection_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_collection_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_collection_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_collection_approved_by FOREIGN KEY (approved_by) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_collection_created_by FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO system_settings (setting_key, setting_value)
VALUES ('collection_seq', '0')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

INSERT IGNORE INTO permissions (code, module, action, description) VALUES
  ('collections.view.own', 'collections', 'view.own', 'View own collection records'),
  ('collections.view.team', 'collections', 'view.team', 'View collection records for the reporting team'),
  ('collections.view.all', 'collections', 'view.all', 'View all collection records'),
  ('collections.create', 'collections', 'create', 'Create collection records'),
  ('collections.edit', 'collections', 'edit', 'Edit collection records'),
  ('collections.delete', 'collections', 'delete', 'Delete collection records'),
  ('collections.approve', 'collections', 'approve', 'Approve or reject collection records');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'collections'
WHERE r.slug IN ('super_admin', 'company_owner');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'collections'
WHERE r.slug = 'executive';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'collections'
WHERE r.slug = 'general_manager'
  AND p.code IN ('collections.view.all', 'collections.create', 'collections.edit', 'collections.delete', 'collections.approve');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'collections'
WHERE r.slug IN ('manager', 'department_head', 'store_manager', 'it_admin')
  AND p.code IN ('collections.view.own', 'collections.view.team', 'collections.create', 'collections.edit', 'collections.approve');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'collections'
WHERE r.slug = 'hr_manager'
  AND p.code IN ('collections.view.own', 'collections.view.team', 'collections.view.all');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'collections'
WHERE r.slug = 'hr_executive'
  AND p.code IN ('collections.view.own', 'collections.view.all');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'collections'
WHERE r.slug IN ('employee', 'helpdesk', 'payroll_admin')
  AND p.code IN ('collections.view.own', 'collections.create');
