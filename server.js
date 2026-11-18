'use strict';
/*
 * Couchkino – zusammen Videos schauen und Musik hören.
 * Start: node server.js   (Port über PORT, Standard 3000)
 * Keine externen Pakete nötig (Node.js 18 oder neuer).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { handleUpgrade } = require('./lib/ws');
const sources = require('./lib/sources');
const Media = require('./public/shared/media.js');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');

const MAX_PLAYLIST = 500;
const MAX_CHAT = 120;
const ROOM_TTL_MS = 24 * 3600 * 1000; // leere Räume nach 24 h löschen

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);

// ======================================================================
// HTTP: statische Dateien + API
// ======================================================================

const fileCache = new Map(); // Pfad → { mtime, size, etag, gz }

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveFile(req, res, fp) {
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Nicht gefunden');
    const ext = path.extname(fp).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = '"' + st.size.toString(36) + '-' + st.mtimeMs.toString(36) + '"';
    const headers = {
      'content-type': type,
      'cache-control': 'no-cache',
      etag,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin'
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const gzipOk = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gzipOk) {
      let entry = fileCache.get(fp);
      if (!entry || entry.etag !== etag) {
        entry = { etag, gz: zlib.gzipSync(fs.readFileSync(fp)) };
        fileCache.set(fp, entry);
      }
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = entry.gz.length;
      headers.vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : entry.gz);
    }
    // Range-Anfragen (wichtig für Video-/Audiodateien)
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { 'content-range': 'bytes */' + st.size });
        return res.end();
      }
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      headers['accept-ranges'] = 'bytes';
      headers['content-length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(fp, { start, end }).pipe(res);
    }
    headers['content-length'] = st.size;
    headers['accept-ranges'] = 'bytes';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fp).pipe(res);
  });
}

// einfache Begrenzung gegen Missbrauch der Such-API
const apiHits = new Map();
function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const e = apiHits.get(ip) || { n: 0, reset: now + 60e3 };
  if (now > e.reset) { e.n = 0; e.reset = now + 60e3; }
  e.n++;
  apiHits.set(ip, e);
  return e.n > 90;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of apiHits) if (now > e.reset) apiHits.delete(ip);
}, 120e3).unref();

async function handleApi(req, res, url) {
  if (rateLimited(req)) return sendJSON(res, 429, { error: 'Zu viele Anfragen – warte kurz.' });
  try {
    const p = url.pathname;
    if (p === '/api/search') {
      const src = url.searchParams.get('src') === 'soundcloud' ? 'soundcloud' : 'youtube';
      const results = await sources.search(src, url.searchParams.get('q'));
      return sendJSON(res, 200, { results });
    }
    if (p === '/api/config') {
      return sendJSON(res, 200, { soundcloudSearch: sources.scAvailable() });
    }
    if (p === '/api/resolve') {
      return sendJSON(res, 200, await sources.resolve(url.searchParams.get('url')));
    }
    if (p === '/api/expand') {
      return sendJSON(res, 200, await sources.expand(url.searchParams.get('url')));
    }
    return sendJSON(res, 404, { error: 'Unbekannte Adresse' });
  } catch (e) {
    if (e.userFacing) return sendJSON(res, e.status || 400, { error: e.message });
    console.warn('[api]', url.pathname, e.message);
    const which = url.searchParams.get('src') === 'soundcloud' ? 'SoundCloud' : 'Der Dienst';
    return sendJSON(res, 502, { error: which + ' antwortet gerade nicht. Ein direkter Link funktioniert trotzdem.' });
  }
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return sendText(res, 400, 'Ungültige Adresse');
  }
  const p = url.pathname;
  if (p.startsWith('/api/')) return handleApi(req, res, url);
  if (p === '/healthz') return sendText(res, 200, 'ok');
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Nicht erlaubt');
  if (p === '/' || /^\/r\/[^/]+\/?$/.test(p)) return serveFile(req, res, path.join(PUBLIC, 'index.html'));
  let rel;
  try {
    rel = decodeURIComponent(p);
  } catch (e) {
    return sendText(res, 400, 'Ungültige Adresse');
  }
  const fp = path.normalize(path.join(PUBLIC, rel));
  if (!fp.startsWith(PUBLIC + path.sep)) return sendText(res, 403, 'Verboten');
  serveFile(req, res, fp);
});

