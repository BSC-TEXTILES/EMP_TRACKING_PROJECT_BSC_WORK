import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/icons';
import { Card, Field, Modal, Skeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useSocketEvent } from '../../contexts/RealtimeContext';
import { useToast } from '../../contexts/ToastContext';
import { api, errorMessage } from '../../lib/api';
import { cx, formatDateTime, formatTime } from '../../lib/format';
import type { PickerEmployee } from '../../lib/types';

/** Local calendar date (YYYY-MM-DD), not UTC. */
export const localToday = () => new Date().toLocaleDateString('en-CA');

export interface TimelineCheckpoint {
  id?: number;
  timeSlot: string;
  label: string;
  hours: string;
  status: 'pending' | 'submitted' | 'verified';
  summary: string | null;
  issuesIdentified: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
}

/** Managers can look at an authorised team member; the server re-checks access on every request. */
export function EmployeeSwitcher({
  employees,
  value,
  onChange,
}: {
  employees: PickerEmployee[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const { user } = useAuth();
  const others = employees.filter((employee) => employee.id !== user?.id);
  if (others.length === 0) return null;
  return (
    <select className="input h-9 w-full py-0 text-sm sm:w-56" value={value ?? ''} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)} aria-label="Employee">
      <option value="">Me ({user?.fullName})</option>
      {others.map((employee) => (
        <option key={employee.id} value={employee.id}>
          {employee.full_name}
          {employee.employee_code ? ` · ${employee.employee_code}` : ''}
        </option>
      ))}
    </select>
  );
}

export function TimelinePanel({ employees }: { employees: PickerEmployee[] }) {
  const { user, user: me } = useAuth();
  const toast = useToast();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [date, setDate] = useState(localToday());
  const [checkpoints, setCheckpoints] = useState<TimelineCheckpoint[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<TimelineCheckpoint | null>(null);
  const [summary, setSummary] = useState('');
  const [issues, setIssues] = useState('');
  const [escalate, setEscalate] = useState(false);
  const [saving, setSaving] = useState(false);

  const viewingSelf = !employeeId || employeeId === user?.id;
  const editable = viewingSelf && date === localToday();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ date });
      if (employeeId) params.set('employeeId', String(employeeId));
      const result = await api.get<{ checkpoints: TimelineCheckpoint[] }>(`/tasks/timeline?${params.toString()}`);
      setCheckpoints(result.checkpoints);
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [date, employeeId]);

  useEffect(() => {
    setCheckpoints(null);
    void load();
  }, [load]);
  useSocketEvent('task:updated', () => void load());

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!active) return;
    if (summary.trim().length < 3) {
      toast.error('Describe the activity in this period (at least 3 characters).');
      return;
    }
    setSaving(true);
    try {
      await api.post('/tasks/timeline', {
        timeSlot: active.timeSlot,
        summary: summary.trim(),
        issues: issues.trim() || undefined,
        escalatedTo: escalate && me?.managerId ? me.managerId : undefined,
      });
      toast.success('Checkpoint saved.');
      setActive(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const done = checkpoints?.filter((cp) => cp.status !== 'pending').length ?? 0;
  const total = checkpoints?.length ?? 7;

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-ink-100 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink-900">Activity timeline</h2>
          <p className="text-sm text-ink-500">Seven checkpoints across store hours (9:30 AM – 9:30 PM), recorded per employee per day.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EmployeeSwitcher employees={employees} value={employeeId} onChange={setEmployeeId} />
          <input type="date" className="input h-9 w-auto py-0 text-sm" value={date} max={localToday()} onChange={(event) => setDate(event.target.value || localToday())} aria-label="Date" />
          <button type="button" className="btn-secondary btn-sm h-9" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        <div className="mb-5 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
            <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <span className="text-sm font-semibold tabular-nums text-ink-700">
            {done} / {total} recorded
          </span>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-red-600">{error}</p>
        ) : !checkpoints ? (
          <Skeleton lines={7} />
        ) : (
          <ol className="relative">
            {checkpoints.map((cp, index) => {
              const last = index === checkpoints.length - 1;
              return (
                <li key={cp.timeSlot} className="relative flex gap-4 pb-5 last:pb-0">
                  {!last && <span className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px bg-ink-200" aria-hidden="true" />}
                  <span
                    className={cx(
                      'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                      cp.status === 'verified'
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : cp.status === 'submitted'
                          ? 'border-brand-600 bg-brand-600 text-white'
                          : 'border-ink-300 bg-surface text-ink-500',
                    )}
                  >
                    {cp.status === 'pending' ? index + 1 : <Icon name="check" size={14} strokeWidth={2.5} />}
                  </span>
                  <div className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-surface p-3.5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink-900">{cp.label}</p>
                        <p className="text-xs text-ink-500">{cp.hours}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={cx(
                            'badge',
                            cp.status === 'verified' ? 'bg-emerald-100 text-emerald-700' : cp.status === 'submitted' ? 'bg-brand-100 text-brand-700' : 'bg-ink-100 text-ink-600',
                          )}
                        >
                          {cp.status === 'verified' ? 'Verified' : cp.status === 'submitted' ? 'Submitted' : 'Pending'}
                        </span>
                        {editable && (
                          <button
                            type="button"
                            className="btn-secondary btn-sm h-8"
                            onClick={() => {
                              setActive(cp);
                              setSummary(cp.summary ?? '');
                              setIssues(cp.issuesIdentified ?? '');
                              setEscalate(false);
                            }}
                          >
                            {cp.status === 'pending' ? 'Record' : 'Update'}
                          </button>
                        )}
                      </div>
                    </div>
                    {cp.summary && <p className="mt-2 text-sm text-ink-700">{cp.summary}</p>}
                    {cp.issuesIdentified && (
                      <p className="mt-2 flex gap-1.5 rounded-md bg-rose-50 px-2.5 py-1.5 text-sm text-rose-700">
                        <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
                        {cp.issuesIdentified}
                      </p>
                    )}
                    {(cp.submittedAt || cp.verifiedAt) && (
                      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
                        {cp.submittedAt && <span>Recorded {date === localToday() ? formatTime(cp.submittedAt) : formatDateTime(cp.submittedAt)}</span>}
                        {cp.verifiedAt && <span>Verified {formatDateTime(cp.verifiedAt)}</span>}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {!editable && checkpoints && (
          <p className="mt-4 text-xs text-ink-500">
            {viewingSelf ? 'Past days are read-only.' : 'You are viewing another employee. Checkpoints can only be recorded by the employee themselves.'}
          </p>
        )}
      </div>

      <Modal
        open={Boolean(active)}
        onClose={() => setActive(null)}
        title={active?.label ?? 'Checkpoint'}
        description={active ? `Time window: ${active.hours}` : undefined}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setActive(null)}>Cancel</button>
            <button type="submit" form="checkpoint-form" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save checkpoint'}</button>
          </>
        }
      >
        <form id="checkpoint-form" onSubmit={save} className="space-y-4">
          <Field label="What was done in this period" required>
            <textarea className="input min-h-[96px]" value={summary} onChange={(event) => setSummary(event.target.value)} required />
          </Field>
          <Field label="Issues or blockers" hint="Leave empty if operations were normal">
            <textarea className="input min-h-[72px]" value={issues} onChange={(event) => setIssues(event.target.value)} />
          </Field>
          {me?.managerId ? (
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" className="h-4 w-4" checked={escalate} onChange={(event) => setEscalate(event.target.checked)} />
              Notify my reporting manager about these issues
            </label>
          ) : null}
        </form>
      </Modal>
    </Card>
  );
}
