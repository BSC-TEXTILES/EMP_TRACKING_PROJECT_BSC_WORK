import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, PageHeader, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDateTime, titleize } from '../lib/format';

interface AuditEntry {
  id: number;
  actorId: number | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

interface JobRun {
  id: number;
  job: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  message: string | null;
}

interface SystemInfo {
  database: { version: string; connections: number };
  storage: { files: number; bytes: number };
  realtime: { sockets: number; online: number; engine: boolean };
  runtime: { node: string; uptimeSeconds: number; memoryMb: number };
}

export default function SettingsAdmin() {
  useDocumentTitle('System settings');
  const { has } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'settings' | 'audit' | 'jobs' | 'system'>('settings');
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditFilter, setAuditFilter] = useState({ action: '', from: '', to: '' });
  const [jobs, setJobs] = useState<JobRun[] | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ settings: Record<string, string> }>('/admin/settings')
      .then((result) => { setSettings(result.settings); setDraft(result.settings); })
      .catch((caught) => toast.error(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === 'audit') {
      const query = new URLSearchParams();
      if (auditFilter.action) query.set('action', auditFilter.action);
      if (auditFilter.from) query.set('from', auditFilter.from);
      if (auditFilter.to) query.set('to', auditFilter.to);
      setAudit(null);
      api.get<{ entries: AuditEntry[] }>(`/admin/audit?${query.toString()}`)
        .then((result) => setAudit(result.entries))
        .catch((caught) => toast.error(errorMessage(caught)));
    }
    if (tab === 'jobs') {
      setJobs(null);
      api.get<{ runs: JobRun[] }>('/admin/jobs').then((result) => setJobs(result.runs)).catch((caught) => toast.error(errorMessage(caught)));
    }
    if (tab === 'system') {
      api.get<SystemInfo>('/admin/system').then(setSystem).catch((caught) => toast.error(errorMessage(caught)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, auditFilter]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/admin/settings', { settings: draft });
      toast.success('Settings saved. Changes are audited.');
      setSettings(draft);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const shifted = (key: string) => settings?.[key] !== draft[key];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Administration & audit"
        description="System configuration, complete audit trail, scheduled job history and runtime health."
        actions={tab === 'settings' && has('settings.manage') ? (
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
        ) : undefined}
      />

      <Tabs
        tabs={[
          { value: 'settings', label: 'Settings' },
          { value: 'audit', label: 'Audit log' },
          { value: 'jobs', label: 'Scheduled jobs' },
          { value: 'system', label: 'System health' },
        ]}
        value={tab}
        onChange={(value) => setTab(value as 'settings' | 'audit' | 'jobs' | 'system')}
      />

      {tab === 'settings' && (
        <Card className="card-pad">
          {!settings ? (
            <Skeleton lines={8} />
          ) : (
            <>
              <SectionHeader title="Organisation defaults" description="Attendance rules, SLA targets, KPI thresholds and retention windows." />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {Object.keys(settings).sort().map((key) => (
                  <Field key={key} label={titleize(key)} hint={shifted(key) ? 'Unsaved change' : undefined}>
                    <input
                      className="input"
                      value={draft[key] ?? ''}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      disabled={!has('settings.manage')}
                    />
                  </Field>
                ))}
              </div>
              <p className="mt-3 text-xs text-ink-400">
                Sequence counters are managed by the application. Editing them directly can break numbering continuity; every change is recorded in the audit log.
              </p>
            </>
          )}
        </Card>
      )}

      {tab === 'audit' && (
        <Card>
          <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
            <input className="input w-auto" placeholder="Filter action (e.g. task)" value={auditFilter.action} onChange={(event) => setAuditFilter({ ...auditFilter, action: event.target.value })} />
            <input type="date" className="input w-auto" value={auditFilter.from} onChange={(event) => setAuditFilter({ ...auditFilter, from: event.target.value })} />
            <input type="date" className="input w-auto" value={auditFilter.to} onChange={(event) => setAuditFilter({ ...auditFilter, to: event.target.value })} />
          </div>
          {!audit ? (
            <div className="p-4"><Skeleton lines={8} /></div>
          ) : audit.length === 0 ? (
            <EmptyState title="No audit entries" description="Activity matching the filters will appear here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th><th>Details</th></tr></thead>
                <tbody>
                  {audit.map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(entry.createdAt)}</td>
                      <td className="text-ink-700">{entry.actorName ?? 'system'}</td>
                      <td><Badge tone="brand">{entry.action}</Badge></td>
                      <td className="text-xs text-ink-600">{entry.entityType}{entry.entityId ? ` #${entry.entityId}` : ''}</td>
                      <td className="text-xs text-ink-400">{entry.ip ?? '—'}</td>
                      <td className="max-w-[280px] truncate text-[11px] text-ink-500" title={JSON.stringify(entry.after ?? entry.before)}>
                        {JSON.stringify(entry.after ?? entry.before)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'jobs' && (
        <Card>
          {!jobs ? (
            <div className="p-4"><Skeleton lines={6} /></div>
          ) : jobs.length === 0 ? (
            <EmptyState title="No scheduled runs yet" description="Reminder, auto-close and KPI jobs record every run here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Job</th><th>Started</th><th>Finished</th><th>Status</th><th>Message</th></tr></thead>
                <tbody>
                  {jobs.map((run) => (
                    <tr key={run.id}>
                      <td className="font-medium text-ink-800">{run.job}</td>
                      <td className="text-xs text-ink-500">{formatDateTime(run.startedAt)}</td>
                      <td className="text-xs text-ink-500">{formatDateTime(run.finishedAt)}</td>
                      <td><StatusBadge status={run.status} /></td>
                      <td className="max-w-[320px] truncate text-xs text-ink-500">{run.message ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'system' && (
        <div className="grid gap-4 md:grid-cols-2">
          {!system ? (
            <Card className="card-pad md:col-span-2"><Skeleton lines={6} /></Card>
          ) : (
            <>
              <Card className="card-pad">
                <SectionHeader title="Database" />
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between"><dt className="text-ink-500">Engine</dt><dd className="text-ink-800">MySQL {system.database.version}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-500">Connections</dt><dd className="text-ink-800">{system.database.connections}</dd></div>
                </dl>
              </Card>
              <Card className="card-pad">
                <SectionHeader title="File storage" />
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between"><dt className="text-ink-500">Files</dt><dd className="text-ink-800">{system.storage.files}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-500">Bytes</dt><dd className="text-ink-800">{(system.storage.bytes / 1048576).toFixed(1)} MB</dd></div>
                </dl>
              </Card>
              <Card className="card-pad">
                <SectionHeader title="Realtime" />
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between"><dt className="text-ink-500">Live sockets</dt><dd className="text-ink-800">{system.realtime.sockets}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-500">Employees online</dt><dd className="text-ink-800">{system.realtime.online}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-500">Engine</dt><dd className="text-ink-800">{system.realtime.engine ? 'Running' : 'Unavailable'}</dd></div>
                </dl>
              </Card>
              <Card className="card-pad">
                <SectionHeader title="Runtime" />
                <dl className="mt-3 space-y-1 text-sm">
                  <div className="flex justify-between"><dt className="text-ink-500">Node</dt><dd className="text-ink-800">{system.runtime.node}</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-500">Uptime</dt><dd className="text-ink-800">{Math.round(system.runtime.uptimeSeconds / 60)} min</dd></div>
                  <div className="flex justify-between"><dt className="text-ink-500">Memory</dt><dd className="text-ink-800">{system.runtime.memoryMb} MB</dd></div>
                </dl>
              </Card>
            </>
          )}
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-ink-400">
        <Icon name="shield" size={13} /> Audit entries are append-only and include the actor, entity, before/after values and source IP.
      </p>
    </div>
  );
}
