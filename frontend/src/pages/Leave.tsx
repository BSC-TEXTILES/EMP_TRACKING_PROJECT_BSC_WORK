import { useEffect, useState } from 'react';
import { api, errorMessage, fileUrl } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime, statusTone, titleize } from '../lib/format';
import type { LeaveItem } from '../lib/types';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { MonthPicker, WeeklyOffPanel, useWeeklyOffSummary, type WeeklyOffDateStatus } from '../components/WeeklyOffPanel';
import { LeavePolicyModal, TeamWeeklyOffs } from '../components/TeamWeeklyOffs';

interface ApplicationContext {
  employeeName: string;
  locationName: string | null;
  manager: { id: number; name: string } | null;
  hrApprovers: { id: number; name: string }[];
  canApply: boolean;
  issues: string[];
}

interface Holiday {
  id: number;
  name: string;
  holiday_date: string;
  is_optional: number;
}

type RequestOption = 'weekly_off' | 'half_day';
type HalfDaySlot = 'first_half' | 'second_half';

interface HalfDayPreview {
  date: string;
  slot: HalfDaySlot;
  days: number;
  deductFrom: { leaveTypeId: number; code: string; name: string; available: number; usable: number };
  lossOfPay: boolean;
  remainingAfterApproval: number;
}

/** Workflow wording shown to every role (employee, manager, HR, admin). */
const STATUS_LABEL: Record<string, string> = {
  pending_manager: 'Pending Manager Approval',
  pending_hr: 'Approved by Manager · Pending HR Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const HISTORY_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  manager_approved: 'Approved by manager',
  manager_rejected: 'Rejected by manager',
  hr_approved: 'Approved by HR',
  hr_rejected: 'Rejected by HR',
  cancelled: 'Cancelled',
};

const WEEKLY_OFF_STATUS_LABEL: Record<WeeklyOffDateStatus, string> = {
  available: 'Available',
  pending: 'Pending',
  taken: 'Taken',
  worked: 'Worked',
  lapsed: 'Lapsed',
  not_eligible: 'Before joining',
};

const SLOT_LABEL: Record<HalfDaySlot, string> = { first_half: 'First Half (Morning)', second_half: 'Second Half (Afternoon)' };

