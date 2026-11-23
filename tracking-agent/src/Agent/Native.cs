using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace BscTracker
{
    /// <summary>
    /// Win32 calls used for sampling. Only the foreground window's owning process,
    /// optional window title and the time since the last input are read. No
    /// keyboard/mouse content, clipboard or screen pixels are ever accessed.
    /// </summary>
    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
        delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern uint GetTickCount();
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        /// <summary>Milliseconds since the last keyboard/mouse input in this session.</summary>
        public static long IdleMilliseconds()
        {
            LASTINPUTINFO info = new LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref info)) return 0;
            return (long)unchecked(GetTickCount() - info.dwTime);
        }

        public sealed class Foreground
        {
            public string ProcessName;   // e.g. "chrome"
            public string AppName;       // e.g. "Google Chrome"
            public string Title;         // only filled when titles are permitted
        }

        static readonly Dictionary<string, string> FriendlyCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static Foreground CurrentForeground(bool includeTitle)
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) return null;
            string path = ImagePath(pid);
            string proc = path != null ? System.IO.Path.GetFileNameWithoutExtension(path) : null;
            // UWP apps are hosted by ApplicationFrameHost; the real app owns a child window.
            if (proc != null && proc.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase))
            {
                uint hostPid = pid;
                uint childPid = 0;
                EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr l)
                {
                    uint p; GetWindowThreadProcessId(child, out p);
                    if (p != 0 && p != hostPid) { childPid = p; return false; }
                    return true;
                }, IntPtr.Zero);
                if (childPid != 0)
                {
                    string childPath = ImagePath(childPid);
                    if (childPath != null) { path = childPath; proc = System.IO.Path.GetFileNameWithoutExtension(childPath); }
                }
            }
            if (proc == null)
            {
                try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { return null; }
            }
            Foreground result = new Foreground();
            result.ProcessName = proc;
            result.AppName = FriendlyName(proc, path);
            if (includeTitle)
            {
                StringBuilder sb = new StringBuilder(512);
                GetWindowText(hwnd, sb, sb.Capacity);
                result.Title = sb.ToString();
            }
            return result;
        }

        static string ImagePath(uint pid)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero) return null;
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                return QueryFullProcessImageName(handle, 0, sb, ref size) ? sb.ToString() : null;
            }
            finally { CloseHandle(handle); }
        }

        static readonly Dictionary<string, string> KnownNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "chrome", "Google Chrome" }, { "msedge", "Microsoft Edge" }, { "firefox", "Mozilla Firefox" }, { "brave", "Brave Browser" },
            { "opera", "Opera" }, { "vivaldi", "Vivaldi" }, { "excel", "Microsoft Excel" }, { "winword", "Microsoft Word" },
            { "powerpnt", "Microsoft PowerPoint" }, { "outlook", "Microsoft Outlook" }, { "olk", "Microsoft Outlook" }, { "onenote", "Microsoft OneNote" },
            { "ms-teams", "Microsoft Teams" }, { "teams", "Microsoft Teams" }, { "explorer", "File Explorer" }, { "notepad", "Notepad" },
            { "code", "Visual Studio Code" }, { "whatsapp", "WhatsApp" }, { "tally", "Tally" }, { "tallyprime", "TallyPrime" },
            { "lockapp", "Lock screen" }, { "searchhost", "Windows Search" }, { "shellexperiencehost", "Windows Shell" },
        };

        static string FriendlyName(string proc, string path)
        {
            string cached;
            string key = path ?? proc;
            if (FriendlyCache.TryGetValue(key, out cached)) return cached;
            string name;
            if (!KnownNames.TryGetValue(proc, out name))
            {
                name = null;
                if (path != null)
                {
                    try
                    {
                        FileVersionInfo info = FileVersionInfo.GetVersionInfo(path);
                        name = !string.IsNullOrWhiteSpace(info.FileDescription) ? info.FileDescription.Trim()
                            : !string.IsNullOrWhiteSpace(info.ProductName) ? info.ProductName.Trim() : null;
                    }
                    catch { }
                }
                if (string.IsNullOrEmpty(name)) name = proc;
                if (name.Length > 150) name = name.Substring(0, 150);
            }
            if (FriendlyCache.Count > 2000) FriendlyCache.Clear();
            FriendlyCache[key] = name;
            return name;
        }

        /// <summary>Browser key used to match reports from the browser extension.</summary>
        public static string BrowserKey(string processName)
        {
            if (processName == null) return null;
            switch (processName.ToLowerInvariant())
            {
                case "chrome": return "chrome";
                case "msedge": return "edge";
                case "brave": return "brave";
                case "firefox": return "firefox";
                case "opera": return "opera";
                case "vivaldi": return "vivaldi";
                default: return null;
            }
        }

        public static string BrowserLabel(string key)
        {
            switch (key)
            {
                case "chrome": return "Chrome";
                case "edge": return "Edge";
                case "brave": return "Brave";
                case "firefox": return "Firefox";
                case "opera": return "Opera";
                case "vivaldi": return "Vivaldi";
                default: return key;
            }
        }
    }
}
