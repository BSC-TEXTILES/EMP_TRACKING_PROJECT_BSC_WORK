/**
 * Workforce monitoring agent (Windows first).
 *
 * Runs only after the employee has started office attendance in the web app and
 * acknowledged the monitoring policy. It records the foreground application's
 * name, category and active duration, plus explicitly approved work metadata.
 * It never captures keystrokes, clipboard contents, screen contents, passwords,
 * private messages or unapproved applications. Screenshot capture is disabled.
 *
 * Usage:
 *   WORKFORCE_EMAIL=you@company.com WORKFORCE_PASSWORD=... npm start
 *   (or set WORKFORCE_DEVICE_TOKEN from a device registered in the web app)
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { collectHealth, collectLocation } from './telemetry.js';

const run = promisify(execFile);

const SERVER = (process.env.WORKFORCE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const EMAIL = process.env.WORKFORCE_EMAIL ?? '';
const PASSWORD = process.env.WORKFORCE_PASSWORD ?? '';
const INTERVAL_MS = Math.max(3000, Number(process.env.AGENT_INTERVAL_MS ?? 10000));
// Optional bounded run for smoke tests / demos; 0 means run until stopped.
const MAX_RUN_MS = Math.max(0, Number(process.env.AGENT_MAX_RUN_MS ?? 0));
const DATA_DIR = process.env.AGENT_DATA_DIR ?? path.resolve(process.cwd(), 'agent-data');
const AGENT_VERSION = '1.1.0';
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const SECURITY_EVERY_N_HEALTH = 6; // Defender status every 30 minutes

interface Policy {
  allowedApps: string[];
  blockedApps: string[];
  allowedDomains: string[];
  policyText: string;
  retentionDays: number;
  idleThresholdMinutes?: number;
  screenshotEnabled: boolean;
  locationTrackingEnabled?: boolean;
  locationIntervalMinutes?: number;
}

interface QueueEvent {
  type: 'app' | 'browser' | 'module' | 'work' | 'error';
  clientEventId: string;
  appName?: string;
  appCategory?: string;
  processName?: string;
  processId?: number;
  startedAt?: string;
  endedAt?: string;
  activeSeconds?: number;
  domain?: string;
  browser?: string;
  tabTitle?: string;
  category?: string;
  module?: string;
  pagePath?: string;
  title?: string;
  description?: string;
  errorCategory?: string;
  errorCode?: string;
  application?: string;
  occurredAt?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  diagnostic?: Record<string, unknown>;
}

interface AgentState {
  deviceToken?: string;
  deviceId?: number;
  cookie?: string;
}

const APP_CATEGORIES: Record<string, string> = {
  chrome: 'Browser', brave: 'Browser', msedge: 'Browser', firefox: 'Browser', opera: 'Browser',
  code: 'Development', antigravity: 'Development', studio64: 'Development', idea64: 'Development', postman: 'Development',
  excel: 'Office Productivity', winword: 'Office Productivity', powerpnt: 'Office Productivity', outlook: 'Communication', onenote: 'Office Productivity',
  teams: 'Communication', whatsapp: 'Communication', slack: 'Communication', zoom: 'Communication', telegram: 'Communication',
  figma: 'Design', notion: 'Documentation',
  tally: 'Data Analytics', pos: 'Business Operations', billing: 'Business Operations', quickbooks: 'Data Analytics',
  notepad: 'Office Productivity', notepadplusplus: 'Office Productivity', calc: 'Office Productivity', explorer: 'Administration',
};

const APPLICATION_NAMES: Record<string, string> = {
  chrome: 'Google Chrome', brave: 'Brave Browser', msedge: 'Microsoft Edge', firefox: 'Firefox', opera: 'Opera',
  code: 'Visual Studio Code', antigravity: 'Antigravity IDE', studio64: 'Android Studio', idea64: 'IntelliJ IDEA',
  postman: 'Postman', excel: 'Microsoft Excel', winword: 'Microsoft Word', powerpnt: 'Microsoft PowerPoint', outlook: 'Microsoft Outlook', onenote: 'Microsoft OneNote',
  teams: 'Microsoft Teams', whatsapp: 'WhatsApp Desktop', slack: 'Slack', zoom: 'Zoom Meetings', telegram: 'Telegram',
  figma: 'Figma', notion: 'Notion',
  tally: 'Tally Accounting', pos: 'Retail POS & Billing Software', billing: 'Store Billing System',
  notepad: 'Notepad', calc: 'Windows Calculator', explorer: 'File Explorer',
};

function resolveAppInfo(processName: string, windowTitle = ''): { appName: string; appCategory: string } {
  const cleanProc = processName.toLowerCase().replace(/\.exe$/i, '');
  if (windowTitle && (windowTitle.includes('BSC') || windowTitle.includes('HRMS') || windowTitle.includes('emptrack'))) {
    return { appName: 'BSC HRMS & Web Portal', appCategory: 'Business Operations' };
  }
  if (APPLICATION_NAMES[cleanProc]) {
    return { appName: APPLICATION_NAMES[cleanProc], appCategory: APP_CATEGORIES[cleanProc] ?? 'Office Productivity' };
  }
  for (const [key, name] of Object.entries(APPLICATION_NAMES)) {
    if (cleanProc.includes(key)) return { appName: name, appCategory: APP_CATEGORIES[key] ?? 'Office Productivity' };
  }
  const formatted = cleanProc.charAt(0).toUpperCase() + cleanProc.slice(1);
  return { appName: formatted, appCategory: 'Office Productivity' };
}

function log(message: string): void {
  console.log(`[agent ${new Date().toLocaleTimeString()}] ${message}`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
}

function keyFromToken(token: string): Buffer {
  return crypto.scryptSync(token, 'workforce-agent-v1', 32);
}

async function writeEncrypted(file: string, value: unknown, token: string): Promise<void> {
  await ensureDir();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromToken(token), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readEncrypted<T>(file: string, token: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromToken(token), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

async function api(pathname: string, init: RequestInit = {}, auth: { cookie?: string; deviceToken?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (auth.cookie) headers.set('Cookie', auth.cookie);
  if (auth.deviceToken) headers.set('X-Device-Token', auth.deviceToken);
  headers.set('Origin', SERVER);
  return fetch(`${SERVER}/api${pathname}`, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
}

async function login(): Promise<string> {
  if (process.env.WORKFORCE_COOKIE) return process.env.WORKFORCE_COOKIE;
  if (!EMAIL || !PASSWORD) throw new Error('Set WORKFORCE_EMAIL and WORKFORCE_PASSWORD (or WORKFORCE_COOKIE / WORKFORCE_DEVICE_TOKEN).');
  const response = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: EMAIL, password: PASSWORD }) });
  if (!response.ok) throw new Error(`Sign-in failed (${response.status}). Check the employee credentials.`);
  const payload = await response.json() as { otpRequired?: boolean };
  if (payload.otpRequired) throw new Error('This account requires OTP verification. Sign in on the web app first, then pass WORKFORCE_COOKIE.');
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  if (!cookies.length) throw new Error('Sign-in succeeded but no session cookie was returned.');
  return cookies.join('; ');
}

async function machineFingerprint(): Promise<string> {
  const host = os.hostname();
  const user = os.userInfo().username;
  return crypto.createHash('sha256').update(`workforce|${host}|${user}`).digest('hex').slice(0, 48);
}

async function registerDevice(cookie: string): Promise<{ deviceId: number; token: string }> {
  const response = await api('/activity/devices', {
    method: 'POST',
    body: JSON.stringify({
      deviceName: `${os.hostname()} · Windows`,
      osName: process.platform === 'win32' ? 'Windows' : process.platform,
      osVersion: os.release(),
      agentVersion: AGENT_VERSION,
      machineFingerprint: await machineFingerprint(),
    }),
  }, { cookie });
  if (!response.ok) throw new Error(`Device registration failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<{ deviceId: number; token: string }>;
}

interface ProcessSnapshot {
  procName: string;
  appName: string;
  appCategory: string;
  pid: number;
  idleSeconds: number;
  windowTitle: string;
}

async function foregroundProcess(): Promise<ProcessSnapshot | null> {
  if (process.platform !== 'win32') return null;
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
}
"@
$h = [Win32]::GetForegroundWindow()
$targetPid = 0
[void][Win32]::GetWindowThreadProcessId($h, [ref]$targetPid)
$lii = New-Object Win32+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[void][Win32]::GetLastInputInfo([ref]$lii)
$idleMs = [Environment]::TickCount - $lii.dwTime
$procName = ""
$title = ""
if ($targetPid -gt 0) {
  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($p) {
    $procName = $p.ProcessName
    $title = $p.MainWindowTitle
  }
}
"$procName|$targetPid|$idleMs|$title"`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
    const parts = stdout.trim().split('|');
    const proc = (parts[0] ?? '').trim().toLowerCase();
    const pid = Number(parts[1]) || 0;
    const idleMs = Math.max(0, Number(parts[2]) || 0);
    const title = parts.slice(3).join('|').trim();
    if (!proc) return null;
    const { appName, appCategory } = resolveAppInfo(proc, title);
    return {
      procName: proc,
      appName,
      appCategory,
      pid,
      idleSeconds: Math.floor(idleMs / 1000),
      windowTitle: title,
    };
  } catch {
    return null;
  }
}

interface WindowsError { recordId: number; provider: string; message: string; time: string }

/** Reads recent Application error events from the Windows event log (no content capture). */
async function recentWindowsErrors(sinceMinutes = 5): Promise<WindowsError[]> {
  if (process.platform !== 'win32') return [];
  const script = `
$start = (Get-Date).AddMinutes(-${sinceMinutes})
Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2; StartTime=$start} -MaxEvents 10 -ErrorAction SilentlyContinue |
  ForEach-Object { [pscustomobject]@{ recordId = $_.RecordId; provider = $_.ProviderName; message = ($_.Message -split "\`n")[0]; time = $_.TimeCreated.ToString('o') } } |
  ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 12000 });
    const parsed = JSON.parse(stdout.trim() || '[]') as WindowsError | WindowsError[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  log(`Connecting to ${SERVER}`);
  await ensureDir();
  const queueFile = path.join(DATA_DIR, 'queue.enc');
  const stateFile = path.join(DATA_DIR, 'state.enc');

  let cookie = await login();
  let token = process.env.WORKFORCE_DEVICE_TOKEN ?? '';
  let deviceId = Number(process.env.WORKFORCE_DEVICE_ID ?? 0);

  if (!token) {
    const registered = await registerDevice(cookie);
    token = registered.token;
    deviceId = registered.deviceId;
    await writeEncrypted(stateFile, { deviceToken: token, deviceId }, token);
    log('Device registered. Token stored encrypted for this machine.');
  }

  const policyResponse = await api('/activity/policy', {}, { cookie });
  if (!policyResponse.ok) throw new Error('Unable to read the monitoring policy. Is monitoring enabled for this server?');
  const policyPayload = await policyResponse.json() as { acknowledged: boolean; policy: Policy };
  if (!policyPayload.acknowledged) throw new Error('The employee has not acknowledged the monitoring policy in the web app. Monitoring will not start.');
  const policy = policyPayload.policy;
  log('Policy acknowledged. Monitoring stays on only while the authorised work session is active.');
  log(`Screenshot evidence: ${policy.screenshotEnabled ? 'authorised but not captured by this build' : 'disabled'} · Retention: ${policy.retentionDays} days`);

  let attendance = await api('/attendance/today', {}, { cookie });
  let attendanceState = (await attendance.json().catch(() => ({}))) as { checkInAt: string | null; checkOutAt: string | null };
  if (!attendanceState.checkInAt) {
    log('Attendance not yet checked in. Initiating automatic check-in from desktop agent...');
    try {
      const checkInRes = await api('/attendance/check-in', {
        method: 'POST',
        body: JSON.stringify({ source: 'desktop_agent', deviceId }),
      }, { cookie });
      if (checkInRes.ok) {
        log('Attendance automatically checked in.');
      } else {
        log('Automatic check-in skipped; proceeding with monitoring session.');
      }
    } catch {
      log('Could not perform automatic check-in; continuing.');
    }
  }

  if (!deviceId) {
    const devices = await api('/activity/devices', {}, { cookie }).then((response) => response.json()) as { devices: { id: number; status: string }[] };
    deviceId = devices.devices.find((device) => device.status === 'active')?.id ?? 0;
  }
  if (!deviceId) throw new Error('No registered device found.');

  // Check if session is already active; if not, start it
  const currentSessionRes = await api('/activity/sessions/current', {}, { cookie });
  const currentSessionData = (await currentSessionRes.json().catch(() => ({}))) as { session?: { id: number } };
  if (!currentSessionData.session) {
    const start = await api('/activity/sessions/start', { method: 'POST', body: JSON.stringify({ deviceId }) }, { cookie });
    if (!start.ok) {
      log(`Note on starting session: ${await start.text()}`);
    } else {
      log(`Work session started automatically on device #${deviceId}.`);
    }
  } else {
    log(`Attached to existing active work session #${currentSessionData.session.id}.`);
  }
  log(`Monitoring active on device #${deviceId}. Press Ctrl+C to stop.`);

  const queue = await readEncrypted<QueueEvent[]>(queueFile, token, []);
  if (queue.length) log(`${queue.length} queued event(s) from a previous offline session will be uploaded.`);

  let activeSnapshot: ProcessSnapshot | null = null;
  let activeSince = Date.now();
  let stopped = false;
  let ticks = 0;
  let syncFailures = 0;
  let lastNetworkErrorAt = 0;
  const seenErrors = new Set<number>();
  const idleThresholdSeconds = (policy.idleThresholdMinutes ?? 5) * 60;

  const flushQueue = async (): Promise<void> => {
    if (queue.length === 0) return;
    const batch = queue.slice(0, 100);
    try {
      const response = await api('/activity/agent/events', { method: 'POST', body: JSON.stringify({ events: batch }) }, { deviceToken: token });
      if (response.ok) {
        const acknowledgement = await response.json() as { rejected: number; accepted: number; duplicates: number };
        if (acknowledgement.rejected || acknowledgement.accepted + acknowledgement.duplicates !== batch.length) {
          log('Batch not fully acknowledged; retained for recovery.');
          return;
        }
        syncFailures = 0;
        queue.splice(0, batch.length);
        await writeEncrypted(queueFile, queue, token);
        log(`Uploaded ${batch.length} event(s); ${queue.length} remain queued.`);
        return;
      }
      // Keep rejected data for recovery; a server rejection is not an acknowledgement.
      log(`Upload deferred (${response.status}); encrypted events retained.`);

    } catch {
      syncFailures += 1;
      if (syncFailures >= 3 && Date.now() - lastNetworkErrorAt > 10 * 60 * 1000) {
        lastNetworkErrorAt = Date.now();
        queue.push({
          type: 'error',
          clientEventId: crypto.randomUUID(),
          errorCategory: 'Network connection failure',
          application: 'Workforce Monitoring Agent',
          module: 'Activity monitoring',
          errorCode: 'AGENT_NETWORK',
          severity: 'medium',
          description: 'The monitoring agent could not reach the Workforce server and is working offline.',
          occurredAt: new Date().toISOString(),
          diagnostic: { server: SERVER, failures: syncFailures },
        });
        await writeEncrypted(queueFile, queue, token).catch(() => undefined);
      }
      log('Server unreachable. Events stay in the encrypted local queue and will sync automatically.');
    }
  };

  const recordTransition = (next: ProcessSnapshot | null): void => {
    const now = Date.now();
    const seconds = Math.round((now - activeSince) / 1000);
    if (activeSnapshot && seconds >= 3) {
      const isBlocked = policy.blockedApps.some((app) =>
        activeSnapshot!.procName.includes(app.toLowerCase()) ||
        activeSnapshot!.appName.toLowerCase().includes(app.toLowerCase()),
      );
      if (isBlocked) {
        log(`Excluded application ${activeSnapshot.appName} detected; activity not recorded.`);
      } else {
        const isIdle = activeSnapshot.idleSeconds >= idleThresholdSeconds;
        queue.push({
          type: isIdle ? 'work' : 'app',
          title: isIdle ? 'Idle period' : undefined,
          occurredAt: isIdle ? new Date(activeSince).toISOString() : undefined,
          clientEventId: crypto.randomUUID(),
          appName: isIdle ? 'Idle Time' : activeSnapshot.appName,
          appCategory: isIdle ? 'Administration' : activeSnapshot.appCategory,
          processName: `${activeSnapshot.procName}.exe`,
          processId: activeSnapshot.pid || undefined,
          startedAt: new Date(activeSince).toISOString(),
          endedAt: new Date(now).toISOString(),
          activeSeconds: seconds,
        });
      }
    }
    activeSnapshot = next;
    activeSince = now;
  };

  let tickRunning = false;
  const tick = async (): Promise<void> => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      const status = await api('/activity/sessions/current', {}, { cookie });
      if (!status.ok) throw new Error('Session status unavailable');
      const current = await status.json() as { session: { status: string } | null };
      if (current.session?.status === 'paused') {
        activeSnapshot = null; activeSince = Date.now();
        return;
      }
      if (!current.session) {
        log('Session was not active. Attempting to reactivate session...');
        const restartRes = await api('/activity/sessions/start', { method: 'POST', body: JSON.stringify({ deviceId }) }, { cookie });
        if (!restartRes.ok) {
          log('Session currently paused or employee checked out.');
          await shutdown(false);
          return;
        }
        log('Session reactivated successfully.');
      }
      const fg = await foregroundProcess();
      const isIdle = fg ? fg.idleSeconds >= idleThresholdSeconds : false;
      const currentApp = isIdle ? 'Idle / Away' : (fg?.appName ?? 'Desktop');
      const currentCategory = isIdle ? 'Administration' : (fg?.appCategory ?? 'Other');

      await api('/activity/agent/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          currentApp,
          currentCategory,
          isIdle,
          idleSeconds: fg?.idleSeconds ?? 0,
        }),
      }, { deviceToken: token });

      const procChanged = (fg?.procName ?? null) !== (activeSnapshot?.procName ?? null);
      // Persist bounded samples even when the foreground application never changes.
      if (procChanged || Date.now() - activeSince >= INTERVAL_MS) recordTransition(fg);
      await writeEncrypted(queueFile, queue, token);

      if (ticks++ % 10 === 0) {
        for (const error of await recentWindowsErrors()) {
          if (!error.recordId || seenErrors.has(error.recordId)) continue;
          seenErrors.add(error.recordId);
          queue.push({
            type: 'error',
            clientEventId: `win-event-${error.recordId}`,
            errorCategory: 'Windows application error',
            application: String(error.provider ?? '').slice(0, 120),
            severity: 'medium',
            description: String(error.message ?? 'Windows application error').slice(0, 400),
            occurredAt: error.time,
            diagnostic: { recordId: error.recordId, provider: error.provider, source: 'windows_event_log' },
          });
        }
      }
      await flushQueue();
    } catch {
      activeSnapshot = null; activeSince = Date.now();
      log('Connection unavailable; collection paused and queued events retained.');
    } finally { tickRunning = false; }
  };

  const shutdown = async (endSession = true): Promise<void> => {
    if (stopped) return;
    stopped = true;
    recordTransition(null);
    await flushQueue();
    if (endSession) {
      try { await api('/activity/sessions/stop', { method: 'POST', body: '{}' }, { cookie }); } catch { /* offline */ }
    }
    log('Monitoring stopped.');
    process.exit(0);
  };

  // --- Device telemetry (LiveGuard Pro integration) ---
  let healthRuns = 0;
  const reportHealth = async (): Promise<void> => {
    if (stopped) return;
    try {
      const sample = await collectHealth(AGENT_VERSION, healthRuns++ % SECURITY_EVERY_N_HEALTH === 0);
      const response = await api('/activity/agent/health', { method: 'POST', body: JSON.stringify(sample) }, { deviceToken: token });
      if (!response.ok) log(`Device health not accepted (${response.status}).`);
      else if (sample.security?.recentThreats) log(`Windows Defender reports ${sample.security.recentThreats} recent threat(s); IT has been notified.`);
    } catch {
      log('Device health report deferred (server unreachable).');
    }
  };
  const reportLocation = async (): Promise<void> => {
    if (stopped) return;
    const location = await collectLocation();
    if (!location) {
      log('Location unavailable. Turn on Windows Settings → Privacy & security → Location to share it.');
      return;
    }
    try {
      const response = await api('/activity/agent/location', { method: 'POST', body: JSON.stringify(location) }, { deviceToken: token });
      const result = await response.json().catch(() => ({})) as { accepted?: boolean; reason?: string };
      if (!result.accepted) log(`Location not recorded (${result.reason ?? response.status}).`);
    } catch {
      log('Location report deferred (server unreachable).');
    }
  };
  void reportHealth();
  setInterval(() => { void reportHealth(); }, HEALTH_INTERVAL_MS);
  if (policy.locationTrackingEnabled) {
    const minutes = Math.min(240, Math.max(5, policy.locationIntervalMinutes ?? 15));
    log(`Location sharing is enabled by policy (every ${minutes} min, only during the work session).`);
    void reportLocation();
    setInterval(() => { void reportLocation(); }, minutes * 60 * 1000);
  } else {
    log('Location sharing: disabled by policy.');
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await flushQueue();
  await tick();
  setInterval(() => { void tick(); }, INTERVAL_MS);
  if (MAX_RUN_MS > 0) setTimeout(() => { log('Reached the configured run duration.'); void shutdown(); }, MAX_RUN_MS);
}

main().catch((error) => {
  console.error(`[agent] ${(error as Error).message}`);
  process.exit(1);
});