function RequestStatus({ status }: { status: string }) {
  return <span className={cx('badge', statusTone[status] ?? 'bg-ink-100 text-ink-600')}>{STATUS_LABEL[status] ?? titleize(status)}</span>;
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function requestTitle(leave: LeaveItem): string {
  if (leave.requestKind === 'weekly_off') return 'Weekly Off';
  if (leave.requestKind === 'half_day' || leave.isHalfDay) return `Half-Day Leave · ${leave.leaveType}`;
  return leave.leaveType;
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
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [routing, setRouting] = useState<ApplicationContext | null>(null);
  const [routingError, setRoutingError] = useState('');
  const [hrApproverId, setHrApproverId] = useState('');
  const [applyOpen, setApplyOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // ------------------------------------------------------------ application form
  const [requestType, setRequestType] = useState<RequestOption>('weekly_off');
  const [reason, setReason] = useState('');
  const [document, setDocument] = useState<File | null>(null);
  const now = new Date();
  const [woPeriod, setWoPeriod] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [woDate, setWoDate] = useState('');
  const { data: woSummary, error: woError, loading: woLoading } = useWeeklyOffSummary(undefined, woPeriod.year, woPeriod.month);
  const [hdDate, setHdDate] = useState('');
  const [hdSlot, setHdSlot] = useState<HalfDaySlot>('first_half');
  const [halfPreview, setHalfPreview] = useState<HalfDayPreview | null>(null);
  const [halfPreviewError, setHalfPreviewError] = useState('');

  const resetForm = () => {
    setRequestType('weekly_off');
    setReason('');
    setDocument(null);
    setWoDate('');
    setHdDate('');
    setHdSlot('first_half');
    setHalfPreview(null);
    setHalfPreviewError('');
  };

  const load = async () => {
    try {
      const result = await api.get<{ items: LeaveItem[] }>(`/leave?scope=${tab}`);
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
    api
      .get<{ holidays: Holiday[] }>('/leave/holidays')
      .then((result) => setHolidays(result.holidays))
      .catch((caught) => toast.error(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useSocketEvent('leave:updated', () => {
    void load();
  });

  // A selected weekly-off date that is no longer available (e.g. approved elsewhere) is cleared.
  useEffect(() => {
    if (!woDate || !woSummary) return;
    const entry = woSummary.sundays.find((item) => item.date === woDate);
    if (!entry || entry.status !== 'available') setWoDate('');
  }, [woSummary, woDate]);

  // Half day: server-side validation and the balance that will be charged 0.5 day.
  useEffect(() => {
    setHalfPreview(null);
    setHalfPreviewError('');
    if (!applyOpen || requestType !== 'half_day' || !hdDate) return;
    let cancelled = false;
    api
      .get<HalfDayPreview>(`/leave/half-day/preview?${new URLSearchParams({ date: hdDate, slot: hdSlot }).toString()}`)
      .then((result) => !cancelled && setHalfPreview(result))
      .catch((caught) => !cancelled && setHalfPreviewError(errorMessage(caught)));
    return () => {
      cancelled = true;
    };
  }, [applyOpen, requestType, hdDate, hdSlot]);

  const loadRouting = async () => {
    setRouting(null);
    setRoutingError('');
    try {
      const result = await api.get<ApplicationContext>('/leave/application-context');
      setRouting(result);
      setHrApproverId(result.hrApprovers.length === 1 ? String(result.hrApprovers[0].id) : '');
    } catch (error) {
      setRoutingError(errorMessage(error));
    }
  };
  useEffect(() => {
    if (applyOpen) void loadRouting();
  }, [applyOpen]);

  const canSubmit =
    Boolean(routing?.canApply && hrApproverId) &&
    !busy &&
    (requestType === 'weekly_off' ? Boolean(woDate) && (woSummary?.weeklyOffs.available ?? 0) > 0 : Boolean(hdDate && halfPreview));

  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const trimmed = reason.trim();
      if (requestType === 'weekly_off') {
        await api.post('/leave/weekly-off', { date: woDate, reason: trimmed || undefined, hrApproverId: Number(hrApproverId) });
        toast.success(`Weekly off request for ${formatDate(woDate)} submitted for approval.`);
      } else {
        let documentFileId: number | undefined;
        if (document) documentFileId = (await api.upload<{ id: number }>(document)).id;
        await api.post('/leave/half-day', {
          date: hdDate,
          slot: hdSlot,
          reason: trimmed || undefined,
          documentFileId,
          hrApproverId: Number(hrApproverId),
        });
        toast.success(`Half-day leave (${SLOT_LABEL[hdSlot]}) for ${formatDate(hdDate)} submitted for approval.`);
      }
      setApplyOpen(false);
      resetForm();
      await load();
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
      toast.success(approve ? (stage === 'manager' ? 'Approved and sent to HR.' : 'Request approved.') : 'Request rejected.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const w = woSummary?.weeklyOffs;
  const optionButton = (value: RequestOption, icon: 'calendar' | 'clock', label: string, hint: string) => (
    <button
      type="button"
      className={cx(
        'flex items-center justify-center gap-2 rounded-lg border py-2.5 px-3 text-xs font-bold transition-all',
        requestType === value
          ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30 shadow-xs'
          : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
      )}
      aria-pressed={requestType === value}
      onClick={() => setRequestType(value)}
    >
      <Icon name={icon} size={15} />
      <span>{label}</span>
      <span className="font-medium text-ink-500">· {hint}</span>
    </button>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leave & holiday management"
        description="Weekly offs and half-day leave with two-stage approval (manager, then HR), and the holiday calendar."
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
          <EmptyState title="No requests" description="Weekly-off and leave applications in this scope will appear here." />
        ) : (
          <div className="divide-y divide-ink-100">
            {items.map((leave) => (
              <div key={leave.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink-900">{requestTitle(leave)}</p>
                    <RequestStatus status={leave.status} />
                    <Badge tone="neutral">{leave.days} day(s)</Badge>
                    {leave.isHalfDay && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-blue-100 text-blue-900 font-bold px-2 py-0.5 text-xs border border-blue-200">
                        <Icon name="clock" size={12} />
                        Half Day · {leave.halfDaySlot === 'second_half' ? SLOT_LABEL.second_half : SLOT_LABEL.first_half}
                      </span>
                    )}
                    {leave.requestKind !== 'weekly_off' && Boolean(leave.weeklyOffDays) && <Badge tone="success">{leave.weeklyOffDays} weekly off(s) not charged</Badge>}
                    {Boolean(leave.holidayDays) && <Badge tone="info">{leave.holidayDays} holiday(s) not charged</Badge>}
                    {tab !== 'mine' && <Badge tone="brand">{leave.employeeName}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    {leave.requestKind === 'weekly_off' || leave.isHalfDay || leave.startDate === leave.endDate ? (
                      <strong className="text-ink-800">{formatDate(leave.startDate)}{leave.isHalfDay ? ` · ${leave.halfDaySlot === 'second_half' ? SLOT_LABEL.second_half : SLOT_LABEL.first_half}` : ''}</strong>
                    ) : (
                      <span>{formatDate(leave.startDate)} → {formatDate(leave.endDate)}</span>
                    )} · applied {formatDateTime(leave.createdAt)}
                  </p>
                  {leave.reason && <p className="mt-1 text-sm text-ink-600">{leave.reason}</p>}
                  <p className="mt-1 text-xs text-ink-500">Location: {leave.locationName ?? 'Not assigned'} · Manager: {leave.managerName ?? 'Not assigned'} · HR: {leave.hrName ?? 'Legacy request'}</p>
                  {leave.history && leave.history.length > 0 ? (
                    <p className="mt-1 text-xs text-brand-700">
                      {leave.history.map((step) => `${HISTORY_LABEL[step.action] ?? titleize(step.action)}${step.actorName ? ` (${step.actorName})` : ''}${step.at ? ` ${formatDateTime(step.at)}` : ''}`).join(' → ')}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-brand-700">Submitted → Manager {leave.managerActionAt ? 'reviewed' : 'pending'} → HR {leave.hrActionAt ? 'reviewed' : 'pending'} → {STATUS_LABEL[leave.status] ?? titleize(leave.status)}</p>
                  )}
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
                      if (!window.confirm('Cancel this request?')) return;
                      try {
                        await api.post(`/leave/${leave.id}/cancel`);
                        await load();
                        toast.success('Request cancelled.');
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
        <SectionHeader title="Holiday calendar" description="Public holidays for your location over the coming months." />
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
        footer={<><button className="btn-secondary" onClick={() => setApplyOpen(false)}>Cancel</button><button className="btn-primary" form="leave-form" type="submit" disabled={!canSubmit}>{busy ? 'Submitting…' : 'Submit request'}</button></>}>
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
              <p className="text-xs text-ink-600">1. Submit request → 2. {routing.manager?.name ?? 'Manager'} reviews → 3. {routing.hrApprovers.find((person) => String(person.id) === hrApproverId)?.name ?? 'Location HR'} gives final approval → 4. Balance and calendar update.</p>
              {routing.issues.map((issue) => <p key={issue} role="alert" className="text-xs text-red-700">{issue}</p>)}
            </div>
          )}

          <div className="space-y-1.5">
            <span className="label">Request type</span>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="group" aria-label="Request type">
              {optionButton('weekly_off', 'calendar', 'Weekly Off', '1 day')}
              {optionButton('half_day', 'clock', 'Half-Day Leave', '0.5 day')}
            </div>
          </div>

          {requestType === 'weekly_off' ? (
            <>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="label mb-0">Select date</span>
                  <MonthPicker year={woPeriod.year} month={woPeriod.month} onChange={(year, month) => { setWoPeriod({ year, month }); setWoDate(''); }} />
                </div>
                {woError && !woSummary ? (
                  <p role="alert" className="text-xs text-red-600">{woError}</p>
                ) : !woSummary || (woLoading && (woSummary.month !== woPeriod.month || woSummary.year !== woPeriod.year)) ? (
                  <Skeleton lines={2} />
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Weekly-off date">
                      {woSummary.sundays.map((entry) => {
                        const selectable = entry.status === 'available' && (w?.available ?? 0) > 0;
                        const selected = woDate === entry.date;
                        return (
                          <button
                            key={entry.date}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={!selectable}
                            onClick={() => setWoDate(entry.date)}
                            className={cx(
                              'rounded-lg border px-2 py-2 text-left text-xs transition-all',
                              selected
                                ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30 font-semibold'
                                : selectable
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300'
                                  : 'cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400',
                            )}
                          >
                            <span className="block font-semibold">{formatDate(entry.date)}</span>
                            <span className="text-[11px]">{WEEKLY_OFF_STATUS_LABEL[entry.status]}</span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-ink-500">
                      Only your eligible {woSummary.weeklyOffDayName}s on or after your joining date can be selected. Taken, pending and worked dates are locked.
                    </p>
                    <div className="grid grid-cols-2 gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 sm:grid-cols-4">
                      <span>Allocated: <strong>{w?.allocated ?? 0}</strong></span>
                      <span>Taken: <strong>{w?.taken ?? 0}</strong></span>
                      <span>Available balance: <strong>{w?.available ?? 0}</strong></span>
                      <span>
                        Remaining balance{woDate ? ' after approval' : ''}: <strong>{woDate ? Math.max(0, (w?.remaining ?? 0) - 1) : (w?.remaining ?? 0)}</strong>
                      </span>
                      {(w?.pending ?? 0) > 0 && <span className="col-span-2 sm:col-span-4 text-emerald-800">{w?.pending} date(s) reserved by pending requests.</span>}
                    </div>
                    {(w?.available ?? 0) <= 0 && (
                      <p role="alert" className="text-xs font-semibold text-red-700">No weekly-off balance is available for {woSummary.monthName} {woSummary.year}.</p>
                    )}
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <Field label="Select date" hint="One date · half-day leave is never taken on your weekly off or a public holiday">
                <input
                  type="date"
                  className="input font-medium"
                  value={hdDate}
                  min={localToday()}
                  onChange={(event) => setHdDate(event.target.value)}
                  required
                />
              </Field>

              <div className="rounded-xl border border-blue-200 bg-blue-50/80 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-blue-950 flex items-center gap-1.5">
                    <Icon name="clock" size={14} className="text-blue-700" />
                    <span>Session (select one)</span>
                  </span>
                  <span className="text-[11px] font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full border border-blue-200">Half-day deduction: 0.5 day</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {(['first_half', 'second_half'] as const).map((slot) => (
                    <label
                      key={slot}
                      className={cx(
                        'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-xs transition-all',
                        hdSlot === slot
                          ? 'border-blue-600 bg-white text-blue-950 shadow-xs ring-2 ring-blue-500/30 font-semibold'
                          : 'border-blue-200 bg-white/70 text-ink-700 hover:bg-white',
                      )}
                    >
                      <input
                        type="radio"
                        name="halfDaySlot"
                        value={slot}
                        checked={hdSlot === slot}
                        onChange={() => setHdSlot(slot)}
                        className="mt-0.5 text-brand-600 focus:ring-brand-500"
                      />
                      <div>
                        <span className="block font-bold text-ink-900">{slot === 'first_half' ? 'First Half' : 'Second Half'}</span>
                        <span className="text-[11px] text-ink-500">{slot === 'first_half' ? 'Morning Session' : 'Afternoon Session'}</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {halfPreviewError ? (
                <p role="alert" className="text-xs text-red-600">{halfPreviewError}</p>
              ) : halfPreview ? (
                <div className={halfPreview.lossOfPay ? 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900' : 'rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-700'}>
                  {halfPreview.lossOfPay ? (
                    <p>You have no paid leave balance left, so this half day will be recorded as <strong>{halfPreview.deductFrom.name}</strong> (0.5 day, loss of pay).</p>
                  ) : (
                    <p>
                      Available {halfPreview.deductFrom.name} balance: <strong>{halfPreview.deductFrom.usable}</strong> day(s) ·{' '}
                      <strong>0.5 day</strong> deducted after HR approval · Remaining after approval: <strong>{halfPreview.remainingAfterApproval}</strong> day(s).
                    </p>
                  )}
                  <p className="mt-1 text-ink-500">Half-day leave never reduces your weekly-off balance.</p>
                </div>
              ) : null}

              <Field label="Supporting document (optional)">
                <input type="file" className="input" onChange={(event) => setDocument(event.target.files?.[0] ?? null)} />
              </Field>
            </>
          )}

          <Field label="Reason" hint="Optional">
            <textarea className="input min-h-[80px]" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} />
          </Field>
          <p className="text-xs text-ink-500">Requests are checked on the server for eligibility, duplicates, overlaps and available balance.</p>
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
