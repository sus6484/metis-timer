/**
 * Metis — Google Sheets 동기화 (비활성화됨)
 *
 * 모든 데이터 연동은 Firestore(metis-firestore-sync.js)로 이전됨.
 * 이 파일은 실수로 로드되어도 폴링·네트워크 호출이 없도록 no-op 스텁만 남김.
 */
(function (global) {
  "use strict";

  function noop() {}
  function resolved() {
    return Promise.resolve(null);
  }

  global.MetisSheetSync = {
    ASSET_VERSION: "disabled",
    assetUrl: function (path) {
      return path || "";
    },
    updateCloudPollPinnedPreset: noop,
    pullPresetsToLocal: resolved,
    savePresetsToCloud: noop,
    deletePresetsByIds: noop,
    markPresetsDeletedLocally: noop,
    clearDeletedPresetTombstones: noop,
    isPresetDeletedLocally: function () {
      return false;
    },
    filterOutDeletedPresets: function (list) {
      return Array.isArray(list) ? list.slice() : [];
    },
    saveTimerStateToCloud: noop,
    pollTimerStatesFromCloud: resolved,
    pullAndApplyPresetTimerState: resolved,
    applyTimerStatesFromCloud: function () {
      return { applied: false };
    },
    applyCloudPresetsIfNewer: function () {
      return false;
    },
    requestImmediateCloudSync: noop,
    maybePushLocalTimerIfAheadOfCloud: noop,
    startCloudTimerSync: noop,
    stopCloudTimerSync: noop,
    getCloudSyncStatus: function () {
      return { state: "idle", label: "Sheets off" };
    },
    onCloudSyncStatusChange: noop,
    bindCloudSyncBadge: noop,
    applyToLocal: noop,
    bootTimerPage: function () {
      console.warn(
        "[MetisSheetSync] 비활성화됨 — MetisFirestoreSync.bootTimerPage 를 사용하세요."
      );
    },
    resolveBootPresetId: function () {
      return "preset_default";
    },
    ensureTimerStateBootstrapped: function () {
      return false;
    },
    getLastCloudUpdatedAt: function () {
      return 0;
    },
    getLastCloudPullData: function () {
      return null;
    },
  };
})(typeof window !== "undefined" ? window : this);
