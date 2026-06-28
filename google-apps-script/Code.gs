/**
 * Metis Timer — Google Sheets 백엔드
 *
 * [배포 방법]
 * 1. 이 프로젝트와 연결된 Google 스프레드시트 → 확장 프로그램 → Apps Script
 * 2. 기존 Code.gs 내용을 아래 코드로 교체
 * 3. 배포 → 새 배포 → 웹 앱(모든 사용자, 익명) → URL은 metis-sheet-sync.js CONFIG.url 과 동일해야 함
 *
 * [시트 "Metis" 레이아웃]
 *   A1: presets JSON (레거시·캐시 — presetRecords에서 자동 생성)
 *   A2: (미사용) activePresetId — UI 선택은 기기 로컬 전용, 클라우드에 저장하지 않음
 *   A3: updatedAt (숫자, 전역 워터마크)
 *   A4: timerStates JSON — 프리셋 id → 실시간 타이머 상태
 *   A5: presetRecords JSON — 프리셋 id → { data, updatedAt } (프리셋별 독립 LWW)
 */

var TOKEN = "metis_secret_444444";
var SHEET_NAME = "Metis";

function doGet() {
  var store = readStore_();
  return jsonResponse_(buildClientPayload_(store));
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: "invalid_json" });
  }

  if (!body || body.token !== TOKEN) {
    return jsonResponse_({ ok: false, error: "unauthorized" });
  }

  var store = readStore_();

  // 프리셋 배열 — presetId별로 독립 병합 (전체 덮어쓰기 금지)
  if (Array.isArray(body.presets) && body.presets.length) {
    store.presetRecords = mergePresetRecords_(
      store.presetRecords || {},
      body.presets,
      body.presetTimestamps || null,
      body.updatedAt
    );
    store.presets = presetRecordsToArray_(store.presetRecords);
  }

  // 단일 프리셋 빠른 업데이트
  if (body.preset && body.presetId) {
    var singlePid = String(body.presetId);
    var singleTs =
      body.presetTimestamps && body.presetTimestamps[singlePid]
        ? Number(body.presetTimestamps[singlePid])
        : body.updatedAt || Date.now();
    store.presetRecords = mergePresetRecords_(
      store.presetRecords || {},
      [body.preset],
      (function () {
        var m = {};
        m[singlePid] = singleTs;
        return m;
      })(),
      singleTs
    );
    store.presets = presetRecordsToArray_(store.presetRecords);
  }

  // 프리셋 삭제
  if (Array.isArray(body.deletedPresetIds) && body.deletedPresetIds.length) {
    store.presetRecords = deletePresetRecords_(
      store.presetRecords || {},
      body.deletedPresetIds
    );
    store.presets = presetRecordsToArray_(store.presetRecords);
    for (var di = 0; di < body.deletedPresetIds.length; di++) {
      var delPid = String(body.deletedPresetIds[di]);
      if (store.timerStates && store.timerStates[delPid]) {
        delete store.timerStates[delPid];
      }
    }
  }

  // activePresetId는 클라우드에 저장하지 않음 (기기별 UI 상태)

  if (body.timerStates && typeof body.timerStates === "object") {
    store.timerStates = mergeTimerStates_(store.timerStates || {}, body.timerStates);
  }

  if (body.timerState && body.presetId) {
    var pid = String(body.presetId);
    if (!store.timerStates) store.timerStates = {};
    var mergedOne = mergeOneTimerState_(store.timerStates[pid], body.timerState);
    if (mergedOne) store.timerStates[pid] = mergedOne;
  }

  store.updatedAt = Date.now();
  writeStore_(store);

  var payload = buildClientPayload_(store);
  payload.ok = true;
  return jsonResponse_(payload);
}

function buildClientPayload_(store) {
  return {
    presets: store.presets || [],
    presetTimestamps: presetTimestampsMap_(store.presetRecords || {}),
    updatedAt: store.updatedAt || 0,
    timerStates: store.timerStates || {},
  };
}

function presetRecordsToArray_(records) {
  var out = [];
  var k;
  records = records || {};
  for (k in records) {
    if (!Object.prototype.hasOwnProperty.call(records, k)) continue;
    var rec = records[k];
    if (rec && rec.data) out.push(rec.data);
  }
  out.sort(function (a, b) {
    return String(a && a.id ? a.id : "").localeCompare(
      String(b && b.id ? b.id : "")
    );
  });
  return out;
}

function presetTimestampsMap_(records) {
  var map = {};
  var k;
  records = records || {};
  for (k in records) {
    if (!Object.prototype.hasOwnProperty.call(records, k)) continue;
    map[k] = Number(records[k].updatedAt) || 0;
  }
  return map;
}

