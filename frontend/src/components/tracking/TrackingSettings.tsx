import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Card, Modal, Skeleton, Switch } from '../ui';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

interface Settings {
  trackingEnabled: boolean; deviceRegistrationEnabled: boolean; selfEnrollmentEnabled: boolean; appTrackingEnabled: boolean;
  websiteTrackingEnabled: boolean; windowTitleTrackingEnabled: boolean; idleThresholdSeconds: number; heartbeatIntervalSeconds: number;
  syncIntervalSeconds: number; offlineAfterSeconds: number; latestAgentVersion: string; minimumAgentVersion: string; retentionDays: number; noticeText: string;
}
type Key = keyof Settings;
interface Described {
  global: Settings;
  canEditGlobal: boolean;
  canEdit: boolean;
  locations: { id: number; code: string; name: string; overrides: Partial<Settings>; effective: Settings }[];
}

const FIELDS: { key: Key; label: string; hint: string; kind: 'bool' | 'number' | 'text' | 'long'; unit?: string; min?: number; max?: number; locationOverride?: boolean }[] = [
  { key: 'trackingEnabled', label: 'Tracking enabled', hint: 'Master switch. When off, agents pause and send heartbeats only.', kind: 'bool', locationOverride: true },
  { key: 'deviceRegistrationEnabled', label: 'Device registration permitted', hint: 'Allow new computers to be enrolled.', kind: 'bool', locationOverride: true },
  { key: 'selfEnrollmentEnabled', label: 'Employee self-enrollment', hint: 'Employees may generate a code for their own computer.', kind: 'bool', locationOverride: true },
  { key: 'appTrackingEnabled', label: 'Application tracking', hint: 'Record the foreground application name.', kind: 'bool', locationOverride: true },
  { key: 'websiteTrackingEnabled', label: 'Website tracking', hint: 'Record the active tab domain (browser connector required).', kind: 'bool', locationOverride: true },
  { key: 'windowTitleTrackingEnabled', label: 'Window titles', hint: 'Off by default: titles can contain private information (email subjects, file names).', kind: 'bool', locationOverride: true },
  { key: 'idleThresholdSeconds', label: 'Idle threshold', hint: 'No keyboard/mouse input for this long counts as idle (60–3600).', kind: 'number', unit: 'seconds', min: 60, max: 3600, locationOverride: true },
  { key: 'heartbeatIntervalSeconds', label: 'Heartbeat interval', hint: 'How often agents report status (15–600).', kind: 'number', unit: 'seconds', min: 15, max: 600, locationOverride: true },
  { key: 'syncIntervalSeconds', label: 'Synchronisation interval', hint: 'How often queued events upload (10–600).', kind: 'number', unit: 'seconds', min: 10, max: 600, locationOverride: true },
  { key: 'offlineAfterSeconds', label: 'Offline after', hint: 'No heartbeat for this long marks a device offline (≥ 2 × heartbeat).', kind: 'number', unit: 'seconds', min: 60, max: 3600, locationOverride: true },
  { key: 'latestAgentVersion', label: 'Latest agent version', hint: 'Older agents are told an update is available.', kind: 'text' },
  { key: 'minimumAgentVersion', label: 'Minimum agent version', hint: 'Older agents are flagged as outdated.', kind: 'text' },
  { key: 'retentionDays', label: 'Data retention', hint: 'Older tracking data is archived then deleted nightly (7–1095).', kind: 'number', unit: 'days', min: 7, max: 1095, locationOverride: true },
  { key: 'noticeText', label: 'Monitoring notice shown to employees', hint: 'Employees must acknowledge this before collection starts.', kind: 'long' },
];

