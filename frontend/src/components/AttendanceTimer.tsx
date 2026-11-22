import { useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { useServerClock } from '../lib/hooks';
import { cx, formatTime, minutesToHours, secondsToClock } from '../lib/format';
import { errorMessage } from '../lib/api';
import type { AttendanceState } from '../lib/types';
import { Badge, StatusBadge, Modal } from './ui';
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
  const [checkoutConfirmOpen, setCheckoutConfirmOpen] = useState(false);
  const running = Boolean(state?.checkInAt && !state?.checkOutAt);
  const elapsed = useServerClock(state?.serverNow ?? null, state?.elapsedSeconds ?? 0, running);

  const handle = async (action: 'check-in' | 'check-out' | 'break/start' | 'break/end') => {
    if (action === 'check-out') {
      setCheckoutConfirmOpen(true);
      return;
    }
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
          : action === 'break/start'
            ? 'Break started.'
            : 'Break ended.',
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const confirmCheckout = async () => {
    setCheckoutConfirmOpen(false);
    try {
      await onAction('check-out');
      toast.success('Checked out. Working hours saved.');
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
          <p className="mt-0.5">
            {state?.sessions && state.sessions.length > 1 ? `Active Session #${state.sessionNumber ?? 1} · ` : ''}
            Check-in {state?.checkInAt ? formatTime(state.checkInAt) : '—'}
          </p>
          <p>Check-out {state?.checkOutAt ? formatTime(state.checkOutAt) : state?.canCheckOut ? 'In progress…' : '—'}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-400">
            {running ? `Session #${state?.sessionNumber ?? 1} active` : state?.totalMinutes ? 'Total worked today' : 'Not started'}
          </p>
          <p className="font-mono text-3xl font-semibold tabular-nums text-ink-900 sm:text-4xl">
            {loading && !state ? '--:--:--' : running ? secondsToClock(elapsed) : minutesToHours(state?.totalMinutes ?? 0)}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {state?.breakMinutes ? `Total breaks ${minutesToHours(state.breakMinutes)} · ` : ''}
            {state?.overtimeMinutes ? `Overtime ${minutesToHours(state.overtimeMinutes)} · ` : ''}
            Server-timestamped · continues after refresh
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {state?.canCheckIn && (
            <button
              type="button"
              className="btn-primary"
              disabled={pending === 'check-in' || locating}
              onClick={() => void handle('check-in')}
            >
              <Icon name="play" size={16} />{' '}
              {locating
                ? 'Locating…'
                : pending === 'check-in'
                  ? 'Checking in…'
                  : state?.sessions && state.sessions.length > 0
                    ? `CHECK IN (Session #${state.sessions.length + 1})`
                    : 'CHECK IN'}
            </button>
          )}
          {state?.canCheckOut && (
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
              <button
                type="button"
                className="btn-danger"
                disabled={pending === 'check-out'}
                onClick={() => setCheckoutConfirmOpen(true)}
              >
                <Icon name="check" size={16} /> CHECK OUT
              </button>
            </>
          )}
          {!state?.canCheckIn && !state?.canCheckOut && state?.checkOutAt && (
            <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
              Session completed · {minutesToHours(state.totalMinutes)}
            </span>
          )}
        </div>
      </div>

      {/* Today's Multi-Session Breakdown */}
      {state?.sessions && state.sessions.length > 0 && (
        <div className="mt-4 border-t border-ink-100 pt-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500 mb-2">
            Today&apos;s Sessions ({state.sessions.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {state.sessions.map((s) => (
              <div
                key={s.id}
                className={cx(
                  'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs',
                  s.isActive
                    ? 'border-emerald-300 bg-emerald-50/70 text-emerald-950 font-semibold shadow-xs'
                    : 'border-ink-200 bg-white text-ink-700',
                )}
              >
                <span className={cx(
                  'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white',
                  s.isActive ? 'bg-emerald-600 animate-pulse' : 'bg-ink-400',
                )}>
                  #{s.sessionNumber}
                </span>
                <span>
                  {s.checkInAt ? formatTime(s.checkInAt) : '—'}
                  {' → '}
                  {s.checkOutAt ? formatTime(s.checkOutAt) : s.isActive ? 'Active' : 'Closed'}
                </span>
                <span className="text-ink-400">·</span>
                <span className="font-mono">{minutesToHours(s.totalMinutes)}</span>
                {s.breakMinutes > 0 && (
                  <span className="text-ink-400 text-[10px]">({s.breakMinutes}m break)</span>
                )}
                {s.isActive && (
                  <span className="rounded-full bg-emerald-200 px-1.5 py-0.2 text-[9px] font-bold text-emerald-900">
                    LIVE
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Checkout Confirmation Modal */}
      {checkoutConfirmOpen && (
        <Modal
          open={checkoutConfirmOpen}
          onClose={() => setCheckoutConfirmOpen(false)}
          title="Confirm Check Out"
          description="Are you sure you want to check out? This will end your current working session."
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setCheckoutConfirmOpen(false)}>
                Cancel / Go Back
              </button>
              <button type="button" className="btn-danger" onClick={confirmCheckout} disabled={pending === 'check-out'}>
                {pending === 'check-out' ? 'Checking out…' : 'Confirm Check Out'}
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm text-ink-600">
            <p>
              Your current working session (<strong>Session #{state?.sessionNumber ?? 1}</strong>) will be closed and your working duration will be recorded to the database.
            </p>
            <div className="rounded-lg bg-amber-50 p-3 border border-amber-200 text-xs text-amber-900">
              <strong>Need to resume work later?</strong> You can check in again at any time today to start a new attendance session segment (e.g. Session #{(state?.sessionNumber ?? 1) + 1}).
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
