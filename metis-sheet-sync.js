/**
 * Metis — Google Sheets 프리셋 동기화 (Apps Script Web App)
 * 나중에 timerStates 필드를 추가하면 타이머 진행 상태 동기화도 확장 가능.
 */
(function (global) {
  "use strict";

  var CONFIG = {
    url: "https://script.google.com/macros/s/AKfycbxcHTHJ4UxcXSClbSIYt_u_JdvOmvfNZSctHJRPLfE4CNZQKnL9xzjoa3RgYbG3ikXl3g/exec",
    token: "metis_secret_444444",
  };

  var STORAGE_PRESETS = "metis_blindPresets";
  var STORAGE_ACTIVE = "metis_activePresetId";

  var pullPromise = null;
  var saveTimer = null;
  var pendingSave = null;
  var lastCloudPullData = null;

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
    applyToLocal: applyToLocal,
    bootTimerPage: bootTimerPage,
    cloudHasWeakerMetadataThanLocal: cloudHasWeakerMetadataThanLocal,
    getLastCloudPullData: function () {
      return lastCloudPullData;
    },
  };
})(typeof window !== "undefined" ? window : this);