// ======================================================================
// Räume
// ======================================================================

const rooms = new Map();
const COLORS = ['#FFB547', '#7FD1B9', '#FF8FA3', '#9DB8FF', '#D2A8FF', '#F3E37C', '#6FD6F2', '#FFA374'];

function rid(n = 10) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function num(v, max = 7 * 86400) {
  const n = Number(v);
  return isFinite(n) && n > 0 && n < max ? n : 0;
}

function cleanName(v) {
  return str(v, 24) || 'Gast';
}

function safeImg(v) {
  const s = str(v, 600);
  return /^https:\/\//i.test(s) ? s : '';
}

function createRoom(id) {
  return {
    id,
    clients: new Map(),
    colors: new Map(),
    playlist: [],
    current: null,
    resumeIdx: 0,
    loop: 'off',
    pb: { lid: 0, item: null, playing: false, pos: 0, at: Date.now(), by: null, action: 'init', seq: 0 },
    chat: [],
    seq: 0,
    lidc: 0,
    emptySince: null,
    endTimer: null,
    leaveTimers: new Map()
  };
}

function makeItem(url, meta, byName, keepUid) {
  const p = Media.parse(url);
  if (!p || p.kind === 'ytlist') return null;
  meta = meta && typeof meta === 'object' ? meta : {};
  return {
    uid: typeof keepUid === 'string' && /^[\w-]{4,20}$/.test(keepUid) ? keepUid : rid(8),
    provider: p.provider,
    kind: p.kind,
    id: p.id,
    hash: p.hash || undefined,
    hls: p.hls || undefined,
    url: p.url,
    live: !!p.live,
    short: p.short || undefined,
    title: str(meta.title, 200) || p.title || 'Unbenannt',
    author: str(meta.author, 120) || p.author || '',
    thumb: safeImg(meta.thumb) || p.thumb || '',
    duration: num(meta.duration),
    start: num(meta.start) || p.start || 0,
    preview: !!meta.preview || undefined,
    by: str(byName, 24) || null,
    hasMeta: !!str(meta.title, 200)
  };
}

function posAt(pb, now = Date.now()) {
  if (!pb.item) return 0;
  let p = pb.playing ? pb.pos + (now - pb.at) / 1000 : pb.pos;
  if (pb.item.duration && p > pb.item.duration) p = pb.item.duration;
  return Math.max(0, p);
}

function send(client, msg) {
  client.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const c of room.clients.values()) c.ws.send(s);
}

function usersOf(room) {
  const seen = new Map();
  for (const c of room.clients.values()) seen.set(c.cid, { cid: c.cid, name: c.name, color: c.color });
  return [...seen.values()];
}

function plMsg(room) {
  return { t: 'pl', playlist: room.playlist, current: room.current, loop: room.loop };
}

function pushChat(room, msg) {
  msg.id = ++room.seq;
  msg.ts = Date.now();
  room.chat.push(msg);
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  broadcast(room, { t: 'chat', msg });
}

function sys(room, text) {
  pushChat(room, { sys: true, text });
}

function quote(item) {
  const t = item.title || 'Unbenannt';
  return '„' + (t.length > 60 ? t.slice(0, 58) + '…' : t) + '“';
}

function scheduleEnd(room) {
  clearTimeout(room.endTimer);
  room.endTimer = null;
  const pb = room.pb;
  if (!pb.playing || !pb.item || pb.item.live || !pb.item.duration) return;
  const remaining = pb.item.duration - posAt(pb);
  const lid = pb.lid;
  // Sicherheitsnetz: falls kein Browser „Ende“ meldet, geht es trotzdem weiter
  room.endTimer = setTimeout(() => {
    if (room.pb.lid === lid && room.pb.playing) onEnded(room, lid, true);
  }, Math.max(0, remaining) * 1000 + 6000);
}

