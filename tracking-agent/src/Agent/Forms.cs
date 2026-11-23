using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace BscTracker
{
    internal static class Ui
    {
        public static readonly Font Body = new Font("Segoe UI", 9.5f);
        public static readonly Font Title = new Font("Segoe UI Semibold", 13f);
        public static readonly Font Bold = new Font("Segoe UI Semibold", 9.5f);
        public static readonly Color Brand = Color.FromArgb(31, 58, 95);

        public static Form Window(string title, int width, int height)
        {
            Form f = new Form();
            f.Text = title;
            f.Font = Body;
            f.FormBorderStyle = FormBorderStyle.FixedDialog;
            f.MaximizeBox = false;
            f.MinimizeBox = false;
            f.StartPosition = FormStartPosition.CenterScreen;
            f.ClientSize = new Size(width, height);
            f.BackColor = Color.White;
            f.ShowInTaskbar = true;
            f.AutoScaleMode = AutoScaleMode.Dpi;
            return f;
        }

        public static Label Header(Control parent, string text, int top)
        {
            Panel band = new Panel { BackColor = Brand, Left = 0, Top = 0, Width = parent.ClientSize.Width, Height = 56 };
            Label l = new Label { Text = text, Font = Title, ForeColor = Color.White, AutoSize = false, Left = 20, Top = 14, Width = parent.ClientSize.Width - 40, Height = 30 };
            band.Controls.Add(l);
            parent.Controls.Add(band);
            return l;
        }

        public static Label Text(Control parent, string text, int left, int top, int width, int height)
        {
            Label l = new Label { Text = text, Left = left, Top = top, Width = width, Height = height, AutoSize = false };
            parent.Controls.Add(l);
            return l;
        }
    }

    /// <summary>First-run registration with a one-time code from HR/IT.</summary>
    internal sealed class EnrollForm : Form
    {
        public EnrollForm(TrayApp app, string server)
        {
            Form f = this;
            f.Text = Product.Name + " — Register this computer";
            f.Font = Ui.Body; f.FormBorderStyle = FormBorderStyle.FixedDialog; f.MaximizeBox = false; f.MinimizeBox = false;
            f.StartPosition = FormStartPosition.CenterScreen; f.ClientSize = new Size(520, 360); f.BackColor = Color.White; f.AutoScaleMode = AutoScaleMode.Dpi;
            Ui.Header(this, "Register this computer", 0);
            Ui.Text(this, "This company computer has the BSC Textiles activity tracker installed. Enter the one-time enrollment code issued to you by HR or IT. The code links this computer and your Windows account to your HRMS employee record.", 20, 72, 480, 64);
            Ui.Text(this, "Server", 20, 144, 120, 20).Font = Ui.Bold;
            Ui.Text(this, server, 140, 144, 360, 20);
            Ui.Text(this, "Windows user", 20, 168, 120, 20).Font = Ui.Bold;
            Ui.Text(this, Environment.UserDomainName + "\\" + Environment.UserName + " on " + Environment.MachineName, 140, 168, 360, 20);
            Ui.Text(this, "Enrollment code", 20, 204, 120, 20).Font = Ui.Bold;
            TextBox code = new TextBox { Left = 140, Top = 200, Width = 200, CharacterCasing = CharacterCasing.Upper, MaxLength = 24, Font = new Font("Consolas", 12f) };
            Controls.Add(code);
            Label status = Ui.Text(this, "", 20, 244, 480, 40);
            status.ForeColor = Color.FromArgb(185, 28, 28);
            Button register = new Button { Text = "Register", Left = 300, Top = 304, Width = 100, Height = 32 };
            Button later = new Button { Text = "Later", Left = 408, Top = 304, Width = 92, Height = 32 };
            Controls.Add(register); Controls.Add(later);
            AcceptButton = register; CancelButton = later;
            later.Click += delegate { Close(); };
            register.Click += delegate
            {
                string value = code.Text.Trim();
                if (value.Replace("-", "").Length < 8) { status.Text = "Enter the full code, for example ABCDE-23456."; return; }
                register.Enabled = false; code.Enabled = false; status.ForeColor = Color.DimGray; status.Text = "Registering…";
                ThreadPool.QueueUserWorkItem(delegate
                {
                    string error;
                    bool ok = app.Enroll(value, out error);
                    BeginInvoke((Action)delegate
                    {
                        if (ok) { Close(); return; }
                        register.Enabled = true; code.Enabled = true; status.ForeColor = Color.FromArgb(185, 28, 28); status.Text = error;
                    });
                });
            };
        }
    }

    /// <summary>Monitoring notice. Collection starts only after the employee acknowledges it.</summary>
    internal sealed class NoticeForm : Form
    {
        public NoticeForm(TrayApp app, string serverText, bool alreadyAcknowledged)
        {
            Text = Product.Name + " — Monitoring notice";
            Font = Ui.Body; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(560, 470); BackColor = Color.White; AutoScaleMode = AutoScaleMode.Dpi;
            Ui.Header(this, "Work activity monitoring notice", 0);
            string text = string.IsNullOrWhiteSpace(serverText)
                ? "BSC Textiles records work activity on this company computer while you are signed in."
                : serverText;
            TextBox body = new TextBox
            {
                Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.FromArgb(248, 250, 252),
                Left = 20, Top = 72, Width = 520, Height = 200,
                Text = text.Replace("\r\n", "\n").Replace("\n", Environment.NewLine) + Environment.NewLine + Environment.NewLine +
                       "Recorded: application name in the foreground and its active time; active, idle and locked time; screen lock/unlock, sleep/wake and sign-in/out times; website domain of the active browser tab when the browser extension is installed." + Environment.NewLine + Environment.NewLine +
                       "Never recorded: keystrokes, passwords, clipboard, screenshots, files, documents, page contents, form data, microphone or camera.",
            };
            Controls.Add(body);
            Ui.Text(this, "The tray icon shows when tracking is on. You can see your own recorded activity in the HRMS under User Activity Tracking.", 20, 284, 520, 40).ForeColor = Color.DimGray;
            CheckBox agree = new CheckBox { Text = "I have read and understood this notice.", Left = 20, Top = 332, Width = 520, Checked = alreadyAcknowledged, Enabled = !alreadyAcknowledged };
            Controls.Add(agree);
            Label status = Ui.Text(this, alreadyAcknowledged ? "You acknowledged this notice." : "", 20, 362, 520, 40);
            Button ok = new Button { Text = alreadyAcknowledged ? "Close" : "Acknowledge", Left = 330, Top = 416, Width = 110, Height = 32 };
            Button close = new Button { Text = "Not now", Left = 448, Top = 416, Width = 92, Height = 32, Visible = !alreadyAcknowledged };
            Controls.Add(ok); Controls.Add(close);
            close.Click += delegate { Close(); };
            ok.Click += delegate
            {
                if (alreadyAcknowledged) { Close(); return; }
                if (!agree.Checked) { status.ForeColor = Color.FromArgb(185, 28, 28); status.Text = "Tick the box to confirm you have read the notice."; return; }
                ok.Enabled = false; status.ForeColor = Color.DimGray; status.Text = "Saving…";
                ThreadPool.QueueUserWorkItem(delegate
                {
                    string error;
                    bool done = app.Acknowledge(out error);
                    BeginInvoke((Action)delegate
                    {
                        if (done) { Close(); return; }
                        ok.Enabled = true; status.ForeColor = Color.FromArgb(185, 28, 28); status.Text = error;
                    });
                });
            };
        }
    }

    /// <summary>Live status: who the device is registered to, connection and synchronisation.</summary>
    internal sealed class StatusForm : Form
    {
        readonly TrayApp app;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 2000 };
        readonly Label headline;
        readonly Label[] values;
        static readonly string[] Labels = { "Employee", "Location", "Computer", "Tracking", "Current state", "Last heartbeat", "Last sync", "Events waiting", "Browser extension", "Server", "Agent version", "Last problem" };

        public StatusForm(TrayApp app)
        {
            this.app = app;
            Text = Product.Name + " — Status";
            Font = Ui.Body; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(560, 420); BackColor = Color.White; AutoScaleMode = AutoScaleMode.Dpi;
            headline = Ui.Header(this, "", 0);
            values = new Label[Labels.Length];
            for (int i = 0; i < Labels.Length; i++)
            {
                Ui.Text(this, Labels[i], 20, 72 + i * 26, 150, 22).Font = Ui.Bold;
                values[i] = Ui.Text(this, "", 170, 72 + i * 26, 370, 22);
                values[i].AutoEllipsis = true;
            }
            Button close = new Button { Text = "Close", Left = 448, Top = 380, Width = 92, Height = 30 };
            Controls.Add(close);
            close.Click += delegate { Close(); };
            CancelButton = close;
            timer.Tick += delegate { Render(); };
            timer.Start();
            FormClosed += delegate { timer.Stop(); timer.Dispose(); };
            Render();
        }

        void Render()
        {
            TrayApp.Snapshot s = app.Status();
            headline.Text = s.Headline;
            string[] v = { s.Employee, s.Location, s.Device, s.Tracking, s.State, s.Heartbeat, s.Sync, s.Pending, s.Extension, s.Server, s.Version, s.Error ?? "—" };
            for (int i = 0; i < v.Length; i++) values[i].Text = v[i];
        }
    }
}
