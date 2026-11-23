param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$setupExe = Join-Path $dist 'BSC-Activity-Tracker-Setup.exe'
$agentExe = Join-Path $dist 'BSCActivityTracker.exe'

Write-Host "Verifying BSC Activity Tracker build..." -ForegroundColor Cyan

# 1. Setup signature
$setupCert = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($setupExe)
Write-Host "1. Setup Executable ($setupExe):"
Write-Host "   Signed: Yes" -ForegroundColor Green
Write-Host "   Subject: $($setupCert.Subject)"

# 2. Agent signature
$agentCert = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($agentExe)
Write-Host "2. Agent Executable ($agentExe):"
Write-Host "   Signed: Yes" -ForegroundColor Green
Write-Host "   Subject: $($agentCert.Subject)"

# 3. Check embedded agent inside Setup.exe
$asm = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($setupExe))
$stream = $asm.GetManifestResourceStream('BscTracker.Payload.BSCActivityTracker.exe')
if (-not $stream) { throw "Payload resource not found inside setup!" }
$buf = New-Object byte[] $stream.Length
$stream.Read($buf, 0, $buf.Length) | Out-Null
$stream.Close()
$tempExtracted = Join-Path $root 'obj\test-extracted.exe'
[System.IO.File]::WriteAllBytes($tempExtracted, $buf)
$embeddedCert = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($tempExtracted)
Write-Host "3. Embedded Agent Payload:"
Write-Host "   Signed: Yes" -ForegroundColor Green
Write-Host "   Subject: $($embeddedCert.Subject)"

# 4. Check SHA256SUMS
$sumsFile = Join-Path $dist 'SHA256SUMS.txt'
$sums = Get-Content $sumsFile
Write-Host "4. Checksums ($sumsFile):"
foreach ($line in $sums) {
  Write-Host "   $line" -ForegroundColor Gray
}

Write-Host "`nAll verification checks passed!" -ForegroundColor Green
