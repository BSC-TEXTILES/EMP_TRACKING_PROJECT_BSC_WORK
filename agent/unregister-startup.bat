@echo off
setlocal
title BSC Textiles - Unregister Desktop Agent Startup
echo ======================================================================
echo BSC TEXTILES - REMOVE AUTOMATIC DESKTOP AGENT STARTUP
echo ======================================================================
echo.

echo [1/2] Removing Task Scheduler task...
schtasks /delete /tn "BSCTextilesWorkforceAgent" /f >nul 2>&1
if %errorlevel% equ 0 (
  echo [OK] Task Scheduler task removed.
) else (
  echo [INFO] No Task Scheduler task was active.
)

echo [2/2] Removing user startup folder launcher...
set "STARTUP_FILE=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\BSCTextilesAgent.bat"
if exist "%STARTUP_FILE%" (
  del /f /q "%STARTUP_FILE%" >nul 2>&1
  echo [OK] Startup launcher removed.
)

echo.
echo ======================================================================
echo Automatic startup has been successfully removed.
echo ======================================================================
pause
