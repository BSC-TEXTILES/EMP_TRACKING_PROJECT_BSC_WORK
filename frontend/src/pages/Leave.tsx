import { useEffect, useState } from 'react';
import { api, errorMessage, fileUrl } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime, titleize } from '../lib/format';
import type { LeaveItem } from '../lib/types';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { WeeklyOffPanel, useWeeklyOffSummary } from '../components/WeeklyOffPanel';
import { LeavePolicyModal, TeamWeeklyOffs } from '../components/TeamWeeklyOffs';

interface DayBreakdown {
  calendarDays: number;
  chargedDays: number;
  weeklyOffDays: number;
  holidayDays: number;
  holidays: { date: string; name: string }[];
  calendarCounted: boolean;
  isHalfDay?: boolean;
}

interface ApplicationContext {
  employeeName: string;
  locationName: string | null;
  manager: { id: number; name: string } | null;
  hrApprovers: { id: number; name: string }[];
  canApply: boolean;
  issues: string[];
}

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
  const [routing, setRouting] = useState<ApplicationContext | null>(null);
  const [routingError, setRoutingError] = useState('');
  const [hrApproverId, setHrApproverId] = useState('');
  const [applyOpen, setApplyOpen] = useState(false);
  const [form, setForm] = useState<{
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason: string;
    isHalfDay: boolean;
    halfDaySlot: 'first_half' | 'second_half';
  }>({
    leaveTypeId: '',
    startDate: '',
    endDate: '',
    reason: '',
    isHalfDay: false,
    halfDaySlot: 'first_half',
  });
  const [document, setDocument] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<DayBreakdown | null>(null);
  const [breakdownError, setBreakdownError] = useState('');
  // Weekly offs for the month the leave starts in (or this month), shown in the leave-type section.
  const weeklyOffMonth = /^\d{4}-\d{2}/.test(form.startDate) ? form.startDate : new Date().toISOString().slice(0, 10);
  const { data: weeklyOff } = useWeeklyOffSummary(undefined, Number(weeklyOffMonth.slice(0, 4)), Number(weeklyOffMonth.slice(5, 7)));

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

  const refreshBalances = async () => {
    try {
      const refreshed = await api.get<{ balances: Balance[] }>('/leave/balances');
      setBalances(refreshed.balances);
    } catch {
      /* the next event retries */
    }
  };
  useSocketEvent('leave:updated', () => {
    void refreshBalances();
    void load();
  });

  // Preview how many days will be charged (Sundays and public holidays are free).
  useEffect(() => {
    setBreakdown(null);
    setBreakdownError('');
    if (!applyOpen || !form.startDate || (!form.isHalfDay && (!form.endDate || form.endDate < form.startDate))) return;
    const effectiveEnd = form.isHalfDay ? form.startDate : form.endDate;
    const params = new URLSearchParams({ startDate: form.startDate, endDate: effectiveEnd });
    if (form.leaveTypeId) params.set('leaveTypeId', form.leaveTypeId);
    if (form.isHalfDay) {
      params.set('isHalfDay', 'true');
      params.set('halfDaySlot', form.halfDaySlot);
    }
    let cancelled = false;
    api
      .get<DayBreakdown>(`/leave/preview?${params.toString()}`)
      .then((result) => !cancelled && setBreakdown(result))
      .catch((caught) => !cancelled && setBreakdownError(errorMessage(caught)));
    return () => {
      cancelled = true;
    };
  }, [applyOpen, form.startDate, form.endDate, form.leaveTypeId, form.isHalfDay, form.halfDaySlot]);

  const loadRouting = async () => {
    setRouting(null); setRoutingError('');
    try {
      const result = await api.get<ApplicationContext>('/leave/application-context');
      setRouting(result);
      setHrApproverId(result.hrApprovers.length === 1 ? String(result.hrApprovers[0].id) : '');
    } catch (error) { setRoutingError(errorMessage(error)); }
  };
  useEffect(() => { if (applyOpen) void loadRouting(); }, [applyOpen]);

  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!routing?.canApply || !hrApproverId || busy) return;
    setBusy(true);
    try {
      let documentFileId: number | undefined;
      if (document) documentFileId = (await api.upload<{ id: number }>(document)).id;
      const effectiveEnd = form.isHalfDay ? form.startDate : form.endDate;
      await api.post('/leave', {
        leaveTypeId: Number(form.leaveTypeId),
        hrApproverId: Number(hrApproverId),
        startDate: form.startDate,
        endDate: effectiveEnd,
        reason: form.reason,
        documentFileId,
        isHalfDay: form.isHalfDay,
        halfDaySlot: form.isHalfDay ? form.halfDaySlot : undefined,
      });
      toast.success(form.isHalfDay ? 'Half-day leave request submitted for approval.' : 'Leave request submitted for approval.');
      setApplyOpen(false);
      setForm({ leaveTypeId: '', startDate: '', endDate: '', reason: '', isHalfDay: false, halfDaySlot: 'first_half' });
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
    const note = window.prompt(approve ? 'Optional note:' : 'Reason for rejection:');
    if (note === null) return;
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
        description="Sunday weekly offs calculated from the calendar, two-stage leave approval (manager, then HR) and the holiday calendar."
        actions={
          <>
            {has('leave.manage') && (
              <button type="button" className="btn-secondary btn-sm" onClick={() => setPolicyOpen(true)}><Icon name="settings" size={15} /> Weekly off policy</button>
            )}
            {has('leave.apply') && <button type="button" className="btn-primary btn-sm" onClick={() => setApplyOpen(true)}><Icon name="plus" size={15} /> Apply for leave</button>}
          </>
        }
      />

      <WeeklyOffPanel showBalances={false} />

      {(tab === 'team' || tab === 'all') && <TeamWeeklyOffs />}

      <Card>
        <div className="px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'mine', label: 'My requests' },
              ...(has('leave.view.team', 'leave.view.all') ? [{ value: 'team', label: 'Team requests' }] : []),
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
                    {leave.isHalfDay && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-blue-100 text-blue-900 font-bold px-2 py-0.5 text-xs border border-blue-200">
                        <Icon name="clock" size={12} />
                        Half Day · {leave.halfDaySlot === 'second_half' ? 'Second Half (Afternoon)' : 'First Half (Morning)'}
                      </span>
                    )}
                    {Boolean(leave.weeklyOffDays) && <Badge tone="success">{leave.weeklyOffDays} Sunday(s) not charged</Badge>}
                    {Boolean(leave.holidayDays) && <Badge tone="info">{leave.holidayDays} holiday(s) not charged</Badge>}
                    {tab !== 'mine' && <Badge tone="brand">{leave.employeeName}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    {leave.isHalfDay ? (
                      <strong className="text-ink-800">{formatDate(leave.startDate)} · {leave.halfDaySlot === 'second_half' ? 'Second Half (Afternoon)' : 'First Half (Morning)'}</strong>
                    ) : (
                      <span>{formatDate(leave.startDate)} → {formatDate(leave.endDate)}</span>
                    )} · applied {formatDateTime(leave.createdAt)}
                  </p>
                  <p className="mt-1 text-sm text-ink-600">{leave.reason}</p>
                  <p className="mt-1 text-xs text-ink-500">Location: {leave.locationName ?? 'Not assigned'} · Manager: {leave.managerName ?? 'Not assigned'} · HR: {leave.hrName ?? 'Legacy request'}</p>
                  <p className="mt-1 text-xs text-brand-700">Submitted → Manager {leave.managerActionAt ? 'reviewed' : 'pending'} → HR {leave.hrActionAt ? 'reviewed' : 'pending'} → {titleize(leave.status)}</p>
                  {leave.documentFileId && <a href={fileUrl(leave.documentFileId, true)} className="mt-1 block text-xs text-brand-700 underline">Download supporting document</a>}
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
        <SectionHeader title="Holiday calendar" description="Public holidays for your location over the coming months. Every Sunday is also a weekly off." />
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
        footer={<><button className="btn-secondary" onClick={() => setApplyOpen(false)}>Cancel</button><button className="btn-primary" form="leave-form" type="submit" disabled={busy || !routing?.canApply || !hrApproverId || breakdown?.chargedDays === 0}>{busy ? 'Submitting…' : 'Submit request'}</button></>}>
        <form id="leave-form" onSubmit={apply} className="space-y-4">
          {routingError ? <div role="alert" className="text-sm text-red-600">{routingError}<button type="button" className="btn-secondary ml-2" onClick={() => void loadRouting()}>Retry</button></div> : !routing ? <p role="status">Loading your approval route…</p> : (
            <div className="space-y-3 rounded-lg border border-brand-200 bg-brand-50 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Employee"><input className="input" value={routing.employeeName} readOnly /></Field>
                <Field label="Assigned location"><input className="input" value={routing.locationName ?? 'Not assigned'} readOnly /></Field>
                <Field label="Reporting manager"><input className="input" value={routing.manager?.name ?? 'Not assigned'} readOnly /></Field>
                <Field label="HR approver" required><select className="input" value={hrApproverId} onChange={(event) => setHrApproverId(event.target.value)} required>
                  <option value="">Select location HR</option>
                  {routing.hrApprovers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select></Field>
              </div>
              <p className="text-xs text-ink-600">1. Submit request → 2. {routing.manager?.name ?? 'Manager'} reviews → 3. {routing.hrApprovers.find((person) => String(person.id) === hrApproverId)?.name ?? 'Location HR'} gives final approval → 4. Balance and attendance update.</p>
              <p className="text-xs text-ink-500">Your location and reporting manager are maintained by administration. Pending requests can be cancelled; rejected requests can be submitted again with corrected details.</p>
              {routing.issues.map((issue) => <p key={issue} role="alert" className="text-xs text-red-700">{issue}</p>)}
            </div>
          )}
          <Field label="Leave type" required>
            <select
              className="input"
              value={form.leaveTypeId}
              onChange={(event) => setForm({ ...form, leaveTypeId: event.target.value })}
              required
            >
              <option value="">Select leave type</option>
              {types.map((type) => {
                const balance = balances.find((item) => item.leaveTypeId === type.id);
                let label = type.name;
                if (type.code === 'LWP') {
                  label += ' (Unpaid · Loss of Pay)';
                } else if (type.code === 'CO') {
                  const available = weeklyOff?.compOff.available ?? balance?.available ?? 0;
                  label += available > 0
                    ? ` (${available} day(s) available · earned for weekly offs not taken)`
                    : ' (0 available · earned when you work on a Sunday instead of taking the weekly off)';
                } else if (type.code === 'ML') {
                  label += ' (Maternity · 26 weeks · Medical doc required)';
                } else if (type.code === 'PL') {
                  label += ' (Paternity · Up to 10 days · Doc required)';
                } else {
                  label += ` (${balance?.available ?? type.annual_quota} days available)`;
                }
                return (
                  <option key={type.id} value={type.id}>
                    {label}
                  </option>
                );
              })}
            </select>
          </Field>

          {/* Leave Duration Toggle */}
          <div className="space-y-1.5">
            <label className="label text-xs font-bold text-ink-800">Leave Duration *</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className={cx(
                  'flex items-center justify-center gap-2 rounded-lg border py-2.5 px-3 text-xs font-bold transition-all',
                  !form.isHalfDay
                    ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30 shadow-xs'
                    : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                )}
                onClick={() => setForm((prev) => ({ ...prev, isHalfDay: false }))}
              >
                <Icon name="calendar" size={15} />
                <span>Full Day (1.0 Day)</span>
              </button>

              <button
                type="button"
                className={cx(
                  'flex items-center justify-center gap-2 rounded-lg border py-2.5 px-3 text-xs font-bold transition-all',
                  form.isHalfDay
                    ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30 shadow-xs'
                    : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                )}
                onClick={() => setForm((prev) => ({ ...prev, isHalfDay: true, endDate: prev.startDate || prev.endDate }))}
              >
                <Icon name="clock" size={15} />
                <span>Half Day (0.5 Day)</span>
              </button>
            </div>
          </div>

          {/* Half Day Session Selection - Both options must be there */}
          {form.isHalfDay && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/80 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-blue-950 flex items-center gap-1.5">
                  <Icon name="clock" size={14} className="text-blue-700" />
                  <span>Half Day Session Option * (Select One)</span>
                </label>
                <span className="text-[11px] font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full border border-blue-200">0.5 Day Deduction</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label
                  className={cx(
                    'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-xs transition-all',
                    form.halfDaySlot === 'first_half'
                      ? 'border-blue-600 bg-white text-blue-950 shadow-xs ring-2 ring-blue-500/30 font-semibold'
                      : 'border-blue-200 bg-white/70 text-ink-700 hover:bg-white',
                  )}
                >
                  <input
                    type="radio"
                    name="halfDaySlot"
                    value="first_half"
                    checked={form.halfDaySlot === 'first_half'}
                    onChange={() => setForm((prev) => ({ ...prev, halfDaySlot: 'first_half' }))}
                    className="mt-0.5 text-brand-600 focus:ring-brand-500"
                  />
                  <div>
                    <span className="block font-bold text-ink-900">First Half</span>
                    <span className="text-[11px] text-ink-500">Morning Session</span>
                  </div>
                </label>

                <label
                  className={cx(
                    'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-xs transition-all',
                    form.halfDaySlot === 'second_half'
                      ? 'border-blue-600 bg-white text-blue-950 shadow-xs ring-2 ring-blue-500/30 font-semibold'
                      : 'border-blue-200 bg-white/70 text-ink-700 hover:bg-white',
                  )}
                >
                  <input
                    type="radio"
                    name="halfDaySlot"
                    value="second_half"
                    checked={form.halfDaySlot === 'second_half'}
                    onChange={() => setForm((prev) => ({ ...prev, halfDaySlot: 'second_half' }))}
                    className="mt-0.5 text-brand-600 focus:ring-brand-500"
                  />
                  <div>
                    <span className="block font-bold text-ink-900">Second Half</span>
                    <span className="text-[11px] text-ink-500">Afternoon Session</span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {weeklyOff && (() => {
            const notTaken = weeklyOff.sundays.filter((sunday) => sunday.status === 'worked');
            const coSelected = selectedType?.code === 'CO';
            return (
              <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                <p className="font-semibold">
                  Weekly offs · {weeklyOff.monthName} {weeklyOff.year}: {weeklyOff.totalSundays} Sundays
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <span>Allocated: <strong>{weeklyOff.weeklyOffs.allocated}</strong></span>
                  <span>Taken: <strong>{weeklyOff.weeklyOffs.taken}</strong></span>
                  <span>Remaining: <strong>{weeklyOff.weeklyOffs.remaining}</strong></span>
                  <span>Not taken (worked): <strong>{weeklyOff.weeklyOffs.worked}</strong></span>
                </div>
                {notTaken.length > 0 ? (
                  <div>
                    <p className="font-medium">Weekly offs you did not take (you worked):</p>
                    <ul className="mt-1 space-y-0.5">
                      {notTaken.map((sunday) => (
                        <li key={sunday.date}>
                          • {formatDate(sunday.date)} — worked {Math.floor(sunday.workedMinutes / 60)}h {sunday.workedMinutes % 60}m ·{' '}
                          {sunday.compOffDays > 0
                            ? <strong>{sunday.compOffDays === 1 ? '1 comp-off day' : 'half comp-off day'} earned</strong>
                            : weeklyOff.policy.compOffEnabled
                              ? 'not enough hours for comp-off'
                              : 'comp-off is disabled by HR'}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p>You have taken every weekly off so far this month.</p>
                )}
                <p>
                  Comp-off available to use: <strong>{weeklyOff.compOff.available} day(s)</strong>
                  {weeklyOff.policy.compOffExpiryDays > 0 ? ` · each credit is valid for ${weeklyOff.policy.compOffExpiryDays} days` : ''}.
                  {' '}Weekly offs are given automatically and are never deducted from CL, SL or EL.
                </p>
                {coSelected && weeklyOff.compOff.available <= 0 && (
                  <p role="alert" className="font-semibold text-red-700">
                    You have no comp-off available. Comp-off is earned only when you work on a weekly off (Sunday).
                  </p>
                )}
              </div>
            );
          })()}

          {form.isHalfDay ? (
            <Field label="Leave Date (Half Day) *" required hint="Single date · 0.5 day deduction">
              <input
                type="date"
                className="input font-medium"
                value={form.startDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(event) => setForm((prev) => ({ ...prev, startDate: event.target.value, endDate: event.target.value }))}
                required
              />
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Start date" required>
                <input type="date" className="input" value={form.startDate} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setForm((prev) => ({ ...prev, startDate: event.target.value }))} required />
              </Field>
              <Field label="End date" required>
                <input type="date" className="input" value={form.endDate} min={form.startDate || new Date().toISOString().slice(0, 10)} onChange={(event) => setForm((prev) => ({ ...prev, endDate: event.target.value }))} required />
              </Field>
            </div>
          )}

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
          {breakdownError ? (
            <p role="alert" className="text-xs text-red-600">{breakdownError}</p>
          ) : breakdown ? (
            <div className={breakdown.chargedDays > 0 ? 'rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-700' : 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800'}>
              {breakdown.calendarCounted ? (
                <p><strong>{breakdown.chargedDays}</strong> calendar day(s) (maternity leave is counted in calendar days).</p>
              ) : form.isHalfDay ? (
                <p className="font-semibold text-blue-950">
                  <strong>0.5 day</strong> will be deducted from your {selectedType?.name ?? 'leave'} balance ({form.halfDaySlot === 'second_half' ? 'Second Half · Afternoon Session' : 'First Half · Morning Session'}).
                </p>
              ) : breakdown.chargedDays > 0 ? (
                <p>
                  <strong>{breakdown.chargedDays}</strong> day(s) will be deducted from your balance
                  {breakdown.weeklyOffDays + breakdown.holidayDays > 0 &&
                    ` (${breakdown.calendarDays} calendar days; ${breakdown.weeklyOffDays ? `${breakdown.weeklyOffDays} Sunday weekly off(s)` : ''}${breakdown.weeklyOffDays && breakdown.holidayDays ? ' and ' : ''}${breakdown.holidayDays ? `${breakdown.holidayDays} public holiday(s): ${breakdown.holidays.map((h) => h.name).join(', ')}` : ''} not charged)`}
                  .
                </p>
              ) : (
                <p>These dates are all Sunday weekly offs or public holidays, so you do not need to apply for leave.</p>
              )}
            </div>
          ) : null}
          <p className="text-xs text-ink-500">Requests are checked for overlaps and available balance before they are submitted.</p>
        </form>
      </Modal>

      <LeavePolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />

      {user && (
        <p className="text-xs text-ink-400">
          Signed in as {user.fullName}. {titleize(user.roleName)} access controls which requests you can see and approve.
        </p>
      )}
    </div>
  );
}
