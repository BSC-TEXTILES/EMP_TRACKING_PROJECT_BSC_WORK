import { Icon } from '../../components/icons';
import { cx } from '../../lib/format';
import { SLOTS, type TaskListSummary } from './taskConfig';

export type SummaryFilter = '' | 'assigned' | 'in_progress' | 'review' | 'completed' | 'overdue';

const CARDS: { id: SummaryFilter; label: string; hint: string; icon: string; tone: string }[] = [
  { id: '', label: 'Total tasks', hint: 'All tasks in this view', icon: 'tasks', tone: 'bg-brand-50 text-brand-700' },
  { id: 'assigned', label: 'Assigned', hint: 'Ready to accept or start', icon: 'inbox', tone: 'bg-sky-50 text-sky-700' },
  { id: 'in_progress', label: 'In progress', hint: 'Being worked on now', icon: 'activity', tone: 'bg-amber-50 text-amber-700' },
  { id: 'review', label: 'Under review', hint: 'Awaiting verification', icon: 'eye', tone: 'bg-indigo-50 text-indigo-700' },
  { id: 'completed', label: 'Verified & completed', hint: 'Approved by a manager', icon: 'checkCircle', tone: 'bg-emerald-50 text-emerald-700' },
  { id: 'overdue', label: 'Overdue', hint: 'Past due, not finished', icon: 'alertTriangle', tone: 'bg-rose-50 text-rose-700' },
];

/** Live counts from the database for the current view, store, search and priority (status filters excluded). */
export function SummaryCards({
  summary,
  active,
  loading,
  onSelect,
}: {
  summary?: TaskListSummary;
  active: SummaryFilter;
  loading: boolean;
  onSelect: (id: SummaryFilter) => void;
}) {
  const value = (id: SummaryFilter): number | null => {
    if (!summary) return null;
    switch (id) {
      case '':
        return summary.total;
      case 'assigned':
        return summary.stages.assigned;
      case 'in_progress':
        return summary.stages.in_progress;
      case 'review':
        return summary.stages.review;
      case 'completed':
        return summary.completed;
      case 'overdue':
        return summary.overdue;
    }
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {CARDS.map((card) => {
        const count = value(card.id);
        const selected = active === card.id;
        return (
          <button
            key={card.label}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(selected && card.id !== '' ? '' : card.id)}
            className={cx(
              'card flex min-w-0 items-start gap-3 p-3.5 text-left transition hover:border-brand-300 hover:shadow-md sm:p-4',
              selected && 'border-brand-500 ring-2 ring-brand-500/15',
            )}
          >
            <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', card.tone)}>
              <Icon name={card.icon} size={18} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-ink-500">{card.label}</span>
              <span className={cx('mt-0.5 block text-2xl font-semibold tabular-nums leading-tight', card.id === 'overdue' && count ? 'text-rose-600' : 'text-ink-900')}>
                {count === null ? (loading ? <span className="inline-block h-6 w-8 animate-pulse rounded bg-ink-100" /> : '—') : count}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-ink-400">{card.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SlotCards({
  slots,
  active,
  onSelect,
}: {
  slots?: Record<string, { total: number; done: number }>;
  active: string;
  onSelect: (slot: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {SLOTS.map((slot) => {
        const stats = slots?.[slot.id] ?? { total: 0, done: 0 };
        const percent = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
        const selected = active === slot.id;
        return (
          <button
            key={slot.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(selected ? '' : slot.id)}
            className={cx(
              'card flex min-w-0 flex-col gap-3 p-4 text-left transition hover:border-brand-300 hover:shadow-md',
              selected && 'border-brand-500 ring-2 ring-brand-500/15',
            )}
          >
            <div className="flex w-full items-start gap-3">
              <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', selected ? 'bg-brand-700 text-white' : 'bg-brand-50 text-brand-700')}>
                <Icon name={slot.icon} size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink-900">{slot.label}</span>
                <span className="block text-xs text-ink-500">{slot.hours}</span>
              </span>
              <span className={cx('shrink-0 text-lg font-semibold tabular-nums', percent === 100 ? 'text-emerald-600' : 'text-ink-900')}>{percent}%</span>
            </div>
            <div className="w-full">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                <div className={cx('h-full rounded-full transition-all', percent === 100 ? 'bg-emerald-500' : 'bg-brand-600')} style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 flex justify-between text-xs text-ink-500">
                <span>
                  <strong className="font-semibold text-ink-800 tabular-nums">{stats.done}</strong> of <span className="tabular-nums">{stats.total}</span> completed
                </span>
                <span className="text-brand-700">{selected ? 'Showing' : 'View tasks'}</span>
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
