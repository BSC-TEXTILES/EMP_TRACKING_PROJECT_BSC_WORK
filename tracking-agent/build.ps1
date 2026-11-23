<#
.SYNOPSIS
  Builds and Authenticode-signs the BSC Activity Tracker agent and installer with the C#
  compiler that ships with .NET Framework 4.8 (on every Windows 10/11 PC).

.DESCRIPTION
  RELEASE build (output: dist\, served by the HRMS backend) requires a code-signing identity
  issued to BSC Textiles by a CA in Microsoft's Trusted Root Program, via ONE of:
    -CertThumbprint <sha1>            certificate in the Windows store (USB token / cloud HSM)
    -TrustedSigningMetadata <json>    Azure Trusted Signing, with -TrustedSigningDlib <dll>
    -PfxPath <file>                   with $env:BSC_SIGN_PFX_PASSWORD
  The agent is signed BEFORE it is embedded in the installer, the installer is signed after,
  and verify-build.ps1 must pass (valid chain to a Microsoft-distributed root, RFC 3161
  timestamp, expected publisher, payload identical) before anything is copied to dist\.
  A self-signed, untimestamped or unverified build can never reach dist\.

  DEV build (output: dist-dev\, never served):
    -DevSign      sign with the local self-signed test certificate (create-dev-cert.ps1).
                  Smart App Control WILL block these; use only on test PCs with SAC off.
    -CompileOnly  compile without signing (CI compile check).

.EXAMPLE
  # USB token / cloud HSM certificate in the store:
  powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1 -CertThumbprint 0123ABCD...
.EXAMPLE
  # Azure Trusted Signing:
  powershell -ExecutionPolicy Bypass -File tracking-agent\build.ps1 -TrustedSigningMetadata C:\sign\metadata.json `
     -TrustedSigningDlib C:\sign\Azure.CodeSigning.Dlib.dll -PublisherName "BSC Textiles Private Limited"
#>
param(
  [string]$Server = 'https://emptrack.bsctextiles.in',
  [string]$CertThumbprint = '',
  [string]$PfxPath = '',
  [string]$TrustedSigningMetadata = '',
  [string]$TrustedSigningDlib = '',
  [string]$PublisherName = '',
  [string]$TimestampServer = '',
  [string]$SignTool = '',
  [switch]$DevSign,
  [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'src'
$obj = Join-Path $root 'obj'
$stage = Join-Path $obj 'stage'
$release = -not ($DevSign -or $CompileOnly)
$out = if ($release) { Join-Path $root 'dist' } else { Join-Path $root 'dist-dev' }
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $obj, $stage, $out | Out-Null

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw ".NET Framework 4.8 C# compiler not found at $csc" }
$refs = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Security.dll', 'System.Web.Extensions.dll') |
  ForEach-Object { "/reference:" + (Join-Path $fw $_) }
function Invoke-Csc([string[]]$arguments) {
  & $csc /nologo /noconfig /optimize+ /warn:4 /platform:anycpu @arguments
  if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
}

# ---------------------------------------------------------------- signing identity
$signParams = @{}
$devCert = $null
if ($release) {
  $given = @($CertThumbprint, $PfxPath, $TrustedSigningMetadata) | Where-Object { $_ }
  if ($given.Count -ne 1) {
    throw @'
A RELEASE build needs exactly one trusted code-signing identity:
  -CertThumbprint <sha1>  |  -TrustedSigningMetadata <json> -TrustedSigningDlib <dll>  |  -PfxPath <pfx>
The certificate must be issued to BSC Textiles by a public CA (DigiCert, Sectigo, GlobalSign,
SSL.com, Certum...) or by Azure Trusted Signing. See docs/CODE_SIGNING.md.
For a local test build use -DevSign (output goes to dist-dev and is never served).
'@
  }
  if ($CertThumbprint) {
    $signParams.CertThumbprint = $CertThumbprint
    $c = Get-Item "Cert:\CurrentUser\My\$CertThumbprint" -ErrorAction SilentlyContinue
    if (-not $c) { $c = Get-Item "Cert:\LocalMachine\My\$CertThumbprint" -ErrorAction SilentlyContinue }
    if (-not $c) { throw "Certificate $CertThumbprint not found." }
    if ($c.Subject -eq $c.Issuer) { throw "Certificate $CertThumbprint is self-signed; it cannot produce a trusted release." }
    if (-not $PublisherName) { $PublisherName = $c.GetNameInfo('SimpleName', $false) }
  } elseif ($PfxPath) {
    $signParams.PfxPath = $PfxPath
    if (-not $PublisherName) {
      if (-not $env:BSC_SIGN_PFX_PASSWORD) { throw 'Set BSC_SIGN_PFX_PASSWORD.' }
      $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $env:BSC_SIGN_PFX_PASSWORD)
      if ($c.Subject -eq $c.Issuer) { throw 'The PFX certificate is self-signed; it cannot produce a trusted release.' }
      $PublisherName = $c.GetNameInfo('SimpleName', $false)
    }
  } else {
    if (-not $PublisherName) { throw 'Trusted Signing: pass -PublisherName with the exact CN of your certificate profile (your validated legal name).' }
    $signParams.TrustedSigningMetadata = $TrustedSigningMetadata
    $signParams.TrustedSigningDlib = $TrustedSigningDlib
  }
  if ($TimestampServer) { $signParams.TimestampServer = $TimestampServer }
  if ($SignTool) { $signParams.SignTool = $SignTool }
} elseif ($DevSign) {
  $devCert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -match 'BSC Textiles' -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
  if (-not $devCert) { $devCert = (& (Join-Path $root 'create-dev-cert.ps1')) | Select-Object -Last 1; $devCert = Get-Item "Cert:\CurrentUser\My\$($devCert.Thumbprint)" }
  $PublisherName = $devCert.GetNameInfo('SimpleName', $false)
  Write-Warning 'DEV build: signed with a self-signed test certificate. Smart App Control will block it. Output: dist-dev (never served).'
}
if (-not $PublisherName) { $PublisherName = 'BSC Textiles Pvt Ltd' }

function Sign-File([string]$path) {
  if ($release) { & (Join-Path $root 'sign.ps1') -FilePath $path @signParams }
  elseif ($DevSign) {
    $s = Set-AuthenticodeSignature -FilePath $path -Certificate $devCert -HashAlgorithm SHA256
    Write-Host "  dev-signed $(Split-Path $path -Leaf): $($s.Status)"
  }
}

# Expected signer CN is compiled in: the agent only accepts updates from this publisher.
$escaped = $PublisherName.Replace('\', '\\').Replace('"', '\"')
$buildInfo = Join-Path $obj 'BuildInfo.cs'
[IO.File]::WriteAllText($buildInfo, "namespace BscTracker { internal static class BuildInfo { public const string ExpectedSigner = `"$escaped`"; } }")
Write-Host "Publisher (certificate CN): $PublisherName" -ForegroundColor Cyan

