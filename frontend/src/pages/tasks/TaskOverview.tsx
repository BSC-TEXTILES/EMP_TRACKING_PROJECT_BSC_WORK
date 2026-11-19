import { Icon } from '../../components/icons';
import { cx } from '../../lib/format';
import { SLOTS, type TaskListSummary } from './taskConfig';

export type SummaryFilter = '' | 'assigned' | 'in_progress' | 'review' | 'completed' | 'overdue';

const SUMMARY_CARDS: {
  id: SummaryFilter;
  label: string;
  hint: string;
  icon: string;
  tone: string;
  iconTone: string;
  activeRing: string;
}[] = [
  {
    id: '',
    label: 'Total Tasks',
    hint: 'All scheduled store operations',
    icon: 'tasks',
    tone: 'text-brand-700 bg-brand-50/80 border-brand-100 dark:border-brand-900/30',
    iconTone: 'bg-brand-600 text-white shadow-sm shadow-brand-500/20',
    activeRing: 'border-brand-600 ring-2 ring-brand-500/20 bg-brand-50/30',
  },
  {
    id: 'assigned',
    label: 'Assigned & Ready',
    hint: 'Ready to accept or start',
    icon: 'inbox',
    tone: 'text-sky-700 bg-sky-50/80 border-sky-100 dark:border-sky-900/30',
    iconTone: 'bg-sky-600 text-white shadow-sm shadow-sky-500/20',
    activeRing: 'border-sky-600 ring-2 ring-sky-500/20 bg-sky-50/30',
  },
  {
    id: 'in_progress',
    label: 'In Progress',
    hint: 'Active store tasks being executed',
    icon: 'activity',
    tone: 'text-amber-700 bg-amber-50/80 border-amber-100 dark:border-amber-900/30',
    iconTone: 'bg-amber-600 text-white shadow-sm shadow-amber-500/20',
    activeRing: 'border-amber-600 ring-2 ring-amber-500/20 bg-amber-50/30',
  },
  {
    id: 'review',
    label: 'Under Review',
    hint: 'Submitted for manager sign-off',
    icon: 'eye',
    tone: 'text-indigo-700 bg-indigo-50/80 border-indigo-100 dark:border-indigo-900/30',
    iconTone: 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20',
    activeRing: 'border-indigo-600 ring-2 ring-indigo-500/20 bg-indigo-50/30',
  },
  {
    id: 'completed',
    label: 'Verified & Done',
    hint: 'Finished and manager-approved',
    icon: 'checkCircle',
    tone: 'text-emerald-700 bg-emerald-50/80 border-emerald-100 dark:border-emerald-900/30',
    iconTone: 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/20',
    activeRing: 'border-emerald-600 ring-2 ring-emerald-500/20 bg-emerald-50/30',
  },
  {
    id: 'overdue',
    label: 'Overdue Tasks',
    hint: 'Past shift deadline, requires focus',
    icon: 'alertTriangle',
    tone: 'text-rose-700 bg-rose-50/80 border-rose-100 dark:border-rose-900/30',
    iconTone: 'bg-rose-600 text-white shadow-sm shadow-rose-500/20',
    activeRing: 'border-rose-600 ring-2 ring-rose-500/20 bg-rose-50/30',
  },
];

/** Live database metric cards with interactive filter toggles. */
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
  const getCount = (id: SummaryFilter): number | null => {
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
      {SUMMARY_CARDS.map((card) => {
        const count = getCount(card.id);
        const selected = active === card.id;
        const isOverdue = card.id === 'overdue' && Boolean(count && count > 0);

        return (
          <button
            key={card.label}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(selected && card.id !== '' ? '' : card.id)}
            className={cx(
              'group relative flex min-w-0 flex-col justify-between rounded-xl border bg-surface p-4 text-left transition-all duration-200',
              'hover:-translate-y-0.5 hover:shadow-md hover:border-brand-400',
              selected
                ? card.activeRing
                : isOverdue
                  ? 'border-rose-300 shadow-sm shadow-rose-500/5'
                  : 'border-ink-200/90 shadow-sm',
            )}
          >
            {/* Top row: Icon & Status indicator */}
            <div className="flex items-center justify-between gap-2">
              <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:scale-105', card.iconTone)}>
                <Icon name={card.icon} size={18} strokeWidth={2.2} />
              </span>
              {selected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                  Active
                </span>
              )}
            </div>

            {/* Middle: Big Metric Number */}
            <div className="mt-3 min-w-0">
              <span className="block truncate text-[11px] font-bold uppercase tracking-wider text-ink-500">
                {card.label}
              </span>
              <span
                className={cx(
                  'mt-0.5 block text-2xl font-black tabular-nums tracking-tight sm:text-3xl',
                  isOverdue ? 'text-rose-600' : 'text-ink-900',
                )}
              >
                {count === null ? (
                  loading ? (
                    <span className="inline-block h-7 w-12 animate-pulse rounded bg-ink-200" />
                  ) : (
                    '—'
                  )
                ) : (
                  count.toLocaleString()
                )}
              </span>
              <span className="mt-1 block truncate text-[11px] font-medium text-ink-400">
                {card.hint}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Daily Store SOP Operational Pipeline cards */
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
        const isComplete = percent === 100 && stats.total > 0;

        return (
          <button
            key={slot.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(selected ? '' : slot.id)}
            className={cx(
              'group relative flex min-w-0 flex-col justify-between rounded-xl border bg-surface p-4 text-left transition-all duration-200',
              'hover:-translate-y-0.5 hover:shadow-md hover:border-brand-400',
              selected
                ? 'border-brand-600 ring-2 ring-brand-500/20 bg-brand-50/20 shadow-md'
                : 'border-ink-200/90 shadow-sm',
            )}
          >
            {/* Top row: Icon, Title, and Hours */}
            <div className="flex items-start gap-3">
              <span
                className={cx(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors',
                  selected
                    ? 'bg-brand-700 text-white shadow-sm'
                    : isComplete
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400'
                      : 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300',
                )}
              >
                <Icon name={slot.icon} size={19} strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-sm font-bold text-ink-900 group-hover:text-brand-700">
                    {slot.label}
                  </span>
                  <span
                    className={cx(
                      'shrink-0 text-sm font-bold tabular-nums',
                      isComplete ? 'text-emerald-600' : 'text-brand-700',
                    )}
                  >
                    {percent}%
                  </span>
                </div>
                <span className="inline-block rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                  {slot.hours}
                </span>
              </div>
            </div>

            {/* Description */}
            <p className="mt-2.5 line-clamp-1 text-xs text-ink-500" title={slot.desc}>
              {slot.desc}
            </p>

            {/* Progress bar and task stats */}
            <div className="mt-3 w-full border-t border-ink-100 pt-2.5 dark:border-ink-800/80">
              <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
                <div
                  className={cx(
                    'h-full rounded-full transition-all duration-300',
                    isComplete ? 'bg-emerald-500' : 'bg-brand-600',
                  )}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs font-medium">
                <span className="text-ink-600">
                  <strong className="font-bold text-ink-900 tabular-nums">{stats.done}</strong>
                  <span className="text-ink-400"> / </span>
                  <span className="tabular-nums">{stats.total}</span> completed
                </span>
                <span
                  className={cx(
                    'text-[11px] font-bold uppercase tracking-wide',
                    selected ? 'text-brand-700 underline' : 'text-ink-400 group-hover:text-brand-700',
                  )}
                >
                  {selected ? 'Filtering' : 'View shift'}
                </span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
