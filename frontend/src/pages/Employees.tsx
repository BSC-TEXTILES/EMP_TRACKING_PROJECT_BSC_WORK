import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadReport, errorMessage } from '../lib/api';
import { OfficeHoursBar, hoursFor, type OfficeHoursData } from '../components/OfficeHours';
import { useDebounced, useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, SectionHeader, Skeleton, StatCard, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime, minutesToHours, titleize } from '../lib/format';
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
  const [locationId, setLocationId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [allowedLocations, setAllowedLocations] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const [locationGroups, setLocationGroups] = useState<Array<{ id: number; code: string; name: string }>>([]);

  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: EmployeeRow[]; total: number } | null>(null);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [modalTab, setModalTab] = useState<'overview' | 'edit' | 'performance'>('overview');
  const [createOpen, setCreateOpen] = useState(false);
  const [orgEdit, setOrgEdit] = useState(false);
  const [orgForm, setOrgForm] = useState({ roleId: '', departmentId: '', designationId: '', managerId: '', locationId: '', groupId: '', teamLeaderId: '', employmentType: '', additionalLocationIds: [] as number[] });
  const [editForm, setEditForm] = useState({ fullName: '', mobile: '', address: '', emergencyContact: '', dateOfBirth: '', employeeCode: '' });
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string; code: string } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Approval modal state
  const [approveTarget, setApproveTarget] = useState<EmployeeRow | null>(null);
  const [approveForm, setApproveForm] = useState({
    locationId: '',
    groupId: '',
    roleId: '',
    departmentId: '',
    managerId: '',
  });
  const [approvingBusy, setApprovingBusy] = useState(false);

  // Transfer modal state
  const [transferTarget, setTransferTarget] = useState<EmployeeRow | null>(null);
  const [transferForm, setTransferForm] = useState({
    locationId: '',
    groupId: '',
    teamLeaderId: '',
    reason: '',
  });
  const [transferringBusy, setTransferringBusy] = useState(false);
  const [targetLocationGroups, setTargetLocationGroups] = useState<Array<{ id: number; code: string; name: string }>>([]);

  // Role hierarchy: mirror the server rule so people only see actions they may take.
  const myLevel = user?.roleLevel ?? 0;
  const isElevatedAdmin = myLevel >= 100 || user?.roleSlug === 'super_admin' || has('employees.manage') || has('employees.delete');
  const roleLevelOf = (roleIdOrName: number | string | null | undefined) =>
    structure?.roles.find((r) => r.id === roleIdOrName || r.name === roleIdOrName)?.level ?? Number.MAX_SAFE_INTEGER;
  const canManage = (employeeId: number, roleIdOrName: number | string | null | undefined) =>
    employeeId !== user?.id && (isElevatedAdmin || roleLevelOf(roleIdOrName) < myLevel);
  const canTransfer = (employeeId: number) =>
    employeeId !== user?.id && (user?.roleSlug === 'super_admin' || (user?.roleLevel ?? 0) >= 70 || has('employees.manage') || has('employees.transfer'));
  const assignableRoles = (structure?.roles ?? []).filter((r) => myLevel >= 100 || r.level <= myLevel);

  const confirmDeleteEmployee = async () => {
    if (!deleteTarget) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      toast.error('Type DELETE to confirm deletion.');
      return;
    }
    setDeleting(true);
    try {
      await api.del(`/employees/${deleteTarget.id}`);
      toast.success(`${deleteTarget.name} has been deleted.`);
      setDeleteTarget(null);
      setDeleteConfirmText('');
      setDetail(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDeleting(false);
    }
  };

  const deleteEmployee = (employeeId: number, name: string, code: string) => {
    setDeleteTarget({ id: employeeId, name, code });
    setDeleteConfirmText('');
  };

  const openApproveModal = (emp: EmployeeRow) => {
    setApproveTarget(emp);
    const defaultLoc = emp.locationId ? String(emp.locationId) : (allowedLocations[0]?.id ? String(allowedLocations[0].id) : '');
    setApproveForm({
      locationId: defaultLoc,
      groupId: emp.groupId ? String(emp.groupId) : '',
      roleId: emp.roleName ? String(structure?.roles.find((r) => r.name === emp.roleName)?.id ?? '') : '',
      departmentId: emp.departmentId ? String(emp.departmentId) : '',
      managerId: emp.managerId ? String(emp.managerId) : '',
    });
    if (defaultLoc) {
      api.get<{ items: Array<{ id: number; code: string; name: string }> }>(`/groups?locationId=${defaultLoc}`)
        .then((res) => setTargetLocationGroups(res.items ?? []))
        .catch(() => setTargetLocationGroups([]));
    }
  };

  const handleConfirmApprove = async () => {
    if (!approveTarget) return;
    setApprovingBusy(true);
    try {
      await api.post(`/employees/${approveTarget.id}/approve`, {
        locationId: approveForm.locationId ? Number(approveForm.locationId) : undefined,
        groupId: approveForm.groupId ? Number(approveForm.groupId) : undefined,
        roleId: approveForm.roleId ? Number(approveForm.roleId) : undefined,
        departmentId: approveForm.departmentId ? Number(approveForm.departmentId) : undefined,
        managerId: approveForm.managerId ? Number(approveForm.managerId) : undefined,
      });
      toast.success(`Registration approved! ${approveTarget.fullName} is now verified & active.`);
      setApproveTarget(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setApprovingBusy(false);
    }
  };

  const rejectEmployee = async (employeeId: number, fullName: string) => {
    const reason = window.prompt(`Reason for rejecting ${fullName}'s registration (min 5 characters):`);
    if (!reason || reason.trim().length < 5) {
      if (reason) toast.error('Rejection reason must be at least 5 characters.');
      return;
    }
    try {
      await api.post(`/employees/${employeeId}/reject`, { reason: reason.trim() });
      toast.success(`Registration rejected for ${fullName}.`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const openTransferModal = (emp: EmployeeRow) => {
    setTransferTarget(emp);
    setTransferForm({
      locationId: '',
      groupId: '',
      teamLeaderId: '',
      reason: '',
    });
    setTargetLocationGroups([]);
  };

  const handleConfirmTransfer = async () => {
    if (!transferTarget || !transferForm.locationId) return;
    setTransferringBusy(true);
    try {
      await api.post(`/employees/${transferTarget.id}/transfer`, {
        locationId: Number(transferForm.locationId),
        groupId: transferForm.groupId ? Number(transferForm.groupId) : null,
        teamLeaderId: transferForm.teamLeaderId ? Number(transferForm.teamLeaderId) : null,
        reason: transferForm.reason.trim() || 'Store relocation by authorized administrator',
      });
      toast.success(`${transferTarget.fullName} transferred successfully.`);
      setTransferTarget(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setTransferringBusy(false);
    }
  };

  const load = async () => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (debounced) query.set('search', debounced);
      if (status) query.set('status', status);
      if (departmentId) query.set('departmentId', departmentId);
      if (locationId) query.set('locationId', locationId);
      if (groupId) query.set('groupId', groupId);
      const result = await api.get<{ items: EmployeeRow[]; total: number }>(`/employees?${query.toString()}`);
      setData(result);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debounced, status, departmentId, locationId, groupId]);

  useEffect(() => {
    api.get<Structure>('/employees/structure').then(setStructure).catch(() => undefined);
    api.get<{ locations: Array<{ id: number; code: string; name: string }> }>('/employees/allowed-locations')
      .then((res) => setAllowedLocations(res.locations ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (locationId) {
      api.get<{ items: Array<{ id: number; code: string; name: string }> }>(`/groups?locationId=${locationId}`)
        .then((res) => setLocationGroups(res.items ?? []))
        .catch(() => setLocationGroups([]));
    } else {
      setLocationGroups([]);
    }
  }, [locationId]);

  const openDetail = async (id: number, tab: 'overview' | 'edit' | 'performance' = 'overview') => {
    try {
      setModalTab(tab);
      const result = await api.get<EmployeeDetail>(`/employees/${id}`);
      setDetail(result);
      setOrgForm({
        roleId: String(result.roleId),
        departmentId: result.departmentId ? String(result.departmentId) : '',
        designationId: result.designationId ? String(result.designationId) : '',
        managerId: result.managerId ? String(result.managerId) : '',
        locationId: result.locationId ? String(result.locationId) : '',
        groupId: result.groupId ? String(result.groupId) : '',
        teamLeaderId: result.teamLeaderId ? String(result.teamLeaderId) : '',
        employmentType: result.employmentType,
        additionalLocationIds: (result as any).additionalLocationIds ?? [],
      });
      setEditForm({
        fullName: result.fullName,
        mobile: result.mobile,
        address: result.address ?? '',
        emergencyContact: result.emergencyContact ?? '',
        dateOfBirth: result.dateOfBirth ?? '',
        employeeCode: result.employeeCode,
      });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const [officeHours, setOfficeHours] = useState<OfficeHoursData | null>(null);
  const employeesList = useMemo(() => {
    return data?.items ?? [];
  }, [data?.items]);

  const pending = employeesList.filter((employee) => ['pending_approval', 'pending_verification'].includes(employee.status));

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
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex flex-wrap items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2">
            <Icon name="clock" size={16} className="text-amber-600 shrink-0" />
            <span>
              <strong>{pending.length}</strong> registration(s) awaiting approval or verification. Use the quick <strong>Approve</strong> button in the table or open a record to review and activate.
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="cursor-pointer" onClick={() => { setStatus(''); setLocationId(''); setGroupId(''); setDepartmentId(''); setPage(1); }} title="Show all employees in scope">
          <StatCard label="Employees in scope" value={employeesList.length} icon={<Icon name="users" size={18} />} />
        </div>
        <div className="cursor-pointer" onClick={() => { setStatus(status === 'pending_approval' ? '' : 'pending_approval'); setPage(1); }} title="Click to filter pending approvals">
          <StatCard label="Pending approval" value={pending.length} tone={pending.length > 0 ? 'warning' : 'neutral'} icon={<Icon name="clock" size={18} />} />
        </div>
        <StatCard label="Departments" value={structure?.departments.length ?? '—'} tone="neutral" icon={<Icon name="building" size={18} />} />
      </div>

      <Card>
        <OfficeHoursBar onLoaded={setOfficeHours} />
        <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <div className="relative min-w-[200px] flex-1">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="input pl-9" placeholder="Search name, code, email, mobile" value={search} onChange={(event) => { setSearch(event.target.value); setParams(event.target.value ? { search: event.target.value } : {}); setPage(1); }} />
          </div>
          <select className="input w-auto font-medium" value={locationId} onChange={(event) => { setLocationId(event.target.value); setGroupId(''); setPage(1); }}>
            <option value="">All locations</option>
            {allowedLocations.map((loc) => <option key={loc.id} value={loc.id}>{loc.code} – {loc.name}</option>)}
          </select>
          {locationId && (
            <select className="input w-auto font-medium" value={groupId} onChange={(event) => { setGroupId(event.target.value); setPage(1); }}>
              <option value="">All groups</option>
              {locationGroups.map((g) => <option key={g.id} value={g.id}>{g.code} – {g.name}</option>)}
            </select>
          )}
          <select className="input w-auto" value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setPage(1); }}>
            <option value="">All departments</option>
            {structure?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
          <select className="input w-auto font-medium" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {['active', 'pending_approval', 'pending_verification', 'inactive'].map((value) => <option key={value} value={value}>{titleize(value)}</option>)}
          </select>
        </div>

        {!data ? (
          <div className="p-4"><Skeleton lines={8} /></div>
        ) : employeesList.length === 0 ? (
          <EmptyState title="No employees found" description="Adjust the filters or search for a different name." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Location & Group</th>
                    <th>Role</th>
                    <th>Department</th>
                    <th>Manager</th>
                    <th>Office time</th>
                    <th>Today</th>
                    <th>Open tasks</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employeesList.map((employee) => (
                    <tr key={employee.id} className="cursor-pointer hover:bg-ink-50/60 transition-colors" onClick={() => void openDetail(employee.id, 'overview')}>
                      <td>
                        <div className="flex items-center gap-2">
                          <Avatar name={employee.fullName} src={employee.photoUrl} size={30} />
                          <div>
                            <p className="font-medium text-ink-800">{employee.fullName}</p>
                            <p className="text-xs text-ink-400">{employee.employeeCode} · {employee.designationTitle ?? '—'}</p>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="flex flex-col gap-0.5">
                          <span className={cx(
                            'inline-flex items-center gap-1 font-mono font-extrabold text-xs px-2.5 py-0.5 rounded-md border w-fit shadow-2xs',
                            employee.locationCode === 'BEL' ? 'bg-blue-50 text-blue-900 border-blue-300' :
                            employee.locationCode === 'DAV' ? 'bg-purple-50 text-purple-900 border-purple-300' :
                            employee.locationCode === 'SHI' ? 'bg-emerald-50 text-emerald-900 border-emerald-300' :
                            employee.locationCode === 'ALL' ? 'bg-amber-100 text-amber-900 border-amber-300 font-black' :
                            'bg-slate-100 text-slate-800 border-slate-300'
                          )}>
                            <Icon name="building" size={11} />
                            {employee.locationCode === 'ALL' ? 'ALL 3 STORES' : (employee.locationCode || employee.locationName || 'Unassigned')}
                          </span>
                          <span className="text-xs text-ink-600 font-medium truncate max-w-[140px]">
                            {employee.groupName || <span className="text-ink-400 italic">No group</span>}
                          </span>
                        </div>
                      </td>
                      <td className="text-ink-600">{employee.roleName}</td>
                      <td className="text-ink-600">{employee.departmentName ?? '—'}</td>
                      <td className="text-ink-600">{employee.managerName ?? '—'}</td>
                      <td className="whitespace-nowrap text-xs text-ink-600 tabular-nums">
                        {(() => {
                          const h = hoursFor(officeHours, employee.locationId);
                          return h ? <>{h.workStart} – {h.workEnd}</> : '—';
                        })()}
                      </td>
                      <td>{employee.attendanceStatus ? <StatusBadge status={employee.attendanceStatus} /> : <span className="text-xs text-ink-400">No record</span>}</td>
                      <td className="text-ink-700">{employee.openTasks}</td>
                      <td><StatusBadge status={employee.status} /></td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          {['pending_approval', 'pending_verification'].includes(employee.status) && has('employees.approve', 'employees.manage') && (
                            <>
                              <button
                                type="button"
                                title="Approve registration & activate"
                                className="btn-primary btn-xs inline-flex items-center gap-1 font-semibold !bg-emerald-600 hover:!bg-emerald-700 !text-white !border-emerald-600 shadow-sm cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openApproveModal(employee);
                                }}
                              >
                                <Icon name="check" size={13} />
                                <span>Approve</span>
                              </button>
                              <button
                                type="button"
                                title="Reject registration"
                                className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold !text-rose-700 !border-rose-200 hover:!bg-rose-50 cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void rejectEmployee(employee.id, employee.fullName);
                                }}
                              >
                                <Icon name="x" size={13} />
                                <span>Reject</span>
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            title="View full details"
                            className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold cursor-pointer"
                            onClick={() => void openDetail(employee.id, 'overview')}
                          >
                            <Icon name="eye" size={13} />
                            <span>View</span>
                          </button>
                          <button
                            type="button"
                            title="Edit employee"
                            className="btn-primary btn-xs inline-flex items-center gap-1 font-semibold cursor-pointer"
                            onClick={() => void openDetail(employee.id, 'edit')}
                          >
                            <Icon name="edit" size={13} />
                            <span>Edit</span>
                          </button>
                          {canTransfer(employee.id) && (
                            <button
                              type="button"
                              title="Transfer Location / Group"
                              className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                openTransferModal(employee);
                              }}
                            >
                              <Icon name="send" size={13} />
                              <span>Transfer</span>
                            </button>
                          )}
                          {canManage(employee.id, employee.roleName) && (
                            <button
                              type="button"
                              title="Delete employee"
                              className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold !text-rose-700 !border-rose-200 hover:!bg-rose-50 cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteEmployee(employee.id, employee.fullName, employee.employeeCode);
                              }}
                            >
                              <Icon name="trash" size={13} />
                              <span>Delete</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={25} total={data?.total ?? employeesList.length} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} size="xl" title={detail?.fullName ?? ''} description={detail ? `${detail.employeeCode} · ${detail.designationTitle ?? ''} · ${detail.departmentName ?? ''}` : undefined}
        footer={detail ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {['pending_approval', 'pending_verification'].includes(detail.status) && has('employees.approve', 'employees.manage') && (
                <>
                  <button className="btn-primary btn-sm !bg-emerald-600 hover:!bg-emerald-700 !text-white !border-emerald-600 shadow-sm" onClick={async () => {
                    try {
                      await api.post(`/employees/${detail.id}/approve`, {});
                      toast.success(`Registration approved for ${detail.fullName}. The employee can now sign in.`);
                      setDetail(null);
                      await load();
                    } catch (caught) { toast.error(errorMessage(caught)); }
                  }}>Approve registration</button>
                  <button className="btn-secondary btn-sm !text-rose-700 !border-rose-200 hover:!bg-rose-50" onClick={async () => {
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
              {canManage(detail.id, detail.roleId) && (
                <button className="btn-secondary btn-sm inline-flex items-center gap-1.5 !text-rose-700 !border-rose-200 hover:!bg-rose-50"
                  onClick={() => deleteEmployee(detail.id, detail.fullName, detail.employeeCode)}>
                  <Icon name="trash" size={14} />
                  <span>Delete</span>
                </button>
              )}
              {has('employees.manage') && canManage(detail.id, detail.roleId) && !['pending_approval', 'pending_verification'].includes(detail.status) && (
                <button className="btn-secondary btn-sm" onClick={() => void (async () => {
                  try {
                    await api.post(`/employees/${detail.id}/status`, { status: detail.status === 'active' ? 'inactive' : 'active' });
                    toast.success(detail.status === 'active' ? 'Employee deactivated. Historical records are preserved.' : 'Employee reactivated.');
                    await openDetail(detail.id, modalTab);
                    await load();
                  } catch (caught) { toast.error(errorMessage(caught)); }
                })()}>{detail.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
              )}
              {modalTab === 'overview' ? (
                <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setModalTab('edit')}>
                  <Icon name="edit" size={14} />
                  <span>Edit employee</span>
                </button>
              ) : (
                <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => setModalTab('overview')}>
                  <Icon name="eye" size={14} />
                  <span>View overview</span>
                </button>
              )}
            </div>
            <button className="btn-secondary btn-sm" onClick={() => setDetail(null)}>Close</button>
          </div>
        ) : null}>
        {detail && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 bg-white p-3.5 shadow-2xs">
              <div className="flex items-center gap-3">
                <Avatar name={detail.fullName} src={detail.photoUrl} size={52} />
                <div>
                  <h3 className="text-base font-bold text-ink-900">{detail.fullName}</h3>
                  <p className="text-xs text-ink-500 font-mono">{detail.employeeCode} · {detail.designationTitle ?? 'Designation Not Assigned'} · {detail.departmentName ?? 'Department'}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={detail.status} />
                <Badge tone="brand">{detail.roleName}</Badge>
                <Badge tone="neutral">{titleize(detail.employmentType)}</Badge>
                {detail.mfaEnabled && <Badge tone="success">MFA</Badge>}
              </div>
            </div>

            {['pending_approval', 'pending_verification'].includes(detail.status) && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 flex flex-wrap items-center justify-between gap-3 shadow-xs">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Icon name="clock" size={16} className="text-amber-700" />
                    <p className="font-bold text-sm text-amber-900">
                      Registration Awaiting Administrative Approval
                    </p>
                  </div>
                  <p className="text-xs text-amber-700">
                    Status: <strong className="uppercase">{titleize(detail.status)}</strong>. Giving approval will verify the employee and activate their account for immediate portal access.
                  </p>
                </div>
                {has('employees.approve', 'employees.manage') && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-primary btn-sm !bg-emerald-600 hover:!bg-emerald-700 !text-white !border-emerald-600 shadow-sm inline-flex items-center gap-1.5 font-bold"
                      onClick={async () => {
                        try {
                          await api.post(`/employees/${detail.id}/approve`, {});
                          toast.success(`Registration approved for ${detail.fullName}. Account is now active.`);
                          setDetail(null);
                          await load();
                        } catch (caught) {
                          toast.error(errorMessage(caught));
                        }
                      }}
                    >
                      <Icon name="check" size={15} />
                      <span>Approve & Activate</span>
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm !text-rose-700 !border-rose-300 hover:!bg-rose-50 inline-flex items-center gap-1.5 font-semibold"
                      onClick={async () => {
                        const reason = window.prompt(`Reason for rejecting ${detail.fullName}'s registration (min 5 characters):`);
                        if (!reason) return;
                        try {
                          await api.post(`/employees/${detail.id}/reject`, { reason });
                          toast.success(`Registration rejected for ${detail.fullName}.`);
                          setDetail(null);
                          await load();
                        } catch (caught) {
                          toast.error(errorMessage(caught));
                        }
                      }}
                    >
                      <Icon name="x" size={15} />
                      <span>Reject</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            <Tabs
              tabs={[
                { value: 'overview', label: 'View Details' },
                { value: 'edit', label: 'Edit Employee' },
                { value: 'performance', label: 'Performance' },
              ]}
              value={modalTab}
              onChange={(value) => setModalTab(value as 'overview' | 'edit' | 'performance')}
            />

            {modalTab === 'overview' && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100">
                    <p className="text-xs font-medium text-ink-500">Tasks completed</p>
                    <p className="text-xl font-bold text-ink-900">{detail.stats.tasks.completed}/{detail.stats.tasks.total}</p>
                  </div>
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100">
                    <p className="text-xs font-medium text-ink-500">Present days (month)</p>
                    <p className="text-xl font-bold text-ink-900">{detail.stats.attendance.presentDays}</p>
                  </div>
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100">
                    <p className="text-xs font-medium text-ink-500">Hours logged (month)</p>
                    <p className="text-xl font-bold text-ink-900">{minutesToHours(detail.stats.attendance.totalMinutes)}</p>
                  </div>
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100">
                    <p className="text-xs font-medium text-ink-500">Latest KPI</p>
                    <p className="text-xl font-bold text-ink-900">{detail.stats.kpi ? `${detail.stats.kpi.score.toFixed(1)} · ${detail.stats.kpi.category}` : '—'}</p>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-ink-200 bg-white p-4">
                    <SectionHeader title="Contact & Personal Information" />
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Employee Number</dt><dd className="font-medium text-ink-800 font-mono">{detail.employeeCode}</dd></div>
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Email ID</dt><dd className="font-medium text-ink-800">{detail.email}</dd></div>
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Mobile No</dt><dd className="font-medium text-ink-800">{detail.mobile}</dd></div>
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Address</dt><dd className="font-medium text-ink-800">{detail.address || '—'}</dd></div>
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Emergency Contact</dt><dd className="font-medium text-ink-800">{detail.emergencyContact || '—'}</dd></div>
                      <div className="flex justify-between gap-2 py-1"><dt className="text-ink-500">Date of Birth</dt><dd className="font-medium text-ink-800">{detail.dateOfBirth ? formatDate(detail.dateOfBirth) : '—'}</dd></div>
                    </dl>
                  </div>

                  <div className="rounded-xl border border-ink-200 bg-white p-4">
                    <SectionHeader title="Role & Organisation" />
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Role</dt><dd className="font-medium text-ink-800">{detail.roleName}</dd></div>
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Department</dt><dd className="font-medium text-ink-800">{detail.departmentName ?? '—'}</dd></div>
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Designation</dt><dd className="font-medium text-ink-800">{detail.designationTitle ?? '—'}</dd></div>
                      <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Location</dt><dd className="font-medium text-ink-800">{detail.locationName ?? '—'}</dd></div>
                      <div className="flex justify-between gap-2 py-1"><dt className="text-ink-500">Reporting Manager</dt><dd className="font-medium text-ink-800">{detail.managerName ?? '—'}</dd></div>
                    </dl>
                  </div>
                </div>

                <div className="rounded-xl border border-ink-200 bg-white p-4">
                  <SectionHeader title="Activity & System Details" />
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 text-sm">
                    <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Joined date</dt><dd className="font-medium text-ink-800">{formatDate(detail.joiningDate)}</dd></div>
                    <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Last login</dt><dd className="font-medium text-ink-800">{formatDateTime(detail.lastLoginAt)}</dd></div>
                    <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Daily reports (month)</dt><dd className="font-medium text-ink-800">{detail.stats.reports.submitted} ({detail.stats.reports.approved} approved)</dd></div>
                    <div className="flex justify-between gap-2 py-1 border-b border-ink-100"><dt className="text-ink-500">Support tickets</dt><dd className="font-medium text-ink-800">{detail.stats.tickets.total} total · {detail.stats.tickets.open} open</dd></div>
                  </div>
                </div>
              </div>
            )}

            {modalTab === 'edit' && (
              <div className="space-y-5">
                <form className="space-y-4 rounded-xl border border-ink-200 bg-white p-4 shadow-2xs" onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    const payload: Record<string, unknown> = {
                      fullName: editForm.fullName,
                      mobile: editForm.mobile,
                      address: editForm.address || undefined,
                      emergencyContact: editForm.emergencyContact || undefined,
                      dateOfBirth: editForm.dateOfBirth || undefined,
                    };
                    // Only include employeeCode if user has permission to manage employees
                    if (has('employees.manage')) {
                      payload.employeeCode = editForm.employeeCode;
                    }
                    await api.patch(`/employees/${detail.id}`, payload);
                    toast.success('Profile details updated successfully.');
                    await openDetail(detail.id, 'edit');
                    await load();
                  } catch (caught) { toast.error(errorMessage(caught)); }
                }}>
                  <div className="flex items-center justify-between pb-2 border-b border-ink-100">
                    <p className="text-sm font-bold text-ink-900">Personal Details</p>
                    <span className="text-xs text-ink-400">Updates profile contact & emergency details</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Full name" required><input className="input" value={editForm.fullName} onChange={(event) => setEditForm({ ...editForm, fullName: event.target.value })} required /></Field>
                    <Field label={has('employees.manage') ? 'Employee Number *' : 'Employee Number'} required={has('employees.manage')} hint="Format: EMP-DVG-1604">
                      <input
                        className="input font-mono font-semibold"
                        value={editForm.employeeCode}
                        onChange={(event) => setEditForm({ ...editForm, employeeCode: event.target.value.toUpperCase() })}
                        placeholder="EMP-DVG-1604"
                        readOnly={!has('employees.manage')}
                        aria-readonly={!has('employees.manage')}
                      />
                      {!has('employees.manage') && <p className="mt-1 text-xs text-ink-400">Only administrators can modify the employee number</p>}
                    </Field>
                    <Field label="Mobile (10 digits)" required><input className="input" type="tel" inputMode="numeric" maxLength={10} value={editForm.mobile} onChange={(event) => setEditForm({ ...editForm, mobile: event.target.value.replace(/\D/g, '').slice(0, 10) })} required /></Field>
                    <Field label="Address"><input className="input" value={editForm.address} onChange={(event) => setEditForm({ ...editForm, address: event.target.value })} placeholder="Residential or work address" /></Field>
                    <Field label="Emergency contact"><input className="input" value={editForm.emergencyContact} onChange={(event) => setEditForm({ ...editForm, emergencyContact: event.target.value })} placeholder="Contact name & phone" /></Field>
                    <Field label="Date of birth"><input type="date" className="input" value={editForm.dateOfBirth} onChange={(event) => setEditForm({ ...editForm, dateOfBirth: event.target.value })} /></Field>
                  </div>
                  <div className="flex justify-end pt-1">
                    <button type="submit" className="btn-primary btn-sm">Save personal details</button>
                  </div>
                </form>

                {has('employees.manage') && (
                  <form className="space-y-4 rounded-xl border border-brand-200 bg-brand-50/20 p-4 shadow-2xs" onSubmit={async (event) => {
                    event.preventDefault();
                    try {
                      await api.patch(`/employees/${detail.id}/org-assignment`, {
                        roleId: orgForm.roleId ? Number(orgForm.roleId) : undefined,
                        departmentId: orgForm.departmentId ? Number(orgForm.departmentId) : null,
                        designationId: orgForm.designationId ? Number(orgForm.designationId) : null,
                        managerId: orgForm.managerId ? Number(orgForm.managerId) : null,
                        locationId: orgForm.locationId ? Number(orgForm.locationId) : null,
                        groupId: orgForm.groupId ? Number(orgForm.groupId) : null,
                        teamLeaderId: orgForm.teamLeaderId ? Number(orgForm.teamLeaderId) : null,
                        employmentType: orgForm.employmentType || undefined,
                        additionalLocationIds: orgForm.additionalLocationIds,
                      });
                      toast.success('Organisational assignment and role updated.');
                      await openDetail(detail.id, 'edit');
                      await load();
                    } catch (caught) { toast.error(errorMessage(caught)); }
                  }}>
                    <div className="flex items-center justify-between pb-2 border-b border-brand-100">
                      <p className="text-sm font-bold text-ink-900">Role & Organisational Assignment</p>
                      <span className="text-xs text-brand-700">Administrative assignment & hierarchy</span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Role">
                        <select className="input font-semibold" value={orgForm.roleId} onChange={(event) => setOrgForm({ ...orgForm, roleId: event.target.value })}>
                          {assignableRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
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
                          {structure?.designations && (data?.items ?? [])
                            .filter((employee) => employee.id !== detail.id && (employee.roleSlug?.includes('manager') || employee.roleSlug?.includes('admin') || employee.fullName.toLowerCase().includes('renuka') || employee.fullName.toLowerCase().includes('chetan')))
                            .map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}
                        </select>
                      </Field>
                      <Field label="Primary Location">
                        <select
                          className="input font-bold text-slate-800"
                          value={orgForm.locationId}
                          onChange={(event) => {
                            const nextLoc = event.target.value;
                            const allLoc = structure?.locations.find((l) => l.code === 'ALL' && String(l.id) === nextLoc);
                            if (allLoc) {
                              const allStoreIds = (structure?.locations ?? []).map((l) => l.id);
                              setOrgForm({ ...orgForm, locationId: nextLoc, additionalLocationIds: allStoreIds });
                            } else {
                              setOrgForm({ ...orgForm, locationId: nextLoc });
                            }
                          }}
                        >
                          <option value="">None / Unassigned</option>
                          {structure?.locations.map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.code === 'ALL'
                                ? '🌐 All Locations (BEL, DAV, SHI & HQ)'
                                : `${location.code} · ${location.name}`}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Employment type">
                        <select className="input" value={orgForm.employmentType} onChange={(event) => setOrgForm({ ...orgForm, employmentType: event.target.value })}>
                          {['full_time', 'part_time', 'contract', 'intern', 'probation'].map((value) => <option key={value} value={value}>{titleize(value)}</option>)}
                        </select>
                      </Field>

                      {/* Multi-Location & Store Access Matrix */}
                      <div className="col-span-full rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5 shadow-2xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                              <Icon name="building" size={14} className="text-brand-700" />
                              Store Location Access Permissions (All 3 Stores)
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Select which store locations this employee has access to view, supervise, or track tasks in.
                            </p>
                          </div>
                          <button
                            type="button"
                            className="btn-secondary btn-xs font-bold text-brand-700 border-brand-300 hover:bg-brand-50"
                            onClick={() => {
                              const storeIds = (structure?.locations ?? []).map((l) => l.id);
                              const allSelected = storeIds.length > 0 && storeIds.every((id) => orgForm.additionalLocationIds.includes(id));
                              setOrgForm({
                                ...orgForm,
                                additionalLocationIds: allSelected ? [] : storeIds,
                              });
                            }}
                          >
                            {(structure?.locations ?? []).every((l) => orgForm.additionalLocationIds.includes(l.id))
                              ? 'Deselect All Stores'
                              : 'Grant Access to All 3 Stores'}
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2 pt-0.5">
                          {(structure?.locations ?? []).map((loc) => {
                            const isSelected = orgForm.additionalLocationIds.includes(loc.id) || String(orgForm.locationId) === String(loc.id);
                            return (
                              <label
                                key={loc.id}
                                className={cx(
                                  'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer transition-all',
                                  isSelected
                                    ? 'bg-blue-50/90 border-blue-400 text-blue-950 shadow-2xs'
                                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50',
                                )}
                              >
                                <input
                                  type="checkbox"
                                  className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...orgForm.additionalLocationIds, loc.id]
                                      : orgForm.additionalLocationIds.filter((id) => id !== loc.id);
                                    setOrgForm({ ...orgForm, additionalLocationIds: next });
                                  }}
                                />
                                <span>{loc.code === 'ALL' ? '🌐 All Locations' : `${loc.code} · ${loc.name}`}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-end pt-1">
                      <button type="submit" className="btn-primary btn-sm font-bold">Save assignment & role</button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {modalTab === 'performance' && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100"><p className="text-xs text-ink-500">Tasks completed</p><p className="text-xl font-bold text-ink-900">{detail.stats.tasks.completed}/{detail.stats.tasks.total}</p></div>
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100"><p className="text-xs text-ink-500">Active tasks</p><p className="text-xl font-bold text-ink-900">{detail.stats.tasks.active}</p></div>
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100"><p className="text-xs text-ink-500">Overdue tasks</p><p className="text-xl font-bold text-ink-900">{detail.stats.tasks.overdue}</p></div>
                  <div className="rounded-lg bg-ink-50 p-3 border border-ink-100"><p className="text-xs text-ink-500">Late days</p><p className="text-xl font-bold text-ink-900">{detail.stats.attendance.lateDays}</p></div>
                </div>

                <div className="rounded-xl border border-ink-200 bg-white p-4">
                  <SectionHeader title="Monthly Attendance & Work Summary" />
                  <div className="mt-3 grid gap-3 sm:grid-cols-3 text-sm">
                    <div className="rounded-lg border border-ink-100 p-2.5 bg-ink-50/50"><p className="text-xs text-ink-400">Total days present</p><p className="text-base font-bold text-ink-800">{detail.stats.attendance.presentDays} days</p></div>
                    <div className="rounded-lg border border-ink-100 p-2.5 bg-ink-50/50"><p className="text-xs text-ink-400">Total work duration</p><p className="text-base font-bold text-ink-800">{minutesToHours(detail.stats.attendance.totalMinutes)}</p></div>
                    <div className="rounded-lg border border-ink-100 p-2.5 bg-ink-50/50"><p className="text-xs text-ink-400">Reports submitted</p><p className="text-base font-bold text-ink-800">{detail.stats.reports.submitted} submitted · {detail.stats.reports.approved} approved</p></div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <CreateEmployee
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        structure={structure}
        allowedLocations={allowedLocations}
        employees={employeesList}
        onCreated={() => { setCreateOpen(false); void load(); }}
      />

      {/* Delete Employee Confirmation Modal */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        title="Delete Employee Account"
        description={deleteTarget ? `Permanently remove ${deleteTarget.name} (${deleteTarget.code})` : undefined}
        size="md"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
              className="btn-primary btn-sm !bg-rose-600 hover:!bg-rose-700 !border-rose-600 text-white disabled:opacity-50"
              onClick={() => void confirmDeleteEmployee()}
            >
              {deleting ? 'Deleting…' : 'Permanently Delete'}
            </button>
          </div>
        }
      >
        {deleteTarget && (
          <div className="space-y-4">
            <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-xs text-rose-800">
              <p className="font-bold text-sm text-rose-900 mb-1 flex items-center gap-1.5">
                <Icon name="trash" size={16} />
                Warning: Irreversible Account Deletion
              </p>
              <ul className="list-disc list-inside space-y-1 text-rose-700">
                <li>The employee will be immediately signed out and blocked from signing in.</li>
                <li>Their registered email and mobile number will be released.</li>
                <li>All historical attendance logs, task submissions, and KPI reports are permanently archived.</li>
              </ul>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1.5">
                Type <span className="font-mono font-bold text-rose-600">DELETE</span> to confirm:
              </label>
              <input
                className="input w-full font-mono text-sm"
                placeholder="Type DELETE"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                autoFocus
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Approve Registration Modal */}
      <Modal
        open={Boolean(approveTarget)}
        onClose={() => setApproveTarget(null)}
        title={`Approve Registration: ${approveTarget?.fullName ?? ''}`}
        description="Verify and assign the employee's store location, group, role, and reporting line to activate their account."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setApproveTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary !bg-emerald-600 hover:!bg-emerald-700 !text-white !border-emerald-600 cursor-pointer"
              disabled={approvingBusy || !approveForm.locationId}
              onClick={() => void handleConfirmApprove()}
            >
              {approvingBusy ? 'Approving…' : 'Confirm & Activate'}
            </button>
          </>
        }
      >
        <div className="space-y-3.5">
          <div className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800 border border-emerald-200">
            Approving this registration will grant access to the system. Assign the store location and group to enforce location boundaries.
          </div>

          <Field label="Store Location" required hint="BEL, DAV, SHI, or HQ">
            <select
              className="input font-medium"
              value={approveForm.locationId}
              onChange={(e) => {
                const locId = e.target.value;
                setApproveForm({ ...approveForm, locationId: locId, groupId: '' });
                if (locId) {
                  api.get<{ items: Array<{ id: number; code: string; name: string }> }>(`/groups?locationId=${locId}`)
                    .then((res) => setTargetLocationGroups(res.items ?? []))
                    .catch(() => setTargetLocationGroups([]));
                } else {
                  setTargetLocationGroups([]);
                }
              }}
              required
            >
              <option value="">Select Location</option>
              {allowedLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} – {l.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Workforce Group">
            <select
              className="input"
              value={approveForm.groupId}
              onChange={(e) => setApproveForm({ ...approveForm, groupId: e.target.value })}
            >
              <option value="">Select Group (Optional)</option>
              {targetLocationGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code} – {g.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role" required>
              <select
                className="input"
                value={approveForm.roleId}
                onChange={(e) => setApproveForm({ ...approveForm, roleId: e.target.value })}
                required
              >
                <option value="">Select Role</option>
                {assignableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Department" required>
              <select
                className="input"
                value={approveForm.departmentId}
                onChange={(e) => setApproveForm({ ...approveForm, departmentId: e.target.value })}
                required
              >
                <option value="">Select Department</option>
                {structure?.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Reporting Manager">
            <select
              className="input"
              value={approveForm.managerId}
              onChange={(e) => setApproveForm({ ...approveForm, managerId: e.target.value })}
            >
              <option value="">Select Manager</option>
              {employeesList
                .filter((e) => e.id !== approveTarget?.id)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName} ({e.employeeCode})
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </Modal>

      {/* Transfer Location Modal */}
      <Modal
        open={Boolean(transferTarget)}
        onClose={() => setTransferTarget(null)}
        title={`Transfer Employee: ${transferTarget?.fullName ?? ''}`}
        description="Transfer employee to another store location and assign their new team group."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setTransferTarget(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="transfer-employee-form"
              className="btn-primary"
              disabled={transferringBusy || !transferForm.locationId}
            >
              {transferringBusy ? 'Transferring…' : 'Confirm Transfer'}
            </button>
          </>
        }
      >
        <form
          id="transfer-employee-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleConfirmTransfer();
          }}
          className="space-y-3.5"
        >
          <Field label="Current Location">
            <input
              className="input bg-ink-100 font-mono"
              value={`${transferTarget?.locationName ?? 'Unassigned'} (${transferTarget?.locationCode ?? '—'})`}
              disabled
            />
          </Field>

          <Field label="Destination Store Location" required>
            <select
              className="input font-medium"
              value={transferForm.locationId}
              onChange={(e) => {
                const locId = e.target.value;
                setTransferForm({ ...transferForm, locationId: locId, groupId: '' });
                if (locId) {
                  api.get<{ items: Array<{ id: number; code: string; name: string }> }>(`/groups?locationId=${locId}`)
                    .then((res) => setTargetLocationGroups(res.items ?? []))
                    .catch(() => setTargetLocationGroups([]));
                } else {
                  setTargetLocationGroups([]);
                }
              }}
              required
            >
              <option value="">Select New Store Location</option>
              {allowedLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} – {l.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="New Workforce Group">
            <select
              className="input"
              value={transferForm.groupId}
              onChange={(e) => setTransferForm({ ...transferForm, groupId: e.target.value })}
            >
              <option value="">Select Group in Destination Store (Optional)</option>
              {targetLocationGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code} – {g.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Reason for Transfer" required hint="Mandatory audit trail log">
            <textarea
              className="input min-h-[70px]"
              placeholder="e.g. Relocation to Davanagere Store per branch requirement."
              value={transferForm.reason}
              onChange={(e) => setTransferForm({ ...transferForm, reason: e.target.value })}
              required
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}

function CreateEmployee({
  open,
  onClose,
  structure,
  allowedLocations,
  employees,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  structure: Structure | null;
  allowedLocations: Array<{ id: number; code: string; name: string }>;
  employees: EmployeeRow[];
  onCreated: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const myLevel = user?.roleLevel ?? 0;
  const assignableRoles = (structure?.roles ?? []).filter((r) => myLevel >= 100 || r.level <= myLevel);
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    mobile: '',
    employeeCode: '',
    roleId: '',
    departmentId: '',
    designationId: '',
    managerId: '',
    locationId: '',
    groupId: '',
    employmentType: 'full_time',
    password: '',
  });
  const [availableGroups, setAvailableGroups] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ employeeCode: string } | null>(null);

  useEffect(() => {
    if (form.locationId) {
      api.get<{ items: Array<{ id: number; code: string; name: string }> }>(`/groups?locationId=${form.locationId}`)
        .then((res) => setAvailableGroups(res.items ?? []))
        .catch(() => setAvailableGroups([]));
    } else {
      setAvailableGroups([]);
    }
  }, [form.locationId]);

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
        groupId: form.groupId ? Number(form.groupId) : null,
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
    <Modal
      open={open}
      onClose={onClose}
      title="Add employee"
      size="lg"
      description="Creates an active account with the selected store location and role. Share the temporary password securely."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
          {!created && (
            <button className="btn-primary" form="employee-form" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create employee'}
            </button>
          )}
        </>
      }
    >
      {created ? (
        <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">
          Employee created with code <strong>{created.employeeCode}</strong>. They can sign in with their email and the password you set.
        </div>
      ) : (
        <form id="employee-form" onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" required>
              <input
                className="input"
                value={form.fullName}
                onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                required
              />
            </Field>
            <Field label="Employee Number *" required hint="Format: EMP-DVG-1604">
              <input
                className="input font-mono font-semibold"
                value={form.employeeCode}
                onChange={(event) => setForm({ ...form, employeeCode: event.target.value.toUpperCase() })}
                placeholder="EMP-DVG-1604"
                required
              />
            </Field>
            <Field label="Email" required>
              <input
                type="email"
                className="input"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                required
              />
            </Field>
            <Field label="Mobile (10 digits)" required hint="10 numbers only">
              <input
                className="input"
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="98XXXXXXXX"
                value={form.mobile}
                onChange={(event) => setForm({ ...form, mobile: event.target.value.replace(/\D/g, '').slice(0, 10) })}
                required
              />
            </Field>

            <Field label="Store Location" required hint="BEL, DAV, SHI, HQ">
              <select
                className="input font-medium"
                value={form.locationId}
                onChange={(event) => {
                  const locId = event.target.value;
                  const selectedLoc = allowedLocations.find((l) => String(l.id) === locId);
                  let locPrefix = 'DVG';
                  if (selectedLoc) {
                    if (selectedLoc.code === 'DAV' || selectedLoc.code === 'DVG') locPrefix = 'DVG';
                    else if (selectedLoc.code === 'BEL' || selectedLoc.code === 'BLG') locPrefix = 'BLG';
                    else if (selectedLoc.code === 'SHI' || selectedLoc.code === 'SMG') locPrefix = 'SMG';
                    else if (selectedLoc.code === 'HQ') locPrefix = 'HQ';
                    else if (selectedLoc.code === 'ALL') locPrefix = 'DVG';
                  }
                  const current = form.employeeCode.trim();
                  const newCode = (!current || /^EMP(-[A-Z0-9]+)?(-\d*)?$/i.test(current))
                    ? `EMP-${locPrefix}-`
                    : current;
                  setForm({ ...form, locationId: locId, groupId: '', employeeCode: newCode });
                }}
                required
              >
                <option value="">Select Location</option>
                {allowedLocations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.code} – {loc.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Workforce Group">
              <select
                className="input"
                value={form.groupId}
                onChange={(event) => setForm({ ...form, groupId: event.target.value })}
              >
                <option value="">Select Group (Optional)</option>
                {availableGroups.map((grp) => (
                  <option key={grp.id} value={grp.id}>
                    {grp.code} – {grp.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Role" required>
              <select
                className="input"
                value={form.roleId}
                onChange={(event) => setForm({ ...form, roleId: event.target.value })}
                required
              >
                <option value="">Select role</option>
                {assignableRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Department" required>
              <select
                className="input"
                value={form.departmentId}
                onChange={(event) => setForm({ ...form, departmentId: event.target.value })}
                required
              >
                <option value="">Select department</option>
                {structure?.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Designation">
              <select
                className="input"
                value={form.designationId}
                onChange={(event) => setForm({ ...form, designationId: event.target.value })}
              >
                <option value="">Select designation</option>
                {structure?.designations.map((designation) => (
                  <option key={designation.id} value={designation.id}>
                    {designation.title}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Reporting manager">
              <select
                className="input"
                value={form.managerId}
                onChange={(event) => setForm({ ...form, managerId: event.target.value })}
              >
                <option value="">Select manager</option>
                {employees
                  .filter((e) => (e.roleSlug?.includes('manager') || e.roleSlug?.includes('admin') || e.fullName.toLowerCase().includes('renuka') || e.fullName.toLowerCase().includes('chetan') || (user?.roleLevel ?? 0) >= 70))
                  .map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.fullName} ({employee.employeeCode})
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Employment type">
              <select
                className="input"
                value={form.employmentType}
                onChange={(event) => setForm({ ...form, employmentType: event.target.value })}
              >
                {['full_time', 'part_time', 'contract', 'intern', 'probation'].map((value) => (
                  <option key={value} value={value}>
                    {titleize(value)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Temporary password" required hint="Minimum 10 characters">
              <input
                type="password"
                className="input"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                minLength={10}
                required
              />
            </Field>
          </div>
        </form>
      )}
    </Modal>
  );
}
