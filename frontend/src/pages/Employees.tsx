import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadReport, errorMessage } from '../lib/api';
import { useDebounced, useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, SectionHeader, Skeleton, StatCard, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDate, formatDateTime, minutesToHours, titleize } from '../lib/format';
import type { EmployeeRow } from '../lib/types';

interface EmployeeDetail extends EmployeeRow {
  roleId: number;
  designationId: number | null;
  locationId: number | null;
  dateOfBirth: string | null;
  address: string | null;
  emergencyContact: string | null;
  createdAt: string | null;
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

interface Structure {
  departments: { id: number; name: string; code: string }[];
  designations: { id: number; title: string; department_id: number | null }[];
  locations: { id: number; name: string; code: string }[];
  roles: { id: number; name: string; slug: string; level: number; employeeCount: number }[];
}

export default function Employees() {
  useDocumentTitle('Employees');
  const { has, user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const debounced = useDebounced(search);
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: EmployeeRow[]; total: number } | null>(null);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [orgEdit, setOrgEdit] = useState(false);
  const [orgForm, setOrgForm] = useState({ roleId: '', departmentId: '', designationId: '', managerId: '', locationId: '', employmentType: '' });
  const [editForm, setEditForm] = useState({ fullName: '', mobile: '', address: '', emergencyContact: '', dateOfBirth: '' });

  const load = async () => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (debounced) query.set('search', debounced);
      if (status) query.set('status', status);
      if (departmentId) query.set('departmentId', departmentId);
      const result = await api.get<{ items: EmployeeRow[]; total: number }>(`/employees?${query.toString()}`);
      setData(result);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debounced, status, departmentId]);

  useEffect(() => {
    api.get<Structure>('/employees/structure').then(setStructure).catch(() => undefined);
  }, []);

  const openDetail = async (id: number) => {
    try {
      const result = await api.get<EmployeeDetail>(`/employees/${id}`);
      setDetail(result);
      setOrgForm({
        roleId: String(result.roleId),
        departmentId: result.departmentId ? String(result.departmentId) : '',
        designationId: result.designationId ? String(result.designationId) : '',
        managerId: result.managerId ? String(result.managerId) : '',
        locationId: result.locationId ? String(result.locationId) : '',
        employmentType: result.employmentType,
      });
      setEditForm({
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

  const pending = (data?.items ?? []).filter((employee) => employee.status === 'pending_approval');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employee directory & HR"
        description="Scoped by reporting structure: managers see their team, HR and administrators see the organisation."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'employees', format: 'xlsx' })}>Export</button>
            {has('employees.manage') && <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}><Icon name="plus" size={15} /> Add employee</button>}
          </>
        }
      />

      {pending.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {pending.length} registration(s) awaiting approval on this page. Open a record to approve or reject it.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Employees in scope" value={data?.total ?? '—'} icon={<Icon name="users" size={18} />} />
        <StatCard label="Pending approval" value={pending.length} tone="warning" icon={<Icon name="clock" size={18} />} />
        <StatCard label="Departments" value={structure?.departments.length ?? '—'} tone="neutral" icon={<Icon name="building" size={18} />} />
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <div className="relative min-w-[200px] flex-1">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="input pl-9" placeholder="Search name, code, email, mobile" value={search} onChange={(event) => { setSearch(event.target.value); setParams(event.target.value ? { search: event.target.value } : {}); setPage(1); }} />
          </div>
          <select className="input w-auto" value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setPage(1); }}>
            <option value="">All departments</option>
            {structure?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
          <select className="input w-auto" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {['active', 'pending_approval', 'pending_verification', 'inactive'].map((value) => <option key={value} value={value}>{titleize(value)}</option>)}
          </select>
        </div>

        {!data ? (
          <div className="p-4"><Skeleton lines={8} /></div>
        ) : data.items.length === 0 ? (
          <EmptyState title="No employees found" description="Adjust the filters or search for a different name." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Employee</th><th>Role</th><th>Department</th><th>Manager</th><th>Today</th><th>Open tasks</th><th>Status</th></tr></thead>
                <tbody>
                  {data.items.map((employee) => (
                    <tr key={employee.id} className="cursor-pointer" onClick={() => void openDetail(employee.id)}>
                      <td>
                        <div className="flex items-center gap-2">
                          <Avatar name={employee.fullName} src={employee.photoUrl} size={30} />
                          <div>
                            <p className="font-medium text-ink-800">{employee.fullName}</p>
                            <p className="text-xs text-ink-400">{employee.employeeCode} · {employee.designationTitle ?? '—'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="text-ink-600">{employee.roleName}</td>
                      <td className="text-ink-600">{employee.departmentName ?? '—'}</td>
                      <td className="text-ink-600">{employee.managerName ?? '—'}</td>
                      <td>{employee.attendanceStatus ? <StatusBadge status={employee.attendanceStatus} /> : <span className="text-xs text-ink-400">No record</span>}</td>
                      <td className="text-ink-700">{employee.openTasks}</td>
                      <td><StatusBadge status={employee.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} size="xl" title={detail?.fullName ?? ''} description={detail ? `${detail.employeeCode} · ${detail.designationTitle ?? ''} · ${detail.departmentName ?? ''}` : undefined}
        footer={detail ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {detail.status === 'pending_approval' && has('employees.approve', 'employees.manage') && (
                <>
                  <button className="btn-primary btn-sm" onClick={async () => {
                    try {
                      await api.post(`/employees/${detail.id}/approve`, {});
                      toast.success('Registration approved. The employee can now sign in.');
                      setDetail(null);
                      await load();
                    } catch (caught) { toast.error(errorMessage(caught)); }
                  }}>Approve registration</button>
                  <button className="btn-secondary btn-sm" onClick={async () => {
                    const reason = window.prompt('Reason for rejection (min 5 characters):');
                    if (!reason) return;
                    try {
                      await api.post(`/employees/${detail.id}/reject`, { reason });
                      toast.success('Registration rejected.');
                      setDetail(null);
                      await load();
                    } catch (caught) { toast.error(errorMessage(caught)); }
                  }}>Reject</button>
                </>
              )}
              {has('employees.manage') && detail.status !== 'pending_approval' && (
                <button className="btn-secondary btn-sm" onClick={() => void (async () => {
                  try {
                    await api.post(`/employees/${detail.id}/status`, { status: detail.status === 'active' ? 'inactive' : 'active' });
                    toast.success(detail.status === 'active' ? 'Employee deactivated. Historical records are preserved.' : 'Employee reactivated.');
                    await openDetail(detail.id);
                    await load();
                  } catch (caught) { toast.error(errorMessage(caught)); }
                })()}>{detail.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
              )}
              {has('employees.manage') && <button className="btn-ghost btn-sm" onClick={() => setOrgEdit((value) => !value)}>Edit assignment</button>}
            </div>
            <button className="btn-secondary btn-sm" onClick={() => setDetail(null)}>Close</button>
          </div>
        ) : null}>
        {detail && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name={detail.fullName} src={detail.photoUrl} size={56} />
              <div className="flex flex-wrap gap-1.5">
                <StatusBadge status={detail.status} />
                <Badge tone="brand">{detail.roleName}</Badge>
                <Badge tone="neutral">{titleize(detail.employmentType)}</Badge>
                {detail.mfaEnabled && <Badge tone="success">MFA</Badge>}
              </div>
            </div>

            <Tabs tabs={[{ value: 'overview', label: 'Overview' }, { value: 'performance', label: 'Performance' }, { value: 'account', label: 'Account' }]} value="overview" onChange={() => undefined} />

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-ink-50 p-2.5"><p className="text-xs text-ink-500">Tasks completed</p><p className="text-lg font-semibold text-ink-900">{detail.stats.tasks.completed}/{detail.stats.tasks.total}</p></div>
              <div className="rounded-lg bg-ink-50 p-2.5"><p className="text-xs text-ink-500">Present days (month)</p><p className="text-lg font-semibold text-ink-900">{detail.stats.attendance.presentDays}</p></div>
              <div className="rounded-lg bg-ink-50 p-2.5"><p className="text-xs text-ink-500">Hours logged (month)</p><p className="text-lg font-semibold text-ink-900">{minutesToHours(detail.stats.attendance.totalMinutes)}</p></div>
              <div className="rounded-lg bg-ink-50 p-2.5"><p className="text-xs text-ink-500">Latest KPI</p><p className="text-lg font-semibold text-ink-900">{detail.stats.kpi ? `${detail.stats.kpi.score.toFixed(1)} · ${detail.stats.kpi.category}` : '—'}</p></div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <SectionHeader title="Contact" />
                <dl className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Email</dt><dd className="text-ink-800">{detail.email}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Mobile</dt><dd className="text-ink-800">{detail.mobile}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Location</dt><dd className="text-ink-800">{detail.locationName ?? '—'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Manager</dt><dd className="text-ink-800">{detail.managerName ?? '—'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Joined</dt><dd className="text-ink-800">{formatDate(detail.joiningDate)}</dd></div>
                </dl>
              </div>
              <div>
                <SectionHeader title="Reports & tickets" />
                <dl className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Daily reports (month)</dt><dd className="text-ink-800">{detail.stats.reports.submitted} · {detail.stats.reports.approved} approved</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Tickets</dt><dd className="text-ink-800">{detail.stats.tickets.total} · {detail.stats.tickets.open} open</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Overdue tasks</dt><dd className="text-ink-800">{detail.stats.tasks.overdue}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-500">Last login</dt><dd className="text-ink-800">{formatDateTime(detail.lastLoginAt)}</dd></div>
                </dl>
              </div>
            </div>

            {orgEdit && (
              <form className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3" onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await api.patch(`/employees/${detail.id}/org-assignment`, {
                    roleId: orgForm.roleId ? Number(orgForm.roleId) : undefined,
                    departmentId: orgForm.departmentId ? Number(orgForm.departmentId) : null,
                    designationId: orgForm.designationId ? Number(orgForm.designationId) : null,
                    managerId: orgForm.managerId ? Number(orgForm.managerId) : null,
                    locationId: orgForm.locationId ? Number(orgForm.locationId) : null,
                    employmentType: orgForm.employmentType || undefined,
                  });
                  toast.success('Organisational assignment updated and audited.');
                  setOrgEdit(false);
                  await openDetail(detail.id);
                } catch (caught) { toast.error(errorMessage(caught)); }
              }}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Role">
                    <select className="input" value={orgForm.roleId} onChange={(event) => setOrgForm({ ...orgForm, roleId: event.target.value })}>
                      {structure?.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Department">
                    <select className="input" value={orgForm.departmentId} onChange={(event) => setOrgForm({ ...orgForm, departmentId: event.target.value })}>
                      <option value="">None</option>
                      {structure?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Designation">
                    <select className="input" value={orgForm.designationId} onChange={(event) => setOrgForm({ ...orgForm, designationId: event.target.value })}>
                      <option value="">None</option>
                      {structure?.designations.map((designation) => <option key={designation.id} value={designation.id}>{designation.title}</option>)}
                    </select>
                  </Field>
                  <Field label="Reporting manager">
                    <select className="input" value={orgForm.managerId} onChange={(event) => setOrgForm({ ...orgForm, managerId: event.target.value })}>
                      <option value="">None</option>
                      {structure?.designations && (data?.items ?? []).filter((employee) => employee.id !== detail.id && employee.fullName.toLowerCase().includes('gagan')).map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}
                    </select>
                  </Field>
                </div>
                <button type="submit" className="btn-primary btn-sm">Save assignment</button>
              </form>
            )}

            {(user?.id === detail.id || has('employees.manage')) && (
              <form className="space-y-3 rounded-lg border border-ink-200 p-3" onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await api.patch(`/employees/${detail.id}`, {
                    fullName: editForm.fullName,
                    mobile: editForm.mobile,
                    address: editForm.address || undefined,
                    emergencyContact: editForm.emergencyContact || undefined,
                    dateOfBirth: editForm.dateOfBirth || undefined,
                  });
                  toast.success('Profile updated.');
                  await openDetail(detail.id);
                  await load();
                } catch (caught) { toast.error(errorMessage(caught)); }
              }}>
                <p className="text-sm font-semibold text-ink-800">Profile details</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Full name"><input className="input" value={editForm.fullName} onChange={(event) => setEditForm({ ...editForm, fullName: event.target.value })} required /></Field>
                  <Field label="Mobile"><input className="input" value={editForm.mobile} onChange={(event) => setEditForm({ ...editForm, mobile: event.target.value })} required /></Field>
                  <Field label="Address"><input className="input" value={editForm.address} onChange={(event) => setEditForm({ ...editForm, address: event.target.value })} /></Field>
                  <Field label="Emergency contact"><input className="input" value={editForm.emergencyContact} onChange={(event) => setEditForm({ ...editForm, emergencyContact: event.target.value })} /></Field>
                  <Field label="Date of birth"><input type="date" className="input" value={editForm.dateOfBirth} onChange={(event) => setEditForm({ ...editForm, dateOfBirth: event.target.value })} /></Field>
                </div>
                <button type="submit" className="btn-secondary btn-sm">Save profile</button>
              </form>
            )}
          </div>
        )}
      </Modal>

      <CreateEmployee open={createOpen} onClose={() => setCreateOpen(false)} structure={structure} employees={data?.items ?? []} onCreated={() => { setCreateOpen(false); void load(); }} />
    </div>
  );
}

