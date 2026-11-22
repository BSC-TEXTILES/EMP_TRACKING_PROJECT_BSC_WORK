import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { Avatar, Badge, Card, EmptyState, ProgressBar, SectionHeader, Skeleton, StatCard } from './ui';
import { formatDateTime, relativeTime } from '../lib/format';
import { Icon } from './icons';
import { AppIcon } from './AppIcon';

/**
 * Live device board (LiveGuard Pro integration): real hardware health, Windows
 * Defender posture and opt-in device location for every active agent.
 */

interface Security {
  antivirusEnabled: boolean | null;
  realTimeProtection: boolean | null;
  signatureAgeDays: number | null;
  recentThreats: number | null;
  threatNames: string[];
  firewallEnabled: boolean | null;
}

interface LiveDevice {
  deviceId: number;
  deviceName: string;
  os: string;
  agentVersion: string | null;
  lastSeenAt: string | null;
  online: boolean;
  employee: { id: number; name: string; code: string; photoUrl: string | null; department: string | null; location: string | null };
  session: { status: string; currentApp: string | null; isIdle: boolean } | null;
  health: {
    cpuPercent: number | null;
    memoryPercent: number | null;
    diskFreeMb: number | null;
    diskTotalMb: number | null;
    memoryTotalMb: number | null;
    uptimeMinutes: number | null;
    cpuModel: string | null;
    cpuCores: number | null;
    networkName: string | null;
    networkType: string | null;
    security: Security | null;
    reportedAt: string;
  } | null;
  location: { latitude: number; longitude: number; accuracyM: number | null; networkName: string | null; recordedAt: string } | null;
}

interface TrailPoint { latitude: number; longitude: number; accuracyM: number | null; networkName: string | null; recordedAt: string }

type SecurityState = 'protected' | 'at_risk' | 'threat' | 'unknown';

function securityState(security: Security | null | undefined): SecurityState {
  if (!security || security.antivirusEnabled === null) return 'unknown';
  if ((security.recentThreats ?? 0) > 0) return 'threat';
  if (!security.antivirusEnabled || security.realTimeProtection === false || security.firewallEnabled === false || (security.signatureAgeDays ?? 0) > 7) return 'at_risk';
  return 'protected';
}

const SECURITY_LABEL: Record<SecurityState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  protected: { label: 'Protected', tone: 'success' },
  at_risk: { label: 'At risk', tone: 'warning' },
  threat: { label: 'Threat found', tone: 'danger' },
  unknown: { label: 'No data', tone: 'neutral' },
};