function setPb(room, patch, client, action) {
  const now = Date.now();
  const pos = 'pos' in patch ? patch.pos : posAt(room.pb, now);
  room.pb = { ...room.pb, ...patch, pos, at: now, by: client ? client.name : null, action, seq: ++room.seq };
  scheduleEnd(room);
  broadcast(room, { t: 'pb', pb: room.pb });
}

function loadItem(room, item, client, playing = true) {
  room.current = item ? item.uid : null;
  room.pb = {
    lid: ++room.lidc,
    item: item ? { ...item } : null,
    playing: !!item && playing,
    pos: item ? item.start || 0 : 0,
    at: Date.now(),
    by: client ? client.name : null,
    action: 'load',
    seq: ++room.seq
  };
  scheduleEnd(room);
  broadcast(room, { t: 'pb', pb: room.pb });
  broadcast(room, plMsg(room));
}

function currentIndex(room) {
  return room.playlist.findIndex((i) => i.uid === room.current);
}

function advance(room, dir, auto, client) {
  const pl = room.playlist;
  if (auto && room.loop === 'one' && room.pb.item) return loadItem(room, room.pb.item, null);
  if (dir < 0 && room.pb.item && posAt(room.pb) > 5) return setPb(room, { pos: 0 }, client, 'seek');
  const idx = currentIndex(room);
  const base = idx >= 0 ? idx : room.resumeIdx - (dir > 0 ? 1 : 0);
  let n = base + dir;
  if (n >= pl.length) {
    if (room.loop === 'all' && pl.length) n = 0;
    else {
      if (auto && room.pb.item) setPb(room, { playing: false, pos: room.pb.item.duration || posAt(room.pb) }, null, 'pause');
      return;
    }
  }
  if (n < 0) {
    if (room.loop === 'all' && pl.length) n = pl.length - 1;
    else {
      if (room.pb.item) setPb(room, { pos: 0 }, client, 'seek');
      return;
    }
  }
  loadItem(room, pl[n], client);
}

function onEnded(room, lid, fromTimer) {
  const pb = room.pb;
  if (lid !== pb.lid || !pb.item) return;
  if (!fromTimer && pb.item.duration && posAt(pb) < pb.item.duration - 15) return; // zu früh gemeldet
  if (!pb.playing && !fromTimer) return;
  advance(room, 1, true, null);
}

async function fillMeta(room, items) {
  for (const it of items) {
    if (it.hasMeta && !it.short) continue;
    try {
      let meta;
      if (it.short) {
        const real = await sources.expandShort(it);
        it.url = real.url;
        it.id = real.id;
        it.kind = real.kind;
        delete it.short;
        meta = await sources.fetchMeta(real);
      } else {
        meta = await sources.fetchMeta(it);
      }
      if (meta.title) it.title = str(meta.title, 200);
      if (meta.author) it.author = str(meta.author, 120);
      if (meta.thumb && !it.thumb) it.thumb = safeImg(meta.thumb);
      if (meta.duration && !it.duration) it.duration = num(meta.duration);
      it.hasMeta = true;
    } catch (e) {
      it.hasMeta = true;
    }
    if (room.pb.item && room.pb.item.uid === it.uid) {
      room.pb.item = { ...room.pb.item, ...it };
      broadcast(room, { t: 'pb', pb: room.pb });
    }
  }
  broadcast(room, plMsg(room));
}

