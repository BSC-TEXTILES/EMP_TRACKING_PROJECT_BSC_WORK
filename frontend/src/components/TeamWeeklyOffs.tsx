import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { Card, EmptyState, Field, Modal, Skeleton } from './ui';
import { MonthPicker, WeeklyOffPanel } from './WeeklyOffPanel';

interface TeamRow {
  employeeId: number;
  name: string;
  code: string | null;
  locationCode: string | null;
  locationName: string | null;
  departmentName: string | null;
  weeklyOffDay: number;
  weeklyOffDayName: string;
  allocated: number;
  taken: number;
  pending: number;
  worked: number;
  remaining: number;
  halfDaysTaken: number;
  halfDayDeducted: number;
  leaveDaysThisMonth: number;
  compOffAvailable: number;
}

interface TeamSummary {
  year: number;
  month: number;
  monthName: string;
  totalSundays: number;
  sundays: string[];
  employees: TeamRow[];
}

const WEEKDAY_OPTIONS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Managers see their reporting team; HR / admins see the locations they are assigned to. */
export function TeamWeeklyOffs() {
  const { has } = useAuth();
  const toast = useToast();
  const canManage = has('leave.manage');
  const now = new Date();
  const [period, setPeriod] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState<{ id: number; code: string; name: string }[]>([]);
  const [data, setData] = useState<TeamSummary | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TeamRow | null>(null);

  useEffect(() => {
    api
      .get<{ locations: { id: number; code: string; name: string }[] }>('/employees/allowed-locations')
      .then((result) => setLocations(result.locations))
      .catch(() => setLocations([]));
  }, []);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ year: String(period.year), month: String(period.month) });
      if (locationId) params.set('locationId', locationId);
      setData(await api.get<TeamSummary>(`/leave/weekly-offs/team?${params.toString()}`));
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [period, locationId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  useSocketEvent('leave:policy', () => void load());
  useSocketEvent('leave:updated', () => void load());

  const changeWeekday = async (row: TeamRow, weekday: number) => {
    if (weekday === row.weeklyOffDay) return;
    if (!window.confirm(`Change ${row.name}'s weekly off to ${WEEKDAY_OPTIONS[weekday]}? Approved weekly offs already taken are kept.`)) return;
    try {
      await api.put(`/leave/weekly-off-day/${row.employeeId}`, { weekday });
      toast.success(`${row.name}'s weekly off is now ${WEEKDAY_OPTIONS[weekday]}.`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const rows = (data?.employees ?? []).filter((row) =>
    `${row.name} ${row.code ?? ''} ${row.locationCode ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Team weekly offs</h2>
          <p className="text-xs text-ink-500">
            {data ? `${data.monthName} ${data.year}: weekly offs allocated from each employee's assigned weekly-off day and joining date; taken = approved.` : 'Loading…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {locations.length > 1 && (
            <select className="input h-8 w-auto py-0 text-sm" value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-label="Location">
              <option value="">All my locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>{location.code} · {location.name}</option>
              ))}
            </select>
          )}
          <input className="input h-8 w-40 py-0 text-sm" placeholder="Search employee" value={search} onChange={(event) => setSearch(event.target.value)} />
          <MonthPicker year={period.year} month={period.month} onChange={(year, month) => setPeriod({ year, month })} />
        </div>
      </div>
      {error ? (
        <p role="alert" className="p-4 text-sm text-red-600">{error}</p>
      ) : !data ? (
        <div className="p-4"><Skeleton lines={5} /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="No employees" description="Employees you are allowed to see will appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Location</th>
                <th>Weekly off</th>
                <th className="text-right">Allocated</th>
                <th className="text-right">Taken</th>
                <th className="text-right">Pending</th>
                <th className="text-right">Remaining</th>
                <th className="text-right">Half days</th>
                <th className="text-right">Worked on off</th>
                <th className="text-right">Leave days</th>
                <th className="text-right">Comp-off</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId} className="cursor-pointer" onClick={() => setSelected(row)}>
                  <td>
                    <p className="font-medium text-ink-800">{row.name}</p>
                    <p className="text-xs text-ink-400">{row.code ?? ''}{row.departmentName ? ` · ${row.departmentName}` : ''}</p>
                  </td>
                  <td className="text-ink-600">{row.locationCode ?? '—'}</td>
                  <td className="text-ink-600" onClick={(event) => canManage && event.stopPropagation()}>
                    {canManage ? (
                      <select
                        className="input h-7 w-auto py-0 text-xs"
                        value={row.weeklyOffDay}
                        aria-label={`Weekly-off day for ${row.name}`}
                        onChange={(event) => void changeWeekday(row, Number(event.target.value))}
                      >
                        {WEEKDAY_OPTIONS.map((name, index) => <option key={name} value={index}>{name}</option>)}
                      </select>
                    ) : (
                      row.weeklyOffDayName
                    )}
                  </td>
                  <td className="text-right font-semibold text-ink-800">{row.allocated}</td>
                  <td className="text-right font-semibold text-emerald-700">{row.taken}</td>
                  <td className="text-right text-amber-700">{row.pending}</td>
                  <td className="text-right font-semibold text-emerald-700">{row.remaining}</td>
                  <td className="text-right text-orange-700">{row.halfDaysTaken}{row.halfDayDeducted ? ` (${row.halfDayDeducted} d)` : ''}</td>
                  <td className="text-right text-amber-700">{row.worked}</td>
                  <td className="text-right text-ink-600">{row.leaveDaysThisMonth}</td>
                  <td className="text-right text-ink-600">{row.compOffAvailable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected ? `${selected.name} · weekly offs` : ''} size="xl">
        {selected && <WeeklyOffPanel employeeId={selected.employeeId} title={`${selected.name}${selected.locationCode ? ` (${selected.locationCode})` : ''}`} />}
      </Modal>
    </Card>
  );
}

interface LeavePolicy {
  compOffEnabled: boolean;
  compOffOnHolidays: boolean;
  compOffFullDayMinutes: number;
  compOffHalfDayMinutes: number;
  compOffExpiryDays: number;
}

/** HR / Super Admin (leave.manage): compensatory-off rules for work on weekly offs and holidays. */
export function LeavePolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [policy, setPolicy] = useState<LeavePolicy | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPolicy(null);
    api
      .get<{ policy: LeavePolicy }>('/leave/policy')
      .then((result) => setPolicy(result.policy))
      .catch((caught) => toast.error(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!policy) return;
    setBusy(true);
    try {
      const result = await api.put<{ policy: LeavePolicy }>('/leave/policy', policy);
      setPolicy(result.policy);
      toast.success('Leave policy saved.');
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const hours = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100);
  const toMinutes = (value: string) => Math.round(Number(value || 0) * 60);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Weekly off & comp-off policy"
      description="Weekly offs are calculated from each employee's assigned weekly-off day. These rules control compensatory offs."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" form="leave-policy-form" type="submit" disabled={busy || !policy}>{busy ? 'Saving…' : 'Save policy'}</button>
        </>
      }
    >
      {!policy ? (
        <Skeleton lines={5} />
      ) : (
        <form id="leave-policy-form" onSubmit={save} className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            Each employee's assigned weekly-off day (Sunday by default) is allocated for every such date on or after joining: a month with 5
            gives 5 weekly offs, a month with 4 gives 4. A weekly off counts as taken once the manager and HR approve it. Weekly offs are never
            deducted from CL, SL or EL, and weekly offs or public holidays inside a leave request are not charged.
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={policy.compOffEnabled} onChange={(event) => setPolicy({ ...policy, compOffEnabled: event.target.checked })} />
            Give compensatory off when an employee works on their weekly off
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={policy.compOffOnHolidays}
              disabled={!policy.compOffEnabled}
              onChange={(event) => setPolicy({ ...policy, compOffOnHolidays: event.target.checked })}
            />
            Also for work on public holidays
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Hours for a full day" hint="1 comp-off day">
              <input
                type="number"
                className="input"
                min={1}
                max={24}
                step={0.25}
                value={hours(policy.compOffFullDayMinutes)}
                disabled={!policy.compOffEnabled}
                onChange={(event) => setPolicy({ ...policy, compOffFullDayMinutes: toMinutes(event.target.value) })}
                required
              />
            </Field>
            <Field label="Hours for a half day" hint="0 = no half days">
              <input
                type="number"
                className="input"
                min={0}
                max={23.75}
                step={0.25}
                value={hours(policy.compOffHalfDayMinutes)}
                disabled={!policy.compOffEnabled}
                onChange={(event) => setPolicy({ ...policy, compOffHalfDayMinutes: toMinutes(event.target.value) })}
                required
              />
            </Field>
            <Field label="Expires after (days)" hint="0 = never expires">
              <input
                type="number"
                className="input"
                min={0}
                max={730}
                value={policy.compOffExpiryDays}
                disabled={!policy.compOffEnabled}
                onChange={(event) => setPolicy({ ...policy, compOffExpiryDays: Math.round(Number(event.target.value || 0)) })}
                required
              />
            </Field>
          </div>
          <p className="text-xs text-ink-500">
            Credits are calculated from attendance at check-out (and after an approved correction) and recorded once per day, so they are
            never duplicated. Changes apply to work done from now on; credits already earned are kept.
          </p>
        </form>
      )}
    </Modal>
  );
}
