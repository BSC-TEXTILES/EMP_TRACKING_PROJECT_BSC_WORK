import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, Field, Modal, PageHeader, SectionHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';

interface GeneralSettings {
  workStartTime: string;
  workEndTime: string;
  lateGraceMinutes: number;
  halfDayHours: number;
  fullDayHours: number;
  overtimeAfterHours: number;
  missingCheckoutGraceMinutes: number;
  workDays: number[];
  dailyReportReminderTime: string;
  lunchStartTime: string;
  lunchEndTime: string;
  breakDurationMinutes: number;
}

interface LocationTiming {
  id: number;
  name: string;
  code: string;
  city: string | null;
  timezone: string;
  workStartTime: string;
  workEndTime: string;
  lateGraceMinutes: number;
  shiftName: string;
  isCustom: boolean;
}

interface ShiftItem {
  id: string;
  name: string;
  code: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  description?: string;
  isDefault?: boolean;
  active?: boolean;
}

interface OfficeTimesData {
  general: GeneralSettings;
  locations: LocationTiming[];
  shifts: ShiftItem[];
  currentStatus: {
    currentTime: string;
    timezone: string;
    inShift: boolean;
    isLateWindow: boolean;
    statusLabel: string;
  };
}

const DAYS_OF_WEEK = [
  { day: 1, label: 'Monday', short: 'Mon' },
  { day: 2, label: 'Tuesday', short: 'Tue' },
  { day: 3, label: 'Wednesday', short: 'Wed' },
  { day: 4, label: 'Thursday', short: 'Thu' },
  { day: 5, label: 'Friday', short: 'Fri' },
  { day: 6, label: 'Saturday', short: 'Sat' },
  { day: 0, label: 'Sunday', short: 'Sun' },
];

