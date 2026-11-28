import { useEffect, useState } from 'react';
import { api, errorMessage, fileUrl } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime, statusTone, titleize, todayDateString } from '../lib/format';
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
  pending_both: 'Pending Manager & HR Approval',
  pending_hr: 'Approved by Manager · Pending HR Verification',
  pending_manager: 'Verified by HR · Pending Manager Approval',
  pending: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const HISTORY_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  hr_approved: 'Verified by Location HR',
  hr_rejected: 'Rejected by Location HR',
  manager_approved: 'Approved by Manager',
  manager_rejected: 'Rejected by Manager',
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
  return todayDateString();
}

function requestTitle(leave: LeaveItem): string {
  if (leave.requestKind === 'weekly_off') return 'Week Off';
  if (leave.requestKind === 'half_day' || leave.isHalfDay) return `Half-Day Leave · ${leave.leaveType || 'General'}`;
  return leave.leaveType || 'Leave Request';
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // ------------------------------------------------------------ application form
  const [requestType, setRequestType] = useState<RequestOption>('regular');
  const [reason, setReason] = useState('');
  const [document, setDocument] = useState<File | null>(null);

  // Regular Leave State (CL, SL, EL, etc.)
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [selectedLeaveTypeId, setSelectedLeaveTypeId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(() => todayDateString());
  const [endDate, setEndDate] = useState<string>(() => todayDateString());
  const [breakdown, setBreakdown] = useState<DayBreakdown | null>(null);
  const [breakdownError, setBreakdownError] = useState<string>('');

  // Weekly Off State (only user with saved weekly off can take)
  const [woPeriod, setWoPeriod] = useState(() => {
    const today = todayDateString();
    return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  });
  const [woMode, setWoMode] = useState<'single' | 'range'>('single');
  const [woDate, setWoDate] = useState(() => todayDateString());
  const [woStartDate, setWoStartDate] = useState(() => todayDateString());
  const [woEndDate, setWoEndDate] = useState(() => todayDateString());
  const { data: woSummary, error: woError, loading: woLoading } = useWeeklyOffSummary(undefined, woPeriod.year, woPeriod.month);

  // Helper to calculate requested week-off days
  const getWoDaysCount = (): number => {
    if (woMode === 'single') return woDate ? 1 : 0;
    if (!woStartDate || !woEndDate || woEndDate < woStartDate) return 0;
    const diff = Math.round((new Date(woEndDate).getTime() - new Date(woStartDate).getTime()) / (1000 * 3600 * 24)) + 1;
    return Math.max(0, diff);
  };

  // Half Day State (0.5 day)
  const [hdDate, setHdDate] = useState(() => todayDateString());
  const [hdSlot, setHdSlot] = useState<HalfDaySlot>('first_half');
  const [halfPreview, setHalfPreview] = useState<HalfDayPreview | null>(null);
  const [halfPreviewError, setHalfPreviewError] = useState('');

  const resetForm = () => {
    const today = todayDateString();
    setRequestType('regular');
    setReason('');
    setDocument(null);
    setWoMode('single');
    setWoDate(today);
    setWoStartDate(today);
    setWoEndDate(today);
    setHdDate(today);
    setHdSlot('first_half');
    setHalfPreview(null);
    setHalfPreviewError('');
    setStartDate(today);
    setEndDate(today);
    setBreakdown(null);
    setBreakdownError('');
  };

  useEffect(() => {
    if (applyOpen) {
      const today = todayDateString();
      if (!startDate) setStartDate(today);
      if (!endDate) setEndDate(today);
      if (!woDate) setWoDate(today);
      if (!woStartDate) setWoStartDate(today);
      if (!woEndDate) setWoEndDate(today);
      if (!hdDate) setHdDate(today);
    }
  }, [applyOpen]);

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
      ? woMode === 'single'
        ? Boolean(woDate) && (woSummary?.weeklyOffs.available ?? 0) >= 1
        : Boolean(woStartDate && woEndDate && woEndDate >= woStartDate && getWoDaysCount() > 0 && (woSummary?.weeklyOffs.available ?? 0) >= getWoDaysCount())
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
        const needed = getWoDaysCount();
        if ((woSummary?.weeklyOffs.available ?? 0) < needed) {
          toast.error(`You have only ${woSummary?.weeklyOffs.available ?? 0} saved weekly off(s) available this month.`);
          return;
        }
        if (woMode === 'single') {
          await api.post('/leave/weekly-off', {
            date: woDate,
            reason: trimmed || undefined,
            hrApproverId: Number(hrApproverId),
          });
          toast.success(`Week-off request for ${formatDate(woDate)} submitted to Location HR for verification.`);
        } else {
          await api.post('/leave/weekly-off', {
            startDate: woStartDate,
            endDate: woEndDate,
            consecutive: true,
            reason: trimmed || undefined,
            hrApproverId: Number(hrApproverId),
          });
          toast.success(`Continuous week-off request (${needed} days) for ${formatDate(woStartDate)} to ${formatDate(woEndDate)} submitted to Location HR.`);
        }
      } else if (requestType === 'half_day') {
        await api.post('/leave/half-day', {
          date: hdDate,
          slot: hdSlot,
          reason: trimmed || undefined,
          hrApproverId: Number(hrApproverId),
          documentFileId,
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
      toast.success(
        approve
          ? stage === 'hr'
            ? 'Verified by Location HR · Forwarded to Reporting Manager.'
            : 'Approved by Manager · Attendance marked as Weekly Off.'
          : `Request rejected by ${stage === 'hr' ? 'Location HR' : 'Reporting Manager'}.`,
      );
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

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = (targetIds: number[]) => {
    setSelectedIds((prev) => {
      if (targetIds.every((id) => prev.has(id))) {
        return new Set();
      }
      return new Set(targetIds);
    });
  };

  const handleBulkDecide = async (approve: boolean) => {
    if (selectedIds.size === 0) return;
    const note = window.prompt(
      approve
        ? `Approve ${selectedIds.size} selected leave request(s)? Optional note:`
        : `Reject ${selectedIds.size} selected leave request(s)? Reason for rejection (mandatory):`,
    );
    if (note === null) return;
    if (!approve && !note.trim()) {
      toast.error('Rejection reason is required.');
      return;
    }
    setBulkBusy(true);
    try {
      const res = await api.post<{ successCount: number; failCount: number; errors: string[] }>('/leave/bulk-decide', {
        requestIds: Array.from(selectedIds),
        approve,
        note: note.trim() || undefined,
        stage: 'auto',
      });
      if (res.failCount > 0) {
        toast.warning(`Processed ${res.successCount} requests successfully. ${res.failCount} failed: ${res.errors[0] || ''}`);
      } else {
        toast.success(`Successfully ${approve ? 'approved' : 'rejected'} ${res.successCount} request(s).`);
      }
      setSelectedIds(new Set());
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBulkBusy(false);
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
                          className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-xs font-semibold text-brand-800 shadow-xs hover:bg-brand-100 hover:border-brand-400 transition-colors"
                          onClick={() => setViewingFlowLeave(leave)}
                          title="Open interactive application flow"
                        >
                          <Icon name="activity" size={13} className="text-brand-700" />
                          Flow View
                        </button>
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
          <div className="space-y-2">
            {/* Sticky Bulk Action Toolbar */}
            {selectedIds.size > 0 && (
              <div className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-300 bg-brand-50/95 p-3.5 shadow-md backdrop-blur-sm animate-in fade-in slide-in-from-top-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white shadow-xs">
                    {selectedIds.size}
                  </span>
                  <div>
                    <p className="text-xs font-bold text-brand-950">
                      {selectedIds.size} leave request{selectedIds.size > 1 ? 's' : ''} selected
                    </p>
                    <p className="text-[11px] text-brand-700">
                      Perform batch action across all selected items simultaneously
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary btn-sm bg-emerald-600 hover:bg-emerald-700 shadow-xs flex items-center gap-1.5"
                    disabled={bulkBusy}
                    onClick={() => void handleBulkDecide(true)}
                  >
                    <Icon name="check" size={13} />
                    <span>Bulk Approve ({selectedIds.size})</span>
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm text-red-600 border-red-200 hover:bg-red-50 shadow-xs flex items-center gap-1.5"
                    disabled={bulkBusy}
                    onClick={() => void handleBulkDecide(false)}
                  >
                    <Icon name="x" size={13} />
                    <span>Bulk Reject ({selectedIds.size})</span>
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm text-ink-600 hover:text-ink-900"
                    disabled={bulkBusy}
                    onClick={() => setSelectedIds(new Set())}
                  >
                    Clear Selection
                  </button>
                </div>
              </div>
            )}

            {/* Select All Actionable Bar for Approvers */}
            {(() => {
              const actionable = items.filter((l) => l.canApproveManager || l.canApproveHr);
              if (actionable.length === 0) return null;
              const allSelected = actionable.length > 0 && actionable.every((l) => selectedIds.has(l.id));
              return (
                <div className="flex items-center justify-between px-4 py-2 bg-ink-50/80 rounded-lg border border-ink-100 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-ink-700">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => selectAll(actionable.map((l) => l.id))}
                      className="rounded border-ink-300 text-brand-600 focus:ring-brand-500 h-4 w-4"
                    />
                    <span>Select all actionable requests ({actionable.length})</span>
                  </label>
                  <span className="text-[11px] text-ink-500 font-medium">
                    Independent Manager & HR batch approval enabled
                  </span>
                </div>
              );
            })()}

            <div className="divide-y divide-ink-100">
              {items.map((leave) => {
                const canSelect = leave.canApproveManager || leave.canApproveHr;
                const isSelected = selectedIds.has(leave.id);
                return (
                  <div
                    key={leave.id}
                    className={cx(
                      'flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 transition-colors',
                      isSelected ? 'bg-brand-50/40' : 'hover:bg-ink-50/40',
                    )}
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {canSelect && (
                        <div className="pt-1">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(leave.id)}
                            className="rounded border-ink-300 text-brand-600 focus:ring-brand-500 h-4 w-4 cursor-pointer"
                            title="Select for bulk approval"
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-bold text-ink-900">{requestTitle(leave)}</p>
                          <RequestStatus status={leave.status} />
                          <Badge tone="neutral">{leave.days} day(s)</Badge>
                          {leave.isHalfDay && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-blue-100 text-blue-900 font-bold px-2 py-0.5 text-xs border border-blue-200">
                              <Icon name="clock" size={12} />
                              Half Day · {leave.halfDaySlot === 'second_half' ? SLOT_LABEL.second_half : SLOT_LABEL.first_half}
                            </span>
                          )}
                          {leave.requestKind !== 'weekly_off' && Boolean(leave.weeklyOffDays) && (
                            <Badge tone="success">{leave.weeklyOffDays} weekly off(s) not charged</Badge>
                          )}
                          {Boolean(leave.holidayDays) && <Badge tone="info">{leave.holidayDays} holiday(s) not charged</Badge>}
                          {tab !== 'mine' && (
                            <Badge tone="brand" className="font-bold">
                              {leave.employeeName} ({leave.employeeCode})
                            </Badge>
                          )}
                          {leave.locationCode && (
                            <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800 border border-amber-200">
                              {leave.locationCode}
                            </span>
                          )}
                        </div>

                        {/* Employee Subtitle */}
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                          {leave.requestKind === 'weekly_off' || leave.isHalfDay || leave.startDate === leave.endDate ? (
                            <strong className="text-ink-800">
                              {formatDate(leave.startDate)}
                              {leave.isHalfDay ? ` · ${leave.halfDaySlot === 'second_half' ? SLOT_LABEL.second_half : SLOT_LABEL.first_half}` : ''}
                            </strong>
                          ) : (
                            <span>
                              {formatDate(leave.startDate)} → {formatDate(leave.endDate)}
                            </span>
                          )}
                          <span>·</span>
                          <span>applied {formatDateTime(leave.createdAt)}</span>
                          {leave.designationTitle && (
                            <>
                              <span>·</span>
                              <span className="font-medium text-ink-600">{leave.designationTitle}</span>
                            </>
                          )}
                        </div>

                        {leave.reason && <p className="mt-1 text-sm text-ink-700 bg-ink-50/60 rounded p-1.5 border border-ink-100/80">{leave.reason}</p>}

                        {/* Location, Manager & HR Details + Dual Status Badges */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-ink-500">
                            Location: <strong className="text-ink-700">{leave.locationName ?? 'Not assigned'}</strong>
                          </span>
                          <span className="text-ink-300">|</span>
                          <div className="flex items-center gap-1">
                            <span className="text-ink-500">Manager:</span>
                            <span className="font-medium text-ink-700">{leave.managerName ?? 'Not assigned'}</span>
                            <span className={cx(
                              'rounded-full px-1.5 py-0.2 text-[10px] font-bold border',
                              leave.managerStatus === 'approved'
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                : leave.managerStatus === 'rejected'
                                  ? 'bg-red-50 text-red-800 border-red-300'
                                  : 'bg-amber-50 text-amber-800 border-amber-300 animate-pulse',
                            )}>
                              {leave.managerStatus === 'approved' ? '✓ Approved' : leave.managerStatus === 'rejected' ? '✕ Rejected' : '● Pending'}
                            </span>
                          </div>
                          <span className="text-ink-300">|</span>
                          <div className="flex items-center gap-1">
                            <span className="text-ink-500">HR:</span>
                            <span className="font-medium text-ink-700">{leave.hrName ?? 'Location HR'}</span>
                            <span className={cx(
                              'rounded-full px-1.5 py-0.2 text-[10px] font-bold border',
                              leave.hrStatus === 'approved'
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                : leave.hrStatus === 'rejected'
                                  ? 'bg-red-50 text-red-800 border-red-300'
                                  : 'bg-amber-50 text-amber-800 border-amber-300 animate-pulse',
                            )}>
                              {leave.hrStatus === 'approved' ? '✓ Verified' : leave.hrStatus === 'rejected' ? '✕ Rejected' : '● Pending'}
                            </span>
                          </div>
                        </div>

                        {/* Visual Live Application Flow Stepper */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setViewingFlowLeave(leave)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') setViewingFlowLeave(leave);
                          }}
                          className="mt-3 rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50/90 via-indigo-50/60 to-slate-50/90 p-3 transition-all hover:border-brand-500 hover:shadow-sm cursor-pointer group"
                          title="Click to inspect live application flow & telemetry"
                        >
                          <div className="flex items-center justify-between text-[11px] font-bold text-ink-600 mb-2.5">
                            <div className="flex items-center gap-2">
                              <span className="flex h-2.5 w-2.5 relative">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-500 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-brand-600"></span>
                              </span>
                              <span className="text-brand-900 uppercase tracking-wider text-[11px] font-bold">
                                Live Application Flow Pipeline
                              </span>
                            </div>
                            <span className="text-[11px] text-brand-700 font-semibold group-hover:underline flex items-center gap-1">
                              <span>Full Flow Diagram</span>
                              <Icon name="chevronRight" size={13} />
                            </span>
                          </div>

                          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5">
                            {/* Step 1: Submitted */}
                            <div className="flex-1 flex items-center gap-2 rounded-lg bg-white p-2 border border-emerald-300 shadow-2xs">
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white shadow-2xs">
                                ✓
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="text-[11px] font-bold text-emerald-950 truncate">1. Submitted</p>
                                <p className="text-[9px] text-ink-500 truncate">{leave.createdAt ? formatDateTime(leave.createdAt) : 'Applied'}</p>
                              </div>
                            </div>

                            <span className="hidden sm:inline-block text-ink-300 font-bold px-0.5">→</span>

                            {/* Step 2: Location HR Verification (Independent) */}
                            {(() => {
                              const isDone = leave.hrStatus === 'approved' || Boolean(leave.hrActionAt);
                              const isRejected = leave.hrStatus === 'rejected';
                              const isCurrent = !isDone && !isRejected && leave.status !== 'rejected' && leave.status !== 'cancelled';
                              return (
                                <div className={cx(
                                  'flex-1 flex items-center gap-2 rounded-lg p-2 border shadow-2xs',
                                  isDone
                                    ? 'bg-emerald-50 border-emerald-300'
                                    : isCurrent
                                      ? 'bg-amber-50 border-amber-400 ring-2 ring-amber-400/20'
                                      : isRejected
                                        ? 'bg-red-50 border-red-300'
                                        : 'bg-white/90 border-ink-200 opacity-80',
                                )}>
                                  <span className={cx(
                                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-2xs',
                                    isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300',
                                  )}>
                                    {isDone ? '✓' : isRejected ? '✕' : '2'}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between">
                                      <p className={cx('text-[11px] font-bold truncate', isDone ? 'text-emerald-950' : isCurrent ? 'text-amber-950' : isRejected ? 'text-red-950' : 'text-ink-700')}>
                                        2. Location HR
                                      </p>
                                      <span className={cx(
                                        'rounded px-1 py-0.1 text-[8px] font-bold uppercase',
                                        isDone ? 'bg-emerald-200 text-emerald-900' : isCurrent ? 'bg-amber-200 text-amber-900' : isRejected ? 'bg-red-200 text-red-900' : 'bg-ink-100 text-ink-600'
                                      )}>
                                        {isDone ? 'Verified' : isCurrent ? 'Pending' : isRejected ? 'Declined' : 'Queue'}
                                      </span>
                                    </div>
                                    <p className="text-[9px] text-ink-500 truncate" title={leave.hrName ?? 'Location HR'}>
                                      {leave.hrName ? leave.hrName : 'Location HR'}
                                    </p>
                                    {leave.hrActionAt && (
                                      <p className="text-[8px] text-ink-400 truncate">{formatDateTime(leave.hrActionAt)}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })()}

                            <span className="hidden sm:inline-block text-ink-300 font-bold px-0.5">→</span>

                            {/* Step 3: Reporting Manager Review (Independent) */}
                            {(() => {
                              const isDone = leave.managerStatus === 'approved' || Boolean(leave.managerActionAt);
                              const isRejected = leave.managerStatus === 'rejected';
                              const isCurrent = !isDone && !isRejected && leave.status !== 'rejected' && leave.status !== 'cancelled';
                              return (
                                <div className={cx(
                                  'flex-1 flex items-center gap-2 rounded-lg p-2 border shadow-2xs',
                                  isDone
                                    ? 'bg-emerald-50 border-emerald-300'
                                    : isCurrent
                                      ? 'bg-amber-50 border-amber-400 ring-2 ring-amber-400/20'
                                      : isRejected
                                        ? 'bg-red-50 border-red-300'
                                        : 'bg-white/90 border-ink-200 opacity-80',
                                )}>
                                  <span className={cx(
                                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-2xs',
                                    isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300',
                                  )}>
                                    {isDone ? '✓' : isRejected ? '✕' : '3'}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between">
                                      <p className={cx('text-[11px] font-bold truncate', isDone ? 'text-emerald-950' : isCurrent ? 'text-amber-950' : isRejected ? 'text-red-950' : 'text-ink-700')}>
                                        3. Manager
                                      </p>
                                      <span className={cx(
                                        'rounded px-1 py-0.1 text-[8px] font-bold uppercase',
                                        isDone ? 'bg-emerald-200 text-emerald-900' : isCurrent ? 'bg-amber-200 text-amber-900' : isRejected ? 'bg-red-200 text-red-900' : 'bg-ink-100 text-ink-600'
                                      )}>
                                        {isDone ? 'Approved' : isCurrent ? 'Pending' : isRejected ? 'Declined' : 'Queue'}
                                      </span>
                                    </div>
                                    <p className="text-[9px] text-ink-500 truncate" title={leave.managerName ?? 'Reporting Manager'}>
                                      {leave.managerName ? leave.managerName : 'Direct Manager'}
                                    </p>
                                    {leave.managerActionAt && (
                                      <p className="text-[8px] text-ink-400 truncate">{formatDateTime(leave.managerActionAt)}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })()}

                            <span className="hidden sm:inline-block text-ink-300 font-bold px-0.5">→</span>

                            {/* Step 4: Final Approval & Attendance Sync */}
                            {(() => {
                              const isApproved = leave.status === 'approved';
                              const isRejected = leave.status === 'rejected';
                              const isCancelled = leave.status === 'cancelled';
                              return (
                                <div className={cx(
                                  'flex-1 flex items-center gap-2 rounded-lg p-2 border shadow-2xs',
                                  isApproved
                                    ? 'bg-emerald-50 border-emerald-300'
                                    : isRejected || isCancelled
                                      ? 'bg-red-50 border-red-300'
                                      : 'bg-white/90 border-ink-200 opacity-80',
                                )}>
                                  <span className={cx(
                                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-2xs',
                                    isApproved ? 'bg-emerald-600' : isRejected || isCancelled ? 'bg-red-500' : 'bg-ink-300',
                                  )}>
                                    {isApproved ? '✓' : isRejected || isCancelled ? '✕' : '4'}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between">
                                      <p className={cx('text-[11px] font-bold truncate', isApproved ? 'text-emerald-950' : isRejected || isCancelled ? 'text-red-950' : 'text-ink-700')}>
                                        4. Live Sync
                                      </p>
                                      <span className={cx(
                                        'rounded px-1 py-0.1 text-[8px] font-bold uppercase',
                                        isApproved ? 'bg-emerald-200 text-emerald-900' : isRejected || isCancelled ? 'bg-red-200 text-red-900' : 'bg-ink-100 text-ink-600'
                                      )}>
                                        {isApproved ? 'Active' : isRejected || isCancelled ? 'Void' : 'Pending'}
                                      </span>
                                    </div>
                                    <p className="text-[9px] text-ink-500 truncate">
                                      {isApproved ? 'Attendance Synced' : isRejected ? 'Rejected' : isCancelled ? 'Cancelled' : 'Pending Approvals'}
                                    </p>
                                    <p className="text-[8px] text-ink-400 truncate">
                                      {isApproved ? 'Store Roster Updated' : 'No changes to roster'}
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
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 shrink-0 pt-1">
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
                      {leave.canApproveHr && (
                        <>
                          <button type="button" className="btn-primary btn-sm bg-brand-600 hover:bg-brand-700 shadow-xs" onClick={() => void decide(leave.id, true, 'hr')}>
                            HR Verify
                          </button>
                          <button type="button" className="btn-secondary btn-sm text-red-600 border-red-200 hover:bg-red-50 shadow-xs" onClick={() => void decide(leave.id, false, 'hr')}>
                            HR Reject
                          </button>
                        </>
                      )}
                      {leave.canApproveManager && (
                        <>
                          <button type="button" className="btn-primary btn-sm bg-emerald-600 hover:bg-emerald-700 shadow-xs" onClick={() => void decide(leave.id, true, 'manager')}>
                            Manager Approve
                          </button>
                          <button type="button" className="btn-secondary btn-sm text-red-600 border-red-200 hover:bg-red-50 shadow-xs" onClick={() => void decide(leave.id, false, 'manager')}>
                            Manager Reject
                          </button>
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
                );
              })}
            </div>
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

      <Modal
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        title="Apply for Leave / Week-Off"
        description="Select whether to take a saved weekly off or apply for regular leave. Location HR verifies first, then your Reporting Manager approves."
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setApplyOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" form="leave-form" type="submit" disabled={!canSubmit}>
              {busy
                ? 'Submitting…'
                : requestType === 'weekly_off'
                  ? 'Submit Week-Off Request'
                  : 'Submit Leave Request'}
            </button>
          </>
        }
      >
        <form id="leave-form" onSubmit={apply} className="space-y-4">
          {routingError ? (
            <div role="alert" className="text-sm text-red-600">
              {routingError}
              <button type="button" className="btn-secondary ml-2" onClick={() => void loadRouting()}>
                Retry
              </button>
            </div>
          ) : !routing ? (
            <p role="status">Loading your approval route…</p>
          ) : (
            <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/80 p-3.5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Employee">
                  <input className="input font-medium" value={routing.employeeName} readOnly />
                </Field>
                <Field label="Assigned location">
                  <input className="input font-medium" value={routing.locationName ?? 'Not assigned'} readOnly />
                </Field>
                <Field label="Reporting manager">
                  <input className="input font-medium" value={routing.manager?.name ?? 'Not assigned'} readOnly />
                </Field>
                <Field label="Location HR approver" required>
                  <select
                    className="input font-medium"
                    value={hrApproverId}
                    onChange={(event) => setHrApproverId(event.target.value)}
                    required
                  >
                    <option value="">Select location HR</option>
                    {routing.hrApprovers.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="text-xs text-brand-900 font-medium">
                Flow: 1. Submit request → 2. Location HR verifies → 3. Reporting Manager approves → 4. Attendance status synced.
              </p>
              {routing.issues.map((issue) => (
                <p key={issue} role="alert" className="text-xs text-red-700">
                  {issue}
                </p>
              ))}
            </div>
          )}

          {/* Mode Selector */}
          <div className="space-y-1.5">
            <span className="label font-bold text-ink-900">Application Type</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Request type">
              {optionButton('weekly_off', 'calendar', 'Saved Week-Off', `Quota (${w?.available ?? 0} avail)`)}
              {optionButton('regular', 'calendar', 'Regular Leave', 'CL / SL / EL')}
              {optionButton('half_day', 'clock', 'Half-Day Leave', '0.5 day')}
            </div>
          </div>

          {requestType === 'weekly_off' ? (
            <div className="space-y-3">
              {/* Month Selector & Entitlement Overview */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="label mb-0 block font-bold text-ink-900">Monthly Week-Off Entitlement</span>
                  <span className="text-[11px] text-ink-500">Calculated dynamically based on number of Sundays in month</span>
                </div>
                <MonthPicker
                  year={woPeriod.year}
                  month={woPeriod.month}
                  onChange={(year, month) => {
                    setWoPeriod({ year, month });
                    setWoDate('');
                  }}
                />
              </div>

              {/* Monthly Saved Weekly-Off Balance Summary Card */}
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 text-xs text-emerald-950 sm:grid-cols-4 shadow-xs">
                <div>
                  <span className="text-[11px] text-emerald-700 block">Total Sundays</span>
                  <strong className="text-sm font-bold">{woSummary?.totalSundays ?? 5}</strong>
                </div>
                <div>
                  <span className="text-[11px] text-emerald-700 block">Allocated Quota</span>
                  <strong className="text-sm font-bold">{w?.allocated ?? 0} Days</strong>
                </div>
                <div>
                  <span className="text-[11px] text-emerald-700 block">Taken / Approved</span>
                  <strong className="text-sm font-bold text-emerald-800">{w?.taken ?? 0} Days</strong>
                </div>
                <div>
                  <span className="text-[11px] text-emerald-700 block">Available Balance</span>
                  <strong className={cx('text-sm font-bold', (w?.available ?? 0) > 0 ? 'text-emerald-700' : 'text-red-600')}>
                    {w?.available ?? 0} Days
                  </strong>
                </div>
                {(w?.pending ?? 0) > 0 && (
                  <div className="col-span-2 sm:col-span-4 pt-1 border-t border-emerald-200 text-emerald-800 text-[11px]">
                    {w?.pending} request(s) currently pending approval.
                  </div>
                )}
              </div>

              {/* Duration Mode: Single Day vs Consecutive Range */}
              <div className="flex items-center gap-2 border-b border-emerald-200 pb-2.5">
                <span className="text-xs font-semibold text-emerald-950">Option:</span>
                <div className="inline-flex rounded-lg border border-emerald-300 bg-white p-0.5 text-xs shadow-2xs">
                  <button
                    type="button"
                    className={cx(
                      'rounded-md px-3 py-1 font-semibold transition-all',
                      woMode === 'single' ? 'bg-emerald-600 text-white shadow-xs' : 'text-emerald-900 hover:bg-emerald-50',
                    )}
                    onClick={() => {
                      setWoMode('single');
                      if (woStartDate) setWoDate(woStartDate);
                    }}
                  >
                    Single Day
                  </button>
                  <button
                    type="button"
                    className={cx(
                      'rounded-md px-3 py-1 font-semibold transition-all',
                      woMode === 'range' ? 'bg-emerald-600 text-white shadow-xs' : 'text-emerald-900 hover:bg-emerald-50',
                    )}
                    onClick={() => {
                      setWoMode('range');
                      if (woDate) {
                        setWoStartDate(woDate);
                        setWoEndDate(woDate);
                      }
                    }}
                  >
                    Consecutive Days (Range)
                  </button>
                </div>
                <span className="text-[11px] text-emerald-700 italic">
                  {woMode === 'single' ? 'Take 1 week off' : 'Take accumulated week offs across continuous days'}
                </span>
              </div>

              {/* Date Selection */}
              {woMode === 'single' ? (
                <div className="space-y-2">
                  <Field label="Select Week-Off Date" hint="Eligible on any calendar date in the month, including weekdays">
                    <input
                      type="date"
                      className="input font-bold text-sm text-ink-900"
                      value={woDate}
                      onChange={(e) => setWoDate(e.target.value)}
                      required
                    />
                  </Field>

                  {woSummary && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-semibold text-ink-500">Quick Pick Month Sundays:</span>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Quick pick Sunday">
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
                                'rounded-lg border px-2.5 py-2 text-left text-xs transition-all',
                                selected
                                  ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30 font-bold shadow-xs'
                                  : selectable
                                    ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:border-emerald-400 hover:bg-emerald-100/60 cursor-pointer'
                                    : 'cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400 opacity-60',
                              )}
                            >
                              <span className="block font-bold">{formatDate(entry.date)}</span>
                              <span className="text-[10px] mt-0.5 block">{WEEKLY_OFF_STATUS_LABEL[entry.status]}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {(w?.available ?? 0) <= 0 ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 font-medium">
                      ⚠️ No week-off balance available for {woSummary?.monthName} {woSummary?.year}. You have taken or reserved all eligible days for this month.
                    </div>
                  ) : woDate ? (
                    <div className="rounded-lg border border-brand-200 bg-brand-50/70 p-3 text-xs text-brand-950 font-medium">
                      Selected date: <strong>{formatDate(woDate)}</strong> · 1 day will be deducted from your monthly entitlement upon final manager approval (Remaining: <strong>{Math.max(0, (w?.remaining ?? 0) - 1)}</strong>).
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Start Date" required>
                      <input
                        type="date"
                        className="input font-bold text-sm text-ink-900"
                        value={woStartDate}
                        onChange={(e) => {
                          setWoStartDate(e.target.value);
                          if (!woEndDate || woEndDate < e.target.value) setWoEndDate(e.target.value);
                        }}
                        required
                      />
                    </Field>
                    <Field label="End Date" required>
                      <input
                        type="date"
                        className="input font-bold text-sm text-ink-900"
                        value={woEndDate}
                        onChange={(e) => setWoEndDate(e.target.value)}
                        required
                      />
                    </Field>
                  </div>

                  {(() => {
                    const count = getWoDaysCount();
                    if (!woStartDate || !woEndDate || count <= 0) return null;
                    const avail = w?.available ?? 0;
                    const remainingAfter = Math.max(0, (w?.remaining ?? 0) - count);
                    if (count > avail) {
                      return (
                        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800 font-medium">
                          ⚠️ Insufficient week-off balance! You requested <strong>{count} consecutive days</strong> ({formatDate(woStartDate)} to {formatDate(woEndDate)}), but you only have <strong>{avail} day(s)</strong> available this month.
                        </div>
                      );
                    }
                    return (
                      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-950 font-medium">
                        ✓ Selected: <strong>{count} consecutive day(s)</strong> ({formatDate(woStartDate)} to {formatDate(woEndDate)}) · Exactly <strong>{count} day(s)</strong> will be deducted from your monthly entitlement upon manager approval (Remaining: <strong>{remainingAfter}</strong>). All {count} dates will be marked as WEEK OFF in attendance.
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          ) : requestType === 'regular' ? (
            <div className="space-y-3">
              <Field label="Leave type" required>
                <select
                  className="input font-medium"
                  value={selectedLeaveTypeId}
                  onChange={(e) => {
                    if (e.target.value === 'WO_SHORTCUT') {
                      setRequestType('weekly_off');
                      return;
                    }
                    setSelectedLeaveTypeId(e.target.value);
                  }}
                  required
                >
                  <option value="">Select leave type</option>
                  <option value="WO_SHORTCUT" className="font-bold text-emerald-700">
                    ⭐ Saved Week-Off ({w?.available ?? 0} days available this month)
                  </option>
                  {types.map((t) => {
                    const bal = balances.find((b) => b.leaveTypeId === t.id);
                    let label = t.name;
                    if (t.code === 'LWP') label += ' (Unpaid · Loss of Pay)';
                    else if (t.code === 'CO') label += ` (${bal?.available ?? 0} days available · Compensatory Off)`;
                    else if (t.code === 'ML') label += ' (Maternity · 26 weeks)';
                    else if (t.code === 'PL') label += ' (Paternity · Up to 10 days)';
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
                              if (startDate === endDate) {
                                setWoMode('single');
                                setWoDate(startDate);
                              } else {
                                setWoMode('range');
                                setWoStartDate(startDate);
                                setWoEndDate(endDate);
                              }
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
                <input type="file" className="input text-xs" onChange={(event) => setDocument(event.target.files?.[0] ?? null)} />
              </Field>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="Date" required>
                <input
                  type="date"
                  className="input font-medium"
                  value={hdDate}
                  onChange={(e) => setHdDate(e.target.value)}
                  required
                />
              </Field>

              <Field label="Half-day session" required>
                <div className="grid grid-cols-2 gap-2" role="radiogroup">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={hdSlot === 'first_half'}
                    className={cx(
                      'rounded-lg border p-2.5 text-left text-xs font-semibold transition-all',
                      hdSlot === 'first_half' ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30' : 'border-ink-200 bg-white text-ink-700',
                    )}
                    onClick={() => setHdSlot('first_half')}
                  >
                    First Half (Morning)
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={hdSlot === 'second_half'}
                    className={cx(
                      'rounded-lg border p-2.5 text-left text-xs font-semibold transition-all',
                      hdSlot === 'second_half' ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/30' : 'border-ink-200 bg-white text-ink-700',
                    )}
                    onClick={() => setHdSlot('second_half')}
                  >
                    Second Half (Afternoon)
                  </button>
                </div>
              </Field>

              {halfPreview && (
                <div className="rounded-lg border border-ink-200 bg-ink-50 p-2.5 text-xs text-ink-700">
                  Will deduct <strong>0.5 day</strong> from your available {halfPreview.deductFrom?.name ?? 'leave balance'}.
                </div>
              )}

              <Field label="Supporting document (optional)">
                <input type="file" className="input text-xs" onChange={(event) => setDocument(event.target.files?.[0] ?? null)} />
              </Field>
            </div>
          )}

          {/* Reason is strictly optional */}
          <Field label="Reason (optional)" hint="Optional notes for your approvers">
            <textarea
              className="input min-h-[75px]"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              placeholder="Reason or notes (optional)…"
            />
          </Field>
          <p className="text-xs text-ink-500">
            Requests are verified by Location HR, approved by your Reporting Manager, and synchronized with attendance.
          </p>
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
                {viewingLeave.canApproveHr && (
                  <>
                    <button
                      type="button"
                      className="btn-primary btn-sm bg-brand-600 hover:bg-brand-700"
                      onClick={async () => {
                        await decide(viewingLeave.id, true, 'hr');
                        setViewingLeave(null);
                      }}
                    >
                      HR Verify
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm text-red-600 border-red-200 hover:bg-red-50"
                      onClick={async () => {
                        await decide(viewingLeave.id, false, 'hr');
                        setViewingLeave(null);
                      }}
                    >
                      HR Reject
                    </button>
                  </>
                )}
                {viewingLeave.canApproveManager && (
                  <>
                    <button
                      type="button"
                      className="btn-primary btn-sm bg-emerald-600 hover:bg-emerald-700"
                      onClick={async () => {
                        await decide(viewingLeave.id, true, 'manager');
                        setViewingLeave(null);
                      }}
                    >
                      Manager Approve
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm text-red-600 border-red-200 hover:bg-red-50"
                      onClick={async () => {
                        await decide(viewingLeave.id, false, 'manager');
                        setViewingLeave(null);
                      }}
                    >
                      Manager Reject
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

                {/* Node 2: Location HR Verification (Independent) */}
                {(() => {
                  const isDone = viewingFlowLeave.hrStatus === 'approved' || Boolean(viewingFlowLeave.hrActionAt);
                  const isRejected = viewingFlowLeave.hrStatus === 'rejected';
                  const isCurrent = !isDone && !isRejected && viewingFlowLeave.status !== 'rejected' && viewingFlowLeave.status !== 'cancelled';
                  return (
                    <div className={cx(
                      'rounded-xl border p-3 space-y-2',
                      isDone ? 'border-emerald-300 bg-emerald-50/70' : isCurrent ? 'border-amber-300 bg-amber-50/80 ring-2 ring-amber-400/30' : isRejected ? 'border-red-300 bg-red-50/70' : 'border-ink-200 bg-ink-50/40 opacity-80',
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-bold">
                          <span className={cx(
                            'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                            isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300',
                          )}>
                            {isDone ? '✓' : isRejected ? '✕' : '2'}
                          </span>
                          <span className={isDone ? 'text-emerald-900' : isCurrent ? 'text-amber-900' : isRejected ? 'text-red-900' : 'text-ink-600'}>2. Location HR</span>
                        </div>
                        <span className={cx(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold',
                          isDone ? 'bg-emerald-200/80 text-emerald-900' : isCurrent ? 'bg-amber-200 text-amber-900 animate-pulse' : isRejected ? 'bg-red-200 text-red-900' : 'bg-ink-200 text-ink-600',
                        )}>
                          {isDone ? 'VERIFIED' : isCurrent ? 'PENDING HR' : isRejected ? 'REJECTED' : 'WAITING'}
                        </span>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p className="font-bold text-ink-900">{viewingFlowLeave.hrName ?? 'Location HR Approver'}</p>
                        <p className="text-[11px] text-ink-500">Location HR Verification</p>
                        <p className="text-[10px] text-ink-600 font-medium">
                          {isDone ? (viewingFlowLeave.hrActionAt ? formatDateTime(viewingFlowLeave.hrActionAt) : 'HR Verified') : isCurrent ? 'Awaiting Location HR' : isRejected ? 'Declined at HR stage' : 'Pending'}
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* Node 3: Reporting Manager Review (Independent) */}
                {(() => {
                  const isDone = viewingFlowLeave.managerStatus === 'approved' || Boolean(viewingFlowLeave.managerActionAt);
                  const isRejected = viewingFlowLeave.managerStatus === 'rejected';
                  const isCurrent = !isDone && !isRejected && viewingFlowLeave.status !== 'rejected' && viewingFlowLeave.status !== 'cancelled';
                  return (
                    <div className={cx(
                      'rounded-xl border p-3 space-y-2',
                      isDone ? 'border-emerald-300 bg-emerald-50/70' : isCurrent ? 'border-amber-300 bg-amber-50/80 ring-2 ring-amber-400/30' : isRejected ? 'border-red-300 bg-red-50/70' : 'border-ink-200 bg-ink-50/40 opacity-80',
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-bold">
                          <span className={cx(
                            'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-2xs',
                            isDone ? 'bg-emerald-600' : isCurrent ? 'bg-amber-500 animate-pulse' : isRejected ? 'bg-red-500' : 'bg-ink-300',
                          )}>
                            {isDone ? '✓' : isRejected ? '✕' : '3'}
                          </span>
                          <span className={isDone ? 'text-emerald-900' : isCurrent ? 'text-amber-900' : isRejected ? 'text-red-900' : 'text-ink-600'}>3. Reporting Manager</span>
                        </div>
                        <span className={cx(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold',
                          isDone ? 'bg-emerald-200/80 text-emerald-900' : isCurrent ? 'bg-amber-200 text-amber-900 animate-pulse' : isRejected ? 'bg-red-200 text-red-900' : 'bg-ink-200 text-ink-600',
                        )}>
                          {isDone ? 'APPROVED' : isCurrent ? 'PENDING MGR' : isRejected ? 'REJECTED' : 'WAITING'}
                        </span>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p className="font-bold text-ink-900">{viewingFlowLeave.managerName ?? 'Reporting Manager'}</p>
                        <p className="text-[11px] text-ink-500">Department / Store Manager</p>
                        <p className="text-[10px] text-ink-600 font-medium">
                          {isDone ? (viewingFlowLeave.managerActionAt ? formatDateTime(viewingFlowLeave.managerActionAt) : 'Manager Approved') : isCurrent ? 'Awaiting Manager Review' : isRejected ? 'Declined by manager' : 'Pending'}
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
                    <span className="text-[11px] font-semibold text-ink-500">Manager Review Note:</span>
                    <p className={cx('mt-0.5 rounded p-2 border text-xs font-medium', viewingFlowLeave.managerNote ? 'bg-indigo-50/80 border-indigo-200 text-indigo-950' : 'bg-white border-ink-100 text-ink-400 italic')}>
                      {viewingFlowLeave.managerNote ? viewingFlowLeave.managerNote : 'No manager review note'}
                    </p>
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-ink-500">Location HR Review Note:</span>
                    <p className={cx('mt-0.5 rounded p-2 border text-xs font-medium', viewingFlowLeave.hrNote ? 'bg-sky-50/80 border-sky-200 text-sky-950' : 'bg-white border-ink-100 text-ink-400 italic')}>
                      {viewingFlowLeave.hrNote ? viewingFlowLeave.hrNote : 'No HR verification note'}
                    </p>
                  </div>
                  {viewingFlowLeave.decisionNote && (
                    <div>
                      <span className="text-[11px] font-semibold text-ink-500">Approver Decision Note:</span>
                      <p className="mt-0.5 rounded p-2 border text-xs font-medium bg-amber-50/80 border-amber-200 text-amber-950">
                        {viewingFlowLeave.decisionNote}
                      </p>
                    </div>
                  )}
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
