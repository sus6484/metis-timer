/**
 * Metis — Firestore 실시간 동기화
 *
 * 컬렉션
 * - timerBuyIn/{presetId}     : 바인 인원 (player / entry)
 * - timerControl/{presetId}   : 타이머 재생·일시정지·시계 (Firestore = SSOT, LWW)
 *
 * 시트 폴링은 이후 단계에서 제거. 지금은 Firestore가 충돌 시 우선한다.
 */
import { db } from "./firebase.js";
import {
  doc,
  setDoc,
  onSnapshot,
  collection,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

var BUY_IN_COLLECTION = "timerBuyIn";
var CONTROL_COLLECTION = "timerControl";
var PRESETS_COLLECTION = "presets";
var PRESETS_STORAGE_KEY = "metis_blindPresets";
var PRESETS_DELETED_KEY = "metis_deletedPresetIds";
var PRESETS_SEEDED_KEY = "metis_firestorePresetsSeeded";

var buyInUnsub = null;
var buyInPresetId = "";
var buyInOnApplied = null;
var lastPushedStatsAt = 0;

var controlUnsub = null;
var controlPresetId = "";
var controlOnApplied = null;
var lastControlPushSig = "";
var lastControlPushAt = 0;
var CONTROL_HEARTBEAT_MIN_MS = 2500;

/** Firestore가 해당 영역의 단일 진실 공급원 */
var isBuyInLive = true;
var isTimerControlLive = true;
var isPresetsLive = true;

var CONTROL_PAYLOAD_KEYS = [
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

function buyInRef(presetId) {
  return doc(db, BUY_IN_COLLECTION, String(presetId));
}

function controlRef(presetId) {
  return doc(db, CONTROL_COLLECTION, String(presetId));
}

function normalizeBuyIn(data) {
  data = data || {};
  return {
    player: Math.max(0, Math.floor(Number(data.player) || 0)),
    entry: Math.max(0, Math.floor(Number(data.entry) || 0)),
    statsUpdatedAt: Number(data.statsUpdatedAt) || 0,
    updatedAt: Number(data.updatedAt) || 0,
  };
}

function copyPendingBridge(pb) {
  if (!pb || typeof pb !== "object") return null;
  return {
    kind: pb.kind,
    remainingSec: Math.max(0, Math.floor(Number(pb.remainingSec) || 0)),
  };
}

function normalizeTimerForFs(timer) {
  if (!timer || typeof timer !== "object") {
    return {
      isRunning: false,
      endAt: null,
      pausedRemainingSec: 0,
      levelIndex: 0,
      bridge: null,
    };
  }
  var bridge = null;
  if (timer.bridge && typeof timer.bridge === "object") {
    bridge = {
      kind: timer.bridge.kind,
      until:
        timer.bridge.until != null && Number.isFinite(Number(timer.bridge.until))
          ? Number(timer.bridge.until)
          : null,
    };
  }
  return {
    isRunning: !!timer.isRunning,
    endAt:
      timer.endAt != null && Number.isFinite(Number(timer.endAt))
        ? Number(timer.endAt)
        : null,
    pausedRemainingSec: Math.max(
      0,
      Math.floor(Number(timer.pausedRemainingSec) || 0)
    ),
    levelIndex: Math.max(0, Math.floor(Number(timer.levelIndex) || 0)),
    bridge: bridge,
  };
}

/** 시트/로컬 슬라이스 → Firestore timerControl 페이로드 (바인 필드 제외) */
function buildControlPayload(slice, presetId) {
  slice = slice || {};
  var out = {
    presetId: String(presetId || slice.presetId || ""),
    timer: normalizeTimerForFs(slice.timer),
    timerStatus: slice.timerStatus != null ? String(slice.timerStatus) : "대기중",
    displayTime: slice.displayTime != null ? String(slice.displayTime) : "00:00",
    level: slice.level != null ? slice.level : 1,
    hasStartedOnce: !!slice.hasStartedOnce,
    pendingBridge: copyPendingBridge(slice.pendingBridge),
    regCloseAt:
      slice.regCloseAt != null && Number.isFinite(Number(slice.regCloseAt))
        ? Number(slice.regCloseAt)
        : null,
    totalScheduleCommittedSec: Math.max(
      0,
      Math.floor(Number(slice.totalScheduleCommittedSec) || 0)
    ),
    timerUpdatedAt: Number(slice.timerUpdatedAt) || 0,
    controlUpdatedAt: Number(slice.controlUpdatedAt) || 0,
    heartbeatAt: Number(slice.heartbeatAt) || 0,
    lastActionTimestamp: Number(slice.lastActionTimestamp) || 0,
    updatedAt: Number(slice.updatedAt) || Date.now(),
  };
  return out;
}

function controlSignature(payload) {
  var t = payload && payload.timer ? payload.timer : {};
  return [
    payload.lastActionTimestamp || 0,
    payload.controlUpdatedAt || 0,
    t.isRunning ? 1 : 0,
    t.levelIndex || 0,
    t.endAt || 0,
    t.pausedRemainingSec || 0,
    t.bridge ? t.bridge.kind + ":" + (t.bridge.until || 0) : "",
    payload.timerStatus || "",
    payload.hasStartedOnce ? 1 : 0,
  ].join("|");
}

/**
 * 바인 인원 변경을 Firestore에 저장 (merge)
 */
function saveBuyInStats(presetId, stats) {
  if (!presetId || !stats || typeof stats !== "object") return;
  var payload = normalizeBuyIn(stats);
  if (!payload.statsUpdatedAt) payload.statsUpdatedAt = Date.now();
  payload.updatedAt = Date.now();
  lastPushedStatsAt = payload.statsUpdatedAt;
  console.log("[MetisFirestore|PUSH|saveBuyInStats]", {
    presetId: String(presetId),
    player: payload.player,
    entry: payload.entry,
    statsUpdatedAt: payload.statsUpdatedAt,
  });
  return setDoc(buyInRef(presetId), payload, { merge: true }).catch(function (err) {
    console.warn("[MetisFirestore] 바인 인원 저장 실패:", err);
  });
}

/**
 * 타이머 제어 상태를 Firestore에 저장
 * @param {string} presetId
 * @param {object} slice - pickTimerSyncSlice / heartbeat 슬라이스
 * @param {{ urgent?: boolean, heartbeat?: boolean }=} options
 */
function saveTimerControl(presetId, slice, options) {
  options = options || {};
  if (!presetId || !slice || typeof slice !== "object") return;
  var payload = buildControlPayload(slice, presetId);
  if (!payload.presetId) return;

  var sig = controlSignature(payload);
  var now = Date.now();
  var urgent = !!options.urgent;

  if (!urgent) {
    if (sig === lastControlPushSig) return;
    if (
      options.heartbeat &&
      lastControlPushAt > 0 &&
      now - lastControlPushAt < CONTROL_HEARTBEAT_MIN_MS &&
      sig.split("|").slice(2).join("|") ===
        lastControlPushSig.split("|").slice(2).join("|")
    ) {
      return;
    }
  }

  lastControlPushSig = sig;
  lastControlPushAt = now;

  console.log("[MetisFirestore|PUSH|saveTimerControl]", {
    presetId: payload.presetId,
    urgent: urgent,
    heartbeat: !!options.heartbeat,
    lastActionTimestamp: payload.lastActionTimestamp,
    isRunning: payload.timer && payload.timer.isRunning,
    endAt: payload.timer && payload.timer.endAt,
    levelIndex: payload.timer && payload.timer.levelIndex,
    timerStatus: payload.timerStatus,
  });

  return setDoc(controlRef(presetId), payload, { merge: true }).catch(function (err) {
    console.warn("[MetisFirestore] 타이머 제어 저장 실패:", err);
  });
}

function applyBuyInToLocal(presetId, raw) {
  if (!window.MetisTimer || !raw) return false;
  var data = normalizeBuyIn(raw);
  var pid = String(presetId || "");
  if (!pid) return false;

  MetisTimer.setSyncPresetId(pid);
  var state = MetisTimer.readSyncState();
  if (!state) return false;

  var localSU = Number(state.statsUpdatedAt) || 0;
  var remoteSU = data.statsUpdatedAt;
  var localPlayer = Math.max(0, Math.floor(Number(state.player) || 0));
  var localEntry = Math.max(0, Math.floor(Number(state.entry) || 0));

  if (remoteSU > 0 && localSU > remoteSU) {
    console.log("[MetisFirestore|PULL|applyBuyIn:로컬최신무시]", {
      localSU: localSU,
      remoteSU: remoteSU,
    });
    return false;
  }

  if (
    localPlayer === data.player &&
    localEntry === data.entry &&
    (remoteSU <= 0 || remoteSU === localSU)
  ) {
    return false;
  }

  state.player = data.player;
  state.entry = data.entry;
  if (remoteSU > 0) state.statsUpdatedAt = remoteSU;
  state.updatedAt = Math.max(
    Number(state.updatedAt) || 0,
    remoteSU,
    Date.now()
  );

  console.log("[MetisFirestore|PULL|applyBuyIn:적용]", {
    presetId: pid,
    player: state.player,
    entry: state.entry,
    statsUpdatedAt: state.statsUpdatedAt,
  });

  MetisTimer.writeSyncState(state, {
    skipCloudPush: true,
    preserveUpdatedAt: true,
  });
  return true;
}

/**
 * Firestore timerControl → 로컬 적용 (Firestore LWW)
 * 로컬 lastActionTimestamp 가 더 크면(방금 조작) echo 대기만 하고 무시
 */
function applyTimerControlToLocal(presetId, raw) {
  if (!window.MetisTimer || !raw) return false;
  var pid = String(presetId || "");
  if (!pid) return false;

  MetisTimer.setSyncPresetId(pid);
  var state = MetisTimer.readSyncState();
  if (!state) return false;

  var cloudSlice = buildControlPayload(raw, pid);
  var localSlice =
    MetisTimer.pickTimerSyncSlice && MetisTimer.pickTimerSyncSlice(state, pid);
  var remoteLA =
    (MetisTimer.sliceLastActionAt && MetisTimer.sliceLastActionAt(cloudSlice)) ||
    Number(cloudSlice.lastActionTimestamp) ||
    0;
  var localLA =
    (MetisTimer.sliceLastActionAt && MetisTimer.sliceLastActionAt(localSlice)) ||
    Number(state.lastActionTimestamp) ||
    0;

  // 로컬이 더 최신 조작이면 Firestore stale 스냅샷 무시 (곧 echo로 맞춰짐)
  if (remoteLA > 0 && localLA > remoteLA) {
    console.log("[MetisFirestore|PULL|applyTimerControl:로컬조작최신무시]", {
      localLA: localLA,
      remoteLA: remoteLA,
    });
    return false;
  }

  var prevLevel =
    state.timer && state.timer.levelIndex != null ? state.timer.levelIndex : 0;

  // Firestore 우선: remoteLA >= localLA 이면 강제 적용 (LWW)
  var applied = MetisTimer.applyTimerSyncSlice(state, cloudSlice, {
    forceApply: remoteLA >= localLA,
  });

  if (!applied) {
    // forceApply인데도 false면 인자 문제 — 타임스탬프만 맞춰 재시도하지 않음
    return false;
  }

  MetisTimer.writeSyncState(state, {
    skipCloudPush: true,
    preserveUpdatedAt: true,
  });

  var newLevel =
    state.timer && state.timer.levelIndex != null ? state.timer.levelIndex : 0;
  console.log("[MetisFirestore|PULL|applyTimerControl:적용]", {
    presetId: pid,
    remoteLA: remoteLA,
    localLA: localLA,
    isRunning: state.timer && state.timer.isRunning,
    endAt: state.timer && state.timer.endAt,
    levelIndex: newLevel,
    leveledUp: newLevel > prevLevel,
    timerStatus: state.timerStatus,
  });

  return {
    changed: true,
    leveledUp: newLevel > prevLevel,
    prevLevelIndex: prevLevel,
    newLevelIndex: newLevel,
  };
}

function stopBuyInSync() {
  if (buyInUnsub) {
    buyInUnsub();
    buyInUnsub = null;
  }
  buyInPresetId = "";
}

function stopTimerControlSync() {
  if (controlUnsub) {
    controlUnsub();
    controlUnsub = null;
  }
  controlPresetId = "";
}

function startBuyInSync(presetId, onApplied) {
  var pid = presetId != null ? String(presetId) : "";
  if (!pid) {
    console.warn("[MetisFirestore] startBuyInSync: presetId 없음");
    return;
  }
  if (buyInUnsub && buyInPresetId === pid) {
    buyInOnApplied = typeof onApplied === "function" ? onApplied : buyInOnApplied;
    return;
  }

  stopBuyInSync();
  buyInPresetId = pid;
  buyInOnApplied = typeof onApplied === "function" ? onApplied : null;

  console.log("[MetisFirestore|PULL|startBuyInSync]", { presetId: pid });
  buyInUnsub = onSnapshot(
    buyInRef(pid),
    function (snap) {
      if (!snap.exists()) {
        console.log("[MetisFirestore|PULL|buyIn:문서없음]", { presetId: pid });
        return;
      }
      var changed = applyBuyInToLocal(pid, snap.data());
      if (changed && typeof buyInOnApplied === "function") {
        buyInOnApplied(true);
      }
    },
    function (err) {
      console.warn("[MetisFirestore] buyIn onSnapshot 오류:", err);
    }
  );
}

function startTimerControlSync(presetId, onApplied) {
  var pid = presetId != null ? String(presetId) : "";
  if (!pid) {
    console.warn("[MetisFirestore] startTimerControlSync: presetId 없음");
    return;
  }
  if (controlUnsub && controlPresetId === pid) {
    controlOnApplied =
      typeof onApplied === "function" ? onApplied : controlOnApplied;
    return;
  }

  stopTimerControlSync();
  controlPresetId = pid;
  controlOnApplied = typeof onApplied === "function" ? onApplied : null;

  console.log("[MetisFirestore|PULL|startTimerControlSync]", { presetId: pid });
  controlUnsub = onSnapshot(
    controlRef(pid),
    function (snap) {
      if (!snap.exists()) {
        console.log("[MetisFirestore|PULL|timerControl:문서없음]", {
          presetId: pid,
        });
        return;
      }
      var result = applyTimerControlToLocal(pid, snap.data());
      if (result && result.changed && typeof controlOnApplied === "function") {
        controlOnApplied(result);
      }
    },
    function (err) {
      console.warn("[MetisFirestore] timerControl onSnapshot 오류:", err);
    }
  );
}

/** 바인 + 타이머 제어 리스너를 함께 시작 */
function startLiveSync(presetId, onApplied) {
  var cb = typeof onApplied === "function" ? onApplied : null;
  startBuyInSync(presetId, function () {
    if (cb) cb({ source: "buyIn" });
  });
  startTimerControlSync(presetId, function (result) {
    if (cb) cb({ source: "timerControl", result: result });
  });
}

function updateBuyInPreset(presetId) {
  if (!presetId) return;
  if (buyInUnsub) startBuyInSync(presetId, buyInOnApplied);
}

function updateTimerControlPreset(presetId) {
  if (!presetId) return;
  if (controlUnsub) startTimerControlSync(presetId, controlOnApplied);
}

function updateLivePreset(presetId) {
  updateBuyInPreset(presetId);
  updateTimerControlPreset(presetId);
}

/** 시트 페이로드에서 Firestore 담당 필드 제거 */
function stripFirestoreOwnedFields(slice) {
  if (!slice || typeof slice !== "object") return slice;
  if (isBuyInLive) {
    delete slice.player;
    delete slice.entry;
    delete slice.statsUpdatedAt;
  }
  if (isTimerControlLive) {
    for (var i = 0; i < CONTROL_PAYLOAD_KEYS.length; i++) {
      var k = CONTROL_PAYLOAD_KEYS[i];
      if (k === "presetId") continue;
      delete slice[k];
    }
  }
  return slice;
}

// ─── 프리셋 컬렉션 (presets/{presetId}) ───────────────────────────

var PRESET_DOC_KEYS = [
  "id",
  "name",
  "levels",
  "tournamentName",
  "totalPrizeText",
  "tournamentInfo",
  "prizeText",
  "prizeItems",
  "entryChips",
  "regCloseLevel",
  "regCloseAfterPlayLevel",
  "preGameWaitMinutes",
  "infoFontScale",
  "prizeFontScale",
  "leftPanelRotate",
  "leftFontScale",
  "updatedAt",
  "deleted",
  "deletedAt",
];

var presetsUnsub = null;
var presetsOnApplied = null;
var presetsReady = false;
var presetsReadyWaiters = [];
var presetsApplyingRemote = false;

function presetsCol() {
  return collection(db, PRESETS_COLLECTION);
}

function presetDocRef(presetId) {
  return doc(db, PRESETS_COLLECTION, String(presetId));
}

function loadLocalPresetsRaw() {
  try {
    var raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e0) {
    return [];
  }
}

function saveLocalPresetsRaw(list) {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list || []));
  } catch (e1) {}
}

