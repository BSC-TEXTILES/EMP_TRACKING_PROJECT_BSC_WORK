# BSC Activity Tracker — Windows agent

Source code is in `tracking-agent/`. The agent is a visible system-tray application
(`BSCActivityTracker.exe`) with a self-contained installer
(`BSC-Activity-Tracker-Setup.exe`). Both target the .NET Framework 4.8, which is
built into Windows 10 and 11, so nothing else needs to be installed on employee PCs.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1 `
  -Server https://emptrack.bsctextiles.in `
  -SignCertThumbprint <code-signing certificate thumbprint>
```

* The build uses the C# compiler that ships with Windows
  (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`). No SDK or NuGet is needed.
* The outputs go to `tracking-agent/dist/`: `BSC-Activity-Tracker-Setup.exe` (with
  the agent embedded), `BSCActivityTracker.exe` and `SHA256SUMS.txt`.
* **Sign every release.** Windows Smart App Control and WDAC block unsigned executables
  (this was observed on the development PC). Use an organisation code-signing
  certificate; signtool must be installed from the Windows SDK.
* Publish the installer to the server
  (`tracking-agent/dist/` or the path in `TRACKING_AGENT_INSTALLER`). Administrators
  can then download it from *User Activity Tracking → Devices & enrollment*.

## Install (administrator)

| Action | Command |
|---|---|
| Interactive | Run `BSC-Activity-Tracker-Setup.exe` (requests elevation) |
| Silent install | `BSC-Activity-Tracker-Setup.exe /install /server=https://emptrack.bsctextiles.in /quiet` |
| Update / repair | Run the new Setup with `/install /quiet`, or `/repair`, or use *Modify* in *Apps & features* |
| Uninstall | *Apps & features → BSC Activity Tracker → Uninstall*, or `"%ProgramFiles%\BSC Textiles\Activity Tracker\BSC-Activity-Tracker-Setup.exe" /uninstall /quiet` |

Exit codes: 0 = success, 1 = failure, 2 = invalid arguments, 5 = not elevated.
The install log is written to `%ProgramData%\BSC Textiles\Activity Tracker\install.log`.

**What setup does**

* Copies the agent to `%ProgramFiles%\BSC Textiles\Activity Tracker\`.
* Writes `HKLM\SOFTWARE\BSC Textiles\Activity Tracker` (`ServerUrl`, `Version`).
* Adds `HKLM\…\Run\BSCActivityTracker`, so the agent starts for **every Windows user at sign-in**.
* Adds a Start-menu shortcut and an *Apps & features* entry.
* Creates the protected data folder.
* Starts the agent un-elevated for the signed-in user.

**Updating** first signals running agents to stop gracefully, through the event
`Global\BSCActivityTrackerShutdown`. The agents flush their queues, so no data is lost.

**Uninstall:**
1. Stops the agents.
2. Uploads any events still waiting on the PC.
3. Unenrolls every user's device on the server.
4. Removes the files, registry entries, shortcut and data.

## Enroll (per Windows user)

1. An administrator generates an enrollment code for the employee in
   *User Activity Tracking → Devices & enrollment → Enrollment code*.
   The code is single-use and valid for 72 hours.
2. At first sign-in, the tray app opens **Register this computer**. Enter the code.
   IT can also run `BSCActivityTracker.exe --enroll=ABCDE-23456` in the employee's session.
3. The employee reads and acknowledges the **monitoring notice**. Collection begins only
   after this, and the server rejects events from unacknowledged devices.

The device identity is `SHA-256(MachineGuid | Windows user SID)`. Shared PCs with separate
Windows accounts therefore map each account to its own employee. Moving a computer to another
employee requires a code issued by an administrator; otherwise the server returns 409.

## Tray icon

| Colour | Meaning |
|---|---|
| Green | Tracking, connected and synchronised |
| Amber | Tracking while offline, or upload delayed (data is kept safely on the PC) |
| Grey | Paused: notice not yet acknowledged, or tracking disabled by policy |
| Red | Not registered, or the registration was revoked |

**Menu:** Tracking status, Monitoring notice, Register this computer, Synchronise now,
Open HRMS, Exit tracker. Exit asks for confirmation and is recorded as `agent_stop`.

## Behaviour

* **Sampling** happens every second using native Win32 calls: the foreground window's
  process (UWP-aware), the time since last input, and lock/unlock, sleep/wake and
  sign-out events. No PowerShell processes are spawned.
* **Idle detection:** idle starts when there has been no input for the configured
  threshold, and is back-dated to the last input. A lock that comes after inactivity
  counts that inactive time as idle.
* **Intervals** roll over every 60 s. Clock jumps and missed sleep events produce a
  gap rather than invented activity.
* **Offline queue:** events are flushed every 5 s to DPAPI-protected (LocalMachine
  scope) segment files in `%ProgramData%\BSC Textiles\Activity Tracker\data\<SID>\queue`.
  That folder's ACL allows only the user, SYSTEM and Administrators.
  * Segments are uploaded oldest first, in batches of up to 500 events, and deleted
    only after the server acknowledges them.
  * If a network or server error occurs, the agent retries with backoff from 15 s up
    to 5 min.
  * If the server rejects the whole batch, it is discarded, so the queue can never
    become stuck.
  * The queue holds at most 250,000 events. Beyond that the oldest are discarded, and
    the count is reported in the heartbeat and shown in the HRMS.
* **Revocation:** a 401 response stops tracking, removes the identity and deletes the
  queued data, so it cannot be attributed to anyone else.
* **Security:**
  * HTTPS is required for servers other than this machine; set
    `HKLM\…\Activity Tracker\AllowInsecureHttp = "1"` only for a lab.
  * The token is rotated automatically 30 days before it expires.
* **Logs** are kept in `…\data\<SID>\logs\agent-YYYYMMDD.log` for 14 days. They hold
  states, counts and errors only.

## Test checklist (run on a signed build, on a company PC)

| # | Test | Expected |
|---|---|---|
| 1 | Clean install with `/install /quiet` | *Apps & features* entry, Run key and tray icon appear; `install.log` shows success |
| 2 | Enroll with a code | Device appears under *Devices* with the right employee and location |
| 3 | Acknowledge the notice | Icon turns green; heartbeat shown in the HRMS within 60 s |
| 4 | Switch between Excel, Chrome and Tally | Applications appear in section C with the right times |
| 5 | Leave the PC with no input beyond the threshold | Idle start is back-dated; status shows **Idle** |
| 6 | Win+L, wait, unlock | Lock/unlock in the timeline; locked time counted |
| 7 | Sleep and wake | Gap listed as "Computer asleep" |
| 8 | Disconnect the network for 10 min, then reconnect | Icon turns amber, pending count rises, then data syncs; no duplicates; batch marked as a replay |
| 9 | Restart Windows | Same device (no re-enrollment); new session; earlier queue uploaded |
| 10 | Install the browser connector and visit sites | Domains appear in section D, with time counted only while the browser is the active, active-state application |
| 11 | Revoke the device in the HRMS | Tracking stops within one heartbeat; icon turns red |
| 12 | Re-run setup (update) while the agent is running | Agent stops gracefully and restarts; no data loss |
| 13 | Uninstall | Pending data uploaded, device unenrolled, files and registry removed |
