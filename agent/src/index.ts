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

const run = promisify(execFile);

const SERVER = (process.env.WORKFORCE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const EMAIL = process.env.WORKFORCE_EMAIL ?? '';
const PASSWORD = process.env.WORKFORCE_PASSWORD ?? '';
const INTERVAL_MS = Math.max(3000, Number(process.env.AGENT_INTERVAL_MS ?? 10000));
// Optional bounded run for smoke tests / demos; 0 means run until stopped.
const MAX_RUN_MS = Math.max(0, Number(process.env.AGENT_MAX_RUN_MS ?? 0));
const DATA_DIR = process.env.AGENT_DATA_DIR ?? path.resolve(process.cwd(), 'agent-data');

interface Policy {
  allowedApps: string[];
  blockedApps: string[];
  allowedDomains: string[];
  policyText: string;
  retentionDays: number;
  screenshotEnabled: boolean;
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
  chrome: 'Browser', brave: 'Browser', msedge: 'Browser', firefox: 'Browser',
  code: 'Development', antigravity: 'Development', studio64: 'Development', idea64: 'Development', postman: 'Development',
  excel: 'Office Productivity', winword: 'Office Productivity', powerpnt: 'Office Productivity', teams: 'Communication',
  figma: 'Design', notion: 'Documentation', slack: 'Communication',
};

const APPLICATION_NAMES: Record<string, string> = {
  chrome: 'Google Chrome', brave: 'Brave Browser', msedge: 'Microsoft Edge', firefox: 'Firefox',
  code: 'Visual Studio Code', antigravity: 'Antigravity', studio64: 'Android Studio', idea64: 'IntelliJ IDEA',
  postman: 'Postman', excel: 'Microsoft Excel', winword: 'Microsoft Word', powerpnt: 'PowerPoint', teams: 'Microsoft Teams',
};

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
  await fs.writeFile(file, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
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
  return fetch(`${SERVER}/api${pathname}`, { ...init, headers });
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
      agentVersion: '1.0.0',
      machineFingerprint: await machineFingerprint(),
    }),
  }, { cookie });
  if (!response.ok) throw new Error(`Device registration failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<{ deviceId: number; token: string }>;
}

async function foregroundProcess(): Promise<{ name: string; pid: number } | null> {
  if (process.platform !== 'win32') return null;
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Foreground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [Foreground]::GetForegroundWindow()
$pid2 = 0
[void][Foreground]::GetWindowThreadProcessId($h, [ref]$pid2)
if ($pid2 -gt 0) { $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue; if ($p) { "$($p.ProcessName)|$pid2" } }`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
    const [name, pid] = stdout.trim().split('|');
    return name ? { name: name.toLowerCase(), pid: Number(pid) || 0 } : null;
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

  const attendance = await api('/attendance/today', {}, { cookie });
  const attendanceState = await attendance.json() as { checkInAt: string | null; checkOutAt: string | null };
  if (!attendanceState.checkInAt) throw new Error('Start office attendance in the web app before running the agent.');
  if (attendanceState.checkOutAt) throw new Error('Attendance for today is already closed. Monitoring will not start.');

  if (!deviceId) {
    const devices = await api('/activity/devices', {}, { cookie }).then((response) => response.json()) as { devices: { id: number; status: string }[] };
    deviceId = devices.devices.find((device) => device.status === 'active')?.id ?? 0;
  }
  if (!deviceId) throw new Error('No registered device found.');

  const start = await api('/activity/sessions/start', { method: 'POST', body: JSON.stringify({ deviceId }) }, { cookie });
  if (!start.ok) throw new Error(`Unable to start monitoring: ${await start.text()}`);
  log(`Monitoring active on device #${deviceId}. Press Ctrl+C to stop.`);

  const queue = await readEncrypted<QueueEvent[]>(queueFile, token, []);
  if (queue.length) log(`${queue.length} queued event(s) from a previous offline session will be uploaded.`);

  let activeProcess: string | null = null;
  let activePid = 0;
  let activeSince = Date.now();
  let stopped = false;
  let ticks = 0;
  let syncFailures = 0;
  let lastNetworkErrorAt = 0;
  const seenErrors = new Set<number>();

  const flushQueue = async (): Promise<void> => {
    if (queue.length === 0) return;
    const batch = queue.slice(0, 100);
    try {
      const response = await api('/activity/agent/events', { method: 'POST', body: JSON.stringify({ events: batch }) }, { deviceToken: token });
      if (response.ok) {
        syncFailures = 0;
        queue.splice(0, batch.length);
        await writeEncrypted(queueFile, queue, token);
        log(`Uploaded ${batch.length} event(s); ${queue.length} remain queued.`);
        return;
      }
      if (response.status === 400) {
        // The server rejected this batch (for example the work session ended while
        // offline). Dropping it avoids an endless retry loop.
        await response.text();
        queue.splice(0, batch.length);
        await writeEncrypted(queueFile, queue, token);
        log(`Server rejected ${batch.length} event(s); they were discarded.`);
      }
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

  const recordTransition = (next: string | null, pid = 0): void => {
    const now = Date.now();
    const seconds = Math.round((now - activeSince) / 1000);
    if (activeProcess && seconds >= 5) {
      if (!APPLICATION_NAMES[activeProcess]) {
        // Unapproved/unknown applications are never recorded as named activity.
      } else if (policy.blockedApps.some((app) => app.toLowerCase().includes(activeProcess!))) {
        log(`Excluded application detected; activity not recorded.`);
      } else if (policy.allowedApps.length === 0 || policy.allowedApps.includes(APPLICATION_NAMES[activeProcess])) {
        queue.push({
          type: 'app',
          clientEventId: crypto.randomUUID(),
          appName: APPLICATION_NAMES[activeProcess],
          appCategory: APP_CATEGORIES[activeProcess] ?? 'Other',
          processName: `${activeProcess}.exe`,
          processId: activePid || undefined,
          startedAt: new Date(activeSince).toISOString(),
          endedAt: new Date(now).toISOString(),
          activeSeconds: seconds,
        });
      }
    }
    activeProcess = next;
    activePid = pid;
    activeSince = now;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const status = await api('/activity/sessions/current', {}, { cookie });
      const current = await status.json() as { session: unknown };
      if (!current.session) {
        log('Work session ended. Monitoring stopped.');
        await shutdown(false);
        return;
      }
      await api('/activity/agent/heartbeat', { method: 'POST', body: '{}' }, { deviceToken: token });
      const next = await foregroundProcess();
      if ((next?.name ?? null) !== activeProcess) recordTransition(next?.name ?? null, next?.pid ?? 0);
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
      log('Sync failed; continuing offline with the encrypted queue.');
    }
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
