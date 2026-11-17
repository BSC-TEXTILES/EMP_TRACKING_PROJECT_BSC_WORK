@echo off
setlocal
title BSC Textiles Workforce Monitoring Agent
cd /d "%~dp0"

if not defined WORKFORCE_URL (
  set "WORKFORCE_URL=https://emptrack.bsctextiles.in"
)

echo ======================================================================
echo BSC TEXTILES - WORKFORCE MONITORING AGENT
echo Server: %WORKFORCE_URL%
echo ======================================================================
echo.

if not defined WORKFORCE_DEVICE_TOKEN (
  if not defined WORKFORCE_EMAIL (
    set /p WORKFORCE_EMAIL="Enter BSC Employee Email / Code: "
  )
  if not defined WORKFORCE_PASSWORD (
    set /p WORKFORCE_PASSWORD="Enter Password: "
  )
)

echo Starting agent monitoring in background...
call npx tsx src/index.ts
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Agent stopped with error code %errorlevel%.
  pause
)
