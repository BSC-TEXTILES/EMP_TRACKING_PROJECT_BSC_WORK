import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Pagination,
  SectionHeader,
  Skeleton,
  StatusBadge,
  Tabs,
} from '../components/ui';
import { Icon } from '../components/icons';
import { formatDate, formatDateTime, minutesToHours } from '../lib/format';

interface ReportHistoryEntry {
  id: number;
  actorId: number;
  actorName: string;
  action: string;
  status: string;
  summary: string | null;
  reviewNote: string | null;
  createdAt: string;
}

interface AssignedTaskItem {
  id: number;
  taskCode: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

interface Report {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  designationTitle: string | null;
  locationCode?: string | null;
  locationName?: string | null;
  reportDate: string;
  workStart: string | null;
  workEnd: string | null;
  totalMinutes: number;
  summary: string;
  problems: string | null;
  supportRequired: string | null;
  tomorrowPlan: string | null;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksPending: number;
  status: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewerName: string | null;
  history?: ReportHistoryEntry[];
}

interface Suggestions {
  date: string;
  employee?: {
    id: number;
    name: string;
    code: string;
    locationName: string | null;
    departmentName: string | null;
    designation: string | null;
    managerName: string | null;
  };
  tasksCompleted: number;
  tasksInProgress: number;
  tasksPending: number;
  totalAssigned?: number;
  hasAssignedTasks?: boolean;
  assignedTasks?: AssignedTaskItem[];
  attendance: { check_in_at: string | null; check_out_at: string | null; total_minutes: number } | null;
}

interface MissingEmployee {
  id: number;
  employeeCode: string;
  fullName: string;
  departmentName: string | null;
  designationTitle: string | null;
  locationCode: string | null;
  locationName: string | null;
  managerName: string | null;
  checkInAt: string | null;
  attendanceStatus: string | null;
  reportStatus: string;
}

interface ComplianceData {
  date: string;
  summary: {
    totalActive: number;
    checkedInCount: number;
    submittedCount: number;
    missingCount: number;
    complianceRate: number;
  };
  missingEmployees: MissingEmployee[];
  submittedReports: Report[];
  locationBreakdown: Array<{
    locationId: number;
    locationCode: string;
    locationName: string;
    totalActive: number;
    submitted: number;
    missing: number;
    complianceRate: number;
  }>;
}

const COMMON_PROBLEMS = [
  'Network / internet connectivity issues',
  'Hardware / system technical fault',
  'Supplier / material delivery delay',
  'Customer escalation pending resolution',
  'Dependency on cross-department approval',
];

export default function DailyReports() {
  useDocumentTitle('End-of-Day Work Reports · BSC HRMS');
  const { user, has, canAny } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'mine';

  const isManagerOrAdmin = canAny('reports.review', 'reports.view.team', 'reports.view.all');

  // Filter states
  const [items, setItems] = useState<Report[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [dateFilter, setDateFilter] = useState(new Date().toISOString().slice(0, 10));
  const [employeeSearch, setEmployeeSearch] = useState('');

  // Modal & Edit states
  const [open, setOpen] = useState<Report | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    summary: '',
    problems: '',
    supportRequired: '',
    tomorrowPlan: '',
    tasksCompleted: 0,
    tasksInProgress: 0,
    tasksPending: 0,
    status: 'submitted',
    reviewNote: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // Today & Suggestions states
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [todayReport, setTodayReport] = useState<Report | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    summary: '',
    problems: '',
    supportRequired: '',
    tomorrowPlan: '',
    workStart: '',
    workEnd: '',
    totalMinutes: 0,
    tasksCompleted: 0,
    tasksInProgress: 0,
    tasksPending: 0,
  });

