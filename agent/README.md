# Workforce monitoring agent (Windows)

Transparent desktop agent that records only authorised work metadata during an active attendance session on a company-managed computer. It never captures keystrokes, clipboard content, screenshots, passwords or private application content. Screenshot evidence is not captured by this build even when the policy flag is enabled.

## Requirements

- Windows 10/11, Node.js 22+ and `tsx` (available from the repository root).
- The employee must have checked in attendance and acknowledged the monitoring policy in the web app.
- A registered device. The agent registers automatically on first run and stores its token encrypted.

## Run

```bash
WORKFORCE_URL=http://localhost:4000 \
WORKFORCE_EMAIL=employee@company.test \
WORKFORCE_PASSWORD='••••••' \
npx tsx agent/src/index.ts
```

Optional:

| Variable | Meaning |
|---|---|
| `WORKFORCE_COOKIE` | Existing session cookie, for accounts that require OTP |
| `WORKFORCE_DEVICE_TOKEN` | Reuse a device token instead of registering again |
| `WORKFORCE_DEVICE_ID` | Device id for session start with a reused token |
| `AGENT_INTERVAL_MS` | Foreground sampling interval (default 10 s, minimum 3 s) |
| `AGENT_DATA_DIR` | Queue/state directory (default `./agent-data`, mode 0700) |

Stop with `Ctrl+C`; the agent flushes its encrypted queue and ends the monitoring session.

## Behaviour

- Samples the foreground process via the Windows API (`GetForegroundWindow` → process name and PID) and records only allow-listed applications with their active duration.
- Reads recent Windows Application error events (provider, first line, record id) so crashes can open a support ticket; it never reads application content.
- Raises a sanitized connectivity incident after repeated server failures, and discards a batch the server rejects (for example after the work session ended) instead of retrying forever.
- Aggregates transitions offline in an AES-256-GCM encrypted queue (`queue.enc`) and retries until the server accepts them.
- Exits immediately if the policy is unacknowledged, attendance is not open, the device is revoked or working hours are closed.
- Sends heartbeats and, every 5 minutes, device health: CPU, memory, disk, uptime and the connected network name.
- Every 30 minutes reads Windows Defender status (antivirus, real-time protection, definitions age, firewall, detections in the last 7 days). A detection opens a security incident. No files are scanned or read by the agent.
- Device location (Windows Location API) is sent only when the monitoring policy enables it, the employee has acknowledged that policy version and a work session is active. See `docs/LIVEGUARD_INTEGRATION.md`.
- Monitoring ends as soon as the session or attendance ends.
- Unknown or blocked applications are never recorded.

## Packaging

The agent is distributed as company software. Before production use, sign the executable, pin updates to an HTTPS endpoint, review the privacy policy with employees and test on the exact Windows build in use. A Tauri/Electron tray wrapper can host this same Node core without changing the API contract.
