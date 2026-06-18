/**
 * Metis Timer — Google Sheets 백엔드
 *
 * [배포 방법]
 * 1. 이 프로젝트와 연결된 Google 스프레드시트 → 확장 프로그램 → Apps Script
 * 2. 기존 Code.gs 내용을 아래 코드로 교체하거나, "timerStates" 주석 구간만 병합
 * 3. 배포 → 새 배포 → 웹 앱(모든 사용자, 익명) → URL은 metis-sheet-sync.js CONFIG.url 과 동일해야 함
 *
 * [시트 "Metis" 레이아웃]
 *   A1: presets JSON
 *   A2: activePresetId
 *   A3: updatedAt (숫자)
 *   A4: timerStates JSON  ← [2단계] 신규 (프리셋 id → 실시간 타이머 상태)
 */

var TOKEN = "metis_secret_444444";
var SHEET_NAME = "Metis";

function doGet() {
  var store = readStore_();
  return jsonResponse_({
    presets: store.presets,
    activePresetId: store.activePresetId,
    updatedAt: store.updatedAt,
    timerStates: store.timerStates || {},
  });
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

  if (Array.isArray(body.presets)) {
    store.presets = body.presets;
  }
  if (body.activePresetId != null && String(body.activePresetId) !== "") {
    store.activePresetId = String(body.activePresetId);
  }

  // [2단계] 여러 프리셋 타이머 상태 일괄 병합
  if (body.timerStates && typeof body.timerStates === "object") {
    store.timerStates = mergeTimerStates_(store.timerStates || {}, body.timerStates);
  }

  // [3단계에서 사용] 단일 프리셋 타이머만 빠르게 올릴 때
  if (body.timerState && body.presetId) {
    var pid = String(body.presetId);
    if (!store.timerStates) store.timerStates = {};
    var mergedOne = mergeOneTimerState_(store.timerStates[pid], body.timerState);
    if (mergedOne) store.timerStates[pid] = mergedOne;
  }

  store.updatedAt = Date.now();
  writeStore_(store);

  return jsonResponse_({
    ok: true,
    presets: store.presets,
    activePresetId: store.activePresetId,
    updatedAt: store.updatedAt,
    timerStates: store.timerStates || {},
  });
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

function mergeOneTimerState_(localSlice, remoteSlice) {
  if (!remoteSlice || typeof remoteSlice !== "object") return localSlice || null;
  if (!localSlice || typeof localSlice !== "object") return remoteSlice;
  var localU = Number(localSlice.updatedAt) || 0;
  var remoteU = Number(remoteSlice.updatedAt) || 0;
  return remoteU >= localU ? remoteSlice : localSlice;
}

function readStore_() {
  var sh = getSheet_();
  var presets = [];
  var activePresetId = "";
  var updatedAt = 0;
  var timerStates = {};

  try {
    var presetsRaw = sh.getRange("A1").getValue();
    if (presetsRaw) presets = JSON.parse(String(presetsRaw));
    if (!Array.isArray(presets)) presets = [];
  } catch (e1) {
    presets = [];
  }

  try {
    activePresetId = String(sh.getRange("A2").getValue() || "");
  } catch (e2) {
    activePresetId = "";
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

  return {
    presets: presets,
    activePresetId: activePresetId,
    updatedAt: updatedAt,
    timerStates: timerStates,
  };
}

function writeStore_(store) {
  var sh = getSheet_();
  sh.getRange("A1").setValue(JSON.stringify(store.presets || []));
  sh.getRange("A2").setValue(store.activePresetId || "");
  sh.getRange("A3").setValue(store.updatedAt || Date.now());
  sh.getRange("A4").setValue(JSON.stringify(store.timerStates || {}));
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
