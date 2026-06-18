/**
 * Metis — Google Sheets 프리셋·타이머 동기화 (Apps Script Web App)
 * timerStates: 프리셋별 실시간 타이머 상태 (pickTimerSyncSlice, 3단계에서 연결)
 */
(function (global) {
  "use strict";

  var CONFIG = {
    url: "https://script.google.com/macros/s/AKfycbwEr9geWitJJG2bHHV-w1DGCZh3MhvzibcNP4Nym5yNnZ4hJnruSshvk3ATMqPCX8gHpQ/exec",
    token: "metis_secret_444444",
  };

  var STORAGE_PRESETS = "metis_blindPresets";
  var STORAGE_ACTIVE = "metis_activePresetId";

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

  var METADATA_KEYS = [
    "tournamentName",
    "totalPrizeText",
    "tournamentInfo",
    "prizeText",
    "prizeItems",
    "infoFontScale",
    "prizeFontScale",
    "leftPanelRotate",
  ];

  function isMetadataEmpty(key, val) {
    if (val === undefined || val === null) return true;
    if (key === "prizeItems") return !Array.isArray(val) || val.length === 0;
    if (typeof val === "string") return !val.trim();
    return false;
  }

  function mergeMetadataPreferNonEmpty(target, source) {
    if (!target || !source) return target;
    for (var i = 0; i < METADATA_KEYS.length; i++) {
      var k = METADATA_KEYS[i];
      if (source[k] === undefined || isMetadataEmpty(k, source[k])) continue;
      target[k] =
        k === "prizeItems" && Array.isArray(source[k])
          ? source[k].slice()
          : source[k];
    }
    return target;
  }

  function mergePresetListsLocal(localList, cloudList) {
    if (global.MetisTimer && global.MetisTimer.mergePresetLists) {
      return global.MetisTimer.mergePresetLists(localList, cloudList);
    }
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
      var merged = Object.assign({}, cloudP);
      mergeMetadataPreferNonEmpty(merged, localById[cloudP.id]);
      out.push(merged);
    });
    localList.forEach(function (localP) {
      if (!localP || !localP.id || seen[localP.id]) return;
      out.push(localP);
    });
    return out.length ? out : cloudList;
  }

  function cloudHasWeakerMetadataThanLocal(cloudData) {
    var localList = [];
    try {
      var raw = localStorage.getItem(STORAGE_PRESETS);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) localList = parsed;
      }
    } catch (e0) {
      return false;
    }
    var cloudList = cloudData && cloudData.presets;
    if (!Array.isArray(cloudList)) return false;
    var cloudById = {};
    cloudList.forEach(function (p) {
      if (p && p.id) cloudById[p.id] = p;
    });
    for (var i = 0; i < localList.length; i++) {
      var localP = localList[i];
      if (!localP || !localP.id) continue;
      var cloudP = cloudById[localP.id] || {};
      for (var j = 0; j < METADATA_KEYS.length; j++) {
        var k = METADATA_KEYS[j];
        if (!isMetadataEmpty(k, localP[k]) && isMetadataEmpty(k, cloudP[k])) {
          return true;
        }
      }
    }
    return false;
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

  function applyToLocal(data) {
    if (!data || typeof data !== "object") return false;
    var changed = false;
    if (Array.isArray(data.presets) && data.presets.length > 0) {
      var localList = [];
      try {
        var raw = localStorage.getItem(STORAGE_PRESETS);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) localList = parsed;
        }
      } catch (e0) {}
      var merged = mergePresetListsLocal(localList, data.presets);
      localStorage.setItem(STORAGE_PRESETS, JSON.stringify(merged));
      changed = true;
    }
    if (data.activePresetId != null && String(data.activePresetId) !== "") {
      localStorage.setItem(STORAGE_ACTIVE, String(data.activePresetId));
      changed = true;
    }
    return changed;
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
      if (s && s.timer && s.timer.isRunning) return 800;
      if (s && s.timer && s.timer.bridge) return 800;
    }
    return 2000;
  }

  function pollTimerStatesFromCloud(pollOptions) {
    pollOptions = pollOptions || cloudPollOptions || {};
    var pinnedId =
      pollOptions.pinnedPresetId != null && String(pollOptions.pinnedPresetId) !== ""
        ? String(pollOptions.pinnedPresetId)
        : "";
    var skipActiveMutation =
      !!pollOptions.skipActivePresetMutation || !!pinnedId;

    setCloudSyncPhase("syncing");
    return fetch(CONFIG.url, { method: "GET", cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        lastCloudPullData = data;
        var activePresetChanged = false;
        if (
          !skipActiveMutation &&
          data &&
          data.activePresetId != null &&
          String(data.activePresetId) !== ""
        ) {
          var nextActive = String(data.activePresetId);
          var curActive = getActivePresetIdFromStorage();
          if (curActive !== nextActive) {
            activePresetChanged = true;
            localStorage.setItem(STORAGE_ACTIVE, nextActive);
            if (global.MetisTimer && global.MetisTimer.setSyncPresetId) {
              global.MetisTimer.setSyncPresetId(nextActive);
            }
          }
        }
        var applyResult = emptyApplyResult();
        if (data && data.timerStates) {
          var applyOpts = {};
          if (pinnedId) {
            applyOpts.forcePresetId = pinnedId;
          } else {
            applyOpts.activePresetId = data.activePresetId;
          }
          applyResult = applyTimerStatesFromCloud(data.timerStates, applyOpts);
        }
        applyResult.activePresetChanged = activePresetChanged;
        setCloudSyncPhase("ok");
        return { data: data, applyResult: applyResult, applied: applyResult.applied };
      })
      .catch(function (err) {
        console.warn("[MetisSheetSync] 타이머 클라우드 불러오기 실패:", err);
        setCloudSyncPhase("error");
        return { data: null, applyResult: emptyApplyResult(), applied: false };
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
        lastCloudPullData = data;
        var applyResult = emptyApplyResult();
        if (data && data.timerStates) {
          applyResult = applyTimerStatesFromCloud(data.timerStates, {
            forcePresetId: String(presetId),
          });
        }
        setCloudSyncPhase("ok");
        return applyResult;
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
          if (result.applied || ar.activePresetChanged || ar.leveledUp) {
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
        lastCloudPullData = data;
        applyToLocal(data);
        var recovered = false;
        if (global.MetisTimer) {
          if (global.MetisTimer.recoverPresetsMetadataFromTimerStates) {
            recovered = !!global.MetisTimer.recoverPresetsMetadataFromTimerStates();
          }
          if (global.MetisTimer.syncAllPresetsMetadataFromStorage) {
            global.MetisTimer.syncAllPresetsMetadataFromStorage();
          }
        }
        if (recovered || cloudHasWeakerMetadataThanLocal(data)) {
          pushLocalPresetsToCloud();
        }
        if (data && data.timerStates) {
          applyTimerStatesFromCloud(data.timerStates, {
            activePresetId: data.activePresetId,
          });
        }
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
      .catch(function (err) {
        console.warn("[MetisSheetSync] 클라우드 저장 실패:", err);
        return null;
      });
  }

  function savePresetsToCloud(presets, activePresetId) {
    pendingSave = {
      presets: presets,
      activePresetId:
        activePresetId != null ? String(activePresetId) : undefined,
    };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      flushSave();
    }, 400);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
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
        var recovered = false;
        if (window.MetisTimer && window.MetisTimer.recoverPresetsMetadataFromTimerStates) {
          recovered = !!window.MetisTimer.recoverPresetsMetadataFromTimerStates();
        }
        if (window.MetisTimer && window.MetisTimer.syncAllPresetsMetadataFromStorage) {
          window.MetisTimer.syncAllPresetsMetadataFromStorage();
        }
        if (recovered || cloudHasWeakerMetadataThanLocal(lastCloudPullData)) {
          pushLocalPresetsToCloud();
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
    pullPresetsToLocal: pullPresetsToLocal,
    savePresetsToCloud: savePresetsToCloud,
    saveTimerStateToCloud: saveTimerStateToCloud,
    pollTimerStatesFromCloud: pollTimerStatesFromCloud,
    pullAndApplyPresetTimerState: pullAndApplyPresetTimerState,
    applyTimerStatesFromCloud: applyTimerStatesFromCloud,
    startCloudTimerSync: startCloudTimerSync,
    stopCloudTimerSync: stopCloudTimerSync,
    getCloudSyncStatus: getCloudSyncStatus,
    onCloudSyncStatusChange: onCloudSyncStatusChange,
    bindCloudSyncBadge: bindCloudSyncBadge,
    applyToLocal: applyToLocal,
    bootTimerPage: bootTimerPage,
    cloudHasWeakerMetadataThanLocal: cloudHasWeakerMetadataThanLocal,
    getLastCloudPullData: function () {
      return lastCloudPullData;
    },
  };
})(typeof window !== "undefined" ? window : this);
