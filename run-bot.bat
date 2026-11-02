@echo off
cd /d "%~dp0"
:loop
.venv\Scripts\python -m colorbook bot
echo Bot stopped, restarting in 10 seconds...
timeout /t 10 >nul
goto loop
