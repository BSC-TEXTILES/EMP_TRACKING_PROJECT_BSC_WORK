import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, fileUrl } from '../lib/api';
import { useDocumentTitle, useDebounced } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, PriorityBadge, Skeleton, StatCard, StatusBadge } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDateTime, titleize } from '../lib/format';
import type { PickerEmployee, TicketSummary } from '../lib/types';

const CATEGORIES = [
  'Website Issues',
  'Application Errors',
  'Login Issues',
  'Database Issues',
  'Printer Issues',
  'Email Issues',
  'Task Management Issues',
  'Communication Issues',
  'Mobile Application Issues',
  'Performance Issues',
  'Security Issues',
  'Other Technical Issues',

  'IT Issues',
  'Software Issues',
  'Hardware Issues',
  'Network Issues',
  'Attendance Issues',
  'HR Issues',
  'Payroll Issues',
  'Store Operations',
  'Customer Complaints',
  'Infrastructure Issues',
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
  useDocumentTitle('Tickets');
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
      toast.success('Ticket updated.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
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
        title="Ticket & issue management"
        description="SLA-tracked support requests with automatic assignment, escalation and resolution feedback."
        actions={
          has('tickets.create') ? (
            <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={15} /> Raise ticket
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
            <input className="input pl-9" placeholder="Search ticket number, subject…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          </div>
          <select className="input w-auto" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {['new', 'assigned', 'acknowledged', 'in_progress', 'waiting_information', 'resolved', 'closed', 'reopened', 'cancelled'].map((value) => (
              <option key={value} value={value}>
                {titleize(value)}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={priorityFilter} onChange={(event) => { setPriorityFilter(event.target.value); setPage(1); }}>
            <option value="">All priorities</option>
            {['critical', 'high', 'medium', 'low'].map((value) => (
              <option key={value} value={value}>
                {titleize(value)}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}>
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
          <EmptyState title="No tickets" description="Tickets matching your filters will appear here." />
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
                    <th>SLA</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((ticket) => (
                    <tr key={ticket.id} className="cursor-pointer" onClick={() => void openDetail(ticket.id)}>
                      <td>
                        <p className="font-medium text-ink-800">{ticket.subject}</p>
                        <p className="text-xs text-ink-400">
                          {ticket.ticketNo} · {ticket.requesterName}
                        </p>
                      </td>
                      <td className="text-ink-600">
                        {ticket.category}
                        {ticket.assignedTeam && <p className="text-xs text-ink-400">{ticket.assignedTeam}</p>}
                      </td>
                      <td><PriorityBadge priority={ticket.priority} /></td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge status={ticket.status} />
                          {ticket.slaBreached && <Badge tone="danger">SLA</Badge>}
                        </div>
                      </td>
                      <td className="text-ink-600">{ticket.assigneeName ?? 'Unassigned'}</td>
                      <td className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(ticket.slaDueAt)}</td>
                      <td className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(ticket.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={20} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      <CreateTicket open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(ticket) => { setCreateOpen(false); setDetail(ticket); void load(); }} />

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.subject ?? ''}
        description={detail ? `${detail.ticketNo} · raised by ${detail.requesterName}` : undefined}
        size="lg"
        footer={
          detail ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {canAny('tickets.assign') && !['closed', 'cancelled'].includes(detail.status) && (
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => {
                    const id = window.prompt(`Assign to employee ID (available: ${assignees.slice(0, 6).map((a) => `${a.id}:${a.full_name}`).join(', ')})`);
                    if (id) void act('assign', { assigneeId: Number(id) });
                  }}>
                    Assign
                  </button>
                )}
                {['assigned', 'acknowledged', 'in_progress', 'waiting_information', 'reopened'].includes(detail.status) && (detail.assigneeId === user?.id || canAny('tickets.assign')) && (
                  <>
                    {detail.status === 'assigned' && (
                      <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('acknowledge')}>
                        Acknowledge
                      </button>
                    )}
                    {['assigned', 'acknowledged'].includes(detail.status) && (
                      <button className="btn-primary btn-sm" disabled={busy} onClick={() => void act('start')}>
                        Start work
                      </button>
                    )}
                    {detail.status === 'in_progress' && (
                      <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('wait_info', { note: window.prompt('What information is required?') ?? undefined })}>
                        Waiting for info
                      </button>
                    )}
                    {['acknowledged', 'in_progress', 'waiting_information'].includes(detail.status) && (
                      <button
                        className="btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => {
                          const resolution = window.prompt('Describe the resolution:');
                          if (resolution) void act('resolve', { resolution });
                        }}
                      >
                        Resolve
                      </button>
                    )}
                  </>
                )}
                {detail.status === 'resolved' && (detail.requesterId === user?.id || canAny('tickets.assign')) && (
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void act('close')}>
                    Close ticket
                  </button>
                )}
                {['resolved', 'closed'].includes(detail.status) && detail.requesterId === user?.id && !detail.feedbackRating && (
                  <button
                    className="btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => {
                      const rating = Number(window.prompt('Rate the resolution from 1 to 5:') ?? 0);
                      if (rating >= 1 && rating <= 5) void act('feedback', { rating, note: window.prompt('Optional comment:') ?? undefined });
                    }}
                  >
                    Leave feedback
                  </button>
                )}
                {['resolved', 'closed'].includes(detail.status) && (detail.requesterId === user?.id || canAny('tickets.assign')) && (
                  <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void act('reopen', { note: window.prompt('Why reopen?') ?? undefined })}>
                    Reopen
                  </button>
                )}
                {!['resolved', 'closed', 'cancelled'].includes(detail.status) && canAny('tickets.assign') && (
                  <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void act('escalate', { note: window.prompt('Escalation note:') ?? undefined })}>
                    Escalate
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
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              <PriorityBadge priority={detail.priority} />
              <Badge tone="brand">{detail.category}</Badge>
              {detail.departmentName && <Badge tone="neutral">{detail.departmentName}</Badge>}
              {detail.slaBreached && <Badge tone="danger">SLA breached</Badge>}
              {detail.feedbackRating && <Badge tone="success">Rated {detail.feedbackRating}/5</Badge>}
            </div>
            <p className="whitespace-pre-line text-sm text-ink-700">{detail.description}</p>
            {detail.issueDetails && <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {Object.entries(detail.issueDetails).filter(([, value]) => value !== null && value !== '' && typeof value !== 'object').map(([key, value]) => (
                <div key={key}><dt className="text-xs text-ink-500">{key.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase()).replace('And Os', 'and OS')}</dt><dd className="whitespace-pre-wrap">{String(value)}</dd></div>
              ))}
            </dl>}
            {!!detail.attachments?.length && <div className="space-y-1"><p className="text-xs font-semibold">Attachments</p>{detail.attachments.map(file => <a key={file.file_id} className="block text-sm underline" href={fileUrl(file.file_id, true)}>{file.original_name}</a>)}</div>}
            <div className="grid gap-2 text-xs text-ink-500 sm:grid-cols-2">
              <p>Assigned team: {detail.assignedTeam ?? '—'}</p>
              <p>Assignee: {detail.assigneeName ?? 'Unassigned'}</p>
              <p>SLA due: {formatDateTime(detail.slaDueAt)}</p>
              <p>Resolved: {formatDateTime(detail.resolvedAt)}</p>
            </div>
            {detail.resolution && (
              <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                <p className="text-xs font-semibold uppercase tracking-wide">Resolution</p>
                {detail.resolution}
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Conversation</p>
              <div className="space-y-2">
                {detail.comments?.length ? (
                  detail.comments.map((entry) => (
                    <div key={entry.id} className={`rounded-lg px-3 py-2 text-sm ${entry.isInternal ? 'bg-amber-50' : 'bg-ink-50'}`}>
                      <p className="text-xs font-semibold text-ink-700">
                        {entry.authorName} <span className="font-normal text-ink-400">· {formatDateTime(entry.createdAt)}</span>
                        {entry.isInternal && <span className="ml-2 text-[10px] uppercase text-amber-700">internal</span>}
                      </p>
                      <p className="mt-0.5 whitespace-pre-line text-ink-700">{entry.body}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-ink-500">No comments yet.</p>
                )}
              </div>
              <form onSubmit={addComment} className="mt-2 space-y-2">
                <input className="input" placeholder="Add a comment…" value={comment} onChange={(event) => setComment(event.target.value)} />
                <div className="flex items-center justify-between">
                  {canAny('tickets.assign') ? (
                    <label className="flex items-center gap-2 text-xs text-ink-600">
                      <input type="checkbox" className="h-4 w-4" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
                      Internal note (not visible to requester)
                    </label>
                  ) : (
                    <span />
                  )}
                  <button type="submit" className="btn-primary btn-sm" disabled={!comment.trim()}>
                    Send
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function CreateTicket({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (ticket: TicketSummary) => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [issueDetails, setIssueDetails] = useState<Record<string, string>>({ impact: 'individual', urgency: 'medium' });
  const [consent, setConsent] = useState(false);
  const [attachments, setAttachments] = useState<{ id: number; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ subject: '', description: '', category: CATEGORIES[0], priority: 'medium' });
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const ticket = await api.post<TicketSummary>('/tickets', { ...form, attachmentIds: attachments.map(file => file.id), issueDetails: { ...issueDetails,
        diagnosticsConsent: consent,
        ...(consent ? { diagnostics: { online: navigator.onLine, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } } : {}) } });
      toast.success(`Ticket ${ticket.ticketNo} created and assigned to ${ticket.assignedTeam ?? 'the support team'}.`);
      setForm({ subject: '', description: '', category: CATEGORIES[0], priority: 'medium' });
      setAttachments([]);
      setIssueDetails({ impact: 'individual', urgency: 'medium' });
      setConsent(false);
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
      title="Raise a support ticket"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="ticket-form" className="btn-primary" disabled={busy || uploading}>
            {busy ? 'Creating…' : 'Create ticket'}
          </button>
        </>
      }
    >
      <form id="ticket-form" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-ink-600">{user?.fullName} · {user?.employeeCode} · {user?.departmentName}<br />{user?.designationTitle} · {user?.locationName}<br />{user?.email}</p>
        <Field label="Subject" required>
          <input className="input" value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} minLength={4} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category" required>
            <select className="input" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
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
        </div>
        <Field label="Description" required hint="Include what happened, what you expected and any error message.">
          <textarea className="input min-h-[120px]" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} minLength={10} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['subcategory', 'affectedModule', 'errorCode', 'browserAndOs', 'device', 'relatedProject'] as const).map(key => <Field key={key} label={key.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase()).replace('And Os', 'and OS')}><input className="input" maxLength={key === 'errorCode' ? 100 : key === 'subcategory' || key === 'affectedModule' ? 120 : 200} value={issueDetails[key] || ''} onChange={event => setIssueDetails({ ...issueDetails, [key]: event.target.value })} /></Field>)}
          <Field label="Occurred at"><input type="datetime-local" className="input" value={issueDetails.occurredAt || ''} onChange={event => setIssueDetails({ ...issueDetails, occurredAt: event.target.value })} /></Field>
          <Field label="Impact"><select className="input" value={issueDetails.impact} onChange={event => setIssueDetails({ ...issueDetails, impact: event.target.value })}>{['individual', 'team', 'organization'].map(value => <option key={value}>{value}</option>)}</select></Field>
          <Field label="Urgency"><select className="input" value={issueDetails.urgency} onChange={event => setIssueDetails({ ...issueDetails, urgency: event.target.value })}>{['low', 'medium', 'high', 'critical'].map(value => <option key={value}>{value}</option>)}</select></Field>
        </div>
        {['stepsToReproduce', 'expectedResult', 'actualResult', 'errorMessage', 'remarks'].map(key => <Field key={key} label={key.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase()).replace('And Os', 'and OS')}><textarea className="input" maxLength={2000} value={issueDetails[key] || ''} onChange={event => setIssueDetails({ ...issueDetails, [key]: event.target.value })} /></Field>)}
        <Field label="Screenshots and supporting files" hint="Up to 10 files. Images, PDF, UTF-8 text, audio or video. Files require security scanning before attachment.">
          <input type="file" multiple disabled={uploading || busy} accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.csv,.webm,.ogg,.mp3,.mp4" onChange={async event => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length + attachments.length > 10) { toast.error('Attach no more than 10 files.'); return; }
            setUploading(true);
            try {
              for (const file of files) {
                const uploaded = await api.upload<{ id: number; name: string }>(file);
                setAttachments(previous => [...previous, uploaded]);
              }
            } catch (error) { toast.error(errorMessage(error)); }
            finally { setUploading(false); }
          }} />
          {uploading && <p className="text-xs">Uploading and scanning…</p>}
          {attachments.map(file => <div key={file.id} className="flex items-center justify-between text-sm"><span>{file.name}</span><button type="button" className="btn-ghost btn-sm" onClick={() => setAttachments(previous => previous.filter(item => item.id !== file.id))}>Remove</button></div>)}
        </Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Attach technical diagnostics: online status and viewport size only.</label>
        <p className="text-xs text-ink-500">Do not include passwords, verification codes, access tokens or private messages in descriptions or attachments.</p>
      </form>
    </Modal>
  );
}
