import { useState } from 'react';
import { Icon } from '../../components/icons';
import { cx } from '../../lib/format';
import type { TaskSummary } from '../../lib/types';
import { TaskCard } from './TaskCard';
import { STAGES, taskRole, type QuickAction, type StageId, type TaskListSummary } from './taskConfig';

export function TaskBoard({
  items,
  summary,
  filteredTotal,
  statusFilter,
  stageFilter,
  userId,
  canApprove,
  busy,
  onOpen,
  onQuick,
  onEdit,
  onDelete,
}: {
  items: TaskSummary[];
  summary?: TaskListSummary;
  filteredTotal: number;
  statusFilter: string;
  stageFilter: string;
  userId?: number;
  canApprove: boolean;
  busy: boolean;
  onOpen: (task: TaskSummary) => void;
  onQuick: (task: TaskSummary, quick: QuickAction) => void;
  onEdit?: (task: TaskSummary) => void;
  onDelete?: (task: TaskSummary) => void;
}) {
  const [mobileStage, setMobileStage] = useState<StageId>('assigned');

  // Column totals come from the database for accuracy across pagination
  const columnTotal = (id: StageId, statuses: string[]) => {
    if (statusFilter) return statuses.includes(statusFilter) ? filteredTotal : 0;
    if (stageFilter === 'completed') return id === 'done' ? filteredTotal : 0;
    if (stageFilter) return stageFilter === id ? filteredTotal : 0;
    return summary?.stages[id] ?? items.filter((task) => statuses.includes(task.status)).length;
  };

  const columns = STAGES.map((stage) => ({
    ...stage,
    items: items.filter((task) => stage.statuses.includes(task.status)),
    total: columnTotal(stage.id, stage.statuses),
  }));

  return (
    <div>
      {/* Mobile Stage Selector */}
      <div className="mb-4 grid grid-cols-4 gap-1.5 rounded-xl bg-ink-100 p-1.5 md:hidden" role="tablist" aria-label="Workflow stage">
        {columns.map((col) => (
          <button
            key={col.id}
            type="button"
            role="tab"
            aria-selected={mobileStage === col.id}
            onClick={() => setMobileStage(col.id)}
            className={cx(
              'flex min-w-0 flex-col items-center rounded-lg px-1.5 py-2 text-xs font-bold leading-tight transition-all',
              mobileStage === col.id
                ? 'bg-surface text-ink-900 shadow-sm'
                : 'text-ink-500 hover:text-ink-800',
            )}
          >
            <span className="truncate">{col.title.split(' ')[0]}</span>
            <span className="mt-0.5 rounded-full bg-ink-200 px-1.5 text-[10px] tabular-nums font-extrabold text-ink-700">
              {col.total}
            </span>
          </button>
        ))}
      </div>

      {/* 4 Equal-width Workflow Columns */}
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((col) => (
          <section
            key={col.id}
            aria-label={col.title}
            className={cx(
              'min-w-0 rounded-2xl border border-slate-200/80 bg-slate-50/80 p-3.5 transition-colors',
              mobileStage === col.id ? 'block' : 'hidden md:block',
            )}
          >
            {/* Column Header */}
            <header className="mb-3.5 px-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', col.dot)} aria-hidden="true" />
                  <h2 className="text-sm font-bold text-slate-900 break-words">{col.title}</h2>
                </div>
                <span
                  className={cx(
                    'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums border shadow-xs',
                    col.accent,
                  )}
                >
                  {col.total}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 leading-normal break-words">{col.description}</p>
              {col.total > col.items.length && col.items.length > 0 && (
                <p className="mt-1 text-[11px] font-medium text-brand-700">
                  Showing {col.items.length} of {col.total} tasks
                </p>
              )}
            </header>

            {/* Task Cards List */}
            {col.items.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200/90 bg-white/70 py-8 px-4 text-center">
                <Icon name="checkCircle" size={18} className="text-slate-300 mb-1.5" />
                <p className="text-xs font-medium text-slate-500">
                  {col.total > 0 ? 'Tasks available on other pages' : 'No tasks in this stage'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {col.items.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    role={taskRole(task, userId, canApprove)}
                    busy={busy}
                    onOpen={() => onOpen(task)}
                    onQuick={(quick) => onQuick(task, quick)}
                    onEdit={onEdit ? () => onEdit(task) : undefined}
                    onDelete={onDelete ? () => onDelete(task) : undefined}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
