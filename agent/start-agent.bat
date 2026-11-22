@echo off
setlocal
title BSC Textiles - Workforce Monitoring Agent
cd /d "%~dp0"

echo ======================================================================
echo BSC TEXTILES - WORKFORCE MONITORING AGENT
echo Davanagere (DAV) | Shivamogga (SHI) | Belagavi (BEL) | Head Office (HQ)
echo ======================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not found in PATH.
  echo Please install Node.js v18 or later.
  pause
  exit /b 1
)

if not exist "logs" mkdir "logs"
if not exist "agent-data" mkdir "agent-data"

echo Starting tracking agent...
node dist\agent.cjs
if %errorlevel% neq 0 (
  echo [ERROR] Agent exited with code %errorlevel%.
  pause
)
