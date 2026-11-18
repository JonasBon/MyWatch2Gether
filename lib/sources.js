'use strict';
/*
 * Suche und Metadaten für YouTube, SoundCloud und Vimeo.
 * Läuft auf dem Server, damit der Browser keine CORS-Probleme bekommt.
 *
 * YouTube-Suche:   1. offizielle API, falls YOUTUBE_API_KEY gesetzt ist
 *                  2. sonst die interne Web-API von youtube.com (ohne Schlüssel)
 *                  3. notfalls die HTML-Ergebnisseite
 * SoundCloud-Suche: nur mit eigenem, offiziellem API-Zugang
 *                  (SOUNDCLOUD_CLIENT_ID + SOUNDCLOUD_CLIENT_SECRET).
 *                  SoundCloud-Links funktionieren immer (offizieller Player + oEmbed).
 */
const Media = require('../public/shared/media.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const YT_CLIENT = { clientName: 'WEB', clientVersion: '2.20251110.01.00', hl: 'de', gl: 'DE' };
const YT_COOKIE = 'SOCS=CAI; CONSENT=YES+1';

class UserError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
    this.userFacing = true;
  }
}

// ---------- kleine Helfer ----------

async function get(url, opts = {}) {
  const headers = {
    'user-agent': UA,
    'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
    ...(opts.headers || {})
  };
  return fetch(url, {
    method: opts.method || 'GET',
    body: opts.body,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 9000)
  });
}

async function getJSON(url, opts) {
  const r = await get(url, opts);
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status + ' von ' + new URL(url).hostname);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.p;
  const p = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { exp: Date.now() + ttlMs, p });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return p;
}

// Sucht rekursiv alle Objekte unter einem bestimmten Schlüssel
function collect(obj, key, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 60) return out;
  if (Array.isArray(obj)) {
    for (const v of obj) collect(v, key, out, depth + 1);
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k]);
    else collect(obj[k], key, out, depth + 1);
  }
  return out;
}

function findString(obj, test, depth = 0) {
  if (obj == null || depth > 30) return null;
  if (typeof obj === 'string') return test(obj) ? obj : null;
  if (typeof obj !== 'object') return null;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const r = findString(v, test, depth + 1);
    if (r) return r;
  }
  return null;
}

function txt(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join('');
  if (t.content) return t.content;
  return '';
}

function hms(s) {
  if (!s) return 0;
  const p = String(s).trim().split(':').map((x) => parseInt(x, 10));
  if (p.some((x) => isNaN(x))) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
}

function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function extractJsonAfter(html, marker) {
  let i = html.indexOf(marker);
  if (i < 0) return null;
  i = html.indexOf('{', i);
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(i, j + 1));
  }
  return null;
}

// ---------- YouTube ----------

async function innertube(endpoint, body) {
  const r = await get('https://www.youtube.com/youtubei/v1/' + endpoint + '?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.youtube.com',
      referer: 'https://www.youtube.com/',
      'x-youtube-client-name': '1',
      'x-youtube-client-version': YT_CLIENT.clientVersion,
      cookie: YT_COOKIE
    },
    body: JSON.stringify({ context: { client: YT_CLIENT }, ...body })
  });
  if (!r.ok) throw new Error('YouTube antwortet mit ' + r.status);
  return r.json();
}

function ytItem(id, title, author, duration, live) {
  return {
    provider: 'youtube', kind: 'video', id,
    url: 'https://www.youtube.com/watch?v=' + id,
    title: title || 'YouTube-Video', author: author || '',
    thumb: Media.ytThumb(id), duration: duration || 0, live: !!live
  };
}

