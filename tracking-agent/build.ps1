<#
.SYNOPSIS
  Builds the BSC Activity Tracker agent and its installer with the C# compiler
  that ships with the .NET Framework 4.8 (present on every Windows 10/11 PC).
  No SDK, NuGet or third-party tooling is required.

.PARAMETER Server
  Default server URL baked into the installer (can still be overridden with
  /server= at install time). Defaults to https://emptrack.bsctextiles.in.

.PARAMETER SignCertThumbprint
  Optional code-signing certificate thumbprint (CurrentUser\My or LocalMachine\My).
  When given, signtool.exe signs both executables with SHA-256 and a timestamp.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1
#>
param(
  [string]$Server = 'https://emptrack.bsctextiles.in',
  [string]$SignCertThumbprint = ''
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

Write-Host '[1/3] Compiling agent (BSCActivityTracker.exe)...'
$agentSources = @(Get-ChildItem (Join-Path $src 'Agent') -Filter *.cs | ForEach-Object FullName) + (Join-Path $src 'Shared\Common.cs')
$agentExe = Join-Path $obj 'BSCActivityTracker.exe'
Invoke-Csc (@('/target:winexe', "/out:$agentExe", "/win32manifest:$(Join-Path $src 'Agent\agent.manifest')") + $refs + $agentSources)

Write-Host '[2/3] Compiling installer (BSC-Activity-Tracker-Setup.exe)...'
$setupSources = @(Get-ChildItem (Join-Path $src 'Setup') -Filter *.cs | ForEach-Object FullName) + (Join-Path $src 'Shared\Common.cs') + (Join-Path $src 'Agent\Api.cs')
$setupExe = Join-Path $out 'BSC-Activity-Tracker-Setup.exe'
$defaultServerFile = Join-Path $obj 'default-server.txt'
[IO.File]::WriteAllText($defaultServerFile, $Server)
Invoke-Csc (@('/target:winexe', "/out:$setupExe", "/win32manifest:$(Join-Path $src 'Setup\setup.manifest')",
  "/resource:$agentExe,BscTracker.Payload.BSCActivityTracker.exe",
  "/resource:$defaultServerFile,BscTracker.Payload.default-server.txt") + $refs + $setupSources)

Copy-Item $agentExe (Join-Path $out 'BSCActivityTracker.exe') -Force

if ($SignCertThumbprint) {
  Write-Host '[3/3] Signing...'
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object FullName -match 'x64' | Select-Object -Last 1
  if (-not $signtool) { throw 'signtool.exe not found (install the Windows SDK signing tools).' }
  foreach ($file in @((Join-Path $out 'BSCActivityTracker.exe'), $setupExe)) {
    & $signtool.FullName sign /sha1 $SignCertThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $file
    if ($LASTEXITCODE -ne 0) { throw "signing failed for $file" }
  }
} else {
  Write-Host '[3/3] Skipping code signing (no -SignCertThumbprint). Sign before wide deployment.'
}

$hash = (Get-FileHash $setupExe -Algorithm SHA256).Hash
Set-Content -Path (Join-Path $out 'SHA256SUMS.txt') -Value @(
  "$hash  BSC-Activity-Tracker-Setup.exe",
  "$((Get-FileHash (Join-Path $out 'BSCActivityTracker.exe') -Algorithm SHA256).Hash)  BSCActivityTracker.exe"
) -Encoding ascii
Write-Host "Done: $setupExe"
Write-Host "SHA-256: $hash"
