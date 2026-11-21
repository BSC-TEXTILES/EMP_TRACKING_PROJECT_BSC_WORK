import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Card, Field } from './ui';
import { useAuth } from '../contexts/AuthContext';

interface Settings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  hasPassword?: boolean;
  otp: { expiryMinutes: number; resendCooldownSeconds: number; maxAttempts: number };
}

const DEFAULT_SETTINGS: Settings = {
  host: 'smtp.hostinger.com',
  port: 465,
  secure: true,
  user: 'admin@bsctextiles.in',
  password: '',
  fromName: 'BSC Textiles Workforce',
  fromEmail: 'admin@bsctextiles.in',
  replyTo: 'admin@bsctextiles.in',
  hasPassword: true,
  otp: { expiryMinutes: 10, resendCooldownSeconds: 60, maxAttempts: 5 },
};

export function SmtpSettingsForm({ onSaved }: { onSaved: () => void }) {
  const { has } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [to, setTo] = useState('admin@bsctextiles.in');
  const [verification, setVerification] = useState('');
  const [received, setReceived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingDirect, setSavingDirect] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (has('settings.manage')) {
      api
        .get<Settings>('/admin/email/configuration')
        .then((value) => {
          setSettings({
            host: value.host || DEFAULT_SETTINGS.host,
            port: value.port || DEFAULT_SETTINGS.port,
            secure: value.secure ?? DEFAULT_SETTINGS.secure,
            user: value.user || DEFAULT_SETTINGS.user,
            password: '',
            fromName: value.fromName || DEFAULT_SETTINGS.fromName,
            fromEmail: value.fromEmail || DEFAULT_SETTINGS.fromEmail,
            replyTo: value.replyTo || DEFAULT_SETTINGS.replyTo,
            hasPassword: value.hasPassword ?? true,
            otp: value.otp || DEFAULT_SETTINGS.otp,
          });
        })
        .catch((err) => {
          const msg = errorMessage(err);
          setError(msg);
          console.error('[SmtpSettingsForm] Failed to load email config:', msg);
          setSettings(DEFAULT_SETTINGS);
        });
    }
  }, [has]);

  if (!has('settings.manage')) return null;

  const changed = (next: Settings) => {
    setSettings(next);
    setVerification('');
    setReceived(false);
    setMessage('');
  };

  const handleDirectSave = async () => {
    if (!settings) return;
    setSavingDirect(true);
    setError('');
    setMessage('');
    try {
      await api.put('/admin/email/configuration', {
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        user: settings.user,
        password: settings.password || undefined,
        fromName: settings.fromName,
        fromEmail: settings.fromEmail,
        replyTo: settings.replyTo,
        otp: settings.otp,
      });
      setSettings({ ...settings, password: '', hasPassword: true });
      setMessage('SMTP email settings saved successfully and live mail transport updated.');
      onSaved();
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      console.error('[SmtpSettingsForm] Direct save failed:', msg, err);
    } finally {
      setSavingDirect(false);
    }
  };

  return (
    <Card className="card-pad">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-ink-900">Configure email and OTP</h2>
          <p className="mt-1 text-sm text-ink-500">
            Enter your SMTP credentials and OTP parameters. You can save directly or verify with a test message.
          </p>
        </div>
        {settings && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy || savingDirect}
            onClick={handleDirectSave}
          >
            {savingDirect ? 'Saving…' : 'Save configuration'}
          </button>
        )}
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-700 bg-red-50 p-2.5 rounded-lg border border-red-200">{error}</p>}
      {message && <p role="status" className="mt-3 text-sm text-emerald-700 bg-emerald-50 p-2.5 rounded-lg border border-emerald-200 font-medium">{message}</p>}

      {!settings ? (
        <p className="mt-3 text-sm">{error ? 'Settings could not be loaded.' : 'Loading settings…'}</p>
      ) : (
        <form
          className="mt-4 space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            setMessage('');
            setVerification('');
            setReceived(false);
            try {
              const { otp, hasPassword: _hasPassword, ...smtp } = settings;
              const result = await api.post<{ verification: string }>('/admin/email/configuration/test', { smtp, otp, to });
              setVerification(result.verification);
              setMessage('The SMTP server accepted the test email. Check your inbox before confirming receipt.');
            } catch (err) {
              const msg = errorMessage(err);
              setError(msg);
              console.error('[SmtpSettingsForm] Test configuration failed:', msg, err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy || savingDirect} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {([
                ['host', 'SMTP hostname', 'off'],
                ['user', 'SMTP username', 'off'],
                ['fromName', 'Sender name', 'off'],
                ['fromEmail', 'Sender email', 'email'],
                ['replyTo', 'Reply-to email', 'email'],
              ] as const).map(([key, label, autoComplete]) => (
                <Field key={key} label={label} required>
                  <input
                    className="input"
                    required
                    type={key === 'fromEmail' || key === 'replyTo' ? 'email' : 'text'}
                    autoComplete={autoComplete}
                    value={settings[key]}
                    onChange={(event) => changed({ ...settings, [key]: event.target.value })}
                  />
                </Field>
              ))}
              <Field label="SMTP port" required>
                <input
                  className="input"
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={settings.port}
                  onChange={(event) => changed({ ...settings, port: Number(event.target.value) })}
                />
              </Field>
              <Field
                label="SMTP password"
                hint={settings.hasPassword ? 'Password is configured. Leave blank to keep existing password, or type to change.' : undefined}
              >
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.hasPassword ? '••••••••••••' : 'Enter SMTP password'}
                  value={settings.password}
                  onChange={(event) => changed({ ...settings, password: event.target.value })}
                />
              </Field>
              <Field label="Test recipient" hint="Email address to receive the test message" required>
                <input
                  className="input"
                  type="email"
                  required
                  autoComplete="email"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </Field>
              {([
                ['expiryMinutes', 'OTP expiry (minutes)', 1, 30],
                ['resendCooldownSeconds', 'Resend cooldown (seconds)', 30, 600],
                ['maxAttempts', 'Maximum attempts', 1, 10],
              ] as const).map(([key, label, min, max]) => (
                <Field key={key} label={label}>
                  <input
                    className="input"
                    required
                    type="number"
                    min={min}
                    max={max}
                    value={settings.otp[key]}
                    onChange={(event) =>
                      changed({
                        ...settings,
                        otp: { ...settings.otp, [key]: Number(event.target.value) },
                      })
                    }
                  />
                </Field>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-ink-700 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.secure}
                onChange={(event) => changed({ ...settings, secure: event.target.checked })}
              />
              Implicit TLS (SSL port 465); uncheck for STARTTLS (port 587)
            </label>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                className="btn-primary"
                disabled={busy || savingDirect}
                onClick={handleDirectSave}
              >
                {savingDirect ? 'Saving…' : 'Save configuration'}
              </button>
              <button className="btn-secondary" type="submit" disabled={busy || savingDirect}>
                {busy ? 'Sending test…' : 'Test configuration'}
              </button>

              {verification && (
                <>
                  <label className="flex items-center gap-2 text-sm cursor-pointer ml-2">
                    <input
                      type="checkbox"
                      checked={received}
                      onChange={(event) => setReceived(event.target.checked)}
                    />
                    I received the test email
                  </label>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!received || busy || savingDirect}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        await api.put('/admin/email/configuration', { verification, receivedTest: true });
                        setSettings({ ...settings, password: '', hasPassword: true });
                        setVerification('');
                        setReceived(false);
                        setMessage('Verified email configuration saved. New messages use these settings.');
                        onSaved();
                      } catch (err) {
                        const msg = errorMessage(err);
                        setError(msg);
                        console.error('[SmtpSettingsForm] Verified save failed:', msg, err);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Save verified configuration
                  </button>
                </>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </Card>
  );
}
