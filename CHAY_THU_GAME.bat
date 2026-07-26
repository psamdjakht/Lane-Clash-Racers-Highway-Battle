@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  start "" powershell -NoProfile -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:8080'"
  py -m http.server 8080
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" powershell -NoProfile -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:8080'"
  python -m http.server 8080
  goto :eof
)
echo Khong tim thay Python. Hay cai Python hoac dua game len GitHub Pages.
pause
