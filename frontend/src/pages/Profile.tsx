import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, Field, Modal, PageHeader, SectionHeader, Skeleton, StatCard, StatusBadge } from '../components/ui';
import { ImageUpload } from '../components/ImageUpload';
import { Icon } from '../components/icons';
import { EmployeeActivityDetailsModal } from '../components/EmployeeActivityDetailsModal';
import { formatDate, formatDateTime, minutesToHours, titleize } from '../lib/format';

interface EmployeeDetail {
  id: number;
  employeeCode: string;
  fullName: string;
  email: string;
  mobile: string;
  photoUrl: string | null;
  status: string;
  employmentType: string;
  joiningDate: string | null;
  dateOfBirth: string | null;
  address: string | null;
  emergencyContact: string | null;
  departmentName: string | null;
  designationTitle: string | null;
  roleName: string;
  managerName: string | null;
  locationName: string | null;
  lastLoginAt: string | null;
  emailVerifiedAt: string | null;
  mobileVerifiedAt: string | null;
  mfaEnabled: boolean;
  stats: {
    tasks: { total: number; completed: number; active: number; overdue: number };
    attendance: { presentDays: number; lateDays: number; totalMinutes: number };
    tickets: { total: number; open: number; resolved: number };
    reports: { submitted: number; approved: number };
    kpi: { period: string; score: number; category: string; status: string } | null;
  };
}

interface LocationOption { id: number; code: string; name: string; city: string | null }
interface SelfLocationInfo { canChange: boolean; currentLocationId: number | null; locations: LocationOption[] }

interface EmployeeDocument {
  id: number;
  documentType: string;
  title: string;
  fileUrl: string;
  status: string;
  verifierName: string | null;
  verifiedAt: string | null;
  notes: string | null;
  createdAt: string;
}

interface EmployeeSalary {
  basicSalary: number;
  hra: number;
  specialAllowance: number;
  conveyanceAllowance: number;
  medicalAllowance: number;
  grossSalary: number;
  epfDeduction: number;
  esiDeduction: number;
  professionalTax: number;
  tdsDeduction: number;
  totalDeductions: number;
  netSalary: number;
  bankName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  panNumber: string | null;
  uanNumber: string | null;
}

interface PayrollRecord {
  id: number;
  month: number;
  year: number;
  workingDays: number;
  presentDays: number;
  payableDays: number;
  grossEarnings: number;
  totalDeductions: number;
  netPay: number;
  paymentStatus: string;
  paidAt: string | null;
  referenceNo: string | null;
}

