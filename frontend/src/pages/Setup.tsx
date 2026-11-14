import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Field } from '../components/ui';

export default function Setup() {
  const [required, setRequired] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    fetch('/api/setup/status', { credentials: 'include' }).then(async response => {
      if (!response.ok) throw new Error('Cannot check installation status.');
      setRequired((await response.json()).required);
    }).catch(error => setError(error.message));
  }, []);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) || '');
    if (value('adminPassword') !== value('confirmPassword')) { setError('Administrator passwords must match.'); setBusy(false); return; }
    try {
      const response = await fetch('/api/setup/install', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Setup-Code': value('setupCode') },
        body: JSON.stringify({ appName: value('company'),
          database: { host: value('dbHost'), port: Number(value('dbPort')), user: value('dbUser'), password: value('dbPassword'), database: value('dbName') },
          smtp: { host: value('smtpHost'), port: Number(value('smtpPort')), secure: data.get('smtpSecure') === 'on', user: value('smtpUser'), password: value('smtpPassword'),
            fromName: value('fromName'), fromEmail: value('fromEmail'), replyTo: value('replyTo') },
          admin: { name: value('adminName'), email: value('adminEmail'), mobile: value('adminMobile'), password: value('adminPassword'), department: value('department'), location: value('location') } }),
        signal: AbortSignal.timeout(180000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Setup failed. Check the server connection and try again.');
      setDone(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Setup failed.'); }
    finally { setBusy(false); }
  };
  const input = (name: string, label: string, type = 'text', defaultValue?: string) => (
    <Field label={label} required><input name={name} type={type} defaultValue={defaultValue} className="input" required autoComplete={type === 'password' ? 'new-password' : 'off'} maxLength={type === 'password' ? 1000 : 190} /></Field>
  );
  return <main className="min-h-screen bg-ink-50 px-4 py-10"><div className="mx-auto max-w-3xl space-y-5">
    <div><h1 className="text-2xl font-semibold">Set up your workforce platform</h1><p className="mt-2 text-sm text-ink-600">Enter your own database, email and administrator details. No sample employees or activity will be created.</p></div>
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {done || required === false ? <div className="card p-6"><p>Installation is complete. Sign in to enter employees, departments, locations and business records.</p><Link className="btn-primary mt-4" to="/login" reloadDocument>Go to sign in</Link></div> : required === null ? <p>Checking installation status…</p> :
      <form onSubmit={submit} className="space-y-5"><fieldset disabled={busy} className="space-y-5">
        <section className="card space-y-4 p-5"><h2 className="font-semibold">Installation access</h2>
          <p className="text-sm text-ink-600">Your server creates a one-time installation code in its private configuration directory. Ask the server operator for that code. It prevents someone else from claiming your installation.</p>
          {input('setupCode', 'One-time installation code', 'password')}{input('company', 'Company name')}
        </section>
        <section className="card space-y-4 p-5"><h2 className="font-semibold">MySQL database</h2><p className="text-sm text-ink-600">Create an empty database with your hosting provider first. Setup validates access and installs the schema. Existing employee data will never be deleted.</p>
          <div className="grid gap-4 sm:grid-cols-2">{input('dbHost', 'Database hostname')}{input('dbPort', 'Database port', 'number', '3306')}{input('dbName', 'Database name')}{input('dbUser', 'Database username')}{input('dbPassword', 'Database password', 'password')}</div>
        </section>
        <section className="card space-y-4 p-5"><h2 className="font-semibold">Email delivery</h2><p className="text-sm text-ink-600">Setup verifies encrypted SMTP connectivity and sends a test email to the administrator. Secrets are encrypted on the server.</p>
          <div className="grid gap-4 sm:grid-cols-2">{input('smtpHost', 'SMTP hostname')}{input('smtpPort', 'SMTP port', 'number', '587')}{input('smtpUser', 'SMTP username')}{input('smtpPassword', 'SMTP password', 'password')}{input('fromName', 'Sender name')}{input('fromEmail', 'Sender email', 'email')}{input('replyTo', 'Reply-to email', 'email')}</div>
          <label className="flex items-center gap-2 text-sm"><input name="smtpSecure" type="checkbox" />Implicit TLS (usually port 465); otherwise STARTTLS is required</label>
        </section>
        <section className="card space-y-4 p-5"><h2 className="font-semibold">First administrator</h2><div className="grid gap-4 sm:grid-cols-2">
          {input('adminName', 'Full name')}{input('adminEmail', 'Email', 'email')}{input('adminMobile', 'Mobile number', 'tel')}{input('department', 'Department name')}{input('location', 'Location name')}{input('adminPassword', 'Password', 'password')}{input('confirmPassword', 'Confirm password', 'password')}
        </div><p className="text-xs text-ink-500">Use 10–72 characters with uppercase, lowercase, a number and a symbol.</p></section>
        <button className="btn-primary" type="submit">{busy ? 'Verifying services and installing…' : 'Verify and install'}</button>
      </fieldset></form>}
  </div></main>;
}
