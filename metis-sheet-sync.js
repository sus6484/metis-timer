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

  function applyToLocal(data) {
    if (!data || typeof data !== "object") return false;
    var changed = false;
    if (Array.isArray(data.presets) && data.presets.length > 0) {
      localStorage.setItem(STORAGE_PRESETS, JSON.stringify(data.presets));
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
        applyToLocal(data);
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
  };
})(typeof window !== "undefined" ? window : this);
