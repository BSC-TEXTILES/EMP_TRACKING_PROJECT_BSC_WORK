import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDate, formatDateTime, titleize } from '../lib/format';
import type { LeaveItem } from '../lib/types';

interface LeaveType {
  id: number;
  name: string;
  code: string;
  annual_quota: number;
  is_paid: number;
  requires_document: number;
}

interface Balance {
  leaveTypeId: number;
  name: string;
  code: string;
  allocated: number;
  used: number;
  available: number;
  requiresDocument: boolean;
  isPaid: boolean;
}

interface Holiday {
  id: number;
  name: string;
  holiday_date: string;
  is_optional: number;
}

export default function Leave() {
  useDocumentTitle('Leave & holidays');
  const { has, user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'mine' | 'team' | 'all'>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'all' && has('leave.view.all')) return 'all';
    if (requested === 'team' && has('leave.view.team')) return 'team';
    return 'mine';
  });
  const [items, setItems] = useState<LeaveItem[] | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [applyOpen, setApplyOpen] = useState(false);
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
  const [document, setDocument] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const scope = tab === 'mine' ? 'mine' : tab;
      const result = await api.get<{ items: LeaveItem[] }>(`/leave?scope=${scope}`);
      setItems(result.items);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    Promise.all([
      api.get<{ balances: Balance[] }>('/leave/balances'),
      api.get<{ types: LeaveType[] }>('/leave/types'),
      api.get<{ holidays: Holiday[] }>('/leave/holidays'),
    ])
      .then(([balanceResult, typeResult, holidayResult]) => {
        setBalances(balanceResult.balances);
        setTypes(typeResult.types);
        setHolidays(holidayResult.holidays);
      })
      .catch((caught) => toast.error(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      let documentFileId: number | undefined;
      if (document) documentFileId = (await api.upload<{ id: number }>(document)).id;
      await api.post('/leave', {
        leaveTypeId: Number(form.leaveTypeId),
        startDate: form.startDate,
        endDate: form.endDate,
        reason: form.reason,
        documentFileId,
      });
      toast.success('Leave request submitted for approval.');
      setApplyOpen(false);
      setForm({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
      setDocument(null);
      await load();
      const refreshed = await api.get<{ balances: Balance[] }>('/leave/balances');
      setBalances(refreshed.balances);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: number, approve: boolean, stage: 'manager' | 'hr') => {
    const note = approve ? window.prompt('Optional note:') ?? '' : window.prompt('Reason for rejection:') ?? '';
    if (!approve && !note) return;
    try {
      await api.post(`/leave/${id}/decide`, { approve, note: note || undefined, stage });
      toast.success(approve ? 'Leave approved.' : 'Leave rejected.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const selectedType = types.find((type) => type.id === Number(form.leaveTypeId));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leave & holiday management"
        description="Two-stage approval (manager, then HR) with balance enforcement and a company holiday calendar."
        actions={has('leave.apply') ? <button type="button" className="btn-primary btn-sm" onClick={() => setApplyOpen(true)}><Icon name="plus" size={15} /> Apply for leave</button> : undefined}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {balances.map((balance) => (
          <Card key={balance.leaveTypeId} className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{balance.name}</p>
                <p className="mt-1 text-2xl font-semibold text-ink-900">{balance.available}<span className="text-sm text-ink-400">/{balance.allocated}</span></p>
                <p className="text-xs text-ink-400">{balance.used} used</p>
              </div>
              <Badge tone={balance.isPaid ? 'success' : 'neutral'}>{balance.isPaid ? 'Paid' : 'Unpaid'}</Badge>
            </div>
          </Card>
        ))}
        {balances.length === 0 && <Card className="p-4 text-sm text-ink-500 sm:col-span-2 lg:col-span-4">Leave balances load after your first approved allocation.</Card>}
      </div>

      <Card>
        <div className="px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'mine', label: 'My requests' },
              ...(has('leave.view.team') ? [{ value: 'team', label: 'Team requests' }] : []),
              ...(has('leave.view.all') ? [{ value: 'all', label: 'All requests' }] : []),
            ]}
            value={tab}
            onChange={(value) => setTab(value as 'mine' | 'team' | 'all')}
          />
        </div>
        {!items ? (
          <div className="p-4"><Skeleton lines={5} /></div>
        ) : items.length === 0 ? (
          <EmptyState title="No leave requests" description="Applications in this scope will appear here." />
        ) : (
          <div className="divide-y divide-ink-100">
            {items.map((leave) => (
              <div key={leave.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink-900">{leave.leaveType}</p>
                    <StatusBadge status={leave.status} />
                    <Badge tone="neutral">{leave.days} day(s)</Badge>
                    {tab !== 'mine' && <Badge tone="brand">{leave.employeeName}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-ink-500">{formatDate(leave.startDate)} → {formatDate(leave.endDate)} · applied {formatDateTime(leave.createdAt)}</p>
                  <p className="mt-1 text-sm text-ink-600">{leave.reason}</p>
                  {leave.decisionNote && <p className="mt-1 text-xs text-ink-500">Decision note: {leave.decisionNote}</p>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {leave.canApproveManager && (
                    <>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void decide(leave.id, true, 'manager')}>Approve</button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void decide(leave.id, false, 'manager')}>Reject</button>
                    </>
                  )}
                  {leave.canApproveHr && (
                    <>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void decide(leave.id, true, 'hr')}>HR approve</button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void decide(leave.id, false, 'hr')}>HR reject</button>
                    </>
                  )}
                  {leave.canCancel && (
                    <button type="button" className="btn-ghost btn-sm" onClick={async () => {
                      if (!window.confirm('Cancel this leave request?')) return;
                      try {
                        await api.post(`/leave/${leave.id}/cancel`);
                        await load();
                        toast.success('Leave request cancelled.');
                      } catch (caught) { toast.error(errorMessage(caught)); }
                    }}>Cancel</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="card-pad">
        <SectionHeader title="Holiday calendar" description="Company holidays for the next months" />
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {holidays.map((holiday) => (
            <div key={holiday.id} className="flex items-center gap-2 rounded-lg border border-ink-200 p-2.5">
              <div className="flex h-9 w-9 flex-col items-center justify-center rounded-lg bg-violet-50 text-[10px] font-semibold text-violet-700">
                <span>{new Date(holiday.holiday_date).getDate()}</span>
                <span className="uppercase">{new Date(holiday.holiday_date).toLocaleString('en-GB', { month: 'short' })}</span>
              </div>
              <div>
                <p className="text-sm font-medium text-ink-800">{holiday.name}</p>
                <p className="text-[11px] text-ink-400">{formatDate(holiday.holiday_date)}{holiday.is_optional ? ' · optional' : ''}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Modal open={applyOpen} onClose={() => setApplyOpen(false)} title="Apply for leave" description="Your manager approves first, then HR. Balances are validated on the server."
        footer={<><button className="btn-secondary" onClick={() => setApplyOpen(false)}>Cancel</button><button className="btn-primary" form="leave-form" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</button></>}>
        <form id="leave-form" onSubmit={apply} className="space-y-4">
          <Field label="Leave type" required>
            <select className="input" value={form.leaveTypeId} onChange={(event) => setForm({ ...form, leaveTypeId: event.target.value })} required>
              <option value="">Select leave type</option>
              {types.map((type) => {
                const balance = balances.find((item) => item.leaveTypeId === type.id);
                return <option key={type.id} value={type.id}>{type.name} ({balance?.available ?? type.annual_quota} available)</option>;
              })}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Start date" required>
              <input type="date" className="input" value={form.startDate} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setForm({ ...form, startDate: event.target.value })} required />
            </Field>
            <Field label="End date" required>
              <input type="date" className="input" value={form.endDate} min={form.startDate || new Date().toISOString().slice(0, 10)} onChange={(event) => setForm({ ...form, endDate: event.target.value })} required />
            </Field>
          </div>
          <Field label="Reason" required>
            <textarea className="input min-h-[80px]" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} minLength={10} required />
          </Field>
          {selectedType?.requires_document ? (
            <Field label="Supporting document" hint="Required for this leave type" required>
              <input type="file" className="input" onChange={(event) => setDocument(event.target.files?.[0] ?? null)} required />
            </Field>
          ) : (
            <Field label="Supporting document (optional)">
              <input type="file" className="input" onChange={(event) => setDocument(event.target.files?.[0] ?? null)} />
            </Field>
          )}
          <p className="text-xs text-ink-500">Requests are checked for overlaps and available balance before they are submitted.</p>
        </form>
      </Modal>

      {user && (
        <p className="text-xs text-ink-400">
          Signed in as {user.fullName}. {titleize(user.roleName)} access controls which requests you can see and approve.
        </p>
      )}
    </div>
  );
}
