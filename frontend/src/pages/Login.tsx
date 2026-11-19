import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import type { CurrentUser } from '../lib/types';
import { Icon } from '../components/icons';

interface TestAccount {
  role: string;
  employeeId: string;
  name: string;
  email: string;
  password: string;
}

const DEFAULT_TEST_ACCOUNTS: TestAccount[] = [
  {
    role: 'Super Admin',
    employeeId: 'EMP-1001',
    name: 'Renukaradhya',
    email: 'renukaradhya@bsctextiles.in',
    password: 'Workforce@2026',
  },
  {
    role: 'HR Manager',
    employeeId: 'EMP-1002',
    name: 'Chetan TK',
    email: 'chetan.tk@bsctextiles.in',
    password: 'Workforce@2026',
  },
];

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
  const [error, setError] = useState<string | null>(sessionStorage.getItem('wfm_session_expired') ? 'Your session has expired. Please sign in again.' : null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [testAccounts, setTestAccounts] = useState<TestAccount[]>(DEFAULT_TEST_ACCOUNTS);
  const [testEnvironment, setTestEnvironment] = useState<string | null>('production');
  const [selectedTest, setSelectedTest] = useState<TestAccount | null>(DEFAULT_TEST_ACCOUNTS[0]);

  // Load latest accounts dynamically if server provides them
  useEffect(() => {
    api
      .get<{ enabled: boolean; environment: string; accounts: TestAccount[] }>('/auth/test-accounts')
      .then((result) => {
        if (result.accounts && result.accounts.length > 0) {
          setTestAccounts(result.accounts);
          setSelectedTest(result.accounts[0] ?? DEFAULT_TEST_ACCOUNTS[0]);
        }
        if (result.environment) {
          setTestEnvironment(result.environment);
        }
      })
      .catch(() => {
        setTestAccounts(DEFAULT_TEST_ACCOUNTS);
        setSelectedTest(DEFAULT_TEST_ACCOUNTS[0]);
      });
  }, []);

  const fillTest = (account: TestAccount) => {
    setSelectedTest(account);
    setIdentifier(account.email);
    setPassword(account.password);
    setError(null);
    setChallenge(null);
  };

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
        setChallenge(result.challenge);
        const code = result.devCode ?? null;
        setDevCode(code);
        if (code) {
          setOtp(code);
          toast.info(`Verification code (OTP): ${code}`);
        } else {
          toast.info('A verification code was sent to your registered email.');
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

  const verifyOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ user: CurrentUser }>('/auth/login/otp/verify', { challenge, code: otp, remember });
      login(result.user);
      navigate(redirectTo, { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between bg-gradient-to-br from-brand-800 via-brand-700 to-brand-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-lg font-bold">W</span>
          <div>
            <p className="font-semibold">Workforce</p>
            <p className="text-xs text-brand-100">Enterprise Workforce Management</p>
          </div>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">
            One platform for attendance, delivery and performance.
          </h1>
          <p className="mt-3 text-sm text-brand-100">
            Server-timestamped attendance, hierarchy-aware task allocation, daily reporting, real-time messaging,
            SLA-tracked tickets and transparent monthly KPIs — all connected through one relational database.
          </p>
          <ul className="mt-8 space-y-3 text-sm">
            {[
              'Live working-hour timer that survives refreshes and reconnects',
              'Managers allocate work only inside their reporting structure',
              'Real-time internal chat with read receipts and presence',
              'Automatic KPI computation with configurable weights',
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/15">
                  <Icon name="check" size={12} />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-brand-200">Secure sessions · Role-based access · Complete audit trail</p>
      </div>

      <div className="flex items-center justify-center bg-ink-100 p-5 sm:p-10">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-700 text-lg font-bold text-white">W</span>
            <div>
              <p className="font-semibold text-ink-900">Workforce</p>
              <p className="text-xs text-ink-500">Enterprise Workforce Management</p>
            </div>
          </div>

          <div className="card p-6 sm:p-7">
            <h2 className="text-xl font-semibold text-ink-900">{challenge ? 'Verify your identity' : 'Sign in'}</h2>
            <p className="mt-1 text-sm text-ink-500">
              {challenge
                ? 'Enter the 6-digit code sent to your registered email address.'
                : 'Use your employee ID, email or mobile number.'}
            </p>

            {error && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {error}
              </div>
            )}

            {!challenge ? (
              <form onSubmit={submit} className="mt-5 space-y-4">
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
                    placeholder="EMP-1001 or you@company.com"
                    required
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="label" htmlFor="password">
                      Password
                    </label>
                    <Link to="/forgot-password" className="mb-1.5 text-xs font-medium text-brand-700 hover:underline">
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
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 hover:text-ink-700 hover:bg-ink-100 transition-colors focus:outline-none"
                      title={showPassword ? 'Hide password' : 'Show password'}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                    </button>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-ink-600">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-4 w-4 rounded border-ink-300" />
                  Remember this device
                </label>
                <button type="submit" className="btn-primary w-full" disabled={submitting}>
                  {submitting ? 'Signing in…' : 'Sign in securely'}
                </button>
              </form>
            ) : (
              <form onSubmit={verifyOtp} className="mt-5 space-y-4">
                <div>
                  <label className="label" htmlFor="otp">
                    Verification code
                  </label>
                  <input
                    id="otp"
                    className="input text-center text-lg tracking-[0.5em]"
                    value={otp}
                    onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    inputMode="numeric"
                    required
                  />
                  {devCode && (
                    <div className="mt-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-amber-800">Verification OTP:</span>
                        <button
                          type="button"
                          onClick={() => setOtp(devCode)}
                          className="rounded bg-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-900 hover:bg-amber-300 transition-colors"
                        >
                          Auto-fill
                        </button>
                      </div>
                      <p className="font-mono text-base font-bold tracking-widest text-amber-950">{devCode}</p>
                      <p className="text-[11px] text-amber-700">Code generated for instant employee verification.</p>
                    </div>
                  )}
                </div>
                <button type="submit" className="btn-primary w-full" disabled={submitting || otp.length < 4}>
                  {submitting ? 'Verifying…' : 'Verify and continue'}
                </button>
                <button
                  type="button"
                  className="btn-ghost w-full"
                  onClick={async () => {
                    try {
                      const sent = await api.post<{ delivered: boolean; devCode?: string }>('/auth/login/otp/send', { challenge });
                      setDevCode(sent.devCode ?? null);
                      toast.success('A new code has been sent.');
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    }
                  }}
                >
                  Resend code
                </button>
                <button type="button" className="btn-ghost w-full" onClick={() => setChallenge(null)}>
                  Use password instead
                </button>
              </form>
            )}

            <p className="mt-5 text-center text-sm text-ink-500">
              New employee?{' '}
              <Link to="/register" className="font-medium text-brand-700 hover:underline">
                Create your account
              </Link>
            </p>
          </div>

          {testAccounts.length > 0 && (
            <section className="mt-4 rounded-xl border border-brand-200 bg-white p-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-ink-900">Admin & Role Access Credentials</p>
                  <p className="text-xs text-ink-500">Select any role below to view Login ID and Password, and auto-fill to sign in.</p>
                </div>
                <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700 border border-brand-200">
                  Quick Role Access
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {testAccounts.map((account) => {
                  const isSelected = selectedTest?.email === account.email;
                  return (
                    <button
                      key={account.email}
                      type="button"
                      onClick={() => fillTest(account)}
                      className={
                        isSelected
                          ? 'rounded-lg border-2 border-brand-600 bg-brand-50 px-3 py-1.5 text-xs font-bold text-brand-900 shadow-xs transition-colors'
                          : 'rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-400 hover:bg-brand-50/50 transition-colors'
                      }
                    >
                      {account.role}
                    </button>
                  );
                })}
              </div>

              {selectedTest && (
                <div className="mt-3.5 rounded-lg border border-ink-200 bg-ink-50/60 p-3">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-ink-200 text-xs">
                    <span className="font-semibold text-ink-800">{selectedTest.role} Profile</span>
                    <span className="text-ink-500">{selectedTest.name}</span>
                  </div>

                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-ink-700">Login ID / Email</span>
                        <button
                          type="button"
                          className="text-[11px] text-brand-700 hover:underline"
                          onClick={() => {
                            navigator.clipboard.writeText(selectedTest.email);
                            toast.success('Login ID copied to clipboard');
                          }}
                        >
                          Copy
                        </button>
                      </div>
                      <input className="input font-mono text-xs bg-white" readOnly value={selectedTest.email} />
                      <p className="mt-1 text-[11px] text-ink-400 font-mono">Employee Code: {selectedTest.employeeId}</p>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-ink-700">Password</span>
                        <button
                          type="button"
                          className="text-[11px] text-brand-700 hover:underline"
                          onClick={() => {
                            navigator.clipboard.writeText(selectedTest.password);
                            toast.success('Password copied to clipboard');
                          }}
                        >
                          Copy
                        </button>
                      </div>
                      <input className="input font-mono text-xs bg-white font-semibold text-brand-900" readOnly value={selectedTest.password} />
                      <p className="mt-1 text-[11px] text-emerald-700">Ready to authenticate</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-primary btn-sm mt-3 w-full justify-center text-xs font-semibold py-2"
                    onClick={() => {
                      fillTest(selectedTest);
                      toast.success(`${selectedTest.role} credentials auto-filled. Click Sign In.`);
                    }}
                  >
                    <Icon name="check" size={14} />
                    <span>Auto-Fill {selectedTest.role} Credentials</span>
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
