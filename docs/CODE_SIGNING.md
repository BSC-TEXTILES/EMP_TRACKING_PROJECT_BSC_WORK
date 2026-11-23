# Code signing the BSC Activity Tracker (Smart App Control)

## 1. Why the installer is blocked: root cause (verified 2026-11-23)

Employee PCs show *"Smart App Control blocked an app that may be unsafe. We could not
verify its publisher."* for `BSC-Activity-Tracker-Setup.exe`.

The shipped installer **is** signed, but with a **self-signed certificate**:

| Check (`Get-AuthenticodeSignature`) | Shipped 2.0.0 installer and agent |
|---|---|
| Signer | `CN=BSC Textiles Pvt Ltd, O=BSC Textiles Pvt Ltd, C=IN` |
| Issuer | the same: self-signed |
| Status | `UnknownError`: *chain terminated in a root certificate which is not trusted* |
| Timestamp | none |

Windows logged the block as CodeIntegrity events **3077 / 3033**: *"did not meet the
Enterprise signing level requirements"*, policy `{0283ac0f-fff1-49ae-ada1-8a933130cad6}`
(Smart App Control).

Smart App Control lets an app run only if Microsoft's cloud service predicts it is safe,
**or** it is signed with a certificate that chains to a CA in the **Microsoft Trusted Root
Program**. A self-signed certificate never chains to such a CA. Smart App Control also
ignores certificates installed locally ("Trusted Publishers", "Trusted Root"). So the
previous build was blocked on **every** PC, by design, whatever publisher name it showed.

Earlier pipeline defects that hid this:
- `build.ps1` silently created and used a self-signed certificate when no real one existed.
- `sign.ps1` counted `NotTrusted`/`UnknownError` as success and fell back to signing without a timestamp.
- `verify-build.ps1` printed "Signed: Yes" for any certificate.
- A PFX password was hard-coded.

All of this is fixed: a release build now **refuses** to run without a trusted identity
and **fails** unless every binary passes the release gate.

## 2. What BSC Textiles must obtain (one-time, cannot be done in code)

Pick **one**:

### Option A: OV code-signing certificate from a public CA (recommended)
Issued by, for example, DigiCert, Sectigo, GlobalSign, SSL.com or Certum (resellers in India
are fine). Since June 2023, CAs issue these keys only on a **hardware token** (USB) or in a
**cloud HSM** (DigiCert KeyLocker, SSL.com eSigner, GlobalSign). No `.pfx` file is handed
over, so the key cannot leak into source code.

The CA will verify the company identity. Typical requirements:
- legal name exactly as registered (for example "BSC Textiles Private Limited"), with the
  Certificate of Incorporation / CIN and GST registration;
- a business address and a phone number listed in a public directory (D-U-N-S, or a
  government registry); the CA calls this number;
- an authorised signatory (director) who confirms the order.

The certificate's **CN will be the legal name the CA verified**. The build reads it from the
certificate automatically and compiles it into the agent as the only accepted update publisher.

An EV certificate also works, but since 2024 it no longer gives instant SmartScreen
reputation, so OV is enough.

### Option B: Microsoft Azure Trusted Signing (Artifact Signing)
A monthly subscription. Microsoft verifies the organisation, and keys stay in Microsoft's
HSM. Check in the Azure portal whether organisations registered in India are currently
eligible before choosing this option.

## 3. Building a signed release

On the build PC, install `signtool.exe`: either the Windows SDK, selecting only "Windows SDK
Signing Tools for Desktop Apps", or `winget install Microsoft.WindowsSDK.10.0.26100`.
signtool and the token driver are Microsoft- or vendor-signed, so Smart App Control allows them.

```powershell
# Option A: token / cloud-HSM certificate (plug in the token, or sign in to the HSM client first)
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Issuer, Thumbprint, NotAfter
powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1 `
  -Server https://emptrack.bsctextiles.in -CertThumbprint <Thumbprint>

# Option B: Azure Trusted Signing
powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1 `
  -Server https://emptrack.bsctextiles.in `
  -TrustedSigningMetadata C:\signing\metadata.json `
  -TrustedSigningDlib C:\signing\Microsoft.Trusted.Signing.Client\bin\x64\Azure.CodeSigning.Dlib.dll `
  -PublisherName "<exact CN of the certificate profile>"
```

What the pipeline does:
1. Compiles the agent and **signs it** (SHA-256 file digest, RFC 3161 SHA-256 timestamp; it tries DigiCert, then Sectigo, then GlobalSign; it never signs without a timestamp).
2. Embeds the signed agent in the installer and signs the installer. The uninstaller is the installed copy of the same signed setup exe. There are no DLLs, drivers, scripts or third-party executables to sign.
3. `verify-build.ps1` (the release gate) checks the setup exe, the agent exe **and the agent extracted from inside setup**: status `Valid`, not self-signed, root distributed by Microsoft, Code Signing EKU, SHA-2, timestamp present, CN equal to the publisher, embedded copy byte-identical, `SHA256SUMS.txt` correct.
4. Only after the gate passes does it copy the files to `tracking-agent/dist/` with `release-manifest.json`. On any failure, `dist/` is left untouched.

Re-check any build at any time:
```powershell
powershell -ExecutionPolicy Bypass -File tracking-agent\verify-build.ps1 -PublisherName "<CN>"
```

Then deploy `tracking-agent/dist/` (installer, `SHA256SUMS.txt`, `release-manifest.json`) to
the server. In the HRMS, *User Activity Tracking → Devices & enrollment* must show
**Trusted signature**. Finally, raise *latest agent version* to `2.1.0` in tracking settings
so enrolled agents update themselves.

## 4. Acceptance test on employee PCs

Use at least one **clean Windows 11 PC with Smart App Control ON** (Settings → Privacy &
security → Windows Security → App & browser control → Smart App Control = On) and Defender on:

1. Download the installer from the HRMS with Edge, so it carries the internet "Mark of the Web".
2. In Explorer, open Properties → Digital Signatures: the signer is the company and "This digital signature is OK".
3. Run it. Expected: no Smart App Control block. A UAC prompt naming the company as **Verified publisher** is normal.
4. Complete the checklist in [TRACKING_AGENT.md](TRACKING_AGENT.md#test-checklist-run-on-a-signed-build-on-a-company-pc).

If Smart App Control still blocks the signed build:
```powershell
Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 50 |
  Where-Object Id -in 3033,3077,3089 | Format-List TimeCreated, Id, Message
Get-AuthenticodeSignature .\BSC-Activity-Tracker-Setup.exe | Format-List *
```
- Event 3089 lists the signature Windows actually saw. Confirm it names the trusted CA, not the dev certificate.
- Check whether Defender quarantined or flagged the file (Windows Security → Protection history). If it is a false positive, submit the installer as a **Software developer** at https://www.microsoft.com/wdsi/filesubmission.
- Record the event text and the signature details in the release ticket.

## 5. Never do this

- Do not tell employees to switch off Smart App Control, Defender or SmartScreen. Once switched off, Smart App Control cannot be switched back on without reinstalling Windows.
- Do not install the dev certificate on employee PCs, edit registry or CI policies, rename executables, or use PowerShell bypasses.
- Do not commit `.pfx`/`.p12` files or passwords (`.gitignore` blocks them). Keep the token, or the HSM credentials, with IT.
- `build.ps1 -DevSign` builds are for test PCs where Smart App Control is off. They go to `dist-dev/`, which the server never serves.
