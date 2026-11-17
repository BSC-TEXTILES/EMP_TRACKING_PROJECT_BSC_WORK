import { afterAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/services/AuthService.js';
import { ActivityService } from '../src/services/ActivityService.js';
import { queryOne, execute, closePool } from '../src/db/index.js';

afterAll(closePool);
describe('automatic monitoring and audit boundaries', () => {
  it('does not accept monitoring consent or manufacture a device on browser login', async () => {
    const row = await queryOne<{ id: number }>("SELECT id FROM employees WHERE email = 'karthik.iyer@workforce.test'");
    const user = (await AuthService.buildUser(row!.id))!;
    await ActivityService.revokeConsent(user, {});
    const before = await queryOne<{ n: number }>('SELECT COUNT(*) n FROM employee_devices WHERE employee_id = ?', [user.id]);
    expect(await ActivityService.autoStartTracking(user)).toMatchObject({ started: false, reason: 'consent_required' });
    expect((await ActivityService.consentStatus(user)).acknowledged).toBe(false);
    expect(await queryOne('SELECT COUNT(*) n FROM employee_devices WHERE employee_id = ?', [user.id])).toEqual(before);
  });
  it('ends only the explicitly logged-out browser audit session', async () => {
    const row = await queryOne<{ id: number }>("SELECT id FROM employees WHERE email = 'karthik.iyer@workforce.test'");
    const first = await AuthService.createSession(row!.id, '127.0.0.1', 'audit-test-one', false);
    const second = await AuthService.createSession(row!.id, '127.0.0.1', 'audit-test-two', false);
    await AuthService.logout(first.token);
    const audit = await queryOne<{ logout_at: string | null }>("SELECT logout_at FROM employee_login_audit WHERE employee_id = ? AND user_agent = 'audit-test-two' ORDER BY id DESC LIMIT 1", [row!.id]);
    expect(audit).not.toBeNull();
    expect(audit!.logout_at).toBeNull();
    await AuthService.logout(second.token);
  });
});
