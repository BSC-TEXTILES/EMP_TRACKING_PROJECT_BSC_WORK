-- Migration 031: independent HR per location, and retirement of the development placeholder
-- locations AND (Andheri Branch) and PUN (Pune Store).
-- Additive: no employee, attendance or leave row is deleted.

-- ---------------------------------------------------------------------------
-- 1. Location HR: the HR people responsible for one location. Leave requests from that
--    location go only to them, and they can see that location's employees.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS location_hr_assignments (
  location_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  assigned_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id, employee_id),
  KEY idx_location_hr_employee (employee_id),
  CONSTRAINT fk_location_hr_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT fk_location_hr_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_location_hr_actor FOREIGN KEY (assigned_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Retire AND and PUN. Their employees move to Head Office (HQ); each move is audited.
--    Nothing happens if HQ is not an active location.
-- ---------------------------------------------------------------------------
SET @hq_id := (SELECT id FROM locations WHERE code = 'HQ' AND is_active = 1 LIMIT 1);

INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
SELECT NULL, 'location.employee_moved', 'employee', e.id,
       JSON_OBJECT('locationId', e.location_id, 'locationCode', l.code),
       JSON_OBJECT('locationId', @hq_id, 'locationCode', 'HQ', 'reason', 'Placeholder location retired')
FROM employees e JOIN locations l ON l.id = e.location_id
WHERE l.code IN ('AND', 'PUN') AND @hq_id IS NOT NULL;

UPDATE employees e JOIN locations l ON l.id = e.location_id
SET e.location_id = @hq_id
WHERE l.code IN ('AND', 'PUN') AND @hq_id IS NOT NULL;

UPDATE workforce_groups g JOIN locations l ON l.id = g.location_id
SET g.is_active = 0
WHERE l.code IN ('AND', 'PUN') AND @hq_id IS NOT NULL;

DELETE el FROM employee_locations el JOIN locations l ON l.id = el.location_id
WHERE l.code IN ('AND', 'PUN') AND @hq_id IS NOT NULL;

INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
SELECT NULL, 'location.deactivated', 'location', l.id, JSON_OBJECT('code', l.code, 'reason', 'Placeholder location retired')
FROM locations l WHERE l.code IN ('AND', 'PUN') AND l.is_active = 1 AND @hq_id IS NOT NULL;

UPDATE locations SET is_active = 0 WHERE code IN ('AND', 'PUN') AND @hq_id IS NOT NULL;
