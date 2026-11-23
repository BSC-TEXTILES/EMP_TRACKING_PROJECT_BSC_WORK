using System;
using System.Collections.Generic;

namespace BscTracker
{
    /// <summary>
    /// Turns once-per-second samples into contiguous, non-overlapping intervals:
    ///   activity(state = active | idle | locked, app, browser, domain)
    /// plus point events (session start/end, lock/unlock, idle start/end,
    /// suspend/resume, agent start/stop). Idle time is back-dated to the last
    /// keyboard/mouse input, so durations are exact rather than delayed by the
    /// threshold. All timestamps are UTC.
    /// Must be driven from the UI thread (SystemEvents callbacks arrive there).
    /// </summary>
    internal sealed class Collector
    {
        sealed class Interval
        {
            public string State, App, Process, Browser, Domain, Title;
            public DateTime Start;
            public string Key { get { return State + "|" + App + "|" + Process + "|" + Browser + "|" + Domain + "|" + Title; } }
        }

        readonly EventQueue queue;
        readonly Bridge bridge;
        Interval current;
        DateTime lastTickUtc = DateTime.MinValue;
        bool locked, suspended, enabled, disabledEventSent;

        public int IdleThresholdSeconds = 300;
        public bool AppTracking = true, WebsiteTracking = true, WindowTitles = false;
        public string SessionId { get; private set; }
        public DateTime SessionStartedUtc { get; private set; }
        public bool Running { get; private set; }

        // Snapshot for heartbeats / tray (read from other threads).
        public volatile string LiveState = "unknown";
        public volatile string LiveApp, LiveBrowser, LiveDomain;

        public Collector(EventQueue queue, Bridge bridge)
        {
            this.queue = queue;
            this.bridge = bridge;
        }

        Dictionary<string, object> NewEvent(string type, DateTime at)
        {
            Dictionary<string, object> e = new Dictionary<string, object>();
            e["id"] = Guid.NewGuid().ToString("N");
            e["type"] = type;
            e["sessionId"] = SessionId;
            e["start"] = Api.Iso(at);
            return e;
        }

        void Point(string type, DateTime at, string detail)
        {
            if (SessionId == null) return;
            Dictionary<string, object> e = NewEvent(type, at);
            if (detail != null) e["detail"] = detail;
            queue.Add(e);
        }

        /// <summary>Starts a tracking session (agent start within a Windows sign-in).</summary>
        public void StartSession()
        {
            if (Running) return;
            SessionId = "s-" + Guid.NewGuid().ToString("N");
            SessionStartedUtc = DateTime.UtcNow;
            Running = true;
            Point("session_start", SessionStartedUtc, null);
            Point("agent_start", SessionStartedUtc, Product.Version);
            Log.Info("Tracking session started.");
        }

        /// <summary>Closes intervals and ends the session (sign-out, shutdown, exit, update).</summary>
        public void StopSession(string reason)
        {
            if (!Running) return;
            DateTime now = DateTime.UtcNow;
            Close(now);
            Point("agent_stop", now, reason);
            Point("session_end", now, reason);
            Running = false;
            LiveState = "unknown";
            queue.Flush();
            Log.Info("Tracking session ended (" + reason + ").");
        }

        /// <summary>Enables or pauses collection (policy switch / notice acknowledgement).</summary>
        public void SetEnabled(bool value, bool byPolicy)
        {
            if (value == enabled) return;
            DateTime now = DateTime.UtcNow;
            if (!value)
            {
                Close(now);
                if (byPolicy && !disabledEventSent) { Point("tracking_disabled", now, null); disabledEventSent = true; }
                LiveState = "unknown";
            }
            else if (disabledEventSent)
            {
                Point("tracking_enabled", now, null);
                disabledEventSent = false;
            }
            enabled = value;
        }

        public bool Enabled { get { return enabled; } }

