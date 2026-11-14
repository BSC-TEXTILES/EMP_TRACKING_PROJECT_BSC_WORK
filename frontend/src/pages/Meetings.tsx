import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDateTime, formatTime, titleize } from '../lib/format';
import type { MeetingSummary, PickerEmployee } from '../lib/types';

interface MeetingDetail extends MeetingSummary {
  agenda: string | null;
  outcome: string | null;
  isOrganizer: boolean;
  participants: { employeeId: number; name: string; photoUrl: string | null; designation: string | null; response: string; attended: boolean; joinedAt: string | null }[];
  actionItems: { id: number; title: string; assigneeId: number | null; assigneeName: string | null; dueDate: string | null; status: string }[];
  messages: { id: number; employeeId: number; name: string; body: string; createdAt: string }[];
}

export default function Meetings() {
  useDocumentTitle('Meetings');
  const { user, has } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [employees, setEmployees] = useState<PickerEmployee[]>([]);
  const [message, setMessage] = useState('');
  const [actionItem, setActionItem] = useState({ title: '', assigneeId: '', dueDate: '' });

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ meetings: MeetingSummary[] }>('/meetings');
      setMeetings(result.meetings);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ employees: PickerEmployee[] }>('/employees/picker')
      .then((result) => setEmployees(result.employees))
      .catch(() => undefined);
  }, []);

  useSocketEvent('meeting:response', () => void load());

  const openDetail = async (id: number) => {
    try {
      setDetail(await api.get<MeetingDetail>(`/meetings/${id}`));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const respond = async (id: number, response: 'accepted' | 'declined') => {
    try {
      await api.post(`/meetings/${id}/respond`, { response });
      toast.success(`Invitation ${response}.`);
      await openDetail(id);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const now = Date.now();
  const visible = (meetings ?? []).filter((meeting) =>
    tab === 'upcoming' ? new Date(meeting.endAt).getTime() >= now && meeting.status !== 'cancelled' : new Date(meeting.endAt).getTime() < now || meeting.status === 'cancelled',
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Meetings"
        description="Schedule, invite, join with real WebRTC audio/video, record outcomes and assign action items."
        actions={
          has('meetings.create') ? (
            <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={15} /> Schedule meeting
            </button>
          ) : undefined
        }
      />

      <Card>
        <div className="px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'upcoming', label: 'Upcoming' },
              { value: 'past', label: 'Past & cancelled' },
            ]}
            value={tab}
            onChange={(value) => setTab(value as 'upcoming' | 'past')}
          />
        </div>
        {!meetings ? (
          <div className="p-4">
            <Skeleton lines={6} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title={tab === 'upcoming' ? 'No upcoming meetings' : 'No past meetings'} description="Meetings you organise or are invited to appear here." />
        ) : (
          <div className="divide-y divide-ink-100">
            {visible.map((meeting) => (
              <div key={meeting.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openDetail(meeting.id)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink-900">{meeting.title}</p>
                    <StatusBadge status={meeting.status} />
                    {meeting.myResponse === 'accepted' && <Badge tone="success">Accepted</Badge>}
                    {meeting.myResponse === 'declined' && <Badge tone="danger">Declined</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    {formatDateTime(meeting.startAt)} – {formatTime(meeting.endAt)} · {meeting.organizerName} · {meeting.participantCount} participants ({meeting.acceptedCount} accepted)
                  </p>
                  {meeting.description && <p className="mt-1 line-clamp-1 text-sm text-ink-600">{meeting.description}</p>}
                </button>
                <div className="flex flex-wrap gap-1.5">
                  {meeting.myResponse !== 'accepted' && meeting.status !== 'cancelled' && (
                    <button type="button" className="btn-secondary btn-sm" onClick={() => void respond(meeting.id, 'accepted')}>
                      Accept
                    </button>
                  )}
                  {meeting.myResponse !== 'declined' && meeting.status !== 'cancelled' && (
                    <button type="button" className="btn-ghost btn-sm" onClick={() => void respond(meeting.id, 'declined')}>
                      Decline
                    </button>
                  )}
                  <Link to={`/meetings/${meeting.id}/room`} className="btn-primary btn-sm">
                    <Icon name="video" size={14} /> Join
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <CreateMeeting open={createOpen} onClose={() => setCreateOpen(false)} employees={employees} onCreated={() => { setCreateOpen(false); void load(); }} />

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.title ?? ''} size="xl" description={detail ? `${formatDateTime(detail.startAt)} · organised by ${detail.organizerName}` : undefined}
        footer={
          detail ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                <Link to={`/meetings/${detail.id}/room`} className="btn-primary btn-sm">Join room</Link>
                {detail.myResponse !== 'accepted' && <button className="btn-secondary btn-sm" onClick={() => void respond(detail.id, 'accepted')}>Accept</button>}
                {detail.isOrganizer && detail.status !== 'cancelled' && (
                  <button className="btn-ghost btn-sm" onClick={async () => {
                    if (!window.confirm('Cancel this meeting? Participants are notified.')) return;
                    try {
                      await api.post(`/meetings/${detail.id}/cancel`, { reason: window.prompt('Reason (optional)') ?? undefined });
                      setDetail(null);
                      await load();
                    } catch (caught) { toast.error(errorMessage(caught)); }
                  }}>Cancel meeting</button>
                )}
              </div>
              <button className="btn-secondary btn-sm" onClick={() => setDetail(null)}>Close</button>
            </div>
          ) : null
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <StatusBadge status={detail.status} />
              <Badge tone="brand">{titleize(detail.locationType)}</Badge>
              {detail.roomName && <Badge tone="neutral">{detail.roomName}</Badge>}
              <Badge tone="neutral">Code {detail.meetingCode}</Badge>
            </div>
            {detail.description && <p className="whitespace-pre-line text-sm text-ink-700">{detail.description}</p>}
            {detail.agenda && (
              <div className="rounded-lg bg-brand-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Agenda</p>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{detail.agenda}</p>
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <SectionHeader title={`Participants (${detail.participants.length})`} />
                <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {detail.participants.map((participant) => (
                    <div key={participant.employeeId} className="flex items-center gap-2 rounded-lg border border-ink-100 px-2 py-1.5">
                      <Avatar name={participant.name} src={participant.photoUrl} size={26} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink-800">{participant.name}</p>
                        <p className="truncate text-[11px] text-ink-400">{participant.designation ?? ''}</p>
                      </div>
                      <StatusBadge status={participant.response} />
                      {participant.attended && <Badge tone="success">Joined</Badge>}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <SectionHeader title="Action items" />
                <div className="mt-2 space-y-1">
                  {detail.actionItems.length === 0 && <p className="text-sm text-ink-500">No action items yet.</p>}
                  {detail.actionItems.map((item) => (
                    <label key={item.id} className="flex items-start gap-2 rounded-lg border border-ink-100 px-2 py-1.5 text-sm">
                      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={item.status === 'completed'} onChange={async () => {
                        try {
                          await api.patch(`/meetings/${detail.id}/action-items/${item.id}`);
                          await openDetail(detail.id);
                        } catch (caught) { toast.error(errorMessage(caught)); }
                      }} />
                      <span className={item.status === 'completed' ? 'text-ink-400 line-through' : 'text-ink-700'}>
                        {item.title}
                        <span className="ml-1 text-[11px] text-ink-400">{item.assigneeName ? `· ${item.assigneeName}` : ''} {item.dueDate ?? ''}</span>
                      </span>
                    </label>
                  ))}
                  <form className="mt-2 space-y-2" onSubmit={async (event) => {
                    event.preventDefault();
                    try {
                      await api.post(`/meetings/${detail.id}/action-items`, {
                        title: actionItem.title,
                        assigneeId: actionItem.assigneeId ? Number(actionItem.assigneeId) : null,
                        dueDate: actionItem.dueDate || null,
                      });
                      setActionItem({ title: '', assigneeId: '', dueDate: '' });
                      await openDetail(detail.id);
                    } catch (caught) { toast.error(errorMessage(caught)); }
                  }}>
                    <input className="input" placeholder="Action item" value={actionItem.title} onChange={(event) => setActionItem({ ...actionItem, title: event.target.value })} required />
                    <div className="flex gap-2">
                      <input type="date" className="input" value={actionItem.dueDate} onChange={(event) => setActionItem({ ...actionItem, dueDate: event.target.value })} />
                      <button type="submit" className="btn-secondary btn-sm">Add</button>
                    </div>
                  </form>
                </div>
              </div>
            </div>

            <div>
              <SectionHeader title="Meeting chat" />
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {detail.messages.length === 0 && <p className="text-sm text-ink-500">No messages.</p>}
                {detail.messages.map((entry) => (
                  <p key={entry.id} className="text-sm text-ink-700">
                    <span className="font-semibold">{entry.name}</span> <span className="text-[11px] text-ink-400">{formatTime(entry.createdAt)}</span>
                    <br />
                    {entry.body}
                  </p>
                ))}
              </div>
              <form className="mt-2 flex gap-2" onSubmit={async (event) => {
                event.preventDefault();
                if (!message.trim()) return;
                try {
                  await api.post(`/meetings/${detail.id}/messages`, { body: message });
                  setMessage('');
                  await openDetail(detail.id);
                } catch (caught) { toast.error(errorMessage(caught)); }
              }}>
                <input className="input" placeholder="Message participants…" value={message} onChange={(event) => setMessage(event.target.value)} />
                <button type="submit" className="btn-primary btn-sm" disabled={!message.trim()}>Send</button>
              </form>
            </div>

            {(detail.isOrganizer || user?.permissions.includes('meetings.manage')) && (
              <div>
                <SectionHeader title="Meeting outcome" description="Saved permanently and shared with participants." />
                <form className="mt-2 space-y-2" onSubmit={async (event) => {
                  event.preventDefault();
                  const outcome = (event.currentTarget.elements.namedItem('outcome') as HTMLTextAreaElement).value;
                  try {
                    await api.post(`/meetings/${detail.id}/outcome`, { outcome });
                    toast.success('Outcome saved.');
                    await openDetail(detail.id);
                  } catch (caught) { toast.error(errorMessage(caught)); }
                }}>
                  <textarea name="outcome" className="input min-h-[80px]" defaultValue={detail.outcome ?? ''} minLength={5} required />
                  <button type="submit" className="btn-secondary btn-sm">Save outcome</button>
                </form>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function CreateMeeting({ open, onClose, employees, onCreated }: { open: boolean; onClose: () => void; employees: PickerEmployee[]; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', description: '', agenda: '', startAt: '', endAt: '', locationType: 'online', roomName: '' });
  const [participants, setParticipants] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (participants.length === 0) {
      toast.error('Invite at least one participant.');
      return;
    }
    if (new Date(form.endAt) <= new Date(form.startAt)) {
      toast.error('End time must be after the start time.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/meetings', {
        ...form,
        participantIds: participants,
        startAt: new Date(form.startAt).toISOString(),
        endAt: new Date(form.endAt).toISOString(),
        roomName: form.locationType === 'room' ? form.roomName : undefined,
      });
      toast.success('Meeting scheduled and invitations sent.');
      setForm({ title: '', description: '', agenda: '', startAt: '', endAt: '', locationType: 'online', roomName: '' });
      setParticipants([]);
      onCreated();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Schedule a meeting" size="lg" footer={
      <>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="meeting-form" className="btn-primary" disabled={busy}>{busy ? 'Scheduling…' : 'Schedule'}</button>
      </>
    }>
      <form id="meeting-form" onSubmit={submit} className="space-y-4">
        <Field label="Title" required>
          <input className="input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} minLength={3} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start" required>
            <input type="datetime-local" className="input" value={form.startAt} onChange={(event) => setForm({ ...form, startAt: event.target.value })} required />
          </Field>
          <Field label="End" required>
            <input type="datetime-local" className="input" value={form.endAt} onChange={(event) => setForm({ ...form, endAt: event.target.value })} required />
          </Field>
          <Field label="Location type">
            <select className="input" value={form.locationType} onChange={(event) => setForm({ ...form, locationType: event.target.value })}>
              <option value="online">Online (WebRTC)</option>
              <option value="room">Meeting room</option>
            </select>
          </Field>
          {form.locationType === 'room' && (
            <Field label="Room name">
              <input className="input" value={form.roomName} onChange={(event) => setForm({ ...form, roomName: event.target.value })} />
            </Field>
          )}
        </div>
        <Field label="Description">
          <textarea className="input min-h-[60px]" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <Field label="Agenda">
          <textarea className="input min-h-[60px]" value={form.agenda} onChange={(event) => setForm({ ...form, agenda: event.target.value })} />
        </Field>
        <div>
          <span className="label">Participants *</span>
          <div className="max-h-44 overflow-y-auto rounded-lg border border-ink-300 p-2">
            {employees.map((employee) => (
              <label key={employee.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-ink-50">
                <input type="checkbox" className="h-4 w-4" checked={participants.includes(employee.id)} onChange={(event) => setParticipants((prev) => (event.target.checked ? [...prev, employee.id] : prev.filter((id) => id !== employee.id)))} />
                {employee.full_name} <span className="text-xs text-ink-400">{employee.designation_title ?? ''}</span>
              </label>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}