export default function Profile() {
  useDocumentTitle('My profile');
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [form, setForm] = useState({ fullName: '', mobile: '', address: '', emergencyContact: '', dateOfBirth: '' });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [locationInfo, setLocationInfo] = useState<SelfLocationInfo | null>(null);
  const [locationChoice, setLocationChoice] = useState('');
  const [locationReason, setLocationReason] = useState('');
  const [locationBusy, setLocationBusy] = useState(false);
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [documents, setDocuments] = useState<EmployeeDocument[]>([]);
  const [salary, setSalary] = useState<EmployeeSalary | null>(null);
  const [payrolls, setPayrolls] = useState<PayrollRecord[]>([]);

  const loadLocations = async () => {
    try {
      const result = await api.get<SelfLocationInfo>('/employees/me/location');
      setLocationInfo(result);
      setLocationChoice(result.currentLocationId ? String(result.currentLocationId) : '');
    } catch {
      setLocationInfo({ canChange: false, currentLocationId: null, locations: [] });
    }
  };

  const changeLocation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!locationChoice) {
      toast.error('Select a location.');
      return;
    }
    if (Number(locationChoice) === locationInfo?.currentLocationId) {
      toast.info('That is already your location.');
      return;
    }
    setLocationBusy(true);
    try {
      const result = await api.patch<{ changed: boolean; location: LocationOption }>('/employees/me/location', {
        locationId: Number(locationChoice),
        reason: locationReason.trim() || undefined,
      });
      toast.success(result.changed ? `Your location is now ${result.location.name}.` : 'Location unchanged.');
      setLocationReason('');
      await refresh();
      await Promise.all([load(), loadLocations()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLocationBusy(false);
    }
  };

  const load = async () => {
    if (!user) return;
    try {
      const result = await api.get<EmployeeDetail>(`/employees/${user.id}`);
      setDetail(result);
      setForm({
        fullName: result.fullName,
        mobile: result.mobile,
        address: result.address ?? '',
        emergencyContact: result.emergencyContact ?? '',
        dateOfBirth: result.dateOfBirth ?? '',
      });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
    try {
      const docsRes = await api.get<{ documents: EmployeeDocument[] }>('/hr/documents');
      setDocuments(docsRes.documents ?? []);
    } catch {
      // ignore
    }
    try {
      const salRes = await api.get<{ salaries: EmployeeSalary[] }>('/hr/salaries');
      setSalary(salRes.salaries?.[0] ?? null);
    } catch {
      // ignore
    }
    try {
      const prRes = await api.get<{ records: PayrollRecord[] }>(`/hr/payroll?year=${new Date().getFullYear()}`);
      setPayrolls(prRes.records ?? []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void load();
    void loadLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      await api.patch(`/employees/${user.id}`, {
        fullName: form.fullName,
        mobile: form.mobile,
        address: form.address || undefined,
        emergencyContact: form.emergencyContact || undefined,
        dateOfBirth: form.dateOfBirth || undefined,
      });
      toast.success('Profile updated.');
      await load();
      await refresh();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirm) {
      toast.error('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/password/change', { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword });
      toast.success('Password changed. Other sessions were revoked.');
      setPasswordOpen(false);
      setPasswords({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="My profile"
        description="Your employee record, contact details, security and performance history."
        actions={
          <>
            <button
              type="button"
              className="btn-primary btn-sm inline-flex items-center gap-1.5"
              onClick={() => setActivityModalOpen(true)}
            >
              <Icon name="activity" size={15} /> My Activity & User Details
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setPasswordOpen(true)}>
              <Icon name="lock" size={15} /> Change password
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={async () => {
              try {
                await api.post('/auth/sessions/revoke-others');
                toast.success('All other devices have been signed out.');
              } catch (caught) { toast.error(errorMessage(caught)); }
            }}>
              Sign out other devices
            </button>
          </>
        }
      />

      <Card className="card-pad">
        <div className="flex flex-wrap items-center gap-5">
          <ImageUpload
            name={user.fullName}
            photoUrl={detail?.photoUrl ?? user.photoUrl}
            size={76}
            onUploaded={async (photoUrl) => {
              setDetail((current) => (current ? { ...current, photoUrl } : current));
              await refresh();
            }}
            onRemoved={async () => {
              setDetail((current) => (current ? { ...current, photoUrl: null } : current));
              await refresh();
            }}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-ink-900">{user.fullName}</h2>
            <p className="text-sm text-ink-500">{user.designationTitle ?? '—'} · {user.departmentName ?? '—'} · {user.employeeCode}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge tone="brand">{user.roleName}</Badge>
              <Badge tone="neutral">{titleize(user.employmentType)}</Badge>
              <StatusBadge status={user.status} />
              {user.mfaEnabled && <Badge tone="success">MFA enabled</Badge>}
            </div>
          </div>
          <div className="text-right text-xs text-ink-500">
            <p>Reports to {user.managerName ?? '—'}</p>
            <p>{user.locationName ?? 'No location'}</p>
            <p>Joined {formatDate(user.joiningDate)}</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tasks completed" value={detail ? `${detail.stats.tasks.completed}/${detail.stats.tasks.total}` : '—'} icon={<Icon name="tasks" size={18} />} />
        <StatCard label="Present days (month)" value={detail?.stats.attendance.presentDays ?? '—'} tone="success" icon={<Icon name="clock" size={18} />} />
        <StatCard label="Hours logged (month)" value={detail ? minutesToHours(detail.stats.attendance.totalMinutes) : '—'} tone="neutral" icon={<Icon name="report" size={18} />} />
        <StatCard label="Latest KPI" value={detail?.stats.kpi ? detail.stats.kpi.score.toFixed(1) : '—'} hint={detail?.stats.kpi?.category} tone="brand" icon={<Icon name="kpi" size={18} />} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="card-pad">
          <SectionHeader title="Contact & personal details" description="Sensitive organisational changes are handled by HR." />
          {!detail ? (
            <Skeleton lines={6} />
          ) : (
            <form onSubmit={save} className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Full name"><input className="input" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required /></Field>
                <Field label="Mobile"><input className="input" value={form.mobile} onChange={(event) => setForm({ ...form, mobile: event.target.value })} required /></Field>
                <Field label="Emergency contact"><input className="input" value={form.emergencyContact} onChange={(event) => setForm({ ...form, emergencyContact: event.target.value })} /></Field>
                <Field label="Date of birth"><input type="date" className="input" value={form.dateOfBirth} onChange={(event) => setForm({ ...form, dateOfBirth: event.target.value })} /></Field>
              </div>
              <Field label="Address"><input className="input" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></Field>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-ink-500">Email: {detail.email}</p>
                <button type="submit" className="btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
              </div>
            </form>
          )}
        </Card>

        <Card className="card-pad">
          <SectionHeader title="Account & security" />
          {!detail ? (
            <Skeleton lines={5} />
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-ink-500">Employee ID</dt><dd className="font-medium text-ink-800">{detail.employeeCode}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-500">Email verified</dt><dd className="text-ink-800">{detail.emailVerifiedAt ? formatDateTime(detail.emailVerifiedAt) : 'Not verified'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-500">Mobile verified</dt><dd className="text-ink-800">{detail.mobileVerifiedAt ? formatDateTime(detail.mobileVerifiedAt) : 'Not verified'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-500">Last login</dt><dd className="text-ink-800">{formatDateTime(detail.lastLoginAt)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-500">Multi-factor auth</dt><dd className="text-ink-800">{detail.mfaEnabled ? 'Enabled' : 'Not enabled'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-500">Permissions</dt><dd className="text-ink-800">{user.permissions.length} granted</dd></div>
            </dl>
          )}
          <div className="mt-4 rounded-lg bg-ink-50 p-3 text-xs text-ink-500">
            Sessions are validated on every request against the server-side session store. Changing your password revokes all other devices.
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="card-pad">
          <SectionHeader
            title="My employment documents"
            description="Verified identity, education and compliance documents on file with HR."
          />
          {documents.length === 0 ? (
            <p className="mt-4 text-xs text-ink-400">No documents have been uploaded yet.</p>
          ) : (
            <div className="mt-3 divide-y divide-ink-100 dark:divide-ink-800 text-sm">
              {documents.map((doc) => (
                <div key={doc.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink-800 dark:text-ink-200 truncate">{doc.title}</p>
                    <p className="text-xs text-ink-400">{titleize(doc.documentType)} · {formatDate(doc.createdAt)}</p>
                    {doc.notes && <p className="text-xs text-ink-500 italic mt-0.5">{doc.notes}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={doc.status} />
                    {doc.fileUrl && (
                      <a
                        href={doc.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-secondary btn-xs inline-flex items-center gap-1"
                      >
                        <Icon name="download" size={13} /> View
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="card-pad">
          <SectionHeader
            title="My salary & compensation"
            description="Confidential salary breakdown and statutory deductions."
          />
          {!salary ? (
            <p className="mt-4 text-xs text-ink-400">Salary structure is being configured by HR.</p>
          ) : (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-lg bg-ink-50 dark:bg-ink-900/50 p-2.5">
                  <span className="text-ink-400 block">Basic Salary</span>
                  <span className="text-sm font-semibold text-ink-800 dark:text-ink-200">₹{salary.basicSalary.toLocaleString()}</span>
                </div>
                <div className="rounded-lg bg-ink-50 dark:bg-ink-900/50 p-2.5">
                  <span className="text-ink-400 block">HRA</span>
                  <span className="text-sm font-semibold text-ink-800 dark:text-ink-200">₹{salary.hra.toLocaleString()}</span>
                </div>
                <div className="rounded-lg bg-ink-50 dark:bg-ink-900/50 p-2.5">
                  <span className="text-ink-400 block">Special Allowance</span>
                  <span className="text-sm font-semibold text-ink-800 dark:text-ink-200">₹{salary.specialAllowance.toLocaleString()}</span>
                </div>
                <div className="rounded-lg bg-brand-500/10 p-2.5">
                  <span className="text-brand-600 dark:text-brand-400 block">Gross Salary</span>
                  <span className="text-sm font-bold text-brand-700 dark:text-brand-300">₹{salary.grossSalary.toLocaleString()}</span>
                </div>
                <div className="rounded-lg bg-rose-500/10 p-2.5">
                  <span className="text-rose-600 dark:text-rose-400 block">Total Deductions</span>
                  <span className="text-sm font-bold text-rose-700 dark:text-rose-300">₹{salary.totalDeductions.toLocaleString()}</span>
                </div>
                <div className="rounded-lg bg-emerald-500/10 p-2.5">
                  <span className="text-emerald-600 dark:text-emerald-400 block">Net Take-Home</span>
                  <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300">₹{salary.netSalary.toLocaleString()}</span>
                </div>
              </div>

              {(salary.bankAccountNo || salary.panNumber || salary.uanNumber) && (
                <div className="rounded-lg border border-ink-100 dark:border-ink-800 p-2.5 text-xs text-ink-500 space-y-1">
                  {salary.bankName && <div><span className="font-medium text-ink-700 dark:text-ink-300">Bank:</span> {salary.bankName} {salary.bankAccountNo ? `(A/C: ••••${salary.bankAccountNo.slice(-4)})` : ''}</div>}
                  {salary.panNumber && <div><span className="font-medium text-ink-700 dark:text-ink-300">PAN:</span> {salary.panNumber}</div>}
                  {salary.uanNumber && <div><span className="font-medium text-ink-700 dark:text-ink-300">UAN:</span> {salary.uanNumber}</div>}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {payrolls.length > 0 && (
        <Card className="card-pad">
          <SectionHeader
            title="Monthly payslips history"
            description="Your monthly attendance, earnings and net payout records."
          />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs text-ink-700 dark:text-ink-300">
              <thead>
                <tr className="border-b border-ink-100 dark:border-ink-800 text-[11px] font-semibold text-ink-400 uppercase">
                  <th className="py-2">Period</th>
                  <th className="py-2">Payable Days</th>
                  <th className="py-2">Gross Earnings</th>
                  <th className="py-2">Deductions</th>
                  <th className="py-2">Net Pay</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Paid On</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-50 dark:divide-ink-800/50">
                {payrolls.map((pr) => (
                  <tr key={pr.id}>
                    <td className="py-2.5 font-medium">{new Date(pr.year, pr.month - 1).toLocaleString('default', { month: 'short' })} {pr.year}</td>
                    <td className="py-2.5">{pr.payableDays} / {pr.workingDays}</td>
                    <td className="py-2.5">₹{pr.grossEarnings.toLocaleString()}</td>
                    <td className="py-2.5 text-rose-600 dark:text-rose-400">₹{pr.totalDeductions.toLocaleString()}</td>
                    <td className="py-2.5 font-bold text-emerald-600 dark:text-emerald-400">₹{pr.netPay.toLocaleString()}</td>
                    <td className="py-2.5"><StatusBadge status={pr.paymentStatus} /></td>
                    <td className="py-2.5 text-ink-400">{pr.paidAt ? formatDate(pr.paidAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {locationInfo?.canChange && (
        <Card className="card-pad">
          <SectionHeader
            title="Work location"
            description="As an administrator or manager you can move your own primary location. Your dashboards, notifications and location-scoped data follow the new location."
          />
          <form onSubmit={changeLocation} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Location" required>
              <select className="input" value={locationChoice} onChange={(event) => setLocationChoice(event.target.value)} required>
                <option value="" disabled>Select a location</option>
                {locationInfo.locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name} ({loc.code}){loc.id === locationInfo.currentLocationId ? ' — current' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason" hint="Optional, recorded in the audit log">
              <input className="input" value={locationReason} maxLength={500} onChange={(event) => setLocationReason(event.target.value)} placeholder="e.g. Covering the Davanagere store" />
            </Field>
            <button
              type="submit"
              className="btn-primary btn-sm"
              disabled={locationBusy || !locationChoice || Number(locationChoice) === locationInfo.currentLocationId}
            >
              {locationBusy ? 'Updating…' : 'Change location'}
            </button>
          </form>
          {locationInfo.locations.length === 0 && (
            <p className="mt-2 text-xs text-ink-500">No active locations are configured.</p>
          )}
        </Card>
      )}

      <Modal open={passwordOpen} onClose={() => setPasswordOpen(false)} title="Change password" description="Minimum 10 characters with upper case, lower case, a number and a symbol."
        footer={<><button className="btn-secondary" onClick={() => setPasswordOpen(false)}>Cancel</button><button className="btn-primary" form="password-form" type="submit" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button></>}>
        <form id="password-form" onSubmit={changePassword} className="space-y-3">
          <Field label="Current password" required><input type="password" className="input" autoComplete="current-password" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} required /></Field>
          <Field label="New password" required><input type="password" className="input" autoComplete="new-password" value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} minLength={10} required /></Field>
          <Field label="Confirm new password" required><input type="password" className="input" autoComplete="new-password" value={passwords.confirm} onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })} minLength={10} required /></Field>
        </form>
      </Modal>

      {activityModalOpen && (
        <EmployeeActivityDetailsModal
          open={activityModalOpen}
          onClose={() => setActivityModalOpen(false)}
          employeeId={user.id}
        />
      )}
    </div>
  );
}