        public void Tick()
        {
            if (!Running) return;
            DateTime now = DateTime.UtcNow;
            // A frozen process, hibernation without a power event or a clock change:
            // never stretch an interval across the jump - record a gap instead.
            if (lastTickUtc != DateTime.MinValue && (now < lastTickUtc || (now - lastTickUtc).TotalSeconds > 30))
            {
                Close(lastTickUtc < now ? lastTickUtc : now);
            }
            lastTickUtc = now;
            if (!enabled || suspended) return;

            long idleMs = Native.IdleMilliseconds();
            string state = locked ? "locked" : idleMs >= IdleThresholdSeconds * 1000L ? "idle" : "active";
            Native.Foreground fg = null;
            if (state != "locked" && AppTracking)
            {
                try { fg = Native.CurrentForeground(WindowTitles); } catch { fg = null; }
                if (fg != null && (fg.ProcessName.Equals("LockApp", StringComparison.OrdinalIgnoreCase) || fg.ProcessName.Equals("LogonUI", StringComparison.OrdinalIgnoreCase)))
                {
                    state = "locked";
                    fg = null;
                }
            }
            Interval next = new Interval();
            next.State = state;
            if (fg != null)
            {
                next.App = fg.AppName;
                next.Process = fg.ProcessName;
                string browserKey = Native.BrowserKey(fg.ProcessName);
                if (browserKey != null)
                {
                    next.Browser = Native.BrowserLabel(browserKey);
                    if (WebsiteTracking) next.Domain = bridge.DomainFor(browserKey);
                }
                if (WindowTitles && state == "active" && !string.IsNullOrEmpty(fg.Title)) next.Title = fg.Title.Length > 250 ? fg.Title.Substring(0, 250) : fg.Title;
            }

            LiveState = state;
            LiveApp = next.App;
            LiveBrowser = next.Browser;
            LiveDomain = next.Domain;

            if (current == null) { Open(next, now); return; }

            if (current.State == "active" && state == "idle")
            {
                DateTime idleStart = now.AddMilliseconds(-idleMs);
                if (idleStart < current.Start) idleStart = current.Start;
                Close(idleStart);
                Point("idle_start", idleStart, null);
                Open(next, idleStart);
                return;
            }
            if (current.State == "idle" && state == "active")
            {
                Close(now);
                Point("idle_end", now, null);
                Open(next, now);
                return;
            }
            if (current.Key != next.Key) { Close(now); Open(next, now); return; }

            // Roll intervals over every 60 s so data reaches the server promptly. An
            // active interval only rolls over while input is recent, because it may
            // still be re-classified as idle once the threshold is reached.
            double age = (now - current.Start).TotalSeconds;
            if (age >= 60 && (current.State != "active" || idleMs < 5000))
            {
                Close(now);
                Open(next, now);
            }
        }

        void Open(Interval next, DateTime at)
        {
            next.Start = at;
            current = next;
        }

        /// <summary>Emits the open interval ending at 'end' (dropped if shorter than 1 s).</summary>
        void Close(DateTime end)
        {
            if (current == null) return;
            Interval i = current;
            current = null;
            if ((end - i.Start).TotalMilliseconds < 1000) return;
            Dictionary<string, object> e = NewEvent("activity", i.Start);
            e["end"] = Api.Iso(end);
            e["state"] = i.State;
            if (i.App != null) e["app"] = i.App;
            if (i.Process != null) e["process"] = i.Process;
            if (i.Browser != null) e["browser"] = i.Browser;
            if (i.Domain != null) e["domain"] = i.Domain;
            if (i.Title != null) e["title"] = i.Title;
            queue.Add(e);
        }

        public void OnLock()
        {
            DateTime now = DateTime.UtcNow;
            if (Running && enabled && current != null && current.State == "active")
            {
                // Input stopped well before the lock (e.g. automatic lock): that part was idle.
                long idleMs = Native.IdleMilliseconds();
                if (idleMs >= 60000)
                {
                    DateTime idleStart = now.AddMilliseconds(-idleMs);
                    if (idleStart > current.Start)
                    {
                        Interval idle = new Interval();
                        idle.State = "idle"; idle.App = current.App; idle.Process = current.Process; idle.Browser = current.Browser; idle.Domain = current.Domain;
                        Close(idleStart);
                        Point("idle_start", idleStart, null);
                        Open(idle, idleStart);
                    }
                }
            }
            if (Running && enabled) { Close(now); Point("lock", now, null); }
            locked = true;
            LiveState = "locked";
            if (Running && enabled) { Interval l = new Interval(); l.State = "locked"; Open(l, now); }
        }

        public void OnUnlock()
        {
            DateTime now = DateTime.UtcNow;
            if (Running && enabled) { Close(now); Point("unlock", now, null); }
            locked = false;
        }

        public void OnSuspend()
        {
            DateTime now = DateTime.UtcNow;
            if (Running) { Close(now); Point("suspend", now, null); }
            suspended = true;
            LiveState = "unknown";
            queue.Flush();
        }

        public void OnResume()
        {
            DateTime now = DateTime.UtcNow;
            suspended = false;
            lastTickUtc = now;
            if (Running) Point("resume", now, null);
        }
    }
}
