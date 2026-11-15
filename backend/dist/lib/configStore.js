import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
/** The web root never contains this directory. Back up ciphertext and key separately. */
export class ConfigStore {
    explicitDirectory;
    constructor(explicitDirectory) {
        this.explicitDirectory = explicitDirectory;
    }
    get directory() { return this.explicitDirectory || process.env.WORKFORCE_CONFIG_DIR || path.join(root, 'backend/storage/config'); }
    ensureDirectory() { fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
    key() {
        this.ensureDirectory();
        const supplied = process.env.ENCRYPTION_MASTER_KEY;
        if (supplied) {
            if (!/^[a-f0-9]{64}$/i.test(supplied))
                throw new Error('ENCRYPTION_MASTER_KEY must contain 64 hexadecimal characters');
            return Buffer.from(supplied, 'hex');
        }
        const file = path.join(this.directory, 'master.key');
        if (!fs.existsSync(file)) {
            try {
                fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
        }
        const key = fs.readFileSync(file);
        if (key.length !== 32)
            throw new Error('Invalid server encryption key');
        return key;
    }
    signingKey() { return crypto.createHmac('sha256', this.key()).update('workforce-jwt-signing-v1').digest('hex'); }
    read() {
        const file = path.join(this.directory, 'settings.enc');
        if (!fs.existsSync(file))
            return {};
        const raw = fs.readFileSync(file);
        if (raw.length < 28)
            throw new Error('Invalid encrypted settings');
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    }
    write(settings) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
        const temporary = path.join(this.directory, `settings-${crypto.randomUUID()}.tmp`);
        try {
            fs.writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporary, path.join(this.directory, 'settings.enc'));
        }
        finally {
            if (fs.existsSync(temporary))
                fs.unlinkSync(temporary);
        }
    }
    setupCode() {
        this.ensureDirectory();
        const file = path.join(this.directory, 'setup-code');
        if (!fs.existsSync(file))
            fs.writeFileSync(file, crypto.randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 });
        return fs.readFileSync(file, 'utf8').trim();
    }
    removeSetupCode() { fs.rmSync(path.join(this.directory, 'setup-code'), { force: true }); }
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const configStore = new ConfigStore();
//# sourceMappingURL=configStore.js.map