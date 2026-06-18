/**
 * Metis 타이머 — 공통 상태/엔진 (localStorage + 탭 간 동기화)
 */
(function (global) {
  "use strict";

  var LEGACY_SYNC_KEY = "metis_timer_sync";
  var HEARTBEAT_KEY = "metis_timer_window_alive";
  var HEARTBEAT_MS = 400;
  var WINDOW_STALE_MS = 1400;

  var syncPresetId =
    global.__METIS_TIMER_PRESET_ID != null && global.__METIS_TIMER_PRESET_ID !== ""
      ? String(global.__METIS_TIMER_PRESET_ID)
      : "";

  var bc = null;

  function getSyncStorageKey() {
    return syncPresetId ? "timer_state_" + syncPresetId : LEGACY_SYNC_KEY;
  }

  function getHeartbeatStorageKey() {
    return syncPresetId ? "metis_timer_window_alive_" + syncPresetId : HEARTBEAT_KEY;
  }

  function reconnectBroadcastChannel() {
    if (typeof BroadcastChannel === "undefined") {
      bc = null;
      return;
    }
    try {
      if (bc && bc.close) bc.close();
    } catch (e1) {}
    try {
      bc = new BroadcastChannel("metis-timer-" + (syncPresetId || "legacy"));
    } catch (e2) {
      bc = null;
    }
  }

  function setSyncPresetId(id) {
    syncPresetId = id != null && id !== "" ? String(id) : "";
    reconnectBroadcastChannel();
  }

  function getSyncPresetId() {
    return syncPresetId;
  }

  var PRESETS_STORAGE_KEY = "metis_blindPresets";

  var PRESET_EMBED_KEYS = [
    "tournamentName",
    "totalPrizeText",
    "tournamentInfo",
    "prizeText",
    "prizeItems",
    "player",
    "entry",
    "entryChips",
    "regCloseLevel",
    "infoFontScale",
    "prizeFontScale",
    "leftPanelRotate",
    "leftFontScale",
  ];

  /** 구글 시트·프리셋에 저장되는 정적 메타데이터 (인원 등 실시간 값 제외) */
  var PRESET_METADATA_ONLY_KEYS = [
    "tournamentName",
    "totalPrizeText",
    "tournamentInfo",
    "prizeText",
    "prizeItems",
    "infoFontScale",
    "prizeFontScale",
    "leftPanelRotate",
  ];

  function isPresetMetadataEmpty(key, val) {
    if (val === undefined || val === null) return true;
    if (key === "prizeItems") return !Array.isArray(val) || val.length === 0;
    if (typeof val === "string") return !val.trim();
    return false;
  }

  function copyMetadataValue(key, val) {
    if (key === "prizeItems" && Array.isArray(val)) return val.slice();
    return val;
  }

  function mergeMetadataFieldsPreferNonEmpty(target, source) {
    if (!target || !source) return target;
    for (var i = 0; i < PRESET_METADATA_ONLY_KEYS.length; i++) {
      var k = PRESET_METADATA_ONLY_KEYS[i];
      if (source[k] === undefined || isPresetMetadataEmpty(k, source[k])) continue;
      target[k] = copyMetadataValue(k, source[k]);
    }
    return target;
  }

  function mergePresetRecord(localPreset, cloudPreset) {
    var out = Object.assign({}, cloudPreset || {});
    mergeMetadataFieldsPreferNonEmpty(out, localPreset);
    return out;
  }

  function mergePresetLists(localList, cloudList) {
    localList = Array.isArray(localList) ? localList : [];
    cloudList = Array.isArray(cloudList) ? cloudList : [];
    if (!cloudList.length) return localList.length ? localList : cloudList;
    var localById = {};
    localList.forEach(function (p) {
      if (p && p.id) localById[p.id] = p;
    });
    var out = [];
    var seen = {};
    cloudList.forEach(function (cloudP) {
      if (!cloudP || !cloudP.id) return;
      seen[cloudP.id] = true;
      out.push(mergePresetRecord(localById[cloudP.id], cloudP));
    });
    localList.forEach(function (localP) {
      if (!localP || !localP.id || seen[localP.id]) return;
      out.push(localP);
    });
    return out.length ? out : cloudList;
  }

  function loadPresetsFromStorage() {
    try {
      var raw = localStorage.getItem(PRESETS_STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function savePresetsToStorage(presets) {
    try {
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
    } catch (e) {}
  }

  function defaultTournamentFields() {
    return {
      tournamentName: "내 토너먼트",
      prizeText: "",
      prizeItems: [],
      totalPrizeText: "",
      tournamentInfo: "",
      player: 0,
      entry: 0,
      entryChips: 50000,
      regCloseLevel: 15,
      infoFontScale: 1,
      prizeFontScale: 1,
      leftPanelRotate: false,
    };
  }

  function tournamentFieldsFromPreset(p) {
    var d = defaultTournamentFields();
    if (!p || typeof p !== "object") return d;
    for (var i = 0; i < PRESET_EMBED_KEYS.length; i++) {
      var k = PRESET_EMBED_KEYS[i];
      if (p[k] !== undefined) d[k] = p[k];
    }
    return d;
  }

  function mergePresetsIntoState(state) {
    if (!state || typeof state !== "object") return;
    state.presets = loadPresetsFromStorage();
    if (syncPresetId) state.activePresetId = syncPresetId;
  }

  function embedActivePresetTournament(state) {
    if (!state || typeof state !== "object" || !syncPresetId) return;
    var presets = loadPresetsFromStorage();
    var idx = -1;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === syncPresetId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    for (var j = 0; j < PRESET_EMBED_KEYS.length; j++) {
      var key = PRESET_EMBED_KEYS[j];
      if (state[key] !== undefined) presets[idx][key] = state[key];
    }
    savePresetsToStorage(presets);
  }

  function shouldApplyMetadataField(key, presetVal, stateVal) {
    if (key === "prizeItems") {
      var pLen = Array.isArray(presetVal) ? presetVal.length : 0;
      var sLen = Array.isArray(stateVal) ? stateVal.length : 0;
      if (pLen === 0 && sLen > 0) return false;
      if (pLen > 0 && (sLen === 0 || pLen >= sLen)) return true;
      return false;
    }
    if (isPresetMetadataEmpty(key, presetVal)) {
      return isPresetMetadataEmpty(key, stateVal);
    }
    return true;
  }

  /** 프리셋 메타데이터만 timer_state_* 에 병합 (인원 등 실시간 값은 유지) */
  function mergeActivePresetMetadataIntoState(state) {
    var preset = getActivePreset(state);
    if (!state || !preset) return state;
    for (var j = 0; j < PRESET_METADATA_ONLY_KEYS.length; j++) {
      var key = PRESET_METADATA_ONLY_KEYS[j];
      if (preset[key] === undefined) continue;
      if (!shouldApplyMetadataField(key, preset[key], state[key])) continue;
      if (!isPresetMetadataEmpty(key, state[key])) continue;
      state[key] = copyMetadataValue(key, preset[key]);
    }
    return state;
  }

  /** 클라우드 프리셋 → 로컬 timer_state_* (대회정보·상금 등 메타데이터) */
  function copyPresetMetadataIntoState(state, preset) {
    if (!state || !preset) return state;
    for (var j = 0; j < PRESET_EMBED_KEYS.length; j++) {
      var key = PRESET_EMBED_KEYS[j];
      if (preset[key] === undefined) continue;
      var presetVal = preset[key];
      var stateVal = state[key];
      if (PRESET_METADATA_ONLY_KEYS.indexOf(key) >= 0) {
        if (!shouldApplyMetadataField(key, presetVal, stateVal)) continue;
      }
      state[key] = copyMetadataValue(key, presetVal);
    }
    return state;
  }

  /** 활성 프리셋 메타데이터를 타이머 동기화 상태에 즉시 반영 */
  function flushActivePresetMetadataToTimer() {
    var presets = loadPresetsFromStorage();
    var aid = syncPresetId;
    try {
      var storedActive = localStorage.getItem("metis_activePresetId");
      if (storedActive) aid = storedActive;
    } catch (e0) {}
    if (!aid) return false;
    setSyncPresetId(aid);
    var preset = null;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i] && presets[i].id === aid) {
        preset = presets[i];
        break;
      }
    }
    if (!preset) return false;
    var state = null;
    try {
      var raw = localStorage.getItem(getSyncStorageKey());
      if (raw) state = JSON.parse(raw);
    } catch (e1) {}
    if (!state) state = buildInitialTimerState();
    if (!state) return false;
    delete state.rebuy;
    delete state.addon;
    delete state.rebuyChips;
    delete state.addonChips;
    delete state.early;
    delete state.earlyChips;
    mergePresetsIntoState(state);
    copyPresetMetadataIntoState(state, preset);
    state.timer = normalizeTimer(state.timer, state);
    ensureTotalSecondsState(state);
    syncLevelField(state);
    writeSyncState(state);
    return true;
  }

  /** timer_state_* 에만 남아 있는 메타데이터를 프리셋 객체로 복구 */
  function recoverPresetsMetadataFromTimerStates() {
    var presets = loadPresetsFromStorage();
    if (!presets.length) return false;
    var savedSyncId = syncPresetId;
    var changed = false;

    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      if (!p || !p.id) continue;
      setSyncPresetId(p.id);
      try {
        var raw = localStorage.getItem(getSyncStorageKey());
        if (!raw) continue;
        var state = JSON.parse(raw);
        for (var j = 0; j < PRESET_METADATA_ONLY_KEYS.length; j++) {
          var key = PRESET_METADATA_ONLY_KEYS[j];
          if (
            !isPresetMetadataEmpty(key, p[key]) ||
            isPresetMetadataEmpty(key, state[key])
          ) {
            continue;
          }
          p[key] = copyMetadataValue(key, state[key]);
          changed = true;
        }
      } catch (e0) {}
    }

    if (changed) savePresetsToStorage(presets);
    setSyncPresetId(savedSyncId);
    return changed;
  }

  function syncAllPresetsMetadataFromStorage() {
    var presets = loadPresetsFromStorage();
    if (!presets.length) return;
    var savedSyncId = syncPresetId;
    var savedActive = "";
    try {
      savedActive = localStorage.getItem("metis_activePresetId") || "";
    } catch (e0) {}

    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      if (!p || !p.id) continue;
      setSyncPresetId(p.id);
      try {
        var raw = localStorage.getItem(getSyncStorageKey());
        var state = null;
        if (raw) {
          state = JSON.parse(raw);
          delete state.rebuy;
          delete state.addon;
          delete state.rebuyChips;
          delete state.addonChips;
          delete state.early;
          delete state.earlyChips;
          mergePresetsIntoState(state);
          state.timer = normalizeTimer(state.timer, state);
          ensureTotalSecondsState(state);
          syncLevelField(state);
        } else {
          state = buildInitialTimerState();
        }
        if (!state) continue;
        copyPresetMetadataIntoState(state, p);
        state.updatedAt = Date.now();
        localStorage.setItem(getSyncStorageKey(), JSON.stringify(state));
        if (p.id === savedActive || p.id === savedSyncId) {
          mirrorRemoteStorage(state);
        }
      } catch (e1) {}
    }

    setSyncPresetId(savedSyncId || savedActive);
  }

  reconnectBroadcastChannel();

  function defaultTimer() {
    return {
      isRunning: false,
      levelIndex: 0,
      endAt: null,
      pausedRemainingSec: 0,
      bridge: null,
    };
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function getActivePreset(state) {
    if (!state || !state.presets || !state.activePresetId) return null;
    var p = state.presets.filter(function (x) {
      return x.id === state.activePresetId;
    })[0];
    return p || null;
  }

  function getActiveLevels(state) {
    var p = getActivePreset(state);
    if (!p || !Array.isArray(p.levels) || !p.levels.length) return null;
    return p.levels;
  }

  /** 브레이크 구간 (쉬는 시간). type === 'break' 인 행만 브레이크로 처리합니다. */
  function isBreakRow(row) {
    return !!(row && row.type === "break");
  }

  function levelDurationSec(level) {
    var m = Number(level && level.minutes);
    if (!Number.isFinite(m) || m <= 0) m = 20;
    return Math.max(1, Math.round(m * 60));
  }

  function isPlayLevelRunning(state, timerObj) {
    if (!state || !timerObj || !timerObj.isRunning || timerObj.bridge) return false;
    var levels = getActiveLevels(state);
    if (!levels || !levels.length) return false;
    var idx = clamp(parseInt(timerObj.levelIndex, 10) || 0, 0, levels.length - 1);
    return !isBreakRow(levels[idx]);
  }

  function ensureTotalSecondsState(state) {
    if (!state || typeof state !== "object") return;
    if ("totalActiveMs" in state) delete state.totalActiveMs;
    if ("totalActiveAnchorMs" in state) delete state.totalActiveAnchorMs;
    state.totalSeconds = 0;
    state.totalSecondsTickAt = null;
  }

  function syncTotalSeconds(state, now) {
    ensureTotalSecondsState(state);
  }

  function getTotalSeconds(state) {
    ensureTotalSecondsState(state);
    return 0;
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
    var br = t.bridge;
    if (
      br &&
      typeof br === "object" &&
      (br.kind === "preWait" || br.kind === "startGo") &&
      Number.isFinite(Number(br.until))
    ) {
      out.bridge = { kind: br.kind, until: Number(br.until) };
    } else {
      out.bridge = null;
    }
    return out;
  }

  function readSyncState() {
    try {
      var raw = localStorage.getItem(getSyncStorageKey());
      var state = null;
      if (!raw) {
        state = buildInitialTimerState();
        if (!state) return null;
      } else {
        state = JSON.parse(raw);
      }
      delete state.rebuy;
      delete state.addon;
      delete state.rebuyChips;
      delete state.addonChips;
      delete state.early;
      delete state.earlyChips;
      mergePresetsIntoState(state);
      mergeActivePresetMetadataIntoState(state);
      state.timer = normalizeTimer(state.timer, state);
      ensureTotalSecondsState(state);
      syncLevelField(state);
      return state;
    } catch (e) {
      return null;
    }
  }

  var REMOTE_KEYS = [
    "tournamentName",
    "totalPrizeText",
    "tournamentInfo",
    "prizeText",
    "prizeItems",
    "regCloseAt",
    "timerStatus",
    "displayTime",
    "totalChips",
    "avgStack",
    "player",
    "entry",
    "level",
    "entryChips",
    "regCloseLevel",
    "infoFontScale",
    "prizeFontScale",
    "leftFontScale",
  ];

  function pickRemoteSlice(state) {
    var out = {};
    if (!state) return out;
    for (var i = 0; i < REMOTE_KEYS.length; i++) {
      var k = REMOTE_KEYS[i];
      if (state[k] !== undefined) out[k] = state[k];
    }
    if (
      !(out.prizeText && String(out.prizeText).trim()) &&
      state.guaranteedPrize != null
    ) {
      var n = Math.floor(Number(state.guaranteedPrize) || 0);
      if (n > 0) out.prizeText = n.toLocaleString("ko-KR");
    }
    return out;
  }

  /**
   * 클라우드 타이머 동기화용 실시간 필드.
   * 대회명·상금 등 정적 메타데이터(presets)는 제외한다.
   */
  var TIMER_SYNC_KEYS = [
    "activePresetId",
    "timer",
    "player",
    "entry",
    "entryChips",
    "timerStatus",
    "displayTime",
    "level",
    "hasStartedOnce",
    "pendingBridge",
    "regCloseAt",
    "totalScheduleCommittedSec",
    "updatedAt",
  ];

  function copyPendingBridgeForSync(pb) {
    if (!pb || typeof pb !== "object") return null;
    return {
      kind: pb.kind,
      remainingSec: Math.max(0, Math.floor(Number(pb.remainingSec) || 0)),
    };
  }

  /**
   * 전체 sync state에서 클라우드에 올릴 슬라이스만 추출한다.
   * @param {object} state - readSyncState() 결과
   * @param {string} [presetId] - 생략 시 state.activePresetId 사용
   */
  function pickTimerSyncSlice(state, presetId) {
    var out = {};
    if (!state || typeof state !== "object") return out;
    var pid =
      presetId != null && presetId !== ""
        ? String(presetId)
        : state.activePresetId != null
          ? String(state.activePresetId)
          : "";
    if (pid) out.presetId = pid;
    for (var i = 0; i < TIMER_SYNC_KEYS.length; i++) {
      var k = TIMER_SYNC_KEYS[i];
      if (state[k] === undefined) continue;
      if (k === "timer") {
        out.timer = normalizeTimer(state.timer, state);
      } else if (k === "pendingBridge") {
        out.pendingBridge = copyPendingBridgeForSync(state.pendingBridge);
      } else if (k === "hasStartedOnce") {
        out.hasStartedOnce = !!state.hasStartedOnce;
      } else {
        out[k] = state[k];
      }
    }
    var u = Number(out.updatedAt);
    if (!Number.isFinite(u) || u <= 0) out.updatedAt = Date.now();
    return out;
  }

  function timerSyncUpdatedAt(slice) {
    if (!slice) return 0;
    var n = Number(slice.updatedAt);
    return Number.isFinite(n) ? n : 0;
  }

  /** cloudSlice가 localSlice보다 최신이면 true (충돌 해결용) */
  function isTimerSyncSliceNewer(cloudSlice, localSlice) {
    return timerSyncUpdatedAt(cloudSlice) > timerSyncUpdatedAt(localSlice);
  }

  /**
   * 클라우드 슬라이스를 로컬 state에 병합한다. cloud가 더 최신일 때만 적용.
   * @returns {boolean} 변경 여부
   */
  function applyTimerSyncSlice(state, cloudSlice) {
    if (!state || !cloudSlice || typeof cloudSlice !== "object") return false;
    var localSlice = pickTimerSyncSlice(state);
    if (!isTimerSyncSliceNewer(cloudSlice, localSlice)) return false;
    for (var i = 0; i < TIMER_SYNC_KEYS.length; i++) {
      var k = TIMER_SYNC_KEYS[i];
      if (cloudSlice[k] === undefined) continue;
      if (k === "timer") {
        state.timer = normalizeTimer(cloudSlice.timer, state);
      } else if (k === "pendingBridge") {
        state.pendingBridge = copyPendingBridgeForSync(cloudSlice.pendingBridge);
      } else if (k === "activePresetId") {
        state.activePresetId = String(cloudSlice.activePresetId);
      } else if (k === "hasStartedOnce") {
        state.hasStartedOnce = !!cloudSlice.hasStartedOnce;
      } else {
        state[k] = cloudSlice[k];
      }
    }
    if (cloudSlice.presetId && !state.activePresetId) {
      state.activePresetId = String(cloudSlice.presetId);
    }
    syncLevelField(state);
    ensureTotalSecondsState(state);
    state.displayTime = formatMMSS(remainingSec(state, Date.now()));
    return true;
  }

  function mirrorRemoteStorage(state) {
    try {
      localStorage.setItem(
        "metis_remoteState",
        JSON.stringify(pickRemoteSlice(state))
      );
    } catch (e) {}
  }

  function writeSyncState(state, options) {
    options = options || {};
    mergePresetsIntoState(state);
    if (!options.skipPresetEmbed) embedActivePresetTournament(state);
    if (!options.preserveUpdatedAt) state.updatedAt = Date.now();
    var str = JSON.stringify(state);
    localStorage.setItem(getSyncStorageKey(), str);
    mirrorRemoteStorage(state);
    if (bc) {
      try {
        bc.postMessage({ type: "sync", t: state.updatedAt });
      } catch (e) {}
    }
    if (
      !options.skipCloudPush &&
      global.MetisSheetSync &&
      typeof global.MetisSheetSync.saveTimerStateToCloud === "function"
    ) {
      var pushPresetId =
        syncPresetId ||
        (state.activePresetId != null ? String(state.activePresetId) : "");
      if (pushPresetId) {
        global.MetisSheetSync.saveTimerStateToCloud(
          pushPresetId,
          pickTimerSyncSlice(state, pushPresetId)
        );
      }
    }
  }

  function remainingSec(state, now) {
    var t = state.timer;
    if (!t) return 0;
    if (t.bridge && t.bridge.until != null && Number.isFinite(t.bridge.until)) {
      return Math.max(0, Math.floor((t.bridge.until - now) / 1000));
    }
    if (t.isRunning && t.endAt != null && Number.isFinite(t.endAt)) {
      return Math.max(0, Math.floor((t.endAt - now) / 1000));
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

  function buildInitialTimerState() {
    var presets = loadPresetsFromStorage();
    if (!syncPresetId) return null;
    var p = null;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === syncPresetId) {
        p = presets[i];
        break;
      }
    }
    if (!p) return null;
    var tour = tournamentFieldsFromPreset(p);
    var levels = p.levels && p.levels.length ? p.levels : null;
    var dur = levels && levels.length ? levelDurationSec(levels[0]) : 0;
    var state = Object.assign({}, tour, {
      presets: presets,
      activePresetId: syncPresetId,
      timer: defaultTimer(),
      timerStatus: "대기중",
      displayTime: levels && levels.length ? formatMMSS(dur) : "00:00",
      level: 1,
      regCloseAt: null,
      pendingBridge: null,
      hasStartedOnce: false,
    });
    if (levels && levels.length) {
      state.timer.levelIndex = 0;
      state.timer.pausedRemainingSec = dur;
    }
    ensureTotalSecondsState(state);
    syncLevelField(state);
    return state;
  }

  /**
   * 일시정지 후 남은 시간 그대로 이어서 시작. 남은 시간이 0이면 현재 레벨 풀타임으로 시작.
   * 이미 진행 중이면 변경 없음.
   */
  function applyResume(state, now) {
    var levels = getActiveLevels(state);
    if (!levels || !levels.length) {
      state.timerStatus = "프리셋 없음";
      return state;
    }
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    if (t.isRunning) {
      if (t.endAt == null || !Number.isFinite(t.endAt)) {
        var remFix = Math.max(0, Math.floor(t.pausedRemainingSec || 0));
        if (remFix <= 0) remFix = levelDurationSec(levels[t.levelIndex]);
        t.endAt = now + remFix * 1000;
        t.pausedRemainingSec = remFix;
      }
      syncLevelField(state);
      state.displayTime = formatMMSS(remainingSec(state, now));
      return state;
    }
    syncLevelField(state);
    var rem = Math.max(0, Math.floor(t.pausedRemainingSec || 0));
    if (rem <= 0) {
      rem = levelDurationSec(levels[t.levelIndex]);
    }
    t.bridge = null;
    state.pendingBridge = null;
    t.pausedRemainingSec = rem;
    t.isRunning = true;
    t.endAt = now + rem * 1000;
    state.hasStartedOnce = true;
    state.timerStatus = "진행중";
    state.displayTime = formatMMSS(rem);
    return state;
  }

  /**
   * 현재 레벨 남은 시간을 프리셋 풀타임으로 맞추고 정지(대기). 진행 중이면 먼저 멈춘 뒤 리셋.
   */
  function applyLevelRefresh(state, now) {
    syncTotalSeconds(state, now);
    var levels = getActiveLevels(state);
    if (!levels || !levels.length) {
      state.timerStatus = "프리셋 없음";
      return state;
    }
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    syncLevelField(state);
    var dur = levelDurationSec(levels[t.levelIndex]);
    t.isRunning = false;
    t.endAt = null;
    t.bridge = null;
    state.pendingBridge = null;
    t.pausedRemainingSec = dur;
    state.hasStartedOnce = false;
    state.timerStatus = "대기중";
    state.displayTime = formatMMSS(dur);
    return state;
  }

  /**
   * 관리자 시작: 프리셋에 N분 대기(옵션) → 남은 3초는 띵(표시·오디오는 클라이언트).
   * 대기가 없으면 3초 startGo 브리지만 두고, 만료 시 applyResume으로 실제 타이머 시작.
   */
  function applyStartSequence(state, now) {
    var levels = getActiveLevels(state);
    if (!levels || !levels.length) {
      state.timerStatus = "프리셋 없음";
      return state;
    }
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    if (t.isRunning || t.bridge) {
      return state;
    }
    if (
      state.pendingBridge &&
      typeof state.pendingBridge === "object" &&
      (state.pendingBridge.kind === "preWait" ||
        state.pendingBridge.kind === "startGo")
    ) {
      var pendingRem = Math.floor(Number(state.pendingBridge.remainingSec) || 0);
      if (pendingRem > 0) {
        t.bridge = {
          kind: state.pendingBridge.kind,
          until: now + pendingRem * 1000,
        };
        state.timerStatus =
          state.pendingBridge.kind === "preWait" ? "대기 타이머" : "시작 준비";
        state.displayTime = formatMMSS(remainingSec(state, now));
        state.pendingBridge = null;
        return state;
      }
      state.pendingBridge = null;
    }
    syncLevelField(state);
    if (state.hasStartedOnce || t.levelIndex > 0) {
      return applyResume(state, now);
    }

    var dur = levelDurationSec(levels[t.levelIndex]);
    var rem = Math.max(0, Math.floor(t.pausedRemainingSec || 0));
    if (rem <= 0) rem = dur;
    t.pausedRemainingSec = rem;
    t.isRunning = false;
    t.endAt = null;

    var preset = getActivePreset(state);
    var wm = 0;
    if (preset && preset.preGameWaitMinutes != null) {
      wm = Math.floor(Number(preset.preGameWaitMinutes));
      if (!Number.isFinite(wm) || wm < 0) wm = 0;
      wm = Math.min(999, wm);
    }
    if (wm > 0) {
      t.bridge = { kind: "preWait", until: now + wm * 60 * 1000 };
      state.timerStatus = "대기 타이머";
    } else {
      t.bridge = { kind: "startGo", until: now + 3000 };
      state.timerStatus = "시작 준비";
    }
    state.pendingBridge = null;
    state.displayTime = formatMMSS(remainingSec(state, now));
    return state;
  }

  function applyPause(state, now) {
    syncTotalSeconds(state, now);
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    if (t.bridge && Number.isFinite(t.bridge.until)) {
      var bridgeRem = Math.max(0, Math.ceil((t.bridge.until - now) / 1000));
      state.pendingBridge = {
        kind: t.bridge.kind,
        remainingSec: bridgeRem,
      };
      t.bridge = null;
      state.timerStatus = "일시정지";
      state.displayTime = formatMMSS(bridgeRem);
      return state;
    }
    t.bridge = null;
    state.pendingBridge = null;
    if (!t.isRunning) {
      if (
        state.timerStatus === "대기 타이머" ||
        state.timerStatus === "시작 준비"
      ) {
        state.timerStatus = "대기중";
      }
      syncLevelField(state);
      state.displayTime = formatMMSS(remainingSec(state, now));
      return state;
    }
    var rem = Math.max(0, Math.ceil((t.endAt - now) / 1000));
    t.pausedRemainingSec = rem;
    t.isRunning = false;
    t.endAt = null;
    state.timerStatus = "일시정지";
    state.displayTime = formatMMSS(rem);
    return state;
  }

  function isPreGameBridge(state, timer) {
    var t = timer;
    if (
      t &&
      t.bridge &&
      (t.bridge.kind === "preWait" || t.bridge.kind === "startGo")
    ) {
      return true;
    }
    var pb = state && state.pendingBridge;
    return !!(
      pb &&
      (pb.kind === "preWait" || pb.kind === "startGo")
    );
  }

  function pauseStalePreGameStatus(state) {
    if (
      state.timerStatus === "대기 타이머" ||
      state.timerStatus === "시작 준비"
    ) {
      state.timerStatus = "일시정지";
    }
  }

  /** 대기 타이머 종료 후 레벨 수동 조정 등으로 bridge 없이 멈춘 경우 START는 재개 */
  function shouldResumeInsteadOfStart(state, timer) {
    var t = normalizeTimer(timer, state);
    if (state.hasStartedOnce) return true;
    if (t.levelIndex > 0) return true;
    if (state.timerStatus === "일시정지") return true;
    return (
      (state.timerStatus === "대기 타이머" || state.timerStatus === "시작 준비") &&
      !t.bridge &&
      !isPreGameBridge(state, t)
    );
  }

  function applyStartOrResume(state, now) {
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    if (t.isRunning || t.bridge) return state;
    if (state.pendingBridge) return applyStartSequence(state, now);
    if (shouldResumeInsteadOfStart(state, t)) return applyResume(state, now);
    return applyStartSequence(state, now);
  }

  /**
   * 레벨 ± 조정. 대기 타이머·시작 준비 중 LEVEL+는 현재(1)레벨을 바로 시작한다.
   */
  function applyScheduleLevelDelta(state, now, delta) {
    var levels = getActiveLevels(state);
    if (!levels || !levels.length) return state;
    var t = normalizeTimer(state.timer, state);
    state.timer = t;

    if (isPreGameBridge(state, t)) {
      if (delta < 0) return state;
      t.bridge = null;
      state.pendingBridge = null;
      return applyResume(state, now);
    }

    var nextIdx = clamp(t.levelIndex + delta, 0, levels.length - 1);
    t.levelIndex = nextIdx;
    var dur = levelDurationSec(levels[nextIdx]);
    t.bridge = null;
    state.pendingBridge = null;
    if (t.isRunning) {
      t.endAt = now + dur * 1000;
      t.pausedRemainingSec = dur;
      state.timerStatus = "진행중";
    } else {
      t.endAt = null;
      t.pausedRemainingSec = dur;
      pauseStalePreGameStatus(state);
      if (
        state.timerStatus !== "종료" &&
        state.timerStatus !== "일시정지" &&
        state.timerStatus !== "대기중"
      ) {
        state.timerStatus = "일시정지";
      }
    }
    syncLevelField(state);
    state.displayTime = formatMMSS(remainingSec(state, now));
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
    if (t.bridge) {
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
    var v = Number(localStorage.getItem(getHeartbeatStorageKey()) || 0);
    if (!Number.isFinite(v)) return false;
    return now - v < WINDOW_STALE_MS;
  }

  function shouldOwnEngine(now) {
    if (global.__METIS_IS_TIMER_PAGE) return true;
    return !isTimerWindowLikelyOpen(now);
  }

  function touchTimerWindowHeartbeat() {
    try {
      localStorage.setItem(getHeartbeatStorageKey(), String(Date.now()));
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
    var t = normalizeTimer(s.timer, s);
    s.timer = t;
    var totalSecBefore = getTotalSeconds(s);
    if (canOwn) syncTotalSeconds(s, now);
    var totalSecAfter = getTotalSeconds(s);

    var bridgeCompleted = null;
    if (
      canOwn &&
      t.bridge &&
      Number.isFinite(t.bridge.until) &&
      now >= t.bridge.until
    ) {
      bridgeCompleted = t.bridge.kind;
      t.bridge = null;
      applyResume(s, now);
      writeSyncState(s);
      return {
        state: s,
        advanced: false,
        leveledUp: false,
        finished: false,
        rem: remainingSec(s, Date.now()),
        now: Date.now(),
        bridgeCompleted: bridgeCompleted,
      };
    }

    var res = tickExpire(s, now, canOwn);
    if (res.advanced) {
      writeSyncState(res.state);
    } else if (canOwn && totalSecAfter !== totalSecBefore) {
      writeSyncState(res.state);
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
      bridgeCompleted: null,
    };
  }

  global.MetisTimer = {
    LEGACY_SYNC_KEY: LEGACY_SYNC_KEY,
    getSyncStorageKey: getSyncStorageKey,
    getHeartbeatStorageKey: getHeartbeatStorageKey,
    setSyncPresetId: setSyncPresetId,
    getSyncPresetId: getSyncPresetId,
    HEARTBEAT_KEY: HEARTBEAT_KEY,
    HEARTBEAT_MS: HEARTBEAT_MS,
    readSyncState: readSyncState,
    writeSyncState: writeSyncState,
    defaultTimer: defaultTimer,
    getActivePreset: getActivePreset,
    getActiveLevels: getActiveLevels,
    isBreakRow: isBreakRow,
    levelDurationSec: levelDurationSec,
    formatMMSS: formatMMSS,
    remainingSec: remainingSec,
    applyResume: applyResume,
    applyStartSequence: applyStartSequence,
    applyLevelRefresh: applyLevelRefresh,
    applyScheduleLevelDelta: applyScheduleLevelDelta,
    isPreGameBridge: isPreGameBridge,
    shouldResumeInsteadOfStart: shouldResumeInsteadOfStart,
    applyStartOrResume: applyStartOrResume,
    applyPause: applyPause,
    tickExpire: tickExpire,
    shouldOwnEngine: shouldOwnEngine,
    isTimerWindowLikelyOpen: isTimerWindowLikelyOpen,
    touchTimerWindowHeartbeat: touchTimerWindowHeartbeat,
    playLevelBeep: playLevelBeep,
    subscribeSync: subscribeSync,
    syncLevelField: syncLevelField,
    normalizeTimer: normalizeTimer,
    getTotalSeconds: getTotalSeconds,
    engineStep: engineStep,
    pickRemoteSlice: pickRemoteSlice,
    TIMER_SYNC_KEYS: TIMER_SYNC_KEYS,
    pickTimerSyncSlice: pickTimerSyncSlice,
    applyTimerSyncSlice: applyTimerSyncSlice,
    timerSyncUpdatedAt: timerSyncUpdatedAt,
    isTimerSyncSliceNewer: isTimerSyncSliceNewer,
    syncAllPresetsMetadataFromStorage: syncAllPresetsMetadataFromStorage,
    recoverPresetsMetadataFromTimerStates: recoverPresetsMetadataFromTimerStates,
    mergePresetLists: mergePresetLists,
    isPresetMetadataEmpty: isPresetMetadataEmpty,
    flushActivePresetMetadataToTimer: flushActivePresetMetadataToTimer,
  };
})(typeof window !== "undefined" ? window : this);
