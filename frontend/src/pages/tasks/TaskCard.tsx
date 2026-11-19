import { Icon } from '../../components/icons';
import { PriorityBadge, StatusBadge } from '../../components/ui';
import { cx } from '../../lib/format';
import type { TaskSummary } from '../../lib/types';
import { displayName, dueLabel, nextAction, slotLabel, type QuickAction, type TaskRole } from './taskConfig';

export function QuickActionButton({ quick, busy, onClick, compact }: { quick: QuickAction; busy: boolean; onClick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold text-white shadow-sm transition-colors disabled:opacity-50',
        quick.tone === 'success' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-brand-700 hover:bg-brand-800',
        compact && 'h-7 px-2.5',
      )}
    >
      <Icon name={quick.icon} size={13} strokeWidth={2.2} />
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

  return (
    <article
      className={cx(
        'group rounded-lg border bg-surface p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:border-brand-300 hover:shadow-md',
        task.isOverdue ? 'border-rose-200' : 'border-ink-200',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold tracking-tight text-ink-500">{task.taskNo}</span>
        <div className="flex items-center gap-1">
          {!['assigned', 'accepted', 'in_progress', 'pending_approval', 'completed'].includes(task.status) && <StatusBadge status={task.status} />}
          <PriorityBadge priority={task.priority} />
        </div>
      </div>

      <button type="button" onClick={onOpen} className="mt-1.5 block w-full text-left">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-ink-900 group-hover:text-brand-700" title={task.title}>
          {task.title}
        </h3>
      </button>

      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-ink-500">
        {category && <span className="truncate capitalize">{category}</span>}
        {category && task.locationCodes && <span aria-hidden="true" className="text-ink-300">•</span>}
        {task.locationCodes && (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-ink-600">
            <Icon name="building" size={12} className="text-ink-400" />
            {task.locationCodes}
          </span>
        )}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-ink-700" title={displayName(task.assigneeNames)}>
          <Icon name="user" size={13} className="shrink-0 text-ink-400" />
          <span className="truncate font-medium">{displayName(task.assigneeNames)}</span>
        </span>
        {due && (
          <span className={cx('flex shrink-0 items-center gap-1 font-medium', task.isOverdue ? 'text-rose-600' : 'text-ink-500')}>
            <Icon name="clock" size={12} />
            {due}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100" role="progressbar" aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={cx('h-full rounded-full transition-all', done || task.progress === 100 ? 'bg-emerald-500' : 'bg-brand-600')} style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
        </div>
        <span className="w-8 text-right text-[11px] font-semibold tabular-nums text-ink-500">{task.progress}%</span>
      </div>

      {(task.requiresEvidence || task.requiresMetric || task.isOverdue) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px] font-medium">
          {task.requiresEvidence && (
            <span className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5', task.evidenceFileId ? 'bg-emerald-50 text-emerald-700' : 'bg-brand-50 text-brand-700')}>
              <Icon name="camera" size={11} />
              {task.evidenceFileId ? 'Proof attached' : 'Proof required'}
            </span>
          )}
          {task.requiresMetric && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
              <Icon name="chart" size={11} />
              {task.metricLabel ?? 'Metric'}
            </span>
          )}
          {task.isOverdue && (
            <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">
              <Icon name="alertTriangle" size={11} />
              Overdue
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-ink-100 pt-3">
        {quick && <QuickActionButton quick={quick} busy={busy} onClick={() => onQuick(quick)} compact />}
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
        >
          View details
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
    </article>
  );
}
