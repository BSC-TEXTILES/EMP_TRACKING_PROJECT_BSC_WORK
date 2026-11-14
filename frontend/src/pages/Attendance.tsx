import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadReport, errorMessage } from '../lib/api';
import { useApi, useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { useAttendance } from '../lib/useAttendance';
import { AttendanceTimer } from '../components/AttendanceTimer';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { minutesToHours } from '../lib/format';
import type { AttendanceState } from '../lib/types';

interface HistoryRecord {
  id: number;
  date: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  status: string;
  totalMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  earlyDeparture: boolean;
  autoClosed: boolean;
  source: string;
}

interface Summary {
  period: string;
  presentDays: number;
  lateDays: number;
  halfDays: number;
  onLeaveDays: number;
  holidayCount: number;
  totalMinutes: number;
  averageMinutesPerDay: number;
  attendancePercent: number;
}

interface Correction {
  id: number;
  employee_id: number;
  full_name: string;
  work_date: string;
  requested_check_in: string | null;
  requested_check_out: string | null;
  reason: string;
  status: string;
  created_at: string;
}

interface TeamRow {
  employee_id: number;
  full_name: string;
  designation_title: string | null;
  status: string;
  check_in_at: string | null;
  check_out_at: string | null;
  total_minutes: number;
  is_late: number;
}

export default function Attendance() {
  useDocumentTitle('Attendance');
  const { has, user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'history';
  const attendance = useAttendance({ poll: true });
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [history, setHistory] = useState<HistoryRecord[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [corrections, setCorrections] = useState<Correction[] | null>(null);
  const [team, setTeam] = useState<TeamRow[] | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionForm, setCorrectionForm] = useState({ workDate: '', checkInAt: '', checkOutAt: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);

  const loadHistory = async (nextPeriod = period) => {
    const from = `${nextPeriod}-01`;
    const to = new Date(new Date(`${from}T00:00:00Z`).getFullYear(), new Date(`${from}T00:00:00Z`).getMonth() + 1, 0)
      .toISOString()
      .slice(0, 10);
    try {
      const [historyResult, summaryResult] = await Promise.all([
        api.get<{ records: HistoryRecord[] }>(`/attendance/history?from=${from}&to=${to}`),
        api.get<Summary>(`/attendance/summary?period=${nextPeriod}`),
      ]);
      setHistory(historyResult.records);
      setSummary(summaryResult);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    if (tab === 'history') void loadHistory();
    if (tab === 'corrections') {
      api
        .get<{ records: Correction[] }>('/attendance/corrections')
        .then((result) => setCorrections(result.records))
        .catch((caught) => toast.error(errorMessage(caught)));
    }
    if (tab === 'team') {
      api
        .get<{ records: TeamRow[] }>('/attendance/team')
        .then((result) => setTeam(result.records))
        .catch((caught) => toast.error(errorMessage(caught)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, period]);

  useSocketEvent('attendance:update', () => {
    void attendance.refresh();
    if (tab === 'team') {
      api.get<{ records: TeamRow[] }>('/attendance/team').then((result) => setTeam(result.records)).catch(() => undefined);
    }
  });

  const submitCorrection = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/attendance/corrections', {
        workDate: correctionForm.workDate,
        checkInAt: correctionForm.checkInAt ? new Date(correctionForm.checkInAt).toISOString() : undefined,
        checkOutAt: correctionForm.checkOutAt ? new Date(correctionForm.checkOutAt).toISOString() : undefined,
        reason: correctionForm.reason,
      });
      toast.success('Correction request submitted for approval.');
      setCorrectionOpen(false);
      setCorrectionForm({ workDate: '', checkInAt: '', checkOutAt: '', reason: '' });
      void loadHistory();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const review = async (id: number, approve: boolean) => {
    const note = approve ? '' : window.prompt('Reason for rejection:') ?? '';
    if (!approve && !note) return;
    try {
      await api.post(`/attendance/corrections/${id}/review`, { approve, note });
      toast.success(approve ? 'Correction approved and attendance updated.' : 'Correction rejected.');
      const result = await api.get<{ records: Correction[] }>('/attendance/corrections');
      setCorrections(result.records);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const state: AttendanceState | null = attendance.state;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Attendance & working hours"
        description="Every timestamp is generated by the server; the timer resumes correctly after refresh, logout or reconnection."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'attendance', format: 'xlsx', from: `${period}-01` })}>
              Export Excel
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setCorrectionOpen(true)}>
              Request correction
            </button>
          </>
        }
      />

      <AttendanceTimer state={state} loading={attendance.loading} pending={attendance.pending} onAction={attendance.act} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Present days', value: summary?.presentDays ?? '—' },
          { label: 'Late arrivals', value: summary?.lateDays ?? '—' },
          { label: 'Total hours', value: summary ? minutesToHours(summary.totalMinutes) : '—' },
          { label: 'Attendance %', value: summary ? `${summary.attendancePercent}%` : '—' },
        ].map((item) => (
          <Card key={item.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{item.label}</p>
            <p className="mt-1 text-xl font-semibold text-ink-900">{item.value}</p>
          </Card>
        ))}
      </div>

      <Card>
        <div className="px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'history', label: 'My attendance' },
              ...(has('attendance.view.team', 'attendance.view.all') ? [{ value: 'team', label: 'Team today' }] : []),
              { value: 'corrections', label: 'Corrections' },
            ]}
            value={tab}
            onChange={(value) => setParams({ tab: value })}
          />
        </div>

        {tab === 'history' && (
          <div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <label className="text-xs font-medium text-ink-500">Period</label>
              <input type="month" className="input w-auto" value={period} onChange={(event) => setPeriod(event.target.value)} />
              <button type="button" className="btn-secondary btn-sm" onClick={() => void loadHistory()}>
                Refresh
              </button>
            </div>
            {!history ? (
              <div className="p-4">
                <Skeleton lines={6} />
              </div>
            ) : history.length === 0 ? (
              <EmptyState title="No attendance records" description="Attendance will appear here after your first check-in." />
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Status</th>
                      <th>Check in</th>
                      <th>Check out</th>
                      <th>Worked</th>
                      <th>Break</th>
                      <th>Overtime</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((record) => (
                      <tr key={record.id}>
                        <td className="whitespace-nowrap font-medium text-ink-800">{record.date}</td>
                        <td>
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge status={record.status} />
                            {record.autoClosed && <Badge tone="warning">Auto-closed</Badge>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap">{record.checkInAt ? new Date(record.checkInAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td className="whitespace-nowrap">{record.checkOutAt ? new Date(record.checkOutAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td>{minutesToHours(record.totalMinutes)}</td>
                        <td>{minutesToHours(record.breakMinutes)}</td>
                        <td>{record.overtimeMinutes ? minutesToHours(record.overtimeMinutes) : '—'}</td>
                        <td className="text-xs text-ink-500">{record.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {summary && (
              <div className="flex flex-wrap gap-4 border-t border-ink-200 px-4 py-3 text-xs text-ink-500">
                <span>Half days: <strong className="text-ink-800">{summary.halfDays}</strong></span>
                <span>Leave days: <strong className="text-ink-800">{summary.onLeaveDays}</strong></span>
                <span>Holidays: <strong className="text-ink-800">{summary.holidayCount}</strong></span>
                <span>Average/day: <strong className="text-ink-800">{minutesToHours(summary.averageMinutesPerDay)}</strong></span>
              </div>
            )}
          </div>
        )}

        {tab === 'team' && (
          <div>
            {!team ? (
              <div className="p-4">
                <Skeleton lines={6} />
              </div>
            ) : team.length === 0 ? (
              <EmptyState title="No team members" description="Your reporting structure has no active employees." />
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Designation</th>
                      <th>Status</th>
                      <th>Check in</th>
                      <th>Check out</th>
                      <th>Worked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((row) => (
                      <tr key={row.employee_id}>
                        <td className="font-medium text-ink-800">{row.full_name}</td>
                        <td className="text-ink-500">{row.designation_title ?? '—'}</td>
                        <td>
                          <div className="flex items-center gap-1">
                            <StatusBadge status={row.status} />
                            {row.is_late ? <Badge tone="warning">Late</Badge> : null}
                          </div>
                        </td>
                        <td>{row.check_in_at ? new Date(row.check_in_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td>{row.check_out_at ? new Date(row.check_out_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td>{minutesToHours(row.total_minutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'corrections' && (
          <div>
            {!corrections ? (
              <div className="p-4">
                <Skeleton lines={4} />
              </div>
            ) : corrections.length === 0 ? (
              <EmptyState title="No correction requests" description="Attendance corrections you request or review will appear here." />
            ) : (
              <div className="divide-y divide-ink-100">
                {corrections.map((correction) => (
                  <div key={correction.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-ink-800">{correction.work_date}</p>
                        <StatusBadge status={correction.status} />
                        {correction.employee_id !== user?.id && <Badge tone="neutral">{correction.full_name}</Badge>}
                      </div>
                      <p className="mt-1 text-sm text-ink-600">{correction.reason}</p>
                      <p className="mt-1 text-xs text-ink-400">
                        Requested in {correction.requested_check_in ? new Date(correction.requested_check_in).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'} · out{' '}
                        {correction.requested_check_out ? new Date(correction.requested_check_out).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}
                      </p>
                    </div>
                    {correction.status === 'pending' && has('attendance.corrections.approve') && correction.employee_id !== user?.id && (
                      <div className="flex gap-2">
                        <button type="button" className="btn-primary btn-sm" onClick={() => void review(correction.id, true)}>
                          Approve
                        </button>
                        <button type="button" className="btn-secondary btn-sm" onClick={() => void review(correction.id, false)}>
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <Modal
        open={correctionOpen}
        onClose={() => setCorrectionOpen(false)}
        title="Request attendance correction"
        description="Corrections are recorded in the audit log and must be approved by your manager."
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCorrectionOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="correction-form" className="btn-primary" disabled={submitting}>
              Submit request
            </button>
          </>
        }
      >
        <form id="correction-form" onSubmit={submitCorrection} className="space-y-4">
          <Field label="Work date" required>
            <input
              type="date"
              className="input"
              max={new Date().toISOString().slice(0, 10)}
              value={correctionForm.workDate}
              onChange={(event) => setCorrectionForm({ ...correctionForm, workDate: event.target.value })}
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Correct check-in">
              <input
                type="datetime-local"
                className="input"
                value={correctionForm.checkInAt}
                onChange={(event) => setCorrectionForm({ ...correctionForm, checkInAt: event.target.value })}
              />
            </Field>
            <Field label="Correct check-out">
              <input
                type="datetime-local"
                className="input"
                value={correctionForm.checkOutAt}
                onChange={(event) => setCorrectionForm({ ...correctionForm, checkOutAt: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Reason" required>
            <textarea
              className="input min-h-[90px]"
              value={correctionForm.reason}
              onChange={(event) => setCorrectionForm({ ...correctionForm, reason: event.target.value })}
              placeholder="Explain why this correction is required"
              minLength={10}
              required
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
