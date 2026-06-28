(function () {
  "use strict";

  var STORAGE = {
    ADMIN_PIN: "metis_adminPin",
    REMOTE: "metis_remoteState",
    PRESETS: "metis_blindPresets",
    ACTIVE_PRESET_ID: "metis_activePresetId",
    SESSION: "metis_sessionOk",
  };

  function defaultRemote() {
    return {
      tournamentName: "내 토너먼트",
      timerStatus: "대기중",
      displayTime: "00:00",
      totalChips: 0,
      avgStack: 0,
      player: 0,
      entry: 0,
      level: 1,
      entryChips: 50000,
      regCloseLevel: 15,
      prizeText: "",
      prizeItems: [],
      totalPrizeText: "",
      tournamentInfo: "",
      regCloseAt: null,
      infoFontScale: 1,
      prizeFontScale: 1,
      leftPanelRotate: false,
    };
  }

  var defaultPresets = function () {
    var dr = defaultRemote();
    return [
      Object.assign(
        {
          id: "preset_default",
          name: "스탠다드 15레벨",
          levels: [
            { sb: 100, bb: 200, ante: 200, minutes: 20 },
            { sb: 200, bb: 400, ante: 400, minutes: 20 },
            { sb: 300, bb: 600, ante: 600, minutes: 20 },
            { sb: 400, bb: 800, ante: 800, minutes: 20 },
            { sb: 500, bb: 1000, ante: 1000, minutes: 20 },
          ],
        },
        {
          tournamentName: dr.tournamentName,
          totalPrizeText: dr.totalPrizeText,
          tournamentInfo: dr.tournamentInfo,
          prizeText: dr.prizeText,
          prizeItems: dr.prizeItems.slice(),
          player: dr.player,
          entry: dr.entry,
          entryChips: dr.entryChips,
          regCloseLevel: dr.regCloseLevel,
        }
      ),
    ];
  };

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback();
      return JSON.parse(raw);
    } catch (e) {
      return fallback();
    }
  }

  function getAdminPin() {
    var p = localStorage.getItem(STORAGE.ADMIN_PIN);
    if (p && /^\d{4}$/.test(p)) return p;
    return null;
  }

  function setAdminPin(pin) {
    localStorage.setItem(STORAGE.ADMIN_PIN, pin);
  }

  function ensureAdminPin() {
    var p = localStorage.getItem(STORAGE.ADMIN_PIN);
    if (p === "000000" || p === "444444") {
      setAdminPin("4444");
      return;
    }
    if (!getAdminPin()) setAdminPin("4444");
  }

  function getRemote() {
    MetisTimer.setSyncPresetId(getActivePresetId());
    var presets = getPresets();
    var aid = getActivePresetId();
    var embedded = {};
    var po = null;
    for (var j = 0; j < presets.length; j++) {
      if (presets[j].id === aid) {
        po = presets[j];
        break;
      }
    }
    if (po) embedded = pickEmbeddedTournament(po);
    var r;
    var s = MetisTimer.readSyncState();
    if (s) {
      r = Object.assign({}, defaultRemote(), embedded, MetisTimer.pickRemoteSlice(s));
      applyPresetMetadataOverSync(r, embedded);
    } else {
      var data = loadJson(STORAGE.REMOTE, function () {
        return {};
      });
      r = Object.assign({}, defaultRemote(), embedded, data);
    }
    delete r.rebuy;
    delete r.addon;
    delete r.rebuyChips;
    delete r.addonChips;
    delete r.early;
    delete r.earlyChips;
    clampPlayerEntry(r);
    return migrateFontScales(r);
  }

  function getPresets() {
    var list = loadJson(STORAGE.PRESETS, defaultPresets);
    return Array.isArray(list) && list.length ? list : defaultPresets();
  }

  function savePresets(list, options) {
    options = options || {};
    localStorage.setItem(STORAGE.PRESETS, JSON.stringify(list));
    if (!options.skipCloudPush && window.MetisSheetSync) {
      MetisSheetSync.savePresetsToCloud(list, getActivePresetId());
    }
  }

  /** 프리셋 객체에 함께 저장되는 대회·참가 정보 필드 */
  var PRESET_TOURNAMENT_KEYS = [
    "tournamentName",
    "totalPrizeText",
    "tournamentInfo",
    "prizeText",
    "prizeItems",
    "player",
    "entry",
    "entryChips",
    "regCloseLevel",
    "infoFontScale",
    "prizeFontScale",
    "leftPanelRotate",
  ];

  /** 구글 시트 프리셋에 저장·동기화되는 메타데이터 (인원 등 실시간 값 제외) */
  var PRESET_METADATA_KEYS = [
    "tournamentName",
    "totalPrizeText",
    "tournamentInfo",
    "prizeText",
    "prizeItems",
    "infoFontScale",
    "prizeFontScale",
    "leftPanelRotate",
  ];

  function applyPresetMetadataOverSync(target, embedded) {
    if (!target || !embedded) return target;
    for (var i = 0; i < PRESET_METADATA_KEYS.length; i++) {
      var k = PRESET_METADATA_KEYS[i];
      if (embedded[k] === undefined) continue;
      if (
        MetisTimer.isPresetMetadataEmpty &&
        !MetisTimer.isPresetMetadataEmpty(k, target[k])
      ) {
        continue;
      }
      if (
        MetisTimer.isPresetMetadataEmpty &&
        MetisTimer.isPresetMetadataEmpty(k, embedded[k])
      ) {
        continue;
      }
      if (k === "prizeItems" && Array.isArray(embedded[k])) {
        var cur = Array.isArray(target[k]) ? target[k] : [];
        if (embedded[k].length >= cur.length) target[k] = embedded[k].slice();
      } else {
        target[k] = embedded[k];
      }
    }
    return target;
  }

  function migrateLegacyTimerSync() {
    try {
      var legacy = localStorage.getItem("metis_timer_sync");
      if (!legacy) return;
      var aid = localStorage.getItem(STORAGE.ACTIVE_PRESET_ID);
      if (!aid) return;
      var nk = "timer_state_" + aid;
      if (localStorage.getItem(nk)) return;
      localStorage.setItem(nk, legacy);
    } catch (e) {}
  }

  function hydrateAllPresetTournaments() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE.PRESETS);
    } catch (e0) {}
    if (!raw) return;

    var list = getPresets();
    var d = defaultRemote();
    var changed = false;
    list.forEach(function (p) {
      PRESET_TOURNAMENT_KEYS.forEach(function (k) {
        if (p[k] === undefined) {
          p[k] = d[k];
          changed = true;
        }
      });
      if (p.infoFontScale === undefined) {
        p.infoFontScale =
          p.leftFontScale != null ? p.leftFontScale : d.infoFontScale;
        changed = true;
      }
      if (p.prizeFontScale === undefined) {
        p.prizeFontScale =
          p.leftFontScale != null ? p.leftFontScale : d.prizeFontScale;
        changed = true;
      }
    });
    if (changed) savePresets(list, { skipCloudPush: true });
  }

  function migrateFontScales(state) {
    if (!state) return state;
    var legacy = state.leftFontScale != null ? state.leftFontScale : 1;
    if (state.infoFontScale == null) state.infoFontScale = legacy;
    if (state.prizeFontScale == null) state.prizeFontScale = legacy;
    state.infoFontScale = clampLeftFontScale(state.infoFontScale);
    state.prizeFontScale = clampLeftFontScale(state.prizeFontScale);
    return state;
  }

  function pickEmbeddedTournament(p) {
    var o = {};
    if (!p || typeof p !== "object") return o;
    for (var i = 0; i < PRESET_TOURNAMENT_KEYS.length; i++) {
      var k = PRESET_TOURNAMENT_KEYS[i];
      if (p[k] !== undefined) o[k] = p[k];
    }
    return o;
  }

  function mergeRemoteIntoActivePreset(options) {
    options = options || {};
    var aid = getActivePresetId();
    if (!aid) return;
    var list = getPresets();
    var idx = list.findIndex(function (x) {
      return x.id === aid;
    });
    if (idx < 0) return;
    for (var i = 0; i < PRESET_TOURNAMENT_KEYS.length; i++) {
      var k = PRESET_TOURNAMENT_KEYS[i];
      if (remoteState[k] === undefined) continue;
      if (
        k !== "prizeItems" &&
        PRESET_METADATA_KEYS.indexOf(k) >= 0 &&
        MetisTimer.isPresetMetadataEmpty &&
        MetisTimer.isPresetMetadataEmpty(k, remoteState[k]) &&
        !MetisTimer.isPresetMetadataEmpty(k, list[idx][k])
      ) {
        continue;
      }
      if (k === "prizeItems" && Array.isArray(remoteState[k])) {
        list[idx][k] = remoteState[k].slice();
      } else {
        list[idx][k] = remoteState[k];
      }
    }
    savePresets(list, options);
  }

  function tournamentSliceFromRemote() {
    var o = {};
    for (var i = 0; i < PRESET_TOURNAMENT_KEYS.length; i++) {
      var k = PRESET_TOURNAMENT_KEYS[i];
      if (remoteState[k] !== undefined) o[k] = remoteState[k];
    }
    return o;
  }

  /** 새 프리셋 추가 시 리모컨 값을 복사하지 않고 쓰는 초기 대회 데이터 */
  function emptyPresetTournamentSlice() {
    return {
      tournamentName: "새 대회",
      totalPrizeText: "",
      tournamentInfo: "",
      prizeText: "",
      prizeItems: [],
      player: 0,
      entry: 0,
      entryChips: 0,
      regCloseLevel: 0,
      infoFontScale: 1,
      prizeFontScale: 1,
      leftPanelRotate: false,
    };
  }

  function clampLeftFontScale(raw) {
    var n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(2, Math.max(0.5, n));
  }

  var PRESET_EXPORT_KEY = "metisPresetExport";
  var PRESET_EXPORT_VERSION = 1;

  function deepClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      return null;
    }
  }

  function slugForFilename(name) {
    var s = String(name || "preset")
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 48);
    return s || "preset";
  }

  /** 내보내기용: 선택 프리셋만 직렬화 (대회 정보 필드 포함) */
  function buildExportPayload(preset) {
    var p = deepClone(preset);
    if (!p || !p.levels) return null;
    var out = {
      name: String(p.name || "").trim() || "프리셋",
      levels: p.levels,
    };
    for (var ti = 0; ti < PRESET_TOURNAMENT_KEYS.length; ti++) {
      var tk = PRESET_TOURNAMENT_KEYS[ti];
      if (p[tk] !== undefined) out[tk] = p[tk];
    }
    if (
      p.regCloseAfterPlayLevel != null &&
      Number.isFinite(Number(p.regCloseAfterPlayLevel)) &&
      Math.floor(Number(p.regCloseAfterPlayLevel)) >= 1
    ) {
      out.regCloseAfterPlayLevel = Math.floor(Number(p.regCloseAfterPlayLevel));
    }
    if (
      p.preGameWaitMinutes != null &&
      Number.isFinite(Number(p.preGameWaitMinutes)) &&
      Math.floor(Number(p.preGameWaitMinutes)) >= 1
    ) {
      out.preGameWaitMinutes = Math.floor(Number(p.preGameWaitMinutes));
    }
    return out;
  }

  function validateImportedPresetPayload(raw) {
    if (!raw || typeof raw !== "object") return "파일 형식이 올바르지 않습니다.";
    var name = String(raw.name != null ? raw.name : "").trim();
    if (!name) return "프리셋 이름이 없습니다.";
    var levels = raw.levels;
    if (!Array.isArray(levels) || levels.length < 1) return "레벨 목록이 비어 있습니다.";
    var playRows = 0;
    for (var i = 0; i < levels.length; i++) {
      var row = levels[i];
      if (!row || typeof row !== "object") return "레벨 " + (i + 1) + " 행이 올바르지 않습니다.";
      if (row.type === "break") {
        var bm = Math.floor(Number(row.minutes));
        if (!Number.isFinite(bm) || bm < 1 || bm > 999) return "브레이크 행의 지속(분)을 확인해 주세요.";
      } else {
        playRows++;
        var sb = parseInt(row.sb, 10);
        var bb = parseInt(row.bb, 10);
        var ante = parseInt(row.ante, 10);
        var minutes = parseInt(row.minutes, 10);
        if (!Number.isFinite(sb) || sb < 0 || !Number.isFinite(bb) || bb < 0)
          return "레벨 행 " + (i + 1) + ": 스몰/빅 블라인드를 확인해 주세요.";
        if (!Number.isFinite(ante) || ante < 0) return "레벨 행 " + (i + 1) + ": 앤티를 확인해 주세요.";
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 999)
          return "레벨 행 " + (i + 1) + ": 지속(분)을 확인해 주세요.";
      }
    }
    if (playRows < 1) return "플레이 레벨(블라인드)이 최소 1개 필요합니다.";
    return null;
  }

  function normalizeImportedPreset(raw) {
    var err = validateImportedPresetPayload(raw);
    if (err) return { error: err };
    var levels = deepClone(raw.levels);
    var dr = defaultRemote();
    var preset = {
      id: uid(),
      name: String(raw.name).trim(),
      levels: levels,
    };
    for (var ti = 0; ti < PRESET_TOURNAMENT_KEYS.length; ti++) {
      var tk = PRESET_TOURNAMENT_KEYS[ti];
      if (raw[tk] !== undefined) preset[tk] = raw[tk];
      else preset[tk] = dr[tk];
    }
    if (preset.prizeItems == null || !Array.isArray(preset.prizeItems)) preset.prizeItems = [];
    if (raw.leftFontScale != null) {
      if (raw.infoFontScale === undefined) preset.infoFontScale = raw.leftFontScale;
      if (raw.prizeFontScale === undefined) preset.prizeFontScale = raw.leftFontScale;
    }
    if (raw.regCloseAfterPlayLevel != null) {
      var rcl = Math.floor(Number(raw.regCloseAfterPlayLevel));
      if (Number.isFinite(rcl) && rcl >= 1 && rcl <= 999) preset.regCloseAfterPlayLevel = rcl;
    }
    if (raw.preGameWaitMinutes != null) {
      var pwm = Math.floor(Number(raw.preGameWaitMinutes));
      if (Number.isFinite(pwm) && pwm >= 1 && pwm <= 999) preset.preGameWaitMinutes = pwm;
    }
    return { preset: preset };
  }

  function parsePresetImportJson(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      return { error: "JSON을 읽을 수 없습니다." };
    }
    if (obj && obj[PRESET_EXPORT_KEY] === PRESET_EXPORT_VERSION && obj.preset) {
      return normalizeImportedPreset(obj.preset);
    }
    if (
      obj &&
      Array.isArray(obj.levels) &&
      obj.levels.length &&
      String(obj.name != null ? obj.name : "").trim()
    ) {
      return normalizeImportedPreset(obj);
    }
    return { error: "Metis 프리셋 파일이 아니거나 형식이 맞지 않습니다." };
  }

  function downloadBlobAsFile(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function saveBlobWithPicker(blob, filename) {
    if (typeof window.showSaveFilePicker !== "function") {
      downloadBlobAsFile(blob, filename);
      return Promise.resolve();
    }
    return window
      .showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "Metis 프리셋",
            accept: { "application/json": [".json"] },
          },
        ],
      })
      .then(function (handle) {
        return handle.createWritable().then(function (writable) {
          return writable.write(blob).then(function () {
            return writable.close();
          });
        });
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        downloadBlobAsFile(blob, filename);
      });
  }

  function exportSelectedPresetToFile() {
    var id = presetSelect.value;
    if (!id) {
      alert("먼저 목록에서 프리셋을 선택해 주세요.");
      return;
    }
    var p = getPresets().find(function (x) {
      return x.id === id;
    });
    if (!p) {
      alert("선택한 프리셋을 찾을 수 없습니다.");
      return;
    }
    var payload = buildExportPayload(p);
    if (!payload) {
      alert("내보낼 데이터가 없습니다.");
      return;
    }
    var wrap = {};
    wrap[PRESET_EXPORT_KEY] = PRESET_EXPORT_VERSION;
    wrap.exportedAt = new Date().toISOString();
    wrap.preset = payload;
    var json = JSON.stringify(wrap, null, 2);
    var filename = "metis-preset-" + slugForFilename(payload.name) + ".json";
    var blob = new Blob([json], { type: "application/json;charset=utf-8" });
    saveBlobWithPicker(blob, filename);
  }

  function applyImportedPreset(preset) {
    var list = getPresets().slice();
    list.push(preset);
    savePresets(list, { skipCloudPush: true });
    if (window.MetisSheetSync) {
      MetisSheetSync.savePresetsToCloud(list, preset.id, {
        changedPresetIds: [preset.id],
        urgent: true,
      });
    }
    renderPresets();
    activatePreset(preset.id).then(function () {
      alert('프리셋 "' + preset.name + '" 을(를) 가져왔습니다.');
    });
  }

  function getActivePresetId() {
    return localStorage.getItem(STORAGE.ACTIVE_PRESET_ID) || "";
  }

  function resolveActivePresetId() {
    var presets = getPresets();
    var candidates = [];
    var stored = getActivePresetId();
    if (stored) candidates.push(stored);
    if (window.MetisTimer) {
      if (MetisTimer.getSyncPresetId) {
        var syncId = MetisTimer.getSyncPresetId();
        if (syncId) candidates.push(syncId);
      }
      if (MetisTimer.readSyncState) {
        var s = MetisTimer.readSyncState();
        if (s && s.activePresetId) candidates.push(String(s.activePresetId));
      }
    }
    for (var i = 0; i < candidates.length; i++) {
      for (var j = 0; j < presets.length; j++) {
        if (presets[j].id === candidates[i]) return candidates[i];
      }
    }
    return "";
  }

  function setActivePresetId(id) {
    localStorage.setItem(STORAGE.ACTIVE_PRESET_ID, id);
    MetisTimer.setSyncPresetId(id);
    if (window.MetisSheetSync && MetisSheetSync.updateCloudPollPinnedPreset) {
      MetisSheetSync.updateCloudPollPinnedPreset(id);
    }
  }

  /** 프리셋 전환: 클라우드 타이머 상태 pull 후 리모트·로컬 동기화 */
  function activatePreset(id) {
    mergeRemoteIntoActivePreset();
    var prevId = getActivePresetId();
    setActivePresetId(id);
    if (prevId && prevId !== id && window.MetisSheetSync) {
      MetisSheetSync.savePresetsToCloud(getPresets(), prevId, {
        changedPresetIds: [prevId],
        urgent: true,
      });
    }
    if (presetSelect) presetSelect.value = id;
    renderPresets();
    if (MetisTimer.applyActivePresetMetadataOnSwitch) {
      MetisTimer.applyActivePresetMetadataOnSwitch(id);
    }
    var pull =
      window.MetisSheetSync && MetisSheetSync.pullAndApplyPresetTimerState
        ? MetisSheetSync.pullAndApplyPresetTimerState(id)
        : Promise.resolve();
    return pull.then(function () {
      remoteState = getRemote();
      mirrorLocalSync();
      renderRemote();
    });
  }

  function uid() {
    return "p_" + Math.random().toString(36).slice(2, 11);
  }

  migrateLegacyTimerSync();
  var remoteState;
  var editingPresetId = null;

  function buildFullSync(skipPresetMerge) {
    MetisTimer.setSyncPresetId(getActivePresetId());
    if (!skipPresetMerge) mergeRemoteIntoActivePreset();
    var prev = MetisTimer.readSyncState();
    var presets = getPresets();
    var aid = getActivePresetId();
    var base = Object.assign({}, defaultRemote(), remoteState, {
      presets: presets,
      activePresetId: aid,
    });
    if (
      prev &&
      typeof prev.totalScheduleCommittedSec === "number" &&
      Number.isFinite(prev.totalScheduleCommittedSec)
    ) {
      base.totalScheduleCommittedSec = Math.max(
        0,
        Math.floor(prev.totalScheduleCommittedSec)
      );
    }
    var t = prev && prev.timer ? prev.timer : MetisTimer.defaultTimer();
    base.timer = MetisTimer.normalizeTimer(t, base);
    MetisTimer.syncLevelField(base);
    base.regCloseAt = null;
    return base;
  }

  function persistTimerSync(options) {
    options = options || {};
    console.log("[MetisSync|PUSH|app:persistTimerSync] (index.html)", {
      bumpStats: !!options.bumpStats,
      urgentCloudPush: !!options.urgentCloudPush,
      player: remoteState.player,
      entry: remoteState.entry,
    });
    clampPlayerEntry(remoteState);
    MetisTimer.setSyncPresetId(getActivePresetId());
    MetisTimer.writeSyncState(buildFullSync(true), {
      skipPresetEmbed: true,
      userAction: !!options.userAction,
      bumpStats: !!options.bumpStats,
      urgentCloudPush: !!options.urgentCloudPush,
    });
  }

  var presetSnapshotTimer = null;
  function persistPresetSnapshot() {
    mergeRemoteIntoActivePreset();
  }

  function schedulePresetSnapshot() {
    if (presetSnapshotTimer) clearTimeout(presetSnapshotTimer);
    presetSnapshotTimer = setTimeout(function () {
      presetSnapshotTimer = null;
      persistPresetSnapshot();
    }, 350);
  }

  function flushPresetSnapshot() {
    if (presetSnapshotTimer) {
      clearTimeout(presetSnapshotTimer);
      presetSnapshotTimer = null;
    }
    persistPresetSnapshot();
  }

  function persistAll() {
    mergeRemoteIntoActivePreset();
    persistTimerSync();
  }

  /** 클라우드 push 없이 로컬 저장소만 맞춤 (앱 시작·클라우드 pull 직후) */
  function mirrorLocalSync() {
    mergeRemoteIntoActivePreset({ skipCloudPush: true });
    clampPlayerEntry(remoteState);
    MetisTimer.setSyncPresetId(getActivePresetId());
    MetisTimer.writeSyncState(buildFullSync(true), {
      skipPresetEmbed: true,
      skipCloudPush: true,
    });
  }

  function pushRemoteLive() {
    console.log("[MetisSync|PUSH|app:pushRemoteLive] (index.html)", {
      player: remoteState.player,
      entry: remoteState.entry,
      activePresetId: getActivePresetId(),
    });
    persistTimerSync({ bumpStats: true, urgentCloudPush: true });
    schedulePresetSnapshot();
  }

  var saveToastTimer = null;
  function showSaveToast(message) {
    var el = document.getElementById("save-toast");
    if (!el) return;
    el.textContent = message || "저장되었습니다.";
    el.hidden = false;
    el.classList.add("is-visible");
    if (saveToastTimer) clearTimeout(saveToastTimer);
    saveToastTimer = setTimeout(function () {
      el.classList.remove("is-visible");
      saveToastTimer = setTimeout(function () {
        el.hidden = true;
      }, 280);
    }, 2400);
  }

  function pushToTimerBroadcast() {
    persistAll();
  }

  function applySyncToRemoteState(s) {
    Object.assign(remoteState, MetisTimer.pickRemoteSlice(s));
  }

  function alignTimerToCurrentLevel() {
    MetisTimer.setSyncPresetId(getActivePresetId());
    var s = MetisTimer.readSyncState() || buildFullSync();
    var levels = MetisTimer.getActiveLevels(s);
    if (!levels || !levels.length) {
      persistAll();
      return;
    }
    var now = Date.now();
    var targetIdx = Math.max(0, (parseInt(remoteState.level, 10) || 1) - 1);
    targetIdx = Math.min(targetIdx, levels.length - 1);
    s.timer = MetisTimer.normalizeTimer(s.timer || {}, s);
    if (
      MetisTimer.isPreGameBridge(s, s.timer) &&
      targetIdx > s.timer.levelIndex
    ) {
      MetisTimer.applyResume(s, now);
    } else {
      s.timer.bridge = null;
      s.pendingBridge = null;
      s.timer.levelIndex = targetIdx;
      MetisTimer.syncLevelField(s);
      var dur = MetisTimer.levelDurationSec(levels[s.timer.levelIndex]);
      if (s.timer.isRunning) {
        s.timer.endAt = now + dur * 1000;
        s.timer.pausedRemainingSec = dur;
        s.timerStatus = "진행중";
      } else {
        s.timer.pausedRemainingSec = dur;
        s.timer.endAt = null;
        if (
          s.timerStatus === "대기 타이머" ||
          s.timerStatus === "시작 준비"
        ) {
          s.timerStatus = "일시정지";
        } else if (
          s.timerStatus !== "종료" &&
          s.timerStatus !== "일시정지" &&
          s.timerStatus !== "대기중"
        ) {
          s.timerStatus = "일시정지";
        }
      }
      s.displayTime = MetisTimer.formatMMSS(
        MetisTimer.remainingSec(s, now)
      );
    }
    MetisTimer.writeSyncState(s, { userAction: true, urgentCloudPush: true });
    applySyncToRemoteState(s);
  }

  var screenAuth = document.getElementById("screen-auth");
  var screenRemote = document.getElementById("screen-remote");
  var pinInputs = Array.from(document.querySelectorAll(".pin-digit"));
  var authError = document.getElementById("auth-error");
  var btnUnlock = document.getElementById("btn-unlock");
  var elTimerStatus = document.getElementById("timer-status");
  var elTimerClock = document.getElementById("timer-clock");
  var presetSelect = document.getElementById("preset-select");
  var presetTbody = document.getElementById("preset-tbody");
  var btnPresetAdd = document.getElementById("btn-preset-add");
  var btnStart = document.getElementById("btn-start");
  var btnPause = document.getElementById("btn-pause");
  var btnRefresh = document.getElementById("btn-refresh");
  var btnStop = document.getElementById("btn-stop");

  var modal = document.getElementById("modal-preset");
  var modalPanel = document.getElementById("modal-preset-panel");
  var modalTitle = document.getElementById("modal-title");
  var modalName = document.getElementById("modal-name");
  var modalLevelsTbody = document.getElementById("modal-levels-tbody");
  var modalAddLevel = document.getElementById("modal-add-level");
  var modalAddBreak = document.getElementById("modal-add-break");
  var modalBulkFrom1 = document.getElementById("modal-bulk-from-1");
  var modalBulkTo1 = document.getElementById("modal-bulk-to-1");
  var modalBulkMin1 = document.getElementById("modal-bulk-min-1");
  var modalBulkFrom2 = document.getElementById("modal-bulk-from-2");
  var modalBulkTo2 = document.getElementById("modal-bulk-to-2");
  var modalBulkMin2 = document.getElementById("modal-bulk-min-2");
  var modalBulkApply = document.getElementById("modal-bulk-apply");
  var modalCancel = document.getElementById("modal-cancel");
  var modalSave = document.getElementById("modal-save");
  var modalRegCloseLevel = document.getElementById("modal-reg-close-level");
  var modalPreWaitMinutes = document.getElementById("modal-pre-wait-minutes");
  var modalNewPresetMeta = document.getElementById("modal-new-preset-meta");
  var modalNewTournamentName = document.getElementById("modal-new-tournament-name");
  var modalNewTournamentInfo = document.getElementById("modal-new-tournament-info");
  var modalNewPlayer = document.getElementById("modal-new-player");
  var modalNewEntry = document.getElementById("modal-new-entry");
  var modalNewEntryChips = document.getElementById("modal-new-entry-chips");
  var modalNewTotalPrize = document.getElementById("modal-new-total-prize");

  var remoteMeta = document.getElementById("remote-meta");
  var inputTournamentName = document.getElementById("input-tournament-name");
  var inputTotalPrize = document.getElementById("input-total-prize");
  var btnOpenPrizeModal = document.getElementById("btn-open-prize-modal");
  var inputTournamentInfo = document.getElementById("input-tournament-info");
  var inputInfoFontScale = document.getElementById("input-info-font-scale");
  var outputInfoFontScale = document.getElementById("output-info-font-scale");
  var inputPrizeFontScale = document.getElementById("input-prize-font-scale");
  var outputPrizeFontScale = document.getElementById("output-prize-font-scale");
  var inputLeftPanelRotate = document.getElementById("input-left-panel-rotate");
  var modalPrize = document.getElementById("modal-prize");
  var modalPrizePanel = document.getElementById("modal-prize-panel");
  var modalPrizeTbody = document.getElementById("modal-prize-tbody");
  var modalPrizeAdd = document.getElementById("modal-prize-add");
  var modalPrizeCancel = document.getElementById("modal-prize-cancel");
  var modalPrizeSave = document.getElementById("modal-prize-save");
  var prizeSortable = null;
  var presetLevelSortable = null;

  var remoteEngineId = null;
  var lastRemoteSeenUpdated = 0;
  var cloudTimerSyncStarted = false;

  function startCloudTimerSyncIfNeeded() {
    if (cloudTimerSyncStarted || !window.MetisSheetSync) return;
    cloudTimerSyncStarted = true;
    console.log("[MetisSync|PULL|app:startCloudTimerSyncIfNeeded] (index.html)");
    if (MetisSheetSync.bindCloudSyncBadge) {
      MetisSheetSync.bindCloudSyncBadge("cloud-sync-badge");
    }
    MetisSheetSync.startCloudTimerSync(function (result) {
      var ar =
        result && result.applyResult
          ? result.applyResult
          : {};
      MetisTimer.setSyncPresetId(getActivePresetId());
      var s = MetisTimer.readSyncState();
      var cloudApplied = !!(result && result.applied);
      var willRender =
        cloudApplied ||
        (result && result.presetsApplied) ||
        (s && (s.updatedAt || 0) > lastRemoteSeenUpdated);
      console.log("[MetisSync|PULL|app:cloudPoll콜백]", {
        applied: cloudApplied,
        presetsApplied: result && result.presetsApplied,
        applyResult: ar,
        lastRemoteSeenUpdated: lastRemoteSeenUpdated,
        stateUpdatedAt: s && s.updatedAt,
        stateLastAction: s && s.lastActionTimestamp,
        stateStats: s
          ? { player: s.player, entry: s.entry, statsUpdatedAt: s.statsUpdatedAt }
          : null,
        willRender: willRender,
        screenActive: screenRemote.classList.contains("is-active"),
      });
      if (result && result.presetsApplied) {
        renderPresets();
      }
      if (!s) return;
      if (willRender) {
        lastRemoteSeenUpdated = Math.max(
          lastRemoteSeenUpdated,
          s.updatedAt || 0,
          s.lastActionTimestamp || 0
        );
        remoteState = getRemote();
        if (screenRemote.classList.contains("is-active")) renderRemote();
      }
    }, {
      pinnedPresetId: getActivePresetId() || undefined,
    });
  }

  function syncLastSeenFromStore() {
    MetisTimer.setSyncPresetId(getActivePresetId());
    var s = MetisTimer.readSyncState();
    if (s && s.updatedAt) lastRemoteSeenUpdated = s.updatedAt;
  }

  function showScreen(which) {
    screenAuth.classList.toggle("is-active", which === "auth");
    screenRemote.classList.toggle("is-active", which === "remote");
    if (which === "remote") startRemoteEngine();
    else stopRemoteEngine();
  }

  function isSessionOk() {
    return sessionStorage.getItem(STORAGE.SESSION) === "1";
  }

  function setSession(ok) {
    if (ok) sessionStorage.setItem(STORAGE.SESSION, "1");
    else sessionStorage.removeItem(STORAGE.SESSION);
  }

  function getPinFromInputs() {
    return pinInputs
      .map(function (i) {
        return i.value.replace(/\D/g, "").slice(-1);
      })
      .join("");
  }

  function clearPin() {
    pinInputs.forEach(function (i) {
      i.value = "";
    });
    if (pinInputs[0]) pinInputs[0].focus();
  }

  function tryUnlock() {
    authError.textContent = "";
    var pin = getPinFromInputs();
    if (pin.length !== 4) {
      authError.textContent = "4자리 숫자를 모두 입력해 주세요.";
      return;
    }
    ensureAdminPin();
    if (pin === getAdminPin()) {
      setSession(true);
      remoteState = getRemote();
      showScreen("remote");
      renderRemote();
      renderPresets();
      mirrorLocalSync();
      syncLastSeenFromStore();
      startCloudTimerSyncIfNeeded();
    } else {
      authError.textContent = "비밀번호가 올바르지 않습니다.";
      clearPin();
    }
  }

  function startRemoteEngine() {
    if (remoteEngineId != null) return;
    remoteEngineId = setInterval(function () {
      if (!isSessionOk() || !screenRemote.classList.contains("is-active"))
        return;
      MetisTimer.setSyncPresetId(getActivePresetId());
      var syncPeek = MetisTimer.readSyncState();
      if (syncPeek) {
        var u = syncPeek.updatedAt || 0;
        if (u > lastRemoteSeenUpdated) {
          lastRemoteSeenUpdated = u;
          remoteState = getRemote();
          renderRemote();
        }
      }
      var step = MetisTimer.engineStep();
      if (!step) return;
      elTimerClock.textContent = MetisTimer.formatMMSS(step.rem);
      elTimerStatus.textContent = step.state.timerStatus || "대기중";
      Object.assign(remoteState, MetisTimer.pickRemoteSlice(step.state));
      clampPlayerEntry(remoteState);
      var lvlEl = document.getElementById("val-level");
      if (lvlEl) lvlEl.textContent = String(step.state.level || 1);
      var vPl = document.getElementById("val-player");
      var vEn = document.getElementById("val-entry");
      if (vPl && vPl.tagName === "INPUT" && document.activeElement !== vPl) {
        vPl.value = String(remoteState.player != null ? remoteState.player : 0);
      }
      if (vEn && vEn.tagName === "INPUT" && document.activeElement !== vEn) {
        vEn.value = String(remoteState.entry != null ? remoteState.entry : 0);
      }
      var ts = computeTotalStack(remoteState);
      var av = computeAvgStack(remoteState);
      document.getElementById("val-total-chips").textContent = formatNum(ts);
      document.getElementById("val-avg-stack").textContent = formatNum(av);
      var ecD = document.getElementById("val-entry-chips-display");
      if (
        ecD &&
        ecD.tagName === "INPUT" &&
        document.activeElement !== ecD
      ) {
        ecD.value = String(Math.max(0, Math.floor(Number(remoteState.entryChips) || 0)));
      }
      var s2 = MetisTimer.readSyncState();
      if (s2 && s2.updatedAt && s2.updatedAt > lastRemoteSeenUpdated)
        lastRemoteSeenUpdated = s2.updatedAt;
    }, 100);
  }

  function stopRemoteEngine() {
    if (remoteEngineId != null) {
      clearInterval(remoteEngineId);
      remoteEngineId = null;
    }
  }

  function normalizePrizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(function (item) {
        if (!item || typeof item !== "object") return null;
        var rank = String(item.rank != null ? item.rank : "").trim().slice(0, 24);
        var amountNum = Math.max(0, Math.floor(Number(item.amount) || 0));
        if (!rank || !amountNum) return null;
        return { rank: rank, amount: amountNum };
      })
      .filter(Boolean);
  }

  function formatAmountWithCommas(value) {
    var digits = String(value == null ? "" : value).replace(/\D/g, "");
    if (!digits) return "";
    return Number(digits).toLocaleString("ko-KR");
  }

  function createPrizeModalRow(rank, amount) {
    if (!modalPrizeTbody) return null;
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td><span class="prize-row-handle" aria-label="순서 변경" title="드래그로 순서 변경">≡</span></td>' +
      '<td><input type="text" class="prize-row-rank" maxlength="24" placeholder="예: 1등" /></td>' +
      '<td><input type="text" class="prize-row-amount" inputmode="numeric" maxlength="20" placeholder="예: 1,500,000" /></td>' +
      '<td><button type="button" class="btn-prize-row-remove">삭제</button></td>';
    var rankInput = tr.querySelector(".prize-row-rank");
    var amountInput = tr.querySelector(".prize-row-amount");
    if (rankInput) rankInput.value = rank || "";
    if (amountInput) amountInput.value = formatAmountWithCommas(amount);
    modalPrizeTbody.appendChild(tr);
    return tr;
  }

  function getPrizeItemsFromModal() {
    if (!modalPrizeTbody) return [];
    var rows = modalPrizeTbody.querySelectorAll("tr");
    var out = [];
    rows.forEach(function (row) {
      var rankInput = row.querySelector(".prize-row-rank");
      var amountInput = row.querySelector(".prize-row-amount");
      var rank = rankInput ? String(rankInput.value || "").trim().slice(0, 24) : "";
      var amountDigits = amountInput
        ? String(amountInput.value || "").replace(/\D/g, "")
        : "";
      var amount = amountDigits ? Math.max(0, Math.floor(Number(amountDigits) || 0)) : 0;
      if (!rank || !amount) return;
      out.push({ rank: rank, amount: amount });
    });
    return out;
  }

  function renderPrizeModalFromRemoteState() {
    if (!modalPrizeTbody) return;
    modalPrizeTbody.innerHTML = "";
    var items = normalizePrizeItems(remoteState.prizeItems || []);
    if (!items.length) {
      createPrizeModalRow("", "");
      return;
    }
    items.forEach(function (item) {
      createPrizeModalRow(item.rank, item.amount);
    });
  }

  function updateModalScrollLock() {
    var anyOpen =
      (modal && modal.classList.contains("is-open")) ||
      (modalPrize && modalPrize.classList.contains("is-open"));
    document.body.classList.toggle("modal-open", anyOpen);
  }

  function openPrizeModal() {
    if (!modalPrize) return;
    renderPrizeModalFromRemoteState();
    modalPrize.classList.add("is-open");
    updateModalScrollLock();
  }

  function closePrizeModal() {
    if (!modalPrize) return;
    modalPrize.classList.remove("is-open");
    updateModalScrollLock();
  }

  function savePrizeModal() {
    var items = normalizePrizeItems(getPrizeItemsFromModal());
    if (!items.length) {
      alert("등수와 금액을 모두 입력한 상금 행이 최소 1개 필요합니다.");
      return;
    }
    remoteState.prizeItems = items;
    remoteState.prizeText = "";
    if ("guaranteedPrize" in remoteState) delete remoteState.guaranteedPrize;
    persistAll();
    if (MetisTimer.flushActivePresetMetadataToTimer) {
      MetisTimer.flushActivePresetMetadataToTimer();
    }
    renderRemote();
    closePrizeModal();
    showSaveToast("상금 스트럭처가 저장되었습니다.");
  }

  function ensurePrizeSortable() {
    if (!modalPrizeTbody || prizeSortable || typeof Sortable === "undefined") return;
    prizeSortable = Sortable.create(modalPrizeTbody, {
      animation: 180,
      handle: ".prize-row-handle",
      draggable: "tr",
      ghostClass: "prize-sortable-ghost",
      chosenClass: "prize-sortable-chosen",
      dragClass: "prize-sortable-drag",
    });
  }

  function syncMetaFromInputs() {
    if (!inputTournamentName) return;
    var tnRaw = inputTournamentName.value || "";
    remoteState.tournamentName = tnRaw.trim()
      ? tnRaw
      : defaultRemote().tournamentName;
    if (inputTotalPrize) remoteState.totalPrizeText = inputTotalPrize.value;
    remoteState.tournamentInfo = inputTournamentInfo
      ? inputTournamentInfo.value
      : "";
    if (inputInfoFontScale) {
      remoteState.infoFontScale = clampLeftFontScale(
        Number(inputInfoFontScale.value) / 100
      );
    }
    if (inputPrizeFontScale) {
      remoteState.prizeFontScale = clampLeftFontScale(
        Number(inputPrizeFontScale.value) / 100
      );
    }
    if (inputLeftPanelRotate) {
      remoteState.leftPanelRotate = !!inputLeftPanelRotate.checked;
    }
  }

  function fillMetaInputsFromRemoteState() {
    if (!inputTournamentName || !remoteMeta) return;
    if (remoteMeta.contains(document.activeElement)) return;
    inputTournamentName.value = remoteState.tournamentName || "";
    if (inputTotalPrize)
      inputTotalPrize.value =
        remoteState.totalPrizeText != null ? String(remoteState.totalPrizeText) : "";
    if (inputTournamentInfo)
      inputTournamentInfo.value = remoteState.tournamentInfo || "";
    function fillFontScaleInput(input, output, scale) {
      if (!input) return;
      var fs = clampLeftFontScale(scale != null ? scale : 1);
      var pct = String(Math.round(fs * 100));
      input.value = pct;
      input.setAttribute("aria-valuenow", pct);
      if (output) output.textContent = pct + "%";
    }
    fillFontScaleInput(
      inputInfoFontScale,
      outputInfoFontScale,
      remoteState.infoFontScale
    );
    fillFontScaleInput(
      inputPrizeFontScale,
      outputPrizeFontScale,
      remoteState.prizeFontScale
    );
    if (inputLeftPanelRotate) {
      inputLeftPanelRotate.checked = !!remoteState.leftPanelRotate;
    }
  }

  function bindMetaFormOnce() {
    if (!inputTournamentName || inputTournamentName.dataset.bound) return;
    inputTournamentName.dataset.bound = "1";
    function pushMeta() {
      syncMetaFromInputs();
      mergeRemoteIntoActivePreset({ skipCloudPush: true });
      pushRemoteLive();
    }
    function flushMeta() {
      syncMetaFromInputs();
      flushPresetSnapshot();
      persistTimerSync({ userAction: true });
    }
    inputTournamentName.addEventListener("input", pushMeta);
    inputTournamentName.addEventListener("change", flushMeta);
    inputTournamentName.addEventListener("blur", flushMeta);
    if (inputTotalPrize) {
      inputTotalPrize.addEventListener("input", pushMeta);
      inputTotalPrize.addEventListener("change", flushMeta);
      inputTotalPrize.addEventListener("blur", flushMeta);
    }
    if (inputTournamentInfo) {
      inputTournamentInfo.addEventListener("input", pushMeta);
      inputTournamentInfo.addEventListener("change", flushMeta);
      inputTournamentInfo.addEventListener("blur", flushMeta);
    }
    function bindFontScaleInput(input, output) {
      if (!input) return;
      function pushFontScale() {
        syncMetaFromInputs();
        if (output) output.textContent = input.value + "%";
        input.setAttribute("aria-valuenow", input.value);
        mergeRemoteIntoActivePreset({ skipCloudPush: true });
        pushRemoteLive();
      }
      function flushFontScale() {
        syncMetaFromInputs();
        if (output) output.textContent = input.value + "%";
        input.setAttribute("aria-valuenow", input.value);
        flushPresetSnapshot();
        persistTimerSync({ userAction: true });
      }
      input.addEventListener("input", pushFontScale);
      input.addEventListener("change", flushFontScale);
    }
    bindFontScaleInput(inputInfoFontScale, outputInfoFontScale);
    bindFontScaleInput(inputPrizeFontScale, outputPrizeFontScale);
    if (inputLeftPanelRotate) {
      inputLeftPanelRotate.addEventListener("change", function () {
        syncMetaFromInputs();
        persistAll();
      });
    }
  }

  function setStatNumberInputIfNotFocused(id, rawVal) {
    var el = document.getElementById(id);
    if (!el || el.tagName !== "INPUT") return;
    if (document.activeElement === el) return;
    var n = Math.max(0, Math.floor(Number(rawVal) || 0));
    el.value = String(n);
  }

  function renderRemote() {
    remoteState = getRemote();
    elTimerStatus.textContent = remoteState.timerStatus || "대기중";
    var s = MetisTimer.readSyncState();
    var now = Date.now();
    var rem = s
      ? MetisTimer.remainingSec(s, now)
      : parseTimeToSec(remoteState.displayTime);
    elTimerClock.textContent = MetisTimer.formatMMSS(rem);
    setStatNumberInputIfNotFocused(
      "val-player",
      remoteState.player != null ? remoteState.player : 0
    );
    setStatNumberInputIfNotFocused(
      "val-entry",
      remoteState.entry != null ? remoteState.entry : 0
    );
    document.getElementById("val-total-chips").textContent = formatNum(
      computeTotalStack(remoteState)
    );
    document.getElementById("val-avg-stack").textContent = formatNum(
      computeAvgStack(remoteState)
    );
    setStatNumberInputIfNotFocused(
      "val-entry-chips-display",
      remoteState.entryChips != null ? remoteState.entryChips : 0
    );
    document.getElementById("val-level").textContent = String(
      remoteState.level != null ? remoteState.level : 1
    );
    fillMetaInputsFromRemoteState();
  }

  function parseTimeToSec(mmss) {
    if (!mmss || typeof mmss !== "string") return 0;
    var p = mmss.split(":");
    if (p.length !== 2) return 0;
    var m = parseInt(p[0], 10);
    var sec = parseInt(p[1], 10);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return 0;
    return m * 60 + sec;
  }

  function formatNum(n) {
    var x = Number(n) || 0;
    return x.toLocaleString("ko-KR");
  }

  function clampPlayerEntry(rs) {
    var e = Math.max(0, Math.floor(Number(rs.entry) || 0));
    var p = Math.max(0, Math.floor(Number(rs.player) || 0));
    rs.entry = e;
    rs.player = Math.min(p, e);
  }

  function computeTotalStack(rs) {
    var ent = Math.max(0, Math.floor(Number(rs.entry) || 0));
    var chips = Math.max(0, Math.floor(Number(rs.entryChips) || 0));
    return ent * chips;
  }

  function computeAvgStack(rs) {
    var p = Math.max(0, Math.floor(Number(rs.player) || 0));
    if (p <= 0) return 0;
    return Math.floor(computeTotalStack(rs) / p);
  }

  function bindEntryPlayerCounters() {
    var valP = document.getElementById("val-player");
    var valE = document.getElementById("val-entry");
    function refreshEntryPlayerDisplays() {
      clampPlayerEntry(remoteState);
      if (valP && valP.tagName === "INPUT") valP.value = String(remoteState.player);
      if (valE && valE.tagName === "INPUT") valE.value = String(remoteState.entry);
      var ts = computeTotalStack(remoteState);
      var av = computeAvgStack(remoteState);
      document.getElementById("val-total-chips").textContent = formatNum(ts);
      document.getElementById("val-avg-stack").textContent = formatNum(av);
    }
    function syncFromInputs() {
      var p = valP ? parseInt(String(valP.value).trim(), 10) : NaN;
      var e = valE ? parseInt(String(valE.value).trim(), 10) : NaN;
      remoteState.player = Math.max(0, Number.isFinite(p) ? p : 0);
      remoteState.entry = Math.max(0, Number.isFinite(e) ? e : 0);
      clampPlayerEntry(remoteState);
      refreshEntryPlayerDisplays();
      pushRemoteLive();
    }
    function push() {
      refreshEntryPlayerDisplays();
      pushRemoteLive();
    }
    function bindStatInput(el, handler) {
      if (!el || el.tagName !== "INPUT") return;
      el.addEventListener("change", handler);
      el.addEventListener("blur", handler);
    }
    bindStatInput(valP, syncFromInputs);
    bindStatInput(valE, syncFromInputs);
    document.getElementById("btn-entry-plus").addEventListener("click", function () {
      remoteState.entry = (remoteState.entry | 0) + 1;
      remoteState.player = (remoteState.player | 0) + 1;
      push();
    });
    document.getElementById("btn-entry-minus").addEventListener("click", function () {
      remoteState.entry = Math.max(0, (remoteState.entry | 0) - 1);
      remoteState.player = Math.min(remoteState.player | 0, remoteState.entry);
      push();
    });
    document.getElementById("btn-player-plus").addEventListener("click", function () {
      remoteState.player = Math.min((remoteState.player | 0) + 1, remoteState.entry | 0);
      push();
    });
    document.getElementById("btn-player-minus").addEventListener("click", function () {
      remoteState.player = Math.max(0, (remoteState.player | 0) - 1);
      push();
    });
  }

  function bindEntryChipsCounter() {
    var valEc = document.getElementById("val-entry-chips-display");
    var step = 5000;
    function refreshStacks() {
      if (valEc && valEc.tagName === "INPUT") {
        valEc.value = String(Math.max(0, Math.floor(Number(remoteState.entryChips) || 0)));
      }
      document.getElementById("val-total-chips").textContent = formatNum(
        computeTotalStack(remoteState)
      );
      document.getElementById("val-avg-stack").textContent = formatNum(
        computeAvgStack(remoteState)
      );
    }
    function syncChipsFromInput() {
      if (!valEc || valEc.tagName !== "INPUT") return;
      var v = parseInt(valEc.value, 10);
      remoteState.entryChips = Math.max(0, Number.isFinite(v) ? v : 0);
      refreshStacks();
      pushRemoteLive();
    }
    function push() {
      refreshStacks();
      pushRemoteLive();
    }
    if (valEc && valEc.tagName === "INPUT") {
      valEc.addEventListener("change", syncChipsFromInput);
      valEc.addEventListener("blur", syncChipsFromInput);
    }
    document.getElementById("btn-entry-chips-plus").addEventListener("click", function () {
      remoteState.entryChips = Math.max(0, (remoteState.entryChips | 0) + step);
      push();
    });
    document.getElementById("btn-entry-chips-minus").addEventListener("click", function () {
      remoteState.entryChips = Math.max(0, (remoteState.entryChips | 0) - step);
      push();
    });
  }

  function countPresetLevelRows(levels) {
    if (!levels || !levels.length) return 0;
    var n = 0;
    for (var i = 0; i < levels.length; i++) {
      if (!levels[i] || levels[i].type !== "break") n++;
    }
    return n;
  }

  function renderPresets() {
    var presets = getPresets();
    var active = resolveActivePresetId();
    presetSelect.innerHTML = "";
    var opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "프리셋 선택…";
    presetSelect.appendChild(opt0);
    presets.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      if (p.id === active) o.selected = true;
      presetSelect.appendChild(o);
    });

    presetTbody.innerHTML = "";
    presets.forEach(function (p, idx) {
      var tr = document.createElement("tr");
      if (p.id === active) tr.classList.add("preset-row--active");
      var activeDot =
        p.id === active
          ? '<span class="preset-active-mark" aria-hidden="true" title="현재 적용 중">●</span>'
          : "";
      tr.innerHTML =
        "<td>" +
        (idx + 1) +
        "</td><td>" +
        '<span class="preset-name-wrap">' +
        activeDot +
        '<span class="preset-name-text">' +
        escapeHtml(p.name) +
        "</span></span></td><td>" +
        countPresetLevelRows(p.levels) +
        '</td><td class="preset-actions"></td>';
      var cell = tr.querySelector(".preset-actions");
      cell.appendChild(
        mkBtn("적용", "blue", function () {
          activatePreset(p.id);
        })
      );
      cell.appendChild(
        mkBtn("타이머 열기", "purple", function () {
          window.open(
            "timer.html?id=" + encodeURIComponent(p.id),
            "metisTimer_" + p.id,
            "noopener,noreferrer,width=1200,height=800"
          );
        })
      );
      cell.appendChild(
        mkBtn("수정", "neutral", function () {
          openModalEdit(p.id);
        })
      );
      cell.appendChild(
        mkBtn("삭제", "red", function () {
          if (!confirm("이 프리셋을 삭제할까요?")) return;
          var next = presets.filter(function (x) {
            return x.id !== p.id;
          });
          savePresets(next, { skipCloudPush: true });
          if (window.MetisSheetSync) {
            MetisSheetSync.savePresetsToCloud(next, getActivePresetId(), {
              deletedPresetIds: [p.id],
              urgent: true,
            });
          }
          if (getActivePresetId() === p.id) setActivePresetId("");
          renderPresets();
          persistAll();
        })
      );
      presetTbody.appendChild(tr);
    });
  }

  function mkBtn(label, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn-sm " + cls;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function defaultLevelRow() {
    return { sb: 100, bb: 200, ante: 200, minutes: 20 };
  }

  function defaultBreakRow() {
    return { type: "break", minutes: 10, adUrl: "./video/0318.mp4" };
  }

  function countModalLevelRows(trs) {
    var n = 0;
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].getAttribute("data-row-type") !== "break") n++;
    }
    return n;
  }

  function updateModalLevelLabels() {
    if (!modalLevelsTbody) return;
    var trs = modalLevelsTbody.querySelectorAll("tr");
    var levelNum = 0;
    var breakNum = 0;
    trs.forEach(function (tr) {
      var cell = tr.querySelector(".pl-lv-num");
      if (!cell) return;
      if (tr.getAttribute("data-row-type") === "break") {
        breakNum++;
        cell.textContent = "BREAK " + breakNum;
      } else {
        levelNum++;
        cell.textContent = "LEVEL " + levelNum;
      }
    });
  }

  function wireModalRowDelete(tr) {
    tr.querySelector(".btn-pl-del").addEventListener("click", function () {
      if (!modalLevelsTbody) return;
      var all = modalLevelsTbody.querySelectorAll("tr");
      if (all.length <= 1) {
        alert("최소 1개의 행이 필요합니다.");
        return;
      }
      var isBreak = tr.getAttribute("data-row-type") === "break";
      if (!isBreak && countModalLevelRows(all) <= 1) {
        alert("최소 1개의 레벨(블라인드) 행이 있어야 합니다.");
        return;
      }
      tr.remove();
      updateModalLevelLabels();
    });
  }

  function modalActionsCellHtml() {
    return (
      '<td class="pl-row-actions">' +
      '<button type="button" class="btn-pl-del" title="이 행 삭제">삭제</button>' +
      "</td>"
    );
  }

  function buildLevelRowTr(row) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-row-type", "level");
    var sb = Math.max(0, Math.floor(Number(row.sb) || 0));
    var bb = Math.max(0, Math.floor(Number(row.bb) || 0));
    var ante = Math.max(0, Math.floor(Number(row.ante != null ? row.ante : 0) || 0));
    var minutes = Math.max(1, Math.min(999, Math.floor(Number(row.minutes != null ? row.minutes : 20) || 20)));
    tr.innerHTML =
      '<td class="pl-col-handle"><span class="pl-row-handle" aria-label="순서 변경" title="드래그로 순서 변경">≡</span></td>' +
      '<td class="pl-lv-num"></td>' +
      '<td><input type="number" class="pl-inp" data-f="sb" min="0" step="1" value="' +
      sb +
      '" /></td>' +
      '<td><input type="number" class="pl-inp" data-f="bb" min="0" step="1" value="' +
      bb +
      '" /></td>' +
      '<td><input type="number" class="pl-inp" data-f="ante" min="0" step="1" value="' +
      ante +
      '" /></td>' +
      '<td><input type="number" class="pl-inp pl-inp-min" data-f="minutes" min="1" max="999" step="1" value="' +
      minutes +
      '" /></td>' +
      '<td><input type="text" class="pl-inp pl-inp-ad" data-f="adUrl" disabled placeholder="브레이크 전용" spellcheck="false" /></td>' +
      modalActionsCellHtml();
    wireModalRowDelete(tr);
    return tr;
  }

  function buildBreakRowTr(row) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-row-type", "break");
    var minutes = Math.max(1, Math.min(999, Math.floor(Number(row.minutes != null ? row.minutes : 10) || 10)));
    var ad = row.adUrl != null ? String(row.adUrl) : "";
    if (ad.length > 2000) ad = ad.slice(0, 2000);
    tr.innerHTML =
      '<td class="pl-col-handle"><span class="pl-row-handle" aria-label="순서 변경" title="드래그로 순서 변경">≡</span></td>' +
      '<td class="pl-lv-num"></td>' +
      '<td colspan="3" class="pl-break-merged">쉬는 시간 (블라인드 없음)</td>' +
      '<td><input type="number" class="pl-inp pl-inp-min" data-f="minutes" min="1" max="999" step="1" value="' +
      minutes +
      '" /></td>' +
      '<td><input type="text" class="pl-inp pl-inp-ad" data-f="adUrl" placeholder="예: ./video/0318.mp4" spellcheck="false" /></td>' +
      modalActionsCellHtml();
    var adInp = tr.querySelector('[data-f="adUrl"]');
    if (adInp) adInp.value = ad;
    wireModalRowDelete(tr);
    return tr;
  }

  function ensurePresetLevelSortable() {
    if (!modalLevelsTbody || presetLevelSortable || typeof Sortable === "undefined") return;
    presetLevelSortable = Sortable.create(modalLevelsTbody, {
      animation: 180,
      handle: ".pl-row-handle",
      draggable: "tr",
      ghostClass: "prize-sortable-ghost",
      chosenClass: "prize-sortable-chosen",
      dragClass: "prize-sortable-drag",
      onEnd: function () {
        updateModalLevelLabels();
      },
    });
  }

  function renderModalLevelRows(levels) {
    if (!modalLevelsTbody) return;
    modalLevelsTbody.innerHTML = "";
    var arr =
      levels && levels.length
        ? levels.map(function (r) {
            if (r && r.type === "break") {
              return {
                type: "break",
                minutes: r.minutes != null ? r.minutes : 10,
                adUrl: r.adUrl != null ? String(r.adUrl) : "",
              };
            }
            return {
              sb: r.sb,
              bb: r.bb,
              ante: r.ante != null ? r.ante : 0,
              minutes: r.minutes != null ? r.minutes : 20,
            };
          })
        : [defaultLevelRow()];
    arr.forEach(function (row) {
      if (row.type === "break") modalLevelsTbody.appendChild(buildBreakRowTr(row));
      else modalLevelsTbody.appendChild(buildLevelRowTr(row));
    });
    updateModalLevelLabels();
    ensurePresetLevelSortable();
  }

  function collectModalLevels() {
    if (!modalLevelsTbody) return { levels: [], error: "표를 불러오지 못했습니다." };
    var trs = modalLevelsTbody.querySelectorAll("tr");
    var out = [];
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var minutes = parseInt(tr.querySelector('[data-f="minutes"]').value, 10);
      if (!Number.isFinite(minutes) || minutes < 1) minutes = 20;
      if (minutes > 999) minutes = 999;
      var adInp = tr.querySelector('[data-f="adUrl"]');
      var adRaw = adInp ? String(adInp.value).trim().slice(0, 2000) : "";

      if (tr.getAttribute("data-row-type") === "break") {
        var br = { type: "break", minutes: minutes };
        if (adRaw) br.adUrl = adRaw;
        out.push(br);
        continue;
      }

      var sb = parseInt(tr.querySelector('[data-f="sb"]').value, 10);
      var bb = parseInt(tr.querySelector('[data-f="bb"]').value, 10);
      var ante = parseInt(tr.querySelector('[data-f="ante"]').value, 10);
      if (!Number.isFinite(sb) || sb < 0 || !Number.isFinite(bb) || bb < 0) {
        return {
          levels: null,
          error: "행 " + (i + 1) + " (레벨): 스몰/빅 블라인드에 0 이상의 숫자를 입력해 주세요.",
        };
      }
      if (!Number.isFinite(ante) || ante < 0) ante = 0;
      out.push({ sb: sb, bb: bb, ante: ante, minutes: minutes });
    }
    var levelCount = out.filter(function (r) {
      return !r || r.type !== "break";
    }).length;
    if (levelCount < 1) {
      return { levels: null, error: "최소 1개의 레벨(블라인드) 행이 필요합니다." };
    }
    return { levels: out, error: null };
  }

  function listModalPlayLevelRows() {
    if (!modalLevelsTbody) return [];
    var trs = modalLevelsTbody.querySelectorAll("tr");
    var levelNum = 0;
    var list = [];
    trs.forEach(function (tr) {
      if (tr.getAttribute("data-row-type") === "break") return;
      levelNum++;
      list.push({ levelNum: levelNum, tr: tr });
    });
    return list;
  }

  function flashBulkMinutesInput(minInput) {
    if (!minInput) return;
    minInput.classList.remove("is-bulk-updated");
    void minInput.offsetWidth;
    minInput.classList.add("is-bulk-updated");
  }

  function parseBulkMinutesRange(fromEl, toEl, minEl, label) {
    var fromRaw = fromEl ? String(fromEl.value).trim() : "";
    var toRaw = toEl ? String(toEl.value).trim() : "";
    var minRaw = minEl ? String(minEl.value).trim() : "";
    if (!fromRaw && !toRaw && !minRaw) return null;
    var from = parseInt(fromRaw, 10);
    var to = parseInt(toRaw, 10);
    var minutes = Math.floor(Number(minRaw));
    if (!Number.isFinite(from) || from < 1 || from > 999) {
      return { error: label + ": 시작 레벨을 1~999 사이로 입력해 주세요." };
    }
    if (!Number.isFinite(to) || to < 1 || to > 999) {
      return { error: label + ": 끝 레벨을 1~999 사이로 입력해 주세요." };
    }
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 999) {
      return { error: label + ": 블라인드(분)을 1~999 사이로 입력해 주세요." };
    }
    if (from > to) {
      return { error: label + ": 시작 레벨이 끝 레벨보다 클 수 없습니다." };
    }
    return { from: from, to: to, minutes: minutes };
  }

  function applyBulkMinutesRange(range, playRows) {
    if (!range || !playRows.length) return 0;
    var maxLevel = playRows[playRows.length - 1].levelNum;
    if (range.from > maxLevel) return 0;
    var to = Math.min(range.to, maxLevel);
    var updated = 0;
    playRows.forEach(function (item) {
      if (item.levelNum < range.from || item.levelNum > to) return;
      var minInput = item.tr.querySelector('input[data-f="minutes"]');
      if (!minInput) return;
      minInput.value = String(range.minutes);
      flashBulkMinutesInput(minInput);
      updated++;
    });
    return updated;
  }

  function applyBulkMinutesToLevelRows() {
    if (!modalLevelsTbody) return;
    var playRows = listModalPlayLevelRows();
    if (!playRows.length) return;
    var ranges = [
      parseBulkMinutesRange(modalBulkFrom1, modalBulkTo1, modalBulkMin1, "구간 1"),
      parseBulkMinutesRange(modalBulkFrom2, modalBulkTo2, modalBulkMin2, "구간 2"),
    ];
    var active = [];
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (!r) continue;
      if (r.error) {
        alert(r.error);
        return;
      }
      active.push(r);
    }
    if (!active.length) {
      alert("적용할 구간을 입력해 주세요. (시작·끝 레벨, 분)");
      if (modalBulkFrom1) modalBulkFrom1.focus();
      return;
    }
    var totalUpdated = 0;
    active.forEach(function (range) {
      totalUpdated += applyBulkMinutesRange(range, playRows);
    });
    if (!totalUpdated) {
      alert("입력한 레벨 구간에 해당하는 블라인드 행이 없습니다.");
    }
  }

  function showNewPresetMeta(show) {
    if (!modalNewPresetMeta) return;
    modalNewPresetMeta.classList.toggle("is-hidden", !show);
    modalNewPresetMeta.setAttribute("aria-hidden", show ? "false" : "true");
  }

  function fillNewPresetMetaDefaults() {
    if (modalNewTournamentName) modalNewTournamentName.value = "새 대회";
    if (modalNewTournamentInfo) modalNewTournamentInfo.value = "";
    if (modalNewPlayer) modalNewPlayer.value = "0";
    if (modalNewEntry) modalNewEntry.value = "0";
    if (modalNewEntryChips) modalNewEntryChips.value = "0";
    if (modalNewTotalPrize) modalNewTotalPrize.value = "";
  }

  function collectNewPresetTournamentFromModal() {
    var o = emptyPresetTournamentSlice();
    if (modalNewTournamentName) {
      var tn = String(modalNewTournamentName.value || "").trim();
      o.tournamentName = tn || "새 대회";
    }
    if (modalNewTournamentInfo) {
      o.tournamentInfo = String(modalNewTournamentInfo.value || "");
    }
    if (modalNewTotalPrize) {
      o.totalPrizeText = String(modalNewTotalPrize.value || "");
    }
    var pl = modalNewPlayer ? parseInt(String(modalNewPlayer.value).trim(), 10) : 0;
    var en = modalNewEntry ? parseInt(String(modalNewEntry.value).trim(), 10) : 0;
    var ec = modalNewEntryChips
      ? parseInt(String(modalNewEntryChips.value).trim(), 10)
      : 0;
    o.player = Math.max(0, Number.isFinite(pl) ? pl : 0);
    o.entry = Math.max(0, Number.isFinite(en) ? en : 0);
    o.entryChips = Math.max(0, Number.isFinite(ec) ? ec : 0);
    clampPlayerEntry(o);
    return o;
  }

  function openModalNew() {
    editingPresetId = null;
    modalTitle.textContent = "프리셋 추가";
    modalName.value = "새 프리셋";
    if (modalRegCloseLevel) modalRegCloseLevel.value = "";
    if (modalPreWaitMinutes) modalPreWaitMinutes.value = "";
    showNewPresetMeta(true);
    fillNewPresetMetaDefaults();
    renderModalLevelRows([defaultLevelRow()]);
    modal.classList.add("is-open");
    updateModalScrollLock();
  }

  function openModalEdit(id) {
    var p = getPresets().find(function (x) {
      return x.id === id;
    });
    if (!p) return;
    editingPresetId = id;
    modalTitle.textContent = "프리셋 수정";
    modalName.value = p.name;
    if (modalRegCloseLevel) {
      var rcl = p.regCloseAfterPlayLevel;
      modalRegCloseLevel.value =
        rcl != null && Number.isFinite(Number(rcl)) && Number(rcl) >= 1
          ? String(Math.floor(Number(rcl)))
          : "";
    }
    if (modalPreWaitMinutes) {
      var pwm = p.preGameWaitMinutes;
      modalPreWaitMinutes.value =
        pwm != null &&
        Number.isFinite(Number(pwm)) &&
        Math.floor(Number(pwm)) >= 1
          ? String(Math.floor(Number(pwm)))
          : "";
    }
    showNewPresetMeta(false);
    var lv = p.levels && p.levels.length ? p.levels : [defaultLevelRow()];
    renderModalLevelRows(lv);
    modal.classList.add("is-open");
    updateModalScrollLock();
  }

  function closeModal() {
    modal.classList.remove("is-open");
    updateModalScrollLock();
  }

  function saveModal() {
    var name = modalName.value.trim();
    if (!name) {
      alert("이름을 입력해 주세요.");
      return;
    }
    var collected = collectModalLevels();
    if (collected.error) {
      alert(collected.error);
      return;
    }
    var levels = collected.levels;
    var regCloseAfterPlayLevel = null;
    if (modalRegCloseLevel) {
      var rcs = String(modalRegCloseLevel.value || "").trim();
      if (rcs !== "") {
        var rcp = parseInt(rcs, 10);
        if (Number.isFinite(rcp) && rcp >= 1 && rcp <= 999) regCloseAfterPlayLevel = rcp;
      }
    }
    var preGameWaitMinutes = null;
    if (modalPreWaitMinutes) {
      var pws = String(modalPreWaitMinutes.value || "").trim();
      if (pws !== "") {
        var pwp = parseInt(pws, 10);
        if (Number.isFinite(pwp) && pwp >= 1 && pwp <= 999) preGameWaitMinutes = pwp;
      }
    }
    var list = getPresets();
    if (editingPresetId) {
      var i = list.findIndex(function (x) {
        return x.id === editingPresetId;
      });
      if (i >= 0) {
        var patch = {
          name: name,
          levels: levels,
          regCloseAfterPlayLevel: regCloseAfterPlayLevel,
          preGameWaitMinutes: preGameWaitMinutes,
        };
        if (editingPresetId === getActivePresetId()) {
          Object.assign(patch, tournamentSliceFromRemote());
        } else {
          Object.assign(patch, pickEmbeddedTournament(list[i]));
        }
        list[i] = Object.assign({}, list[i], patch);
      }
    } else {
      list.push(
        Object.assign(
          {
            id: uid(),
            name: name,
            levels: levels,
            regCloseAfterPlayLevel: regCloseAfterPlayLevel,
            preGameWaitMinutes: preGameWaitMinutes,
          },
          collectNewPresetTournamentFromModal()
        )
      );
    }
    var savedPresetId = editingPresetId;
    if (!savedPresetId && list.length) {
      savedPresetId = list[list.length - 1].id;
    }
    savePresets(list, { skipCloudPush: true });
    if (savedPresetId && window.MetisSheetSync) {
      MetisSheetSync.savePresetsToCloud(list, savedPresetId, {
        changedPresetIds: [savedPresetId],
        urgent: true,
      });
    }
    closeModal();
    renderPresets();
    persistAll();
    showSaveToast(
      editingPresetId ? "프리셋이 저장되었습니다." : "새 프리셋이 추가되었습니다."
    );
  }

  function doStart() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume().catch(function () {});
    } catch (e1) {}
    var now = Date.now();
    var s = MetisTimer.readSyncState() || buildFullSync();
    var t = MetisTimer.normalizeTimer(s.timer || {}, s);
    if (MetisTimer.isEffectivelyRunningTimer(t, now)) {
      MetisTimer.writeSyncState(s);
      applySyncToRemoteState(s);
      renderRemote();
      return;
    }
    MetisTimer.applyStartOrResume(s, now);
    MetisTimer.writeSyncState(s, { userAction: true, urgentCloudPush: true });
    applySyncToRemoteState(s);
    renderRemote();
  }

  function doPause() {
    var s = MetisTimer.readSyncState() || buildFullSync();
    MetisTimer.applyPause(s, Date.now());
    MetisTimer.writeSyncState(s, { userAction: true, urgentCloudPush: true });
    applySyncToRemoteState(s);
    renderRemote();
  }

  function doRefresh() {
    var s = MetisTimer.readSyncState() || buildFullSync();
    MetisTimer.applyLevelRefresh(s, Date.now());
    MetisTimer.writeSyncState(s, { userAction: true, urgentCloudPush: true });
    applySyncToRemoteState(s);
    renderRemote();
  }

  function doStop() {
    if (!window.confirm("타이머를 종료하시겠습니까?")) return;
    MetisTimer.setSyncPresetId(getActivePresetId());
    var now = Date.now();
    var s = MetisTimer.readSyncState() || buildFullSync();
    var levels = MetisTimer.getActiveLevels(s);

    s.timer = MetisTimer.defaultTimer();
    s.pendingBridge = null;
    s.hasStartedOnce = false;
    s.timerStatus = "대기중";
    s.level = 1;
    s.regCloseAt = null;
    if (typeof s.totalScheduleCommittedSec === "number") s.totalScheduleCommittedSec = 0;
    s.totalSeconds = 0;
    s.totalSecondsTickAt = null;

    if (levels && levels.length) {
      s.timer.levelIndex = 0;
      s.timer.pausedRemainingSec = MetisTimer.levelDurationSec(levels[0]);
      s.displayTime = MetisTimer.formatMMSS(s.timer.pausedRemainingSec);
    } else {
      s.timer.levelIndex = 0;
      s.timer.pausedRemainingSec = 0;
      s.displayTime = "00:00";
    }

    MetisTimer.writeSyncState(s, { userAction: true, urgentCloudPush: true });
    applySyncToRemoteState(s);
    renderRemote();
  }

  ensureAdminPin();

  pinInputs.forEach(function (input, i) {
    input.addEventListener("input", function () {
      input.value = input.value.replace(/\D/g, "").slice(-1);
      if (input.value && i < pinInputs.length - 1) pinInputs[i + 1].focus();
      authError.textContent = "";
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Backspace" && !input.value && i > 0) {
        pinInputs[i - 1].focus();
        pinInputs[i - 1].value = "";
      }
      if (e.key === "Enter") tryUnlock();
    });
  });

  btnUnlock.addEventListener("click", tryUnlock);

  if (btnStart) btnStart.addEventListener("click", doStart);
  if (btnPause) btnPause.addEventListener("click", doPause);
  if (btnRefresh) btnRefresh.addEventListener("click", doRefresh);
  if (btnStop) btnStop.addEventListener("click", doStop);

  bindEntryPlayerCounters();
  bindEntryChipsCounter();
  bindMetaFormOnce();

  presetSelect.addEventListener("change", function () {
    activatePreset(presetSelect.value);
  });

  btnPresetAdd.addEventListener("click", openModalNew);

  var btnPresetExport = document.getElementById("btn-preset-export");
  var btnPresetImport = document.getElementById("btn-preset-import");
  var inputPresetImport = document.getElementById("input-preset-import");
  if (btnPresetExport) btnPresetExport.addEventListener("click", exportSelectedPresetToFile);
  if (btnPresetImport && inputPresetImport) {
    btnPresetImport.addEventListener("click", function () {
      inputPresetImport.click();
    });
    inputPresetImport.addEventListener("change", function () {
      var f = inputPresetImport.files && inputPresetImport.files[0];
      inputPresetImport.value = "";
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || "");
        var parsed = parsePresetImportJson(text);
        if (parsed.error) {
          alert(parsed.error);
          return;
        }
        applyImportedPreset(parsed.preset);
      };
      reader.onerror = function () {
        alert("파일을 읽지 못했습니다.");
      };
      reader.readAsText(f, "UTF-8");
    });
  }

  modalCancel.addEventListener("click", closeModal);
  modalSave.addEventListener("click", saveModal);
  if (modalAddLevel && modalLevelsTbody) {
    modalAddLevel.addEventListener("click", function () {
      modalLevelsTbody.appendChild(buildLevelRowTr(defaultLevelRow()));
      updateModalLevelLabels();
    });
  }
  if (modalAddBreak && modalLevelsTbody) {
    modalAddBreak.addEventListener("click", function () {
      modalLevelsTbody.appendChild(buildBreakRowTr(defaultBreakRow()));
      updateModalLevelLabels();
    });
  }
  if (modalBulkApply) {
    modalBulkApply.addEventListener("click", applyBulkMinutesToLevelRows);
  }
  [
    modalBulkFrom1,
    modalBulkTo1,
    modalBulkMin1,
    modalBulkFrom2,
    modalBulkTo2,
    modalBulkMin2,
  ].forEach(function (el) {
    if (!el) return;
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        applyBulkMinutesToLevelRows();
      }
    });
  });
  if (btnOpenPrizeModal) {
    btnOpenPrizeModal.addEventListener("click", openPrizeModal);
  }
  if (modalPrizeAdd) {
    modalPrizeAdd.addEventListener("click", function () {
      createPrizeModalRow("", "");
    });
  }
  if (modalPrizeSave) {
    modalPrizeSave.addEventListener("click", savePrizeModal);
  }
  if (modalPrizeCancel) {
    modalPrizeCancel.addEventListener("click", closePrizeModal);
  }
  if (modalPrizeTbody) {
    ensurePrizeSortable();
    modalPrizeTbody.addEventListener("input", function (e) {
      var target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.classList.contains("prize-row-amount")) {
        target.value = formatAmountWithCommas(target.value);
      }
    });
    modalPrizeTbody.addEventListener("click", function (e) {
      var target = e.target;
      if (!(target instanceof HTMLButtonElement)) return;
      if (!target.classList.contains("btn-prize-row-remove")) return;
      var row = target.closest("tr");
      if (row) row.remove();
      if (!modalPrizeTbody.querySelector("tr")) createPrizeModalRow("", "");
    });
  }

  document.getElementById("btn-level-minus").addEventListener("click", function () {
    var lv = Math.floor(Number(remoteState.level));
    if (!Number.isFinite(lv) || lv < 1) lv = 1;
    remoteState.level = Math.max(1, lv - 1);
    document.getElementById("val-level").textContent = String(remoteState.level);
    alignTimerToCurrentLevel();
    renderRemote();
  });
  document.getElementById("btn-level-plus").addEventListener("click", function () {
    var lv = Math.floor(Number(remoteState.level));
    if (!Number.isFinite(lv) || lv < 1) lv = 1;
    var sPeek = MetisTimer.readSyncState() || buildFullSync();
    var lvls = MetisTimer.getActiveLevels(sPeek);
    var maxStep = lvls && lvls.length ? lvls.length : 99999;
    remoteState.level = Math.min(maxStep, lv + 1);
    document.getElementById("val-level").textContent = String(remoteState.level);
    alignTimerToCurrentLevel();
    renderRemote();
  });

  MetisTimer.subscribeSync(function () {
    if (!isSessionOk() || !screenRemote.classList.contains("is-active")) return;
    MetisTimer.setSyncPresetId(getActivePresetId());
    var s = MetisTimer.readSyncState();
    if (s && s.updatedAt) lastRemoteSeenUpdated = s.updatedAt;
    remoteState = getRemote();
    renderRemote();
  });

  function startAppAfterCloudSync() {
    hydrateAllPresetTournaments();
    if (MetisTimer.syncAllPresetsMetadataFromStorage) {
      MetisTimer.syncAllPresetsMetadataFromStorage();
    }
    remoteState = getRemote();
    startCloudTimerSyncIfNeeded();
    if (isSessionOk()) {
      showScreen("remote");
      renderRemote();
      renderPresets();
      mirrorLocalSync();
      syncLastSeenFromStore();
    } else {
      showScreen("auth");
      renderPresets();
      requestAnimationFrame(function () {
        if (pinInputs[0]) pinInputs[0].focus();
      });
    }
  }

  if (window.MetisSheetSync) {
    MetisSheetSync.pullPresetsToLocal().finally(startAppAfterCloudSync);
  } else {
    startAppAfterCloudSync();
  }
})();