function parseYtVideos(data) {
  const out = [];
  const seen = new Set();
  for (const v of collect(data, 'videoRenderer')) {
    const id = v && v.videoId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const len = txt(v.lengthText);
    const live = !len && JSON.stringify(v.badges || v.thumbnailOverlays || '').includes('LIVE');
    out.push(ytItem(id, txt(v.title), txt(v.ownerText || v.longBylineText || v.shortBylineText), hms(len), live));
  }
  // Neueres Layout ("lockupViewModel")
  for (const l of collect(data, 'lockupViewModel')) {
    if (!l || l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue;
    const id = l.contentId;
    if (!id || seen.has(id) || !/^[\w-]{11}$/.test(id)) continue;
    seen.add(id);
    const md = l.metadata && l.metadata.lockupMetadataViewModel;
    const title = md && md.title ? txt(md.title) : '';
    const rows = (md && md.metadata && md.metadata.contentMetadataViewModel &&
      md.metadata.contentMetadataViewModel.metadataRows) || [];
    const author = rows[0] && rows[0].metadataParts && rows[0].metadataParts[0]
      ? txt(rows[0].metadataParts[0].text) : '';
    const dur = findString(l.contentImage, (s) => /^\d{1,2}(:\d{2}){1,2}$/.test(s));
    out.push(ytItem(id, title, author, hms(dur), !dur));
  }
  return out;
}

async function ytSearchApi(q, key) {
  const s = await getJSON('https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=25' +
    '&q=' + encodeURIComponent(q) + '&key=' + key);
  const ids = (s.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const d = await getJSON('https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=' +
    ids.join(',') + '&key=' + key);
  return (d.items || []).map((v) => ytItem(
    v.id, v.snippet.title, v.snippet.channelTitle,
    isoDuration(v.contentDetails && v.contentDetails.duration),
    v.snippet.liveBroadcastContent === 'live'
  ));
}

async function ytSearch(q) {
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    try { return await ytSearchApi(q, key); } catch (e) { console.warn('[suche] YouTube-API:', e.message); }
  }
  try {
    const data = await innertube('search', { query: q, params: 'EgIQAQ==' });
    const res = parseYtVideos(data);
    if (res.length) return res;
  } catch (e) {
    console.warn('[suche] YouTube intern:', e.message);
  }
  const r = await get('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) +
    '&sp=EgIQAQ%253D%253D', { headers: { cookie: YT_COOKIE } });
  if (!r.ok) throw new Error('YouTube antwortet mit ' + r.status);
  const data = extractJsonAfter(await r.text(), 'ytInitialData');
  if (!data) throw new Error('YouTube-Ergebnisse nicht lesbar');
  return parseYtVideos(data);
}

function parsePlaylistVideos(data) {
  const out = [];
  for (const v of collect(data, 'playlistVideoRenderer')) {
    if (!v || !v.videoId || v.isPlayable === false) continue;
    out.push(ytItem(v.videoId, txt(v.title), txt(v.shortBylineText),
      parseInt(v.lengthSeconds, 10) || hms(txt(v.lengthText))));
  }
  if (!out.length) return parseYtVideos(data);
  return out;
}

// Weiterblättern: Token steckt (teils verschachtelt) in "continuationCommand"
function continuationToken(data) {
  const found = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 80) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    for (const k of Object.keys(o)) {
      if (k === 'continuationCommand' && o[k] && typeof o[k].token === 'string') found.push(o[k]);
      walk(o[k], depth + 1);
    }
  })(data, 0);
  const c = found.find((x) => x.request === 'CONTINUATION_REQUEST_TYPE_BROWSE') || found[0];
  return c ? c.token : null;
}

async function ytPlaylist(listId) {
  if (/^RD/.test(listId)) throw new UserError('YouTube-Mixe lassen sich nicht importieren. Nimm eine normale Playlist.');
  let data;
  try {
    data = await innertube('browse', { browseId: 'VL' + listId });
  } catch (e) {
    const r = await get('https://www.youtube.com/playlist?list=' + encodeURIComponent(listId), { headers: { cookie: YT_COOKIE } });
    data = extractJsonAfter(await r.text(), 'ytInitialData');
  }
  if (!data) throw new UserError('Die Playlist konnte nicht geladen werden.', 502);
  const meta = collect(data, 'playlistMetadataRenderer')[0];
  const header = collect(data, 'pageHeaderRenderer')[0];
  const title = (meta && meta.title) || (header && header.pageTitle) || 'YouTube-Playlist';
  let items = parsePlaylistVideos(data);
  let token = continuationToken(data);
  for (let page = 0; token && items.length < 500 && page < 8; page++) {
    const more = await innertube('browse', { continuation: token });
    const got = parsePlaylistVideos(more);
    if (!got.length) break;
    items = items.concat(got);
    token = continuationToken(more);
  }
  const seen = new Set();
  items = items.filter((i) => !seen.has(i.id) && seen.add(i.id));
  if (!items.length) throw new UserError('Die Playlist ist leer, privat oder nicht verfügbar.', 404);
  return { title, items: items.slice(0, 500) };
}

// ---------- SoundCloud ----------

// SoundCloud-Suche nur mit eigenem, offiziellem API-Zugang:
//   SOUNDCLOUD_CLIENT_ID + SOUNDCLOUD_CLIENT_SECRET (Client-Credentials-Verfahren).
// Ohne Zugang funktionieren SoundCloud-Links trotzdem – über den offiziellen Player.
function scCreds() {
  const id = (process.env.SOUNDCLOUD_CLIENT_ID || '').trim();
  const secret = (process.env.SOUNDCLOUD_CLIENT_SECRET || '').trim();
  return id && secret ? { id, secret } : null;
}

function scAvailable() {
  return !!scCreds();
}

