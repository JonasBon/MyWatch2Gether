@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Installiere die LTS-Version von https://nodejs.org und starte diese Datei dann nochmal.
  pause
  exit /b 1
)
where cloudflared >/dev/null 2>nul
if errorlevel 1 (
  echo cloudflared fehlt. Installiere es einmalig in einer Eingabeaufforderung mit:
  echo     winget install --id Cloudflare.cloudflared
  echo Danach dieses Fenster schliessen und teilen.bat nochmal starten.
  pause
  exit /b 1
)
start "Couchkino-Server" cmd /k node server.js
echo.
echo Gleich erscheint unten ein Link wie https://irgendwas.trycloudflare.com
echo Den oeffnest du selbst und schickst ihn deinem Kumpel.
echo Beide Fenster offen lassen, solange ihr schaut.
echo.
cloudflared tunnel --url http://localhost:3000
pause
