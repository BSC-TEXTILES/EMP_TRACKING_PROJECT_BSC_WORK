import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadReport, errorMessage, fileUrl } from '../lib/api';
import { useApi, useDebounced, useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, PriorityBadge, ProgressBar, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDate, formatDateTime, minutesToHours, titleize } from '../lib/format';
import type { PickerEmployee, ProjectSummary, TaskSummary } from '../lib/types';

interface TaskListResponse {
  items: TaskSummary[];
  total: number;
  page: number;
  pageSize: number;
}

interface TimelineCheckpoint {
  id?: number;
  timeSlot: string;
  label: string;
  hours: string;
  status: 'pending' | 'submitted' | 'verified';
  summary: string | null;
  issuesIdentified: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
}

interface PerformanceScore {
  taskScore: number;
  timelyScore: number;
  qualityScore: number;
  reportingScore: number;
  attendanceScore: number;
  coordinationScore: number;
  escalationScore: number;
  totalScore: number;
  rating: string;
}

export default function Tasks() {
  useDocumentTitle('Tasks & SOP Management');
  const { user, has, canAny } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [activeMainTab, setActiveMainTab] = useState<'tasks' | 'timeline' | 'performance'>('tasks');
  const view = params.get('view') ?? 'mine';
  const status = params.get('status') ?? '';
  const timeSlot = params.get('timeSlot') ?? '';
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
  const [busy, setBusy] = useState(false);
  const [generatingDaily, setGeneratingDaily] = useState(false);

  // Submit modal state
  const [submitModalOpen, setSubmitModalOpen] = useState(false);
  const [submitNote, setSubmitNote] = useState('');
  const [submitMetricValue, setSubmitMetricValue] = useState<number | ''>('');
  const [submitFile, setSubmitFile] = useState<File | null>(null);
  const [submittingVerification, setSubmittingVerification] = useState(false);

  // Timeline checkpoints state
  const [checkpoints, setCheckpoints] = useState<TimelineCheckpoint[]>([]);
  const [loadingTimeline, setLoadingTimeline] = useState(false);
  const [checkpointModalOpen, setCheckpointModalOpen] = useState(false);
  const [activeCheckpoint, setActiveCheckpoint] = useState<TimelineCheckpoint | null>(null);
  const [checkpointSummary, setCheckpointSummary] = useState('');
  const [checkpointIssues, setCheckpointIssues] = useState('');
  const [checkpointEscalate, setCheckpointEscalate] = useState(false);
  const [submittingCheckpoint, setSubmittingCheckpoint] = useState(false);

  // Performance score state
  const [performance, setPerformance] = useState<PerformanceScore | null>(null);
  const [loadingPerformance, setLoadingPerformance] = useState(false);

  const query = new URLSearchParams();
  if (view !== 'all') query.set('view', view);
  if (status) query.set('status', status);
  if (priority) query.set('priority', priority);
  if (timeSlot) query.set('timeSlot', timeSlot);
  if (overdue) query.set('overdue', 'true');
  if (debouncedSearch) query.set('search', debouncedSearch);
  query.set('page', String(page));
  query.set('pageSize', '15');

  const { data, loading, reload } = useApi<TaskListResponse>(`/tasks?${query.toString()}`, [
    view,
    status,
    priority,
    timeSlot,
    overdue,
    debouncedSearch,
    page,
  ]);
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

  const loadTimeline = async () => {
    setLoadingTimeline(true);
    try {
      const res = await api.get<{ checkpoints: TimelineCheckpoint[] }>('/tasks/timeline');
      setCheckpoints(res.checkpoints);
    } catch {
      // ignore
    } finally {
      setLoadingTimeline(false);
    }
  };

  const loadPerformance = async () => {
    setLoadingPerformance(true);
    try {
      const res = await api.get<PerformanceScore>('/tasks/performance');
      setPerformance(res);
    } catch {
      // ignore
    } finally {
      setLoadingPerformance(false);
    }
  };

  useEffect(() => {
    if (activeMainTab === 'timeline') void loadTimeline();
    if (activeMainTab === 'performance') void loadPerformance();
  }, [activeMainTab]);

  useSocketEvent('task:updated', () => {
    void reload();
    if (detail) void openDetail(detail.id, true);
    if (activeMainTab === 'timeline') void loadTimeline();
    if (activeMainTab === 'performance') void loadPerformance();
  });
  useSocketEvent('task:created', () => void reload());

  const openDetail = async (id: number, silent = false) => {
    if (!silent) setDetailLoading(true);
    try {
      const result = await api.get<TaskSummary>(`/tasks/${id}`);
      setDetail(result);
      setProgressValue(result.progress);
      setSubmitMetricValue(result.metricValue ?? '');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDetailLoading(false);
    }
  };

  const [targetTaskId, setTargetTaskId] = useState<number | null>(null);
  const autoGeneratedRef = useRef(false);

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
      toast.success(
        action === 'accept'
          ? 'Task accepted! Ready to begin.'
          : action === 'start'
          ? 'Work started on task.'
          : action === 'verify'
          ? 'Task verified & approved!'
          : action === 'progress'
          ? 'Progress updated.'
          : 'Task updated successfully.',
      );
      await openDetail(detail.id, true);
      await reload();
      if (activeMainTab === 'performance') void loadPerformance();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const actOnTask = async (taskId: number, action: string, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      await api.post(`/tasks/${taskId}/action`, { action, ...payload });
      toast.success(
        action === 'accept'
          ? 'Task accepted! Status updated.'
          : action === 'start'
          ? 'Work started! Timer is running.'
          : action === 'verify'
          ? 'Task verified & approved!'
          : 'Task updated successfully.',
      );
      await reload();
      if (detail && detail.id === taskId) {
        await openDetail(taskId, true);
      }
      if (activeMainTab === 'performance') void loadPerformance();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const openSubmitModalForTask = (task: { id: number; metricValue?: number | null }) => {
    setTargetTaskId(task.id);
    void openDetail(task.id);
    setSubmitModalOpen(true);
    setSubmitNote('');
    setSubmitMetricValue(task.metricValue ?? '');
    setSubmitFile(null);
  };

  const handleGenerateDailyTasks = async () => {
    setGeneratingDaily(true);
    try {
      const res = await api.post<{ created: number; existing: number }>('/tasks/daily/generate', {});
      if (res.created > 0) {
        toast.success(`Generated ${res.created} daily SOP tasks for today!`);
      } else {
        toast.info(`Today's SOP tasks (${res.existing}) are already generated.`);
      }
      await reload();
      if (activeMainTab === 'performance') void loadPerformance();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setGeneratingDaily(false);
    }
  };

  // Auto-generate on load if empty on the "Assigned to me" view
  useEffect(() => {
    if (data && data.total === 0 && view === 'mine' && !autoGeneratedRef.current && !loading) {
      autoGeneratedRef.current = true;
      void handleGenerateDailyTasks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, view, loading]);

  const handleSubmitVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    const effectiveTaskId = detail?.id ?? targetTaskId;
    if (!effectiveTaskId) return;
    if (!submitNote.trim() || submitNote.trim().length < 5) {
      toast.error('Please describe the work completed (min 5 characters).');
      return;
    }

    setSubmittingVerification(true);
    try {
      let fileId: number | undefined;
      if (submitFile) {
        const uploaded = await api.uploadFile(submitFile);
        fileId = uploaded.id;
      }

      await api.post(`/tasks/${effectiveTaskId}/action`, {
        action: 'submit',
        completionNote: submitNote.trim(),
        metricValue: submitMetricValue !== '' ? Number(submitMetricValue) : undefined,
        evidenceFileId: fileId,
      });

      toast.success('Task submitted for manager verification.');
      setSubmitModalOpen(false);
      setSubmitNote('');
      setSubmitFile(null);
      setTargetTaskId(null);
      if (detail) {
        await openDetail(detail.id, true);
      }
      await reload();
      if (activeMainTab === 'performance') void loadPerformance();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmittingVerification(false);
    }
  };

  const handleSaveCheckpoint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCheckpoint) return;
    if (!checkpointSummary.trim()) {
      toast.error('Summary of operational activity is required.');
      return;
    }

    setSubmittingCheckpoint(true);
    try {
      await api.post('/tasks/timeline', {
        timeSlot: activeCheckpoint.timeSlot,
        summary: checkpointSummary.trim(),
        issues: checkpointIssues.trim() || undefined,
        escalatedTo: checkpointEscalate && user?.managerId ? user.managerId : undefined,
      });

      toast.success('Activity checkpoint submitted.');
      setCheckpointModalOpen(false);
      await loadTimeline();
      if (activeMainTab === 'performance') void loadPerformance();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmittingCheckpoint(false);
    }
  };

  const isAssignee = detail?.assigneeIds.includes(user?.id ?? -1) ?? false;
  const isManager = detail ? detail.createdBy === user?.id || detail.managerName === user?.fullName || has('tasks.approve') : false;

  const renderSlotBadge = (slot?: string | null) => {
    if (!slot) return null;
    const map: Record<string, { label: string; tone: string }> = {
      morning: { label: 'Morning', tone: 'warning' },
      operations: { label: 'Store Ops', tone: 'brand' },
      evening: { label: 'Evening', tone: 'info' },
      closing: { label: 'Night Closing', tone: 'neutral' },
    };
    const s = map[slot] || { label: titleize(slot), tone: 'neutral' };
    return <Badge tone={s.tone}>{s.label}</Badge>;
  };

  const renderVerificationBadge = (vStatus?: string | null) => {
    if (vStatus === 'verified') return <Badge tone="success">✓ Verified</Badge>;
    if (vStatus === 'rejected') return <Badge tone="danger">✗ Rejected</Badge>;
    if (vStatus === 'escalated') return <Badge tone="danger">⚠ Escalated</Badge>;
    return <Badge tone="neutral">Unverified</Badge>;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Store SOP & Daily Task Tracking"
        description="Role-based daily task allocation, activity timeline checkpoints, and verified performance monitoring for Davanagere, Shivamogga & Belagavi."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={generatingDaily}
              onClick={handleGenerateDailyTasks}
              title="Generate today's pre-assigned tasks based on your role"
            >
              <Icon name="refresh" size={14} className={generatingDaily ? 'animate-spin' : ''} />
              {generatingDaily ? 'Generating…' : "Generate Today's Tasks"}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'tasks', format: 'xlsx' })}>
              Export
            </button>
            {has('tasks.create') && (
              <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={15} /> Allocate task
              </button>
            )}
          </div>
        }
      />

      {/* Main Mode Tabs */}
      <div className="flex border-b border-ink-200">
        <button
          type="button"
          onClick={() => setActiveMainTab('tasks')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
            activeMainTab === 'tasks' ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800'
          }`}
        >
          <Icon name="tasks" size={16} />
          Daily Tasks & SOP
        </button>
        <button
          type="button"
          onClick={() => setActiveMainTab('timeline')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
            activeMainTab === 'timeline' ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800'
          }`}
        >
          <Icon name="clock" size={16} />
          Activity Timeline (7 Checkpoints)
        </button>
        <button
          type="button"
          onClick={() => setActiveMainTab('performance')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
            activeMainTab === 'performance' ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800'
          }`}
        >
          <Icon name="kpi" size={16} />
          100-Point Performance Score
        </button>
      </div>

      {activeMainTab === 'tasks' && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 pt-2">
            <Tabs
              tabs={[
                { value: 'mine', label: 'Assigned to me' },
                { value: 'allocated', label: 'Allocated by me' },
                { value: 'all', label: 'All store tasks' },
              ]}
              value={view}
              onChange={(value) => {
                setPage(1);
                setParams(value === 'mine' ? {} : { view: value });
              }}
            />

            {/* Time Slot Filter Pills */}
            <div className="flex flex-wrap items-center gap-1.5 py-1 text-xs">
              <span className="font-medium text-ink-500">SOP Slot:</span>
              {[
                { id: '', label: 'All' },
                { id: 'morning', label: '🌅 Morning (9:30-11)' },
                { id: 'operations', label: '🏬 Operations (11-5)' },
                { id: 'evening', label: '🌇 Evening (5-8)' },
                { id: 'closing', label: '🔒 Closing (8-9:30)' },
              ].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    if (s.id) next.set('timeSlot', s.id);
                    else next.delete('timeSlot');
                    setParams(next);
                    setPage(1);
                  }}
                  className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
                    timeSlot === s.id
                      ? 'bg-brand-600 text-white'
                      : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Visual Store SOP Daily Operational Pipeline */}
          <div className="border-b border-ink-100 bg-gradient-to-r from-slate-50 via-brand-50/20 to-slate-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-bold uppercase tracking-wider text-ink-700">Daily Store SOP Operational Pipeline</span>
                <span className="hidden text-xs text-ink-400 sm:inline">· Click a shift slot to filter tasks & track progress</span>
              </div>
              <span className="text-xs font-medium text-brand-700 bg-brand-50 px-2 py-0.5 rounded border border-brand-200">
                Belagavi · Davanagere · Shivamogga
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {[
                { id: 'morning', label: 'Morning SOP', hours: '09:30 – 11:00 AM', emoji: '🌅', desc: 'Opening float, safe lock, sales check, staff briefing' },
                { id: 'operations', label: 'Store Operations', hours: '11:00 AM – 05:00 PM', emoji: '🏬', desc: 'Floor walk, sales monitoring, CRM feedback' },
                { id: 'evening', label: 'Evening Peak', hours: '05:00 – 08:00 PM', emoji: '🌇', desc: 'Cash sweep, rush queue control, midday sweep' },
                { id: 'closing', label: 'Night Closing', hours: '08:00 – 09:30 PM', emoji: '🔒', desc: 'Cash reconciliation, safe lockdown, checkout report' },
              ].map((slot) => {
                const isSelected = timeSlot === slot.id;
                const slotTasks = data?.items.filter((t) => t.timeSlot === slot.id) ?? [];
                const doneCount = slotTasks.filter((t) => ['completed', 'verified'].includes(t.status)).length;
                return (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      if (isSelected) next.delete('timeSlot');
                      else next.set('timeSlot', slot.id);
                      setParams(next);
                      setPage(1);
                    }}
                    className={`flex flex-col justify-between rounded-xl border p-3 text-left transition-all ${
                      isSelected
                        ? 'border-brand-600 bg-white ring-2 ring-brand-500/20 shadow-sm'
                        : 'border-ink-200/80 bg-white/70 hover:border-brand-300 hover:bg-white'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-ink-900 flex items-center gap-1.5">
                          <span>{slot.emoji}</span>
                          <span>{slot.label}</span>
                        </span>
                        {slotTasks.length > 0 && (
                          <span className={`text-[11px] font-semibold px-1.5 py-0.2 rounded-full ${
                            doneCount === slotTasks.length && slotTasks.length > 0
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-brand-50 text-brand-700'
                          }`}>
                            {doneCount}/{slotTasks.length} Done
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] font-medium text-brand-600">{slot.hours}</p>
                      <p className="mt-1 line-clamp-1 text-[11px] text-ink-400">{slot.desc}</p>
                    </div>
                    {slotTasks.length > 0 && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                        <div
                          className="h-full bg-brand-600 transition-all"
                          style={{ width: `${(doneCount / slotTasks.length) * 100}%` }}
                        />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
            <div className="relative min-w-[200px] flex-1">
              <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                className="input pl-9"
                placeholder="Search title, task number, SOP keyword…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <select className="input w-auto" value={status} onChange={(event) => setStatusParam(event.target.value)}>
              <option value="">All statuses</option>
              {['assigned', 'accepted', 'in_progress', 'on_hold', 'pending_approval', 'completed', 'rejected', 'escalated', 'overdue', 'cancelled'].map((value) => (
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
              description="Click 'Generate Today\'s Tasks' to load your daily SOP routines or allocate a custom task."
              action={
                <div className="flex gap-2">
                  <button className="btn-secondary btn-sm" onClick={handleGenerateDailyTasks}>
                    Generate Today's Tasks
                  </button>
                  {has('tasks.create') && (
                    <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                      Allocate task
                    </button>
                  )}
                </div>
              }
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Task & Requirements</th>
                      <th>Slot</th>
                      <th>Assignees</th>
                      <th>Priority</th>
                      <th>Status & Verification</th>
                      <th>Due</th>
                      <th className="w-28">Progress</th>
                      <th className="w-48 text-right">Quick Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((task) => (
                      <tr key={task.id} className="cursor-pointer hover:bg-ink-50/70" onClick={() => void openDetail(task.id)}>
                        <td>
                          <div className="space-y-1">
                            <p className="font-medium text-ink-800">{task.title}</p>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
                              <span className="font-mono text-ink-500">{task.taskNo}</span>
                              {task.projectName && <span>· {task.projectName}</span>}
                              {task.requiresEvidence && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-brand-50 px-1.5 py-0.2 text-[11px] font-medium text-brand-700">
                                  Proof Req.
                                </span>
                              )}
                              {task.requiresMetric && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.2 text-[11px] font-medium text-amber-700">
                                  {task.metricLabel ?? 'Metric'}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>{renderSlotBadge(task.timeSlot)}</td>
                        <td className="text-ink-600">{task.assigneeNames ?? '—'}</td>
                        <td><PriorityBadge priority={task.priority} /></td>
                        <td>
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge status={task.status} />
                            {renderVerificationBadge(task.verificationStatus)}
                            {task.isOverdue && task.status !== 'overdue' && <Badge tone="danger">Overdue</Badge>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-xs text-ink-600">
                          {formatDate(task.dueDate)} {task.dueTime ? `(${task.dueTime.slice(0, 5)})` : ''}
                        </td>
                        <td>
                          <ProgressBar value={task.progress} tone={task.progress === 100 ? 'success' : 'brand'} />
                        </td>
                        <td onClick={(e) => e.stopPropagation()} className="whitespace-nowrap text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {['assigned', 'not_started', 'on_hold', 'rejected'].includes(task.status) && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void actOnTask(task.id, 'accept')}
                                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                                title="Accept this SOP task"
                              >
                                <Icon name="check" size={12} />
                                Accept
                              </button>
                            )}
                            {task.status === 'accepted' && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void actOnTask(task.id, 'start')}
                                className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                                title="Start work on this task"
                              >
                                <Icon name="play" size={12} />
                                Start Work
                              </button>
                            )}
                            {task.status === 'in_progress' && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => openSubmitModalForTask(task)}
                                className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                                title="Submit work for verification"
                              >
                                <Icon name="upload" size={12} />
                                Submit
                              </button>
                            )}
                            {task.status === 'pending_approval' && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void actOnTask(task.id, 'verify')}
                                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                                title="Verify and approve this task"
                              >
                                <Icon name="check" size={12} />
                                Verify
                              </button>
                            )}
                            {task.status === 'completed' && (
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600">
                                <Icon name="check" size={14} />
                                Done
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => void openDetail(task.id)}
                              className="rounded border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50"
                              title="Open task detail drawer"
                            >
                              Details
                            </button>
                          </div>
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
      )}

      {/* Activity Timeline View */}
      {activeMainTab === 'timeline' && (
        <Card>
          <div className="flex items-center justify-between border-b border-ink-100 px-6 py-4">
            <div>
              <h3 className="text-base font-semibold text-ink-900">Daily Store Activity Checkpoints</h3>
              <p className="text-xs text-ink-500">Track and submit progress updates throughout store operating hours (09:30 AM – 09:30 PM).</p>
            </div>
            <button type="button" className="btn-secondary btn-sm" onClick={loadTimeline}>
              <Icon name="refresh" size={14} className={loadingTimeline ? 'animate-spin' : ''} />
              Refresh Checkpoints
            </button>
          </div>

          <div className="divide-y divide-ink-100 p-6">
            {checkpoints.map((cp, idx) => (
              <div key={cp.timeSlot} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                      {idx + 1}
                    </span>
                    <h4 className="font-semibold text-ink-900">{cp.label}</h4>
                    <span className="rounded bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">{cp.hours}</span>
                    {cp.status === 'verified' && <Badge tone="success">Verified</Badge>}
                    {cp.status === 'submitted' && <Badge tone="info">Submitted</Badge>}
                    {cp.status === 'pending' && <Badge tone="neutral">Pending</Badge>}
                  </div>

                  {cp.summary && (
                    <p className="pl-8 text-sm text-ink-700">
                      <span className="font-medium text-ink-900">Summary: </span>
                      {cp.summary}
                    </p>
                  )}
                  {cp.issuesIdentified && (
                    <p className="pl-8 text-sm text-rose-600">
                      <span className="font-medium">Reported Issues: </span>
                      {cp.issuesIdentified}
                    </p>
                  )}
                  {cp.submittedAt && (
                    <p className="pl-8 text-xs text-ink-400">
                      Submitted: {formatDateTime(cp.submittedAt)}
                    </p>
                  )}
                </div>

                <div className="pl-8 sm:pl-0">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setActiveCheckpoint(cp);
                      setCheckpointSummary(cp.summary || '');
                      setCheckpointIssues(cp.issuesIdentified || '');
                      setCheckpointEscalate(false);
                      setCheckpointModalOpen(true);
                    }}
                  >
                    {cp.status === 'pending' ? 'Submit Checkpoint' : 'Update Checkpoint'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 100-Point Performance View */}
      {activeMainTab === 'performance' && (
        <div className="space-y-5">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-100 px-6 py-4">
              <div>
                <h3 className="text-base font-semibold text-ink-900">100-Point Daily Performance Evaluation</h3>
                <p className="text-xs text-ink-500">Based on task completion, timeliness, audit quality, attendance & escalation discipline.</p>
              </div>
              <button type="button" className="btn-secondary btn-sm" onClick={loadPerformance}>
                <Icon name="refresh" size={14} className={loadingPerformance ? 'animate-spin' : ''} />
                Recalculate
              </button>
            </div>

            {loadingPerformance && !performance ? (
              <div className="p-6">
                <Skeleton lines={6} />
              </div>
            ) : performance ? (
              <div className="p-6">
                <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-gradient-to-r from-brand-50 to-brand-100/60 p-5">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Overall Daily Score</p>
                    <p className="text-3xl font-extrabold text-ink-900">
                      {performance.totalScore.toFixed(1)} <span className="text-base font-medium text-ink-500">/ 100</span>
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-500">Daily Rating</p>
                    <span
                      className={`inline-block rounded-full px-4 py-1 text-sm font-bold ${
                        performance.totalScore >= 90
                          ? 'bg-emerald-600 text-white'
                          : performance.totalScore >= 80
                          ? 'bg-brand-600 text-white'
                          : performance.totalScore >= 70
                          ? 'bg-amber-500 text-white'
                          : 'bg-rose-600 text-white'
                      }`}
                    >
                      {performance.rating}
                    </span>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="rounded-lg border border-ink-200 p-4">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Task Completion</span>
                      <span className="text-brand-700">{performance.taskScore} / 30 pts</span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={(performance.taskScore / 30) * 100} />
                    </div>
                    <p className="mt-1 text-xs text-ink-400">All mandatory SOP tasks verified</p>
                  </div>

                  <div className="rounded-lg border border-ink-200 p-4">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Timely Completion</span>
                      <span className="text-brand-700">{performance.timelyScore} / 15 pts</span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={(performance.timelyScore / 15) * 100} />
                    </div>
                    <p className="mt-1 text-xs text-ink-400">Submitted within SOP shift deadlines</p>
                  </div>

                  <div className="rounded-lg border border-ink-200 p-4">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Quality & Accuracy</span>
                      <span className="text-brand-700">{performance.qualityScore} / 20 pts</span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={(performance.qualityScore / 20) * 100} />
                    </div>
                    <p className="mt-1 text-xs text-ink-400">Free from rejections or errors</p>
                  </div>

                  <div className="rounded-lg border border-ink-200 p-4">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Reporting & Documentation</span>
                      <span className="text-brand-700">{performance.reportingScore} / 10 pts</span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={(performance.reportingScore / 10) * 100} />
                    </div>
                    <p className="mt-1 text-xs text-ink-400">Submitted proof & activity checkpoints</p>
                  </div>

                  <div className="rounded-lg border border-ink-200 p-4">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Attendance & Punctuality</span>
                      <span className="text-brand-700">{performance.attendanceScore} / 10 pts</span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={(performance.attendanceScore / 10) * 100} />
                    </div>
                    <p className="mt-1 text-xs text-ink-400">On-time checkin & shift completion</p>
                  </div>

                  <div className="rounded-lg border border-ink-200 p-4">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Team Coordination</span>
                      <span className="text-brand-700">{performance.coordinationScore} / 10 pts</span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={(performance.coordinationScore / 10) * 100} />
                    </div>
                    <p className="mt-1 text-xs text-ink-400">Briefing attendance & cross-floor sync</p>
                  </div>

                  <div className="rounded-lg border border-ink-200 p-4 sm:col-span-2 lg:col-span-1">
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Escalation Discipline</span>
                      <span className="text-brand-700">{performance.escalationScore} / 5 pts</span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar value={(performance.escalationScore / 5) * 100} />
                    </div>
                    <p className="mt-1 text-xs text-ink-400">Timely logging and resolution of blockers</p>
                  </div>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      )}

      {/* Task Detail Modal */}
      <Modal
        open={Boolean(detail) || detailLoading}
        onClose={() => setDetail(null)}
        title={detail?.title ?? 'Loading task…'}
        description={detail ? `${detail.taskNo} · allocated by ${detail.creatorName ?? '—'}` : undefined}
        size="xl"
        footer={
          detail ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
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
                      setSubmitModalOpen(true);
                      setSubmitNote('');
                      setSubmitMetricValue(detail.metricValue ?? '');
                      setSubmitFile(null);
                    }}
                  >
                    Submit for verification
                  </button>
                )}
                {isAssignee && !['completed', 'cancelled'].includes(detail.status) && (
                  <button
                    className="btn-ghost btn-sm text-rose-600 hover:bg-rose-50"
                    disabled={busy}
                    onClick={() => {
                      const note = window.prompt('Describe the blocker or reason to escalate:');
                      if (note) void act('escalate', { note });
                    }}
                  >
                    Escalate issue
                  </button>
                )}

                {/* Manager verification actions */}
                {isManager && ['pending_approval', 'in_progress'].includes(detail.status) && (
                  <>
                    <button
                      className="btn-primary btn-sm bg-emerald-600 hover:bg-emerald-700"
                      disabled={busy}
                      onClick={() => void act('verify')}
                    >
                      ✓ Verify & Approve
                    </button>
                    <button
                      className="btn-secondary btn-sm text-rose-600 hover:bg-rose-50"
                      disabled={busy}
                      onClick={() => {
                        const reason = window.prompt('Specify rejection reason / rectification required:');
                        if (reason) void act('reject', { rejectionReason: reason });
                      }}
                    >
                      ✗ Reject Task
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
            {/* Visual Lifecycle Stepper */}
            <div className="rounded-xl border border-ink-200 bg-slate-50/70 p-3.5">
              <div className="mb-2.5 flex items-center justify-between text-xs font-semibold text-ink-500">
                <span className="uppercase tracking-wider">SOP Lifecycle Status Flow</span>
                <span className="font-bold text-brand-700 capitalize">Current: {titleize(detail.status)}</span>
              </div>
              <div className="grid grid-cols-5 gap-1.5 text-center">
                {[
                  { key: 'assigned', label: '1. Assigned', step: 1 },
                  { key: 'accepted', label: '2. Accepted', step: 2 },
                  { key: 'in_progress', label: '3. In Progress', step: 3 },
                  { key: 'pending_approval', label: '4. Submitted', step: 4 },
                  { key: 'completed', label: '5. Verified', step: 5 },
                ].map((st) => {
                  const stepMap: Record<string, number> = {
                    not_started: 1,
                    assigned: 1,
                    accepted: 2,
                    in_progress: 3,
                    on_hold: 3,
                    pending_approval: 4,
                    completed: 5,
                    verified: 5,
                  };
                  const curStep = stepMap[detail.status] ?? 1;
                  const isPast = st.step < curStep;
                  const isCurrent = st.step === curStep;
                  return (
                    <div
                      key={st.key}
                      className={`rounded-lg px-1 py-1.5 text-[11px] font-semibold transition-all ${
                        isCurrent
                          ? 'bg-brand-600 text-white shadow-sm ring-2 ring-brand-300'
                          : isPast
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-ink-100 text-ink-400'
                      }`}
                    >
                      {st.label}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              {renderVerificationBadge(detail.verificationStatus)}
              {renderSlotBadge(detail.timeSlot)}
              <PriorityBadge priority={detail.priority} />
              {detail.projectName && <Badge tone="brand">{detail.projectName}</Badge>}
              {detail.recurrence !== 'none' && <Badge tone="info">Repeats {detail.recurrence}</Badge>}
              {detail.isOverdue && <Badge tone="danger">Past due</Badge>}
            </div>

            {/* SOP Verification Banner */}
            {(detail.requiresEvidence || detail.requiresMetric) && (
              <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3.5 text-sm">
                <p className="font-semibold text-brand-900">SOP Verification Requirements</p>
                <div className="mt-1.5 flex flex-wrap gap-4 text-xs">
                  {detail.requiresEvidence && (
                    <div className="flex items-center gap-1.5 text-ink-700">
                      <Icon name="camera" size={14} className="text-brand-600" />
                      <span>
                        Proof Required:{' '}
                        <strong className="text-ink-900">{titleize(detail.evidenceType || 'Document/Photo')}</strong>
                      </span>
                    </div>
                  )}
                  {detail.requiresMetric && (
                    <div className="flex items-center gap-1.5 text-ink-700">
                      <Icon name="chart" size={14} className="text-brand-600" />
                      <span>
                        Metric: <strong className="text-ink-900">{detail.metricLabel || 'Value'}</strong>{' '}
                        {detail.metricValue !== null && detail.metricValue !== undefined
                          ? `(Recorded: ${detail.metricValue} ${detail.metricUnit || ''})`
                          : '(Pending)'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-400">Assigned to</p>
                <p className="text-sm font-medium text-ink-800">{detail.assigneeNames ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-400">Due</p>
                <p className="text-sm font-medium text-ink-800">
                  {formatDate(detail.dueDate)} {detail.dueTime ? `· ${detail.dueTime.slice(0, 5)}` : ''}
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
              <div className="rounded-lg bg-rose-50 p-3 text-sm font-medium text-rose-800">
                Rejection reason: {detail.rejectionReason}
              </div>
            )}

            <div>
              <ProgressBar value={detail.progress} label="Progress" />
              {isAssignee && !['completed', 'cancelled'].includes(detail.status) && (
                <div className="mt-2.5 space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-medium text-ink-500">Quick Set:</span>
                    {[25, 50, 75, 100].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          setProgressValue(pct);
                          await act('progress', { progress: pct, note: `Progress updated to ${pct}%` });
                        }}
                        className={`rounded border px-2.5 py-1 text-xs font-semibold transition-colors ${
                          detail.progress === pct
                            ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                            : 'border-ink-200 bg-ink-50 text-ink-700 hover:bg-ink-100'
                        }`}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
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
                </div>
              )}
            </div>

            {/* Attachments / Proof Section */}
            {detail.attachments && detail.attachments.length > 0 && (
              <div>
                <SectionHeader title="Proof & Attachments" />
                <div className="mt-2 flex flex-wrap gap-2">
                  {detail.attachments.map((att) => (
                    <a
                      key={att.id}
                      href={fileUrl(att.file_id, true)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                    >
                      <Icon name="file" size={14} className="text-brand-600" />
                      {att.original_name}
                    </a>
                  ))}
                </div>
              </div>
            )}

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
                </div>
              </div>

              <div>
                <SectionHeader title="Activity & Audit Logs" />
                <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
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
            </div>

            <div className="flex flex-wrap gap-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
              <span>Created {formatDateTime(detail.createdAt)}</span>
              {detail.submittedAt && <span>Submitted {formatDateTime(detail.submittedAt)}</span>}
              {detail.approvedAt && <span>Verified {formatDateTime(detail.approvedAt)}</span>}
            </div>
          </div>
        )}
      </Modal>

      {/* Task Verification Submission Modal */}
      <Modal
        open={submitModalOpen}
        onClose={() => setSubmitModalOpen(false)}
        title="Submit Task for Manager Verification"
        description="Provide work details, numerical metrics, and proof of completion as per SOP requirements."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setSubmitModalOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              form="submit-verification-form"
              className="btn-primary"
              disabled={submittingVerification}
            >
              {submittingVerification ? 'Submitting…' : 'Submit for Verification'}
            </button>
          </>
        }
      >
        <form id="submit-verification-form" onSubmit={handleSubmitVerification} className="space-y-4">
          <Field label="Work description / Completion note" required hint="Describe in detail the tasks completed">
            <textarea
              className="input min-h-[90px]"
              placeholder="e.g. Completed cash tally, reconciled ₹1,85,000 against billing reports, all customer counter logs cleared."
              value={submitNote}
              onChange={(e) => setSubmitNote(e.target.value)}
              minLength={5}
              required
            />
          </Field>

          {detail?.requiresMetric && (
            <Field
              label={detail.metricLabel ? `${detail.metricLabel} (${detail.metricUnit || ''})` : 'Numerical Metric Value'}
              required
            >
              <input
                type="number"
                step="any"
                className="input"
                placeholder={`Enter ${detail.metricLabel || 'metric'} value`}
                value={submitMetricValue}
                onChange={(e) => setSubmitMetricValue(e.target.value === '' ? '' : Number(e.target.value))}
                required
              />
            </Field>
          )}

          <Field
            label="Upload Proof / Evidence"
            hint={
              detail?.requiresEvidence
                ? `Mandatory: ${titleize(detail.evidenceType || 'Photo / Document proof')}`
                : 'Optional photo or document attachment'
            }
            required={detail?.requiresEvidence}
          >
            <input
              type="file"
              className="input py-1.5 text-xs"
              onChange={(e) => setSubmitFile(e.target.files?.[0] || null)}
              required={detail?.requiresEvidence}
            />
          </Field>
        </form>
      </Modal>

      {/* Checkpoint Modal */}
      <Modal
        open={checkpointModalOpen}
        onClose={() => setCheckpointModalOpen(false)}
        title={activeCheckpoint?.label || 'Activity Checkpoint'}
        description={`Time slot: ${activeCheckpoint?.hours || ''}`}
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCheckpointModalOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              form="checkpoint-form"
              className="btn-primary"
              disabled={submittingCheckpoint}
            >
              {submittingCheckpoint ? 'Saving…' : 'Save Checkpoint'}
            </button>
          </>
        }
      >
        <form id="checkpoint-form" onSubmit={handleSaveCheckpoint} className="space-y-4">
          <Field label="Operational Activity Summary" required hint="What activities were performed during this period?">
            <textarea
              className="input min-h-[90px]"
              placeholder="e.g. Conducted morning floor briefing, aligned sales staff on targets, verified counter readiness."
              value={checkpointSummary}
              onChange={(e) => setCheckpointSummary(e.target.value)}
              required
            />
          </Field>

          <Field label="Issues or Blockers Identified" hint="Leave empty if operations were normal">
            <textarea
              className="input min-h-[70px]"
              placeholder="e.g. POS printer malfunctioning on Ground Floor, 2 staff members absent without notice."
              value={checkpointIssues}
              onChange={(e) => setCheckpointIssues(e.target.value)}
            />
          </Field>

          <label className="flex items-center gap-2 text-xs font-semibold text-rose-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-rose-300"
              checked={checkpointEscalate}
              onChange={(e) => setCheckpointEscalate(e.target.checked)}
            />
            Escalate issue to Store Manager immediately
          </label>
        </form>
      </Modal>

      {/* Create Task Modal */}
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

  // Retain only Gagan C B in authorized assignees
  const gaganAssignees = useMemo(() => {
    const list = assignees.filter((e) => e.full_name.toLowerCase().includes('gagan'));
    return list.length > 0 ? list : assignees;
  }, [assignees]);

  // Pre-select Gagan C B and initialize today's date on open
  useEffect(() => {
    if (open) {
      if (!form.dueDate) {
        setForm((prev) => ({ ...prev, dueDate: new Date().toISOString().slice(0, 10) }));
      }
      if (selected.length === 0 && gaganAssignees.length > 0) {
        setSelected([gaganAssignees[0].id]);
      }
    }
  }, [open, gaganAssignees, form.dueDate, selected.length]);

  const term = assigneeSearch.trim().toLowerCase();
  const filteredAssignees = term
    ? gaganAssignees.filter((employee) =>
        [employee.full_name, employee.employee_code, employee.designation_title, employee.department_name]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term)),
      )
    : gaganAssignees;

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
    { id: 'morning', label: 'Morning Slot', hours: '09:30 - 11:00 AM', icon: '🌅', desc: 'Opening, counter setup & cash float' },
    { id: 'operations', label: 'Store Operations', hours: '11:00 AM - 05:00 PM', icon: '🏬', desc: 'Active floor, customer service & sales' },
    { id: 'evening', label: 'Evening Slot', hours: '05:00 - 08:00 PM', icon: '🌇', desc: 'Peak footfall, restock & register' },
    { id: 'closing', label: 'Night Closing', hours: '08:00 - 09:30 PM', icon: '🔒', desc: 'Day-end tally, security & closing' },
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
                      <span className="text-lg">{slot.icon}</span>
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
                const employee = gaganAssignees.find((item) => item.id === id);
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