function mergePresetRecords_(existing, incomingPresets, incomingTsMap, fallbackTs) {
  existing = existing || {};
  incomingPresets = incomingPresets || [];
  incomingTsMap = incomingTsMap || {};
  fallbackTs = Number(fallbackTs) || Date.now();

  for (var i = 0; i < incomingPresets.length; i++) {
    var p = incomingPresets[i];
    if (!p || !p.id) continue;
    var pid = String(p.id);
    var incomingTs = Number(incomingTsMap[pid]);
    if (!Number.isFinite(incomingTs) || incomingTs <= 0) incomingTs = fallbackTs;
    var cur = existing[pid];
    if (!cur || incomingTs >= (Number(cur.updatedAt) || 0)) {
      existing[pid] = {
        data: JSON.parse(JSON.stringify(p)),
        updatedAt: incomingTs,
      };
    }
  }
  return existing;
}

function deletePresetRecords_(existing, deletedIds) {
  existing = existing || {};
  for (var i = 0; i < deletedIds.length; i++) {
    var pid = String(deletedIds[i]);
    if (Object.prototype.hasOwnProperty.call(existing, pid)) {
      delete existing[pid];
    }
  }
  return existing;
}

function migrateLegacyPresetsToRecords_(presets, presetRecords) {
  presetRecords = presetRecords || {};
  if (!Array.isArray(presets) || !presets.length) return presetRecords;
  var hasRecords = false;
  var k;
  for (k in presetRecords) {
    if (Object.prototype.hasOwnProperty.call(presetRecords, k)) {
      hasRecords = true;
      break;
    }
  }
  if (hasRecords) return presetRecords;
  return mergePresetRecords_(presetRecords, presets, null, Date.now());
}

/** updatedAt 이 더 큰 쪽이 이김 (last-write-wins) */
function mergeTimerStates_(existing, incoming) {
  var out = {};
  var k;
  existing = existing || {};
  incoming = incoming || {};
  for (k in existing) {
    if (Object.prototype.hasOwnProperty.call(existing, k)) {
      out[k] = existing[k];
    }
  }
  for (k in incoming) {
    if (!Object.prototype.hasOwnProperty.call(incoming, k)) continue;
    var merged = mergeOneTimerState_(out[k], incoming[k]);
    if (merged) out[k] = merged;
  }
  return out;
}

function sliceTU_(s) {
  var tu = Number(s.timerUpdatedAt);
  if (Number.isFinite(tu) && tu > 0) return tu;
  return Number(s.updatedAt) || 0;
}

function sliceSU_(s) {
  var su = Number(s.statsUpdatedAt);
  if (Number.isFinite(su) && su > 0) return su;
  return Number(s.updatedAt) || 0;
}

function sliceCtrl_(s) {
  var cu = Number(s.controlUpdatedAt);
  if (Number.isFinite(cu) && cu > 0) return cu;
  return sliceTU_(s);
}

function sliceHb_(s) {
  var hb = Number(s.heartbeatAt);
  return Number.isFinite(hb) && hb > 0 ? hb : 0;
}

/** 사용자 수동 조작 시각 — tick은 이 값을 올리지 않음 */
function sliceAction_(s) {
  if (!s) return 0;
  var la = Number(s.lastActionTimestamp);
  if (Number.isFinite(la) && la > 0) return la;
  var cu = Number(s.controlUpdatedAt);
  var su = Number(s.statsUpdatedAt);
  var max = 0;
  if (Number.isFinite(cu) && cu > 0) max = Math.max(max, cu);
  if (Number.isFinite(su) && su > 0) max = Math.max(max, su);
  return max;
}

function isPlayingSlice_(s) {
  var t = s && s.timer;
  if (!t) return false;
  if (t.bridge) return true;
  return !!t.isRunning;
}

function finalizeMerged_(winner, localSlice, remoteSlice) {
  var out = JSON.parse(JSON.stringify(winner));
  out.timerUpdatedAt = Math.max(sliceTU_(localSlice), sliceTU_(remoteSlice));
  out.lastActionTimestamp = Math.max(
    sliceAction_(localSlice),
    sliceAction_(remoteSlice)
  );
  out.controlUpdatedAt = Math.max(sliceCtrl_(localSlice), sliceCtrl_(remoteSlice));
  out.statsUpdatedAt = Math.max(sliceSU_(localSlice), sliceSU_(remoteSlice));
  out.heartbeatAt = Math.max(sliceHb_(localSlice), sliceHb_(remoteSlice));
  out.updatedAt = Math.max(
    out.timerUpdatedAt,
    out.lastActionTimestamp,
    out.statsUpdatedAt
  );
  return out;
}

function mergeTimerObjects_(ctrlWinner, posWinner, bothPlaying) {
  var base = JSON.parse(JSON.stringify((ctrlWinner && ctrlWinner.timer) || {}));
  if (!bothPlaying || !posWinner || !posWinner.timer) return base;
  var pt = posWinner.timer;
  if (pt.endAt !== undefined) base.endAt = pt.endAt;
  if (pt.pausedRemainingSec !== undefined) {
    base.pausedRemainingSec = pt.pausedRemainingSec;
  }
  if (pt.bridge !== undefined) base.bridge = pt.bridge;
  return base;
}

