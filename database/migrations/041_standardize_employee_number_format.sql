-- 041_standardize_employee_number_format.sql
-- Enforce standardized Employee Number format: EMP-DVG-1604, EMP-DVG-XXXX, EMP-BLG-XXXX, EMP-SMG-XXXX, EMP-HQ-XXXX

-- 1. Super Admin: Renukaradhya M S -> EMP-DVG-1604
UPDATE employees
SET employee_code = 'EMP-DVG-1604',
    full_name = 'Renukaradhya M S'
WHERE id = 1;

-- 2. HR Manager: Chetan TK -> EMP-HQ-1002
UPDATE employees
SET employee_code = 'EMP-HQ-1002'
WHERE id = 2;

-- 3. Davanagere Employees (Location 2): EMP-DVG-1601 to 1612 (skipping 1604 which is Renukaradhya M S)
UPDATE employees SET employee_code = 'EMP-DVG-1601' WHERE id = 3;
UPDATE employees SET employee_code = 'EMP-DVG-1602' WHERE id = 4;
UPDATE employees SET employee_code = 'EMP-DVG-1603' WHERE id = 5;
UPDATE employees SET employee_code = 'EMP-DVG-1605' WHERE id = 6;
UPDATE employees SET employee_code = 'EMP-DVG-1606' WHERE id = 7;
UPDATE employees SET employee_code = 'EMP-DVG-1607' WHERE id = 8;
UPDATE employees SET employee_code = 'EMP-DVG-1608' WHERE id = 9;
UPDATE employees SET employee_code = 'EMP-DVG-1609' WHERE id = 10;
UPDATE employees SET employee_code = 'EMP-DVG-1610' WHERE id = 11;
UPDATE employees SET employee_code = 'EMP-DVG-1611' WHERE id = 12;
UPDATE employees SET employee_code = 'EMP-DVG-1612' WHERE id = 13;

-- 4. Shivamogga Employees (Location 3): EMP-SMG-1601 to 1611
UPDATE employees SET employee_code = 'EMP-SMG-1601' WHERE id = 14;
UPDATE employees SET employee_code = 'EMP-SMG-1602' WHERE id = 15;
UPDATE employees SET employee_code = 'EMP-SMG-1603' WHERE id = 16;
UPDATE employees SET employee_code = 'EMP-SMG-1604' WHERE id = 17;
UPDATE employees SET employee_code = 'EMP-SMG-1605' WHERE id = 18;
UPDATE employees SET employee_code = 'EMP-SMG-1606' WHERE id = 19;
UPDATE employees SET employee_code = 'EMP-SMG-1607' WHERE id = 20;
UPDATE employees SET employee_code = 'EMP-SMG-1608' WHERE id = 21;
UPDATE employees SET employee_code = 'EMP-SMG-1609' WHERE id = 22;
UPDATE employees SET employee_code = 'EMP-SMG-1610' WHERE id = 23;
UPDATE employees SET employee_code = 'EMP-SMG-1611' WHERE id = 24;

-- 5. Belagavi Employees (Location 1): EMP-BLG-1601 to 1611
UPDATE employees SET employee_code = 'EMP-BLG-1601' WHERE id = 25;
UPDATE employees SET employee_code = 'EMP-BLG-1602' WHERE id = 26;
UPDATE employees SET employee_code = 'EMP-BLG-1603' WHERE id = 27;
UPDATE employees SET employee_code = 'EMP-BLG-1604' WHERE id = 28;
UPDATE employees SET employee_code = 'EMP-BLG-1605' WHERE id = 29;
UPDATE employees SET employee_code = 'EMP-BLG-1606' WHERE id = 30;
UPDATE employees SET employee_code = 'EMP-BLG-1607' WHERE id = 31;
UPDATE employees SET employee_code = 'EMP-BLG-1608' WHERE id = 32;
UPDATE employees SET employee_code = 'EMP-BLG-1609' WHERE id = 33;
UPDATE employees SET employee_code = 'EMP-BLG-1610' WHERE id = 34;
UPDATE employees SET employee_code = 'EMP-BLG-1611' WHERE id = 35;
