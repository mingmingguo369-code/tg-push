@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm install
)
echo.
echo ====== Started! Open this in your browser: http://localhost:3000 ======
echo.
node server.js
pause
