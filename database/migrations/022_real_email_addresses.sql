-- Migration 022: Ensure all employee emails use official BSC Textiles domain (@bsctextiles.in)
UPDATE employees 
SET email = CONCAT(LOWER(REPLACE(TRIM(full_name), ' ', '.')), '@bsctextiles.in')
WHERE email LIKE '%@workforce.test' OR email IS NULL OR email = '';

-- Normalize any special email accounts
UPDATE employees SET email = 'admin@bsctextiles.in' WHERE employee_code = 'EMP-1001';
UPDATE employees SET email = 'ceo@bsctextiles.in' WHERE employee_code = 'EMP-1002';
UPDATE employees SET email = 'coo@bsctextiles.in' WHERE employee_code = 'EMP-1003';
UPDATE employees SET email = 'hr.manager@bsctextiles.in' WHERE employee_code = 'EMP-1005';
UPDATE employees SET email = 'it.manager@bsctextiles.in' WHERE employee_code = 'EMP-1007';
UPDATE employees SET email = 'it.admin@bsctextiles.in' WHERE employee_code = 'EMP-1008';
UPDATE employees SET email = 'store.manager@bsctextiles.in' WHERE employee_code = 'EMP-1016';
