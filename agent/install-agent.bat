@echo off
setlocal enabledelayedexpansion
title BSC Textiles - Employee Activity Monitoring Agent Setup
echo ======================================================================
echo BSC TEXTILES - WORKFORCE MONITORING AGENT INSTALLER
echo Davanagere (DAV) | Shivamogga (SHI) | Belagavi (BEL) | Head Office (HQ)
echo ======================================================================
echo.

cd /d "%~dp0"
if not exist "logs" mkdir "logs"
if not exist "agent-data" mkdir "agent-data"

echo [%date% %time%] Installer initiated >> "logs\install.log"

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [INFO] Node.js is not found. Attempting automatic installation via winget...
  echo [%date% %time%] Node.js missing, running winget >> "logs\install.log"
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements >nul 2>nul
  where node >nul 2>nul
  if !errorlevel! neq 0 (
    echo [ERROR] Node.js is required to run the tracking agent.
    echo Please install Node.js v18 or later from https://nodejs.org
    echo [%date% %time%] Installation failed: Node.js missing >> "logs\install.log"
    pause
    exit /b 1
  )
)

echo [1/3] Node.js runtime verified.
echo [%date% %time%] Node.js verified >> "logs\install.log"

:: Check or create config
if not exist "agent-data\config.json" (
  set "DEFAULT_URL=https://emptrack.bsctextiles.in"
  if defined WORKFORCE_URL set "DEFAULT_URL=%WORKFORCE_URL%"
  echo {"serverUrl":"!DEFAULT_URL!","deviceToken":""} > "agent-data\config.json"
)
echo [2/3] Agent configuration verified.

:: Register Startup Shortcut
echo [3/3] Registering auto-start on Windows boot...
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_SCRIPT=%~dp0run-agent-hidden.vbs"
set "LNK_TARGET=%STARTUP_DIR%\BSCTextilesAgent.lnk"

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%LNK_TARGET%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_SCRIPT%\"'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Save()" >> "logs\install.log" 2>&1

:: Launch background agent
start "" wscript.exe "%VBS_SCRIPT%"
echo [%date% %time%] Background agent launched via wscript >> "logs\install.log"

echo ======================================================================
echo [SUCCESS] BSC Workforce Activity Tracking Agent installed successfully!
echo Status: Running silently in the background
echo Startup: Configured for automatic start on Windows login
echo Log File: %~dp0logs\agent.log
echo ======================================================================
echo.
timeout /t 5
