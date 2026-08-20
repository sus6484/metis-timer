/**
 * Metis — Firestore 실시간 동기화
 *
 * 컬렉션
 * - timerBuyIn/{presetId}     : 바인 인원 (player / entry)
 * - timerControl/{presetId}   : 타이머 재생·일시정지·시계 (Firestore = SSOT, LWW)
 * - presets/{presetId}        : 프리셋 목록
 *
 * Google Sheets 폴링은 사용하지 않음. 동기화는 Firestore + 로컬 상태만.
 *
 * ═══════════════════════════════════════════════════════════
 * Firebase PUSH 디바운스 안전장치 (여기만 조절하면 됨)
 * ───────────────────────────────────────────────────────────
 * SYNC_DELAY_ENABLED : true  = 클라우드 전송을 SYNC_DELAY_MS 만큼 모아서 1회
 *                      false = 디바운스 OFF (즉시 전송, 예전 동작에 가깝게)
 * SYNC_DELAY_MS      : 대기 시간(ms). 권장 1500~2000. 너무 길면 줄이세요.
 * 롤백               : ENABLED=false 하거나, 아래 scheduleFirestorePush 호출을
 *                      각 flush* 직접 호출로 되돌리면 됩니다.
 * options.immediate  : true면 이 호출만 디바운스 무시(삭제·시드 등)
 * 로컬 UI            : localStorage/화면은 PUSH 전에 이미 반영(낙관적 업데이트)
 * ═══════════════════════════════════════════════════════════
 */
import { db } from "./firebase.js";
import {
  doc,
  setDoc,
  getDocFromServer,
  serverTimestamp,
  onSnapshot,
  collection,
  writeBatch,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

/** @type {boolean} false 로 바꾸면 클라우드 PUSH 디바운스 비활성화 */
var SYNC_DELAY_ENABLED = true;
/** @type {number} 클라우드로 실제 전송하기 전 대기(ms). 1.5~2초 권장 */
var SYNC_DELAY_MS = 1800;

var syncDelayTimers = {};
var syncDelayPending = {};
/** presets 채널용: 디바운스 동안 id→doc 병합 */
var syncDelayPendingDocs = {};

/**
 * 채널별 trailing debounce.
 * 같은 channel 로 연속 호출되면 최신 runFn 만 SYNC_DELAY_MS 후 1회 실행.
 * 로컬 반영은 호출부에서 이미 끝난 뒤 이 함수를 부르면 됨(낙관적 업데이트).
 */
function scheduleFirestorePush(channel, runFn, options) {
  options = options || {};
  var skipDelay =
    !SYNC_DELAY_ENABLED ||
    !!options.immediate ||
    !!options.flushNow ||
    !!options.skipSyncDelay;
  if (typeof runFn !== "function") return Promise.resolve(null);

  if (skipDelay) {
    if (syncDelayTimers[channel]) {
      clearTimeout(syncDelayTimers[channel]);
      delete syncDelayTimers[channel];
    }
    delete syncDelayPending[channel];
    try {
      return Promise.resolve(runFn());
    } catch (e0) {
      return Promise.reject(e0);
    }
  }

  syncDelayPending[channel] = runFn;
  if (syncDelayTimers[channel]) clearTimeout(syncDelayTimers[channel]);
  syncDelayTimers[channel] = setTimeout(function () {
    var fn = syncDelayPending[channel];
    delete syncDelayPending[channel];
    delete syncDelayTimers[channel];
    if (typeof fn === "function") {
      try {
        fn();
      } catch (e1) {
        console.warn("[MetisFirestore] deferred PUSH 실패:", channel, e1);
      }
    }
  }, Math.max(0, Number(SYNC_DELAY_MS) || 0));

  return Promise.resolve({ deferred: true, channel: channel, delayMs: SYNC_DELAY_MS });
}

function flushDeferredFirestorePush(channel) {
  if (syncDelayTimers[channel]) {
    clearTimeout(syncDelayTimers[channel]);
    delete syncDelayTimers[channel];
  }
  var fn = syncDelayPending[channel];
  delete syncDelayPending[channel];
  if (typeof fn === "function") return Promise.resolve(fn());
  return Promise.resolve(null);
}

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
/** 비긴급 타이머 제어 쓰기 절대 하한(초당/분당 폭주 차단) */
var CONTROL_PUSH_MIN_MS = 400;
var CONTROL_PUSH_MAX_PER_MIN = 30;
var controlPushWindowStart = 0;
var controlPushWindowCount = 0;
/** 이번 구독에서 서버(원본) 문서를 아직 못 받음 */
var timerControlServerHydrated = false;
var controlHydratePending = false;
var controlCacheFallbackTimer = null;

/** Firestore 서버 시각 offset 재측정 주기 (최소 5분, 단축 불가) */
var CLOCK_RESYNC_MS = 5 * 60 * 1000;
var CLOCK_RESYNC_MIN_GAP_MS = 5 * 60 * 1000;
var clockSyncInFlight = null;
var clockResyncTimer = null;
var lastClockSyncAt = 0;
/** MetisTimer 로드 전에 측정된 offset 보관 */
var pendingClockOffsetMs = null;

function applyClockOffsetToTimer(offset, rtt) {
  if (!Number.isFinite(offset)) return;
  if (
    window.MetisTimer &&
    typeof MetisTimer.setClockOffsetMs === "function"
  ) {
    MetisTimer.setClockOffsetMs(offset);
    pendingClockOffsetMs = null;
    console.log("[MetisClock] offsetMs=", offset, "rttMs=", rtt != null ? rtt : "?");
    if (typeof MetisTimer.notifyLocalSyncListeners === "function") {
      MetisTimer.notifyLocalSyncListeners();
    }
    try {
      window.dispatchEvent(
        new CustomEvent("metis-clock-synced", {
          detail: { offsetMs: offset, rttMs: rtt },
        })
      );
    } catch (eEvt) {}
  } else {
    pendingClockOffsetMs = offset;
  }
}

function flushPendingClockOffset() {
  if (pendingClockOffsetMs == null) return false;
  if (
    !window.MetisTimer ||
    typeof MetisTimer.setClockOffsetMs !== "function"
  ) {
    return false;
  }
  applyClockOffsetToTimer(pendingClockOffsetMs, null);
  return true;
}

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
  "levelAdvanceKind",
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

function clockRef() {
  // timerControl 쓰기 권한이 있는 경로를 재사용 (별도 컬렉션 규칙 불필요)
  return doc(db, CONTROL_COLLECTION, "__metis_clock");
}

/**
 * Firestore serverTimestamp 로 로컬 시계 오차(offset)를 측정한다.
 * offset ≈ serverNow - Date.now()
 * → MetisTimer.now() = Date.now() + offset 가 서버 시각에 맞춰진다.
 *
 * ⛔ 최소 5분 간격. 짧은 주기/중첩 호출로 읽기·쓰기가 폭주하지 않도록 가드.
 */
function syncServerClockOffset(force) {
  if (clockSyncInFlight) return clockSyncInFlight;
  var now = Date.now();
  if (
    !force &&
    lastClockSyncAt > 0 &&
    now - lastClockSyncAt < CLOCK_RESYNC_MIN_GAP_MS
  ) {
    return Promise.resolve(null);
  }
  clockSyncInFlight = (async function () {
    var t0 = Date.now();
    try {
      lastClockSyncAt = t0;
      await setDoc(
        clockRef(),
        {
          serverTime: serverTimestamp(),
          clientSentAt: t0,
          purpose: "clock-sync",
        },
        { merge: true }
      );
      var snap = await getDocFromServer(clockRef());
      var t1 = Date.now();
      var data = snap && snap.data ? snap.data() : null;
      var st = data && data.serverTime;
      var serverMs =
        st && typeof st.toMillis === "function"
          ? st.toMillis()
          : st && Number.isFinite(Number(st.seconds))
            ? Number(st.seconds) * 1000 + Math.floor(Number(st.nanoseconds || 0) / 1e6)
            : NaN;
      if (!Number.isFinite(serverMs)) {
        console.warn("[MetisClock] serverTimestamp 파싱 실패");
        return null;
      }
      var rtt = Math.max(0, t1 - t0);
      if (rtt > 3000) {
        console.warn("[MetisClock] RTT 과다 — offset 무시", { rttMs: rtt });
        return null;
      }
      // 왕복의 중간 시점에 서버 시각이 기록됐다고 가정
      var offset = Math.round(serverMs - (t0 + rtt / 2));
      applyClockOffsetToTimer(offset, rtt);
      return offset;
    } catch (err) {
      console.warn("[MetisClock] 동기화 실패 (로컬 시계 사용):", err);
      return null;
    } finally {
      clockSyncInFlight = null;
    }
  })();
  return clockSyncInFlight;
}

function startClockOffsetSync() {
  syncServerClockOffset(true);
  if (clockResyncTimer) return;
  clockResyncTimer = setInterval(function () {
    syncServerClockOffset(false);
  }, CLOCK_RESYNC_MS);
}

function stopClockOffsetSync() {
  if (clockResyncTimer) {
    clearInterval(clockResyncTimer);
    clockResyncTimer = null;
  }
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
    levelAdvanceKind:
      slice.levelAdvanceKind === "expire" ||
      slice.levelAdvanceKind === "manual" ||
      slice.levelAdvanceKind === "reset"
        ? slice.levelAdvanceKind
        : null,
    timerUpdatedAt: Number(slice.timerUpdatedAt) || 0,
    controlUpdatedAt: Number(slice.controlUpdatedAt) || 0,
    heartbeatAt: Number(slice.heartbeatAt) || 0,
    lastActionTimestamp: Number(slice.lastActionTimestamp) || 0,
    updatedAt: Number(slice.updatedAt) || Date.now(),
  };
  return out;
}