function restore(room, cache) {
  if (!cache || typeof cache !== 'object' || !Array.isArray(cache.playlist)) return;
  for (const raw of cache.playlist.slice(0, MAX_PLAYLIST)) {
    if (!raw || typeof raw.url !== 'string') continue;
    const it = makeItem(raw.url, raw, raw.by, raw.uid);
    if (it) {
      it.hasMeta = true;
      room.playlist.push(it);
    }
  }
  if (['off', 'all', 'one'].includes(cache.loop)) room.loop = cache.loop;
  if (typeof cache.current === 'string' && room.playlist.some((i) => i.uid === cache.current)) room.current = cache.current;
  const ci = cache.item;
  if (ci && typeof ci.url === 'string') {
    const it = makeItem(ci.url, ci, ci.by, ci.uid);
    if (it) {
      it.hasMeta = true;
      room.pb = { lid: ++room.lidc, item: it, playing: false, pos: num(cache.pos), at: Date.now(), by: null, action: 'load', seq: ++room.seq };
    }
  }
}

function insertIndex(room, mode) {
  if (mode === 'end') return room.playlist.length;
  const idx = currentIndex(room);
  if (idx >= 0) return idx + 1;
  if (room.current === null && room.pb.item) return Math.min(room.resumeIdx, room.playlist.length);
  return room.playlist.length;
}

// ---------- Nachrichten vom Browser ----------

