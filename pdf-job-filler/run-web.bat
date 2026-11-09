@echo off
cd /d "%~dp0"
if not exist "web\dist\index.html" (
  echo Building the web app first...
  call npm run build || (pause & exit /b 1)
)
echo Web app: http://localhost:4173  (press Ctrl+C to stop)
echo In Chrome/Edge use the "Install" icon in the address bar to install it as an app.
start "" http://localhost:4173
call npm run preview
pause
