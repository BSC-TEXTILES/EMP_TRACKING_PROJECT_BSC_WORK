import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useDocumentTitle } from '../../lib/hooks';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Card, Field, Modal, PageHeader, Skeleton } from '../../components/ui';
import { Icon } from '../../components/icons';
import { formatDateTime } from '../../lib/format';

interface Announcement {
  id: number;
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  audienceType: string;
  author: string;
  publishedAt: string;
}

interface AudienceOptions {
  departments: Array<{ id: number; name: string }>;
  roles: Array<{ id: number; name: string }>;
  locations: Array<{ id: number; name: string }>;
  employeeCount: number;
}

export default function HrAnnouncements() {
  useDocumentTitle('HR Announcements');
  const toast = useToast();
  const { has, user } = useAuth();

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [options, setOptions] = useState<AudienceOptions | null>(null);

  const [form, setForm] = useState({
    title: '',
    message: '',
    priority: 'normal' as 'low' | 'normal' | 'high' | 'critical',
    audienceType: 'all' as 'all' | 'department' | 'role' | 'location',
    audienceValue: '',
  });
  const [busy, setBusy] = useState(false);

  const loadAnnouncements = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ announcements: Announcement[] }>('/notifications/announcements');
      setAnnouncements(res.announcements);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAnnouncements();
    api.get<AudienceOptions>('/notifications/audience-options')
      .then((res) => setOptions(res))
      .catch(() => undefined);
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.message.trim()) {
      toast.error('Title and message are required.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/notifications/announcements', {
        title: form.title,
        message: form.message,
        priority: form.priority,
        audienceType: form.audienceType,
        audienceValue: form.audienceType === 'all' ? undefined : form.audienceValue,
      });
      toast.success('Announcement broadcasted to workforce.');
      setCreateOpen(false);
      setForm({ title: '', message: '', priority: 'normal', audienceType: 'all', audienceValue: '' });
      await loadAnnouncements();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const priorityBadge = (p: Announcement['priority']) => {
    switch (p) {
      case 'critical':
        return <Badge tone="danger">Urgent / Critical</Badge>;
      case 'high':
        return <Badge tone="warning">Important</Badge>;
      case 'low':
        return <Badge tone="neutral">Informational</Badge>;
      default:
        return <Badge tone="info">General Notice</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title="HR Announcements & Staff Notices"
          description="Broadcast official store guidelines, festival holiday notices, shift updates, and company memos to employees."
        />
        <button
          type="button"
          className="btn-primary flex items-center gap-1.5"
          onClick={() => setCreateOpen(true)}
        >
          <Icon name="bell" className="h-4 w-4" />
          <span>New Announcement</span>
        </button>
      </div>

      <div className="space-y-4">
        {loading ? (
          <Card className="p-6">
            <Skeleton lines={6} />
          </Card>
        ) : announcements.length === 0 ? (
          <Card className="p-8 text-center text-ink-500">
            No company announcements posted yet. Click "New Announcement" to publish a notice.
          </Card>
        ) : (
          announcements.map((a) => (
            <Card key={a.id} className="card-pad space-y-3 border-l-4 border-l-brand-600">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-ink-900">{a.title}</h3>
                  {priorityBadge(a.priority)}
                </div>
                <div className="flex items-center gap-2 text-xs text-ink-500">
                  <span>Posted by <strong className="text-ink-800">{a.author}</strong></span>
                  <span>&bull;</span>
                  <span>{formatDateTime(a.publishedAt)}</span>
                </div>
              </div>
              <p className="whitespace-pre-line text-sm text-ink-700">{a.body}</p>
              <div className="flex items-center gap-2 pt-1 text-xs text-ink-400">
                <span className="font-semibold text-ink-600">Audience:</span>
                <Badge tone="neutral" className="capitalize">
                  {a.audienceType}
                </Badge>
              </div>
            </Card>
          ))
        )}
      </div>

      {createOpen && (
        <Modal
          open={createOpen}
          title="Publish HR Announcement / Notice"
          onClose={() => setCreateOpen(false)}
        >
          <form className="space-y-4" onSubmit={handleCreate}>
            <Field label="Announcement Title" required>
              <input
                type="text"
                className="input"
                placeholder="e.g. Revised Store Timings / Festival Bonus Update"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                required
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority" required>
                <select
                  className="input"
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as any }))}
                >
                  <option value="normal">General Notice</option>
                  <option value="high">Important</option>
                  <option value="critical">Urgent / Critical</option>
                  <option value="low">Informational</option>
                </select>
              </Field>

              <Field label="Target Audience" required>
                <select
                  className="input"
                  value={form.audienceType}
                  onChange={(e) => setForm((f) => ({ ...f, audienceType: e.target.value as any, audienceValue: '' }))}
                >
                  <option value="all">All Employees ({options?.employeeCount ?? 0})</option>
                  <option value="location">Specific Store Location</option>
                  <option value="department">Specific Department</option>
                  <option value="role">Specific Role</option>
                </select>
              </Field>
            </div>

            {form.audienceType === 'location' && (
              <Field label="Select Store Location" required>
                <select
                  className="input"
                  value={form.audienceValue}
                  onChange={(e) => setForm((f) => ({ ...f, audienceValue: e.target.value }))}
                  required
                >
                  <option value="">Select a location…</option>
                  {options?.locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </Field>
            )}

            {form.audienceType === 'department' && (
              <Field label="Select Department" required>
                <select
                  className="input"
                  value={form.audienceValue}
                  onChange={(e) => setForm((f) => ({ ...f, audienceValue: e.target.value }))}
                  required
                >
                  <option value="">Select a department…</option>
                  {options?.departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </Field>
            )}

            {form.audienceType === 'role' && (
              <Field label="Select Role" required>
                <select
                  className="input"
                  value={form.audienceValue}
                  onChange={(e) => setForm((f) => ({ ...f, audienceValue: e.target.value }))}
                  required
                >
                  <option value="">Select a role…</option>
                  {options?.roles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Announcement Message" required>
              <textarea
                className="input"
                rows={4}
                placeholder="Type the announcement text clearly for all employees…"
                value={form.message}
                onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                required
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCreateOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? 'Broadcasting…' : 'Publish Notice'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
