import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { formatDate, formatDateTime, minutesToHours } from '../lib/format';

interface Report {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  designationTitle: string | null;
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
}

interface Suggestions {
  date: string;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksPending: number;
  attendance: { check_in_at: string | null; check_out_at: string | null; total_minutes: number } | null;
}

export default function DailyReports() {
  useDocumentTitle('Daily work reports');
  const { user, has } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'mine';
  const [items, setItems] = useState<Report[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<Report | null>(null);
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

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (status) query.set('status', status);
      const result = await api.get<{ items: Report[]; total: number }>(`/reports?${query.toString()}`);
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/reports', {
        reportDate: new Date().toISOString().slice(0, 10),
        ...form,
      });
      toast.success('Daily report submitted for manager review.');
      setForm({ ...form, summary: '', problems: '', supportRequired: '', tomorrowPlan: '' });
      await load();
      const result = await api.get<{ report: Report | null }>('/reports/today');
      setTodayReport(result.report);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const review = async (id: number, approve: boolean) => {
    const note = approve ? window.prompt('Optional note for the employee:') ?? '' : window.prompt('What should be corrected?') ?? '';
    if (!approve && !note) return;
    try {
      await api.post(`/reports/${id}/review`, { approve, note: note || undefined });
      toast.success(approve ? 'Report approved.' : 'Correction requested.');
      setOpen(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const visible = (items ?? []).filter((report) => (tab === 'mine' ? report.employeeId === user?.id : report.employeeId !== user?.id));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Daily work reports"
        description="A permanent record of what was planned, delivered, blocked and requested each day."
      />

      {!todayReport && suggestions && (
        <Card className="card-pad">
          <SectionHeader
            title="Submit today's report"
            description={`${formatDate(new Date().toISOString())} · suggestions derived from your live tasks and attendance`}
          />
          <form onSubmit={submit} className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">Tasks completed</p>
                <p className="text-lg font-semibold text-ink-900">{form.tasksCompleted}</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">In progress</p>
                <p className="text-lg font-semibold text-ink-900">{form.tasksInProgress}</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">Pending</p>
                <p className="text-lg font-semibold text-ink-900">{form.tasksPending}</p>
              </div>
            </div>
            <Field label="Work completed today" required hint="Minimum 10 characters">
              <textarea
                className="input min-h-[100px]"
                value={form.summary}
                onChange={(event) => setForm({ ...form, summary: event.target.value })}
                placeholder="Summarise the work you completed, decisions made and outcomes delivered."
                minLength={10}
                required
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Problems encountered">
                <textarea className="input min-h-[70px]" value={form.problems} onChange={(event) => setForm({ ...form, problems: event.target.value })} />
              </Field>
              <Field label="Support required">
                <textarea className="input min-h-[70px]" value={form.supportRequired} onChange={(event) => setForm({ ...form, supportRequired: event.target.value })} />
              </Field>
            </div>
            <Field label="Tomorrow's plan">
              <textarea className="input min-h-[70px]" value={form.tomorrowPlan} onChange={(event) => setForm({ ...form, tomorrowPlan: event.target.value })} />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-500">
                Attendance today: {suggestions.attendance?.total_minutes ? minutesToHours(suggestions.attendance.total_minutes) : 'no hours recorded yet'}
              </p>
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? 'Submitting…' : 'Submit report'}
              </button>
            </div>
          </form>
        </Card>
      )}

      {todayReport && (
        <Card className="card-pad">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-ink-900">Today&apos;s report submitted</p>
              <p className="text-xs text-ink-500">
                {formatDateTime(todayReport.submittedAt)} · reviewed by {todayReport.reviewerName ?? 'pending'}
              </p>
            </div>
            <StatusBadge status={todayReport.status} />
          </div>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-600">{todayReport.summary}</p>
        </Card>
      )}

      <Card>
        <div className="px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'mine', label: 'My reports' },
              ...(has('reports.view.team', 'reports.view.all') ? [{ value: 'team', label: 'Team reports' }] : []),
            ]}
            value={tab}
            onChange={(value) => setParams({ tab: value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <select className="input w-auto" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="changes_requested">Changes requested</option>
          </select>
          <Badge tone="neutral">{visible.length} on this page</Badge>
        </div>

        {!items ? (
          <div className="p-4">
            <Skeleton lines={6} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title="No reports" description="Reports submitted for the selected scope will appear here." />
        ) : (
          <div className="divide-y divide-ink-100">
            {visible.map((report) => (
              <button key={report.id} type="button" className="flex w-full flex-wrap items-start justify-between gap-3 px-4 py-3 text-left hover:bg-ink-50" onClick={() => setOpen(report)}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink-900">{report.reportDate}</p>
                    <StatusBadge status={report.status} />
                    {tab === 'team' && <Badge tone="brand">{report.employeeName}</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-ink-600">{report.summary}</p>
                  <p className="mt-1 text-xs text-ink-400">
                    {report.tasksCompleted} completed · {report.tasksInProgress} in progress · {report.tasksPending} pending · {minutesToHours(report.totalMinutes)}
                  </p>
                </div>
                <div className="text-right text-xs text-ink-500">
                  <p>{formatDateTime(report.submittedAt)}</p>
                  {report.reviewerName && <p>Reviewed by {report.reviewerName}</p>}
                </div>
              </button>
            ))}
          </div>
        )}
        <Pagination page={page} pageSize={20} total={total} onPage={setPage} />
      </Card>

      <Modal
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open ? `Report · ${open.reportDate}` : ''}
        description={open ? `${open.employeeName} · ${open.designationTitle ?? ''} · ${open.departmentName ?? ''}` : undefined}
        size="lg"
        footer={
          open && has('reports.review') && open.status !== 'approved' && open.employeeId !== user?.id ? (
            <>
              <button type="button" className="btn-secondary" onClick={() => void review(open.id, false)}>
                Request correction
              </button>
              <button type="button" className="btn-primary" onClick={() => void review(open.id, true)}>
                Approve report
              </button>
            </>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => setOpen(null)}>
              Close
            </button>
          )
        }
      >
        {open && (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-ink-50 p-2.5">
                <p className="text-xs text-ink-500">Working hours</p>
                <p className="font-semibold text-ink-900">{minutesToHours(open.totalMinutes)}</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-2.5">
                <p className="text-xs text-ink-500">Tasks</p>
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
              <section className="rounded-lg bg-amber-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Reviewer note</p>
                <p className="mt-1 text-amber-800">{open.reviewNote}</p>
              </section>
            )}
            <p className="text-xs text-ink-400">
              Submitted {formatDateTime(open.submittedAt)} {open.reviewedAt ? `· reviewed ${formatDateTime(open.reviewedAt)}` : ''}
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