export function TrackingSettings() {
  const toast = useToast();
  const [data, setData] = useState<Described | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'global' | number>('global');
  const [draft, setDraft] = useState<Partial<Record<Key, unknown>>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retention, setRetention] = useState<null | { plan: { locationId: number | null; cutoff: string; events: number; heartbeats: number; sessions: number }[] }>(null);
  const [retentionBusy, setRetentionBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<Described>('/tracking/settings');
      setData(result);
      setError(null);
      if (!result.canEditGlobal && result.locations[0]) setScope((s) => (s === 'global' ? result.locations[0].id : s));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setDraft({}); }, [scope]);

  const location = useMemo(() => (scope === 'global' ? null : data?.locations.find((l) => l.id === scope) ?? null), [data, scope]);
  if (error) return <Card className="card-pad text-sm text-red-600">{error}</Card>;
  if (!data) return <Card className="card-pad"><Skeleton lines={8} /></Card>;

  const base: Settings = location ? location.effective : data.global;
  const fields = FIELDS.filter((f) => scope === 'global' || f.locationOverride);
  const valueOf = (key: Key) => (key in draft ? draft[key] : location ? (key in location.overrides ? location.overrides[key] : null) : base[key]);
  const changes = Object.entries(draft) as [Key, unknown][];
  const editable = data.canEdit && (scope !== 'global' || data.canEditGlobal);

  const save = async () => {
    setSaving(true);
    try {
      const settings = Object.fromEntries(changes.map(([k, v]) => [k, v === '' ? null : v]));
      await api.put('/tracking/settings', { locationId: scope === 'global' ? null : scope, settings });
      toast.success('Tracking settings saved. Agents pick them up at their next heartbeat.');
      setDraft({});
      setConfirm(false);
      await load();
    } catch (e) {
      toast.error(errorMessage(e), 'Settings not saved');
    } finally {
      setSaving(false);
    }
  };

  const previewRetention = async () => {
    setRetentionBusy(true);
    try { setRetention(await api.post('/tracking/retention', { dryRun: true })); } catch (e) { toast.error(errorMessage(e)); } finally { setRetentionBusy(false); }
  };
  const runRetention = async () => {
    setRetentionBusy(true);
    try {
      const result = await api.post<{ archiveFiles: number }>('/tracking/retention', { dryRun: false });
      toast.success(`Retention complete: ${result.archiveFiles} archive file(s) written.`);
      setRetention(null);
    } catch (e) { toast.error(errorMessage(e)); } finally { setRetentionBusy(false); }
  };

  const display = (key: Key, value: unknown) => (typeof value === 'boolean' ? (value ? 'On' : 'Off') : value === null || value === undefined ? 'Inherit global' : String(value));

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3">
          <span className="text-sm font-semibold text-ink-800">Scope</span>
          {data.canEditGlobal && (
            <button type="button" onClick={() => setScope('global')} className={`rounded-full px-3 py-1 text-sm ${scope === 'global' ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'}`}>All locations (global)</button>
          )}
          {data.locations.map((l) => (
            <button key={l.id} type="button" onClick={() => setScope(l.id)} className={`rounded-full px-3 py-1 text-sm ${scope === l.id ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'}`}>
              {l.code}{Object.keys(l.overrides).length > 0 && <span className="ml-1 opacity-75">• {Object.keys(l.overrides).length}</span>}
            </button>
          ))}
        </div>
        {location && <p className="border-b border-ink-100 bg-ink-50 px-4 py-2 text-xs text-ink-600">{location.name}: values marked <em>Inherit global</em> follow the global setting. Override only what must differ at this location.</p>}
        {!base.trackingEnabled && <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">Tracking is currently <strong>disabled</strong> {location ? `for ${location.code}` : 'globally'}: agents pause collection and the dashboard shows “Tracking disabled”.</p>}
        <div className="divide-y divide-ink-100">
          {fields.map((f) => {
            const value = valueOf(f.key);
            const inherited = location !== null && (value === null || value === undefined);
            return (
              <div key={f.key} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,320px)] sm:items-center">
                <div>
                  <div className="text-sm font-medium text-ink-900">{f.label} {f.key in draft && <Badge tone="brand">changed</Badge>}</div>
                  <div className="text-xs text-ink-500">{f.hint}{inherited ? ` · global: ${display(f.key, data.global[f.key])}` : ''}</div>
                </div>
                <div className="flex items-center gap-2">
                  {location && (
                    <select className="input h-9 w-36" disabled={!editable} value={inherited ? 'inherit' : 'override'}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value === 'inherit' ? null : data.global[f.key] }))}>
                      <option value="inherit">Inherit</option><option value="override">Override</option>
                    </select>
                  )}
                  {!inherited && f.kind === 'bool' && <Switch checked={Boolean(value)} disabled={!editable} onChange={(checked) => setDraft((d) => ({ ...d, [f.key]: checked }))} />}
                  {!inherited && f.kind === 'number' && (
                    <span className="flex items-center gap-2">
                      <input type="number" className="input h-9 w-28" disabled={!editable} min={f.min} max={f.max} value={String(value ?? '')}
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value === '' ? '' : Number(e.target.value) }))} />
                      <span className="text-xs text-ink-500">{f.unit}</span>
                    </span>
                  )}
                  {!inherited && f.kind === 'text' && <input className="input h-9 w-32" disabled={!editable} value={String(value ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />}
                  {!inherited && f.kind === 'long' && <textarea className="input min-h-[110px] w-full" disabled={!editable} value={String(value ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />}
                </div>
              </div>
            );
          })}
        </div>
        {editable ? (
          <div className="flex justify-end gap-2 border-t border-ink-100 px-4 py-3">
            <button type="button" className="btn-secondary" disabled={changes.length === 0} onClick={() => setDraft({})}>Discard</button>
            <button type="button" className="btn-primary" disabled={changes.length === 0} onClick={() => setConfirm(true)}>Review & save</button>
          </div>
        ) : (
          <p className="border-t border-ink-100 px-4 py-3 text-xs text-ink-500">You can view these settings. Changing them requires the <em>Configure monitoring policy</em> permission{scope === 'global' ? ' with organisation-wide access' : ''}.</p>
        )}
      </Card>

      {data.canEditGlobal && data.canEdit && (
        <Card className="card-pad">
          <h3 className="text-sm font-semibold text-ink-900">Retention and archival</h3>
          <p className="mt-1 text-sm text-ink-600">Runs nightly at 02:40 IST. Data older than each location’s retention period is written to compressed archive files on the server, then removed from the database. Preview what would be affected first.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-secondary" disabled={retentionBusy} onClick={previewRetention}>Preview</button>
          </div>
        </Card>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Apply tracking settings?" description={scope === 'global' ? 'Affects every location without an override.' : `Affects ${location?.code} only.`}
        footer={<><button type="button" className="btn-secondary" onClick={() => setConfirm(false)} disabled={saving}>Cancel</button><button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Apply'}</button></>}>
        <ul className="space-y-1.5 text-sm">
          {changes.map(([k, v]) => (
            <li key={k} className="flex justify-between gap-3"><span className="text-ink-600">{FIELDS.find((f) => f.key === k)?.label}</span><span className="max-w-[60%] truncate font-medium text-ink-900">{k === 'noticeText' ? 'Updated text' : display(k, v === '' ? null : v)}</span></li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-500">The change is recorded in the audit log. Connected agents apply it within one heartbeat interval.</p>
      </Modal>

      <Modal open={Boolean(retention)} onClose={() => setRetention(null)} title="Retention preview"
        footer={<><button type="button" className="btn-secondary" onClick={() => setRetention(null)} disabled={retentionBusy}>Close</button>
          <button type="button" className="btn-danger" disabled={retentionBusy || !retention?.plan.some((p) => p.events + p.sessions + p.heartbeats > 0)} onClick={runRetention}>{retentionBusy ? 'Archiving…' : 'Archive and delete now'}</button></>}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-ink-500"><tr><th className="py-1">Location</th><th>Older than</th><th className="text-right">Events</th><th className="text-right">Sessions</th><th className="text-right">Heartbeats</th></tr></thead>
          <tbody>
            {retention?.plan.map((p) => (
              <tr key={String(p.locationId)} className="border-t border-ink-100">
                <td className="py-1.5">{data.locations.find((l) => l.id === p.locationId)?.code ?? (p.locationId === null ? 'No location' : `#${p.locationId}`)}</td>
                <td>{p.cutoff}</td><td className="text-right tabular-nums">{p.events}</td><td className="text-right tabular-nums">{p.sessions}</td><td className="text-right tabular-nums">{p.heartbeats}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>
    </div>
  );
}
