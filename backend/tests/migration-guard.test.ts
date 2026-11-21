import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNonDestructive } from '../src/db/migrate.js';

describe('migration safety guard', () => {
  it('refuses migrations that wipe data', () => {
    expect(() => assertNonDestructive('x.sql', 'DELETE FROM messages;')).toThrow(/destructive/);
    expect(() => assertNonDestructive('x.sql', 'SET FOREIGN_KEY_CHECKS = 0;\nTRUNCATE tickets;')).toThrow(/destructive/);
    expect(() => assertNonDestructive('x.sql', 'DROP TABLE employees;')).toThrow(/destructive/);
    expect(() => assertNonDestructive('021_clear_all_legacy_data.sql', 'DELETE FROM employees;')).toThrow(/destructive/);
    // Always-true conditions are full deletes in disguise.
    expect(() => assertNonDestructive('x.sql', 'DELETE FROM messages WHERE id > 0;')).toThrow(/destructive/);
    expect(() => assertNonDestructive('x.sql', 'DELETE FROM files WHERE 1 = 1;')).toThrow(/destructive/);
    expect(() => assertNonDestructive('x.sql', 'DELETE FROM notification_recipients WHERE notification_id > 0;')).toThrow(/destructive/);
  });

  it('runs a destructive migration only when that exact file is explicitly allowed', () => {
    const previous = process.env.ALLOW_DESTRUCTIVE_MIGRATION;
    try {
      process.env.ALLOW_DESTRUCTIVE_MIGRATION = '020_clear_old_data.sql';
      expect(() => assertNonDestructive('020_clear_old_data.sql', 'DELETE FROM messages WHERE id > 0;')).not.toThrow();
      expect(() => assertNonDestructive('021_other.sql', 'DELETE FROM messages WHERE id > 0;')).toThrow(/destructive/);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_DESTRUCTIVE_MIGRATION;
      else process.env.ALLOW_DESTRUCTIVE_MIGRATION = previous;
    }
  });

  it('allows additive and targeted changes', () => {
    expect(() => assertNonDestructive('x.sql', "DELETE FROM otp_verifications WHERE created_at < NOW();\nALTER TABLE calls ADD COLUMN x INT;")).not.toThrow();
    expect(() => assertNonDestructive('x.sql', '-- DELETE FROM messages;\nCREATE TABLE IF NOT EXISTS t (id INT);')).not.toThrow();
  });

  it('accepts every additive migration (the opt-in data wipe 020 excepted)', () => {
    const dir = path.resolve(__dirname, '../../database/migrations');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql') && !['020_clear_old_data.sql', '021_clear_all_legacy_data.sql', '026_keep_only_gagan_cb.sql', '040_clear_all_tasks_data.sql'].includes(name))) {
      expect(() => assertNonDestructive(file, fs.readFileSync(path.join(dir, file), 'utf8')), file).not.toThrow();
    }
  });
});
