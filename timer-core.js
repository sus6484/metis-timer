/**
 * Metis 타이머 — 공통 상태/엔진 (localStorage + 탭 간 동기화)
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "metis_timer_sync";
  var HEARTBEAT_KEY = "metis_timer_window_alive";
  var HEARTBEAT_MS = 400;
  var WINDOW_STALE_MS = 1400;

  var bc =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("metis-timer")
      : null;

  function defaultTimer() {
    return {
      isRunning: false,
      levelIndex: 0,
      endAt: null,
      pausedRemainingSec: 0,
    };
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function getActiveLevels(state) {
    if (!state || !state.presets || !state.activePresetId) return null;
    var p = state.presets.filter(function (x) {
      return x.id === state.activePresetId;
    })[0];
    if (!p || !Array.isArray(p.levels) || !p.levels.length) return null;
    return p.levels;
  }

  function levelDurationSec(level) {
    var m = Number(level && level.minutes);
    if (!Number.isFinite(m) || m <= 0) m = 20;
    return Math.max(1, Math.round(m * 60));
  }

  function formatMMSS(totalSec) {
    var s = Math.max(0, Math.floor(totalSec));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }

  function normalizeTimer(t, state) {
    var d = defaultTimer();
    if (!t || typeof t !== "object") t = {};
    var out = {
      isRunning: !!t.isRunning,
      levelIndex: clamp(
        parseInt(t.levelIndex, 10) || 0,
        0,
        Math.pow(2, 20)
      ),
      endAt: t.endAt == null ? null : Number(t.endAt),
      pausedRemainingSec: Math.max(
        0,
        Number(t.pausedRemainingSec) || 0
      ),
    };
    var levels = getActiveLevels(state);
    var maxI = levels ? levels.length - 1 : 0;
    out.levelIndex = clamp(out.levelIndex, 0, Math.max(0, maxI));
    if (!Number.isFinite(out.endAt)) out.endAt = null;
    return out;
  }

  function readSyncState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var state = JSON.parse(raw);
      state.timer = normalizeTimer(state.timer, state);
      syncLevelField(state);
      return state;
    } catch (e) {
      return null;
    }
  }

  var REMOTE_KEYS = [
    "tournamentName",
    "timerStatus",
    "displayTime",
    "totalChips",
    "avgStack",
    "player",
    "entry",
    "rebuy",
    "addon",
    "early",
    "level",
    "entryChips",
    "earlyChips",
    "regCloseLevel",
    "rebuyChips",
    "addonChips",
  ];

  function pickRemoteSlice(state) {
    var out = {};
    if (!state) return out;
    for (var i = 0; i < REMOTE_KEYS.length; i++) {
      var k = REMOTE_KEYS[i];
      if (state[k] !== undefined) out[k] = state[k];
    }
    return out;
  }

  function mirrorRemoteStorage(state) {
    try {
      localStorage.setItem(
        "metis_remoteState",
        JSON.stringify(pickRemoteSlice(state))
      );
    } catch (e) {}
  }

  function writeSyncState(state) {
    state.updatedAt = Date.now();
    var str = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, str);
    mirrorRemoteStorage(state);
    if (bc) {
      try {
        bc.postMessage({ type: "sync", t: state.updatedAt });
      } catch (e) {}
    }
  }

  function remainingSec(state, now) {
    var t = state.timer;
    if (!t) return 0;
    if (t.isRunning && t.endAt != null) {
      return Math.max(0, Math.ceil((t.endAt - now) / 1000));
    }
    return Math.max(0, Math.floor(t.pausedRemainingSec || 0));
  }

  function syncLevelField(state) {
    var t = state.timer;
    var levels = getActiveLevels(state);
    if (!levels || !levels.length) {
      state.level = 1;
      return;
    }
    t.levelIndex = clamp(t.levelIndex, 0, levels.length - 1);
    state.level = t.levelIndex + 1;
  }

  function applyRestart(state, now) {
    var levels = getActiveLevels(state);
    if (!levels || !levels.length) {
      state.timerStatus = "프리셋 없음";
      return state;
    }
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    syncLevelField(state);
    var dur = levelDurationSec(levels[t.levelIndex]);
    t.isRunning = true;
    t.endAt = now + dur * 1000;
    t.pausedRemainingSec = dur;
    state.timerStatus = "진행중";
    state.displayTime = formatMMSS(dur);
    return state;
  }

  function applyPause(state, now) {
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    var rem = remainingSec({ timer: t }, now);
    if (t.isRunning && t.endAt != null) {
      rem = Math.max(0, Math.ceil((t.endAt - now) / 1000));
    }
    t.pausedRemainingSec = rem;
    t.isRunning = false;
    t.endAt = null;
    state.timerStatus = "정지";
    state.displayTime = formatMMSS(rem);
    return state;
  }

  /**
   * 레벨 시간 종료 시 다음 레벨로. canOwn true일 때만 상태 변경.
   * @returns {{ state: object, advanced: boolean, finished: boolean, leveledUp: boolean }}
   */
  function tickExpire(state, now, canOwn) {
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    var levels = getActiveLevels(state);
    if (!canOwn || !levels || !levels.length) {
      syncLevelField(state);
      state.displayTime = formatMMSS(remainingSec(state, now));
      return { state: state, advanced: false, finished: false, leveledUp: false };
    }
    if (!t.isRunning || t.endAt == null || now < t.endAt) {
      syncLevelField(state);
      state.displayTime = formatMMSS(remainingSec(state, now));
      return { state: state, advanced: false, finished: false, leveledUp: false };
    }

    var idx = clamp(t.levelIndex, 0, levels.length - 1);
    var nextIdx = idx + 1;
    if (nextIdx >= levels.length) {
      t.isRunning = false;
      t.endAt = null;
      t.pausedRemainingSec = 0;
      t.levelIndex = idx;
      syncLevelField(state);
      state.timerStatus = "종료";
      state.displayTime = "00:00";
      return { state: state, advanced: true, finished: true, leveledUp: false };
    }

    t.levelIndex = nextIdx;
    var dur = levelDurationSec(levels[nextIdx]);
    t.isRunning = true;
    t.endAt = now + dur * 1000;
    t.pausedRemainingSec = dur;
    syncLevelField(state);
    state.timerStatus = "진행중";
    state.displayTime = formatMMSS(dur);
    return { state: state, advanced: true, finished: false, leveledUp: true };
  }

  function isTimerWindowLikelyOpen(now) {
    var v = Number(localStorage.getItem(HEARTBEAT_KEY) || 0);
    if (!Number.isFinite(v)) return false;
    return now - v < WINDOW_STALE_MS;
  }

  function shouldOwnEngine(now) {
    if (global.__METIS_IS_TIMER_PAGE) return true;
    return !isTimerWindowLikelyOpen(now);
  }

  function touchTimerWindowHeartbeat() {
    try {
      localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
    } catch (e) {}
  }

  var audioCtx = null;
  function playLevelBeep() {
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(function () {});
      }
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      o.connect(g);
      g.connect(audioCtx.destination);
      var t0 = audioCtx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      o.start(t0);
      o.stop(t0 + 0.13);
    } catch (e) {}
  }

  function subscribeSync(cb) {
    if (!bc) return function () {};
    var fn = function (ev) {
      if (ev && ev.data && ev.data.type === "sync") cb();
    };
    bc.addEventListener("message", fn);
    return function () {
      bc.removeEventListener("message", fn);
    };
  }

  /**
   * 한 스텝: 만료 시 다음 레벨 반영 후 저장. UI는 remainingSec / state 로 갱신.
   */
  function engineStep() {
    var s = readSyncState();
    if (!s) return null;
    var now = Date.now();
    var canOwn = shouldOwnEngine(now);
    var res = tickExpire(s, now, canOwn);
    if (res.advanced) {
      writeSyncState(res.state);
      if (res.leveledUp) playLevelBeep();
    }
    var live = res.state;
    var rem = remainingSec(live, now);
    return {
      state: live,
      advanced: !!res.advanced,
      leveledUp: !!res.leveledUp,
      finished: !!res.finished,
      rem: rem,
      now: now,
    };
  }

  global.MetisTimer = {
    STORAGE_KEY: STORAGE_KEY,
    HEARTBEAT_KEY: HEARTBEAT_KEY,
    HEARTBEAT_MS: HEARTBEAT_MS,
    readSyncState: readSyncState,
    writeSyncState: writeSyncState,
    defaultTimer: defaultTimer,
    getActiveLevels: getActiveLevels,
    levelDurationSec: levelDurationSec,
    formatMMSS: formatMMSS,
    remainingSec: remainingSec,
    applyRestart: applyRestart,
    applyPause: applyPause,
    tickExpire: tickExpire,
    shouldOwnEngine: shouldOwnEngine,
    isTimerWindowLikelyOpen: isTimerWindowLikelyOpen,
    touchTimerWindowHeartbeat: touchTimerWindowHeartbeat,
    playLevelBeep: playLevelBeep,
    subscribeSync: subscribeSync,
    syncLevelField: syncLevelField,
    normalizeTimer: normalizeTimer,
    engineStep: engineStep,
    pickRemoteSlice: pickRemoteSlice,
  };
})(typeof window !== "undefined" ? window : this);
