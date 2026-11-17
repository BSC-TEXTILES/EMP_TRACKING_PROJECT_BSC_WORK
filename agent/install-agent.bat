@echo off
setlocal
title BSC Textiles - Employee Activity Monitoring Agent Setup
echo ======================================================================
echo BSC TEXTILES - WORKFORCE MONITORING AGENT INSTALLER
echo Davanagere (DAV) ^| Shivamogga (SHI) ^| Belagavi (BEL) ^| Head Office (HQ)
echo ======================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Please install Node.js v18 or later from https://nodejs.org
  pause
  exit /b 1
)

cd /d "%~dp0"
echo [1/3] Installing agent dependencies...
call npm install --no-audit --no-fund

echo.
echo [2/3] Building agent...
if not exist "agent-data" mkdir "agent-data"

echo.
echo [3/3] Creating desktop launcher and registering automatic startup...
set "LAUNCH_BAT=%~dp0start-agent.bat"
call "%~dp0register-startup.bat"

echo ======================================================================
echo Installation completed successfully!
echo To run the agent, launch start-agent.bat or use:
echo   set WORKFORCE_URL=https://emptrack.bsctextiles.in
echo   set WORKFORCE_EMAIL=your.email@bsctextiles.in
echo   set WORKFORCE_PASSWORD=your_password
echo   npm start
echo ======================================================================
pause
