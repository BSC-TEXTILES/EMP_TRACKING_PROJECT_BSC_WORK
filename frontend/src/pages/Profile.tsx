import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, Field, Modal, PageHeader, SectionHeader, Skeleton, StatCard, StatusBadge } from '../components/ui';
import { ImageUpload } from '../components/ImageUpload';
import { Icon } from '../components/icons';
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

export default function Profile() {
  useDocumentTitle('My profile');
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [form, setForm] = useState({ fullName: '', mobile: '', address: '', emergencyContact: '', dateOfBirth: '' });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);

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
  };

  useEffect(() => {
    void load();
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

      <Modal open={passwordOpen} onClose={() => setPasswordOpen(false)} title="Change password" description="Minimum 10 characters with upper case, lower case, a number and a symbol."
        footer={<><button className="btn-secondary" onClick={() => setPasswordOpen(false)}>Cancel</button><button className="btn-primary" form="password-form" type="submit" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button></>}>
        <form id="password-form" onSubmit={changePassword} className="space-y-3">
          <Field label="Current password" required><input type="password" className="input" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} required /></Field>
          <Field label="New password" required><input type="password" className="input" value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} minLength={10} required /></Field>
          <Field label="Confirm new password" required><input type="password" className="input" value={passwords.confirm} onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })} minLength={10} required /></Field>
        </form>
      </Modal>
    </div>
  );
}
