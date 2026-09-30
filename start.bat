@echo off
title EXFIL ZONE - Server Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 or newer.
  echo         Download: https://nodejs.org/
  pause
  exit /b 1
)

echo ============================================
echo   EXFIL ZONE  -  Local Server
echo ============================================
echo   Local :  http://localhost:9090
echo   LAN   :  http://YOUR-PC-IP:9090
echo ============================================
echo.

start "EXFIL-ZONE-SERVER" cmd /k "node server/server.js"
ping -n 3 127.0.0.1 >nul
start http://localhost:9090
echo [OK] Server window opened. Browser should open automatically.
echo      Press any key to close this window.
pause
