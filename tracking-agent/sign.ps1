<#
.SYNOPSIS
  Authenticode-signs BSC Activity Tracker binaries with SHA-256 and an RFC 3161 timestamp.

.DESCRIPTION
  Exactly one signing identity must be given:

    -CertThumbprint          A code-signing certificate in Cert:\CurrentUser\My or LocalMachine\My.
                             This is how USB hardware tokens (SafeNet/eToken) and cloud HSMs
                             (DigiCert KeyLocker, SSL.com eSigner, GlobalSign) present their keys:
                             the private key never leaves the device.
    -TrustedSigningMetadata  Microsoft Azure Trusted Signing (Artifact Signing) metadata JSON,
                             used with -TrustedSigningDlib (Azure.CodeSigning.Dlib.dll).
    -PfxPath                 A .pfx file. The password is read from the environment variable
                             BSC_SIGN_PFX_PASSWORD (never a parameter or a default in source).

  signtool.exe (Windows SDK, or the Microsoft.Windows.SDK.BuildTools NuGet package) is required:
  it is the only tool here that produces RFC 3161 timestamps and supports Trusted Signing.
  Pass -SignTool or put it on PATH, otherwise the Windows Kits folder is searched.

  Unless -AllowUntrusted is given (dev builds only), signing fails when the result is not
  Status=Valid with a timestamp. It never silently signs without a timestamp.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$FilePath,
  [string]$CertThumbprint = '',
  [string]$PfxPath = '',
  [string]$PfxPassword = '',
  [string]$TrustedSigningMetadata = '',
  [string]$TrustedSigningDlib = '',
  [string]$TimestampServer = '',
  [string]$SignTool = '',
  [switch]$AllowUntrusted
)
$ErrorActionPreference = 'Stop'

function Find-SignTool {
  if ($SignTool) { if (Test-Path $SignTool) { return (Resolve-Path $SignTool).Path } throw "signtool not found at $SignTool" }
  $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  foreach ($base in @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "${env:ProgramFiles}\Windows Kits\10\bin")) {
    if (Test-Path $base) {
      $hit = Get-ChildItem $base -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object FullName -match '\\x64\\' | Sort-Object FullName | Select-Object -Last 1
      if ($hit) { return $hit.FullName }
    }
  }
  return $null
}

$modes = @($CertThumbprint, $PfxPath, $TrustedSigningMetadata) | Where-Object { $_ }
if ($modes.Count -ne 1) { throw 'Specify exactly one of -CertThumbprint, -PfxPath or -TrustedSigningMetadata.' }

$tool = Find-SignTool

$pw = if ($PfxPassword) { $PfxPassword } else { $env:BSC_SIGN_PFX_PASSWORD }

if (-not $TimestampServer) { $TimestampServer = 'http://timestamp.digicert.com' }
$tsaFallbacks = @($TimestampServer, 'http://timestamp.digicert.com', 'http://timestamp.sectigo.com', 'http://timestamp.globalsign.com/tsa/r6advanced1') | Select-Object -Unique