# ---------------------------------------------------------------- compile + sign
Write-Host '[1/5] Compiling agent...' -ForegroundColor Cyan
$agentSources = @(Get-ChildItem (Join-Path $src 'Agent') -Filter *.cs | ForEach-Object FullName) + (Join-Path $src 'Shared\Common.cs') + $buildInfo
$agentExe = Join-Path $stage 'BSCActivityTracker.exe'
Invoke-Csc (@('/target:winexe', "/out:$agentExe", "/win32manifest:$(Join-Path $src 'Agent\agent.manifest')") + $refs + $agentSources)

Write-Host '[2/5] Signing agent (before embedding it in the installer)...' -ForegroundColor Cyan
Sign-File $agentExe

Write-Host '[3/5] Compiling installer with the signed agent embedded...' -ForegroundColor Cyan
$setupSources = @(Get-ChildItem (Join-Path $src 'Setup') -Filter *.cs | ForEach-Object FullName) + (Join-Path $src 'Shared\Common.cs') + (Join-Path $src 'Agent\Api.cs') + $buildInfo
$setupExe = Join-Path $stage 'BSC-Activity-Tracker-Setup.exe'
$defaultServerFile = Join-Path $obj 'default-server.txt'
[IO.File]::WriteAllText($defaultServerFile, $Server)
Invoke-Csc (@('/target:winexe', "/out:$setupExe", "/win32manifest:$(Join-Path $src 'Setup\setup.manifest')",
  "/resource:$agentExe,BscTracker.Payload.BSCActivityTracker.exe",
  "/resource:$defaultServerFile,BscTracker.Payload.default-server.txt") + $refs + $setupSources)

Write-Host '[4/5] Signing installer...' -ForegroundColor Cyan
Sign-File $setupExe

$sums = @(
  "$((Get-FileHash $setupExe -Algorithm SHA256).Hash)  BSC-Activity-Tracker-Setup.exe",
  "$((Get-FileHash $agentExe -Algorithm SHA256).Hash)  BSCActivityTracker.exe")
Set-Content -Path (Join-Path $stage 'SHA256SUMS.txt') -Value $sums -Encoding ascii

Write-Host '[5/5] Release gate...' -ForegroundColor Cyan
$verifyArgs = @{ Dir = $stage; PublisherName = $PublisherName }
if (-not $release) { $verifyArgs.AllowUntrusted = $true }
$result = & (Join-Path $root 'verify-build.ps1') @verifyArgs | Select-Object -Last 1
if ($release -and ($LASTEXITCODE -ne 0 -or -not $result.releaseGrade)) {
  throw 'Release gate FAILED - nothing was copied to dist. Fix the problems listed above.'
}

$version = (Get-Item $setupExe).VersionInfo.ProductVersion
$manifest = [ordered]@{
  product = 'BSC Activity Tracker'
  version = $version
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
  kind = $(if ($release) { 'release' } elseif ($DevSign) { 'dev-signed' } else { 'unsigned' })
  releaseGrade = [bool]$result.releaseGrade
  publisher = $PublisherName
  setup = $result.setup
  agent = $result.agent
  embeddedAgent = $result.embeddedAgent
  problems = $result.problems
  sha256 = @{ setup = (Get-FileHash $setupExe -Algorithm SHA256).Hash.ToLower(); agent = (Get-FileHash $agentExe -Algorithm SHA256).Hash.ToLower() }
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $stage 'release-manifest.json') -Encoding utf8
Copy-Item (Join-Path $stage '*') $out -Force
Write-Host "`nBuild complete ($($manifest.kind), release-grade: $($manifest.releaseGrade)) -> $out" -ForegroundColor $(if ($manifest.releaseGrade) { 'Green' } else { 'Yellow' })