export default function OfficeTimesAdmin() {
  useDocumentTitle('Office Times & Shifts');
  const toast = useToast();
  const { has, user } = useAuth();
  const canManage = has('settings.manage') || has('org.manage') || (user?.roleLevel ?? 0) >= 60 || user?.roleSlug === 'super_admin';

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<OfficeTimesData | null>(null);
  const [tab, setTab] = useState<'general' | 'locations' | 'shifts' | 'schedule'>('general');

  // Form draft state
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [locations, setLocations] = useState<LocationTiming[]>([]);
  const [shifts, setShifts] = useState<ShiftItem[]>([]);

  // Edit location modal
  const [editLocModal, setEditLocModal] = useState<LocationTiming | null>(null);
  const [locForm, setLocForm] = useState({
    workStartTime: '09:30',
    workEndTime: '18:30',
    lateGraceMinutes: 10,
    shiftName: 'Store Shift',
    isCustom: true,
  });

  // Edit/add shift modal
  const [shiftModalOpen, setShiftModalOpen] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
  const [shiftForm, setShiftForm] = useState<Omit<ShiftItem, 'id'>>({
    name: '',
    code: '',
    startTime: '09:30',
    endTime: '18:30',
    graceMinutes: 10,
    description: '',
    isDefault: false,
    active: true,
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await api.get<OfficeTimesData>('/admin/office-times');
      setData(res);
      setGeneral(res.general);
      setLocations(res.locations);
      setShifts(res.shifts);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveAll = async () => {
    if (!general) return;
    setBusy(true);
    try {
      await api.put('/admin/office-times', {
        general,
        locations: locations.map((l) => ({
          id: l.id,
          workStartTime: l.workStartTime,
          workEndTime: l.workEndTime,
          lateGraceMinutes: l.lateGraceMinutes,
          shiftName: l.shiftName,
          isCustom: l.isCustom,
        })),
        shifts,
      });
      toast.success('Office times, store shifts, and schedules updated successfully.');
      await loadData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openLocationModal = (loc: LocationTiming) => {
    setEditLocModal(loc);
    setLocForm({
      workStartTime: loc.workStartTime || general?.workStartTime || '09:30',
      workEndTime: loc.workEndTime || general?.workEndTime || '18:30',
      lateGraceMinutes: loc.lateGraceMinutes ?? general?.lateGraceMinutes ?? 10,
      shiftName: loc.shiftName || `${loc.name} Store Shift`,
      isCustom: loc.isCustom,
    });
  };

  const saveLocationModal = () => {
    if (!editLocModal) return;
    setLocations((prev) =>
      prev.map((l) =>
        l.id === editLocModal.id
          ? {
              ...l,
              workStartTime: locForm.isCustom ? locForm.workStartTime : (general?.workStartTime || '09:30'),
              workEndTime: locForm.isCustom ? locForm.workEndTime : (general?.workEndTime || '18:30'),
              lateGraceMinutes: locForm.isCustom ? locForm.lateGraceMinutes : (general?.lateGraceMinutes || 10),
              shiftName: locForm.isCustom ? locForm.shiftName : 'Standard Store Shift',
              isCustom: locForm.isCustom,
            }
          : l,
      ),
    );
    setEditLocModal(null);
    toast.success(`Updated timing for ${editLocModal.name}. Remember to click "Save office times".`);
  };

  const resetLocationToDefault = (locId: number) => {
    if (!general) return;
    setLocations((prev) =>
      prev.map((l) =>
        l.id === locId
          ? {
              ...l,
              workStartTime: general.workStartTime,
              workEndTime: general.workEndTime,
              lateGraceMinutes: general.lateGraceMinutes,
              shiftName: 'Standard Store Shift',
              isCustom: false,
            }
          : l,
      ),
    );
    toast.success('Location reset to default general timing.');
  };

  const openAddShift = () => {
    setEditingShiftId(null);
    setShiftForm({
      name: '',
      code: '',
      startTime: '09:30',
      endTime: '18:30',
      graceMinutes: 10,
      description: '',
      isDefault: false,
      active: true,
    });
    setShiftModalOpen(true);
  };

  const openEditShift = (shift: ShiftItem) => {
    setEditingShiftId(shift.id);
    setShiftForm({
      name: shift.name,
      code: shift.code,
      startTime: shift.startTime,
      endTime: shift.endTime,
      graceMinutes: shift.graceMinutes,
      description: shift.description || '',
      isDefault: Boolean(shift.isDefault),
      active: shift.active !== false,
    });
    setShiftModalOpen(true);
  };

  const saveShiftModal = () => {
    if (!shiftForm.name.trim() || !shiftForm.code.trim()) {
      toast.error('Shift name and code are required.');
      return;
    }
    if (editingShiftId) {
      setShifts((prev) =>
        prev.map((s) => (s.id === editingShiftId ? { ...s, ...shiftForm } : s)),
      );
      toast.success('Shift updated. Click "Save office times" to persist.');
    } else {
      const newId = `shift-${Date.now().toString(36)}`;
      setShifts((prev) => [...prev, { id: newId, ...shiftForm }]);
      toast.success('New shift added. Click "Save office times" to persist.');
    }
    setShiftModalOpen(false);
  };

  const deleteShift = (id: string) => {
    setShifts((prev) => prev.filter((s) => s.id !== id));
    toast.success('Shift removed from catalog.');
  };

  const toggleWorkDay = (day: number) => {
    if (!general) return;
    const exists = general.workDays.includes(day);
    let next: number[];
    if (exists) {
      if (general.workDays.length <= 1) {
        toast.error('At least one working day must be enabled.');
        return;
      }
      next = general.workDays.filter((d) => d !== day);
    } else {
      next = [...general.workDays, day];
    }
    setGeneral({ ...general, workDays: next.sort() });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Office times & shift management"
        description="Configure corporate working hours, retail store shift timings, check-in grace periods, weekly off days, and store-specific schedules."
        actions={
          canManage && general ? (
            <button
              type="button"
              className="btn-primary btn-sm inline-flex items-center gap-1.5"
              disabled={busy}
              onClick={() => void handleSaveAll()}
            >
              <Icon name="check" size={15} />
              <span>{busy ? 'Saving changes…' : 'Save office times'}</span>
            </button>
          ) : undefined
        }
      />

      {/* Live Store & Shift Status Header Banner */}
      {data && (
        <Card className="card-pad bg-gradient-to-r from-blue-50/70 via-indigo-50/50 to-white border-blue-200/80">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
                <Icon name="clock" size={22} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold text-ink-900">
                    Current Shift Status: {data.currentStatus.statusLabel}
                  </span>
                  <Badge tone={data.currentStatus.inShift ? 'success' : 'neutral'}>
                    {data.currentStatus.inShift ? 'ACTIVE' : 'OFF HOURS'}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-ink-600">
                  Standard store hours: <span className="font-semibold text-ink-800">{data.general.workStartTime} – {data.general.workEndTime}</span> (IST · Asia/Kolkata) · Late grace: <span className="font-semibold text-ink-800">{data.general.lateGraceMinutes} min</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4 text-right">
              <div className="rounded-lg bg-white/80 px-3.5 py-1.5 border border-blue-100 shadow-2xs">
                <p className="text-[10px] font-bold uppercase tracking-wider text-ink-500">Kolkata Time</p>
                <p className="font-mono text-lg font-bold text-ink-900">{data.currentStatus.currentTime} IST</p>
              </div>
              <div className="rounded-lg bg-white/80 px-3.5 py-1.5 border border-blue-100 shadow-2xs">
                <p className="text-[10px] font-bold uppercase tracking-wider text-ink-500">Active Stores</p>
                <p className="font-mono text-lg font-bold text-blue-700">{locations.length} Locations</p>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Tabs
        tabs={[
          { value: 'general', label: 'General Office Timings' },
          { value: 'locations', label: `Store & Location Hours (${locations.length})` },
          { value: 'shifts', label: `Shift Catalog (${shifts.length})` },
          { value: 'schedule', label: 'Weekly Offs & Working Days' },
        ]}
        value={tab}
        onChange={(val) => setTab(val as typeof tab)}
      />

      {loading || !general ? (
        <Card className="card-pad">
          <Skeleton lines={8} />
        </Card>
      ) : (
        <>
          {/* TAB 1: GENERAL OFFICE TIMINGS */}
          {tab === 'general' && (
            <div className="space-y-4">
              <Card className="card-pad space-y-5">
                <div>
                  <SectionHeader
                    title="Enterprise Daily Work Timings"
                    description="Standard day shift timings that apply across all branches, retail counters, and corporate offices by default."
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Work Start Time (Check-in time)" required hint="Official beginning of working hours">
                    <input
                      type="time"
                      className="input"
                      value={general.workStartTime}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, workStartTime: e.target.value })}
                      required
                    />
                  </Field>

                  <Field label="Work End Time (Check-out time)" required hint="Official close of business hours">
                    <input
                      type="time"
                      className="input"
                      value={general.workEndTime}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, workEndTime: e.target.value })}
                      required
                    />
                  </Field>

                  <Field label="Late Check-in Grace Period (minutes)" required hint="Allowable arrival delay before check-in is flagged late">
                    <input
                      type="number"
                      min={0}
                      max={180}
                      className="input"
                      value={general.lateGraceMinutes}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, lateGraceMinutes: Number(e.target.value) })}
                      required
                    />
                  </Field>

                  <Field label="Full-day Target (hours)" required hint="Standard minimum daily hours for a full-day present credit">
                    <input
                      type="number"
                      step="0.5"
                      min={1}
                      max={24}
                      className="input"
                      value={general.fullDayHours}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, fullDayHours: Number(e.target.value) })}
                      required
                    />
                  </Field>

                  <Field label="Half-day Minimum (hours)" required hint="Minimum worked hours required to avoid an absent mark">
                    <input
                      type="number"
                      step="0.5"
                      min={1}
                      max={12}
                      className="input"
                      value={general.halfDayHours}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, halfDayHours: Number(e.target.value) })}
                      required
                    />
                  </Field>

                  <Field label="Overtime Starts After (hours)" required hint="Threshold beyond which extra minutes calculate as overtime">
                    <input
                      type="number"
                      step="0.5"
                      min={1}
                      max={24}
                      className="input"
                      value={general.overtimeAfterHours}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, overtimeAfterHours: Number(e.target.value) })}
                      required
                    />
                  </Field>
                </div>
              </Card>

              <Card className="card-pad space-y-5">
                <div>
                  <SectionHeader
                    title="Break & Auto-Close Windows"
                    description="Lunch intervals, auto check-out safeguards, and daily reporting reminder triggers."
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Lunch Window Start" hint="Designated lunch start time">
                    <input
                      type="time"
                      className="input"
                      value={general.lunchStartTime}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, lunchStartTime: e.target.value })}
                    />
                  </Field>

                  <Field label="Lunch Window End" hint="Designated lunch resumption time">
                    <input
                      type="time"
                      className="input"
                      value={general.lunchEndTime}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, lunchEndTime: e.target.value })}
                    />
                  </Field>

                  <Field label="Break Allowance (minutes)" hint="Maximum allocated break duration per day">
                    <input
                      type="number"
                      min={0}
                      max={180}
                      className="input"
                      value={general.breakDurationMinutes}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, breakDurationMinutes: Number(e.target.value) })}
                    />
                  </Field>

                  <Field label="Daily Report Reminder" hint="Time when employees receive daily report reminder">
                    <input
                      type="time"
                      className="input"
                      value={general.dailyReportReminderTime}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, dailyReportReminderTime: e.target.value })}
                    />
                  </Field>

                  <Field label="Missing Check-out Grace (minutes)" hint="Auto-close interval after work end if employee forgot check-out">
                    <input
                      type="number"
                      min={0}
                      max={360}
                      className="input"
                      value={general.missingCheckoutGraceMinutes}
                      disabled={!canManage}
                      onChange={(e) => setGeneral({ ...general, missingCheckoutGraceMinutes: Number(e.target.value) })}
                    />
                  </Field>
                </div>
              </Card>
            </div>
          )}

          {/* TAB 2: STORE & LOCATION-SPECIFIC HOURS */}
          {tab === 'locations' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-ink-900">Store-Wise Working Hours</h3>
                  <p className="text-xs text-ink-500">
                    Each retail store branch can follow the general company hours or maintain custom counter shift timings.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
                {locations.map((loc) => (
                  <Card key={loc.id} className="card-pad hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink-900 text-base">{loc.name}</span>
                          <span className="rounded-md bg-ink-100 px-1.5 py-0.5 text-xs font-mono font-bold text-ink-700">
                            {loc.code}
                          </span>
                          <Badge tone={loc.isCustom ? 'brand' : 'neutral'}>
                            {loc.isCustom ? 'CUSTOM STORE HOURS' : 'DEFAULT HOURS'}
                          </Badge>
                        </div>
                        <p className="text-xs text-ink-500 mt-0.5">
                          {loc.city ? `${loc.city} · ` : ''}Timezone: {loc.timezone} · Shift: <span className="font-semibold text-ink-700">{loc.shiftName}</span>
                        </p>
                      </div>

                      {canManage && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="btn-secondary btn-xs cursor-pointer inline-flex items-center gap-1"
                            onClick={() => openLocationModal(loc)}
                          >
                            <Icon name="edit" size={13} />
                            <span>Edit hours</span>
                          </button>
                          {loc.isCustom && (
                            <button
                              type="button"
                              className="btn-secondary btn-xs cursor-pointer text-rose-600 hover:bg-rose-50 border-rose-200"
                              onClick={() => resetLocationToDefault(loc.id)}
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-ink-50/60 p-3 border border-ink-100">
                      <div>
                        <p className="text-[10px] uppercase font-bold text-ink-400">Shift Start</p>
                        <p className="text-sm font-semibold font-mono text-ink-800">{loc.workStartTime}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold text-ink-400">Shift End</p>
                        <p className="text-sm font-semibold font-mono text-ink-800">{loc.workEndTime}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold text-ink-400">Late Grace</p>
                        <p className="text-sm font-semibold font-mono text-ink-800">{loc.lateGraceMinutes} min</p>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: SHIFT CATALOG */}
          {tab === 'shifts' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-ink-900">Shift Catalog</h3>
                  <p className="text-xs text-ink-500">
                    Predefined operational shifts for retail counters, stock handling, management, and evening cash reconciliation.
                  </p>
                </div>
                {canManage && (
                  <button
                    type="button"
                    className="btn-primary btn-sm inline-flex items-center gap-1.5"
                    onClick={openAddShift}
                  >
                    <Icon name="plus" size={14} />
                    <span>Add Shift</span>
                  </button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
                {shifts.map((shift) => (
                  <Card key={shift.id} className="card-pad hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink-900 text-base">{shift.name}</span>
                          <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-mono font-bold text-blue-700 border border-blue-200">
                            {shift.code}
                          </span>
                          {shift.isDefault && <Badge tone="success">DEFAULT</Badge>}
                          {shift.active === false && <Badge tone="danger">INACTIVE</Badge>}
                        </div>
                        {shift.description && (
                          <p className="text-xs text-ink-600 mt-1">{shift.description}</p>
                        )}
                      </div>

                      {canManage && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="btn-secondary btn-xs cursor-pointer"
                            onClick={() => openEditShift(shift)}
                          >
                            <Icon name="edit" size={13} />
                          </button>
                          {!shift.isDefault && (
                            <button
                              type="button"
                              className="btn-secondary btn-xs cursor-pointer text-rose-600 hover:bg-rose-50"
                              onClick={() => deleteShift(shift.id)}
                            >
                              <Icon name="trash" size={13} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="mt-4 flex items-center justify-between rounded-xl bg-ink-50/70 p-3 border border-ink-100">
                      <div>
                        <p className="text-[10px] uppercase font-bold text-ink-400">Timings</p>
                        <p className="text-sm font-semibold font-mono text-ink-800">
                          {shift.startTime} – {shift.endTime}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold text-ink-400">Grace</p>
                        <p className="text-sm font-semibold font-mono text-ink-800">{shift.graceMinutes} min</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold text-ink-400">Status</p>
                        <p className="text-xs font-semibold text-emerald-700">Ready</p>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* TAB 4: SCHEDULE & WORKING DAYS */}
          {tab === 'schedule' && (
            <Card className="card-pad space-y-5">
              <div>
                <SectionHeader
                  title="Official Organization Work Days"
                  description="Select active working days for retail stores and corporate offices. Attendance auto-close and reports respect weekly offs."
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
                {DAYS_OF_WEEK.map((d) => {
                  const isActive = general.workDays.includes(d.day);
                  return (
                    <button
                      key={d.day}
                      type="button"
                      disabled={!canManage}
                      onClick={() => toggleWorkDay(d.day)}
                      className={`flex flex-col items-center justify-center p-4 rounded-xl border text-center transition-all ${
                        isActive
                          ? 'bg-blue-50/80 border-blue-300 text-blue-900 shadow-2xs font-semibold'
                          : 'bg-ink-50/40 border-ink-200 text-ink-400 hover:bg-ink-50'
                      } ${canManage ? 'cursor-pointer hover:border-blue-400' : 'cursor-default'}`}
                    >
                      <span className="text-xs uppercase tracking-wider">{d.short}</span>
                      <span className="text-base font-bold mt-1">{d.label}</span>
                      <span className={`text-[11px] mt-2 px-2 py-0.5 rounded-full ${isActive ? 'bg-blue-600 text-white font-bold' : 'bg-ink-200 text-ink-600'}`}>
                        {isActive ? 'Work Day' : 'Weekly Off'}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 rounded-xl bg-blue-50/60 p-3.5 border border-blue-200/60">
                <p className="text-xs text-blue-900 font-medium">
                  <strong>Policy Summary:</strong> Currently configured for{' '}
                  <span className="font-bold underline">{general.workDays.length} working days per week</span>. Employees checking in on unselected days are marked with weekend overtime or recorded as voluntary holiday shifts.
                </p>
              </div>
            </Card>
          )}

          {canManage && (
            <div className="flex justify-end pt-3">
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => void handleSaveAll()}
              >
                {busy ? 'Saving changes…' : 'Save all office times'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Edit Location Modal */}
      <Modal
        open={Boolean(editLocModal)}
        onClose={() => setEditLocModal(null)}
        title={`Configure Timings · ${editLocModal?.name || 'Location'}`}
        description="Set custom working hours and shift timing specifically for this branch."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setEditLocModal(null)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={saveLocationModal}>
              Apply Timing
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink-800 cursor-pointer">
            <input
              type="checkbox"
              checked={locForm.isCustom}
              onChange={(e) => setLocForm({ ...locForm, isCustom: e.target.checked })}
            />
            <span>Enable custom working hours for this store location</span>
          </label>

          {locForm.isCustom ? (
            <div className="space-y-3 pt-2">
              <Field label="Shift Name / Label" required>
                <input
                  className="input"
                  value={locForm.shiftName}
                  onChange={(e) => setLocForm({ ...locForm, shiftName: e.target.value })}
                  placeholder="e.g. Retail Floor Shift"
                  required
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Work Start Time" required>
                  <input
                    type="time"
                    className="input"
                    value={locForm.workStartTime}
                    onChange={(e) => setLocForm({ ...locForm, workStartTime: e.target.value })}
                    required
                  />
                </Field>
                <Field label="Work End Time" required>
                  <input
                    type="time"
                    className="input"
                    value={locForm.workEndTime}
                    onChange={(e) => setLocForm({ ...locForm, workEndTime: e.target.value })}
                    required
                  />
                </Field>
              </div>

              <Field label="Late Grace (minutes)" required>
                <input
                  type="number"
                  min={0}
                  max={180}
                  className="input"
                  value={locForm.lateGraceMinutes}
                  onChange={(e) => setLocForm({ ...locForm, lateGraceMinutes: Number(e.target.value) })}
                  required
                />
              </Field>
            </div>
          ) : (
            <div className="rounded-xl bg-ink-50 p-4 border border-ink-200 text-xs text-ink-600">
              This location will use the company-wide general office hours ({general?.workStartTime} – {general?.workEndTime}, {general?.lateGraceMinutes}m grace).
            </div>
          )}
        </div>
      </Modal>

      {/* Add / Edit Shift Modal */}
      <Modal
        open={shiftModalOpen}
        onClose={() => setShiftModalOpen(false)}
        title={editingShiftId ? 'Edit Shift Definition' : 'Add New Shift Definition'}
        description="Define a standard shift preset available for assignment across stores."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setShiftModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={saveShiftModal}>
              {editingShiftId ? 'Update Shift' : 'Add to Catalog'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Shift Name" required>
              <input
                className="input"
                placeholder="e.g. Night Retail Shift"
                value={shiftForm.name}
                onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })}
                required
              />
            </Field>
            <Field label="Shift Code" required>
              <input
                className="input font-mono uppercase"
                placeholder="e.g. NGT-01"
                value={shiftForm.code}
                onChange={(e) => setShiftForm({ ...shiftForm, code: e.target.value.toUpperCase() })}
                required
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Start Time" required>
              <input
                type="time"
                className="input"
                value={shiftForm.startTime}
                onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })}
                required
              />
            </Field>
            <Field label="End Time" required>
              <input
                type="time"
                className="input"
                value={shiftForm.endTime}
                onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })}
                required
              />
            </Field>
          </div>

          <Field label="Grace Period (minutes)" required>
            <input
              type="number"
              min={0}
              max={180}
              className="input"
              value={shiftForm.graceMinutes}
              onChange={(e) => setShiftForm({ ...shiftForm, graceMinutes: Number(e.target.value) })}
              required
            />
          </Field>

          <Field label="Description">
            <input
              className="input"
              placeholder="e.g. For store closing operations and cash tally"
              value={shiftForm.description}
              onChange={(e) => setShiftForm({ ...shiftForm, description: e.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