  // Compliance & Missing state
  const [compliance, setCompliance] = useState<ComplianceData | null>(null);
  const [loadingCompliance, setLoadingCompliance] = useState(false);
  const [sendingReminders, setSendingReminders] = useState(false);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (status) query.set('status', status);
      if (locationFilter) query.set('locationId', locationFilter);
      if (tab === 'team' && dateFilter) {
        query.set('from', dateFilter);
        query.set('to', dateFilter);
      }
      const result = await api.get<{ items: Report[]; total: number }>(`/reports?${query.toString()}`);
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }, [page, status, locationFilter, tab, dateFilter, toast]);

  const loadCompliance = useCallback(async () => {
    if (!isManagerOrAdmin) return;
    setLoadingCompliance(true);
    try {
      const query = new URLSearchParams({ date: dateFilter });
      if (locationFilter) query.set('locationId', locationFilter);
      const data = await api.get<ComplianceData>(`/reports/compliance?${query.toString()}`);
      setCompliance(data);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoadingCompliance(false);
    }
  }, [isManagerOrAdmin, dateFilter, locationFilter, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === 'missing' || tab === 'compliance') {
      void loadCompliance();
    }
  }, [tab, loadCompliance]);

  const refreshTodayStatus = useCallback(() => {
    api
      .get<Suggestions>('/reports/suggestions')
      .then((result) => {
        setSuggestions(result);
        setForm((prev) => ({
          ...prev,
          tasksCompleted: result.tasksCompleted,
          tasksInProgress: result.tasksInProgress,
          tasksPending: result.tasksPending,
          totalMinutes: result.attendance?.total_minutes ?? 0,
          workStart: result.attendance?.check_in_at ? new Date(result.attendance.check_in_at).toISOString().slice(11, 16) : '',
          workEnd: result.attendance?.check_out_at ? new Date(result.attendance.check_out_at).toISOString().slice(11, 16) : '',
        }));
      })
      .catch(() => undefined);

    api
      .get<{ report: Report | null }>('/reports/today')
      .then((result) => setTodayReport(result.report))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshTodayStatus();
  }, [refreshTodayStatus]);

  const openReportDetail = async (report: Report) => {
    setOpen(report);
    setIsEditing(false);
    setLoadingDetail(true);
    try {
      const detail = await api.get<Report>(`/reports/${report.id}`);
      setOpen(detail);
    } catch {
      // keep basic report
    } finally {
      setLoadingDetail(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.summary.trim() || form.summary.trim().length < 10) {
      toast.error('Work completed summary must be at least 10 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/reports', {
        reportDate: new Date().toISOString().slice(0, 10),
        ...form,
        summary: form.summary.trim(),
        problems: form.problems.trim() || undefined,
        supportRequired: form.supportRequired.trim() || undefined,
        tomorrowPlan: form.tomorrowPlan.trim() || undefined,
      });
      toast.success('End-of-day report submitted successfully.');
      setForm((prev) => ({ ...prev, summary: '', problems: '', supportRequired: '', tomorrowPlan: '' }));
      refreshTodayStatus();
      await load();
      if (tab === 'missing' || tab === 'compliance') {
        void loadCompliance();
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const review = async (id: number, approve: boolean) => {
    const note = approve ? window.prompt('Optional review note for the employee:') ?? '' : window.prompt('What should the employee correct before resubmitting?') ?? '';
    if (!approve && !note) return;
    try {
      await api.post(`/reports/${id}/review`, { approve, note: note || undefined });
      toast.success(approve ? 'Report marked as Reviewed & Approved.' : 'Report returned to employee for correction.');
      setOpen(null);
      setIsEditing(false);
      await load();
      if (tab === 'missing' || tab === 'compliance') {
        void loadCompliance();
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const startEditing = (report: Report) => {
    setEditForm({
      summary: report.summary,
      problems: report.problems ?? '',
      supportRequired: report.supportRequired ?? '',
      tomorrowPlan: report.tomorrowPlan ?? '',
      tasksCompleted: report.tasksCompleted,
      tasksInProgress: report.tasksInProgress,
      tasksPending: report.tasksPending,
      status: report.status,
      reviewNote: report.reviewNote ?? '',
    });
    setIsEditing(true);
  };

  const saveEdit = async () => {
    if (!open) return;
    if (!editForm.summary.trim() || editForm.summary.trim().length < 10) {
      toast.error('Work completed summary must be at least 10 characters.');
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await api.put<Report>(`/reports/${open.id}`, {
        summary: editForm.summary.trim(),
        problems: editForm.problems.trim() || undefined,
        supportRequired: editForm.supportRequired.trim() || undefined,
        tomorrowPlan: editForm.tomorrowPlan.trim() || undefined,
        tasksCompleted: Number(editForm.tasksCompleted),
        tasksInProgress: Number(editForm.tasksInProgress),
        tasksPending: Number(editForm.tasksPending),
        status: editForm.status as 'submitted' | 'approved' | 'changes_requested',
        reviewNote: editForm.reviewNote.trim() || undefined,
      });
      toast.success('Report updated successfully.');
      setOpen(updated);
      setIsEditing(false);
      refreshTodayStatus();
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSendReminders = async () => {
    setSendingReminders(true);
    try {
      const res = await api.post<{ ok: boolean; reminded: number }>('/reports/remind', {});
      toast.success(`Sent automatic EOD reminders to ${res.reminded} checked-in employees and their managers.`);
      void loadCompliance();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSendingReminders(false);
    }
  };

  const handleExport = async (type: 'excel' | 'pdf') => {
    setExporting(type);
    try {
      const query = new URLSearchParams();
      if (dateFilter) {
        query.set('from', dateFilter);
        query.set('to', dateFilter);
      }
      if (locationFilter) query.set('locationId', locationFilter);

      const response = await fetch(`/api/reports/export/${type}?${query.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `BSC_HRMS_EOD_Reports_${dateFilter || 'all'}.${type === 'excel' ? 'xlsx' : 'pdf'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success(`Exported ${type.toUpperCase()} successfully.`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setExporting(null);
    }
  };

  const visibleReports = (items ?? []).filter((report) => {
    if (tab === 'mine') return report.employeeId === user?.id;
    if (employeeSearch.trim()) {
      const q = employeeSearch.toLowerCase();
      const matchName = report.employeeName.toLowerCase().includes(q);
      const matchCode = report.employeeCode.toLowerCase().includes(q);
      const matchDept = report.departmentName?.toLowerCase().includes(q) ?? false;
      if (!matchName && !matchCode && !matchDept) return false;
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="End-of-Day Work Reports"
          description="Live daily submission, task verification, manager review workflow, and Android application."
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm inline-flex items-center gap-1.5 font-bold"
            onClick={() => setParams({ tab: 'apk' })}
          >
            <Icon name="smartphone" size={15} className="text-emerald-600" />
            <span>Download Android APK</span>
          </button>
        </div>
      </div>

      <Tabs
        tabs={[
          { value: 'mine', label: 'My EOD Report' },
          ...(isManagerOrAdmin
            ? [
                { value: 'team', label: 'Team Reports' },
                {
                  value: 'missing',
                  label: compliance ? `Missing Submissions (${compliance.summary.missingCount})` : 'Missing Submissions',
                },
                { value: 'compliance', label: 'Compliance & Exports' },
              ]
            : []),
          { value: 'apk', label: '📱 Mobile APK' },
        ]}
        value={tab}
        onChange={(value) => setParams({ tab: value })}
      />

      {/* TAB 1: MY EOD REPORT */}
      {tab === 'mine' && (
        <div className="space-y-5">
          {/* Correction Requested Alert Banner */}
          {todayReport && todayReport.status === 'changes_requested' && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-amber-200/70 p-2 text-amber-800">
                    <Icon name="alertTriangle" size={20} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-amber-900">Report Returned for Correction</h3>
                    <p className="mt-0.5 text-xs text-amber-800">
                      <strong>Manager Note:</strong> {todayReport.reviewNote || 'Please review and update your report.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => openReportDetail(todayReport)}
                >
                  <Icon name="edit" size={14} />
                  Correct & Resubmit Report
                </button>
              </div>
            </div>
          )}

          {/* Today's Existing Submission Card */}
          {todayReport && todayReport.status !== 'changes_requested' && (
            <Card className="card-pad border-brand-200/80 bg-gradient-to-r from-brand-50/40 to-white">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                      <Icon name="check" size={14} />
                    </span>
                    <h3 className="text-sm font-bold text-ink-900">Today&apos;s EOD Report Submitted</h3>
                    <StatusBadge status={todayReport.status} />
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    Submitted on {formatDateTime(todayReport.submittedAt)} · Reviewed by{' '}
                    <strong className="text-ink-700">{todayReport.reviewerName ?? 'Pending Review'}</strong>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => openReportDetail(todayReport)}
                  >
                    View Details & Audit Trail
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      startEditing(todayReport);
                      setOpen(todayReport);
                    }}
                  >
                    <Icon name="edit" size={13} />
                    Edit Report
                  </button>
                </div>
              </div>
              <div className="mt-3 rounded-lg bg-white/80 p-3 border border-ink-100">
                <p className="text-xs font-bold text-ink-500 uppercase tracking-wider">Work Completed</p>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-800 line-clamp-3">{todayReport.summary}</p>
              </div>
            </Card>
          )}

          {/* Today's Report Submission Form */}
          {(!todayReport || todayReport.status === 'changes_requested') && (
            <Card className="card-pad">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3">
                <SectionHeader
                  title="Submit End-of-Day Work Report"
                  description={`${formatDate(new Date().toISOString())} · Live task and attendance verification`}
                />
                {suggestions?.employee && (
                  <div className="flex items-center gap-2 text-xs text-ink-600 bg-ink-50 px-3 py-1.5 rounded-lg border border-ink-200">
                    <Icon name="user" size={14} className="text-brand-600" />
                    <span>
                      <strong>{suggestions.employee.name}</strong> ({suggestions.employee.code})
                    </span>
                    {suggestions.employee.locationName && (
                      <span className="rounded bg-blue-100 px-1.5 py-0.2 font-semibold text-blue-800">
                        {suggestions.employee.locationName}
                      </span>
                    )}
                    {suggestions.employee.managerName && (
                      <span>· Manager: {suggestions.employee.managerName}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Live Task Statistics Grid */}
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wider text-ink-500">Live Task Status</p>
                  <span className="text-xs text-ink-400">
                    {suggestions?.hasAssignedTasks ? 'Connected to live assignments' : 'No assigned tasks today'}
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-emerald-800">Tasks Completed</span>
                      <Icon name="check" size={16} className="text-emerald-600" />
                    </div>
                    <p className="mt-1 text-2xl font-black text-emerald-900">{form.tasksCompleted}</p>
                    <p className="text-[11px] text-emerald-700">Finished in database today</p>
                  </div>

                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-blue-800">In Progress</span>
                      <Icon name="clock" size={16} className="text-blue-600" />
                    </div>
                    <p className="mt-1 text-2xl font-black text-blue-900">{form.tasksInProgress}</p>
                    <p className="text-[11px] text-blue-700">Currently active assignments</p>
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-amber-800">Tasks Pending</span>
                      <Icon name="alertTriangle" size={16} className="text-amber-600" />
                    </div>
                    <p className="mt-1 text-2xl font-black text-amber-900">{form.tasksPending}</p>
                    <p className="text-[11px] text-amber-700">Awaiting action</p>
                  </div>
                </div>

                {/* Assigned Tasks Drawer */}
                {suggestions?.assignedTasks && suggestions.assignedTasks.length > 0 ? (
                  <div className="rounded-lg border border-ink-200/80 bg-ink-50/50 p-3">
                    <p className="text-xs font-bold text-ink-700 mb-2">Today&apos;s Assigned Tasks:</p>
                    <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                      {suggestions.assignedTasks.map((t) => (
                        <div key={t.id} className="flex items-center justify-between gap-2 rounded bg-white p-2 text-xs border border-ink-100 shadow-2xs">
                          <div className="flex items-center gap-2 truncate">
                            <span className="font-mono font-bold text-ink-500">{t.taskCode}</span>
                            <span className="font-medium text-ink-800 truncate">{t.title}</span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-bold text-ink-700">{t.priority}</span>
                            <StatusBadge status={t.status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50/30 p-2.5 text-center text-xs text-ink-500">
                    No individual task tickets were assigned in the system for today. Record your operational activities and accomplishments in the work completed section below.
                  </div>
                )}
              </div>

                <form onSubmit={submit} className="mt-5 space-y-4">
                <Field
                  label="Work Completed Today (Mandatory)"
                  required
                  hint={`Minimum 10 characters (${form.summary.trim().length} chars entered)`}
                >
                  <textarea
                    className="input min-h-[120px]"
                    value={form.summary}
                    onChange={(event) => setForm({ ...form, summary: event.target.value })}
                    placeholder="Provide a detailed summary of the operational responsibilities, sales, client queries, code, or tasks completed during your shift..."
                    minLength={10}
                    required
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Field label="Problems Encountered (Optional)" hint="Operational issues, client blockers, technical delays">
                      <textarea
                        className="input min-h-[85px]"
                        value={form.problems}
                        onChange={(event) => setForm({ ...form, problems: event.target.value })}
                        placeholder="Mention any delays, system bugs, or obstacles faced today..."
                      />
                    </Field>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {COMMON_PROBLEMS.map((prob) => (
                        <button
                          key={prob}
                          type="button"
                          className="rounded-full bg-ink-100 hover:bg-ink-200 px-2 py-0.5 text-[10px] text-ink-700 transition-colors"
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              problems: prev.problems ? `${prev.problems}; ${prob}` : prob,
                            }))
                          }
                        >
                          + {prob}
                        </button>
                      ))}
                    </div>
                  </div>

                  <Field label="Support Required (Optional)" hint="Specify the assistance or department/manager needed">
                    <textarea
                      className="input min-h-[85px]"
                      value={form.supportRequired}
                      onChange={(event) => setForm({ ...form, supportRequired: event.target.value })}
                      placeholder="e.g. Need IT hardware replacement, Store Manager approval for stock return, HR clarification on leaves..."
                    />
                  </Field>
                </div>

                <Field label="Tomorrow's Plan (Optional)" hint="Activities, follow-ups, and pending goals planned for next working day">
                  <textarea
                    className="input min-h-[80px]"
                    value={form.tomorrowPlan}
                    onChange={(event) => setForm({ ...form, tomorrowPlan: event.target.value })}
                    placeholder="List planned activities, follow-ups with customers, or pending deliveries..."
                  />
                </Field>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-ink-100">
                  <div className="text-xs text-ink-500">
                    <span>
                      Attendance: <strong>{suggestions?.attendance?.total_minutes ? minutesToHours(suggestions.attendance.total_minutes) : 'Recorded on sign-off'}</strong>
                    </span>
                    {suggestions?.attendance?.check_in_at && (
                      <span className="ml-2 text-ink-400">
                        (Checked in at {new Date(suggestions.attendance.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                      </span>
                    )}
                  </div>
                  <button type="submit" className="btn-primary" disabled={submitting || form.summary.trim().length < 10}>
                    {submitting ? 'Submitting Report…' : todayReport ? 'Resubmit EOD Report' : 'Submit End-of-Day Report'}
                  </button>
                </div>
              </form>
            </Card>
          )}

          {/* Past Submissions History */}
          <Card>
            <div className="px-4 py-3 border-b border-ink-100 flex items-center justify-between">
              <h3 className="text-sm font-bold text-ink-900">My Report History</h3>
              <Badge tone="neutral">{visibleReports.length} reports</Badge>
            </div>
            {!items ? (
              <div className="p-4">
                <Skeleton lines={5} />
              </div>
            ) : visibleReports.length === 0 ? (
              <EmptyState title="No previous reports" description="Your submitted daily work reports will appear here." />
            ) : (
              <div className="divide-y divide-ink-100">
                {visibleReports.map((report) => (
                  <div
                    key={report.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-ink-900">{formatDate(report.reportDate)}</span>
                        <StatusBadge status={report.status} />
                        <span className="text-xs text-ink-400 font-mono">
                          {report.tasksCompleted} done · {report.tasksInProgress} in-prog · {report.tasksPending} pending
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-ink-600">{report.summary}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => openReportDetail(report)}
                      >
                        View & Audit Trail
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* TAB 2: TEAM REPORTS (MANAGER & HR) */}
      {tab === 'team' && isManagerOrAdmin && (
        <div className="space-y-4">
          <Card className="card-pad">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Filter by Date">
                <input
                  type="date"
                  className="input"
                  value={dateFilter}
                  onChange={(e) => {
                    setDateFilter(e.target.value);
                    setPage(1);
                  }}
                />
              </Field>

              <Field label="Location">
                <select
                  className="input"
                  value={locationFilter}
                  onChange={(e) => {
                    setLocationFilter(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All Locations (BEL, DAV, SHI, HQ)</option>
                  <option value="1">DAV – Davanagere</option>
                  <option value="2">BEL – Belagavi</option>
                  <option value="3">SHI – Shivamogga</option>
                  <option value="4">HUB-HQ – Head Office</option>
                </select>
              </Field>

              <Field label="Report Status">
                <select
                  className="input"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All Statuses</option>
                  <option value="submitted">Submitted (Under Review)</option>
                  <option value="approved">Approved</option>
                  <option value="changes_requested">Changes Requested</option>
                </select>
              </Field>

              <Field label="Search Employee">
                <input
                  type="text"
                  className="input"
                  placeholder="Search name, code, dept..."
                  value={employeeSearch}
                  onChange={(e) => setEmployeeSearch(e.target.value)}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-ink-900">Submitted Reports</h3>
                <Badge tone="brand">{visibleReports.length} found</Badge>
              </div>
            </div>

            {!items ? (
              <div className="p-4">
                <Skeleton lines={6} />
              </div>
            ) : visibleReports.length === 0 ? (
              <EmptyState
                title="No reports found"
                description="No daily reports match the selected filters or date."
              />
            ) : (
              <div className="divide-y divide-ink-100">
                {visibleReports.map((report) => (
                  <div
                    key={report.id}
                    className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 hover:bg-ink-50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-ink-900">{report.employeeName}</span>
                        <span className="font-mono text-xs text-ink-500">({report.employeeCode})</span>
                        {report.locationCode && (
                          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 border border-blue-200">
                            {report.locationCode}
                          </span>
                        )}
                        <span className="text-xs text-ink-500">· {report.departmentName ?? 'General'}</span>
                        <StatusBadge status={report.status} />
                      </div>

                      <p className="mt-1.5 whitespace-pre-line text-sm text-ink-700 line-clamp-2">{report.summary}</p>

                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-500">
                        <span>Date: <strong>{report.reportDate}</strong></span>
                        <span>Working: <strong>{minutesToHours(report.totalMinutes)}</strong></span>
                        <span>Tasks: <strong className="text-emerald-700">{report.tasksCompleted} done</strong>, <strong>{report.tasksInProgress} active</strong>, <strong className="text-amber-700">{report.tasksPending} pending</strong></span>
                        {report.reviewerName && <span>Reviewed by {report.reviewerName}</span>}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.status !== 'approved' && has('reports.review') && (
                        <>
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            onClick={() => void review(report.id, true)}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            onClick={() => void review(report.id, false)}
                          >
                            Return
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => openReportDetail(report)}
                      >
                        Details
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <Pagination page={page} pageSize={20} total={total} onPage={setPage} />
          </Card>
        </div>
      )}

      {/* TAB 3: MISSING SUBMISSIONS & REMINDERS */}
      {tab === 'missing' && isManagerOrAdmin && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <input
                type="date"
                className="input py-1 text-sm font-semibold"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
              />
              <select
                className="input py-1 text-sm font-semibold"
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
              >
                <option value="">All Locations</option>
                <option value="1">DAV – Davanagere</option>
                <option value="2">BEL – Belagavi</option>
                <option value="3">SHI – Shivamogga</option>
                <option value="4">HUB-HQ – Head Office</option>
              </select>
            </div>

            <button
              type="button"
              className="btn-primary inline-flex items-center gap-2"
              disabled={sendingReminders || !compliance || compliance.summary.missingCount === 0}
              onClick={() => void handleSendReminders()}
            >
              <Icon name="bell" size={15} />
              <span>{sendingReminders ? 'Sending Reminders…' : 'Send Automatic Reminders'}</span>
            </button>
          </div>

          {/* Missing Summary Cards */}
          {compliance && (
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-ink-200 bg-white p-3.5 shadow-2xs">
                <p className="text-xs text-ink-500">Checked In Today</p>
                <p className="mt-1 text-2xl font-bold text-ink-900">{compliance.summary.checkedInCount}</p>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5 shadow-2xs">
                <p className="text-xs text-emerald-800">EOD Reports Submitted</p>
                <p className="mt-1 text-2xl font-bold text-emerald-900">{compliance.summary.submittedCount}</p>
              </div>
              <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3.5 shadow-2xs">
                <p className="text-xs text-rose-800">Missing Submissions</p>
                <p className="mt-1 text-2xl font-bold text-rose-900">{compliance.summary.missingCount}</p>
              </div>
              <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3.5 shadow-2xs">
                <p className="text-xs text-blue-800">Compliance Rate</p>
                <p className="mt-1 text-2xl font-bold text-blue-900">{compliance.summary.complianceRate}%</p>
              </div>
            </div>
          )}

          {/* Missing Employees Table */}
          <Card>
            <div className="px-4 py-3 border-b border-ink-100 flex items-center justify-between">
              <h3 className="text-sm font-bold text-ink-900">
                Employees Checked In Without EOD Report ({formatDate(dateFilter)})
              </h3>
              <Badge tone="danger">{compliance?.missingEmployees.length ?? 0} missing</Badge>
            </div>

            {loadingCompliance ? (
              <div className="p-4">
                <Skeleton lines={6} />
              </div>
            ) : !compliance || compliance.missingEmployees.length === 0 ? (
              <EmptyState
                title="Full compliance achieved!"
                description="All checked-in employees have submitted their end-of-day reports for this date."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50/60 text-xs font-semibold text-ink-600">
                    <tr>
                      <th className="px-4 py-3">Employee</th>
                      <th className="px-4 py-3">Location</th>
                      <th className="px-4 py-3">Department</th>
                      <th className="px-4 py-3">Reporting Manager</th>
                      <th className="px-4 py-3">Check-In Time</th>
                      <th className="px-4 py-3">Report Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {compliance.missingEmployees.map((emp) => (
                      <tr key={emp.id} className="hover:bg-ink-50">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-ink-900">{emp.fullName}</div>
                          <div className="font-mono text-xs text-ink-500">{emp.employeeCode}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700 border border-blue-200">
                            {emp.locationCode ?? 'HQ'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-ink-700">{emp.departmentName ?? '—'}</td>
                        <td className="px-4 py-3 text-ink-700">{emp.managerName ?? '—'}</td>
                        <td className="px-4 py-3 text-xs text-ink-600">
                          {emp.checkInAt
                            ? new Date(emp.checkInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : 'Active employee'}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-800">
                            Not Submitted
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* TAB 4: COMPLIANCE & EXPORTS */}
      {tab === 'compliance' && isManagerOrAdmin && (
        <div className="space-y-4">
          <Card className="card-pad">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-ink-900">EOD Compliance Analytics & Reports Export</h3>
                <p className="text-xs text-ink-500">
                  Export verified daily reports in professional Excel (.xlsx) and PDF (.pdf) formats.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-1.5 font-bold"
                  disabled={exporting !== null}
                  onClick={() => void handleExport('excel')}
                >
                  <Icon name="file" size={15} className="text-emerald-600" />
                  <span>{exporting === 'excel' ? 'Exporting…' : 'Export Excel (.xlsx)'}</span>
                </button>

                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-1.5 font-bold"
                  disabled={exporting !== null}
                  onClick={() => void handleExport('pdf')}
                >
                  <Icon name="file" size={15} className="text-rose-600" />
                  <span>{exporting === 'pdf' ? 'Exporting…' : 'Export PDF (.pdf)'}</span>
                </button>
              </div>
            </div>
          </Card>

          {/* Location Breakdown Table */}
          {compliance && (
            <Card>
              <div className="px-4 py-3 border-b border-ink-100">
                <h3 className="text-sm font-bold text-ink-900">Store & Location Breakdown ({formatDate(dateFilter)})</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-ink-200 bg-ink-50/60 text-xs font-semibold text-ink-600">
                    <tr>
                      <th className="px-4 py-3">Store Location</th>
                      <th className="px-4 py-3">Active Workforce</th>
                      <th className="px-4 py-3">Reports Submitted</th>
                      <th className="px-4 py-3">Missing Reports</th>
                      <th className="px-4 py-3">Compliance Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {compliance.locationBreakdown.map((loc) => (
                      <tr key={loc.locationId} className="hover:bg-ink-50">
                        <td className="px-4 py-3">
                          <span className="font-bold text-ink-900">{loc.locationName}</span>
                          <span className="ml-2 font-mono text-xs text-ink-400">({loc.locationCode})</span>
                        </td>
                        <td className="px-4 py-3 text-ink-800 font-medium">{loc.totalActive}</td>
                        <td className="px-4 py-3 text-emerald-700 font-bold">{loc.submitted}</td>
                        <td className="px-4 py-3 text-rose-700 font-bold">{loc.missing}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-ink-900">{loc.complianceRate}%</span>
                            <div className="h-2 w-24 rounded-full bg-ink-100 overflow-hidden">
                              <div
                                className="h-full bg-brand-600 rounded-full"
                                style={{ width: `${loc.complianceRate}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* TAB 5: ANDROID MOBILE APK DOWNLOAD */}
      {tab === 'apk' && (
        <div className="space-y-5">
          <Card className="card-pad border-brand-200/80 bg-gradient-to-r from-brand-50/30 to-white">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <span className="inline-flex items-center gap-1 rounded bg-brand-100 px-2.5 py-0.5 text-xs font-bold text-brand-800 mb-2">
                  <Icon name="smartphone" size={13} />
                  Official Android Mobile Application
                </span>
                <h2 className="text-xl font-bold text-ink-900">BSC Textiles HRMS for Android</h2>
                <p className="mt-1 text-sm text-ink-600 max-w-2xl">
                  Download and install the native Android application on your smartphone or tablet. Access live attendance geofencing, push notifications, daily task management, and End-of-Day reports from anywhere.
                </p>
              </div>
            </div>
          </Card>

          <div className="grid gap-5 md:grid-cols-2">
            {/* Release APK Card */}
            <Card className="card-pad flex flex-col justify-between border-emerald-200/80 shadow-xs">
              <div>
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800">
                    Recommended · Production
                  </span>
                  <span className="text-xs text-ink-400 font-mono">Size: 6.6 MB</span>
                </div>
                <h3 className="mt-3 text-lg font-bold text-ink-900">Production Release APK (v1.0.0)</h3>
                <p className="mt-1 text-xs text-ink-500">
                  Signed with the official BSC Textiles release keystore. Optimized for daily employee use across Belagavi, Davanagere, Shivamogga, and Head Office.
                </p>

                <ul className="mt-4 space-y-2 text-xs text-ink-700">
                  <li className="flex items-center gap-2">
                    <Icon name="check" size={14} className="text-emerald-600" />
                    <span>Signed and secure for Android 8.0 through Android 15</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Icon name="check" size={14} className="text-emerald-600" />
                    <span>Biometric login & persistent session storage</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Icon name="check" size={14} className="text-emerald-600" />
                    <span>Live GPS Store Geofencing for attendance check-in</span>
                  </li>
                </ul>
              </div>

              <div className="mt-6 pt-4 border-t border-ink-100">
                <a
                  href="/downloads/bsc-hrms-release.apk"
                  download="bsc-hrms-release.apk"
                  className="btn-primary w-full text-center flex items-center justify-center gap-2 py-2.5"
                >
                  <Icon name="download" size={16} />
                  <span>Download Release APK (6.6 MB)</span>
                </a>
              </div>
            </Card>

            {/* Debug APK Card */}
            <Card className="card-pad flex flex-col justify-between border-ink-200/80 shadow-xs">
              <div>
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">
                    Development / Testing
                  </span>
                  <span className="text-xs text-ink-400 font-mono">Size: 8.4 MB</span>
                </div>
                <h3 className="mt-3 text-lg font-bold text-ink-900">Debug APK (v1.0.0 Dev)</h3>
                <p className="mt-1 text-xs text-ink-500">
                  Unminified debug build with remote debugging capabilities and verbose system logging. Intended for IT administrators and QA verification.
                </p>

                <ul className="mt-4 space-y-2 text-xs text-ink-700">
                  <li className="flex items-center gap-2">
                    <Icon name="check" size={14} className="text-blue-600" />
                    <span>Enables Chrome Remote Webview inspection</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Icon name="check" size={14} className="text-blue-600" />
                    <span>Detailed console log output for network requests</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Icon name="check" size={14} className="text-blue-600" />
                    <span>Quick install without keystore certificate checks</span>
                  </li>
                </ul>
              </div>

              <div className="mt-6 pt-4 border-t border-ink-100">
                <a
                  href="/downloads/bsc-hrms-debug.apk"
                  download="bsc-hrms-debug.apk"
                  className="btn-secondary w-full text-center flex items-center justify-center gap-2 py-2.5"
                >
                  <Icon name="download" size={16} />
                  <span>Download Debug APK (8.4 MB)</span>
                </a>
              </div>
            </Card>
          </div>

          {/* Installation Instructions */}
          <Card className="card-pad">
            <h3 className="text-sm font-bold text-ink-900 mb-3">Simple 4-Step Android Installation Guide</h3>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white mb-2">1</span>
                <h4 className="text-xs font-bold text-ink-900">Download APK</h4>
                <p className="mt-1 text-[11px] text-ink-600">
                  Tap the &quot;Download Release APK&quot; button above directly on your Android phone or Chrome browser.
                </p>
              </div>

              <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white mb-2">2</span>
                <h4 className="text-xs font-bold text-ink-900">Open Downloads</h4>
                <p className="mt-1 text-[11px] text-ink-600">
                  Once downloaded, tap the notification or open your phone&apos;s Files / Downloads folder and tap <code className="font-mono text-[10px]">bsc-hrms-release.apk</code>.
                </p>
              </div>

              <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white mb-2">3</span>
                <h4 className="text-xs font-bold text-ink-900">Allow Unknown Apps</h4>
                <p className="mt-1 text-[11px] text-ink-600">
                  If prompted with &quot;Install unknown apps&quot;, tap <strong>Settings</strong> and toggle on <strong>Allow from this source</strong>.
                </p>
              </div>

              <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white mb-2">4</span>
                <h4 className="text-xs font-bold text-ink-900">Install & Sign In</h4>
                <p className="mt-1 text-[11px] text-ink-600">
                  Tap <strong>Install</strong>, open the app, and log in with your BSC Textiles employee credentials.
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* DETAIL & EDIT MODAL WITH AUDIT TRAIL */}
      <Modal
        open={Boolean(open)}
        onClose={() => {
          setOpen(null);
          setIsEditing(false);
        }}
        title={open ? (isEditing ? `Edit Report · ${open.reportDate}` : `Report · ${open.reportDate}`) : ''}
        description={open ? `${open.employeeName} (${open.employeeCode}) · ${open.designationTitle ?? ''} · ${open.departmentName ?? ''}` : undefined}
        size="lg"
        footer={
          open && (
            isEditing ? (
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-ink-500 font-medium">
                  Update work report details and status
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={savingEdit}
                    onClick={() => setIsEditing(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={savingEdit}
                    onClick={() => void saveEdit()}
                  >
                    {savingEdit ? 'Saving…' : 'Save & Update Status'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-800 hover:bg-brand-100 transition-colors shadow-xs"
                    onClick={() => startEditing(open)}
                  >
                    <Icon name="edit" size={13} className="text-brand-700" />
                    Edit & Update Status
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {open.status !== 'approved' && open.employeeId !== user?.id && (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void review(open.id, false)}>
                        Request correction
                      </button>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void review(open.id, true)}>
                        Approve report
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setOpen(null);
                      setIsEditing(false);
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            )
          )
        }
      >
        {open && (
          isEditing ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-xl border border-brand-200 bg-brand-50/70 p-3.5 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Status" hint="Update report status directly">
                    <select
                      className="input font-semibold text-ink-900"
                      value={editForm.status}
                      onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                    >
                      <option value="submitted">Submitted (Under Review)</option>
                      <option value="approved">Approved</option>
                      <option value="changes_requested">Changes Requested</option>
                    </select>
                  </Field>

                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Completed">
                      <input
                        type="number"
                        className="input font-bold"
                        min={0}
                        value={editForm.tasksCompleted}
                        onChange={(e) => setEditForm({ ...editForm, tasksCompleted: Math.max(0, Number(e.target.value)) })}
                      />
                    </Field>
                    <Field label="In Progress">
                      <input
                        type="number"
                        className="input font-bold"
                        min={0}
                        value={editForm.tasksInProgress}
                        onChange={(e) => setEditForm({ ...editForm, tasksInProgress: Math.max(0, Number(e.target.value)) })}
                      />
                    </Field>
                    <Field label="Pending">
                      <input
                        type="number"
                        className="input font-bold"
                        min={0}
                        value={editForm.tasksPending}
                        onChange={(e) => setEditForm({ ...editForm, tasksPending: Math.max(0, Number(e.target.value)) })}
                      />
                    </Field>
                  </div>
                </div>
              </div>

              <Field label="Work completed today" required hint="Minimum 10 characters">
                <textarea
                  className="input min-h-[110px]"
                  value={editForm.summary}
                  onChange={(e) => setEditForm({ ...editForm, summary: e.target.value })}
                  placeholder="Summarise the work you completed, decisions made and outcomes delivered."
                  required
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Problems encountered (optional)">
                  <textarea
                    className="input min-h-[75px]"
                    value={editForm.problems}
                    placeholder="Mention any technical or operational delays…"
                    onChange={(e) => setEditForm({ ...editForm, problems: e.target.value })}
                  />
                </Field>
                <Field label="Support required (optional)">
                  <textarea
                    className="input min-h-[75px]"
                    value={editForm.supportRequired}
                    placeholder="Mention responsible department or manager…"
                    onChange={(e) => setEditForm({ ...editForm, supportRequired: e.target.value })}
                  />
                </Field>
              </div>

              <Field label="Tomorrow's plan (optional)">
                <textarea
                  className="input min-h-[75px]"
                  value={editForm.tomorrowPlan}
                  placeholder="Tasks and activities planned for next day…"
                  onChange={(e) => setEditForm({ ...editForm, tomorrowPlan: e.target.value })}
                />
              </Field>

              {(has('reports.review', 'reports.view.all') || Boolean(open.reviewNote)) && (
                <Field label="Reviewer note / remarks (optional)">
                  <textarea
                    className="input min-h-[60px] bg-amber-50/50 border-amber-200"
                    value={editForm.reviewNote}
                    placeholder="Add feedback or reason for correction request…"
                    onChange={(e) => setEditForm({ ...editForm, reviewNote: e.target.value })}
                  />
                </Field>
              )}
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              {loadingDetail && <Skeleton lines={2} />}

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg bg-ink-50 p-2.5">
                  <p className="text-xs text-ink-500">Working hours</p>
                  <p className="font-semibold text-ink-900">{minutesToHours(open.totalMinutes)}</p>
                </div>
                <div className="rounded-lg bg-ink-50 p-2.5">
                  <p className="text-xs text-ink-500">Tasks Completed / Active / Pending</p>
                  <p className="font-semibold text-ink-900">
                    {open.tasksCompleted} / {open.tasksInProgress} / {open.tasksPending}
                  </p>
                </div>
                <div className="rounded-lg bg-ink-50 p-2.5">
                  <p className="text-xs text-ink-500">Status</p>
                  <StatusBadge status={open.status} />
                </div>
              </div>

              <section>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Work completed</p>
                <p className="mt-1 whitespace-pre-line text-ink-700">{open.summary}</p>
              </section>

              {open.problems && (
                <section>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Problems encountered</p>
                  <p className="mt-1 whitespace-pre-line text-ink-700">{open.problems}</p>
                </section>
              )}

              {open.supportRequired && (
                <section>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Support required</p>
                  <p className="mt-1 whitespace-pre-line text-ink-700">{open.supportRequired}</p>
                </section>
              )}

              {open.tomorrowPlan && (
                <section>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Tomorrow&apos;s plan</p>
                  <p className="mt-1 whitespace-pre-line text-ink-700">{open.tomorrowPlan}</p>
                </section>
              )}

              {open.reviewNote && (
                <section className="rounded-lg bg-amber-50 p-3 border border-amber-200">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Reviewer Note</p>
                  <p className="mt-1 text-amber-800">{open.reviewNote}</p>
                </section>
              )}

              {/* Complete Chronological Audit Trail */}
              {open.history && open.history.length > 0 && (
                <section className="mt-4 pt-3 border-t border-ink-100">
                  <p className="text-xs font-bold uppercase tracking-wider text-ink-500 mb-2">
                    Report Audit Trail & History
                  </p>
                  <div className="space-y-2">
                    {open.history.map((h) => (
                      <div key={h.id} className="rounded-lg bg-ink-50 p-2.5 text-xs border border-ink-100">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-ink-800">
                            {h.actorName} · <span className="uppercase text-[10px] text-brand-700 font-bold">{h.action.replace('_', ' ')}</span>
                          </span>
                          <span className="text-[11px] text-ink-400">{formatDateTime(h.createdAt)}</span>
                        </div>
                        {h.reviewNote && (
                          <p className="mt-1 text-ink-600 bg-white p-1.5 rounded border border-ink-100 font-mono text-[11px]">
                            {h.reviewNote}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <p className="text-xs text-ink-400 pt-2 border-t border-ink-100">
                Submitted on {formatDateTime(open.submittedAt)}{' '}
                {open.reviewedAt ? `· reviewed ${formatDateTime(open.reviewedAt)} by ${open.reviewerName ?? 'manager'}` : ''}
              </p>
            </div>
          )
        )}
      </Modal>
    </div>
  );
}
