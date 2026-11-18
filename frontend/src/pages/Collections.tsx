import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { openExternal } from '../lib/native';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Pagination,
  SectionHeader,
  Skeleton,
  StatCard,
  StatusBadge,
  Tabs,
} from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime } from '../lib/format';

interface CollectionRow {
  id: number;
  referenceNo: string;
  customerName: string;
  customerContact: string | null;
  invoiceNo: string | null;
  amountDue: number;
  amountCollected: number;
  outstanding: number;
  currency: string;
  paymentMode: string | null;
  status: string;
  approvalStatus: string;
  dueDate: string;
  collectedOn: string | null;
  notes: string | null;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  locationName: string | null;
  approvedByName: string | null;
  rejectionReason: string | null;
  overdue: boolean;
  createdAt: string;
}

interface DashboardData {
  summary: {
    records: number;
    due: number;
    collected: number;
    outstanding: number;
    pendingCount: number;
    pendingAmount: number;
    overdueCount: number;
    overdueAmount: number;
    approvals: number;
    collectedToday: number;
    collectedThisMonth: number;
  };
  byStatus: { status: string; total: number; amount: number }[];
  byDepartment: { department: string; collected: number; records: number }[];
  recent: {
    id: number;
    referenceNo: string;
    customerName: string;
    amountDue: number;
    amountCollected: number;
    currency: string;
    status: string;
    approvalStatus: string;
    dueDate: string;
    employeeName: string;
  }[];
}

interface Meta {
  statuses: { value: string; label: string }[];
  approvals: { value: string; label: string }[];
  paymentModes: { value: string; label: string }[];
}

interface Option {
  id: number;
  name: string;
}

interface EmployeeOption {
  id: number;
  full_name: string;
  employee_code: string;
}

interface FormState {
  customerName: string;
  customerContact: string;
  invoiceNo: string;
  amountDue: string;
  amountCollected: string;
  paymentMode: string;
  dueDate: string;
  collectedOn: string;
  employeeId: string;
  departmentId: string;
  locationId: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  customerName: '',
  customerContact: '',
  invoiceNo: '',
  amountDue: '',
  amountCollected: '0',
  paymentMode: '',
  dueDate: new Date().toISOString().slice(0, 10),
  collectedOn: '',
  employeeId: '',
  departmentId: '',
  locationId: '',
  notes: '',
};

const money = (value: number, currency = 'INR', compact = false) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: compact ? 0 : 2,
    notation: compact ? 'compact' : 'standard',
  }).format(Number.isFinite(value) ? value : 0);

function monthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

function monthEnd(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
}

