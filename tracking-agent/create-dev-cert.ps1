<#
.SYNOPSIS
  Generates a local SHA-256 Authenticode code-signing certificate for development,
  testing, and lab environments for "BSC Textiles Pvt Ltd".
.PARAMETER Subject
  Distinguished name for the certificate. Defaults to "CN=BSC Textiles Pvt Ltd, O=BSC Textiles Pvt Ltd, C=IN".
.PARAMETER ExportPfxPath
  Optional path to export the certificate as a PKCS#12 (.pfx) bundle.
.PARAMETER Password
  Password for the exported PFX. Defaults to "BscTextiles@2026".
#>
[CmdletBinding()]
param(
  [string]$Subject = "CN=BSC Textiles Pvt Ltd, O=BSC Textiles Pvt Ltd, C=IN",
  [string]$ExportPfxPath = "",
  [string]$Password = "BscTextiles@2026"
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

# Add to CurrentUser\TrustedPublisher so publisher is explicitly trusted
try {
  $pubStore = New-Object System.Security.Cryptography.X509Certificates.X509Store([System.Security.Cryptography.X509Certificates.StoreName]::TrustedPublisher, [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
  $pubStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $alreadyInPub = $pubStore.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if (-not $alreadyInPub) {
    $pubStore.Add($cert)
    Write-Host "Trusted in CurrentUser\TrustedPublisher store." -ForegroundColor Green
  }
  $pubStore.Close()
} catch {
  Write-Warning "Could not add to CurrentUser\TrustedPublisher store: $($_.Exception.Message)"
}

if ($ExportPfxPath) {
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
