-- Migration 037: the Super Admin account is renamed to Renukaradhya (renukaradhya@bsctextiles.in).
--
-- The real Super Admin login was gagan.cb@bsctextiles.in. Earlier startup code instead created / overwrote a
-- separate "Renukaradhya" row (renuka.adhya@bsctextiles.in) and demoted the real account on every restart.
--
-- This migration:
--   * renames the real account in place (same id, same password, all history kept);
--   * moves reporting lines and department heads from the old placeholder row to it;
--   * deactivates the placeholder row (it is kept, nothing is deleted);
--   * where no gagan.cb@ account exists (fresh / local databases), just updates the placeholder's email.
-- Idempotent: running it again changes nothing.

SET @super_role := (SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1);
SET @employee_role := (SELECT id FROM roles WHERE slug = 'employee' LIMIT 1);
SET @real_id := (SELECT id FROM employees WHERE LOWER(email) = 'gagan.cb@bsctextiles.in' LIMIT 1);
SET @placeholder_id := (
  SELECT id FROM employees
  WHERE LOWER(email) = 'renuka.adhya@bsctextiles.in' AND (@real_id IS NULL OR id <> @real_id)
  LIMIT 1
);

-- 1. Real account exists: hand the placeholder's reporting lines and department heads to it.
UPDATE employees SET manager_id = @real_id
WHERE @real_id IS NOT NULL AND @placeholder_id IS NOT NULL AND manager_id = @placeholder_id AND id <> @real_id;

UPDATE departments SET head_employee_id = @real_id
WHERE @real_id IS NOT NULL AND @placeholder_id IS NOT NULL AND head_employee_id = @placeholder_id;

-- 2. Deactivate the placeholder (kept for history; it can no longer act as Super Admin or log in).
UPDATE employees
SET status = 'inactive',
    role_id = COALESCE(@employee_role, role_id),
    manager_id = @real_id,
    full_name = CONCAT(full_name, ' (old placeholder)')
WHERE @real_id IS NOT NULL AND id = @placeholder_id AND status <> 'inactive';

-- 3. Rename the real account in place and make sure it is the active Super Admin at the top of the hierarchy.
UPDATE employees
SET full_name = 'Renukaradhya',
    email = 'renukaradhya@bsctextiles.in',
    role_id = COALESCE(@super_role, role_id),
    manager_id = NULL,
    status = 'active',
    failed_login_attempts = 0,
    locked_until = NULL
WHERE id = @real_id
  AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM employees WHERE LOWER(email) = 'renukaradhya@bsctextiles.in') AS taken WHERE taken.id <> @real_id);

-- 4. No gagan.cb@ account (fresh / local database): the existing Renukaradhya row simply gets the new email.
UPDATE employees
SET email = 'renukaradhya@bsctextiles.in'
WHERE @real_id IS NULL AND id = @placeholder_id
  AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM employees WHERE LOWER(email) = 'renukaradhya@bsctextiles.in') AS taken);
