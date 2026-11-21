import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import type { CurrentUser } from '../lib/types';
import { Icon } from '../components/icons';

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
  const [error, setError] = useState<string | null>(
    sessionStorage.getItem('wfm_session_expired') ? 'Your session has expired. Please sign in again.' : null
  );

  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ user?: CurrentUser; requiresOtp?: boolean; challenge?: string; devCode?: string }>('/auth/login', {
        identifier: identifier.trim(),
        password,
        remember,
      });
      if (result.requiresOtp && result.challenge) {
        // For simplicity, auto-fill OTP if devCode is provided
        if (result.devCode) {
          const verifyResult = await api.post<{ user: CurrentUser }>('/auth/login/otp/verify', {
            challenge: result.challenge,
            code: result.devCode,
            remember,
          });
          login(verifyResult.user);
          toast.success(`Welcome back, ${verifyResult.user.fullName.split(' ')[0]}.`);
          navigate(redirectTo, { replace: true });
        } else {
          toast.info('A verification code was sent to your registered email.');
          setError('OTP required - check your email for the verification code');
        }
        setSubmitting(false);
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

  // Clear session expired flag on mount
  useEffect(() => {
    sessionStorage.removeItem('wfm_session_expired');
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-100 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-700 mb-4">
            <Icon name="briefcase" size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-ink-900">Workforce</h1>
          <p className="mt-1 text-sm text-ink-500">Enterprise Workforce Management</p>
        </div>

        <div className="card p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-ink-900 text-center">Sign in</h2>
          <p className="mt-1 text-sm text-ink-500 text-center">Use your employee ID, email or mobile number.</p>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="identifier">
                Employee ID, email or mobile
              </label>
              <input
                id="identifier"
                className="input"
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="EMP-2201 or you@company.com"
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