import type { TaskSummary } from '../../lib/types';

export interface TaskListSummary {
  total: number;
  overdue: number;
  completed: number;
  cancelled: number;
  byStatus: Record<string, number>;
  stages: Record<StageId, number>;
}

export interface TaskListResponse {
  items: TaskSummary[];
  total: number;
  page: number;
  pageSize: number;
  summary?: TaskListSummary;
  slots?: Record<string, { total: number; done: number }>;
}

export type StageId = 'assigned' | 'in_progress' | 'review' | 'done';

/** Board columns. The status groups must match TASK_STAGES in backend/src/services/TaskService.ts. */
export const STAGES: {
  id: StageId;
  title: string;
  description: string;
  statuses: string[];
  dot: string;
  accent: string;
}[] = [
  {
    id: 'assigned',
    title: 'Assigned & Ready',
    description: 'Waiting to be accepted or started, incl. overdue and returned work',
    statuses: ['assigned', 'not_started', 'overdue', 'rejected'],
    dot: 'bg-sky-500',
    accent: 'bg-sky-50 text-sky-700',
  },
  {
    id: 'in_progress',
    title: 'In Progress',
    description: 'Accepted and being worked on',
    statuses: ['accepted', 'in_progress'],
    dot: 'bg-amber-500',
    accent: 'bg-amber-50 text-amber-700',
  },
  {
    id: 'review',
    title: 'Under Review',
    description: 'Submitted for verification, on hold or escalated',
    statuses: ['pending_approval', 'on_hold', 'escalated'],
    dot: 'bg-indigo-500',
    accent: 'bg-indigo-50 text-indigo-700',
  },
  {
    id: 'done',
    title: 'Verified & Done',
    description: 'Verified by a manager, or cancelled',
    statuses: ['completed', 'verified', 'cancelled'],
    dot: 'bg-emerald-500',
    accent: 'bg-emerald-50 text-emerald-700',
  },
];

export const SLOTS: { id: 'morning' | 'operations' | 'evening' | 'closing'; label: string; short: string; hours: string; icon: string; desc: string }[] = [
  { id: 'morning', label: 'Morning SOP', short: 'Morning', hours: '9:30 AM – 11:00 AM', icon: 'clock', desc: 'Opening float, safe check, sales review, staff briefing' },
  { id: 'operations', label: 'Store Operations', short: 'Operations', hours: '11:00 AM – 5:00 PM', icon: 'building', desc: 'Floor walk, sales monitoring, CRM feedback' },
  { id: 'evening', label: 'Evening Peak', short: 'Evening', hours: '5:00 PM – 8:00 PM', icon: 'users', desc: 'Cash sweep, rush queue control' },
  { id: 'closing', label: 'Night Closing', short: 'Closing', hours: '8:00 PM – 9:30 PM', icon: 'lock', desc: 'Cash reconciliation, safe lock, closing report' },
];

export const slotLabel = (slot?: string | null) => SLOTS.find((s) => s.id === slot)?.label ?? null;

export const ALL_STATUSES = ['assigned', 'accepted', 'in_progress', 'on_hold', 'pending_approval', 'completed', 'rejected', 'escalated', 'overdue', 'cancelled'];

/** Names on old records were renamed; an empty assignee list is shown as "Unassigned", never as a real person. */
export const displayName = (name?: string | null): string => {
  if (!name || name === '—') return 'Unassigned';
  return name.replace(/Gagan(\s+C\s+B)?/gi, 'Renukaradhya');
};

export interface TaskRole {
  isAssignee: boolean;
  isManager: boolean;
}

/** Mirrors the server checks in TaskService.applyAction (the server remains the authority). */
export function taskRole(task: Pick<TaskSummary, 'assigneeIds' | 'createdBy' | 'managerId'>, userId: number | undefined, canApprove: boolean): TaskRole {
  const id = userId ?? -1;
  return {
    isAssignee: task.assigneeIds.includes(id),
    isManager: task.createdBy === id || task.managerId === id || canApprove,
  };
}

export type QuickAction = { action: 'accept' | 'start' | 'resume' | 'submit' | 'verify'; label: string; icon: string; tone: 'primary' | 'success' };

/** The single "next step" button a card / table row offers to this user, if any. */
export function nextAction(task: TaskSummary, role: TaskRole): QuickAction | null {
  if (role.isAssignee) {
    if (['assigned', 'not_started', 'rejected'].includes(task.status)) return { action: 'accept', label: 'Accept task', icon: 'check', tone: 'primary' };
    if (task.status === 'overdue' || task.status === 'accepted') return { action: 'start', label: 'Start', icon: 'play', tone: 'primary' };
    if (task.status === 'on_hold') return { action: 'resume', label: 'Resume', icon: 'play', tone: 'primary' };
    if (task.status === 'in_progress') return { action: 'submit', label: 'Submit', icon: 'send', tone: 'primary' };
  }
  if (role.isManager && task.status === 'pending_approval') return { action: 'verify', label: 'Verify', icon: 'checkCircle', tone: 'success' };
  return null;
}

export function dueLabel(task: Pick<TaskSummary, 'dueDate' | 'dueTime'>): string | null {
  if (!task.dueDate) return task.dueTime ? task.dueTime.slice(0, 5) : null;
  const date = new Date(`${task.dueDate}T00:00:00`);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const label = sameDay ? 'Today' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return task.dueTime ? `${label} · ${task.dueTime.slice(0, 5)}` : label;
}
