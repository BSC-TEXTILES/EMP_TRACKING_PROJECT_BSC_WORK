import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import type { CurrentUser } from '../lib/types';
import { Icon } from '../components/icons';

type OtpMethod = 'email' | 'totp' | 'recovery';
const OTP_HELP: Record<OtpMethod, { label: string; hint: string }> = {
  email: { label: 'Email code', hint: 'Enter the 6-digit code we sent to your registered email address.' },
  totp: { label: 'Authenticator app', hint: 'Enter the 6-digit code shown in your authenticator app.' },
  recovery: { label: 'Recovery code', hint: 'Enter one of your saved recovery codes.' },
};

export default function Login() {
  useDocumentTitle('Sign in');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [otp, setOtp] = useState<{ challenge: string; channels: OtpMethod[]; method: OtpMethod } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [error, setError] = useState<string | null>(
    sessionStorage.getItem('wfm_session_expired') ? 'Your session has expired. Please sign in again.' : null
  );

  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ user?: CurrentUser; requiresOtp?: boolean; challenge?: string; channels?: OtpMethod[]; preferred?: OtpMethod; devCode?: string }>('/auth/login', {
        identifier: identifier.trim(),
        password,
        remember,
      });
      if (result.requiresOtp && result.challenge) {
        if (result.devCode) {
          // Development/test servers only: the backend never returns the code in production.
          await finishOtp(result.challenge, result.devCode, 'email');
          return;
        }
        const channels = result.channels?.length ? result.channels : (['email'] as OtpMethod[]);
        const method = result.preferred && channels.includes(result.preferred) ? result.preferred : channels[0];
        setOtp({ challenge: result.challenge, channels, method });
        setOtpCode('');
        if (method === 'email') toast.info('A verification code was sent to your registered email.');
        return;
      }
      if (result.user) {
        login(result.user);
        toast.success(`Welcome back, ${result.user.fullName.split(' ')[0]}.`);
        navigate(redirectTo, { replace: true });
      }
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const finishOtp = async (challenge: string, code: string, method: OtpMethod) => {
    const verifyResult = await api.post<{ user: CurrentUser }>('/auth/login/otp/verify', { challenge, code: code.trim(), remember, method });
    login(verifyResult.user);
    toast.success(`Welcome back, ${verifyResult.user.fullName.split(' ')[0]}.`);
    navigate(redirectTo, { replace: true });
  };

  const submitOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!otp) return;
    setSubmitting(true);
    setError(null);
    try {
      await finishOtp(otp.challenge, otpCode, otp.method);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const resendOtp = async () => {
    if (!otp) return;
    setError(null);
    try {
      await api.post('/auth/login/otp/send', { challenge: otp.challenge });
      toast.info('A new code was sent to your registered email.');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const chooseMethod = async (method: OtpMethod) => {
    if (!otp) return;
    setOtp({ ...otp, method });
    setOtpCode('');
    if (method === 'email') await resendOtp();
  };

  // Clear session expired flag on mount
  useEffect(() => {
    sessionStorage.removeItem('wfm_session_expired');
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-100 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/icons/icon.svg" alt="BSC Textiles" className="inline-block w-16 h-16 rounded-2xl shadow-lg mb-3 object-cover" />
          <h1 className="text-2xl font-bold text-ink-900 tracking-tight">BSC Textiles</h1>
          <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wider mt-0.5">Enterprise Workforce & Communication</p>
        </div>

        <div className="card p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-ink-900 text-center">Sign in</h2>
          <p className="mt-1 text-sm text-ink-500 text-center">Use your employee ID, email or mobile number.</p>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </div>
          )}

          {otp ? (
            <form onSubmit={submitOtp} className="mt-6 space-y-4">
              {otp.channels.length > 1 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Verification method">
                  {otp.channels.map((m) => (
                    <button key={m} type="button" onClick={() => void chooseMethod(m)}
                      className={m === otp.method ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}>
                      {OTP_HELP[m].label}
                    </button>
                  ))}
                </div>
              )}
              <div>
                <label className="label" htmlFor="otp-code">Verification code</label>
                <input
                  id="otp-code"
                  className="input font-mono tracking-widest"
                  inputMode={otp.method === 'recovery' ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  value={otpCode}
                  onChange={(event) => setOtpCode(event.target.value)}
                  placeholder={otp.method === 'recovery' ? 'xxxx-xxxx' : '123456'}
                  autoFocus
                  required
                />
                <p className="mt-1 text-xs text-ink-500">{OTP_HELP[otp.method].hint}</p>
              </div>
              <button type="submit" className="btn-primary w-full py-2.5" disabled={submitting || otpCode.trim().length < 4}>
                {submitting ? 'Verifying…' : 'Verify and sign in'}
              </button>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <button type="button" className="font-medium text-ink-600 hover:underline" onClick={() => { setOtp(null); setError(null); }}>
                  Back
                </button>
                {otp.method === 'email' && (
                  <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => void resendOtp()}>
                    Send a new code
                  </button>
                )}
              </div>
              <p className="text-xs text-ink-500">No code? Ask HR or your administrator for help signing in.</p>
            </form>
          ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="identifier">
                Employee Number *, email or mobile
              </label>
              <input
                id="identifier"
                className="input"
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="EMP-DVG-1604 or you@bsctextiles.in"
                required
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="label" htmlFor="password">Password</label>
                <Link to="/forgot-password" className="text-xs font-medium text-brand-700 hover:underline">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  id="password"
                  className="input pr-10"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 hover:text-ink-700 hover:bg-ink-100 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-ink-600">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-4 w-4 rounded border-ink-300"
              />
              Remember this device
            </label>

            <button type="submit" className="btn-primary w-full py-2.5" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in securely'}
            </button>
          </form>
          )}

          <p className="mt-6 text-center text-sm text-ink-500">
            New employee?{' '}
            <Link to="/register" className="font-medium text-brand-700 hover:underline">
              Create your account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}