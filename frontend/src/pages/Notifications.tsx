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
import { getNotificationPermission, requestNotificationPermission, type NotificationPermissionState } from '../lib/notifications';
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

interface PushPreferences {
  categories: { key: string; label: string; push: boolean }[];
  note: string;
}

interface PushDevice {
  id: number;
  platform: string;
  deviceName: string | null;
  appVersion: string | null;
  registeredAt: string;
  lastPushAt: string | null;
}

const CATEGORIES = [
  { key: 'all', label: 'All Categories' },
  { key: 'tasks', label: 'Tasks & Projects' },
  { key: 'reports', label: 'Daily Reports' },
  { key: 'attendance', label: 'Attendance & Leave' },
  { key: 'calls', label: 'Calls & Meetings' },
  { key: 'chat', label: 'Messages' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'announcements', label: 'Announcements' },
];

const LOCATIONS = [
  { code: 'all', label: 'All Branches' },
  { code: 'BEL', label: 'BEL – Belagavi' },
  { code: 'DAV', label: 'DAV – Davanagere' },
  { code: 'SHI', label: 'SHI – Shivamogga' },
  { code: 'HUB', label: 'HUB/HQ – Head Office' },
];

export default function Notifications() {
  useDocumentTitle('Notifications');
  const { has } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'inbox' | 'announcements' | 'preferences'>('inbox');
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedLocation, setSelectedLocation] = useState('all');
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [options, setOptions] = useState<AudienceOptions | null>(null);
  const [form, setForm] = useState({ title: '', message: '', priority: 'normal', audienceType: 'all', audienceValue: '' });
  const [busy, setBusy] = useState(false);

  // Preferences & Push state
  const [permissionState, setPermissionState] = useState<NotificationPermissionState>('granted');
  const [pushPrefs, setPushPrefs] = useState<PushPreferences | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [testingPush, setTestingPush] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  useEffect(() => {
    setPermissionState(getNotificationPermission());
  }, []);

  const loadInbox = async () => {
    try {
      const params = new URLSearchParams();
      if (unreadOnly) params.set('unread', 'true');
      if (selectedCategory !== 'all') params.set('category', selectedCategory);
      if (selectedLocation !== 'all') params.set('location', selectedLocation);
      const queryStr = params.toString() ? `?${params.toString()}` : '';
      const result = await api.get<{ items: NotificationItem[]; unread: number }>(`/notifications${queryStr}`);
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

  const loadPreferences = async () => {
    try {
      const [prefs, devRes] = await Promise.all([
        api.get<PushPreferences>('/push/preferences'),
        api.get<{ devices: PushDevice[] }>('/push/devices'),
      ]);
      setPushPrefs(prefs);
      setDevices(devRes.devices || []);
    } catch (caught) {
      console.warn(errorMessage(caught));
    }
  };

  useEffect(() => {
    if (tab === 'inbox') void loadInbox();
    else if (tab === 'announcements') void loadAnnouncements();
    else if (tab === 'preferences') void loadPreferences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, unreadOnly, selectedCategory, selectedLocation]);

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

  const handleEnableDesktop = async () => {
    const res = await requestNotificationPermission();
    setPermissionState(res);
    if (res === 'granted') {
      toast.success('Desktop and Windows notifications enabled!');
    } else {
      toast.info('Notifications were not granted.');
    }
  };

  const handleTestNotification = async () => {
    setTestingPush(true);
    try {
      await api.post('/push/test');
      toast.success('Test notification sent to your registered browser!');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setTestingPush(false);
    }
  };

  const toggleCategoryPush = async (key: string, enabled: boolean) => {
    if (!pushPrefs) return;
    setSavingPrefs(true);
    try {
      const updated = { [key]: enabled };
      const res = await api.put<PushPreferences>('/push/preferences', { categories: updated });
      setPushPrefs(res);
      toast.success('Notification preferences updated.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Notification Centre"
        description="Real-time multi-channel notifications for desktop, Windows, Android, and iOS across all store branches."
        actions={
          has('notifications.send') ? (
            <button type="button" className="btn-primary btn-sm" onClick={() => setSendOpen(true)}>
              <Icon name="megaphone" size={15} /> Send announcement
            </button>
          ) : undefined
        }
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-2 border-b border-ink-100">
          <Tabs
            tabs={[
              { value: 'inbox', label: 'Inbox' },
              { value: 'announcements', label: 'Announcements' },
              { value: 'preferences', label: 'Notification Settings' },
            ]}
            value={tab}
            onChange={(value) => setTab(value as 'inbox' | 'announcements' | 'preferences')}
          />
          {tab === 'inbox' && (
            <div className="flex flex-wrap items-center gap-2 pb-1">
              <label className="flex items-center gap-1.5 text-xs text-ink-600 font-medium">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                  checked={unreadOnly}
                  onChange={(event) => setUnreadOnly(event.target.checked)}
                />
                Unread only
              </label>
              <Badge tone={unread > 0 ? 'danger' : 'neutral'}>{unread} unread</Badge>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await api.post('/notifications/read-all');
                    await loadInbox();
                    window.dispatchEvent(new CustomEvent('notifications:changed'));
                  } catch (caught) {
                    toast.error(errorMessage(caught));
                  }
                }}
              >
                Mark all read
              </button>
            </div>
          )}
        </div>

        {tab === 'inbox' && (
          <div className="bg-ink-50/50 p-3 border-b border-ink-100 flex flex-wrap items-center justify-between gap-3">
            {/* Category Pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setSelectedCategory(cat.key)}
                  className={cx(
                    'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                    selectedCategory === cat.key
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'bg-white text-ink-700 border border-ink-200 hover:bg-ink-50',
                  )}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* Location selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-500 font-medium">Branch:</span>
              <select
                value={selectedLocation}
                onChange={(e) => setSelectedLocation(e.target.value)}
                className="input py-1 px-2.5 text-xs w-auto min-w-[150px] font-medium"
              >
                {LOCATIONS.map((loc) => (
                  <option key={loc.code} value={loc.code}>
                    {loc.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {tab === 'inbox' ? (
          !items ? (
            <div className="p-4">
              <Skeleton lines={6} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title="You're all caught up"
              description="No notifications match your current filter. Task assignments, reports, and messages will appear here."
            />
          ) : (
            <div className="divide-y divide-ink-100">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={cx(
                    'flex flex-wrap items-start justify-between gap-3 px-4 py-3 transition-colors',
                    !item.read ? 'bg-blue-50/30' : 'hover:bg-ink-50/60',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {!item.read && <span className="h-2 w-2 rounded-full bg-blue-600 shrink-0" />}
                      <p className="text-sm font-semibold text-ink-900">{item.title}</p>
                      <Badge tone={item.priority === 'critical' ? 'danger' : item.priority === 'high' ? 'warning' : 'neutral'}>
                        {titleize(item.priority)}
                      </Badge>
                      <Badge tone="neutral">{titleize(item.type)}</Badge>
                      {item.locationCode && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                          {item.locationCode}
                        </span>
                      )}
                    </div>
                    {item.body && <p className="mt-1 text-sm text-ink-600">{item.body}</p>}
                    <p className="mt-1 text-xs text-ink-400">
                      {item.senderName && <span className="font-medium text-ink-600">{item.senderName} · </span>}
                      {item.locationName && <span>{item.locationName} · </span>}
                      {formatDateTime(item.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    {item.link && (
                      <Link to={item.link} className="btn-secondary btn-sm" onClick={() => void markRead(item.id)}>
                        Open
                      </Link>
                    )}
                    {!item.read && (
                      <button type="button" className="btn-ghost btn-sm" onClick={() => void markRead(item.id)}>
                        Mark read
                      </button>
                    )}
                    <button type="button" className="btn-ghost btn-sm text-red-600 hover:bg-red-50" onClick={() => void remove(item.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === 'announcements' ? (
          !announcements ? (
            <div className="p-4">
              <Skeleton lines={5} />
            </div>
          ) : announcements.length === 0 ? (
            <EmptyState title="No announcements" description="Organisation-wide announcements will appear here." />
          ) : (
            <div className="divide-y divide-ink-100">
              {announcements.map((announcement) => (
                <div key={announcement.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink-900">{announcement.title}</p>
                    <Badge tone="brand">{titleize(announcement.audienceType)}</Badge>
                    <Badge tone={announcement.priority === 'critical' ? 'danger' : 'neutral'}>
                      {titleize(announcement.priority)}
                    </Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm text-ink-600">{announcement.body}</p>
                  <p className="mt-1 text-xs text-ink-400">
                    {announcement.author} · {formatDateTime(announcement.publishedAt)}
                  </p>
                </div>
              ))}
            </div>
          )
        ) : (
          /* Preferences & Notification Settings Tab */
          <div className="p-6 space-y-6">
            {/* Desktop Notification Card */}
            <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white">
                    <Icon name="bell" size={20} />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-ink-900">Windows & Desktop Push Notifications</h4>
                    <p className="text-xs text-ink-500">
                      Receive immediate system alerts even when the browser is minimized or running in the background.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {permissionState === 'granted' ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      Notifications Active
                    </span>
                  ) : (
                    <button type="button" className="btn-primary btn-sm" onClick={handleEnableDesktop}>
                      Enable Desktop Notifications
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={handleTestNotification}
                    disabled={testingPush}
                  >
                    {testingPush ? 'Sending…' : 'Send Test Notification'}
                  </button>
                </div>
              </div>
            </div>

            {/* Category Preferences */}
            <div>
              <h4 className="text-sm font-bold text-ink-900 mb-1">Push Notification Categories</h4>
              <p className="text-xs text-ink-500 mb-4">
                Choose which types of alerts are delivered to your desktop and mobile devices. Security alerts are always delivered.
              </p>

              {pushPrefs?.categories ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {pushPrefs.categories.map((cat) => (
                    <label
                      key={cat.key}
                      className="flex items-center justify-between p-3 rounded-lg border border-ink-200 hover:bg-ink-50 cursor-pointer transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-ink-800">{cat.label}</p>
                        <p className="text-xs text-ink-400 capitalize">{cat.key}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={cat.push}
                        disabled={savingPrefs}
                        onChange={(e) => void toggleCategoryPush(cat.key, e.target.checked)}
                        className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <Skeleton lines={4} />
              )}
            </div>

            {/* Registered Devices */}
            <div>
              <h4 className="text-sm font-bold text-ink-900 mb-1">Registered Notification Devices</h4>
              <p className="text-xs text-ink-500 mb-3">
                Devices associated with your account for real-time push delivery.
              </p>

              {devices.length === 0 ? (
                <div className="p-4 rounded-lg border border-dashed border-ink-200 text-center text-xs text-ink-500">
                  No mobile devices registered yet. Log in to the BSC Workforce Android or iOS app to register your phone.
                </div>
              ) : (
                <div className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                  {devices.map((dev) => (
                    <div key={dev.id} className="flex items-center justify-between p-3">
                      <div className="flex items-center gap-2.5">
                        <Icon name={dev.platform === 'ios' ? 'smartphone' : 'smartphone'} size={18} className="text-ink-400" />
                        <div>
                          <p className="text-sm font-medium text-ink-800">
                            {dev.deviceName || (dev.platform === 'android' ? 'Android Device' : 'iOS Device')}
                          </p>
                          <p className="text-xs text-ink-400">
                            Registered: {formatDateTime(dev.registeredAt)}
                            {dev.lastPushAt ? ` · Last alert: ${formatDateTime(dev.lastPushAt)}` : ''}
                          </p>
                        </div>
                      </div>
                      <Badge tone="brand">{dev.platform.toUpperCase()}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      <Modal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        title="Send announcement"
        description={options ? `Audience is resolved on the server. ${options.employeeCount} active employees.` : undefined}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setSendOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" form="announcement-form" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send announcement'}
            </button>
          </>
        }
      >
        <form id="announcement-form" onSubmit={send} className="space-y-4">
          <Field label="Title" required>
            <input
              className="input"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              minLength={3}
              required
            />
          </Field>
          <Field label="Message" required>
            <textarea
              className="input min-h-[100px]"
              value={form.message}
              onChange={(event) => setForm({ ...form, message: event.target.value })}
              minLength={5}
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority">
              <select className="input" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
                {['low', 'normal', 'high', 'critical'].map((value) => (
                  <option key={value} value={value}>
                    {titleize(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Audience">
              <select
                className="input"
                value={form.audienceType}
                onChange={(event) => setForm({ ...form, audienceType: event.target.value, audienceValue: '' })}
              >
                <option value="all">All employees</option>
                <option value="department">Specific department</option>
                <option value="role">Specific role</option>
                <option value="location">Specific location</option>
              </select>
            </Field>
          </div>
          {form.audienceType !== 'all' && (
            <Field label="Audience value" required>
              <select
                className="input"
                value={form.audienceValue}
                onChange={(event) => setForm({ ...form, audienceValue: event.target.value })}
                required
              >
                <option value="">Select…</option>
                {form.audienceType === 'department' &&
                  options?.departments.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                {form.audienceType === 'role' &&
                  options?.roles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                {form.audienceType === 'location' &&
                  options?.locations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <SectionHeader
            title="Delivery"
            description="Delivered in-app instantly, via Windows & mobile push notifications, and email where SMTP is configured."
          />
        </form>
      </Modal>
    </div>
  );
}
