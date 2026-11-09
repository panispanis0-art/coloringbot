@echo off
cd /d "%~dp0"
echo Development server with live reload: http://localhost:8080  (Ctrl+C to stop)
call npm run dev
pause
