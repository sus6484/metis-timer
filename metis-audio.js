/**
 * Metis 타이머 효과음 — Web Audio + MP3 fallback, 브라우저 autoplay 정책 대응
 */
(function (global) {
  "use strict";

  var audioCtx = null;
  var masterGain = null;
  var masterVolume = 1;
  var MIN_MASTER_VOLUME = 0.35;
  var DEFAULT_MASTER_VOLUME = 1;
  var unlocked = false;
  var preloadDone = false;

  var FALLBACK = {
    tick: "audio/tick.mp3",
    fanfare: "audio/fanfare.mp3",
    bell: "audio/bell.mp3",
  };

  var fallbackCache = {};

  function ensureCtx() {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) {
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = masterVolume;
      masterGain.connect(audioCtx.destination);
    }
    if (masterGain) masterGain.gain.value = masterVolume;
    return audioCtx;
  }

  function resumeCtx() {
    var ctx = ensureCtx();
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === "running") return Promise.resolve(true);
    return ctx.resume().then(function () {
      return ctx.state === "running";
    }).catch(function () {
      return false;
    });
  }

  function preloadFallbacks() {
    if (preloadDone) return;
    preloadDone = true;
    var keys = Object.keys(FALLBACK);
    for (var i = 0; i < keys.length; i++) {
      (function (key) {
        try {
          var a = new Audio(FALLBACK[key]);
          a.preload = "auto";
          a.load();
          fallbackCache[key] = a;
        } catch (e) {}
      })(keys[i]);
    }
  }

  function unlock() {
    preloadFallbacks();
    var ctx = ensureCtx();
    if (!ctx) return;
    unlocked = true;
    try {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 440;
      g.gain.value = 0.00001;
      o.connect(g);
      g.connect(masterGain || ctx.destination);
      var t0 = ctx.currentTime;
      o.start(t0);
      o.stop(t0 + 0.01);
    } catch (e) {}
    resumeCtx();
  }

  function playUrlOnce(url, vol) {
    if (!url) return;
    try {
      var a;
      var cacheKey = null;
      var keys = Object.keys(FALLBACK);
      for (var i = 0; i < keys.length; i++) {
        if (FALLBACK[keys[i]] === url) {
          cacheKey = keys[i];
          break;
        }
      }
      if (cacheKey && fallbackCache[cacheKey]) {
        a = fallbackCache[cacheKey].cloneNode
          ? fallbackCache[cacheKey].cloneNode()
          : new Audio(url);
      } else {
        a = new Audio(url);
      }
      a.volume = Math.max(0, Math.min(1, (vol == null ? 0.55 : vol) * masterVolume));
      var p = a.play();
      if (p && typeof p.then === "function") p.catch(function () {});
    } catch (e) {}
  }

  function envelopeGain(g, t0, peak, dur) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * masterVolume),
      t0 + Math.min(0.03, dur * 0.15)
    );
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  function withAudio(webFn, fallbackKey, fallbackVol) {
    unlock();
    var url = FALLBACK[fallbackKey];
    var vol = fallbackVol == null ? 0.62 : fallbackVol;
    resumeCtx().then(function (running) {
      if (running) {
        try {
          webFn(ensureCtx());
          return;
        } catch (e) {}
      }
      playUrlOnce(url, vol);
    });
  }

  function setMasterVolume(v) {
    var n = Number(v);
    if (!Number.isFinite(n) || n <= 0) n = DEFAULT_MASTER_VOLUME;
    masterVolume = Math.max(MIN_MASTER_VOLUME, Math.min(1, n));
    if (masterGain) masterGain.gain.value = masterVolume;
    return masterVolume;
  }

  function getMasterVolume() {
    return masterVolume;
  }

  /** 예비 카운트 — 짧고 또렷한 고음 */
  function playTick() {
    withAudio(function (ctx) {
      var dest = masterGain || ctx.destination;
      var t0 = ctx.currentTime;
      var freqs = [880, 1174];
      for (var i = 0; i < freqs.length; i++) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freqs[i];
        o.connect(g);
        g.connect(dest);
        var start = t0 + i * 0.045;
        envelopeGain(g, start, 0.28, 0.09);
        o.start(start);
        o.stop(start + 0.1);
      }
    }, "tick", 0.68);
  }

  /** GAME START 팡파레 */
  function playGameStart() {
    withAudio(function (ctx) {
      var dest = masterGain || ctx.destination;
      var t0 = ctx.currentTime;
      var freqs = [523, 659, 784, 1046];
      for (var i = 0; i < freqs.length; i++) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "triangle";
        o.frequency.value = freqs[i];
        o.connect(g);
        g.connect(dest);
        var delay = i * 0.07;
        envelopeGain(g, t0 + delay, 0.22, 0.45);
        o.start(t0 + delay);
        o.stop(t0 + delay + 0.48);
      }
    }, "fanfare", 0.7);
  }

  /** 레벨·전환 벨 (띠리링) */
  function playDoorong() {
    withAudio(function (ctx) {
      var dest = masterGain || ctx.destination;
      function bell(freq, start, peak, dur) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        o.connect(g);
        g.connect(dest);
        envelopeGain(g, start, peak, dur);
        o.start(start);
        o.stop(start + dur + 0.05);
      }
      var t0 = ctx.currentTime;
      bell(659, t0, 0.32, 0.55);
      bell(880, t0 + 0.12, 0.36, 0.62);
      bell(1174, t0 + 0.24, 0.28, 0.72);
    }, "bell", 0.85);
  }

  function speakText(text) {
    if (!global.speechSynthesis) return;
    resumeCtx();
    try {
      var u = new global.SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.92;
      u.pitch = 1.02;
      u.volume = Math.max(0, Math.min(1, 0.88 * masterVolume));
      global.speechSynthesis.speak(u);
    } catch (e) {}
  }

  function speakNextLevelBlindsUp() {
    speakText("Next Level. Blinds Up.");
  }

  function speakBreakTime() {
    speakText("Break Time.");
  }

  function speakGameStart() {
    speakText("Game Start.");
  }

  global.MetisAudio = {
    ensureCtx: ensureCtx,
    unlock: unlock,
    resumeCtx: resumeCtx,
    playTick: playTick,
    playGameStart: playGameStart,
    playDoorong: playDoorong,
    setMasterVolume: setMasterVolume,
    getMasterVolume: getMasterVolume,
    speakNextLevelBlindsUp: speakNextLevelBlindsUp,
    speakBreakTime: speakBreakTime,
    speakGameStart: speakGameStart,
  };
})(typeof window !== "undefined" ? window : this);