function loadFsDeletedMap() {
  try {
    var raw = localStorage.getItem(PRESETS_DELETED_KEY);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (e0) {
    return {};
  }
}

function saveFsDeletedMap(map) {
  try {
    localStorage.setItem(PRESETS_DELETED_KEY, JSON.stringify(map || {}));
  } catch (e1) {}
}

function markPresetsDeletedFs(ids) {
  if (!ids || !ids.length) return;
  var map = loadFsDeletedMap();
  var now = Date.now();
  for (var i = 0; i < ids.length; i++) {
    var pid = String(ids[i] || "");
    if (!pid) continue;
    map[pid] = now;
  }
  saveFsDeletedMap(map);
  if (window.MetisSheetSync && MetisSheetSync.markPresetsDeletedLocally) {
    MetisSheetSync.markPresetsDeletedLocally(ids);
  }
}

function clearPresetsDeletedFs(ids) {
  if (!ids || !ids.length) return;
  var map = loadFsDeletedMap();
  var changed = false;
  for (var i = 0; i < ids.length; i++) {
    var pid = String(ids[i] || "");
    if (!pid || !Object.prototype.hasOwnProperty.call(map, pid)) continue;
    delete map[pid];
    changed = true;
  }
  if (changed) saveFsDeletedMap(map);
  if (window.MetisSheetSync && MetisSheetSync.clearDeletedPresetTombstones) {
    MetisSheetSync.clearDeletedPresetTombstones(ids);
  }
}

function filterDeletedPresetsFs(list) {
  list = Array.isArray(list) ? list : [];
  var map = loadFsDeletedMap();
  if (
    window.MetisSheetSync &&
    typeof MetisSheetSync.filterOutDeletedPresets === "function"
  ) {
    list = MetisSheetSync.filterOutDeletedPresets(list);
  }
  if (!Object.keys(map).length) return list.slice();
  return list.filter(function (p) {
    return p && p.id && !Object.prototype.hasOwnProperty.call(map, String(p.id));
  });
}

/** 프리셋 문서용 정규화 — player/entry(실시간) 제외 */
function normalizePresetForFs(preset) {
  if (!preset || typeof preset !== "object") return null;
  var id = preset.id != null ? String(preset.id) : "";
  if (!id) return null;
  var out = {
    id: id,
    name: String(preset.name != null ? preset.name : "").trim() || "프리셋",
    levels: Array.isArray(preset.levels) ? preset.levels : [],
    tournamentName:
      preset.tournamentName != null ? String(preset.tournamentName) : "",
    totalPrizeText:
      preset.totalPrizeText != null ? String(preset.totalPrizeText) : "",
    tournamentInfo:
      preset.tournamentInfo != null ? String(preset.tournamentInfo) : "",
    prizeText: preset.prizeText != null ? String(preset.prizeText) : "",
    prizeItems: Array.isArray(preset.prizeItems) ? preset.prizeItems : [],
    entryChips: Math.max(0, Math.floor(Number(preset.entryChips) || 0)),
    regCloseLevel: Math.max(0, Math.floor(Number(preset.regCloseLevel) || 0)),
    infoFontScale: Number(preset.infoFontScale) || 1,
    prizeFontScale: Number(preset.prizeFontScale) || 1,
    leftPanelRotate: !!preset.leftPanelRotate,
    updatedAt: Number(preset.updatedAt) || Date.now(),
    deleted: !!preset.deleted,
  };
  if (preset.leftFontScale != null) {
    out.leftFontScale = Number(preset.leftFontScale) || 1;
  }
  if (
    preset.regCloseAfterPlayLevel != null &&
    Number.isFinite(Number(preset.regCloseAfterPlayLevel))
  ) {
    out.regCloseAfterPlayLevel = Math.floor(Number(preset.regCloseAfterPlayLevel));
  } else {
    out.regCloseAfterPlayLevel = null;
  }
  if (
    preset.preGameWaitMinutes != null &&
    Number.isFinite(Number(preset.preGameWaitMinutes))
  ) {
    out.preGameWaitMinutes = Math.floor(Number(preset.preGameWaitMinutes));
  } else {
    out.preGameWaitMinutes = null;
  }
  if (preset.deletedAt != null) {
    out.deletedAt = Number(preset.deletedAt) || 0;
  }
  return out;
}

function presetUpdatedAt(p) {
  return Number(p && p.updatedAt) || 0;
}

function notifyPresetsReady() {
  if (presetsReady) return;
  presetsReady = true;
  var waiters = presetsReadyWaiters.slice();
  presetsReadyWaiters = [];
  for (var i = 0; i < waiters.length; i++) {
    try {
      waiters[i]();
    } catch (e0) {}
  }
  try {
    window.dispatchEvent(new Event("metis-presets-firestore-ready"));
  } catch (e1) {}
  try {
    document.dispatchEvent(new Event("metis-presets-bootstrapped"));
  } catch (e2) {}
}

function whenPresetsReady(cb) {
  if (typeof cb !== "function") return;
  if (presetsReady) {
    cb();
    return;
  }
  presetsReadyWaiters.push(cb);
}

/**
 * 단일/복수 프리셋을 Firestore에 저장
 * @param {object|object[]} presets
 * @param {{ urgent?: boolean }=} options
 */
function savePresetsToFirestore(presets, options) {
  options = options || {};
  if (presetsApplyingRemote) return Promise.resolve();
  var list = Array.isArray(presets) ? presets : presets ? [presets] : [];
  var docs = [];
  for (var i = 0; i < list.length; i++) {
    var normalized = normalizePresetForFs(list[i]);
    if (!normalized || normalized.deleted) continue;
    if (!normalized.updatedAt) normalized.updatedAt = Date.now();
    normalized.deleted = false;
    docs.push(normalized);
    clearPresetsDeletedFs([normalized.id]);
  }
  if (!docs.length) return Promise.resolve();

  console.log("[MetisFirestore|PUSH|savePresets]", {
    count: docs.length,
    ids: docs.map(function (d) {
      return d.id;
    }),
    urgent: !!options.urgent,
  });

  var batch = writeBatch(db);
  for (var j = 0; j < docs.length; j++) {
    batch.set(presetDocRef(docs[j].id), docs[j], { merge: true });
  }
  return batch.commit().catch(function (err) {
    console.warn("[MetisFirestore] 프리셋 저장 실패:", err);
  });
}

/**
 * 프리셋 삭제 (소프트 삭제 + 로컬 톰스톤)
 */
function deletePresetsFromFirestore(presetIds, options) {
  options = options || {};
  var ids = (presetIds || []).map(String).filter(Boolean);
  if (!ids.length) return Promise.resolve();
  markPresetsDeletedFs(ids);

  var now = Date.now();
  console.log("[MetisFirestore|PUSH|deletePresets]", { ids: ids });

  var batch = writeBatch(db);
  for (var i = 0; i < ids.length; i++) {
    batch.set(
      presetDocRef(ids[i]),
      { id: ids[i], deleted: true, deletedAt: now, updatedAt: now },
      { merge: true }
    );
  }
  return batch.commit().catch(function (err) {
    console.warn("[MetisFirestore] 프리셋 삭제 실패:", err);
  });
}

function mergeLocalTournamentOntoRemote(localP, remoteP) {
  var out = Object.assign({}, remoteP);
  // 로컬에만 있던 player/entry 는 유지하지 않음(실시간 컬렉션 담당)
  // 메타는 remote(Firestore) 우선 — LWW로 이미 선택된 쪽
  if (localP && localP.id) out.id = String(localP.id);
  return out;
}

function applyPresetsSnapshot(snapshot) {
  var remoteActive = [];
  var remoteDeletedIds = [];
  snapshot.forEach(function (snapDoc) {
    var data = snapDoc.data() || {};
    data.id = data.id || snapDoc.id;
    if (data.deleted) {
      remoteDeletedIds.push(String(data.id));
      return;
    }
    var normalized = normalizePresetForFs(data);
    if (normalized) remoteActive.push(normalized);
  });

  if (remoteDeletedIds.length) {
    markPresetsDeletedFs(remoteDeletedIds);
  }

  var deletedMap = loadFsDeletedMap();
  var localList = filterDeletedPresetsFs(loadLocalPresetsRaw());
  var localById = {};
  localList.forEach(function (p) {
    if (p && p.id) localById[String(p.id)] = p;
  });
  var remoteById = {};
  remoteActive.forEach(function (p) {
    remoteById[String(p.id)] = p;
  });

  // 최초: Firestore가 비어 있고 로컬에 프리셋이 있으면 시드(마이그레이션)
  var seededFlag = false;
  try {
    seededFlag = localStorage.getItem(PRESETS_SEEDED_KEY) === "1";
  } catch (e0) {}

  if (!remoteActive.length && localList.length && !seededFlag) {
    console.log("[MetisFirestore|PUSH|seedPresets]", {
      count: localList.length,
    });
    try {
      localStorage.setItem(PRESETS_SEEDED_KEY, "1");
    } catch (e1) {}
    var seedList = localList.map(function (p) {
      var n = normalizePresetForFs(p);
      if (n && !n.updatedAt) n.updatedAt = Date.now();
      return n;
    }).filter(Boolean);
    savePresetsToFirestore(seedList, { urgent: true });
    notifyPresetsReady();
    return { changed: false, seeded: true, presets: localList };
  }

  try {
    localStorage.setItem(PRESETS_SEEDED_KEY, "1");
  } catch (e2) {}

  var out = [];
  var changed = false;
  var toPush = [];

  remoteActive.forEach(function (rp) {
    var pid = String(rp.id);
    if (Object.prototype.hasOwnProperty.call(deletedMap, pid)) return;
    var lp = localById[pid];
    if (!lp) {
      out.push(rp);
      changed = true;
      return;
    }
    var rU = presetUpdatedAt(rp);
    var lU = presetUpdatedAt(lp);
    if (rU > lU) {
      // Firestore가 더 최신 → 강제 적용 (SSOT)
      out.push(mergeLocalTournamentOntoRemote(lp, rp));
      changed = true;
    } else if (rU < lU) {
      // 로컬이 더 최신 → 유지 후 Firestore에 재푸시
      var localNormNewer = normalizePresetForFs(lp);
      out.push(localNormNewer || lp);
      if (localNormNewer) toPush.push(localNormNewer);
    } else {
      // 동일 updatedAt: 내용이 다르면 로컬 편집 중으로 보고 로컬 유지+재푸시
      // (예전 버그: 로컬만 이름 바꾸고 updatedAt 미갱신 → 옛 Firestore가 덮어씀)
      var localNormEq = normalizePresetForFs(lp);
      var sameContent = false;
      try {
        sameContent =
          JSON.stringify(localNormEq) === JSON.stringify(rp);
      } catch (eEq) {
        sameContent = false;
      }
      if (sameContent) {
        out.push(rp);
      } else {
        out.push(localNormEq || lp);
        if (localNormEq) toPush.push(localNormEq);
      }
    }
  });

  localList.forEach(function (lp) {
    if (!lp || !lp.id) return;
    var pid = String(lp.id);
    if (Object.prototype.hasOwnProperty.call(deletedMap, pid)) return;
    if (remoteById[pid]) return;
    if (remoteDeletedIds.indexOf(pid) >= 0) {
      changed = true;
      return;
    }
    // 원격에 없는 로컬 전용 → 유지 + 업로드
    var localNorm = normalizePresetForFs(lp);
    out.push(localNorm || lp);
    if (localNorm) toPush.push(localNorm);
    changed = true;
  });

  presetsApplyingRemote = true;
  try {
    if (changed || !localList.length) {
      saveLocalPresetsRaw(out);
      if (
        window.MetisTimer &&
        typeof MetisTimer.syncAllPresetsMetadataFromStorage === "function"
      ) {
        MetisTimer.syncAllPresetsMetadataFromStorage();
      }
    }
  } finally {
    presetsApplyingRemote = false;
  }

  if (toPush.length) {
    savePresetsToFirestore(toPush, { urgent: false });
  }

  console.log("[MetisFirestore|PULL|applyPresets]", {
    remote: remoteActive.length,
    localOut: out.length,
    changed: changed,
    deleted: remoteDeletedIds.length,
  });

  notifyPresetsReady();
  return { changed: changed, presets: out, deletedIds: remoteDeletedIds };
}

function stopPresetsSync() {
  if (presetsUnsub) {
    presetsUnsub();
    presetsUnsub = null;
  }
}

/**
 * 프리셋 컬렉션 실시간 리스너
 */
function startPresetsSync(onApplied) {
  if (presetsUnsub) {
    presetsOnApplied =
      typeof onApplied === "function" ? onApplied : presetsOnApplied;
    if (presetsReady && typeof onApplied === "function") onApplied({ ready: true });
    return;
  }
  presetsOnApplied = typeof onApplied === "function" ? onApplied : null;
  console.log("[MetisFirestore|PULL|startPresetsSync]");

  presetsUnsub = onSnapshot(
    presetsCol(),
    function (snapshot) {
      var result = applyPresetsSnapshot(snapshot);
      if (typeof presetsOnApplied === "function") {
        presetsOnApplied(result || { ready: true });
      }
    },
    function (err) {
      console.warn("[MetisFirestore] presets onSnapshot 오류:", err);
      notifyPresetsReady();
    }
  );
}

function stopAllLiveSync() {
  stopBuyInSync();
  stopTimerControlSync();
  stopPresetsSync();
}

window.MetisFirestoreSync = {
  isBuyInLive: isBuyInLive,
  isTimerControlLive: isTimerControlLive,
  isPresetsLive: isPresetsLive,
  saveBuyInStats: saveBuyInStats,
  saveTimerControl: saveTimerControl,
  savePresetsToFirestore: savePresetsToFirestore,
  deletePresetsFromFirestore: deletePresetsFromFirestore,
  startBuyInSync: startBuyInSync,
  startTimerControlSync: startTimerControlSync,
  startPresetsSync: startPresetsSync,
  startLiveSync: startLiveSync,
  stopBuyInSync: stopBuyInSync,
  stopTimerControlSync: stopTimerControlSync,
  stopPresetsSync: stopPresetsSync,
  stopAllLiveSync: stopAllLiveSync,
  updateBuyInPreset: updateBuyInPreset,
  updateTimerControlPreset: updateTimerControlPreset,
  updateLivePreset: updateLivePreset,
  applyBuyInToLocal: applyBuyInToLocal,
  applyTimerControlToLocal: applyTimerControlToLocal,
  stripFirestoreOwnedFields: stripFirestoreOwnedFields,
  buildControlPayload: buildControlPayload,
  normalizePresetForFs: normalizePresetForFs,
  whenPresetsReady: whenPresetsReady,
  filterDeletedPresetsFs: filterDeletedPresetsFs,
};

window.dispatchEvent(new Event("metis-firebase-ready"));
console.log("[MetisFirestore] 준비 완료 (바인 + 타이머 제어 + 프리셋)");
