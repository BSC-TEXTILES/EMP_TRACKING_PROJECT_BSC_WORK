import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { Field, Modal } from './ui';
import { Icon } from './icons';

export interface Hours {
  workStart: string;
  workEnd: string;
  breakStart?: string | null;
  breakEnd?: string | null;
  secondBreakStart?: string | null;
  secondBreakEnd?: string | null;
  totalWorkingHours?: number | null;
  weeklyWorkingDays?: number[];
  weeklyOffDay?: number | null;
  graceMinutes: number;
  earlyDepartureThresholdMinutes?: number | null;
}

export interface OfficeHoursData {
  default: Hours;
  locations: (Hours & { locationId: number; code: string; name: string; usesDefault: boolean })[];
  canEdit: boolean;
}

/** Login / logout hours for an employee's location (company default when the location has none). */
export function hoursFor(data: OfficeHoursData | null, locationId: number | null | undefined): Hours | null {
  if (!data) return null;
  return data.locations.find((l) => l.locationId === locationId) ?? data.default;
}

/**
 * Office hours strip for the Employees page: company login / logout time,
 * any location that differs, and (for admins) a dialog to change them.
 * Check-in after login time + grace is marked Late; check-out before the
 * logout time is an early departure.
 */
export function OfficeHoursBar({ onLoaded }: { onLoaded?: (data: OfficeHoursData) => void }) {
  const toast = useToast();
  const [data, setData] = useState<OfficeHoursData | null>(null);
  const [editing, setEditing] = useState(false);

  const load = async () => {
    try {
      const result = await api.get<OfficeHoursData>('/attendance/office-hours');
      setData(result);
      onLoaded?.(result);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;
  const custom = data.locations.filter((l) => !l.usesDefault);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-100 bg-ink-50 px-4 py-2.5 text-sm">
      <span className="inline-flex items-center gap-2 font-semibold text-ink-700">
        <Icon name="clock" size={15} className="text-brand-700" /> Office hours
      </span>
      <span className="text-ink-700">
        Login <b className="font-semibold text-ink-900">{data.default.workStart}</b>
        <span className="mx-1.5 text-ink-300">·</span>
        Logout <b className="font-semibold text-ink-900">{data.default.workEnd}</b>
        <span className="mx-1.5 text-ink-300">·</span>
        <span className="text-ink-500">{data.default.graceMinutes} min grace</span>
      </span>
      {custom.map((l) => (
        <span key={l.locationId} className="rounded border border-ink-200 bg-surface px-2 py-0.5 text-xs text-ink-600" title={l.name}>
          <b className="font-mono text-ink-800">{l.code}</b> {l.workStart}–{l.workEnd} · {l.graceMinutes}m
        </span>
      ))}
      {data.canEdit && (
        <span className="ml-auto flex items-center gap-2">
          <Link to="/admin/office-times" className="text-xs font-medium text-brand-700 hover:underline">Shifts, breaks & work days</Link>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(true)}>
            <Icon name="edit" size={14} /> Change office hours
          </button>
        </span>
      )}
      {editing && <OfficeHoursModal data={data} onClose={() => setEditing(false)} onSaved={(next) => { setData(next); onLoaded?.(next); }} />}
    </div>
  );
}

