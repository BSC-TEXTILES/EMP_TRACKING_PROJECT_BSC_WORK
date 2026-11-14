import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/lib/configStore.js';

const folders: string[] = [];
function temporaryStore() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wfm-vault-test-')); folders.push(directory); return new ConfigStore(directory); }
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
describe('encrypted website configuration', () => {
  it('survives process-style reloads without storing plaintext credentials', () => {
    const store = temporaryStore();
    const value = { smtp: { host: 'smtp.test', port: 587, secure: false, user: 'test', password: 'sensitive-test-value', from: 'test@test.invalid', replyTo: 'test@test.invalid' } };
    store.write(value);
    expect(fs.readFileSync(path.join(store.directory, 'settings.enc')).toString()).not.toContain(value.smtp.password);
    expect(new ConfigStore(store.directory).read()).toEqual(value);
    expect(new ConfigStore(store.directory).signingKey()).toBe(store.signingKey());
  });
  it('rejects tampered ciphertext instead of silently falling back to default credentials', () => {
    const store = temporaryStore(); store.write({ setupComplete: true });
    const file = path.join(store.directory, 'settings.enc'); const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
    expect(() => store.read()).toThrow();
  });
  it('keeps one setup code until explicitly consumed', () => {
    const store = temporaryStore(); const code = store.setupCode();
    expect(new ConfigStore(store.directory).setupCode()).toBe(code);
    expect(code).toHaveLength(48);
    store.removeSetupCode();
    expect(fs.existsSync(path.join(store.directory, 'setup-code'))).toBe(false);
  });
});
