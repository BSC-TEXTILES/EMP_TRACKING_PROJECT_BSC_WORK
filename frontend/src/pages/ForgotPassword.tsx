import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Field } from '../components/ui';
import { Icon } from '../components/icons';
import { cx } from '../lib/format';

export default function ForgotPassword() {
  useDocumentTitle('Reset password');
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasMinLength = password.length >= 10;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const isPasswordValid = hasMinLength && hasUpper && hasLower && hasNumber && hasSymbol;

  const request = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ message: string; devCode?: string; delivered: boolean }>('/auth/password/forgot', { identifier });
      setDevCode(result.devCode ?? null);
      setStep('reset');
      toast.info(result.message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isPasswordValid) {
      setError('Password must be at least 10 characters with upper, lower, number and symbol.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/password/reset', { identifier, code, password });
      toast.success('Password updated. Please sign in.');
      navigate('/login', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-100 px-4 py-8">
      <div className="w-full max-w-md">
        <div className="card p-6 sm:p-7 shadow-md">
          <div className="mb-5 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-700 font-bold text-white shadow-sm">W</span>
            <p className="font-semibold text-ink-900">Workforce</p>
          </div>
          <h1 className="text-xl font-semibold text-ink-900">{step === 'request' ? 'Reset your password' : 'Choose a new password'}</h1>
          <p className="mt-1 text-sm text-ink-500">
            {step === 'request'
              ? 'We will send a verification code to your registered email address or mobile number.'
              : 'Enter the code we sent, then set a strong new password. All other devices will be signed out.'}
          </p>
          {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {devCode && (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Development mode · delivery is not configured, so this code is shown here: <strong className="tracking-widest">{devCode}</strong>
            </p>
          )}

          {step === 'request' ? (
            <form onSubmit={request} className="mt-5 space-y-4">
              <Field label="Email, mobile or employee ID" required>
                <input
                  className="input"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder="you@company.com"
                  required
                />
              </Field>
              <button type="submit" className="btn-primary w-full" disabled={submitting}>
                {submitting ? 'Sending code…' : 'Send verification code'}
              </button>
            </form>
          ) : (
            <form onSubmit={reset} className="mt-5 space-y-4">
              <Field label="Verification code" required>
                <input
                  className="input tracking-[0.4em]"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  required
                />
              </Field>
              <Field label="New password" hint="Minimum 10 characters with upper, lower, number and symbol." required>
                <div className="relative">
                  <input
                    className={cx('input pr-10', password && isPasswordValid && 'border-emerald-400')}
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={10}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1 rounded"
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                  </button>
                </div>
              </Field>

              {password && (
                <div className="rounded-lg border border-ink-200 bg-surface-alt/50 p-2.5 text-xs space-y-1">
                  <p className="font-semibold text-ink-700 text-[11px] uppercase tracking-wider">Password Requirements:</p>
                  <ul className="space-y-0.5">
                    <li className={cx('flex items-center gap-1.5', hasMinLength ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                      <span>{hasMinLength ? '✓' : '•'}</span> 10+ characters
                    </li>
                    <li className={cx('flex items-center gap-1.5', hasUpper ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                      <span>{hasUpper ? '✓' : '•'}</span> Uppercase letter (A-Z)
                    </li>
                    <li className={cx('flex items-center gap-1.5', hasLower ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                      <span>{hasLower ? '✓' : '•'}</span> Lowercase letter (a-z)
                    </li>
                    <li className={cx('flex items-center gap-1.5', hasNumber ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                      <span>{hasNumber ? '✓' : '•'}</span> Number (0-9)
                    </li>
                    <li className={cx('flex items-center gap-1.5', hasSymbol ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                      <span>{hasSymbol ? '✓' : '•'}</span> Symbol (!@#$%^&*)
                    </li>
                  </ul>
                </div>
              )}

              <Field label="Confirm new password" required>
                <div className="relative">
                  <input
                    className={cx('input pr-10', confirm && confirm === password && 'border-emerald-400')}
                    type={showConfirm ? 'text' : 'password'}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    minLength={10}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1 rounded"
                    title={showConfirm ? 'Hide password' : 'Show password'}
                  >
                    <Icon name={showConfirm ? 'eyeOff' : 'eye'} size={18} />
                  </button>
                </div>
              </Field>

              {confirm && (
                <div>
                  {confirm === password ? (
                    <p className="text-xs font-medium text-emerald-600 flex items-center gap-1">✓ Passwords match</p>
                  ) : (
                    <p className="text-xs font-medium text-red-600 flex items-center gap-1">✕ Passwords do not match</p>
                  )}
                </div>
              )}

              <button type="submit" className="btn-primary w-full" disabled={submitting}>
                {submitting ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}

          <p className="mt-5 text-center text-sm text-ink-500">
            <Link to="/login" className="font-medium text-brand-700 hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
