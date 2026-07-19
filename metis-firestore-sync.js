/**
 * Metis — Firestore 실시간 동기화
 * 1단계: 바인 인원(player / entry)만 onSnapshot 으로 동기화
 */
import { db } from "./firebase.js";
import {
  doc,
  setDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

var BUY_IN_COLLECTION = "timerBuyIn";
var buyInUnsub = null;
var buyInPresetId = "";
var buyInOnApplied = null;
var lastPushedStatsAt = 0;

/** 바인 인원은 Firestore가 담당 (시트 동기화에서 제외) */
var isBuyInLive = true;

function buyInRef(presetId) {
  return doc(db, BUY_IN_COLLECTION, String(presetId));
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

/**
 * 바인 인원 변경을 Firestore에 저장 (merge)
 * @returns {Promise<void>|undefined}
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
 * Firestore 스냅샷을 로컬 MetisTimer state에 반영
 * @returns {boolean} 변경 여부
 */
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

  // 로컬이 더 최신(방금 누른 값)이면 원격 stale 무시
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

function stopBuyInSync() {
  if (buyInUnsub) {
    buyInUnsub();
    buyInUnsub = null;
  }
  buyInPresetId = "";
}

/**
 * 프리셋별 바인 인원 실시간 리스너
 * @param {string} presetId
 * @param {function(boolean)=} onApplied - 로컬 반영 시 호출
 */
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
        console.log("[MetisFirestore|PULL|onSnapshot:문서없음]", { presetId: pid });
        return;
      }
      var changed = applyBuyInToLocal(pid, snap.data());
      if (changed && typeof buyInOnApplied === "function") {
        buyInOnApplied(true);
      }
    },
    function (err) {
      console.warn("[MetisFirestore] onSnapshot 오류:", err);
    }
  );
}

function updateBuyInPreset(presetId) {
  if (!presetId) return;
  if (buyInUnsub) {
    startBuyInSync(presetId, buyInOnApplied);
  }
}

window.MetisFirestoreSync = {
  isBuyInLive: isBuyInLive,
  saveBuyInStats: saveBuyInStats,
  startBuyInSync: startBuyInSync,
  stopBuyInSync: stopBuyInSync,
  updateBuyInPreset: updateBuyInPreset,
  applyBuyInToLocal: applyBuyInToLocal,
};

window.dispatchEvent(new Event("metis-firebase-ready"));
console.log("[MetisFirestore] 준비 완료 (바인 인원 실시간 동기화)");
