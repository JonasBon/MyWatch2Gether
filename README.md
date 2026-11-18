# Couchkino

Zusammen YouTube, SoundCloud, Vimeo und Twitch schauen und hören – im Browser, auf jedem Gerät.
Wer startet, pausiert oder spult, tut das für alle im Raum gleichzeitig.

## Was es kann

- **Räume per Link**: Raum erstellen, Link schicken, fertig. Kein Konto nötig.
- **Synchron abspielen**: Play, Pause, Spulen und Titelwechsel laufen bei allen gleich. Wer hinterherhängt, wird automatisch nachgezogen.
- **Suchen**: YouTube-Suche direkt im Raum. SoundCloud-Suche mit eigenem API-Zugang (siehe unten).
- **Link einfügen**: YouTube (auch Shorts, Startzeit `&t=`), YouTube-Playlists, SoundCloud (Titel und Playlists), Vimeo, Twitch (Kanäle live und Videos) sowie direkte Dateien (`.mp4`, `.webm`, `.mp3`, `.m4a`, `.ogg`, `.wav`, `.m3u8` …).
  Danach: **Abspielen**, **Als Nächstes** oder **Zur Playlist**.
- **Playlist**: gemeinsam bauen, per Ziehen (Maus oder Finger) oder mit den Pfeiltasten umsortieren, mischen, wiederholen (alle / einen Titel), leeren. Nach jedem Titel geht es automatisch weiter.
- **Chat** im Raum, Namen ändern, wer gerade da ist.
- **Läuft überall**: Handy hoch und quer, Tablet, Laptop, großer Bildschirm. Lautstärke ist pro Person.

Tastenkürzel (nicht beim Tippen): `Leertaste`/`K` Play/Pause · `←`/`→` 10 s zurück/vor · `M` Ton aus · `N` nächster Titel · `/` ins Suchfeld

---

## 1. Auf deinem PC ausprobieren

