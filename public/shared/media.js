/*
 * Couchkino – Link-Erkennung (läuft im Browser UND auf dem Server).
 * Media.parse(link) → { provider, kind, id, url, ... } oder null.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Media = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)$/i;
  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
  const HLS_EXT = /\.m3u8$/i;

  const SC_RESERVED = new Set([
    'discover', 'search', 'stream', 'you', 'upload', 'charts', 'pages', 'settings',
    'messages', 'notifications', 'terms-of-use', 'imprint', 'mobile', 'feed',
    'stations', 'people', 'signin', 'logout', 'jobs', 'press', 'popular'
  ]);
  const SC_PROFILE_PAGES = new Set([
    'tracks', 'albums', 'reposts', 'likes', 'followers', 'following',
    'popular-tracks', 'comments', 'playlists', 'spotlight'
  ]);
  const TWITCH_RESERVED = new Set([
    'directory', 'videos', 'settings', 'subscriptions', 'inventory', 'wallet',
    'drops', 'search', 'downloads', 'jobs', 'turbo', 'p', 'login', 'signup'
  ]);

  const PROVIDER_NAMES = {
    youtube: 'YouTube', soundcloud: 'SoundCloud', vimeo: 'Vimeo',
    twitch: 'Twitch', file: 'Datei'
  };

  function looksLikeUrl(input) {
    const s = String(input || '').trim();
    if (!s || /\s/.test(s)) return false;
    if (/^https?:\/\//i.test(s)) return true;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(s);
  }

  function toURL(input) {
    let s = String(input || '').trim();
    if (!s || /\s/.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) {
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(s)) s = 'https://' + s;
      else return null;
    }
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch (e) {
      return null;
    }
  }

  // "90", "1:30", "1:02:03", "1h2m3s", "2m", "45s"
  function parseTime(t) {
    if (!t) return 0;
    t = String(t).trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
      return t.split(':').reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
    }
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(t);
    if (m && (m[1] || m[2] || m[3])) {
      return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    }
    return 0;
  }

  function ytThumb(id) {
    return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
  }

  function youtubeVideo(id, u, list) {
    return {
      provider: 'youtube',
      kind: 'video',
      id: id,
      url: 'https://www.youtube.com/watch?v=' + id,
      thumb: ytThumb(id),
      title: 'YouTube-Video',
      start: parseTime(u.searchParams.get('t') || u.searchParams.get('start')),
      // Mixe (RD…) lassen sich nicht importieren
      list: list && /^[A-Za-z0-9_-]{10,}$/.test(list) && !/^RD/.test(list) ? list : null
    };
  }

  function parse(input) {
    const u = toURL(input);
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    const path = u.pathname;
    const parts = path.split('/').filter(Boolean);

    // ---------- YouTube ----------
    if (host === 'youtu.be') {
      const id = parts[0] || '';
      return YT_ID.test(id) ? youtubeVideo(id, u, u.searchParams.get('list')) : null;
    }
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      let id = u.searchParams.get('v');
      if (!id) {
        const m = /^\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})/.exec(path);
        if (m) id = m[1];
      }
      const list = u.searchParams.get('list');
      if (id && YT_ID.test(id)) return youtubeVideo(id, u, list);
      if (list && /^[A-Za-z0-9_-]{10,}$/.test(list)) {
        return {
          provider: 'youtube',
          kind: 'ytlist',
          id: list,
          list: list,
          url: 'https://www.youtube.com/playlist?list=' + list,
          title: 'YouTube-Playlist',
          mix: /^RD/.test(list)
        };
      }
      return null;
    }

    // ---------- SoundCloud ----------
    if (host === 'on.soundcloud.com' || host === 'snd.sc') {
      if (!parts.length) return null;
      return {
        provider: 'soundcloud', kind: 'audio', short: true,
        id: u.href, url: u.href, title: 'SoundCloud-Titel'
      };
    }
    if (host === 'soundcloud.com') {
      if (parts.length < 2 || SC_RESERVED.has(parts[0].toLowerCase())) return null;
      if (SC_PROFILE_PAGES.has(parts[1].toLowerCase())) return null;
      const isSet = parts[1] === 'sets';
      if (isSet && parts.length < 3) return null;
      let keep = 2;
      if (isSet) keep = parts[3] && /^s-/.test(parts[3]) ? 4 : 3;
      else if (parts[2] && /^s-/.test(parts[2])) keep = 3; // private Links
      const clean = 'https://soundcloud.com/' + parts.slice(0, keep).join('/');
      const tm = /t=([\d:hms]+)/.exec(u.hash || '');
      return {
        provider: 'soundcloud',
        kind: isSet ? 'set' : 'audio',
        id: parts.slice(0, keep).join('/'),
        url: clean,
        title: isSet ? 'SoundCloud-Playlist' : 'SoundCloud-Titel',
        start: tm ? parseTime(tm[1]) : 0
      };
    }
    if (host === 'api.soundcloud.com' && /^\/tracks\/\d+/.test(path)) {
      const clean = 'https://api.soundcloud.com' + path.replace(/\/$/, '');
      return { provider: 'soundcloud', kind: 'audio', id: path, url: clean, title: 'SoundCloud-Titel' };
    }

    // ---------- Vimeo ----------
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const m = /^\/(?:video\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?\/?$/.exec(path) ||
        /\/(\d{5,})(?:\/([0-9a-f]{6,}))?\/?$/.exec(path);
      if (!m) return null;
      const id = m[1];
      const hash = m[2] || u.searchParams.get('h') || null;
      const tm = /t=([\dhms]+)/.exec(u.hash || '');
      return {
        provider: 'vimeo', kind: 'video', id: id, hash: hash,
        url: 'https://vimeo.com/' + id + (hash ? '/' + hash : ''),
        title: 'Vimeo-Video',
        start: tm ? parseTime(tm[1]) : 0
      };
    }

    // ---------- Twitch ----------
    if (host === 'twitch.tv' || host === 'go.twitch.tv') {
      if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) {
        return {
          provider: 'twitch', kind: 'video', id: 'v' + parts[1],
          url: 'https://www.twitch.tv/videos/' + parts[1],
          title: 'Twitch-Video',
          start: parseTime(u.searchParams.get('t'))
        };
      }
      if (parts.length === 1 && /^[A-Za-z0-9_]{3,25}$/.test(parts[0]) &&
          !TWITCH_RESERVED.has(parts[0].toLowerCase())) {
        const ch = parts[0].toLowerCase();
        return {
          provider: 'twitch', kind: 'live', live: true, id: ch,
          url: 'https://www.twitch.tv/' + ch,
          title: parts[0] + ' (live auf Twitch)', author: parts[0]
        };
      }
      return null;
    }

    // ---------- Direkte Dateien ----------
    let fileName = parts.length ? parts[parts.length - 1] : '';
    try { fileName = decodeURIComponent(fileName); } catch (e) { /* egal */ }
    if (HLS_EXT.test(path)) {
      return { provider: 'file', kind: 'video', hls: true, id: u.href, url: u.href, title: fileName || 'Stream' };
    }
    if (VIDEO_EXT.test(path)) {
      return { provider: 'file', kind: 'video', id: u.href, url: u.href, title: fileName };
    }
    if (AUDIO_EXT.test(path)) {
      return { provider: 'file', kind: 'audio', id: u.href, url: u.href, title: fileName };
    }
    return null;
  }

  return {
    parse: parse,
    parseTime: parseTime,
    looksLikeUrl: looksLikeUrl,
    ytThumb: ytThumb,
    providerName: function (p) { return PROVIDER_NAMES[p] || p; }
  };
});
