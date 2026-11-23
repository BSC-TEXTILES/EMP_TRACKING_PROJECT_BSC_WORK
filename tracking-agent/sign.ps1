<#
.SYNOPSIS
  Authenticode code-signing script for BSC Activity Tracker executables.
  Dual-engine: Uses signtool.exe if available; falls back to Set-AuthenticodeSignature.
  Signs with SHA-256 and RFC 3161 timestamps.
.PARAMETER FilePath
  Array of executable paths to sign.
.PARAMETER CertThumbprint
  Optional certificate thumbprint in Cert:\CurrentUser\My or Cert:\LocalMachine\My.
.PARAMETER PfxPath
  Optional path to a .pfx file.
.PARAMETER PfxPassword
  Password for the .pfx file.
.PARAMETER TimestampServer
  RFC 3161 timestamp server URL. Defaults to 'http://timestamp.digicert.com'.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$FilePath,
  [string]$CertThumbprint = '',
  [string]$PfxPath = '',
  [string]$PfxPassword = 'BscTextiles@2026',
  [string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

# 1. Resolve Certificate
$cert = $null

if ($PfxPath -and (Test-Path $PfxPath)) {
  $secPass = ConvertTo-SecureString $PfxPassword -AsPlainText -Force
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $secPass)
  Write-Host "Using certificate from PFX: $($cert.Subject) [Thumbprint: $($cert.Thumbprint)]"
} elseif ($CertThumbprint) {
  $cert = Get-Item "Cert:\CurrentUser\My\$CertThumbprint" -ErrorAction SilentlyContinue
  if (-not $cert) {
    $cert = Get-Item "Cert:\LocalMachine\My\$CertThumbprint" -ErrorAction SilentlyContinue
  }
  if (-not $cert) {
    throw "Certificate with thumbprint '$CertThumbprint' not found in CurrentUser\My or LocalMachine\My."
  }
  Write-Host "Using certificate by thumbprint: $($cert.Subject) [Thumbprint: $($cert.Thumbprint)]"
} else {
  # Auto-discover code-signing certificate
  $candidates = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue) +
                @(Get-ChildItem Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue)
  $cert = $candidates | Where-Object { $_.Subject -match 'BSC Textiles' -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
  if (-not $cert) {
    $cert = $candidates | Where-Object { $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
  }
  if ($cert) {
    Write-Host "Auto-selected certificate: $($cert.Subject) [Thumbprint: $($cert.Thumbprint)]"
  } else {
    throw "No code-signing certificate found. Run tracking-agent\create-dev-cert.ps1 or provide -CertThumbprint / -PfxPath."
  }
}

# 2. Check for signtool.exe
$signtool = $null
$sdkPaths = @(
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
  "${env:ProgramFiles}\Windows Kits\10\bin"
)
foreach ($sp in $sdkPaths) {
  if (Test-Path $sp) {
    $signtool = Get-ChildItem $sp -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object FullName -match 'x64' | Select-Object -Last 1
    if ($signtool) { break }
  }
}

$timestampServers = @(
  $TimestampServer,
  'http://timestamp.digicert.com',
  'http://timestamp.sectigo.com',
  'http://tsa.starfieldtech.com'
)

# 3. Sign each file
foreach ($f in $FilePath) {
  if (-not (Test-Path $f)) {
    throw "File to sign does not exist: $f"
  }
  $resolved = (Resolve-Path $f).Path
  Write-Host "Signing $resolved ..." -ForegroundColor Cyan

  $signed = $false

  # Try signtool if available
  if ($signtool) {
    Write-Host "  Using signtool: $($signtool.FullName)"
    foreach ($ts in $timestampServers) {
      try {
        if ($PfxPath) {
          & $signtool.FullName sign /f $PfxPath /p $PfxPassword /fd SHA256 /tr $ts /td SHA256 $resolved 2>&1 | Out-Null
        } else {
          & $signtool.FullName sign /sha1 $cert.Thumbprint /fd SHA256 /tr $ts /td SHA256 $resolved 2>&1 | Out-Null
        }
        if ($LASTEXITCODE -eq 0) { $signed = $true; break }
      } catch {}
    }
    if (-not $signed) {
      # Try without timestamp (e.g. offline)
      if ($PfxPath) {
        & $signtool.FullName sign /f $PfxPath /p $PfxPassword /fd SHA256 $resolved 2>&1 | Out-Null
      } else {
        & $signtool.FullName sign /sha1 $cert.Thumbprint /fd SHA256 $resolved 2>&1 | Out-Null
      }
      if ($LASTEXITCODE -eq 0) { $signed = $true }
    }
  }

  # If signtool was not available or failed, use Set-AuthenticodeSignature
  if (-not $signed) {
    Write-Host "  Using PowerShell Set-AuthenticodeSignature..."
    foreach ($ts in $timestampServers) {
      try {
        $sig = Set-AuthenticodeSignature -FilePath $resolved -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $ts -ErrorAction Stop
        if ($sig.Status -eq 'Valid' -or $sig.Status -eq 'NotTrusted' -or $sig.Status -eq 'UnknownError') {
          $signed = $true
          break
        }
      } catch {}
    }
    if (-not $signed) {
      # Fallback without timestamp (offline/sandbox)
      $sig = Set-AuthenticodeSignature -FilePath $resolved -Certificate $cert -HashAlgorithm SHA256 -ErrorAction Stop
      if ($sig.Status -eq 'Valid' -or $sig.Status -eq 'NotTrusted' -or $sig.Status -eq 'UnknownError') {
        $signed = $true
      }
    }
  }

  # Verification
  $verify = Get-AuthenticodeSignature -FilePath $resolved
  Write-Host "  Signature verification for $(Split-Path $resolved -Leaf):"
  Write-Host "    Status:            $($verify.Status)" -ForegroundColor $(if ($verify.Status -eq 'Valid') { 'Green' } else { 'Yellow' })
  Write-Host "    StatusMessage:     $($verify.StatusMessage)"
  Write-Host "    SignerSubject:     $($verify.SignerCertificate.Subject)"
  Write-Host "    SignerThumbprint:  $($verify.SignerCertificate.Thumbprint)"
  if ($verify.TimeStamperCertificate) {
    Write-Host "    TimeStamper:       $($verify.TimeStamperCertificate.Subject)"
  }
}
