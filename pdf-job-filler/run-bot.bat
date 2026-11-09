@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo No .env file. Copy .env.example to .env and fill in BOT_TOKEN and ALLOWED_USER_ID.
  pause
  exit /b 1
)
echo Telegram bot starting (keep this window open, Ctrl+C to stop)...
call npm run bot
pause
