using System;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("BSC Activity Tracker")]
[assembly: System.Reflection.AssemblyDescription("Authorised work activity tracking agent for BSC Textiles company computers")]
[assembly: System.Reflection.AssemblyCompany("BSC Textiles Pvt Ltd")]
[assembly: System.Reflection.AssemblyProduct("BSC Activity Tracker")]
[assembly: System.Reflection.AssemblyCopyright("Copyright © 2026 BSC Textiles Pvt Ltd. All rights reserved.")]
[assembly: System.Reflection.AssemblyVersion("2.1.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.1.0.0")]

namespace BscTracker
{
    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            // One agent per Windows sign-in session.
            bool first;
            using (Mutex mutex = new Mutex(true, @"Local\BSCActivityTracker", out first))
            {
                if (!first) return 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e) { Log.Error("Unhandled UI error: " + e.Exception.Message); };
                AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) { Log.Error("Fatal: " + e.ExceptionObject); };

                string configured = Environment.GetEnvironmentVariable("BSC_TRACKER_SERVER") ?? Product.ReadMachineSetting("ServerUrl", Product.DefaultServer);
                string server = Api.ValidateServer(configured);
                if (server == null)
                {
                    Log.Error("Invalid or insecure server address configured.");
                    MessageBox.Show("The tracking server address is not valid or does not use HTTPS:\n\n" + configured + "\n\nAsk IT to repair the installation.", Product.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 2;
                }
                // Optional scripted enrollment by IT in the employee's session: --enroll=ABCDE-23456
                string enrollCode = null;
                foreach (string a in args)
                    if (a.StartsWith("--enroll=", StringComparison.OrdinalIgnoreCase)) enrollCode = a.Substring(9).Trim();
                Application.Run(new TrayApp(server, enrollCode));
                GC.KeepAlive(mutex);
            }
            return 0;
        }
    }
}