/**
 * 의미 있는 제어 상태만 시그니처에 포함.
 * endAt이 있으면 pausedRemainingSec는 매 초 변하므로 제외(하트비트 위장 쓰기 차단).
 */
function controlSignature(payload) {
  var t = payload && payload.timer ? payload.timer : {};
  var hasEndAt = t.endAt != null && Number.isFinite(Number(t.endAt));
  return [
    payload.lastActionTimestamp || 0,
    payload.controlUpdatedAt || 0,
    t.isRunning ? 1 : 0,
    t.levelIndex || 0,
    t.endAt || 0,
    hasEndAt ? 0 : t.pausedRemainingSec || 0,
    t.bridge ? t.bridge.kind + ":" + (t.bridge.until || 0) : "",
    payload.timerStatus || "",
    payload.hasStartedOnce ? 1 : 0,
  ].join("|");
}

function allowControlPushRate(now) {
  if (!controlPushWindowStart || now - controlPushWindowStart >= 60000) {
    controlPushWindowStart = now;
    controlPushWindowCount = 0;
  }
  if (controlPushWindowCount >= CONTROL_PUSH_MAX_PER_MIN) {
    console.warn(
      "[MetisFirestore] saveTimerControl 분당 한도 초과 — 쓰기 차단",
      controlPushWindowCount
    );
    return false;
  }
  controlPushWindowCount += 1;
  return true;
}

/**
 * 바인 인원 변경을 Firestore에 저장 (merge)
 * 로컬 상태는 호출부(writeSyncState)에서 이미 반영됨 → 여기는 클라우드만 디바운스.
 */
function saveBuyInStats(presetId, stats, options) {
  options = options || {};
  if (!presetId || !stats || typeof stats !== "object") return;
  var payload = normalizeBuyIn(stats);
  if (!payload.statsUpdatedAt) payload.statsUpdatedAt = Date.now();
  payload.updatedAt = Date.now();
  lastPushedStatsAt = payload.statsUpdatedAt;
  var pid = String(presetId);
  var channel = "buyIn:" + pid;

  return scheduleFirestorePush(
    channel,
    function () {
      console.log("[MetisFirestore|PUSH|saveBuyInStats]", {
        presetId: pid,
        player: payload.player,
        entry: payload.entry,
        statsUpdatedAt: payload.statsUpdatedAt,
        deferred: !!(SYNC_DELAY_ENABLED && !options.immediate),
      });
      return setDoc(buyInRef(pid), payload, { merge: true }).catch(function (err) {
        console.warn("[MetisFirestore] 바인 인원 저장 실패:", err);
      });
    },
    options
  );
}

/** 디바운스 동안 로컬이 이미 다음 레벨을 받았으면 그 최신 슬라이스를 보낸다. */
function resolveLiveControlPayload(presetId, fallbackSlice) {
  var pid = String(presetId || "");
  if (
    window.MetisTimer &&
    typeof MetisTimer.readSyncState === "function" &&
    typeof MetisTimer.pickTimerSyncSlice === "function"
  ) {
    var liveState = MetisTimer.readSyncState();
    if (liveState) {
      var livePid =
        (typeof MetisTimer.getSyncPresetId === "function" &&
          MetisTimer.getSyncPresetId()) ||
        liveState.activePresetId ||
        "";
      if (String(livePid) === pid) {
        var fresh = MetisTimer.pickTimerSyncSlice(liveState, pid);
        if (fresh && fresh.timer) return buildControlPayload(fresh, pid);
      }
    }
  }
  if (!fallbackSlice) return null;
  return buildControlPayload(fallbackSlice, pid);
}

/**
 * 서버 문서가 더 최신이면 쓰지 않는다 (지연된 핸드폰 페이로드가 레벨을 되돌리지 못하게).
 */
var controlRetryTimer = null;
var controlRetryAttempt = 0;
var controlRetryPresetId = "";
var CONTROL_RETRY_BASE_MS = 700;
var CONTROL_RETRY_MAX_MS = 20000;

function clearTimerControlRetry() {
  if (controlRetryTimer) {
    clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
  }
  controlRetryAttempt = 0;
  controlRetryPresetId = "";
}

function armTimerControlRetry(presetId) {
  var pid = String(presetId || "");
  if (!pid) return;
  if (controlRetryTimer) return;
  controlRetryPresetId = pid;
  var delay = Math.min(
    CONTROL_RETRY_MAX_MS,
    CONTROL_RETRY_BASE_MS * Math.pow(2, Math.min(controlRetryAttempt, 5))
  );
  controlRetryAttempt += 1;
  setCloudSyncBadgeState("syncing", "동기화 재시도");
  console.warn("[MetisFirestore] 타이머 제어 PUSH 재시도 예약", {
    presetId: pid,
    attempt: controlRetryAttempt,
    delayMs: delay,
  });
  controlRetryTimer = setTimeout(function () {
    controlRetryTimer = null;
    retryTimerControlPush(pid);
  }, delay);
}

function retryTimerControlPush(presetId) {
  var livePayload = resolveLiveControlPayload(presetId, null);
  if (!livePayload || !livePayload.presetId) {
    armTimerControlRetry(presetId);
    return Promise.resolve({ skipped: false, error: "no-payload" });
  }
  return pushTimerControlPayload(livePayload, { isRetry: true, urgent: true });
}

function commitTimerControlIfNewer(payload) {
  var ref = controlRef(payload.presetId);
  return runTransaction(db, function (transaction) {
    return transaction.get(ref).then(function (snap) {
      if (snap.exists()) {
        var existing = buildControlPayload(snap.data(), payload.presetId);
        if (
          window.MetisTimer &&
          typeof MetisTimer.isStaleTimerControlWrite === "function" &&
          MetisTimer.isStaleTimerControlWrite(payload, existing)
        ) {
          console.log("[MetisFirestore|PUSH|saveTimerControl:낡은쓰기거부]", {
            presetId: payload.presetId,
            inLA: payload.lastActionTimestamp,
            exLA: existing.lastActionTimestamp,
            inLevel: payload.timer && payload.timer.levelIndex,
            exLevel: existing.timer && existing.timer.levelIndex,
            kind: payload.levelAdvanceKind,
          });
          return { skipped: true };
        }
      }
      transaction.set(ref, payload, { merge: true });
      return { skipped: false };
    });
  }).catch(function (err) {
    console.warn("[MetisFirestore] 타이머 제어 저장 실패:", err);
    return { skipped: false, error: err };
  });
}