let scToken = null; // { value, exp }
async function getScToken(force) {
  if (!force && scToken && scToken.exp > Date.now() + 60e3) return scToken.value;
  const c = scCreds();
  if (!c) throw new UserError('Für die SoundCloud-Suche fehlt ein SoundCloud-API-Zugang (siehe Anleitung). SoundCloud-Links einfügen geht trotzdem.', 501);
  const r = await get('https://secure.soundcloud.com/oauth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json; charset=utf-8',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(c.id + ':' + c.secret).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new UserError('SoundCloud lehnt den API-Zugang ab (' + r.status + '). Prüf Client-ID und Secret.', 502);
  const j = await r.json();
  scToken = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return scToken.value;
}

async function scApi(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getScToken(attempt > 0);
    const r = await get('https://api.soundcloud.com' + path, {
      headers: { accept: 'application/json; charset=utf-8', authorization: 'OAuth ' + token }
    });
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 404) throw new UserError('Bei SoundCloud nicht gefunden (privat oder gelöscht?).', 404);
    if (!r.ok) throw new Error('SoundCloud antwortet mit ' + r.status);
    return r.json();
  }
  throw new UserError('SoundCloud lehnt den API-Zugang ab. Prüf Client-ID und Secret.', 502);
}

function scArtwork(t) {
  const a = t.artwork_url || (t.user && t.user.avatar_url) || '';
  return a.replace('-large.', '-t300x300.');
}

function scItem(t) {
  return {
    provider: 'soundcloud', kind: 'audio', id: t.permalink_url.replace('https://soundcloud.com/', ''),
    url: t.permalink_url, title: t.title, author: (t.user && t.user.username) || '',
    thumb: scArtwork(t), duration: Math.round((t.full_duration || t.duration || 0) / 1000),
    preview: t.access === 'preview'
  };
}

async function scSearch(q) {
  const j = await scApi('/tracks?q=' + encodeURIComponent(q) + '&access=playable&limit=25&linked_partitioning=true');
  const list = Array.isArray(j) ? j : j.collection || [];
  return list
    .filter((t) => t && t.permalink_url && t.embeddable_by !== 'none' && t.access !== 'blocked')
    .map(scItem);
}

async function scSet(url) {
  const set = await scApi('/resolve?url=' + encodeURIComponent(url));
  if (!set || set.kind !== 'playlist') throw new UserError('Das ist keine SoundCloud-Playlist.');
  const items = (set.tracks || [])
    .filter((t) => t && t.permalink_url && t.access !== 'blocked')
    .map(scItem);
  if (!items.length) throw new UserError('Die Playlist ist leer oder privat.', 404);
  return { title: set.title || 'SoundCloud-Playlist', items };
}

// ---------- Metadaten für eingefügte Links ----------

async function fetchMeta(p) {
  try {
    if (p.provider === 'youtube') {
      const j = await getJSON('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(p.url));
      return { title: j.title, author: j.author_name };
    }
    if (p.provider === 'soundcloud') {
      const j = await getJSON('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(p.url));
      return { title: j.title, author: j.author_name, thumb: j.thumbnail_url };
    }
    if (p.provider === 'vimeo') {
      const j = await getJSON('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(p.url));
      return { title: j.title, author: j.author_name, thumb: j.thumbnail_url, duration: j.duration };
    }
  } catch (e) {
    console.warn('[meta]', p.provider, e.message);
  }
  return {};
}

async function expandShort(p) {
  // on.soundcloud.com/xyz → soundcloud.com/kuenstler/titel
  const r = await get(p.url);
  try { await r.arrayBuffer(); } catch (e) { /* egal */ }
  const real = Media.parse(r.url);
  if (!real || real.short) throw new UserError('Der Kurzlink führt nicht zu einem SoundCloud-Titel.');
  return real;
}

async function resolve(url) {
  let p = Media.parse(url);
  if (!p) throw new UserError('Diesen Link kenne ich nicht.');
  if (p.short) p = await cached('short:' + p.url, 3600e3, () => expandShort(p));
  const meta = await cached('meta:' + p.url, 3600e3, () => fetchMeta(p));
  const out = { ...p };
  for (const k of ['title', 'author', 'thumb', 'duration']) if (meta[k]) out[k] = meta[k];
  return out;
}

async function search(src, q) {
  q = String(q || '').trim().slice(0, 200);
  if (!q) throw new UserError('Leere Suche.');
  if (src === 'soundcloud') return cached('sc:' + q.toLowerCase(), 10 * 60e3, () => scSearch(q));
  return cached('yt:' + q.toLowerCase(), 10 * 60e3, () => ytSearch(q));
}

async function expand(url) {
  const p = Media.parse(url);
  if (!p) throw new UserError('Diesen Link kenne ich nicht.');
  if (p.provider === 'youtube' && (p.kind === 'ytlist' || p.list)) {
    const list = p.kind === 'ytlist' ? p.id : p.list;
    return cached('ytpl:' + list, 10 * 60e3, () => ytPlaylist(list));
  }
  if (p.provider === 'soundcloud' && p.kind === 'set') {
    return cached('scset:' + p.url, 10 * 60e3, () => scSet(p.url));
  }
  throw new UserError('Das ist keine Playlist.');
}

module.exports = { search, resolve, expand, fetchMeta, expandShort, UserError, scAvailable, _test: { parseYtVideos, parsePlaylistVideos, extractJsonAfter, collect } };