function CreateEmployee({ open, onClose, structure, employees, onCreated }: { open: boolean; onClose: () => void; structure: Structure | null; employees: EmployeeRow[]; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ fullName: '', email: '', mobile: '', employeeCode: '', roleId: '', departmentId: '', designationId: '', managerId: '', locationId: '', employmentType: 'full_time', password: '' });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ employeeCode: string } | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post<{ employeeCode: string }>('/employees', {
        ...form,
        employeeCode: form.employeeCode || undefined,
        roleId: Number(form.roleId),
        departmentId: Number(form.departmentId),
        designationId: form.designationId ? Number(form.designationId) : null,
        managerId: form.managerId ? Number(form.managerId) : null,
        locationId: form.locationId ? Number(form.locationId) : null,
      });
      setCreated(result);
      toast.success(`Employee ${result.employeeCode} created.`);
      onCreated();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add employee" size="lg" description="Creates an active account with the selected role. Share the temporary password securely."
      footer={<><button className="btn-secondary" onClick={onClose}>Close</button>{!created && <button className="btn-primary" form="employee-form" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create employee'}</button>}</>}>
      {created ? (
        <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">
          Employee created with code <strong>{created.employeeCode}</strong>. They can sign in with their email and the password you set.
        </div>
      ) : (
        <form id="employee-form" onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" required><input className="input" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required /></Field>
            <Field label="Employee code"><input className="input" value={form.employeeCode} onChange={(event) => setForm({ ...form, employeeCode: event.target.value })} placeholder="Auto" /></Field>
            <Field label="Email" required><input type="email" className="input" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></Field>
            <Field label="Mobile" required><input className="input" value={form.mobile} onChange={(event) => setForm({ ...form, mobile: event.target.value })} required /></Field>
            <Field label="Role" required>
              <select className="input" value={form.roleId} onChange={(event) => setForm({ ...form, roleId: event.target.value })} required>
                <option value="">Select role</option>
                {structure?.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </select>
            </Field>
            <Field label="Department" required>
              <select className="input" value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })} required>
                <option value="">Select department</option>
                {structure?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
              </select>
            </Field>
            <Field label="Designation">
              <select className="input" value={form.designationId} onChange={(event) => setForm({ ...form, designationId: event.target.value })}>
                <option value="">Select designation</option>
                {structure?.designations.map((designation) => <option key={designation.id} value={designation.id}>{designation.title}</option>)}
              </select>
            </Field>
            <Field label="Reporting manager">
              <select className="input" value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })}>
                <option value="">Select manager</option>
                {employees.filter((e) => e.fullName.toLowerCase().includes('gagan')).map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}
              </select>
            </Field>
            <Field label="Location">
              <select className="input" value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>
                <option value="">Select location</option>
                {structure?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </Field>
            <Field label="Employment type">
              <select className="input" value={form.employmentType} onChange={(event) => setForm({ ...form, employmentType: event.target.value })}>
                {['full_time', 'part_time', 'contract', 'intern', 'probation'].map((value) => <option key={value} value={value}>{titleize(value)}</option>)}
              </select>
            </Field>
            <Field label="Temporary password" required hint="Minimum 10 characters">
              <input type="password" className="input" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} minLength={10} required />
            </Field>
          </div>
        </form>
      )}
    </Modal>
  );
}
