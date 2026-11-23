import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, EmptyState, Field, Modal, Skeleton } from '../ui';
import { Icon } from '../icons';
import { api, downloadFile, errorMessage } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { useToast } from '../../contexts/ToastContext';
import { ago, istDateTime, type DeviceInfo, type OverviewResponse } from '../../lib/tracking';

type DeviceRow = DeviceInfo & { status: string; employeeName: string; employeeCode: string; locationCode: string | null };
interface PendingCode { id: number; employee_id: number; code_hint: string; expires_at: string; created_at: string; full_name: string; employee_code: string; created_by_name: string | null }

export function TrackingDevices({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [codes, setCodes] = useState<PendingCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [revoking, setRevoking] = useState<DeviceRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        api.get<{ devices: DeviceRow[] }>('/tracking/devices'),
        canManage ? api.get<{ codes: PendingCode[] }>('/tracking/enrollment-codes') : Promise.resolve({ codes: [] }),
      ]);
      setDevices(d.devices);
      setCodes(c.codes);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [canManage]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.post(`/tracking/devices/${revoking.deviceId}/revoke`, {});
      toast.success(`${revoking.deviceName} can no longer send tracking data.`, 'Device revoked');
      setRevoking(null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeCode = async (code: PendingCode) => {
    try {
      await api.del(`/tracking/enrollment-codes/${code.id}`);
      toast.success('Enrollment code cancelled.');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const downloadInstaller = async () => {
    try {
      await downloadFile('/tracking/agent/download', 'BSC-Activity-Tracker-Setup.exe');
    } catch (e) {
      toast.error(errorMessage(e), 'Installer unavailable');
    }
  };

  const term = filter.trim().toLowerCase();
  const shown = (devices ?? []).filter((d) => !term || `${d.employeeName} ${d.employeeCode} ${d.deviceName} ${d.locationCode ?? ''}`.toLowerCase().includes(term));

  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-base font-semibold text-ink-900">Install the Windows tracking agent</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-600">
              <li>An administrator runs <strong>BSC-Activity-Tracker-Setup.exe</strong> on the company computer (silent: <code className="rounded bg-ink-100 px-1">/install /quiet</code>).</li>
              <li>Generate a one-time enrollment code for the employee below (valid 72 hours).</li>
              <li>The employee signs in to Windows, enters the code in the tray app and acknowledges the monitoring notice. Tracking starts only then.</li>
              <li>Optional: deploy the <em>BSC Activity Tracker – Browser Connector</em> extension to Chrome/Edge to record website domains.</li>
            </ol>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={downloadInstaller}><Icon name="download" size={16} /> Download installer</button>
            {canManage && <button type="button" className="btn-primary" onClick={() => setEnrollOpen(true)}><Icon name="plus" size={16} /> Enrollment code</button>}
          </div>
        </div>
      </Card>

      {canManage && codes.length > 0 && (
        <Card>
          <div className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-800">Unused enrollment codes ({codes.length})</div>
          <ul className="divide-y divide-ink-100">
            {codes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span><strong>{c.full_name}</strong> <span className="text-ink-500">({c.employee_code}) · code …{c.code_hint} · expires {istDateTime(c.expires_at)}{c.created_by_name ? ` · by ${c.created_by_name}` : ''}</span></span>
                <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => revokeCode(c)}>Cancel code</button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-800">Registered devices {devices && <span className="text-ink-500">({devices.length})</span>}</h2>
          <div className="flex gap-2">
            <input className="input h-9 w-56" placeholder="Search employee or device" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button type="button" className="btn-secondary btn-sm" onClick={() => void load()} aria-label="Refresh devices"><Icon name="refresh" size={14} /></button>
          </div>
        </div>
        {error ? (
          <div className="p-4 text-sm text-red-600">{error} <button type="button" className="ml-2 underline" onClick={() => void load()}>Retry</button></div>
        ) : !devices ? (
          <div className="p-4"><Skeleton lines={5} /></div>
        ) : shown.length === 0 ? (
          <EmptyState title="No tracking devices registered" description="Install the agent and register a computer with an enrollment code." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2.5">Employee</th><th className="px-3 py-2.5">Device</th><th className="px-3 py-2.5">Agent</th>
                  <th className="px-3 py-2.5">Connection</th><th className="px-3 py-2.5">Last heartbeat</th><th className="px-3 py-2.5">Last sync</th>
                  <th className="px-3 py-2.5 text-right">Pending</th><th className="px-3 py-2.5 text-right">Failures</th><th className="px-3 py-2.5">Problem</th>
                  {canManage && <th className="px-4 py-2.5 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {shown.map((d) => (
                  <tr key={d.deviceId} className={d.status !== 'active' ? 'opacity-60' : undefined}>
                    <td className="px-4 py-2.5">
                      <Link to={`/activity-tracking/${d.employeeId}`} className="font-medium text-ink-900 hover:text-brand-700">{d.employeeName}</Link>
                      <div className="text-xs text-ink-500">{d.employeeCode} · {d.locationCode ?? '—'}</div>
                    </td>
                    <td className="px-3 py-2.5">{d.deviceName}<div className="text-xs text-ink-500">{[d.osName, d.osVersion].filter(Boolean).join(' ')}</div></td>
                    <td className="px-3 py-2.5">{d.agentVersion ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      {d.status !== 'active' ? <Badge>Revoked</Badge> : d.online ? <Badge tone="success">Connected</Badge> : <Badge tone="danger">Offline</Badge>}
                      {d.status === 'active' && !d.noticeAcknowledgedAt && <div className="mt-1 text-xs text-amber-700">Notice not acknowledged</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5" title={istDateTime(d.lastHeartbeatAt)}>{d.lastHeartbeatAt ? ago(d.lastHeartbeatAt) : 'Never'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5" title={istDateTime(d.lastSyncAt)}>{d.lastSyncAt ? ago(d.lastSyncAt) : 'Never'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{d.pendingEvents}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{d.connectionFailures}</td>
                    <td className="max-w-[220px] px-3 py-2.5 text-xs text-amber-700">{d.syncError ?? (d.extensionSeenAt ? '' : <span className="text-ink-400">No browser connector</span>)}</td>
                    {canManage && (
                      <td className="px-4 py-2.5 text-right">
                        {d.status === 'active' && <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => setRevoking(d)}>Revoke</button>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <EnrollmentDialog open={enrollOpen} onClose={() => { setEnrollOpen(false); void load(); }} />

      <Modal
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title="Revoke tracking device?"
        description={revoking ? `${revoking.deviceName} — ${revoking.employeeName}` : undefined}
        footer={(
          <>
            <button type="button" className="btn-secondary" onClick={() => setRevoking(null)} disabled={busy}>Cancel</button>
            <button type="button" className="btn-danger" onClick={revoke} disabled={busy}>{busy ? 'Revoking…' : 'Revoke device'}</button>
          </>
        )}
      >
        <p className="text-sm text-ink-600">The device credential is invalidated immediately. The agent on that computer stops tracking and discards any data it could not upload. Recorded history is kept. To use the computer again, issue a new enrollment code.</p>
      </Modal>
    </div>
  );
}

function EnrollmentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [results, setResults] = useState<OverviewResponse['items']>([]);
  const [selected, setSelected] = useState<OverviewResponse['items'][number] | null>(null);
  const [issued, setIssued] = useState<{ code: string; expiresAt: string; employee: { name: string; code: string } } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setSearch(''); setSelected(null); setIssued(null); setResults([]); return; }
    let cancelled = false;
    api.get<OverviewResponse>(`/tracking/overview?pageSize=20&sort=name&search=${encodeURIComponent(debounced)}`)
      .then((r) => { if (!cancelled) setResults(r.items); })
      .catch(() => { if (!cancelled) setResults([]); });
    return () => { cancelled = true; };
  }, [open, debounced]);

  const issue = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setIssued(await api.post('/tracking/enrollment-codes', { employeeId: selected.id }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={issued ? 'Enrollment code' : 'Register a computer for an employee'}
      description={issued ? `For ${issued.employee.name} (${issued.employee.code})` : 'Choose the employee who will use the computer.'}
      footer={issued
        ? <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        : (
          <>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" onClick={issue} disabled={!selected || busy}>{busy ? 'Generating…' : 'Generate code'}</button>
          </>
        )}
    >
      {issued ? (
        <div className="text-center">
          <div className="mx-auto my-3 inline-block select-all rounded-xl border-2 border-dashed border-brand-300 bg-brand-50 px-6 py-4 font-mono text-3xl font-bold tracking-[0.2em] text-brand-800">{issued.code}</div>
          <p className="text-sm text-ink-600">Single use · expires {istDateTime(issued.expiresAt)} IST.</p>
          <p className="mt-2 text-sm text-ink-600">The employee enters it in the BSC Activity Tracker tray app on the computer after signing in to Windows. This code is shown only once.</p>
          <button type="button" className="btn-secondary btn-sm mt-3" onClick={() => { void navigator.clipboard?.writeText(issued.code); toast.success('Code copied.'); }}>Copy code</button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Employee">
            <input className="input" autoFocus placeholder="Search by name or employee ID" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <ul className="max-h-64 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
            {results.length === 0 && <li className="px-3 py-4 text-center text-sm text-ink-500">No matching employees in your scope.</li>}
            {results.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setSelected(r)}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${selected?.id === r.id ? 'bg-brand-50' : 'hover:bg-ink-50'}`}>
                  <span><strong>{r.fullName}</strong> <span className="text-ink-500">· {r.employeeCode} · {r.locationCode ?? '—'}</span></span>
                  {r.deviceCount > 0 && <Badge tone="info">{r.deviceCount} device{r.deviceCount > 1 ? 's' : ''}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
