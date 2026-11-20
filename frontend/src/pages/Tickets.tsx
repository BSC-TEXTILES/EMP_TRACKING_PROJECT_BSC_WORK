import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, fileUrl } from '../lib/api';
import { useDocumentTitle, useDebounced } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, PriorityBadge, Skeleton, StatCard, StatusBadge } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDateTime, titleize } from '../lib/format';
import type { PickerEmployee, TicketSummary } from '../lib/types';

export const CATEGORIES = [
  'Hardware Issues',
  'Software Issues',
  'Printer Issues',
  'Login Issues',
  'Network Issues',
  'Store Operations',
  'Attendance Issues',
  'HR Issues',
  'Payroll Issues',
  'Customer Complaints',
  'Infrastructure Issues',
  'Application Errors',
  'Website Issues',
  'Database Issues',
  'Email Issues',
  'Task Management Issues',
  'General Requests',
];

interface Stats {
  total: number;
  open: number;
  resolved: number;
  breached: number;
  mine: number;
}

export default function Tickets() {
  useDocumentTitle('Tickets & Support Requests');
  const { user, has, canAny } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<TicketSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<TicketSummary | null>(null);
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assignees, setAssignees] = useState<PickerEmployee[]>([]);

  // Action dialog states
  const [actionType, setActionType] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<number | ''>('');
  const [feedbackRating, setFeedbackRating] = useState<number>(5);

  // Edit & Delete states
  const [editTicket, setEditTicket] = useState<TicketSummary | null>(null);
  const [deleteConfirmTicket, setDeleteConfirmTicket] = useState<TicketSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (status) query.set('status', status);
      if (priorityFilter) query.set('priority', priorityFilter);
      if (category) query.set('category', category);
      if (debouncedSearch) query.set('search', debouncedSearch);
      const [list, stat] = await Promise.all([
        api.get<{ items: TicketSummary[]; total: number }>(`/tickets?${query.toString()}`),
        api.get<Stats>('/tickets/stats'),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setStats(stat);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, priorityFilter, category, debouncedSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ employees: PickerEmployee[] }>('/employees/picker')
      .then((result) => setAssignees(result.employees))
      .catch(() => undefined);
  }, []);

  useSocketEvent('ticket:updated', () => {
    void load();
    if (detail) void openDetail(detail.id, true);
  });
  useSocketEvent('ticket:created', () => void load());
  useSocketEvent('ticket:deleted', (data: any) => {
    void load();
    if (detail && data?.id === detail.id) {
      setDetail(null);
    }
  });

  const handleDeleteTicket = async () => {
    if (!deleteConfirmTicket) return;
    setDeleteBusy(true);
    try {
      await api.del(`/tickets/${deleteConfirmTicket.id}`);
      toast.success(`Ticket ${deleteConfirmTicket.ticketNo} deleted successfully.`);
      if (detail?.id === deleteConfirmTicket.id) {
        setDetail(null);
      }
      setDeleteConfirmTicket(null);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const openDetail = async (id: number, silent = false) => {
    try {
      const result = await api.get<TicketSummary>(`/tickets/${id}`);
      setDetail(result);
    } catch (caught) {
      if (!silent) toast.error(errorMessage(caught));
    }
  };

  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.post<TicketSummary>(`/tickets/${detail.id}/action`, { action, ...payload });
      setDetail(result);
      await load();
      toast.success('Ticket updated successfully.');
      setActionType(null);
      setActionNote('');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleActionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionType) return;

    if (actionType === 'assign') {
      if (!selectedAssigneeId) {
        toast.error('Please select an employee to assign.');
        return;
      }
      await act('assign', { assigneeId: Number(selectedAssigneeId) });
    } else if (actionType === 'resolve') {
      if (!actionNote.trim()) {
        toast.error('Please describe the resolution details.');
        return;
      }
      await act('resolve', { resolution: actionNote.trim() });
    } else if (actionType === 'feedback') {
      await act('feedback', { rating: feedbackRating, note: actionNote.trim() || undefined });
    } else if (actionType === 'wait_info') {
      await act('wait_info', { note: actionNote.trim() || undefined });
    } else if (actionType === 'reopen') {
      await act('reopen', { note: actionNote.trim() || undefined });
    } else if (actionType === 'escalate') {
      await act('escalate', { note: actionNote.trim() || undefined });
    }
  };

  const addComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail || !comment.trim()) return;
    try {
      const result = await api.post<TicketSummary>(`/tickets/${detail.id}/comments`, { body: comment, isInternal: internal });
      setDetail(result);
      setComment('');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Support & Issue Tickets"
        description="Raise tickets for store POS, printer, IT, software, or store maintenance issues with rapid resolution."
        actions={
          has('tickets.create') ? (
            <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={15} /> Raise Support Ticket
            </button>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open tickets" value={stats?.open ?? '—'} tone="warning" icon={<Icon name="ticket" size={18} />} />
        <StatCard label="Resolved" value={stats?.resolved ?? '—'} tone="success" icon={<Icon name="check" size={18} />} />
        <StatCard label="SLA breached" value={stats?.breached ?? '—'} tone="danger" icon={<Icon name="clock" size={18} />} />
        <StatCard label="Raised by me" value={stats?.mine ?? '—'} tone="neutral" icon={<Icon name="report" size={18} />} />
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <div className="relative min-w-[180px] flex-1">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-9"
              placeholder="Search ticket number, subject, issue…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            className="input w-auto"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {['new', 'assigned', 'acknowledged', 'in_progress', 'waiting_information', 'resolved', 'closed', 'reopened', 'cancelled'].map((value) => (
              <option key={value} value={value}>
                {titleize(value)}
              </option>
            ))}
          </select>
          <select
            className="input w-auto"
            value={priorityFilter}
            onChange={(event) => {
              setPriorityFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All priorities</option>
            {['critical', 'high', 'medium', 'low'].map((value) => (
              <option key={value} value={value}>
                {titleize(value)}
              </option>
            ))}
          </select>
          <select
            className="input w-auto"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        {!items ? (
          <div className="p-4">
            <Skeleton lines={7} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No tickets found"
            description="No support tickets match your filters. Click 'Raise Support Ticket' to submit a new issue."
            action={
              has('tickets.create') ? (
                <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  <Icon name="plus" size={15} /> Raise Support Ticket
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Category</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Assignee</th>
                    <th>SLA Target</th>
                    <th>Created</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((ticket) => (
                    <tr key={ticket.id} className="cursor-pointer hover:bg-ink-50/70" onClick={() => void openDetail(ticket.id)}>
                      <td className="max-w-[280px]">
                        <p className="font-semibold text-ink-900 break-words">{ticket.subject}</p>
                        <p className="text-xs text-ink-400 mt-0.5">
                          {ticket.ticketNo} · {ticket.requesterName}
                        </p>
                      </td>
                      <td className="text-ink-600">
                        <span className="font-medium text-ink-800">{ticket.category}</span>
                        {ticket.assignedTeam && <p className="text-xs text-ink-400">{ticket.assignedTeam}</p>}
                      </td>
                      <td>
                        <PriorityBadge priority={ticket.priority} />
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusBadge status={ticket.status} />
                          {ticket.slaBreached && <Badge tone="danger">SLA Breached</Badge>}
                        </div>
                      </td>
                      <td className="text-ink-600">{ticket.assigneeName ?? <span className="text-ink-400">Unassigned</span>}</td>
                      <td className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(ticket.slaDueAt)}</td>
                      <td className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(ticket.createdAt)}</td>
                      <td className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            className="p-1.5 rounded-lg text-ink-500 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                            title="Edit Ticket"
                            onClick={() => setEditTicket(ticket)}
                          >
                            <Icon name="edit" size={16} />
                          </button>
                          <button
                            type="button"
                            className="p-1.5 rounded-lg text-ink-500 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                            title="Delete Ticket"
                            onClick={() => setDeleteConfirmTicket(ticket)}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={20} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {/* Ticket Detail Modal */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.subject ?? ''}
        description={detail ? `${detail.ticketNo} · raised by ${detail.requesterName}` : undefined}
        size="lg"
        footer={
          detail ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {canAny('tickets.assign') && !['closed', 'cancelled'].includes(detail.status) && (
                  <button
                    className="btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setSelectedAssigneeId(detail.assigneeId || (assignees[0]?.id ?? ''));
                      setActionType('assign');
                    }}
                  >
                    Assign Staff
                  </button>
                )}
                {['assigned', 'acknowledged', 'in_progress', 'waiting_information', 'reopened'].includes(detail.status) &&
                  (detail.assigneeId === user?.id || canAny('tickets.assign')) && (
                    <>
                      {detail.status === 'assigned' && (
                        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('acknowledge')}>
                          Acknowledge
                        </button>
                      )}
                      {['assigned', 'acknowledged'].includes(detail.status) && (
                        <button className="btn-primary btn-sm" disabled={busy} onClick={() => void act('start')}>
                          Start Work
                        </button>
                      )}
                      {detail.status === 'in_progress' && (
                        <button
                          className="btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => {
                            setActionType('wait_info');
                            setActionNote('');
                          }}
                        >
                          Waiting for Info
                        </button>
                      )}
                      {['acknowledged', 'in_progress', 'waiting_information'].includes(detail.status) && (
                        <button
                          className="btn-primary btn-sm bg-emerald-600 hover:bg-emerald-700"
                          disabled={busy}
                          onClick={() => {
                            setActionType('resolve');
                            setActionNote('');
                          }}
                        >
                          ✓ Mark Resolved
                        </button>
                      )}
                    </>
                  )}
                {detail.status === 'resolved' && (detail.requesterId === user?.id || canAny('tickets.assign')) && (
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('close')}>
                    Close Ticket
                  </button>
                )}
                {['resolved', 'closed'].includes(detail.status) && detail.requesterId === user?.id && !detail.feedbackRating && (
                  <button
                    className="btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setActionType('feedback');
                      setFeedbackRating(5);
                      setActionNote('');
                    }}
                  >
                    ★ Leave Feedback
                  </button>
                )}
                {['resolved', 'closed'].includes(detail.status) && (detail.requesterId === user?.id || canAny('tickets.assign')) && (
                  <button
                    className="btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setActionType('reopen');
                      setActionNote('');
                    }}
                  >
                    Reopen
                  </button>
                )}
                {!['resolved', 'closed', 'cancelled'].includes(detail.status) && canAny('tickets.assign') && (
                  <button
                    className="btn-ghost btn-sm text-rose-600 hover:bg-rose-50"
                    disabled={busy}
                    onClick={() => {
                      setActionType('escalate');
                      setActionNote('');
                    }}
                  >
                    Escalate
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-brand-700 hover:bg-brand-50"
                  onClick={() => setEditTicket(detail)}
                >
                  <Icon name="edit" size={14} />
                  Edit Ticket
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-rose-600 hover:bg-rose-50 border-rose-200"
                  onClick={() => setDeleteConfirmTicket(detail)}
                >
                  <Icon name="trash" size={14} />
                  Delete
                </button>
                <button className="btn-secondary btn-sm" onClick={() => setDetail(null)}>
                  Close
                </button>
              </div>
            </div>
          ) : null
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              <PriorityBadge priority={detail.priority} />
              <Badge tone="brand">{detail.category}</Badge>
              {detail.departmentName && <Badge tone="neutral">{detail.departmentName}</Badge>}
              {detail.slaBreached && <Badge tone="danger">SLA Breached</Badge>}
              {detail.feedbackRating && <Badge tone="success">Rated {detail.feedbackRating} / 5 ★</Badge>}
            </div>

            <div className="rounded-lg bg-ink-50/70 p-3.5 text-sm text-ink-800">
              <p className="whitespace-pre-line leading-relaxed">{detail.description}</p>
            </div>

            {detail.issueDetails && (
              <div className="grid gap-2.5 rounded-lg border border-ink-200 bg-white p-3 text-xs sm:grid-cols-2">
                {Object.entries(detail.issueDetails)
                  .filter(([, value]) => value !== null && value !== '' && typeof value !== 'object')
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt className="font-semibold text-ink-500 uppercase tracking-wider text-[10px]">
                        {key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()).replace('And Os', 'and OS')}
                      </dt>
                      <dd className="mt-0.5 text-ink-900 font-medium whitespace-pre-wrap">{String(value)}</dd>
                    </div>
                  ))}
              </div>
            )}

            {!!detail.attachments?.length && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-ink-700">Proof & Attachments</p>
                <div className="flex flex-wrap gap-2">
                  {detail.attachments.map((file) => (
                    <a
                      key={file.file_id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                      href={fileUrl(file.file_id, true)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="file" size={14} className="text-brand-600" />
                      {file.original_name}
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-2 rounded-lg border border-ink-100 bg-ink-50/50 p-3 text-xs text-ink-600 sm:grid-cols-2">
              <p>
                <strong className="text-ink-800">Assigned Team:</strong> {detail.assignedTeam ?? '—'}
              </p>
              <p>
                <strong className="text-ink-800">Assignee:</strong> {detail.assigneeName ?? 'Unassigned'}
              </p>
              <p>
                <strong className="text-ink-800">SLA Due:</strong> {formatDateTime(detail.slaDueAt)}
              </p>
              <p>
                <strong className="text-ink-800">Resolved At:</strong> {formatDateTime(detail.resolvedAt) || 'Pending'}
              </p>
            </div>

            {detail.resolution && (
              <div className="rounded-lg bg-emerald-50 p-3.5 text-sm text-emerald-800 border border-emerald-200">
                <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">Resolution Summary</p>
                <p className="mt-1 whitespace-pre-line">{detail.resolution}</p>
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">Activity & Conversation</p>
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {detail.comments?.length ? (
                  detail.comments.map((entry) => (
                    <div key={entry.id} className={`rounded-lg px-3 py-2 text-sm ${entry.isInternal ? 'bg-amber-50 border border-amber-200' : 'bg-ink-50'}`}>
                      <p className="text-xs font-semibold text-ink-700">
                        {entry.authorName} <span className="font-normal text-ink-400">· {formatDateTime(entry.createdAt)}</span>
                        {entry.isInternal && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.2 text-[10px] font-bold uppercase text-amber-800">internal</span>}
                      </p>
                      <p className="mt-0.5 whitespace-pre-line text-ink-800">{entry.body}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-ink-400">No comments recorded yet.</p>
                )}
              </div>
              <form onSubmit={addComment} className="mt-2.5 space-y-2">
                <input className="input" placeholder="Add an update or response…" value={comment} onChange={(event) => setComment(event.target.value)} />
                <div className="flex items-center justify-between">
                  {canAny('tickets.assign') ? (
                    <label className="flex items-center gap-2 text-xs text-ink-600">
                      <input type="checkbox" className="h-4 w-4 rounded border-ink-300" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
                      Internal note (visible only to support team)
                    </label>
                  ) : (
                    <span />
                  )}
                  <button type="submit" className="btn-primary btn-sm" disabled={!comment.trim()}>
                    Send Update
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </Modal>

      {/* Ticket Action Modal (Assign / Resolve / Feedback / Escalate / Reopen) */}
      <Modal
        open={Boolean(actionType)}
        onClose={() => setActionType(null)}
        title={
          actionType === 'assign'
            ? 'Assign Ticket to Staff'
            : actionType === 'resolve'
            ? 'Resolve Ticket'
            : actionType === 'feedback'
            ? 'Resolution Feedback'
            : actionType === 'wait_info'
            ? 'Request Additional Information'
            : actionType === 'reopen'
            ? 'Reopen Ticket'
            : 'Escalate Ticket'
        }
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setActionType(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="ticket-action-form"
              className="btn-primary"
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </>
        }
      >
        <form id="ticket-action-form" onSubmit={handleActionSubmit} className="space-y-4">
          {actionType === 'assign' && (
            <Field label="Assign to Employee" required>
              <select
                className="input"
                value={selectedAssigneeId}
                onChange={(e) => setSelectedAssigneeId(e.target.value === '' ? '' : Number(e.target.value))}
                required
              >
                <option value="">Select support team member</option>
                {assignees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.full_name} {emp.designation_title ? `(${emp.designation_title})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {actionType === 'resolve' && (
            <Field label="Resolution Details" required hint="Explain how the problem was resolved">
              <textarea
                className="input min-h-[100px]"
                placeholder="e.g. Replaced POS printer ribbon, cleared print spooler cache, and printed test billing slip successfully."
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                required
              />
            </Field>
          )}

          {actionType === 'feedback' && (
            <>
              <Field label="Rate the Resolution">
                <div className="flex items-center gap-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setFeedbackRating(star)}
                      className={`text-2xl transition-colors ${
                        star <= feedbackRating ? 'text-amber-400' : 'text-ink-200'
                      }`}
                    >
                      ★
                    </button>
                  ))}
                  <span className="ml-2 text-sm font-semibold text-ink-700">
                    {feedbackRating === 5
                      ? '5 - Excellent'
                      : feedbackRating === 4
                      ? '4 - Very Good'
                      : feedbackRating === 3
                      ? '3 - Satisfactory'
                      : feedbackRating === 2
                      ? '2 - Poor'
                      : '1 - Unsatisfactory'}
                  </span>
                </div>
              </Field>
              <Field label="Comments / Feedback (Optional)">
                <textarea
                  className="input min-h-[80px]"
                  placeholder="Share any comments regarding the support experience..."
                  value={actionNote}
                  onChange={(e) => setActionNote(e.target.value)}
                />
              </Field>
            </>
          )}

          {['wait_info', 'reopen', 'escalate'].includes(actionType || '') && (
            <Field
              label={
                actionType === 'wait_info'
                  ? 'Information Required'
                  : actionType === 'reopen'
                  ? 'Reason for Reopening'
                  : 'Escalation Reason'
              }
              required
            >
              <textarea
                className="input min-h-[90px]"
                placeholder="Please describe in detail..."
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                required
              />
            </Field>
          )}
        </form>
      </Modal>

      <CreateTicket
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(ticket) => {
          setCreateOpen(false);
          void load();
          void openDetail(ticket.id);
        }}
      />

      <EditTicketModal
        ticket={editTicket}
        open={Boolean(editTicket)}
        assignees={assignees}
        onClose={() => setEditTicket(null)}
        onSaved={(updated) => {
          setEditTicket(null);
          if (detail?.id === updated.id) {
            setDetail(updated);
          }
          void load();
        }}
      />

      <DeleteTicketModal
        ticket={deleteConfirmTicket}
        open={Boolean(deleteConfirmTicket)}
        busy={deleteBusy}
        onClose={() => setDeleteConfirmTicket(null)}
        onConfirm={handleDeleteTicket}
      />
    </div>
  );
}

function EditTicketModal({
  ticket,
  open,
  assignees,
  onClose,
  onSaved,
}: {
  ticket: TicketSummary | null;
  open: boolean;
  assignees: PickerEmployee[];
  onClose: () => void;
  onSaved: (ticket: TicketSummary) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    subject: '',
    description: '',
    category: CATEGORIES[0],
    priority: 'medium',
    status: 'new',
    assigneeId: '' as number | '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (ticket) {
      setForm({
        subject: ticket.subject,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        assigneeId: ticket.assigneeId ?? '',
      });
    }
  }, [ticket]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticket) return;
    if (!form.subject.trim()) {
      toast.error('Subject is required');
      return;
    }
    if (!form.description.trim()) {
      toast.error('Description is required');
      return;
    }
    setSaving(true);
    try {
      const updated = await api.put<TicketSummary>(`/tickets/${ticket.id}`, {
        subject: form.subject.trim(),
        description: form.description.trim(),
        category: form.category,
        priority: form.priority,
        status: form.status,
        assigneeId: form.assigneeId ? Number(form.assigneeId) : null,
      });
      toast.success('Ticket updated successfully');
      onSaved(updated);
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
      title={`Edit Ticket · ${ticket?.ticketNo ?? ''}`}
      description="Update ticket details, priority, assignment, or status."
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Subject" required>
          <input
            className="input"
            value={form.subject}
            onChange={(e) => setForm((prev) => ({ ...prev, subject: e.target.value }))}
            required
            placeholder="Brief summary of the issue"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category" required>
            <select
              className="input"
              value={form.category}
              onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Priority" required>
            <select
              className="input"
              value={form.priority}
              onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value }))}
            >
              <option value="low">Low (72 h SLA)</option>
              <option value="medium">Medium (48 h SLA)</option>
              <option value="high">High (24 h SLA)</option>
              <option value="critical">Critical (4 h SLA)</option>
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
              {['new', 'assigned', 'acknowledged', 'in_progress', 'waiting_information', 'resolved', 'closed', 'reopened', 'cancelled'].map((st) => (
                <option key={st} value={st}>
                  {titleize(st)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Assignee">
            <select
              className="input"
              value={form.assigneeId}
              onChange={(e) => setForm((prev) => ({ ...prev, assigneeId: e.target.value ? Number(e.target.value) : '' }))}
            >
              <option value="">Unassigned</option>
              {assignees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.full_name} ({emp.employee_code})
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Description" required>
          <textarea
            className="input min-h-[110px]"
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            required
            rows={4}
            placeholder="Detailed description of the issue or request"
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

function DeleteTicketModal({
  ticket,
  open,
  busy,
  onClose,
  onConfirm,
}: {
  ticket: TicketSummary | null;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Confirm Delete Ticket" size="sm">
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Are you sure you want to permanently delete ticket{' '}
          <strong className="text-ink-900">{ticket?.ticketNo}</strong> (<em>{ticket?.subject}</em>)?
        </p>
        <p className="text-xs text-rose-600 font-medium">
          This action will remove the ticket, associated comments, attachments, and logs. It cannot be undone.
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
            {busy ? 'Deleting…' : 'Delete Ticket'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CreateTicket({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (ticket: TicketSummary) => void }) {
  const toast = useToast();
  const { user } = useAuth();

  const [form, setForm] = useState({
    subject: '',
    description: '',
    category: CATEGORIES[0],
    priority: 'medium',
  });

  const [attachments, setAttachments] = useState<{ id: number; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [issueDetails, setIssueDetails] = useState<Record<string, string>>({
    device: '',
    affectedModule: '',
    errorCode: '',
    impact: 'individual',
  });
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.subject.trim() || form.subject.trim().length < 4) {
      toast.error('Please enter a clear subject (at least 4 characters).');
      return;
    }
    if (!form.description.trim() || form.description.trim().length < 10) {
      toast.error('Please provide a description of the issue (at least 10 characters).');
      return;
    }

    setBusy(true);
    try {
      const ticket = await api.post<TicketSummary>('/tickets', {
        subject: form.subject.trim(),
        description: form.description.trim(),
        category: form.category,
        priority: form.priority,
        attachmentIds: attachments.map((file) => file.id),
        issueDetails: {
          impact: issueDetails.impact || 'individual',
          ...(issueDetails.device ? { device: issueDetails.device.trim() } : {}),
          ...(issueDetails.affectedModule ? { affectedModule: issueDetails.affectedModule.trim() } : {}),
          ...(issueDetails.errorCode ? { errorCode: issueDetails.errorCode.trim() } : {}),
        },
      });

      toast.success(`Ticket ${ticket.ticketNo} created successfully! Assigned to ${ticket.assignedTeam ?? 'Support Team'}.`);
      setForm({ subject: '', description: '', category: CATEGORIES[0], priority: 'medium' });
      setAttachments([]);
      setIssueDetails({ device: '', affectedModule: '', errorCode: '', impact: 'individual' });
      setShowAdvanced(false);
      onCreated(ticket);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Raise a Support Ticket"
      description="Report an operational, POS, IT or store issue for immediate resolution."
      size="md"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="create-ticket-form" className="btn-primary" disabled={busy || uploading}>
            {busy ? 'Creating Ticket…' : 'Submit Ticket'}
          </button>
        </>
      }
    >
      <form id="create-ticket-form" onSubmit={submit} className="space-y-4">
        {/* Requester Identity Banner */}
        <div className="flex items-center gap-3 rounded-xl border border-ink-200 bg-ink-50/70 p-3">
          <Avatar name={user?.fullName} src={user?.photoUrl} size={38} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-ink-900">{user?.fullName}</span>
              {user?.employeeCode && (
                <span className="rounded bg-white px-1.5 py-0.5 text-[11px] font-medium text-ink-600 border border-ink-200">
                  {user.employeeCode}
                </span>
              )}
            </div>
            <p className="text-xs text-ink-500">
              {user?.designationTitle ?? 'Employee'} · {user?.locationName ?? 'Store Location'}
              {user?.departmentName ? ` · ${user.departmentName}` : ''}
            </p>
          </div>
        </div>

        {/* Subject */}
        <Field label="What is the issue?" required hint="A short summary of what went wrong">
          <input
            className="input"
            placeholder="e.g. Counter 2 POS printer is offline and not printing receipts"
            value={form.subject}
            onChange={(event) => setForm({ ...form, subject: event.target.value })}
            minLength={4}
            required
          />
        </Field>

        {/* Category & Priority */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Issue Category" required>
            <select
              className="input"
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
            >
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Priority / Urgency">
            <select
              className="input"
              value={form.priority}
              onChange={(event) => setForm({ ...form, priority: event.target.value })}
            >
              <option value="low">Low (General Query)</option>
              <option value="medium">Medium (Normal Work Issue)</option>
              <option value="high">High (Urgent Impact)</option>
              <option value="critical">Critical (Store / POS Down)</option>
            </select>
          </Field>
        </div>

        {/* Priority quick selector pills */}
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          {[
            { id: 'low', label: 'Low', color: form.priority === 'low' ? 'bg-ink-100 border-ink-400 font-bold' : 'border-ink-200 text-ink-600' },
            { id: 'medium', label: 'Medium', color: form.priority === 'medium' ? 'bg-amber-100 border-amber-500 text-amber-900 font-bold' : 'border-ink-200 text-ink-600' },
            { id: 'high', label: 'High', color: form.priority === 'high' ? 'bg-orange-100 border-orange-500 text-orange-900 font-bold' : 'border-ink-200 text-ink-600' },
            { id: 'critical', label: 'Critical', color: form.priority === 'critical' ? 'bg-rose-100 border-rose-500 text-rose-900 font-bold' : 'border-ink-200 text-ink-600' },
          ].map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setForm({ ...form, priority: p.id })}
              className={`rounded-lg border py-1.5 transition-colors ${p.color}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Description */}
        <Field label="Detailed Description" required hint="Include error messages or steps to help the team resolve it quickly">
          <textarea
            className="input min-h-[110px]"
            placeholder="Please describe what happened, any error code shown, and how it is affecting operations..."
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            minLength={10}
            required
          />
        </Field>

        {/* Screenshots / Attachments Upload */}
        <div className="space-y-2">
          <span className="label mb-0">Screenshot or Document Proof (Optional)</span>
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-ink-300 bg-ink-50/50 p-3 hover:border-brand-400 hover:bg-brand-50/20 transition-colors">
            <Icon name="camera" size={18} className="text-brand-600" />
            <span className="text-xs font-semibold text-ink-700">Attach Screenshot or Photo</span>
            <input
              type="file"
              multiple
              className="hidden"
              disabled={uploading || busy}
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.csv"
              onChange={async (event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                if (files.length + attachments.length > 5) {
                  toast.error('Attach no more than 5 files.');
                  return;
                }
                setUploading(true);
                try {
                  for (const file of files) {
                    const uploaded = await api.upload<{ id: number; name: string }>(file);
                    setAttachments((previous) => [...previous, uploaded]);
                  }
                  toast.success('File(s) attached.');
                } catch (error) {
                  toast.error(errorMessage(error));
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>

          {uploading && <p className="text-xs text-brand-600 animate-pulse">Uploading and scanning file…</p>}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {attachments.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-medium text-ink-800"
                >
                  <Icon name="file" size={13} className="text-brand-600" />
                  <span className="max-w-[160px] truncate">{file.name}</span>
                  <button
                    type="button"
                    className="ml-1 text-ink-400 hover:text-rose-600"
                    onClick={() => setAttachments((previous) => previous.filter((item) => item.id !== file.id))}
                    aria-label={`Remove ${file.name}`}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Collapsible More Details */}
        <div className="border-t border-ink-100 pt-2">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <Icon name={showAdvanced ? 'close' : 'plus'} size={12} />
            {showAdvanced ? 'Hide Additional Details' : '+ Add More Technical Details (Optional)'}
          </button>

          {showAdvanced && (
            <div className="mt-3 grid gap-3 rounded-xl border border-ink-200 bg-ink-50/40 p-3 sm:grid-cols-2">
              <Field label="Affected Counter / Location">
                <input
                  className="input"
                  placeholder="e.g. Ground Floor Billing Counter 2"
                  value={issueDetails.device}
                  onChange={(e) => setIssueDetails({ ...issueDetails, device: e.target.value })}
                />
              </Field>

              <Field label="System / App Module">
                <input
                  className="input"
                  placeholder="e.g. POS Billing App, Thermal Printer"
                  value={issueDetails.affectedModule}
                  onChange={(e) => setIssueDetails({ ...issueDetails, affectedModule: e.target.value })}
                />
              </Field>

              <Field label="Error Code (if displayed)">
                <input
                  className="input"
                  placeholder="e.g. ERR_TIMEOUT_504, PORT_BUSY"
                  value={issueDetails.errorCode}
                  onChange={(e) => setIssueDetails({ ...issueDetails, errorCode: e.target.value })}
                />
              </Field>

              <Field label="Operational Impact">
                <select
                  className="input"
                  value={issueDetails.impact}
                  onChange={(e) => setIssueDetails({ ...issueDetails, impact: e.target.value })}
                >
                  <option value="individual">Individual Employee</option>
                  <option value="team">Section / Floor Team</option>
                  <option value="organization">Whole Store Operations</option>
                </select>
              </Field>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
