/**
 * Device telemetry ported from LiveGuard Pro.
 *
 * Collects real, read-only device facts: CPU / memory / disk usage, connected
 * network name, Windows Defender status and (only when the monitoring policy
 * enables it) the Windows Location API position. No files are scanned or read,
 * no keystrokes or screen content are captured, and nothing is invented: a value
 * that cannot be measured is sent as null.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

export interface HealthSample {
  cpuPercent: number | null;
  memoryPercent: number;
  memoryTotalMb: number;
  diskFreeMb: number | null;
  diskTotalMb: number | null;
  uptimeMinutes: number;
  cpuModel: string | null;
  cpuCores: number;
  networkName: string | null;
  networkType: string | null;
  agentVersion: string;
  security: SecurityPosture | null;
}

export interface SecurityPosture {
  antivirusEnabled: boolean | null;
  realTimeProtection: boolean | null;
  signatureAgeDays: number | null;
  recentThreats: number | null;
  threatNames: string[];
  firewallEnabled: boolean | null;
}

export interface LocationSample {
  latitude: number;
  longitude: number;
  accuracyM: number;
  source: 'windows_location';
  networkName: string | null;
}

/** CPU utilisation measured over a short window from kernel tick counters. */
async function cpuPercent(sampleMs = 1000): Promise<number | null> {
  const snapshot = () => os.cpus().reduce(
    (acc, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return { idle: acc.idle + cpu.times.idle, total: acc.total + total };
    },
    { idle: 0, total: 0 },
  );
  const first = snapshot();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const second = snapshot();
  const total = second.total - first.total;
  if (total <= 0) return null;
  return Math.round((1 - (second.idle - first.idle) / total) * 1000) / 10;
}

async function systemDisk(): Promise<{ freeMb: number; totalMb: number } | null> {
  try {
    const root = process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/';
    const stats = await fs.statfs(root);
    return {
      freeMb: Math.round((Number(stats.bavail) * Number(stats.bsize)) / 1048576),
      totalMb: Math.round((Number(stats.blocks) * Number(stats.bsize)) / 1048576),
    };
  } catch {
    return null;
  }
}

/** Connected Wi-Fi name (SSID), or Ethernet when wired. Nearby networks are never scanned. */
export async function networkName(): Promise<{ name: string | null; type: string | null }> {
  if (process.platform !== 'win32') return { name: null, type: null };
  try {
    const { stdout } = await run('netsh', ['wlan', 'show', 'interfaces'], { timeout: 5000, windowsHide: true });
    const state = /^\s*State\s*:\s*(.+)$/m.exec(stdout)?.[1]?.trim().toLowerCase();
    const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
    if (state === 'connected' && ssid) return { name: ssid.slice(0, 120), type: 'wifi' };
  } catch { /* no wireless service */ }
  const wired = Object.entries(os.networkInterfaces()).some(([name, list]) =>
    /ethernet|eth|en\d/i.test(name) && (list ?? []).some((address) => !address.internal && address.family === 'IPv4'));
  return wired ? { name: 'Ethernet', type: 'ethernet' } : { name: null, type: null };
}

/** Windows Defender and firewall status (read-only Get-Mp* cmdlets). */
async function securityPosture(): Promise<SecurityPosture | null> {
  if (process.platform !== 'win32') return null;
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
    const { stdout } = await run('powershell.exe', [...PS, script], { timeout: 20000, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || '{}') as Partial<SecurityPosture> & { threatNames?: string[] | string };
    return {
      antivirusEnabled: typeof parsed.antivirusEnabled === 'boolean' ? parsed.antivirusEnabled : null,
      realTimeProtection: typeof parsed.realTimeProtection === 'boolean' ? parsed.realTimeProtection : null,
      signatureAgeDays: Number.isFinite(parsed.signatureAgeDays) ? Number(parsed.signatureAgeDays) : null,
      recentThreats: Number.isFinite(parsed.recentThreats) ? Number(parsed.recentThreats) : null,
      threatNames: (Array.isArray(parsed.threatNames) ? parsed.threatNames : parsed.threatNames ? [parsed.threatNames] : []).map(String).slice(0, 10),
      firewallEnabled: typeof parsed.firewallEnabled === 'boolean' ? parsed.firewallEnabled : null,
    };
  } catch {
    return null;
  }
}

export async function collectHealth(agentVersion: string, includeSecurity: boolean): Promise<HealthSample> {
  const [cpu, disk, network, security] = await Promise.all([
    cpuPercent(),
    systemDisk(),
    networkName(),
    includeSecurity ? securityPosture() : Promise.resolve(null),
  ]);
  const total = os.totalmem();
  return {
    cpuPercent: cpu,
    memoryPercent: Math.round(((total - os.freemem()) / total) * 1000) / 10,
    memoryTotalMb: Math.round(total / 1048576),
    diskFreeMb: disk?.freeMb ?? null,
    diskTotalMb: disk?.totalMb ?? null,
    uptimeMinutes: Math.round(os.uptime() / 60),
    cpuModel: os.cpus()[0]?.model?.trim() ?? null,
    cpuCores: os.cpus().length,
    networkName: network.name,
    networkType: network.type,
    agentVersion,
    security,
  };
}

/**
 * Position from the Windows Location API (Settings → Privacy → Location must be on).
 * Tries the WinRT Geolocator first, then the legacy System.Device watcher.
 */
export async function collectLocation(): Promise<LocationSample | null> {
  if (process.platform !== 'win32') return null;
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
    const { stdout } = await run('powershell.exe', [...PS, script], { timeout: 45000, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || 'null') as { latitude: number; longitude: number; accuracy: number } | null;
    if (!parsed || !Number.isFinite(parsed.latitude) || !Number.isFinite(parsed.longitude)) return null;
    if (parsed.latitude === 0 && parsed.longitude === 0) return null;
    const network = await networkName();
    return {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      accuracyM: Math.round(Number(parsed.accuracy) || 0),
      source: 'windows_location',
      networkName: network.name,
    };
  } catch {
    return null;
  }
}
