// ==UserScript==
// @name         FMV Sticker Collect - Auto Advance
// @namespace    fmv
// @version      0.1.0
// @description  Auto-collect sticker rewards and auto-decline raffle proposals in the Devvit webview.
// @match        https://*.devvit.net/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  function main() {
    "use strict";

  const alreadyInjected = !!window.__fmvAutoAdvanceInjected;
  window.__fmvAutoAdvanceInjected = true;
  window.__fmvAutoAdvanceVersion = "2026-01-31";

  /***************************************************************************
   * config
   *
   * Keep this minimal and explicit so you can tweak behavior without touching
   * the logic below.
   ***************************************************************************/
  const CONFIG = {
    // Auto-click the green "Collect" button after the reveal completes.
    autoCollect: false,
    autoCollectDelayMs: 600,

    // Optional: auto-skip the pack opening animation ("Press to skip").
    autoSkip: false,
    autoSkipDelayMs: 500,

    // Always decline raffle proposal if it appears after Collect.
    autoDeclineRaffle: false,
    autoDeclineDelayMs: 600,

    // Safety: keep scanning until patches land, then stop.
    scanIntervalMs: 1500,

    // Input fallback: simulate clicks at known button locations.
    // This is used when patching doesn't work or the runtime is isolated.
    inputFallbackEnabled: false,
    inputRequireUserGestureMs: 12000,
    inputMinIntervalMs: 1200,
    inputPostCollectDeclineDelayMs: 3027,
    inputTargets: {
      // Relative positions (0..1) within the canvas.
      collect: { x: 0.497, y: 0.9193 },
      notNow: { x: 0.5092, y: 0.7949 },
      skip: { x: 0.9216, y: 0.1227 },
    },

    // Capture logger: record click positions to refine targets.
    captureEnabled: false,
    capturePattern: ["collect", "not-now", "skip"],
    captureMinIntervalMs: 120,
    captureMaxEntries: 5000,
    captureLogEach: false,

    // Collect burst: run N collect clicks after one user click.
    collectBurstEnabled: true,
    collectBurstCount: 10,
    collectBurstDelayMs: 200,
    collectBurstIntervalMs: 10700,
  };

  const DEBUG = {
    scan: false,
    methods: true,
    hooks: true,
    timers: true,
    resolve: true,
    frames: false,
    input: true,
    capture: true,
  };

  /***************************************************************************
   * internal state + logging
   ***************************************************************************/
  const STATE = {
    patchedCollect: false,
    patchedSkip: false,
    patchedRaffle: false,
    scanTimer: null,
    intervalId: null,
    runtimeTimer: null,
    lastRuntimeLogAt: 0,
    lastHref: "",
    lastUserPointerAt: 0,
    lastAutoClickAt: 0,
    lastAutoCollectAt: 0,
    lastAutoDeclineAt: 0,
    lastAutoSkipAt: 0,
    burstRunning: false,
    burstRemaining: 0,
    burstTimers: [],
    lastCanvasRect: null,
    lastCanvasAt: 0,
  };

  const TAG = "[FMV AutoAdvance]";
  const log = (...args) => console.log(TAG, ...args);
  const debugLog = (flag, ...args) => {
    if (!DEBUG[flag]) return;
    console.log(TAG, ...args);
  };

  function findCanvasDeep() {
    // Devvit often nests the canvas in shadow roots; crawl to avoid brittle selectors.
    const seen = new Set();
    const walk = (root) => {
      if (!root || seen.has(root)) return null;
      seen.add(root);
      if (root.querySelectorAll) {
        const canvases = root.querySelectorAll("canvas");
        if (canvases.length) return canvases[0];
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const c = walk(el.shadowRoot);
            if (c) return c;
          }
        }
      }
      return null;
    };
    return walk(document);
  }

  function probeCanvasContext() {
    const canvas = document.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect?.();
    return {
      href: location.href,
      ready: document.readyState,
      canvases: document.querySelectorAll("canvas").length,
      canvasClass: canvas?.className || null,
      canvasRect: rect
        ? {
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
          }
        : null,
    };
  }

  /***************************************************************************
   * capture logger
   *
   * Records click positions and timings so we can compute reliable averages
   * for Collect / Not Now / Skip buttons across many runs.
   ***************************************************************************/
  function installCaptureLogger() {
    if (!CONFIG.captureEnabled) return;
    if (window.__fmvCaptureInstalled) return;
    window.__fmvCaptureInstalled = true;

    const captureState = {
      enabled: !!CONFIG.captureEnabled,
      pattern: Array.isArray(CONFIG.capturePattern)
        ? CONFIG.capturePattern.slice()
        : ["collect", "not-now", "skip"],
      index: 0,
      lastAt: 0,
      entries: [],
    };

    function nextLabel() {
      if (!captureState.pattern.length) return "click";
      return captureState.pattern[captureState.index % captureState.pattern.length];
    }

    function recordPointer(e) {
      if (!captureState.enabled) return;

      const now = Date.now();
      if (now - captureState.lastAt < CONFIG.captureMinIntervalMs) return;

      const canvas = findCanvasDeep();
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const relX = Math.round(e.clientX - rect.left);
      const relY = Math.round(e.clientY - rect.top);
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const px = w ? Number((relX / w).toFixed(4)) : 0;
      const py = h ? Number((relY / h).toFixed(4)) : 0;

      const entry = {
        label: nextLabel(),
        relX,
        relY,
        w,
        h,
        px,
        py,
        at: now,
        deltaMs: captureState.lastAt ? now - captureState.lastAt : null,
        canvasClass: canvas.className || "",
      };

      captureState.lastAt = now;
      captureState.index += 1;
      captureState.entries.push(entry);

      if (captureState.entries.length > CONFIG.captureMaxEntries) {
        captureState.entries.shift();
      }

      if (CONFIG.captureLogEach) {
        debugLog("capture", "capture entry", entry);
      }
    }

    document.addEventListener("pointerdown", recordPointer, true);

    window.__fmvCapture = {
      start: () => {
        captureState.enabled = true;
        debugLog("capture", "capture started");
      },
      stop: () => {
        captureState.enabled = false;
        debugLog("capture", "capture stopped");
      },
      reset: () => {
        captureState.entries = [];
        captureState.index = 0;
        captureState.lastAt = 0;
        debugLog("capture", "capture reset");
      },
      setPattern: (pattern) => {
        if (!Array.isArray(pattern) || !pattern.length) return;
        captureState.pattern = pattern.slice();
        captureState.index = 0;
        debugLog("capture", "capture pattern updated", pattern);
      },
      dump: () => captureState.entries.slice(),
      summary: () => summarizeCapture(captureState.entries),
      print: () => {
        const summary = summarizeCapture(captureState.entries);
        console.log(TAG, "capture summary", formatCaptureSummary(summary));
        return summary;
      },
    };

    debugLog("capture", "capture logger installed");
  }

  function summarizeCapture(entries) {
    const byLabel = {};

    for (const entry of entries) {
      const label = entry.label || "click";
      if (!byLabel[label]) {
        byLabel[label] = {
          count: 0,
          sumRelX: 0,
          sumRelY: 0,
          sumPx: 0,
          sumPy: 0,
          sumW: 0,
          sumH: 0,
          sumDeltaMs: 0,
          deltaCount: 0,
        };
      }

      const bucket = byLabel[label];
      bucket.count += 1;
      bucket.sumRelX += entry.relX;
      bucket.sumRelY += entry.relY;
      bucket.sumPx += entry.px;
      bucket.sumPy += entry.py;
      bucket.sumW += entry.w;
      bucket.sumH += entry.h;
      if (entry.deltaMs != null) {
        bucket.sumDeltaMs += entry.deltaMs;
        bucket.deltaCount += 1;
      }
    }

    const summary = {};
    for (const label of Object.keys(byLabel)) {
      const b = byLabel[label];
      summary[label] = {
        count: b.count,
        avgRelX: Math.round(b.sumRelX / b.count),
        avgRelY: Math.round(b.sumRelY / b.count),
        avgPx: Number((b.sumPx / b.count).toFixed(4)),
        avgPy: Number((b.sumPy / b.count).toFixed(4)),
        avgW: Math.round(b.sumW / b.count),
        avgH: Math.round(b.sumH / b.count),
        avgDeltaMs:
          b.deltaCount > 0 ? Math.round(b.sumDeltaMs / b.deltaCount) : null,
      };
    }

    return summary;
  }

  function formatCaptureSummary(summary) {
    const lines = [];
    for (const label of Object.keys(summary)) {
      const s = summary[label];
      lines.push(
        `${label}: n=${s.count} avgPx=${s.avgPx} avgPy=${s.avgPy} ` +
          `avgRel=(${s.avgRelX},${s.avgRelY}) avgCanvas=(${s.avgW}x${s.avgH}) ` +
          `avgDeltaMs=${s.avgDeltaMs}`,
      );
    }
    return lines.join("\n");
  }

  /***************************************************************************
   * input fallback
   *
   * When we can't patch game internals, simulate clicks at known positions.
   * This is guarded by recent user interaction to avoid random clicking.
   ***************************************************************************/
  function installInputFallback() {
    if (!CONFIG.inputFallbackEnabled) return;
    if (window.__fmvInputFallbackInstalled) return;
    window.__fmvInputFallbackInstalled = true;

    // Require a recent user gesture before any automated clicks.
    window.addEventListener("pointerdown", () => {
      STATE.lastUserPointerAt = Date.now();
      updateLastCanvasRect();
      if (CONFIG.collectBurstEnabled) {
        startCollectBurst("user-pointer");
        return;
      }
      maybeScheduleInputActions("user-pointer");
    }, true);

    // Manual trigger helpers for debugging.
    window.__fmvAutoClick = {
      collect: () => scheduleInputClick("collect", 0, "manual"),
      skip: () => scheduleInputClick("skip", 0, "manual"),
      notNow: () => scheduleInputClick("notNow", 0, "manual"),
    };
  }

  function getCanvasRect() {
    const canvas = findCanvasDeep();
    if (!canvas) {
      if (STATE.lastCanvasRect && Date.now() - STATE.lastCanvasAt < 15000) {
        return STATE.lastCanvasRect;
      }
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const snap = { canvas, rect };
    STATE.lastCanvasRect = snap;
    STATE.lastCanvasAt = Date.now();
    return snap;
  }

  function updateLastCanvasRect() {
    const canvas = findCanvasDeep();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    STATE.lastCanvasRect = { canvas, rect };
    STATE.lastCanvasAt = Date.now();
  }

  function dispatchPointerClick(canvas, clientX, clientY) {
    const common = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
      pressure: 0.5,
      view: window,
    };

    const targets = [canvas, document, window].filter(Boolean);
    for (const target of targets) {
      try {
        target.dispatchEvent(new PointerEvent("pointerdown", common));
        target.dispatchEvent(new PointerEvent("pointerup", common));
      } catch (err) {
        // PointerEvent might not exist; fall back to mouse events.
      }

      target.dispatchEvent(new MouseEvent("mousedown", common));
      target.dispatchEvent(new MouseEvent("mouseup", common));
      target.dispatchEvent(new MouseEvent("click", common));
    }
  }

  function scheduleInputClick(action, delayMs, reason, attempt = 0) {
    if (!CONFIG.inputFallbackEnabled) return;
    const now = Date.now();
    if (now - STATE.lastAutoClickAt < CONFIG.inputMinIntervalMs) return;

    const target = CONFIG.inputTargets[action];
    if (!target) return;

    debugLog("input", "input click scheduled", { action, delayMs, reason });
    setTimeout(() => {
      const snap = getCanvasRect();
      if (!snap) {
        debugLog("input", "input click aborted (no canvas)", {
          action,
          reason,
          probe: probeCanvasContext(),
        });
        if (attempt < 6) {
          scheduleInputClick(action, 200, `${reason || "cycle"}-retry`, attempt + 1);
        }
        return;
      }
      const { canvas, rect } = snap;

      const clientX = rect.left + rect.width * target.x;
      const clientY = rect.top + rect.height * target.y;

      STATE.lastAutoClickAt = Date.now();
      if (action === "collect") STATE.lastAutoCollectAt = STATE.lastAutoClickAt;
      if (action === "notNow") STATE.lastAutoDeclineAt = STATE.lastAutoClickAt;
      if (action === "skip") STATE.lastAutoSkipAt = STATE.lastAutoClickAt;

      debugLog("input", "input click firing", {
        action,
        x: Math.round(clientX),
        y: Math.round(clientY),
      });

      dispatchPointerClick(canvas, clientX, clientY);

      // Optionally chain a decline click after collect.
      if (
        action === "collect" &&
        CONFIG.autoDeclineRaffle &&
        CONFIG.inputFallbackEnabled &&
        !STATE.cycleRunning &&
        !STATE.cycleArmed
      ) {
        scheduleInputClick("notNow", CONFIG.inputPostCollectDeclineDelayMs, "post-collect");
      }
    }, delayMs);
  }

  function maybeScheduleInputActions(reason) {
    if (!CONFIG.inputFallbackEnabled) return;
    if (STATE.burstRunning) return;

    const now = Date.now();
    if (now - STATE.lastUserPointerAt > CONFIG.inputRequireUserGestureMs) return;

    if (CONFIG.autoSkip) {
      scheduleInputClick("skip", CONFIG.autoSkipDelayMs, reason || "auto-skip");
    }

    if (CONFIG.autoCollect) {
      scheduleInputClick("collect", CONFIG.autoCollectDelayMs, reason || "auto-collect");
    }
  }

  /***************************************************************************
   * collect burst
   ***************************************************************************/
  function clearBurstTimers() {
    for (const t of STATE.burstTimers) {
      clearTimeout(t);
    }
    STATE.burstTimers = [];
  }

  function startCollectBurst(reason) {
    if (!CONFIG.collectBurstEnabled) return;
    if (STATE.burstRunning) return;
    STATE.burstRunning = true;
    STATE.burstRemaining = CONFIG.collectBurstCount;
    debugLog("input", "collect burst started", { remaining: STATE.burstRemaining, reason });

    const runOne = () => {
      if (!STATE.burstRunning) return;
      if (STATE.burstRemaining <= 0) {
        stopCollectBurst("complete");
        return;
      }

      scheduleBurstClick("collect", CONFIG.collectBurstDelayMs, "burst");
      STATE.burstRemaining -= 1;

      const nextTimer = setTimeout(runOne, CONFIG.collectBurstIntervalMs);
      STATE.burstTimers.push(nextTimer);
    };

    runOne();
  }

  function scheduleBurstClick(action, delayMs, reason) {
    const timer = setTimeout(() => {
      scheduleInputClick(action, 0, reason);
    }, delayMs);
    STATE.burstTimers.push(timer);
  }

  function stopCollectBurst(reason) {
    if (!STATE.burstRunning) return;
    STATE.burstRunning = false;
    clearBurstTimers();
    log("collect burst stopped", { reason });
  }

  function installCycleControls() {
    if (window.__fmvCycleControlsInstalled) return;
    window.__fmvCycleControlsInstalled = true;

    window.__fmvBurst = {
      start: () => startCollectBurst("manual"),
      stop: () => stopCollectBurst("manual"),
      state: () => ({
        running: STATE.burstRunning,
        remaining: STATE.burstRemaining,
      }),
    };
  }

  /***************************************************************************
   * webpack hook
   *
   * The game bundles are webpacked under window.webpackChunkfarm_merge_game.
   * We capture the webpack require function so we can inspect loaded exports
   * and patch the right class prototypes.
   ***************************************************************************/
  const CHUNK_NAME = "webpackChunkfarm_merge_game";

  function waitForWebpack() {
    debugLog("scan", "script loaded", location.href);
    if (!location.hostname.endsWith("devvit.net")) {
      debugLog("scan", "non-devvit host, exiting");
      return;
    }
    if (isLauncherPage()) {
      startLauncherBridge();
    }
    startRuntimeWatcher();
    waitForGameRuntime();
  }

  function startRuntimeWatcher() {
    if (STATE.runtimeTimer) return;
    STATE.lastHref = location.href;
    STATE.runtimeTimer = setInterval(() => {
      if (STATE.lastHref !== location.href) {
        STATE.lastHref = location.href;
        debugLog("scan", "location change", STATE.lastHref);
        waitForGameRuntime(true);
      } else {
        waitForGameRuntime(false);
      }
    }, 500);
  }

  function isGameRuntimeReady() {
    return (
      typeof window[CHUNK_NAME] !== "undefined" ||
      typeof window.__fmvWebpackRequire !== "undefined"
    );
  }

  function waitForGameRuntime(forceLog = false) {
    if (!isGameRuntimeReady()) {
      const now = Date.now();
      if (forceLog || now - STATE.lastRuntimeLogAt > 3000) {
        STATE.lastRuntimeLogAt = now;
        debugLog("scan", "waiting for game runtime...");
      }
      return;
    }

    debugLog("scan", "game runtime detected");

    const chunk = window[CHUNK_NAME];
    if (chunk) {
      hookChunkPush(chunk);
      captureWebpackRequire(chunk);
    }

    startScanLoop();
  }

  function hookChunkPush(chunk) {
    if (chunk.__fmvHooked) return;
    const originalPush = chunk.push.bind(chunk);
    chunk.push = function (...args) {
      const result = originalPush(...args);
      debugLog("scan", "chunk push");
      scheduleScan("chunk-push");
      return result;
    };
    chunk.__fmvHooked = true;
  }

  function captureWebpackRequire(chunk) {
    if (window.__fmvWebpackRequire) return;
    try {
      chunk.push([
        ["fmv_capture"],
        {},
        (req) => {
          window.__fmvWebpackRequire = req;
          debugLog("scan", "webpack require captured");
        },
      ]);
    } catch (err) {
      // If this fails early, the scan loop will retry on later chunk pushes.
    }
  }

  /***************************************************************************
   * scan + patch
   ***************************************************************************/
  function scheduleScan(reason) {
    if (STATE.scanTimer) return;
    STATE.scanTimer = setTimeout(() => {
      STATE.scanTimer = null;
      scanForTargets(reason);
    }, 200);
  }

  function startScanLoop() {
    scheduleScan("startup");
    if (STATE.intervalId) return;
    STATE.intervalId = setInterval(() => {
      scanForTargets("interval");
      if (allPatchesApplied()) {
        clearInterval(STATE.intervalId);
        STATE.intervalId = null;
      }
    }, CONFIG.scanIntervalMs);
  }

  function allPatchesApplied() {
    return (
      (!CONFIG.autoCollect || STATE.patchedCollect) &&
      (!CONFIG.autoSkip || STATE.patchedSkip) &&
      (!CONFIG.autoDeclineRaffle || STATE.patchedRaffle)
    );
  }

  function scanForTargets(reason) {
    const req = window.__fmvWebpackRequire;
    if (!req || !req.c) return;

    if (DEBUG.scan) {
      const moduleCount = Object.keys(req.c).length;
      debugLog("scan", "scanForTargets", { reason, moduleCount });
    }

    const visited = new WeakSet();
    for (const id in req.c) {
      const mod = req.c[id];
      if (!mod || !mod.exports) continue;
      walkExports(mod.exports, visited, patchConstructorIfMatch);
    }

    if (allPatchesApplied()) {
      log("patches applied", { reason });
    }
  }

  function walkExports(value, visited, visitor) {
    if (!value) return;
    if (typeof value === "function") {
      visitor(value);
      return;
    }
    if (typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walkExports(item, visited, visitor);
      return;
    }

    for (const key of Object.keys(value)) {
      walkExports(value[key], visited, visitor);
    }
  }

  function patchConstructorIfMatch(ctor) {
    if (typeof ctor !== "function" || !ctor.prototype) return;

    for (const key of Object.getOwnPropertyNames(ctor.prototype)) {
      const fn = ctor.prototype[key];
      if (typeof fn !== "function") continue;
      const src = Function.prototype.toString.call(fn);

      if (DEBUG.methods && (key.includes("Raffl") || src.includes("Raffl"))) {
        debugLog("methods", "raffl-like method seen", {
          key,
          src: src.slice(0, 220),
        });
      }

      if (DEBUG.methods && key === "_close") {
        debugLog("methods", "_close method seen", {
          key,
          src: src.slice(0, 220),
        });
      }

      // Auto-Collect: _showButton includes BUTTON_COLLECT and calls _animationResolve.
      if (
        CONFIG.autoCollect &&
        !STATE.patchedCollect &&
        key.includes("_show") &&
        src.includes("BUTTON_COLLECT") &&
        src.includes("_animationResolve")
      ) {
        wrapAutoCollect(ctor.prototype, key, fn);
        STATE.patchedCollect = true;
        log("patched auto-collect", { method: key });
      }

      // Auto-Skip: create skip button includes BUTTON_SKIP.
      if (
        CONFIG.autoSkip &&
        !STATE.patchedSkip &&
        src.includes("BUTTON_SKIP")
      ) {
        wrapAutoSkip(ctor.prototype, key, fn);
        STATE.patchedSkip = true;
        log("patched auto-skip", { method: key });
      }

      // Auto-Decline raffle proposal: method name contains "Raffl" and
      // sets _animationResolve before showing proposal UI.
      if (
        CONFIG.autoDeclineRaffle &&
        !STATE.patchedRaffle &&
        key.includes("Raffl") &&
        src.includes("_animationResolve")
      ) {
        wrapAutoDeclineRaffle(ctor.prototype, key, fn);
        STATE.patchedRaffle = true;
        log("patched auto-decline raffle", { method: key });
      }
    }
  }

  /***************************************************************************
   * patch wrappers
   ***************************************************************************/
  function wrapAutoCollect(proto, key, original) {
    if (original.__fmvAutoCollectWrapped) return;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      const self = this;

      wrapResolveOnce(self, "__fmvAutoCollectDone");

      if (!self.__fmvAutoCollectTimer) {
        debugLog("timers", "auto-collect scheduled", {
          delayMs: CONFIG.autoCollectDelayMs,
        });
        self.__fmvAutoCollectTimer = setTimeout(() => {
          debugLog("timers", "auto-collect firing");
          if (self.__fmvAutoCollectDone) return;
          self.__fmvAutoCollectDone = true;
          try {
            if (typeof self._animationResolve === "function") {
              debugLog("resolve", "auto-collect calling _animationResolve");
              self._animationResolve();
            }
          } catch (err) {
            // No-op: avoid breaking the game loop on failures.
          }
        }, CONFIG.autoCollectDelayMs);
      }

      return result;
    };

    wrapped.__fmvAutoCollectWrapped = true;
    proto[key] = wrapped;
  }

  function wrapAutoSkip(proto, key, original) {
    if (original.__fmvAutoSkipWrapped) return;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      const self = this;

      if (!self.__fmvAutoSkipTimer) {
        debugLog("timers", "auto-skip scheduled", {
          delayMs: CONFIG.autoSkipDelayMs,
        });
        self.__fmvAutoSkipTimer = setTimeout(() => {
          debugLog("timers", "auto-skip firing");
          if (self.__fmvAutoSkipDone) return;
          self.__fmvAutoSkipDone = true;
          try {
            if (typeof self._onSkippedPressed === "function") {
              debugLog("resolve", "auto-skip calling _onSkippedPressed");
              self._onSkippedPressed();
              return;
            }
            if (typeof self._animationResolve === "function") {
              debugLog("resolve", "auto-skip calling _animationResolve");
              self._animationResolve();
            }
          } catch (err) {
            // No-op.
          }
        }, CONFIG.autoSkipDelayMs);
      }

      return result;
    };

    wrapped.__fmvAutoSkipWrapped = true;
    proto[key] = wrapped;
  }

  function wrapAutoDeclineRaffle(proto, key, original) {
    if (original.__fmvAutoDeclineWrapped) return;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      const self = this;

      wrapResolveOnce(self, "__fmvAutoDeclineDone");

      if (!self.__fmvAutoDeclineTimer) {
        debugLog("timers", "auto-decline scheduled", {
          delayMs: CONFIG.autoDeclineDelayMs,
        });
        self.__fmvAutoDeclineTimer = setTimeout(() => {
          debugLog("timers", "auto-decline firing");
          if (self.__fmvAutoDeclineDone) return;
          self.__fmvAutoDeclineDone = true;
          try {
            if (typeof self._close === "function") {
              debugLog("resolve", "auto-decline calling _close(false)");
              self._close(false);
              return;
            }
            if (typeof self._animationResolve === "function") {
              debugLog("resolve", "auto-decline calling _animationResolve(false)");
              self._animationResolve(false);
            }
          } catch (err) {
            // No-op.
          }
        }, CONFIG.autoDeclineDelayMs);
      }

      return result;
    };

    wrapped.__fmvAutoDeclineWrapped = true;
    proto[key] = wrapped;
  }

  function wrapResolveOnce(self, doneFlagName) {
    if (!self || typeof self._animationResolve !== "function") return;
    if (self._animationResolve.__fmvWrapped) return;

    const original = self._animationResolve;
    const wrapped = function (...args) {
      debugLog("resolve", "_animationResolve called", { args });
      self[doneFlagName] = true;
      return original.apply(this, args);
    };

    wrapped.__fmvWrapped = true;
    self._animationResolve = wrapped;
  }

  /***************************************************************************
   * launcher bridge
   ***************************************************************************/
  function isLauncherPage() {
    return location.pathname.includes("/launcher/");
  }

  function startLauncherBridge() {
    if (window.__fmvAutoAdvanceLauncher) return;
    window.__fmvAutoAdvanceLauncher = true;

    debugLog("frames", "launcher bridge enabled");

    const seen = new WeakSet();
    setInterval(() => {
      const frames = collectIframes();
      if (!frames.length) return;

      frames.forEach((frame) => {
        if (seen.has(frame)) return;
        seen.add(frame);

        let childWin = null;
        try {
          childWin = frame.contentWindow;
        } catch (err) {
          debugLog("frames", "iframe access blocked", err);
          return;
        }
        if (!childWin) return;

        let href = "";
        try {
          href = childWin.location?.href || frame.src || "";
        } catch (err) {
          href = frame.src || "";
        }

        debugLog("frames", "iframe discovered", { href });

        if (childWin.__fmvAutoAdvanceInjected) {
          return;
        }

        try {
          childWin.eval(`(${main.toString()})();`);
          childWin.__fmvAutoAdvanceInjected = true;
          debugLog("frames", "injected into iframe", { href });
        } catch (err) {
          debugLog("frames", "iframe eval failed, trying script tag", err);
          try {
            const doc = frame.contentDocument;
            if (!doc) return;
            const script = doc.createElement("script");
            script.textContent = `(${main.toString()})();`;
            doc.documentElement.appendChild(script);
            childWin.__fmvAutoAdvanceInjected = true;
            debugLog("frames", "injected via script tag", { href });
          } catch (err2) {
            debugLog("frames", "iframe injection failed", err2);
          }
        }
      });
    }, 1000);
  }

  function collectIframes() {
    const frames = [];
    const roots = [document];
    const seenRoots = new Set();

    while (roots.length) {
      const root = roots.pop();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);

      try {
        const found = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
        found.forEach((frame) => frames.push(frame));
      } catch (err) {
        debugLog("frames", "iframe query failed", err);
      }

      // Walk elements to discover nested shadow roots.
      try {
        const walker = document.createTreeWalker(
          root instanceof ShadowRoot ? root : root,
          NodeFilter.SHOW_ELEMENT,
        );
        let node = walker.currentNode;
        while (node) {
          if (node.shadowRoot && !seenRoots.has(node.shadowRoot)) {
            roots.push(node.shadowRoot);
          }
          node = walker.nextNode();
        }
      } catch (err) {
        debugLog("frames", "shadow walk failed", err);
      }
    }

    if (DEBUG.frames) {
      debugLog("frames", "iframe scan", { count: frames.length });
    }

    return frames;
  }

  /***************************************************************************
   * boot
   ***************************************************************************/
  installCaptureLogger();
  installInputFallback();
  installCycleControls();
  window.__fmvCanvasProbe = probeCanvasContext;

  if (!alreadyInjected) {
    waitForWebpack();
  }
  }

  main();
})();
