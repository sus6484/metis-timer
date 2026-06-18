/**
 * Metis — Google Sheets 프리셋·타이머 동기화 (Apps Script Web App)
 * timerStates: 프리셋별 실시간 타이머 상태 (pickTimerSyncSlice, 3단계에서 연결)
 */
(function (global) {
  "use strict";

  var CONFIG = {
    url: "https://script.google.com/macros/s/AKfycbwEr9geWitJJG2bHHV-w1DGCZh3MhvzibcNP4Nym5yNnZ4hJnruSshvk3ATMqPCX8gHpQ/exec",
    token: "metis_secret_444444",
    assetVersion: "20260622",
  };

  var STORAGE_PRESETS = "metis_blindPresets";
  var STORAGE_ACTIVE = "metis_activePresetId";
  var STORAGE_CLOUD_UPDATED = "metis_lastCloudUpdatedAt";

  var pullPromise = null;
  var saveTimer = null;
  var pendingSave = null;
  var lastCloudPullData = null;

  var timerSaveTimer = null;
  var pendingTimerSave = null;
  var cloudPollTimer = null;
  var cloudPollOnApplied = null;
  var cloudPollRunning = false;
  /** timer.html: { pinnedPresetId } — 이 창은 해당 프리셋만 동기화 */
  var cloudPollOptions = null;

  var cloudSyncState = "idle";
  var cloudSyncLastOkAt = 0;
  var cloudSyncLastErrorAt = 0;
  var cloudSyncStatusListeners = [];

  /** 로컬 프리셋 전환 직후 클라우드 activePresetId가 되돌리는 것 방지 */
  var pendingLocalActivePresetId = null;
  var localActivePresetSwitchAt = 0;
  var ACTIVE_PRESET_GUARD_MS = 5000;

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

  function markLocalActivePresetSwitch(id) {
    if (id == null || id === "") {
      pendingLocalActivePresetId = null;
      return;
    }
    pendingLocalActivePresetId = String(id);
    localActivePresetSwitchAt = Date.now();
    var ahead = Date.now();
    if (ahead > getLastCloudUpdatedAt()) setLastCloudUpdatedAt(ahead);
  }

  function shouldGuardLocalActivePreset() {
    if (pendingLocalActivePresetId) return true;
    if (!localActivePresetSwitchAt) return false;
    return Date.now() - localActivePresetSwitchAt < ACTIVE_PRESET_GUARD_MS;
  }

  function getGuardedLocalActivePresetId() {
    if (!shouldGuardLocalActivePreset()) return "";
    return pendingLocalActivePresetId || getActivePresetIdFromStorage();
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

  function presetsJsonEqual(cloudList, localList) {
    try {
      var cloudNorm = (cloudList || []).map(presetForCloudCompare);
      var localNorm = (localList || []).map(presetForCloudCompare);
      return JSON.stringify(cloudNorm) === JSON.stringify(localNorm);
    } catch (e1) {
      return false;
    }
  }

  function shouldApplyCloudPresets(data) {
    if (!data || !Array.isArray(data.presets) || !data.presets.length) return false;
    if (getLastCloudUpdatedAt() === 0) return true;
    return !presetsJsonEqual(data.presets, loadLocalPresetsList());
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

  /** 클라우드가 최신일 때 로컬 프리셋을 통째로 덮어씀 (병합 없음) */
  function applyCloudPresetsIfNewer(data, options) {
    options = options || {};
    var result = { applied: false, activePresetChanged: false };

    if (shouldApplyCloudPresets(data)) {
      if (Array.isArray(data.presets) && data.presets.length > 0) {
        localStorage.setItem(STORAGE_PRESETS, JSON.stringify(data.presets));
        result.applied = true;
      }
      adoptCloudUpdatedAt(data.updatedAt);
      if (
        result.applied &&
        global.MetisTimer &&
        global.MetisTimer.syncAllPresetsMetadataFromStorage
      ) {
        global.MetisTimer.syncAllPresetsMetadataFromStorage();
      }
    }

    var skipActive =
      !!options.skipActivePresetMutation || !!options.pinnedPresetId;
    if (
      !skipActive &&
      !shouldGuardLocalActivePreset() &&
      data &&
      data.activePresetId != null &&
      String(data.activePresetId) !== ""
    ) {
      var nextActive = String(data.activePresetId);
      var curActive = getActivePresetIdFromStorage();
      if (curActive !== nextActive) {
        result.activePresetChanged = true;
        localStorage.setItem(STORAGE_ACTIVE, nextActive);
        if (global.MetisTimer && global.MetisTimer.setSyncPresetId) {
          global.MetisTimer.setSyncPresetId(nextActive);
        }
        if (
          global.MetisTimer &&
          global.MetisTimer.applyActivePresetMetadataOnSwitch
        ) {
          global.MetisTimer.applyActivePresetMetadataOnSwitch(nextActive);
        }
      }
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
      if (sl && sl.updatedAt) adoptCloudUpdatedAt(sl.updatedAt);
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
    var presetId = resolveTimerPresetId({
      activePresetId: data.activePresetId,
    });
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
    if (localU > cloudU && isCloudTimerAheadOfLocal(data)) return;
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

  function resolveTimerPresetId(options) {
    options = options || {};
    if (options.activePresetId != null && String(options.activePresetId) !== "") {
      return String(options.activePresetId);
    }
    if (global.MetisTimer && global.MetisTimer.getSyncPresetId) {
      var sid = global.MetisTimer.getSyncPresetId();
      if (sid) return String(sid);
    }
    return getActivePresetIdFromStorage();
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
        : "";
    var skipActiveMutation =
      !!pollOptions.skipActivePresetMutation || !!pinnedId;

    lastCloudPullData = data;

    var applyResult = emptyApplyResult();
    if (data && data.timerStates) {
      var applyOpts = {};
      if (pinnedId) {
        applyOpts.forcePresetId = pinnedId;
      } else {
        var guardedActive = getGuardedLocalActivePresetId();
        applyOpts.activePresetId =
          guardedActive ||
          (data.activePresetId != null ? data.activePresetId : undefined);
      }
      applyResult = applyTimerStatesFromCloud(data.timerStates, applyOpts);
    }

    var presetResult = applyCloudPresetsIfNewer(data, {
      skipActivePresetMutation: skipActiveMutation,
      pinnedPresetId: pinnedId,
    });
    syncCloudWatermarkFromPull(data, applyResult);
    maybePushLocalIfAheadOfCloud(data);
    applyResult.activePresetChanged =
      presetResult.activePresetChanged || applyResult.activePresetChanged;
    applyResult.presetsApplied = presetResult.applied;

    return {
      data: data,
      applyResult: applyResult,
      presetsApplied: presetResult.applied,
      applied: applyResult.applied || presetResult.applied,
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
    if (!timerStates || typeof timerStates !== "object") return result;
    if (!global.MetisTimer || !global.MetisTimer.applyTimerSyncSlice) return result;

    options = options || {};
    var presetId =
      options.forcePresetId != null && String(options.forcePresetId) !== ""
        ? String(options.forcePresetId)
        : resolveTimerPresetId(options);
    if (!presetId) return result;

    var cloudSlice = timerStates[presetId];
    if (!cloudSlice || typeof cloudSlice !== "object") return result;

    global.MetisTimer.setSyncPresetId(presetId);
    var localState = global.MetisTimer.readSyncState();
    if (!localState) return result;

    var prevLevelIndex = snapshotTimerLevel(localState);
    if (!global.MetisTimer.applyTimerSyncSlice(localState, cloudSlice)) return result;

    var appliedU = global.MetisTimer.timerSyncUpdatedAt(cloudSlice);
    if (appliedU > 0) localState.updatedAt = appliedU;

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
    return result;
  }

  function flushTimerSave() {
    if (!pendingTimerSave) return Promise.resolve(null);
    var payload = pendingTimerSave;
    pendingTimerSave = null;
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
        if (data && data.updatedAt) adoptCloudUpdatedAt(data.updatedAt);
        return data;
      })
      .catch(function (err) {
        console.warn("[MetisSheetSync] 타이머 클라우드 저장 실패:", err);
        setCloudSyncPhase("error");
        return null;
      });
  }

  function saveTimerStateToCloud(presetId, slice) {
    if (!presetId || !slice || typeof slice !== "object") return;
    pendingTimerSave = {
      presetId: String(presetId),
      timerState: slice,
    };
    if (timerSaveTimer) clearTimeout(timerSaveTimer);
    timerSaveTimer = setTimeout(function () {
      timerSaveTimer = null;
      setCloudSyncPhase("syncing");
      flushTimerSave();
    }, 350);
  }

  function getCloudPollIntervalMs() {
    if (typeof document !== "undefined" && document.hidden) return 3000;
    if (global.MetisTimer && global.MetisTimer.readSyncState) {
      var s = global.MetisTimer.readSyncState();
      if (!s) return 2000;
      if (s.timer && (s.timer.isRunning || s.timer.bridge)) return 800;
      if (s.hasStartedOnce && (s.timerStatus || "") !== "대기중") return 800;
    }
    return 2000;
  }

  function pollTimerStatesFromCloud(pollOptions) {
    pollOptions = pollOptions || cloudPollOptions || {};

    setCloudSyncPhase("syncing");
    return fetch(CONFIG.url, { method: "GET", cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        lastCloudPullData = data;
        var result = processCloudFetchData(data, pollOptions);
        setCloudSyncPhase("ok");
        return result;
      })
      .catch(function (err) {
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
    setCloudSyncPhase("syncing");
    return fetch(CONFIG.url, { method: "GET", cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var result = processCloudFetchData(data, {
          skipActivePresetMutation: true,
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
    if (cloudPollTimer) clearTimeout(cloudPollTimer);
    cloudPollTimer = setTimeout(function () {
      cloudPollTimer = null;
      pollTimerStatesFromCloud()
        .then(function (result) {
          if (!result || typeof cloudPollOnApplied !== "function") return;
          var ar = result.applyResult || emptyApplyResult();
          if (
            result.applied ||
            result.presetsApplied ||
            ar.activePresetChanged ||
            ar.leveledUp
          ) {
            cloudPollOnApplied(result);
          }
        })
        .finally(scheduleCloudTimerPoll);
    }, getCloudPollIntervalMs());
  }

  function startCloudTimerSync(onApplied, options) {
    cloudPollOnApplied = typeof onApplied === "function" ? onApplied : null;
    cloudPollOptions = options && typeof options === "object" ? options : null;
    if (cloudPollRunning) return;
    cloudPollRunning = true;
    setCloudSyncPhase("syncing");
    scheduleCloudTimerPoll();
  }

  function stopCloudTimerSync() {
    cloudPollRunning = false;
    cloudPollOnApplied = null;
    cloudPollOptions = null;
    if (cloudPollTimer) {
      clearTimeout(cloudPollTimer);
      cloudPollTimer = null;
    }
  }

  function pullPresetsToLocal() {
    if (pullPromise) return pullPromise;
    pullPromise = fetch(CONFIG.url, { method: "GET", cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        processCloudFetchData(data, {});
        return data;
      })
      .catch(function (err) {
        console.warn("[MetisSheetSync] 클라우드 불러오기 실패, 로컬 데이터 사용:", err);
        return null;
      });
    return pullPromise;
  }

  function flushSave() {
    if (!pendingSave) return Promise.resolve(null);
    var payload = pendingSave;
    pendingSave = null;
    return fetch(CONFIG.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: CONFIG.token,
        presets: payload.presets,
        activePresetId: payload.activePresetId,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("POST failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.updatedAt) adoptCloudUpdatedAt(data.updatedAt);
        if (data) pendingLocalActivePresetId = null;
        return data;
      })
      .catch(function (err) {
        console.warn("[MetisSheetSync] 클라우드 저장 실패:", err);
        return null;
      });
  }

  function savePresetsToCloud(presets, activePresetId, options) {
    options = options || {};
    var nextActive =
      activePresetId != null && activePresetId !== ""
        ? String(activePresetId)
        : undefined;
    if (options.activePresetChanged && nextActive) {
      markLocalActivePresetSwitch(nextActive);
    }
    pendingSave = {
      presets: presets,
      activePresetId: nextActive,
    };
    if (saveTimer) clearTimeout(saveTimer);
    var fastActivePush = !!(options.activePresetChanged && nextActive);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      flushSave();
    }, fastActivePush ? 80 : 400);
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
    return pullPresetsToLocal()
      .catch(function () {
        return null;
      })
      .then(function () {
        window.__METIS_TIMER_PRESET_ID = resolvePresetIdFn();
        return loadScript("timer-core.js");
      })
      .then(function () {
        if (global.MetisTimer && global.MetisTimer.syncAllPresetsMetadataFromStorage) {
          global.MetisTimer.syncAllPresetsMetadataFromStorage();
        }
        if (lastCloudPullData && lastCloudPullData.timerStates) {
          var bootPresetId =
            window.__METIS_TIMER_PRESET_ID != null
              ? String(window.__METIS_TIMER_PRESET_ID)
              : "";
          applyTimerStatesFromCloud(lastCloudPullData.timerStates, bootPresetId
            ? { forcePresetId: bootPresetId }
            : { activePresetId: lastCloudPullData.activePresetId });
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
          typeof resolvePresetIdFn === "function"
            ? resolvePresetIdFn()
            : "preset_default";
        window.__METIS_TIMER_BOOT_DONE = true;
        window.dispatchEvent(new Event("metis-timer-boot-done"));
      });
  }

  global.MetisSheetSync = {
    ASSET_VERSION: CONFIG.assetVersion,
    assetUrl: assetUrl,
    markLocalActivePresetSwitch: markLocalActivePresetSwitch,
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
    getLastCloudUpdatedAt: getLastCloudUpdatedAt,
    getLastCloudPullData: function () {
      return lastCloudPullData;
    },
  };
})(typeof window !== "undefined" ? window : this);
