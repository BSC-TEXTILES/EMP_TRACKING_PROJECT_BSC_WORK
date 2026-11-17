import { SmtpSettingsForm } from '../components/SmtpSettingsForm';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, PageHeader, SectionHeader, Skeleton, StatusBadge } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDateTime, relativeTime } from '../lib/format';

interface SmtpStatus {
  configured: boolean;
  reachable: boolean | null;
  host: string;
  port: number;
  secure: boolean;
  auth: boolean;
  from: string;
  replyTo: string | null;
  error: string | null;
  checkedAt: string | null;
}

interface Delivery {
  id: number;
  recipient: string;
  recipientName: string | null;
  subject: string;
  template: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  messageId?: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface Overview {
  status: SmtpStatus;
  stats: Record<string, number>;
  last24h: number;
  templates: { key: string; label: string; description: string }[];
  settings: {
    appName: string;
    appUrl: string;
    otpExpiryMinutes: number;
    otpResendCooldownSeconds: number;
    otpMaxAttempts: number;
    provider: string;
  };
  deliveries: Delivery[];
}

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'accepted', label: 'Accepted by SMTP' },
  { value: 'queued', label: 'Queued' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
];

export default function EmailConfiguration() {
  useDocumentTitle('Email delivery');
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [filter, setFilter] = useState('');
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<number | null>(null);

  const load = useCallback(
    async (status = filter) => {
      try {
        const query = new URLSearchParams();
        if (status) query.set('status', status);
        query.set('limit', '60');
        const result = await api.get<Overview>(`/admin/email?${query.toString()}`);
        setData(result);
      } catch (caught) {
        toast.error(errorMessage(caught));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter],
  );

  useEffect(() => {
    void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const sendTest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!testTo.trim()) return;
    setBusy(true);
    try {
      await api.post('/admin/email/test', { to: testTo.trim() });
      toast.success(`SMTP accepted the test message for ${testTo.trim()}.`);
      setTestTo('');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (id: number) => {
    setRetrying(id);
    try {
      await api.post(`/admin/email/retry/${id}`);
      toast.success('Message requeued and attempted.');
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setRetrying(null);
    }
  };

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton lines={3} />
        <Card className="card-pad"><Skeleton lines={7} /></Card>
      </div>
    );
  }

  const { status, stats, templates, settings, deliveries } = data;
  const stateTone = !status.configured ? 'neutral' : status.reachable ? 'success' : 'danger';
  const stateLabel = !status.configured ? 'Not configured' : status.reachable ? 'Connected' : 'Unreachable';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Email delivery"
        description="Manage verified SMTP settings, OTP policies and actual delivery records."
        actions={
          <button type="button" className="btn-secondary btn-sm" onClick={() => void load()}>
            Recheck connection
          </button>
        }
      />

      <SmtpSettingsForm onSaved={() => void load()} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="card-pad lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeader title="SMTP connection" description={`${settings.provider} · ${status.host}:${status.port}${status.secure ? ' · TLS' : ''}`} />
            <Badge tone={stateTone}>{stateLabel}</Badge>
          </div>
          <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3 border-b border-ink-100 py-1.5">
              <dt className="text-ink-500">Sender</dt>
              <dd className="truncate text-right text-ink-800">{status.from}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-ink-100 py-1.5">
              <dt className="text-ink-500">Reply-to</dt>
              <dd className="truncate text-right text-ink-800">{status.replyTo ?? 'Same as sender'}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-ink-100 py-1.5">
              <dt className="text-ink-500">Authentication</dt>
              <dd className="text-ink-800">{status.auth ? 'Username and password' : 'No authentication'}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-ink-100 py-1.5">
              <dt className="text-ink-500">Last checked</dt>
              <dd className="text-ink-800">{status.checkedAt ? relativeTime(status.checkedAt) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-ink-100 py-1.5">
              <dt className="text-ink-500">Application URL</dt>
              <dd className="truncate text-right text-ink-800">{settings.appUrl}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-ink-100 py-1.5">
              <dt className="text-ink-500">Codes valid for</dt>
              <dd className="text-ink-800">{settings.otpExpiryMinutes} min · {settings.otpMaxAttempts} attempts</dd>
            </div>
          </dl>

          {status.error && (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <Icon name="shield" size={14} className="mt-0.5 shrink-0" />
              <span>{status.error}</span>
            </p>
          )}

          <form onSubmit={sendTest} className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-4">
            <div className="min-w-[220px] flex-1">
              <Field label="Send a test message" hint="Delivered immediately and recorded in the log below.">
                <input
                  type="email"
                  required
                  className="input"
                  placeholder="you@company.com"
                  value={testTo}
                  onChange={(event) => setTestTo(event.target.value)}
                />
              </Field>
            </div>
            <button type="submit" className="btn-primary btn-sm" disabled={busy || !status.configured}>
              {busy ? 'Sending…' : 'Send test'}
            </button>
          </form>
        </Card>

        <Card className="card-pad">
          <SectionHeader title="Delivery health" description="Messages recorded by the queue." />
          <div className="mt-4 space-y-2 text-sm">
            {[
              { label: 'Sent', value: stats.sent ?? 0, tone: 'text-emerald-700' },
              { label: 'Queued', value: stats.queued ?? 0, tone: 'text-brand-700' },
              { label: 'Retrying', value: stats.failed ?? 0, tone: 'text-amber-700' },
              { label: 'Skipped (no SMTP)', value: stats.skipped ?? 0, tone: 'text-ink-600' },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between border-b border-ink-100 py-1.5 last:border-0">
                <span className="text-ink-500">{row.label}</span>
                <span className={cx('font-semibold', row.tone)}>{row.value}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-400">{data.last24h} message(s) recorded in the last 24 hours.</p>
          <div className="mt-4 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-600">
            <p className="font-semibold text-ink-700">How to change these settings</p>
            <p className="mt-1 leading-relaxed">
              Update <code className="font-mono">SMTP_*</code> in <code className="font-mono">.env.production</code> on the server and restart the API.
              Values are intentionally not editable here so credentials never travel through the browser.
            </p>
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-ink-800">Delivery log</p>
            <p className="text-xs text-ink-500">Every queued, sent, retried and skipped message with its failure reason.</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={cx('rounded-md px-2.5 py-1 text-xs font-medium', filter === item.value ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200')}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {deliveries.length === 0 ? (
          <EmptyState title="No messages yet" description="Task, ticket, meeting, leave and KPI notifications will appear here once they are queued." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Queued</th>
                  <th>Recipient</th>
                  <th>Subject</th>
                  <th>Template</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Detail</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deliveries.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(row.createdAt)}</td>
                    <td className="text-ink-700">
                      <span className="block text-sm">{row.recipientName ?? row.recipient}</span>
                      {row.recipientName && <span className="block text-[11px] text-ink-400">{row.recipient}</span>}
                    </td>
                    <td className="max-w-[260px] truncate text-sm text-ink-700" title={row.subject}>{row.subject}</td>
                    <td className="text-xs text-ink-500">{row.template}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td className="text-xs text-ink-500">{row.attempts}/{row.maxAttempts}</td>
                    <td className="max-w-[260px] text-xs text-ink-500">
                      {row.status === 'sent' && row.sentAt ? `Delivered ${formatDateTime(row.sentAt)}` : null}
                      {row.lastError ? <span className="line-clamp-2" title={row.lastError}>{row.lastError}</span> : null}
                      {!row.lastError && row.status !== 'sent' && row.nextAttemptAt ? `Next attempt ${formatDateTime(row.nextAttemptAt)}` : null}
                      {!row.lastError && row.status === 'queued' ? 'Waiting for the queue worker' : null}
                    </td>
                    <td className="text-right">
                      {(row.status === 'failed' || row.status === 'skipped') && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={retrying === row.id}
                          onClick={() => void retry(row.id)}
                        >
                          {retrying === row.id ? 'Retrying…' : 'Retry'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="card-pad">
        <SectionHeader title="Message templates" description="HTML templates rendered server-side and shared by every module." />
        <div className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {templates.map((template) => (
            <div key={template.key} className="border-b border-ink-100 py-2 last:border-0">
              <p className="text-sm font-medium text-ink-800">{template.label}</p>
              <p className="text-xs text-ink-500">{template.description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
