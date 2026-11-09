@echo off
cd /d "%~dp0"
start "PDF Job Filler - web" cmd /k run-web.bat
start "PDF Job Filler - bot" cmd /k run-bot.bat