export default function Collections() {
  useDocumentTitle('Collections');
  const { canAny, has } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'overview' | 'records'>('overview');
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [records, setRecords] = useState<{ items: CollectionRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [locations, setLocations] = useState<Option[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    search: '',
    status: '',
    approvalStatus: '',
    employeeId: '',
    departmentId: '',
    locationId: '',
    from: monthStart(),
    to: monthEnd(),
  });
  const [searchDraft, setSearchDraft] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<CollectionRow | null>(null);
  const [detail, setDetail] = useState<CollectionRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const canView = canAny('collections.view.own', 'collections.view.team', 'collections.view.all');
  const canCreate = has('collections.create');
  const canEdit = has('collections.edit');
  const canApprove = has('collections.approve');
  const canDelete = has('collections.delete');

  const query = useMemo(() => {
    const search = new URLSearchParams();
    if (filters.search) search.set('search', filters.search);
    if (filters.status) search.set('status', filters.status);
    if (filters.approvalStatus) search.set('approvalStatus', filters.approvalStatus);
    if (filters.employeeId) search.set('employeeId', filters.employeeId);
    if (filters.departmentId) search.set('departmentId', filters.departmentId);
    if (filters.locationId) search.set('locationId', filters.locationId);
    if (filters.from) search.set('from', filters.from);
    if (filters.to) search.set('to', filters.to);
    return search;
  }, [filters]);

  useEffect(() => {
    if (!canView) return;
    api.get<Meta>('/collections/meta').then(setMeta).catch(() => undefined);
    api
      .get<{ departments: Option[]; locations: Option[] }>('/employees/structure')
      .then((result) => {
        setDepartments(result.departments ?? []);
        setLocations(result.locations ?? []);
      })
      .catch(() => undefined);
    api
      .get<{ employees: EmployeeOption[] }>('/employees/picker')
      .then((result) => setEmployees(result.employees ?? []))
      .catch(() => undefined);
  }, [canView]);

  const loadDashboard = useCallback(async () => {
    try {
      const search = new URLSearchParams();
      if (filters.from) search.set('from', filters.from);
      if (filters.to) search.set('to', filters.to);
      setDashboard(await api.get<DashboardData>(`/collections/dashboard?${search.toString()}`));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from, filters.to]);

  const loadRecords = useCallback(async () => {
    try {
      const search = new URLSearchParams(query);
      search.set('page', String(page));
      search.set('pageSize', '20');
      setRecords(await api.get(`/collections?${search.toString()}`));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, page]);

  useEffect(() => {
    if (!canView) return;
    void loadDashboard();
  }, [canView, loadDashboard]);

  useEffect(() => {
    if (!canView || tab !== 'records') return;
    setRecords(null);
    void loadRecords();
  }, [canView, tab, loadRecords]);

  const refresh = async () => {
    await Promise.all([loadDashboard(), tab === 'records' ? loadRecords() : Promise.resolve()]);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, employeeId: '' });
    setFormOpen(true);
  };

  const openEdit = (row: CollectionRow) => {
    setEditing(row);
    setForm({
      customerName: row.customerName,
      customerContact: row.customerContact ?? '',
      invoiceNo: row.invoiceNo ?? '',
      amountDue: String(row.amountDue),
      amountCollected: String(row.amountCollected),
      paymentMode: row.paymentMode ?? '',
      dueDate: row.dueDate,
      collectedOn: row.collectedOn ?? '',
      employeeId: String(row.employeeId),
      departmentId: '',
      locationId: '',
      notes: row.notes ?? '',
    });
    setFormOpen(true);
    setDetail(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const amountDue = Number(form.amountDue);
    const amountCollected = Number(form.amountCollected || 0);
    if (!form.customerName.trim()) {
      toast.error('Enter the customer name.');
      return;
    }
    if (!Number.isFinite(amountDue) || amountDue <= 0) {
      toast.error('Amount due must be greater than zero.');
      return;
    }
    if (amountCollected > amountDue) {
      toast.error('Collected amount cannot exceed the amount due.');
      return;
    }
    if (form.collectedOn && !form.dueDate) {
      toast.error('Enter the due date.');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        customerName: form.customerName.trim(),
        customerContact: form.customerContact.trim() || null,
        invoiceNo: form.invoiceNo.trim() || null,
        amountDue,
        amountCollected,
        paymentMode: form.paymentMode || null,
        dueDate: form.dueDate,
        collectedOn: form.collectedOn || null,
        employeeId: form.employeeId ? Number(form.employeeId) : undefined,
        departmentId: form.departmentId ? Number(form.departmentId) : null,
        locationId: form.locationId ? Number(form.locationId) : null,
        notes: form.notes.trim() || null,
      };
      if (editing) await api.patch(`/collections/${editing.id}`, payload);
      else await api.post('/collections', payload);
      toast.success(editing ? 'Collection record updated.' : 'Collection record created.');
      setFormOpen(false);
      await refresh();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (row: CollectionRow, approve: boolean) => {
    let reason: string | undefined;
    if (!approve) {
      const input = window.prompt('Reason for rejecting this collection record:');
      if (!input) return;
      reason = input;
    }
    setBusy(true);
    try {
      await api.post(`/collections/${row.id}/decision`, { approve, reason });
      toast.success(approve ? 'Collection approved.' : 'Collection rejected.');
      setDetail(null);
      await refresh();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: CollectionRow) => {
    if (!window.confirm(`Delete ${row.referenceNo}? The record is archived, not permanently destroyed.`)) return;
    setBusy(true);
    try {
      await api.del(`/collections/${row.id}`);
      toast.success('Collection record deleted.');
      setDetail(null);
      await refresh();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const exportFile = (format: 'xlsx' | 'pdf') => {
    const search = new URLSearchParams(query);
    search.set('type', 'collections');
    search.set('format', format);
    void openExternal(`/api/exports?${search.toString()}`);
  };

  if (!canView) {
    return (
      <Card className="card-pad">
        <EmptyState title="Collection access required" description="Your role does not include the collection module. Ask an administrator for access." />
      </Card>
    );
  }

  const summary = dashboard?.summary;
  const filterCount = [filters.status, filters.approvalStatus, filters.employeeId, filters.departmentId, filters.locationId].filter(Boolean).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Collections"
        description="Customer payment collection register with approval workflow, hierarchy-scoped visibility and downloadable reports."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => exportFile('xlsx')}>
              <Icon name="download" size={14} /> Excel
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => exportFile('pdf')}>
              <Icon name="download" size={14} /> PDF
            </button>
            {canCreate && (
              <button type="button" className="btn-primary btn-sm" onClick={openCreate}>
                <Icon name="plus" size={14} /> New collection
              </button>
            )}
          </>
        }
      />

      <Tabs
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'records', label: 'Records' },
        ]}
        value={tab}
        onChange={(value) => setTab(value as 'overview' | 'records')}
      />

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px]">
          <Field label="Due from">
            <input type="date" className="input" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </Field>
        </div>
        <div className="min-w-[180px]">
          <Field label="Due to">
            <input type="date" className="input" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </Field>
        </div>
        <div className="min-w-[170px]">
          <Field label="Status">
            <select className="input" value={filters.status} onChange={(event) => { setFilters({ ...filters, status: event.target.value }); setPage(1); }}>
              <option value="">All statuses</option>
              {meta?.statuses.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="min-w-[170px]">
          <Field label="Approval">
            <select className="input" value={filters.approvalStatus} onChange={(event) => { setFilters({ ...filters, approvalStatus: event.target.value }); setPage(1); }}>
              <option value="">All approvals</option>
              {meta?.approvals.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="min-w-[180px]">
          <Field label="Employee">
            <select className="input" value={filters.employeeId} onChange={(event) => { setFilters({ ...filters, employeeId: event.target.value }); setPage(1); }}>
              <option value="">All employees</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>{employee.full_name} · {employee.employee_code}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="min-w-[170px]">
          <Field label="Department">
            <select className="input" value={filters.departmentId} onChange={(event) => { setFilters({ ...filters, departmentId: event.target.value }); setPage(1); }}>
              <option value="">All departments</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="min-w-[160px]">
          <Field label="Location">
            <select className="input" value={filters.locationId} onChange={(event) => { setFilters({ ...filters, locationId: event.target.value }); setPage(1); }}>
              <option value="">All locations</option>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </Field>
        </div>
        {filterCount > 0 && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setFilters({ ...filters, status: '', approvalStatus: '', employeeId: '', departmentId: '', locationId: '' });
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {tab === 'overview' && (
        <>
          {!dashboard ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((item) => <Card key={item} className="card-pad"><Skeleton lines={3} /></Card>)}
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="Collected this month" value={money(summary!.collectedThisMonth, 'INR', true)} hint={`${money(summary!.collectedToday, 'INR', true)} today`} tone="success" icon={<Icon name="wallet" size={18} />} />
                <StatCard label="Outstanding" value={money(summary!.outstanding, 'INR', true)} hint={`${summary!.pendingCount} pending record(s)`} tone="warning" icon={<Icon name="clock" size={18} />} />
                <StatCard label="Overdue" value={money(summary!.overdueAmount, 'INR', true)} hint={`${summary!.overdueCount} past due date`} tone="danger" icon={<Icon name="clock" size={18} />} />
                <StatCard label="Awaiting approval" value={summary!.approvals} hint={`${summary!.records} record(s) in range`} tone="neutral" icon={<Icon name="check" size={18} />} />
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="card-pad">
                  <SectionHeader title="Status mix" description="Records in the selected period" />
                  <div className="mt-3 space-y-2">
                    {['pending', 'partial', 'collected', 'cancelled'].map((status) => {
                      const item = dashboard.byStatus.find((entry) => entry.status === status);
                      const total = summary!.records || 1;
                      const percent = Math.round(((item?.total ?? 0) / total) * 100);
                      return (
                        <div key={status}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="capitalize text-ink-600">{status}</span>
                            <span className="text-ink-500">{item?.total ?? 0} · {percent}%</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                            <div className={cx('h-full rounded-full', status === 'collected' ? 'bg-emerald-500' : status === 'pending' ? 'bg-amber-500' : status === 'partial' ? 'bg-brand-500' : 'bg-ink-400')} style={{ width: `${percent}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>

                <Card className="card-pad lg:col-span-2">
                  <SectionHeader title="Collected by department" description="Top departments in the selected period" />
                  {dashboard.byDepartment.length === 0 ? (
                    <EmptyState compact title="No collections in this period" description="Adjust the date range or record a new collection." />
                  ) : (
                    <div className="mt-3 space-y-2">
                      {dashboard.byDepartment.map((row) => {
                        const max = Math.max(...dashboard.byDepartment.map((entry) => entry.collected), 1);
                        return (
                          <div key={row.department} className="flex items-center gap-3">
                            <span className="w-32 shrink-0 truncate text-xs text-ink-600">{row.department}</span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                              <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.round((row.collected / max) * 100)}%` }} />
                            </div>
                            <span className="w-24 shrink-0 text-right text-xs font-medium text-ink-700">{money(row.collected, 'INR', true)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              </div>

              <Card>
                <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
                  <p className="text-sm font-semibold text-ink-800">Recent records</p>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setTab('records')}>View all records</button>
                </div>
                {dashboard.recent.length === 0 ? (
                  <EmptyState title="No collection records yet" description={canCreate ? 'Create the first record to start tracking collections.' : 'Records created by your team will appear here.'} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="table-base">
                      <thead><tr><th>Reference</th><th>Customer</th><th>Collector</th><th>Due</th><th>Collected</th><th>Status</th><th>Approval</th><th>Due date</th></tr></thead>
                      <tbody>
                        {dashboard.recent.map((row) => (
                          <tr key={row.id} className="cursor-pointer" onClick={() => setTab('records')}>
                            <td className="whitespace-nowrap font-medium text-ink-800">{row.referenceNo}</td>
                            <td className="text-ink-700">{row.customerName}</td>
                            <td className="text-xs text-ink-500">{row.employeeName}</td>
                            <td className="whitespace-nowrap">{money(row.amountDue, row.currency)}</td>
                            <td className="whitespace-nowrap">{money(row.amountCollected, row.currency)}</td>
                            <td><StatusBadge status={row.status} /></td>
                            <td><StatusBadge status={row.approvalStatus} /></td>
                            <td className="whitespace-nowrap text-xs text-ink-500">{formatDate(row.dueDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </>
      )}

      {tab === 'records' && (
        <Card>
          <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
            <form
              className="flex min-w-[240px] flex-1 items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFilters({ ...filters, search: searchDraft.trim() });
                setPage(1);
              }}
            >
              <div className="flex-1">
                <Field label="Search">
                  <div className="relative">
                    <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                    <input
                      className="input pl-8"
                      placeholder="Customer, reference or invoice"
                      value={searchDraft}
                      onChange={(event) => setSearchDraft(event.target.value)}
                    />
                  </div>
                </Field>
              </div>
              <button type="submit" className="btn-secondary btn-sm">Search</button>
              {filters.search && (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    setSearchDraft('');
                    setFilters({ ...filters, search: '' });
                    setPage(1);
                  }}
                >
                  Reset
                </button>
              )}
            </form>
            <p className="ml-auto text-xs text-ink-500">
              {records ? `${records.total} record(s) in range` : 'Loading…'}
            </p>
          </div>

          {!records ? (
            <div className="p-4"><Skeleton lines={8} /></div>
          ) : records.items.length === 0 ? (
            <EmptyState
              title="No collection records"
              description="Nothing matches the current filters. Adjust the period or create a record."
              action={canCreate ? <button type="button" className="btn-primary btn-sm" onClick={openCreate}>New collection</button> : undefined}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr><th>Reference</th><th>Customer</th><th>Invoice</th><th>Collector</th><th>Due</th><th>Collected</th><th>Outstanding</th><th>Status</th><th>Approval</th><th>Due date</th></tr>
                  </thead>
                  <tbody>
                    {records.items.map((row) => (
                      <tr key={row.id} className="cursor-pointer" onClick={() => setDetail(row)}>
                        <td className="whitespace-nowrap font-medium text-brand-700">{row.referenceNo}</td>
                        <td>
                          <span className="block text-ink-800">{row.customerName}</span>
                          <span className="block text-[11px] text-ink-400">{row.customerContact ?? '—'}</span>
                        </td>
                        <td className="text-xs text-ink-500">{row.invoiceNo ?? '—'}</td>
                        <td>
                          <span className="block text-ink-700">{row.employeeName}</span>
                          <span className="block text-[11px] text-ink-400">{row.departmentName ?? row.employeeCode}</span>
                        </td>
                        <td className="whitespace-nowrap">{money(row.amountDue, row.currency)}</td>
                        <td className="whitespace-nowrap text-emerald-700">{money(row.amountCollected, row.currency)}</td>
                        <td className={cx('whitespace-nowrap font-medium', row.outstanding > 0 ? 'text-amber-700' : 'text-ink-500')}>{money(row.outstanding, row.currency)}</td>
                        <td>
                          <StatusBadge status={row.status} />
                          {row.overdue && <Badge tone="danger" className="ml-1">Overdue</Badge>}
                        </td>
                        <td><StatusBadge status={row.approvalStatus} /></td>
                        <td className="whitespace-nowrap text-xs text-ink-500">{formatDate(row.dueDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={records.page} pageSize={records.pageSize} total={records.total} onPage={setPage} />
            </>
          )}
        </Card>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Edit ${editing.referenceNo}` : 'New collection'}
        description="Amounts are stored exactly as entered and validated server-side."
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setFormOpen(false)}>Cancel</button>
            <button type="submit" form="collection-form" className="btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create record'}</button>
          </>
        }
      >
        <form id="collection-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer name" required>
            <input className="input" value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })} required minLength={2} maxLength={160} />
          </Field>
          <Field label="Customer contact">
            <input className="input" value={form.customerContact} onChange={(event) => setForm({ ...form, customerContact: event.target.value })} maxLength={40} placeholder="Phone or email" />
          </Field>
          <Field label="Invoice number">
            <input className="input" value={form.invoiceNo} onChange={(event) => setForm({ ...form, invoiceNo: event.target.value })} maxLength={80} />
          </Field>
          <Field label="Collector" hint="Defaults to you. Managers may assign within their reporting structure.">
            <select className="input" value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.target.value })}>
              <option value="">Me</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name} · {employee.employee_code}</option>)}
            </select>
          </Field>
          <Field label="Amount due" required>
            <input type="number" min="0.01" step="0.01" className="input" value={form.amountDue} onChange={(event) => setForm({ ...form, amountDue: event.target.value })} required />
          </Field>
          <Field label="Amount collected">
            <input type="number" min="0" step="0.01" className="input" value={form.amountCollected} onChange={(event) => setForm({ ...form, amountCollected: event.target.value })} />
          </Field>
          <Field label="Due date" required>
            <input type="date" className="input" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} required />
          </Field>
          <Field label="Collected on">
            <input type="date" className="input" value={form.collectedOn} onChange={(event) => setForm({ ...form, collectedOn: event.target.value })} />
          </Field>
          <Field label="Payment mode">
            <select className="input" value={form.paymentMode} onChange={(event) => setForm({ ...form, paymentMode: event.target.value })}>
              <option value="">Not recorded</option>
              {meta?.paymentModes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
          <Field label="Department">
            <select className="input" value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
              <option value="">Default from collector</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </Field>
          <Field label="Location">
            <select className="input" value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>
              <option value="">Default from collector</option>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <textarea className="input min-h-[80px]" maxLength={1000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Payment reference, follow-up context…" />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.referenceNo} · ${detail.customerName}` : 'Collection'}
        description={detail ? `Recorded ${formatDateTime(detail.createdAt)}` : undefined}
        size="md"
        footer={
          detail ? (
            <>
              {canDelete && (
                <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={() => void remove(detail)}>Delete</button>
              )}
              {canApprove && detail.approvalStatus === 'pending' && (
                <>
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void decide(detail, false)}>Reject</button>
                  <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void decide(detail, true)}>Approve</button>
                </>
              )}
              {canEdit && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => openEdit(detail)}>Edit record</button>
              )}
            </>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <StatusBadge status={detail.status} />
              <StatusBadge status={detail.approvalStatus} />
              {detail.overdue && <Badge tone="danger">Overdue</Badge>}
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[
                ['Amount due', money(detail.amountDue, detail.currency)],
                ['Collected', money(detail.amountCollected, detail.currency)],
                ['Outstanding', money(detail.outstanding, detail.currency)],
                ['Payment mode', detail.paymentMode?.replace(/_/g, ' ') ?? 'Not recorded'],
                ['Due date', formatDate(detail.dueDate)],
                ['Collected on', detail.collectedOn ? formatDate(detail.collectedOn) : 'Not collected'],
                ['Collector', `${detail.employeeName} · ${detail.employeeCode}`],
                ['Department', detail.departmentName ?? '—'],
                ['Location', detail.locationName ?? '—'],
                ['Invoice', detail.invoiceNo ?? '—'],
                ['Contact', detail.customerContact ?? '—'],
                ['Reviewed by', detail.approvedByName ?? 'Pending'],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3 border-b border-ink-100 py-1.5">
                  <dt className="text-ink-500">{label}</dt>
                  <dd className="text-right font-medium text-ink-800">{value}</dd>
                </div>
              ))}
            </dl>
            {detail.rejectionReason && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">Rejected: {detail.rejectionReason}</p>
            )}
            {detail.notes && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{detail.notes}</p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
