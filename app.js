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
      rebuy: 0,
      addon: 0,
      early: 0,
      level: 1,
      entryChips: 50000,
      earlyChips: 0,
      regCloseLevel: 15,
      rebuyChips: 0,
      addonChips: 0,
    };
  }

  var defaultPresets = function () {
    return [
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
    if (p && /^\d{6}$/.test(p)) return p;
    return null;
  }

  function setAdminPin(pin) {
    localStorage.setItem(STORAGE.ADMIN_PIN, pin);
  }

  function ensureAdminPin() {
    if (!getAdminPin()) setAdminPin("000000");
  }

  function getRemote() {
    var s = MetisTimer.readSyncState();
    if (s) {
      return Object.assign({}, defaultRemote(), MetisTimer.pickRemoteSlice(s));
    }
    var data = loadJson(STORAGE.REMOTE, function () {
      return {};
    });
    return Object.assign({}, defaultRemote(), data);
  }

  function getPresets() {
    var list = loadJson(STORAGE.PRESETS, defaultPresets);
    return Array.isArray(list) && list.length ? list : defaultPresets();
  }

  function savePresets(list) {
    localStorage.setItem(STORAGE.PRESETS, JSON.stringify(list));
  }

  function getActivePresetId() {
    return localStorage.getItem(STORAGE.ACTIVE_PRESET_ID) || "";
  }

  function setActivePresetId(id) {
    localStorage.setItem(STORAGE.ACTIVE_PRESET_ID, id);
  }

  function uid() {
    return "p_" + Math.random().toString(36).slice(2, 11);
  }

  var remoteState = getRemote();
  var editingPresetId = null;

  function buildFullSync() {
    var prev = MetisTimer.readSyncState();
    var presets = getPresets();
    var aid = getActivePresetId();
    var base = Object.assign({}, defaultRemote(), remoteState, {
      presets: presets,
      activePresetId: aid,
    });
    var t = prev && prev.timer ? prev.timer : MetisTimer.defaultTimer();
    base.timer = MetisTimer.normalizeTimer(t, base);
    MetisTimer.syncLevelField(base);
    return base;
  }

  function persistAll() {
    MetisTimer.writeSyncState(buildFullSync());
  }

  function pushToTimerBroadcast() {
    persistAll();
  }

  function applySyncToRemoteState(s) {
    Object.assign(remoteState, MetisTimer.pickRemoteSlice(s));
  }

  function alignTimerToCurrentLevel() {
    var s = MetisTimer.readSyncState() || buildFullSync();
    var levels = MetisTimer.getActiveLevels(s);
    if (!levels || !levels.length) {
      persistAll();
      return;
    }
    var idx = Math.max(0, (parseInt(remoteState.level, 10) || 1) - 1);
    idx = Math.min(idx, levels.length - 1);
    s.timer = MetisTimer.normalizeTimer(s.timer || {}, s);
    s.timer.levelIndex = idx;
    MetisTimer.syncLevelField(s);
    var dur = MetisTimer.levelDurationSec(levels[s.timer.levelIndex]);
    if (s.timer.isRunning) {
      s.timer.endAt = Date.now() + dur * 1000;
      s.timer.pausedRemainingSec = dur;
    } else {
      s.timer.pausedRemainingSec = dur;
      s.timer.endAt = null;
    }
    s.displayTime = MetisTimer.formatMMSS(
      MetisTimer.remainingSec(s, Date.now())
    );
    MetisTimer.writeSyncState(s);
    applySyncToRemoteState(s);
  }

  var screenAuth = document.getElementById("screen-auth");
  var screenRemote = document.getElementById("screen-remote");
  var pinInputs = Array.from(document.querySelectorAll(".pin-digit"));
  var authError = document.getElementById("auth-error");
  var btnUnlock = document.getElementById("btn-unlock");
  var btnLogout = document.getElementById("btn-logout");
  var remoteTitle = document.getElementById("remote-title");
  var elTimerStatus = document.getElementById("timer-status");
  var elTimerClock = document.getElementById("timer-clock");
  var presetSelect = document.getElementById("preset-select");
  var presetTbody = document.getElementById("preset-tbody");
  var btnPresetAdd = document.getElementById("btn-preset-add");
  var btnOpenTimer = document.getElementById("btn-open-timer");
  var btnRestart = document.getElementById("btn-restart");
  var btnPause = document.getElementById("btn-pause");

  var modal = document.getElementById("modal-preset");
  var modalPanel = document.getElementById("modal-preset-panel");
  var modalTitle = document.getElementById("modal-title");
  var modalName = document.getElementById("modal-name");
  var modalLevels = document.getElementById("modal-levels");
  var modalCancel = document.getElementById("modal-cancel");
  var modalSave = document.getElementById("modal-save");

  var counters = ["player", "entry", "rebuy", "addon"];

  var remoteEngineId = null;

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
    if (pin.length !== 6) {
      authError.textContent = "6자리 숫자를 모두 입력해 주세요.";
      return;
    }
    ensureAdminPin();
    if (pin === getAdminPin()) {
      setSession(true);
      remoteState = getRemote();
      showScreen("remote");
      renderRemote();
      renderPresets();
      persistAll();
    } else {
      authError.textContent = "비밀번호가 올바르지 않습니다.";
      clearPin();
    }
  }

  function logout() {
    setSession(false);
    clearPin();
    authError.textContent = "";
    showScreen("auth");
    if (pinInputs[0]) pinInputs[0].focus();
  }

  function startRemoteEngine() {
    if (remoteEngineId != null) return;
    remoteEngineId = setInterval(function () {
      if (!isSessionOk() || !screenRemote.classList.contains("is-active"))
        return;
      var step = MetisTimer.engineStep();
      if (!step) return;
      elTimerClock.textContent = MetisTimer.formatMMSS(step.rem);
      elTimerStatus.textContent = step.state.timerStatus || "대기중";
      Object.assign(remoteState, MetisTimer.pickRemoteSlice(step.state));
      var lvlEl = document.getElementById("val-level");
      if (lvlEl) lvlEl.textContent = String(step.state.level || 1);
    }, 200);
  }

  function stopRemoteEngine() {
    if (remoteEngineId != null) {
      clearInterval(remoteEngineId);
      remoteEngineId = null;
    }
  }

  function bindCounter(name) {
    var valEl = document.getElementById("val-" + name);
    var minus = document.getElementById("btn-" + name + "-minus");
    var plus = document.getElementById("btn-" + name + "-plus");
    function update() {
      valEl.textContent = String(remoteState[name]);
      persistAll();
    }
    minus.addEventListener("click", function () {
      remoteState[name] = Math.max(0, (remoteState[name] | 0) - 1);
      update();
    });
    plus.addEventListener("click", function () {
      remoteState[name] = (remoteState[name] | 0) + 1;
      update();
    });
  }

  function renderRemote() {
    remoteState = getRemote();
    remoteTitle.textContent =
      "타이머 리모컨 — " + (remoteState.tournamentName || "토너먼트");
    elTimerStatus.textContent = remoteState.timerStatus || "대기중";
    var s = MetisTimer.readSyncState();
    var now = Date.now();
    var rem = s
      ? MetisTimer.remainingSec(s, now)
      : parseTimeToSec(remoteState.displayTime);
    elTimerClock.textContent = MetisTimer.formatMMSS(rem);
    counters.forEach(function (c) {
      var el = document.getElementById("val-" + c);
      if (el) el.textContent = String(remoteState[c] != null ? remoteState[c] : 0);
    });
    document.getElementById("val-total-chips").textContent = formatNum(
      remoteState.totalChips
    );
    document.getElementById("val-avg-stack").textContent = formatNum(
      remoteState.avgStack
    );
    document.getElementById("val-early").textContent = String(
      remoteState.early != null ? remoteState.early : 0
    );
    document.getElementById("val-level").textContent = String(
      remoteState.level != null ? remoteState.level : 1
    );
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

  function renderPresets() {
    var presets = getPresets();
    var active = getActivePresetId();
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
      tr.innerHTML =
        "<td>" +
        (idx + 1) +
        "</td><td>" +
        escapeHtml(p.name) +
        "</td><td>" +
        (p.levels ? p.levels.length : 0) +
        '</td><td class="preset-actions"></td>';
      var cell = tr.querySelector(".preset-actions");
      cell.appendChild(
        mkBtn("적용", "sm blue", function () {
          setActivePresetId(p.id);
          presetSelect.value = p.id;
          alignTimerToCurrentLevel();
          persistAll();
        })
      );
      cell.appendChild(
        mkBtn("수정", "sm neutral", function () {
          openModalEdit(p.id);
        })
      );
      cell.appendChild(
        mkBtn("삭제", "sm red", function () {
          if (!confirm("이 프리셋을 삭제할까요?")) return;
          var next = presets.filter(function (x) {
            return x.id !== p.id;
          });
          savePresets(next);
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

  function levelsToText(levels) {
    return JSON.stringify(levels, null, 2);
  }

  function parseLevelsText(text) {
    var parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("레벨은 배열이어야 합니다.");
    return parsed.map(function (row, i) {
      var sb = Number(row.sb);
      var bb = Number(row.bb);
      var ante = Number(row.ante != null ? row.ante : 0);
      var minutes = Number(row.minutes != null ? row.minutes : 20);
      if (!Number.isFinite(sb) || !Number.isFinite(bb))
        throw new Error("레벨 " + (i + 1) + ": sb/bb가 필요합니다.");
      return { sb: sb, bb: bb, ante: ante, minutes: minutes };
    });
  }

  function openModalNew() {
    editingPresetId = null;
    modalTitle.textContent = "프리셋 추가";
    modalName.value = "새 프리셋";
    modalLevels.value = levelsToText(defaultPresets()[0].levels);
    modal.classList.add("is-open");
  }

  function openModalEdit(id) {
    var p = getPresets().find(function (x) {
      return x.id === id;
    });
    if (!p) return;
    editingPresetId = id;
    modalTitle.textContent = "프리셋 수정";
    modalName.value = p.name;
    modalLevels.value = levelsToText(p.levels || []);
    modal.classList.add("is-open");
  }

  function closeModal() {
    modal.classList.remove("is-open");
  }

  function saveModal() {
    var name = modalName.value.trim();
    if (!name) {
      alert("이름을 입력해 주세요.");
      return;
    }
    var levels;
    try {
      levels = parseLevelsText(modalLevels.value);
    } catch (e) {
      alert(e.message || "JSON 형식을 확인해 주세요.");
      return;
    }
    var list = getPresets();
    if (editingPresetId) {
      var i = list.findIndex(function (x) {
        return x.id === editingPresetId;
      });
      if (i >= 0) list[i] = Object.assign({}, list[i], { name: name, levels: levels });
    } else {
      list.push({ id: uid(), name: name, levels: levels });
    }
    savePresets(list);
    closeModal();
    renderPresets();
    persistAll();
  }

  function doRestart() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume().catch(function () {});
    } catch (e1) {}
    var s = MetisTimer.readSyncState() || buildFullSync();
    MetisTimer.applyRestart(s, Date.now());
    MetisTimer.writeSyncState(s);
    applySyncToRemoteState(s);
    renderRemote();
  }

  function doPause() {
    var s = MetisTimer.readSyncState() || buildFullSync();
    MetisTimer.applyPause(s, Date.now());
    MetisTimer.writeSyncState(s);
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
  btnLogout.addEventListener("click", logout);

  if (btnRestart) btnRestart.addEventListener("click", doRestart);
  if (btnPause) btnPause.addEventListener("click", doPause);

  counters.forEach(bindCounter);

  presetSelect.addEventListener("change", function () {
    setActivePresetId(presetSelect.value);
    alignTimerToCurrentLevel();
    persistAll();
  });

  btnPresetAdd.addEventListener("click", openModalNew);
  modalCancel.addEventListener("click", closeModal);
  modalSave.addEventListener("click", saveModal);
  modalPanel.addEventListener("click", function (e) {
    e.stopPropagation();
  });
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });

  btnOpenTimer.addEventListener("click", function () {
    persistAll();
    window.open(
      "timer.html",
      "metisTimer",
      "noopener,noreferrer,width=1200,height=800"
    );
  });

  document.getElementById("btn-early-minus").addEventListener("click", function () {
    remoteState.early = Math.max(0, (remoteState.early | 0) - 1);
    document.getElementById("val-early").textContent = String(remoteState.early);
    persistAll();
  });
  document.getElementById("btn-early-plus").addEventListener("click", function () {
    remoteState.early = (remoteState.early | 0) + 1;
    document.getElementById("val-early").textContent = String(remoteState.early);
    persistAll();
  });
  document.getElementById("btn-level-minus").addEventListener("click", function () {
    remoteState.level = Math.max(1, (remoteState.level | 1) - 1);
    document.getElementById("val-level").textContent = String(remoteState.level);
    alignTimerToCurrentLevel();
    renderRemote();
  });
  document.getElementById("btn-level-plus").addEventListener("click", function () {
    remoteState.level = (remoteState.level | 1) + 1;
    document.getElementById("val-level").textContent = String(remoteState.level);
    alignTimerToCurrentLevel();
    renderRemote();
  });

  MetisTimer.subscribeSync(function () {
    if (!isSessionOk() || !screenRemote.classList.contains("is-active")) return;
    remoteState = getRemote();
    renderRemote();
  });

  if (isSessionOk()) {
    remoteState = getRemote();
    showScreen("remote");
    renderRemote();
    renderPresets();
    persistAll();
  } else {
    showScreen("auth");
    requestAnimationFrame(function () {
      if (pinInputs[0]) pinInputs[0].focus();
    });
  }
})();
