"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// agent/src/index.ts
var import_node_child_process2 = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_promises2 = __toESM(require("node:fs/promises"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_util2 = require("node:util");

// agent/src/telemetry.ts
var import_node_child_process = require("node:child_process");
var import_promises = __toESM(require("node:fs/promises"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_util = require("node:util");
var run = (0, import_node_util.promisify)(import_node_child_process.execFile);
var PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
async function cpuPercent(sampleMs = 1e3) {
  const snapshot = () => import_node_os.default.cpus().reduce(
    (acc, cpu) => {
      const total2 = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return { idle: acc.idle + cpu.times.idle, total: acc.total + total2 };
    },
    { idle: 0, total: 0 }
  );
  const first = snapshot();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const second = snapshot();
  const total = second.total - first.total;
  if (total <= 0) return null;
  return Math.round((1 - (second.idle - first.idle) / total) * 1e3) / 10;
}
async function systemDisk() {
  try {
    const root = process.platform === "win32" ? `${process.env.SystemDrive ?? "C:"}\\` : "/";
    const stats = await import_promises.default.statfs(root);
    return {
      freeMb: Math.round(Number(stats.bavail) * Number(stats.bsize) / 1048576),
      totalMb: Math.round(Number(stats.blocks) * Number(stats.bsize) / 1048576)
    };
  } catch {
    return null;
  }
}
async function networkName() {
  if (process.platform !== "win32") return { name: null, type: null };
  try {
    const { stdout } = await run("netsh", ["wlan", "show", "interfaces"], { timeout: 5e3, windowsHide: true });
    const state = /^\s*State\s*:\s*(.+)$/m.exec(stdout)?.[1]?.trim().toLowerCase();
    const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
    if (state === "connected" && ssid) return { name: ssid.slice(0, 120), type: "wifi" };
  } catch {
  }
  const wired = Object.entries(import_node_os.default.networkInterfaces()).some(([name, list]) => /ethernet|eth|en\d/i.test(name) && (list ?? []).some((address) => !address.internal && address.family === "IPv4"));
  return wired ? { name: "Ethernet", type: "ethernet" } : { name: null, type: null };
}
async function securityPosture() {
  if (process.platform !== "win32") return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ antivirusEnabled = $null; realTimeProtection = $null; signatureAgeDays = $null; recentThreats = $null; threatNames = @(); firewallEnabled = $null }
$s = Get-MpComputerStatus
if ($s) {
  $out.antivirusEnabled = [bool]$s.AntivirusEnabled
  $out.realTimeProtection = [bool]$s.RealTimeProtectionEnabled
  $out.signatureAgeDays = [int]$s.AntivirusSignatureAge
  $since = (Get-Date).AddDays(-7)
  $d = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt $since })
  $out.recentThreats = $d.Count
  if ($d.Count -gt 0) {
    $ids = $d | Select-Object -ExpandProperty ThreatID -Unique
    $out.threatNames = @(Get-MpThreat | Where-Object { $ids -contains $_.ThreatID } | Select-Object -ExpandProperty ThreatName -First 10)
  }
}
$fw = Get-NetFirewallProfile
if ($fw) { $out.firewallEnabled = [bool](@($fw | Where-Object { $_.Enabled }).Count -eq @($fw).Count) }
$out | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run("powershell.exe", [...PS, script], { timeout: 2e4, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || "{}");
    return {
      antivirusEnabled: typeof parsed.antivirusEnabled === "boolean" ? parsed.antivirusEnabled : null,
      realTimeProtection: typeof parsed.realTimeProtection === "boolean" ? parsed.realTimeProtection : null,
      signatureAgeDays: Number.isFinite(parsed.signatureAgeDays) ? Number(parsed.signatureAgeDays) : null,
      recentThreats: Number.isFinite(parsed.recentThreats) ? Number(parsed.recentThreats) : null,
      threatNames: (Array.isArray(parsed.threatNames) ? parsed.threatNames : parsed.threatNames ? [parsed.threatNames] : []).map(String).slice(0, 10),
      firewallEnabled: typeof parsed.firewallEnabled === "boolean" ? parsed.firewallEnabled : null
    };
  } catch {
    return null;
  }
}
async function collectHealth(agentVersion, includeSecurity) {
  const [cpu, disk, network, security] = await Promise.all([
    cpuPercent(),
    systemDisk(),
    networkName(),
    includeSecurity ? securityPosture() : Promise.resolve(null)
  ]);
  const total = import_node_os.default.totalmem();
  return {
    cpuPercent: cpu,
    memoryPercent: Math.round((total - import_node_os.default.freemem()) / total * 1e3) / 10,
    memoryTotalMb: Math.round(total / 1048576),
    diskFreeMb: disk?.freeMb ?? null,
    diskTotalMb: disk?.totalMb ?? null,
    uptimeMinutes: Math.round(import_node_os.default.uptime() / 60),
    cpuModel: import_node_os.default.cpus()[0]?.model?.trim() ?? null,
    cpuCores: import_node_os.default.cpus().length,
    networkName: network.name,
    networkType: network.type,
    agentVersion,
    security
  };
}
async function collectLocation() {
  if (process.platform !== "win32") return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$result = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  $locator = New-Object Windows.Devices.Geolocation.Geolocator
  $locator.DesiredAccuracyInMeters = 50
  $task = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($locator.GetGeopositionAsync()))
  if ($task.Wait(20000)) {
    $c = $task.Result.Coordinate
    $result = @{ latitude = $c.Point.Position.Latitude; longitude = $c.Point.Position.Longitude; accuracy = $c.Accuracy }
  }
} catch {}
if (-not $result -or $result.accuracy -gt 1000) {
  try {
    Add-Type -AssemblyName System.Device
    $w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
    $null = $w.TryStart($false, [TimeSpan]::FromSeconds(15))
    $loc = $w.Position.Location
    if (-not $loc.IsUnknown -and (-not $result -or $loc.HorizontalAccuracy -lt $result.accuracy)) {
      $result = @{ latitude = $loc.Latitude; longitude = $loc.Longitude; accuracy = $loc.HorizontalAccuracy }
    }
    $w.Stop()
  } catch {}
}
if ($result) { $result | ConvertTo-Json -Compress } else { 'null' }`;
  try {
    const { stdout } = await run("powershell.exe", [...PS, script], { timeout: 45e3, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || "null");
    if (!parsed || !Number.isFinite(parsed.latitude) || !Number.isFinite(parsed.longitude)) return null;
    if (parsed.latitude === 0 && parsed.longitude === 0) return null;
    const network = await networkName();
    return {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      accuracyM: Math.round(Number(parsed.accuracy) || 0),
      source: "windows_location",
      networkName: network.name
    };
  } catch {
    return null;
  }
}

// agent/src/index.ts
var run2 = (0, import_node_util2.promisify)(import_node_child_process2.execFile);
var SERVER = (process.env.WORKFORCE_URL ?? "http://localhost:4000").replace(/\/$/, "");
var EMAIL = process.env.WORKFORCE_EMAIL ?? "";
var PASSWORD = process.env.WORKFORCE_PASSWORD ?? "";
var INTERVAL_MS = Math.max(3e3, Number(process.env.AGENT_INTERVAL_MS ?? 1e4));
var MAX_RUN_MS = Math.max(0, Number(process.env.AGENT_MAX_RUN_MS ?? 0));
var DATA_DIR = process.env.AGENT_DATA_DIR ?? import_node_path.default.resolve(process.cwd(), "agent-data");
var AGENT_VERSION = "1.1.0";
var HEALTH_INTERVAL_MS = 5 * 60 * 1e3;
var SECURITY_EVERY_N_HEALTH = 6;
var APP_CATEGORIES = {
  chrome: "Browser",
  brave: "Browser",
  msedge: "Browser",
  firefox: "Browser",
  opera: "Browser",
  code: "Development",
  antigravity: "Development",
  studio64: "Development",
  idea64: "Development",
  postman: "Development",
  excel: "Office Productivity",
  winword: "Office Productivity",
  powerpnt: "Office Productivity",
  outlook: "Communication",
  onenote: "Office Productivity",
  teams: "Communication",
  whatsapp: "Communication",
  slack: "Communication",
  zoom: "Communication",
  telegram: "Communication",
  figma: "Design",
  notion: "Documentation",
  tally: "Data Analytics",
  pos: "Business Operations",
  billing: "Business Operations",
  quickbooks: "Data Analytics",
  notepad: "Office Productivity",
  notepadplusplus: "Office Productivity",
  calc: "Office Productivity",
  explorer: "Administration"
};
var APPLICATION_NAMES = {
  chrome: "Google Chrome",
  brave: "Brave Browser",
  msedge: "Microsoft Edge",
  firefox: "Firefox",
  opera: "Opera",
  code: "Visual Studio Code",
  antigravity: "Antigravity IDE",
  studio64: "Android Studio",
  idea64: "IntelliJ IDEA",
  postman: "Postman",
  excel: "Microsoft Excel",
  winword: "Microsoft Word",
  powerpnt: "Microsoft PowerPoint",
  outlook: "Microsoft Outlook",
  onenote: "Microsoft OneNote",
  teams: "Microsoft Teams",
  whatsapp: "WhatsApp Desktop",
  slack: "Slack",
  zoom: "Zoom Meetings",
  telegram: "Telegram",
  figma: "Figma",
  notion: "Notion",
  tally: "Tally Accounting",
  pos: "Retail POS & Billing Software",
  billing: "Store Billing System",
  notepad: "Notepad",
  calc: "Windows Calculator",
  explorer: "File Explorer"
};
function resolveAppInfo(processName, windowTitle = "") {
  const cleanProc = processName.toLowerCase().replace(/\.exe$/i, "");
  if (windowTitle && (windowTitle.includes("BSC") || windowTitle.includes("HRMS") || windowTitle.includes("emptrack"))) {
    return { appName: "BSC HRMS & Web Portal", appCategory: "Business Operations" };
  }
  if (APPLICATION_NAMES[cleanProc]) {
    return { appName: APPLICATION_NAMES[cleanProc], appCategory: APP_CATEGORIES[cleanProc] ?? "Office Productivity" };
  }
  for (const [key, name] of Object.entries(APPLICATION_NAMES)) {
    if (cleanProc.includes(key)) return { appName: name, appCategory: APP_CATEGORIES[key] ?? "Office Productivity" };
  }
  const formatted = cleanProc.charAt(0).toUpperCase() + cleanProc.slice(1);
  return { appName: formatted, appCategory: "Office Productivity" };
}
function log(message) {
  console.log(`[agent ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${message}`);
}
async function ensureDir() {
  await import_promises2.default.mkdir(DATA_DIR, { recursive: true, mode: 448 });
}
function keyFromToken(token) {
  return import_node_crypto.default.scryptSync(token, "workforce-agent-v1", 32);
}
async function writeEncrypted(file, value, token) {
  await ensureDir();
  const iv = import_node_crypto.default.randomBytes(12);
  const cipher = import_node_crypto.default.createCipheriv("aes-256-gcm", keyFromToken(token), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const temporary = `${file}.tmp`;
  await import_promises2.default.writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 384 });
  await import_promises2.default.rename(temporary, file);
}
async function readEncrypted(file, token, fallback) {
  try {
    const raw = await import_promises2.default.readFile(file);
    const decipher = import_node_crypto.default.createDecipheriv("aes-256-gcm", keyFromToken(token), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}
async function api(pathname, init = {}, auth = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (auth.cookie) headers.set("Cookie", auth.cookie);
  if (auth.deviceToken) headers.set("X-Device-Token", auth.deviceToken);
  headers.set("Origin", SERVER);
  return fetch(`${SERVER}/api${pathname}`, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(15e3) });
}
async function login() {
  if (process.env.WORKFORCE_COOKIE) return process.env.WORKFORCE_COOKIE;
  if (!EMAIL || !PASSWORD) throw new Error("Set WORKFORCE_EMAIL and WORKFORCE_PASSWORD (or WORKFORCE_COOKIE / WORKFORCE_DEVICE_TOKEN).");
  const response = await api("/auth/login", { method: "POST", body: JSON.stringify({ identifier: EMAIL, password: PASSWORD }) });
  if (!response.ok) throw new Error(`Sign-in failed (${response.status}). Check the employee credentials.`);
  const payload = await response.json();
  if (payload.otpRequired) throw new Error("This account requires OTP verification. Sign in on the web app first, then pass WORKFORCE_COOKIE.");
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
  if (!cookies.length) throw new Error("Sign-in succeeded but no session cookie was returned.");
  return cookies.join("; ");
}
async function machineFingerprint() {
  const host = import_node_os2.default.hostname();
  const user = import_node_os2.default.userInfo().username;
  return import_node_crypto.default.createHash("sha256").update(`workforce|${host}|${user}`).digest("hex").slice(0, 48);
}
async function registerDevice(cookie) {
  const response = await api("/activity/devices", {
    method: "POST",
    body: JSON.stringify({
      deviceName: `${import_node_os2.default.hostname()} \xB7 Windows`,
      osName: process.platform === "win32" ? "Windows" : process.platform,
      osVersion: import_node_os2.default.release(),
      agentVersion: AGENT_VERSION,
      machineFingerprint: await machineFingerprint()
    })
  }, { cookie });
  if (!response.ok) throw new Error(`Device registration failed (${response.status}): ${await response.text()}`);
  return response.json();
}
async function foregroundProcess() {
  if (process.platform !== "win32") return null;
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
$isLocked = ($h -eq [IntPtr]::Zero) -or ($procName -like "*lockapp*") -or ($procName -like "*logonui*")
"$procName|$targetPid|$idleMs|$($isLocked ? 1 : 0)|$title"`;
  try {
    const { stdout } = await run2("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 8e3 });
    const parts = stdout.trim().split("|");
    const proc = (parts[0] ?? "").trim().toLowerCase();
    const pid = Number(parts[1]) || 0;
    const idleMs = Math.max(0, Number(parts[2]) || 0);
    const isLocked = parts[3] === "1";
    const title = parts.slice(4).join("|").trim();
    if (!proc && !isLocked) return null;
    const { appName, appCategory } = isLocked ? { appName: "Workstation Locked", appCategory: "Administration" } : resolveAppInfo(proc, title);
    return {
      procName: proc || "lockapp",
      appName,
      appCategory,
      pid,
      idleSeconds: Math.floor(idleMs / 1e3),
      isLocked,
      windowTitle: title
    };
  } catch {
    return null;
  }
}
async function recentWindowsErrors(sinceMinutes = 5) {
  if (process.platform !== "win32") return [];
  const script = `
$start = (Get-Date).AddMinutes(-${sinceMinutes})
Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2; StartTime=$start} -MaxEvents 10 -ErrorAction SilentlyContinue |
  ForEach-Object { [pscustomobject]@{ recordId = $_.RecordId; provider = $_.ProviderName; message = ($_.Message -split "\`n")[0]; time = $_.TimeCreated.ToString('o') } } |
  ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run2("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 12e3 });
    const parsed = JSON.parse(stdout.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}
async function main() {
  log(`Connecting to ${SERVER}`);
  await ensureDir();
  const queueFile = import_node_path.default.join(DATA_DIR, "queue.enc");
  const stateFile = import_node_path.default.join(DATA_DIR, "state.enc");
  let cookie = await login();
  let token = process.env.WORKFORCE_DEVICE_TOKEN ?? "";
  let deviceId = Number(process.env.WORKFORCE_DEVICE_ID ?? 0);
  if (!token) {
    const registered = await registerDevice(cookie);
    token = registered.token;
    deviceId = registered.deviceId;
    await writeEncrypted(stateFile, { deviceToken: token, deviceId }, token);
    log("Device registered. Token stored encrypted for this machine.");
  }
  const policyResponse = await api("/activity/policy", {}, { cookie });
  if (!policyResponse.ok) throw new Error("Unable to read the monitoring policy. Is monitoring enabled for this server?");
  const policyPayload = await policyResponse.json();
  if (!policyPayload.acknowledged) throw new Error("The employee has not acknowledged the monitoring policy in the web app. Monitoring will not start.");
  const policy = policyPayload.policy;
  log("Policy acknowledged. Monitoring stays on only while the authorised work session is active.");
  log(`Screenshot evidence: ${policy.screenshotEnabled ? "authorised but not captured by this build" : "disabled"} \xB7 Retention: ${policy.retentionDays} days`);
  let attendance = await api("/attendance/today", {}, { cookie });
  let attendanceState = await attendance.json().catch(() => ({}));
  if (!attendanceState.checkInAt) {
    log("Attendance not yet checked in. Initiating automatic check-in from desktop agent...");
    try {
      const checkInRes = await api("/attendance/check-in", {
        method: "POST",
        body: JSON.stringify({ source: "desktop_agent", deviceId })
      }, { cookie });
      if (checkInRes.ok) {
        log("Attendance automatically checked in.");
      } else {
        log("Automatic check-in skipped; proceeding with monitoring session.");
      }
    } catch {
      log("Could not perform automatic check-in; continuing.");
    }
  }
  if (!deviceId) {
    const devices = await api("/activity/devices", {}, { cookie }).then((response) => response.json());
    deviceId = devices.devices.find((device) => device.status === "active")?.id ?? 0;
  }
  if (!deviceId) throw new Error("No registered device found.");
  const currentSessionRes = await api("/activity/sessions/current", {}, { cookie });
  const currentSessionData = await currentSessionRes.json().catch(() => ({}));
  if (!currentSessionData.session) {
    const start = await api("/activity/sessions/start", { method: "POST", body: JSON.stringify({ deviceId }) }, { cookie });
    if (!start.ok) {
      log(`Note on starting session: ${await start.text()}`);
    } else {
      log(`Work session started automatically on device #${deviceId}.`);
    }
  } else {
    log(`Attached to existing active work session #${currentSessionData.session.id}.`);
  }
  log(`Monitoring active on device #${deviceId}. Press Ctrl+C to stop.`);
  const queue = await readEncrypted(queueFile, token, []);
  if (queue.length) log(`${queue.length} queued event(s) from a previous offline session will be uploaded.`);
  let activeSnapshot = null;
  let activeSince = Date.now();
  let stopped = false;
  let ticks = 0;
  let syncFailures = 0;
  let lastNetworkErrorAt = 0;
  const seenErrors = /* @__PURE__ */ new Set();
  const idleThresholdSeconds = (policy.idleThresholdMinutes ?? 5) * 60;
  const flushQueue = async () => {
    if (queue.length === 0) return;
    const batch = queue.slice(0, 100);
    try {
      const response = await api("/activity/agent/events", { method: "POST", body: JSON.stringify({ events: batch }) }, { deviceToken: token });
      if (response.ok) {
        const acknowledgement = await response.json();
        if (acknowledgement.rejected || acknowledgement.accepted + acknowledgement.duplicates !== batch.length) {
          log("Batch not fully acknowledged; retained for recovery.");
          return;
        }
        syncFailures = 0;
        queue.splice(0, batch.length);
        await writeEncrypted(queueFile, queue, token);
        log(`Uploaded ${batch.length} event(s); ${queue.length} remain queued.`);
        return;
      }
      log(`Upload deferred (${response.status}); encrypted events retained.`);
    } catch {
      syncFailures += 1;
      if (syncFailures >= 3 && Date.now() - lastNetworkErrorAt > 10 * 60 * 1e3) {
        lastNetworkErrorAt = Date.now();
        queue.push({
          type: "error",
          clientEventId: import_node_crypto.default.randomUUID(),
          errorCategory: "Network connection failure",
          application: "Workforce Monitoring Agent",
          module: "Activity monitoring",
          errorCode: "AGENT_NETWORK",
          severity: "medium",
          description: "The monitoring agent could not reach the Workforce server and is working offline.",
          occurredAt: (/* @__PURE__ */ new Date()).toISOString(),
          diagnostic: { server: SERVER, failures: syncFailures }
        });
        await writeEncrypted(queueFile, queue, token).catch(() => void 0);
      }
      log("Server unreachable. Events stay in the encrypted local queue and will sync automatically.");
    }
  };
  const recordTransition = (next) => {
    const now = Date.now();
    const seconds = Math.round((now - activeSince) / 1e3);
    if (activeSnapshot && seconds >= 3) {
      const isBlocked = policy.blockedApps.some(
        (app) => activeSnapshot.procName.includes(app.toLowerCase()) || activeSnapshot.appName.toLowerCase().includes(app.toLowerCase())
      );
      if (isBlocked) {
        log(`Excluded application ${activeSnapshot.appName} detected; activity not recorded.`);
      } else {
        const isIdle = activeSnapshot.idleSeconds >= idleThresholdSeconds;
        const idleSec = isIdle ? Math.min(seconds, activeSnapshot.idleSeconds) : 0;
        const activeSec = Math.max(0, seconds - idleSec);
        queue.push({
          type: "app",
          title: activeSnapshot.windowTitle || void 0,
          occurredAt: new Date(activeSince).toISOString(),
          clientEventId: import_node_crypto.default.randomUUID(),
          appName: activeSnapshot.appName,
          appCategory: activeSnapshot.appCategory,
          processName: `${activeSnapshot.procName}.exe`,
          processId: activeSnapshot.pid || void 0,
          startedAt: new Date(activeSince).toISOString(),
          endedAt: new Date(now).toISOString(),
          activeSeconds: activeSec,
          idleSeconds: idleSec,
          foregroundSeconds: seconds,
          isLocked: activeSnapshot.isLocked,
          windowTitle: activeSnapshot.windowTitle
        });
      }
    }
    activeSnapshot = next;
    activeSince = now;
  };
  let tickRunning = false;
  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      const status = await api("/activity/sessions/current", {}, { cookie });
      if (!status.ok) throw new Error("Session status unavailable");
      const current = await status.json();
      if (current.session?.status === "paused") {
        activeSnapshot = null;
        activeSince = Date.now();
        return;
      }
      if (!current.session) {
        log("Session was not active. Attempting to reactivate session...");
        const restartRes = await api("/activity/sessions/start", { method: "POST", body: JSON.stringify({ deviceId }) }, { cookie });
        if (!restartRes.ok) {
          log("Session currently paused or employee checked out.");
          await shutdown(false);
          return;
        }
        log("Session reactivated successfully.");
      }
      const fg = await foregroundProcess();
      const isIdle = fg ? fg.idleSeconds >= idleThresholdSeconds : false;
      const currentApp = fg?.appName ?? "Desktop";
      const currentCategory = fg?.appCategory ?? "Other";
      await api("/activity/agent/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          currentApp,
          currentCategory,
          isIdle,
          idleSeconds: fg?.idleSeconds ?? 0,
          isLocked: fg?.isLocked ?? false,
          windowTitle: fg?.windowTitle ?? ""
        })
      }, { deviceToken: token });
      const procChanged = (fg?.procName ?? null) !== (activeSnapshot?.procName ?? null);
      if (procChanged || Date.now() - activeSince >= INTERVAL_MS) recordTransition(fg);
      await writeEncrypted(queueFile, queue, token);
      if (ticks++ % 10 === 0) {
        for (const error of await recentWindowsErrors()) {
          if (!error.recordId || seenErrors.has(error.recordId)) continue;
          seenErrors.add(error.recordId);
          queue.push({
            type: "error",
            clientEventId: `win-event-${error.recordId}`,
            errorCategory: "Windows application error",
            application: String(error.provider ?? "").slice(0, 120),
            severity: "medium",
            description: String(error.message ?? "Windows application error").slice(0, 400),
            occurredAt: error.time,
            diagnostic: { recordId: error.recordId, provider: error.provider, source: "windows_event_log" }
          });
        }
      }
      await flushQueue();
    } catch {
      activeSnapshot = null;
      activeSince = Date.now();
      log("Connection unavailable; collection paused and queued events retained.");
    } finally {
      tickRunning = false;
    }
  };
  const shutdown = async (endSession = true) => {
    if (stopped) return;
    stopped = true;
    recordTransition(null);
    await flushQueue();
    if (endSession) {
      try {
        await api("/activity/sessions/stop", { method: "POST", body: "{}" }, { cookie });
      } catch {
      }
    }
    log("Monitoring stopped.");
    process.exit(0);
  };
  let healthRuns = 0;
  const reportHealth = async () => {
    if (stopped) return;
    try {
      const sample = await collectHealth(AGENT_VERSION, healthRuns++ % SECURITY_EVERY_N_HEALTH === 0);
      const response = await api("/activity/agent/health", { method: "POST", body: JSON.stringify(sample) }, { deviceToken: token });
      if (!response.ok) log(`Device health not accepted (${response.status}).`);
      else if (sample.security?.recentThreats) log(`Windows Defender reports ${sample.security.recentThreats} recent threat(s); IT has been notified.`);
    } catch {
      log("Device health report deferred (server unreachable).");
    }
  };
  const reportLocation = async () => {
    if (stopped) return;
    const location = await collectLocation();
    if (!location) {
      log("Location unavailable. Turn on Windows Settings \u2192 Privacy & security \u2192 Location to share it.");
      return;
    }
    try {
      const response = await api("/activity/agent/location", { method: "POST", body: JSON.stringify(location) }, { deviceToken: token });
      const result = await response.json().catch(() => ({}));
      if (!result.accepted) log(`Location not recorded (${result.reason ?? response.status}).`);
    } catch {
      log("Location report deferred (server unreachable).");
    }
  };
  void reportHealth();
  setInterval(() => {
    void reportHealth();
  }, HEALTH_INTERVAL_MS);
  if (policy.locationTrackingEnabled) {
    const minutes = Math.min(240, Math.max(5, policy.locationIntervalMinutes ?? 15));
    log(`Location sharing is enabled by policy (every ${minutes} min, only during the work session).`);
    void reportLocation();
    setInterval(() => {
      void reportLocation();
    }, minutes * 60 * 1e3);
  } else {
    log("Location sharing: disabled by policy.");
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await flushQueue();
  await tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  if (MAX_RUN_MS > 0) setTimeout(() => {
    log("Reached the configured run duration.");
    void shutdown();
  }, MAX_RUN_MS);
}
main().catch((error) => {
  console.error(`[agent] ${error.message}`);
  process.exit(1);
});
