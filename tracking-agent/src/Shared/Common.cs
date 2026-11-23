// BSC Textiles Activity Tracker - shared constants (agent + setup).
// Language level: C# 5 (.NET Framework 4.8 csc, ships with Windows).
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace BscTracker
{
    public static class Product
    {
        public const string Name = "BSC Activity Tracker";
        public const string Publisher = "BSC Textiles";
        public const string Version = "2.0.0";
        public const string ExeName = "BSCActivityTracker.exe";
        public const string SetupName = "BSC-Activity-Tracker-Setup.exe";
        public const string RegistryPath = @"SOFTWARE\BSC Textiles\Activity Tracker";
        public const string RunValue = "BSCActivityTracker";
        public const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\BSCActivityTracker";
        public const string ShutdownEventName = @"Global\BSCActivityTrackerShutdown";
        public const int BridgePort = 47613;
        public const string DefaultServer = "https://emptrack.bsctextiles.in";

        public static string InstallDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "BSC Textiles", "Activity Tracker"); }
        }

        /// <summary>Machine-wide data root; each Windows user gets an ACL-protected subfolder.</summary>
        public static string DataRoot
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "BSC Textiles", "Activity Tracker", "data"); }
        }

        public static string ReadMachineSetting(string name, string fallback)
        {
            try
            {
                using (RegistryKey key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(RegistryPath))
                {
                    if (key == null) return fallback;
                    object value = key.GetValue(name);
                    return value == null ? fallback : value.ToString();
                }
            }
            catch { return fallback; }
        }
    }

    /// <summary>
    /// Device secrets are protected with DPAPI (LocalMachine scope + product entropy)
    /// and stored in a folder whose ACL allows only the owning user, SYSTEM and
    /// Administrators. Administrators can therefore unenroll on uninstall, while
    /// other standard users on a shared PC cannot read each other's data.
    /// </summary>
    public static class Secure
    {
        static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BSC-Activity-Tracker/v2");

        public static byte[] Protect(string text)
        {
            return ProtectedData.Protect(Encoding.UTF8.GetBytes(text), Entropy, DataProtectionScope.LocalMachine);
        }

        public static string Unprotect(byte[] data)
        {
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(data, Entropy, DataProtectionScope.LocalMachine));
        }

        public static void WriteAtomic(string path, byte[] data)
        {
            string temp = path + ".tmp";
            File.WriteAllBytes(temp, data);
            if (File.Exists(path)) File.Replace(temp, path, null);
            else File.Move(temp, path);
        }

        /// <summary>Restricts a folder to one user + SYSTEM + Administrators (no inheritance).</summary>
        public static void LockDownFolder(string folder, SecurityIdentifier owner)
        {
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(folder, security);
        }

        public static string Sha256Hex(string text)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }
    }
}
