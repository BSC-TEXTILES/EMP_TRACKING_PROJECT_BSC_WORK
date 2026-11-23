using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("BSC Activity Tracker Setup")]
[assembly: AssemblyDescription("Installs, repairs, updates and removes the BSC Activity Tracker")]
[assembly: AssemblyCompany("BSC Textiles Pvt Ltd")]
[assembly: AssemblyProduct("BSC Activity Tracker")]
[assembly: AssemblyCopyright("Copyright © 2026 BSC Textiles Pvt Ltd. All rights reserved.")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace BscTracker
{
    /// <summary>
    /// Installer. Usage:
    ///   BSC-Activity-Tracker-Setup.exe                         interactive
    ///   BSC-Activity-Tracker-Setup.exe /install /server=https://hrms.example.com [/quiet] [/nolaunch]
    ///   BSC-Activity-Tracker-Setup.exe /repair [/quiet]
    ///   BSC-Activity-Tracker-Setup.exe /uninstall [/quiet]
    /// Exit codes: 0 success, 1 failure, 2 invalid arguments, 5 not elevated.
    /// </summary>
    internal static class SetupProgram
    {
        static bool quiet;
        static readonly string LogFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "BSC Textiles", "Activity Tracker", "install.log");

        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Dictionary<string, string> opts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string a in args)
            {
                string arg = a.TrimStart('/', '-');
                int eq = arg.IndexOf('=');
                if (eq > 0) opts[arg.Substring(0, eq)] = arg.Substring(eq + 1); else opts[arg] = "1";
            }
            quiet = opts.ContainsKey("quiet") || opts.ContainsKey("silent") || opts.ContainsKey("q");
            if (!IsElevated())
            {
                Fail("Administrator rights are required to install or remove the tracker.");
                return 5;
            }
            try
            {
                if (opts.ContainsKey("uninstall")) { Uninstall(); return 0; }
                if (opts.ContainsKey("install") || opts.ContainsKey("repair"))
                {
                    string server = opts.ContainsKey("server") ? opts["server"] : Product.ReadMachineSetting("ServerUrl", DefaultServer());
                    if (Api.ValidateServer(server) == null) { Fail("Invalid server URL (HTTPS is required): " + server); return 2; }
                    Install(Api.ValidateServer(server), !opts.ContainsKey("nolaunch"));
                    return 0;
                }
                if (quiet) { Fail("Specify /install, /repair or /uninstall with /quiet."); return 2; }
                Application.Run(new SetupForm());
                return 0;
            }
            catch (Exception ex)
            {
                Write("FAILED: " + ex);
                Fail(ex.Message);
                return 1;
            }
        }

        static bool IsElevated()
        {
            return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        }

        public static string DefaultServer()
        {
            try
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("BscTracker.Payload.default-server.txt"))
                using (StreamReader r = new StreamReader(s)) return r.ReadToEnd().Trim();
            }
            catch { return Product.DefaultServer; }
        }

        public static bool IsInstalled { get { return File.Exists(Path.Combine(Product.InstallDir, Product.ExeName)); } }

        public static void Write(string message)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
                File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine);
            }
            catch { }
        }

        static void Fail(string message)
        {
            Write("ERROR: " + message);
            if (!quiet) MessageBox.Show(message, Product.Name + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            else Console.Error.WriteLine(message);
        }

        static RegistryKey Hklm() { return RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64); }

        // ------------------------------------------------------------------ install
        public static void Install(string server, bool launch)
        {
            bool upgrade = IsInstalled;
            Write((upgrade ? "Repair/update" : "Install") + " " + Product.Version + " -> " + server);
            StopAgents();

            string dir = Product.InstallDir;
            Directory.CreateDirectory(dir);
            string exe = Path.Combine(dir, Product.ExeName);
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("BscTracker.Payload.BSCActivityTracker.exe"))
            {
                if (payload == null) throw new InvalidOperationException("Installer payload missing; rebuild the installer.");
                string temp = exe + ".new";
                using (FileStream f = File.Create(temp)) payload.CopyTo(f);
                if (File.Exists(exe)) File.Replace(temp, exe, null); else File.Move(temp, exe);
            }
            string self = Assembly.GetExecutingAssembly().Location;
            string installedSetup = Path.Combine(dir, Product.SetupName);
            if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(installedSetup), StringComparison.OrdinalIgnoreCase))
                File.Copy(self, installedSetup, true);

            PrepareDataRoot();

            using (RegistryKey key = Hklm().CreateSubKey(Product.RegistryPath))
            {
                key.SetValue("ServerUrl", server);
                key.SetValue("Version", Product.Version);
                key.SetValue("InstallDir", dir);
                key.SetValue("InstalledAt", DateTime.UtcNow.ToString("o"));
            }
            using (RegistryKey run = Hklm().CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Run"))
                run.SetValue(Product.RunValue, "\"" + exe + "\"");
            using (RegistryKey arp = Hklm().CreateSubKey(Product.UninstallKey))
            {
                arp.SetValue("DisplayName", Product.Name);
                arp.SetValue("DisplayVersion", Product.Version);
                arp.SetValue("Publisher", Product.Publisher);
                arp.SetValue("DisplayIcon", exe);
                arp.SetValue("InstallLocation", dir);
                arp.SetValue("UninstallString", "\"" + installedSetup + "\" /uninstall");
                arp.SetValue("QuietUninstallString", "\"" + installedSetup + "\" /uninstall /quiet");
                arp.SetValue("ModifyPath", "\"" + installedSetup + "\" /repair");
                arp.SetValue("NoModify", 0, RegistryValueKind.DWord);
                arp.SetValue("NoRepair", 0, RegistryValueKind.DWord);
                arp.SetValue("EstimatedSize", (int)(new FileInfo(exe).Length / 1024 + 64), RegistryValueKind.DWord);
                arp.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
            CreateShortcut(exe);
            Write("Installed to " + dir);
            if (launch) LaunchForInteractiveUser(exe);
        }

        /// <summary>
        /// %ProgramData%\BSC Textiles\Activity Tracker\data: users may create their own
        /// subfolder (which the agent then restricts to that user); nobody else can read it.
        /// </summary>
        static void PrepareDataRoot()
        {
            string root = Product.DataRoot;
            Directory.CreateDirectory(root);
            DirectorySecurity sec = new DirectorySecurity();
            sec.SetAccessRuleProtection(true, false);
            InheritanceFlags all = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, all, PropagationFlags.None, AccessControlType.Allow));
            sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, all, PropagationFlags.None, AccessControlType.Allow));
            sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                FileSystemRights.ReadAndExecute | FileSystemRights.CreateDirectories, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
            sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.CreatorOwnerSid, null), FileSystemRights.FullControl, all, PropagationFlags.InheritOnly, AccessControlType.Allow));
            Directory.SetAccessControl(root, sec);
        }

        static string ShortcutPath
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs", Product.Name + ".lnk"); }
        }

        static void CreateShortcut(string exe)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { ShortcutPath });
                Type linkType = link.GetType();
                linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { exe });
                linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Path.GetDirectoryName(exe) });
                linkType.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "Show the BSC Activity Tracker status" });
                linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
            }
            catch (Exception ex) { Write("Shortcut not created: " + ex.Message); }
        }

        /// <summary>Starts the agent un-elevated in the signed-in user's session (via the shell).</summary>
        static void LaunchForInteractiveUser(string exe)
        {
            try
            {
                if (Process.GetCurrentProcess().SessionId == 0) { Write("No interactive session; the agent starts at next sign-in."); return; }
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + exe + "\"") { UseShellExecute = false });
                Write("Agent launched for the signed-in user.");
            }
            catch (Exception ex) { Write("Agent not launched now (" + ex.Message + "); it starts at next sign-in."); }
        }

        /// <summary>Asks every running agent (all sessions) to stop gracefully, then forces any that remain.</summary>
        static void StopAgents()
        {
            Process[] running = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Product.ExeName));
            if (running.Length == 0) return;
            Write("Stopping " + running.Length + " running agent(s)...");
            EventWaitHandle signal = null;
            try
            {
                EventWaitHandleSecurity security = new EventWaitHandleSecurity();
                security.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), EventWaitHandleRights.Synchronize | EventWaitHandleRights.Modify, AccessControlType.Allow));
                bool created;
                signal = new EventWaitHandle(false, EventResetMode.ManualReset, Product.ShutdownEventName, out created, security);
                signal.Set();
                DateTime deadline = DateTime.UtcNow.AddSeconds(15);
                while (DateTime.UtcNow < deadline && Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Product.ExeName)).Length > 0) Thread.Sleep(250);
            }
            catch (Exception ex) { Write("Graceful stop unavailable: " + ex.Message); }
            foreach (Process p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Product.ExeName)))
            {
                try { p.Kill(); p.WaitForExit(5000); Write("Forced agent exit (pid " + p.Id + ")."); } catch { }
            }
            if (signal != null) { signal.Reset(); signal.Dispose(); }
        }

        // ---------------------------------------------------------------- uninstall
        public static void Uninstall()
        {
            Write("Uninstall " + Product.Version);
            StopAgents();
            if (Directory.Exists(Product.DataRoot))
            {
                foreach (string userDir in Directory.GetDirectories(Product.DataRoot)) RetireUser(userDir);
            }
            using (RegistryKey run = Hklm().OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", true))
                if (run != null) run.DeleteValue(Product.RunValue, false);
            Hklm().DeleteSubKeyTree(Product.UninstallKey, false);
            Hklm().DeleteSubKeyTree(Product.RegistryPath, false);
            try { if (File.Exists(ShortcutPath)) File.Delete(ShortcutPath); } catch { }
            try { Directory.Delete(Path.GetDirectoryName(Product.DataRoot), true); } catch (Exception ex) { Write("Data folder not fully removed: " + ex.Message); }
            string dir = Product.InstallDir;
            try { File.Delete(Path.Combine(dir, Product.ExeName)); } catch { }
            // The running setup copy cannot delete itself; remove the folder after exit.
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 4 > nul & rmdir /s /q \"" + dir + "\"")
                { CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, UseShellExecute = false });
            }
            catch { }
            Write("Uninstalled.");
        }

        /// <summary>Uploads anything still queued on this PC for one Windows user, then unenrolls the device.</summary>
        static void RetireUser(string userDir)
        {
            string deviceFile = Path.Combine(userDir, "device.dat");
            if (!File.Exists(deviceFile)) return;
            try
            {
                Dictionary<string, object> device = Api.Deserialize<Dictionary<string, object>>(Secure.Unprotect(File.ReadAllBytes(deviceFile)));
                string token = Api.Str(device, "token");
                string server = Api.ValidateServer(Api.Str(device, "serverUrl") ?? Product.ReadMachineSetting("ServerUrl", ""));
                if (token == null || server == null) return;
                string queueDir = Path.Combine(userDir, "queue");
                int uploaded = 0;
                if (Directory.Exists(queueDir) && Api.Bool(device, "noticeAcknowledged", false))
                {
                    foreach (string seg in Directory.GetFiles(queueDir, "q-*.dat").OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal))
                    {
                        List<Dictionary<string, object>> events = Api.Deserialize<List<Dictionary<string, object>>>(Secure.Unprotect(File.ReadAllBytes(seg)));
                        Dictionary<string, object> body = new Dictionary<string, object>();
                        body["batchId"] = "u-" + Secure.Sha256Hex(Path.GetFileName(seg)).Substring(0, 40);
                        body["sentAt"] = Api.IsoNow();
                        body["events"] = events.Take(500).ToList();
                        ApiResult r = Api.Post(server, "/tracking/agent/events", body, token);
                        if (!r.Ok) { Write("Pending upload stopped: " + r.Error); break; }
                        uploaded += events.Count;
                    }
                }
                ApiResult result = Api.Post(server, "/tracking/agent/unenroll", new Dictionary<string, object>(), token);
                Write("User " + Path.GetFileName(userDir) + ": uploaded " + uploaded + " pending event(s); unenroll " + (result.Ok ? "ok" : "failed (" + result.Error + ")"));
            }
            catch (Exception ex) { Write("Could not retire " + Path.GetFileName(userDir) + ": " + ex.Message); }
        }
    }

    /// <summary>Interactive installer window.</summary>
    internal sealed class SetupForm : Form
    {
        public SetupForm()
        {
            bool installed = SetupProgram.IsInstalled;
            Text = Product.Name + " " + Product.Version + " Setup";
            Font = new Font("Segoe UI", 9.5f);
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(560, 430); BackColor = Color.White; AutoScaleMode = AutoScaleMode.Dpi;
            Panel band = new Panel { BackColor = Color.FromArgb(31, 58, 95), Width = 560, Height = 60 };
            band.Controls.Add(new Label { Text = Product.Name + " Setup", ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 14f), Left = 20, Top = 15, Width = 520, Height = 32 });
            Controls.Add(band);
            Controls.Add(new Label
            {
                Left = 20, Top = 76, Width = 520, Height = 110,
                Text = (installed ? "The tracker is installed (version " + Product.ReadMachineSetting("Version", "?") + "). You can repair/update it or remove it.\n\n" : "") +
                       "This installs the authorised BSC Textiles work activity tracker for every Windows user on this computer. It runs visibly in the system tray, " +
                       "records application and website usage, active/idle time and lock/unlock events, and sends them securely to the HRMS. " +
                       "It never records keystrokes, passwords, clipboard, screenshots, microphone or camera. Each employee registers with a one-time code and must acknowledge the monitoring notice before any data is collected.",
            });
            Controls.Add(new Label { Text = "HRMS server", Left = 20, Top = 200, Width = 120, Font = new Font("Segoe UI Semibold", 9.5f) });
            TextBox server = new TextBox { Left = 140, Top = 196, Width = 400, Text = Product.ReadMachineSetting("ServerUrl", SetupProgram.DefaultServer()) };
            Controls.Add(server);
            CheckBox confirm = new CheckBox { Left = 20, Top = 236, Width = 520, Height = 40, Text = "I confirm this is a company-managed computer and its users have been informed about work activity monitoring." };
            Controls.Add(confirm);
            Label status = new Label { Left = 20, Top = 290, Width = 520, Height = 60, ForeColor = Color.DimGray };
            Controls.Add(status);
            Button install = new Button { Text = installed ? "Repair / Update" : "Install", Left = 220, Top = 380, Width = 120, Height = 32 };
            Button remove = new Button { Text = "Uninstall", Left = 348, Top = 380, Width = 92, Height = 32, Enabled = installed };
            Button close = new Button { Text = "Close", Left = 448, Top = 380, Width = 92, Height = 32 };
            Controls.Add(install); Controls.Add(remove); Controls.Add(close);
            CancelButton = close;
            close.Click += delegate { Close(); };
            install.Click += delegate
            {
                string url = Api.ValidateServer(server.Text);
                if (url == null) { status.ForeColor = Color.FromArgb(185, 28, 28); status.Text = "Enter a valid HTTPS server address."; return; }
                if (!confirm.Checked) { status.ForeColor = Color.FromArgb(185, 28, 28); status.Text = "Please confirm the computer is company-managed and users are informed."; return; }
                Run(status, new Control[] { install, remove, close }, delegate { SetupProgram.Install(url, true); }, "Installed. The tracker is starting in the system tray; the employee registers it with their enrollment code.");
            };
            remove.Click += delegate
            {
                if (MessageBox.Show("Remove the tracker from this computer?\n\nAny data still waiting on this PC is uploaded first, and every registration on this PC is removed from the HRMS.", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
                Run(status, new Control[] { install, remove, close }, delegate { SetupProgram.Uninstall(); }, "The tracker has been removed.");
            };
        }

        void Run(Label status, Control[] buttons, Action work, string done)
        {
            foreach (Control b in buttons) b.Enabled = false;
            status.ForeColor = Color.DimGray; status.Text = "Working…";
            ThreadPool.QueueUserWorkItem(delegate
            {
                string error = null;
                try { work(); } catch (Exception ex) { error = ex.Message; SetupProgram.Write("FAILED: " + ex); }
                BeginInvoke((Action)delegate
                {
                    buttons[2].Enabled = true;
                    status.ForeColor = error == null ? Color.FromArgb(21, 128, 61) : Color.FromArgb(185, 28, 28);
                    status.Text = error == null ? done : "Failed: " + error;
                });
            });
        }
    }
}
