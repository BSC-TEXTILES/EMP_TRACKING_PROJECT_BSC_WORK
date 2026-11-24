using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace BscTracker
{
    /// <summary>
    /// Visible system-tray application. The tray icon is always shown while the
    /// agent runs: green = tracking and synchronised, amber = offline / data waiting,
    /// grey = paused (policy, notice not yet acknowledged), red = not registered.
    /// </summary>
    internal sealed class TrayApp : ApplicationContext
    {
        readonly NotifyIcon tray = new NotifyIcon();
        readonly Control ui = new Control();
        readonly EventQueue queue = new EventQueue();
        readonly Bridge bridge = new Bridge();
        readonly Collector collector;
        readonly System.Windows.Forms.Timer tickTimer = new System.Windows.Forms.Timer();
        readonly System.Windows.Forms.Timer flushTimer = new System.Windows.Forms.Timer();
        readonly AutoResetEvent syncSignal = new AutoResetEvent(false);
        readonly AutoResetEvent heartbeatSignal = new AutoResetEvent(false);
        readonly string server;
        DeviceIdentity identity;
        volatile bool shuttingDown;
        volatile bool trackingEnabledByPolicy = true;
        volatile int heartbeatSeconds = 60, syncSeconds = 30;
        volatile string lastError;
        volatile bool connected;
        DateTime lastHeartbeatUtc = DateTime.MinValue, lastSyncUtc = DateTime.MinValue;
        int syncFailures;
        string noticeText = "";
        string updateNotice;
        StatusForm statusForm;
        EnrollForm enrollForm;
        NoticeForm noticeForm;
        readonly Dictionary<string, Icon> icons = new Dictionary<string, Icon>();

        public TrayApp(string serverUrl, string enrollCode)
        {
            server = serverUrl;
            ui.CreateControl();
            collector = new Collector(queue, bridge);
            bridge.WebsiteTrackingAllowed = delegate { return collector.WebsiteTracking && collector.Enabled; };

            tray.Text = Product.Name;
            tray.Visible = true;
            tray.DoubleClick += delegate { ShowStatus(); };
            BuildMenu();

            identity = DeviceIdentity.Load();
            if (identity != null && identity.ServerUrl != null && !string.Equals(identity.ServerUrl, server, StringComparison.OrdinalIgnoreCase))
            {
                Log.Warn("Server address changed; this computer must be registered again.");
                identity = null;
                DeviceIdentity.Delete();
            }

            SystemEvents.SessionSwitch += OnSessionSwitch;
            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            SystemEvents.SessionEnding += OnSessionEnding;
            Application.ApplicationExit += delegate { Shutdown("agent_exit", false); };

            tickTimer.Interval = 1000;
            tickTimer.Tick += delegate { try { collector.Tick(); } catch (Exception ex) { Log.Error("Sampling error: " + ex.Message); } };
            flushTimer.Interval = 5000;
            flushTimer.Tick += delegate { queue.Flush(); RefreshTray(); };
            tickTimer.Start();
            flushTimer.Start();

            bridge.Start();
            StartBackground("heartbeat", HeartbeatLoop);
            StartBackground("upload", UploadLoop);
            StartBackground("shutdown-listener", ShutdownListener);

            if (identity == null && !string.IsNullOrEmpty(enrollCode))
            {
                string error;
                if (!Enroll(enrollCode, out error))
                {
                    Log.Warn("Scripted enrollment failed: " + error);
                    RefreshTray();
                    ShowEnroll();
                }
            }
            else if (identity == null)
            {
                RefreshTray();
                ShowEnroll();
            }
            else
            {
                BeginTracking();
            }
            Log.Info("Agent " + Product.Version + " started for this Windows user.");
        }

        static void StartBackground(string name, ThreadStart work)
        {
            Thread t = new Thread(work) { IsBackground = true, Name = name };
            t.Start();
        }

        void OnUi(Action action)
        {
            if (shuttingDown && !ui.IsHandleCreated) return;
            try { if (ui.InvokeRequired) ui.BeginInvoke(action); else action(); } catch { }
        }

        // ---------------------------------------------------------------- lifecycle
        void BeginTracking()
        {
            collector.StartSession();
            collector.SetEnabled(identity.NoticeAcknowledged && trackingEnabledByPolicy, false);
            heartbeatSignal.Set();
            RefreshTray();
            if (!identity.NoticeAcknowledged) ShowNotice();
        }

        void Shutdown(string reason, bool exitApp)
        {
            if (shuttingDown) return;
            shuttingDown = true;
            try
            {
                tickTimer.Stop();
                flushTimer.Stop();
                collector.StopSession(reason);
                queue.Flush(); // durable on disk; anything not uploaded now syncs on next start
                // Sign-out/shutdown give the app only seconds, so upload only on a deliberate exit.
                if (identity != null && reason == "agent_exit") UploadOnce(1);
            }
            catch (Exception ex) { Log.Error("Shutdown: " + ex.Message); }
            bridge.Stop();
            tray.Visible = false;
            tray.Dispose();
            if (exitApp) Application.Exit();
        }

        void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            Shutdown(e.Reason == SessionEndReasons.SystemShutdown ? "system_shutdown" : "signed_out", true);
        }

        void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
        {
            switch (e.Reason)
            {
                case SessionSwitchReason.SessionLock:
                case SessionSwitchReason.ConsoleDisconnect:
                case SessionSwitchReason.RemoteDisconnect:
                    collector.OnLock();
                    break;
                case SessionSwitchReason.SessionUnlock:
                case SessionSwitchReason.ConsoleConnect:
                case SessionSwitchReason.RemoteConnect:
                    collector.OnUnlock();
                    break;
            }
            RefreshTray();
        }

        void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode == PowerModes.Suspend) collector.OnSuspend();
            else if (e.Mode == PowerModes.Resume) { collector.OnResume(); heartbeatSignal.Set(); syncSignal.Set(); }
        }

        /// <summary>The installer signals this event to stop agents gracefully before update/uninstall.</summary>
        void ShutdownListener()
        {
            try
            {
                EventWaitHandle handle;
                if (!EventWaitHandle.TryOpenExisting(Product.ShutdownEventName, out handle))
                {
                    bool created;
                    handle = new EventWaitHandle(false, EventResetMode.ManualReset, Product.ShutdownEventName, out created);
                }
                handle.WaitOne();
                Log.Info("Installer requested shutdown.");
                OnUi(delegate { Shutdown("agent_update", true); });
            }
            catch (Exception ex) { Log.Warn("Shutdown listener unavailable: " + ex.Message); }
        }

        // ---------------------------------------------------------------- network loops
        void HeartbeatLoop()
        {
            while (!shuttingDown)
            {
                heartbeatSignal.WaitOne(TimeSpan.FromSeconds(Math.Max(15, heartbeatSeconds)));
                if (shuttingDown) break;
                DeviceIdentity id = identity;
                if (id == null) continue;
                Dictionary<string, object> body = new Dictionary<string, object>();
                body["state"] = collector.LiveState == "idle" || collector.LiveState == "locked" ? collector.LiveState : "active";
                body["currentApp"] = collector.LiveApp;
                body["currentBrowser"] = collector.LiveBrowser;
                body["currentDomain"] = collector.LiveDomain;
                body["pendingEvents"] = queue.PendingCount;
                body["droppedEvents"] = queue.Dropped;
                body["syncFailures"] = syncFailures;
                body["lastError"] = lastError;
                body["agentVersion"] = Product.Version;
                body["osVersion"] = Environment.OSVersion.Version.ToString();
                body["trackingPaused"] = !collector.Enabled;
                if (collector.SessionId != null) { body["sessionId"] = collector.SessionId; body["sessionStartedAt"] = Api.Iso(collector.SessionStartedUtc); }
                DateTime extSeen = bridge.LastSeenUtc != DateTime.MinValue ? bridge.LastSeenUtc
                    : (collector.WebsiteTracking && !string.IsNullOrEmpty(collector.LiveDomain)) ? DateTime.UtcNow : DateTime.MinValue;
                if (extSeen != DateTime.MinValue) body["extensionSeenAt"] = Api.Iso(extSeen);
                body["sentAt"] = Api.IsoNow();
                ApiResult result = Api.Post(server, "/tracking/agent/heartbeat", body, id.Token);
                if (result.Ok)
                {
                    connected = true;
                    lastError = null;
                    syncFailures = 0;
                    lastHeartbeatUtc = DateTime.UtcNow;
                    ApplyServerState(result.Body);
                }
                else if (result.Unauthorized)
                {
                    OnUi(delegate { HandleRevoked(result.Error); });
                }
                else
                {
                    connected = false;
                    if (result.NetworkFailure) lastError = result.Error;
                }
                OnUi(RefreshTray);
            }
        }

        void ApplyServerState(Dictionary<string, object> body)
        {
            if (body == null) return;
            Dictionary<string, object> cfg = Api.Dict(body, "config");
            bool enabled = Api.Bool(body, "trackingEnabled", true);
            bool noticeRequired = Api.Bool(body, "noticeRequired", false);
            string token = Api.Str(body, "newToken");
            string text = Api.Str(body, "noticeText");
            Dictionary<string, object> employee = Api.Dict(body, "employee");
            Dictionary<string, object> update = Api.Dict(body, "update");
            OnUi(delegate
            {
                DeviceIdentity id = identity;
                if (id == null) return;
                bool changed = false;
                if (token != null && token.StartsWith("bsct_")) { id.Token = token; changed = true; Log.Info("Device credential rotated."); }
                if (employee != null)
                {
                    string name = Api.Str(employee, "name");
                    if (name != null && name != id.EmployeeName) { id.EmployeeName = name; id.EmployeeCode = Api.Str(employee, "code"); id.Location = Api.Str(employee, "location"); changed = true; }
                }
                // The server is the record of acknowledgement (e.g. reassigned device, or acknowledged earlier).
                if (noticeRequired && id.NoticeAcknowledged) { id.NoticeAcknowledged = false; changed = true; }
                else if (!noticeRequired && !id.NoticeAcknowledged)
                {
                    id.NoticeAcknowledged = true; changed = true;
                    if (noticeForm != null && !noticeForm.IsDisposed) noticeForm.Close();
                }
                if (changed) id.Save();
                if (text != null) noticeText = text;
                if (cfg != null)
                {
                    collector.IdleThresholdSeconds = Math.Max(60, Api.Int(cfg, "idleThresholdSeconds", 300));
                    collector.AppTracking = Api.Bool(cfg, "appTracking", true);
                    collector.WebsiteTracking = Api.Bool(cfg, "websiteTracking", true);
                    collector.WindowTitles = Api.Bool(cfg, "windowTitles", false);
                    heartbeatSeconds = Math.Max(15, Api.Int(cfg, "heartbeatIntervalSeconds", 60));
                    syncSeconds = Math.Max(10, Api.Int(cfg, "syncIntervalSeconds", 30));
                }
                trackingEnabledByPolicy = enabled;
                collector.SetEnabled(enabled && id.NoticeAcknowledged, !enabled);
                if (!id.NoticeAcknowledged && noticeForm == null) ShowNotice();
                string latest = update != null ? Api.Str(update, "latestVersion") : null;
                if (latest != null && updateNotice != latest)
                {
                    updateNotice = latest;
                    bool required = Api.Bool(update, "required", false);
                    string downloadPath = Api.Str(update, "downloadPath");
                    string expectedSha256 = Api.Str(update, "sha256");
                    tray.ShowBalloonTip(10000, Product.Name, "Version " + latest + " is available" + (required ? " and required by your administrator" : "") + ". Ask IT to update, or download it from the HRMS.", required ? ToolTipIcon.Warning : ToolTipIcon.Info);
                    if (required && !string.IsNullOrEmpty(downloadPath))
                    {
                        StartBackground("auto-update", delegate { ApplySecureUpdate(latest, downloadPath, expectedSha256); });
                    }
                }
                RefreshTray();
            });
        }

        void ApplySecureUpdate(string targetVersion, string downloadPath, string expectedSha256)
        {
            string destFile = null;
            FileStream hold = null;
            try
            {
                DeviceIdentity id = identity;
                if (id == null) return;
                if (string.IsNullOrEmpty(expectedSha256))
                {
                    Log.Warn("Update " + targetVersion + " offered without a SHA-256; ignored.");
                    return;
                }
                Log.Info("Starting verified update download for version " + targetVersion + "...");
                string dir = Path.Combine(Path.GetTempPath(), "BSCActivityTrackerUpdate");
                Directory.CreateDirectory(dir);
                destFile = Path.Combine(dir, "BSC-Activity-Tracker-Setup-" + targetVersion + ".exe");
                string downloadErr;
                if (!Api.DownloadFile(server, downloadPath, destFile, id.Token, out downloadErr))
                {
                    Log.Warn("Update download failed: " + downloadErr);
                    return;
                }

                // Hold a read lock from verification until the installer has started, so the
                // verified file cannot be swapped for another one in between.
                hold = new FileStream(destFile, FileMode.Open, FileAccess.Read, FileShare.Read);
                string computedHash = SignatureVerifier.FileSha256Hex(destFile);
                if (!string.Equals(computedHash, expectedSha256.Trim(), StringComparison.OrdinalIgnoreCase))
                {
                    Log.Error("SECURITY ALERT: Update file hash mismatch! Expected: " + expectedSha256 + ", got: " + computedHash);
                    return;
                }
                string signErr;
                if (!SignatureVerifier.VerifyPublisher(destFile, out signErr))
                {
                    Log.Error("SECURITY ALERT: Update rejected: " + signErr);
                    return;
                }

                Log.Info("Update verified (WinVerifyTrust + publisher + SHA-256). Starting installer...");
                ProcessStartInfo psi = new ProcessStartInfo(destFile, "/repair /quiet");
                psi.UseShellExecute = true;
                psi.Verb = "runas";
                Process.Start(psi);
                Thread.Sleep(3000);
                destFile = null; // keep the file; the installer is using it
            }
            catch (Exception ex)
            {
                Log.Error("Auto-update error: " + ex.Message);
            }
            finally
            {
                if (hold != null) hold.Dispose();
                if (destFile != null) { try { File.Delete(destFile); } catch { } }
            }
        }

        void UploadLoop()
        {
            int backoff = 0;
            while (!shuttingDown)
            {
                int wait = backoff > 0 ? backoff : Math.Max(10, syncSeconds);
                syncSignal.WaitOne(TimeSpan.FromSeconds(wait));
                if (shuttingDown) break;
                int outcome = UploadOnce(20);
                if (outcome < 0) backoff = Math.Min(300, backoff == 0 ? 15 : backoff * 2);
                else backoff = 0;
                OnUi(RefreshTray);
            }
        }

        readonly object uploadGate = new object();

        /// <summary>Uploads up to maxBatches batches. Returns -1 on network failure, else batches sent.</summary>
        int UploadOnce(int maxBatches)
        {
            lock (uploadGate)
            {
                int sent = 0;
                for (int n = 0; n < maxBatches; n++)
                {
                    DeviceIdentity id = identity;
                    if (id == null || !id.NoticeAcknowledged) return sent;
                    queue.Flush();
                    EventQueue.Batch batch = queue.Take(500);
                    if (batch.Events.Count == 0)
                    {
                        lastSyncUtc = DateTime.UtcNow;
                        if (connected) { lastError = null; syncFailures = 0; }
                        return sent;
                    }
                    string batchKey = Secure.Sha256Hex(string.Join("|", batch.Files.Select(f => System.IO.Path.GetFileName(f)).ToArray())).Substring(0, 40);
                    int part = 0;
                    foreach (List<Dictionary<string, object>> chunk in EventQueue.Chunk(batch.Events, 500))
                    {
                        Dictionary<string, object> body = new Dictionary<string, object>();
                        body["batchId"] = "b-" + batchKey + "-" + (part++);
                        body["sentAt"] = Api.IsoNow();
                        body["events"] = chunk;
                        ApiResult result = Api.Post(server, "/tracking/agent/events", body, id.Token);
                        if (result.Unauthorized)
                        {
                            OnUi(delegate { HandleRevoked(result.Error); });
                            return -1;
                        }
                        if (result.NetworkFailure)
                        {
                            syncFailures++;
                            lastError = result.Error;
                            connected = false;
                            Log.Warn("Upload deferred: " + result.Error + " (" + queue.PendingCount + " event(s) kept offline)");
                            return -1;
                        }
                        if (!result.Ok)
                        {
                            // A permanent rejection of the whole batch: keeping it would block the queue forever.
                            syncFailures++;
                            lastError = !string.IsNullOrEmpty(result.Error) ? "Upload rejected: " + result.Error : "Server refused event batch";
                            Log.Error("Server refused a batch of " + chunk.Count + " event(s): " + result.Error + ". Batch discarded.");
                            continue;
                        }
                        object rejected;
                        if (result.Body != null && result.Body.TryGetValue("rejected", out rejected))
                        {
                            System.Collections.ArrayList list = rejected as System.Collections.ArrayList;
                            if (list != null && list.Count > 0)
                            {
                                Dictionary<string, int> reasons = new Dictionary<string, int>();
                                foreach (object r in list)
                                {
                                    string reason = Api.Str(r as Dictionary<string, object>, "reason") ?? "unknown";
                                    int c; reasons.TryGetValue(reason, out c); reasons[reason] = c + 1;
                                }
                                Log.Warn("Server rejected " + list.Count + " event(s): " + string.Join(", ", reasons.Select(kv => kv.Key + "=" + kv.Value).ToArray()));
                            }
                        }
                    }
                    queue.Acknowledge(batch);
                    lastSyncUtc = DateTime.UtcNow;
                    lastError = null;
                    connected = true;
                    syncFailures = 0;
                    sent++;
                }
                return sent;
            }
        }

        void HandleRevoked(string message)
        {
            if (identity == null) return;
            Log.Warn("Device registration is no longer valid: " + message);
            collector.StopSession("device_revoked");
            identity = null;
            DeviceIdentity.Delete();
            // Queued data cannot be attributed safely to any other registration.
            foreach (string f in System.IO.Directory.GetFiles(Paths.QueueDir, "q-*.dat")) { try { System.IO.File.Delete(f); } catch { } }
            RefreshTray();
            tray.ShowBalloonTip(10000, Product.Name, "This computer's tracking registration was removed by an administrator. Tracking has stopped.", ToolTipIcon.Warning);
        }

        // ---------------------------------------------------------------- enrollment / notice
        public bool Enroll(string code, out string error)
        {
            error = null;
            string sid = Paths.UserSid.Value;
            string machineGuid = Product.ReadMachineSetting("MachineGuidFallback", null);
            try
            {
                using (RegistryKey key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
                    if (key != null && key.GetValue("MachineGuid") != null) machineGuid = key.GetValue("MachineGuid").ToString();
            }
            catch { }
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["enrollmentCode"] = code;
            body["deviceUid"] = Secure.Sha256Hex("bsc-trk|" + (machineGuid ?? Environment.MachineName) + "|" + sid);
            body["hostname"] = Environment.MachineName;
            body["osName"] = "Windows";
            body["osVersion"] = Environment.OSVersion.Version.ToString();
            body["agentVersion"] = Product.Version;
            ApiResult result = Api.Post(server, "/tracking/agent/enroll", body, null);
            if (!result.Ok)
            {
                error = result.Error ?? "Registration failed.";
                Log.Warn("Enrollment failed: HTTP " + result.Status);
                return false;
            }
            Dictionary<string, object> employee = Api.Dict(result.Body, "employee");
            DeviceIdentity id = new DeviceIdentity();
            id.Token = Api.Str(result.Body, "deviceToken");
            id.DeviceId = Api.Int(result.Body, "deviceId", 0);
            id.EmployeeName = Api.Str(employee, "name");
            id.EmployeeCode = Api.Str(employee, "code");
            id.Location = Api.Str(employee, "location");
            id.ServerUrl = server;
            id.NoticeAcknowledged = false;
            noticeText = Api.Str(result.Body, "noticeText") ?? noticeText;
            if (string.IsNullOrEmpty(id.Token)) { error = "The server did not return a device credential."; return false; }
            id.Save();
            identity = id;
            Log.Info("Computer registered (device #" + id.DeviceId + ").");
            BeginTracking();
            return true;
        }

        public bool Acknowledge(out string error)
        {
            error = null;
            DeviceIdentity id = identity;
            if (id == null) { error = "This computer is not registered."; return false; }
            ApiResult result = Api.Post(server, "/tracking/agent/acknowledge", new Dictionary<string, object>(), id.Token);
            if (!result.Ok) { error = result.Error ?? "Could not reach the server. Try again when online."; return false; }
            id.NoticeAcknowledged = true;
            id.Save();
            collector.SetEnabled(trackingEnabledByPolicy, false);
            heartbeatSignal.Set();
            RefreshTray();
            Log.Info("Monitoring notice acknowledged.");
            return true;
        }

        void ShowEnroll()
        {
            if (enrollForm != null && !enrollForm.IsDisposed) { enrollForm.Activate(); return; }
            enrollForm = new EnrollForm(this, server);
            enrollForm.FormClosed += delegate { enrollForm = null; };
            enrollForm.Show();
        }

        void ShowNotice()
        {
            if (noticeForm != null && !noticeForm.IsDisposed) { noticeForm.Activate(); return; }
            noticeForm = new NoticeForm(this, noticeText, identity != null && identity.NoticeAcknowledged);
            noticeForm.FormClosed += delegate { noticeForm = null; };
            noticeForm.Show();
        }

        void ShowStatus()
        {
            if (statusForm != null && !statusForm.IsDisposed) { statusForm.Activate(); return; }
            statusForm = new StatusForm(this);
            statusForm.FormClosed += delegate { statusForm = null; };
            statusForm.Show();
        }

        // ---------------------------------------------------------------- tray
        void BuildMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Tracking status…", null, delegate { ShowStatus(); });
            menu.Items.Add("Monitoring notice…", null, delegate { ShowNotice(); });
            menu.Items.Add("Register this computer…", null, delegate { ShowEnroll(); });
            menu.Items.Add("Synchronise now", null, delegate { syncSignal.Set(); heartbeatSignal.Set(); });
            menu.Items.Add("Open HRMS", null, delegate { try { Process.Start(server); } catch { } });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit tracker", null, delegate
            {
                if (MessageBox.Show("Exit the activity tracker?\n\nTracking stops until you sign in again. HR will see that the tracker was closed.",
                    Product.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                {
                    Shutdown("agent_exit", true);
                }
            });
            menu.Opening += delegate { menu.Items[2].Visible = identity == null; menu.Items[1].Enabled = identity != null; };
            tray.ContextMenuStrip = menu;
        }

        public sealed class Snapshot
        {
            public string Headline, Employee, Location, Device, Server, Tracking, State, Heartbeat, Sync, Pending, Extension, Version, Error;
            public string Color;
        }

        public Snapshot Status()
        {
            Snapshot s = new Snapshot();
            DeviceIdentity id = identity;
            int pending = queue.PendingCount;
            s.Server = server;
            s.Version = Product.Version;
            s.Device = Environment.MachineName + (id != null && id.DeviceId > 0 ? "  (#" + id.DeviceId + ")" : "");
            s.Employee = id == null ? "Not registered" : (id.EmployeeName ?? "") + (id.EmployeeCode != null ? "  (" + id.EmployeeCode + ")" : "");
            s.Location = id != null ? (id.Location ?? "—") : "—";
            s.Heartbeat = lastHeartbeatUtc == DateTime.MinValue ? "—" : lastHeartbeatUtc.ToLocalTime().ToString("dd MMM yyyy  hh:mm:ss tt");
            s.Sync = lastSyncUtc == DateTime.MinValue ? "—" : lastSyncUtc.ToLocalTime().ToString("dd MMM yyyy  hh:mm:ss tt");
            s.Pending = pending.ToString() + (queue.Dropped > 0 ? "  (" + queue.Dropped + " discarded: storage full)" : "");
            if (bridge.LastSeenUtc != DateTime.MinValue && (DateTime.UtcNow - bridge.LastSeenUtc).TotalMinutes < 10)
            {
                s.Extension = "Connected (Browser extension)";
            }
            else if (collector.WebsiteTracking)
            {
                s.Extension = "Active (Native detection)";
            }
            else
            {
                s.Extension = "Disabled by company policy";
            }
            s.Error = lastError;
            string live = collector.LiveState;
            s.State = !collector.Enabled ? "—" : live == "active" ? "Active" : live == "idle" ? "Idle" : live == "locked" ? "Locked" : "—";
            if (id == null) { s.Color = "red"; s.Headline = "Not registered"; s.Tracking = "Off — this computer is not registered"; }
            else if (!id.NoticeAcknowledged) { s.Color = "grey"; s.Headline = "Waiting for notice acknowledgement"; s.Tracking = "Paused — please read and acknowledge the monitoring notice"; }
            else if (!trackingEnabledByPolicy) { s.Color = "grey"; s.Headline = "Tracking disabled by administrator"; s.Tracking = "Off — disabled by company policy"; }
            else if (!connected) { s.Color = "amber"; s.Headline = "Tracking (offline)"; s.Tracking = "On — offline, data is stored securely and will sync automatically"; }
            else if (pending > 0 && lastSyncUtc != DateTime.MinValue && (DateTime.UtcNow - lastSyncUtc).TotalMinutes > 5) { s.Color = "amber"; s.Headline = "Tracking (sync delayed)"; s.Tracking = "On — upload delayed"; }
            else { s.Color = "green"; s.Headline = "Tracking active"; s.Tracking = "On — connected and synchronised"; }
            return s;
        }

        void RefreshTray()
        {
            if (shuttingDown) return;
            Snapshot s = Status();
            tray.Icon = IconFor(s.Color);
            string text = Product.Name + "\n" + s.Headline + (s.Pending != "0" ? "\nPending: " + s.Pending : "");
            tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        }

        Icon IconFor(string color)
        {
            Icon icon;
            if (icons.TryGetValue(color, out icon)) return icon;
            Color fill = color == "green" ? Color.FromArgb(22, 163, 74) : color == "amber" ? Color.FromArgb(217, 119, 6) : color == "red" ? Color.FromArgb(220, 38, 38) : Color.FromArgb(120, 120, 120);
            using (Bitmap bmp = new Bitmap(32, 32))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush brush = new SolidBrush(fill)) g.FillEllipse(brush, 1, 1, 30, 30);
                using (Font font = new Font("Segoe UI", 15, FontStyle.Bold, GraphicsUnit.Pixel))
                using (StringFormat fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    g.DrawString("B", font, Brushes.White, new RectangleF(0, 1, 32, 32), fmt);
                icon = Icon.FromHandle(bmp.GetHicon());
            }
            icons[color] = icon;
            return icon;
        }
    }
}
