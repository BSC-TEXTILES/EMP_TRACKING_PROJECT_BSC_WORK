import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadReport, errorMessage, fileUrl } from '../lib/api';
import { useApi, useDebounced, useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime, useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Card, EmptyState, Field, Modal, Pagination, PriorityBadge, Skeleton, StatusBadge } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDate, formatDateTime, minutesToHours, relativeTime, titleize } from '../lib/format';
import type { PickerEmployee, ProjectSummary, TaskSummary } from '../lib/types';
import { ALL_STATUSES, SLOTS, displayName, slotLabel, taskRole, type QuickAction, type TaskListResponse } from './tasks/taskConfig';
import { SlotCards, SummaryCards, type SummaryFilter } from './tasks/TaskOverview';
import { TaskBoard } from './tasks/TaskBoard';
import { TaskTable, type SortKey } from './tasks/TaskTable';
import { TimelinePanel } from './tasks/TimelinePanel';
import { PerformancePanel } from './tasks/PerformancePanel';

type MainTab = 'tasks' | 'timeline' | 'performance';
type ViewMode = 'flow' | 'list';

const readViewMode = (): ViewMode => {
  try {
    return localStorage.getItem('tasks.viewMode') === 'list' ? 'list' : 'flow';
  } catch {
    return 'flow';
  }
};

const ACTION_LABELS: Record<string, string> = {
  created: 'created the task',
  create: 'created the task',
  accept: 'accepted the task',
  start: 'started work',
  hold: 'put the task on hold',
  resume: 'resumed work',
  progress: 'updated progress',
  submit: 'submitted for verification',
  verify: 'verified and approved',
  approve: 'verified and approved',
  reject: 'rejected the submission',
  request_changes: 'requested corrections',
  escalate: 'escalated the task',
  set_status: 'changed the status',
  cancel: 'cancelled the task',
  reopen: 'reopened the task',
  reassign: 'reassigned the task',
  reassigned: 'reassigned the task',
};

interface ReasonDialog {
  action: 'reject' | 'request_changes' | 'escalate' | 'cancel';
  title: string;
  description: string;
  label: string;
  confirm: string;
  danger?: boolean;
  required: boolean;
}

