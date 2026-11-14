import { useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { useServerClock } from '../lib/hooks';
import { cx, formatTime, minutesToHours, secondsToClock } from '../lib/format';
import { errorMessage } from '../lib/api';
import type { AttendanceState } from '../lib/types';
import { Badge, StatusBadge } from './ui';
import { Icon } from './icons';

interface Props {
  state: AttendanceState | null;
  loading?: boolean;
  pending?: string | null;
  onAction: (action: 'check-in' | 'check-out' | 'break/start' | 'break/end', payload?: Record<string, unknown>) => Promise<unknown>;
  compact?: boolean;
}

export function AttendanceTimer({ state, loading, pending, onAction, compact }: Props) {
  const toast = useToast();
  const [locating, setLocating] = useState(false);
  const running = Boolean(state?.checkInAt && !state?.checkOutAt);
  const elapsed = useServerClock(state?.serverNow ?? null, state?.elapsedSeconds ?? 0, running);

  const handle = async (action: 'check-in' | 'check-out' | 'break/start' | 'break/end') => {
    try {
      let payload: Record<string, unknown> = {};
      if (action === 'check-in' && 'geolocation' in navigator) {
        setLocating(true);
        payload = await new Promise<Record<string, unknown>>((resolve) => {
          const timer = window.setTimeout(() => resolve({}), 3000);
          navigator.geolocation.getCurrentPosition(
            (position) => {
              window.clearTimeout(timer);
              resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
            },
            () => {
              window.clearTimeout(timer);
              resolve({});
            },
            { timeout: 3000, maximumAge: 60_000 },
          );
        });
        setLocating(false);
      }
      await onAction(action, payload);
      toast.success(
        action === 'check-in'
          ? 'Checked in. Your working timer has started.'
          : action === 'check-out'
            ? 'Checked out. Working hours saved.'
            : action === 'break/start'
              ? 'Break started.'
              : 'Break ended.',
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className={cx('card overflow-hidden', compact ? 'p-4' : 'p-5')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Today&apos;s attendance</p>
          <div className="mt-1 flex items-center gap-2">
            {state ? <StatusBadge status={state.status} /> : <Badge tone="neutral">Loading…</Badge>}
            {state?.isLate && <Badge tone="warning">Late by {state.lateMinutes}m</Badge>}
            {state?.isOnBreak && <Badge tone="info">On break</Badge>}
            {state?.isHoliday && <Badge tone="brand">{state.holidayName ?? 'Holiday'}</Badge>}
          </div>
        </div>
        <div className="text-right text-xs text-ink-500">
          <p>Shift {state?.workStart ?? '—'} – {state?.workEnd ?? '—'}</p>
          <p className="mt-0.5">Check-in {state?.checkInAt ? formatTime(state.checkInAt) : '—'}</p>
          <p>Check-out {state?.checkOutAt ? formatTime(state.checkOutAt) : '—'}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-400">
            {running ? 'Working duration' : state?.checkOutAt ? 'Total worked' : 'Not started'}
          </p>
          <p className="font-mono text-3xl font-semibold tabular-nums text-ink-900 sm:text-4xl">
            {loading && !state ? '--:--:--' : running ? secondsToClock(elapsed) : minutesToHours(state?.totalMinutes ?? 0)}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {state?.breakMinutes ? `Breaks ${minutesToHours(state.breakMinutes)} · ` : ''}
            {state?.overtimeMinutes ? `Overtime ${minutesToHours(state.overtimeMinutes)}` : 'Server-timestamped · continues after refresh'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!state?.checkInAt && (
            <button type="button" className="btn-primary" disabled={pending === 'check-in' || locating} onClick={() => void handle('check-in')}>
              <Icon name="play" size={16} /> {locating ? 'Locating…' : pending === 'check-in' ? 'Checking in…' : 'CHECK IN'}
            </button>
          )}
          {state?.checkInAt && !state?.checkOutAt && (
            <>
              {state.isOnBreak ? (
                <button type="button" className="btn-secondary" disabled={pending === 'break/end'} onClick={() => void handle('break/end')}>
                  <Icon name="play" size={16} /> Resume work
                </button>
              ) : (
                <button type="button" className="btn-secondary" disabled={pending === 'break/start'} onClick={() => void handle('break/start')}>
                  <Icon name="pause" size={16} /> Start break
                </button>
              )}
              <button type="button" className="btn-danger" disabled={pending === 'check-out'} onClick={() => void handle('check-out')}>
                <Icon name="check" size={16} /> CHECK OUT
              </button>
            </>
          )}
          {state?.checkOutAt && (
            <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
              Day closed · {minutesToHours(state.totalMinutes)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
