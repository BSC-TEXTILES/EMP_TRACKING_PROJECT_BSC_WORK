import { useState } from 'react';
import { cx } from '../../lib/format';
import type { TaskSummary } from '../../lib/types';
import { TaskCard } from './TaskCard';
import { STAGES, taskRole, type QuickAction, type StageId, type TaskListSummary } from './taskConfig';

/**
 * Four equal workflow columns. Columns grow with their content (no inner scrollbars); on phones a stage
 * switcher shows one column at a time so nothing overflows horizontally.
 */
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
}) {
  const [mobileStage, setMobileStage] = useState<StageId>('assigned');

  // Column totals come from the database, not from the loaded page.
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
      {/* Phone: pick a stage */}
      <div className="mb-3 grid grid-cols-4 gap-1 rounded-lg bg-ink-100 p-1 md:hidden" role="tablist" aria-label="Workflow stage">
        {columns.map((col) => (
          <button
            key={col.id}
            type="button"
            role="tab"
            aria-selected={mobileStage === col.id}
            onClick={() => setMobileStage(col.id)}
            className={cx(
              'flex min-w-0 flex-col items-center rounded-md px-1 py-1.5 text-[11px] font-semibold leading-tight transition',
              mobileStage === col.id ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500',
            )}
          >
            <span className="truncate">{col.title.split(' ')[0]}</span>
            <span className="tabular-nums text-ink-400">{col.total}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 min-[1400px]:grid-cols-4">
        {columns.map((col) => (
          <section
            key={col.id}
            aria-label={col.title}
            className={cx('min-w-0 rounded-xl border border-ink-200 bg-ink-50 p-3', mobileStage === col.id ? 'block' : 'hidden md:block')}
          >
            <header className="mb-3 px-0.5">
              <div className="flex items-center gap-2">
                <span className={cx('h-2 w-2 shrink-0 rounded-full', col.dot)} aria-hidden="true" />
                <h2 className="truncate text-sm font-semibold text-ink-900">{col.title}</h2>
                <span className={cx('ml-auto rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', col.accent)}>{col.total}</span>
              </div>
              <p className="mt-1 text-xs leading-snug text-ink-500">{col.description}</p>
              {col.total > col.items.length && col.items.length > 0 && (
                <p className="mt-1 text-[11px] text-ink-400">Showing {col.items.length} of {col.total} on this page</p>
              )}
            </header>

            {col.items.length === 0 ? (
              <p className="px-0.5 pb-1 text-xs text-ink-400">{col.total > 0 ? 'On other pages' : 'Nothing here'}</p>
            ) : (
              <div className="space-y-2.5">
                {col.items.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    role={taskRole(task, userId, canApprove)}
                    busy={busy}
                    onOpen={() => onOpen(task)}
                    onQuick={(quick) => onQuick(task, quick)}
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
