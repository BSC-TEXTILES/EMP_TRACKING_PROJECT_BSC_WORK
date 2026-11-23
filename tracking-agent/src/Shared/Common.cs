// BSC Textiles Activity Tracker - shared constants (agent + setup).
// Language level: C# 5 (.NET Framework 4.8 csc, ships with Windows).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace BscTracker
{
    public static class Product
    {
        public const string Name = "BSC Activity Tracker";
        public const string Publisher = "BSC Textiles Pvt Ltd";
        public const string Copyright = "Copyright © 2026 BSC Textiles Pvt Ltd. All rights reserved.";
        public const string Version = "2.1.0";
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

    public static class SignatureVerifier
    {
        public static string FileSha256Hex(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream fs = File.OpenRead(path))
            {
                byte[] hash = sha.ComputeHash(fs);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        /// <summary>
        /// Full Authenticode check via WinVerifyTrust (the same API Windows uses): the signature
        /// must be cryptographically intact (file unmodified), chain to a root trusted by this
        /// PC, and not be revoked. Then the signing certificate's CN must equal the publisher
        /// this build was signed with (BuildInfo.ExpectedSigner, baked in at build time) - the
        /// server cannot widen that list. Self-signed or tampered files are rejected.
        /// </summary>
        public static bool VerifyPublisher(string filePath, out string error)
        {
            error = null;
            if (!File.Exists(filePath)) { error = "File does not exist: " + filePath; return false; }
            int trust = WinTrust.Verify(filePath);
            if (trust != 0)
            {
                error = "Authenticode verification failed (0x" + trust.ToString("X8") + "): " + WinTrust.Describe(trust);
                return false;
            }
            try
            {
                X509Certificate2 cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(filePath));
                string cn = cert.GetNameInfo(X509NameType.SimpleName, false);
                string expected = ExpectedSigner;
                if (!string.Equals(cn, expected, StringComparison.Ordinal))
                {
                    error = "Publisher mismatch. Expected signer CN '" + expected + "', found '" + cn + "'.";
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                error = "Signature verification error: " + ex.Message;
                return false;
            }
        }

        public static string ExpectedSigner
        {
            get { return Product.Publisher; }
        }
    }

    internal static class WinTrust
    {
        static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct FileInfo
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct TrustData
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false, CharSet = CharSet.Unicode)]
        static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, ref TrustData data);

        const uint WTD_UI_NONE = 2, WTD_REVOKE_WHOLECHAIN = 1, WTD_CHOICE_FILE = 1;
        const uint WTD_STATEACTION_VERIFY = 1, WTD_STATEACTION_CLOSE = 2;
        const uint WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT = 0x80;

        public static int Verify(string path)
        {
            FileInfo fi = new FileInfo();
            fi.cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo));
            fi.pcwszFilePath = path;
            IntPtr pFile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
            Marshal.StructureToPtr(fi, pFile, false);
            TrustData data = new TrustData();
            data.cbStruct = (uint)Marshal.SizeOf(typeof(TrustData));
            data.dwUIChoice = WTD_UI_NONE;
            data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
            data.dwUnionChoice = WTD_CHOICE_FILE;
            data.pFile = pFile;
            data.dwStateAction = WTD_STATEACTION_VERIFY;
            data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
            try
            {
                return WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
            }
            finally
            {
                data.dwStateAction = WTD_STATEACTION_CLOSE;
                WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
                Marshal.DestroyStructure(pFile, typeof(FileInfo));
                Marshal.FreeHGlobal(pFile);
            }
        }

        public static string Describe(int code)
        {
            switch ((uint)code)
            {
                case 0x800B0100: return "file is not signed";
                case 0x800B0109: return "certificate chains to an untrusted root (self-signed or private CA)";
                case 0x80096010: return "signature does not match the file (file modified)";
                case 0x800B0101: return "certificate expired and signature has no timestamp";
                case 0x800B010C: return "certificate revoked";
                case 0x80092013: return "revocation server unreachable";
                case 0x800B0111: return "publisher explicitly distrusted";
                default: return "untrusted";
            }
        }
    }
}

