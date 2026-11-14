import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Field } from '../components/ui';

interface Options {
  departments: { id: number; name: string }[];
  designations: { id: number; title: string; department_id: number | null }[];
  locations: { id: number; name: string; city: string | null }[];
  managers: { id: number; full_name: string; designation_title: string | null; department_name: string | null }[];
}

export default function Register() {
  useDocumentTitle('Create account');
  const toast = useToast();
  const [options, setOptions] = useState<Options | null>(null);
  const [step, setStep] = useState<'form' | 'verify' | 'done'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registration, setRegistration] = useState<{ employeeId: number; employeeCode: string; devEmailCode?: string; devMobileCode?: string } | null>(null);
  const [codes, setCodes] = useState({ email: '', mobile: '' });
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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post<{
        employeeId: number;
        employeeCode: string;
        devEmailCode?: string;
        devMobileCode?: string;
      }>('/auth/register', {
        fullName: form.fullName,
        email: form.email,
        mobile: form.mobile,
        departmentId: Number(form.departmentId),
        designationId: form.designationId ? Number(form.designationId) : null,
        managerId: form.managerId ? Number(form.managerId) : null,
        locationId: form.locationId ? Number(form.locationId) : null,
        employmentType: form.employmentType,
        password: form.password,
      });
      setRegistration(result);
      setCodes({ email: result.devEmailCode ?? '', mobile: result.devMobileCode ?? '' });
      setStep('verify');
      toast.info('Verification codes have been sent to your email and mobile.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!registration) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/register/verify', {
        employeeId: registration.employeeId,
        emailCode: codes.email,
        mobileCode: codes.mobile,
      });
      setStep('done');
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
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-700 text-lg font-bold text-white">W</span>
          <div>
            <p className="font-semibold text-ink-900">Workforce</p>
            <p className="text-xs text-ink-500">Employee registration</p>
          </div>
        </div>

        <div className="card p-6 sm:p-8">
          {step === 'form' && (
            <>
              <h1 className="text-xl font-semibold text-ink-900">Create your employee account</h1>
              <p className="mt-1 text-sm text-ink-500">
                Your registration is verified by email and mobile OTP, then approved by HR before access is granted.
              </p>
              {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
              <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="Full name" required>
                    <input
                      className="input"
                      value={form.fullName}
                      onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                      placeholder="e.g. Ananya Rao"
                      required
                      minLength={2}
                    />
                  </Field>
                </div>
                <Field label="Email address" required>
                  <input
                    className="input"
                    type="email"
                    value={form.email}
                    onChange={(event) => setForm({ ...form, email: event.target.value })}
                    placeholder="you@company.com"
                    required
                  />
                </Field>
                <Field label="Mobile number" required>
                  <input
                    className="input"
                    value={form.mobile}
                    onChange={(event) => setForm({ ...form, mobile: event.target.value })}
                    placeholder="98XXXXXXXX"
                    required
                  />
                </Field>
                <Field label="Department" required>
                  <select
                    className="input"
                    value={form.departmentId}
                    onChange={(event) => setForm({ ...form, departmentId: event.target.value, designationId: '' })}
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
                <Field label="Designation">
                  <select className="input" value={form.designationId} onChange={(event) => setForm({ ...form, designationId: event.target.value })}>
                    <option value="">Select designation</option>
                    {designations.map((designation) => (
                      <option key={designation.id} value={designation.id}>
                        {designation.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reporting manager">
                  <select className="input" value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })}>
                    <option value="">Select manager</option>
                    {options?.managers.map((manager) => (
                      <option key={manager.id} value={manager.id}>
                        {manager.full_name} · {manager.designation_title ?? manager.department_name ?? ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Work location">
                  <select className="input" value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>
                    <option value="">Select location</option>
                    {options?.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Employment type">
                  <select className="input" value={form.employmentType} onChange={(event) => setForm({ ...form, employmentType: event.target.value })}>
                    <option value="full_time">Full time</option>
                    <option value="part_time">Part time</option>
                    <option value="contract">Contract</option>
                    <option value="intern">Intern</option>
                    <option value="probation">Probation</option>
                  </select>
                </Field>
                <div className="hidden sm:block" />
                <Field label="Password" hint="At least 10 characters with upper, lower, number and symbol." required>
                  <input
                    className="input"
                    type="password"
                    value={form.password}
                    onChange={(event) => setForm({ ...form, password: event.target.value })}
                    minLength={10}
                    required
                  />
                </Field>
                <Field label="Confirm password" required>
                  <input
                    className="input"
                    type="password"
                    value={form.confirmPassword}
                    onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })}
                    minLength={10}
                    required
                  />
                </Field>
                <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-ink-500">
                    Already registered?{' '}
                    <Link to="/login" className="font-medium text-brand-700 hover:underline">
                      Sign in
                    </Link>
                  </p>
                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? 'Creating account…' : 'Create account'}
                  </button>
                </div>
              </form>
            </>
          )}

          {step === 'verify' && registration && (
            <>
              <h1 className="text-xl font-semibold text-ink-900">Verify your email and mobile</h1>
              <p className="mt-1 text-sm text-ink-500">
                Registration <strong>{registration.employeeCode}</strong> was created. Enter both codes to continue.
              </p>
              {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
              {(registration.devEmailCode || registration.devMobileCode) && (
                <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Development mode: email/SMS delivery is not configured on this server, so the generated codes are shown here.
                </div>
              )}
              <form onSubmit={verify} className="mt-5 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Email OTP" required>
                    <input
                      className="input tracking-[0.3em]"
                      value={codes.email}
                      onChange={(event) => setCodes({ ...codes, email: event.target.value.replace(/\D/g, '').slice(0, 6) })}
                      placeholder="000000"
                      inputMode="numeric"
                      required
                    />
                  </Field>
                  <Field label="Mobile OTP" required>
                    <input
                      className="input tracking-[0.3em]"
                      value={codes.mobile}
                      onChange={(event) => setCodes({ ...codes, mobile: event.target.value.replace(/\D/g, '').slice(0, 6) })}
                      placeholder="000000"
                      inputMode="numeric"
                      required
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={async () => {
                      try {
                        const result = await api.post<{ devCode?: string }>('/auth/register/resend', {
                          employeeId: registration.employeeId,
                          channel: 'email',
                        });
                        if (result.devCode) setCodes({ ...codes, email: result.devCode });
                        toast.success('A new email code has been sent.');
                      } catch (caught) {
                        toast.error(errorMessage(caught));
                      }
                    }}
                  >
                    Resend email code
                  </button>
                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? 'Verifying…' : 'Verify and submit for approval'}
                  </button>
                </div>
              </form>
            </>
          )}

          {step === 'done' && (
            <div className="py-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">✓</div>
              <h1 className="text-xl font-semibold text-ink-900">Verification complete</h1>
              <p className="mx-auto mt-2 max-w-md text-sm text-ink-500">
                Your account is now awaiting HR approval. You will receive a notification as soon as it is activated, and can then sign in.
              </p>
              <Link to="/login" className="btn-primary mt-5">
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
