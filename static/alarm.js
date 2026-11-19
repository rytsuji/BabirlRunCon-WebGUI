"use strict";

(() => {
  if (window.__daqAlarmInstalled) return;
  window.__daqAlarmInstalled = true;

  const REPEAT_INTERVAL_MS = 3000;
  const TIMER_REPEAT_INTERVAL_MS = 4000;

  let config = {
    enabled: true,
    timer_notify: true,
    timer_repeat: true,
    statuses: {
      disconnected: true,
      state_error: true,
      acquisition: true,
      api_monitor: true
    },
    detectors: {
      eb: true,
      api: true,
      daq: true
    },
    detector_labels: {},
    panel_html: ""
  };

  let audioCtx = null;
  let audioUnlocked = false;
  let currentActiveSig = "";
  let acknowledgedSig = "";
  let latched = false;
  let latchedErrors = [];
  let lastPlayedAt = 0;
  let pendingPlay = false;
  let isPlayingStarting = false;
  let isUnloading = false;
  let activeMonitorItems = [];
  let floatingStopBtn = null;
  let floatingTimerBtn = null;
  let floatingArmBadge = null;

  // Run timer completion tracking
  let initializedTimerTracking = false;
  let lastNotifiedTimerId = "";
  let timerLatched = false;
  let timerMessage = "";
  let lastTimerPlayedAt = 0;
  let pendingTimerPlay = false;

  const errorBuckets = {
    status: [],
    connections: [],
    snapshot: [],
    monitors: {},
    api: []
  };

  window.addEventListener("beforeunload", () => {
    isUnloading = true;
  });

  function ensureAlarmStyles() {
    if (document.getElementById("daq-alarm-style")) return;
    const style = document.createElement("style");
    style.id = "daq-alarm-style";
    style.textContent = `
      @keyframes daq-alarm-off-blink {
        0%, 100% {
          background-color: #dc2626;
          color: #ffffff;
          box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.45);
        }
        50% {
          background-color: #fee2e2;
          color: #b91c1c;
          box-shadow: 0 0 8px 1px rgba(220, 38, 38, 0.35);
        }
      }
      @keyframes daq-alarm-firing-blink {
        0%, 100% {
          background-color: #b91c1c;
          color: #ffffff;
        }
        50% {
          background-color: #fef2f2;
          color: #991b1b;
        }
      }
      #tab-alarm.alarm-tab-off {
        background-color: #dc2626;
        color: #ffffff;
        border-bottom-color: #991b1b;
        border-radius: 5px 5px 0 0;
        padding: 0 8px 9px;
        font-weight: 700;
        animation: daq-alarm-off-blink 1.4s ease-in-out infinite;
      }
      #tab-alarm.alarm-tab-firing {
        background-color: #b91c1c;
        color: #ffffff;
        border-bottom-color: #7f1d1d;
        border-radius: 5px 5px 0 0;
        padding: 0 8px 9px;
        font-weight: 700;
        animation: daq-alarm-firing-blink 0.7s ease-in-out infinite;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showBriefToast(message) {
    try {
      const existing = document.getElementById("daq-alarm-timer-toast");
      if (existing) existing.remove();
      const el = document.createElement("div");
      el.id = "daq-alarm-timer-toast";
      el.className = "toast";
      el.textContent = message;
      document.body.appendChild(el);
      setTimeout(() => {
        if (el.parentNode) el.remove();
      }, 6000);
    } catch (_) {}
  }

  function isDetectorEnabled(detId) {
    if (Object.prototype.hasOwnProperty.call(config.detectors, detId)) {
      return Boolean(config.detectors[detId]);
    }
    return !/strasse/i.test(detId);
  }

  function isStatusEnabled(statusId) {
    if (Object.prototype.hasOwnProperty.call(config.statuses, statusId)) {
      return Boolean(config.statuses[statusId]);
    }
    return true;
  }

  function ensureContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        audioCtx = new AC();
        audioCtx.addEventListener("statechange", () => {
          audioUnlocked = audioCtx.state === "running";
          updateAlarmUI();
        });
      }
    }
    if (audioCtx) {
      audioUnlocked = audioCtx.state === "running";
    }
    return audioCtx;
  }

  function playSilentUnlockBuffer(ctx) {
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (_) {}
  }

  function emitTones() {
    if (!audioCtx || audioCtx.state !== "running") return false;

    const now = audioCtx.currentTime;
    [0.0, 0.62, 1.24].forEach((base) => {
      [
        { d: 0.00, f: 987.77, t: 0.10 },
        { d: 0.13, f: 987.77, t: 0.10 },
        { d: 0.26, f: 1318.5, t: 0.28 }
      ].forEach(({ d, f, t }) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(f, now + base + d);
        gain.gain.setValueAtTime(0.28, now + base + d);
        gain.gain.exponentialRampToValueAtTime(0.001, now + base + d + t);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + base + d);
        osc.stop(now + base + d + t);
      });
    });
    return true;
  }

  // Pleasant ascending C5-E5-G5-C6 completion chime for timed Run stop
  function emitTimerChime() {
    if (!audioCtx || audioCtx.state !== "running") return false;

    const now = audioCtx.currentTime;
    const notes = [
      { d: 0.00, f: 523.25, t: 0.22 }, // C5
      { d: 0.14, f: 659.25, t: 0.22 }, // E5
      { d: 0.28, f: 783.99, t: 0.24 }, // G5
      { d: 0.44, f: 1046.50, t: 0.55 } // C6
    ];
    notes.forEach(({ d, f, t }) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f, now + d);
      gain.gain.setValueAtTime(0.001, now + d);
      gain.gain.linearRampToValueAtTime(0.26, now + d + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + d + t);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + d);
      osc.stop(now + d + t);
    });
    return true;
  }

  function triggerAlarmNow(forceTest = false) {
    if (!forceTest && !config.enabled) return;
    const ctx = ensureContext();
    if (!ctx) return;

    if (ctx.state === "running") {
      audioUnlocked = true;
      updateAlarmUI();
      if (emitTones()) {
        if (!forceTest) lastPlayedAt = Date.now();
        pendingPlay = false;
      }
      return;
    }

    if (isPlayingStarting) return;
    isPlayingStarting = true;
    ctx.resume()
      .then(() => {
        isPlayingStarting = false;
        audioUnlocked = ctx.state === "running";
        updateAlarmUI();
        if (ctx.state === "running" && (forceTest || (config.enabled && latched))) {
          if (emitTones()) {
            if (!forceTest) lastPlayedAt = Date.now();
            pendingPlay = false;
          }
        } else if (!forceTest) {
          pendingPlay = true;
        }
      })
      .catch(() => {
        isPlayingStarting = false;
        if (!forceTest) pendingPlay = true;
        updateAlarmUI();
      });
  }

  function triggerTimerChimeNow(forceTest = false) {
    if (!forceTest && (!config.enabled || !config.timer_notify)) return;
    const ctx = ensureContext();
    if (!ctx) return;

    if (ctx.state === "running") {
      audioUnlocked = true;
      updateAlarmUI();
      if (emitTimerChime()) {
        if (!forceTest) lastTimerPlayedAt = Date.now();
        pendingTimerPlay = false;
      }
      return;
    }

    ctx.resume()
      .then(() => {
        audioUnlocked = ctx.state === "running";
        updateAlarmUI();
        if (ctx.state === "running" && (forceTest || (config.enabled && config.timer_notify && timerLatched))) {
          if (emitTimerChime()) {
            if (!forceTest) lastTimerPlayedAt = Date.now();
            pendingTimerPlay = false;
          }
        } else if (!forceTest) {
          pendingTimerPlay = true;
        }
      })
      .catch(() => {
        if (!forceTest) pendingTimerPlay = true;
        updateAlarmUI();
      });
  }

  function onUserGesture() {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state !== "running") {
      ctx.resume()
        .then(() => {
          playSilentUnlockBuffer(ctx);
          audioUnlocked = ctx.state === "running";
          updateAlarmUI();
          if ((pendingPlay || latched) && config.enabled && latched) {
            triggerAlarmNow();
          } else if ((pendingTimerPlay || timerLatched) && config.enabled && config.timer_notify && timerLatched) {
            triggerTimerChimeNow();
          }
        })
        .catch(() => {});
    } else if (!audioUnlocked) {
      playSilentUnlockBuffer(ctx);
      audioUnlocked = true;
      updateAlarmUI();
      if (pendingPlay && config.enabled && latched) {
        triggerAlarmNow();
      } else if (pendingTimerPlay && config.enabled && config.timer_notify && timerLatched) {
        triggerTimerChimeNow();
      }
    } else {
      if (pendingPlay && config.enabled && latched) triggerAlarmNow();
      if (pendingTimerPlay && config.enabled && config.timer_notify && timerLatched) triggerTimerChimeNow();
    }
  }

  ["pointerdown", "mousedown", "click", "touchstart", "keydown"].forEach((ev) =>
    window.addEventListener(ev, onUserGesture, { passive: true, capture: true })
  );

  function formatDurationLabel(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (rem > 0 || parts.length === 0) parts.push(`${rem}s`);
    return parts.join(" ");
  }

  function handleRunTimerStatus(rt) {
    if (!rt || typeof rt !== "object" || !rt.id) {
      initializedTimerTracking = true;
      return;
    }

    if (!initializedTimerTracking) {
      initializedTimerTracking = true;
      if (!rt.active && ["completed", "cancelled", "failed"].includes(rt.phase)) {
        lastNotifiedTimerId = rt.id;
      }
      return;
    }

    if (rt.active) {
      // If a new timer run starts, clear any previous completion notice
      if (timerLatched && rt.id !== lastNotifiedTimerId) {
        dismissTimerNotice();
      }
      return;
    }

    if (rt.id === lastNotifiedTimerId) return;

    if (rt.phase === "completed") {
      lastNotifiedTimerId = rt.id;
      const durText = formatDurationLabel(rt.duration_sec);
      const runsText = rt.repeat && rt.total_runs > 1 ? `, ${rt.total_runs} runs` : "";
      timerMessage = `Timed Run completed and stopped (${durText}${runsText}).`;
      showBriefToast(`⏱️ ${timerMessage}`);

      if (config.timer_notify) {
        timerLatched = true;
        lastTimerPlayedAt = 0;
        updateAlarmUI();
        triggerTimerChimeNow();
        if (!config.timer_repeat) {
          // One-shot chime mode: play once and clear repeat latch after initial playback
          pendingTimerPlay = false;
        }
      }
    } else if (rt.phase === "cancelled" || rt.phase === "failed") {
      lastNotifiedTimerId = rt.id;
    }
  }

  function dismissTimerNotice() {
    timerLatched = false;
    pendingTimerPlay = false;
    updateAlarmUI();
  }

  function formatEsLabel(item, efn) {
    const hostPart = item.host ? ` (${item.host})` : "";
    if (item.name) {
      return `efn=${efn}: ${item.name}${hostPart}`;
    }
    return `efn=${efn}${hostPart}`;
  }

  function processEsObject(esObj, itemsOut, newDetectors) {
    if (!esObj || typeof esObj !== "object") return;
    if (esObj.error) {
      if (!Object.prototype.hasOwnProperty.call(config.detectors, "es_all")) {
        newDetectors["es_all"] = {
          label: "ES Common (overall ES query error)",
          default_enabled: true
        };
      }
      itemsOut.push({
        key: "es_err:" + esObj.error,
        detectorId: "es_all",
        statusType: "disconnected",
        message: "ES Common: " + esObj.error
      });
    }
    if (Array.isArray(esObj.items)) {
      esObj.items.forEach((item, idx) => {
        if (!item || typeof item !== "object") return;
        const efn = item.efn !== undefined && item.efn !== null ? String(item.efn) : String(idx);
        const detId = "es_" + efn;
        const label = formatEsLabel(item, efn);

        if (!Object.prototype.hasOwnProperty.call(config.detectors, detId) || config.detector_labels[detId] !== label) {
          newDetectors[detId] = { label, default_enabled: isDetectorEnabled(detId) };
        }

        if (item.error) {
          itemsOut.push({
            key: `es_${efn}:${item.error}`,
            detectorId: detId,
            statusType: "disconnected",
            message: `ES ${label}: ${item.error}`
          });
        } else if (item.connected === false) {
          itemsOut.push({
            key: `es_${efn}:disconnected`,
            detectorId: detId,
            statusType: "disconnected",
            message: `ES ${label}: Disconnected`
          });
        }
      });
    }
  }

  function parseStatusPayload(url, data, newDetectors) {
    const items = [];
    if (!data || typeof data !== "object") {
      items.push({
        key: "invalid_json:" + url,
        detectorId: "daq",
        statusType: "api_monitor",
        message: "Invalid status response"
      });
      return items;
    }

    const st = data.state || {};
    const acq = st.acquisition_errors || {};
    const isInitial = data.connected === false && !data.error && !data.snapshot_at;

    if (!isInitial && data.connected === false) {
      items.push({
        key: "disconnected:" + (data.error || "unknown"),
        detectorId: "daq",
        statusType: "disconnected",
        message: "DAQ disconnected: " + (data.error || "unknown")
      });
    }
    if (data.error) {
      items.push({
        key: "err:" + data.error,
        detectorId: "daq",
        statusType: "state_error",
        message: "DAQ Error: " + data.error
      });
    }
    if (data.eb_connection?.connected === false) {
      items.push({
        key: "eb_conn:" + (data.eb_connection.error || "false"),
        detectorId: "eb",
        statusType: "disconnected",
        message: "Event Builder (EB): " + (data.eb_connection.error || "Disconnected")
      });
    }
    if (data.api_connection?.connected === false) {
      items.push({
        key: "api_conn:" + (data.api_connection.error || "false"),
        detectorId: "api",
        statusType: "disconnected",
        message: "Run Control API: " + (data.api_connection.error || "Disconnected")
      });
    }
    if (st.state === "error") {
      items.push({
        key: "state_error",
        detectorId: "daq",
        statusType: "state_error",
        message: "DAQ State is ERROR"
      });
    }
    if (Array.isArray(data.control_errors) && data.control_errors.length > 0) {
      items.push({
        key: "ctrl_err:" + data.control_errors.length,
        detectorId: "daq",
        statusType: "state_error",
        message: "Control Error (" + data.control_errors.length + ")"
      });
    }
    if (data.active_operation?.status === "failed") {
      items.push({
        key: "op_fail:" + (data.active_operation.id || ""),
        detectorId: "daq",
        statusType: "state_error",
        message: "Operation failed: " + (data.active_operation.message || data.active_operation.id || "")
      });
    }
    if (data.run_timer?.phase === "failed") {
      items.push({
        key: "timer_fail:" + (data.run_timer.id || ""),
        detectorId: "daq",
        statusType: "state_error",
        message: "Timer stopped with error: " + (data.run_timer.message || "failed")
      });
    }

    for (const [k, v] of Object.entries(acq)) {
      if (!v || k === "target") continue;
      const detId = k.includes("/es") ? "es_all" : "daq";
      if (detId === "es_all" && !Object.prototype.hasOwnProperty.call(config.detectors, "es_all")) {
        newDetectors["es_all"] = {
          label: "ES Common (overall ES query error)",
          default_enabled: true
        };
      }
      items.push({
        key: `acq:${k}:${v}`,
        detectorId: detId,
        statusType: "acquisition",
        message: `Acquisition (${k}): ${v}`
      });
    }

    processEsObject(data.es_connections, items, newDetectors);
    return items;
  }

  function syncExperimentConfig(expConfig, pruneMonitors = true) {
    if (!expConfig || typeof expConfig !== "object") return;
    activeMonitorItems = Array.isArray(expConfig.monitor_api) ? expConfig.monitor_api : [];

    const reg = {};
    const validMonitorIds = [];

    if (expConfig.eb?.name) {
      reg["eb"] = {
        label: `Event Builder (${expConfig.eb.name})`,
        default_enabled: isDetectorEnabled("eb")
      };
    }

    activeMonitorItems.forEach((m) => {
      if (!m || !m.name) return;
      const detId = "monitor:" + m.name;
      validMonitorIds.push(detId);
      const disabledSuffix = m.enabled === false ? " (disabled in YAML)" : "";
      reg[detId] = {
        label: `${m.name}${disabledSuffix}`,
        default_enabled: !/strasse/i.test(m.name)
      };
    });

    const patch = {};
    if (Object.keys(reg).length > 0) patch.register_detectors = reg;
    if (pruneMonitors) patch.valid_monitor_ids = validMonitorIds;
    if (Object.keys(patch).length > 0) {
      saveServerConfig(patch);
    }
  }

  function syncAlarmState() {
    const monitorErrors = Object.values(errorBuckets.monitors).flat();
    const rawAll = [
      ...errorBuckets.status,
      ...errorBuckets.connections,
      ...errorBuckets.snapshot,
      ...monitorErrors,
      ...errorBuckets.api
    ];

    const uniqueMap = new Map();
    for (const item of rawAll) uniqueMap.set(item.key, item);
    const allItems = Array.from(uniqueMap.values());

    const activeItems = allItems.filter(
      (item) => isDetectorEnabled(item.detectorId) && isStatusEnabled(item.statusType)
    );

    if (activeItems.length === 0) {
      currentActiveSig = "";
      if (!latched) {
        acknowledgedSig = "";
        latchedErrors = [];
      }
      updateAlarmUI();
      return;
    }

    const newSig = activeItems.map((i) => i.key).sort().join("|");
    currentActiveSig = newSig;

    if (newSig !== acknowledgedSig) {
      if (!latched || latchedErrors.map((i) => i.key).sort().join("|") !== newSig) {
        latched = true;
        latchedErrors = activeItems;
        lastPlayedAt = 0;
      }
    }

    updateAlarmUI();
    tickAlarm();
  }

  function stopAlarm() {
    latched = false;
    acknowledgedSig = currentActiveSig;
    pendingPlay = false;
    updateAlarmUI();
  }

  function inspectData(url, ok, data) {
    if (isUnloading || url.includes("/api/alarm")) return;
    const newDetectors = {};

    if (ok && data && typeof data === "object" && data.config && Array.isArray(data.config.monitor_api)) {
      errorBuckets.monitors = {};
      syncExperimentConfig(data.config, true);
      syncAlarmState();
      return;
    }

    if (url.includes("/status")) {
      if (!ok) {
        const detail = (data && typeof data === "object" && data.detail) ? data.detail : "HTTP error";
        errorBuckets.status = [{
          key: "status_http:" + detail,
          detectorId: "api",
          statusType: "api_monitor",
          message: "Status API failed: " + detail
        }];
      } else {
        if (data && typeof data === "object") {
          handleRunTimerStatus(data.run_timer);
        }
        errorBuckets.status = parseStatusPayload(url, data, newDetectors);
        if (data && typeof data === "object" && data.es_connections !== undefined) {
          errorBuckets.connections = [];
        }
      }
    } else if (url.includes("/connections/")) {
      if (!ok) {
        const detail = (data && typeof data === "object" && data.detail) ? data.detail : "HTTP error";
        errorBuckets.connections = [{
          key: "conn_http:" + detail,
          detectorId: "api",
          statusType: "api_monitor",
          message: "Connection check failed: " + detail
        }];
      } else {
        const items = [];
        processEsObject(data, items, newDetectors);
        errorBuckets.connections = items;
      }
    } else if (url.includes("/notification-snapshot")) {
      if (!ok) {
        errorBuckets.snapshot = [{
          key: "snap_http",
          detectorId: "api",
          statusType: "api_monitor",
          message: "Snapshot request failed"
        }];
      } else {
        errorBuckets.snapshot = parseStatusPayload(url, data, newDetectors);
      }
    } else if (url.includes("/monitors/")) {
      const mMatch = url.match(/\/monitors\/(\d+)/);
      const idx = mMatch ? Number(mMatch[1]) : -1;
      const monMeta = idx >= 0 ? activeMonitorItems[idx] : null;
      if (!monMeta || !monMeta.name) {
        return;
      }
      const monName = monMeta.name;
      const detId = "monitor:" + monName;

      if (!ok || (data && (data.status === "fail" || data.status === "error" || data.status === "timeout"))) {
        const msg = (data && (data.message || data.detail)) || "Monitor failed";
        errorBuckets.monitors[idx] = [{
          key: `monitor_${idx}:${msg}`,
          detectorId: detId,
          statusType: "api_monitor",
          message: `Monitor (${monName}): ${msg}`
        }];
      } else {
        errorBuckets.monitors[idx] = [];
      }
    } else {
      if (!ok) {
        const detail = (data && typeof data === "object" && data.detail) ? data.detail : url;
        errorBuckets.api = [{
          key: "api_http:" + detail,
          detectorId: "api",
          statusType: "api_monitor",
          message: "API error: " + detail
        }];
      } else {
        errorBuckets.api = [];
      }
    }

    if (Object.keys(newDetectors).length > 0) {
      saveServerConfig({ register_detectors: newDetectors });
    }

    syncAlarmState();
  }

  function tickAlarm() {
    if (!config.enabled) return;

    if (latched) {
      if (Date.now() - lastPlayedAt >= REPEAT_INTERVAL_MS) {
        triggerAlarmNow();
      }
      return;
    }

    if (timerLatched && config.timer_notify && config.timer_repeat) {
      if (Date.now() - lastTimerPlayedAt >= TIMER_REPEAT_INTERVAL_MS) {
        triggerTimerChimeNow();
      }
    }
  }

  setInterval(tickAlarm, 500);

  function isApiUrl(url) {
    return url.includes("/api/");
  }

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
    try {
      const res = await origFetch.apply(this, args);
      if (isApiUrl(url)) {
        const cloned = res.clone();
        cloned.json()
          .then((d) => inspectData(url, res.ok, d))
          .catch(() => {
            if (!res.ok) inspectData(url, false, null);
          });
      }
      return res;
    } catch (err) {
      if (isApiUrl(url) && !isUnloading && err?.name !== "AbortError") {
        inspectData(url, false, { detail: "Network error" });
      }
      throw err;
    }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__daqUrl = typeof url === "string" ? url : String(url || "");
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("loadend", function() {
      try {
        if (!this.__daqUrl || !isApiUrl(this.__daqUrl) || isUnloading || this.status === 0) return;
        const ok = this.status >= 200 && this.status < 300;
        let data = null;
        try { data = JSON.parse(this.responseText); } catch (_) {}
        inspectData(this.__daqUrl, ok, data);
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };

  async function loadServerConfig() {
    try {
      const res = await origFetch("/api/alarm");
      if (res.ok) {
        config = await res.json();
        renderPanelFromServerHTML();
        syncAlarmState();
      }
    } catch (_) {}
  }

  async function saveServerConfig(patch) {
    if (patch.enabled !== undefined) config.enabled = Boolean(patch.enabled);
    if (patch.timer_notify !== undefined) config.timer_notify = Boolean(patch.timer_notify);
    if (patch.timer_repeat !== undefined) config.timer_repeat = Boolean(patch.timer_repeat);
    if (patch.statuses) Object.assign(config.statuses, patch.statuses);
    if (patch.detectors) Object.assign(config.detectors, patch.detectors);
    if (patch.register_detectors) {
      for (const [k, meta] of Object.entries(patch.register_detectors)) {
        const label = typeof meta === "object" ? meta.label : String(meta);
        const defEn = typeof meta === "object" ? Boolean(meta.default_enabled) : !/strasse/i.test(label);
        if (!Object.prototype.hasOwnProperty.call(config.detectors, k)) {
          config.detectors[k] = defEn;
        }
        config.detector_labels[k] = label;
      }
    }
    if (Array.isArray(patch.valid_monitor_ids)) {
      const validSet = new Set(patch.valid_monitor_ids);
      for (const k of Object.keys(config.detectors)) {
        if (k.startsWith("monitor:") && !validSet.has(k)) {
          delete config.detectors[k];
          delete config.detector_labels[k];
        }
      }
    }

    if (!config.timer_notify && timerLatched) {
      timerLatched = false;
      pendingTimerPlay = false;
    }

    if (latched) {
      const stillActive = latchedErrors.filter(
        (item) => isDetectorEnabled(item.detectorId) && isStatusEnabled(item.statusType)
      );
      if (stillActive.length === 0) {
        latched = false;
        pendingPlay = false;
      } else {
        latchedErrors = stillActive;
      }
    }

    syncAlarmState();

    try {
      const res = await origFetch("/api/alarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (res.ok) {
        config = await res.json();
        renderPanelFromServerHTML();
        updateAlarmUI();
      }
    } catch (_) {}
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderPanelFromServerHTML() {
    const view = document.getElementById("view-alarm");
    if (!view || !config.panel_html) return;

    view.innerHTML = config.panel_html;

    const masterToggle = view.querySelector("#alarm-master-toggle");
    if (masterToggle) {
      masterToggle.addEventListener("change", () => {
        const enabled = masterToggle.checked;
        saveServerConfig({ enabled });
        if (enabled && !latched) triggerAlarmNow(true);
      });
    }

    view.querySelector("#alarm-test-btn")?.addEventListener("click", () => {
      triggerAlarmNow(true);
    });

    view.querySelector("#alarm-stop-btn")?.addEventListener("click", () => {
      stopAlarm();
    });

    view.querySelector("#alarm-timer-test-btn")?.addEventListener("click", () => {
      triggerTimerChimeNow(true);
    });

    view.querySelector("#alarm-timer-dismiss-btn")?.addEventListener("click", () => {
      dismissTimerNotice();
    });

    view.querySelectorAll("input[data-alarm-timer]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const key = cb.getAttribute("data-alarm-timer");
        if (key === "notify") saveServerConfig({ timer_notify: cb.checked });
        else if (key === "repeat") saveServerConfig({ timer_repeat: cb.checked });
      });
    });

    view.querySelectorAll("input[data-alarm-detector]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const detId = cb.getAttribute("data-alarm-detector");
        saveServerConfig({ detectors: { [detId]: cb.checked } });
      });
    });

    view.querySelectorAll("input[data-alarm-status]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const stId = cb.getAttribute("data-alarm-status");
        saveServerConfig({ statuses: { [stId]: cb.checked } });
      });
    });

    view.querySelectorAll("button[data-alarm-bulk]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-alarm-bulk");
        if (mode === "det-all" || mode === "det-none") {
          const val = mode === "det-all";
          const patch = {};
          Object.keys(config.detector_labels || config.detectors).forEach((k) => { patch[k] = val; });
          saveServerConfig({ detectors: patch });
        } else if (mode === "st-all" || mode === "st-none") {
          const val = mode === "st-all";
          const patch = {};
          Object.keys(config.statuses).forEach((k) => { patch[k] = val; });
          saveServerConfig({ statuses: patch });
        }
      });
    });
  }

  function updateAlarmUI() {
    ensureAlarmStyles();
    const isOff = !config.enabled;
    const isBlocked = config.enabled && !audioUnlocked;

    if (floatingArmBadge) {
      const showArm = isBlocked && !latched && !timerLatched;
      floatingArmBadge.style.display = showArm ? "inline-block" : "none";
    }

    if (floatingStopBtn) {
      const nextDisplay = latched ? "inline-block" : "none";
      if (floatingStopBtn.style.display !== nextDisplay) {
        floatingStopBtn.style.display = nextDisplay;
      }
      const nextStopText = isBlocked ? "🔊 Click to Sound / Stop Alarm" : "🛑 Stop Alarm";
      if (floatingStopBtn.textContent !== nextStopText) {
        floatingStopBtn.textContent = nextStopText;
      }
    }

    if (floatingTimerBtn) {
      const nextDisplay = timerLatched ? "inline-block" : "none";
      if (floatingTimerBtn.style.display !== nextDisplay) {
        floatingTimerBtn.style.display = nextDisplay;
      }
      floatingTimerBtn.style.bottom = latched ? "58px" : "16px";
      const nextTimerText = isBlocked
        ? "🔊 Click to Chime / Dismiss Timer"
        : "⏱️ Timed Run Stopped (Dismiss)";
      if (floatingTimerBtn.textContent !== nextTimerText) {
        floatingTimerBtn.textContent = nextTimerText;
      }
    }

    const tabBtn = document.getElementById("tab-alarm");
    if (tabBtn) {
      const nextLabel = latched
        ? (isBlocked ? "Alarm (! 🔇)" : "Alarm (!)")
        : timerLatched
          ? "Alarm (⏱️)"
          : (isOff ? "Alarm (OFF)" : (isBlocked ? "Alarm (🔇)" : "Alarm"));
      if (tabBtn.textContent !== nextLabel) {
        tabBtn.textContent = nextLabel;
      }
      tabBtn.classList.toggle("alarm-tab-off", isOff && !latched);
      tabBtn.classList.toggle("alarm-tab-firing", Boolean(latched));
    }

    const view = document.getElementById("view-alarm");
    if (!view) return;

    const panelStopBtn = view.querySelector("#alarm-stop-btn");
    if (panelStopBtn && panelStopBtn.hidden !== !latched) {
      panelStopBtn.hidden = !latched;
    }

    const panelTimerDismissBtn = view.querySelector("#alarm-timer-dismiss-btn");
    if (panelTimerDismissBtn && panelTimerDismissBtn.hidden !== !timerLatched) {
      panelTimerDismissBtn.hidden = !timerLatched;
    }

    const notice = view.querySelector("#alarm-active-notice");
    if (notice) {
      const shouldHide = !latched || latchedErrors.length === 0;
      if (notice.hidden !== shouldHide) {
        notice.hidden = shouldHide;
      }
      if (!shouldHide) {
        const nextHtml = "<strong>Active Unacknowledged Alarm</strong>" +
          latchedErrors.map((e) => `<div>${escapeHtml(e.message)}</div>`).join("");
        if (notice.innerHTML !== nextHtml) {
          notice.innerHTML = nextHtml;
        }
      }
    }

    const timerNotice = view.querySelector("#alarm-timer-notice");
    if (timerNotice) {
      const shouldHideTimer = !timerLatched || !timerMessage;
      if (timerNotice.hidden !== shouldHideTimer) {
        timerNotice.hidden = shouldHideTimer;
      }
      if (!shouldHideTimer) {
        const nextHtml = `<strong>Run Timer Completed</strong><div>${escapeHtml(timerMessage)}</div>`;
        if (timerNotice.innerHTML !== nextHtml) {
          timerNotice.innerHTML = nextHtml;
        }
      }
    }
  }

  function ensureFloatingControls() {
    if (!document.getElementById("daq-alarm-arm-btn")) {
      const arm = document.createElement("button");
      arm.id = "daq-alarm-arm-btn";
      arm.type = "button";
      arm.className = "button small";
      arm.textContent = "🔇 Click anywhere to arm alarm";
      floatingArmBadge = arm;

      Object.assign(arm.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: "99998",
        display: "none", borderRadius: "999px", opacity: "0.9"
      });
      document.body.appendChild(arm);
    }

    if (!document.getElementById("daq-timer-dismiss-btn")) {
      const tbtn = document.createElement("button");
      tbtn.id = "daq-timer-dismiss-btn";
      tbtn.type = "button";
      tbtn.className = "button blue";
      tbtn.textContent = "⏱️ Timed Run Stopped (Dismiss)";
      floatingTimerBtn = tbtn;

      Object.assign(tbtn.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: "99999",
        display: "none", borderRadius: "999px", fontWeight: "bold",
        boxShadow: "0 4px 14px rgba(35, 94, 232, 0.45)"
      });
      tbtn.addEventListener("click", dismissTimerNotice);
      document.body.appendChild(tbtn);
    }

    if (!document.getElementById("daq-alarm-ack-btn")) {
      const btn = document.createElement("button");
      btn.id = "daq-alarm-ack-btn";
      btn.type = "button";
      btn.className = "button danger";
      btn.textContent = "🛑 Stop Alarm";
      floatingStopBtn = btn;

      Object.assign(btn.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: "100000",
        display: "none", borderRadius: "999px", fontWeight: "bold",
        boxShadow: "0 4px 14px rgba(220, 38, 38, 0.5)"
      });
      btn.addEventListener("click", stopAlarm);
      document.body.appendChild(btn);
    }
  }

  window.mountAlarm = function mountAlarm(context) {
    ensureAlarmStyles();
    ensureContext();
    ensureFloatingControls();

    syncExperimentConfig(context.config, true);

    const tabList = document.querySelector(".control-page .tabs");
    const footer = document.querySelector(".control-page .footer");
    if (tabList && footer && !document.getElementById("tab-alarm")) {
      tabList.insertAdjacentHTML(
        "beforeend",
        '<button class="tab" id="tab-alarm" role="tab" aria-selected="false" aria-controls="view-alarm">Alarm</button>'
      );
      footer.insertAdjacentHTML(
        "beforebegin",
        '<section class="utility-view section" id="view-alarm" role="tabpanel" aria-labelledby="tab-alarm" hidden></section>'
      );
      if (context.utilities?.ids && !context.utilities.ids.includes("alarm")) {
        context.utilities.ids.push("alarm");
      }
      renderPanelFromServerHTML();
      updateAlarmUI();
    }

    return {
      activate(isActive) {
        if (isActive) {
          renderPanelFromServerHTML();
          updateAlarmUI();
        }
      },
      destroy() {
        activeMonitorItems = [];
        errorBuckets.monitors = {};
        initializedTimerTracking = false;
        lastNotifiedTimerId = "";
        timerLatched = false;
      }
    };
  };

  loadServerConfig();
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () => {
      ensureAlarmStyles();
      ensureContext();
      ensureFloatingControls();
      updateAlarmUI();
    });
  } else {
    ensureAlarmStyles();
    ensureContext();
    ensureFloatingControls();
    updateAlarmUI();
  }
})();
