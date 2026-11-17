import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadReport, errorMessage, fileUrl } from '../lib/api';
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
      toast.success('Task updated successfully.');
      await openDetail(detail.id, true);
      await reload();
      if (activeMainTab === 'performance') void loadPerformance();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
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

  const handleSubmitVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
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

      await api.post(`/tasks/${detail.id}/action`, {
        action: 'submit',
        completionNote: submitNote.trim(),
        metricValue: submitMetricValue !== '' ? Number(submitMetricValue) : undefined,
        evidenceFileId: fileId,
      });

      toast.success('Task submitted for manager verification.');
      setSubmitModalOpen(false);
      setSubmitNote('');
      setSubmitFile(null);
      await openDetail(detail.id, true);
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
                      <th className="w-32">Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((task) => (
                      <tr key={task.id} className="cursor-pointer hover:bg-ink-50/70" onClick={() => void openDetail(task.id)}>
                        <td>
                          <div className="space-y-1">
                            <p className="font-medium text-ink-800">{task.title}</p>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
                              <span>{task.taskNo}</span>
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
      toast.error('Select at least one employee to allocate this task to.');
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
      toast.success('Task allocated and assignees notified.');
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
          <Field label="SOP Time Slot">
            <select className="input" value={form.timeSlot} onChange={(event) => setForm({ ...form, timeSlot: event.target.value })}>
              <option value="morning">Morning (09:30 - 11:00 AM)</option>
              <option value="operations">Store Operations (11:00 AM - 05:00 PM)</option>
              <option value="evening">Evening (05:00 - 08:00 PM)</option>
              <option value="closing">Night Closing (08:00 - 09:30 PM)</option>
            </select>
          </Field>
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
          <div className="flex items-end justify-between gap-2">
            <span className="label mb-0">Assign to (reporting structure only) *</span>
            <span className="text-xs font-medium text-ink-500">{selected.length} selected</span>
          </div>

          <div className="relative mt-1.5">
            <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="input py-1.5 pl-9 pr-9 text-sm"
              value={assigneeSearch}
              onChange={(event) => setAssigneeSearch(event.target.value)}
              placeholder="Search by name, employee ID, designation or department…"
              aria-label="Search assignees"
            />
            {assigneeSearch && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                onClick={() => setAssigneeSearch('')}
                aria-label="Clear assignee search"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500">
            <span>
              {filteredAssignees.length} of {assignees.length} shown
            </span>
            <div className="flex items-center gap-2">
              {filteredAssignees.length > 0 && (
                <button type="button" className="font-medium text-brand-700 hover:underline" onClick={toggleFiltered}>
                  {allFilteredSelected ? 'Unselect shown' : 'Select all shown'}
                </button>
              )}
              {selected.length > 0 && (
                <button type="button" className="font-medium text-ink-500 hover:underline" onClick={() => setSelected([])}>
                  Clear selection
                </button>
              )}
            </div>
          </div>

          <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-ink-300 p-2">
            {assignees.length === 0 && <p className="p-2 text-sm text-ink-500">No employees available in your reporting structure.</p>}
            {assignees.length > 0 && filteredAssignees.length === 0 && (
              <p className="p-2 text-sm text-ink-500">No one in your reporting structure matches “{assigneeSearch.trim()}”.</p>
            )}
            {filteredAssignees.map((employee) => (
              <label key={employee.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-ink-50">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={selected.includes(employee.id)}
                  onChange={(event) =>
                    setSelected((prev) => (event.target.checked ? [...prev, employee.id] : prev.filter((id) => id !== employee.id)))
                  }
                />
                <span className="min-w-0 flex-1 truncate text-ink-800">
                  {employee.full_name}
                  {employee.employee_code && <span className="ml-1.5 text-xs text-ink-400">{employee.employee_code}</span>}
                </span>
                <span className="max-w-[45%] truncate text-xs text-ink-400">{employee.designation_title ?? employee.department_name ?? ''}</span>
              </label>
            ))}
          </div>

          {selected.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Selected assignees">
              {selected.map((id) => {
                const employee = assignees.find((item) => item.id === id);
                return (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-brand-800">
                    {employee?.full_name ?? `Employee #${id}`}
                    <button
                      type="button"
                      className="rounded-full p-0.5 hover:bg-brand-100"
                      onClick={() => setSelected((prev) => prev.filter((value) => value !== id))}
                      aria-label={`Remove ${employee?.full_name ?? id}`}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
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
