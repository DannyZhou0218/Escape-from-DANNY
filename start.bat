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

rem ---- Dependency check ----
rem A fresh git clone never contains node_modules; it is gitignored.
rem Without it the server crashes with: Cannot find module ws
rem So install dependencies once, automatically.
if not exist "node_modules\ws" (
  echo [INFO] First run: installing dependencies ws + three ...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] npm not found. Install Node.js which includes npm, then run:  npm install
    pause
    exit /b 1
  )
  call npm install
  if not exist "node_modules\ws" (
    echo [ERROR] Dependency install failed. Please run manually:  npm install
    pause
    exit /b 1
  )
  echo [INFO] Dependencies ready.
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