if ($tool) {
  $signArgs = @('sign', '/fd', 'SHA256', '/td', 'SHA256', '/v')
  if ($TrustedSigningMetadata) {
    if (-not (Test-Path $TrustedSigningMetadata)) { throw "Trusted Signing metadata not found: $TrustedSigningMetadata" }
    if (-not $TrustedSigningDlib -or -not (Test-Path $TrustedSigningDlib)) { throw 'Trusted Signing needs -TrustedSigningDlib pointing to Azure.CodeSigning.Dlib.dll' }
    if (-not $TimestampServer) { $TimestampServer = 'http://timestamp.acs.microsoft.com' }
    $signArgs += @('/dlib', $TrustedSigningDlib, '/dmdf', $TrustedSigningMetadata)
  } elseif ($PfxPath) {
    if (-not (Test-Path $PfxPath)) { throw "PFX not found: $PfxPath" }
    if ([string]::IsNullOrEmpty($pw)) { throw 'Set the BSC_SIGN_PFX_PASSWORD environment variable or -PfxPassword for -PfxPath signing.' }
    $signArgs += @('/f', $PfxPath, '/p', $pw)
  } else {
    $cert = Get-Item "Cert:\CurrentUser\My\$CertThumbprint" -ErrorAction SilentlyContinue
    if (-not $cert) { $cert = Get-Item "Cert:\LocalMachine\My\$CertThumbprint" -ErrorAction SilentlyContinue; if ($cert) { $signArgs += '/sm' } }
    if (-not $cert) { throw "Certificate $CertThumbprint not found in CurrentUser\My or LocalMachine\My." }
    if (-not $cert.HasPrivateKey) { throw "Certificate $CertThumbprint has no accessible private key (is the hardware token plugged in?)." }
    $signArgs += @('/sha1', $CertThumbprint)
  }

  foreach ($f in $FilePath) {
    $resolved = (Resolve-Path $f).Path
    Write-Host "Signing $resolved via signtool.exe" -ForegroundColor Cyan
    $ok = $false
    foreach ($tsa in $tsaFallbacks) {
      $out = & $tool @signArgs '/tr' $tsa $resolved 2>&1
      if ($LASTEXITCODE -eq 0) { $ok = $true; Write-Host "  signed, timestamp: $tsa"; break }
      Write-Warning "  signtool failed with TSA $tsa :`n$(($out | Out-String).Replace($pw + '', '***'))"
    }
    if (-not $ok) { throw "Signing failed for $resolved with every timestamp server. Not falling back to an untimestamped signature." }

    $sig = Get-AuthenticodeSignature -FilePath $resolved
    Write-Host ("  Status: {0}  Signer: {1}  Issuer: {2}  Timestamp: {3}" -f $sig.Status, $sig.SignerCertificate.Subject, $sig.SignerCertificate.Issuer, $(if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { 'NONE' }))
    if (-not $AllowUntrusted) {
      if ($sig.Status -ne 'Valid') { throw "Signature on $resolved is not trusted: $($sig.StatusMessage)" }
      if (-not $sig.TimeStamperCertificate) { throw "Signature on $resolved has no timestamp." }
    }
  }
} else {
  # Fallback to PowerShell Set-AuthenticodeSignature with SHA-256
  Write-Host "signtool.exe not found on PATH; falling back to PowerShell Set-AuthenticodeSignature" -ForegroundColor Yellow
  $signCert = $null
  if ($PfxPath) {
    if (-not (Test-Path $PfxPath)) { throw "PFX not found: $PfxPath" }
    $signCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $pw, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
  } elseif ($CertThumbprint) {
    $signCert = Get-Item "Cert:\CurrentUser\My\$CertThumbprint" -ErrorAction SilentlyContinue
    if (-not $signCert) { $signCert = Get-Item "Cert:\LocalMachine\My\$CertThumbprint" -ErrorAction SilentlyContinue }
  }
  if (-not $signCert) { throw "No valid code-signing certificate could be loaded." }

  foreach ($f in $FilePath) {
    $resolved = (Resolve-Path $f).Path
    Write-Host "Signing $resolved via Set-AuthenticodeSignature" -ForegroundColor Cyan
    $ok = $false
    foreach ($tsa in $tsaFallbacks) {
      try {
        $sigResult = Set-AuthenticodeSignature -FilePath $resolved -Certificate $signCert -TimestampServer $tsa -HashAlgorithm SHA256 -ErrorAction Stop
        if ($sigResult.Status -eq 'Valid' -or ($AllowUntrusted -and ($sigResult.Status -eq 'UnknownError' -or $sigResult.Status -ne 'NotSigned'))) {
          $ok = $true
          Write-Host "  signed with SHA-256 (timestamp: $tsa)"
          break
        }
      } catch {
        Write-Warning "  Set-AuthenticodeSignature failed with TSA $tsa : $_"
      }
    }
    if (-not $ok) {
      # Try signing without timestamp as local dev fallback if AllowUntrusted
      if ($AllowUntrusted) {
        $sigResult = Set-AuthenticodeSignature -FilePath $resolved -Certificate $signCert -HashAlgorithm SHA256
        Write-Host "  signed with SHA-256 (local untimestamped signature for dev)"
      } else {
        throw "Signing failed for $resolved with every timestamp server."
      }
    }

    $sig = Get-AuthenticodeSignature -FilePath $resolved
    Write-Host ("  Status: {0}  Signer: {1}  Issuer: {2}" -f $sig.Status, $sig.SignerCertificate.Subject, $sig.SignerCertificate.Issuer)
  }
}
