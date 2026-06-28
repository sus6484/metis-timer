/**
 * Metis — Google Sheets 프리셋·타이머 동기화 (Apps Script Web App)
 * timerStates: 프리셋별 실시간 타이머 상태 (pickTimerSyncSlice, 3단계에서 연결)
 */
(function (global) {
  "use strict";

  var CONFIG = {
    url: "https://script.google.com/macros/s/AKfycbyBqSCpy5-Xo1-CvIsbzNjJvzaFa3cSDHNTTyjhjPfXp3GrAaEmENwc7yC1ykgz4enPTw/exec",
    token: "metis_secret_444444",
    assetVersion: "20260702",
  };

  var CLOUD_PULL_RETRY_DELAYS_MS = [0, 600, 1500];

  /** 절충: 원본(350/800/2000/3000)과 공격적(100/400/1000/1500)의 중간 */
  var CLOUD_PUSH_DEBOUNCE_MS = 250;
  var CLOUD_POLL_MS_ACTIVE = 600;
  var CLOUD_POLL_MS_IDLE = 1500;
  var CLOUD_POLL_MS_HIDDEN = 2500;
  var CLOUD_POLL_MIN_GAP_MS = 100;

  var STORAGE_PRESETS = "metis_blindPresets";
  var STORAGE_ACTIVE = "metis_activePresetId";
  var STORAGE_CLOUD_UPDATED = "metis_lastCloudUpdatedAt";
  var STORAGE_PRESET_CLOUD_TS = "metis_presetCloudTimestamps";

  var pullPromise = null;
  var saveTimer = null;
  var pendingSave = null;
  var lastCloudPullData = null;

  var timerSaveTimer = null;
  var pendingTimerSave = null;
  var cloudPollTimer = null;
  var cloudPollOnApplied = null;
  var cloudPollRunning = false;
  var cloudPollInFlight = false;
  var cloudVisibilityBound = false;
  /** timer.html: { pinnedPresetId } — 이 창은 해당 프리셋만 동기화 */
  var cloudPollOptions = null;

  var cloudSyncState = "idle";
  var cloudSyncLastOkAt = 0;
  var cloudSyncLastErrorAt = 0;
  var cloudSyncStatusListeners = [];

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

  function statsSnippet(slice) {
    if (!slice || typeof slice !== "object") return null;
    return {
      presetId: slice.presetId || null,
      player: slice.player,
      entry: slice.entry,
      entryChips: slice.entryChips,
      isRunning: slice.timer && slice.timer.isRunning,
      hasBridge: !!(slice.timer && slice.timer.bridge),
      timerUpdatedAt: slice.timerUpdatedAt,
      controlUpdatedAt: slice.controlUpdatedAt,
      lastActionTimestamp: slice.lastActionTimestamp,
      heartbeatAt: slice.heartbeatAt,
      statsUpdatedAt: slice.statsUpdatedAt,
      updatedAt: slice.updatedAt,
    };
  }

  function getLastCloudUpdatedAt() {
    try {
      return Number(localStorage.getItem(STORAGE_CLOUD_UPDATED)) || 0;
    } catch (e0) {
      return 0;
    }
  }

  function setLastCloudUpdatedAt(ts) {
    try {
      localStorage.setItem(STORAGE_CLOUD_UPDATED, String(ts));
    } catch (e1) {}
  }

  function adoptCloudUpdatedAt(ts) {
    var n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return;
    if (n > getLastCloudUpdatedAt()) setLastCloudUpdatedAt(n);
  }

  function loadPresetCloudTimestamps() {
    try {
      var raw = localStorage.getItem(STORAGE_PRESET_CLOUD_TS);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e0) {
      return {};
    }
  }

  function savePresetCloudTimestamps(map) {
    try {
      localStorage.setItem(STORAGE_PRESET_CLOUD_TS, JSON.stringify(map || {}));
    } catch (e1) {}
  }

  function adoptPresetCloudTimestamps(cloudMap) {
    if (!cloudMap || typeof cloudMap !== "object") return;
    var local = loadPresetCloudTimestamps();
    var changed = false;
    for (var pid in cloudMap) {
      if (!Object.prototype.hasOwnProperty.call(cloudMap, pid)) continue;
      var ts = Number(cloudMap[pid]) || 0;
      if (ts > (Number(local[pid]) || 0)) {
        local[pid] = ts;
        changed = true;
      }
    }
    if (changed) savePresetCloudTimestamps(local);
  }

  function markPresetCloudPushed(presetIds, ts) {
    if (!presetIds || !presetIds.length) return;
    var now = Number(ts) || Date.now();
    var local = loadPresetCloudTimestamps();
    for (var i = 0; i < presetIds.length; i++) {
      var pid = String(presetIds[i]);
      if (!pid) continue;
      local[pid] = now;
    }
    savePresetCloudTimestamps(local);
  }

  /** 프리셋 내용이 실제로 바뀐 경우에만 덮어씀 (타이머 저장으로 인한 updatedAt 변화 무시) */
  function loadLocalPresetsList() {
    try {
      var raw = localStorage.getItem(STORAGE_PRESETS);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e0) {
      return [];
    }
  }

  var PRESET_REALTIME_COMPARE_KEYS = ["player", "entry", "entryChips", "regCloseLevel"];

  function presetForCloudCompare(p) {
    if (!p || typeof p !== "object") return p;
    var o = Object.assign({}, p);
    for (var i = 0; i < PRESET_REALTIME_COMPARE_KEYS.length; i++) {
      delete o[PRESET_REALTIME_COMPARE_KEYS[i]];
    }
    return o;
  }

  function presetsJsonEqual(aList, bList) {
    try {
      var aNorm = (aList || []).map(presetForCloudCompare);
      var bNorm = (bList || []).map(presetForCloudCompare);
      return JSON.stringify(aNorm) === JSON.stringify(bNorm);
    } catch (e1) {
      return false;
    }
  }

  function getMergedPresetsList() {
    var list = loadLocalPresetsList();
    if (list.length) return list;
    if (
      lastCloudPullData &&
      Array.isArray(lastCloudPullData.presets) &&
      lastCloudPullData.presets.length
    ) {
      return lastCloudPullData.presets;
    }
    return [];
  }

  function isPresetKnown(presetId) {
    if (!presetId) return false;
    if (findPresetById(loadLocalPresetsList(), presetId)) return true;
    if (
      lastCloudPullData &&
      findPresetById(lastCloudPullData.presets, presetId)
    ) {
      return true;
    }
    return false;
  }

  /** timer.html 부팅: URL id → 로컬/클라우드 프리셋 → fallback */
  function resolveBootPresetId() {
    var urlId = null;
    try {
      if (typeof location !== "undefined" && location.search) {
        urlId = new URLSearchParams(location.search).get("id");
      }
    } catch (e0) {}

    if (urlId && isPresetKnown(urlId)) return urlId;

    var list = getMergedPresetsList();
    if (list.length) {
      var aid = getActivePresetIdFromStorage();
      if (aid && findPresetById(list, aid)) return String(aid);
      return String(list[0].id);
    }

    return urlId || "preset_default";
  }

  function findPresetById(list, id) {
    if (!id || !Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  /**
   * 클라우드 프리셋을 presetId별 타임스탬프로 병합한다.
   * 로컬에 더 최신인 프리셋은 유지하고, 클라우드가 더 최신인 프리셋만 반영한다.
   */
  function mergeCloudPresetsIntoLocal(cloudPresets, cloudTimestamps) {
    cloudPresets = Array.isArray(cloudPresets) ? cloudPresets : [];
    cloudTimestamps = cloudTimestamps || {};
    if (!cloudPresets.length) return { merged: null, applied: false };

    var localList = loadLocalPresetsList();
    if (!localList.length) {
      var freshOut = cloudPresets.slice();
      var freshTs = loadPresetCloudTimestamps();
      for (var fi = 0; fi < cloudPresets.length; fi++) {
        var fp = cloudPresets[fi];
        if (!fp || !fp.id) continue;
        var fpid = String(fp.id);
        var ft = Number(cloudTimestamps[fpid]) || 0;
        if (ft > 0) freshTs[fpid] = ft;
      }
      savePresetCloudTimestamps(freshTs);
      return { merged: freshOut, applied: true };
    }
    var localTs = loadPresetCloudTimestamps();
    var localById = {};
    localList.forEach(function (p) {
      if (p && p.id) localById[p.id] = p;
    });

    var out = localList.slice();
    var outIndex = {};
    out.forEach(function (p, idx) {
      if (p && p.id) outIndex[p.id] = idx;
    });

    var changed = false;
    for (var i = 0; i < cloudPresets.length; i++) {
      var cloudP = cloudPresets[i];
      if (!cloudP || !cloudP.id) continue;
      var pid = String(cloudP.id);
      var cloudT = Number(cloudTimestamps[pid]) || 0;
      var localT = Number(localTs[pid]) || 0;
      if (cloudT > 0 && cloudT <= localT) continue;

      var mergedP =
        global.MetisTimer && global.MetisTimer.mergePresetRecord
          ? global.MetisTimer.mergePresetRecord(localById[pid], cloudP)
          : cloudP;

      if (outIndex[pid] !== undefined) {
        if (!presetsJsonEqual([out[outIndex[pid]]], [mergedP])) {
          out[outIndex[pid]] = mergedP;
          changed = true;
        }
      } else {
        out.push(mergedP);
        outIndex[pid] = out.length - 1;
        changed = true;
      }
      if (cloudT > 0) localTs[pid] = cloudT;
    }

    if (!changed) return { merged: localList, applied: false };
    savePresetCloudTimestamps(localTs);
    return { merged: out, applied: true };
  }

  function buildPresetsPushPayload(presets, options) {
    options = options || {};
    presets = Array.isArray(presets) ? presets : [];
    var now = Date.now();
    var pushList = [];
    var presetTimestamps = {};
    var deletedPresetIds = options.deletedPresetIds || null;

    if (options.pushAllPresets) {
      pushList = presets.slice();
      for (var i = 0; i < pushList.length; i++) {
        if (pushList[i] && pushList[i].id) {
          presetTimestamps[String(pushList[i].id)] = now;
        }
      }
    } else if (options.changedPresetIds && options.changedPresetIds.length) {
      for (var j = 0; j < options.changedPresetIds.length; j++) {
        var cid = String(options.changedPresetIds[j]);
        var cp = findPresetById(presets, cid);
        if (cp) {
          pushList.push(cp);
          presetTimestamps[cid] = now;
        }
      }
    } else if (options.activePresetId) {
      var ap = findPresetById(presets, String(options.activePresetId));
      if (ap) {
        pushList = [ap];
        presetTimestamps[String(options.activePresetId)] = now;
      }
    } else if (presets.length) {
      pushList = presets.slice();
      for (var k = 0; k < pushList.length; k++) {
        if (pushList[k] && pushList[k].id) {
          presetTimestamps[String(pushList[k].id)] = now;
        }
      }
    }

    return {
      presets: pushList,
      presetTimestamps: presetTimestamps,
      deletedPresetIds: deletedPresetIds,
      pushedPresetIds: Object.keys(presetTimestamps),
    };
  }

  function assetUrl(path) {
    var v =
      (global.__METIS_ASSET_V != null && String(global.__METIS_ASSET_V)) ||
      CONFIG.assetVersion ||
      "1";
    if (!path || path.indexOf("?") >= 0) return path;
    return path + "?v=" + encodeURIComponent(v);
  }

  function pushLocalPresetsToCloud() {
    try {
      var raw = localStorage.getItem(STORAGE_PRESETS);
      var active = localStorage.getItem(STORAGE_ACTIVE);
      if (!raw) return;
      var presets = JSON.parse(raw);
      if (Array.isArray(presets) && presets.length) {
        savePresetsToCloud(presets, active);
      }
    } catch (e1) {}
  }

  /** 클라우드 프리셋을 presetId별로 병합 (전체 덮어쓰기·activePresetId 적용 없음) */
  function applyCloudPresetsIfNewer(data, options) {
    options = options || {};
    var result = { applied: false, activePresetChanged: false };

    if (data && data.presetTimestamps) {
      adoptPresetCloudTimestamps(data.presetTimestamps);
    }

    if (data && Array.isArray(data.presets) && data.presets.length) {
      var mergeResult = mergeCloudPresetsIntoLocal(
        data.presets,
        data.presetTimestamps
      );
      if (mergeResult.applied && mergeResult.merged) {
        localStorage.setItem(STORAGE_PRESETS, JSON.stringify(mergeResult.merged));
        result.applied = true;
        if (
          global.MetisTimer &&
          global.MetisTimer.syncAllPresetsMetadataFromStorage
        ) {
          global.MetisTimer.syncAllPresetsMetadataFromStorage();
        }
      }
      adoptCloudUpdatedAt(data.updatedAt);
    }

    return result;
  }

  /** 이 기기가 클라우드보다 앞서 있을 때만 업로드 (역주행 push 차단) */
  function syncCloudWatermarkFromPull(data, applyResult) {
    if (!data) return;
    adoptCloudUpdatedAt(data.updatedAt);
    if (
      applyResult &&
      applyResult.applied &&
      applyResult.presetId &&
      data.timerStates
    ) {
      var sl = data.timerStates[applyResult.presetId];
      if (sl) {
        if (sl.lastActionTimestamp) adoptCloudUpdatedAt(sl.lastActionTimestamp);
        if (sl.controlUpdatedAt) adoptCloudUpdatedAt(sl.controlUpdatedAt);
        if (sl.timerUpdatedAt) adoptCloudUpdatedAt(sl.timerUpdatedAt);
        if (sl.statsUpdatedAt) adoptCloudUpdatedAt(sl.statsUpdatedAt);
        if (sl.updatedAt) adoptCloudUpdatedAt(sl.updatedAt);
      }
    }
  }

  function isCloudTimerAheadOfLocal(data) {
    if (
      !data ||
      !data.timerStates ||
      !global.MetisTimer ||
      !global.MetisTimer.timerGameplayRank
    ) {
      return false;
    }
    var presetId = resolveLocalTimerPresetId();
    if (!presetId) return false;
    var cloudSlice = data.timerStates[presetId];
    if (!cloudSlice) return false;
    global.MetisTimer.setSyncPresetId(presetId);
    var localState = global.MetisTimer.readSyncState();
    if (!localState) return false;
    var localSlice = global.MetisTimer.pickTimerSyncSlice(localState, presetId);
    return (
      global.MetisTimer.timerGameplayRank(cloudSlice) >
      global.MetisTimer.timerGameplayRank(localSlice)
    );
  }

  /** 이 기기가 클라우드보다 앞서 있을 때만 업로드 (역주행 push 차단) */
  function maybePushLocalIfAheadOfCloud(data) {
    if (!data) return;
    var cloudU = Number(data.updatedAt) || 0;
    var localU = getLastCloudUpdatedAt();
    var cloudAhead = isCloudTimerAheadOfLocal(data);
    syncDbg("PULL", "maybePushLocalIfAheadOfCloud", {
      localU: localU,
      cloudU: cloudU,
      localAhead: localU > cloudU,
      cloudTimerAhead: cloudAhead,
      willPushLocal: localU > cloudU && !cloudAhead,
    });
    if (localU > cloudU && cloudAhead) return;
    if (localU > cloudU) pushLocalPresetsToCloud();
  }

  function applyToLocal(data) {
    return applyCloudPresetsIfNewer(data, {}).applied;
  }

  function getActivePresetIdFromStorage() {
    try {
      return localStorage.getItem(STORAGE_ACTIVE) || "";
    } catch (e0) {
      return "";
    }
  }

  /** 클라우드 activePresetId는 사용하지 않음 — 항상 이 기기의 로컬 선택만 */
  function resolveLocalTimerPresetId() {
    if (cloudPollOptions && cloudPollOptions.pinnedPresetId) {
      return String(cloudPollOptions.pinnedPresetId);
    }
    var localActive = getActivePresetIdFromStorage();
    if (localActive) return localActive;
    if (global.MetisTimer && global.MetisTimer.getSyncPresetId) {
      var sid = global.MetisTimer.getSyncPresetId();
      if (sid) return String(sid);
    }
    return "";
  }

  function resolveTimerPresetId(options) {
    options = options || {};
    if (options.forcePresetId != null && String(options.forcePresetId) !== "") {
      return String(options.forcePresetId);
    }
    return resolveLocalTimerPresetId();
  }

  function updateCloudPollPinnedPreset(presetId) {
    if (!cloudPollOptions) cloudPollOptions = {};
    if (presetId != null && String(presetId) !== "") {
      cloudPollOptions.pinnedPresetId = String(presetId);
      cloudPollOptions.skipActivePresetMutation = true;
    } else {
      delete cloudPollOptions.pinnedPresetId;
    }
  }

  function emptyApplyResult() {
    return {
      applied: false,
      leveledUp: false,
      presetId: null,
      prevLevelIndex: 0,
      newLevelIndex: 0,
      activePresetChanged: false,
      presetsApplied: false,
    };
  }

  function processCloudFetchData(data, pollOptions) {
    pollOptions = pollOptions || cloudPollOptions || {};
    var pinnedId =
      pollOptions.pinnedPresetId != null && String(pollOptions.pinnedPresetId) !== ""
        ? String(pollOptions.pinnedPresetId)
        : resolveLocalTimerPresetId();

    lastCloudPullData = data;

    syncDbg("PULL", "1.processCloudFetchData:시작", {
      cloudUpdatedAt: data && data.updatedAt,
      localActivePresetId: getActivePresetIdFromStorage(),
      pinnedId: pinnedId || null,
      timerStatePresetIds: data && data.timerStates ? Object.keys(data.timerStates) : [],
      lastCloudUpdatedAtLocal: getLastCloudUpdatedAt(),
    });

    var applyResult = emptyApplyResult();
    if (data && data.timerStates && pinnedId) {
      syncDbg("PULL", "2.processCloudFetchData:클라우드슬라이스", {
        targetPresetId: pinnedId,
        cloudSlice: statsSnippet(data.timerStates[pinnedId]),
      });
      applyResult = applyTimerStatesFromCloud(data.timerStates, {
        forcePresetId: pinnedId,
      });
      syncDbg("PULL", "3.processCloudFetchData:applyTimerStates결과", applyResult);
    } else {
      syncDbg("PULL", "2.processCloudFetchData:timerStates없음또는로컬프리셋없음", {
        hasData: !!data,
        pinnedId: pinnedId,
      });
    }

    var presetResult = applyCloudPresetsIfNewer(data, {});
    syncDbg("PULL", "4.processCloudFetchData:프리셋적용", {
      presetsApplied: presetResult.applied,
    });
    syncCloudWatermarkFromPull(data, applyResult);
    maybePushLocalIfAheadOfCloud(data);
    applyResult.presetsApplied = presetResult.applied;

    if (presetResult.applied) {
      ensureTimerStateBootstrapped();
    }

    var finalApplied = applyResult.applied || presetResult.applied;
    syncDbg("PULL", "5.processCloudFetchData:완료", {
      applied: finalApplied,
      applyResult: applyResult,
      lastCloudUpdatedAtAfter: getLastCloudUpdatedAt(),
    });

    return {
      data: data,
      applyResult: applyResult,
      presetsApplied: presetResult.applied,
      applied: finalApplied,
    };
  }

  function snapshotTimerLevel(state) {
    if (!state || !state.timer) return 0;
    return Math.max(0, parseInt(state.timer.levelIndex, 10) || 0);
  }

  function getCloudSyncStatus() {
    var label = "동기화됨";
    if (cloudSyncState === "syncing") label = "동기화 중…";
    else if (cloudSyncState === "offline") label = "오프라인";
    else if (cloudSyncState === "idle") label = "대기";
    return {
      state: cloudSyncState,
      label: label,
      lastOkAt: cloudSyncLastOkAt,
      lastErrorAt: cloudSyncLastErrorAt,
    };
  }

  function notifyCloudSyncStatus() {
    var detail = getCloudSyncStatus();
    for (var i = 0; i < cloudSyncStatusListeners.length; i++) {
      try {
        cloudSyncStatusListeners[i](detail);
      } catch (e0) {}
    }
    if (typeof document !== "undefined") {
      try {
        document.dispatchEvent(
          new CustomEvent("metis-cloud-sync-status", { detail: detail })
        );
      } catch (e1) {}
    }
  }

  function setCloudSyncPhase(phase) {
    if (phase === "syncing") cloudSyncState = "syncing";
    else if (phase === "ok") {
      cloudSyncState = "synced";
      cloudSyncLastOkAt = Date.now();
    } else if (phase === "error") {
      cloudSyncState = "offline";
      cloudSyncLastErrorAt = Date.now();
    }
    notifyCloudSyncStatus();
  }

  function onCloudSyncStatusChange(cb) {
    if (typeof cb !== "function") return function () {};
    cloudSyncStatusListeners.push(cb);
    cb(getCloudSyncStatus());
    return function () {
      var idx = cloudSyncStatusListeners.indexOf(cb);
      if (idx >= 0) cloudSyncStatusListeners.splice(idx, 1);
    };
  }

  function bindCloudSyncBadge(elementId) {
    var el =
      typeof elementId === "string"
        ? document.getElementById(elementId)
        : elementId;
    if (!el) return function () {};
    return onCloudSyncStatusChange(function (status) {
      el.dataset.state = status.state;
      var labelEl = el.querySelector(".cloud-sync-label");
      if (labelEl) labelEl.textContent = status.label;
      el.title =
        status.lastOkAt > 0
          ? "마지막 동기화: " + new Date(status.lastOkAt).toLocaleTimeString("ko-KR")
          : "클라우드 동기화";
    });
  }

  /**
   * 클라우드 timerStates 중 지정 프리셋 슬라이스를 로컬에 반영한다.
   * @returns {{ applied: boolean, leveledUp: boolean, presetId: string|null, ... }}
   */
  function applyTimerStatesFromCloud(timerStates, options) {
    var result = emptyApplyResult();
    if (!timerStates || typeof timerStates !== "object") {
      syncDbg("PULL", "applyTimerStatesFromCloud:timerStates없음");
      return result;
    }
    if (!global.MetisTimer || !global.MetisTimer.applyTimerSyncSlice) {
      syncDbg("PULL", "applyTimerStatesFromCloud:MetisTimer없음");
      return result;
    }

    options = options || {};
    var presetId = resolveTimerPresetId(options);
    if (!presetId) {
      syncDbg("PULL", "applyTimerStatesFromCloud:presetId없음", options);
      return result;
    }

    var cloudSlice = timerStates[presetId];
    if (!cloudSlice || typeof cloudSlice !== "object") {
      syncDbg("PULL", "applyTimerStatesFromCloud:cloudSlice없음", {
        presetId: presetId,
        availableIds: Object.keys(timerStates),
      });
      return result;
    }

    global.MetisTimer.setSyncPresetId(presetId);
    var localState = global.MetisTimer.readSyncState();
    if (!localState) {
      syncDbg("PULL", "applyTimerStatesFromCloud:localState없음", { presetId: presetId });
      return result;
    }

    var localSlice =
      global.MetisTimer.pickTimerSyncSlice &&
      global.MetisTimer.pickTimerSyncSlice(localState, presetId);
    syncDbg("PULL", "applyTimerStatesFromCloud:병합전", {
      presetId: presetId,
      localSlice: statsSnippet(localSlice),
      cloudSlice: statsSnippet(cloudSlice),
    });

    var prevLevelIndex = snapshotTimerLevel(localState);
    if (!global.MetisTimer.applyTimerSyncSlice(localState, cloudSlice)) {
      syncDbg("PULL", "applyTimerStatesFromCloud:applyTimerSyncSlice거부", {
        presetId: presetId,
      });
      return result;
    }

    var appliedU = global.MetisTimer.timerSyncUpdatedAt(cloudSlice);
    var appliedTU = global.MetisTimer.sliceTimerUpdatedAt(cloudSlice);
    var appliedSU = global.MetisTimer.sliceStatsUpdatedAt(cloudSlice);
    var appliedCU =
      global.MetisTimer.sliceControlUpdatedAt &&
      global.MetisTimer.sliceControlUpdatedAt(cloudSlice);
    var appliedLA =
      global.MetisTimer.sliceLastActionAt &&
      global.MetisTimer.sliceLastActionAt(cloudSlice);
    if (appliedTU > 0) localState.timerUpdatedAt = appliedTU;
    else if (appliedU > 0) localState.timerUpdatedAt = appliedU;
    if (appliedLA > 0) localState.lastActionTimestamp = appliedLA;
    if (appliedCU > 0) localState.controlUpdatedAt = appliedCU;
    else if (appliedLA > 0) localState.controlUpdatedAt = appliedLA;
    else if (appliedTU > 0) localState.controlUpdatedAt = appliedTU;
    if (appliedSU > 0) localState.statsUpdatedAt = appliedSU;
    else if (appliedU > 0) localState.statsUpdatedAt = appliedU;

    global.MetisTimer.writeSyncState(localState, {
      skipCloudPush: true,
      preserveUpdatedAt: true,
    });

    var newLevelIndex = snapshotTimerLevel(localState);
    result.applied = true;
    result.presetId = presetId;
    result.prevLevelIndex = prevLevelIndex;
    result.newLevelIndex = newLevelIndex;
    result.leveledUp = newLevelIndex > prevLevelIndex;
    syncDbg("PULL", "applyTimerStatesFromCloud:병합후로컬저장", {
      presetId: presetId,
      mergedSlice: statsSnippet(
        global.MetisTimer.pickTimerSyncSlice(localState, presetId)
      ),
      leveledUp: result.leveledUp,
    });
    return result;
  }

  function flushTimerSave() {
    if (!pendingTimerSave) {
      syncDbg("PUSH", "flushTimerSave:대기페이로드없음");
      return Promise.resolve(null);
    }
    var payload = pendingTimerSave;
    pendingTimerSave = null;
    syncDbg("PUSH", "flushTimerSave:POST시작", {
      presetId: payload.presetId,
      timerState: statsSnippet(payload.timerState),
      url: CONFIG.url,
    });
    return fetch(CONFIG.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: CONFIG.token,
        presetId: payload.presetId,
        timerState: payload.timerState,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("POST timerState failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        setCloudSyncPhase("ok");
        syncDbg("PUSH", "flushTimerSave:POST성공", {
          ok: data && data.ok,
          updatedAt: data && data.updatedAt,
          savedSlice: data && data.timerStates && payload.presetId
            ? statsSnippet(data.timerStates[payload.presetId])
            : null,
          lastCloudUpdatedAtAfter: getLastCloudUpdatedAt(),
        });
        if (data && data.updatedAt) adoptCloudUpdatedAt(data.updatedAt);
        return data;
      })
      .catch(function (err) {
        syncDbg("PUSH", "flushTimerSave:POST실패", {
          presetId: payload.presetId,
          error: String(err && err.message ? err.message : err),
        });
        console.warn("[MetisSheetSync] 타이머 클라우드 저장 실패:", err);
        setCloudSyncPhase("error");
        return null;
      });
  }

  function saveTimerStateToCloud(presetId, slice, options) {
    options = options || {};
    if (!presetId || !slice || typeof slice !== "object") {
      syncDbg("PUSH", "saveTimerStateToCloud:스킵(인자부족)", {
        presetId: presetId,
        hasSlice: !!slice,
      });
      return;
    }
    syncDbg("PUSH", "saveTimerStateToCloud:큐등록", {
      presetId: String(presetId),
      slice: statsSnippet(slice),
      urgent: !!options.urgent,
      delayMs: options.urgent ? 0 : CLOUD_PUSH_DEBOUNCE_MS,
    });
    pendingTimerSave = {
      presetId: String(presetId),
      timerState: slice,
    };
    if (timerSaveTimer) clearTimeout(timerSaveTimer);
    timerSaveTimer = null;
    var delay = options.urgent ? 0 : CLOUD_PUSH_DEBOUNCE_MS;
    if (delay <= 0) {
      setCloudSyncPhase("syncing");
      flushTimerSave();
      return;
    }
    timerSaveTimer = setTimeout(function () {
      timerSaveTimer = null;
      setCloudSyncPhase("syncing");
      flushTimerSave();
    }, delay);
  }

  function getCloudPollIntervalMs() {
    if (typeof document !== "undefined" && document.hidden) {
      return CLOUD_POLL_MS_HIDDEN;
    }
    if (global.MetisTimer && global.MetisTimer.readSyncState) {
      var s = global.MetisTimer.readSyncState();
      if (!s) return CLOUD_POLL_MS_IDLE;
      if (s.timer && (s.timer.isRunning || s.timer.bridge)) {
        return CLOUD_POLL_MS_ACTIVE;
      }
      if (s.hasStartedOnce && (s.timerStatus || "") !== "대기중") {
        return CLOUD_POLL_MS_ACTIVE;
      }
    }
    return CLOUD_POLL_MS_IDLE;
  }

  function notifyCloudPollResult(result) {
    if (!result || typeof cloudPollOnApplied !== "function") {
      syncDbg("PULL", "6.cloudPoll:콜백스킵", {
        hasResult: !!result,
        hasOnApplied: typeof cloudPollOnApplied === "function",
      });
      return;
    }
    var ar = result.applyResult || emptyApplyResult();
    var willNotify =
      result.applied || result.presetsApplied || ar.leveledUp;
    syncDbg("PULL", "6.cloudPoll:콜백판단", {
      willNotify: willNotify,
      applied: result.applied,
      presetsApplied: result.presetsApplied,
      leveledUp: ar.leveledUp,
    });
    if (willNotify) cloudPollOnApplied(result);
  }

  function scheduleNextCloudPoll(afterMs) {
    if (!cloudPollRunning) return;
    if (cloudPollTimer) clearTimeout(cloudPollTimer);
    cloudPollTimer = setTimeout(runCloudPollCycle, afterMs);
  }

  function runCloudPollCycle() {
    if (!cloudPollRunning) return;
    cloudPollTimer = null;
    if (cloudPollInFlight) {
      scheduleNextCloudPoll(getCloudPollIntervalMs());
      return;
    }
    cloudPollInFlight = true;
    var startedAt = Date.now();
    pollTimerStatesFromCloud()
      .then(notifyCloudPollResult)
      .finally(function () {
        cloudPollInFlight = false;
        if (!cloudPollRunning) return;
        var elapsed = Date.now() - startedAt;
        var delay = Math.max(
          CLOUD_POLL_MIN_GAP_MS,
          getCloudPollIntervalMs() - elapsed
        );
        scheduleNextCloudPoll(delay);
      });
  }

  function onCloudVisibilityChange() {
    if (!cloudPollRunning || typeof document === "undefined") return;
    if (document.hidden) return;
    if (cloudPollTimer) clearTimeout(cloudPollTimer);
    cloudPollTimer = null;
    runCloudPollCycle();
  }

  function bindCloudVisibilitySync() {
    if (cloudVisibilityBound || typeof document === "undefined") return;
    cloudVisibilityBound = true;
    document.addEventListener("visibilitychange", onCloudVisibilityChange);
  }

  function unbindCloudVisibilitySync() {
    if (!cloudVisibilityBound || typeof document === "undefined") return;
    cloudVisibilityBound = false;
    document.removeEventListener("visibilitychange", onCloudVisibilityChange);
  }

  function pollTimerStatesFromCloud(pollOptions) {
    pollOptions = pollOptions || cloudPollOptions || {};

    syncDbg("PULL", "0.pollTimerStatesFromCloud:GET시작", {
      pollOptions: pollOptions,
      intervalMs: getCloudPollIntervalMs(),
    });
    setCloudSyncPhase("syncing");
    return fetch(CONFIG.url, { method: "GET", cache: "no-store" })
      .then(function (res) {
        syncDbg("PULL", "0.pollTimerStatesFromCloud:GET응답", {
          ok: res.ok,
          status: res.status,
        });
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        lastCloudPullData = data;
        syncDbg("PULL", "0.pollTimerStatesFromCloud:GET본문", {
          updatedAt: data && data.updatedAt,
          localActivePresetId: getActivePresetIdFromStorage(),
          timerStateIds: data && data.timerStates ? Object.keys(data.timerStates) : [],
        });
        var result = processCloudFetchData(data, pollOptions);
        setCloudSyncPhase("ok");
        return result;
      })
      .catch(function (err) {
        syncDbg("PULL", "0.pollTimerStatesFromCloud:GET실패", {
          error: String(err && err.message ? err.message : err),
        });
        console.warn("[MetisSheetSync] 타이머 클라우드 불러오기 실패:", err);
        setCloudSyncPhase("error");
        return {
          data: null,
          applyResult: emptyApplyResult(),
          presetsApplied: false,
          applied: false,
        };
      });
  }

  /** 프리셋 전환 시 해당 프리셋의 클라우드 타이머 상태를 가져와 반영 */
  function pullAndApplyPresetTimerState(presetId) {
    if (!presetId) return Promise.resolve(emptyApplyResult());
    if (global.MetisTimer && global.MetisTimer.setSyncPresetId) {
      global.MetisTimer.setSyncPresetId(String(presetId));
    }
    updateCloudPollPinnedPreset(presetId);
    setCloudSyncPhase("syncing");
    return fetch(CONFIG.url, { method: "GET", cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var result = processCloudFetchData(data, {
          pinnedPresetId: String(presetId),
        });
        setCloudSyncPhase("ok");
        return result.applyResult || emptyApplyResult();
      })
      .catch(function (err) {
        console.warn("[MetisSheetSync] 프리셋 타이머 불러오기 실패:", err);
        setCloudSyncPhase("error");
        return emptyApplyResult();
      });
  }

  function scheduleCloudTimerPoll() {
    if (!cloudPollRunning) return;
    scheduleNextCloudPoll(0);
  }

  function startCloudTimerSync(onApplied, options) {
    cloudPollOnApplied = typeof onApplied === "function" ? onApplied : null;
    cloudPollOptions = options && typeof options === "object" ? options : {};
    if (!cloudPollOptions.pinnedPresetId) {
      var localActive = getActivePresetIdFromStorage();
      if (localActive) cloudPollOptions.pinnedPresetId = localActive;
    }
    cloudPollOptions.skipActivePresetMutation = true;
    syncDbg("PULL", "startCloudTimerSync", {
      alreadyRunning: cloudPollRunning,
      pollOptions: cloudPollOptions,
    });
    if (cloudPollRunning) return;
    cloudPollRunning = true;
    bindCloudVisibilitySync();
    setCloudSyncPhase("syncing");
    scheduleCloudTimerPoll();
  }

  function stopCloudTimerSync() {
    cloudPollRunning = false;
    cloudPollOnApplied = null;
    cloudPollOptions = null;
    cloudPollInFlight = false;
    unbindCloudVisibilitySync();
    if (cloudPollTimer) {
      clearTimeout(cloudPollTimer);
      cloudPollTimer = null;
    }
  }

  function fetchCloudDataOnce() {
    return fetch(CONFIG.url, { method: "GET", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("GET failed: " + res.status);
      return res.json();
    });
  }

  /** 프리셋이 늦게 도착했을 때 타이머 상태를 처음부터 생성 */
  function ensureTimerStateBootstrapped() {
    if (!global.MetisTimer || !global.MetisTimer.readSyncState) return false;

    var presetId =
      global.__METIS_TIMER_PRESET_ID != null && global.__METIS_TIMER_PRESET_ID !== ""
        ? String(global.__METIS_TIMER_PRESET_ID)
        : resolveBootPresetId();
    if (!presetId || !isPresetKnown(presetId)) return false;

    global.MetisTimer.setSyncPresetId(presetId);
    var hadState = false;
    try {
      var key =
        global.MetisTimer.getSyncStorageKey &&
        global.MetisTimer.getSyncStorageKey();
      hadState = !!(key && localStorage.getItem(key));
    } catch (e0) {}

    var state = global.MetisTimer.readSyncState();
    if (!state) return false;

    if (
      !hadState &&
      lastCloudPullData &&
      lastCloudPullData.timerStates &&
      lastCloudPullData.timerStates[presetId]
    ) {
      applyTimerStatesFromCloud(lastCloudPullData.timerStates, {
        forcePresetId: presetId,
      });
    }

    if (typeof document !== "undefined") {
      try {
        document.dispatchEvent(new Event("metis-presets-bootstrapped"));
      } catch (e1) {}
    }
    return true;
  }

  function pullPresetsToLocal(options) {
    options = options || {};
    if (pullPromise && !options.force) return pullPromise;

    var maxAttempts = options.retries != null ? Number(options.retries) : 3;
    if (!Number.isFinite(maxAttempts) || maxAttempts < 1) maxAttempts = 1;

    function attempt(tryIndex) {
      return fetchCloudDataOnce()
        .then(function (data) {
          processCloudFetchData(data, { skipActivePresetMutation: true });
          setCloudSyncPhase("ok");
          return data;
        })
        .catch(function (err) {
          syncDbg("PULL", "pullPresetsToLocal:실패", {
            attempt: tryIndex + 1,
            maxAttempts: maxAttempts,
            error: String(err && err.message ? err.message : err),
          });
          if (tryIndex + 1 < maxAttempts) {
            var delay =
              CLOUD_PULL_RETRY_DELAYS_MS[tryIndex + 1] != null
                ? CLOUD_PULL_RETRY_DELAYS_MS[tryIndex + 1]
                : 1500;
            return new Promise(function (resolve) {
              setTimeout(resolve, delay);
            }).then(function () {
              return attempt(tryIndex + 1);
            });
          }
          console.warn(
            "[MetisSheetSync] 클라우드 불러오기 실패, 로컬 데이터 사용:",
            err
          );
          setCloudSyncPhase("error");
          pullPromise = null;
          return null;
        });
    }

    pullPromise = attempt(0);
    return pullPromise;
  }

  function flushSave() {
    if (!pendingSave) return Promise.resolve(null);
    var payload = pendingSave;
    pendingSave = null;
    var body = {
      token: CONFIG.token,
    };
    if (payload.presets && payload.presets.length) {
      body.presets = payload.presets;
    }
    if (payload.presetTimestamps) {
      body.presetTimestamps = payload.presetTimestamps;
    }
    if (payload.deletedPresetIds && payload.deletedPresetIds.length) {
      body.deletedPresetIds = payload.deletedPresetIds;
    }
    return fetch(CONFIG.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("POST failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.updatedAt) adoptCloudUpdatedAt(data.updatedAt);
        if (data && data.presetTimestamps) {
          adoptPresetCloudTimestamps(data.presetTimestamps);
        }
        if (payload.pushedPresetIds && payload.pushedPresetIds.length) {
          markPresetCloudPushed(payload.pushedPresetIds, Date.now());
        }
        return data;
      })
      .catch(function (err) {
        console.warn("[MetisSheetSync] 클라우드 저장 실패:", err);
        return null;
      });
  }

  function savePresetsToCloud(presets, activePresetId, options) {
    options = options || {};
    var built = buildPresetsPushPayload(presets, {
      activePresetId: activePresetId,
      pushAllPresets: !!options.pushAllPresets,
      changedPresetIds: options.changedPresetIds || null,
      deletedPresetIds: options.deletedPresetIds || null,
    });
    if (!built.presets.length && !(built.deletedPresetIds && built.deletedPresetIds.length)) {
      return;
    }
    pendingSave = built;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      flushSave();
    }, options.urgent ? 80 : 400);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = assetUrl(src);
      s.async = false;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("script load failed: " + src));
      };
      document.body.appendChild(s);
    });
  }

  /** timer.html: 클라우드 pull → preset id 결정 → timer-core/metis-audio 순차 로드 */
  function bootTimerPage(resolvePresetIdFn) {
    var resolveId =
      typeof resolvePresetIdFn === "function"
        ? resolvePresetIdFn
        : resolveBootPresetId;

    return pullPresetsToLocal({ retries: 3 })
      .catch(function () {
        return null;
      })
      .then(function () {
        window.__METIS_TIMER_PRESET_ID = resolveId();
        return loadScript("timer-core.js");
      })
      .then(function () {
        if (global.MetisTimer && global.MetisTimer.syncAllPresetsMetadataFromStorage) {
          global.MetisTimer.syncAllPresetsMetadataFromStorage();
        }
        ensureTimerStateBootstrapped();
        if (lastCloudPullData && lastCloudPullData.timerStates) {
          var bootPresetId =
            window.__METIS_TIMER_PRESET_ID != null
              ? String(window.__METIS_TIMER_PRESET_ID)
              : "";
          if (bootPresetId) {
            applyTimerStatesFromCloud(lastCloudPullData.timerStates, {
              forcePresetId: bootPresetId,
            });
          }
        }
        return loadScript("metis-audio.js");
      })
      .then(function () {
        window.__METIS_TIMER_BOOT_DONE = true;
        window.dispatchEvent(new Event("metis-timer-boot-done"));
      })
      .catch(function (err) {
        console.warn("[MetisSheetSync] 타이머 부팅 실패:", err);
        window.__METIS_TIMER_PRESET_ID =
          typeof resolveId === "function" ? resolveId() : "preset_default";
        window.__METIS_TIMER_BOOT_DONE = true;
        window.dispatchEvent(new Event("metis-timer-boot-done"));
      });
  }

  global.MetisSheetSync = {
    ASSET_VERSION: CONFIG.assetVersion,
    assetUrl: assetUrl,
    updateCloudPollPinnedPreset: updateCloudPollPinnedPreset,
    pullPresetsToLocal: pullPresetsToLocal,
    savePresetsToCloud: savePresetsToCloud,
    saveTimerStateToCloud: saveTimerStateToCloud,
    pollTimerStatesFromCloud: pollTimerStatesFromCloud,
    pullAndApplyPresetTimerState: pullAndApplyPresetTimerState,
    applyTimerStatesFromCloud: applyTimerStatesFromCloud,
    applyCloudPresetsIfNewer: applyCloudPresetsIfNewer,
    startCloudTimerSync: startCloudTimerSync,
    stopCloudTimerSync: stopCloudTimerSync,
    getCloudSyncStatus: getCloudSyncStatus,
    onCloudSyncStatusChange: onCloudSyncStatusChange,
    bindCloudSyncBadge: bindCloudSyncBadge,
    applyToLocal: applyToLocal,
    bootTimerPage: bootTimerPage,
    resolveBootPresetId: resolveBootPresetId,
    ensureTimerStateBootstrapped: ensureTimerStateBootstrapped,
    getLastCloudUpdatedAt: getLastCloudUpdatedAt,
    getLastCloudPullData: function () {
      return lastCloudPullData;
    },
  };
})(typeof window !== "undefined" ? window : this);
