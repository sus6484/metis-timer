/**
 * Metis 타이머 효과음 — Web Audio 우선, 실패 시 짧은 CC 라이선스 샘플 URL 재생 시도.
 */
(function (global) {
  "use strict";

  var audioCtx = null;
  var masterVolume = 1;

  /** Web Audio 불가 시 로컬 MP3 재생 (프로젝트 audio/ 폴더, Mixkit 프리뷰 기반) */
  var FALLBACK = {
    tick: "audio/tick.mp3",
    fanfare: "audio/fanfare.mp3",
    bell: "audio/bell.mp3",
  };

  function ensureCtx() {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  function unlock() {
    var ctx = ensureCtx();
    if (!ctx) return;
    try {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 440;
      g.gain.value = 0.00001;
      o.connect(g);
      g.connect(ctx.destination);
      var t0 = ctx.currentTime;
      o.start(t0);
      o.stop(t0 + 0.01);
    } catch (e) {}
  }

  function playUrlOnce(url, vol) {
    if (!url) return;
    try {
      var a = new Audio(url);
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

  function setMasterVolume(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return masterVolume;
    masterVolume = Math.max(0, Math.min(1, n));
    return masterVolume;
  }

  function getMasterVolume() {
    return masterVolume;
  }

  /** 예비 카운트 띵 (짧은 고음) */
  function playTick() {
    var ctx = ensureCtx();
    if (!ctx || ctx.state !== "running") {
      playUrlOnce(FALLBACK.tick, 0.62);
      return;
    }
    try {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 1046;
      o.connect(g);
      g.connect(ctx.destination);
      var t0 = ctx.currentTime;
      envelopeGain(g, t0, 0.26, 0.11);
      o.start(t0);
      o.stop(t0 + 0.12);
    } catch (e) {
      playUrlOnce(FALLBACK.tick, 0.62);
    }
  }

  /** GAME START — 코러스 + 노이즈 스웰 */
  function playGameStart() {
    var ctx = ensureCtx();
    if (!ctx || ctx.state !== "running") {
      playUrlOnce(FALLBACK.fanfare, 0.65);
      return;
    }
    try {
      var t0 = ctx.currentTime;
      var freqs = [659, 880, 1174];
      for (var i = 0; i < freqs.length; i++) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "sawtooth";
        o.frequency.value = freqs[i];
        o.connect(g);
        g.connect(ctx.destination);
        var delay = i * 0.06;
        envelopeGain(g, t0 + delay, 0.24, 0.5);
        o.start(t0 + delay);
        o.stop(t0 + delay + 0.52);
      }
      var dur = 0.72;
      var buflen = ctx.sampleRate * dur;
      var buf = ctx.createBuffer(1, buflen, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var j = 0; j < buflen; j++) {
        data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / buflen, 2);
      }
      var noise = ctx.createBufferSource();
      noise.buffer = buf;
      var ng = ctx.createGain();
      noise.connect(ng);
      ng.connect(ctx.destination);
      envelopeGain(ng, t0 + 0.02, 0.11, dur);
      noise.start(t0);
      noise.stop(t0 + dur);
    } catch (e) {
      playUrlOnce(FALLBACK.fanfare, 0.65);
    }
  }

  /** 레벨 전환 벨 */
  function playDoorong() {
    var ctx = ensureCtx();
    if (!ctx || ctx.state !== "running") {
      playUrlOnce(FALLBACK.bell, 0.82);
      return;
    }
    try {
      function bell(freq, start) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        envelopeGain(g, start, 0.34, 0.62);
        o.start(start);
        o.stop(start + 0.66);
      }
      var t0 = ctx.currentTime;
      bell(784, t0);
      bell(988, t0 + 0.14);
    } catch (e) {
      playUrlOnce(FALLBACK.bell, 0.82);
    }
  }

  /** "Next Level, Blinds Up" */
  function speakNextLevelBlindsUp() {
    if (global.speechSynthesis) {
      try {
        global.speechSynthesis.cancel();
        var u = new global.SpeechSynthesisUtterance("Next Level. Blinds Up.");
        u.lang = "en-US";
        u.rate = 0.9;
        u.volume = Math.max(0, Math.min(1, 0.82 * masterVolume));
        global.speechSynthesis.speak(u);
      } catch (e) {}
    }
  }

  /** "Break Time" */
  function speakBreakTime() {
    if (global.speechSynthesis) {
      try {
        global.speechSynthesis.cancel();
        var u = new global.SpeechSynthesisUtterance("Break Time.");
        u.lang = "en-US";
        u.rate = 0.9;
        u.volume = Math.max(0, Math.min(1, 0.82 * masterVolume));
        global.speechSynthesis.speak(u);
      } catch (e) {}
    }
  }

  /** "Game Start" */
  function speakGameStart() {
    if (global.speechSynthesis) {
      try {
        global.speechSynthesis.cancel();
        var u = new global.SpeechSynthesisUtterance("Game Start.");
        u.lang = "en-US";
        u.rate = 0.9;
        u.volume = Math.max(0, Math.min(1, 0.82 * masterVolume));
        global.speechSynthesis.speak(u);
      } catch (e) {}
    }
  }

  global.MetisAudio = {
    ensureCtx: ensureCtx,
    unlock: unlock,
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
