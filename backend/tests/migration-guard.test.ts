import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNonDestructive } from '../src/db/migrate.js';

describe('migration safety guard', () => {
  it('refuses migrations that wipe data', () => {
    expect(() => assertNonDestructive('x.sql', 'DELETE FROM messages;')).toThrow(/destructive/);
    expect(() => assertNonDestructive('x.sql', 'SET FOREIGN_KEY_CHECKS = 0;\nTRUNCATE tickets;')).toThrow(/destructive/);
    expect(() => assertNonDestructive('x.sql', 'DROP TABLE employees;')).toThrow(/destructive/);
  });

  it('allows additive and targeted changes', () => {
    expect(() => assertNonDestructive('x.sql', "DELETE FROM otp_verifications WHERE created_at < NOW();\nALTER TABLE calls ADD COLUMN x INT;")).not.toThrow();
    expect(() => assertNonDestructive('x.sql', '-- DELETE FROM messages;\nCREATE TABLE IF NOT EXISTS t (id INT);')).not.toThrow();
  });

  it('accepts every committed migration', () => {
    const dir = path.resolve(__dirname, '../../database/migrations');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
      expect(() => assertNonDestructive(file, fs.readFileSync(path.join(dir, file), 'utf8')), file).not.toThrow();
    }
  });
});