1. **Node.js** installieren (LTS-Version von <https://nodejs.org>), falls noch nicht vorhanden.
2. Im Ordner doppelt auf **`start.bat`** klicken. Der Browser öffnet sich mit `http://localhost:3000`.

Andere Leute in deinem WLAN erreichen dich unter `http://<IP-deines-PCs>:3000`. Für deinen Kumpel woanders brauchst du einen der beiden Wege unten.

## 2. Mit deinem Kumpel teilen

### Weg A – direkt von deinem PC (schnell, ohne Konto)

Ein Cloudflare-„Quick Tunnel“ macht deinen PC kurz über einen Link erreichbar.

1. Einmalig `cloudflared` installieren – in der Eingabeaufforderung:
   `winget install --id Cloudflare.cloudflared`
2. Doppelklick auf **`teilen.bat`**. Es öffnen sich zwei Fenster; im zweiten erscheint ein Link wie
   `https://irgendwas-zufaelliges.trycloudflare.com`.
3. Diesen Link öffnen, Raum erstellen und den Raum-Link (Knopf **Einladen**) an deinen Kumpel schicken.

Der Link gilt nur, solange die Fenster offen sind, und ändert sich bei jedem Start.

### Weg B – dauerhaft im Internet (Render, kostenlos)

1. Auf <https://github.com> ein Konto anlegen, ein neues Repository erstellen und alle Dateien aus diesem Ordner hochladen („Add file → Upload files“).
2. Auf <https://render.com> mit GitHub anmelden → **New → Blueprint** → dein Repository auswählen → **Apply**.
   Render liest die Datei `render.yaml` und richtet alles selbst ein.
3. Nach ein, zwei Minuten bekommst du eine Adresse wie `https://couchkino-xyz.onrender.com`. Die bleibt gleich.

Gut zu wissen beim kostenlosen Render-Tarif: Nach 15 Minuten ohne Besucher schläft der Dienst ein. Der erste Aufruf danach dauert etwas länger, bis er wieder wach ist. Solange jemand im Raum ist, bleibt er wach.

Andere Anbieter gehen auch – es ist eine normale Node.js-App (`node server.js`, Port über die Umgebungsvariable `PORT`). Ein `Dockerfile` liegt bei.

## 3. Optional: Suche verbessern

### YouTube-Suche mit offiziellem Schlüssel

Ohne Schlüssel nutzt die Suche die Web-Oberfläche von YouTube. Das klappt, kann aber ausfallen, wenn YouTube dort etwas umbaut. Zuverlässiger ist der offizielle Weg:

1. <https://console.cloud.google.com> → neues Projekt → **YouTube Data API v3** aktivieren.
2. **Anmeldedaten → API-Schlüssel erstellen**.
3. Den Schlüssel als Umgebungsvariable `YOUTUBE_API_KEY` eintragen
   (bei Render unter **Environment**; lokal in der Eingabeaufforderung `set YOUTUBE_API_KEY=…` und dann `node server.js`).

Das kostenlose Kontingent reicht für rund 100 Suchen am Tag. Ist es aufgebraucht, nimmt Couchkino automatisch wieder den Weg ohne Schlüssel.

### SoundCloud-Suche

SoundCloud-**Links** funktionieren immer. Für die **Suche** braucht es einen eigenen, offiziellen SoundCloud-API-Zugang (App auf <https://developers.soundcloud.com> registrieren). Trag dann ein:

- `SOUNDCLOUD_CLIENT_ID`
- `SOUNDCLOUD_CLIENT_SECRET`

Sobald beides gesetzt ist, erscheint im Raum der Umschalter **YouTube / SoundCloud**, und SoundCloud-Playlists lassen sich in einzelne Titel aufteilen.

---

## Gut zu wissen

- **Handys und Autoplay**: Manche Browser (vor allem iPhone/Safari) starten Videos erst nach einem Tipp. Dann erscheint der Hinweis „Mitschauen“ – antippen oder direkt aufs Video tippen.
- **App-Wechsel auf dem Handy**: Pausiert das Handy das Video beim Wegwechseln, stoppt das nicht die anderen. Beim Zurückkommen wird wieder angeglichen.
- **Manche YouTube-Videos** dürfen nicht auf anderen Seiten laufen (der Uploader hat das gesperrt). Couchkino zeigt das an und bietet „Überspringen“ an.
- **Twitch** braucht eine HTTPS-Adresse (klappt mit Render und dem Tunnel). Live-Streams lassen sich nicht spulen.
- **SoundCloud-Playlists als Ganzes** laufen im SoundCloud-Player; synchron sind dann nur Start und Pause. Mit API-Zugang lieber „Alle Titel einzeln“ nehmen.
- **Nicht möglich**: Netflix, Disney+, Spotify & Co. – deren Kopierschutz erlaubt kein Einbetten.
- **Server-Neustart**: Räume liegen im Arbeitsspeicher. Nach einem Neustart stellt der erste Browser, der wieder in den Raum kommt, Playlist und Stand aus seiner lokalen Kopie wieder her.

## Dateien

```
server.js              Webserver, Räume, Synchronisation (keine externen Pakete)
lib/ws.js              eigener WebSocket-Server
lib/sources.js         Suche und Titel-Infos (YouTube, SoundCloud, Vimeo)
public/index.html      Seite
public/style.css       Aussehen
public/app.js          Bedienung, Verbindung, Sync
public/players.js      Player für YouTube, SoundCloud, Vimeo, Twitch, Dateien
public/shared/media.js Link-Erkennung (Browser und Server)
start.bat              lokal starten (Windows)
teilen.bat             lokal starten + öffentlichen Link erzeugen (Windows)
render.yaml            Einrichtung für Render
Dockerfile             für Docker-Hosting
```

Umbenennen? Der Name „Couchkino“ steht in `public/index.html`, `public/manifest.webmanifest` und im Titel in `public/app.js`.
