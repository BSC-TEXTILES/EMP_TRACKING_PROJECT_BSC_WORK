-- 054_location_schedule_permissions.sql
-- Permissions for location office schedule management

INSERT INTO permissions (code, module, action, description)
VALUES
  ('attendance.location_schedule.view', 'attendance', 'view', 'View location office schedules and timings'),
  ('attendance.location_schedule.manage', 'attendance', 'manage', 'Create, update, and delete location office schedules'),
  ('attendance.location_schedule.admin', 'attendance', 'admin', 'Full admin access to location office schedules including bulk operations')
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  module = VALUES(module),
  action = VALUES(action);

-- Grant view permission to roles that can view attendance
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'attendance.location_schedule.view'
WHERE r.slug IN ('super_admin', 'admin', 'hr_manager', 'manager', 'employee')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- Grant manage permission to admin roles
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'attendance.location_schedule.manage'
WHERE r.slug IN ('super_admin', 'admin', 'hr_manager')
ON DUPLICATE KEY UPDATE role_id = role_id;

-- Grant admin permission to super_admin only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'attendance.location_schedule.admin'
WHERE r.slug = 'super_admin'
ON DUPLICATE KEY UPDATE role_id = role_id;