function pushTimerControlPayload(payload, options) {
  options = options || {};
  if (!payload || !payload.presetId) {
    return Promise.resolve({ skipped: true, error: "no-payload" });
  }
  setCloudSyncBadgeState("syncing", "동기화 중");
  return commitTimerControlIfNewer(payload).then(function (result) {
    if (!result || result.error) {
      armTimerControlRetry(payload.presetId);
      return result || { skipped: false, error: true };
    }
    if (result.skipped) {
      clearTimerControlRetry();
      setCloudSyncBadgeState("synced", "동기화됨");
      return result;
    }
    clearTimerControlRetry();
    lastControlPushSig = controlSignature(payload);
    lastControlPushAt = Date.now();
    setCloudSyncBadgeState("synced", "동기화됨");
    console.log("[MetisFirestore|PUSH|saveTimerControl:ack]", {
      presetId: payload.presetId,
      levelIndex: payload.timer && payload.timer.levelIndex,
      lastActionTimestamp: payload.lastActionTimestamp,
      retry: !!options.isRetry,
    });
    return result;
  });
}

/**
 * 타이머 제어 상태를 Firestore에 저장
 * @param {string} presetId
 * @param {object} slice - pickTimerSyncSlice / heartbeat 슬라이스
 * @param {{ urgent?: boolean, heartbeat?: boolean, immediate?: boolean }=} options
 *
 * ⛔ heartbeat:true 쓰기는 전부 거부. 남은 시간은 endAt 로컬 계산.
 *    쓰기 1회 = 모든 onSnapshot 리스너에 읽기 1회씩 발생.
 *    로컬 UI는 writeSyncState 가 먼저 처리 — 클라우드는 디바운스.
 */
