using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace BscTracker
{
    /// <summary>
    /// Loopback-only endpoint (127.0.0.1:47613) for the browser extension. The
    /// extension reports the hostname of the active tab; the agent attributes it to
    /// foreground time of that browser, so website time follows the same
    /// active/idle/locked rules as application time. Full URLs, page titles and page
    /// contents are never accepted.
    /// </summary>
    internal sealed class Bridge
    {
        sealed class TabReport { public string Domain; public DateTime At; }

        readonly object gate = new object();
        readonly Dictionary<string, TabReport> latest = new Dictionary<string, TabReport>();
        static readonly Regex HostPattern = new Regex(@"^[a-z0-9.-]{1,190}$", RegexOptions.Compiled);
        TcpListener listener;
        Thread thread;
        volatile bool running;
        public DateTime LastSeenUtc { get; private set; }
        public Func<bool> WebsiteTrackingAllowed = delegate { return true; };

        public void Start()
        {
            try
            {
                listener = new TcpListener(IPAddress.Loopback, Product.BridgePort);
                listener.Start();
                running = true;
                thread = new Thread(Loop) { IsBackground = true, Name = "extension-bridge" };
                thread.Start();
                Log.Info("Browser extension bridge listening on 127.0.0.1:" + Product.BridgePort);
            }
            catch (Exception ex)
            {
                // Another Windows user's agent may hold the port on a shared PC; website
                // attribution is then unavailable for this session only.
                Log.Warn("Browser extension bridge unavailable: " + ex.Message);
            }
        }

        public void Stop()
        {
            running = false;
            try { if (listener != null) listener.Stop(); } catch { }
        }

        /// <summary>Most recent domain reported for a browser within the last 5 minutes.</summary>
        public string DomainFor(string browserKey)
        {
            if (browserKey == null) return null;
            lock (gate)
            {
                TabReport report;
                if (!latest.TryGetValue(browserKey, out report)) return null;
                return (DateTime.UtcNow - report.At).TotalMinutes <= 5 ? report.Domain : null;
            }
        }

        void Loop()
        {
            while (running)
            {
                TcpClient client = null;
                try
                {
                    client = listener.AcceptTcpClient();
                    client.ReceiveTimeout = 3000;
                    client.SendTimeout = 3000;
                    Handle(client);
                }
                catch (Exception ex)
                {
                    if (running) Log.Warn("Bridge request failed: " + ex.Message);
                }
                finally
                {
                    if (client != null) try { client.Close(); } catch { }
                }
            }
        }

        void Handle(TcpClient client)
        {
            NetworkStream stream = client.GetStream();
            string head = ReadHead(stream);
            if (head == null) return;
            string[] lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
            string[] requestLine = lines[0].Split(' ');
            if (requestLine.Length < 2) return;
            string method = requestLine[0];
            string path = requestLine[1];
            Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon > 0) headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
            }
            string origin;
            headers.TryGetValue("Origin", out origin);
            // Browsers always send Origin for web-page requests, so any web origin is refused:
            // a website can never feed or probe this endpoint. Extension origins are accepted,
            // as is a missing Origin (Chromium omits it on some extension GET requests).
            bool extensionOrigin = origin != null && (origin.StartsWith("chrome-extension://") || origin.StartsWith("moz-extension://") || origin.StartsWith("extension://"));
            if (origin != null && !extensionOrigin)
            {
                Respond(stream, 403, "{\"error\":\"forbidden\"}", null);
                return;
            }
            if (method == "OPTIONS") { Respond(stream, 204, "", origin); return; }
            if (method == "GET" && path == "/v1/status")
            {
                Respond(stream, 200, "{\"ok\":true,\"agent\":\"" + Product.Version + "\",\"websiteTracking\":" + (WebsiteTrackingAllowed() ? "true" : "false") + "}", origin);
                return;
            }
            if (method == "POST" && path == "/v1/tab")
            {
                string lengthText;
                int length;
                if (!headers.TryGetValue("Content-Length", out lengthText) || !int.TryParse(lengthText, out length) || length < 0 || length > 4096)
                {
                    Respond(stream, 413, "{\"error\":\"too_large\"}", origin);
                    return;
                }
                byte[] body = new byte[length];
                int read = 0;
                while (read < length)
                {
                    int n = stream.Read(body, read, length - read);
                    if (n <= 0) break;
                    read += n;
                }
                Dictionary<string, object> payload;
                try { payload = Api.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body, 0, read)); }
                catch { Respond(stream, 400, "{\"error\":\"bad_json\"}", origin); return; }
                string browser = (Api.Str(payload, "browser") ?? "").ToLowerInvariant();
                string domain = CleanHost(Api.Str(payload, "domain"));
                if (browser.Length == 0 || browser.Length > 20)
                {
                    Respond(stream, 400, "{\"error\":\"bad_browser\"}", origin);
                    return;
                }
                lock (gate)
                {
                    if (domain == null) latest.Remove(browser);
                    else { TabReport r = new TabReport(); r.Domain = domain; r.At = DateTime.UtcNow; latest[browser] = r; }
                }
                LastSeenUtc = DateTime.UtcNow;
                Respond(stream, 200, "{\"ok\":true,\"websiteTracking\":" + (WebsiteTrackingAllowed() ? "true" : "false") + "}", origin);
                return;
            }
            Respond(stream, 404, "{\"error\":\"not_found\"}", origin);
        }

        /// <summary>Hostname only; internal pages (chrome://, file://, new tab) report no domain.</summary>
        public static string CleanHost(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            string host = raw.Trim().ToLowerInvariant();
            int scheme = host.IndexOf("://", StringComparison.Ordinal);
            if (scheme >= 0)
            {
                string s = host.Substring(0, scheme);
                if (s != "http" && s != "https") return null;
                host = host.Substring(scheme + 3);
            }
            int cut = host.IndexOfAny(new[] { '/', '?', '#' });
            if (cut >= 0) host = host.Substring(0, cut);
            int at = host.LastIndexOf('@');
            if (at >= 0) host = host.Substring(at + 1);
            int colon = host.IndexOf(':');
            if (colon >= 0) host = host.Substring(0, colon);
            if (host.StartsWith("www.")) host = host.Substring(4);
            if (!HostPattern.IsMatch(host) || (host.IndexOf('.') < 0 && host != "localhost")) return null;
            return host;
        }

        static string ReadHead(NetworkStream stream)
        {
            StringBuilder sb = new StringBuilder();
            int last4 = 0;
            while (sb.Length < 8192)
            {
                int b = stream.ReadByte();
                if (b < 0) return null;
                sb.Append((char)b);
                last4 = ((last4 << 8) | b) & 0x7FFFFFFF;
                if (sb.Length >= 4 && sb[sb.Length - 4] == '\r' && sb[sb.Length - 3] == '\n' && sb[sb.Length - 2] == '\r' && sb[sb.Length - 1] == '\n')
                    return sb.ToString(0, sb.Length - 4);
            }
            return null;
        }

        static void Respond(NetworkStream stream, int status, string body, string origin)
        {
            string reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 400 ? "Bad Request" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : "Error";
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            StringBuilder head = new StringBuilder();
            head.AppendFormat("HTTP/1.1 {0} {1}\r\n", status, reason);
            head.Append("Content-Type: application/json\r\nConnection: close\r\nCache-Control: no-store\r\n");
            if (origin != null)
            {
                head.AppendFormat("Access-Control-Allow-Origin: {0}\r\n", origin);
                head.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n");
            }
            head.AppendFormat("Content-Length: {0}\r\n\r\n", bytes.Length);
            byte[] h = Encoding.ASCII.GetBytes(head.ToString());
            stream.Write(h, 0, h.Length);
            if (bytes.Length > 0) stream.Write(bytes, 0, bytes.Length);
        }
    }
}
