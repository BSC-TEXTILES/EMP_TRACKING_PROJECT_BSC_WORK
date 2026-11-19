import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/icons';
import { Card, Field, Modal, Skeleton } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useSocketEvent } from '../../contexts/RealtimeContext';
import { useToast } from '../../contexts/ToastContext';
import { api, errorMessage } from '../../lib/api';
import { cx, formatDateTime, formatTime } from '../../lib/format';
import type { PickerEmployee } from '../../lib/types';
import { displayName } from './taskConfig';

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

/** Managers can look at an authorised team member */
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
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-800">
      <Icon name="user" size={14} className="text-brand-600" />
      <span>{displayName(user?.fullName)}</span>
      {user?.employeeCode ? <span className="font-mono text-[11px] text-ink-500">({user.employeeCode})</span> : null}
    </span>
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
      toast.success('Checkpoint recorded successfully.');
      setActive(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const doneCount = checkpoints?.filter((cp) => cp.status !== 'pending').length ?? 0;
  const verifiedCount = checkpoints?.filter((cp) => cp.status === 'verified').length ?? 0;
  const total = checkpoints?.length ?? 7;
  const percentDone = Math.round((doneCount / total) * 100);

  return (
    <div className="space-y-4">
      {/* Panel Card */}
      <div className="rounded-2xl border border-ink-200/90 bg-surface p-5 shadow-sm dark:border-ink-800">
        {/* Panel Header */}
        <div className="flex flex-col gap-4 border-b border-ink-100 pb-5 dark:border-ink-800 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                <Icon name="clock" size={17} strokeWidth={2.2} />
              </span>
              <h2 className="text-lg font-bold text-ink-900">Activity Timeline — 7 Shift Checkpoints</h2>
            </div>
            <p className="mt-1 text-xs text-ink-500">
              Verified operational checkpoints logged across store trading hours (09:30 AM – 09:30 PM).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <EmployeeSwitcher employees={employees} value={employeeId} onChange={setEmployeeId} />
            <div className="relative">
              <input
                type="date"
                className="input h-9 w-auto px-3 py-0 text-sm font-semibold"
                value={date}
                max={localToday()}
                onChange={(event) => setDate(event.target.value || localToday())}
                aria-label="Timeline Date"
              />
            </div>
            <button
              type="button"
              className="btn-secondary h-9 px-3 text-xs font-semibold"
              onClick={() => void load()}
              disabled={loading}
            >
              <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {/* Progress Summary Header */}
        <div className="my-5 rounded-xl border border-ink-200/80 bg-ink-50/60 p-4 dark:border-ink-800 dark:bg-ink-900/30">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-700">
              Daily Operational Checkpoint Progress
            </span>
            <div className="flex items-center gap-3 text-xs font-semibold">
              <span className="text-emerald-700 dark:text-emerald-400">
                ✓ {verifiedCount} Verified
              </span>
              <span className="text-brand-700 dark:text-brand-400">
                • {doneCount - verifiedCount} Submitted
              </span>
              <span className="text-ink-500">
                ○ {total - doneCount} Pending
              </span>
            </div>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-600 to-emerald-500 transition-all duration-300"
              style={{ width: `${percentDone}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-ink-500 font-medium">
            <span>{doneCount} of {total} checkpoints completed</span>
            <span className="font-bold tabular-nums text-ink-800">{percentDone}% Complete</span>
          </div>
        </div>

        {/* Checkpoint Stepper / List */}
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        ) : !checkpoints ? (
          <Skeleton lines={7} />
        ) : (
          <ol className="relative ml-2 space-y-4 border-l-2 border-brand-200 dark:border-ink-800 pl-6 my-4">
            {checkpoints.map((cp, index) => {
              const isVerified = cp.status === 'verified';
              const isSubmitted = cp.status === 'submitted';
              const isPending = cp.status === 'pending';

              return (
                <li key={cp.timeSlot} className="relative">
                  {/* Step Circle Indicator */}
                  <span
                    className={cx(
                      'absolute -left-[33px] top-1.5 flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors',
                      isVerified
                        ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                        : isSubmitted
                          ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                          : 'border-ink-300 bg-surface text-ink-500 dark:border-ink-700',
                    )}
                  >
                    {isPending ? index + 1 : <Icon name="check" size={13} strokeWidth={2.6} />}
                  </span>

                  {/* Card Container */}
                  <div
                    className={cx(
                      'rounded-xl border p-4 transition-all duration-150',
                      isVerified
                        ? 'border-emerald-200/80 bg-emerald-50/20 dark:border-emerald-900/40'
                        : isSubmitted
                          ? 'border-brand-200/80 bg-brand-50/20 dark:border-brand-900/40'
                          : 'border-ink-200/80 bg-surface dark:border-ink-800',
                    )}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-ink-900">{cp.label}</h3>
                          <span className="rounded bg-ink-100 px-2 py-0.5 text-[11px] font-semibold text-ink-600 dark:bg-ink-800">
                            {cp.hours}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={cx(
                            'badge font-bold',
                            isVerified
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : isSubmitted
                                ? 'bg-brand-100 text-brand-800 border border-brand-200 dark:bg-brand-950/40 dark:text-brand-300'
                                : 'bg-ink-100 text-ink-600 border border-ink-200 dark:bg-ink-800',
                          )}
                        >
                          {isVerified ? 'Verified' : isSubmitted ? 'Submitted' : 'Pending'}
                        </span>

                        {editable && (
                          <button
                            type="button"
                            className="btn-secondary h-8 px-3 text-xs font-semibold"
                            onClick={() => {
                              setActive(cp);
                              setSummary(cp.summary ?? '');
                              setIssues(cp.issuesIdentified ?? '');
                              setEscalate(false);
                            }}
                          >
                            {isPending ? 'Log Checkpoint' : 'Edit Log'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Summary and issues */}
                    {cp.summary && (
                      <div className="mt-3 rounded-lg bg-surface/80 p-3 text-xs leading-relaxed text-ink-800 border border-ink-100 dark:border-ink-800">
                        <p className="font-semibold text-ink-500 uppercase text-[10px] tracking-wider mb-1">
                          Operational Summary:
                        </p>
                        <p className="whitespace-pre-line">{cp.summary}</p>
                      </div>
                    )}

                    {cp.issuesIdentified && (
                      <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                        <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0 text-amber-600" />
                        <div>
                          <strong className="font-bold">Flagged Issues: </strong>
                          <span>{cp.issuesIdentified}</span>
                        </div>
                      </div>
                    )}

                    {/* Timestamps */}
                    {(cp.submittedAt || cp.verifiedAt) && (
                      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-ink-400 border-t border-ink-100 pt-2.5 dark:border-ink-800">
                        {cp.submittedAt && (
                          <span>Submitted: <strong className="text-ink-600 font-semibold">{formatDateTime(cp.submittedAt)}</strong></span>
                        )}
                        {cp.verifiedAt && (
                          <span>Verified: <strong className="text-emerald-700 font-semibold">{formatDateTime(cp.verifiedAt)}</strong></span>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Checkpoint Record Modal */}
      <Modal
        open={Boolean(active)}
        onClose={() => setActive(null)}
        title={active ? `Record Checkpoint: ${active.label}` : 'Record Checkpoint'}
        description={active?.hours}
        size="lg"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button type="button" className="btn-ghost text-xs" onClick={() => setActive(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="checkpoint-form"
              className="btn-primary text-xs font-bold"
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Checkpoint'}
            </button>
          </div>
        }
      >
        <form id="checkpoint-form" onSubmit={save} className="space-y-4">
          <Field label="Operational Summary" required hint="Briefly summarize completed floor duties and shift observations">
            <textarea
              className="input min-h-[90px] text-sm"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. Completed opening float verification, sales terminals live, morning staff brief conducted with 6 attendees."
              required
            />
          </Field>

          <Field label="Issues or Blockers (Optional)" hint="Log any shortages, cash discrepancies, or customer escalation">
            <textarea
              className="input min-h-[60px] text-sm"
              value={issues}
              onChange={(e) => setIssues(e.target.value)}
              placeholder="e.g. Till #2 printer ribbon stuck, replacement requested from store tech."
            />
          </Field>

          <label className="flex items-center gap-2 text-xs font-semibold text-ink-700 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={escalate}
              onChange={(e) => setEscalate(e.target.checked)}
              className="rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            <span>Escalate issues immediately to reporting manager</span>
          </label>
        </form>
      </Modal>
    </div>
  );
}
