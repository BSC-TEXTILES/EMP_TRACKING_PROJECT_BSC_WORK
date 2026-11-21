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

interface DayBreakdown {
  startDate: string;
  endDate: string;
  calendarDays: number;
  chargedDays: number;
  weeklyOffDays: number;
  holidayDays: number;
  weeklyOffDates: string[];
  holidays: { date: string; name: string }[];
  calendarCounted: boolean;
  isHalfDay: boolean;
}

type RequestOption = 'regular' | 'weekly_off' | 'half_day';
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
  const [tab, setTab] = useState<'mine' | 'team' | 'all' | 'live'>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'live') return 'live';
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
  const [viewingLeave, setViewingLeave] = useState<LeaveItem | null>(null);
  const [viewingFlowLeave, setViewingFlowLeave] = useState<LeaveItem | null>(null);
  const [liveLocation, setLiveLocation] = useState<string>('ALL');
  const [busy, setBusy] = useState(false);

  // ------------------------------------------------------------ application form
  const [requestType, setRequestType] = useState<RequestOption>('regular');
  const [reason, setReason] = useState('');
  const [document, setDocument] = useState<File | null>(null);

  // Regular Leave State (CL, SL, EL, etc.)
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [selectedLeaveTypeId, setSelectedLeaveTypeId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [breakdown, setBreakdown] = useState<DayBreakdown | null>(null);
  const [breakdownError, setBreakdownError] = useState<string>('');

  // Weekly Off State (only user with saved weekly off can take)
  const now = new Date();
  const [woPeriod, setWoPeriod] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [woDate, setWoDate] = useState('');
  const { data: woSummary, error: woError, loading: woLoading } = useWeeklyOffSummary(undefined, woPeriod.year, woPeriod.month);

  // Half Day State (0.5 day)
  const [hdDate, setHdDate] = useState('');
  const [hdSlot, setHdSlot] = useState<HalfDaySlot>('first_half');
  const [halfPreview, setHalfPreview] = useState<HalfDayPreview | null>(null);
  const [halfPreviewError, setHalfPreviewError] = useState('');

  const resetForm = () => {
    setRequestType('regular');
    setReason('');
    setDocument(null);
    setWoDate('');
    setHdDate('');
    setHdSlot('first_half');
    setHalfPreview(null);
    setHalfPreviewError('');
    setStartDate('');
    setEndDate('');
    setBreakdown(null);
    setBreakdownError('');
  };

  const load = async () => {
    try {
      const scopeParam = tab === 'live' ? (has('leave.view.all') ? 'all' : (has('leave.view.team') ? 'team' : 'mine')) : tab;
      const result = await api.get<{ items: LeaveItem[] }>(`/leave?scope=${scopeParam}`);
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

  // Regular Leave Breakdown preview
  useEffect(() => {
    setBreakdown(null);
    setBreakdownError('');
    if (!applyOpen || requestType !== 'regular' || !startDate || !endDate || endDate < startDate) return;
    let cancelled = false;
    const params = new URLSearchParams({ startDate, endDate });
    if (selectedLeaveTypeId) params.set('leaveTypeId', selectedLeaveTypeId);
    api
      .get<DayBreakdown>(`/leave/preview?${params.toString()}`)
      .then((res) => !cancelled && setBreakdown(res))
      .catch((caught) => !cancelled && setBreakdownError(errorMessage(caught)));
    return () => {
      cancelled = true;
    };
  }, [applyOpen, requestType, startDate, endDate, selectedLeaveTypeId]);

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
    if (applyOpen) {
      void loadRouting();
      // Fetch leave types (exclude 'WO' so Weekly Off never appears in regular leave types)
      api
        .get<{ types: LeaveType[] }>('/leave/types')
        .then((res) => {
          const regularTypes = (res.types ?? []).filter((t) => t.code !== 'WO');
          setTypes(regularTypes);
          if (regularTypes.length > 0) {
            setSelectedLeaveTypeId((prev) => prev || String(regularTypes[0].id));
          }
        })
        .catch(() => {});

      api
        .get<{ balances: Balance[] }>('/leave/balances')
        .then((res) => setBalances(res.balances ?? []))
        .catch(() => {});
    }
  }, [applyOpen]);

  const canSubmit =
    Boolean(routing?.canApply && hrApproverId) &&
    !busy &&
    (requestType === 'weekly_off'
      ? Boolean(woDate) && (woSummary?.weeklyOffs.available ?? 0) > 0
      : requestType === 'half_day'
        ? Boolean(hdDate && halfPreview)
        : Boolean(selectedLeaveTypeId && startDate && endDate && endDate >= startDate && (breakdown?.chargedDays ?? 0) > 0));

  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const trimmed = reason.trim();
      let documentFileId: number | undefined;
      if (document) documentFileId = (await api.upload<{ id: number }>(document)).id;

      if (requestType === 'weekly_off') {
        if ((woSummary?.weeklyOffs.available ?? 0) <= 0) {
          toast.error('You have no saved weekly offs available to take.');
          return;
        }
        await api.post('/leave/weekly-off', { date: woDate, reason: trimmed || undefined, hrApproverId: Number(hrApproverId) });
        toast.success(`Weekly off request for ${formatDate(woDate)} submitted for approval.`);
      } else if (requestType === 'half_day') {
        await api.post('/leave/half-day', {
          date: hdDate,
          slot: hdSlot,
          reason: trimmed || undefined,
          documentFileId,
          hrApproverId: Number(hrApproverId),
        });
        toast.success(`Half-day leave (${SLOT_LABEL[hdSlot]}) for ${formatDate(hdDate)} submitted for approval.`);
      } else {
        await api.post('/leave', {
          leaveTypeId: Number(selectedLeaveTypeId),
          hrApproverId: Number(hrApproverId),
          startDate,
          endDate,
          reason: trimmed || undefined,
          documentFileId,
        });
        toast.success('Leave request submitted for approval.');
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

  const cancel = async (id: number) => {
    if (!window.confirm('Cancel this request?')) return;
    try {
      await api.post(`/leave/${id}/cancel`);
      await load();
      if (viewingLeave?.id === id) setViewingLeave(null);
      if (viewingFlowLeave?.id === id) setViewingFlowLeave(null);
      toast.success('Request cancelled.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    if (items) {
      if (viewingLeave) {
        const fresh = items.find((it) => it.id === viewingLeave.id);
        if (fresh) setViewingLeave(fresh);
      }
      if (viewingFlowLeave) {
        const fresh = items.find((it) => it.id === viewingFlowLeave.id);
        if (fresh) setViewingFlowLeave(fresh);
      }
    }
  }, [items]);

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
              { value: 'live', label: '🟢 Live Store View' },
            ]}
            value={tab}
            onChange={(value) => setTab(value as 'mine' | 'team' | 'all' | 'live')}
          />
        </div>
        {tab === 'live' ? (
          <div className="p-4 space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-ink-100 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                </span>
                <div>
                  <h3 className="text-sm font-bold text-ink-900">Live Today: Employees On Leave / Weekly Off</h3>
                  <p className="text-xs text-ink-500 font-medium">Real-time attendance & leave roster across retail stores ({formatDate(localToday())})</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink-600">Location:</span>
                <select
                  value={liveLocation}
                  onChange={(e) => setLiveLocation(e.target.value)}
                  className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-800 focus:outline-none"
                >
                  <option value="ALL">All Store Locations</option>
                  <option value="BEL">BEL – Belagavi</option>
                  <option value="DAV">DAV – Davanagere</option>
                  <option value="SHI">SHI – Shivamogga</option>
                  <option value="HUB-HQ">HUB-HQ – Head Office</option>
                </select>
              </div>
            </div>

            {/* Live Today Roster */}
            {(() => {
              const todayStr = localToday();
              const activeLeaves = (items ?? []).filter((l) => {
                if (l.status !== 'approved') return false;
                const isToday = todayStr >= l.startDate && todayStr <= l.endDate;
                if (!isToday) return false;
                if (liveLocation !== 'ALL') {
                  const loc = (l.locationName ?? '').toUpperCase();
                  if (liveLocation === 'BEL' && !loc.includes('BEL') && !loc.includes('BELAGAVI')) return false;
                  if (liveLocation === 'DAV' && !loc.includes('DAV') && !loc.includes('DAVANAGERE')) return false;
                  if (liveLocation === 'SHI' && !loc.includes('SHI') && !loc.includes('SHIVAMOGGA')) return false;
                  if (liveLocation === 'HUB-HQ' && !loc.includes('HUB') && !loc.includes('HEAD OFFICE')) return false;
                }
                return true;
              });

              if (activeLeaves.length === 0) {
                return (
                  <EmptyState
                    title="No Employees on Leave Today"
                    description={liveLocation !== 'ALL' ? `No employees at ${liveLocation} are currently on leave or weekly off today.` : 'All active staff across all locations are scheduled for work today.'}
                  />
                );
              }

              return (
                <div className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white">
                  {activeLeaves.map((leave) => (
                    <div key={leave.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5 hover:bg-ink-50/50 transition-colors">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 font-bold text-xs">
                          {leave.employeeName.split(' ').map((n) => n[0]).slice(0, 2).join('')}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-bold text-ink-900">{leave.employeeName}</span>
                            <span className="text-xs text-ink-400 font-mono">({leave.employeeCode})</span>
                            <Badge tone="brand" className="text-[11px]">{leave.locationName ?? 'Store'}</Badge>
                            <Badge tone="success" className="text-[11px] font-semibold">{requestTitle(leave)}</Badge>
                            {leave.isHalfDay && (
                              <Badge tone="info" className="text-[11px]">
                                {leave.halfDaySlot === 'second_half' ? 'Afternoon Slot' : 'Morning Slot'}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-ink-500 mt-0.5">
                            Department: {leave.departmentName ?? 'Retail & Store Operations'} · Manager: {leave.managerName ?? 'Manager'} · HR: {leave.hrName ?? 'HR'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-xs hover:bg-ink-50 hover:border-brand-300 transition-colors"
                          onClick={() => setViewingLeave(leave)}
                        >
                          <Icon name="eye" size={13} className="text-brand-600" />
                          Live View
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : !items ? (
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
                  {/* Visual Live Application Flow Stepper */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setViewingFlowLeave(leave)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setViewingFlowLeave(leave);
                    }}
                    className="mt-2.5 rounded-xl border border-blue-200/90 bg-gradient-to-r from-blue-50/80 via-indigo-50/50 to-slate-50/80 p-2.5 transition-all hover:border-brand-400 hover:shadow-xs cursor-pointer group"
                    title="Click to view live interactive application flow diagram"
                  >
                    <div className="flex items-center justify-between text-[11px] font-bold text-ink-600 mb-2">
                      <div className="flex items-center gap-1.5">
                        <span className="flex h-2 w-2 relative">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-500 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-600"></span>
                        </span>
                        <span className="text-brand-900 uppercase tracking-wider text-[10px] font-bold">Live Flow Status</span>
                      </div>
                      <span className="text-[10px] text-brand-700 font-semibold group-hover:underline flex items-center gap-0.5">
                        <span>Inspect Flow</span>
                        <Icon name="chevronRight" size={12} />
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {/* Step 1: Submitted */}
                      <div className="flex items-center gap-2 rounded-lg bg-white/95 p-2 border border-emerald-200 shadow-2xs">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white shadow-2xs">
                          ✓
                        </span>
                        <div className="min-w-0">
                          <p className="text-[11px] font-bold text-emerald-950 truncate">1. Submitted</p>
                          <p className="text-[9px] text-ink-500 truncate">{leave.createdAt ? formatDate(leave.createdAt) : 'Applied'}</p>
                        </div>
                      </div>

                      {/* Step 2: Manager Review */}
                      {(() => {
                        const isDone = Boolean(leave.managerActionAt) || leave.status === 'pending_hr' || leave.status === 'approved';
                        const isCurrent = leave.status === 'pending_manager';
                        const isRejected = leave.status === 'rejected' && !leave.managerActionAt;
                        return (
                          <div className={cx(
                            'flex items-center gap-2 rounded-lg p-2 border shadow-2xs',
                            isDone ? 'bg-emerald-50/90 border-emerald-200' : isCurrent ? 'bg-amber-50/95 border-amber-300 ring-1 ring-amber-400/30' : isRejected ? 'bg-red-50 border-red-200' : 'bg-white/90 border-ink-100 opacity-80'
                          )}>
                            <span className={cx(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                              isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300'
                            )}>
                              {isDone ? '✓' : isRejected ? '✕' : '2'}
                            </span>
                            <div className="min-w-0">
                              <p className={cx('text-[11px] font-bold truncate', isDone ? 'text-emerald-950' : isCurrent ? 'text-amber-950' : isRejected ? 'text-red-950' : 'text-ink-700')}>
                                2. Manager
                              </p>
                              <p className="text-[9px] text-ink-500 truncate" title={leave.managerName ?? 'Direct Manager'}>
                                {isDone ? 'Approved' : isCurrent ? 'Awaiting Review' : isRejected ? 'Rejected' : leave.managerName ?? 'Manager Review'}
                              </p>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Step 3: HR Review */}
                      {(() => {
                        const isDone = Boolean(leave.hrActionAt) || leave.status === 'approved';
                        const isCurrent = leave.status === 'pending_hr';
                        const isRejected = leave.status === 'rejected' && Boolean(leave.managerActionAt) && !leave.hrActionAt;
                        return (
                          <div className={cx(
                            'flex items-center gap-2 rounded-lg p-2 border shadow-2xs',
                            isDone ? 'bg-emerald-50/90 border-emerald-200' : isCurrent ? 'bg-amber-50/95 border-amber-300 ring-1 ring-amber-400/30' : isRejected ? 'bg-red-50 border-red-200' : 'bg-white/90 border-ink-100 opacity-80'
                          )}>
                            <span className={cx(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                              isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300'
                            )}>
                              {isDone ? '✓' : isRejected ? '✕' : '3'}
                            </span>
                            <div className="min-w-0">
                              <p className={cx('text-[11px] font-bold truncate', isDone ? 'text-emerald-950' : isCurrent ? 'text-amber-950' : isRejected ? 'text-red-950' : 'text-ink-700')}>
                                3. HR Final
                              </p>
                              <p className="text-[9px] text-ink-500 truncate" title={leave.hrName ?? 'HR Operations'}>
                                {isDone ? 'Approved' : isCurrent ? 'Awaiting HR' : isRejected ? 'Rejected' : leave.hrName ?? 'HR Review'}
                              </p>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Step 4: Attendance Sync */}
                      {(() => {
                        const isApproved = leave.status === 'approved';
                        const isRejected = leave.status === 'rejected';
                        const isCancelled = leave.status === 'cancelled';
                        return (
                          <div className={cx(
                            'flex items-center gap-2 rounded-lg p-2 border shadow-2xs',
                            isApproved ? 'bg-emerald-50/90 border-emerald-200' : isRejected || isCancelled ? 'bg-red-50 border-red-200' : 'bg-white/90 border-ink-100 opacity-80'
                          )}>
                            <span className={cx(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                              isApproved ? 'bg-emerald-600' : isRejected || isCancelled ? 'bg-red-500' : 'bg-ink-300'
                            )}>
                              {isApproved ? '✓' : isRejected || isCancelled ? '✕' : '4'}
                            </span>
                            <div className="min-w-0">
                              <p className={cx('text-[11px] font-bold truncate', isApproved ? 'text-emerald-950' : isRejected || isCancelled ? 'text-red-950' : 'text-ink-700')}>
                                4. Live Sync
                              </p>
                              <p className="text-[9px] text-ink-500 truncate">
                                {isApproved ? 'Attendance Synced' : isRejected ? 'Rejected' : isCancelled ? 'Cancelled' : 'Pending'}
                              </p>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                  {leave.documentFileId && <a href={fileUrl(leave.documentFileId, true)} className="mt-1 block text-xs text-brand-700 underline">Download supporting document</a>}
                  {leave.decisionNote && <p className="mt-1 text-xs text-ink-500">Decision note: {leave.decisionNote}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-xs font-semibold text-brand-800 shadow-xs hover:bg-brand-100 hover:border-brand-400 transition-colors"
                    onClick={() => setViewingFlowLeave(leave)}
                    title="Open interactive application flow"
                  >
                    <Icon name="activity" size={13} className="text-brand-700" />
                    Flow View
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-700 shadow-xs hover:bg-ink-50 hover:border-brand-300 transition-colors"
                    onClick={() => setViewingLeave(leave)}
                  >
                    <Icon name="eye" size={13} className="text-brand-600" />
                    Live View
                  </button>
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
                    <button
                      type="button"
                      className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                      onClick={() => void cancel(leave.id)}
                    >
                      Cancel
                    </button>
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
            <span className="label font-bold text-ink-900">Request type</span>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3" role="group" aria-label="Request type">
              {optionButton('regular', 'calendar', 'Regular Leave', 'CL / SL / EL')}
              {optionButton('weekly_off', 'calendar', 'Weekly Off', `Saved (${w?.available ?? 0} avail)`)}
              {optionButton('half_day', 'clock', 'Half-Day Leave', '0.5 day')}
            </div>
          </div>

          {requestType === 'regular' ? (
            <>
              <Field label="Leave type" required>
                <select
                  className="input font-medium"
                  value={selectedLeaveTypeId}
                  onChange={(e) => setSelectedLeaveTypeId(e.target.value)}
                  required
                >
                  <option value="">Select leave type</option>
                  {types.map((t) => {
                    const bal = balances.find((b) => b.leaveTypeId === t.id);
                    let label = t.name;
                    if (t.code === 'LWP') label += ' (Unpaid · Loss of Pay)';
                    else if (t.code === 'CO') label += ` (${bal?.available ?? 0} days available · Compensatory Off)`;
                    else if (t.code === 'ML') label += ' (Maternity · 26 weeks · Medical doc required)';
                    else if (t.code === 'PL') label += ' (Paternity · Up to 10 days · Doc required)';
                    else label += ` (${bal?.available ?? t.annual_quota} days available)`;
                    return (
                      <option key={t.id} value={t.id}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Start date" required>
                  <input
                    type="date"
                    className="input font-medium"
                    value={startDate}
                    min={localToday()}
                    onChange={(e) => {
                      setStartDate(e.target.value);
                      if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
                    }}
                    required
                  />
                </Field>
                <Field label="End date" required>
                  <input
                    type="date"
                    className="input font-medium"
                    value={endDate}
                    min={startDate || localToday()}
                    onChange={(e) => setEndDate(e.target.value)}
                    required
                  />
                </Field>
              </div>

              {breakdownError ? (
                <p role="alert" className="text-xs text-red-600">{breakdownError}</p>
              ) : breakdown ? (
                <div className={breakdown.chargedDays > 0 ? 'rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-700' : 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800'}>
                  {breakdown.calendarCounted ? (
                    <p><strong>{breakdown.chargedDays}</strong> calendar day(s) (maternity leave is counted in calendar days).</p>
                  ) : breakdown.chargedDays > 0 ? (
                    <p>
                      <strong>{breakdown.chargedDays}</strong> day(s) will be deducted from your leave balance
                      {breakdown.weeklyOffDays + breakdown.holidayDays > 0 &&
                        ` (${breakdown.calendarDays} calendar days; ${breakdown.weeklyOffDays ? `${breakdown.weeklyOffDays} Sunday weekly off(s)` : ''}${breakdown.weeklyOffDays && breakdown.holidayDays ? ' and ' : ''}${breakdown.holidayDays ? `${breakdown.holidayDays} public holiday(s)` : ''} not charged)`}
                      .
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="font-semibold text-amber-900">
                        These selected dates ({startDate === endDate ? formatDate(startDate) : `${formatDate(startDate)} to ${formatDate(endDate)}`}) are Sunday weekly off(s) or public holidays.
                      </p>
                      {breakdown.weeklyOffDays > 0 && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-amber-200">
                          <span className="text-[11px] text-amber-800 font-medium">
                            Want to take this date as your scheduled weekly off from your monthly balance?
                          </span>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 transition-colors"
                            onClick={() => {
                              setRequestType('weekly_off');
                              setWoDate(startDate);
                            }}
                          >
                            <Icon name="calendar" size={12} />
                            Apply as Saved Weekly Off
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : null}

              <Field label="Supporting document (optional)">
                <input type="file" className="input" onChange={(event) => setDocument(event.target.files?.[0] ?? null)} />
              </Field>
            </>
          ) : requestType === 'weekly_off' ? (
            <>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="label mb-0 block font-bold text-ink-900">Select weekly-off date</span>
                    <span className="text-[11px] text-ink-500">Only saved/allocated weekly offs can be selected and taken</span>
                  </div>
                  <MonthPicker year={woPeriod.year} month={woPeriod.month} onChange={(year, month) => { setWoPeriod({ year, month }); setWoDate(''); }} />
                </div>

                {/* Monthly Saved Weekly-Off Balance Summary Card */}
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 text-xs text-emerald-950 sm:grid-cols-4 shadow-xs">
                  <div>
                    <span className="text-[11px] text-emerald-700 block">Total Sundays</span>
                    <strong className="text-sm font-bold">{woSummary?.totalSundays ?? 5}</strong>
                  </div>
                  <div>
                    <span className="text-[11px] text-emerald-700 block">Allocated</span>
                    <strong className="text-sm font-bold">{w?.allocated ?? 0}</strong>
                  </div>
                  <div>
                    <span className="text-[11px] text-emerald-700 block">Taken</span>
                    <strong className="text-sm font-bold text-emerald-800">{w?.taken ?? 0}</strong>
                  </div>
                  <div>
                    <span className="text-[11px] text-emerald-700 block">Saved / Available</span>
                    <strong className={cx('text-sm font-bold', (w?.available ?? 0) > 0 ? 'text-emerald-700' : 'text-red-600')}>
                      {w?.available ?? 0} available
                    </strong>
                  </div>
                  {(w?.pending ?? 0) > 0 && (
                    <div className="col-span-2 sm:col-span-4 pt-1 border-t border-emerald-200 text-emerald-800 text-[11px]">
                      {w?.pending} date(s) currently reserved by pending approval.
                    </div>
                  )}
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
                              'rounded-lg border px-2.5 py-2.5 text-left text-xs transition-all',
                              selected
                                ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30 font-bold shadow-xs'
                                : selectable
                                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:border-emerald-400 hover:bg-emerald-100/60 cursor-pointer'
                                  : 'cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400 opacity-60',
                            )}
                          >
                            <span className="block font-bold">{formatDate(entry.date)}</span>
                            <span className="text-[11px] mt-0.5 block">{WEEKLY_OFF_STATUS_LABEL[entry.status]}</span>
                          </button>
                        );
                      })}
                    </div>

                    {(w?.available ?? 0) <= 0 ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 font-medium">
                        ⚠️ No saved weekly-off balance is available for {woSummary.monthName} {woSummary.year}. You have taken or reserved all eligible weekly offs.
                      </div>
                    ) : woDate ? (
                      <div className="rounded-lg border border-brand-200 bg-brand-50/70 p-3 text-xs text-brand-950 font-medium">
                        Selected date: <strong>{formatDate(woDate)}</strong> · 1 day will be deducted from your saved weekly-off quota upon approval (Remaining: <strong>{Math.max(0, (w?.remaining ?? 0) - 1)}</strong>).
                      </div>
                    ) : null}
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

      {/* LIVE LEAVE REQUEST VIEW MODAL */}
      <Modal
        open={Boolean(viewingLeave)}
        onClose={() => setViewingLeave(null)}
        title={viewingLeave ? `Live Request View · ${requestTitle(viewingLeave)}` : 'Live Request View'}
        size="lg"
        footer={
          viewingLeave && (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div>
                {viewingLeave.canCancel && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                    onClick={() => void cancel(viewingLeave.id)}
                  >
                    Cancel Request
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {viewingLeave.canApproveManager && (
                  <>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={async () => {
                        await decide(viewingLeave.id, true, 'manager');
                        setViewingLeave(null);
                      }}
                    >
                      Manager Approve
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={async () => {
                        await decide(viewingLeave.id, false, 'manager');
                        setViewingLeave(null);
                      }}
                    >
                      Manager Reject
                    </button>
                  </>
                )}
                {viewingLeave.canApproveHr && (
                  <>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={async () => {
                        await decide(viewingLeave.id, true, 'hr');
                        setViewingLeave(null);
                      }}
                    >
                      HR Approve
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={async () => {
                        await decide(viewingLeave.id, false, 'hr');
                        setViewingLeave(null);
                      }}
                    >
                      HR Reject
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setViewingFlowLeave(viewingLeave);
                    setViewingLeave(null);
                  }}
                >
                  <Icon name="activity" size={13} className="mr-1 text-brand-600" />
                  Flow View
                </button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => setViewingLeave(null)}>
                  Close
                </button>
              </div>
            </div>
          )
        }
      >
        {viewingLeave && (
          <div className="space-y-4 text-ink-800">
            {/* Live Telemetry Banner */}
            <div className="relative overflow-hidden rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50 via-indigo-50 to-emerald-50 p-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-3 w-3 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-bold text-ink-900">{requestTitle(viewingLeave)}</span>
                      <RequestStatus status={viewingLeave.status} />
                      <Badge tone="neutral" className="font-semibold">{viewingLeave.days} day(s)</Badge>
                      {viewingLeave.isHalfDay && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-blue-100 text-blue-900 font-bold px-2 py-0.5 text-xs border border-blue-200">
                          <Icon name="clock" size={12} />
                          Half Day · {viewingLeave.halfDaySlot === 'second_half' ? SLOT_LABEL.second_half : SLOT_LABEL.first_half}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-600 mt-1">
                      Live status telemetry · Synced with HRMS attendance & roster engine
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-mono text-ink-500">Req #{viewingLeave.id}</span>
                  <div className="text-xs font-semibold text-brand-700">
                    {formatDate(viewingLeave.startDate)}
                    {viewingLeave.startDate !== viewingLeave.endDate && ` → ${formatDate(viewingLeave.endDate)}`}
                  </div>
                </div>
              </div>
            </div>

            {/* Live 4-Stage Approval & System Pipeline */}
            <div className="rounded-xl border border-ink-200 bg-white p-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-500 mb-3 flex items-center gap-1.5">
                <Icon name="check" size={13} className="text-brand-600" />
                Live Approval & Synchronization Pipeline
              </h4>
              <div className="grid gap-3 sm:grid-cols-4">
                {/* Stage 1: Submitted */}
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-[10px] text-white">✓</span>
                    1. Application
                  </div>
                  <p className="text-[11px] font-semibold text-emerald-950 mt-1">Submitted</p>
                  <p className="text-[10px] text-ink-500 mt-0.5">
                    {viewingLeave.createdAt ? formatDateTime(viewingLeave.createdAt) : 'Initial creation'}
                  </p>
                </div>

                {/* Stage 2: Manager Review */}
                {(() => {
                  const isDone = Boolean(viewingLeave.managerActionAt) || viewingLeave.status === 'pending_hr' || viewingLeave.status === 'approved';
                  const isCurrent = viewingLeave.status === 'pending_manager';
                  return (
                    <div className={cx(
                      'rounded-lg border p-2.5',
                      isDone ? 'border-emerald-200 bg-emerald-50/50' : isCurrent ? 'border-amber-300 bg-amber-50/60 ring-2 ring-amber-400/20' : 'border-ink-200 bg-ink-50/40'
                    )}>
                      <div className="flex items-center gap-1.5 text-xs font-bold">
                        <span className={cx(
                          'flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                          isDone ? 'bg-emerald-600 text-white' : isCurrent ? 'bg-amber-500 text-white animate-pulse' : 'bg-ink-300 text-white'
                        )}>
                          {isDone ? '✓' : '2'}
                        </span>
                        <span className={isDone ? 'text-emerald-800' : isCurrent ? 'text-amber-800' : 'text-ink-600'}>2. Manager</span>
                      </div>
                      <p className="text-[11px] font-semibold text-ink-900 mt-1 truncate" title={viewingLeave.managerName ?? 'Direct Manager'}>
                        {viewingLeave.managerName ?? 'Direct Manager'}
                      </p>
                      <p className="text-[10px] text-ink-500 mt-0.5">
                        {isDone ? (viewingLeave.managerActionAt ? formatDateTime(viewingLeave.managerActionAt) : 'Approved') : isCurrent ? 'Awaiting review' : 'Pending'}
                      </p>
                    </div>
                  );
                })()}

                {/* Stage 3: HR Review */}
                {(() => {
                  const isDone = Boolean(viewingLeave.hrActionAt) || viewingLeave.status === 'approved';
                  const isCurrent = viewingLeave.status === 'pending_hr';
                  return (
                    <div className={cx(
                      'rounded-lg border p-2.5',
                      isDone ? 'border-emerald-200 bg-emerald-50/50' : isCurrent ? 'border-amber-300 bg-amber-50/60 ring-2 ring-amber-400/20' : 'border-ink-200 bg-ink-50/40'
                    )}>
                      <div className="flex items-center gap-1.5 text-xs font-bold">
                        <span className={cx(
                          'flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                          isDone ? 'bg-emerald-600 text-white' : isCurrent ? 'bg-amber-500 text-white animate-pulse' : 'bg-ink-300 text-white'
                        )}>
                          {isDone ? '✓' : '3'}
                        </span>
                        <span className={isDone ? 'text-emerald-800' : isCurrent ? 'text-amber-800' : 'text-ink-600'}>3. HR Final</span>
                      </div>
                      <p className="text-[11px] font-semibold text-ink-900 mt-1 truncate" title={viewingLeave.hrName ?? 'HR Operations'}>
                        {viewingLeave.hrName ?? 'HR Operations'}
                      </p>
                      <p className="text-[10px] text-ink-500 mt-0.5">
                        {isDone ? (viewingLeave.hrActionAt ? formatDateTime(viewingLeave.hrActionAt) : 'Approved') : isCurrent ? 'Awaiting review' : 'Pending'}
                      </p>
                    </div>
                  );
                })()}

                {/* Stage 4: Attendance Sync */}
                {(() => {
                  const isApproved = viewingLeave.status === 'approved';
                  const isCancelled = viewingLeave.status === 'cancelled';
                  const isRejected = viewingLeave.status === 'rejected';
                  return (
                    <div className={cx(
                      'rounded-lg border p-2.5',
                      isApproved ? 'border-emerald-200 bg-emerald-50/50' : isCancelled || isRejected ? 'border-red-200 bg-red-50/40' : 'border-ink-200 bg-ink-50/40'
                    )}>
                      <div className="flex items-center gap-1.5 text-xs font-bold">
                        <span className={cx(
                          'flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                          isApproved ? 'bg-emerald-600 text-white' : isCancelled || isRejected ? 'bg-red-500 text-white' : 'bg-ink-300 text-white'
                        )}>
                          {isApproved ? '✓' : isCancelled || isRejected ? '✕' : '4'}
                        </span>
                        <span className={isApproved ? 'text-emerald-800' : isCancelled || isRejected ? 'text-red-700' : 'text-ink-600'}>4. Live Sync</span>
                      </div>
                      <p className="text-[11px] font-semibold text-ink-900 mt-1">
                        {isApproved ? 'Attendance Synced' : isCancelled ? 'Cancelled' : isRejected ? 'Rejected' : 'Pending Approval'}
                      </p>
                      <p className="text-[10px] text-ink-500 mt-0.5">
                        {isApproved ? 'Updated on roster' : isCancelled || isRejected ? 'Regular duty active' : 'Sync on completion'}
                      </p>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Employee, Location & Schedule Info Grid */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-ink-200 bg-ink-50/40 p-3.5 space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-ink-500">Applicant Details</span>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-ink-500">Employee Name:</span>
                    <span className="font-bold text-ink-900">{viewingLeave.employeeName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Employee ID / Code:</span>
                    <span className="font-mono font-semibold text-ink-800">{viewingLeave.employeeCode}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Department:</span>
                    <span className="font-medium text-ink-800">{viewingLeave.departmentName ?? 'General Operations'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Store / Location:</span>
                    <span className="font-semibold text-brand-700">{viewingLeave.locationName ?? 'Not Assigned'}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-ink-200 bg-ink-50/40 p-3.5 space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-ink-500">Schedule & Leave Metrics</span>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-ink-500">Request Type:</span>
                    <span className="font-bold text-ink-900">{requestTitle(viewingLeave)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Requested Period:</span>
                    <span className="font-semibold text-ink-900">
                      {formatDate(viewingLeave.startDate)}
                      {viewingLeave.startDate !== viewingLeave.endDate && ` to ${formatDate(viewingLeave.endDate)}`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Charged Duration:</span>
                    <span className="font-bold text-ink-900">{viewingLeave.days} Day(s)</span>
                  </div>
                  {viewingLeave.isHalfDay && (
                    <div className="flex justify-between">
                      <span className="text-ink-500">Shift Slot:</span>
                      <span className="font-semibold text-blue-700">
                        {viewingLeave.halfDaySlot === 'second_half' ? 'Second Half (Afternoon)' : 'First Half (Morning)'}
                      </span>
                    </div>
                  )}
                  {Boolean(viewingLeave.weeklyOffDays) && (
                    <div className="flex justify-between">
                      <span className="text-ink-500">Weekly Offs Excluded:</span>
                      <span className="font-semibold text-emerald-700">{viewingLeave.weeklyOffDays} Sunday(s) (Not Charged)</span>
                    </div>
                  )}
                  {Boolean(viewingLeave.holidayDays) && (
                    <div className="flex justify-between">
                      <span className="text-ink-500">Holidays Excluded:</span>
                      <span className="font-semibold text-violet-700">{viewingLeave.holidayDays} Holiday(s) (Not Charged)</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Reason & Approver Remarks */}
            <div className="rounded-xl border border-ink-200 bg-white p-3.5 space-y-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-ink-500">Reason / Notes</span>
                <div className="mt-1 rounded-lg border border-ink-100 bg-ink-50/50 p-2.5 text-xs text-ink-800">
                  {viewingLeave.reason ? viewingLeave.reason : <span className="italic text-ink-400">No reason provided (optional field)</span>}
                </div>
              </div>

              {viewingLeave.decisionNote && (
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-ink-500">Approver Decision Note</span>
                  <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-xs text-amber-950 font-medium">
                    {viewingLeave.decisionNote}
                  </div>
                </div>
              )}

              {viewingLeave.documentFileId && (
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-ink-500">Supporting Document</span>
                  <div className="mt-1">
                    <a
                      href={fileUrl(viewingLeave.documentFileId, true)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 transition-colors"
                    >
                      <Icon name="file" size={14} />
                      Download Attached Document
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* LIVE APPLICATION FLOW VIEW MODAL */}
      <Modal
        open={Boolean(viewingFlowLeave)}
        onClose={() => setViewingFlowLeave(null)}
        title={viewingFlowLeave ? `Live Application Flow · Req #${viewingFlowLeave.id}` : 'Live Application Flow'}
        size="lg"
        footer={
          viewingFlowLeave && (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {viewingFlowLeave.canCancel && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                    onClick={() => void cancel(viewingFlowLeave.id)}
                  >
                    Cancel Request
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setViewingLeave(viewingFlowLeave);
                    setViewingFlowLeave(null);
                  }}
                >
                  <Icon name="eye" size={13} className="mr-1 text-ink-600" />
                  Live View
                </button>
              </div>
              <div className="flex items-center gap-2">
                {viewingFlowLeave.canApproveManager && (
                  <>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={async () => {
                        await decide(viewingFlowLeave.id, true, 'manager');
                      }}
                    >
                      Manager Approve
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={async () => {
                        await decide(viewingFlowLeave.id, false, 'manager');
                      }}
                    >
                      Manager Reject
                    </button>
                  </>
                )}
                {viewingFlowLeave.canApproveHr && (
                  <>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={async () => {
                        await decide(viewingFlowLeave.id, true, 'hr');
                      }}
                    >
                      HR Approve
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={async () => {
                        await decide(viewingFlowLeave.id, false, 'hr');
                      }}
                    >
                      HR Reject
                    </button>
                  </>
                )}
                <button type="button" className="btn-secondary btn-sm" onClick={() => setViewingFlowLeave(null)}>
                  Close
                </button>
              </div>
            </div>
          )
        }
      >
        {viewingFlowLeave && (
          <div className="space-y-4 text-ink-800">
            {/* Header Telemetry Card */}
            <div className="relative overflow-hidden rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50 via-indigo-50 to-slate-50 p-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-3 w-3 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-500 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-600"></span>
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-bold text-ink-900">{requestTitle(viewingFlowLeave)}</span>
                      <RequestStatus status={viewingFlowLeave.status} />
                      <Badge tone="neutral" className="font-semibold">{viewingFlowLeave.days} day(s)</Badge>
                      {viewingFlowLeave.isHalfDay && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-blue-100 text-blue-900 font-bold px-2 py-0.5 text-xs border border-blue-200">
                          <Icon name="clock" size={12} />
                          Half Day · {viewingFlowLeave.halfDaySlot === 'second_half' ? SLOT_LABEL.second_half : SLOT_LABEL.first_half}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-600 mt-1">
                      Live application lifecycle flow · Telemetry synced with BSC HRMS database
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-mono text-ink-500">Req #{viewingFlowLeave.id}</span>
                  <div className="text-xs font-semibold text-brand-700">
                    {formatDate(viewingFlowLeave.startDate)}
                    {viewingFlowLeave.startDate !== viewingFlowLeave.endDate && ` → ${formatDate(viewingFlowLeave.endDate)}`}
                  </div>
                </div>
              </div>

              {/* Lifecycle Progress Bar */}
              {(() => {
                const isApproved = viewingFlowLeave.status === 'approved';
                const isPendingHr = viewingFlowLeave.status === 'pending_hr';
                const isPendingMgr = viewingFlowLeave.status === 'pending_manager';
                const isRejected = viewingFlowLeave.status === 'rejected';
                const isCancelled = viewingFlowLeave.status === 'cancelled';
                const percent = isApproved ? 100 : isPendingHr ? 66 : isPendingMgr ? 33 : (isRejected || isCancelled) ? 100 : 25;
                const barColor = isApproved ? 'bg-emerald-500' : isRejected || isCancelled ? 'bg-red-500' : 'bg-brand-600';
                return (
                  <div className="mt-3.5 space-y-1">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-ink-600">
                      <span>Flow Progress: {isApproved ? 'Approved & Synced (100%)' : isPendingHr ? 'Awaiting HR Approval (66%)' : isPendingMgr ? 'Awaiting Manager Review (33%)' : isRejected ? 'Rejected (100%)' : isCancelled ? 'Cancelled (100%)' : 'Processing'}</span>
                      <span className="font-mono">{percent}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-200">
                      <div className={cx('h-full transition-all duration-500', barColor)} style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Interactive 4-Stage Flow Diagram */}
            <div className="rounded-xl border border-ink-200 bg-white p-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-500 mb-3 flex items-center gap-1.5">
                <Icon name="activity" size={13} className="text-brand-600" />
                Live Application Pipeline & Decision Telemetry
              </h4>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {/* Node 1: Submission */}
                <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-900">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white shadow-2xs">✓</span>
                      <span>1. Application</span>
                    </div>
                    <span className="rounded-full bg-emerald-200/80 px-2 py-0.5 text-[10px] font-bold text-emerald-900">SUBMITTED</span>
                  </div>
                  <div className="space-y-1 text-xs">
                    <p className="font-bold text-ink-900">{viewingFlowLeave.employeeName}</p>
                    <p className="text-[11px] font-mono text-ink-500">{viewingFlowLeave.employeeCode} · {viewingFlowLeave.locationName ?? 'Location'}</p>
                    <p className="text-[10px] text-ink-600 font-medium">Applied: {viewingFlowLeave.createdAt ? formatDateTime(viewingFlowLeave.createdAt) : 'Initial Date'}</p>
                    <p className="text-[11px] text-ink-700 bg-white/70 rounded p-1 border border-emerald-100">
                      {viewingFlowLeave.days} Day(s) · {requestTitle(viewingFlowLeave)}
                    </p>
                  </div>
                </div>

                {/* Node 2: Manager Review */}
                {(() => {
                  const isDone = Boolean(viewingFlowLeave.managerActionAt) || viewingFlowLeave.status === 'pending_hr' || viewingFlowLeave.status === 'approved';
                  const isCurrent = viewingFlowLeave.status === 'pending_manager';
                  const isRejected = viewingFlowLeave.status === 'rejected' && !viewingFlowLeave.managerActionAt;
                  return (
                    <div className={cx(
                      'rounded-xl border p-3 space-y-2',
                      isDone ? 'border-emerald-300 bg-emerald-50/70' : isCurrent ? 'border-amber-300 bg-amber-50/80 ring-2 ring-amber-400/30' : isRejected ? 'border-red-300 bg-red-50/70' : 'border-ink-200 bg-ink-50/40 opacity-80'
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-bold">
                          <span className={cx(
                            'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                            isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300'
                          )}>
                            {isDone ? '✓' : isRejected ? '✕' : '2'}
                          </span>
                          <span className={isDone ? 'text-emerald-900' : isCurrent ? 'text-amber-900' : isRejected ? 'text-red-900' : 'text-ink-600'}>2. Manager</span>
                        </div>
                        <span className={cx(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold',
                          isDone ? 'bg-emerald-200/80 text-emerald-900' : isCurrent ? 'bg-amber-200 text-amber-900 animate-pulse' : isRejected ? 'bg-red-200 text-red-900' : 'bg-ink-200 text-ink-600'
                        )}>
                          {isDone ? 'REVIEWED' : isCurrent ? 'PENDING' : isRejected ? 'REJECTED' : 'WAITING'}
                        </span>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p className="font-bold text-ink-900">{viewingFlowLeave.managerName ?? 'Reporting Manager'}</p>
                        <p className="text-[11px] text-ink-500">First-level Reviewer</p>
                        <p className="text-[10px] text-ink-600 font-medium">
                          {isDone ? (viewingFlowLeave.managerActionAt ? formatDateTime(viewingFlowLeave.managerActionAt) : 'Approved') : isCurrent ? 'Awaiting Manager Action' : isRejected ? 'Declined at manager review' : 'Standing by'}
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* Node 3: HR Review */}
                {(() => {
                  const isDone = Boolean(viewingFlowLeave.hrActionAt) || viewingFlowLeave.status === 'approved';
                  const isCurrent = viewingFlowLeave.status === 'pending_hr';
                  const isRejected = viewingFlowLeave.status === 'rejected' && Boolean(viewingFlowLeave.managerActionAt) && !viewingFlowLeave.hrActionAt;
                  return (
                    <div className={cx(
                      'rounded-xl border p-3 space-y-2',
                      isDone ? 'border-emerald-300 bg-emerald-50/70' : isCurrent ? 'border-amber-300 bg-amber-50/80 ring-2 ring-amber-400/30' : isRejected ? 'border-red-300 bg-red-50/70' : 'border-ink-200 bg-ink-50/40 opacity-80'
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-bold">
                          <span className={cx(
                            'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                            isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300'
                          )}>
                            {isDone ? '✓' : isRejected ? '✕' : '3'}
                          </span>
                          <span className={isDone ? 'text-emerald-900' : isCurrent ? 'text-amber-900' : isRejected ? 'text-red-900' : 'text-ink-600'}>3. Location HR</span>
                        </div>
                        <span className={cx(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold',
                          isDone ? 'bg-emerald-200/80 text-emerald-900' : isCurrent ? 'bg-amber-200 text-amber-900 animate-pulse' : isRejected ? 'bg-red-200 text-red-900' : 'bg-ink-200 text-ink-600'
                        )}>
                          {isDone ? 'APPROVED' : isCurrent ? 'PENDING HR' : isRejected ? 'REJECTED' : 'WAITING'}
                        </span>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p className="font-bold text-ink-900">{viewingFlowLeave.hrName ?? 'HR Operations'}</p>
                        <p className="text-[11px] text-ink-500">Final Decision Maker</p>
                        <p className="text-[10px] text-ink-600 font-medium">
                          {isDone ? (viewingFlowLeave.hrActionAt ? formatDateTime(viewingFlowLeave.hrActionAt) : 'HR Approved') : isCurrent ? 'Awaiting HR Approval' : isRejected ? 'Declined at HR stage' : 'Standing by'}
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* Node 4: Attendance Sync */}
                {(() => {
                  const isApproved = viewingFlowLeave.status === 'approved';
                  const isRejected = viewingFlowLeave.status === 'rejected';
                  const isCancelled = viewingFlowLeave.status === 'cancelled';
                  return (
                    <div className={cx(
                      'rounded-xl border p-3 space-y-2',
                      isApproved ? 'border-emerald-300 bg-emerald-50/70' : isRejected || isCancelled ? 'border-red-300 bg-red-50/70' : 'border-ink-200 bg-ink-50/40 opacity-80'
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-bold">
                          <span className={cx(
                            'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                            isApproved ? 'bg-emerald-600' : isRejected || isCancelled ? 'bg-red-500' : 'bg-ink-300'
                          )}>
                            {isApproved ? '✓' : isRejected || isCancelled ? '✕' : '4'}
                          </span>
                          <span className={isApproved ? 'text-emerald-900' : isRejected || isCancelled ? 'text-red-900' : 'text-ink-600'}>4. Live Sync</span>
                        </div>
                        <span className={cx(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold',
                          isApproved ? 'bg-emerald-200/80 text-emerald-900' : isRejected ? 'bg-red-200 text-red-900' : isCancelled ? 'bg-ink-200 text-ink-600' : 'bg-ink-200 text-ink-600'
                        )}>
                          {isApproved ? 'SYNCED' : isRejected ? 'VOIDED' : isCancelled ? 'CANCELLED' : 'QUEUED'}
                        </span>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p className="font-bold text-ink-900">{isApproved ? 'Attendance Engine Synced' : isRejected ? 'Request Voided' : isCancelled ? 'Request Cancelled' : 'Roster Sync Queued'}</p>
                        <p className="text-[11px] text-ink-500">Biometrics & Roster</p>
                        <p className="text-[10px] text-ink-600 font-medium">
                          {isApproved ? 'Roster marked with leave code' : isRejected || isCancelled ? 'Regular shifts retained' : 'Triggers on final approval'}
                        </p>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Application Details & Approver Decision Notes */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-ink-200 bg-ink-50/40 p-3.5 space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-ink-500">Employee & Schedule Details</span>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-ink-500">Applicant:</span>
                    <span className="font-bold text-ink-900">{viewingFlowLeave.employeeName} ({viewingFlowLeave.employeeCode})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Department / Store:</span>
                    <span className="font-medium text-ink-800">{viewingFlowLeave.departmentName ?? 'General'} · {viewingFlowLeave.locationName ?? 'Not Assigned'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Requested Period:</span>
                    <span className="font-semibold text-ink-900">
                      {formatDate(viewingFlowLeave.startDate)}
                      {viewingFlowLeave.startDate !== viewingFlowLeave.endDate && ` to ${formatDate(viewingFlowLeave.endDate)}`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-500">Duration:</span>
                    <span className="font-bold text-brand-700">{viewingFlowLeave.days} Day(s){viewingFlowLeave.isHalfDay ? ` (Half Day · ${viewingFlowLeave.halfDaySlot === 'second_half' ? SLOT_LABEL.second_half : SLOT_LABEL.first_half})` : ''}</span>
                  </div>
                  {Boolean(viewingFlowLeave.weeklyOffDays) && (
                    <div className="flex justify-between">
                      <span className="text-ink-500">Sundays Not Charged:</span>
                      <span className="font-semibold text-emerald-700">{viewingFlowLeave.weeklyOffDays} Sunday Weekly Off(s) Preserved</span>
                    </div>
                  )}
                  {Boolean(viewingFlowLeave.holidayDays) && (
                    <div className="flex justify-between">
                      <span className="text-ink-500">Holidays Excluded:</span>
                      <span className="font-semibold text-violet-700">{viewingFlowLeave.holidayDays} Holiday(s) Preserved</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-ink-200 bg-ink-50/40 p-3.5 space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-ink-500">Notes & Decision Trail</span>
                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-[11px] font-semibold text-ink-500">Employee Reason:</span>
                    <p className="mt-0.5 rounded bg-white p-2 border border-ink-100 text-ink-800">
                      {viewingFlowLeave.reason ? viewingFlowLeave.reason : <span className="italic text-ink-400">No reason specified (optional)</span>}
                    </p>
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-ink-500">Approver Decision Note:</span>
                    <p className={cx('mt-0.5 rounded p-2 border text-xs font-medium', viewingFlowLeave.decisionNote ? 'bg-amber-50/80 border-amber-200 text-amber-950' : 'bg-white border-ink-100 text-ink-400 italic')}>
                      {viewingFlowLeave.decisionNote ? viewingFlowLeave.decisionNote : 'No approver note added'}
                    </p>
                  </div>
                  {viewingFlowLeave.documentFileId && (
                    <div>
                      <a
                        href={fileUrl(viewingFlowLeave.documentFileId, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-100 transition-colors"
                      >
                        <Icon name="file" size={13} />
                        Download Attached Supporting Document
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Audit History Timeline Log */}
            {viewingFlowLeave.history && viewingFlowLeave.history.length > 0 && (
              <div className="rounded-xl border border-ink-200 bg-white p-3.5">
                <span className="text-xs font-bold uppercase tracking-wider text-ink-500 block mb-2.5">
                  Chronological Audit Trail & State Transitions
                </span>
                <div className="divide-y divide-ink-100 text-xs">
                  {viewingFlowLeave.history.map((step, idx) => (
                    <div key={idx} className="flex items-center justify-between py-2 gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-bold text-brand-700 border border-brand-200">
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold text-ink-900 truncate">
                            {HISTORY_LABEL[step.action] ?? titleize(step.action)}
                            {step.actorName && <span className="text-ink-600 font-normal"> by <strong>{step.actorName}</strong></span>}
                          </p>
                          {step.note && <p className="text-[11px] text-ink-600 italic mt-0.5 font-sans">"{step.note}"</p>}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-mono text-[11px] text-ink-500">{step.at ? formatDateTime(step.at) : 'Logged'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
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
