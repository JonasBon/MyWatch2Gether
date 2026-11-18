/* Couchkino – Oberfläche, Verbindung und Synchronisation */
(function () {
  'use strict';

  // ====================================================================
  // Helfer
  // ====================================================================
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('ck:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('ck:' + k, JSON.stringify(v)); } catch (e) { /* privat-Modus */ }
    }
  };
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  function rid(n) {
    const r = crypto.getRandomValues(new Uint8Array(n));
    let s = '';
    for (const x of r) s += ALPHA[x % ALPHA.length];
    return s;
  }
  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  function fmtLong(s) {
    s = Math.round(s / 60);
    if (s < 60) return s + ' Min.';
    return Math.floor(s / 60) + ' Std. ' + (s % 60) + ' Min.';
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name, extra) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ic' + (extra ? ' ' + extra : ''));
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }
  function iconBtn(name, label, cls) {
    const b = el('button', cls || 'ibtn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(name));
    return b;
  }
  function setIcon(btn, name) {
    const u = btn.querySelector('use');
    if (u) u.setAttribute('href', '#i-' + name);
  }
  function thumbEl(item, cls) {
    const wrap = el('div', 'thumb ' + (cls || '') + ' thumb-' + item.provider);
    if (item.thumb) {
      const img = new Image();
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      img.src = item.thumb;
      wrap.appendChild(img);
    }
    wrap.appendChild(icon(item.kind === 'audio' || item.provider === 'soundcloud' ? 'note' : 'play', 'thumb-fallback'));
    return wrap;
  }
  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  function toast(text, kind) {
    const t = el('div', 'toast' + (kind ? ' toast-' + kind : ''), text);
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), kind === 'error' ? 4200 : 2600);
    setTimeout(() => t.remove(), kind === 'error' ? 4700 : 3100);
  }

  // ====================================================================
  // Zustand
  // ====================================================================
  const S = {
    roomId: null,
    cid: store.get('cid', null) || ('c-' + rid(14)),
    name: store.get('name', ''),
    me: null,
    users: [],
    playlist: [],
    current: null,
    loop: 'off',
    pb: null,
    chat: [],
    joined: false,
    src: store.get('src', 'youtube'),
    tab: 'playlist',
    unread: 0,
    volume: store.get('vol', 80),
    muted: store.get('muted', false),
    offset: 0,
    scSearch: false
  };
  store.set('cid', S.cid);

  // ====================================================================
  // Verbindung
  // ====================================================================
  const Net = {
    ws: null,
    retry: 0,
    pingTimer: null,
    queue: [],
    samples: [],
    connect() {
      clearTimeout(this.retryTimer);
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try {
        ws = new WebSocket(proto + '://' + location.host + '/ws');
      } catch (e) {
        return this.scheduleRetry();
      }
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 0;
        ws.send(JSON.stringify({ t: 'join', room: S.roomId, name: S.name, cid: S.cid, cache: Cache.load() }));
        this.samples = [];
        for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 200);
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.ping(), 15000);
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        onMessage(m);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        S.joined = false;
        clearInterval(this.pingTimer);
        setConn(false);
        this.scheduleRetry();
      };
      ws.onerror = () => { /* onclose folgt */ };
    },
    scheduleRetry() {
      const d = Math.min(6000, 400 * Math.pow(1.8, this.retry++));
      this.retryTimer = setTimeout(() => this.connect(), d);
    },
    ping() {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
    },
    onPong(m) {
      const t = Date.now();
      const rtt = t - m.c;
      if (rtt < 0 || rtt > 10000) return;
      this.samples.push({ rtt, off: m.s - (m.c + rtt / 2) });
      if (this.samples.length > 10) this.samples.shift();
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      S.offset = best.off;
    },
    send(m) {
      if (this.ws && this.ws.readyState === 1 && S.joined) {
        this.ws.send(JSON.stringify(m));
        return true;
      }
      if (m.t === 'chat' || m.t === 'add') {
        this.queue.push(m);
        if (this.queue.length > 30) this.queue.shift();
        toast('Keine Verbindung – wird gesendet, sobald sie wieder steht.');
      }
      return false;
    },
    flush() {
      const q = this.queue;
      this.queue = [];
      for (const m of q) this.send(m);
    }
  };
  const serverNow = () => Date.now() + S.offset;

  function setConn(ok) {
    const c = $('#conn');
    c.classList.toggle('off', !ok);
    c.title = ok ? 'Verbunden' : 'Verbindung verloren – verbinde neu …';
    document.body.classList.toggle('offline', !ok);
  }

  // Raum-Kopie im Browser, damit ein Server-Neustart nichts kaputt macht
  const Cache = {
    timer: null,
    key() { return 'room:' + S.roomId; },
    save() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const pb = S.pb;
        store.set(this.key(), {
          t: Date.now(),
          playlist: S.playlist.slice(0, 500),
          current: S.current,
          loop: S.loop,
          item: pb && pb.item ? pb.item : null,
          pos: pb && pb.item ? Sync.expected() : 0
        });
      }, 1500);
    },
    load() {
      const c = store.get(this.key(), null);
      if (!c || Date.now() - c.t > 7 * 86400e3) return null;
      return c;
    }
  };

  function onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        S.joined = true;
        S.me = m.me;
        S.offset = m.s - Date.now();
        setConn(true);
        const r = m.room;
        S.users = r.users;
        S.playlist = r.playlist;
        S.current = r.current;
        S.loop = r.loop;
        S.chat = [];
        $('#chat-list').replaceChildren();
        r.chat.forEach((x) => addChat(x, true));
        Sync.apply(r.pb);
        renderPeople();
        renderPlaylist();
        renderMe();
        Net.flush();
        break;
      }
      case 'pb':
        Sync.apply(m.pb);
        renderPlaylist();
        Cache.save();
        break;
      case 'pbmeta':
        if (S.pb && S.pb.lid === m.lid) {
          S.pb.item = m.item;
          renderNow();
        }
        break;
      case 'pl':
        S.playlist = m.playlist;
        S.current = m.current;
        S.loop = m.loop;
        renderPlaylist();
        Cache.save();
        break;
      case 'users':
        S.users = m.users;
        renderPeople();
        break;
      case 'chat':
        addChat(m.msg);
        break;
      case 'pong':
        Net.onPong(m);
        break;
      case 'error':
        toast(m.text, 'error');
        break;
    }
  }

  // ====================================================================
  // Synchronisation
  // ====================================================================
  const Sync = {
    a: null,          // aktueller Player-Adapter
    lid: null,
    ignoreUntil: 0,   // eigene, programmgesteuerte Änderungen nicht zurückmelden
    last: null,
    lastFix: 0,
    askedPlayAt: 0,
    intent: 'pause',          // was wir zuletzt selbst angeordnet haben
    playedSinceIntent: false,
    hiddenAt: 0,
    blocked: false,
    error: null,
    reported: {},

    guard(ms) { this.ignoreUntil = Math.max(this.ignoreUntil, performance.now() + ms); },
    guarded() { return performance.now() < this.ignoreUntil; },
    noSync() { return !S.pb || !S.pb.item || S.pb.item.live || (this.a && this.a.noSync); },

    expected(pb) {
      pb = pb || S.pb;
      if (!pb || !pb.item) return 0;
      let p = pb.playing ? pb.pos + (serverNow() - pb.at) / 1000 : pb.pos;
      const d = pb.item.duration || (this.a && this.a.getDuration()) || 0;
      if (d && p > d) p = d;
      return Math.max(0, p);
    },

    apply(pb, tight) {
      S.pb = pb;
      renderNow();
      if (!pb || !pb.item) {
        this.unmount();
        setStage('idle');
        return;
      }
      if (!this.a || this.lid !== pb.lid) {
        this.mount(pb);
        return;
      }
      setStage(pb.playing ? 'playing' : 'paused');
      if (!this.a.ready) return; // „ready“ holt den Stand nach
      this.guard(1000);
      const target = this.expected();
      if (!this.noSync()) {
        const diff = Math.abs(this.a.getTime() - target);
        // pausiert ist Spulen billig → genauer angleichen
        const limit = !pb.playing ? 0.3 : (pb.action === 'seek' || tight ? 0.5 : 1);
        if (diff > limit) this.a.seek(target);
      }
      if (pb.playing) {
        if (this.intent !== 'play' || !this.a.isPlaying()) this.play();
      } else {
        this.pauseLocal();
        this.setBlocked(false);
      }
    },

    mount(pb) {
      this.unmount();
      this.lid = pb.lid;
      this.intent = pb.playing ? 'play' : 'pause';
      this.playedSinceIntent = false;
      this.last = null;
      this.error = null;
      this.guard(1500);
      showPlayerMsg(null);
      setStage(pb.playing ? 'playing' : 'paused');
      const lid = pb.lid;
      try {
        this.a = window.Players.create(pb.item, $('#player-host'), {
          start: this.expected(pb),
          autoplay: pb.playing,
          volume: S.volume,
          muted: S.muted
        }, (type, data) => this.onEvent(type, data, lid));
      } catch (e) {
        showPlayerMsg('Dieser Eintrag lässt sich nicht abspielen.');
        return;
      }
      this.askedPlayAt = pb.playing ? performance.now() : 0;
      updateControls();
    },

    unmount() {
      if (this.a) {
        try { this.a.destroy(); } catch (e) { /* egal */ }
      }
      this.a = null;
      this.lid = null;
      this.setBlocked(false);
      showPlayerMsg(null);
      $('#player-host').replaceChildren();
    },

    play() {
      if (!this.a) return;
      this.intent = 'play';
      this.playedSinceIntent = false;
      this.askedPlayAt = performance.now();
      this.a.play();
    },

    pauseLocal() {
      if (!this.a) return;
      this.intent = 'pause';
      this.askedPlayAt = 0;
      this.a.pause();
    },

    setBlocked(on) {
      if (this.blocked === on) return;
      this.blocked = on;
      $('#blocked').hidden = !on;
    },

    onEvent(type, data, lid) {
      if (lid !== this.lid || !this.a) return;
      const pb = S.pb;
      if (!pb || !pb.item) return;
      const a = this.a;
      switch (type) {
        case 'ready': {
          a.setVolume(S.volume, S.muted);
          this.guard(1200);
          if (!this.noSync()) {
            const exp = this.expected();
            if (Math.abs(a.getTime() - exp) > 1) a.seek(exp);
          }
          if (pb.playing) this.play();
          else this.pauseLocal();
          updateControls();
          break;
        }
        case 'play':
          this.playedSinceIntent = true;
          this.setBlocked(false);
          // Play im Player selbst gedrückt, während der Raum pausiert ist
          if (this.intent === 'pause' && !pb.playing && !this.guarded()) {
            this.intent = 'play';
            Net.send({ t: 'play', pos: a.getTime(), lid });
          }
          updateControls();
          break;
        case 'pause':
          // Handys pausieren beim Wegwechseln selbst – das soll die anderen nicht stoppen
          if (document.hidden || performance.now() - this.hiddenAt < 1500) break;
          // Pause im Player selbst gedrückt (nicht von uns angeordnet)
          if (this.intent === 'play' && this.playedSinceIntent && pb.playing && !this.guarded()) {
            this.intent = 'pause';
            Net.send({ t: 'pause', pos: a.getTime(), lid });
          }
          updateControls();
          break;
        case 'ended':
          Net.send({ t: 'ended', lid });
          break;
        case 'blocked':
          this.setBlocked(true);
          break;
        case 'meta': {
          const it = pb.item;
          const key = it.uid + ':' + lid;
          const d = data && data.duration;
          const needTitle = data && data.title && (!it.title || /^(YouTube|SoundCloud|Vimeo)-/.test(it.title));
          const needDur = d && !it.live && (!it.duration || Math.abs(it.duration - d) > 2);
          if ((needTitle || needDur) && this.reported[key] !== (d || 0) + (data.title || '')) {
            this.reported[key] = (d || 0) + (data.title || '');
            Net.send({ t: 'meta', uid: it.uid, duration: d || 0, title: data.title || '', author: data.author || '', thumb: data.thumb || '' });
          }
          updateControls();
          break;
        }
        case 'error':
          this.error = data;
          showPlayerMsg(data && data.msg);
          break;
      }
    },

    tick() {
      const a = this.a;
      const pb = S.pb;
      if (!a || !pb || !pb.item || !a.ready) {
        updateTime();
        return;
      }
      const t0 = performance.now();
      const t = a.getTime();
      const playing = a.isPlaying();
      const guarded = this.guarded();

      // Hat jemand im Player selbst gespult?
      if (this.last && !guarded && !this.noSync() && !document.hidden) {
        const dt = (t0 - this.last.at) / 1000;
        const jump = (t - this.last.t) - (this.last.playing ? dt : 0);
        if (Math.abs(jump) > 2.5) {
          Net.send({ t: 'seek', pos: t, lid: pb.lid });
          this.guard(1200);
        }
      }
      this.last = { t, at: t0, playing };

      // Pausiert, aber an anderer Stelle als der Raum → hier wurde im Player gespult
      if (!guarded && !this.noSync() && !pb.playing && !playing && !document.hidden &&
          Math.abs(t - this.expected()) > 2.5 && t0 - this.lastFix > 1000) {
        Net.send({ t: 'seek', pos: t, lid: pb.lid });
        this.lastFix = t0;
        this.guard(1200);
      }

      // Raum pausiert, Player läuft trotzdem (z. B. verpasstes Ereignis) → anhalten
      if (!guarded && !pb.playing && playing && this.intent === 'pause' && t0 - this.lastFix > 2000) {
        this.pauseLocal();
        this.lastFix = t0;
      }

      // Abweichung korrigieren
      if (!guarded && !this.noSync() && pb.playing && playing && t0 - this.lastFix > 5000) {
        const exp = this.expected();
        if (Math.abs(t - exp) > 1.5) {
          a.seek(exp);
          this.lastFix = t0;
          this.guard(1500);
        }
      }

      // Raum spielt, Player hier nicht → wahrscheinlich Autoplay blockiert
      if (pb.playing && !playing && !a.buffering && !this.error && this.askedPlayAt && t0 - this.askedPlayAt > 3500) {
        this.setBlocked(true);
      }
      updateTime(t);
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) Sync.hiddenAt = performance.now();
    else {
      Sync.hiddenAt = performance.now();
      // Zurück im Tab: Stand neu und genau anwenden
      if (S.pb && Sync.a && Sync.a.ready) Sync.apply(S.pb, true);
    }
  });
  setInterval(() => Sync.tick(), 500);

  // ====================================================================
  // Bühne + Steuerleiste
  // ====================================================================
  function setStage(state) {
    $('#screen').dataset.state = state;
    $('#empty').hidden = state !== 'idle';
    document.title = S.pb && S.pb.item
      ? (state === 'playing' ? '▶ ' : '❚❚ ') + S.pb.item.title + ' – Couchkino'
      : 'Couchkino';
    updateControls();
  }

  function showPlayerMsg(text) {
    const box = $('#player-msg');
    if (!text) { box.hidden = true; return; }
    $('#player-msg-text').textContent = text;
    const it = S.pb && S.pb.item;
    const link = $('#open-src');
    if (it && it.url) { link.href = it.url; link.hidden = false; } else link.hidden = true;
    box.hidden = false;
  }

  function currentDuration() {
    const pb = S.pb;
    if (!pb || !pb.item) return 0;
    return (Sync.a && Sync.a.ready && Sync.a.getDuration()) || pb.item.duration || 0;
  }

  let seeking = false;
  function updateTime(t) {
    const pb = S.pb;
    const seek = $('#seek');
    if (!pb || !pb.item) {
      $('#time-cur').textContent = '0:00';
      $('#time-dur').textContent = '0:00';
      seek.value = 0;
      seek.style.setProperty('--p', '0%');
      return;
    }
    if (pb.item.live) {
      $('#time-cur').textContent = 'Live';
      $('#time-dur').textContent = '';
      seek.style.setProperty('--p', '100%');
      return;
    }
    const d = currentDuration();
    if (t == null) t = Sync.expected();
    if (seeking) return;
    $('#time-cur').textContent = fmt(t);
    $('#time-dur').textContent = d ? fmt(d) : '–:––';
    seek.max = d || 100;
    seek.value = Math.min(t, d || 0);
    seek.style.setProperty('--p', d ? Math.min(100, (t / d) * 100) + '%' : '0%');
  }

  function updateControls() {
    const pb = S.pb;
    const has = !!(pb && pb.item);
    const playing = has && pb.playing;
    const pbtn = $('#play-btn');
    setIcon(pbtn, playing ? 'pause' : 'play');
    pbtn.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
    pbtn.title = playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)';
    pbtn.disabled = !has;
    $('#seek').disabled = !has || (pb && pb.item.live) || Sync.noSync();
    const idx = S.playlist.findIndex((i) => i.uid === S.current);
    $('#next-btn').disabled = !S.playlist.length || (S.loop !== 'all' && idx >= S.playlist.length - 1 && idx !== -1);
    $('#prev-btn').disabled = !has;
    setIcon($('#mute-btn'), S.muted || S.volume === 0 ? 'vol-off' : 'vol');
    $('#mute-btn').setAttribute('aria-label', S.muted ? 'Ton an' : 'Ton aus');
    const vol = $('#vol');
    vol.value = S.muted ? 0 : S.volume;
    vol.style.setProperty('--p', (S.muted ? 0 : S.volume) + '%');
  }

  function renderNow() {
    const pb = S.pb;
    const it = pb && pb.item;
    $('#now-title').textContent = it ? it.title : 'Nichts ausgewählt';
    const sub = $('#now-sub');
    sub.replaceChildren();
    const link = $('#now-link');
    if (it) {
      const bits = [];
      if (it.author) bits.push(it.author);
      bits.push(window.Media.providerName(it.provider));
      if (it.by) bits.push('von ' + it.by);
      bits.forEach((b) => sub.appendChild(el('span', null, b)));
      if (it.url && it.provider !== 'file') {
        link.href = it.url;
        $('#now-link-text').textContent = 'Auf ' + window.Media.providerName(it.provider) + ' öffnen';
        link.hidden = false;
      } else link.hidden = true;
    } else {
      link.hidden = true;
    }
    updateControls();
  }

  // Bedienelemente
  function togglePlay() {
    const pb = S.pb;
    if (!pb || !pb.item) return;
    const a = Sync.a;
    const pos = a && a.ready ? a.getTime() : Sync.expected();
    if (pb.playing) {
      Sync.pauseLocal();
      Net.send({ t: 'pause', pos, lid: pb.lid });
    } else {
      Sync.play();
      Net.send({ t: 'play', pos, lid: pb.lid });
    }
  }
  function seekTo(pos) {
    const pb = S.pb;
    if (!pb || !pb.item || pb.item.live) return;
    const d = currentDuration();
    pos = Math.max(0, d ? Math.min(pos, d - 0.5) : pos);
    Sync.guard(1200);
    if (Sync.a) Sync.a.seek(pos);
    Net.send({ t: 'seek', pos, lid: pb.lid });
  }
  function setVolume(v, muted) {
    S.volume = Math.round(v);
    S.muted = muted;
    store.set('vol', S.volume);
    store.set('muted', S.muted);
    if (Sync.a) Sync.a.setVolume(S.volume, S.muted);
    updateControls();
  }

  $('#play-btn').addEventListener('click', togglePlay);
  $('#next-btn').addEventListener('click', () => Net.send({ t: 'next' }));
  $('#prev-btn').addEventListener('click', () => Net.send({ t: 'prev' }));
  $('#skip-btn').addEventListener('click', () => Net.send({ t: 'next' }));
  $('#blocked-btn').addEventListener('click', () => {
    Sync.setBlocked(false);
    if (Sync.a) {
      Sync.guard(1500);
      if (!Sync.noSync()) Sync.a.seek(Sync.expected());
      Sync.play();
    }
  });
  const seekEl = $('#seek');
  seekEl.addEventListener('input', () => {
    seeking = true;
    const d = currentDuration();
    $('#time-cur').textContent = fmt(+seekEl.value);
    seekEl.style.setProperty('--p', d ? (seekEl.value / d) * 100 + '%' : '0%');
  });
  seekEl.addEventListener('change', () => {
    seeking = false;
    seekTo(+seekEl.value);
  });
  seekEl.addEventListener('pointerup', () => { setTimeout(() => { seeking = false; }, 50); });
  $('#mute-btn').addEventListener('click', () => {
    if (S.volume === 0) setVolume(60, false);
    else setVolume(S.volume, !S.muted);
  });
  $('#vol').addEventListener('input', (e) => setVolume(+e.target.value, false));

  const fullBtn = $('#full-btn');
  const screen = $('#screen');
  const canFull = !!(screen.requestFullscreen || screen.webkitRequestFullscreen);
  fullBtn.hidden = !canFull;
  fullBtn.addEventListener('click', () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else {
      const r = (screen.requestFullscreen || screen.webkitRequestFullscreen).call(screen);
      if (r && r.catch) r.catch(() => toast('Vollbild ist hier nicht möglich.'));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!S.joined || isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!$('#join-overlay').hidden || !$('#name-overlay').hidden) return;
    const k = e.key;
    if ((k === ' ' && e.target.tagName !== 'BUTTON') || k === 'k' || k === 'K') {
      e.preventDefault();
      togglePlay();
    } else if (k === 'ArrowRight' && e.target.type !== 'range') {
      e.preventDefault();
      seekTo((Sync.a && Sync.a.ready ? Sync.a.getTime() : Sync.expected()) + 10);
    } else if (k === 'ArrowLeft' && e.target.type !== 'range') {
      e.preventDefault();
      seekTo((Sync.a && Sync.a.ready ? Sync.a.getTime() : Sync.expected()) - 10);
    } else if (k === 'm' || k === 'M') {
      $('#mute-btn').click();
    } else if (k === 'n' || k === 'N') {
      Net.send({ t: 'next' });
    } else if (k === '/') {
      e.preventDefault();
      $('#omni-input').focus();
    }
  });

  // ====================================================================
  // Leute
  // ====================================================================
  function initial(name) {
    return (Array.from(name.trim())[0] || '?').toUpperCase();
  }
  function renderPeople() {
    const box = $('#people');
    box.replaceChildren();
    const users = S.users.slice().sort((a, b) => (a.cid === S.cid ? -1 : b.cid === S.cid ? 1 : 0));
    const shown = users.slice(0, 5);
    for (const u of shown) {
      const d = el('span', 'avatar', initial(u.name));
      d.style.setProperty('--c', u.color);
      d.title = u.name + (u.cid === S.cid ? ' (du)' : '');
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', d.title);
      box.appendChild(d);
    }
    if (users.length > shown.length) box.appendChild(el('span', 'avatar avatar-more', '+' + (users.length - shown.length)));
    const label = el('span', 'people-count', users.length === 1 ? 'nur du' : users.length + ' im Raum');
    box.appendChild(label);
  }
  function renderMe() {
    $('#me-name').textContent = S.name || 'Gast';
    const me = S.users.find((u) => u.cid === S.cid);
    $('#me-dot').style.setProperty('--c', (me && me.color) || (S.me && S.me.color) || '#FFB547');
  }

  // ====================================================================
  // Playlist
  // ====================================================================
  function renderPlaylist() {
    const list = $('#pl-list');
    const pl = S.playlist;
    $('#pl-count').textContent = pl.length;
    $('#pl-empty').hidden = pl.length > 0;
    $('.pl-tools').hidden = pl.length === 0;
    const total = pl.reduce((s, i) => s + (i.duration || 0), 0);
    $('#pl-sum').textContent = pl.length === 1 ? '1 Titel' : pl.length + ' Titel' + (total > 60 ? ', ' + fmtLong(total) : '');
    const playingUid = S.pb && S.pb.item ? S.pb.item.uid : null;
    const frag = document.createDocumentFragment();
    pl.forEach((it, i) => {
      const li = el('li', 'pl-item');
      li.dataset.uid = it.uid;
      const isCur = it.uid === S.current || it.uid === playingUid;
      if (isCur) {
        li.classList.add('is-current');
        if (S.pb && S.pb.playing) li.classList.add('is-playing');
      }
      const grip = iconBtn('grip', 'Verschieben (Pfeiltasten oder ziehen)', 'grip');
      li.appendChild(grip);
      const idx = el('span', 'pl-idx');
      if (isCur) {
        const eq = el('span', 'eq');
        eq.setAttribute('aria-label', 'Läuft gerade');
        eq.append(el('i'), el('i'), el('i'));
        idx.appendChild(eq);
      } else idx.textContent = i + 1;
      li.appendChild(idx);
      const main = el('button', 'pl-main');
      main.type = 'button';
      main.title = 'Jetzt abspielen';
      main.appendChild(thumbEl(it));
      const meta = el('span', 'pl-meta');
      meta.appendChild(el('span', 'pl-title', it.title));
      const sub = el('span', 'pl-sub');
      if (it.author) sub.appendChild(el('span', null, it.author));
      if (it.duration) sub.appendChild(el('span', null, fmt(it.duration)));
      else if (it.live) sub.appendChild(el('span', 'live', 'Live'));
      if (it.by) sub.appendChild(el('span', 'pl-by', 'von ' + it.by));
      meta.appendChild(sub);
      main.appendChild(meta);
      li.appendChild(main);
      const rm = iconBtn('x', 'Aus der Playlist entfernen', 'ibtn pl-rm');
      li.appendChild(rm);
      frag.appendChild(li);
    });
    list.replaceChildren(frag);
    // Wiederholen-Knopf
    const loopBtn = $('#loop-btn');
    setIcon(loopBtn, S.loop === 'one' ? 'repeat-one' : 'repeat');
    loopBtn.classList.toggle('on', S.loop !== 'off');
    loopBtn.setAttribute('aria-pressed', S.loop !== 'off');
    $('#loop-label').textContent = S.loop === 'all' ? 'Alle wiederholen' : S.loop === 'one' ? 'Titel wiederholen' : 'Wiederholen';
    updateControls();
  }

  $('#pl-list').addEventListener('click', (e) => {
    const li = e.target.closest('.pl-item');
    if (!li) return;
    if (e.target.closest('.pl-rm')) {
      Net.send({ t: 'remove', uid: li.dataset.uid });
      li.classList.add('removing');
    } else if (e.target.closest('.pl-main')) {
      Net.send({ t: 'playItem', uid: li.dataset.uid });
    }
  });

  function moveLocal(uid, to) {
    const from = S.playlist.findIndex((i) => i.uid === uid);
    if (from < 0 || from === to) return;
    const [it] = S.playlist.splice(from, 1);
    S.playlist.splice(to, 0, it);
    renderPlaylist();
    Net.send({ t: 'move', uid, to });
  }

  // Tastatur: Pfeile auf dem Griff
  $('#pl-list').addEventListener('keydown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const uid = grip.closest('.pl-item').dataset.uid;
    const from = S.playlist.findIndex((i) => i.uid === uid);
    const to = Math.max(0, Math.min(S.playlist.length - 1, from + (e.key === 'ArrowUp' ? -1 : 1)));
    moveLocal(uid, to);
    const again = $('.pl-item[data-uid="' + uid + '"] .grip');
    if (again) again.focus();
  });

  // Ziehen mit Maus oder Finger
  $('#pl-list').addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const list = $('#pl-list');
    const scroller = $('#panel-playlist');
    const li = grip.closest('.pl-item');
    const items = $$('.pl-item', list);
    const from = items.indexOf(li);
    if (from < 0 || items.length < 2) return;
    const tops = items.map((x) => x.offsetTop);
    const step = items.length > 1 ? tops[1] - tops[0] : li.offsetHeight;
    const startY = e.clientY;
    const startScroll = scroller.scrollTop;
    let to = from;
    let lastY = e.clientY;
    let raf = 0;
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
    li.classList.add('dragging');
    list.classList.add('is-dragging');

    function layout() {
      const dy = lastY - startY + (scroller.scrollTop - startScroll);
      li.style.transform = 'translateY(' + dy + 'px)';
      to = Math.max(0, Math.min(items.length - 1, Math.round(from + dy / step)));
      items.forEach((x, k) => {
        if (k === from) return;
        let shift = 0;
        if (from < to && k > from && k <= to) shift = -step;
        if (from > to && k >= to && k < from) shift = step;
        x.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      });
    }
    function autoscroll() {
      const r = scroller.getBoundingClientRect();
      let v = 0;
      if (lastY < r.top + 48) v = -Math.ceil((r.top + 48 - lastY) / 6);
      else if (lastY > r.bottom - 48) v = Math.ceil((lastY - (r.bottom - 48)) / 6);
      if (v) {
        scroller.scrollTop += v;
        layout();
      }
      raf = requestAnimationFrame(autoscroll);
    }
    raf = requestAnimationFrame(autoscroll);
    function move(ev) {
      lastY = ev.clientY;
      layout();
    }
    function up() {
      cancelAnimationFrame(raf);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      items.forEach((x) => { x.style.transform = ''; });
      li.classList.remove('dragging');
      list.classList.remove('is-dragging');
      if (to !== from) moveLocal(li.dataset.uid, to);
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });

  $('#shuffle-btn').addEventListener('click', () => Net.send({ t: 'shuffle' }));
  $('#loop-btn').addEventListener('click', () => {
    const next = { off: 'all', all: 'one', one: 'off' }[S.loop] || 'off';
    Net.send({ t: 'loop', mode: next });
    toast(next === 'all' ? 'Die ganze Playlist wird wiederholt' : next === 'one' ? 'Der aktuelle Titel wird wiederholt' : 'Wiederholen aus');
  });
  let clearArmed = 0;
  $('#clear-btn').addEventListener('click', () => {
    const btn = $('#clear-btn');
    if (Date.now() - clearArmed < 3000) {
      clearArmed = 0;
      btn.classList.remove('armed');
      $('#clear-label').textContent = 'Leeren';
      Net.send({ t: 'clear' });
      return;
    }
    clearArmed = Date.now();
    btn.classList.add('armed');
    $('#clear-label').textContent = 'Wirklich leeren?';
    setTimeout(() => {
      if (Date.now() - clearArmed >= 2900) {
        btn.classList.remove('armed');
        $('#clear-label').textContent = 'Leeren';
      }
    }, 3000);
  });

  // ====================================================================
  // Hinzufügen
  // ====================================================================
  function metaOf(r) {
    return { title: r.title, author: r.author, thumb: r.thumb, duration: r.duration, preview: r.preview };
  }
  function addItems(items, mode) {
    if (!items.length) return;
    Net.send({ t: 'add', mode, items });
    const label = items.length === 1 ? '„' + (items[0].meta && items[0].meta.title || 'Titel') + '“' : items.length + ' Titel';
    if (mode === 'now') toast(label + ' wird abgespielt');
    else if (mode === 'next') toast(label + ' kommt als Nächstes');
    else toast(label + ' ist in der Playlist');
  }

  // ====================================================================
  // Suchfeld: Link oder Suche
  // ====================================================================
  const omni = $('#omni-input');
  let linkState = null;
  let resolveSeq = 0;

  function setSrc(src) {
    if (!S.scSearch) src = 'youtube';
    S.src = src;
    store.set('src', src);
    $$('.src-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.src === src)));
    omni.placeholder = S.scSearch && window.innerWidth >= 600
      ? 'Auf ' + (src === 'soundcloud' ? 'SoundCloud' : 'YouTube') + ' suchen oder Link einfügen'
      : 'Suchen oder Link einfügen';
  }
  $$('.src-btn').forEach((b) => b.addEventListener('click', () => {
    setSrc(b.dataset.src);
    const q = omni.value.trim();
    if (q && !window.Media.looksLikeUrl(q)) doSearch(q);
    else omni.focus();
  }));

  function hideLinkCard() {
    linkState = null;
    $('#linkcard').hidden = true;
    $('#linkcard').replaceChildren();
  }

  function cardButton(iconName, label, cls, fn) {
    const b = el('button', 'btn btn-small ' + (cls || ''));
    b.type = 'button';
    b.appendChild(icon(iconName));
    b.appendChild(el('span', null, label));
    b.addEventListener('click', fn);
    return b;
  }

  function renderLinkCard() {
    const card = $('#linkcard');
    const st = linkState;
    card.replaceChildren();
    if (!st) { card.hidden = true; return; }
    card.hidden = false;
    if (st.unsupported) {
      card.classList.add('linkcard-warn');
      card.appendChild(el('p', 'lc-title', 'Diesen Link kann ich nicht abspielen.'));
      card.appendChild(el('p', 'lc-sub', 'Geht: YouTube, SoundCloud, Vimeo, Twitch und direkte Dateien (.mp4, .webm, .mp3, .m3u8 …).'));
      return;
    }
    card.classList.remove('linkcard-warn');
    const p = st.info;
    const top = el('div', 'lc-top');
    top.appendChild(thumbEl(p, 'lc-thumb'));
    const meta = el('div', 'lc-meta');
    meta.appendChild(el('p', 'lc-title', st.loading && p.kind !== 'ytlist' ? 'Lade Infos …' : p.title));
    const sub = el('p', 'lc-sub');
    const bits = [window.Media.providerName(p.provider)];
    if (p.author) bits.push(p.author);
    if (p.duration) bits.push(fmt(p.duration));
    if (p.kind === 'set' || p.kind === 'ytlist') bits.push('Playlist');
    bits.forEach((b) => sub.appendChild(el('span', null, b)));
    meta.appendChild(sub);
    top.appendChild(meta);
    const close = iconBtn('x', 'Schließen', 'ibtn lc-close');
    close.addEventListener('click', () => { omni.value = ''; hideLinkCard(); });
    top.appendChild(close);
    card.appendChild(top);

    const actions = el('div', 'lc-actions');
    const single = { url: p.url, meta: st.loading ? {} : metaOf(p) };
    const done = () => { omni.value = ''; hideLinkCard(); };
    if (p.kind === 'ytlist') {
      actions.appendChild(cardButton('play', 'Playlist abspielen', 'btn-primary', () => expandAndAdd(p.url, 'now')));
      actions.appendChild(cardButton('plus', 'Zur Playlist', '', () => expandAndAdd(p.url, 'end')));
    } else {
      actions.appendChild(cardButton('play', 'Abspielen', 'btn-primary', () => { addItems([single], 'now'); done(); }));
      actions.appendChild(cardButton('next-up', 'Als Nächstes', '', () => { addItems([single], 'next'); done(); }));
      actions.appendChild(cardButton('plus', 'Zur Playlist', '', () => { addItems([single], 'end'); done(); }));
      if (p.list) {
        actions.appendChild(cardButton('plus', 'Ganze YouTube-Playlist', 'btn-ghost', () => expandAndAdd('https://www.youtube.com/playlist?list=' + p.list, 'end')));
      }
      if (p.kind === 'set' && S.scSearch) {
        actions.appendChild(cardButton('plus', 'Alle Titel einzeln', 'btn-ghost', () => expandAndAdd(p.url, 'end')));
      }
    }
    card.appendChild(actions);
    if (p.provider === 'twitch' && p.kind === 'live') {
      card.appendChild(el('p', 'lc-note', 'Live-Streams laufen bei allen, lassen sich aber nicht spulen.'));
    }
    if (p.kind === 'set') {
      card.appendChild(el('p', 'lc-note', 'Als Ganzes läuft die Playlist im SoundCloud-Player; synchron sind dann nur Start und Pause.'));
    }
  }

  async function expandAndAdd(url, mode) {
    const card = $('#linkcard');
    card.classList.add('busy');
    try {
      const r = await fetch('/api/expand?url=' + encodeURIComponent(url));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Fehler');
      addItems(j.items.map((i) => ({ url: i.url, meta: metaOf(i) })), mode);
      omni.value = '';
      hideLinkCard();
    } catch (e) {
      toast(e.message || 'Die Playlist konnte nicht geladen werden.', 'error');
    } finally {
      card.classList.remove('busy');
    }
  }

  function onOmniChange() {
    const v = omni.value.trim();
    const p = window.Media.parse(v);
    if (p) {
      if (linkState && linkState.info.url === p.url) return;
      const seq = ++resolveSeq;
      linkState = { info: p, loading: true };
      renderLinkCard();
      fetch('/api/resolve?url=' + encodeURIComponent(v))
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (seq !== resolveSeq || !linkState) return;
          linkState = { info: ok ? Object.assign({}, p, j) : p, loading: false };
          renderLinkCard();
        })
        .catch(() => {
          if (seq !== resolveSeq || !linkState) return;
          linkState = { info: p, loading: false };
          renderLinkCard();
        });
    } else if (window.Media.looksLikeUrl(v)) {
      resolveSeq++;
      linkState = { unsupported: true };
      renderLinkCard();
    } else if (linkState) {
      resolveSeq++;
      hideLinkCard();
    }
  }
  omni.addEventListener('input', onOmniChange);
  omni.addEventListener('paste', () => setTimeout(onOmniChange, 0));

  $('#omni').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = omni.value.trim();
    if (!v) return;
    if (linkState && linkState.info) {
      const p = linkState.info;
      if (p.kind === 'ytlist') return expandAndAdd(p.url, 'end');
      addItems([{ url: p.url, meta: linkState.loading ? {} : metaOf(p) }], 'end');
      omni.value = '';
      hideLinkCard();
      return;
    }
    if (linkState && linkState.unsupported) return;
    doSearch(v);
    omni.blur();
  });

  // ====================================================================
  // Suche
  // ====================================================================
  let searchSeq = 0;
  let lastResults = [];
  async function doSearch(q) {
    const seq = ++searchSeq;
    switchTab('search');
    const head = $('#search-head');
    const list = $('#results');
    const srcName = S.src === 'soundcloud' ? 'SoundCloud' : 'YouTube';
    head.replaceChildren(el('p', 'search-status', 'Suche „' + q + '“ auf ' + srcName + ' …'));
    list.replaceChildren();
    list.classList.add('loading');
    for (let i = 0; i < 6; i++) list.appendChild(el('li', 'result skeleton'));
    try {
      const r = await fetch('/api/search?src=' + S.src + '&q=' + encodeURIComponent(q));
      const j = await r.json();
      if (seq !== searchSeq) return;
      if (!r.ok) throw new Error(j.error || 'Die Suche hat nicht geklappt.');
      lastResults = j.results;
      renderResults(q, srcName);
    } catch (e) {
      if (seq !== searchSeq) return;
      list.replaceChildren();
      head.replaceChildren(el('p', 'search-status search-error', e.message || 'Die Suche hat nicht geklappt.'));
    } finally {
      if (seq === searchSeq) list.classList.remove('loading');
    }
  }

  function renderResults(q, srcName) {
    const head = $('#search-head');
    const list = $('#results');
    list.replaceChildren();
    if (!lastResults.length) {
      head.replaceChildren(el('p', 'search-status', 'Keine Treffer für „' + q + '“ auf ' + srcName + '.'));
      return;
    }
    head.replaceChildren(el('p', 'search-status', lastResults.length + ' Treffer auf ' + srcName));
    const inList = new Set(S.playlist.map((i) => i.url));
    lastResults.forEach((r, i) => {
      const li = el('li', 'result');
      li.dataset.i = i;
      const t = thumbEl(r, 'result-thumb');
      if (r.duration) t.appendChild(el('span', 'dur', fmt(r.duration)));
      else if (r.live) t.appendChild(el('span', 'dur live', 'Live'));
      li.appendChild(t);
      const meta = el('div', 'result-meta');
      meta.appendChild(el('p', 'result-title', r.title));
      const sub = el('p', 'result-sub');
      if (r.author) sub.appendChild(el('span', null, r.author));
      if (r.preview) sub.appendChild(el('span', 'warn', 'nur 30-s-Vorschau'));
      meta.appendChild(sub);
      li.appendChild(meta);
      const acts = el('div', 'result-acts');
      acts.appendChild(iconBtn('play', 'Jetzt abspielen', 'ibtn r-play'));
      acts.appendChild(iconBtn('next-up', 'Als Nächstes', 'ibtn r-next'));
      const add = iconBtn(inList.has(r.url) ? 'check' : 'plus', inList.has(r.url) ? 'Schon in der Playlist – nochmal hinzufügen' : 'Zur Playlist', 'ibtn r-add');
      if (inList.has(r.url)) add.classList.add('done');
      acts.appendChild(add);
      li.appendChild(acts);
      list.appendChild(li);
    });
  }

  $('#results').addEventListener('click', (e) => {
    const li = e.target.closest('.result');
    if (!li || li.classList.contains('skeleton')) return;
    const r = lastResults[+li.dataset.i];
    if (!r) return;
    const item = { url: r.url, meta: metaOf(r) };
    if (e.target.closest('.r-play')) addItems([item], 'now');
    else if (e.target.closest('.r-next')) addItems([item], 'next');
    else if (e.target.closest('.r-add')) {
      addItems([item], 'end');
      const b = li.querySelector('.r-add');
      setIcon(b, 'check');
      b.classList.add('done');
    }
  });

  // ====================================================================
  // Reiter
  // ====================================================================
  function switchTab(tab) {
    S.tab = tab;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'panel-' + tab; });
    if (tab === 'chat') {
      S.unread = 0;
      $('#chat-badge').hidden = true;
      const list = $('#chat-list');
      list.scrollTop = list.scrollHeight;
    }
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = $$('.tab');
    const i = tabs.findIndex((t) => t.dataset.tab === S.tab);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    switchTab(n.dataset.tab);
    n.focus();
  });

  // ====================================================================
  // Chat
  // ====================================================================
  function addChat(msg, quiet) {
    S.chat.push(msg);
    const list = $('#chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const li = el('li', msg.sys ? 'msg msg-sys' : 'msg');
    const time = new Date(msg.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (msg.sys) {
      li.appendChild(el('span', 'msg-text', msg.text));
      li.appendChild(el('time', 'msg-time', time));
    } else {
      const head = el('div', 'msg-head');
      const n = el('span', 'msg-name', msg.name);
      n.style.setProperty('--c', msg.color);
      head.appendChild(n);
      head.appendChild(el('time', 'msg-time', time));
      li.appendChild(head);
      li.appendChild(el('p', 'msg-text', msg.text));
      if (msg.cid === S.cid) li.classList.add('msg-me');
    }
    list.appendChild(li);
    while (list.children.length > 150) list.firstChild.remove();
    if (nearBottom || msg.cid === S.cid) list.scrollTop = list.scrollHeight;
    if (!quiet && !msg.sys && S.tab !== 'chat' && msg.cid !== S.cid) {
      S.unread++;
      const b = $('#chat-badge');
      b.textContent = S.unread > 9 ? '9+' : S.unread;
      b.hidden = false;
    }
  }
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (!text) return;
    Net.send({ t: 'chat', text });
    inp.value = '';
  });

  // ====================================================================
  // Einladen, Name, Dialoge
  // ====================================================================
  function roomLink() {
    return location.origin + '/r/' + S.roomId;
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return false;
    }
  }
  $('#invite-btn').addEventListener('click', async () => {
    const link = roomLink();
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.share) {
      try {
        await navigator.share({ title: 'Couchkino', text: 'Schau mit mir zusammen:', url: link });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    if (await copyText(link)) toast('Link kopiert – schick ihn rum');
    else openDialog('#invite-overlay');
  });
  $('#invite-copy').addEventListener('click', async () => {
    const inp = $('#invite-input');
    inp.select();
    if (await copyText(inp.value)) {
      toast('Link kopiert');
      closeDialogs();
    } else {
      try { document.execCommand('copy'); toast('Link kopiert'); closeDialogs(); } catch (e) { toast('Markier den Link und kopier ihn selbst.'); }
    }
  });

  let lastFocus = null;
  function openDialog(sel) {
    lastFocus = document.activeElement;
    const o = $(sel);
    o.hidden = false;
    if (sel === '#invite-overlay') $('#invite-input').value = roomLink();
    if (sel === '#name-overlay') $('#name-input').value = S.name;
    const f = $('input', o);
    if (f) setTimeout(() => { f.focus(); f.select(); }, 30);
  }
  function closeDialogs() {
    ['#name-overlay', '#invite-overlay'].forEach((s) => { $(s).hidden = true; });
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeDialogs));
  $$('.overlay').forEach((o) => o.addEventListener('click', (e) => {
    if (e.target === o && o.id !== 'join-overlay') closeDialogs();
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialogs();
  });
  $('#me-btn').addEventListener('click', () => openDialog('#name-overlay'));
  $('#name-dialog').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('#name-input').value.trim().slice(0, 24);
    if (n) {
      S.name = n;
      store.set('name', n);
      Net.send({ t: 'name', name: n });
      renderMe();
    }
    closeDialogs();
  });

  // ====================================================================
  // Start, Raum betreten
  // ====================================================================
  function showLanding() {
    $('#app').hidden = true;
    $('#join-overlay').hidden = true;
    $('#landing').hidden = false;
    document.body.className = 'is-landing';
    document.title = 'Couchkino';
    const n = $('#landing-name');
    n.value = S.name;
  }

  function enterRoom(id, alreadyClicked) {
    S.roomId = id;
    $('#landing').hidden = true;
    $('#app').hidden = false;
    document.body.className = 'is-room';
    $('#room-code').textContent = id;
    setSrc(S.src);
    fetch('/api/config').then((r) => r.json()).then((c) => {
      S.scSearch = !!c.soundcloudSearch;
      $('#omni .src').hidden = !S.scSearch;
      setSrc(store.get('src', 'youtube'));
    }).catch(() => {});
    setVolume(S.volume, S.muted);
    renderPlaylist();
    renderNow();
    setStage('idle');
    if (alreadyClicked && S.name) {
      start();
    } else {
      $('#join-room-code').textContent = id;
      $('#join-name').value = S.name;
      $('#join-overlay').hidden = false;
      setTimeout(() => (S.name ? $('#join-dialog button') : $('#join-name')).focus(), 50);
    }
  }

  function start() {
    $('#join-overlay').hidden = true;
    renderMe();
    Net.connect();
  }

  $('#join-dialog').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('#join-name').value.trim().slice(0, 24);
    if (!n) {
      $('#join-name').focus();
      return;
    }
    S.name = n;
    store.set('name', n);
    start();
  });

  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('#landing-name').value.trim().slice(0, 24);
    if (!n) {
      $('#landing-name').focus();
      $('#landing-name').classList.add('shake');
      setTimeout(() => $('#landing-name').classList.remove('shake'), 400);
      return;
    }
    S.name = n;
    store.set('name', n);
    const id = rid(6);
    history.pushState(null, '', '/r/' + id);
    enterRoom(id, true);
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#join-code').value.trim();
    const m = /(?:\/r\/)?([a-z0-9-]{3,32})\/?$/i.exec(v);
    const err = $('#join-error');
    if (!m) {
      err.textContent = 'Das sieht nicht nach einem Raum-Code aus. Er steht am Ende des Links, z. B. …/r/k7x2qm.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    const n = $('#landing-name').value.trim();
    if (n) { S.name = n.slice(0, 24); store.set('name', S.name); }
    const id = m[1].toLowerCase();
    history.pushState(null, '', '/r/' + id);
    enterRoom(id, !!S.name);
  });

  function route() {
    const m = /^\/r\/([a-z0-9-]{3,32})\/?$/i.exec(location.pathname);
    if (m) enterRoom(m[1].toLowerCase(), false);
    else showLanding();
  }
  window.addEventListener('popstate', () => location.reload());

  // Für Tests und Neugierige
  window.Couchkino = { S, Sync, Net };

  route();
})();
