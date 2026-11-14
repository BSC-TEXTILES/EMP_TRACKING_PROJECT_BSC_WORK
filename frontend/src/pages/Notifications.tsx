import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDateTime, titleize } from '../lib/format';
import type { NotificationItem } from '../lib/types';

interface Announcement {
  id: number;
  title: string;
  body: string;
  priority: string;
  audienceType: string;
  author: string;
  publishedAt: string;
}

interface AudienceOptions {
  departments: { id: number; name: string }[];
  roles: { id: number; name: string }[];
  locations: { id: number; name: string }[];
  employeeCount: number;
}

export default function Notifications() {
  useDocumentTitle('Notifications');
  const { has } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'inbox' | 'announcements'>('inbox');
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [options, setOptions] = useState<AudienceOptions | null>(null);
  const [form, setForm] = useState({ title: '', message: '', priority: 'normal', audienceType: 'all', audienceValue: '' });
  const [busy, setBusy] = useState(false);

  const loadInbox = async () => {
    try {
      const result = await api.get<{ items: NotificationItem[]; unread: number }>(`/notifications${unreadOnly ? '?unread=true' : ''}`);
      setItems(result.items);
      setUnread(result.unread);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const loadAnnouncements = async () => {
    try {
      const result = await api.get<{ announcements: Announcement[] }>('/notifications/announcements');
      setAnnouncements(result.announcements);
      if (has('notifications.send')) {
        setOptions(await api.get<AudienceOptions>('/notifications/audience-options'));
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    if (tab === 'inbox') void loadInbox();
    else void loadAnnouncements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, unreadOnly]);

  useSocketEvent('notification:new', () => {
    void loadInbox();
  });

  const markRead = async (id: number) => {
    try {
      await api.post(`/notifications/${id}/read`);
      setItems((prev) => prev?.map((item) => (item.id === id ? { ...item, read: true } : item)) ?? null);
      setUnread((value) => Math.max(0, value - 1));
      window.dispatchEvent(new CustomEvent('notifications:changed'));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const remove = async (id: number) => {
    try {
      await api.del(`/notifications/${id}`);
      setItems((prev) => prev?.filter((item) => item.id !== id) ?? null);
      window.dispatchEvent(new CustomEvent('notifications:changed'));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post<{ recipients: number }>('/notifications/announcements', form);
      toast.success(`Announcement sent to ${result.recipients} employee(s).`);
      setSendOpen(false);
      setForm({ title: '', message: '', priority: 'normal', audienceType: 'all', audienceValue: '' });
      await loadAnnouncements();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Notifications & announcements"
        description="Every assignment, approval, message, ticket and KPI event creates a real notification. Online users receive it instantly."
        actions={has('notifications.send') ? <button type="button" className="btn-primary btn-sm" onClick={() => setSendOpen(true)}><Icon name="megaphone" size={15} /> Send announcement</button> : undefined}
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'inbox', label: 'Inbox' },
              { value: 'announcements', label: 'Announcements' },
            ]}
            value={tab}
            onChange={(value) => setTab(value as 'inbox' | 'announcements')}
          />
          {tab === 'inbox' && (
            <div className="flex flex-wrap items-center gap-2 pb-1">
              <label className="flex items-center gap-1.5 text-xs text-ink-600">
                <input type="checkbox" className="h-4 w-4" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
                Unread only
              </label>
              <Badge tone={unread > 0 ? 'danger' : 'neutral'}>{unread} unread</Badge>
              <button type="button" className="btn-secondary btn-sm" onClick={async () => {
                try {
                  await api.post('/notifications/read-all');
                  await loadInbox();
                  window.dispatchEvent(new CustomEvent('notifications:changed'));
                } catch (caught) { toast.error(errorMessage(caught)); }
              }}>Mark all read</button>
            </div>
          )}
        </div>

        {tab === 'inbox' ? (
          !items ? (
            <div className="p-4"><Skeleton lines={6} /></div>
          ) : items.length === 0 ? (
            <EmptyState title="You're all caught up" description="Task assignments, approvals and messages will appear here." />
          ) : (
            <div className="divide-y divide-ink-100">
              {items.map((item) => (
                <div key={item.id} className={cx('flex flex-wrap items-start justify-between gap-3 px-4 py-3', !item.read && 'bg-brand-50/40')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {!item.read && <span className="h-2 w-2 rounded-full bg-brand-600" />}
                      <p className="text-sm font-medium text-ink-900">{item.title}</p>
                      <Badge tone={item.priority === 'critical' ? 'danger' : item.priority === 'high' ? 'warning' : 'neutral'}>{titleize(item.priority)}</Badge>
                      <Badge tone="neutral">{titleize(item.type)}</Badge>
                    </div>
                    {item.body && <p className="mt-1 text-sm text-ink-600">{item.body}</p>}
                    <p className="mt-1 text-xs text-ink-400">{formatDateTime(item.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.link && <Link to={item.link} className="btn-secondary btn-sm" onClick={() => void markRead(item.id)}>Open</Link>}
                    {!item.read && <button type="button" className="btn-ghost btn-sm" onClick={() => void markRead(item.id)}>Mark read</button>}
                    <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => void remove(item.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : !announcements ? (
          <div className="p-4"><Skeleton lines={5} /></div>
        ) : announcements.length === 0 ? (
          <EmptyState title="No announcements" description="Organisation-wide announcements will appear here." />
        ) : (
          <div className="divide-y divide-ink-100">
            {announcements.map((announcement) => (
              <div key={announcement.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-ink-900">{announcement.title}</p>
                  <Badge tone="brand">{titleize(announcement.audienceType)}</Badge>
                  <Badge tone={announcement.priority === 'critical' ? 'danger' : 'neutral'}>{titleize(announcement.priority)}</Badge>
                </div>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-600">{announcement.body}</p>
                <p className="mt-1 text-xs text-ink-400">{announcement.author} · {formatDateTime(announcement.publishedAt)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={sendOpen} onClose={() => setSendOpen(false)} title="Send announcement" description={options ? `Audience is resolved on the server. ${options.employeeCount} active employees.` : undefined}
        footer={<><button className="btn-secondary" onClick={() => setSendOpen(false)}>Cancel</button><button className="btn-primary" form="announcement-form" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send announcement'}</button></>}>
        <form id="announcement-form" onSubmit={send} className="space-y-4">
          <Field label="Title" required><input className="input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} minLength={3} required /></Field>
          <Field label="Message" required><textarea className="input min-h-[100px]" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} minLength={5} required /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority">
              <select className="input" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
                {['low', 'normal', 'high', 'critical'].map((value) => <option key={value} value={value}>{titleize(value)}</option>)}
              </select>
            </Field>
            <Field label="Audience">
              <select className="input" value={form.audienceType} onChange={(event) => setForm({ ...form, audienceType: event.target.value, audienceValue: '' })}>
                <option value="all">All employees</option>
                <option value="department">Specific department</option>
                <option value="role">Specific role</option>
                <option value="location">Specific location</option>
              </select>
            </Field>
          </div>
          {form.audienceType !== 'all' && (
            <Field label="Audience value" required>
              <select className="input" value={form.audienceValue} onChange={(event) => setForm({ ...form, audienceValue: event.target.value })} required>
                <option value="">Select…</option>
                {form.audienceType === 'department' && options?.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                {form.audienceType === 'role' && options?.roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                {form.audienceType === 'location' && options?.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </Field>
          )}
          <SectionHeader title="Delivery" description="In-app instantly, and email where SMTP is configured. Notifications are stored per recipient." />
        </form>
      </Modal>
    </div>
  );
}
