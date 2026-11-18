/*
 * Couchkino – Player-Adapter.
 * Jeder Adapter bietet: play(), pause(), seek(s), getTime(), getDuration(),
 * isPlaying(), setVolume(0..100, muted), destroy()
 * und meldet Ereignisse über emit(type, data):
 *   ready, play, pause, ended, meta {duration,title,author,thumb}, blocked, error {msg}
 */
(function () {
  'use strict';

  const scripts = {};
  function loadScript(src, timeout = 15000) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        const t = setTimeout(() => fail(new Error('Zeitüberschreitung')), timeout);
        function fail(e) {
          clearTimeout(t);
          delete scripts[src];
          s.remove();
          reject(e);
        }
        s.onload = () => { clearTimeout(t); resolve(); };
        s.onerror = () => fail(new Error('Laden fehlgeschlagen'));
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  let ytPromise = null;
  function loadYouTube() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!ytPromise) {
      ytPromise = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (typeof prev === 'function') { try { prev(); } catch (e) { /* egal */ } }
          resolve();
        };
        loadScript('https://www.youtube.com/iframe_api').catch((e) => {
          ytPromise = null;
          reject(e);
        });
        setTimeout(() => {
          if (!(window.YT && window.YT.Player)) { ytPromise = null; reject(new Error('Zeitüberschreitung')); }
        }, 15000);
      });
    }
    return ytPromise;
  }

  const now = () => performance.now();

  class Base {
    constructor(item, host, opts, emit) {
      this.item = item;
      this.opts = opts;
      this.emit = (type, data) => { if (!this.dead) emit(type, data); };
      this.ready = false;
      this.playing = false;
      this.buffering = false;
      this.started = false;
      this.dead = false;
      this.dur = item.duration || 0;
      this.vol = opts.volume == null ? 80 : opts.volume;
      this.muted = !!opts.muted;
      this.t = opts.start || 0;
      this.tAt = now();
      this.el = document.createElement('div');
      this.el.className = 'mount mount-' + item.provider + (item.kind === 'audio' ? ' mount-audio' : '');
      host.appendChild(this.el);
    }
    // für Player, deren Position nur per Ereignis kommt
    setT(t) { this.t = t; this.tAt = now(); }
    getTime() {
      return this.playing && !this.buffering ? this.t + (now() - this.tAt) / 1000 : this.t;
    }
    getDuration() { return this.dur || this.item.duration || 0; }
    isPlaying() { return this.playing; }
    setVolume(v, muted) { this.vol = v; this.muted = muted; this.applyVol(); }
    applyVol() {}
    _ready() {
      if (this.ready || this.dead) return;
      this.ready = true;
      this.emit('ready');
    }
    _play() {
      this.buffering = false;
      this.started = true;
      this.tAt = now();
      if (!this.playing) { this.playing = true; this.emit('play'); }
    }
    _pause() {
      if (this.playing) { this.playing = false; this.emit('pause'); }
    }
    nearEnd(t) {
      const d = this.getDuration();
      return d > 0 && t >= d - 1.2;
    }
    destroy() {
      this.dead = true;
      this.el.remove();
    }
  }

  // ---------------- YouTube ----------------
  const YT_ERRORS = {
    2: 'Ungültige Video-ID.',
    5: 'Das Video lässt sich in diesem Browser nicht abspielen.',
    100: 'Video nicht gefunden – gelöscht oder privat.',
    101: 'Der Uploader erlaubt das Abspielen auf anderen Seiten nicht.',
    150: 'Der Uploader erlaubt das Abspielen auf anderen Seiten nicht.',
    153: 'YouTube hat den Player abgelehnt.'
  };

  class YouTube extends Base {
    constructor(...a) {
      super(...a);
      const div = document.createElement('div');
      this.el.appendChild(div);
      this.wantPlay = !!this.opts.autoplay;
      this.cuedAt = this.opts.start || 0;
      loadYouTube().then(() => {
        if (this.dead) return;
        this.p = new window.YT.Player(div, {
          videoId: this.item.id,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: this.opts.autoplay ? 1 : 0,
            start: Math.floor(this.opts.start || 0),
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
            enablejsapi: 1,
            origin: location.origin
          },
          events: {
            onReady: () => {
              this.applyVol();
              this.dur = this.p.getDuration() || this.dur;
              const d = this.p.getVideoData ? this.p.getVideoData() : null;
              this.emit('meta', { duration: this.dur, title: d && d.title, author: d && d.author });
              this._ready();
            },
            onStateChange: (e) => this.onState(e.data),
            onError: (e) => this.emit('error', { msg: YT_ERRORS[e.data] || 'YouTube-Fehler ' + e.data + '.', code: e.data }),
            onAutoplayBlocked: () => this.emit('blocked')
          }
        });
      }).catch(() => this.emit('error', {
        msg: 'Der YouTube-Player lädt nicht. Prüf deine Verbindung oder ob ein Werbeblocker youtube.com sperrt.'
      }));
    }
    onState(s) {
      if (s === 1) {
        this._play();
        const d = this.p.getDuration();
        if (d && Math.abs(d - this.dur) > 1) { this.dur = d; this.emit('meta', { duration: d }); }
      } else if (s === 2) {
        this.buffering = false;
        this._pause();
      } else if (s === 3) {
        this.buffering = true;
      } else if (s === 0) {
        this.playing = false;
        this.buffering = false;
        this.emit('ended');
      }
    }
    getTime() {
      if (!this.started) return this.cuedAt;
      try { return this.p.getCurrentTime() || 0; } catch (e) { return 0; }
    }
    getDuration() {
      try { return (this.p && this.p.getDuration && this.p.getDuration()) || this.dur; } catch (e) { return this.dur; }
    }
    isPlaying() { return this.playing; }
    play() {
      this.wantPlay = true;
      try { this.p.playVideo(); } catch (e) { /* noch nicht bereit */ }
    }
    pause() {
      this.wantPlay = false;
      try { this.p.pauseVideo(); } catch (e) { /* noch nicht bereit */ }
    }
    seek(t) {
      if (!this.p || !this.p.seekTo) return;
      // Ein noch nie gestartetes Video würde durch seekTo losspielen – stattdessen neu „cuen“
      if (!this.started && !this.wantPlay) {
        this.cuedAt = t;
        try { this.p.cueVideoById({ videoId: this.item.id, startSeconds: t }); } catch (e) { /* egal */ }
        return;
      }
      try { this.p.seekTo(t, true); } catch (e) { /* egal */ }
    }
    applyVol() {
      if (!this.p || !this.p.setVolume) return;
      try {
        this.p.setVolume(this.vol);
        if (this.muted) this.p.mute(); else this.p.unMute();
      } catch (e) { /* egal */ }
    }
    destroy() {
      try { if (this.p && this.p.destroy) this.p.destroy(); } catch (e) { /* egal */ }
      super.destroy();
    }
  }

  // ---------------- SoundCloud ----------------
  class SoundCloud extends Base {
    constructor(...a) {
      super(...a);
      this.isSet = this.item.kind === 'set';
      const f = document.createElement('iframe');
      f.allow = 'autoplay; encrypted-media';
      f.title = 'SoundCloud-Player';
      f.setAttribute('frameborder', '0');
      f.setAttribute('scrolling', 'no');
      const q = new URLSearchParams({
        url: this.item.url,
        auto_play: this.opts.autoplay ? 'true' : 'false',
        visual: 'true',
        hide_related: 'true',
        show_comments: 'false',
        show_reposts: 'false',
        show_teaser: 'false',
        show_user: 'true',
        buying: 'false',
        sharing: 'false',
        download: 'false',
        color: '#ffb547'
      });
      f.src = 'https://w.soundcloud.com/player/?' + q.toString();
      this.el.appendChild(f);
      loadScript('https://w.soundcloud.com/player/api.js').then(() => {
        if (this.dead) return;
        const W = window.SC.Widget;
        const E = W.Events;
        const w = this.w = W(f);
        w.bind(E.READY, () => {
          this.applyVol();
          w.getCurrentSound((s) => {
            if (!s) return;
            this.dur = (s.full_duration || s.duration || 0) / 1000;
            this.emit('meta', {
              duration: this.isSet ? 0 : this.dur,
              title: this.isSet ? null : s.title,
              author: s.user && s.user.username,
              thumb: (s.artwork_url || '').replace('-large.', '-t300x300.')
            });
          });
          if ((this.opts.start || 0) > 1 && !this.isSet) w.seekTo(this.opts.start * 1000);
          this._ready();
        });
        w.bind(E.PLAY, () => this._play());
        w.bind(E.PAUSE, (e) => {
          if (e && e.currentPosition != null) this.setT(e.currentPosition / 1000);
          if (this.nearEnd(this.t)) return; // Ende, keine echte Pause
          this._pause();
        });
        w.bind(E.FINISH, () => {
          this.playing = false;
          if (!this.isSet) return this.emit('ended');
          w.getCurrentSoundIndex((i) => w.getSounds((ss) => {
            if (!ss || i >= ss.length - 1) this.emit('ended');
          }));
        });
        w.bind(E.PLAY_PROGRESS, (e) => this.setT(e.currentPosition / 1000));
        w.bind(E.SEEK, (e) => this.setT(e.currentPosition / 1000));
        w.bind(E.ERROR, () => this.emit('error', { msg: 'SoundCloud kann diesen Titel nicht abspielen (privat, gelöscht oder gesperrt).' }));
      }).catch(() => this.emit('error', { msg: 'Der SoundCloud-Player lädt nicht. Prüf deine Verbindung oder den Werbeblocker.' }));
    }
    get noSync() { return this.isSet; }
    play() { if (this.w) this.w.play(); }
    pause() { if (this.w) this.w.pause(); }
    seek(t) {
      if (!this.w || this.isSet) return;
      this.setT(t);
      this.w.seekTo(t * 1000);
    }
    applyVol() { if (this.w) this.w.setVolume(this.muted ? 0 : this.vol); }
    destroy() {
      try { if (this.w) this.w.unbind(window.SC.Widget.Events.PLAY_PROGRESS); } catch (e) { /* egal */ }
      super.destroy();
    }
  }

  // ---------------- Vimeo ----------------
  class Vimeo extends Base {
    constructor(...a) {
      super(...a);
      loadScript('https://player.vimeo.com/api/player.js').then(() => {
        if (this.dead) return;
        const p = this.p = new window.Vimeo.Player(this.el, {
          url: this.item.url,
          autoplay: !!this.opts.autoplay,
          playsinline: true,
          dnt: true,
          byline: false,
          portrait: false,
          color: 'ffb547'
        });
        p.ready().then(() => {
          const f = this.el.querySelector('iframe');
          if (f) { f.removeAttribute('width'); f.removeAttribute('height'); }
          this.applyVol();
          if ((this.opts.start || 0) > 1) p.setCurrentTime(this.opts.start).catch(() => {});
          Promise.all([p.getDuration(), p.getVideoTitle().catch(() => null)]).then(([d, title]) => {
            this.dur = d;
            this.emit('meta', { duration: d, title });
          }).catch(() => {});
          this._ready();
        }).catch(() => this.emit('error', { msg: 'Vimeo erlaubt dieses Video nicht (privat oder Einbetten gesperrt).' }));
        p.on('play', () => this._play());
        p.on('pause', (d) => {
          if (d && d.seconds != null) this.setT(d.seconds);
          if (this.nearEnd(this.t)) return;
          this._pause();
        });
        p.on('ended', () => { this.playing = false; this.emit('ended'); });
        p.on('timeupdate', (d) => this.setT(d.seconds));
        p.on('seeked', (d) => this.setT(d.seconds));
        p.on('bufferstart', () => { this.buffering = true; });
        p.on('bufferend', () => { this.buffering = false; this.tAt = now(); });
        p.on('error', (e) => {
          if (e && e.name === 'NotAllowedError') this.emit('blocked');
        });
      }).catch(() => this.emit('error', { msg: 'Der Vimeo-Player lädt nicht. Prüf deine Verbindung.' }));
    }
    play() {
      if (!this.p) return;
      this.p.play().catch((e) => { if (e && e.name === 'NotAllowedError') this.emit('blocked'); });
    }
    pause() { if (this.p) this.p.pause().catch(() => {}); }
    seek(t) {
      if (!this.p) return;
      this.setT(t);
      this.p.setCurrentTime(t).catch(() => {});
    }
    applyVol() {
      if (!this.p) return;
      this.p.setVolume(this.muted ? 0 : this.vol / 100).catch(() => {});
    }
    destroy() {
      try { if (this.p) this.p.destroy(); } catch (e) { /* egal */ }
      super.destroy();
    }
  }

  // ---------------- Twitch ----------------
  function twitchTime(s) {
    s = Math.floor(s);
    return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm' + (s % 60) + 's';
  }

  class Twitch extends Base {
    constructor(...a) {
      super(...a);
      this.el.id = 'tw-' + Math.random().toString(36).slice(2);
      loadScript('https://player.twitch.tv/js/embed/v1.js').then(() => {
        if (this.dead) return;
        const T = window.Twitch.Player;
        const o = {
          width: '100%',
          height: '100%',
          parent: [location.hostname],
          autoplay: !!this.opts.autoplay,
          muted: false
        };
        if (this.item.kind === 'live') o.channel = this.item.id;
        else {
          o.video = this.item.id;
          if ((this.opts.start || 0) > 1) o.time = twitchTime(this.opts.start);
        }
        const p = this.p = new T(this.el.id, o);
        p.addEventListener(T.READY, () => {
          this.applyVol();
          try { this.dur = p.getDuration() || 0; } catch (e) { /* egal */ }
          this._ready();
        });
        p.addEventListener(T.PLAY, () => this._play());
        p.addEventListener(T.PAUSE, () => this._pause());
        p.addEventListener(T.ENDED, () => { this.playing = false; this.emit('ended'); });
        p.addEventListener(T.OFFLINE, () => this.emit('error', { msg: 'Dieser Twitch-Kanal ist gerade offline.' }));
      }).catch(() => this.emit('error', { msg: 'Der Twitch-Player lädt nicht. Prüf deine Verbindung.' }));
    }
    get noSync() { return this.item.kind === 'live'; }
    getTime() { try { return this.p ? this.p.getCurrentTime() || 0 : 0; } catch (e) { return 0; } }
    getDuration() { try { return (this.p && this.p.getDuration()) || this.dur; } catch (e) { return this.dur; } }
    play() { try { if (this.p) this.p.play(); } catch (e) { /* egal */ } }
    pause() { try { if (this.p) this.p.pause(); } catch (e) { /* egal */ } }
    seek(t) { try { if (this.p && !this.noSync) this.p.seek(t); } catch (e) { /* egal */ } }
    applyVol() {
      if (!this.p) return;
      try { this.p.setVolume(this.vol / 100); this.p.setMuted(this.muted); } catch (e) { /* egal */ }
    }
  }

  // ---------------- Direkte Dateien (mp4, mp3, m3u8 …) ----------------
  class FileMedia extends Base {
    constructor(...a) {
      super(...a);
      const audio = this.item.kind === 'audio';
      if (audio) {
        const card = document.createElement('div');
        card.className = 'audio-card';
        card.innerHTML = '<svg class="ic"><use href="#i-note"/></svg><span></span>';
        card.querySelector('span').textContent = this.item.title || 'Audio';
        this.el.appendChild(card);
      }
      const v = this.v = document.createElement(audio ? 'audio' : 'video');
      v.controls = true;
      v.preload = 'auto';
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.className = audio ? 'media-audio' : 'media-video';
      this.el.appendChild(v);

      v.addEventListener('loadedmetadata', () => {
        if (isFinite(v.duration)) {
          this.dur = v.duration;
          this.emit('meta', { duration: v.duration });
        }
        if ((this.opts.start || 0) > 0.5) v.currentTime = this.opts.start;
        this.applyVol();
        this._ready();
      });
      v.addEventListener('play', () => this._play());
      v.addEventListener('playing', () => { this.buffering = false; });
      v.addEventListener('waiting', () => { this.buffering = true; });
      v.addEventListener('pause', () => {
        if (v.ended || this.nearEnd(v.currentTime)) return;
        this._pause();
      });
      v.addEventListener('ended', () => { this.playing = false; this.emit('ended'); });
      v.addEventListener('error', () => {
        if (this.dead) return;
        this.emit('error', { msg: 'Die Datei lässt sich nicht abspielen (falsches Format, nicht erreichbar oder gesperrt).' });
      });

      if (this.item.hls && !v.canPlayType('application/vnd.apple.mpegurl')) {
        loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => {
          if (this.dead) return;
          if (!window.Hls || !window.Hls.isSupported()) {
            this.emit('error', { msg: 'Dieser Browser kann den Stream nicht abspielen.' });
            return;
          }
          this.hls = new window.Hls();
          this.hls.loadSource(this.item.url);
          this.hls.attachMedia(v);
        }).catch(() => this.emit('error', { msg: 'Der Stream-Player lädt nicht.' }));
      } else {
        v.src = this.item.url;
      }
    }
    getTime() { return this.v.currentTime || 0; }
    getDuration() { return isFinite(this.v.duration) ? this.v.duration : this.dur; }
    isPlaying() { return !this.v.paused && !this.v.ended; }
    play() {
      const r = this.v.play();
      if (r && r.catch) r.catch((e) => { if (e && e.name === 'NotAllowedError') this.emit('blocked'); });
    }
    pause() { this.v.pause(); }
    seek(t) { try { this.v.currentTime = t; } catch (e) { /* egal */ } }
    applyVol() { this.v.volume = this.vol / 100; this.v.muted = this.muted; }
    destroy() {
      try {
        if (this.hls) this.hls.destroy();
        this.v.pause();
        this.v.removeAttribute('src');
        this.v.load();
      } catch (e) { /* egal */ }
      super.destroy();
    }
  }

  const TYPES = { youtube: YouTube, soundcloud: SoundCloud, vimeo: Vimeo, twitch: Twitch, file: FileMedia };

  window.Players = {
    create(item, host, opts, emit) {
      const C = TYPES[item.provider];
      if (!C) throw new Error('Unbekannter Anbieter ' + item.provider);
      return new C(item, host, opts, emit);
    }
  };
})();
