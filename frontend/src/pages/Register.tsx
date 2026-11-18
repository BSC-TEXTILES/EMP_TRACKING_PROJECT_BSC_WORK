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
    if (!options?.managers) return [{ id: 1, full_name: 'Gagan C B', location_name: 'Head Office' }];
    return options.managers.length > 0 ? options.managers : [{ id: 1, full_name: 'Gagan C B', location_name: 'Head Office' }];
  }, [options?.managers]);

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
                Enter your details to register. Once submitted, an administrator will review and activate your account.
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
                    {visibleManagers.map((manager) => (
                      <option key={manager.id} value={manager.id}>
                        {manager.full_name}{manager.location_name ? ` · ${manager.location_name}` : ''}
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
                <Field label="Password" hint="At least 10 characters with upper, lower, number and symbol." required>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
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
                    autoComplete="new-password"
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

          {step === 'done' && (
            <div className="py-6 text-center space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-2xl font-bold">
                ✓
              </div>
              <h1 className="text-xl font-bold text-ink-900">Registration Submitted</h1>
              <p className="mx-auto max-w-md text-sm text-ink-600">
                Your employee registration <strong className="text-ink-900 font-mono text-base">{registration?.employeeCode}</strong> has been submitted.
              </p>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 text-left max-w-md mx-auto space-y-1">
                <p className="font-semibold text-amber-900">Awaiting Administrator Approval</p>
                <p>An administrator or HR manager will review and approve your registration. Once approved, you can immediately sign in with your email or employee ID and password.</p>
              </div>
              <div className="pt-2">
                <Link to="/login" className="btn-primary">
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