function OfficeHoursModal({ data, onClose, onSaved }: { data: OfficeHoursData; onClose: () => void; onSaved: (data: OfficeHoursData) => void }) {
  const toast = useToast();
  const [def, setDef] = useState<Hours>(data.default);
  const [locs, setLocs] = useState(() => data.locations.map((l) => ({ ...l })));
  const [saving, setSaving] = useState(false);

  const invalid = (h: Hours) => !h.workStart || !h.workEnd || h.workEnd <= h.workStart || h.graceMinutes < 0 || h.graceMinutes > 120;
  const hasError = invalid(def) || locs.some((l) => !l.usesDefault && invalid(l));

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.put<OfficeHoursData>('/attendance/office-hours', {
        default: def,
        locations: locs.map((l) => (l.usesDefault
          ? { locationId: l.locationId, inherit: true }
          : {
              locationId: l.locationId,
              workStart: l.workStart,
              workEnd: l.workEnd,
              breakStart: l.breakStart ?? null,
              breakEnd: l.breakEnd ?? null,
              secondBreakStart: l.secondBreakStart ?? null,
              secondBreakEnd: l.secondBreakEnd ?? null,
              totalWorkingHours: l.totalWorkingHours ?? null,
              weeklyWorkingDays: l.weeklyWorkingDays ?? null,
              weeklyOffDay: l.weeklyOffDay ?? null,
              graceMinutes: l.graceMinutes,
              earlyDepartureThresholdMinutes: l.earlyDepartureThresholdMinutes ?? null,
            })),
      });
      toast.success('Office hours saved. They apply from the next check-in.');
      onSaved(result);
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const timeInputs = (h: Hours, set: (h: Hours) => void, disabled = false) => (
    <>
      <input type="time" className="input" value={h.workStart} disabled={disabled} onChange={(e) => set({ ...h, workStart: e.target.value })} aria-label="Login time" />
      <input type="time" className="input" value={h.workEnd} disabled={disabled} onChange={(e) => set({ ...h, workEnd: e.target.value })} aria-label="Logout time" />
      <input type="time" className="input" value={h.breakStart ?? ''} disabled={disabled} onChange={(e) => set({ ...h, breakStart: e.target.value || null })} aria-label="Break start time" />
      <input type="time" className="input" value={h.breakEnd ?? ''} disabled={disabled} onChange={(e) => set({ ...h, breakEnd: e.target.value || null })} aria-label="Break end time" />
      <input type="number" min={0} max={120} className="input" value={h.graceMinutes} disabled={disabled}
        onChange={(e) => set({ ...h, graceMinutes: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })} aria-label="Grace minutes" />
    </>
  );

  const scheduleInputs = (h: Hours, set: (h: Hours) => void, disabled = false) => (
    <>
      <input type="number" min={0.25} max={24} step={0.25} className="input" value={h.totalWorkingHours ?? ''} disabled={disabled}
        onChange={(e) => set({ ...h, totalWorkingHours: e.target.value ? Math.max(0.25, Math.min(24, Number(e.target.value))) : null })} aria-label="Total working hours" />
      <input type="number" min={0} max={480} className="input" value={h.earlyDepartureThresholdMinutes ?? ''} disabled={disabled}
        onChange={(e) => set({ ...h, earlyDepartureThresholdMinutes: e.target.value ? Math.max(0, Math.min(480, Number(e.target.value))) : null })} aria-label="Early departure threshold (minutes)" />
      <input type="number" min={0} max={6} className="input" value={h.weeklyOffDay ?? ''} disabled={disabled}
        onChange={(e) => set({ ...h, weeklyOffDay: e.target.value ? Math.max(0, Math.min(6, Number(e.target.value))) : null })} aria-label="Weekly off day (0=Sun, 6=Sat)" />
    </>
  );

  const weeklyDaysSelector = (h: Hours, set: (h: Hours) => void, disabled = false) => (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Weekly working days">
      {[0, 1, 2, 3, 4, 5, 6].map((day) => (
        <label key={day} className="inline-flex items-center gap-1 px-2 py-1 rounded border text-xs cursor-pointer transition"
          style={{
            backgroundColor: h.weeklyWorkingDays?.includes(day) ? '#3b82f6' : '#f3f4f6',
            color: h.weeklyWorkingDays?.includes(day) ? 'white' : '#374151',
            borderColor: h.weeklyWorkingDays?.includes(day) ? '#3b82f6' : '#d1d5db',
          }}>
          <input type="checkbox"
            checked={h.weeklyWorkingDays?.includes(day) ?? false}
            disabled={disabled}
            onChange={(e) => set({ ...h, weeklyWorkingDays: e.target.checked
              ? [...(h.weeklyWorkingDays ?? []), day]
              : (h.weeklyWorkingDays ?? []).filter((d) => d !== day) })} />
          <span>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]}</span>
        </label>
      ))}
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Location Office Timings"
      description="Configure office start/end times, breaks, working hours, weekly offs, and grace periods per location. Changes apply from the next check-in; today's records are not recalculated."
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={saving || hasError} onClick={() => void save()}>{saving ? 'Saving…' : 'Save office timings'}</button>
      </>}
    >
      <div className="space-y-5">
        <Field label="Company default (all locations unless changed below)">
          <div className="grid grid-cols-3 gap-2">
            {timeInputs(def, setDef)}
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-ink-400"><span>Login</span><span>Logout</span><span>Grace (min)</span></div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {scheduleInputs(def, setDef)}
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-ink-400"><span>Work hrs/day</span><span>Early dep. (min)</span><span>Weekly off (0=Sun)</span></div>
          <div className="mt-2">
            <label className="label">Weekly working days</label>
            {weeklyDaysSelector(def, setDef)}
          </div>
          {invalid(def) && <p className="mt-1 text-xs text-red-600">Logout must be after login, grace 0–120 minutes.</p>}
        </Field>

        <div>
          <p className="label">Per location</p>
          <ul className="space-y-2">
            {locs.map((l, i) => {
              const set = (h: Hours) => setLocs((prev) => prev.map((p, j) => (j === i ? { ...p, ...h } : p)));
              return (
                <li key={l.locationId} className="rounded-lg border border-ink-200 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink-800"><b className="font-mono">{l.code}</b> – {l.name}</span>
                    <label className="inline-flex items-center gap-2 text-xs text-ink-600">
                      <input type="checkbox" checked={l.usesDefault}
                        onChange={(e) => setLocs((prev) => prev.map((p, j) => (j === i ? { ...p, usesDefault: e.target.checked, ...(e.target.checked ? def : {}) } : p)))} />
                      Use company defaults
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {timeInputs(l.usesDefault ? def : l, set, l.usesDefault)}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {scheduleInputs(l.usesDefault ? def : l, set, l.usesDefault)}
                  </div>
                  <div className="mt-2">
                    <label className="label">Weekly working days</label>
                    {weeklyDaysSelector(l.usesDefault ? def : l, set, l.usesDefault)}
                  </div>
                  {!l.usesDefault && invalid(l) && <p className="mt-1 text-xs text-red-600">Invalid schedule: logout must be after login, grace 0–120 minutes.</p>}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

const scheduleInputs = (h: Hours, set: (h: Hours) => void, disabled = false) => (
  <>
    <input type="number" min={0.25} max={24} step={0.25} className="input" value={h.totalWorkingHours ?? ''} disabled={disabled}
      onChange={(e) => set({ ...h, totalWorkingHours: e.target.value ? Math.max(0.25, Math.min(24, Number(e.target.value))) : null })} aria-label="Total working hours per day" />
    <input type="number" min={0} max={480} className="input" value={h.earlyDepartureThresholdMinutes ?? ''} disabled={disabled}
      onChange={(e) => set({ ...h, earlyDepartureThresholdMinutes: e.target.value ? Math.max(0, Math.min(480, Number(e.target.value))) : null })} aria-label="Early departure threshold (minutes)" />
    <input type="number" min={0} max={6} className="input" value={h.weeklyOffDay ?? ''} disabled={disabled}
      onChange={(e) => set({ ...h, weeklyOffDay: e.target.value ? Math.max(0, Math.min(6, Number(e.target.value))) : null })} aria-label="Weekly off day (0=Sun, 6=Sat)" />
  </>
);
