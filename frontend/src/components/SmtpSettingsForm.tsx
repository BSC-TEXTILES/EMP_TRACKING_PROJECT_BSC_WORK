import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Card, Field } from './ui';
import { useAuth } from '../contexts/AuthContext';

interface Settings { host: string; port: number; secure: boolean; user: string; password: string; fromName: string; fromEmail: string; replyTo: string; hasPassword?: boolean;
  otp: { expiryMinutes: number; resendCooldownSeconds: number; maxAttempts: number }; }

export function SmtpSettingsForm({ onSaved }: { onSaved: () => void }) {
  const { has } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [to, setTo] = useState('');
  const [verification, setVerification] = useState('');
  const [received, setReceived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (has('settings.manage')) api.get<Settings>('/admin/email/configuration').then(value => setSettings({ ...value, password: '' })).catch(error => setError(errorMessage(error)));
  }, [has]);
  if (!has('settings.manage')) return null;
  const changed = (next: Settings) => { setSettings(next); setVerification(''); setReceived(false); setMessage(''); };
  return <Card className="card-pad"><h2 className="font-semibold">Configure email and OTP</h2>
    <p className="mt-1 text-sm text-ink-500">Enter your provider settings, send a test, confirm receipt and save. Saved passwords are never returned to the browser.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="mt-3 text-sm text-emerald-700">{message}</p>}
    {!settings ? <p className="mt-3 text-sm">{error ? 'Settings could not be loaded.' : 'Loading settings…'}</p> : <form className="mt-4 space-y-4" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(''); setMessage(''); setVerification(''); setReceived(false);
      try {
        const { otp, hasPassword: _hasPassword, ...smtp } = settings;
        const result = await api.post<{ verification: string }>('/admin/email/configuration/test', { smtp, otp, to });
        setVerification(result.verification);
        setMessage('The SMTP server accepted the test email. Check your inbox before saving.');
      } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
    }}><fieldset disabled={busy} className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {([['host', 'SMTP hostname'], ['user', 'SMTP username'], ['fromName', 'Sender name'], ['fromEmail', 'Sender email'], ['replyTo', 'Reply-to email']] as const).map(([key, label]) => <Field key={key} label={label} required><input className="input" required type={key === 'fromEmail' || key === 'replyTo' ? 'email' : 'text'} value={settings[key]} onChange={event => changed({ ...settings, [key]: event.target.value })} /></Field>)}
      <Field label="SMTP port" required><input className="input" required type="number" min={1} max={65535} value={settings.port} onChange={event => changed({ ...settings, port: Number(event.target.value) })} /></Field>
      <Field label="SMTP password" hint={settings.hasPassword ? 'Leave blank to keep the saved password for the same provider/account.' : undefined}><input className="input" type="password" autoComplete="new-password" value={settings.password} onChange={event => changed({ ...settings, password: event.target.value })} /></Field>
      <Field label="Test recipient" required><input className="input" type="email" required value={to} onChange={event => setTo(event.target.value)} /></Field>
      {([['expiryMinutes', 'OTP expiry (minutes)', 1, 30], ['resendCooldownSeconds', 'Resend cooldown (seconds)', 30, 600], ['maxAttempts', 'Maximum attempts', 1, 10]] as const).map(([key, label, min, max]) => <Field key={key} label={label}><input className="input" required type="number" min={min} max={max} value={settings.otp[key]} onChange={event => changed({ ...settings, otp: { ...settings.otp, [key]: Number(event.target.value) } })} /></Field>)}
    </div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.secure} onChange={event => changed({ ...settings, secure: event.target.checked })} />Implicit TLS (usually port 465); otherwise STARTTLS is required</label>
    <div className="flex flex-wrap items-center gap-3"><button className="btn-secondary" type="submit">{busy ? 'Working…' : 'Test configuration'}</button>
      {verification && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={received} onChange={event => setReceived(event.target.checked)} />I received the test email</label>
        <button type="button" className="btn-primary" disabled={!received || busy} onClick={async () => {
          setBusy(true); setError('');
          try {
            await api.put('/admin/email/configuration', { verification, receivedTest: true });
            setSettings({ ...settings, password: '', hasPassword: true }); setVerification(''); setReceived(false);
            setMessage('Verified email configuration saved. New messages use these settings.'); onSaved();
          } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
        }}>Save verified configuration</button></>}
    </div></fieldset></form>}
  </Card>;
}
