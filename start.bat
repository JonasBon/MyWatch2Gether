@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Installiere die LTS-Version von https://nodejs.org und starte diese Datei dann nochmal.
  pause
  exit /b 1
)
echo Couchkino startet ... Fenster offen lassen, solange ihr schaut.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
