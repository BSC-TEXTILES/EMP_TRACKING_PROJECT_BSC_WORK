-- Migration 033: Calling permissions, role locations, and permission audit logs.
-- Additive only: preserves all existing employees, calls, roles, and attendance records.

-- 1. Table for tracking permission & role assignment audit history
CREATE TABLE IF NOT EXISTS permission_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id BIGINT UNSIGNED NULL,
  role_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  module VARCHAR(80) NULL,
  details JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_perm_audit_role (role_id),
  KEY idx_perm_audit_employee (employee_id),
  KEY idx_perm_audit_created (created_at),
  CONSTRAINT fk_perm_audit_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_perm_audit_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_perm_audit_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Table for location assignment per role (cross-location role presets)
CREATE TABLE IF NOT EXISTS role_locations (
  role_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  granted_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, location_id),
  KEY idx_role_locations_loc (location_id),
  CONSTRAINT fk_role_locations_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_locations_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_locations_actor FOREIGN KEY (granted_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Comprehensive permissions for calling, notifications, reports, and role management
INSERT INTO permissions (code, module, action, description)
VALUES
  ('calls.view', 'calls', 'view', 'View live calling dialer, active directory and employee status'),
  ('calls.make', 'calls', 'create', 'Initiate audio and video calls to colleagues'),
  ('calls.receive', 'calls', 'approve', 'Receive incoming audio and video calls'),
  ('calls.history', 'calls', 'view', 'View call duration history, logs and records'),
  ('calls.delete', 'calls', 'delete', 'Delete personal call records from history'),
  ('calls.manage', 'calls', 'manage', 'Administer calling configuration, TURN/STUN servers and logs'),

  ('notifications.view', 'notifications', 'view', 'View notification centre and incoming workforce alert stream'),
  ('notifications.delete', 'notifications', 'delete', 'Dismiss and remove notifications'),
  ('notifications.manage', 'notifications', 'manage', 'Configure push notifications, sound settings and delivery channels'),

  ('reports.create', 'reports', 'create', 'Create and submit Daily Evaluation Reports (DER)'),
  ('reports.edit', 'reports', 'edit', 'Edit submitted daily reports and metrics'),
  ('reports.delete', 'reports', 'delete', 'Delete daily reports and draft entries'),
  ('reports.approve', 'reports', 'approve', 'Approve team daily evaluation reports'),

  ('roles.view', 'roles', 'view', 'View roles and permission matrices'),
  ('roles.create', 'roles', 'create', 'Create new custom workforce roles'),
  ('roles.edit', 'roles', 'edit', 'Edit roles, permissions and location access'),
  ('roles.delete', 'roles', 'delete', 'Delete custom workforce roles with employee migration'),

  ('attendance.export', 'attendance', 'export', 'Export attendance and timesheet records'),
  ('activity.export', 'activity', 'export', 'Export employee activity and audit telemetry'),
  ('projects.delete', 'projects', 'delete', 'Delete projects and tasks'),
  ('projects.approve', 'projects', 'approve', 'Approve project milestones and deliverables'),
  ('projects.export', 'projects', 'export', 'Export project status and financial summaries')
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  module = VALUES(module),
  action = VALUES(action);

-- 4. Grant all permissions to Super Admin role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug = 'super_admin'
ON DUPLICATE KEY UPDATE role_id = role_id;

-- 5. Grant standard calling, notification & report permissions to other roles
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'calls.view', 'calls.make', 'calls.receive', 'calls.history',
  'notifications.view',
  'reports.create', 'reports.view.own',
  'attendance.view.own',
  'chat.use'
)
WHERE r.slug <> 'super_admin'
ON DUPLICATE KEY UPDATE role_id = role_id;
