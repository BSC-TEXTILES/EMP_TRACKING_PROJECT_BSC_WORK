<#
.SYNOPSIS
  Builds the BSC Activity Tracker agent and its installer with the C# compiler
  that ships with the .NET Framework 4.8 (present on every Windows 10/11 PC).
  No SDK, NuGet or third-party tooling is required.
  Automatically applies Authenticode code-signing with SHA-256 and RFC 3161 timestamping.

.PARAMETER Server
  Default server URL baked into the installer (can still be overridden with
  /server= at install time). Defaults to https://emptrack.bsctextiles.in.

.PARAMETER SignCertThumbprint
  Optional code-signing certificate thumbprint (CurrentUser\My or LocalMachine\My).

.PARAMETER PfxPath
  Optional path to a .pfx code-signing certificate file.

.PARAMETER PfxPassword
  Password for the .pfx file.

.PARAMETER CreateDevCertIfMissing
  If true or default, automatically creates a local testing/staging cert if no cert exists.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1
#>
param(
  [string]$Server = 'https://emptrack.bsctextiles.in',
  [string]$SignCertThumbprint = '',
  [string]$PfxPath = '',
  [string]$PfxPassword = 'BscTextiles@2026',
  [switch]$CreateDevCertIfMissing = $true
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'src'
$out = Join-Path $root 'dist'
$obj = Join-Path $root 'obj'
New-Item -ItemType Directory -Force $out, $obj | Out-Null

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw ".NET Framework 4.8 C# compiler not found at $csc" }

$refs = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Security.dll', 'System.Web.Extensions.dll') |
  ForEach-Object { "/reference:" + (Join-Path $fw $_) }

function Invoke-Csc([string[]]$arguments) {
  & $csc /nologo /noconfig /nostdlib- /optimize+ /warn:4 /warnaserror- /platform:anycpu @arguments
  if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
}

# 1. Resolve Certificate for Code Signing
$signScript = Join-Path $root 'sign.ps1'
$devCertScript = Join-Path $root 'create-dev-cert.ps1'

$activeThumbprint = $SignCertThumbprint
$devPfx = Join-Path $obj 'dev-codesign.pfx'
if (-not $PfxPath -and (Test-Path $devPfx)) {
  $PfxPath = $devPfx
}

if (-not $activeThumbprint -and -not ($PfxPath -and (Test-Path $PfxPath))) {
  $existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -match 'BSC Textiles' -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
  if ($existing) {
    $activeThumbprint = $existing.Thumbprint
  } elseif ($CreateDevCertIfMissing) {
    Write-Host 'Creating local staging/dev code-signing certificate for BSC Textiles Pvt Ltd...' -ForegroundColor Cyan
    $certResult = & $devCertScript -ExportPfxPath $devPfx -Password $PfxPassword
    $activeThumbprint = $certResult.Thumbprint
    $PfxPath = $devPfx
  }
}

Write-Host '[1/4] Compiling agent (BSCActivityTracker.exe)...' -ForegroundColor Cyan
$agentSources = @(Get-ChildItem (Join-Path $src 'Agent') -Filter *.cs | ForEach-Object FullName) + (Join-Path $src 'Shared\Common.cs')
$agentExeObj = Join-Path $obj 'BSCActivityTracker.exe'
Invoke-Csc (@('/target:winexe', "/out:$agentExeObj", "/win32manifest:$(Join-Path $src 'Agent\agent.manifest')") + $refs + $agentSources)

# 2. CRITICAL: Sign agent executable BEFORE embedding into installer resource
if ($activeThumbprint -or ($PfxPath -and (Test-Path $PfxPath))) {
  Write-Host '[2/4] Signing agent executable before embedding...' -ForegroundColor Cyan
  if ($PfxPath -and (Test-Path $PfxPath)) {
    & $signScript -FilePath $agentExeObj -PfxPath $PfxPath -PfxPassword $PfxPassword
  } else {
    & $signScript -FilePath $agentExeObj -CertThumbprint $activeThumbprint
  }
} else {
  Write-Host '[2/4] Skipping agent signing (no certificate available).' -ForegroundColor Yellow
}

Write-Host '[3/4] Compiling installer (BSC-Activity-Tracker-Setup.exe)...' -ForegroundColor Cyan
$setupSources = @(Get-ChildItem (Join-Path $src 'Setup') -Filter *.cs | ForEach-Object FullName) + (Join-Path $src 'Shared\Common.cs') + (Join-Path $src 'Agent\Api.cs')
$setupExe = Join-Path $out 'BSC-Activity-Tracker-Setup.exe'
$defaultServerFile = Join-Path $obj 'default-server.txt'
[IO.File]::WriteAllText($defaultServerFile, $Server)
Invoke-Csc (@('/target:winexe', "/out:$setupExe", "/win32manifest:$(Join-Path $src 'Setup\setup.manifest')",
  "/resource:$agentExeObj,BscTracker.Payload.BSCActivityTracker.exe",
  "/resource:$defaultServerFile,BscTracker.Payload.default-server.txt") + $refs + $setupSources)

# Copy the signed agent into dist
$agentExeDist = Join-Path $out 'BSCActivityTracker.exe'
Copy-Item $agentExeObj $agentExeDist -Force

Write-Host '[4/4] Signing installer and finalizing...' -ForegroundColor Cyan
if ($activeThumbprint -or ($PfxPath -and (Test-Path $PfxPath))) {
  if ($PfxPath -and (Test-Path $PfxPath)) {
    & $signScript -FilePath $setupExe -PfxPath $PfxPath -PfxPassword $PfxPassword
  } else {
    & $signScript -FilePath $setupExe -CertThumbprint $activeThumbprint
  }
} else {
  Write-Host 'Skipping installer signing (no certificate available).' -ForegroundColor Yellow
}

$setupHash = (Get-FileHash $setupExe -Algorithm SHA256).Hash
$agentHash = (Get-FileHash $agentExeDist -Algorithm SHA256).Hash
Set-Content -Path (Join-Path $out 'SHA256SUMS.txt') -Value @(
  "$setupHash  BSC-Activity-Tracker-Setup.exe",
  "$agentHash  BSCActivityTracker.exe"
) -Encoding ascii

Write-Host "`nBuild complete successfully!" -ForegroundColor Green
Write-Host "  Setup: $setupExe ($setupHash)"
Write-Host "  Agent: $agentExeDist ($agentHash)"
