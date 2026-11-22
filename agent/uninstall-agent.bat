@echo off
setlocal
title BSC Textiles - Uninstall Workforce Agent
cd /d "%~dp0"

echo ======================================================================
echo BSC TEXTILES - WORKFORCE MONITORING AGENT UNINSTALLER
echo ======================================================================
echo.

echo [1/3] Removing Windows Startup shortcut...
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP_DIR%\BSCTextilesAgent.lnk" (
  del /f /q "%STARTUP_DIR%\BSCTextilesAgent.lnk"
  echo Removed BSCTextilesAgent.lnk
)

echo [2/3] Terminating running agent process...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dist\agent.cjs*' -or $_.CommandLine -like '*dist/agent.cjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

echo [3/3] Agent uninstalled cleanly.
echo ======================================================================
echo Uninstallation completed.
echo ======================================================================
pause
