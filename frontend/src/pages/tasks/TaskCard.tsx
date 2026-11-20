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
  onEdit,
  onDelete,
}: {
  task: TaskSummary;
  role: TaskRole;
  busy: boolean;
  onOpen: () => void;
  onQuick: (quick: QuickAction) => void;
  onEdit?: () => void;
  onDelete?: () => void;
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
        'group relative flex flex-col justify-between rounded-xl border bg-white p-3.5 shadow-sm transition-all duration-200 cursor-pointer',
        'hover:-translate-y-0.5 hover:shadow-md hover:border-brand-400',
        task.isOverdue
          ? 'border-rose-300 bg-rose-50/20'
          : 'border-slate-200',
      )}
    >
      <div>
        {/* Top Header: Task ID, Location, Status, Priority - flex-wrap ensures no text is clipped or overlapping */}
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] font-bold tracking-tight text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200/90 shrink-0">
              {task.taskNo}
            </span>
            {task.locationCodes && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 border border-blue-200/80">
                <Icon name="building" size={10} />
                {task.locationCodes}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1 shrink-0">
            {!['assigned', 'accepted', 'in_progress', 'pending_approval', 'completed'].includes(task.status) && (
              <StatusBadge status={task.status} />
            )}
            <PriorityBadge priority={task.priority} />
          </div>
        </div>

        {/* Task Title - break-words and no truncation so full text is clearly visible and divides cleanly */}
        <h3
          className="mt-2.5 text-sm font-bold leading-snug text-slate-900 group-hover:text-brand-700 transition-colors break-words"
          title={task.title}
        >
          {task.title}
        </h3>

        {/* Category & Slot info */}
        {category && (
          <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-slate-500">
            <span className="capitalize break-words">{category}</span>
          </p>
        )}

        {/* Assignee & Due Date Row */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-slate-700" title={assignee}>
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-600">
              <Icon name="user" size={11} className="text-slate-500" />
            </span>
            <span className="truncate max-w-[140px]">{assignee}</span>
          </span>

          {due && (
            <span
              className={cx(
                'inline-flex shrink-0 items-center gap-1 font-semibold text-[11px]',
                task.isOverdue ? 'text-rose-600' : 'text-slate-500',
              )}
            >
              <Icon name="clock" size={12} />
              {due}
            </span>
          )}
        </div>

        {/* Progress Bar */}
        <div className="mt-2.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cx(
                'h-full rounded-full transition-all duration-300',
                done || task.progress === 100 ? 'bg-emerald-500' : 'bg-brand-600',
              )}
              style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
            />
          </div>
          <span className="w-8 text-right text-[11px] font-bold tabular-nums text-slate-500">
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
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-blue-50 text-blue-700 border-blue-200',
                )}
              >
                <Icon name="camera" size={11} />
                {task.evidenceFileId ? 'Proof attached' : 'Proof required'}
              </span>
            )}
            {task.requiresMetric && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-amber-800 border border-amber-200">
                <Icon name="chart" size={11} />
                {task.metricLabel ?? 'Metric'}
              </span>
            )}
            {task.isOverdue && (
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-rose-700 border border-rose-200">
                <Icon name="alertTriangle" size={11} />
                Overdue
              </span>
            )}
          </div>
        )}
      </div>

      {/* Card Actions Footer */}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <div className="shrink-0">
          {quick ? (
            <QuickActionButton quick={quick} busy={busy} onClick={() => onQuick(quick)} compact />
          ) : (
            <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 capitalize">
              {task.status.replace(/_/g, ' ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onEdit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              title="Edit Task"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-brand-50 hover:text-brand-700 transition-colors"
            >
              <Icon name="edit" size={13} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="Delete Task"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-600 transition-colors"
            >
              <Icon name="trash" size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 hover:text-slate-900 transition-colors"
          >
            Details
            <Icon name="chevronRight" size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}