/**
 * Last Write Wins (lastActionTimestamp).
 * - 수동 조작이 더 최신이면 해당 슬라이스 전체 승리 (tick이 덮어쓰지 못함)
 * - 조작 세대가 같으면 heartbeat로 재생 중 위치만 병합
 */
function mergeOneTimerState_(localSlice, remoteSlice) {
  if (!remoteSlice || typeof remoteSlice !== "object") return localSlice || null;
  if (!localSlice || typeof localSlice !== "object") return remoteSlice;

  var localAction = sliceAction_(localSlice);
  var remoteAction = sliceAction_(remoteSlice);

  if (remoteAction > localAction) {
    return finalizeMerged_(remoteSlice, localSlice, remoteSlice);
  }
  if (localAction > remoteAction) {
    return finalizeMerged_(localSlice, localSlice, remoteSlice);
  }

  var localPlaying = isPlayingSlice_(localSlice);
  var remotePlaying = isPlayingSlice_(remoteSlice);
  if (localPlaying !== remotePlaying) {
    var pauseWinner = localPlaying ? remoteSlice : localSlice;
    return finalizeMerged_(pauseWinner, localSlice, remoteSlice);
  }

  var localHb = sliceHb_(localSlice);
  var remoteHb = sliceHb_(remoteSlice);
  var bothPlaying = localPlaying && remotePlaying;
  var posWinner =
    bothPlaying && remoteHb >= localHb
      ? remoteSlice
      : bothPlaying
        ? localSlice
        : remoteHb >= localHb
          ? remoteSlice
          : localSlice;
  var ctrlWinner = posWinner;

  var out = JSON.parse(JSON.stringify(ctrlWinner));
  out.timer = mergeTimerObjects_(ctrlWinner, posWinner, bothPlaying);

  var timerKeys = [
    "timerStatus",
    "displayTime",
    "level",
    "hasStartedOnce",
    "pendingBridge",
    "regCloseAt",
    "totalScheduleCommittedSec",
  ];
  var statsKeys = ["player", "entry", "entryChips"];

  if (bothPlaying && posWinner.displayTime !== undefined) {
    out.displayTime = posWinner.displayTime;
  }
  for (var i = 0; i < timerKeys.length; i++) {
    var tk = timerKeys[i];
    if (tk === "displayTime" && bothPlaying) continue;
    if (ctrlWinner[tk] !== undefined) out[tk] = ctrlWinner[tk];
    else if (localSlice[tk] !== undefined) out[tk] = localSlice[tk];
  }
  for (var j = 0; j < statsKeys.length; j++) {
    var sk = statsKeys[j];
    if (ctrlWinner[sk] !== undefined) out[sk] = ctrlWinner[sk];
    else if (localSlice[sk] !== undefined) out[sk] = localSlice[sk];
  }
  // presetId / activePresetId는 타이머 슬라이스에 포함하지 않음 (기기 로컬 UI 전용)

  return finalizeMerged_(out, localSlice, remoteSlice);
}

function readStore_() {
  var sh = getSheet_();
  var presets = [];
  var updatedAt = 0;
  var timerStates = {};
  var presetRecords = {};

  try {
    var presetsRaw = sh.getRange("A1").getValue();
    if (presetsRaw) presets = JSON.parse(String(presetsRaw));
    if (!Array.isArray(presets)) presets = [];
  } catch (e1) {
    presets = [];
  }

  try {
    updatedAt = Number(sh.getRange("A3").getValue()) || 0;
  } catch (e3) {
    updatedAt = 0;
  }

  try {
    var timerRaw = sh.getRange("A4").getValue();
    if (timerRaw) {
      var parsed = JSON.parse(String(timerRaw));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        timerStates = parsed;
      }
    }
  } catch (e4) {
    timerStates = {};
  }

  try {
    var recordsRaw = sh.getRange("A5").getValue();
    if (recordsRaw) {
      var recParsed = JSON.parse(String(recordsRaw));
      if (recParsed && typeof recParsed === "object" && !Array.isArray(recParsed)) {
        presetRecords = recParsed;
      }
    }
  } catch (e5) {
    presetRecords = {};
  }

  presetRecords = migrateLegacyPresetsToRecords_(presets, presetRecords);
  presets = presetRecordsToArray_(presetRecords);

  return {
    presets: presets,
    presetRecords: presetRecords,
    updatedAt: updatedAt,
    timerStates: timerStates,
  };
}

function writeStore_(store) {
  var sh = getSheet_();
  sh.getRange("A1").setValue(JSON.stringify(store.presets || []));
  sh.getRange("A2").setValue("");
  sh.getRange("A3").setValue(store.updatedAt || Date.now());
  sh.getRange("A4").setValue(JSON.stringify(store.timerStates || {}));
  sh.getRange("A5").setValue(JSON.stringify(store.presetRecords || {}));
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
  }
  return sh;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
