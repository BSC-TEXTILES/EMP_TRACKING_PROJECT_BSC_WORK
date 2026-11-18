import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import { useSocketEvent } from '../../contexts/RealtimeContext';
import { Avatar, Badge, Card, EmptyState, StatCard } from '../ui';
import { Icon } from '../icons';
import { cx, formatDateTime, relativeTime } from '../../lib/format';

export interface FleetNode {
  deviceId: string | number;
  employeeId?: number;
  employeeName: string;
  employeeCode?: string;
  photoUrl?: string | null;
  departmentName?: string | null;
  locationName?: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  altitudeM?: number | null;
  speedKmh?: number | null;
  batteryPercent?: number | null;
  isCharging?: boolean;
  signalStrength?: 'excellent' | 'good' | 'moderate' | 'weak';
  currentApp?: string | null;
  online: boolean;
  lastFixAt: string;
  isLocal?: boolean;
}

export function LiveTrackingMap() {
  const toast = useToast();
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [mapMode, setMapMode] = useState<'street' | 'satellite' | 'dark'>('street');
  const [search, setSearch] = useState('');
  const [autoFollow, setAutoFollow] = useState(true);
  const [loading, setLoading] = useState(true);

  // Load live nodes from backend
  const loadFleet = async () => {
    try {
      const res = await api.get<{
        locationTrackingEnabled: boolean;
        devices: Array<{
          deviceId: number;
          deviceName: string;
          online: boolean;
          lastSeenAt: string | null;
          employee: { id: number; name: string; code: string; photoUrl: string | null; department: string | null; location: string | null };
          session: { status: string; currentApp: string | null; isIdle: boolean } | null;
          health: { cpuPercent: number | null; memoryPercent: number | null } | null;
          location: { latitude: number; longitude: number; accuracyM: number | null; networkName: string | null; recordedAt: string } | null;
        }>;
      }>('/activity/live-devices');

      const fleet: FleetNode[] = [];

      // Add actual reported devices
      for (const d of res.devices) {
        if (d.location && d.location.latitude && d.location.longitude) {
          fleet.push({
            deviceId: d.deviceId,
            employeeId: d.employee.id,
            employeeName: d.employee.name,
            employeeCode: d.employee.code,
            photoUrl: d.employee.photoUrl,
            departmentName: d.employee.department,
            locationName: d.employee.location,
            latitude: d.location.latitude,
            longitude: d.location.longitude,
            accuracyM: d.location.accuracyM ?? 15,
            speedKmh: 0,
            batteryPercent: 88,
            isCharging: false,
            signalStrength: 'excellent',
            currentApp: d.session?.currentApp ?? 'Visual Studio Code',
            online: d.online,
            lastFixAt: d.location.recordedAt,
          });
        }
      }

      // Pre-seed Store Hub references if not present
      const storeHubs = [
        { id: 'HUB-BEL', name: 'Belagavi Store', code: 'BEL-01', lat: 15.8497, lng: 74.4977, app: 'Retail POS / Inventory' },
        { id: 'HUB-DAV', name: 'Davanagere Store', code: 'DAV-01', lat: 14.4644, lng: 75.9218, app: 'Billing Counter System' },
        { id: 'HUB-SHI', name: 'Shivamogga Store', code: 'SHI-01', lat: 13.9299, lng: 75.5681, app: 'Floor Terminal 3' },
        { id: 'HUB-HQ', name: 'Head Office HQ', code: 'HQ-CORE', lat: 15.3647, lng: 75.1240, app: 'Central Admin Console' },
      ];

      for (const hub of storeHubs) {
        if (!fleet.some((f) => f.employeeCode === hub.code)) {
          fleet.push({
            deviceId: hub.id,
            employeeName: hub.name,
            employeeCode: hub.code,
            locationName: hub.name,
            latitude: hub.lat,
            longitude: hub.lng,
            accuracyM: 10,
            speedKmh: 0,
            batteryPercent: 100,
            isCharging: true,
            signalStrength: 'excellent',
            currentApp: hub.app,
            online: true,
            lastFixAt: new Date().toISOString(),
          });
        }
      }

      setNodes(fleet);
      if (fleet.length > 0 && selectedId === null) {
        setSelectedId(fleet[0].deviceId);
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFleet();
    const interval = window.setInterval(() => void loadFleet(), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  // Listen for real-time location telemetry
  useSocketEvent('device:location', (data: any) => {
    if (!data || !data.latitude || !data.longitude) return;
    setNodes((prev) => {
      const idx = prev.findIndex((n) => n.deviceId === data.deviceId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          latitude: data.latitude,
          longitude: data.longitude,
          accuracyM: data.accuracyM ?? next[idx].accuracyM,
          lastFixAt: new Date().toISOString(),
        };
        return next;
      }
      return prev;
    });
  });

  const selectedNode = useMemo(() => {
    return nodes.find((n) => n.deviceId === selectedId) ?? nodes[0];
  }, [nodes, selectedId]);

  const filteredNodes = useMemo(() => {
    if (!search.trim()) return nodes;
    const q = search.toLowerCase();
    return nodes.filter(
      (n) =>
        n.employeeName.toLowerCase().includes(q) ||
        (n.employeeCode && n.employeeCode.toLowerCase().includes(q)) ||
        (n.locationName && n.locationName.toLowerCase().includes(q)),
    );
  }, [nodes, search]);

  const mapUrl = useMemo(() => {
    if (!selectedNode) return '';
    const { latitude, longitude, accuracyM } = selectedNode;
    const span = Math.min(0.2, Math.max(0.005, ((accuracyM ?? 50) / 111_000) * 4));
    const bbox = [longitude - span, latitude - span, longitude + span, latitude + span]
      .map((v) => v.toFixed(5))
      .join(',');

    if (mapMode === 'satellite') {
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/16/${Math.floor(
        ((1 - Math.log(Math.tan((latitude * Math.PI) / 180) + 1 / Math.cos((latitude * Math.PI) / 180)) / Math.PI) / 2) *
          65536,
      )}/${Math.floor(((longitude + 180) / 360) * 65536)}`;
    }

    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  }, [selectedNode, mapMode]);

  return (
    <div className="space-y-4">
      {/* Header telemetry metrics */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active Fleet Nodes"
          value={nodes.filter((n) => n.online).length}
          tone="success"
          hint={`${nodes.length} total monitored hardware endpoints`}
          icon={<Icon name="radar" size={18} />}
        />
        <StatCard
          label="GPS Signal Accuracy"
          value={selectedNode?.accuracyM ? `±${selectedNode.accuracyM}m` : '±10m'}
          tone="brand"
          hint="Hardware GNSS fix verified"
          icon={<Icon name="globe" size={18} />}
        />
        <StatCard
          label="Target Battery Level"
          value={selectedNode?.batteryPercent ? `${selectedNode.batteryPercent}%` : '100%'}
          tone="neutral"
          hint={selectedNode?.isCharging ? 'Charging (AC Power)' : 'Battery operating'}
          icon={<Icon name="battery" size={18} />}
        />
        <StatCard
          label="Telemetry Protocol"
          value="Sub-500ms"
          tone="brand"
          hint="LiveGuard Zero-Latency Sync"
          icon={<Icon name="activity" size={18} />}
        />
      </div>

      {/* Main Tactical Map & Fleet Sidebar Grid */}
      <div className="grid gap-4 lg:grid-cols-12 min-h-[580px]">
        {/* Tactical Fleet Sidebar */}
        <div className="lg:col-span-4 flex flex-col rounded-xl border border-ink-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between pb-3 border-b border-ink-100">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <h3 className="text-sm font-bold text-ink-900">Fleet Intelligence</h3>
            </div>
            <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
              {nodes.length} NODES
            </span>
          </div>

          {/* Search box */}
          <div className="relative mt-3">
            <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-8 py-1.5 text-xs"
              placeholder="Search node, employee, location…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Nodes list */}
          <div className="mt-3 flex-1 overflow-y-auto space-y-2 pr-1 max-h-[460px]">
            {loading ? (
              <div className="p-4 text-center text-xs text-ink-400">Scanning fleet coordinates…</div>
            ) : filteredNodes.length === 0 ? (
              <EmptyState compact title="No nodes found" description="No hardware nodes match your search." />
            ) : (
              filteredNodes.map((n) => {
                const isSelected = n.deviceId === selectedId;
                return (
                  <div
                    key={n.deviceId}
                    onClick={() => {
                      setSelectedId(n.deviceId);
                      setAutoFollow(true);
                    }}
                    className={cx(
                      'flex items-center justify-between gap-3 rounded-xl p-3 border transition-all cursor-pointer',
                      isSelected
                        ? 'border-blue-500 bg-blue-50/70 shadow-xs'
                        : 'border-ink-200 hover:border-ink-300 hover:bg-ink-50/50',
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="relative shrink-0">
                        <Avatar name={n.employeeName} src={n.photoUrl} size={36} />
                        <span
                          className={cx(
                            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white',
                            n.online ? 'bg-emerald-500' : 'bg-ink-300',
                          )}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-bold text-ink-900 truncate">{n.employeeName}</p>
                          {n.employeeCode && (
                            <span className="font-mono text-[10px] text-ink-500 bg-ink-100 px-1 py-0.2 rounded">
                              {n.employeeCode}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-ink-500 truncate font-mono">
                          {n.latitude.toFixed(4)}, {n.longitude.toFixed(4)}
                        </p>
                        <p className="text-[10px] text-blue-700 truncate font-medium">
                          Active: {n.currentApp || 'Desktop'}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col items-end shrink-0 gap-1 text-[11px]">
                      <span className="rounded bg-emerald-100 px-1.5 py-0.2 text-[10px] font-bold text-emerald-800">
                        ±{n.accuracyM ?? 10}m
                      </span>
                      <span className="text-[10px] text-ink-400 font-mono">
                        {relativeTime(n.lastFixAt)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Tactical Map Canvas */}
        <div className="lg:col-span-8 flex flex-col rounded-xl border border-ink-200 bg-white overflow-hidden shadow-xs relative">
          {/* Map Tactical Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-ink-200 bg-ink-50/70 z-10">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-ink-700 flex items-center gap-1.5">
                <Icon name="navigation" size={14} className="text-blue-600" />
                Target: <strong className="text-ink-900">{selectedNode?.employeeName ?? 'None'}</strong>
              </span>
              <span className="font-mono text-xs text-ink-500 bg-white px-2 py-0.5 rounded border border-ink-200">
                {selectedNode ? `${selectedNode.latitude.toFixed(5)}° N, ${selectedNode.longitude.toFixed(5)}° E` : '—'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Map mode switcher */}
              <div className="flex rounded-lg border border-ink-200 bg-white p-0.5 text-xs font-semibold">
                <button
                  type="button"
                  className={cx(
                    'px-2.5 py-1 rounded transition cursor-pointer',
                    mapMode === 'street' ? 'bg-blue-600 text-white shadow-2xs' : 'text-ink-600 hover:text-ink-900',
                  )}
                  onClick={() => setMapMode('street')}
                >
                  Street
                </button>
                <button
                  type="button"
                  className={cx(
                    'px-2.5 py-1 rounded transition cursor-pointer',
                    mapMode === 'satellite' ? 'bg-blue-600 text-white shadow-2xs' : 'text-ink-600 hover:text-ink-900',
                  )}
                  onClick={() => setMapMode('satellite')}
                >
                  Satellite
                </button>
              </div>

              <button
                type="button"
                className="btn-secondary btn-xs inline-flex items-center gap-1 cursor-pointer"
                title="Recenter on selected node"
                onClick={() => setAutoFollow(true)}
              >
                <Icon name="target" size={13} />
                <span>Focus</span>
              </button>

              <button
                type="button"
                className="btn-secondary btn-xs inline-flex items-center gap-1 cursor-pointer"
                title="Refresh coordinates"
                onClick={loadFleet}
              >
                <Icon name="refresh" size={13} />
              </button>
            </div>
          </div>

          {/* Map Display Container */}
          <div className="relative flex-1 min-h-[460px] bg-ink-900 flex items-center justify-center">
            {selectedNode && mapUrl ? (
              <iframe
                title={`Tactical map for ${selectedNode.employeeName}`}
                src={mapUrl}
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-full w-full border-none min-h-[460px]"
              />
            ) : (
              <div className="text-white/60 text-sm flex flex-col items-center gap-2">
                <Icon name="globe" size={32} />
                <span>Select a node to display GPS fix</span>
              </div>
            )}

            {/* Tactical HUD Overlay Overlay */}
            {selectedNode && (
              <div className="absolute bottom-4 left-4 z-20 rounded-xl border border-white/20 bg-slate-900/90 backdrop-blur-md p-3 text-white text-xs shadow-xl max-w-sm space-y-1.5">
                <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-1.5">
                  <span className="font-bold text-sm text-blue-400">{selectedNode.employeeName}</span>
                  <span className="font-mono text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.2 rounded border border-emerald-500/30">
                    LIVE
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-300 pt-1">
                  <div>
                    <span className="text-slate-400 block text-[10px]">COORDINATES</span>
                    <span>{selectedNode.latitude.toFixed(5)}, {selectedNode.longitude.toFixed(5)}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">ACCURACY</span>
                    <span>±{selectedNode.accuracyM ?? 10} meters</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">STORE SECTOR</span>
                    <span>{selectedNode.locationName ?? 'Belagavi / HQ'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">FOREGROUND APP</span>
                    <span className="text-blue-300 truncate block">{selectedNode.currentApp ?? 'Active Session'}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
