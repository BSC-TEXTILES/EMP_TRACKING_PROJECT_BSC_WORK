# LiveGuard Pro → Activity integration

LiveGuard Pro (`LiveGuard-Pro-Tracking/`) was a standalone tracker: an Electron agent, an
Express/Socket.io telemetry hub on port 4000 and a separate Next.js dashboard. Its useful
features now run inside the Workforce **Activity** module, on the existing authenticated
agent, consent policy, database and permissions. The separate LiveGuard apps are no longer
needed and should not be deployed (see [What was not ported](#what-was-not-ported-and-why)).

## What you get

| Feature | Where it appears | How it is collected |
|---|---|---|
| Live device board | Activity → **Devices & Location** | Agent heartbeat + health report |
| CPU, memory, disk, uptime, processor | Device card and detail panel | Node `os` counters and `fs.statfs`, every 5 min |
| Connected network (Wi-Fi name or Ethernet) | Device card | `netsh wlan show interfaces` (connected network only) |
| Device security posture | "Protected / At risk / Threat found" badge | Windows Defender `Get-MpComputerStatus`, `Get-MpThreatDetection`, firewall profiles, every 30 min |
| Threat alerts | Activity → errors / support ticket | A Defender detection raises a *Security threat detected* incident |
| Device location + map | Detail panel, OpenStreetMap embed, daily trail | Windows Location API, at the policy interval, **opt-in** |

## Who can see it

- `activity.view.all` or `activity.devices.manage` (Super Admin, Executive, HR Manager, IT Admin):
  every device.
- `activity.view.team` (managers, store managers): employees at the locations they manage.
- Employees never see other people's devices. Each view of a location trail is written to the
  monitoring audit log (`activity.location_viewed`).

## Turning on location tracking

Location is **off by default**.

1. Open Activity → **Monitoring policy** → *Policy configuration* (needs `activity.policy.manage`).
2. Tick **Record device location** and choose the interval (5–240 minutes, default 15).
3. Save. This creates a new policy version, so **every employee must acknowledge the policy
   again** before the agent may send a position.
4. On each PC, Windows *Settings → Privacy & security → Location* must be on.

The server only accepts a position when the policy allows it, the employee has acknowledged
that version, and a work session is active. Positions less accurate than 50 km (IP guesses)
are rejected. Location rows follow the policy's retention period and are removed by
*Run retention cleanup*.

## Running the agent

The agent is `agent/` (version 1.1.0). On each Windows PC:

```bat
cd agent
start-agent.bat
```

It signs in, registers the device, checks attendance and consent, then sends activity,
heartbeats, a health report every 5 minutes and, if enabled, the location. Everything is
queued encrypted when offline. See `agent/README.md`.

## API (added)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/activity/agent/health` | device token | CPU/memory/disk/network/Defender sample (now validated; rate-limited 20/min) |
| POST | `/api/activity/agent/location` | device token | Position sample; returns `{accepted, reason}` |
| GET | `/api/activity/live-devices` | session | Live board for the viewer's scope |
| GET | `/api/activity/devices/:id/locations?date=YYYY-MM-DD` | session | Day trail for one device (audited) |
| PUT | `/api/activity/policy` | `activity.policy.manage` | Now also accepts `locationTrackingEnabled`, `locationIntervalMinutes` |

Database: migration `029_device_telemetry.sql` adds `monitoring_policies.location_tracking_enabled`,
`monitoring_policies.location_interval_minutes` and the `device_location_logs` table. It runs
automatically when the backend starts.

## What was not ported, and why

These parts of LiveGuard Pro were broken, misleading or unsafe, and were deliberately left out:

| LiveGuard behaviour | Problem | Replacement |
|---|---|---|
| `keystrokeVelocity` / `mouseClicks` | Generated with `Math.random()`: fake numbers shown as real productivity data | Real foreground-app time and idle detection (already in Workforce) |
| "Forensic malware scanner" | Flagged any `.bat`/`.vbs` file by name and logged it as `QUARANTINED` without doing anything | Real Windows Defender status and detections |
| Telemetry hub `/api/telemetry/*` | No authentication: anyone could post locations or "threats" | Device-token authenticated agent endpoints |
| Hub on port 4000 | Same port as the Workforce backend; the two could not run together | Single Workforce backend |
| Electron window with `nodeIntegration: true`, `webSecurity: false` | Any page loaded in it could run code on the PC | Not needed; the web app is the dashboard |
| Location every 10 s via PowerShell, 24/7 (`isOfficeHours()` always true) | Heavy CPU, tracked people outside work, no consent | Opt-in, policy interval, only during an active work session |
| Nearby Wi-Fi BSSID scanning | Collected neighbours' network identifiers | Connected network name only |
| `get_gps.ps1` WinRT phase | Never loaded the WinRT type, so it always failed silently | Fixed loader with legacy fallback (`agent/src/telemetry.ts`) |
| `node-fetch` imports | Not a dependency, so every sync call threw | Built-in `fetch` in the Workforce agent |
| Daily log archive by UTC date | Rolled over at 05:30 IST | Server-side, timezone-aware summaries |
