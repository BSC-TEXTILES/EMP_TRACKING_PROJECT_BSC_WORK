<#
.SYNOPSIS
  Release gate for the BSC Activity Tracker. Exits non-zero unless every executable is
  release-grade signed. Checks, for the setup exe, the agent exe AND the agent payload
  embedded inside setup:
    - Authenticode status is Valid (signature intact = file not modified; chain trusted)
    - signer certificate is not self-signed and chains to a root distributed by Microsoft
      (LocalMachine\AuthRoot, or a Microsoft root) - a root someone installed by hand would
      satisfy this PC but NOT Smart App Control on employee PCs
    - leaf certificate has the Code Signing EKU and a SHA-256 signature algorithm
    - an RFC 3161 timestamp is present (signature stays valid after the cert expires)
    - signer CN equals -PublisherName
    - the embedded payload is byte-identical to the shipped agent
    - SHA256SUMS.txt matches
.PARAMETER Dir
  Folder containing the build (default: dist).
.PARAMETER PublisherName
  Expected certificate CN (the legal name on the certificate).
.PARAMETER AllowUntrusted
  Report problems but do not fail (dev builds).
#>
[CmdletBinding()]
param(
  [string]$Dir = '',
  [string]$PublisherName = 'BSC Textiles Pvt Ltd',
  [switch]$AllowUntrusted
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Dir) { $Dir = Join-Path $root 'dist' }
$setupExe = Join-Path $Dir 'BSC-Activity-Tracker-Setup.exe'
$agentExe = Join-Path $Dir 'BSCActivityTracker.exe'
$problems = New-Object System.Collections.Generic.List[string]
$report = [ordered]@{}

function Test-Signed([string]$label, [string]$path) {
  $r = [ordered]@{ file = (Split-Path $path -Leaf) }
  $sig = Get-AuthenticodeSignature -FilePath $path
  $r.status = "$($sig.Status)"
  $r.statusMessage = $sig.StatusMessage
  $leaf = $sig.SignerCertificate
  if (-not $leaf) { $problems.Add("${label}: not signed"); $r.signed = $false; return $r }
  $r.signed = $true
  $r.signer = $leaf.Subject
  $r.issuer = $leaf.Issuer
  $r.thumbprint = $leaf.Thumbprint
  $r.notAfter = $leaf.NotAfter.ToString('o')
  $r.timestamp = $(if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { $null })
  if ($sig.Status -ne 'Valid') { $problems.Add("${label}: signature status $($sig.Status) - $($sig.StatusMessage)") }
  if (-not $sig.TimeStamperCertificate) { $problems.Add("${label}: no RFC 3161 timestamp") }
  $cn = $leaf.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $r.signerCN = $cn
  if ($cn -cne $PublisherName) { $problems.Add("${label}: signer CN '$cn' is not the expected publisher '$PublisherName'") }
  if ($leaf.Subject -eq $leaf.Issuer) { $problems.Add("${label}: certificate is SELF-SIGNED - Smart App Control will always block it") }
  if ($leaf.SignatureAlgorithm.FriendlyName -notmatch 'sha256|sha384|sha512') { $problems.Add("${label}: certificate signature algorithm $($leaf.SignatureAlgorithm.FriendlyName) is not SHA-2") }
  $eku = $leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' }
  if (-not $eku -or -not ($eku.EnhancedKeyUsages | Where-Object Value -eq '1.3.6.1.5.5.7.3.3')) { $problems.Add("${label}: certificate lacks the Code Signing EKU") }

  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'Online'
  [void]$chain.Build($leaf)
  $rootCert = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
  $r.root = $rootCert.Subject
  $inAuthRoot = [bool](Get-ChildItem Cert:\LocalMachine\AuthRoot -ErrorAction SilentlyContinue | Where-Object Thumbprint -eq $rootCert.Thumbprint)
  $microsoftRoot = ($rootCert.Subject -match 'O=Microsoft Corporation') -and [bool](Get-ChildItem Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $rootCert.Thumbprint)
  $r.rootDistributedByMicrosoft = ($inAuthRoot -or $microsoftRoot)
  if (-not $r.rootDistributedByMicrosoft) {
    $problems.Add("${label}: root '$($rootCert.Subject)' is not a Microsoft-distributed root (installed locally or private CA) - employee PCs will not trust it")
  }
  foreach ($s in $chain.ChainStatus) {
    if ($s.Status -ne 'NoError' -and $s.Status -ne 'RevocationStatusUnknown' -and $s.Status -ne 'OfflineRevocation') { $problems.Add("${label}: chain $($s.Status) - $($s.StatusInformation.Trim())") }
  }
  return $r
}

foreach ($f in @($setupExe, $agentExe)) { if (-not (Test-Path $f)) { throw "Missing build output: $f" } }
Write-Host "Verifying build in $Dir (expected publisher CN: $PublisherName)" -ForegroundColor Cyan
$report.setup = Test-Signed 'Setup' $setupExe
$report.agent = Test-Signed 'Agent' $agentExe

# Embedded payload
$asm = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($setupExe))
$stream = $asm.GetManifestResourceStream('BscTracker.Payload.BSCActivityTracker.exe')
if (-not $stream) { throw 'Agent payload resource not found inside setup.' }
$buf = New-Object byte[] $stream.Length
$read = 0; while ($read -lt $buf.Length) { $n = $stream.Read($buf, $read, $buf.Length - $read); if ($n -le 0) { break }; $read += $n }
$stream.Close()
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("bsc-payload-" + [guid]::NewGuid().ToString('N') + '.exe')
[IO.File]::WriteAllBytes($tmp, $buf)
try {
  $report.embeddedAgent = Test-Signed 'Embedded agent' $tmp
  $report.embeddedAgent.file = 'BSCActivityTracker.exe (inside setup)'
  if ((Get-FileHash $tmp -Algorithm SHA256).Hash -ne (Get-FileHash $agentExe -Algorithm SHA256).Hash) { $problems.Add('Embedded agent differs from the shipped BSCActivityTracker.exe') }
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }

$sums = Join-Path $Dir 'SHA256SUMS.txt'
if (Test-Path $sums) {
  foreach ($line in Get-Content $sums) {
    if ($line -match '^([0-9A-Fa-f]{64})\s+(\S.*)$') {
      $p = Join-Path $Dir $Matches[2]
      if (-not (Test-Path $p) -or (Get-FileHash $p -Algorithm SHA256).Hash -ne $Matches[1].ToUpper()) { $problems.Add("SHA256SUMS mismatch for $($Matches[2])") }
    }
  }
}

foreach ($k in 'setup', 'agent', 'embeddedAgent') {
  $e = $report[$k]
  Write-Host ("  {0,-15} {1,-10} signer={2} root={3} timestamp={4}" -f $k, $e.status, $e.signerCN, $e.root, $(if ($e.timestamp) { 'yes' } else { 'NO' }))
}
$report.releaseGrade = ($problems.Count -eq 0)
$report.problems = @($problems)
if ($problems.Count -gt 0) {
  Write-Host "`nNOT RELEASE-GRADE:" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  if (-not $AllowUntrusted) { [pscustomobject]$report; exit 1 }
} else {
  Write-Host "`nRelease gate passed: all components validly signed, timestamped, publisher '$PublisherName'." -ForegroundColor Green
}
[pscustomobject]$report
