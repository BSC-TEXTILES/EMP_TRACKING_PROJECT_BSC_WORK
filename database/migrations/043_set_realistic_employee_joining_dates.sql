-- Migration 043: Set realistic employee joining dates so weekly offs are not blocked by seed date
UPDATE employees 
SET joining_date = '2024-01-01' 
WHERE joining_date >= '2026-11-01' OR joining_date IS NULL;
