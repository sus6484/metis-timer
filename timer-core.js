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

  /** 이 탭에서 사용자 조작 전까지 클라우드 우선 수용 (부팅 grace) */
  var sessionUserActionSeen = false;

  var bc = null;

  function syncPageTag() {
    try {
      if (typeof location === "undefined" || !location.pathname) return "?";
      var p = location.pathname.split("/").pop();
      return p || location.pathname;
    } catch (e0) {
      return "?";
    }
  }

  /** @param {"PUSH"|"PULL"} phase @param {string} step */
  function syncDbg(phase, step, detail) {
    var msg = "[MetisSync|" + phase + "|" + step + "] (" + syncPageTag() + ")";
    if (detail === undefined) console.log(msg);
    else console.log(msg, detail);
  }

  function statsSnippet(state) {
    if (!state || typeof state !== "object") return null;
    return {
      player: state.player,
      entry: state.entry,
      entryChips: state.entryChips,
      timerUpdatedAt: state.timerUpdatedAt,
      controlUpdatedAt: state.controlUpdatedAt,
      lastActionTimestamp: state.lastActionTimestamp,
      statsUpdatedAt: state.statsUpdatedAt,
      updatedAt: state.updatedAt,
    };
  }

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

  /**
   * 프리셋 ID에 묶인 대회 설정 (실시간 인원과 분리).
   * entryChips·regCloseLevel은 타이머 루트에 남아 다른 프리셋 값으로 덮일 수 있어
   * 항상 activePresetId / syncPresetId로 해당 프리셋에서만 가져온다.
   */
  var PRESET_BOUND_CONFIG_KEYS = ["entryChips", "regCloseLevel"];

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
      var list = Array.isArray(arr) ? arr : [];
      if (
        global.MetisFirestoreSync &&
        typeof global.MetisFirestoreSync.filterDeletedPresetsFs === "function"
      ) {
        return global.MetisFirestoreSync.filterDeletedPresetsFs(list);
      }
      return list;
    } catch (e) {
      return [];
    }
  }

  function savePresetsToStorage(presets) {
    try {
      var list = Array.isArray(presets) ? presets.slice() : [];
      if (
        global.MetisFirestoreSync &&
        typeof global.MetisFirestoreSync.filterDeletedPresetsFs === "function"
      ) {
        list = global.MetisFirestoreSync.filterDeletedPresetsFs(list);
      }
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list));
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

  function findPresetIndexById(presets, id) {
    if (!id || !Array.isArray(presets)) return -1;
    var sid = String(id);
    for (var i = 0; i < presets.length; i++) {
      if (presets[i] && String(presets[i].id) === sid) return i;
    }
    return -1;
  }

  function findPresetInList(presets, id) {
    var idx = findPresetIndexById(presets, id);
    return idx >= 0 ? presets[idx] : null;
  }

  function embedActivePresetTournament(state) {
    if (!state || typeof state !== "object" || !syncPresetId) return;
    var presets = loadPresetsFromStorage();
    var idx = findPresetIndexById(presets, syncPresetId);
    if (idx < 0) return;
    var updated = null;
    try {
      updated = JSON.parse(JSON.stringify(presets[idx]));
    } catch (e0) {
      updated = Object.assign({}, presets[idx]);
    }
    for (var j = 0; j < PRESET_METADATA_ONLY_KEYS.length; j++) {
      var key = PRESET_METADATA_ONLY_KEYS[j];
      if (state[key] !== undefined) updated[key] = state[key];
    }
    for (var c = 0; c < PRESET_BOUND_CONFIG_KEYS.length; c++) {
      var ck = PRESET_BOUND_CONFIG_KEYS[c];
      if (state[ck] !== undefined) updated[ck] = state[ck];
    }
    updated.id = String(syncPresetId);
    var next = presets.map(function (p, i) {
      return i === idx ? updated : p;
    });
    savePresetsToStorage(next);
  }

  function shouldApplyMetadataField(key, presetVal, stateVal) {
    if (key === "prizeItems") {
      if (!Array.isArray(presetVal) || presetVal.length === 0) {
        return isPresetMetadataEmpty(key, stateVal);
      }
      return true;
    }
    if (isPresetMetadataEmpty(key, presetVal)) {
      return isPresetMetadataEmpty(key, stateVal);
    }
    return true;
  }

  /** 프리셋 메타데이터만 timer_state_* 에 병합 (인원 등 실시간 값은 유지) */
  function mergeActivePresetMetadataIntoState(state) {
    return copyPresetMetadataIntoState(state, getActivePreset(state));
  }

  /** 클라우드 프리셋 → 로컬 timer_state_* (대회정보·상금 등 정적 메타데이터만) */
  function copyPresetMetadataIntoState(state, preset) {
    if (!state || !preset) return state;
    for (var j = 0; j < PRESET_METADATA_ONLY_KEYS.length; j++) {
      var key = PRESET_METADATA_ONLY_KEYS[j];
      if (preset[key] === undefined) continue;
      if (!shouldApplyMetadataField(key, preset[key], state[key])) continue;
      state[key] = copyMetadataValue(key, preset[key]);
    }
    return state;
  }

  /** 활성 프리셋 ID의 바인칩·레지마감 등 대회 설정을 timer state 루트에 강제 반영 */
  function copyPresetBoundConfigIntoState(state, preset) {
    if (!state || !preset) return state;
    for (var i = 0; i < PRESET_BOUND_CONFIG_KEYS.length; i++) {
      var key = PRESET_BOUND_CONFIG_KEYS[i];
      if (preset[key] === undefined) continue;
      state[key] = preset[key];
    }
    return state;
  }

  function mergeActivePresetBoundConfigIntoState(state) {
    if (!state) return state;
    var preset =
      getActivePreset(state) ||
      findPresetInList(state.presets || loadPresetsFromStorage(), syncPresetId);
    return copyPresetBoundConfigIntoState(state, preset);
  }

  /** 활성 프리셋의 entryChips (없으면 state 값) */
  function resolveActiveEntryChips(state) {
    var preset =
      getActivePreset(state) ||
      findPresetInList(
        (state && state.presets) || loadPresetsFromStorage(),
        (state && state.activePresetId) || syncPresetId
      );
    if (preset && preset.entryChips !== undefined) {
      return Math.max(0, Math.floor(Number(preset.entryChips) || 0));
    }
    return Math.max(0, Math.floor(Number(state && state.entryChips) || 0));
  }

  /** 프리셋 전환 시 이전 프리셋 대회명·바인칩 등이 남지 않도록 즉시 교체 */
  function applyActivePresetMetadataOnSwitch(presetId) {
    if (!presetId) return false;
    var pid = String(presetId);
    setSyncPresetId(pid);
    var presets = loadPresetsFromStorage();
    var preset = findPresetInList(presets, pid);
    if (!preset) return false;
    var state = null;
    try {
      var raw = localStorage.getItem(getSyncStorageKey());
      if (raw) state = JSON.parse(raw);
    } catch (e0) {}
    if (!state) state = buildInitialTimerState();
    if (!state) return false;
    delete state.rebuy;
    delete state.addon;
    delete state.rebuyChips;
    delete state.addonChips;
    delete state.early;
    delete state.earlyChips;
    mergePresetsIntoState(state);
    state.activePresetId = pid;
    for (var j = 0; j < PRESET_METADATA_ONLY_KEYS.length; j++) {
      var key = PRESET_METADATA_ONLY_KEYS[j];
      if (preset[key] !== undefined) {
        state[key] = copyMetadataValue(key, preset[key]);
      }
    }
    copyPresetBoundConfigIntoState(state, preset);
    state.timer = normalizeTimer(state.timer, state);
    ensureTotalSecondsState(state);
    syncLevelField(state);
    writeSyncState(state, { skipCloudPush: true, skipPresetEmbed: true });
    return true;
  }

  /** 활성 프리셋 메타데이터·바인칩을 타이머 동기화 상태에 즉시 반영 */
  function flushActivePresetMetadataToTimer() {
    var presets = loadPresetsFromStorage();
    var aid = syncPresetId;
    try {
      var storedActive = localStorage.getItem("metis_activePresetId");
      if (storedActive) aid = storedActive;
    } catch (e0) {}
    if (!aid) return false;
    aid = String(aid);
    setSyncPresetId(aid);
    var preset = findPresetInList(presets, aid);
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
    state.activePresetId = aid;
    copyPresetMetadataIntoState(state, preset);
    copyPresetBoundConfigIntoState(state, preset);
    state.timer = normalizeTimer(state.timer, state);
    ensureTotalSecondsState(state);
    syncLevelField(state);
    writeSyncState(state, { skipPresetEmbed: true });
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
        var prevUpdatedAt = state.updatedAt;
        copyPresetMetadataIntoState(state, p);
        if (prevUpdatedAt != null && Number.isFinite(Number(prevUpdatedAt))) {
          state.updatedAt = prevUpdatedAt;
        }
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
    if (!state || !state.presets) return null;
    var aid =
      syncPresetId ||
      (state.activePresetId != null ? String(state.activePresetId) : "");
    if (!aid) return null;
    return findPresetInList(state.presets, aid);
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
      if (syncPresetId) state.activePresetId = String(syncPresetId);
      mergeActivePresetMetadataIntoState(state);
      mergeActivePresetBoundConfigIntoState(state);
      state.timer = normalizeTimer(state.timer, state);
      ensureTotalSecondsState(state);
      syncLevelField(state);
      reconcileRunningEndAt(state, Date.now());
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
  var STATS_SYNC_KEYS = ["player", "entry", "entryChips"];

  var TIMER_FIELD_SYNC_KEYS = [
    "timer",
    "timerStatus",
    "displayTime",
    "level",
    "hasStartedOnce",
    "pendingBridge",
    "regCloseAt",
    "totalScheduleCommittedSec",
  ];

  var TIMER_SYNC_KEYS = [
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
    "timerUpdatedAt",
    "statsUpdatedAt",
    "controlUpdatedAt",
    "heartbeatAt",
    "lastActionTimestamp",
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
    if (!Number.isFinite(u) || u <= 0) u = Date.now();
    out.updatedAt = u;
    var tu = Number(out.timerUpdatedAt);
    if (!Number.isFinite(tu) || tu <= 0) out.timerUpdatedAt = u;
    var su = Number(out.statsUpdatedAt);
    if (!Number.isFinite(su) || su <= 0) out.statsUpdatedAt = u;
    var cu = Number(out.controlUpdatedAt);
    if (!Number.isFinite(cu) || cu <= 0) out.controlUpdatedAt = out.timerUpdatedAt;
    var la = Number(out.lastActionTimestamp);
    if (!Number.isFinite(la) || la <= 0) {
      la = Math.max(
        Number.isFinite(cu) && cu > 0 ? cu : 0,
        Number.isFinite(su) && su > 0 ? su : 0
      );
      if (la > 0) out.lastActionTimestamp = la;
    }
    if (
      out.timer &&
      out.timer.isRunning &&
      !out.timer.bridge &&
      (out.timer.endAt == null || !Number.isFinite(Number(out.timer.endAt)))
    ) {
      var remPush = Math.max(0, Math.floor(Number(out.timer.pausedRemainingSec) || 0));
      if (remPush <= 0 && state) {
        var lvPush = getActiveLevels(state);
        if (lvPush && lvPush.length) {
          remPush = levelDurationSec(lvPush[out.timer.levelIndex]);
        }
      }
      if (remPush > 0) {
        out.timer.endAt = Date.now() + remPush * 1000;
      }
    }
    return out;
  }

  function timerSyncUpdatedAt(slice) {
    if (!slice) return 0;
    var n = Number(slice.updatedAt);
    return Number.isFinite(n) ? n : 0;
  }

  function sliceTimerUpdatedAt(slice) {
    if (!slice) return 0;
    var tu = Number(slice.timerUpdatedAt);
    if (Number.isFinite(tu) && tu > 0) return tu;
    return timerSyncUpdatedAt(slice);
  }

  function sliceStatsUpdatedAt(slice) {
    if (!slice) return 0;
    var su = Number(slice.statsUpdatedAt);
    if (Number.isFinite(su) && su > 0) return su;
    return timerSyncUpdatedAt(slice);
  }

  function sliceControlUpdatedAt(slice) {
    if (!slice) return 0;
    var cu = Number(slice.controlUpdatedAt);
    if (Number.isFinite(cu) && cu > 0) return cu;
    return sliceTimerUpdatedAt(slice);
  }

  function sliceHeartbeatAt(slice) {
    if (!slice) return 0;
    var hb = Number(slice.heartbeatAt);
    return Number.isFinite(hb) && hb > 0 ? hb : 0;
  }

  /**
   * 사용자 수동 조작 시각 (LWW 기준).
   * tick/heartbeat는 이 값을 갱신하지 않는다.
   */
  function sliceLastActionAt(slice) {
    if (!slice) return 0;
    var la = Number(slice.lastActionTimestamp);
    if (Number.isFinite(la) && la > 0) return la;
    var cu = Number(slice.controlUpdatedAt);
    var su = Number(slice.statsUpdatedAt);
    var max = 0;
    if (Number.isFinite(cu) && cu > 0) max = Math.max(max, cu);
    if (Number.isFinite(su) && su > 0) max = Math.max(max, su);
    return max;
  }

  function isTickSyncUpdate(options) {
    options = options || {};
    return !!(options.cloudHeartbeat || options.autoTick);
  }

  function isUserSyncAction(options) {
    options = options || {};
    if (options.preserveUpdatedAt || isTickSyncUpdate(options)) return false;
    return !!(options.userAction || options.urgentCloudPush);
  }

  function isBootGraceActive() {
    return !sessionUserActionSeen;
  }

  function markSessionUserInput(options) {
    options = options || {};
    if (options.preserveUpdatedAt || isTickSyncUpdate(options)) return;
    if (options.userAction || options.urgentCloudPush || options.bumpStats) {
      sessionUserActionSeen = true;
    }
  }

  /** 부팅 grace: 클라우드가 더 최신이면 로컬 타임스탬프와 무관하게 적용 */
  function isCloudNewerDuringGrace(cloudSlice, localSlice) {
    if (!cloudSlice || typeof cloudSlice !== "object") return false;
    if (!localSlice || typeof localSlice !== "object") return true;
    if (sliceLastActionAt(cloudSlice) > sliceLastActionAt(localSlice)) return true;
    if (shouldApplyCloudTimerSlice(cloudSlice, localSlice)) return true;
    if (timerSyncUpdatedAt(cloudSlice) > timerSyncUpdatedAt(localSlice)) return true;
    var cloudSU = sliceStatsUpdatedAt(cloudSlice);
    var localSU = sliceStatsUpdatedAt(localSlice);
    if (cloudSU > localSU && cloudSU > 0) return true;
    return false;
  }

  function isStatsSyncAction(options) {
    options = options || {};
    if (options.preserveUpdatedAt || isTickSyncUpdate(options)) return false;
    return !!options.bumpStats;
  }

  /** 재생/브레이지 중이면 true (일시정지·대기중 제외) */
  function isEffectivelyPlayingSlice(slice) {
    if (!slice || typeof slice !== "object") return false;
    var t = slice.timer;
    if (!t) return false;
    if (t.bridge) return true;
    return !!t.isRunning;
  }

  function playStatesDiffer(cloudSlice, localSlice) {
    return (
      isEffectivelyPlayingSlice(cloudSlice) !==
      isEffectivelyPlayingSlice(localSlice)
    );
  }

  /** 재생/정지 전환은 lastActionTimestamp(LWW)만 따른다. heartbeat·timerUpdatedAt으로 덮지 않는다. */
  function cloudHasNewerControlAction(cloudSlice, localSlice) {
    return sliceLastActionAt(cloudSlice) > sliceLastActionAt(localSlice);
  }

  /**
   * 재생↔정지가 다르고 클라우드 쪽 수동 조작 시각이 더 최신이면 적용한다.
   * (로컬이 돌아가는 중이어도 원격 일시정지를 따름)
   */
  function shouldForceApplyCloudControl(cloudSlice, localSlice) {
    if (!playStatesDiffer(cloudSlice, localSlice)) return false;
    return cloudHasNewerControlAction(cloudSlice, localSlice);
  }

  function applyCloudControlSlice(state, cloudSlice) {
    copyCloudSliceOntoState(state, cloudSlice);
    syncLevelField(state);
    reconcileRunningEndAt(state, Date.now());
    ensureTotalSecondsState(state);
    state.displayTime = formatMMSS(remainingSec(state, Date.now()));
  }

  function assignSyncTimestamps(state, options) {
    options = options || {};
    if (options.preserveUpdatedAt) {
      syncDbg("PUSH", "assignSyncTimestamps:preserveUpdatedAt", statsSnippet(state));
      return;
    }
    var now = Date.now();
    var curSU = Number(state.statsUpdatedAt) || 0;
    var curLA = Number(state.lastActionTimestamp) || 0;

    if (isTickSyncUpdate(options)) {
      state.heartbeatAt = now;
      state.updatedAt = Math.max(
        state.updatedAt || 0,
        now,
        Number(state.timerUpdatedAt) || 0,
        curSU,
        curLA
      );
      syncDbg("PUSH", "assignSyncTimestamps:tick", {
        autoTick: !!options.autoTick,
        cloudHeartbeat: !!options.cloudHeartbeat,
        heartbeatAt: state.heartbeatAt,
        lastActionTimestamp: state.lastActionTimestamp,
      });
      return;
    }

    if (isStatsSyncAction(options)) {
      state.statsUpdatedAt = now;
      state.updatedAt = Math.max(
        now,
        Number(state.timerUpdatedAt) || 0,
        curSU,
        curLA
      );
      syncDbg("PUSH", "assignSyncTimestamps:stats", statsSnippet(state));
      markSessionUserInput(options);
      if (!isUserSyncAction(options)) return;
    }

    if (!isUserSyncAction(options)) {
      return;
    }

    state.lastActionTimestamp = now;
    state.controlUpdatedAt = now;
    state.timerUpdatedAt = now;
    state.updatedAt = Math.max(now, curSU);
    syncDbg("PUSH", "assignSyncTimestamps:userAction", {
      lastActionTimestamp: state.lastActionTimestamp,
      bumpStats: !!options.bumpStats,
      player: state.player,
      entry: state.entry,
      isRunning: state.timer && state.timer.isRunning,
    });
    markSessionUserInput(options);
  }

  /** 클라우드 슬라이스 전체를 로컬 state에 덮어쓴다 (LWW) */
  function copyCloudSliceOntoState(state, cloudSlice) {
    for (var ti = 0; ti < TIMER_FIELD_SYNC_KEYS.length; ti++) {
      var tk = TIMER_FIELD_SYNC_KEYS[ti];
      if (cloudSlice[tk] === undefined) continue;
      if (tk === "timer") {
        state.timer = normalizeTimer(cloudSlice.timer, state);
      } else if (tk === "pendingBridge") {
        state.pendingBridge = copyPendingBridgeForSync(cloudSlice.pendingBridge);
      } else if (tk === "hasStartedOnce") {
        state.hasStartedOnce = !!cloudSlice.hasStartedOnce;
      } else {
        state[tk] = cloudSlice[tk];
      }
    }
    for (var si = 0; si < STATS_SYNC_KEYS.length; si++) {
      var sk = STATS_SYNC_KEYS[si];
      if (cloudSlice[sk] !== undefined) state[sk] = cloudSlice[sk];
    }
    // 바인칩·레지마감은 이 기기의 활성 프리셋 설정을 우선 (클라우드 슬라이스 오염 방지)
    mergeActivePresetBoundConfigIntoState(state);
    if (cloudSlice.presetId) {
      state.presetId = String(cloudSlice.presetId);
    }
    // activePresetId는 기기 로컬 UI 전용 — 클라우드 슬라이스로 덮어쓰지 않음
    if (syncPresetId) {
      state.activePresetId = syncPresetId;
    } else if (cloudSlice.presetId) {
      state.activePresetId = String(cloudSlice.presetId);
    }
    var tsKeys = [
      "timerUpdatedAt",
      "statsUpdatedAt",
      "controlUpdatedAt",
      "heartbeatAt",
      "lastActionTimestamp",
      "updatedAt",
    ];
    for (var xi = 0; xi < tsKeys.length; xi++) {
      var xk = tsKeys[xi];
      if (cloudSlice[xk] != null && Number(cloudSlice[xk]) > 0) {
        state[xk] = Number(cloudSlice[xk]);
      }
    }
  }

  /** tick 전용: 재생 중 양쪽 모두일 때 위치(endAt·displayTime)만 동기화 */
  function applyCloudTickSlice(state, cloudSlice) {
    if (!cloudSlice.timer) return false;
    var t = normalizeTimer(state.timer, state);
    var ct = normalizeTimer(cloudSlice.timer, state);
    if (ct.endAt != null && Number.isFinite(ct.endAt)) {
      t.endAt = ct.endAt;
    }
    if (ct.pausedRemainingSec !== undefined) {
      t.pausedRemainingSec = ct.pausedRemainingSec;
    }
    if (ct.bridge !== undefined) {
      t.bridge = ct.bridge;
    }
    t.isRunning = !!ct.isRunning;
    state.timer = t;
    if (cloudSlice.displayTime !== undefined) {
      state.displayTime = cloudSlice.displayTime;
    }
    if (cloudSlice.timerStatus !== undefined) {
      state.timerStatus = cloudSlice.timerStatus;
    }
    var cloudHb = sliceHeartbeatAt(cloudSlice);
    if (cloudHb > 0) state.heartbeatAt = cloudHb;
    return true;
  }

  /** isRunning인데 endAt이 없으면 보정 — pausedRemainingSec만 쓰면 기기마다 30초+ 어긋남 */
  function reconcileRunningEndAt(state, now) {
    if (!state || !state.timer) return;
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    if (t.bridge) return;
    if (t.isRunning) {
      if (t.endAt != null && Number.isFinite(t.endAt)) {
        t.pausedRemainingSec = remainingSec(state, now);
        return;
      }
      var rem = Math.max(0, Math.floor(t.pausedRemainingSec || 0));
      if (rem <= 0) {
        var levels = getActiveLevels(state);
        if (levels && levels.length) {
          rem = levelDurationSec(levels[t.levelIndex]);
        }
      }
      if (rem > 0) {
        t.endAt = now + rem * 1000;
        t.pausedRemainingSec = rem;
      } else {
        t.isRunning = false;
        t.endAt = null;
      }
      return;
    }
    if (t.endAt != null && Number.isFinite(t.endAt)) {
      t.endAt = null;
    }
  }

  function isEffectivelyRunningTimer(timer, now) {
    if (!timer) return false;
    if (timer.bridge) return true;
    if (!timer.isRunning) return false;
    if (timer.endAt != null && Number.isFinite(timer.endAt)) return true;
    return Math.max(0, Math.floor(timer.pausedRemainingSec || 0)) > 0;
  }

  /** cloudSlice가 localSlice보다 최신이면 true (충돌 해결용) */
  function isTimerSyncSliceNewer(cloudSlice, localSlice) {
    return timerSyncUpdatedAt(cloudSlice) > timerSyncUpdatedAt(localSlice);
  }

  /** 진행도 비교용 — updatedAt만으로 놓치는 “리셋된 로컬 vs 진행 중 클라우드” 판별 */
  function timerGameplayRank(slice) {
    if (!slice || typeof slice !== "object") return 0;
    var t = slice.timer;
    if (!t) return slice.hasStartedOnce ? 1 : 0;
    var levelIdx = Math.max(0, parseInt(t.levelIndex, 10) || 0);
    if (t.isRunning || t.bridge) {
      return 100 + levelIdx * 10 + (t.isRunning ? 1 : 0);
    }
    if (slice.hasStartedOnce) return 50 + levelIdx * 10;
    if (levelIdx > 0) return 20 + levelIdx;
    return 0;
  }

  /**
   * 클라우드 슬라이스를 적용할지 판단한다.
   * 로컬 updatedAt이 더 크더라도, 로컬이 대기/리셋이고 클라우드가 진행 중이면 클라우드를 따른다.
   */
  function shouldApplyCloudTimerSlice(cloudSlice, localSlice) {
    if (!cloudSlice || typeof cloudSlice !== "object") return false;
    if (!localSlice || typeof localSlice !== "object") return true;
    if (shouldForceApplyCloudControl(cloudSlice, localSlice)) return true;
    if (shouldForceApplyCloudControl(localSlice, cloudSlice)) return false;
    var cloudU = sliceTimerUpdatedAt(cloudSlice);
    var localU = sliceTimerUpdatedAt(localSlice);
    if (cloudU > localU) {
      if (
        playStatesDiffer(cloudSlice, localSlice) &&
        !cloudHasNewerControlAction(cloudSlice, localSlice)
      ) {
        return false;
      }
      return true;
    }
    if (cloudU < localU) {
      var cloudPlaying = isEffectivelyPlayingSlice(cloudSlice);
      var localPlaying = isEffectivelyPlayingSlice(localSlice);
      if (localPlaying && !cloudPlaying) return false;
      var cloudRank = timerGameplayRank(cloudSlice);
      var localRank = timerGameplayRank(localSlice);
      if (cloudRank > localRank + 5) return true;
      if (cloudRank >= 50 && localRank < 20) return true;
    }
    return false;
  }

  /**
   * 클라우드 슬라이스를 로컬 state에 병합한다.
   * lastActionTimestamp LWW: 클라우드가 더 최신이면 전체 덮어쓰기.
   * 동일 조작 세대에서는 tick(heartbeat)만 위치 동기화.
   * @returns {boolean} 변경 여부
   */
  function applyTimerSyncSlice(state, cloudSlice, options) {
    options = options || {};
    if (!state || !cloudSlice || typeof cloudSlice !== "object") {
      syncDbg("PULL", "applyTimerSyncSlice:인자없음");
      return false;
    }
    var localSlice = pickTimerSyncSlice(state);
    var cloudLA = sliceLastActionAt(cloudSlice);
    var localLA = sliceLastActionAt(localSlice);

    syncDbg("PULL", "applyTimerSyncSlice:판단", {
      cloudLA: cloudLA,
      localLA: localLA,
      cloudHb: sliceHeartbeatAt(cloudSlice),
      localHb: sliceHeartbeatAt(localSlice),
      cloudPlaying: isEffectivelyPlayingSlice(cloudSlice),
      localPlaying: isEffectivelyPlayingSlice(localSlice),
      bootGrace: isBootGraceActive(),
      cloudStats: {
        player: cloudSlice.player,
        entry: cloudSlice.entry,
      },
      localStats: {
        player: localSlice.player,
        entry: localSlice.entry,
      },
      forceApply: !!options.forceApply,
    });

    if (options.forceApply) {
      applyCloudControlSlice(state, cloudSlice);
      syncDbg("PULL", "applyTimerSyncSlice:강제클라우드적용", {
        cloudLA: cloudLA,
        localLA: localLA,
        merged: statsSnippet(state),
      });
      return true;
    }

    if (isBootGraceActive() && isCloudNewerDuringGrace(cloudSlice, localSlice)) {
      applyCloudControlSlice(state, cloudSlice);
      syncDbg("PULL", "applyTimerSyncSlice:bootGrace클라우드적용", {
        cloudLA: cloudLA,
        localLA: localLA,
        merged: statsSnippet(state),
      });
      return true;
    }

    if (shouldForceApplyCloudControl(cloudSlice, localSlice)) {
      applyCloudControlSlice(state, cloudSlice);
      syncDbg("PULL", "applyTimerSyncSlice:control강제적용", {
        cloudLA: cloudLA,
        localLA: localLA,
        merged: statsSnippet(state),
      });
      return true;
    }

    if (cloudLA > localLA) {
      applyCloudControlSlice(state, cloudSlice);
      syncDbg("PULL", "applyTimerSyncSlice:LWW전체적용", {
        lastActionTimestamp: cloudLA,
        merged: statsSnippet(state),
      });
      return true;
    }

    if (
      cloudLA === localLA &&
      shouldApplyCloudTimerSlice(cloudSlice, localSlice)
    ) {
      applyCloudControlSlice(state, cloudSlice);
      syncDbg("PULL", "applyTimerSyncSlice:동일조작세대_상태적용", {
        cloudLA: cloudLA,
        localLA: localLA,
        merged: statsSnippet(state),
      });
      return true;
    }

    if (shouldForceApplyCloudControl(localSlice, cloudSlice)) {
      syncDbg("PULL", "applyTimerSyncSlice:로컬control최신", {
        cloudLA: cloudLA,
        localLA: localLA,
      });
      return false;
    }

    if (localLA > cloudLA) {
      syncDbg("PULL", "applyTimerSyncSlice:로컬조작최신_클라우드무시", {
        localLA: localLA,
        cloudLA: cloudLA,
      });
      return false;
    }

    var cloudHb = sliceHeartbeatAt(cloudSlice);
    var localHb = sliceHeartbeatAt(localSlice);
    if (cloudHb <= localHb) {
      syncDbg("PULL", "applyTimerSyncSlice:tick스킵", { cloudHb: cloudHb, localHb: localHb });
      return false;
    }

    if (
      !isEffectivelyPlayingSlice(cloudSlice) ||
      !isEffectivelyPlayingSlice(localSlice)
    ) {
      syncDbg("PULL", "applyTimerSyncSlice:tick비재생상태");
      return false;
    }

    applyCloudTickSlice(state, cloudSlice);
    reconcileRunningEndAt(state, Date.now());
    state.displayTime = formatMMSS(remainingSec(state, Date.now()));
    syncDbg("PULL", "applyTimerSyncSlice:tick위치만적용", {
      heartbeatAt: cloudHb,
    });
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

  function pickTimerHeartbeatSlice(state, presetId) {
    var full = pickTimerSyncSlice(state, presetId);
    var out = {};
    var keys = [
      "presetId",
      "timer",
      "timerStatus",
      "displayTime",
      "level",
      "hasStartedOnce",
      "pendingBridge",
      "regCloseAt",
      "totalScheduleCommittedSec",
      "timerUpdatedAt",
      "controlUpdatedAt",
      "heartbeatAt",
      "lastActionTimestamp",
      "updatedAt",
    ];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (full[k] !== undefined) out[k] = full[k];
    }
    return out;
  }

  function writeSyncState(state, options) {
    options = options || {};
    mergePresetsIntoState(state);
    if (syncPresetId) state.activePresetId = String(syncPresetId);
    if (!options.skipPresetEmbed) embedActivePresetTournament(state);
    reconcileRunningEndAt(state, Date.now());
    assignSyncTimestamps(state, options);
    var str = JSON.stringify(state);
    localStorage.setItem(getSyncStorageKey(), str);
    mirrorRemoteStorage(state);
    if (bc) {
      try {
        bc.postMessage({ type: "sync", t: state.updatedAt });
      } catch (e) {}
    }
    if (!options.skipCloudPush) {
      var pushPresetId =
        syncPresetId ||
        (state.activePresetId != null ? String(state.activePresetId) : "");
      // 바인 인원(player/entry) → Firestore
      if (
        options.bumpStats &&
        pushPresetId &&
        global.MetisFirestoreSync &&
        typeof global.MetisFirestoreSync.saveBuyInStats === "function"
      ) {
        global.MetisFirestoreSync.saveBuyInStats(pushPresetId, {
          player: state.player,
          entry: state.entry,
          statsUpdatedAt: state.statsUpdatedAt,
        });
      }
      // 타이머 제어(재생/일시정지/시계) → Firestore (SSOT)
      if (
        pushPresetId &&
        global.MetisFirestoreSync &&
        global.MetisFirestoreSync.isTimerControlLive &&
        typeof global.MetisFirestoreSync.saveTimerControl === "function"
      ) {
        var pushControl =
          isUserSyncAction(options) ||
          !!options.autoTick ||
          !!options.cloudHeartbeat;
        if (pushControl) {
          var controlSlice =
            options.cloudHeartbeat || options.autoTick
              ? pickTimerHeartbeatSlice(state, pushPresetId)
              : pickTimerSyncSlice(state, pushPresetId);
          global.MetisFirestoreSync.saveTimerControl(pushPresetId, controlSlice, {
            urgent: isUserSyncAction(options),
            heartbeat: !!(options.cloudHeartbeat || options.autoTick),
          });
        }
      } else {
        syncDbg("PUSH", "writeSyncState:Firestore타이머푸시스킵", {
          pushPresetId: pushPresetId,
          firestoreTimerLive: !!(
            global.MetisFirestoreSync &&
            global.MetisFirestoreSync.isTimerControlLive
          ),
          stats: statsSnippet(state),
        });
      }
    } else {
      syncDbg("PUSH", "writeSyncState:클라우드푸시스킵", {
        skipCloudPush: !!options.skipCloudPush,
        stats: statsSnippet(state),
      });
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
    var p = findPresetInList(presets, syncPresetId);
    if (!p) return null;
    var tour = tournamentFieldsFromPreset(p);
    var levels = p.levels && p.levels.length ? p.levels : null;
    var dur = levels && levels.length ? levelDurationSec(levels[0]) : 0;
    var state = Object.assign({}, tour, {
      presets: presets,
      activePresetId: String(syncPresetId),
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

  var lastCloudHeartbeatAt = 0;
  var CLOUD_HEARTBEAT_MS = 3000;

  function needsCloudHeartbeat(state) {
    if (!state) return false;
    var t = state.timer;
    if (t && (t.isRunning || t.bridge)) return true;
    if (state.hasStartedOnce && (state.timerStatus || "") !== "대기중") return true;
    return false;
  }

  function applyCloudHeartbeat(state, now) {
    var t = normalizeTimer(state.timer, state);
    state.timer = t;
    reconcileRunningEndAt(state, now);
    var rem = remainingSec(state, now);
    state.displayTime = formatMMSS(rem);
    if (!t.isRunning && !t.bridge) {
      t.pausedRemainingSec = rem;
    }
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
      writeSyncState(s, { skipPresetEmbed: true, autoTick: true });
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
      writeSyncState(res.state, { skipPresetEmbed: true, autoTick: true });
    } else if (canOwn && totalSecAfter !== totalSecBefore) {
      writeSyncState(res.state, { skipPresetEmbed: true, autoTick: true });
    }
    var live = res.state;
    if (
      canOwn &&
      needsCloudHeartbeat(live) &&
      now - lastCloudHeartbeatAt >= CLOUD_HEARTBEAT_MS
    ) {
      lastCloudHeartbeatAt = now;
      applyCloudHeartbeat(live, now);
      writeSyncState(live, { skipPresetEmbed: true, cloudHeartbeat: true });
    }
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
    resolveActiveEntryChips: resolveActiveEntryChips,
    findPresetInList: findPresetInList,
    mergeActivePresetBoundConfigIntoState: mergeActivePresetBoundConfigIntoState,
    PRESET_BOUND_CONFIG_KEYS: PRESET_BOUND_CONFIG_KEYS,
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
    pickTimerHeartbeatSlice: pickTimerHeartbeatSlice,
    applyTimerSyncSlice: applyTimerSyncSlice,
    timerSyncUpdatedAt: timerSyncUpdatedAt,
    isTimerSyncSliceNewer: isTimerSyncSliceNewer,
    shouldApplyCloudTimerSlice: shouldApplyCloudTimerSlice,
    timerGameplayRank: timerGameplayRank,
    sliceTimerUpdatedAt: sliceTimerUpdatedAt,
    sliceStatsUpdatedAt: sliceStatsUpdatedAt,
    sliceControlUpdatedAt: sliceControlUpdatedAt,
    sliceLastActionAt: sliceLastActionAt,
    shouldForceApplyCloudControl: shouldForceApplyCloudControl,
    isBootGraceActive: isBootGraceActive,
    isEffectivelyPlayingSlice: isEffectivelyPlayingSlice,
    isEffectivelyRunningTimer: isEffectivelyRunningTimer,
    reconcileRunningEndAt: reconcileRunningEndAt,
    syncAllPresetsMetadataFromStorage: syncAllPresetsMetadataFromStorage,
    recoverPresetsMetadataFromTimerStates: recoverPresetsMetadataFromTimerStates,
    mergePresetLists: mergePresetLists,
    mergePresetRecord: mergePresetRecord,
    isPresetMetadataEmpty: isPresetMetadataEmpty,
    flushActivePresetMetadataToTimer: flushActivePresetMetadataToTimer,
    applyActivePresetMetadataOnSwitch: applyActivePresetMetadataOnSwitch,
  };
})(typeof window !== "undefined" ? window : this);
