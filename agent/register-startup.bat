@echo off
setlocal
title BSC Textiles - Register Desktop Agent at Windows Logon
echo ======================================================================
echo BSC TEXTILES - AUTOMATIC DESKTOP AGENT STARTUP REGISTRATION
echo Configures automatic monitoring startup on Windows logon
echo ======================================================================
echo.

cd /d "%~dp0"

echo [1/2] Creating Windows Task Scheduler task for Windows Logon...
schtasks /create /tn "BSCTextilesWorkforceAgent" /tr "\"%~dp0start-agent.bat\"" /sc onlogon /f >nul 2>&1
if %errorlevel% equ 0 (
  echo [OK] Task Scheduler task "BSCTextilesWorkforceAgent" registered successfully.
) else (
  echo [NOTE] Elevated task registration skipped. Proceeding with user startup shortcut.
)

echo [2/2] Registering user startup folder launcher...
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP_FOLDER%" (
  copy /y "%~dp0start-agent.bat" "%STARTUP_FOLDER%\BSCTextilesAgent.bat" >nul 2>&1
  echo [OK] Startup launcher copied to "%STARTUP_FOLDER%\BSCTextilesAgent.bat"
) else (
  echo [WARNING] Startup directory not found.
)

echo.
echo ======================================================================
echo Automatic startup setup complete!
echo The BSC Workforce Monitoring Agent will now automatically launch when
echo an authorized employee logs into this Windows computer.
echo ======================================================================
timeout /t 5 >nul
