import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Field } from '../components/ui';
import { Icon } from '../components/icons';
import { cx } from '../lib/format';

interface Options {
  departments: { id: number; name: string }[];
  designations: { id: number; title: string; department_id: number | null }[];
  locations: { id: number; name: string; city: string | null }[];
  managers: { id: number; full_name: string; location_name: string | null }[];
}

export default function Register() {
  useDocumentTitle('Create account');
  const toast = useToast();
  const [options, setOptions] = useState<Options | null>(null);
  const [step, setStep] = useState<'form' | 'done'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registration, setRegistration] = useState<{ employeeId: number; employeeCode: string } | null>(null);

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    mobile: '',
    departmentId: '',
    designationId: '',
    managerId: '',
    locationId: '',
    employmentType: 'full_time',
    password: '',
    confirmPassword: '',
  });

  useEffect(() => {
    api
      .get<Options>('/auth/registration-options')
      .then(setOptions)
      .catch(() => setOptions({ departments: [], designations: [], locations: [], managers: [] }));
  }, []);

  const designations = useMemo(() => {
    if (!options) return [];
    return options.designations.filter((d) => !form.departmentId || d.department_id === Number(form.departmentId) || d.department_id === null);
  }, [options, form.departmentId]);

  const visibleManagers = useMemo(() => {
    const list = (options?.managers || []).filter((m) => !m.full_name.toLowerCase().includes('gagan'));
    if (list.length > 0) return list;
    return [{ id: 1, full_name: 'Renukaradhya', location_name: 'Head Office' }];
  }, [options?.managers]);

  // Validation criteria
  const isNameValid = form.fullName.trim().length >= 2;
  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  // Strictly 10 numbers only, starting with valid telecom prefix (6, 7, 8, or 9)
  const isMobileValid = /^[6-9]\d{9}$/.test(form.mobile) && form.mobile.length === 10;

  const isDeptValid = Boolean(form.departmentId);

  // Password criteria (matches backend passwordIssues requirement)
  const hasMinLength = form.password.length >= 10;
  const hasUpper = /[A-Z]/.test(form.password);
  const hasLower = /[a-z]/.test(form.password);
  const hasNumber = /[0-9]/.test(form.password);
  const hasSymbol = /[^A-Za-z0-9]/.test(form.password);
  const isPasswordValid = hasMinLength && hasUpper && hasLower && hasNumber && hasSymbol;

  const passwordStrengthScore = [hasMinLength, hasUpper, hasLower, hasNumber, hasSymbol].filter(Boolean).length;
  const strengthDetails = useMemo(() => {
    if (!form.password) return { label: '', color: 'bg-ink-200', width: '0%' };
    if (passwordStrengthScore <= 2) return { label: 'Weak', color: 'bg-red-500', width: '30%' };
    if (passwordStrengthScore === 3) return { label: 'Fair', color: 'bg-amber-500', width: '60%' };
    if (passwordStrengthScore === 4) return { label: 'Good', color: 'bg-sky-500', width: '80%' };
    return { label: 'Strong', color: 'bg-emerald-600', width: '100%' };
  }, [form.password, passwordStrengthScore]);

  // Confirm password criteria
  const isConfirmMatch = form.confirmPassword.length > 0 && form.confirmPassword === form.password;
  const isConfirmMismatch = form.confirmPassword.length > 0 && form.confirmPassword !== form.password;

  const handleBlur = (field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    // Mark all fields as touched for comprehensive error display
    const allTouched = {
      fullName: true,
      email: true,
      mobile: true,
      departmentId: true,
      password: true,
      confirmPassword: true,
    };
    setTouched(allTouched);

    if (!isNameValid) {
      setError('Please enter your full name (minimum 2 characters).');
      return;
    }
    if (!isEmailValid) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!isMobileValid || form.mobile.length !== 10) {
      if (form.mobile.length === 0) {
        setError('Mobile number is required.');
      } else if (form.mobile.length !== 10) {
        setError(`Mobile number must be exactly 10 digits (${form.mobile.length}/10).`);
      } else {
        setError('Mobile number must start with 6, 7, 8, or 9.');
      }
      return;
    }
    if (!isDeptValid) {
      setError('Please select a department.');
      return;
    }
    if (!isPasswordValid) {
      const missing: string[] = [];
      if (!hasMinLength) missing.push('at least 10 characters');
      if (!hasUpper) missing.push('an uppercase letter');
      if (!hasLower) missing.push('a lowercase letter');
      if (!hasNumber) missing.push('a number');
      if (!hasSymbol) missing.push('a symbol');
      setError(`Password must contain ${missing.join(', ')}.`);
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.post<{
        employeeId: number;
        employeeCode: string;
      }>('/auth/register', {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        mobile: form.mobile.trim(),
        departmentId: Number(form.departmentId),
        designationId: form.designationId ? Number(form.designationId) : null,
        managerId: form.managerId ? Number(form.managerId) : null,
        locationId: form.locationId ? Number(form.locationId) : null,
        employmentType: form.employmentType,
        password: form.password,
      });
      setRegistration(result);
      setStep('done');
      toast.success('Registration submitted! Awaiting administrator approval.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-100 px-4 py-8">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-700 text-lg font-bold text-white shadow-sm">
            W
          </span>
          <div>
            <p className="font-semibold text-ink-900 leading-tight">Workforce</p>
            <p className="text-xs text-ink-500">Employee registration</p>
          </div>
        </div>

        <div className="card p-6 sm:p-8 shadow-md">
          {step === 'form' && (
            <>
              <h1 className="text-xl font-semibold text-ink-900">Create your employee account</h1>
              <p className="mt-1 text-sm text-ink-500">
                Enter your details to register. Once submitted, an administrator will review and activate your account.
              </p>

              {error && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-start gap-2">
                  <span className="text-red-500 font-bold shrink-0 mt-0.5">!</span>
                  <div>{error}</div>
                </div>
              )}

              <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-2" noValidate>
                {/* Full Name */}
                <div className="sm:col-span-2">
                  <Field
                    label="Full name"
                    required
                    error={touched.fullName && !isNameValid ? 'Please enter your full name (at least 2 characters).' : undefined}
                  >
                    <input
                      className={cx('input', touched.fullName && !isNameValid && 'border-red-400 focus:border-red-500 focus:ring-red-100')}
                      value={form.fullName}
                      autoComplete="name"
                      onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                      onBlur={() => handleBlur('fullName')}
                      placeholder="e.g. Ananya Rao"
                      required
                    />
                  </Field>
                </div>

                {/* Email Address */}
                <Field
                  label="Email address"
                  required
                  error={touched.email && !isEmailValid ? 'Please enter a valid email address.' : undefined}
                >
                  <input
                    className={cx('input', touched.email && !isEmailValid && 'border-red-400 focus:border-red-500 focus:ring-red-100')}
                    type="email"
                    autoComplete="username"
                    value={form.email}
                    onChange={(event) => setForm({ ...form, email: event.target.value })}
                    onBlur={() => handleBlur('email')}
                    placeholder="you@company.com"
                    required
                  />
                </Field>

                {/* Mobile Number */}
                <Field
                  label="Mobile number"
                  required
                  error={
                    touched.mobile && !isMobileValid
                      ? form.mobile.length === 0
                        ? 'Mobile number is required.'
                        : form.mobile.length !== 10
                        ? `Mobile number must be exactly 10 digits (${form.mobile.length}/10).`
                        : 'Mobile number must start with 6, 7, 8, or 9.'
                      : undefined
                  }
                  hint="10 numbers only"
                >
                  <div className="relative">
                    <input
                      className={cx(
                        'input pr-16',
                        touched.mobile && !isMobileValid && 'border-red-400 focus:border-red-500 focus:ring-red-100',
                        form.mobile.length === 10 && isMobileValid && 'border-emerald-400 focus:border-emerald-500 focus:ring-emerald-100',
                      )}
                      type="tel"
                      autoComplete="tel"
                      inputMode="numeric"
                      maxLength={10}
                      pattern="[0-9]{10}"
                      value={form.mobile}
                      onChange={(event) => {
                        // Strictly numbers only, max 10 digits
                        const digitsOnly = event.target.value.replace(/\D/g, '').slice(0, 10);
                        setForm({ ...form, mobile: digitsOnly });
                      }}
                      onBlur={() => handleBlur('mobile')}
                      placeholder="98XXXXXXXX"
                      required
                    />
                    <span className={cx(
                      'absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-mono font-medium',
                      form.mobile.length === 10 ? 'text-emerald-600 font-bold' : 'text-ink-400'
                    )}>
                      {form.mobile.length}/10
                    </span>
                  </div>
                </Field>

                {/* Department */}
                <Field
                  label="Department"
                  required
                  error={touched.departmentId && !isDeptValid ? 'Please select a department.' : undefined}
                >
                  <select
                    className={cx('input', touched.departmentId && !isDeptValid && 'border-red-400 focus:border-red-500 focus:ring-red-100')}
                    value={form.departmentId}
                    onChange={(event) => setForm({ ...form, departmentId: event.target.value, designationId: '' })}
                    onBlur={() => handleBlur('departmentId')}
                    required
                  >
                    <option value="">Select department</option>
                    {options?.departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </select>
                </Field>

                {/* Designation */}
                <Field label="Designation">
                  <select
                    className="input"
                    value={form.designationId}
                    onChange={(event) => setForm({ ...form, designationId: event.target.value })}
                  >
                    <option value="">Select designation</option>
                    {designations.map((designation) => (
                      <option key={designation.id} value={designation.id}>
                        {designation.title}
                      </option>
                    ))}
                  </select>
                </Field>

                {/* Reporting Manager */}
                <Field label="Reporting manager">
                  <select
                    className="input"
                    value={form.managerId}
                    onChange={(event) => setForm({ ...form, managerId: event.target.value })}
                  >
                    <option value="">Select manager</option>
                    {visibleManagers.map((manager) => (
                      <option key={manager.id} value={manager.id}>
                        {manager.full_name}
                        {manager.location_name ? ` · ${manager.location_name}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>

                {/* Work Location */}
                <Field label="Work location">
                  <select
                    className="input"
                    value={form.locationId}
                    onChange={(event) => setForm({ ...form, locationId: event.target.value })}
                  >
                    <option value="">Select location</option>
                    {options?.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </Field>

                {/* Password field with Eye Toggle & Validation */}
                <div className="sm:col-span-1">
                  <Field
                    label="Password"
                    required
                    error={
                      touched.password && !isPasswordValid
                        ? 'At least 10 characters with upper, lower, number and symbol.'
                        : undefined
                    }
                  >
                    <div className="relative">
                      <input
                        className={cx(
                          'input pr-10',
                          touched.password && !isPasswordValid && 'border-red-400 focus:border-red-500 focus:ring-red-100',
                          form.password && isPasswordValid && 'border-emerald-400 focus:border-emerald-500 focus:ring-emerald-100',
                        )}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={form.password}
                        onChange={(event) => setForm({ ...form, password: event.target.value })}
                        onBlur={() => handleBlur('password')}
                        placeholder="••••••••••"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 hover:text-ink-700 hover:bg-ink-100 transition-colors focus:outline-none"
                        title={showPassword ? 'Hide password' : 'Show password'}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                      </button>
                    </div>
                  </Field>

                  {/* Password Strength Meter */}
                  {form.password && (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-ink-500">Strength:</span>
                        <span className={cx('font-semibold', passwordStrengthScore >= 4 ? 'text-emerald-600' : passwordStrengthScore === 3 ? 'text-amber-600' : 'text-red-500')}>
                          {strengthDetails.label}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-200">
                        <div
                          className={cx('h-full transition-all duration-300', strengthDetails.color)}
                          style={{ width: strengthDetails.width }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Live Password Criteria Checklist */}
                  <div className="mt-2.5 rounded-lg border border-ink-200 bg-surface-alt/50 p-2.5 text-xs space-y-1.5">
                    <p className="font-semibold text-ink-700 text-[11px] uppercase tracking-wider">Password Requirements:</p>
                    <ul className="space-y-1">
                      <li className={cx('flex items-center gap-1.5', hasMinLength ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                        <span className={cx('flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold', hasMinLength ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-200 text-ink-500')}>
                          {hasMinLength ? '✓' : '•'}
                        </span>
                        At least 10 characters
                      </li>
                      <li className={cx('flex items-center gap-1.5', hasUpper ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                        <span className={cx('flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold', hasUpper ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-200 text-ink-500')}>
                          {hasUpper ? '✓' : '•'}
                        </span>
                        Uppercase letter (A-Z)
                      </li>
                      <li className={cx('flex items-center gap-1.5', hasLower ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                        <span className={cx('flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold', hasLower ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-200 text-ink-500')}>
                          {hasLower ? '✓' : '•'}
                        </span>
                        Lowercase letter (a-z)
                      </li>
                      <li className={cx('flex items-center gap-1.5', hasNumber ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                        <span className={cx('flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold', hasNumber ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-200 text-ink-500')}>
                          {hasNumber ? '✓' : '•'}
                        </span>
                        At least one number (0-9)
                      </li>
                      <li className={cx('flex items-center gap-1.5', hasSymbol ? 'text-emerald-700 font-medium' : 'text-ink-500')}>
                        <span className={cx('flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold', hasSymbol ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-200 text-ink-500')}>
                          {hasSymbol ? '✓' : '•'}
                        </span>
                        At least one symbol (!@#$%^&*)
                      </li>
                    </ul>
                  </div>
                </div>

                {/* Confirm Password field with Eye Toggle & Match Indicator */}
                <div className="sm:col-span-1">
                  <Field
                    label="Confirm password"
                    required
                    error={
                      touched.confirmPassword && isConfirmMismatch
                        ? 'Passwords do not match.'
                        : undefined
                    }
                  >
                    <div className="relative">
                      <input
                        className={cx(
                          'input pr-10',
                          touched.confirmPassword && isConfirmMismatch && 'border-red-400 focus:border-red-500 focus:ring-red-100',
                          isConfirmMatch && 'border-emerald-400 focus:border-emerald-500 focus:ring-emerald-100',
                        )}
                        type={showConfirmPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={form.confirmPassword}
                        onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })}
                        onBlur={() => handleBlur('confirmPassword')}
                        placeholder="••••••••••"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 hover:text-ink-700 hover:bg-ink-100 transition-colors focus:outline-none"
                        title={showConfirmPassword ? 'Hide password' : 'Show password'}
                        aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      >
                        <Icon name={showConfirmPassword ? 'eyeOff' : 'eye'} size={18} />
                      </button>
                    </div>
                  </Field>

                  {/* Live matching feedback */}
                  {form.confirmPassword && (
                    <div className="mt-2.5">
                      {isConfirmMatch ? (
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg p-2">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold">✓</span>
                          Passwords match
                        </p>
                      ) : (
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-100 text-[10px] font-bold">✕</span>
                          Passwords do not match
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Submit & Sign In link */}
                <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 pt-2">
                  <p className="text-xs text-ink-500">
                    Already registered?{' '}
                    <Link to="/login" className="font-semibold text-brand-700 hover:underline">
                      Sign in
                    </Link>
                  </p>
                  <button
                    type="submit"
                    className="btn-primary px-6 py-2.5 shadow-sm text-sm"
                    disabled={submitting}
                  >
                    {submitting ? 'Creating account…' : 'Create account'}
                  </button>
                </div>
              </form>
            </>
          )}

          {step === 'done' && (
            <div className="py-6 text-center space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-2xl font-bold shadow-sm">
                ✓
              </div>
              <h1 className="text-xl font-bold text-ink-900">Registration Submitted</h1>
              <p className="mx-auto max-w-md text-sm text-ink-600">
                Your employee registration <strong className="text-ink-900 font-mono text-base">{registration?.employeeCode}</strong> has been submitted.
              </p>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 text-left max-w-md mx-auto space-y-1">
                <p className="font-semibold text-amber-900">Awaiting Administrator Approval</p>
                <p>
                  An administrator or HR manager will review and approve your registration. Once approved, you can immediately sign in with your email or employee ID and password.
                </p>
              </div>
              <div className="pt-2">
                <Link to="/login" className="btn-primary inline-flex">
                  Back to sign in
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
