import { Icon } from '../../components/icons';
import { PriorityBadge, StatusBadge } from '../../components/ui';
import { cx } from '../../lib/format';
import type { TaskSummary } from '../../lib/types';
import { QuickActionButton } from './TaskCard';
import { displayName, dueLabel, nextAction, slotLabel, taskRole, type QuickAction } from './taskConfig';

export type SortKey = 'task' | 'title' | 'slot' | 'priority' | 'status' | 'due' | 'progress';

function SortHeader({
  label,
  column,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (column: SortKey) => void;
  className?: string;
}) {
  const active = sort === column;
  return (
    <th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(column)} className={cx('inline-flex items-center gap-1 hover:text-ink-900', active && 'text-ink-900')}>
        {label}
        <Icon name={active && dir === 'desc' ? 'chevronDown' : 'chevronUp'} size={12} className={active ? 'text-brand-600' : 'text-ink-300'} />
      </button>
    </th>
  );
}

/** Sorting is done by the server so it applies to every page, not just the visible rows. */
export function TaskTable({
  items,
  sort,
  dir,
  onSort,
  userId,
  canApprove,
  busy,
  onOpen,
  onQuick,
}: {
  items: TaskSummary[];
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (column: SortKey) => void;
  userId?: number;
  canApprove: boolean;
  busy: boolean;
  onOpen: (task: TaskSummary) => void;
  onQuick: (task: TaskSummary, quick: QuickAction) => void;
}) {
  const headerProps = { sort, dir, onSort };
  return (
    <div className="overflow-x-auto">
      <table className="table-base min-w-[960px]">
        <thead>
          <tr>
            <SortHeader label="Task" column="title" {...headerProps} />
            <SortHeader label="SOP slot" column="slot" {...headerProps} />
            <th>Assigned to</th>
            <th>Store</th>
            <SortHeader label="Priority" column="priority" {...headerProps} />
            <SortHeader label="Status" column="status" {...headerProps} />
            <SortHeader label="Due" column="due" {...headerProps} />
            <SortHeader label="Progress" column="progress" className="w-32" {...headerProps} />
            <th className="text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((task) => {
            const quick = nextAction(task, taskRole(task, userId, canApprove));
            return (
              <tr key={task.id} className="cursor-pointer hover:bg-ink-50" onClick={() => onOpen(task)}>
                <td className="max-w-[320px]">
                  <p className="truncate font-medium text-ink-900" title={task.title}>{task.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
                    <span className="font-mono">{task.taskNo}</span>
                    {task.requiresEvidence && (
                      <span className="inline-flex items-center gap-0.5 text-brand-700">
                        <Icon name="camera" size={11} /> {task.evidenceFileId ? 'Proof attached' : 'Proof required'}
                      </span>
                    )}
                    {task.requiresMetric && <span className="text-amber-700">{task.metricLabel ?? 'Metric'}</span>}
                  </p>
                </td>
                <td className="whitespace-nowrap text-ink-600">{slotLabel(task.timeSlot) ?? '—'}</td>
                <td className="max-w-[180px] truncate text-ink-700" title={displayName(task.assigneeNames)}>{displayName(task.assigneeNames)}</td>
                <td className="whitespace-nowrap text-ink-600">{task.locationCodes ?? '—'}</td>
                <td><PriorityBadge priority={task.priority} /></td>
                <td>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={task.status} />
                    {task.isOverdue && task.status !== 'overdue' && <span className="badge bg-rose-100 text-rose-700">Overdue</span>}
                  </div>
                </td>
                <td className={cx('whitespace-nowrap text-xs', task.isOverdue ? 'font-semibold text-rose-600' : 'text-ink-600')}>{dueLabel(task) ?? '—'}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                      <div className={cx('h-full rounded-full', task.progress === 100 ? 'bg-emerald-500' : 'bg-brand-600')} style={{ width: `${task.progress}%` }} />
                    </div>
                    <span className="w-8 text-right text-xs tabular-nums text-ink-500">{task.progress}%</span>
                  </div>
                </td>
                <td className="whitespace-nowrap text-right" onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1.5">
                    {quick && <QuickActionButton quick={quick} busy={busy} onClick={() => onQuick(task, quick)} compact />}
                    <button type="button" onClick={() => onOpen(task)} className="h-7 rounded-md px-2.5 text-xs font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900">
                      Details
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