function saveTimerControl(presetId, slice, options) {
  options = options || {};
  if (!presetId || !slice || typeof slice !== "object") return;
  var payload = buildControlPayload(slice, presetId);
  if (!payload.presetId) return;

  // 표시용 하트비트는 클라우드 금지 (호출부가 실수로 넘겨도 차단)
  if (options.heartbeat && !options.urgent) {
    console.warn(
      "[MetisFirestore] saveTimerControl: heartbeat 쓰기 차단 (로컬 endAt만 사용)"
    );
    return;
  }

  var sig = controlSignature(payload);
  var now = Date.now();
  var urgent = !!options.urgent;
  var isRetry = !!options.isRetry;
  // 시작/일시정지·레벨업은 기기 간 체감을 위해 즉시 전송
  var pushOpts = Object.assign({}, options, {
    immediate: !!options.immediate || urgent || isRetry,
  });

  if (!urgent && !isRetry) {
    if (sig === lastControlPushSig) return;
    if (
      lastControlPushAt > 0 &&
      now - lastControlPushAt < CONTROL_PUSH_MIN_MS
    ) {
      return;
    }
    if (!allowControlPushRate(now)) return;
  } else if (
    !isRetry &&
    sig === lastControlPushSig &&
    lastControlPushAt > 0 &&
    now - lastControlPushAt < 50
  ) {
    // 동일 urgent 연타만 무시 (재시도는 통과)
    return;
  }

  var channel = "timerControl:" + payload.presetId;
  var fallbackSlice = slice;
  return scheduleFirestorePush(
    channel,
    function () {
      var livePayload = resolveLiveControlPayload(payload.presetId, fallbackSlice);
      console.log("[MetisFirestore|PUSH|saveTimerControl]", {
        presetId: livePayload.presetId,
        urgent: urgent,
        retry: isRetry,
        heartbeat: !!options.heartbeat,
        lastActionTimestamp: livePayload.lastActionTimestamp,
        isRunning: livePayload.timer && livePayload.timer.isRunning,
        endAt: livePayload.timer && livePayload.timer.endAt,
        levelIndex: livePayload.timer && livePayload.timer.levelIndex,
        timerStatus: livePayload.timerStatus,
      });
      return pushTimerControlPayload(livePayload, {
        urgent: urgent,
        isRetry: isRetry,
      });
    },
    pushOpts
  );
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

function notifyTimerControlUi(detail) {
  setCloudSyncBadgeState("synced", "동기화됨");
  try {
    window.dispatchEvent(
      new CustomEvent("metis-timer-control-applied", {
        detail: detail || {},
      })
    );
  } catch (e0) {}
  if (
    window.MetisTimer &&
    typeof MetisTimer.notifyLocalSyncListeners === "function"
  ) {
    MetisTimer.notifyLocalSyncListeners();
  }
}

var cloudSyncBadgeId = "";
var cloudSyncBadgeUnsub = null;
var cloudSyncBadgeTimer = null;
var CLOUD_SYNC_BADGE_STALL_MS = 12000;
var timerControlHasSnapshot = false;
var pendingControlSnap = null;
var pendingBuyInSnap = null;

function setCloudSyncBadgeState(state, label) {
  var id = cloudSyncBadgeId || "cloud-sync-badge";
  var el =
    typeof document !== "undefined" ? document.getElementById(id) : null;
  if (!el) return;
  el.setAttribute("data-state", state || "idle");
  var lab = el.querySelector(".cloud-sync-label");
  if (lab) lab.textContent = label || "";
  if (cloudSyncBadgeTimer) {
    clearTimeout(cloudSyncBadgeTimer);
    cloudSyncBadgeTimer = null;
  }
  if (state === "syncing") {
    cloudSyncBadgeTimer = setTimeout(function () {
      cloudSyncBadgeTimer = null;
      var cur =
        typeof document !== "undefined" ? document.getElementById(id) : null;
      if (cur && cur.getAttribute("data-state") === "syncing") {
        setCloudSyncBadgeState("stalled", "연결 지연");
      }
    }, CLOUD_SYNC_BADGE_STALL_MS);
  }
}

function bindCloudSyncBadge(elementId) {
  cloudSyncBadgeId = elementId || "cloud-sync-badge";
  if (timerControlHasSnapshot) {
    setCloudSyncBadgeState("synced", "동기화됨");
  } else {
    setCloudSyncBadgeState("syncing", "동기화 중");
  }
  if (cloudSyncBadgeUnsub) return;
  cloudSyncBadgeUnsub = true;
  window.addEventListener("metis-timer-control-applied", function () {
    setCloudSyncBadgeState("synced", "동기화됨");
  });
  window.addEventListener("metis-firebase-ready", function () {
    if (!timerControlHasSnapshot) {
      setCloudSyncBadgeState("syncing", "동기화 중");
    }
  });
  if (typeof navigator !== "undefined") {
    window.addEventListener("offline", function () {
      setCloudSyncBadgeState("offline", "오프라인");
    });
    window.addEventListener("online", function () {
      if (!timerControlHasSnapshot) {
        setCloudSyncBadgeState("syncing", "동기화 중");
      }
    });
  }
}

/**
 * Firestore timerControl → 로컬 적용 (Firestore LWW)
 * 로컬 lastActionTimestamp 가 더 크면(방금 조작) echo 대기만 하고 무시
 * @param {string} presetId
 * @param {object} raw
 * @param {{ bootHydrate?: boolean }=} options
 */
function applyTimerControlToLocal(presetId, raw, options) {
  options = options || {};
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
  var localWouldRollback = !!(
    localSlice &&
    MetisTimer.isStaleTimerControlWrite &&
    MetisTimer.isStaleTimerControlWrite(localSlice, cloudSlice)
  );
  var cloudIntentional = !!(
    MetisTimer.isIntentionalLevelMutation
      ? MetisTimer.isIntentionalLevelMutation(cloudSlice)
      : cloudSlice.levelAdvanceKind === "manual" ||
        cloudSlice.levelAdvanceKind === "reset"
  );
  var bootGrace = !!(
    MetisTimer.isBootGraceActive && MetisTimer.isBootGraceActive()
  );
  var isOwner = !!(
    MetisTimer.shouldOwnEngine && MetisTimer.shouldOwnEngine(Date.now())
  );
  var cloudIdx = MetisTimer.sliceLevelIndex
    ? MetisTimer.sliceLevelIndex(cloudSlice)
    : 0;
  var localIdx = MetisTimer.sliceLevelIndex
    ? MetisTimer.sliceLevelIndex(localSlice)
    : 0;
  var hydrate = !!options.bootHydrate || controlHydratePending || bootGrace;

  if (hydrate) {
    if (isOwner && localIdx > cloudIdx) {
      console.log("[MetisFirestore|PULL|applyTimerControl:부팅로컬선행_서버치유]", {
        localIdx: localIdx,
        cloudIdx: cloudIdx,
        localLA: localLA,
        remoteLA: remoteLA,
      });
      controlHydratePending = false;
      saveTimerControl(pid, localSlice, { urgent: true, immediate: true });
      return false;
    }
  }

  // 로컬이 더 최신 조작이면 Firestore stale 스냅샷 무시 (곧 echo로 맞춰짐).
  // 단, 로컬이 레벨을 되돌리는 낡은 쓰기이거나, 클라우드가 LEVEL±/종료면 따른다.
  // 새 기기 부팅(팔로워)은 캐시 LA가 앞서 있어도 서버를 따른다.
  if (remoteLA > 0 && localLA > remoteLA) {
    if (!localWouldRollback && !cloudIntentional && !(hydrate && !isOwner)) {
      console.log("[MetisFirestore|PULL|applyTimerControl:로컬조작최신무시]", {
        localLA: localLA,
        remoteLA: remoteLA,
      });
      return false;
    }
    console.log("[MetisFirestore|PULL|applyTimerControl:로컬보다클라우드우선]", {
      localLA: localLA,
      remoteLA: remoteLA,
      cloudIntentional: cloudIntentional,
      localWouldRollback: localWouldRollback,
      hydrate: hydrate,
      cloudLevel: cloudSlice.timer && cloudSlice.timer.levelIndex,
      localLevel: localSlice && localSlice.timer && localSlice.timer.levelIndex,
    });
  }

  // 로컬이 이미 스케줄 종료인데 동일/이전 세대의 재생 중 클라우드면 무시
  // (레벨 만료 → 디바운스 PUSH 전에 stale 스냅샷이 덮어 처음부터 반복되던 레이스)
  var localFinished =
    (state.timerStatus || "") === "종료" &&
    !(
      state.timer &&
      (state.timer.isRunning ||
        (state.timer.bridge && state.timer.bridge.kind))
    );
  var cloudPlaying = MetisTimer.isEffectivelyPlayingSlice
    ? MetisTimer.isEffectivelyPlayingSlice(cloudSlice)
    : !!(
        cloudSlice.timer &&
        (cloudSlice.timer.isRunning ||
          (cloudSlice.timer.bridge && cloudSlice.timer.bridge.kind))
      );
  if (localFinished && cloudPlaying && remoteLA <= localLA) {
    console.log("[MetisFirestore|PULL|applyTimerControl:로컬종료보호]", {
      localLA: localLA,
      remoteLA: remoteLA,
      cloudLevel: cloudSlice.timer && cloudSlice.timer.levelIndex,
    });
    return false;
  }

  if (
    localSlice &&
    MetisTimer.isStaleTimerControlWrite &&
    MetisTimer.isStaleTimerControlWrite(cloudSlice, localSlice)
  ) {
    if (hydrate && !isOwner) {
      console.log("[MetisFirestore|PULL|applyTimerControl:팔로워부팅_서버강제]", {
        localLA: localLA,
        remoteLA: remoteLA,
        cloudLevel: cloudSlice.timer && cloudSlice.timer.levelIndex,
        localLevel: localSlice.timer && localSlice.timer.levelIndex,
      });
    } else {
      console.log("[MetisFirestore|PULL|applyTimerControl:낡은레벨롤백거부]", {
        localLA: localLA,
        remoteLA: remoteLA,
        cloudLevel: cloudSlice.timer && cloudSlice.timer.levelIndex,
        localLevel: localSlice.timer && localSlice.timer.levelIndex,
        kind: cloudSlice.levelAdvanceKind,
      });
      return false;
    }
  }

  if (
    !hydrate &&
    MetisTimer.isPrematureCloudExpire &&
    MetisTimer.isPrematureCloudExpire(cloudSlice, localSlice, MetisTimer.now())
  ) {
    console.log("[MetisFirestore|PULL|applyTimerControl:조기만료거부]", {
      cloudLevel: cloudSlice.timer && cloudSlice.timer.levelIndex,
      localLevel: localSlice.timer && localSlice.timer.levelIndex,
      kind: cloudSlice.levelAdvanceKind,
    });
    return false;
  }

  // 동일 조작 세대에서 로컬 진행도가 더 앞서면(낙관적 레벨 만료) 클라우드 롤백 거부
  if (
    !hydrate &&
    remoteLA === localLA &&
    localSlice &&
    MetisTimer.timerGameplayRank &&
    MetisTimer.timerGameplayRank(localSlice) >
      MetisTimer.timerGameplayRank(cloudSlice) + 5
  ) {
    console.log("[MetisFirestore|PULL|applyTimerControl:로컬진행도우선]", {
      localRank: MetisTimer.timerGameplayRank(localSlice),
      cloudRank: MetisTimer.timerGameplayRank(cloudSlice),
    });
    return false;
  }

  // 동일 조작 세대 + 제어 시그니처 동일 = display/heartbeat 잔여 스냅샷 → 스킵
  // (과거 3초 heartbeat 문서가 남아 있어도 읽기→재적용 루프를 끊는다)
  if (
    remoteLA === localLA &&
    localSlice &&
    controlSignature(cloudSlice) === controlSignature(buildControlPayload(localSlice, pid))
  ) {
    var cloudHb = Number(cloudSlice.heartbeatAt) || 0;
    var localHb = Number(state.heartbeatAt) || 0;
    if (cloudHb <= localHb) {
      setCloudSyncBadgeState("synced", "동기화됨");
      return false;
    }
    // heartbeatAt만 앞선 경우: 로컬 타임스탬프만 맞추고 UI/클라우드 재푸시 없음
    state.heartbeatAt = cloudHb;
    MetisTimer.writeSyncState(state, {
      skipCloudPush: true,
      preserveUpdatedAt: true,
    });
    setCloudSyncBadgeState("synced", "동기화됨");
    return false;
  }

  var prevLevel =
    state.timer && state.timer.levelIndex != null ? state.timer.levelIndex : 0;

  // Firestore 우선: 클라우드 조작이 더 최신일 때만 강제 적용
  // 부팅 hydrate(새 기기/팔로워)는 로컬 캐시보다 서버를 강제 채택
  var applied = MetisTimer.applyTimerSyncSlice(state, cloudSlice, {
    forceApply:
      remoteLA > localLA ||
      localWouldRollback ||
      cloudIntentional ||
      (hydrate && !isOwner),
    bootHydrate: hydrate,
  });

  if (!applied) {
    controlHydratePending = false;
    return false;
  }

  controlHydratePending = false;

  MetisTimer.writeSyncState(state, {
    skipCloudPush: true,
    preserveUpdatedAt: true,
  });

  var newLevel =
    state.timer && state.timer.levelIndex != null ? state.timer.levelIndex : 0;
  var result = {
    changed: true,
    leveledUp: newLevel > prevLevel,
    prevLevelIndex: prevLevel,
    newLevelIndex: newLevel,
    presetId: pid,
    timerStatus: state.timerStatus,
    displayTime: state.displayTime,
    hasStartedOnce: !!state.hasStartedOnce,
  };
  console.log("[MetisFirestore|PULL|applyTimerControl:적용]", {
    presetId: pid,
    remoteLA: remoteLA,
    localLA: localLA,
    isRunning: state.timer && state.timer.isRunning,
    endAt: state.timer && state.timer.endAt,
    levelIndex: newLevel,
    leveledUp: result.leveledUp,
    timerStatus: state.timerStatus,
  });

  // 로컬 저장 직후 타이머/리모컨 UI를 강제 갱신 (시트 폴링 콜백 대체)
  notifyTimerControlUi(result);

  return result;
}

function applyBuyInSnapshot(pid, snap) {
  if (!window.MetisTimer) {
    pendingBuyInSnap = { pid: pid, snap: snap };
    return false;
  }
  if (!snap || !snap.exists()) {
    console.log("[MetisFirestore|PULL|buyIn:문서없음]", { presetId: pid });
    return false;
  }
  return applyBuyInToLocal(pid, snap.data());
}

function applyControlSnapshot(pid, snap, options) {
  options = options || {};
  if (!window.MetisTimer) {
    pendingControlSnap = { pid: pid, snap: snap, options: options };
    return false;
  }
  timerControlHasSnapshot = true;
  timerControlServerHydrated = true;
  if (!snap || !snap.exists()) {
    console.log("[MetisFirestore|PULL|timerControl:문서없음]", {
      presetId: pid,
    });
    controlHydratePending = false;
    setCloudSyncBadgeState("synced", "동기화됨");
    return false;
  }
  var result = applyTimerControlToLocal(pid, snap.data(), options);
  if (!result) {
    setCloudSyncBadgeState("synced", "동기화됨");
  }
  return result;
}

function flushQueuedLiveSnaps() {
  if (pendingControlSnap && window.MetisTimer) {
    var q = pendingControlSnap;
    pendingControlSnap = null;
    if (!controlPresetId || String(q.pid) === String(controlPresetId)) {
      applyControlSnapshot(q.pid, q.snap, q.options || { bootHydrate: true });
    }
  }
  if (pendingBuyInSnap && window.MetisTimer) {
    var b = pendingBuyInSnap;
    pendingBuyInSnap = null;
    if (!buyInPresetId || String(b.pid) === String(buyInPresetId)) {
      applyBuyInSnapshot(b.pid, b.snap);
    }
  }
}

function stopBuyInSync() {
  if (buyInUnsub) {
    buyInUnsub();
    buyInUnsub = null;
  }
  buyInPresetId = "";
  pendingBuyInSnap = null;
}

function stopTimerControlSync() {
  if (controlUnsub) {
    controlUnsub();
    controlUnsub = null;
  }
  if (controlCacheFallbackTimer) {
    clearTimeout(controlCacheFallbackTimer);
    controlCacheFallbackTimer = null;
  }
  controlPresetId = "";
  pendingControlSnap = null;
  timerControlServerHydrated = false;
  controlHydratePending = false;
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

  // 프리셋 변경/재구독 전 반드시 기존 리스너 해제 (중복 onSnapshot 방지)
  stopBuyInSync();
  buyInPresetId = pid;
  buyInOnApplied = typeof onApplied === "function" ? onApplied : null;

  console.log("[MetisFirestore|PULL|startBuyInSync]", { presetId: pid });
  buyInUnsub = onSnapshot(
    buyInRef(pid),
    function (snap) {
      var changed = applyBuyInSnapshot(pid, snap);
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
    if (timerControlHasSnapshot) {
      setCloudSyncBadgeState("synced", "동기화됨");
      if (typeof controlOnApplied === "function") {
        controlOnApplied({ changed: false, presetId: pid });
      }
    }
    return;
  }

  // 프리셋 변경/재구독 전 반드시 기존 리스너 해제 (중복 onSnapshot 방지)
  stopTimerControlSync();
  controlPresetId = pid;
  controlOnApplied = typeof onApplied === "function" ? onApplied : null;
  timerControlHasSnapshot = false;
  timerControlServerHydrated = false;
  controlHydratePending = true;
  setCloudSyncBadgeState("syncing", "동기화 중");

  console.log("[MetisFirestore|PULL|startTimerControlSync]", { presetId: pid });

  fetchTimerControlFromServer(pid);

  if (controlCacheFallbackTimer) clearTimeout(controlCacheFallbackTimer);
  controlCacheFallbackTimer = setTimeout(function () {
    controlCacheFallbackTimer = null;
    if (timerControlServerHydrated) return;
    if (pendingControlSnap && String(pendingControlSnap.pid) === pid) {
      console.warn(
        "[MetisFirestore] 서버 hydrate 대기 초과 — 캐시 스냅샷 사용",
        { presetId: pid }
      );
      timerControlServerHydrated = true;
      var queued = pendingControlSnap;
      pendingControlSnap = null;
      applyControlSnapshot(queued.pid, queued.snap, { bootHydrate: true });
    }
  }, 3500);

  controlUnsub = onSnapshot(
    controlRef(pid),
    function (snap) {
      var fromCache = !!(snap.metadata && snap.metadata.fromCache);
      if (fromCache && !timerControlServerHydrated) {
        pendingControlSnap = { pid: pid, snap: snap, options: { bootHydrate: true } };
        console.log("[MetisFirestore|PULL|timerControl:캐시대기]", {
          presetId: pid,
        });
        return;
      }
      timerControlServerHydrated = true;
      if (controlCacheFallbackTimer) {
        clearTimeout(controlCacheFallbackTimer);
        controlCacheFallbackTimer = null;
      }
      var result = applyControlSnapshot(pid, snap, {
        bootHydrate: controlHydratePending,
      });
      if (result && result.changed && typeof controlOnApplied === "function") {
        controlOnApplied(result);
      }
    },
    function (err) {
      console.warn("[MetisFirestore] timerControl onSnapshot 오류:", err);
      setCloudSyncBadgeState("offline", "오류");
    }
  );
}

/** IndexedDB 캐시를 건너뛰고 서버 원본 timerControl 을 적용 */
function fetchTimerControlFromServer(presetId) {
  var pid = String(presetId || "");
  if (!pid) return Promise.resolve(null);
  return getDocFromServer(controlRef(pid))
    .then(function (snap) {
      if (controlCacheFallbackTimer) {
        clearTimeout(controlCacheFallbackTimer);
        controlCacheFallbackTimer = null;
      }
      console.log("[MetisFirestore|PULL|timerControl:서버원본]", {
        presetId: pid,
        exists: !!(snap && snap.exists && snap.exists()),
      });
      var result = applyControlSnapshot(pid, snap, { bootHydrate: true });
      if (result && result.changed && typeof controlOnApplied === "function") {
        controlOnApplied(result);
      }
      return result;
    })
    .catch(function (err) {
      console.warn("[MetisFirestore] timerControl 서버 원본 읽기 실패:", err);
      return null;
    });
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
/** PULL(onSnapshot) 적용 중 — 이 동안 클라우드 PUSH 금지 */
var presetsApplyingRemote = false;
/** 로컬→Firestore 푸시 대기열: 스냅샷이 이보다 오래되면 무시 */
var pendingPresetWrites = {};
/** 동일 페이로드 재푸시 차단 */
var lastPresetPushSig = "";
var lastPresetPushAt = 0;
var PRESET_PUSH_MIN_MS = 1500;
var PRESET_PUSH_MAX_PER_MIN = 20;
var presetPushWindowStart = 0;
var presetPushWindowCount = 0;
/** 스냅샷 적용 직후 잠깐 PUSH 차단 (echo 재진입 방지) */
var presetsPullCooldownUntil = 0;
var PRESETS_PULL_COOLDOWN_MS = 2000;

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
}

function filterDeletedPresetsFs(list) {
  list = Array.isArray(list) ? list : [];
  var map = loadFsDeletedMap();
  // 문서 자체에 deleted:true 가 있으면 제외 (로컬 캐시·시드 잔존 방지)
  list = list.filter(function (p) {
    if (!p || !p.id) return false;
    if (p.deleted === true || p.deleted === "true" || p.deleted === 1) {
      return false;
    }
    return true;
  });
  if (!Object.keys(map).length) return list.slice();
  return list.filter(function (p) {
    return p && p.id && !Object.prototype.hasOwnProperty.call(map, String(p.id));
  });
}

/** 프리셋 문서용 정규화 — player/entry(실시간) 제외. 중첩 배열은 깊은 복사 */
function normalizePresetForFs(preset) {
  if (!preset || typeof preset !== "object") return null;
  var id = preset.id != null ? String(preset.id) : "";
  if (!id) return null;
  var levelsClone = [];
  if (Array.isArray(preset.levels)) {
    try {
      levelsClone =
        typeof structuredClone === "function"
          ? structuredClone(preset.levels)
          : JSON.parse(JSON.stringify(preset.levels));
    } catch (eLv) {
      levelsClone = preset.levels.map(function (row) {
        return row && typeof row === "object" ? Object.assign({}, row) : row;
      });
    }
  }
  var out = {
    id: id,
    name: String(preset.name != null ? preset.name : "").trim() || "프리셋",
    levels: levelsClone,
    tournamentName:
      preset.tournamentName != null ? String(preset.tournamentName) : "",
    totalPrizeText:
      preset.totalPrizeText != null ? String(preset.totalPrizeText) : "",
    tournamentInfo:
      preset.tournamentInfo != null ? String(preset.tournamentInfo) : "",
    prizeText: preset.prizeText != null ? String(preset.prizeText) : "",
    prizeItems: Array.isArray(preset.prizeItems)
      ? preset.prizeItems
          .map(function (item) {
            if (!item || typeof item !== "object") return null;
            var rank = String(item.rank != null ? item.rank : "").trim().slice(0, 24);
            var amountNum = 0;
            if (typeof item.amount === "number") {
              amountNum = Math.max(
                0,
                Math.floor(Number.isFinite(item.amount) ? item.amount : 0)
              );
            } else {
              var digits = String(item.amount == null ? "" : item.amount).replace(/\D/g, "");
              amountNum = digits ? Math.max(0, Math.floor(Number(digits) || 0)) : 0;
            }
            var extraPrize = String(item.extraPrize != null ? item.extraPrize : "")
              .trim()
              .slice(0, 48);
            // 금액이 없어도 extraPrize가 있으면 Firebase/로컬에 유지
            if (!rank || !(amountNum > 0 || extraPrize)) return null;
            return {
              rank: rank,
              amount: amountNum,
              extraPrize: extraPrize,
            };
          })
          .filter(Boolean)
      : [],
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

function presetPushSignature(docs) {
  try {
    return (docs || [])
      .map(function (d) {
        return String(d.id) + ":" + (Number(d.updatedAt) || 0);
      })
      .sort()
      .join("|");
  } catch (e0) {
    return String(Date.now());
  }
}

function allowPresetPushRate(now) {
  if (!presetPushWindowStart || now - presetPushWindowStart >= 60000) {
    presetPushWindowStart = now;
    presetPushWindowCount = 0;
  }
  if (presetPushWindowCount >= PRESET_PUSH_MAX_PER_MIN) {
    console.warn(
      "[MetisFirestore] savePresets 분당 한도 초과 — 쓰기 차단",
      presetPushWindowCount
    );
    return false;
  }
  presetPushWindowCount += 1;
  return true;
}

function isPresetsApplyingRemote() {
  return (
    !!presetsApplyingRemote || Date.now() < presetsPullCooldownUntil
  );
}

/** onSnapshot 콜백 본문 실행 중(쿨다운 제외) — 홈 DOM 덮어쓰기 방지용 */
function isPresetsPullInProgress() {
  return !!presetsApplyingRemote;
}

/**
 * 단일/복수 프리셋을 Firestore에 저장
 * @param {object|object[]} presets
 * @param {{ urgent?: boolean, fromUser?: boolean, immediate?: boolean }=} options
 *
 * ⛔ onSnapshot(PULL) 적용 중·쿨다운 중에는 PUSH 하지 않는다.
 *    soft-delete 톰스톤을 임의로 지우지 않는다(부활 핑퐁 방지).
 *    pendingPresetWrites / 로컬은 즉시 갱신하고, setDoc 만 디바운스.
 */
function savePresetsToFirestore(presets, options) {
  options = options || {};
  var fromUser = !!(options.fromUser || options.urgent);
  var now = Date.now();

  if (presetsApplyingRemote && !fromUser) {
    console.warn(
      "[MetisFirestore] savePresets: PULL 적용 중 PUSH 차단"
    );
    return Promise.resolve(null);
  }
  if (!fromUser && now < presetsPullCooldownUntil) {
    console.warn(
      "[MetisFirestore] savePresets: PULL 쿨다운 중 PUSH 차단"
    );
    return Promise.resolve(null);
  }

  var list = Array.isArray(presets) ? presets : presets ? [presets] : [];
  var deletedMap = loadFsDeletedMap();
  var docs = [];
  for (var i = 0; i < list.length; i++) {
    var normalized = normalizePresetForFs(list[i]);
    if (!normalized || normalized.deleted) continue;
    var pid = String(normalized.id);
    // soft-delete 된 ID는 사용자 명시 복구가 아니면 절대 재업로드하지 않음
    if (Object.prototype.hasOwnProperty.call(deletedMap, pid) && !options.forceUndelete) {
      console.warn(
        "[MetisFirestore] savePresets: 삭제된 프리셋 재푸시 차단",
        pid
      );
      continue;
    }
    if (!normalized.updatedAt) normalized.updatedAt = now;
    normalized.deleted = false;
    docs.push(normalized);
    if (options.forceUndelete) {
      clearPresetsDeletedFs([normalized.id]);
    }
    // LWW용 대기열은 즉시 등록 (디바운스 중에도 PULL이 덮지 않도록)
    pendingPresetWrites[pid] = {
      updatedAt: normalized.updatedAt,
      payload: normalized,
    };
  }
  if (!docs.length) return Promise.resolve();

  var sig = presetPushSignature(docs);
  if (!fromUser && sig === lastPresetPushSig) {
    return Promise.resolve(null);
  }
  if (
    !fromUser &&
    lastPresetPushAt > 0 &&
    now - lastPresetPushAt < PRESET_PUSH_MIN_MS
  ) {
    console.warn("[MetisFirestore] savePresets: 최소 간격 미달 — 스킵");
    return Promise.resolve(null);
  }
  if (!fromUser && !allowPresetPushRate(now)) {
    return Promise.resolve(null);
  }

  lastPresetPushSig = sig;
  lastPresetPushAt = now;

  // 채널 하나에 문서들을 id 기준으로 합친 뒤 디바운스 플러시
  var channel = "presets";
  if (!syncDelayPendingDocs) syncDelayPendingDocs = {};
  docs.forEach(function (d) {
    syncDelayPendingDocs[String(d.id)] = d;
  });

  var pushOpts = Object.assign({}, options, {
    // 시드·강제 즉시만 immediate. 일반 저장은 디바운스로 연속 수정 합치기
    immediate: !!options.immediate,
  });

  return scheduleFirestorePush(
    channel,
    function () {
      var merged = [];
      var ids = Object.keys(syncDelayPendingDocs || {});
      for (var m = 0; m < ids.length; m++) {
        merged.push(syncDelayPendingDocs[ids[m]]);
      }
      syncDelayPendingDocs = {};
      if (!merged.length) return Promise.resolve(null);

      console.log("[MetisFirestore|PUSH|savePresets]", {
        count: merged.length,
        ids: merged.map(function (d) {
          return d.id;
        }),
        urgent: !!options.urgent,
        fromUser: fromUser,
        deferred: !!(SYNC_DELAY_ENABLED && !pushOpts.immediate),
      });

      var batch = writeBatch(db);
      for (var j = 0; j < merged.length; j++) {
        batch.set(presetDocRef(merged[j].id), merged[j], { merge: true });
      }
      return batch
        .commit()
        .then(function () {
          var local = loadLocalPresetsRaw();
          var byId = {};
          local.forEach(function (p, idx) {
            if (p && p.id) byId[String(p.id)] = idx;
          });
          merged.forEach(function (d) {
            var docPid = String(d.id);
            if (byId[docPid] != null) local[byId[docPid]] = d;
            else local.push(d);
          });
          saveLocalPresetsRaw(filterDeletedPresetsFs(local));
          return merged;
        })
        .catch(function (err) {
          console.warn("[MetisFirestore] 프리셋 저장 실패:", err);
          return null;
        });
    },
    pushOpts
  );
}

/**
 * 프리셋 삭제 (소프트 삭제 + 로컬 톰스톤)
 */
function deletePresetsFromFirestore(presetIds, options) {
  options = options || {};
  var ids = (presetIds || []).map(String).filter(Boolean);
  if (!ids.length) return Promise.resolve();
  markPresetsDeletedFs(ids);

  // 대기 중이던 저장 페이로드가 soft-delete 문서를 되살리지 못하게 제거
  for (var c = 0; c < ids.length; c++) {
    delete pendingPresetWrites[ids[c]];
  }

  // 로컬 목록에서도 즉시 제거
  var local = filterDeletedPresetsFs(loadLocalPresetsRaw()).filter(function (p) {
    return p && ids.indexOf(String(p.id)) < 0;
  });
  saveLocalPresetsRaw(local);

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
  // remote(Firestore) 우선. 중첩 필드 참조 공유 방지를 위해 정규화 복사
  var out = normalizePresetForFs(remoteP) || Object.assign({}, remoteP);
  if (localP && localP.id) out.id = String(localP.id);
  return out;
}

function applyPresetsSnapshot(snapshot) {
  var remoteActive = [];
  var remoteDeletedIds = [];
  var changed = false;
  snapshot.forEach(function (snapDoc) {
    var data = snapDoc.data() || {};
    data.id = data.id || snapDoc.id;
    if (
      data.deleted === true ||
      data.deleted === "true" ||
      data.deleted === 1
    ) {
      remoteDeletedIds.push(String(data.id));
      return;
    }
    var normalized = normalizePresetForFs(data);
    if (normalized && !normalized.deleted) remoteActive.push(normalized);
  });

  if (remoteDeletedIds.length) {
    markPresetsDeletedFs(remoteDeletedIds);
    for (var di = 0; di < remoteDeletedIds.length; di++) {
      delete pendingPresetWrites[remoteDeletedIds[di]];
    }
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
  // (전부 soft-delete만 있는 경우는 시드하지 않음 — remoteDeletedIds만 있는 상태)
  var seededFlag = false;
  try {
    seededFlag = localStorage.getItem(PRESETS_SEEDED_KEY) === "1";
  } catch (e0) {}

  if (
    !remoteActive.length &&
    !remoteDeletedIds.length &&
    localList.length &&
    !seededFlag
  ) {
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
    // 시드는 사용자 마이그레이션 — 즉시 전송
    savePresetsToFirestore(seedList, {
      urgent: true,
      fromUser: true,
      immediate: true,
    });
    notifyPresetsReady();
    return { changed: false, seeded: true, presets: localList };
  }

  try {
    localStorage.setItem(PRESETS_SEEDED_KEY, "1");
  } catch (e2) {}

  var out = [];
  // ⛔ PULL 경로에서 절대 자동 PUSH 하지 않음.
  //    로컬이 더 최신이어도 대기열(pendingPresetWrites)만 유지하고
  //    재업로드는 사용자 savePresets → savePresetsToFirestore 에만 맡긴다.
  //    (이전: rU < lU / local-only 자동 toPush → 무한 핑퐁)

  remoteActive.forEach(function (rp) {
    var pid = String(rp.id);
    if (Object.prototype.hasOwnProperty.call(deletedMap, pid)) return;
    var lp = localById[pid];
    var pending = pendingPresetWrites[pid];
    var rU = presetUpdatedAt(rp);

    // 아직 반영 전인 로컬 푸시가 더 최신이면 스냅샷으로 덮지 않음
    if (pending && pending.updatedAt > rU) {
      out.push(pending.payload);
      return;
    }
    if (pending && pending.updatedAt <= rU) {
      delete pendingPresetWrites[pid];
    }

    if (!lp) {
      out.push(rp);
      changed = true;
      return;
    }
    var lU = presetUpdatedAt(lp);
    if (pending) lU = Math.max(lU, pending.updatedAt);
    if (rU >= lU) {
      // Firestore SSOT (동률 포함) — 로컬 재푸시 금지
      out.push(mergeLocalTournamentOntoRemote(lp, rp));
      if (rU > lU) changed = true;
    } else if (pending) {
      // 사용자 푸시 대기 중: 로컬 유지, PUSH는 하지 않음(이미 전송됨)
      out.push(pending.payload);
    } else {
      // 로컬 updatedAt만 앞선 경우(hydrate 등) — 클라우드를 SSOT로 채택해 핑퐁 차단
      out.push(mergeLocalTournamentOntoRemote(lp, rp));
      changed = true;
    }
  });

  localList.forEach(function (lp) {
    if (!lp || !lp.id) return;
    var pid = String(lp.id);
    if (Object.prototype.hasOwnProperty.call(deletedMap, pid)) {
      changed = true;
      return;
    }
    if (remoteById[pid]) return;
    if (remoteDeletedIds.indexOf(pid) >= 0) {
      changed = true;
      return;
    }
    // 원격에 없는 로컬 전용: 목록에는 유지하되 자동 업로드하지 않음
    // (사용자가 저장/생성할 때 savePresetsToFirestore 가 처리)
    var localNorm = normalizePresetForFs(lp);
    if (!localNorm || localNorm.deleted) {
      changed = true;
      return;
    }
    out.push(localNorm);
  });

  // 삭제만 반영된 경우에도 로컬 목록에서 제거 필요
  // soft-delete 문서가 매 스냅샷에 남아 있어도, 로컬이 이미 정리됐으면 재저장하지 않음
  var outFiltered = filterDeletedPresetsFs(out).map(function (p) {
    return normalizePresetForFs(p) || p;
  });
  function presetContentSig(list) {
    try {
      return JSON.stringify(
        (list || []).map(function (p) {
          if (!p || !p.id) return "";
          // updatedAt 외에 대회 메타·이름도 비교 — 동률 타임스탬프 내용 변경도 감지
          return [
            String(p.id),
            Number(p.updatedAt) || 0,
            String(p.name || ""),
            String(p.tournamentName || ""),
            String(p.tournamentInfo || ""),
            String(p.totalPrizeText || ""),
            String(p.prizeText || ""),
            Array.isArray(p.prizeItems)
              ? p.prizeItems
                  .map(function (it) {
                    if (!it || typeof it !== "object") return "";
                    return [
                      String(it.rank || ""),
                      String(it.amount != null ? it.amount : ""),
                      String(it.extraPrize || ""),
                    ].join("|");
                  })
                  .join(";")
              : "",
            Number(p.entryChips) || 0,
            Number(p.infoFontScale) || 1,
            Number(p.prizeFontScale) || 1,
            p.leftPanelRotate ? 1 : 0,
            Array.isArray(p.levels) ? p.levels.length : 0,
          ].join(":");
        })
      );
    } catch (eSig) {
      return String(Date.now());
    }
  }
  var localSig = presetContentSig(localList);
  var outSig = presetContentSig(outFiltered);
  var localNeedsRewrite = changed || localSig !== outSig;

  presetsApplyingRemote = true;
  try {
    if (localNeedsRewrite) {
      saveLocalPresetsRaw(outFiltered);
      if (
        window.MetisTimer &&
        typeof MetisTimer.syncAllPresetsMetadataFromStorage === "function"
      ) {
        MetisTimer.syncAllPresetsMetadataFromStorage();
      }
      changed = true;
    }
  } finally {
    presetsApplyingRemote = false;
    presetsPullCooldownUntil = Date.now() + PRESETS_PULL_COOLDOWN_MS;
  }

  console.log("[MetisFirestore|PULL|applyPresets]", {
    remote: remoteActive.length,
    localOut: outFiltered.length,
    changed: changed,
    deleted: remoteDeletedIds.length,
    autoPush: false,
    localRewrite: localNeedsRewrite,
  });

  notifyPresetsReady();
  var appliedResult = {
    changed: changed,
    presets: outFiltered,
    deletedIds: remoteDeletedIds,
  };
  try {
    window.dispatchEvent(
      new CustomEvent("metis-presets-remote-applied", { detail: appliedResult })
    );
  } catch (eEv) {}
  return appliedResult;
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

function assetUrl(path) {
  var v =
    (typeof window !== "undefined" &&
      window.__METIS_ASSET_V != null &&
      String(window.__METIS_ASSET_V)) ||
    "1";
  if (!path || path.indexOf("?") >= 0) return path;
  return path + "?v=" + encodeURIComponent(v);
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

function findPresetByIdLocal(list, id) {
  if (!id || !Array.isArray(list)) return null;
  var sid = String(id);
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].id) === sid) return list[i];
  }
  return null;
}

function loadLocalPresetsList() {
  try {
    var raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return filterDeletedPresetsFs(Array.isArray(arr) ? arr : []);
  } catch (e0) {
    return [];
  }
}

function upsertLocalPreset(normalized) {
  if (!normalized || !normalized.id) return;
  var local = loadLocalPresetsRaw();
  var sid = String(normalized.id);
  var found = false;
  for (var i = 0; i < local.length; i++) {
    if (local[i] && String(local[i].id) === sid) {
      local[i] = normalized;
      found = true;
      break;
    }
  }
  if (!found) local.push(normalized);
  saveLocalPresetsRaw(filterDeletedPresetsFs(local));
}

/** 부팅용: 활성 프리셋 문서만 먼저 가져와 블라인드/메타를 빨리 채운다 */
function fetchActivePresetFast(presetId) {
  var pid = String(presetId || "");
  if (!pid) return Promise.resolve(null);
  return getDocFromServer(presetDocRef(pid))
    .then(function (snap) {
      if (!snap || !snap.exists()) return null;
      var data = snap.data() || {};
      data.id = data.id || snap.id;
      if (
        data.deleted === true ||
        data.deleted === "true" ||
        data.deleted === 1
      ) {
        return null;
      }
      var normalized = normalizePresetForFs(data);
      if (!normalized || normalized.deleted) return null;
      upsertLocalPreset(normalized);
      console.log("[MetisFirestore|PULL|activePresetFast]", { presetId: pid });
      if (
        window.MetisTimer &&
        typeof MetisTimer.syncAllPresetsMetadataFromStorage === "function"
      ) {
        MetisTimer.syncAllPresetsMetadataFromStorage();
      }
      if (
        window.MetisTimer &&
        typeof MetisTimer.notifyLocalSyncListeners === "function"
      ) {
        MetisTimer.notifyLocalSyncListeners();
      }
      try {
        window.dispatchEvent(
          new CustomEvent("metis-presets-remote-applied", {
            detail: { changed: true, presets: loadLocalPresetsList(), fast: true },
          })
        );
      } catch (e0) {}
      return normalized;
    })
    .catch(function (err) {
      console.warn("[MetisFirestore] 활성 프리셋 선로드 실패:", err);
      return null;
    });
}

/** timer.html 부팅: URL id 우선 (로컬 캐시 없어도 해당 대회에 연결) */
function resolveBootPresetId() {
  var urlId = null;
  try {
    if (typeof location !== "undefined" && location.search) {
      urlId = new URLSearchParams(location.search).get("id");
    }
  } catch (e0) {}
  if (urlId) return String(urlId);

  var list = loadLocalPresetsList();
  if (list.length) {
    var aid = "";
    try {
      aid = localStorage.getItem("metis_activePresetId") || "";
    } catch (e1) {}
    if (aid && findPresetByIdLocal(list, aid)) return String(aid);
    return String(list[0].id);
  }

  return "preset_default";
}

function ensureTimerStateBootstrapped() {
  if (!window.MetisTimer || !window.MetisTimer.readSyncState) return false;

  var presetId =
    window.__METIS_TIMER_PRESET_ID != null && window.__METIS_TIMER_PRESET_ID !== ""
      ? String(window.__METIS_TIMER_PRESET_ID)
      : resolveBootPresetId();
  if (!presetId) return false;

  window.MetisTimer.setSyncPresetId(presetId);
  var state = window.MetisTimer.readSyncState();
  if (!state) return false;

  if (typeof document !== "undefined") {
    try {
      document.dispatchEvent(new Event("metis-presets-bootstrapped"));
    } catch (e1) {}
  }
  return true;
}

/**
 * timer.html: 타이머 제어를 먼저 구독하고, 프리셋 전체는 백그라운드
 */
function bootTimerPage(resolvePresetIdFn) {
  var resolveId =
    typeof resolvePresetIdFn === "function"
      ? resolvePresetIdFn
      : resolveBootPresetId;

  function continueBoot() {
    window.__METIS_TIMER_PRESET_ID = resolveId();
    var pid = window.__METIS_TIMER_PRESET_ID
      ? String(window.__METIS_TIMER_PRESET_ID)
      : "";
    bindCloudSyncBadge("cloud-sync-badge");
    if (pid) {
      fetchActivePresetFast(pid);
      startLiveSync(pid);
    }
    if (isPresetsLive) {
      startPresetsSync(function (result) {
        if (
          window.MetisTimer &&
          typeof MetisTimer.syncAllPresetsMetadataFromStorage === "function"
        ) {
          MetisTimer.syncAllPresetsMetadataFromStorage();
        }
        try {
          window.dispatchEvent(
            new CustomEvent("metis-presets-remote-applied", {
              detail: result || {},
            })
          );
        } catch (e0) {}
      });
    }
    return loadScript("timer-core.js")
      .then(function () {
        flushPendingClockOffset();
        if (pid && window.MetisTimer && window.MetisTimer.setSyncPresetId) {
          window.MetisTimer.setSyncPresetId(pid);
        }
        flushQueuedLiveSnaps();
        syncServerClockOffset(false);
        if (
          window.MetisTimer &&
          window.MetisTimer.syncAllPresetsMetadataFromStorage
        ) {
          window.MetisTimer.syncAllPresetsMetadataFromStorage();
        }
        ensureTimerStateBootstrapped();
        return loadScript("metis-audio.js");
      })
      .then(function () {
        flushQueuedLiveSnaps();
        if (!pid || timerControlServerHydrated) return;
        var startedAt = Date.now();
        return new Promise(function (resolve) {
          function check() {
            if (timerControlServerHydrated || Date.now() - startedAt >= 4000) {
              resolve();
              return;
            }
            setTimeout(check, 50);
          }
          check();
        });
      })
      .then(function () {
        flushQueuedLiveSnaps();
        if (window.__METIS_TIMER_BOOT_DONE) return;
        window.__METIS_TIMER_BOOT_DONE = true;
        window.dispatchEvent(new Event("metis-timer-boot-done"));
      })
      .catch(function (err) {
        console.warn("[MetisFirestore] 타이머 부팅 실패:", err);
        window.__METIS_TIMER_PRESET_ID = pid || "preset_default";
        if (window.__METIS_TIMER_BOOT_DONE) return;
        window.__METIS_TIMER_BOOT_DONE = true;
        window.dispatchEvent(new Event("metis-timer-boot-done"));
      });
  }

  return continueBoot();
}

window.MetisFirestoreSync = {
  isBuyInLive: isBuyInLive,
  isTimerControlLive: isTimerControlLive,
  isPresetsLive: isPresetsLive,
  /** PUSH 디바운스 ON/OFF — false 면 즉시 전송 */
  SYNC_DELAY_ENABLED: SYNC_DELAY_ENABLED,
  /** PUSH 대기 ms (기본 1800) */
  SYNC_DELAY_MS: SYNC_DELAY_MS,
  setSyncDelayEnabled: function (on) {
    SYNC_DELAY_ENABLED = !!on;
    window.MetisFirestoreSync.SYNC_DELAY_ENABLED = SYNC_DELAY_ENABLED;
  },
  setSyncDelayMs: function (ms) {
    var n = Math.max(0, Math.floor(Number(ms) || 0));
    SYNC_DELAY_MS = n;
    window.MetisFirestoreSync.SYNC_DELAY_MS = SYNC_DELAY_MS;
  },
  flushDeferredFirestorePush: flushDeferredFirestorePush,
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
  clearPresetsDeletedFs: clearPresetsDeletedFs,
  isPresetsApplyingRemote: isPresetsApplyingRemote,
  isPresetsPullInProgress: isPresetsPullInProgress,
  resolveBootPresetId: resolveBootPresetId,
  ensureTimerStateBootstrapped: ensureTimerStateBootstrapped,
  bootTimerPage: bootTimerPage,
  fetchTimerControlFromServer: fetchTimerControlFromServer,
  bindCloudSyncBadge: bindCloudSyncBadge,
  setCloudSyncBadgeState: setCloudSyncBadgeState,
  syncServerClockOffset: syncServerClockOffset,
  startClockOffsetSync: startClockOffsetSync,
  stopClockOffsetSync: stopClockOffsetSync,
  flushPendingClockOffset: flushPendingClockOffset,
};

startClockOffsetSync();
if (typeof window !== "undefined") {
  window.addEventListener("online", function () {
    if (!controlRetryPresetId) return;
    var pid = controlRetryPresetId;
    if (controlRetryTimer) {
      clearTimeout(controlRetryTimer);
      controlRetryTimer = null;
    }
    retryTimerControlPush(pid);
  });
}
window.dispatchEvent(new Event("metis-firebase-ready"));
console.log("[MetisFirestore] 준비 완료 (바인 + 타이머 제어 + 프리셋 + 시계보정)");
