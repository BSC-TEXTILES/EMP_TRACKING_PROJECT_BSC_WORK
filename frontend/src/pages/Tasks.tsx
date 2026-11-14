import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadReport, errorMessage } from '../lib/api';
import { useApi, useDebounced, useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, PriorityBadge, ProgressBar, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDate, formatDateTime, minutesToHours, titleize } from '../lib/format';
import type { PickerEmployee, ProjectSummary, TaskSummary } from '../lib/types';

interface TaskListResponse {
  items: TaskSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export default function Tasks() {
  useDocumentTitle('Tasks');
  const { user, has, canAny } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'mine';
  const status = params.get('status') ?? '';
  const overdue = params.get('overdue') === 'true';
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<TaskSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(params.get('create') === '1');
  const [assignees, setAssignees] = useState<PickerEmployee[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [comment, setComment] = useState('');
  const [progressValue, setProgressValue] = useState(0);
  const [progressNote, setProgressNote] = useState('');
  const [completionNote, setCompletionNote] = useState('');
  const [busy, setBusy] = useState(false);

  const query = new URLSearchParams();
  if (view !== 'all') query.set('view', view);
  if (status) query.set('status', status);
  if (priority) query.set('priority', priority);
  if (overdue) query.set('overdue', 'true');
  if (debouncedSearch) query.set('search', debouncedSearch);
  query.set('page', String(page));
  query.set('pageSize', '15');

  const { data, loading, reload } = useApi<TaskListResponse>(`/tasks?${query.toString()}`, [view, status, priority, overdue, debouncedSearch, page]);
  const projectsData = useApi<{ projects: ProjectSummary[] }>('/projects');

  useEffect(() => {
    if (projectsData.data) setProjects(projectsData.data.projects);
  }, [projectsData.data]);

  useEffect(() => {
    api
      .get<{ employees: PickerEmployee[] }>(has('tasks.assign') ? '/tasks/meta/assignable' : '/employees/picker')
      .then((result) => setAssignees(result.employees))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useSocketEvent('task:updated', () => {
    void reload();
    if (detail) void openDetail(detail.id, true);
  });
  useSocketEvent('task:created', () => void reload());

  const openDetail = async (id: number, silent = false) => {
    if (!silent) setDetailLoading(true);
    try {
      const result = await api.get<TaskSummary>(`/tasks/${id}`);
      setDetail(result);
      setProgressValue(result.progress);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    const taskId = params.get('task');
    if (taskId) void openDetail(Number(taskId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${detail.id}/action`, { action, ...payload });
      toast.success('Task updated.');
      await openDetail(detail.id, true);
      await reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const isAssignee = detail?.assigneeIds.includes(user?.id ?? -1) ?? false;
  const isManager = detail ? detail.createdBy === user?.id || detail.managerName === user?.fullName || has('tasks.approve') : false;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Task allocation & tracking"
        description="Allocate, accept, track and approve work with a complete audit trail."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'tasks', format: 'xlsx' })}>
              Export
            </button>
            {has('tasks.create') && (
              <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={15} /> Allocate task
              </button>
            )}
          </>
        }
      />

      <Card>
        <div className="px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'mine', label: 'Assigned to me' },
              { value: 'allocated', label: 'Allocated by me' },
              { value: 'all', label: 'All tasks' },
            ]}
            value={view}
            onChange={(value) => {
              setPage(1);
              setParams(value === 'mine' ? {} : { view: value });
            }}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <div className="relative min-w-[200px] flex-1">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-9"
              placeholder="Search title, task number…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <select className="input w-auto" value={status} onChange={(event) => { setStatusParam(event.target.value); }}>
            <option value="">All statuses</option>
            {['assigned', 'accepted', 'in_progress', 'on_hold', 'pending_approval', 'completed', 'overdue', 'cancelled'].map((value) => (
              <option key={value} value={value}>
                {titleize(value)}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={priority} onChange={(event) => { setPriority(event.target.value); setPage(1); }}>
            <option value="">All priorities</option>
            {['critical', 'high', 'medium', 'low'].map((value) => (
              <option key={value} value={value}>
                {titleize(value)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs font-medium text-ink-600">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.checked) next.set('overdue', 'true');
                else next.delete('overdue');
                setParams(next);
                setPage(1);
              }}
              className="h-4 w-4 rounded border-ink-300"
            />
            Overdue only
          </label>
        </div>

        {loading && !data ? (
          <div className="p-4">
            <Skeleton lines={8} />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No tasks found"
            description="Adjust the filters or allocate a new task to your team."
            action={has('tasks.create') ? <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>Allocate task</button> : undefined}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Assignees</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Due</th>
                    <th className="w-32">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((task) => (
                    <tr key={task.id} className="cursor-pointer" onClick={() => void openDetail(task.id)}>
                      <td>
                        <p className="font-medium text-ink-800">{task.title}</p>
                        <p className="text-xs text-ink-400">
                          {task.taskNo} {task.projectName ? `· ${task.projectName}` : ''}
                        </p>
                      </td>
                      <td className="text-ink-600">{task.assigneeNames ?? '—'}</td>
                      <td><PriorityBadge priority={task.priority} /></td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusBadge status={task.status} />
                          {task.isOverdue && task.status !== 'overdue' && <Badge tone="danger">Overdue</Badge>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-ink-600">{formatDate(task.dueDate)}</td>
                      <td>
                        <ProgressBar value={task.progress} tone={task.progress === 100 ? 'success' : 'brand'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        assignees={assignees}
        projects={projects}
        onCreated={() => {
          setCreateOpen(false);
          void reload();
        }}
      />

      <Modal
        open={Boolean(detail) || detailLoading}
        onClose={() => setDetail(null)}
        title={detail?.title ?? 'Loading task…'}
        description={detail ? `${detail.taskNo} · allocated by ${detail.creatorName ?? '—'}` : undefined}
        size="xl"
        footer={
          detail ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {isAssignee && ['assigned', 'not_started', 'rejected', 'on_hold'].includes(detail.status) && (
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => void act('accept')}>
                    Accept task
                  </button>
                )}
                {isAssignee && ['accepted', 'in_progress'].includes(detail.status) && (
                  <>
                    {detail.status === 'accepted' && (
                      <button className="btn-primary btn-sm" disabled={busy} onClick={() => void act('start')}>
                        Start work
                      </button>
                    )}
                    <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('hold')}>
                      Put on hold
                    </button>
                  </>
                )}
                {isAssignee && detail.status === 'on_hold' && (
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => void act('resume')}>
                    Resume
                  </button>
                )}
                {isAssignee && ['accepted', 'in_progress', 'on_hold'].includes(detail.status) && (
                  <button
                    className="btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => {
                      const note = completionNote || window.prompt('Describe the completed work:') || '';
                      if (note.length < 5) {
                        toast.error('Describe the completed work before submitting.');
                        return;
                      }
                      void act('submit', { completionNote: note });
                    }}
                  >
                    Submit for approval
                  </button>
                )}
                {isManager && detail.status === 'pending_approval' && (
                  <>
                    <button className="btn-primary btn-sm" disabled={busy} onClick={() => void act('approve')}>
                      Approve completion
                    </button>
                    <button
                      className="btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => {
                        const note = window.prompt('What needs to change?');
                        if (note) void act('request_changes', { note });
                      }}
                    >
                      Request changes
                    </button>
                  </>
                )}
                {isManager && !['completed', 'cancelled'].includes(detail.status) && (
                  <button
                    className="btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Cancel this task?')) void act('cancel');
                    }}
                  >
                    Cancel
                  </button>
                )}
                {isManager && ['completed', 'rejected'].includes(detail.status) && (
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('reopen')}>
                    Reopen
                  </button>
                )}
              </div>
              <button className="btn-secondary btn-sm" onClick={() => setDetail(null)}>
                Close
              </button>
            </div>
          ) : null
        }
      >
        {detailLoading || !detail ? (
          <Skeleton lines={10} />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              <PriorityBadge priority={detail.priority} />
              {detail.projectName && <Badge tone="brand">{detail.projectName}</Badge>}
              {detail.recurrence !== 'none' && <Badge tone="info">Repeats {detail.recurrence}</Badge>}
              {detail.isOverdue && <Badge tone="danger">Past due</Badge>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-400">Assigned to</p>
                <p className="text-sm font-medium text-ink-800">{detail.assigneeNames ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-400">Due</p>
                <p className="text-sm font-medium text-ink-800">
                  {formatDate(detail.dueDate)} {detail.dueTime ? `· ${detail.dueTime}` : ''}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-400">Estimated</p>
                <p className="text-sm font-medium text-ink-800">{detail.estimatedMinutes ? minutesToHours(detail.estimatedMinutes) : '—'}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-400">Time logged</p>
                <p className="text-sm font-medium text-ink-800">{minutesToHours(detail.totalLoggedMinutes ?? 0)}</p>
              </div>
            </div>

            {detail.description && <p className="whitespace-pre-line text-sm text-ink-600">{detail.description}</p>}
            {detail.instructions && (
              <div className="rounded-lg bg-brand-50/60 p-3 text-sm text-ink-700">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-700">Instructions</p>
                {detail.instructions}
              </div>
            )}
            {detail.rejectionReason && (
              <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Changes requested: {detail.rejectionReason}</div>
            )}

            <div>
              <ProgressBar value={detail.progress} label="Progress" />
              {isAssignee && !['completed', 'cancelled'].includes(detail.status) && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={progressValue}
                    onChange={(event) => setProgressValue(Number(event.target.value))}
                    className="w-40"
                  />
                  <input
                    className="input flex-1"
                    placeholder="Optional progress note"
                    value={progressNote}
                    onChange={(event) => setProgressNote(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={busy}
                    onClick={async () => {
                      await act('progress', { progress: progressValue, note: progressNote || undefined });
                      setProgressNote('');
                    }}
                  >
                    Update progress
                  </button>
                </div>
              )}
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <SectionHeader title="Checklist" />
                <div className="mt-2 space-y-1.5">
                  {detail.subtasks?.length ? (
                    detail.subtasks.map((subtask) => (
                      <label key={subtask.id} className="flex items-start gap-2 rounded-lg border border-ink-200 px-2.5 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={subtask.isDone}
                          className="mt-0.5 h-4 w-4"
                          onChange={async () => {
                            try {
                              await api.patch(`/tasks/${detail.id}/subtasks/${subtask.id}`);
                              await openDetail(detail.id, true);
                            } catch (caught) {
                              toast.error(errorMessage(caught));
                            }
                          }}
                        />
                        <span className={subtask.isDone ? 'text-ink-400 line-through' : 'text-ink-700'}>{subtask.title}</span>
                      </label>
                    ))
                  ) : (
                    <p className="text-sm text-ink-500">No checklist items.</p>
                  )}
                  <form
                    className="flex gap-2"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const input = (event.currentTarget.elements.namedItem('subtask') as HTMLInputElement).value;
                      if (!input.trim()) return;
                      try {
                        await api.post(`/tasks/${detail.id}/subtasks`, { title: input });
                        (event.currentTarget.elements.namedItem('subtask') as HTMLInputElement).value = '';
                        await openDetail(detail.id, true);
                      } catch (caught) {
                        toast.error(errorMessage(caught));
                      }
                    }}
                  >
                    <input name="subtask" className="input" placeholder="Add checklist item" />
                    <button type="submit" className="btn-secondary btn-sm">
                      Add
                    </button>
                  </form>
                </div>
              </div>

              <div>
                <SectionHeader title="Assignments" />
                <div className="mt-2 space-y-2">
                  {detail.assignments?.map((assignment) => (
                    <div key={assignment.id} className="rounded-lg border border-ink-200 px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-ink-800">{assignment.employeeName}</p>
                        <StatusBadge status={assignment.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-ink-500">
                        Assigned {formatDateTime(assignment.assignedAt)} · {minutesToHours(assignment.timeSpentMinutes)} logged
                      </p>
                      {assignment.completionNote && <p className="mt-1 text-xs text-ink-600">“{assignment.completionNote}”</p>}
                    </div>
                  ))}
                  {detail.timeLogs?.length ? (
                    <p className="text-xs text-ink-400">
                      Latest time log: {detail.timeLogs[0].employeeName} · {minutesToHours(detail.timeLogs[0].minutes)}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <div>
              <SectionHeader title="Discussion" />
              <div className="mt-2 space-y-2">
                {detail.comments?.length ? (
                  detail.comments.map((entry) => (
                    <div key={entry.id} className="rounded-lg bg-ink-50 px-3 py-2">
                      <p className="text-xs font-semibold text-ink-700">
                        {entry.authorName} <span className="font-normal text-ink-400">· {formatDateTime(entry.createdAt)}</span>
                      </p>
                      <p className="mt-0.5 text-sm text-ink-700">{entry.body}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-ink-500">No comments yet.</p>
                )}
                <form
                  className="flex gap-2"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!comment.trim()) return;
                    try {
                      await api.post(`/tasks/${detail.id}/comments`, { body: comment });
                      setComment('');
                      await openDetail(detail.id, true);
                      await reload();
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    }
                  }}
                >
                  <input className="input" placeholder="Add a comment…" value={comment} onChange={(event) => setComment(event.target.value)} />
                  <button type="submit" className="btn-primary btn-sm" disabled={!comment.trim()}>
                    Send
                  </button>
                </form>
              </div>
            </div>

            <div className="flex flex-wrap gap-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
              <span>Created {formatDateTime(detail.createdAt)}</span>
              {detail.submittedAt && <span>Submitted {formatDateTime(detail.submittedAt)}</span>}
              {detail.approvedAt && <span>Approved {formatDateTime(detail.approvedAt)}</span>}
              {canAny('tasks.assign') && <span>Assignees can only be changed by the allocating manager.</span>}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );

  function setStatusParam(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set('status', value);
    else next.delete('status');
    setParams(next);
    setPage(1);
  }
}

function CreateTaskModal({
  open,
  onClose,
  assignees,
  projects,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  assignees: PickerEmployee[];
  projects: ProjectSummary[];
  onCreated: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    dueDate: '',
    dueTime: '18:30',
    estimatedMinutes: 120,
    projectId: '',
    category: 'Delivery',
    recurrence: 'none',
    instructions: '',
    subtasks: '',
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selected.length === 0) {
      toast.error('Select at least one employee to allocate this task to.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/tasks', {
        title: form.title,
        description: form.description || undefined,
        priority: form.priority,
        dueDate: form.dueDate || undefined,
        dueTime: form.dueTime || undefined,
        estimatedMinutes: Number(form.estimatedMinutes) || undefined,
        projectId: form.projectId ? Number(form.projectId) : null,
        category: form.category,
        recurrence: form.recurrence,
        instructions: form.instructions || undefined,
        assigneeIds: selected,
        subtasks: form.subtasks
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      });
      toast.success('Task allocated and assignees notified.');
      setForm({ ...form, title: '', description: '', instructions: '', subtasks: '' });
      setSelected([]);
      onCreated();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Allocate a task"
      description="Assignees receive a notification immediately and appear in their task list."
      size="lg"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="create-task-form" className="btn-primary" disabled={submitting}>
            {submitting ? 'Allocating…' : 'Allocate task'}
          </button>
        </>
      }
    >
      <form id="create-task-form" onSubmit={submit} className="space-y-4">
        <Field label="Task title" required>
          <input className="input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} minLength={3} required />
        </Field>
        <Field label="Description">
          <textarea className="input min-h-[80px]" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority">
            <select className="input" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
              {['low', 'medium', 'high', 'critical'].map((value) => (
                <option key={value} value={value}>
                  {titleize(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <input className="input" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
          </Field>
          <Field label="Start / due date" required>
            <input
              type="date"
              className="input"
              value={form.dueDate}
              onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
              required
            />
          </Field>
          <Field label="Due time">
            <input type="time" className="input" value={form.dueTime} onChange={(event) => setForm({ ...form, dueTime: event.target.value })} />
          </Field>
          <Field label="Estimated duration (minutes)">
            <input
              type="number"
              min={15}
              step={15}
              className="input"
              value={form.estimatedMinutes}
              onChange={(event) => setForm({ ...form, estimatedMinutes: Number(event.target.value) })}
            />
          </Field>
          <Field label="Project">
            <select className="input" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Recurrence">
            <select className="input" value={form.recurrence} onChange={(event) => setForm({ ...form, recurrence: event.target.value })}>
              <option value="none">One-off task</option>
              <option value="daily">Repeat daily</option>
              <option value="weekly">Repeat weekly</option>
              <option value="monthly">Repeat monthly</option>
            </select>
          </Field>
        </div>

        <div>
          <span className="label">Assign to (reporting structure only) *</span>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-ink-300 p-2">
            {assignees.length === 0 && <p className="p-2 text-sm text-ink-500">No employees available in your reporting structure.</p>}
            {assignees.map((employee) => (
              <label key={employee.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-ink-50">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={selected.includes(employee.id)}
                  onChange={(event) =>
                    setSelected((prev) => (event.target.checked ? [...prev, employee.id] : prev.filter((id) => id !== employee.id)))
                  }
                />
                <span className="text-ink-800">{employee.full_name}</span>
                <span className="text-xs text-ink-400">{employee.designation_title ?? ''}</span>
              </label>
            ))}
          </div>
        </div>

        <Field label="Instructions">
          <textarea className="input min-h-[70px]" value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} />
        </Field>
        <Field label="Checklist" hint="One item per line">
          <textarea className="input min-h-[70px]" value={form.subtasks} onChange={(event) => setForm({ ...form, subtasks: event.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}
