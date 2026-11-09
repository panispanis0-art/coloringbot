@echo off
setlocal
cd /d "%~dp0"
echo === PDF Job Filler setup ===
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node %%v found.
echo Installing packages (takes a minute)...
call npm install
if errorlevel 1 goto :fail
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env - open it in Notepad and fill in BOT_TOKEN and ALLOWED_USER_ID.
)
echo Building the web app...
call npm run build
if errorlevel 1 goto :fail
echo.
echo Done. Start the web app with run-web.bat and the bot with run-bot.bat (or both: run-all.bat).
pause
exit /b 0
:fail
echo Something went wrong, see the messages above.
pause
exit /b 1
