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
    <th className={cx('whitespace-nowrap py-3 px-3.5 text-left text-xs font-bold uppercase tracking-wider text-slate-900', className)} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cx(
          'inline-flex items-center gap-1.5 font-bold text-slate-900 hover:text-brand-700 transition-colors',
          active && 'text-brand-700 font-extrabold',
        )}
      >
        {label}
        <Icon
          name={active && dir === 'desc' ? 'chevronDown' : 'chevronUp'}
          size={13}
          className={active ? 'text-brand-700' : 'text-slate-500'}
        />
      </button>
    </th>
  );
}

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
  onEdit,
  onDelete,
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
  onEdit?: (task: TaskSummary) => void;
  onDelete?: (task: TaskSummary) => void;
}) {
  const headerProps = { sort, dir, onSort };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[960px] text-left border-collapse">
        <thead className="border-b border-slate-300 bg-slate-100">
          <tr>
            <SortHeader label="Task ID & Title" column="title" {...headerProps} />
            <SortHeader label="SOP Slot" column="slot" {...headerProps} />
            <th className="py-3 px-3.5 text-xs font-bold uppercase tracking-wider text-slate-900">Assigned To</th>
            <th className="py-3 px-3.5 text-xs font-bold uppercase tracking-wider text-slate-900">Store</th>
            <SortHeader label="Priority" column="priority" {...headerProps} />
            <SortHeader label="Status" column="status" {...headerProps} />
            <SortHeader label="Due Date" column="due" {...headerProps} />
            <SortHeader label="Progress" column="progress" className="w-36" {...headerProps} />
            <th className="py-3 px-3.5 text-right text-xs font-bold uppercase tracking-wider text-slate-900">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {items.map((task) => {
            const quick = nextAction(task, taskRole(task, userId, canApprove));
            const assignee = displayName(task.assigneeNames);
            const due = dueLabel(task);

            return (
              <tr
                key={task.id}
                className="group cursor-pointer transition-colors bg-white hover:bg-blue-50/70"
                onClick={() => onOpen(task)}
              >
                {/* Title & Task No */}
                <td className="py-3.5 px-3.5 max-w-[340px]">
                  <p className="text-sm font-bold text-slate-900 group-hover:text-brand-700 transition-colors break-words" title={task.title}>
                    {task.title}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                    <span className="font-mono text-[11px] font-bold text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-300">
                      {task.taskNo}
                    </span>
                    {task.requiresEvidence && (
                      <span className={cx('inline-flex items-center gap-1 font-semibold text-[10px] rounded px-1.5 py-0.2', task.evidenceFileId ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-brand-50 text-brand-700 border border-brand-200')}>
                        <Icon name="camera" size={10} />
                        {task.evidenceFileId ? 'Proof attached' : 'Proof required'}
                      </span>
                    )}
                    {task.requiresMetric && (
                      <span className="inline-flex items-center gap-1 font-semibold text-[10px] rounded bg-amber-50 px-1.5 py-0.2 text-amber-800 border border-amber-200">
                        <Icon name="chart" size={10} />
                        {task.metricLabel ?? 'Metric'}
                      </span>
                    )}
                  </p>
                </td>

                {/* SOP Slot */}
                <td className="py-3.5 px-3.5 whitespace-nowrap text-xs font-bold text-slate-800">
                  {slotLabel(task.timeSlot) ?? '—'}
                </td>

                {/* Assignee */}
                <td className="py-3.5 px-3.5 max-w-[180px]">
                  <div className="flex items-center gap-1.5 truncate text-xs font-semibold text-slate-800" title={assignee}>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] text-slate-700">
                      <Icon name="user" size={11} />
                    </span>
                    <span className="truncate">{assignee}</span>
                  </div>
                </td>

                {/* Store Location */}
                <td className="py-3.5 px-3.5 whitespace-nowrap">
                  {task.locationCodes ? (
                    <span
                      className={cx(
                        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 text-xs font-extrabold border shadow-2xs',
                        task.locationCodes.includes('BEL')
                          ? 'bg-blue-50 text-blue-900 border-blue-300'
                          : task.locationCodes.includes('DAV')
                            ? 'bg-purple-50 text-purple-900 border-purple-300'
                            : task.locationCodes.includes('SHI')
                              ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                              : 'bg-slate-100 text-slate-800 border-slate-300',
                      )}
                    >
                      <Icon name="building" size={11} />
                      {task.locationCodes}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>

                {/* Priority */}
                <td className="py-3.5 px-3.5 whitespace-nowrap">
                  <PriorityBadge priority={task.priority} />
                </td>

                {/* Status */}
                <td className="py-3.5 px-3.5 whitespace-nowrap">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={task.status} />
                    {task.isOverdue && task.status !== 'overdue' && (
                      <span className="badge bg-rose-100 text-rose-700 border border-rose-200">
                        Overdue
                      </span>
                    )}
                  </div>
                </td>

                {/* Due Date & Time */}
                <td className={cx('py-3.5 px-3.5 whitespace-nowrap text-xs font-bold', task.isOverdue ? 'text-rose-600' : 'text-slate-800')}>
                  {due ?? '—'}
                </td>

                {/* Progress */}
                <td className="py-3.5 px-3.5 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={cx(
                          'h-full rounded-full transition-all duration-300',
                          task.progress === 100 ? 'bg-emerald-600' : 'bg-brand-600',
                        )}
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-xs font-bold tabular-nums text-slate-800">
                      {task.progress}%
                    </span>
                  </div>
                </td>

                {/* Action Buttons */}
                <td className="py-3.5 px-3.5 whitespace-nowrap text-right" onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1.5">
                    {quick && (
                      <QuickActionButton quick={quick} busy={busy} onClick={() => onQuick(task, quick)} compact />
                    )}
                    {onEdit && (
                      <button
                        type="button"
                        onClick={() => onEdit(task)}
                        title="Edit Task"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-brand-50 hover:text-brand-700 transition-colors"
                      >
                        <Icon name="edit" size={13} />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => onDelete(task)}
                        title="Delete Task"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpen(task)}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 hover:text-slate-900 transition-colors border border-slate-200"
                    >
                      Details
                      <Icon name="chevronRight" size={13} />
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
