<#
.SYNOPSIS
  DEV/TEST ONLY. Generates a SELF-SIGNED code-signing certificate for local test builds
  (build.ps1 -DevSign). Windows Smart App Control and SmartScreen will ALWAYS treat binaries
  signed with it as "unverified publisher" on every PC - it can never be used for a release,
  and build.ps1 refuses to put such a build in dist\. Do not install it on employee PCs.
.PARAMETER Subject
  Distinguished name for the certificate. Defaults to "CN=BSC Textiles Pvt Ltd, O=BSC Textiles Pvt Ltd, C=IN".
.PARAMETER ExportPfxPath
  Optional path to export the certificate as a PKCS#12 (.pfx) bundle (requires -Password).
.PARAMETER Password
  Password for the exported PFX (no default; never commit it).
#>
[CmdletBinding()]
param(
  [string]$Subject = "CN=BSC Textiles Pvt Ltd, O=BSC Textiles Pvt Ltd, C=IN",
  [string]$ExportPfxPath = "",
  [string]$Password = ""
)

$ErrorActionPreference = 'Stop'
Write-Host "Creating code-signing certificate for '$Subject'..." -ForegroundColor Cyan

# Check if a matching valid cert already exists in CurrentUser\My
$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -match 'BSC Textiles' -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
  Select-Object -First 1

if ($existing) {
  Write-Host "Found existing valid certificate: $($existing.Thumbprint)" -ForegroundColor Green
  $cert = $existing
} else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert `
    -Subject $Subject `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -HashAlgorithm SHA256 `
    -KeyLength 2048 `
    -KeyUsage DigitalSignature `
    -NotAfter (Get-Date).AddYears(5)
  Write-Host "Generated new certificate: $($cert.Thumbprint)" -ForegroundColor Green
}

if ($ExportPfxPath) {
  if (-not $Password) { throw 'Pass -Password to export a PFX.' }
  $dir = Split-Path -Parent $ExportPfxPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $secPass = ConvertTo-SecureString $Password -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath $ExportPfxPath -Password $secPass | Out-Null
  Write-Host "Exported PFX to $ExportPfxPath" -ForegroundColor Green
}

[PSCustomObject]@{
  Thumbprint = $cert.Thumbprint
  Subject    = $cert.Subject
  Issuer     = $cert.Issuer
  NotAfter   = $cert.NotAfter
}
