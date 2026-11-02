@echo off
REM One-time setup on Windows. Install Python 3.10+ from python.org first (tick "Add to PATH").
cd /d "%~dp0"
python -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip -q
.venv\Scripts\pip install -r requirements.txt -q
if not exist .env copy .env.example .env
echo.
echo Installed. Edit .env in Notepad (bot token, chat id, Cloudflare id + token), then run:
echo   .venv\Scripts\python -m colorbook check
echo   .venv\Scripts\python -m colorbook make --send
echo   .venv\Scripts\python -m colorbook bot
pause
