@echo off
setlocal enabledelayedexpansion
title HDR Web Paint Server

echo ============================================================
echo               Starting HDR Web Paint Server...
echo ============================================================
echo.

:: Get local IP address for phone testing
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^169\.' } | Select-Object -ExpandProperty IPAddress -First 1)"`) do (
    set LOCAL_IP=%%i
)

set PORT=8080

echo Server is launching on port %PORT%:
echo.
echo   [PC / Desktop]   http://localhost:%PORT%
if defined LOCAL_IP (
    echo   [Phone on Wi-Fi] http://!LOCAL_IP!:%PORT%
)
echo.
echo Opening browser...
start http://localhost:%PORT%
echo.
echo Press Ctrl+C in this window anytime to stop the server.
echo ============================================================
echo.

:: Check for Python first, then Node, otherwise fallback
where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
    python -m http.server %PORT%
    goto end
)

where npx >nul 2>&1
if %ERRORLEVEL% equ 0 (
    npx --yes serve -l %PORT%
    goto end
)

echo Neither Python nor Node.js was found in PATH.
echo Please install Python (python.org) or Node.js (nodejs.org) to run a local server.
pause

:end
