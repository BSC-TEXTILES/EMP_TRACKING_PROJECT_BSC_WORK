// Types and formatting for User Activity Tracking. All times are stored in UTC by
// the server and always displayed in Asia/Kolkata (IST), whatever the viewer's
// device timezone is.

export type LiveStatus = 'active' | 'idle' | 'locked' | 'offline' | 'not_installed' | 'disabled';

export interface OverviewItem {
  id: number;
  employeeCode: string;
  fullName: string;
  photoUrl: string | null;
  designation: string | null;
  department: string | null;
  locationId: number | null;
  locationCode: string | null;
  locationName: string | null;
  device: { id: number; name: string; os: string; agentVersion: string | null; online: boolean } | null;
  deviceCount: number;
  loginAt: string | null;
  hrmsLoginAt: string | null;
  logoutAt: string | null;
  activeSeconds: number;
  idleSeconds: number;
  lockedSeconds: number;
  hasData: boolean;
  lastActivityAt: string | null;
  status: LiveStatus;
  currentApp: string | null;
  currentDomain: string | null;
  lastHeartbeatAt: string | null;
  syncError: string | null;
  trackingEnabled: boolean;
}

export interface OverviewResponse {
  date: string;
  today: string;
  serverTime: string;
  counts: Record<'all' | 'active' | 'idle' | 'locked' | 'offline' | 'not_installed' | 'sync_error' | 'disabled', number>;
  locations: { id: number; code: string; name: string; count: number }[];
  totals: { activeSeconds: number; idleSeconds: number };
  items: OverviewItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface DeviceInfo {
  deviceId: number;
  employeeId: number;
  deviceName: string;
  hostname: string | null;
  osName: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  agentState: string | null;
  activityState: string | null;
  currentApp: string | null;
  currentDomain: string | null;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
  lastEventAt: string | null;
  pendingEvents: number;
  droppedEvents: number;
  agentSyncFailures: number;
  connectionFailures: number;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  noticeAcknowledgedAt: string | null;
  extensionSeenAt: string | null;
  enrolledAt: string | null;
  clockSkewMs: number;
  online: boolean;
  syncError: string | null;
}

export interface DetailsResponse {
  date: string;
  today: string;
  serverTime: string;
  employee: {
    id: number; employeeCode: string; fullName: string; photoUrl: string | null; designation: string | null;
    department: string | null; manager: string | null; locationCode: string | null; locationName: string | null;
  };
  tracking: {
    status: LiveStatus; enabled: boolean; appTracking: boolean; websiteTracking: boolean; idleThresholdSeconds: number;
    latestAgentVersion: string; currentApp: string | null; currentDomain: string | null;
  };
  devices: (DeviceInfo & { registrationStatus: string; registeredAt: string | null; revokedAt: string | null; revokedReason: string | null; outdated: boolean })[];
  summary: {
    hasData: boolean; firstLoginAt: string | null; lastLogoutAt: string | null; stillSignedIn: boolean; sessionSeconds: number;
    activeSeconds: number; idleSeconds: number; lockedSeconds: number; sessionCount: number;
    longestActive: { start: string; end: string; seconds: number } | null;
    longestIdle: { start: string; end: string; seconds: number } | null;
    observedSpanSeconds: number; trackedSeconds: number; offlineSeconds: number; completenessPercent: number | null; idleThresholdSeconds: number;
  };
  applications: { app: string; activeSeconds: number; idleSeconds: number; firstUsedAt: string; lastUsedAt: string }[];
  websites: { browser: string; domain: string; activeSeconds: number; visits: number; firstVisitedAt: string; lastVisitedAt: string }[];
  sessions: { id: number; device: string; startedAt: string | null; endedAt: string | null; lastSeenAt: string | null; seconds: number; endReason: string | null; open: boolean }[];
  gaps: { start: string; end: string; seconds: number; reason: string }[];
  timeline: { at: string; type: string; title: string; detail: string | null; seconds?: number; source: string }[];
  timelineTruncated: boolean;
}

export const IST = 'Asia/Kolkata';
const time = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
const timeSeconds = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
const dateTime = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const dateOnly = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

const valid = (value?: string | null) => (value ? !Number.isNaN(new Date(value).getTime()) : false);
export const istTime = (value?: string | null) => (valid(value) ? time.format(new Date(value!)).toUpperCase() : '—');
export const istTimeSeconds = (value?: string | null) => (valid(value) ? timeSeconds.format(new Date(value!)).toUpperCase() : '—');
export const istDateTime = (value?: string | null) => (valid(value) ? dateTime.format(new Date(value!)).replace(/am|pm/, (m) => m.toUpperCase()) : '—');
export const istDateLabel = (date: string) => dateOnly.format(new Date(`${date}T12:00:00+05:30`));

/** Today's business date in IST (YYYY-MM-DD). */
export function istToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}

export function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function duration(seconds?: number | null): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 60) return s === 0 ? '0m' : `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function ago(value?: string | null): string {
  if (!valid(value)) return '';
  const diff = Date.now() - new Date(value!).getTime();
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return `${Math.round(diff / 86_400_000)} d ago`;
}

export const STATUS_META: Record<LiveStatus, { label: string; tone: string; dot: string; description: string }> = {
  active: { label: 'Active', tone: 'success', dot: 'bg-emerald-500', description: 'Agent connected and the employee is using the computer' },
  idle: { label: 'Idle', tone: 'warning', dot: 'bg-amber-500', description: 'Agent connected; no keyboard or mouse input beyond the idle threshold' },
  locked: { label: 'Locked', tone: 'neutral', dot: 'bg-slate-500', description: 'Agent connected; the computer is locked' },
  offline: { label: 'Offline', tone: 'danger', dot: 'bg-red-500', description: 'No heartbeat from the agent recently (computer off, asleep, offline or agent stopped)' },
  not_installed: { label: 'Agent not installed', tone: 'neutral', dot: 'bg-ink-300', description: 'No tracking device is registered for this employee' },
  disabled: { label: 'Tracking disabled', tone: 'neutral', dot: 'bg-ink-400', description: 'Tracking is switched off by policy for this location' },
};
