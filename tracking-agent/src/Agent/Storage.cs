using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace BscTracker
{
    /// <summary>Per-Windows-user data folder: %ProgramData%\BSC Textiles\Activity Tracker\data\&lt;SID&gt;.</summary>
    internal static class Paths
    {
        static string userDir;

        public static SecurityIdentifier UserSid { get { return WindowsIdentity.GetCurrent().User; } }

        public static string UserDir
        {
            get
            {
                if (userDir != null) return userDir;
                string dir = Path.Combine(Product.DataRoot, UserSid.Value);
                bool created = !Directory.Exists(dir);
                Directory.CreateDirectory(dir);
                if (created) { try { Secure.LockDownFolder(dir, UserSid); } catch (Exception ex) { Log.Warn("Could not restrict data folder permissions: " + ex.Message); } }
                Directory.CreateDirectory(Path.Combine(dir, "queue"));
                Directory.CreateDirectory(Path.Combine(dir, "logs"));
                userDir = dir;
                return dir;
            }
        }

        public static string DeviceFile { get { return Path.Combine(UserDir, "device.dat"); } }
        public static string QueueDir { get { return Path.Combine(UserDir, "queue"); } }
        public static string LogDir { get { return Path.Combine(UserDir, "logs"); } }
    }

    /// <summary>
    /// Diagnostic log. Never writes application names, window titles, domains or
    /// tokens - only states, counts and error messages.
    /// </summary>
    internal static class Log
    {
        static readonly object Gate = new object();
        static DateTime lastCleanup = DateTime.MinValue;

        public static void Info(string message) { Write("INFO", message); }
        public static void Warn(string message) { Write("WARN", message); }
        public static void Error(string message) { Write("ERROR", message); }

        static void Write(string level, string message)
        {
            try
            {
                lock (Gate)
                {
                    string dir = Paths.LogDir;
                    string file = Path.Combine(dir, "agent-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
                    File.AppendAllText(file, string.Format("{0:yyyy-MM-dd HH:mm:ss.fff} [{1}] {2}{3}", DateTime.Now, level, message, Environment.NewLine));
                    if ((DateTime.UtcNow - lastCleanup).TotalHours > 12)
                    {
                        lastCleanup = DateTime.UtcNow;
                        foreach (string old in Directory.GetFiles(dir, "agent-*.log"))
                            if (File.GetLastWriteTimeUtc(old) < DateTime.UtcNow.AddDays(-14)) File.Delete(old);
                    }
                }
            }
            catch { }
        }
    }

    /// <summary>Enrolled device identity (DPAPI-protected on disk).</summary>
    internal sealed class DeviceIdentity
    {
        public string Token;
        public int DeviceId;
        public string EmployeeName;
        public string EmployeeCode;
        public string Location;
        public string ServerUrl;
        public bool NoticeAcknowledged;

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        public static DeviceIdentity Load()
        {
            try
            {
                if (!File.Exists(Paths.DeviceFile)) return null;
                Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(Secure.Unprotect(File.ReadAllBytes(Paths.DeviceFile)));
                DeviceIdentity id = new DeviceIdentity();
                id.Token = Str(d, "token");
                id.DeviceId = d.ContainsKey("deviceId") ? Convert.ToInt32(d["deviceId"]) : 0;
                id.EmployeeName = Str(d, "employeeName");
                id.EmployeeCode = Str(d, "employeeCode");
                id.Location = Str(d, "location");
                id.ServerUrl = Str(d, "serverUrl");
                id.NoticeAcknowledged = d.ContainsKey("noticeAcknowledged") && Convert.ToBoolean(d["noticeAcknowledged"]);
                return string.IsNullOrEmpty(id.Token) ? null : id;
            }
            catch (Exception ex)
            {
                Log.Error("Device identity unreadable: " + ex.Message);
                return null;
            }
        }

        public void Save()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["token"] = Token; d["deviceId"] = DeviceId; d["employeeName"] = EmployeeName; d["employeeCode"] = EmployeeCode;
            d["location"] = Location; d["serverUrl"] = ServerUrl; d["noticeAcknowledged"] = NoticeAcknowledged;
            Secure.WriteAtomic(Paths.DeviceFile, Secure.Protect(Json.Serialize(d)));
        }

        public static void Delete()
        {
            try { if (File.Exists(Paths.DeviceFile)) File.Delete(Paths.DeviceFile); } catch { }
        }

        static string Str(Dictionary<string, object> d, string k) { return d.ContainsKey(k) && d[k] != null ? d[k].ToString() : null; }
    }

    /// <summary>
    /// Durable offline queue. Events are buffered in memory and flushed every few
    /// seconds into DPAPI-protected segment files named q-&lt;ticks&gt;-&lt;count&gt;.dat, which
    /// are uploaded oldest-first and deleted only after the server acknowledges them.
    /// Each event carries a unique id, so a retried upload is never double-counted.
    /// </summary>
    internal sealed class EventQueue
    {
        public const int MaxStoredEvents = 250000;
        readonly object gate = new object();
        readonly List<Dictionary<string, object>> memory = new List<Dictionary<string, object>>();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        int seq;
        public int Dropped { get; private set; }

        public void Add(Dictionary<string, object> evt)
        {
            lock (gate) memory.Add(evt);
        }

        public int MemoryCount { get { lock (gate) return memory.Count; } }

        /// <summary>Writes buffered events to a new segment file.</summary>
        public void Flush()
        {
            List<Dictionary<string, object>> copy;
            lock (gate)
            {
                if (memory.Count == 0) return;
                copy = new List<Dictionary<string, object>>(memory);
                memory.Clear();
            }
            try
            {
                string name = string.Format("q-{0:D20}-{1:D4}-{2}.dat", DateTime.UtcNow.Ticks, (seq++) % 10000, copy.Count);
                Secure.WriteAtomic(Path.Combine(Paths.QueueDir, name), Secure.Protect(json.Serialize(copy)));
                EnforceCapacity();
            }
            catch (Exception ex)
            {
                Log.Error("Could not persist events (kept in memory): " + ex.Message);
                lock (gate) memory.InsertRange(0, copy);
            }
        }

        static int CountOf(string file)
        {
            string stem = Path.GetFileNameWithoutExtension(file);
            int dash = stem.LastIndexOf('-');
            int n;
            return dash > 0 && int.TryParse(stem.Substring(dash + 1), out n) ? n : 0;
        }

        string[] Segments()
        {
            try { return Directory.GetFiles(Paths.QueueDir, "q-*.dat").OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal).ToArray(); }
            catch { return new string[0]; }
        }

        public int PendingCount
        {
            get
            {
                int total = MemoryCount;
                foreach (string f in Segments()) total += CountOf(f);
                return total;
            }
        }

        void EnforceCapacity()
        {
            string[] files = Segments();
            int total = files.Sum(f => CountOf(f));
            int i = 0;
            while (total > MaxStoredEvents && i < files.Length)
            {
                int n = CountOf(files[i]);
                try { File.Delete(files[i]); total -= n; Dropped += n; Log.Warn("Offline storage full; discarded " + n + " oldest event(s)."); } catch { }
                i++;
            }
        }

        public sealed class Batch
        {
            public List<string> Files = new List<string>();
            public List<Dictionary<string, object>> Events = new List<Dictionary<string, object>>();
        }

        /// <summary>Oldest segments up to roughly maxEvents (always at least one segment).</summary>
        public Batch Take(int maxEvents)
        {
            Batch batch = new Batch();
            foreach (string file in Segments())
            {
                if (batch.Events.Count > 0 && batch.Events.Count + CountOf(file) > maxEvents) break;
                try
                {
                    List<Dictionary<string, object>> events = json.Deserialize<List<Dictionary<string, object>>>(Secure.Unprotect(File.ReadAllBytes(file)));
                    batch.Files.Add(file);
                    batch.Events.AddRange(events);
                }
                catch (Exception ex)
                {
                    Log.Error("Unreadable queue segment discarded: " + ex.Message);
                    Dropped += CountOf(file);
                    try { File.Delete(file); } catch { }
                }
                if (batch.Events.Count >= maxEvents) break;
            }
            return batch;
        }

        public void Acknowledge(Batch batch)
        {
            foreach (string file in batch.Files) { try { File.Delete(file); } catch { } }
        }

        /// <summary>Splits a segment that is larger than one upload allows.</summary>
        public static List<List<Dictionary<string, object>>> Chunk(List<Dictionary<string, object>> events, int size)
        {
            List<List<Dictionary<string, object>>> chunks = new List<List<Dictionary<string, object>>>();
            for (int i = 0; i < events.Count; i += size) chunks.Add(events.GetRange(i, Math.Min(size, events.Count - i)));
            return chunks;
        }
    }
}