export default function Tasks() {
  useDocumentTitle('Tasks & SOP Management');
  const { user, has, canAny } = useAuth();
  const { connected } = useRealtime();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const canSeeTeam = canAny('tasks.view.team', 'tasks.view.all');
  const canAllocate = has('tasks.create');
  const canApprove = has('tasks.approve');

  const [mainTab, setMainTab] = useState<MainTab>(() => {
    const tab = params.get('tab');
    return tab === 'timeline' || tab === 'performance' ? tab : 'tasks';
  });
  const [viewMode, setViewModeState] = useState<ViewMode>(readViewMode);
  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    setPage(1);
    try {
      localStorage.setItem('tasks.viewMode', mode);
    } catch {
      /* per-browser convenience only */
    }
  };

  // Filters live in the URL so links and the back button keep working.
  const rawView = params.get('view') ?? 'mine';
  const view = (rawView === 'all' && !canSeeTeam) || (rawView === 'allocated' && !canAllocate) ? 'mine' : rawView;
  const status = params.get('status') ?? '';
  const stage = params.get('stage') ?? '';
  const timeSlot = params.get('timeSlot') ?? '';
  const overdue = params.get('overdue') === 'true';
  const locationId = params.get('location') ?? '';
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState<SortKey | ''>('');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  const [locations, setLocations] = useState<{ id: number; code: string; name: string }[]>([]);
  const [assignees, setAssignees] = useState<PickerEmployee[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [createOpen, setCreateOpen] = useState(params.get('create') === '1');
  const [busy, setBusy] = useState(false);
  const [generatingDaily, setGeneratingDaily] = useState(false);

  // Detail panel
  const [detail, setDetail] = useState<TaskSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'comments' | 'activity'>('comments');
  const [comment, setComment] = useState('');
  const [progressValue, setProgressValue] = useState(0);
  const [progressNote, setProgressNote] = useState('');
  const [reasonDialog, setReasonDialog] = useState<ReasonDialog | null>(null);
  const [reasonText, setReasonText] = useState('');

  // Submission
  const [submitTarget, setSubmitTarget] = useState<TaskSummary | null>(null);
  const [submitNote, setSubmitNote] = useState('');
  const [submitMetricValue, setSubmitMetricValue] = useState<number | ''>('');
  const [submitFile, setSubmitFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Edit & Delete Task states
  const [editTask, setEditTask] = useState<TaskSummary | null>(null);
  const [deleteConfirmTask, setDeleteConfirmTask] = useState<TaskSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [purgeAllOpen, setPurgeAllOpen] = useState(false);
  const [purgingAll, setPurgingAll] = useState(false);

  const pageSize = viewMode === 'flow' ? 60 : 20;
  const query = new URLSearchParams();
  if (view !== 'all') query.set('view', view);
  if (status) query.set('status', status);
  if (stage) query.set('stage', stage);
  if (priority) query.set('priority', priority);
  if (timeSlot) query.set('timeSlot', timeSlot);
  if (overdue) query.set('overdue', 'true');
  if (locationId) query.set('locationId', locationId);
  if (debouncedSearch) query.set('search', debouncedSearch);
  if (sort && viewMode === 'list') {
    query.set('sort', sort);
    query.set('dir', dir);
  }
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));

  const { data, loading, error, reload } = useApi<TaskListResponse>(`/tasks?${query.toString()}`, [query.toString()]);
  const projectsData = useApi<{ projects: ProjectSummary[] }>(canAllocate ? '/projects' : null);

  useEffect(() => {
    if (projectsData.data) setProjects(projectsData.data.projects);
  }, [projectsData.data]);

  useEffect(() => {
    api
      .get<{ employees: PickerEmployee[] }>(has('tasks.assign') ? '/tasks/meta/assignable' : '/employees/picker')
      .then((result) => setAssignees(result.employees))
      .catch(() => setAssignees([]));
    api
      .get<{ locations: { id: number; code: string; name: string }[] }>('/employees/allowed-locations')
      .then((result) => setLocations(result.locations ?? []))
      .catch(() => setLocations([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDetail = async (id: number, silent = false) => {
    if (!silent) {
      setDetailLoading(true);
      setDetailTab('comments');
    }
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

  useSocketEvent('task:updated', () => {
    void reload();
    if (detail) void openDetail(detail.id, true);
  });
  useSocketEvent('task:created', () => void reload());
  useSocketEvent('task:deleted', (data: any) => {
    void reload();
    if (detail && data?.id === detail.id) {
      setDetail(null);
    }
  });
  useSocketEvent('tasks:purged', () => {
    void reload();
    setDetail(null);
  });

  const handlePurgeAll = async () => {
    setPurgingAll(true);
    try {
      await api.post('/tasks/purge-all', {});
      toast.success('All task data has been removed.');
      setPurgeAllOpen(false);
      setDetail(null);
      void reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPurgingAll(false);
    }
  };

  const handleDeleteTask = async () => {
    if (!deleteConfirmTask) return;
    setDeleteBusy(true);
    try {
      await api.del(`/tasks/${deleteConfirmTask.id}`);
      toast.success(`Task ${deleteConfirmTask.taskNo} deleted successfully.`);
      if (detail?.id === deleteConfirmTask.id) {
        setDetail(null);
      }
      setDeleteConfirmTask(null);
      void reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    next.delete('task');
    next.delete('create');
    mutate(next);
    setParams(next);
    setPage(1);
  };

  const successMessage = (action: string) =>
    ({
      accept: 'Task accepted.',
      start: 'Work started. Time is being logged.',
      resume: 'Work resumed.',
      hold: 'Task put on hold.',
      verify: 'Task verified and approved.',
      reject: 'Submission rejected. The assignee has been notified.',
      request_changes: 'Correction requested. The assignee has been notified.',
      escalate: 'Task escalated to the manager.',
      cancel: 'Task cancelled.',
      reopen: 'Task reopened.',
      progress: 'Progress updated.',
    })[action] ?? 'Task updated.';

  const runAction = async (taskId: number, action: string, payload: Record<string, unknown> = {}) => {
    if (busy) return false;
    if (action === 'hold' || action === 'reject' || (action === 'set_status' && payload.status === 'on_hold')) {
      if (!payload.note && !payload.rejectionReason) {
        const reason = window.prompt(action === 'reject' ? 'Reason for rejecting this task:' : 'Reason for putting this task on hold:');
        if (!reason?.trim()) return false;
        payload = { ...payload, note: reason.trim() };
      }
    }
    setBusy(true);
    try {
      await api.post(`/tasks/${taskId}/action`, { action, ...payload });
      toast.success(successMessage(action));
      await reload();
      if (detail?.id === taskId) await openDetail(taskId, true);
      return true;
    } catch (caught) {
      toast.error(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openSubmit = (task: TaskSummary) => {
    setSubmitTarget(task);
    setSubmitNote('');
    setSubmitMetricValue(task.metricValue ?? '');
    setSubmitFile(null);
  };

  const onQuick = (task: TaskSummary, quick: QuickAction) => {
    if (quick.action === 'submit') openSubmit(task);
    else void runAction(task.id, quick.action);
  };

  const changeStatus = async (task: TaskSummary, nextStatus: string) => {
    if (nextStatus === task.status) return;
    if (nextStatus === 'pending_approval') {
      openSubmit(task);
      return;
    }
    await runAction(task.id, 'set_status', { status: nextStatus });
  };

  const handleGenerate = async () => {
    setGeneratingDaily(true);
    try {
      // "force" only fills in SOP tasks the employee is missing today; the server never creates duplicates.
      const res = await api.post<{ created: number; existing: number; error?: string }>('/tasks/daily/generate', { force: true });
      if (res.error) toast.error(res.error);
      else if (res.created > 0) toast.success(`Added ${res.created} SOP task(s) for today.`);
      else toast.info(res.existing > 0 ? `All of today's SOP tasks are already assigned (${res.existing}).` : 'No SOP templates apply to your role.');
      await reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setGeneratingDaily(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!submitTarget) return;
    if (submitNote.trim().length < 5) {
      toast.error('Describe the work completed (at least 5 characters).');
      return;
    }
    const needsProof = submitTarget.requiresEvidence && !submitTarget.evidenceFileId;
    if (needsProof && !submitFile) {
      toast.error('Attach the required proof before submitting.');
      return;
    }
    setSubmitting(true);
    try {
      let evidenceFileId: number | undefined;
      if (submitFile) evidenceFileId = (await api.uploadFile(submitFile)).id;
      await api.post(`/tasks/${submitTarget.id}/action`, {
        action: 'submit',
        completionNote: submitNote.trim(),
        metricValue: submitMetricValue !== '' ? Number(submitMetricValue) : undefined,
        evidenceFileId,
      });
      toast.success('Submitted for manager verification.');
      const id = submitTarget.id;
      setSubmitTarget(null);
      await reload();
      if (detail?.id === id) await openDetail(id, true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const openReason = (dialog: ReasonDialog) => {
    setReasonText('');
    setReasonDialog(dialog);
  };

  const confirmReason = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail || !reasonDialog) return;
    const text = reasonText.trim();
    if (reasonDialog.required && text.length < 3) {
      toast.error('Please add a short explanation (at least 3 characters).');
      return;
    }
    const payload =
      reasonDialog.action === 'reject' ? { rejectionReason: text } : text ? { note: text } : {};
    const ok = await runAction(detail.id, reasonDialog.action, payload);
    if (ok) setReasonDialog(null);
  };

  // ------------------------------------------------------------------ derived
  const summary = data?.summary;
  const activeSummary: SummaryFilter = overdue
    ? 'overdue'
    : (['assigned', 'in_progress', 'review', 'completed'] as const).find((value) => value === stage) ?? '';
  const filtersActive = Boolean(status || stage || priority || timeSlot || overdue || debouncedSearch || locationId);
  const selectedLocation = locations.find((location) => String(location.id) === locationId);
  const storeLabel = selectedLocation
    ? `${selectedLocation.code} · ${selectedLocation.name}`
    : locations.length > 1
      ? `All my stores (${locations.map((location) => location.code).join(', ')})`
      : user?.locationCode
        ? `${user.locationCode} · ${user.locationName ?? ''}`
        : (user?.locationName ?? locations[0]?.name ?? 'No store assigned');
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const role = detail ? taskRole(detail, user?.id, canApprove) : { isAssignee: false, isManager: false };
  const statusOptions = detail
    ? [
        ...(role.isManager ? [['assigned', 'Assigned']] : []),
        ...(role.isAssignee || role.isManager ? [['accepted', 'Accepted'], ['in_progress', 'In progress'], ['on_hold', 'On hold']] : []),
        ...(role.isAssignee || role.isManager ? [['pending_approval', 'Submitted for verification']] : []),
        ...(role.isManager ? [['completed', 'Completed (verified)'], ['cancelled', 'Cancelled']] : []),
      ]
    : [];

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------------ header */}
      <header className="card p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Tasks & SOP management</p>
            <h1 className="mt-1 text-xl font-semibold text-ink-900 sm:text-2xl">Store SOP & Daily Task Tracking</h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-600">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="calendar" size={15} className="text-ink-400" />
                {todayLabel}
              </span>
              {locations.length > 1 ? (
                <label className="inline-flex items-center gap-1.5">
                  <Icon name="building" size={15} className="text-ink-400" />
                  <span className="sr-only">Store</span>
                  <select
                    className="h-8 rounded-md border border-ink-200 bg-surface px-2 text-sm font-medium text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    value={locationId}
                    onChange={(event) => updateParams((next) => (event.target.value ? next.set('location', event.target.value) : next.delete('location')))}
                  >
                    <option value="">All my stores ({locations.map((location) => location.code).join(', ')})</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.code} · {location.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="building" size={15} className="text-ink-400" />
                  {storeLabel}
                </span>
              )}
              <span className={cx('inline-flex items-center gap-1.5 font-medium', connected ? 'text-emerald-700' : 'text-amber-700')} title={connected ? 'Changes appear instantly' : 'Trying to reconnect; data refreshes when the connection returns'}>
                <span className="relative flex h-2 w-2">
                  {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
                  <span className={cx('relative inline-flex h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')} />
                </span>
                {connected ? 'Live' : 'Reconnecting…'}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(user?.roleSlug === 'super_admin' || user?.roleSlug === 'admin' || (user?.roleLevel ?? 0) >= 40) && (
              <button
                type="button"
                className="btn-secondary h-10 text-rose-600 hover:bg-rose-50 border-rose-200 inline-flex items-center gap-1.5"
                onClick={() => setPurgeAllOpen(true)}
                title="Remove all task records and reset to zero"
              >
                <Icon name="trash" size={16} />
                Clear all tasks
              </button>
            )}
            <button type="button" className="btn-secondary h-10" disabled={generatingDaily} onClick={() => void handleGenerate()} title="Assign today's SOP tasks for your role (existing tasks are never duplicated)">
              <Icon name="refresh" size={16} className={generatingDaily ? 'animate-spin' : ''} />
              {generatingDaily ? 'Generating…' : "Generate today's tasks"}
            </button>
            <button type="button" className="btn-secondary h-10" onClick={() => downloadReport({ type: 'tasks', format: 'xlsx', locationId: locationId || undefined })}>
              <Icon name="download" size={16} />
              Export report
            </button>
            {canAllocate && (
              <button type="button" className="btn-primary h-10" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={16} />
                Allocate task
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------ section tabs */}
      <nav className="flex gap-1 overflow-x-auto rounded-lg border border-ink-200 bg-surface p-1 sm:inline-flex" aria-label="Tasks sections">
        {(
          [
            ['tasks', 'tasks', 'Daily tasks & SOP'],
            ['timeline', 'clock', 'Activity timeline · 7 checkpoints'],
            ['performance', 'kpi', '100-point performance'],
          ] as const
        ).map(([id, icon, label]) => (
          <button
            key={id}
            type="button"
            aria-current={mainTab === id ? 'page' : undefined}
            onClick={() => setMainTab(id)}
            className={cx(
              'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3.5 py-2 text-sm font-medium transition-colors',
              mainTab === id ? 'bg-brand-700 text-white shadow-sm' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
            )}
          >
            <Icon name={icon} size={16} />
            {label}
          </button>
        ))}
      </nav>

      {mainTab === 'timeline' && <TimelinePanel employees={canSeeTeam ? assignees : []} />}
      {mainTab === 'performance' && <PerformancePanel employees={canSeeTeam ? assignees : []} />}

      {mainTab === 'tasks' && (
        <>
          <SummaryCards
            summary={summary}
            active={activeSummary}
            loading={loading}
            onSelect={(id) =>
              updateParams((next) => {
                next.delete('status');
                next.delete('stage');
                next.delete('overdue');
                if (id === 'overdue') next.set('overdue', 'true');
                else if (id) next.set('stage', id);
              })
            }
          />

          <section aria-labelledby="sop-timeline-title">
            <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="sop-timeline-title" className="text-sm font-semibold text-ink-900">Daily SOP timeline</h2>
              <p className="text-xs text-ink-500">Completion per shift for the current view. Select a shift to see its tasks.</p>
            </div>
            <SlotCards slots={data?.slots} active={timeSlot} onSelect={(slot) => updateParams((next) => (slot ? next.set('timeSlot', slot) : next.delete('timeSlot')))} />
          </section>

          <Card>
            {/* Toolbar: scope + view */}
            <div className="flex flex-col gap-3 border-b border-ink-100 p-3 sm:p-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex gap-1 overflow-x-auto rounded-lg bg-ink-100 p-1" role="tablist" aria-label="Task scope">
                {[
                  { value: 'mine', label: 'Assigned to me', show: true },
                  { value: 'allocated', label: 'Allocated by me', show: canAllocate },
                  { value: 'all', label: 'All store tasks', show: canSeeTeam },
                ]
                  .filter((tab) => tab.show)
                  .map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      role="tab"
                      aria-selected={view === tab.value}
                      onClick={() => updateParams((next) => (tab.value === 'mine' ? next.delete('view') : next.set('view', tab.value)))}
                      className={cx(
                        'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition',
                        view === tab.value ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900',
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
              </div>
              <div className="flex items-center gap-1 self-start rounded-lg border border-ink-200 p-1 lg:self-auto" role="group" aria-label="Layout">
                {(
                  [
                    ['flow', 'project', 'Workflow'],
                    ['list', 'list', 'Table'],
                  ] as const
                ).map(([mode, icon, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={viewMode === mode}
                    onClick={() => setViewMode(mode)}
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                      viewMode === mode ? 'bg-brand-700 text-white shadow-sm' : 'text-ink-600 hover:bg-ink-100',
                    )}
                  >
                    <Icon name={icon} size={15} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Filters */}
            <div className="grid grid-cols-2 gap-2 border-b border-ink-100 p-3 sm:p-4 md:flex md:flex-wrap md:items-center">
              <div className="relative col-span-2 md:min-w-[240px] md:flex-1">
                <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  className="input h-9 pl-9"
                  placeholder="Search by title, task ID or keyword"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Search tasks"
                />
              </div>
              <select
                className="input h-9 py-0 text-sm md:w-44"
                value={timeSlot}
                onChange={(event) => updateParams((next) => (event.target.value ? next.set('timeSlot', event.target.value) : next.delete('timeSlot')))}
                aria-label="SOP slot"
              >
                <option value="">All SOP slots</option>
                {SLOTS.map((slot) => (
                  <option key={slot.id} value={slot.id}>
                    {slot.short}
                  </option>
                ))}
              </select>
              <select
                className="input h-9 py-0 text-sm md:w-44"
                value={status}
                onChange={(event) =>
                  updateParams((next) => {
                    next.delete('stage');
                    if (event.target.value) next.set('status', event.target.value);
                    else next.delete('status');
                  })
                }
                aria-label="Status"
              >
                <option value="">All statuses</option>
                {ALL_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {titleize(value)}
                  </option>
                ))}
              </select>
              <select
                className="input h-9 py-0 text-sm md:w-40"
                value={priority}
                onChange={(event) => {
                  setPriority(event.target.value);
                  setPage(1);
                }}
                aria-label="Priority"
              >
                <option value="">All priorities</option>
                {['critical', 'high', 'medium', 'low'].map((value) => (
                  <option key={value} value={value}>
                    {titleize(value)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-pressed={overdue}
                onClick={() =>
                  updateParams((next) => {
                    if (overdue) next.delete('overdue');
                    else next.set('overdue', 'true');
                  })
                }
                className={cx(
                  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition',
                  overdue ? 'border-rose-300 bg-rose-50 text-rose-700' : 'border-ink-300 bg-surface text-ink-700 hover:bg-ink-50',
                )}
              >
                <Icon name="alertTriangle" size={14} />
                Overdue only
              </button>
              {filtersActive && (
                <button
                  type="button"
                  className="inline-flex h-9 items-center justify-center gap-1 rounded-md px-3 text-sm font-medium text-brand-700 hover:bg-brand-50"
                  onClick={() => {
                    setSearch('');
                    setPriority('');
                    updateParams((next) => {
                      ['status', 'stage', 'timeSlot', 'overdue', 'location'].forEach((key) => next.delete(key));
                    });
                  }}
                >
                  <Icon name="x" size={14} />
                  Clear filters
                </button>
              )}
            </div>

            {/* Results */}
            {error && !data ? (
              <div className="p-6">
                <p role="alert" className="text-sm text-red-600">Could not load tasks: {error}</p>
                <button type="button" className="btn-secondary btn-sm mt-3" onClick={() => void reload()}>Try again</button>
              </div>
            ) : loading && !data ? (
              <div className="p-4"><Skeleton lines={8} /></div>
            ) : !data || data.items.length === 0 ? (
              <EmptyState
                title={filtersActive ? 'No tasks match these filters' : 'No tasks yet'}
                description={filtersActive ? 'Try clearing a filter or choosing another shift.' : "Generate today's SOP tasks for your role, or allocate a task to your team."}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {filtersActive ? (
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          setSearch('');
                          setPriority('');
                          updateParams((next) => ['status', 'stage', 'timeSlot', 'overdue', 'location'].forEach((key) => next.delete(key)));
                        }}
                      >
                        Clear filters
                      </button>
                    ) : (
                      <button className="btn-secondary btn-sm" onClick={() => void handleGenerate()}>Generate today's tasks</button>
                    )}
                    {canAllocate && <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>Allocate task</button>}
                  </div>
                }
              />
            ) : viewMode === 'flow' ? (
              <div className="p-3 sm:p-4">
                <TaskBoard
                  items={data.items}
                  summary={summary}
                  filteredTotal={data.total}
                  statusFilter={status}
                  stageFilter={stage}
                  userId={user?.id}
                  canApprove={canApprove}
                  busy={busy}
                  onOpen={(task) => void openDetail(task.id)}
                  onQuick={onQuick}
                  onEdit={(task) => setEditTask(task)}
                  onDelete={(task) => setDeleteConfirmTask(task)}
                />
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
              </div>
            ) : (
              <>
                <TaskTable
                  items={data.items}
                  sort={sort}
                  dir={dir}
                  onSort={(column) => {
                    if (sort === column) setDir(dir === 'asc' ? 'desc' : 'asc');
                    else {
                      setSort(column);
                      setDir('asc');
                    }
                    setPage(1);
                  }}
                  userId={user?.id}
                  canApprove={canApprove}
                  busy={busy}
                  onOpen={(task) => void openDetail(task.id)}
                  onQuick={onQuick}
                  onEdit={(task) => setEditTask(task)}
                  onDelete={(task) => setDeleteConfirmTask(task)}
                />
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
              </>
            )}
          </Card>
        </>
      )}

      {/* ------------------------------------------------------------ task details */}
      <Modal
        open={Boolean(detail) || detailLoading}
        onClose={() => setDetail(null)}
        title={detail?.title ?? 'Loading task…'}
        description={detail ? `${detail.taskNo}${slotLabel(detail.timeSlot) ? ` · ${slotLabel(detail.timeSlot)}` : ''}${detail.locationCodes ? ` · ${detail.locationCodes}` : ''}` : undefined}
        size="xl"
        footer={
          detail ? (
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-1.5">
                <button className="btn-ghost btn-sm" onClick={() => setDetail(null)}>Close</button>
                <button
                  type="button"
                  className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-brand-700 hover:bg-brand-50"
                  onClick={() => setEditTask(detail)}
                >
                  <Icon name="edit" size={14} /> Edit Task
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-rose-600 hover:bg-rose-50 border-rose-200"
                  onClick={() => setDeleteConfirmTask(detail)}
                >
                  <Icon name="trash" size={14} /> Delete
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* Employee (assignee) actions */}
                {role.isAssignee && ['assigned', 'not_started', 'rejected'].includes(detail.status) && (
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => void runAction(detail.id, 'accept')}><Icon name="check" size={14} /> Accept task</button>
                )}
                {role.isAssignee && ['accepted', 'overdue'].includes(detail.status) && (
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => void runAction(detail.id, 'start')}><Icon name="play" size={14} /> Start work</button>
                )}
                {role.isAssignee && ['assigned', 'not_started', 'accepted'].includes(detail.status) && (<button className="btn-secondary btn-sm" disabled={busy} onClick={() => void runAction(detail.id, 'reject')}>Reject task</button>)}
                {role.isAssignee && detail.status === 'on_hold' && (
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => void runAction(detail.id, 'resume')}><Icon name="play" size={14} /> Resume</button>
                )}
                {role.isAssignee && ['accepted', 'in_progress'].includes(detail.status) && (
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void runAction(detail.id, 'hold')}><Icon name="pause" size={14} /> Put on hold</button>
                )}
                {role.isAssignee && ['accepted', 'in_progress', 'on_hold'].includes(detail.status) && (
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => openSubmit(detail)}><Icon name="send" size={14} /> Submit for verification</button>
                )}
                {(role.isAssignee || role.isManager) && !['completed', 'verified', 'cancelled', 'escalated'].includes(detail.status) && (
                  <button
                    className="btn-ghost btn-sm text-rose-700 hover:bg-rose-50"
                    disabled={busy}
                    onClick={() =>
                      openReason({
                        action: 'escalate',
                        title: 'Escalate this task',
                        description: 'The allocating manager is notified immediately and the task becomes critical.',
                        label: 'What is blocking the task?',
                        confirm: 'Escalate',
                        danger: true,
                        required: true,
                      })
                    }
                  >
                    <Icon name="alertTriangle" size={14} /> Escalate
                  </button>
                )}

                {/* Manager actions */}
                {role.isManager && detail.status === 'pending_approval' && (
                  <>
                    <button
                      className="btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() =>
                        openReason({
                          action: 'request_changes',
                          title: 'Request a correction',
                          description: 'The task goes back to the assignee as "in progress" with your note.',
                          label: 'What needs to be corrected?',
                          confirm: 'Request correction',
                          required: true,
                        })
                      }
                    >
                      <Icon name="edit" size={14} /> Request correction
                    </button>
                    <button
                      className="btn-secondary btn-sm text-rose-700"
                      disabled={busy}
                      onClick={() =>
                        openReason({
                          action: 'reject',
                          title: 'Reject this submission',
                          description: 'The submission is rejected and the assignee must accept and redo the task.',
                          label: 'Reason for rejection',
                          confirm: 'Reject',
                          danger: true,
                          required: true,
                        })
                      }
                    >
                      <Icon name="x" size={14} /> Reject
                    </button>
                    <button className="btn-sm inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50" disabled={busy} onClick={() => void runAction(detail.id, 'verify')}>
                      <Icon name="checkCircle" size={14} /> Verify & approve
                    </button>
                  </>
                )}
                {role.isManager && ['completed', 'rejected'].includes(detail.status) && (
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void runAction(detail.id, 'reopen')}><Icon name="undo" size={14} /> Reopen</button>
                )}
                {role.isManager && !['completed', 'verified', 'cancelled'].includes(detail.status) && (
                  <button
                    className="btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() =>
                      openReason({
                        action: 'cancel',
                        title: 'Cancel this task',
                        description: 'Cancelled tasks stay in the history but no longer need any work.',
                        label: 'Note (optional)',
                        confirm: 'Cancel task',
                        danger: true,
                        required: false,
                      })
                    }
                  >
                    Cancel task
                  </button>
                )}
              </div>
            </div>
          ) : null
        }
      >
        {detailLoading || !detail ? (
          <Skeleton lines={10} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-5">
              {/* Lifecycle */}
              <ol className="grid grid-cols-5 gap-1.5" aria-label="Task lifecycle">
                {[
                  ['Assigned', 1],
                  ['Accepted', 2],
                  ['In progress', 3],
                  ['Submitted', 4],
                  ['Verified', 5],
                ].map(([label, step]) => {
                  const current =
                    ({ not_started: 1, assigned: 1, overdue: 1, rejected: 1, accepted: 2, in_progress: 3, on_hold: 3, escalated: 3, pending_approval: 4, completed: 5, verified: 5 } as Record<string, number>)[detail.status] ?? 1;
                  const reached = Number(step) < current || (Number(step) === current && current === 5);
                  const isCurrent = Number(step) === current && current !== 5;
                  return (
                    <li key={label} className="min-w-0">
                      <div className={cx('h-1.5 rounded-full', reached ? 'bg-emerald-500' : isCurrent ? 'bg-brand-600' : 'bg-ink-200')} />
                      <p className={cx('mt-1.5 truncate text-[11px] font-medium sm:text-xs', isCurrent ? 'text-brand-700' : reached ? 'text-emerald-700' : 'text-ink-400')}>{label}</p>
                    </li>
                  );
                })}
              </ol>

              {detail.rejectionReason && ['rejected', 'in_progress', 'accepted', 'assigned'].includes(detail.status) && (
                <div className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                  <Icon name="alertTriangle" size={16} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">{detail.status === 'rejected' ? 'Submission rejected' : 'Correction requested'}</p>
                    <p className="mt-0.5">{detail.rejectionReason}</p>
                  </div>
                </div>
              )}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Description</h3>
                <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-ink-700">{detail.description || 'No description provided.'}</p>
              </section>

              {detail.instructions && (
                <section className="rounded-lg border border-brand-100 bg-brand-50 p-3.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-700">Instructions</h3>
                  <p className="mt-1.5 whitespace-pre-line text-sm text-ink-700">{detail.instructions}</p>
                </section>
              )}

              {(detail.requiresEvidence || detail.requiresMetric || (detail.attachments?.length ?? 0) > 0) && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Proof & documents</h3>
                  <div className="mt-2 space-y-2">
                    {detail.requiresEvidence && (
                      <p className="flex items-center gap-2 text-sm text-ink-700">
                        <Icon name="camera" size={15} className="text-brand-600" />
                        Required: <strong className="font-semibold text-ink-900">{titleize(detail.evidenceType || 'photo or document')}</strong>
                        <span className={cx('badge', detail.evidenceFileId || detail.attachments?.length ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700')}>
                          {detail.evidenceFileId || detail.attachments?.length ? 'Uploaded' : 'Not uploaded yet'}
                        </span>
                      </p>
                    )}
                    {detail.requiresMetric && (
                      <p className="flex items-center gap-2 text-sm text-ink-700">
                        <Icon name="chart" size={15} className="text-brand-600" />
                        {detail.metricLabel || 'Value'}:{' '}
                        <strong className="font-semibold text-ink-900">
                          {detail.metricValue !== null && detail.metricValue !== undefined ? `${detail.metricValue} ${detail.metricUnit ?? ''}` : 'not recorded yet'}
                        </strong>
                      </p>
                    )}
                    {(detail.attachments?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {detail.attachments!.map((att) => (
                          <a
                            key={att.id}
                            href={fileUrl(att.file_id, true)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-300 hover:text-brand-700"
                          >
                            <Icon name={att.mime_type?.startsWith('image/') ? 'image' : 'file'} size={14} className="shrink-0 text-brand-600" />
                            <span className="truncate">{att.original_name}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

              <section>
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Progress</h3>
                  <span className="text-sm font-semibold tabular-nums text-ink-900">{detail.progress}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div className={cx('h-full rounded-full', detail.progress === 100 ? 'bg-emerald-500' : 'bg-brand-600')} style={{ width: `${detail.progress}%` }} />
                </div>
                {role.isAssignee && ['accepted', 'in_progress', 'on_hold', 'overdue'].includes(detail.status) && (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-2 sm:w-56">
                      <input type="range" min={0} max={100} step={5} value={progressValue} onChange={(event) => setProgressValue(Number(event.target.value))} className="flex-1" aria-label="Progress" />
                      <span className="w-10 text-right text-sm tabular-nums text-ink-600">{progressValue}%</span>
                    </div>
                    <input className="input h-9 flex-1" placeholder="Progress note (optional)" value={progressNote} onChange={(event) => setProgressNote(event.target.value)} />
                    <button
                      type="button"
                      className="btn-secondary btn-sm h-9"
                      disabled={busy || progressValue === detail.progress}
                      onClick={async () => {
                        if (await runAction(detail.id, 'progress', { progress: progressValue, note: progressNote || undefined })) setProgressNote('');
                      }}
                    >
                      Update
                    </button>
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Checklist {detail.subtasks?.length ? `· ${detail.subtasks.filter((item) => item.isDone).length}/${detail.subtasks.length}` : ''}
                </h3>
                <div className="mt-2 space-y-1.5">
                  {detail.subtasks?.length ? (
                    detail.subtasks.map((subtask) => (
                      <label key={subtask.id} className="flex cursor-pointer items-start gap-2.5 rounded-md border border-ink-200 px-3 py-2 text-sm hover:bg-ink-50">
                        <input
                          type="checkbox"
                          checked={subtask.isDone}
                          disabled={!role.isAssignee && !role.isManager}
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
                </div>
              </section>

              {/* Comments & activity */}
              <section>
                <div className="flex gap-4 border-b border-ink-200" role="tablist">
                  {(
                    [
                      ['comments', `Comments (${detail.comments?.length ?? 0})`],
                      ['activity', `Activity history (${detail.history?.length ?? 0})`],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={detailTab === id}
                      onClick={() => setDetailTab(id)}
                      className={cx('-mb-px border-b-2 pb-2 text-sm font-medium', detailTab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800')}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {detailTab === 'comments' ? (
                  <div className="mt-3 space-y-3">
                    {detail.comments?.length ? (
                      detail.comments.map((entry) => (
                        <div key={entry.id} className="flex gap-2.5">
                          <Avatar name={entry.authorName} size={28} />
                          <div className="min-w-0 flex-1 rounded-lg bg-ink-50 px-3 py-2">
                            <p className="text-xs text-ink-500">
                              <span className="font-semibold text-ink-800">{displayName(entry.authorName)}</span> · {formatDateTime(entry.createdAt)}
                            </p>
                            <p className="mt-0.5 whitespace-pre-line break-words text-sm text-ink-700">{entry.body}</p>
                          </div>
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
                          await api.post(`/tasks/${detail.id}/comments`, { body: comment.trim() });
                          setComment('');
                          await openDetail(detail.id, true);
                        } catch (caught) {
                          toast.error(errorMessage(caught));
                        }
                      }}
                    >
                      <input className="input h-9" placeholder="Write a comment…" value={comment} onChange={(event) => setComment(event.target.value)} aria-label="Comment" />
                      <button type="submit" className="btn-primary btn-sm h-9" disabled={!comment.trim()}>
                        <Icon name="send" size={14} /> Send
                      </button>
                    </form>
                  </div>
                ) : (
                  <ol className="mt-3 space-y-3">
                    {(detail.history?.length ?? 0) === 0 && <li className="text-sm text-ink-500">No recorded actions yet.</li>}
                    {detail.history?.map((entry) => (
                      <li key={entry.id} className="flex gap-2.5 text-sm">
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="text-ink-700">
                            <span className="font-semibold text-ink-900">{entry.actorName ?? 'System'}</span> {ACTION_LABELS[entry.action] ?? titleize(entry.action).toLowerCase()}
                            {entry.status && entry.action !== 'progress' && (
                              <>
                                {' '}→ <StatusBadge status={entry.status} />
                              </>
                            )}
                          </p>
                          {entry.note && <p className="mt-0.5 break-words text-ink-500">“{entry.note}”</p>}
                          <p className="text-xs text-ink-400" title={formatDateTime(entry.createdAt)}>{relativeTime(entry.createdAt)}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            {/* Side panel */}
            <aside className="h-fit space-y-4 rounded-xl border border-ink-200 bg-ink-50 p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={detail.status} />
                <PriorityBadge priority={detail.priority} />
                {detail.verificationStatus && detail.verificationStatus !== 'unverified' && <StatusBadge status={detail.verificationStatus} />}
                {detail.isOverdue && <span className="badge bg-rose-100 text-rose-700">Overdue</span>}
              </div>

              {(role.isAssignee || role.isManager) && !['completed', 'verified', 'cancelled'].includes(detail.status) && (
                <label className="block">
                  <span className="text-xs font-medium text-ink-500">Update status</span>
                  <select className="input mt-1 h-9 py-0 text-sm" value={detail.status} disabled={busy} onChange={(event) => void changeStatus(detail, event.target.value)}>
                    {!statusOptions.some(([value]) => value === detail.status) && (
                      <option value={detail.status} disabled>
                        {titleize(detail.status)}
                      </option>
                    )}
                    {statusOptions.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <dl className="space-y-2.5 text-sm">
                {(
                  [
                    ['Assigned to', displayName(detail.assigneeNames)],
                    ['Allocated by', detail.creatorName ?? '—'],
                    ['Manager', detail.managerName ?? detail.creatorName ?? '—'],
                    ['Store', detail.locationCodes ?? '—'],
                    ['SOP slot', slotLabel(detail.timeSlot) ?? '—'],
                    ['Category', detail.category ?? detail.projectName ?? '—'],
                    ['Created', formatDateTime(detail.createdAt)],
                    ['Due', detail.dueDate ? `${formatDate(detail.dueDate)}${detail.dueTime ? ` · ${detail.dueTime.slice(0, 5)}` : ''}` : '—'],
                    ['Estimated', detail.estimatedMinutes ? minutesToHours(detail.estimatedMinutes) : '—'],
                    ['Time logged', minutesToHours(detail.totalLoggedMinutes ?? 0)],
                    ...(detail.submittedAt ? [['Submitted', formatDateTime(detail.submittedAt)]] : []),
                    ...(detail.approvedAt ? [['Verified', formatDateTime(detail.approvedAt)]] : []),
                    ...(detail.recurrence && detail.recurrence !== 'none' ? [['Repeats', titleize(detail.recurrence)]] : []),
                  ] as [string, string][]
                ).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="shrink-0 text-ink-500">{label}</dt>
                    <dd className="min-w-0 break-words text-right font-medium text-ink-800">{value}</dd>
                  </div>
                ))}
              </dl>

              {(detail.assignments?.length ?? 0) > 0 && (
                <div className="border-t border-ink-200 pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Assignees</p>
                  <ul className="mt-2 space-y-2">
                    {detail.assignments!.map((assignment) => (
                      <li key={assignment.id} className="text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-ink-800">{displayName(assignment.employeeName)}</span>
                          <StatusBadge status={assignment.status} />
                        </div>
                        <p className="text-xs text-ink-500">
                          {assignment.acceptedAt ? `Accepted ${formatDateTime(assignment.acceptedAt)}` : 'Not accepted yet'}
                          {assignment.completedAt ? ` · Finished ${formatDateTime(assignment.completedAt)}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------------ reason dialog */}
      <Modal
        open={Boolean(reasonDialog)}
        onClose={() => setReasonDialog(null)}
        title={reasonDialog?.title ?? ''}
        description={reasonDialog?.description}
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setReasonDialog(null)}>Back</button>
            <button type="submit" form="task-reason-form" className={reasonDialog?.danger ? 'btn-danger' : 'btn-primary'} disabled={busy}>
              {busy ? 'Saving…' : reasonDialog?.confirm}
            </button>
          </>
        }
      >
        <form id="task-reason-form" onSubmit={confirmReason}>
          <Field label={reasonDialog?.label ?? ''} required={reasonDialog?.required}>
            <textarea className="input min-h-[96px]" value={reasonText} onChange={(event) => setReasonText(event.target.value)} autoFocus maxLength={2000} />
          </Field>
        </form>
      </Modal>

      {/* ------------------------------------------------------------ submission */}
      <Modal
        open={Boolean(submitTarget)}
        onClose={() => setSubmitTarget(null)}
        title="Submit for verification"
        description={submitTarget ? `${submitTarget.taskNo} · ${submitTarget.title}` : undefined}
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setSubmitTarget(null)}>Cancel</button>
            <button type="submit" form="submit-verification-form" className="btn-primary" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit for verification'}
            </button>
          </>
        }
      >
        <form id="submit-verification-form" onSubmit={handleSubmit} className="space-y-4">
          <Field label="What was completed" required hint="Your manager sees this note when verifying the task">
            <textarea
              className="input min-h-[96px]"
              placeholder="e.g. Cash tallied and reconciled against the billing report; counter logs cleared."
              value={submitNote}
              onChange={(event) => setSubmitNote(event.target.value)}
              minLength={5}
              required
            />
          </Field>
          {submitTarget?.requiresMetric && (
            <Field label={`${submitTarget.metricLabel ?? 'Value'}${submitTarget.metricUnit ? ` (${submitTarget.metricUnit})` : ''}`} hint="Enter 0 if not applicable">
              <input
                type="number"
                step="any"
                min="0"
                className="input"
                value={submitMetricValue}
                onChange={(event) => setSubmitMetricValue(event.target.value === '' ? '' : Number(event.target.value))}
              />
            </Field>
          )}
          <Field
            label="Proof (photo or document)"
            required={Boolean(submitTarget?.requiresEvidence && !submitTarget?.evidenceFileId)}
            hint={
              submitTarget?.requiresEvidence
                ? submitTarget.evidenceFileId
                  ? 'Proof already uploaded. Add another file only if needed.'
                  : `Required: ${titleize(submitTarget.evidenceType || 'photo or document')}`
                : 'Optional'
            }
          >
            <input
              type="file"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
              className="input py-1.5 text-sm"
              onChange={(event) => setSubmitFile(event.target.files?.[0] ?? null)}
            />
          </Field>
        </form>
      </Modal>

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

      <EditTaskModal
        task={editTask}
        open={Boolean(editTask)}
        assignees={assignees}
        onClose={() => setEditTask(null)}
        onSaved={() => {
          const updatedId = editTask?.id;
          setEditTask(null);
          if (detail && updatedId && detail.id === updatedId) {
            void openDetail(updatedId);
          }
          void reload();
        }}
      />

      <DeleteTaskModal
        task={deleteConfirmTask}
        open={Boolean(deleteConfirmTask)}
        busy={deleteBusy}
        onClose={() => setDeleteConfirmTask(null)}
        onConfirm={handleDeleteTask}
      />

      <PurgeAllTasksModal
        open={purgeAllOpen}
        busy={purgingAll}
        onClose={() => setPurgeAllOpen(false)}
        onConfirm={handlePurgeAll}
      />
    </div>
  );
}

function EditTaskModal({
  task,
  open,
  assignees,
  onClose,
  onSaved,
}: {
  task: TaskSummary | null;
  open: boolean;
  assignees: PickerEmployee[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    timeSlot: 'operations',
    dueDate: '',
    proofRequired: false,
    status: 'assigned',
    assigneeIds: [] as number[],
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (task) {
      setForm({
        title: task.title,
        description: task.description ?? '',
        priority: task.priority,
        timeSlot: task.timeSlot ?? 'operations',
        dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
        proofRequired: Boolean(task.requiresEvidence),
        status: task.status,
        assigneeIds: task.assigneeIds ?? [],
      });
    }
  }, [task]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task) return;
    if (!form.title.trim()) {
      toast.error('Task title is required');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/tasks/${task.id}`, {
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        timeSlot: form.timeSlot,
        dueDate: form.dueDate || undefined,
        proofRequired: form.proofRequired,
        status: form.status,
        assigneeIds: form.assigneeIds,
      });
      toast.success('Task updated successfully');
      onSaved();
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit Task · ${task?.taskNo ?? ''}`}
      description="Update task details, assignment, priority, and SOP schedule."
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Task Title" required>
          <input
            className="input"
            value={form.title}
            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
            required
            placeholder="Actionable task title"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Priority" required>
            <select
              className="input"
              value={form.priority}
              onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value }))}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </Field>

          <Field label="SOP Shift Slot" required>
            <select
              className="input"
              value={form.timeSlot}
              onChange={(e) => setForm((prev) => ({ ...prev, timeSlot: e.target.value }))}
            >
              <option value="morning">Morning SOP (09:30 - 11:00)</option>
              <option value="operations">Store Operations (11:00 - 17:00)</option>
              <option value="evening">Evening Peak (17:00 - 20:00)</option>
              <option value="closing">Night Closing (20:00 - 21:30)</option>
            </select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status" required>
            <select
              className="input"
              value={form.status}
              onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}
            >
              <option value="assigned">Assigned</option>
              <option value="accepted">Accepted</option>
              <option value="in_progress">In Progress</option>
              <option value="on_hold">On Hold</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="completed">Completed / Verified</option>
              <option value="overdue">Overdue</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </Field>

          <Field label="Due Date">
            <input
              type="date"
              className="input"
              value={form.dueDate}
              onChange={(e) => setForm((prev) => ({ ...prev, dueDate: e.target.value }))}
            />
          </Field>
        </div>

        <Field label="Assignees">
          <select
            className="input"
            value={form.assigneeIds[0] ?? ''}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                assigneeIds: e.target.value ? [Number(e.target.value)] : [],
              }))
            }
          >
            <option value="">Select Assignee</option>
            {assignees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.full_name} ({emp.employee_code})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Description">
          <textarea
            className="input min-h-[90px]"
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            rows={3}
            placeholder="Operational guidelines and steps to execute"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary btn-sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteTaskModal({
  task,
  open,
  busy,
  onClose,
  onConfirm,
}: {
  task: TaskSummary | null;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Confirm Delete Task" size="sm">
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Are you sure you want to delete task{' '}
          <strong className="text-ink-900 font-mono">{task?.taskNo}</strong> ({task?.title})?
        </p>
        <p className="text-xs text-rose-600 font-medium">
          This will permanently remove the task allocation, time logs, and subtasks. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary btn-sm bg-rose-600 hover:bg-rose-700 text-white"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete Task'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PurgeAllTasksModal({
  open,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Purge All Tasks Data" size="sm">
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Are you sure you want to remove <strong>all task data</strong> from the project?
        </p>
        <p className="text-xs text-rose-600 font-medium">
          This will permanently delete all task records, assignments, comments, attachments, time logs, and daily SOP checkpoints. The task list will be completely reset to 0. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary btn-sm bg-rose-600 hover:bg-rose-700 text-white"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Purging…' : 'Purge All Tasks'}
          </button>
        </div>
      </div>
    </Modal>
  );
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
  const { user } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    timeSlot: 'operations',
    dueDate: '',
    dueTime: '18:30',
    estimatedMinutes: 120,
    projectId: '',
    category: 'Retail Store Ops',
    recurrence: 'none',
    instructions: '',
    subtasks: '',
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-select current employee and initialize today's date on open
  useEffect(() => {
    if (open) {
      if (!form.dueDate) {
        setForm((prev) => ({ ...prev, dueDate: new Date().toISOString().slice(0, 10) }));
      }
      if (selected.length === 0) {
        if (user?.id && assignees.some((e) => e.id === user.id)) {
          setSelected([user.id]);
        } else if (assignees.length > 0) {
          setSelected([assignees[0].id]);
        }
      }
    }
  }, [open, assignees, form.dueDate, selected.length, user?.id]);

  const term = assigneeSearch.trim().toLowerCase();
  const filteredAssignees = term
    ? assignees.filter((employee) =>
        [employee.full_name, employee.employee_code, employee.designation_title, employee.department_name]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term)),
      )
    : assignees;

  const allFilteredSelected = filteredAssignees.length > 0 && filteredAssignees.every((employee) => selected.includes(employee.id));
  const toggleFiltered = () => {
    const ids = filteredAssignees.map((employee) => employee.id);
    setSelected((previous) =>
      allFilteredSelected ? previous.filter((id) => !ids.includes(id)) : [...new Set([...previous, ...ids])],
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selected.length === 0) {
      toast.error('Select at least one authorized employee to allocate this task to.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/tasks', {
        title: form.title,
        description: form.description || undefined,
        priority: form.priority,
        timeSlot: form.timeSlot,
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
      toast.success('Task allocated and assignee notified.');
      setForm({ ...form, title: '', description: '', instructions: '', subtasks: '' });
      setSelected([]);
      setAssigneeSearch('');
      onCreated();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const timeSlots = [
    { id: 'morning', label: 'Morning Slot', hours: '09:30 - 11:00 AM', icon: 'clock', desc: 'Opening, counter setup & cash float' },
    { id: 'operations', label: 'Store Operations', hours: '11:00 AM - 05:00 PM', icon: 'building', desc: 'Active floor, customer service & sales' },
    { id: 'evening', label: 'Evening Slot', hours: '05:00 - 08:00 PM', icon: 'activity', desc: 'Peak footfall, restock & register' },
    { id: 'closing', label: 'Night Closing', hours: '08:00 - 09:30 PM', icon: 'lock', desc: 'Day-end tally, security & closing' },
  ];

  const priorities = [
    { id: 'low', label: 'Low', badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    { id: 'medium', label: 'Medium', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
    { id: 'high', label: 'High', badgeClass: 'bg-orange-50 text-orange-700 border-orange-200' },
    { id: 'critical', label: 'Urgent', badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  ];

  const durationPresets = [30, 60, 120, 180, 240];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Allocate Work Session Task"
      description="Create, schedule and allocate workforce tasks directly to authorized personnel."
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="text-xs text-ink-500">
            {selected.length === 1 ? '1 team member assigned' : `${selected.length} team members assigned`}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" form="create-task-form" className="btn-primary inline-flex items-center gap-2" disabled={submitting}>
              <Icon name="check" size={16} />
              <span>{submitting ? 'Allocating task…' : 'Allocate task'}</span>
            </button>
          </div>
        </div>
      }
    >
      <form id="create-task-form" onSubmit={submit} className="space-y-5">
        {/* Card 1: Task Information */}
        <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-ink-100 pb-2">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700">1</span>
              <p className="text-sm font-bold text-ink-900">Task Information & Deliverables</p>
            </div>
            <span className="text-xs text-ink-400">Core requirements</span>
          </div>

          <Field label="Task title" hint="Clear, actionable title for the employee" required>
            <input
              className="input font-medium text-ink-900"
              placeholder="e.g. Daily Store Opening Checklist & Register Setup"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              minLength={3}
              required
            />
          </Field>

          <Field label="Description">
            <textarea
              className="input min-h-[74px] text-sm"
              placeholder="Specify the background, required standards, and key objectives for this work session..."
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>

          <Field label="Action Checklist / Subtasks" hint="Optional: enter checklist milestones (one per line)">
            <textarea
              className="input font-mono text-xs min-h-[64px]"
              placeholder="Inspect storefront visual displays&#10;Verify cash float reconciliation&#10;Submit opening checkpoint report"
              value={form.subtasks}
              onChange={(event) => setForm({ ...form, subtasks: event.target.value })}
            />
          </Field>
        </div>

        {/* Card 2: SOP Timing, Priority & Duration */}
        <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-ink-100 pb-2">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700">2</span>
              <p className="text-sm font-bold text-ink-900">SOP Time Slot & Priority</p>
            </div>
            <span className="text-xs text-ink-400">Schedule & timing</span>
          </div>

          <div>
            <label className="label mb-2">Select SOP Time Slot</label>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {timeSlots.map((slot) => {
                const isSelected = form.timeSlot === slot.id;
                return (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => setForm({ ...form, timeSlot: slot.id })}
                    className={`flex flex-col rounded-lg border p-3 text-left transition-all ${
                      isSelected
                        ? 'border-brand-600 bg-brand-50/70 shadow-xs ring-1 ring-brand-600'
                        : 'border-ink-200 bg-white hover:border-brand-300 hover:bg-brand-50/20'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={cx(
                        'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                        isSelected ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                      )}>
                        <Icon name={slot.icon} size={15} />
                      </span>
                      {isSelected && (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-white">
                          <Icon name="check" size={10} />
                        </span>
                      )}
                    </div>
                    <p className={`mt-1.5 text-xs font-bold ${isSelected ? 'text-brand-900' : 'text-ink-800'}`}>
                      {slot.label}
                    </p>
                    <p className="text-[11px] font-medium text-ink-500 font-mono">{slot.hours}</p>
                    <p className="mt-1 text-[10px] text-ink-400 line-clamp-1">{slot.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="label mb-2">Priority Level</label>
            <div className="flex flex-wrap gap-2">
              {priorities.map((p) => {
                const isSelected = form.priority === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setForm({ ...form, priority: p.id })}
                    className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1 text-xs font-semibold transition-all ${
                      isSelected
                        ? `${p.badgeClass} ring-2 ring-brand-500 ring-offset-1 shadow-2xs`
                        : 'border-ink-200 bg-white text-ink-600 hover:border-ink-300'
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${isSelected ? 'bg-current' : 'bg-ink-300'}`} />
                    <span>{p.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Due date" required>
              <input
                type="date"
                className="input"
                value={form.dueDate}
                onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
                required
              />
            </Field>

            <Field label="Due time">
              <input
                type="time"
                className="input"
                value={form.dueTime}
                onChange={(event) => setForm({ ...form, dueTime: event.target.value })}
              />
            </Field>

            <div>
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
              <div className="mt-1.5 flex flex-wrap gap-1">
                {durationPresets.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setForm({ ...form, estimatedMinutes: m })}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                      form.estimatedMinutes === m ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                    }`}
                  >
                    {m}m
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Project & Classification */}
        <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-ink-100 pb-2">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700">3</span>
              <p className="text-sm font-bold text-ink-900">Project, Category & Recurrence</p>
            </div>
            <span className="text-xs text-ink-400">Classification</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Category">
              <input
                className="input"
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.target.value })}
                placeholder="Retail Store Ops"
              />
            </Field>

            <Field label="Linked Project">
              <select className="input" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
                <option value="">No linked project</option>
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
        </div>

        {/* Card 4: Assignee Allocation */}
        <div className="rounded-xl border border-brand-200 bg-white p-4 shadow-2xs space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 pb-2">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">4</span>
              <p className="text-sm font-bold text-ink-900">Authorized Assignee</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700 border border-brand-200">
                {selected.length} employee selected
              </span>
              {filteredAssignees.length > 1 && (
                <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={toggleFiltered}>
                  {allFilteredSelected ? 'Unselect all' : 'Select all'}
                </button>
              )}
            </div>
          </div>

          <div className="relative">
            <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="input py-2 pl-9 pr-9 text-sm"
              value={assigneeSearch}
              onChange={(event) => setAssigneeSearch(event.target.value)}
              placeholder="Search employee by name, ID or role…"
              aria-label="Search assignees"
            />
            {assigneeSearch && (
              <button
                type="button"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                onClick={() => setAssigneeSearch('')}
                aria-label="Clear assignee search"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          <div className="space-y-2">
            {filteredAssignees.length === 0 ? (
              <p className="p-3 text-center text-xs text-ink-500">No matching employee found.</p>
            ) : (
              filteredAssignees.map((employee) => {
                const isChecked = selected.includes(employee.id);
                return (
                  <button
                    key={employee.id}
                    type="button"
                    onClick={() => {
                      setSelected((prev) =>
                        isChecked ? prev.filter((id) => id !== employee.id) : [...prev, employee.id],
                      );
                    }}
                    className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition-all ${
                      isChecked
                        ? 'border-brand-600 bg-brand-50/60 shadow-2xs ring-1 ring-brand-500'
                        : 'border-ink-200 bg-white hover:border-brand-300 hover:bg-ink-50/50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Avatar name={employee.full_name} size={40} />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-ink-900">{employee.full_name}</p>
                          {employee.employee_code && (
                            <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-mono font-medium text-ink-600">
                              {employee.employee_code}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-500">
                          {employee.designation_title ?? 'Store Manager'}
                          {employee.department_name ? ` · ${employee.department_name}` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-md border transition-colors ${
                          isChecked ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-300 bg-white'
                        }`}
                      >
                        {isChecked && <Icon name="check" size={13} />}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-xs text-ink-500">Allocated to:</span>
              {selected.map((id) => {
                const employee = assignees.find((item: PickerEmployee) => item.id === id);
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 shadow-2xs"
                  >
                    <span>{employee?.full_name ?? `Employee #${id}`}</span>
                    <button
                      type="button"
                      className="rounded-full p-0.5 hover:bg-brand-200/60"
                      onClick={() => setSelected((prev) => prev.filter((value) => value !== id))}
                      aria-label="Remove"
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Card 5: Operational Instructions */}
        <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs">
          <Field label="Special Operational Instructions" hint="Optional compliance notes, SOP safety guidelines, or manager remarks">
            <textarea
              className="input min-h-[64px] text-sm"
              placeholder="e.g. Ensure physical verification of high-value garments before closing the checkout counter..."
              value={form.instructions}
              onChange={(event) => setForm({ ...form, instructions: event.target.value })}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
