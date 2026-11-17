$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-agent.bat'
if (-not (Test-Path -LiteralPath $launcher)) { throw 'Agent launcher missing' }
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $startup 'BSCTextilesAgent.lnk'))
$link.TargetPath = $launcher
$link.WorkingDirectory = $PSScriptRoot
$link.WindowStyle = 1
$link.Description = 'Visible BSC employee monitoring agent'
$link.Save()
Write-Output 'Registered visible agent startup for the current Windows user.'
