import { Icon } from '../../components/icons';
import { Avatar } from '../../components/ui';
import { cx, formatTime, relativeTime } from '../../lib/format';
import type { IssueItem } from '../../lib/types';

interface IssueCardsProps {
  issues: IssueItem[];
  currentUserId?: number;
  isManagerOrAdmin: boolean;
  onOpen: (id: number) => void;
  onAcknowledge: (id: number) => void;
  onEscalate: (id: number) => void;
  onEdit?: (issue: IssueItem) => void;
  onDelete?: (issue: IssueItem) => void;
}

export function IssueCards({
  issues,
  currentUserId,
  isManagerOrAdmin,
  onOpen,
  onAcknowledge,
  onEscalate,
  onEdit,
  onDelete,
}: IssueCardsProps) {
  if (issues.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-ink-300 p-12 text-center bg-white">
        <Icon name="checkCircle" size={32} className="mx-auto text-ink-300" />
        <h3 className="mt-3 text-sm font-bold text-ink-800">No issues found</h3>
        <p className="mt-1 text-xs text-ink-500">There are no operational issues matching your active filter criteria.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {issues.map((issue) => {
        const isOverdue = issue.due_at && new Date(issue.due_at) < new Date() && !['resolved', 'closed', 'cancelled'].includes(issue.status);
        const canAcknowledge = !issue.acknowledged_at && (issue.assigned_to === currentUserId || isManagerOrAdmin);

        return (
          <div
            key={issue.id}
            onClick={() => onOpen(issue.id)}
            className={cx(
              'group relative flex flex-col justify-between rounded-xl border bg-white p-4 shadow-xs transition-all duration-200 cursor-pointer',
              'hover:-translate-y-0.5 hover:shadow-md hover:border-brand-400',
              isOverdue ? 'border-red-300 bg-red-50/10' : 'border-ink-200'
            )}
          >
            <div>
              {/* Header: Reference #, Priority, Status, Location */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-mono text-xs font-bold text-ink-700 bg-ink-100 px-2 py-0.5 rounded border border-ink-200">
                    {issue.issue_no}
                  </span>
                  {issue.location_code && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-800 border border-slate-200">
                      <Icon name="building" size={10} />
                      {issue.location_code}
                    </span>
                  )}
                  {issue.escalation_level > 1 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                      Level {issue.escalation_level}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <span
                    className={cx(
                      'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border',
                      issue.priority === 'critical'
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : issue.priority === 'high'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : issue.priority === 'medium'
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'bg-slate-50 text-slate-700 border-slate-200'
                    )}
                  >
                    {issue.priority}
                  </span>
                  <span
                    className={cx(
                      'px-2 py-0.5 rounded-full text-[10px] font-bold capitalize border',
                      issue.status === 'resolved'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : issue.status === 'escalated'
                        ? 'bg-purple-50 text-purple-700 border-purple-200'
                        : issue.status === 'in_progress'
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    )}
                  >
                    {issue.status.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>

              {/* Title & Category */}
              <h3 className="mt-2.5 text-sm font-bold text-ink-900 group-hover:text-brand-700 transition-colors break-words">
                {issue.title}
              </h3>

              <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-500 font-medium">
                <span className="capitalize">{issue.category.replace(/_/g, ' ')}</span>
                {issue.affected_module && <span>· {issue.affected_module}</span>}
              </div>

              {/* Description preview */}
              <p className="mt-2 text-xs text-ink-600 leading-relaxed break-words">
                {issue.description}
              </p>
            </div>

            {/* Footer with Reporter, Assignee, and Quick Actions */}
            <div className="mt-4 pt-3 border-t border-ink-100 flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 min-w-0" title={`Raised by ${issue.reporter_name}`}>
                  <Avatar name={issue.reporter_name} src={issue.reporter_photo} size={20} />
                  <span className="truncate text-ink-700 font-medium">{issue.reporter_name}</span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0 text-ink-500 font-medium" title={`Assigned to ${issue.assigned_to_name}`}>
                  <span className="text-[10px] text-ink-400">Assigned:</span>
                  <Avatar name={issue.assigned_to_name ?? 'Mgr'} src={issue.assigned_to_photo} size={20} />
                  <span className="truncate max-w-[90px] font-semibold text-ink-800">
                    {issue.assigned_to_name ?? 'Unassigned'}
                  </span>
                </div>
              </div>

              {/* SLA Due & Action row */}
              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <Icon name="clock" size={12} className={isOverdue ? 'text-red-500' : 'text-ink-400'} />
                  <span className={cx('font-medium', isOverdue ? 'text-red-600 font-bold' : 'text-ink-500')}>
                    {issue.due_at ? (isOverdue ? `Overdue · ${relativeTime(issue.due_at)}` : `Due ${formatTime(issue.due_at)}`) : 'No SLA'}
                  </span>
                </div>

                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {canAcknowledge && (
                    <button
                      type="button"
                      onClick={() => onAcknowledge(issue.id)}
                      className="px-2 py-1 rounded text-xs font-bold bg-brand-50 text-brand-700 hover:bg-brand-100 border border-brand-200 transition-colors"
                    >
                      Acknowledge
                    </button>
                  )}

                  {['pending', 'in_progress'].includes(issue.status) && (
                    <button
                      type="button"
                      onClick={() => onEscalate(issue.id)}
                      className="px-2 py-1 rounded text-xs font-bold text-purple-700 hover:bg-purple-50 border border-purple-200 transition-colors"
                    >
                      Escalate
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onOpen(issue.id)}
                    className="px-2 py-1 rounded text-xs font-bold text-ink-600 hover:bg-ink-100 border border-ink-200 transition-colors"
                  >
                    Details
                  </button>

                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(issue)}
                      title="Edit Issue"
                      className="p-1 rounded text-ink-500 hover:text-brand-600 hover:bg-brand-50 border border-ink-200 transition-colors"
                    >
                      <Icon name="edit" size={13} />
                    </button>
                  )}

                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => onDelete(issue)}
                      title="Delete Issue"
                      className="p-1 rounded text-ink-500 hover:text-rose-600 hover:bg-rose-50 border border-ink-200 transition-colors"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