const handlers = {
  play(room, c, m) {
    if (m.lid !== room.pb.lid || !room.pb.item) return;
    setPb(room, { playing: true, pos: clampPos(room, m.pos) }, c, 'play');
  },
  pause(room, c, m) {
    if (m.lid !== room.pb.lid || !room.pb.item) return;
    setPb(room, { playing: false, pos: clampPos(room, m.pos) }, c, 'pause');
  },
  seek(room, c, m) {
    if (m.lid !== room.pb.lid || !room.pb.item || room.pb.item.live) return;
    setPb(room, { pos: clampPos(room, m.pos) }, c, 'seek');
  },
  ended(room, c, m) {
    onEnded(room, m.lid, false);
  },
  next(room, c) { advance(room, 1, false, c); },
  prev(room, c) { advance(room, -1, false, c); },
  async add(room, c, m) {
    const list = Array.isArray(m.items) ? m.items.slice(0, MAX_PLAYLIST) : [];
    const mode = ['end', 'next', 'now'].includes(m.mode) ? m.mode : 'end';
    const items = [];
    for (const raw of list) {
      if (!raw || typeof raw.url !== 'string') continue;
      const it = makeItem(raw.url, raw.meta, c.name);
      if (it) items.push(it);
    }
    if (!items.length) return send(c, { t: 'error', text: 'Dieser Link wird nicht unterstützt.' });
    const room_left = MAX_PLAYLIST - room.playlist.length;
    if (room_left <= 0) return send(c, { t: 'error', text: 'Die Playlist ist voll (' + MAX_PLAYLIST + ' Einträge).' });
    items.splice(room_left);
    const at = insertIndex(room, mode);
    room.playlist.splice(at, 0, ...items);
    const label = items.length === 1 ? quote(items[0]) : items.length + ' Titel';
    if (mode === 'now' || !room.pb.item) {
      loadItem(room, items[0], c);
      sys(room, c.name + ' spielt ' + quote(items[0]) + (items.length > 1 ? ' (+' + (items.length - 1) + ')' : ''));
    } else {
      broadcast(room, plMsg(room));
      sys(room, c.name + ' hat ' + label + (mode === 'next' ? ' als Nächstes eingereiht' : ' hinzugefügt'));
    }
    fillMeta(room, items);
  },
  remove(room, c, m) {
    const idx = room.playlist.findIndex((i) => i.uid === m.uid);
    if (idx < 0) return;
    room.playlist.splice(idx, 1);
    if (room.current === m.uid) {
      room.current = null;
      room.resumeIdx = idx;
    } else if (room.current === null && idx < room.resumeIdx) {
      room.resumeIdx--;
    }
    broadcast(room, plMsg(room));
  },
  move(room, c, m) {
    const from = room.playlist.findIndex((i) => i.uid === m.uid);
    if (from < 0) return;
    const to = Math.max(0, Math.min(room.playlist.length - 1, parseInt(m.to, 10) || 0));
    const [it] = room.playlist.splice(from, 1);
    room.playlist.splice(to, 0, it);
    broadcast(room, plMsg(room));
  },
  clear(room, c) {
    if (!room.playlist.length) return;
    room.playlist = [];
    room.current = null;
    room.resumeIdx = 0;
    broadcast(room, plMsg(room));
    sys(room, c.name + ' hat die Playlist geleert');
  },
  shuffle(room, c) {
    const pl = room.playlist;
    if (pl.length < 2) return;
    let head = [];
    const idx = currentIndex(room);
    if (idx >= 0) head = pl.splice(idx, 1);
    for (let i = pl.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [pl[i], pl[j]] = [pl[j], pl[i]];
    }
    room.playlist = head.concat(pl);
    if (idx < 0) room.resumeIdx = 0;
    broadcast(room, plMsg(room));
    sys(room, c.name + ' hat die Playlist gemischt');
  },
  playItem(room, c, m) {
    const it = room.playlist.find((i) => i.uid === m.uid);
    if (!it) return;
    loadItem(room, it, c);
    sys(room, c.name + ' spielt ' + quote(it));
  },
  loop(room, c, m) {
    if (!['off', 'all', 'one'].includes(m.mode)) return;
    room.loop = m.mode;
    broadcast(room, plMsg(room));
  },
  stop(room, c) {
    if (!room.pb.item) return;
    room.resumeIdx = Math.max(0, currentIndex(room) + 1);
    loadItem(room, null, c, false);
  },
  meta(room, c, m) {
    const fix = (it) => {
      if (!it || it.uid !== m.uid) return false;
      let changed = false;
      const d = num(m.duration);
      if (d && !it.live && (!it.duration || Math.abs(it.duration - d) > 2)) { it.duration = Math.round(d * 10) / 10; changed = true; }
      if (!it.hasMeta || /^(YouTube|SoundCloud|Vimeo)-/.test(it.title)) {
        const t = str(m.title, 200);
        if (t) { it.title = t; changed = true; }
        const a = str(m.author, 120);
        if (a && !it.author) { it.author = a; changed = true; }
        const th = safeImg(m.thumb);
        if (th && !it.thumb) { it.thumb = th; changed = true; }
      }
      return changed;
    };
    const inList = fix(room.playlist.find((i) => i.uid === m.uid));
    let inPb = false;
    if (room.pb.item && room.pb.item.uid === m.uid) {
      inPb = fix(room.pb.item);
      if (inPb) scheduleEnd(room);
    }
    if (inList) broadcast(room, plMsg(room));
    if (inPb) broadcast(room, { t: 'pbmeta', item: room.pb.item, lid: room.pb.lid });
  },
  chat(room, c, m) {
    const text = str(m.text, 500);
    if (!text) return;
    const now = Date.now();
    c.chatTimes = (c.chatTimes || []).filter((t) => now - t < 5000);
    if (c.chatTimes.length >= 6) return send(c, { t: 'error', text: 'Nicht so schnell.' });
    c.chatTimes.push(now);
    pushChat(room, { cid: c.cid, name: c.name, color: c.color, text });
  },
  name(room, c, m) {
    const name = cleanName(m.name);
    if (name === c.name) return;
    const old = c.name;
    for (const other of room.clients.values()) if (other.cid === c.cid) other.name = name;
    broadcast(room, { t: 'users', users: usersOf(room) });
    sys(room, old + ' heißt jetzt ' + name);
  }
};

function clampPos(room, v) {
  let p = Number(v);
  if (!isFinite(p) || p < 0) p = 0;
  const d = room.pb.item && room.pb.item.duration;
  if (d && p > d) p = d;
  return p;
}

function pickColor(room, cid) {
  if (room.colors.has(cid)) return room.colors.get(cid);
  const used = new Set(room.colors.values());
  const color = COLORS.find((c) => !used.has(c)) || COLORS[room.colors.size % COLORS.length];
  room.colors.set(cid, color);
  return color;
}

