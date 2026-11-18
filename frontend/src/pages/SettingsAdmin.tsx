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

interface LoginRecord {
  id: number;
  sessionId: number | null;
  employeeId: number;
  employeeCode: string;
  fullName: string;
  locationName: string;
  locationCode: string;
  department: string | null;
  designation: string | null;
  loginAt: string;
  logoutAt: string | null;
  lastHeartbeatAt: string;
  durationMinutes: number;
  ip: string | null;
  browser: string | null;
  os: string | null;
  status: string;
  logoutReason: string | null;
  terminationStatus: string;
  isLive: boolean;
}

export default function SettingsAdmin() {
  useDocumentTitle('System settings');
  const { has } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'settings' | 'audit' | 'logins' | 'jobs' | 'system'>('settings');
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditFilter, setAuditFilter] = useState({ action: '', from: '', to: '' });
  const [jobs, setJobs] = useState<JobRun[] | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [loginAudits, setLoginAudits] = useState<LoginRecord[] | null>(null);
  const [loginLocation, setLoginLocation] = useState('all');
  const [loginSearch, setLoginSearch] = useState('');
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
    if (tab === 'logins') {
      setLoginAudits(null);
      const params = new URLSearchParams();
      if (loginLocation !== 'all') params.set('location', loginLocation);
      if (loginSearch) params.set('search', loginSearch);
      api.get<{ records: LoginRecord[] }>(`/admin/login-audit?${params.toString()}`)
        .then((res) => setLoginAudits(res.records))
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
  }, [tab, auditFilter, loginLocation, loginSearch]);

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

  const shifted = (key: string) => draft[key] !== (settings?.[key] ?? '');

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
          { value: 'logins', label: 'Login & Branch Audit' },
          { value: 'jobs', label: 'Scheduled jobs' },
          { value: 'system', label: 'System health' },
        ]}
        value={tab}
        onChange={(value) => setTab(value as 'settings' | 'audit' | 'logins' | 'jobs' | 'system')}
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

      {tab === 'logins' && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3 bg-ink-50/50">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">User Login & Branch Tracking History</h3>
              <p className="text-xs text-ink-500">Live sessions and complete login/logout timeline across all store branches.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input w-auto text-xs py-1"
                placeholder="Search name, code, IP…"
                value={loginSearch}
                onChange={(e) => setLoginSearch(e.target.value)}
              />
              <select
                className="input w-auto text-xs py-1 font-medium"
                value={loginLocation}
                onChange={(e) => setLoginLocation(e.target.value)}
              >
                <option value="all">All Branches</option>
                <option value="BEL">BEL – Belagavi</option>
                <option value="DAV">DAV – Davanagere</option>
                <option value="SHI">SHI – Shivamogga</option>
                <option value="HUB">HUB/HQ – Head Office</option>
              </select>
            </div>
          </div>

          {!loginAudits ? (
            <div className="p-4"><Skeleton lines={8} /></div>
          ) : loginAudits.length === 0 ? (
            <EmptyState title="No login history found" description="No login records match the current filter." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Employee</th>
                    <th>Assigned Branch</th>
                    <th>Login Time</th>
                    <th>Logout Time</th>
                    <th>Duration</th>
                    <th>Device & IP</th>
                    <th>Termination</th>
                  </tr>
                </thead>
                <tbody>
                  {loginAudits.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        {entry.isLive ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-200">
                            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                            Live Online
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
                            Logged Out
                          </span>
                        )}
                      </td>
                      <td>
                        <div>
                          <p className="font-semibold text-ink-900">{entry.fullName}</p>
                          <p className="text-xs text-ink-400 font-mono">{entry.employeeCode} {entry.designation ? `· ${entry.designation}` : ''}</p>
                        </div>
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                          {entry.locationCode || 'HUB'}
                          <span className="font-normal text-blue-600">({entry.locationName})</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-xs text-ink-600">{formatDateTime(entry.loginAt)}</td>
                      <td className="whitespace-nowrap text-xs text-ink-500">
                        {entry.logoutAt ? formatDateTime(entry.logoutAt) : <span className="text-emerald-600 font-medium">Session Active</span>}
                      </td>
                      <td className="text-xs font-mono text-ink-700">
                        {entry.durationMinutes > 0 ? (
                          entry.durationMinutes < 60 ? `${entry.durationMinutes}m` : `${Math.floor(entry.durationMinutes / 60)}h ${entry.durationMinutes % 60}m`
                        ) : '—'}
                      </td>
                      <td className="text-xs text-ink-500">
                        <p className="truncate max-w-[140px]" title={entry.browser || ''}>{entry.browser || entry.os || 'Web Browser'}</p>
                        <p className="text-[11px] font-mono text-ink-400">{entry.ip || '—'}</p>
                      </td>
                      <td className="text-xs text-ink-500">
                        <Badge tone={entry.isLive ? 'success' : entry.logoutReason === 'session_expired' ? 'warning' : 'neutral'}>
                          {entry.logoutReason || entry.terminationStatus || 'Normal'}
                        </Badge>
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
