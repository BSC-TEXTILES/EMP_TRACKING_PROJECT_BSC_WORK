using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace BscTracker
{
    internal sealed class ApiResult
    {
        public int Status;                       // HTTP status, 0 = network failure
        public Dictionary<string, object> Body;  // parsed JSON (may be null)
        public string Error;                     // human readable

        public bool Ok { get { return Status >= 200 && Status < 300; } }
        public bool NetworkFailure { get { return Status == 0 || Status >= 500 || Status == 429; } }
        public bool Unauthorized { get { return Status == 401; } }
    }

    /// <summary>Minimal JSON-over-HTTPS client for the HRMS tracking API.</summary>
    internal static class Api
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };

        static Api()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            ServicePointManager.Expect100Continue = false;
        }

        /// <summary>HTTPS is required except for a server on this machine (development).</summary>
        public static string ValidateServer(string url)
        {
            Uri uri;
            if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url.Trim().TrimEnd('/'), UriKind.Absolute, out uri)) return null;
            bool local = uri.IsLoopback;
            bool insecureAllowed = Product.ReadMachineSetting("AllowInsecureHttp", "0") == "1";
            if (uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && (local || insecureAllowed)))
                return uri.GetLeftPart(UriPartial.Authority) + uri.AbsolutePath.TrimEnd('/');
            return null;
        }

        public static ApiResult Post(string server, string path, object body, string token)
        {
            ApiResult result = new ApiResult();
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(server + "/api" + path);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Accept = "application/json";
                request.UserAgent = "BSCActivityTracker/" + Product.Version;
                request.Timeout = 20000;
                request.ReadWriteTimeout = 20000;
                request.AllowAutoRedirect = false;
                if (token != null) request.Headers["Authorization"] = "Bearer " + token;
                byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(body ?? new Dictionary<string, object>()));
                request.ContentLength = payload.Length;
                using (Stream s = request.GetRequestStream()) s.Write(payload, 0, payload.Length);
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    result.Status = (int)response.StatusCode;
                    result.Body = Read(response);
                }
            }
            catch (WebException ex)
            {
                HttpWebResponse response = ex.Response as HttpWebResponse;
                if (response != null)
                {
                    using (response)
                    {
                        result.Status = (int)response.StatusCode;
                        result.Body = Read(response);
                    }
                    result.Error = ServerMessage(result.Body) ?? ("HTTP " + result.Status);
                }
                else
                {
                    result.Status = 0;
                    result.Error = ex.Status == WebExceptionStatus.Timeout ? "Server did not respond (timeout)" : "Server unreachable (" + ex.Status + ")";
                }
            }
            catch (Exception ex)
            {
                result.Status = 0;
                result.Error = ex.Message;
            }
            return result;
        }

        static Dictionary<string, object> Read(HttpWebResponse response)
        {
            try
            {
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string text = reader.ReadToEnd();
                    if (string.IsNullOrWhiteSpace(text)) return null;
                    return Json.Deserialize<Dictionary<string, object>>(text);
                }
            }
            catch { return null; }
        }

        static string ServerMessage(Dictionary<string, object> body)
        {
            if (body == null) return null;
            object error;
            if (body.TryGetValue("error", out error))
            {
                Dictionary<string, object> e = error as Dictionary<string, object>;
                if (e != null && e.ContainsKey("message")) return Convert.ToString(e["message"]);
                if (error is string) return (string)error;
            }
            object message;
            return body.TryGetValue("message", out message) ? Convert.ToString(message) : null;
        }

        public static string Serialize(object value) { return Json.Serialize(value); }
        public static T Deserialize<T>(string text) { return Json.Deserialize<T>(text); }

        public static string IsoNow() { return DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); }
        public static string Iso(DateTime utc) { return utc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); }

        public static Dictionary<string, object> Dict(Dictionary<string, object> parent, string key)
        {
            object value;
            return parent != null && parent.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            object value;
            return d != null && d.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
        }

        public static int Int(Dictionary<string, object> d, string key, int fallback)
        {
            object value;
            if (d == null || !d.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt32(value); } catch { return fallback; }
        }

        public static bool Bool(Dictionary<string, object> d, string key, bool fallback)
        {
            object value;
            if (d == null || !d.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToBoolean(value); } catch { return fallback; }
        }

        public static bool DownloadFile(string server, string path, string destPath, string token, out string error)
        {
            error = null;
            try
            {
                string url = path.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || path.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                    ? path
                    : server + (path.StartsWith("/") ? path : "/" + path);

                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.UserAgent = "BSCActivityTracker/" + Product.Version;
                request.Timeout = 60000;
                request.ReadWriteTimeout = 60000;
                if (!string.IsNullOrEmpty(token)) request.Headers["Authorization"] = "Bearer " + token;

                string tempPath = destPath + ".tmp";
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300)
                    {
                        error = "HTTP " + (int)response.StatusCode;
                        return false;
                    }
                    using (Stream src = response.GetResponseStream())
                    using (FileStream dst = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        byte[] buffer = new byte[81920];
                        int read;
                        while ((read = src.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            dst.Write(buffer, 0, read);
                        }
                    }
                }
                if (File.Exists(destPath)) File.Delete(destPath);
                File.Move(tempPath, destPath);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }
    }
}