function onConnection(ws) {
  let room = null;
  let client = null;
  let budget = 40;
  let budgetAt = Date.now();

  ws.on('message', (raw) => {
    // Grenze: ca. 20 Nachrichten pro Sekunde
    const now = Date.now();
    budget = Math.min(40, budget + ((now - budgetAt) / 1000) * 20);
    budgetAt = now;
    if (budget < 1) return;
    budget--;

    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() }));
      return;
    }

    if (m.t === 'join') {
      if (room) return;
      const id = String(m.room || '').toLowerCase();
      if (!/^[a-z0-9-]{3,32}$/.test(id)) {
        ws.send(JSON.stringify({ t: 'error', text: 'Ungültiger Raum-Code.' }));
        return;
      }
      room = rooms.get(id);
      let fresh = false;
      if (!room) {
        room = createRoom(id);
        rooms.set(id, room);
        fresh = true;
      }
      if (fresh) restore(room, m.cache);
      const cid = typeof m.cid === 'string' && /^[\w-]{6,40}$/.test(m.cid) ? m.cid : rid(12);
      client = { ws, conn: rid(10), cid, name: cleanName(m.name), color: pickColor(room, cid) };
      const wasHere = [...room.clients.values()].some((x) => x.cid === cid);
      room.clients.set(client.conn, client);
      room.emptySince = null;
      send(client, {
        t: 'welcome',
        s: Date.now(),
        me: { cid, name: client.name, color: client.color },
        room: {
          id: room.id, playlist: room.playlist, current: room.current, loop: room.loop,
          pb: room.pb, users: usersOf(room), chat: room.chat.slice(-60)
        }
      });
      broadcast(room, { t: 'users', users: usersOf(room) });
      const pendingLeave = room.leaveTimers.get(cid);
      if (pendingLeave) {
        clearTimeout(pendingLeave);
        room.leaveTimers.delete(cid);
      } else if (!wasHere) {
        sys(room, client.name + ' ist da');
      }
      return;
    }

    if (!room || !client) return;
    const fn = handlers[m.t];
    if (!fn) return;
    try {
      const r = fn(room, client, m);
      if (r && r.catch) r.catch((e) => console.warn('[raum]', m.t, e.message));
    } catch (e) {
      console.warn('[raum]', m.t, e.message);
    }
  });

  ws.on('close', () => {
    if (!room || !client) return;
    room.clients.delete(client.conn);
    const r = room;
    const c = client;
    broadcast(r, { t: 'users', users: usersOf(r) });
    const stillHere = [...r.clients.values()].some((x) => x.cid === c.cid);
    if (!stillHere && !r.leaveTimers.has(c.cid)) {
      // erst nach kurzer Zeit melden – Neuladen der Seite soll keinen Lärm machen
      r.leaveTimers.set(c.cid, setTimeout(() => {
        r.leaveTimers.delete(c.cid);
        if (![...r.clients.values()].some((x) => x.cid === c.cid)) sys(r, c.name + ' ist gegangen');
      }, 15000));
    }
    if (!r.clients.size) {
      r.emptySince = Date.now();
      // niemand mehr da: an aktueller Stelle pausieren
      if (r.pb.playing) {
        r.pb = { ...r.pb, pos: posAt(r.pb), at: Date.now(), playing: false, action: 'pause', seq: ++r.seq };
        scheduleEnd(r);
      }
    }
  });
}

server.on('upgrade', (req, socket, head) => {
  let p = '';
  try { p = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* egal */ }
  if (p !== '/ws') {
    socket.destroy();
    return;
  }
  handleUpgrade(req, socket, head, onConnection);
});

// Verbindungen am Leben halten (Proxys schließen sonst stille Verbindungen)
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients.values()) {
      if (!c.ws.alive) { c.ws.close(1001); continue; }
      c.ws.alive = false;
      c.ws.ping();
    }
  }
}, 25000).unref();

// alte, leere Räume aufräumen
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (!room.clients.size && room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
      clearTimeout(room.endTimer);
      rooms.delete(id);
    }
  }
}, 10 * 60e3).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('Couchkino läuft auf http://localhost:' + PORT);
  });
}

module.exports = { server, rooms };
