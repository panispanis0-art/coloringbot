@echo off
setlocal
cd /d "%~dp0"
echo === PDF Job Filler: updating to the newest version ===
echo.
echo Stop the bot first: close its window if it is open.
pause
echo Downloading the newest version...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$zip = Join-Path $env:TEMP 'pdf-job-filler-update.zip';" ^
  "$tmp = Join-Path $env:TEMP 'pdf-job-filler-update';" ^
  "Invoke-WebRequest 'https://github.com/panispanis0-art/coloringbot/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing;" ^
  "if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force };" ^
  "Expand-Archive $zip $tmp -Force;" ^
  "$src = Join-Path $tmp 'coloringbot-main\pdf-job-filler';" ^
  "$dst = (Get-Location).Path;" ^
  "robocopy $src $dst /E /XD node_modules dist data /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null;" ^
  "if ($LASTEXITCODE -ge 8) { throw 'Copying the new files failed.' };" ^
  "Remove-Item $zip, $tmp -Recurse -Force;" ^
  "Write-Host 'New files copied. Your .env settings, templates and jobs were kept.'"
if errorlevel 1 (
  echo.
  echo The update failed. Check your internet connection and try again.
  pause
  exit /b 1
)
echo.
echo Installing what the new version needs...
call setup.bat