const gb = (mb: number | null | undefined) => (mb == null ? '—' : `${(mb / 1024).toFixed(mb > 10240 ? 0 : 1)} GB`);
const tone = (value: number | null | undefined) => (value == null ? 'brand' : value >= 90 ? 'danger' : value >= 75 ? 'warning' : 'success');
const uptime = (minutes: number | null | undefined) => {
  if (minutes == null) return '—';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes % 60}m`;
};

/** OpenStreetMap embed: no API key, no extra library. */
function MapEmbed({ latitude, longitude, accuracyM, title }: { latitude: number; longitude: number; accuracyM: number | null; title: string }) {
  // Zoom the box to the reported accuracy so a coarse fix is not shown as a precise pin.
  const span = Math.min(0.5, Math.max(0.004, ((accuracyM ?? 200) / 111_000) * 3));
  const bbox = [longitude - span, latitude - span, longitude + span, latitude + span].map((v) => v.toFixed(5)).join(',');
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  return (
    <iframe
      title={title}
      src={src}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="h-72 w-full rounded-lg border border-ink-200"
    />
  );
}

export function LiveDevicesPanel() {
  const toast = useToast();
  const [data, setData] = useState<{ locationTrackingEnabled: boolean; devices: LiveDevice[] } | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'at_risk' | 'located'>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [trailDate, setTrailDate] = useState(new Date().toISOString().slice(0, 10));
  const [trail, setTrail] = useState<TrailPoint[] | null>(null);

  const load = async () => {
    try {
      setData(await api.get<{ locationTrackingEnabled: boolean; devices: LiveDevice[] }>('/activity/live-devices'));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useSocketEvent('activity:location', () => void load());

  useEffect(() => {
    if (selected === null) { setTrail(null); return; }
    let cancelled = false;
    api.get<{ points: TrailPoint[] }>(`/activity/devices/${selected}/locations?date=${trailDate}`)
      .then((result) => { if (!cancelled) setTrail(result.points); })
      .catch((caught) => { if (!cancelled) { setTrail([]); toast.error(errorMessage(caught)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, trailDate]);

  const devices = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.devices ?? []).filter((device) => {
      if (term && ![device.employee.name, device.employee.code, device.deviceName, device.employee.location ?? ''].some((v) => v.toLowerCase().includes(term))) return false;
      if (filter === 'online') return device.online;
      if (filter === 'at_risk') return ['at_risk', 'threat'].includes(securityState(device.health?.security));
      if (filter === 'located') return Boolean(device.location);
      return true;
    });
  }, [data, search, filter]);

  if (!data) return <Card className="card-pad"><Skeleton lines={6} /></Card>;

  const all = data.devices;
  const online = all.filter((d) => d.online).length;
  const atRisk = all.filter((d) => ['at_risk', 'threat'].includes(securityState(d.health?.security))).length;
  const located = all.filter((d) => d.location).length;
  const current = all.find((d) => d.deviceId === selected) ?? null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Registered devices" value={all.length} icon={<Icon name="monitor" size={18} />} />
        <StatCard label="Online now" value={online} icon={<Icon name="activity" size={18} />} />
        <StatCard label="Security attention" value={atRisk} icon={<Icon name="shield" size={18} />} tone={atRisk > 0 ? 'warning' : 'success'} />
        <StatCard label="Sharing location" value={data.locationTrackingEnabled ? located : 'Off'} icon={<Icon name="globe" size={18} />} />
      </div>

      {!data.locationTrackingEnabled && (
        <p className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-600">
          Device location is switched off. A policy manager can enable it in <strong>Monitoring policy</strong>; employees must re-acknowledge the
          policy before any location is recorded, and it is only captured during an active work session.
        </p>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <SectionHeader title="Live devices" description="Hardware health, Windows Defender status and last known location, refreshed every minute." />
          <div className="flex flex-wrap items-center gap-2">
            <input className="input h-8 w-48 text-sm" placeholder="Search employee or device" value={search} onChange={(e) => setSearch(e.target.value)} />
            {(['all', 'online', 'at_risk', 'located'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${filter === value ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}
                onClick={() => setFilter(value)}
              >
                {{ all: 'All', online: 'Online', at_risk: 'Needs attention', located: 'With location' }[value]}
              </button>
            ))}
          </div>
        </div>

        {devices.length === 0 ? (
          <EmptyState
            title="No devices to show"
            description="Devices appear here once an employee runs the Workforce desktop agent (agent/start-agent.bat) and starts a work session."
          />
        ) : (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {devices.map((device) => {
              const sec = securityState(device.health?.security);
              const diskUsed = device.health?.diskTotalMb && device.health.diskFreeMb != null
                ? Math.round((1 - device.health.diskFreeMb / device.health.diskTotalMb) * 100)
                : null;
              return (
                <button
                  key={device.deviceId}
                  type="button"
                  onClick={() => setSelected(device.deviceId === selected ? null : device.deviceId)}
                  className={`rounded-lg border p-3 text-left transition-colors hover:border-brand-300 ${device.deviceId === selected ? 'border-brand-500 ring-1 ring-brand-500' : 'border-ink-200'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar name={device.employee.name} src={device.employee.photoUrl} size={32} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink-800">{device.employee.name}</p>
                        <p className="truncate text-xs text-ink-500">{device.employee.code} · {device.deviceName}</p>
                      </div>
                    </div>
                    <Badge tone={device.online ? 'success' : 'neutral'}>{device.online ? 'Online' : 'Offline'}</Badge>
                  </div>

                  <div className="mt-2 flex items-center gap-1.5 truncate text-xs text-ink-600">
                    {device.session ? (
                      device.session.status === 'paused' ? (
                        <span>Session paused</span>
                      ) : device.session.isIdle ? (
                        <span className="text-amber-700 font-medium">Idle / away</span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          Using <AppIcon name={device.session.currentApp ?? 'desktop'} size={14} />
                          <strong className="text-ink-800">{device.session.currentApp ?? 'desktop'}</strong>
                        </span>
                      )
                    ) : (
                      <span className="text-ink-400">No active work session</span>
                    )}
                    {device.lastSeenAt ? <span className="text-ink-400">· seen {relativeTime(device.lastSeenAt)}</span> : null}
                  </div>

                  {device.health ? (
                    <div className="mt-3 space-y-2">
                      <ProgressBar value={device.health.cpuPercent ?? 0} tone={tone(device.health.cpuPercent)} label={`CPU ${device.health.cpuPercent ?? '—'}%`} />
                      <ProgressBar value={device.health.memoryPercent ?? 0} tone={tone(device.health.memoryPercent)} label={`Memory ${device.health.memoryPercent ?? '—'}% of ${gb(device.health.memoryTotalMb)}`} />
                      <ProgressBar value={diskUsed ?? 0} tone={tone(diskUsed)} label={`Disk ${gb(device.health.diskFreeMb)} free of ${gb(device.health.diskTotalMb)}`} />
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-ink-400">No health report yet (agent 1.1+ sends one every 5 minutes).</p>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge tone={SECURITY_LABEL[sec].tone}>{SECURITY_LABEL[sec].label}</Badge>
                    {device.health?.networkName && <Badge tone="info">{device.health.networkType === 'wifi' ? 'Wi-Fi: ' : ''}{device.health.networkName}</Badge>}
                    {device.location && <Badge tone="neutral">Location {relativeTime(device.location.recordedAt)}</Badge>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {current && (
        <Card className="card-pad space-y-4">
          <SectionHeader
            title={`${current.employee.name} · ${current.deviceName}`}
            description={`${current.os}${current.agentVersion ? ` · agent ${current.agentVersion}` : ''}${current.employee.location ? ` · ${current.employee.location}` : ''}`}
            action={<button type="button" className="btn-secondary btn-sm" onClick={() => setSelected(null)}>Close</button>}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 text-sm">
              <dl className="grid grid-cols-2 gap-2">
                {[
                  ['Processor', current.health?.cpuModel ? `${current.health.cpuModel} (${current.health.cpuCores} threads)` : '—'],
                  ['Uptime', uptime(current.health?.uptimeMinutes)],
                  ['Network', current.health?.networkName ?? '—'],
                  ['Last health report', current.health ? formatDateTime(current.health.reportedAt) : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md bg-ink-50 p-2">
                    <dt className="text-xs text-ink-500">{label}</dt>
                    <dd className="truncate font-medium text-ink-800" title={value}>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="rounded-md border border-ink-200 p-3">
                <p className="text-sm font-semibold text-ink-800">Device security (Windows Defender)</p>
                {current.health?.security ? (
                  <ul className="mt-2 space-y-1 text-xs text-ink-600">
                    <li>Antivirus: <strong>{current.health.security.antivirusEnabled ? 'On' : 'Off'}</strong></li>
                    <li>Real-time protection: <strong>{current.health.security.realTimeProtection ? 'On' : 'Off'}</strong></li>
                    <li>Firewall: <strong>{current.health.security.firewallEnabled === null ? 'Unknown' : current.health.security.firewallEnabled ? 'On (all profiles)' : 'Off on at least one profile'}</strong></li>
                    <li>Virus definitions: <strong>{current.health.security.signatureAgeDays === null ? 'Unknown' : current.health.security.signatureAgeDays === 0 ? 'Up to date' : `${current.health.security.signatureAgeDays} day(s) old`}</strong></li>
                    <li>Threats in the last 7 days: <strong>{current.health.security.recentThreats ?? 0}</strong>
                      {current.health.security.threatNames.length > 0 && <span className="text-red-700"> ({current.health.security.threatNames.join(', ')})</span>}
                    </li>
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-ink-400">Not reported yet. Defender status is read every 30 minutes.</p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink-800">Location</p>
                <input type="date" className="input h-8 w-40 text-sm" value={trailDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setTrailDate(e.target.value)} />
              </div>
              {current.location ? (
                <>
                  <MapEmbed latitude={current.location.latitude} longitude={current.location.longitude} accuracyM={current.location.accuracyM} title={`Location of ${current.employee.name}`} />
                  <p className="text-xs text-ink-500">
                    Last fix {formatDateTime(current.location.recordedAt)} · accuracy ±{current.location.accuracyM ?? '?'} m
                    {current.location.networkName ? ` · ${current.location.networkName}` : ''} ·{' '}
                    <a className="text-brand-700 hover:underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${current.location.latitude}&mlon=${current.location.longitude}#map=16/${current.location.latitude}/${current.location.longitude}`}>Open map</a>
                  </p>
                </>
              ) : (
                <p className="rounded-md bg-ink-50 p-3 text-xs text-ink-500">
                  {data.locationTrackingEnabled ? 'No location received yet. Windows location services must be on for this device.' : 'Location tracking is switched off in the monitoring policy.'}
                </p>
              )}
              {trail && trail.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-ink-100">
                  <table className="table-base text-xs">
                    <thead><tr><th>Time</th><th>Position</th><th>Accuracy</th><th>Network</th></tr></thead>
                    <tbody>
                      {trail.slice().reverse().map((point) => (
                        <tr key={point.recordedAt}>
                          <td>{formatDateTime(point.recordedAt)}</td>
                          <td className="font-mono">{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</td>
                          <td>±{point.accuracyM ?? '?'} m</td>
                          <td>{point.networkName ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {trail && trail.length === 0 && data.locationTrackingEnabled && <p className="text-xs text-ink-400">No positions recorded on this date.</p>}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
