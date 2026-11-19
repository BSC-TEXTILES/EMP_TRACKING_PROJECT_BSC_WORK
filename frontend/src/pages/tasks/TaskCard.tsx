import { Icon } from '../../components/icons';
import { PriorityBadge, StatusBadge } from '../../components/ui';
import { cx } from '../../lib/format';
import type { TaskSummary } from '../../lib/types';
import { displayName, dueLabel, nextAction, slotLabel, type QuickAction, type TaskRole } from './taskConfig';

export function QuickActionButton({
  quick,
  busy,
  onClick,
  compact,
}: {
  quick: QuickAction;
  busy: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold text-white shadow-sm transition-all duration-150 disabled:opacity-50 active:scale-[0.98]',
        quick.tone === 'success'
          ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20'
          : 'bg-brand-700 hover:bg-brand-800 shadow-brand-500/20',
        compact ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-xs',
      )}
    >
      <Icon name={quick.icon} size={13} strokeWidth={2.4} />
      {quick.label}
    </button>
  );
}

export function TaskCard({
  task,
  role,
  busy,
  onOpen,
  onQuick,
}: {
  task: TaskSummary;
  role: TaskRole;
  busy: boolean;
  onOpen: () => void;
  onQuick: (quick: QuickAction) => void;
}) {
  const quick = nextAction(task, role);
  const category = task.category ? task.category.replace(/_/g, ' ') : slotLabel(task.timeSlot);
  const due = dueLabel(task);
  const done = ['completed', 'verified'].includes(task.status);
  const assignee = displayName(task.assigneeNames);

  return (
    <article
      onClick={onOpen}
      className={cx(
        'group relative flex flex-col justify-between rounded-xl border bg-surface p-3.5 shadow-sm transition-all duration-200 cursor-pointer',
        'hover:-translate-y-0.5 hover:shadow-md hover:border-brand-400',
        task.isOverdue
          ? 'border-rose-300 dark:border-rose-900/50 bg-rose-50/10'
          : 'border-ink-200/90 dark:border-ink-800',
      )}
    >
      <div>
        {/* Top Header: Task ID, Location, Priority */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="shrink-0 font-mono text-[11px] font-bold tracking-tight text-ink-600 bg-ink-100 dark:bg-ink-800 px-2 py-0.5 rounded-md border border-ink-200 dark:border-ink-700">
              {task.taskNo}
            </span>
            {task.locationCodes && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-700 border border-brand-200/60 dark:bg-brand-950/40 dark:text-brand-300">
                <Icon name="building" size={10} />
                {task.locationCodes}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!['assigned', 'accepted', 'in_progress', 'pending_approval', 'completed'].includes(task.status) && (
              <StatusBadge status={task.status} />
            )}
            <PriorityBadge priority={task.priority} />
          </div>
        </div>

        {/* Task Title */}
        <h3
          className="mt-2.5 line-clamp-2 text-sm font-bold leading-snug text-ink-900 group-hover:text-brand-700 transition-colors"
          title={task.title}
        >
          {task.title}
        </h3>

        {/* Category & Slot info */}
        {category && (
          <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-ink-500">
            <span className="truncate capitalize">{category}</span>
          </p>
        )}

        {/* Assignee & Due Date Row */}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-ink-100 pt-2.5 text-xs dark:border-ink-800/60">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink-700" title={assignee}>
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[10px] font-bold text-ink-600 dark:bg-ink-800">
              <Icon name="user" size={11} className="text-ink-500" />
            </span>
            <span className="truncate">{assignee}</span>
          </span>

          {due && (
            <span
              className={cx(
                'inline-flex shrink-0 items-center gap-1 font-semibold text-[11px]',
                task.isOverdue ? 'text-rose-600' : 'text-ink-500',
              )}
            >
              <Icon name="clock" size={12} />
              {due}
            </span>
          )}
        </div>

        {/* Progress Bar */}
        <div className="mt-2.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div
              className={cx(
                'h-full rounded-full transition-all duration-300',
                done || task.progress === 100 ? 'bg-emerald-500' : 'bg-brand-600',
              )}
              style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
            />
          </div>
          <span className="w-8 text-right text-[11px] font-bold tabular-nums text-ink-500">
            {task.progress}%
          </span>
        </div>

        {/* Requirement Badges (Proof, Metrics, Overdue) */}
        {(task.requiresEvidence || task.requiresMetric || task.isOverdue) && (
          <div className="mt-2.5 flex flex-wrap gap-1.5 text-[10px] font-semibold">
            {task.requiresEvidence && (
              <span
                className={cx(
                  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 border',
                  task.evidenceFileId
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                    : 'bg-brand-50 text-brand-700 border-brand-200 dark:bg-brand-950/40 dark:text-brand-300 dark:border-brand-800',
                )}
              >
                <Icon name="camera" size={11} />
                {task.evidenceFileId ? 'Proof attached' : 'Proof required'}
              </span>
            )}
            {task.requiresMetric && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800">
                <Icon name="chart" size={11} />
                {task.metricLabel ?? 'Metric'}
              </span>
            )}
            {task.isOverdue && (
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800">
                <Icon name="alertTriangle" size={11} />
                Overdue
              </span>
            )}
          </div>
        )}
      </div>

      {/* Card Actions Footer */}
      <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-ink-100 pt-3 dark:border-ink-800/80">
        <div>
          {quick ? (
            <QuickActionButton quick={quick} busy={busy} onClick={() => onQuick(quick)} compact />
          ) : (
            <span className="text-[11px] font-medium text-ink-400 capitalize">
              {task.status.replace(/_/g, ' ')}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-ink-600 hover:bg-ink-100 hover:text-ink-900 transition-colors"
        >
          Details
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
    </article>
  );
}
