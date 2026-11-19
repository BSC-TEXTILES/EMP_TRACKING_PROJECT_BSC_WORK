import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/icons';
import { Card, Skeleton } from '../../components/ui';
import { useSocketEvent } from '../../contexts/RealtimeContext';
import { api, errorMessage } from '../../lib/api';
import { cx } from '../../lib/format';
import type { PickerEmployee } from '../../lib/types';
import { EmployeeSwitcher, localToday } from './TimelinePanel';

interface ScoreCategory {
  key: string;
  label: string;
  max: number;
  score: number | null;
  measured: boolean;
  basis: string;
}

export interface PerformanceScore {
  date: string;
  totalScore: number | null;
  earnedPoints: number;
  measuredMax: number;
  rating: string;
  breakdown: ScoreCategory[];
}

const CATEGORY_ICONS: Record<string, string> = {
  task: 'tasks',
  timely: 'clock',
  quality: 'checkCircle',
  reporting: 'file',
  attendance: 'userCheck',
  coordination: 'users',
  escalation: 'alertTriangle',
};

function ratingTone(score: number | null) {
  if (score === null) return { ring: 'text-ink-300', badge: 'bg-ink-100 text-ink-600' };
  if (score >= 90) return { ring: 'text-emerald-500', badge: 'bg-emerald-100 text-emerald-700' };
  if (score >= 80) return { ring: 'text-brand-600', badge: 'bg-brand-100 text-brand-700' };
  if (score >= 70) return { ring: 'text-amber-500', badge: 'bg-amber-100 text-amber-700' };
  return { ring: 'text-rose-500', badge: 'bg-rose-100 text-rose-700' };
}

function ScoreRing({ score }: { score: number | null }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const tone = ratingTone(score);
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r={radius} fill="none" strokeWidth="10" className="stroke-ink-100" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          stroke="currentColor"
          className={cx('transition-all duration-500', tone.ring)}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - (score ?? 0) / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums text-ink-900">{score === null ? '—' : score.toFixed(1)}</span>
        <span className="text-xs text-ink-500">out of 100</span>
      </div>
    </div>
  );
}

export function PerformancePanel({ employees }: { employees: PickerEmployee[] }) {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [date, setDate] = useState(localToday());
  const [data, setData] = useState<PerformanceScore | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ date });
      if (employeeId) params.set('employeeId', String(employeeId));
      setData(await api.get<PerformanceScore>(`/tasks/performance?${params.toString()}`));
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [date, employeeId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  useSocketEvent('task:updated', () => void load());
  useSocketEvent('attendance:update', () => void load());

  const tone = ratingTone(data?.totalScore ?? null);
  const notMeasured = data?.breakdown.filter((item) => !item.measured) ?? [];

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-ink-100 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink-900">100-point performance score</h2>
          <p className="text-sm text-ink-500">Calculated from recorded tasks, verification, proof, checkpoints and attendance for the selected day.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EmployeeSwitcher employees={employees} value={employeeId} onChange={setEmployeeId} />
          <input type="date" className="input h-9 w-auto py-0 text-sm" value={date} max={localToday()} onChange={(event) => setDate(event.target.value || localToday())} aria-label="Date" />
          <button type="button" className="btn-secondary btn-sm h-9" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
            Recalculate
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="p-5 text-sm text-red-600">Could not calculate the score: {error}</p>
      ) : !data ? (
        <div className="p-5"><Skeleton lines={6} /></div>
      ) : (
        <div className="grid gap-6 p-4 sm:p-5 lg:grid-cols-[minmax(260px,320px)_1fr]">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-ink-200 bg-ink-50 p-5 text-center">
            <ScoreRing score={data.totalScore} />
            <span className={cx('badge px-3 py-1 text-sm', tone.badge)}>{data.rating}</span>
            <p className="text-xs text-ink-500">
              {data.measuredMax > 0
                ? `${data.earnedPoints} of ${data.measuredMax} measurable points earned, scaled to 100.`
                : 'Nothing could be measured for this day yet.'}
            </p>
            {notMeasured.length > 0 && (
              <p className="text-xs text-ink-400">Not counted: {notMeasured.map((item) => item.label.toLowerCase()).join(', ')}.</p>
            )}
          </div>

          <ul className="grid content-start gap-3 sm:grid-cols-2">
            {data.breakdown.map((item) => {
              const percent = item.score === null ? 0 : (item.score / item.max) * 100;
              return (
                <li key={item.key} className={cx('rounded-lg border p-3.5', item.measured ? 'border-ink-200 bg-surface' : 'border-dashed border-ink-200 bg-ink-50')}>
                  <div className="flex items-center gap-2.5">
                    <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', item.measured ? 'bg-brand-50 text-brand-700' : 'bg-ink-100 text-ink-400')}>
                      <Icon name={CATEGORY_ICONS[item.key] ?? 'chart'} size={15} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-900">{item.label}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-ink-900">
                      {item.measured ? item.score : '—'}
                      <span className="font-normal text-ink-400"> / {item.max}</span>
                    </span>
                  </div>
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
                    <div className={cx('h-full rounded-full', percent >= 80 ? 'bg-emerald-500' : percent >= 50 ? 'bg-brand-600' : 'bg-amber-500')} style={{ width: `${percent}%` }} />
                  </div>
                  <p className={cx('mt-1.5 text-xs', item.measured ? 'text-ink-500' : 'text-ink-400')}>{item.measured ? item.basis : `Not measured · ${item.basis}`}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
