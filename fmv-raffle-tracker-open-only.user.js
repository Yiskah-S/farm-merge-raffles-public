// ==UserScript==
// @name         FMV Raffle Tracker (Open Only)
// @namespace    fmv
// @version      0.1.0
// @description  Ingest raffle feed, normalize storage, and open raffles in batches
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://new.reddit.com/*
// @match        https://sh.reddit.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      www.reddit.com
// @connect      reddit.com
// @connect      playfmv-94o1jc-0-3-26-webview.devvit.net
// @connect      playfmv-94o1jc-0-3-27-webview.devvit.net
// @connect      playfmv-94o1jc-0-3-29-webview.devvit.net
// @connect      *.devvit.net
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==


(() => {
  "use strict";


  /**
 * FMV Raffle Tracker — single-file userscript
 *
 * This script prioritizes:
 * - crash safety over elegance
 * - explicit policy over implicit behavior
 * - storage correctness over UI convenience
 *
 * All persistent state flows through raffleStore.
 * All automation is gated by POLICY and user toggles.
 *
 * This file is intentionally monolithic for iteration speed;
 * sections are organized so it can be split later if needed.
 */


  /***************************************************************************
   * constants.js
   *
   * Central place for URLs, storage keys, and timing knobs. Keeping these
   * together makes the rest of the file easier to scan and change.
   ***************************************************************************/

  const FEED_URL =
    "https://www.reddit.com/r/FarmMergeValley/?f=flair_name%3A%22%F0%9F%8E%81%20Raffles%2FGiveaways%22";
  const META_KEY = "fmvTracker:meta";
  const STICKER_MAP_KEY = "fmvTracker:stickerMap";
  const RAFFLE_INDEX_KEY = "fmvTracker:raffleIndex";
  const RAFFLE_DAYS_KEY = "fmvTracker:raffleDays";
  const RAFFLE_BUCKET_PREFIX = "fmvTracker:raffles:";
  const FEED_LAST_RUN_KEY = "fmvTracker:lastFeedRunAt";
  const PIGGYBANK_KEY = "fmvTracker:piggybank";
  const DEBUG_LOG_DAYS_KEY = "fmvTracker:debugLogDays";
  const DEBUG_LOG_BUCKET_PREFIX = "fmvTracker:debugLog:";
  const SETTINGS_KEY = "fmvTracker:settings";
  const SCHEMA_VERSION = 2;
  const REQUEST_DELAY_MS = 5000;
  const FEED_PAGE_DELAY_MS = 400;
  const MAX_FEED_PAGES = 15;
  const DEFAULT_ORIGIN = "https://playfmv-94o1jc-0-3-27-webview.devvit.net";
  const RAFFLE_DATA_PATH = "/api/posts/getRaffleData";
  const CLAIM_RAFFLE_PATH = "/api/posts/claimRaffle";
  const STICKERBOOK_PATH = "/raffle/stickers.json";

  /***************************************************************************
   * USER CONFIG (fill locally; do not commit personal values)
   ***************************************************************************/
  const CURRENT_USER_ID = "";
  const CURRENT_USER_NAME = "";
  const SHEETS_WEBHOOK_URL = "";
  const SHEETS_WEBHOOK_SECRET = "";
  const USER_EXCLUDED_WINNER_NAMES = [CURRENT_USER_NAME].filter(Boolean);

  /***************************************************************************
   * policy.js
   *
   * Centralized policy + behavior knobs. This makes it explicit what the
   * system is allowed to do automatically so future edits do not quietly
   * change behavior.
   *
   * IMPORTANT: Storage writes are immediate. Do not reintroduce batching
   * unless you deliberately update this policy and annotate the change.
   ***************************************************************************/

  const POLICY = {
    storageWriteMode: "immediate",
    autoClaimRequires: {
      winnerIsCurrentUser: true,
      unrevealedTrue: true,
    },
    nonParticipantClaimRequires: {
      winnerMissing: true,
      unrevealedFalse: true,
      currentUserNotParticipant: true,
    },
  };
  const LOG_TIMEZONE = "America/New_York";
  // Optional: set to your script endpoint and shared secret for Sheets sync.
  const SHEETS_TIMEZONE = LOG_TIMEZONE;
  const SHEETS_BATCH_SIZE = 100;
  const SHEETS_BATCH_DELAY_MS = 500;
  const SHEETS_AUTO_SYNC = true;
  const SHEETS_AUTO_FLUSH_MIN_ROWS = 100;
  const DEFAULT_EXCLUDED_WINNER_NAMES = ["alexeye", "Independent_Sand_295"];
  const SHEETS_EXCLUDED_WINNER_NAMES = [
    ...DEFAULT_EXCLUDED_WINNER_NAMES,
    ...USER_EXCLUDED_WINNER_NAMES,
  ].filter(Boolean);

  /***************************************************************************
   * debug.js
   *
   * Toggle these flags during development. Each scope maps to a small slice
   * of the script so you can get loud logs without drowning in noise.
   ***************************************************************************/

  const DEBUG = {
    boss: false, // Boss tab selection + bootstrapping logs
    discovery: false, // Feed parsing, pagination, and loader counts
    storage: false, // Storage writes, exports, and cleanup helpers
    ui: false, // Panel rendering + UI interactions
    actions: false, // Joins, claims, settlements, and batch actions
    timers: false, // Scheduler ticks and interval gating
    warnings: true, // warnLog output
    network: false, // HTTP call tracing + GM_xmlhttpRequest details
    calls: false, // Every GM_xmlhttpRequest call
    writes: false, // Every storage write
  };

  function loadSettings() {
    return loadJsonKey(SETTINGS_KEY) || {};
  }

  function saveSettings(settings) {
    saveJsonKey(SETTINGS_KEY, settings || {});
  }

  /***************************************************************************
   * export_history.js
   *
   * Track exported storage snapshots so we can quickly locate the last
   * backup file. This is stored in settings and shown in the Debug tab.
   ***************************************************************************/

  const EXPORT_HISTORY_MAX = 52;

  function loadExportHistory() {
    const settings = loadSettings();
    const history = settings?.exportHistory;
    return Array.isArray(history) ? history : [];
  }

  function recordExportHistory(filename, contextLabel) {
    if (!filename) return;
    const settings = loadSettings();
    const history = Array.isArray(settings.exportHistory) ? settings.exportHistory : [];
    const stamp = nowSec();
    history.unshift({
      filename,
      timestamp: stamp,
      timestampHuman: formatLogTimestamp(stamp),
      context: contextLabel || "",
    });
    settings.exportHistory = history.slice(0, EXPORT_HISTORY_MAX);
    saveSettings(settings);
  }

  function formatLogTimestamp(sec) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: LOG_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZoneName: "short",
      });
      const parts = formatter.formatToParts(new Date(sec * 1000));
      const get = (type) => parts.find((part) => part.type === type)?.value || "";
      return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
        "minute",
      )}:${get("second")} ${get("timeZoneName")}`.trim();
    } catch {
      return String(sec);
    }
  }

  function debugLog(scope, ...args) {
    if (!DEBUG[scope]) return;
    const stamp = formatLogTimestamp(nowSec());
    console.log(`[FMV:${scope}]`, stamp, ...args);
  }

  function warnLog(...args) {
    if (!DEBUG.warnings) return;
    const stamp = formatLogTimestamp(nowSec());
    console.warn("[FMV:warn]", stamp, ...args);
  }

  function errorLog(...args) {
    const stamp = formatLogTimestamp(nowSec());
    console.error("[FMV:error]", stamp, ...args);
  }

  /***************************************************************************
   * storage.js
   *
   * Tampermonkey persists strings only. These helpers define the storage
   * boundary: everything past this point should treat objects as real JS.
   ***************************************************************************/

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function parseDayKeyToEpoch(dayKey) {
    if (!dayKey || typeof dayKey !== "string") return null;
    const match = dayKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    const date = new Date(year, month - 1, day, 0, 0, 0);
    const sec = Math.floor(date.getTime() / 1000);
    return Number.isFinite(sec) ? sec : null;
  }

  function loadJsonKey(key, options = {}) {
    const raw = GM_getValue(key);
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") {
      if (options.allowPrimitive) return raw;
      warnLog("Non-string value in storage", key, typeof raw);
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (options.allowPrimitive) return parsed;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveJsonKey(key, value) {
    debugLog("writes", "saveJsonKey", key);
    GM_setValue(key, JSON.stringify(value));
  }

  /***************************************************************************
   * store_init.js
   *
   * The store is split across multiple keys to avoid mega-blob corruption
   * and to keep exports readable. This loader reconstructs the pieces.
   ***************************************************************************/

  function loadStore(options = {}) {
    // When includeRaffles is false we ONLY load meta + stickerMap so modules
    // that do not own raffle storage avoid touching bucket/index keys.
    const includeRaffles = options.includeRaffles !== false;
    const meta = loadJsonKey(META_KEY);
    if (!meta) {
      const fresh = initStore();
      if (includeRaffles) {
        saveStoreParts(fresh);
        return fresh;
      }
      saveStoreMeta(fresh);
      return {
        schemaVersion: fresh.schemaVersion,
        activeStickerbookId: fresh.activeStickerbookId,
        stickerMap: fresh.stickerMap,
      };
    }
    const base = {
      schemaVersion: SCHEMA_VERSION,
      activeStickerbookId: meta.activeStickerbookId || "stickerbook-2",
      stickerMap: loadJsonKey(STICKER_MAP_KEY) || {},
    };
    if (includeRaffles) {
      base.raffleIndex = loadJsonKey(RAFFLE_INDEX_KEY) || {};
      base.raffleDays = loadJsonKey(RAFFLE_DAYS_KEY) || {};
    }
    return base;
  }

  function saveStoreParts(store) {
    saveJsonKey(META_KEY, {
      schemaVersion: store.schemaVersion,
      activeStickerbookId: store.activeStickerbookId,
    });
    saveJsonKey(STICKER_MAP_KEY, store.stickerMap || {});
    saveJsonKey(RAFFLE_INDEX_KEY, store.raffleIndex || {});
    saveJsonKey(RAFFLE_DAYS_KEY, store.raffleDays || {});
  }

  function saveStoreRaffleKeys(store) {
    // Raffle-only save keeps meta/stickerMap untouched.
    saveJsonKey(RAFFLE_INDEX_KEY, store.raffleIndex || {});
    saveJsonKey(RAFFLE_DAYS_KEY, store.raffleDays || {});
  }

  function saveStoreMeta(store) {
    // Meta-only save keeps raffle index/day keys untouched.
    saveJsonKey(META_KEY, {
      schemaVersion: store.schemaVersion,
      activeStickerbookId: store.activeStickerbookId,
    });
    saveJsonKey(STICKER_MAP_KEY, store.stickerMap || {});
  }

  function initStore() {
    return {
      schemaVersion: SCHEMA_VERSION,
      activeStickerbookId: "stickerbook-2",
      stickerMap: {},
      raffleIndex: {},
      raffleDays: {},
    };
  }

  /***************************************************************************
   * raffle_buckets.js
   *
   * Raffles are stored in per-day buckets. The index tells us which bucket
   * owns each postId so we can load/update only what we need.
   *
   * IMPORTANT: these helpers are internal plumbing for raffleStore. Other
   * modules should never call them directly.
   ***************************************************************************/

  function loadRaffleBucket(dayKey) {
    return loadJsonKey(`${RAFFLE_BUCKET_PREFIX}${dayKey}`) || {};
  }

  function saveRaffleBucket(dayKey, bucket) {
    saveJsonKey(`${RAFFLE_BUCKET_PREFIX}${dayKey}`, bucket);
  }

  /***************************************************************************
   * storage_policy.js
   *
   * Write policy: we persist immediately after any new data is fetched.
   * This prevents long-running loops from losing progress if the tab crashes
   * or a network error interrupts the run.
   *
   * NOTE: If you think you need batching, update POLICY.storageWriteMode
   * explicitly and document why. Otherwise, write through raffleStore.put()
   * directly after every data mutation.
   ***************************************************************************/

  function loadPiggybank() {
    return loadJsonKey(PIGGYBANK_KEY) || {};
  }

  function savePiggybank(piggybank) {
    saveJsonKey(PIGGYBANK_KEY, piggybank || {});
  }

  /***************************************************************************
   * time.js
   *
   * Canonical timestamps are Unix seconds. We normalize ms/sec inputs here
   * so the rest of the code never mixes units.
   ***************************************************************************/

  function toEpochSec(value) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return num >= 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }

  function formatDayKey(sec) {
    const d = new Date(sec * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function formatTimeOfDay(sec, timeZone = LOG_TIMEZONE) {
    if (!sec) return "?";
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      });
      return formatter.format(new Date(sec * 1000));
    } catch {
      const d = new Date(sec * 1000);
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      return `${hours}:${minutes}`;
    }
  }

  function formatDayKeyInTimeZone(sec, timeZone) {
    if (!sec) return "";
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = formatter.formatToParts(new Date(sec * 1000));
      const get = (type) => parts.find((part) => part.type === type)?.value || "";
      const y = get("year");
      const m = get("month");
      const d = get("day");
      if (y && m && d) return `${y}-${m}-${d}`;
      return formatDayKey(sec);
    } catch {
      return formatDayKey(sec);
    }
  }

  function getRaffleDayKey(raffle) {
    const endTimeSec = toEpochSec(raffle?.raffle?.endTime);
    if (endTimeSec) return formatDayKey(endTimeSec);
    const lastSeenSec = toEpochSec(raffle?.lastSeenAt);
    if (lastSeenSec) return formatDayKey(lastSeenSec);
    const firstSeenSec = toEpochSec(raffle?.firstSeenAt);
    if (firstSeenSec) return formatDayKey(firstSeenSec);
    const createdSec = toEpochSec(raffle?.createdAt);
    if (createdSec) return formatDayKey(createdSec);
    return formatDayKey(nowSec());
  }

  function getReverifyDayKey(raffle) {
    const endTimeSec = toEpochSec(raffle?.raffle?.endTime ?? raffle?.endTime);
    if (endTimeSec) return formatDayKey(endTimeSec);
    const explicit = raffle?.dayKey || raffle?.day || raffle?.date;
    if (typeof explicit === "string" && explicit) return explicit;
    const createdSec = toEpochSec(raffle?.createdAt || raffle?.firstSeenAt || raffle?.updatedAt);
    if (createdSec) return formatDayKey(createdSec);
    return "unknown";
  }

  /***************************************************************************
   * raffle_store.js
   *
   * This is the single authority for raffle storage. Any code that needs
   * to read or write raffle buckets MUST go through this module so bucket,
   * index, and day invariants cannot drift.
   ***************************************************************************/

  function createRaffleStoreBatch(label) {
    const batch = {
      label: label || "raffleStore",
      store: loadStore(),
      bucketCache: new Map(),
      touchedDays: new Set(),
    };

    batch.flush = () => {
      for (const dayKey of batch.touchedDays) {
        const bucket = batch.bucketCache.get(dayKey) || loadRaffleBucket(dayKey);
        if (!bucket || Object.keys(bucket).length === 0) {
          saveRaffleBucket(dayKey, {});
          delete batch.store.raffleDays[dayKey];
        } else {
          saveRaffleBucket(dayKey, bucket);
        }
      }
      saveStoreRaffleKeys(batch.store);
      batch.touchedDays.clear();
    };

    return batch;
  }

  function getBucketFromBatch(batch, dayKey) {
    let bucket = batch.bucketCache.get(dayKey);
    if (!bucket) {
      bucket = loadRaffleBucket(dayKey);
      batch.bucketCache.set(dayKey, bucket);
    }
    return bucket;
  }

  function markDayTouched(batch, dayKey) {
    if (!batch) return;
    batch.touchedDays.add(dayKey);
  }

  function resolveDayKeyForPost(store, postId) {
    if (!store || !postId) return "";
    const dayKey = store.raffleIndex?.[postId] || "";
    return typeof dayKey === "string" ? dayKey : "";
  }

  function ensureBucketForWrite(batch, dayKey) {
    if (!batch) return loadRaffleBucket(dayKey);
    return getBucketFromBatch(batch, dayKey);
  }

  function commitBucketWrite(batch, dayKey, bucket) {
    if (batch) {
      batch.bucketCache.set(dayKey, bucket);
      markDayTouched(batch, dayKey);
      return;
    }
    saveRaffleBucket(dayKey, bucket);
  }

  const raffleStore = {
    /***************************************************************************
     * raffleStore.put() — Canonical single-writer for raffle buckets/index/days.
     *
     * Invariants enforced:
     * - postId appears in exactly one day bucket
     * - raffleIndex points to the correct bucket for postId
     * - raffleDays contains only buckets that have at least one raffle
     *
     * DayKey rules:
     * - Derived from raffle endTime if present
     * - Falls back to lastSeen/firstSeen/createdAt
     * - Changing dayKey triggers remove-from-old-bucket then write to new bucket
     ***************************************************************************/
    beginBatch(label) {
      return createRaffleStoreBatch(label);
    },

    get(postId, batch = null) {
      if (!postId) return null;
      const store = batch?.store || loadStore();
      const dayKey = resolveDayKeyForPost(store, postId);
      if (!dayKey) return null;
      const bucket = batch ? getBucketFromBatch(batch, dayKey) : loadRaffleBucket(dayKey);
      return bucket?.[postId] || null;
    },

    put(raffle, batch = null) {
      if (!raffle || typeof raffle !== "object") return null;
      const postId = raffle.postId;
      if (!postId) return null;
      // Single source of truth for bucket/index invariants: do not bypass.
      const workingBatch = batch || createRaffleStoreBatch("put");
      const store = workingBatch.store;

      const nextDayKey = getRaffleDayKey(raffle);
      const previousDayKey = resolveDayKeyForPost(store, postId);

      if (previousDayKey && previousDayKey !== nextDayKey) {
        const previousBucket = ensureBucketForWrite(workingBatch, previousDayKey);
        if (previousBucket && previousBucket[postId]) {
          delete previousBucket[postId];
          if (Object.keys(previousBucket).length === 0) {
            delete store.raffleDays[previousDayKey];
          }
          commitBucketWrite(workingBatch, previousDayKey, previousBucket);
        }
      }

      const nextBucket = ensureBucketForWrite(workingBatch, nextDayKey);
      nextBucket[postId] = raffle;
      commitBucketWrite(workingBatch, nextDayKey, nextBucket);
      store.raffleIndex[postId] = nextDayKey;
      store.raffleDays[nextDayKey] = 1;

      if (!batch) {
        workingBatch.flush();
      }
      return raffle;
    },

    remove(postId, batch = null) {
      if (!postId) return false;
      const workingBatch = batch || createRaffleStoreBatch("remove");
      const store = workingBatch.store;
      const dayKey = resolveDayKeyForPost(store, postId);
      if (!dayKey) return false;

      const bucket = ensureBucketForWrite(workingBatch, dayKey);
      if (bucket && bucket[postId]) {
        delete bucket[postId];
        if (Object.keys(bucket).length === 0) {
          delete store.raffleDays[dayKey];
        }
        commitBucketWrite(workingBatch, dayKey, bucket);
      }
      delete store.raffleIndex[postId];

      if (!batch) {
        workingBatch.flush();
      }
      return true;
    },

    listDayKeys(batch = null) {
      const store = batch?.store || loadStore();
      return Object.keys(store.raffleDays || {});
    },

    listByDay(dayKey, batch = null) {
      if (!dayKey) return [];
      const bucket = batch ? getBucketFromBatch(batch, dayKey) : loadRaffleBucket(dayKey);
      return Object.values(bucket || {}).filter((raffle) => raffle && typeof raffle === "object");
    },

    listRange(startDayKey, endDayKey) {
      const dayKeys = raffleStore.listDayKeys().sort();
      const filtered = dayKeys.filter((dayKey) => {
        if (startDayKey && dayKey < startDayKey) return false;
        if (endDayKey && dayKey > endDayKey) return false;
        return true;
      });
      const raffles = [];
      for (const dayKey of filtered) {
        raffles.push(...raffleStore.listByDay(dayKey));
      }
      return raffles;
    },

    getBucketSnapshot(dayKey) {
      if (!dayKey) return {};
      return loadRaffleBucket(dayKey);
    },

    getIndexSnapshot() {
      const store = loadStore();
      return store.raffleIndex || {};
    },

    getDaySetSnapshot() {
      const store = loadStore();
      return store.raffleDays || {};
    },
  };

  /***************************************************************************
   * invariants.js
   *
   * Lightweight integrity checks that warn about drift without mutating data.
   * These checks are throttled to avoid spamming the console.
   ***************************************************************************/

  let lastInvariantCheckAt = 0;

  function assertRaffleStoreInvariants(reason) {
    if (!DEBUG.warnings) return;
    const now = nowSec();
    if (now - lastInvariantCheckAt < 300) return;
    lastInvariantCheckAt = now;

    const dayKeys = raffleStore.listDayKeys();
    const seen = new Set();
    const duplicates = [];
    let msTimestampCount = 0;
    let heuristicOnlyCount = 0;
    let missingStickerMetaCount = 0;

    const checkTimestamp = (value) => {
      if (value === null || value === undefined) return;
      const num = Number(value);
      if (!Number.isFinite(num)) return;
      if (num >= 1e12) msTimestampCount += 1;
    };

    for (const dayKey of dayKeys) {
      const raffles = raffleStore.listByDay(dayKey);
      for (const raffle of raffles) {
        if (!raffle || typeof raffle !== "object") continue;
        const postId = raffle.postId;
        if (postId) {
          if (seen.has(postId)) duplicates.push(postId);
          else seen.add(postId);
        }

        checkTimestamp(raffle.firstSeenAt);
        checkTimestamp(raffle.lastSeenAt);
        checkTimestamp(raffle.createdAt);
        checkTimestamp(raffle.updatedAt);

        const token = raffle.token || {};
        checkTimestamp(token.tokenFetchedAt);

        const status = raffle.status || {};
        checkTimestamp(status.lastFetchAt);
        checkTimestamp(status.lastErrorAt);

        const winner = raffle.winner || {};
        checkTimestamp(winner.winnerFetchedAt);

        const entry = raffle.entry || {};
        checkTimestamp(entry.enteredAt);

        const claim = raffle.claim || {};
        checkTimestamp(claim.claimAttemptedAt);
        checkTimestamp(claim.claimSucceededAt);

        const raffleData = raffle.raffle || {};
        checkTimestamp(raffleData.endTime);
        checkTimestamp(raffleData.stickerbookEndTime);

        const stickerId = raffleData.stickerId;
        const stickerName = raffleData.stickerName;
        const stickerStars = raffleData.stickerStars;
        const hasHeuristic = stickerName !== undefined || stickerStars !== undefined;
        if (!stickerId && hasHeuristic) {
          heuristicOnlyCount += 1;
        }
        if (stickerId && (stickerName === undefined || stickerStars === undefined)) {
          missingStickerMetaCount += 1;
        }
      }
    }

    if (duplicates.length) {
      warnLog("Invariant: postId appears in multiple buckets", {
        reason,
        count: duplicates.length,
        sample: duplicates.slice(0, 5),
      });
    }
    if (msTimestampCount) {
      warnLog("Invariant: millisecond timestamps detected (expected seconds)", {
        reason,
        count: msTimestampCount,
      });
    }
    if (heuristicOnlyCount) {
      warnLog("Invariant: heuristic sticker fields without stickerId", {
        reason,
        count: heuristicOnlyCount,
      });
    }
    if (missingStickerMetaCount) {
      warnLog("Invariant: stickerId missing name/stars", {
        reason,
        count: missingStickerMetaCount,
      });
    }
  }

  function toFullUrl(permalink) {
    if (!permalink) return "";
    return permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
  }

  function openInBackground(url) {
    if (!url) return null;
    try {
      if (typeof GM_openInTab === "function") {
        return GM_openInTab(url, {
          active: false,
          insert: true,
          setParent: true,
        });
      }
    } catch (err) {
      // Fall back to window.open below.
    }
    const tab = window.open(url, "_blank", "noopener,noreferrer");
    if (tab && typeof tab.blur === "function") {
      tab.blur();
    }
    if (typeof window.focus === "function") {
      window.focus();
    }
    return tab;
  }

  /***************************************************************************
   * debug_log.js
   *
   * Persist a concise, append-only summary log for key events. This is not
   * the console log; it is a compact history of important outcomes only.
   ***************************************************************************/

  function loadDebugLogDays() {
    return loadJsonKey(DEBUG_LOG_DAYS_KEY) || {};
  }

  function saveDebugLogDays(days) {
    saveJsonKey(DEBUG_LOG_DAYS_KEY, days || {});
  }

  function loadDebugLogBucket(dayKey) {
    return loadJsonKey(`${DEBUG_LOG_BUCKET_PREFIX}${dayKey}`) || [];
  }

  function saveDebugLogBucket(dayKey, bucket) {
    saveJsonKey(`${DEBUG_LOG_BUCKET_PREFIX}${dayKey}`, bucket || []);
  }

  function appendDebugLog(type, data) {
    const stamp = nowSec();
    const dayKey = formatDayKey(stamp);
    const days = loadDebugLogDays();
    const bucket = loadDebugLogBucket(dayKey);
    const payload = data && typeof data === "object" ? { ...data } : data;
    if (payload && typeof payload === "object" && Number.isFinite(Number(payload.stamped))) {
      payload.stampedHuman = formatLogTimestamp(Number(payload.stamped));
    }
    bucket.push({
      timestamp: stamp,
      timestampHuman: formatLogTimestamp(stamp),
      type,
      data: payload,
    });
    if (bucket.length > 200) {
      bucket.splice(0, bucket.length - 200);
    }
    days[dayKey] = 1;
    saveDebugLogBucket(dayKey, bucket);
    saveDebugLogDays(days);
  }

  /***************************************************************************
   * parsing_utils.js
   *
   * Helpers for safely extracting attributes and JSON from HTML nodes.
   ***************************************************************************/

  function safeJsonParse(raw) {
    if (!raw || typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch {
      try {
        return JSON.parse(raw.replaceAll("&quot;", '"'));
      } catch {
        return null;
      }
    }
  }

  function getAttr(el, ...names) {
    for (const name of names) {
      const value = el.getAttribute(name);
      if (value) return value;
    }
    return "";
  }

  function getWebviewUrlTemplate(el) {
    return (
      getAttr(el, "webviewurltemplate", "webViewUrlTemplate", "webviewurlTemplate") || ""
    );
  }

  function buildWebviewUrl(template, token) {
    if (!template) return "";
    const base = template.replace("{{path}}", "raffle/raffle.html");
    if (!token) return base;
    return `${base}?webbit_token=${encodeURIComponent(token)}`;
  }

  function getOriginFromWebviewUrl(url) {
    if (!url) return DEFAULT_ORIGIN;
    try {
      return new URL(url).origin;
    } catch {
      return DEFAULT_ORIGIN;
    }
  }

  /***************************************************************************
   * sheets_sync.js
   *
   * Minimal Google Sheets exporter for daily winners. This module is
   * intentionally read-only: it never mutates raffle storage, and it never
   * sends excluded usernames to the webhook. If the webhook URL is blank,
   * everything below becomes a no-op so the rest of the script stays intact.
   ***************************************************************************/

  function normalizeWinnerUsername(raw) {
    if (!raw) return "";
    return String(raw).trim().replace(/^\/?u\//i, "");
  }

  function normalizeWinnerKey(raw) {
    return normalizeWinnerUsername(raw).toLowerCase();
  }

  const SHEETS_EXCLUDED_WINNER_SET = new Set(
    (SHEETS_EXCLUDED_WINNER_NAMES || [])
      .map((name) => normalizeWinnerKey(name))
      .filter(Boolean),
  );

  const SHEETS_EXCLUDED_WINNER_ID_SET = new Set(
    [CURRENT_USER_ID].filter(Boolean).map((id) => String(id)),
  );

  function isExcludedWinner(winnerName, winnerId) {
    const normalized = normalizeWinnerKey(winnerName);
    if (normalized && SHEETS_EXCLUDED_WINNER_SET.has(normalized)) return true;
    if (winnerId && SHEETS_EXCLUDED_WINNER_ID_SET.has(String(winnerId))) return true;
    return false;
  }

  function buildSheetsWinnerRow(raffle) {
    if (!raffle || typeof raffle !== "object") return null;
    const postId = raffle.postId;
    if (!postId) return null;

    const endTimeSec = toEpochSec(raffle.raffle?.endTime);
    if (!endTimeSec) return null;
    const dayKey = formatDayKeyInTimeZone(endTimeSec, SHEETS_TIMEZONE);
    if (!dayKey) return null;

    const winnerName = normalizeWinnerUsername(
      raffle.winner?.winnerName || raffle.winnerName || "",
    );
    const winnerId = String(raffle.winner?.winnerId || raffle.winnerId || "").trim();

    // Only export when we have a readable username to avoid exposing raw IDs.
    if (!winnerName) return null;
    if (winnerName.toLowerCase() === "nobody") return null;
    if (isExcludedWinner(winnerName, winnerId)) return null;

    const stickerName = String(
      raffle.raffle?.stickerName || raffle.postTitle || "(unknown)",
    ).trim();
    const starsNum = Number(raffle.raffle?.stickerStars);
    const stickerStars = Number.isFinite(starsNum) ? starsNum : "";
    const postUrl = toFullUrl(raffle.url || raffle.permalink);
    if (!postUrl) return null;

    const row = [postId, winnerName, stickerName, stickerStars, postUrl];
    const fingerprint = `${dayKey}|${row.join("|")}`;
    return { dayKey, postId, row, fingerprint };
  }

  function listAllRafflesForSheets() {
    const dayKeys = raffleStore.listDayKeys();
    const raffles = [];
    for (const dayKey of dayKeys) {
      raffles.push(...raffleStore.listByDay(dayKey));
    }
    return raffles;
  }

  const sheetsSync = (() => {
    const pendingByDay = new Map();
    const sentFingerprintByPostId = new Map();
    let inFlight = false;

    function isEnabled() {
      return typeof SHEETS_WEBHOOK_URL === "string" && SHEETS_WEBHOOK_URL.startsWith("http");
    }

    function getPendingCounts() {
      let rows = 0;
      let days = 0;
      for (const [, dayMap] of pendingByDay.entries()) {
        if (!dayMap || dayMap.size === 0) continue;
        days += 1;
        rows += dayMap.size;
      }
      return { rows, days };
    }

    function enqueueFromRaffle(raffle, contextLabel) {
      if (!isEnabled()) return false;
      const built = buildSheetsWinnerRow(raffle);
      if (!built) return false;

      const alreadySent = sentFingerprintByPostId.get(built.postId);
      if (alreadySent === built.fingerprint) return false;

      let dayMap = pendingByDay.get(built.dayKey);
      if (!dayMap) {
        dayMap = new Map();
        pendingByDay.set(built.dayKey, dayMap);
      }

      dayMap.set(built.postId, { row: built.row, fingerprint: built.fingerprint });

      debugLog("actions", "Sheets enqueue", {
        context: contextLabel || "",
        dayKey: built.dayKey,
        postId: built.postId,
        winner: built.row[1],
      });

      return true;
    }

    async function postBatch(dayKey, rows, reason) {
      const payload = {
        date: dayKey,
        rows,
        mode: "upsert",
      };
      if (SHEETS_WEBHOOK_SECRET) {
        payload.secret = SHEETS_WEBHOOK_SECRET;
      }

      const resp = await gmRequestJson({
        url: SHEETS_WEBHOOK_URL,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify(payload),
        timeoutMs: 60000,
      });

      const ok = resp?.status >= 200 && resp?.status < 300;
      appendDebugLog("sheets-sync", {
        dayKey,
        count: rows.length,
        status: resp?.status || 0,
        ok,
        reason: reason || "",
        error: ok ? null : resp?.error || resp?.text || null,
      });
      debugLog("actions", "Sheets batch", {
        dayKey,
        reason: reason || "",
        ok,
        status: resp?.status || 0,
        count: rows.length,
      });

      return { ok, resp };
    }

    async function flush({ force = false, reason = "" } = {}) {
      if (!isEnabled()) {
        return { ok: false, disabled: true, sent: 0, days: 0, batches: 0, errors: 0 };
      }
      if (inFlight) {
        return { ok: false, inFlight: true, sent: 0, days: 0, batches: 0, errors: 0 };
      }

      const pending = getPendingCounts();
      const minRows = Number.isFinite(Number(SHEETS_AUTO_FLUSH_MIN_ROWS))
        ? Math.max(0, Number(SHEETS_AUTO_FLUSH_MIN_ROWS))
        : 0;

      if (!force && pending.rows < minRows) {
        debugLog("actions", "Sheets flush skipped (below threshold)", {
          pendingRows: pending.rows,
          minRows,
          reason: reason || "",
        });
        return { ok: true, skipped: true, sent: 0, days: 0, batches: 0, errors: 0 };
      }

      if (pending.rows === 0) {
        return { ok: true, skipped: true, sent: 0, days: 0, batches: 0, errors: 0 };
      }

      const summary = { ok: true, sent: 0, days: 0, batches: 0, errors: 0 };
      inFlight = true;

      try {
        const dayKeys = Array.from(pendingByDay.keys()).sort();
        for (const dayKey of dayKeys) {
          const dayMap = pendingByDay.get(dayKey);
          if (!dayMap || dayMap.size === 0) continue;
          summary.days += 1;

          const entries = Array.from(dayMap.entries());
          for (let i = 0; i < entries.length; i += SHEETS_BATCH_SIZE) {
            const slice = entries.slice(i, i + SHEETS_BATCH_SIZE);
            const rows = slice.map(([, payload]) => payload.row);

            const { ok } = await postBatch(dayKey, rows, reason);
            summary.batches += 1;
            if (!ok) {
              summary.ok = false;
              summary.errors += 1;
              return summary;
            }

            for (const [postId, payload] of slice) {
              sentFingerprintByPostId.set(postId, payload.fingerprint);
              dayMap.delete(postId);
              summary.sent += 1;
            }

            if (SHEETS_BATCH_DELAY_MS > 0) {
              await new Promise((resolve) => setTimeout(resolve, SHEETS_BATCH_DELAY_MS));
            }
          }

          if (dayMap.size === 0) {
            pendingByDay.delete(dayKey);
          }
        }
      } catch (err) {
        summary.ok = false;
        summary.errors += 1;
        warnLog("Sheets flush crashed", err);
      } finally {
        inFlight = false;
      }

      return summary;
    }

    async function syncDayFromStorage(dayKey, reason = "manual-sync") {
      if (!isEnabled()) {
        warnLog("Sheets sync aborted: webhook URL is not configured.");
        return { ok: false, disabled: true, sent: 0, batches: 0, errors: 0, total: 0 };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
        warnLog("Sheets sync aborted: invalid date format (expected YYYY-MM-DD).", dayKey);
        return { ok: false, invalid: true, sent: 0, batches: 0, errors: 0, total: 0 };
      }

      const all = listAllRafflesForSheets();
      const byPostId = new Map();

      for (const raffle of all) {
        const built = buildSheetsWinnerRow(raffle);
        if (!built) continue;
        if (built.dayKey !== dayKey) continue;
        byPostId.set(built.postId, built);
      }

      const winners = Array.from(byPostId.values());
      winners.sort((a, b) => {
        const starsA = Number(a.row[3] || 0);
        const starsB = Number(b.row[3] || 0);
        if (starsA !== starsB) return starsB - starsA;
        const nameA = String(a.row[2] || "").toLowerCase();
        const nameB = String(b.row[2] || "").toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return String(a.postId).localeCompare(String(b.postId));
      });

      let sent = 0;
      let batches = 0;
      let errors = 0;

      for (let i = 0; i < winners.length; i += SHEETS_BATCH_SIZE) {
        const slice = winners.slice(i, i + SHEETS_BATCH_SIZE);
        const rows = slice.map((item) => item.row);
        const { ok } = await postBatch(dayKey, rows, reason);
        batches += 1;
        if (!ok) {
          errors += 1;
          break;
        }
        for (const item of slice) {
          sentFingerprintByPostId.set(item.postId, item.fingerprint);
        }
        sent += rows.length;
        if (SHEETS_BATCH_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, SHEETS_BATCH_DELAY_MS));
        }
      }

      return { ok: errors === 0, total: winners.length, sent, batches, errors };
    }

    return {
      isEnabled,
      enqueueFromRaffle,
      flush,
      syncDayFromStorage,
      getPendingCounts,
    };
  })();

  async function syncWinnersToSheetsPrompt() {
    const defaultDay = formatDayKeyInTimeZone(nowSec(), SHEETS_TIMEZONE);
    const raw = prompt("Sync winners to Sheets for date (YYYY-MM-DD):", defaultDay);
    if (raw === null) return;
    const dayKey = String(raw).trim();
    const result = await sheetsSync.syncDayFromStorage(dayKey, "manual-sync");
    debugLog("actions", "Sheets manual sync complete", {
      dayKey,
      total: result.total ?? "?",
      sent: result.sent,
      batches: result.batches,
      errors: result.errors,
    });
  }

  async function flushPendingSheetsSyncNow() {
    const pending = sheetsSync.getPendingCounts();
    const result = await sheetsSync.flush({ force: true, reason: "manual-flush" });
    debugLog("actions", "Sheets manual flush complete", {
      pendingRows: pending.rows,
      pendingDays: pending.days,
      sent: result.sent,
      batches: result.batches,
      errors: result.errors,
    });
  }

  /***************************************************************************
   * feed_time.js
   *
   * Reddit's feed includes the true post creation timestamp. We extract it
   * here so `createdAt` reflects Reddit time, not local discovery time.
   ***************************************************************************/

  function parseCreatedTimestamp(value) {
    if (!value) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toEpochSec(numeric);
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) return null;
    return toEpochSec(parsed);
  }

  function getCreatedAtFromFeed(el, postId) {
    if (!el || !postId) return null;
    const doc = el.ownerDocument;
    if (!doc) return null;
    const postEl =
      doc.querySelector(`shreddit-post[postid="${postId}"]`) ||
      doc.querySelector(`shreddit-post[postId="${postId}"]`) ||
      doc.querySelector(`shreddit-post[id="${postId}"]`);
    if (!postEl) return null;
    const createdAttr = getAttr(
      postEl,
      "created-timestamp",
      "createdTimestamp",
      "created_timestamp",
    );
    const createdFromAttr = parseCreatedTimestamp(createdAttr);
    if (createdFromAttr) return createdFromAttr;
    const telemetry = safeJsonParse(getAttr(postEl, "telemetry-post-data"));
    return parseCreatedTimestamp(telemetry?.created_timestamp);
  }

  /***************************************************************************
   * raffle_normalize.js
   *
   * Discovery phase: build the canonical raffle object from feed HTML.
   * We only add fields we can trust from the feed at this stage.
   ***************************************************************************/

  function normalizeStickerFields(raffle, stickerMap) {
    const stickerId = raffle?.raffle?.stickerId;
    if (!stickerId || !stickerMap || typeof stickerMap !== "object") return raffle;
    const entry = stickerMap[stickerId];
    if (!entry) return raffle;
    const next = { ...raffle };
    next.raffle = { ...raffle.raffle };
    next.raffle.stickerName = entry.stickerName || entry.localizedName || null;
    next.raffle.stickerStars =
      entry.stickerStars !== undefined ? entry.stickerStars : Number(entry.tier || 0);
    return next;
  }

  function parseStickerInfoFromTitle(title) {
    if (!title) return null;
    const starMatch = title.match(/(\d)\s*Stars?/i);
    const nameMatch = title.match(/win a\s+(.*?)\s+sticker/i);
    let stickerName = nameMatch ? nameMatch[1].trim() : null;
    if (stickerName) {
      stickerName = stickerName.replace(/^\d+\s*stars?\s*/i, "").trim();
    }
    return {
      stickerStars: starMatch ? Number(starMatch[1]) : null,
      stickerName,
    };
  }

  function resolveStickerIdFromName(stickerName, stickerMap) {
    if (!stickerName || !stickerMap || typeof stickerMap !== "object") return null;
    const nameLower = stickerName.toLowerCase();
    for (const [id, entry] of Object.entries(stickerMap)) {
      if (!entry?.stickerName) continue;
      if (entry.stickerName.toLowerCase() === nameLower) return id;
    }
    return null;
  }

  function estimateEndTime(createdAtSec) {
    if (!createdAtSec) return null;
    return createdAtSec + 24 * 60 * 60;
  }

  function looksLikeRaffleFromFeed(feed) {
    // Simple, conservative gate: if it does not look like a raffle, we skip it.
    // This keeps storage clean without building a complicated classifier.
    const title = String(feed.postTitle || feed.postData?.splash?.title || "").toLowerCase();
    return title.includes("giveaway") || title.includes("enter to win") || title.includes("sticker");
  }

  /***************************************************************************
   * normalizeRaffleFromFeed()
   *
   * This is the only place we trust feed HTML for discovery.
   * It populates:
   * - identity fields (postId, permalink, author, subreddit)
   * - token data for API calls
   * - provisional heuristic fields (sticker name/stars, estimated endTime)
   *
   * IMPORTANT:
   * - Heuristic fields MUST be overwritten later by getRaffleData.
   * - Non-raffle posts are filtered out here and never stored.
   ***************************************************************************/
  function normalizeRaffleFromFeed(el, store, existing) {
    const postId = getAttr(el, "postId", "postid");
    if (!postId) return null;
    // Discovery phase: only trust fields embedded in the feed HTML. We do not
    // attempt to infer or validate deeper raffle data here.
    const permalink = getAttr(el, "permalink");
    const postTitle = getAttr(el, "postTitle");
    const postAuthorId = getAttr(el, "postAuthorId");
    const subredditId = getAttr(el, "subredditId");
    const subredditName = getAttr(el, "subredditName");
    const postData = safeJsonParse(getAttr(el, "postData"));
    const webbitToken = getAttr(el, "webbit-token", "webbitToken", "webbit_token");
    const webviewUrlTemplate = getWebviewUrlTemplate(el);
    const webviewUrl = buildWebviewUrl(webviewUrlTemplate, webbitToken);
    const gatewayOrigin = getAttr(el, "gateway-origin");
    const createdAtSec = getCreatedAtFromFeed(el, postId);

    const previous = existing || { postId };
    const now = nowSec();
    const entry = previous.entry && typeof previous.entry === "object" ? { ...previous.entry } : null;
    const claim = previous.claim && typeof previous.claim === "object" ? { ...previous.claim } : null;
    const status =
      previous.status && typeof previous.status === "object" ? { ...previous.status } : null;
    const feed = {
      permalink,
      postTitle,
      postAuthorId,
      subredditId,
      subredditName,
      appSlug: getAttr(el, "app-slug"),
      appVersionNumber: getAttr(el, "app-version-number"),
      appBundleUrl: getAttr(el, "app-bundle-url"),
      appPublicApiVersion: getAttr(el, "app-public-api-version"),
      appInstallationId: getAttr(el, "app-installation-id"),
      runtimeLiteVersion: getAttr(el, "runtime-lite-version"),
      pageType: getAttr(el, "page-type"),
      signedRequestContext: getAttr(el, "signed-request-context"),
      userAgent: getAttr(el, "user-agent"),
      webViewClientData: safeJsonParse(getAttr(el, "web-view-client-data")),
      postData: postData || null,
    };
    if (!looksLikeRaffleFromFeed(feed)) return null;
    const next = {
      ...previous,
      postId,
      url: toFullUrl(permalink) || previous.url || "",
      permalink: permalink || previous.permalink || "",
      postTitle: postTitle || previous.postTitle || "",
      postAuthorId: postAuthorId || previous.postAuthorId || "",
      subredditId: subredditId || previous.subredditId || "",
      subredditName: subredditName || previous.subredditName || "",
      feed,
      token: {
        webbitToken: webbitToken || previous.token?.webbitToken || "",
        webviewUrlTemplate: webviewUrlTemplate || previous.token?.webviewUrlTemplate || "",
        webviewUrl: webviewUrl || previous.token?.webviewUrl || "",
        gatewayOrigin: gatewayOrigin || previous.token?.gatewayOrigin || "",
        tokenFetchedAt: webbitToken ? now : previous.token?.tokenFetchedAt || 0,
      },
      raffle: {
        ...(previous.raffle || {}),
      },
      entry: entry || undefined,
      claim: claim || undefined,
      status: status || undefined,
      firstSeenAt: previous.firstSeenAt || now,
      lastSeenAt: now,
      createdAt: createdAtSec || previous.createdAt || now,
      updatedAt: now,
    };

    const parsed = parseStickerInfoFromTitle(postTitle);
    if (parsed) {
      next.raffle = next.raffle || {};
      if (parsed.stickerStars != null) {
        next.raffle.stickerStars = parsed.stickerStars;
      }
      if (parsed.stickerName) {
        next.raffle.stickerName = parsed.stickerName;
      }
    }
    if (!next.raffle?.stickerId && next.raffle?.stickerName && store.stickerMap) {
      const resolved = resolveStickerIdFromName(next.raffle.stickerName, store.stickerMap);
      if (resolved) next.raffle.stickerId = resolved;
    }
    if (!next.raffle?.endTime && next.createdAt) {
      const estimated = estimateEndTime(toEpochSec(next.createdAt));
      if (estimated) next.raffle.endTime = estimated;
    }

    // Sticker mapping is an optional convenience layer, not a source of truth.
    return normalizeStickerFields(next, store.stickerMap);
  }

  /***************************************************************************
   * network.js
   *
   * HTML fetches and API calls live here so we can reason about I/O clearly.
   ***************************************************************************/

  async function fetchHtml(url) {
    return new Promise((resolve) => {
      logHttp("GET", url);
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { Accept: "text/html" },
        responseType: "text",
        onload: (resp) => resolve(resp.responseText || ""),
        onerror: () => resolve(""),
      });
    });
  }

  function getTokenFromDocument(doc, postId) {
    if (!doc) return { token: "", webviewUrl: "" };
    const loaders = Array.from(doc.querySelectorAll("shreddit-devvit-ui-loader"));
    let token = "";
    let template = "";
    for (const loader of loaders) {
      const loaderPostId = getAttr(loader, "postid", "postId");
      if (postId && loaderPostId && loaderPostId !== postId) continue;
      token = getAttr(loader, "webbit-token", "webbit_token", "webbitToken");
      template = getWebviewUrlTemplate(loader);
      if (token && String(token).startsWith("eyJ")) break;
      token = "";
    }
    if (token && !String(token).startsWith("eyJ")) token = "";
    return { token, webviewUrl: buildWebviewUrl(template, token) };
  }

  /***************************************************************************
   * url_utils.js
   *
   * Normalize relative links from Reddit into full URLs for pagination
   * and storage.
   ***************************************************************************/

  function resolveRedditUrl(url) {
    if (!url) return "";
    if (url.startsWith("http")) return url;
    if (url.startsWith("/")) return `https://www.reddit.com${url}`;
    return `https://www.reddit.com/${url}`;
  }

  function isBossTab() {
    try {
      return window.location.href === FEED_URL;
    } catch {
      return false;
    }
  }

  function extractNextPageUrl(doc) {
    const nodes = doc.querySelectorAll('faceplate-partial[slot="load-after"][src]');
    if (!nodes.length) return "";
    return nodes[nodes.length - 1].getAttribute("src") || "";
  }

  async function refreshToken(raffle) {
    if (!raffle?.url) return { updated: false };
    const html = await fetchHtml(raffle.url);
    if (!html) return { updated: false };
    const doc = new DOMParser().parseFromString(html, "text/html");
    const { token, webviewUrl } = getTokenFromDocument(doc, raffle.postId);
    if (!token) return { updated: false };
    return {
      updated: true,
      token,
      webviewUrl,
    };
  }

  /***************************************************************************
   * ensureToken()
   *
   * Single helper for token refresh. This removes the repeated boilerplate
   * of "if no token, refresh and copy fields" so that every flow behaves
   * identically and we avoid subtle drift.
   ***************************************************************************/

  async function ensureToken(raffle) {
    if (!raffle) return { ok: false, refreshed: false };
    if (raffle.token?.webbitToken) return { ok: true, refreshed: false };
    if (!raffle.url) return { ok: false, refreshed: false };
    const refreshed = await refreshToken(raffle);
    if (!refreshed.updated) return { ok: false, refreshed: false };
    raffle.token = raffle.token || {};
    raffle.token.webbitToken = refreshed.token;
    raffle.token.webviewUrl = refreshed.webviewUrl || raffle.token.webviewUrl;
    raffle.token.tokenFetchedAt = nowSec();
    return { ok: true, refreshed: true };
  }

  function gmRequestJson({ url, headers = {}, method = "GET", timeoutMs = 60000, data }) {
    debugLog("calls", "gmRequestJson", method, url);
    if (DEBUG.network) {
      console.trace("[FMV] gmRequestJson called", { method, url });
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        responseType: "json",
        timeout: timeoutMs,
        onload: (resp) => {
          const status = resp.status || 0;
          resolve({ status, data: resp.response, text: resp.responseText || "" });
        },
        onerror: () => resolve({ status: 0, data: null, text: "", error: "network error" }),
        ontimeout: () => resolve({ status: 0, data: null, text: "", error: "timeout" }),
      });
    });
  }

  function logHttp(method, url) {
    debugLog("network", method, url);
  }

  /***************************************************************************
   * raffle_data.js
   *
   * Pull getRaffleData for a specific raffle and merge it into storage.
   ***************************************************************************/

  async function fetchRaffleData(raffle) {
    const token = raffle?.token?.webbitToken || "";
    if (!token) return { status: 0, data: null, error: "missing token" };
    const origin = getOriginFromWebviewUrl(raffle?.token?.webviewUrl);
    const url = `${origin}${RAFFLE_DATA_PATH}`;
    logHttp("GET", url);
    const resp = await gmRequestJson({
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    return resp;
  }

  /***************************************************************************
   * request_helpers.js
   *
   * Centralized wrapper for raffle API calls. This retries once on 401 with
   * a refreshed token and marks the raffle as deleted when the API returns 500.
   ***************************************************************************/

  /***************************************************************************
   * runRaffleRequest() — Single I/O gateway for raffle API calls.
   *
   * Responsibilities:
   * - Track attempt time + status transport in raffle.status
   * - Retry once on 401 by refreshing token
   * - Mark deleted on hard 500
   *
   * Why it exists:
   * - All API calls should flow through here so status semantics are consistent
   *   across manual, auto, and recovery flows.
   *
   * Side effects:
   * - Mutates raffle.token on refresh
   * - Mutates raffle.status fields (attempt/success/error/transport)
   ***************************************************************************/
  async function runRaffleRequest(raffle, requestFn, contextLabel) {
    noteStatusAttempt(raffle);
    let resp = await requestFn(raffle);
    if (resp?.status === 401) {
      const refreshed = await refreshToken(raffle);
      if (refreshed.updated) {
        raffle.token = raffle.token || {};
        raffle.token.webbitToken = refreshed.token;
        raffle.token.webviewUrl = refreshed.webviewUrl || raffle.token.webviewUrl;
        raffle.token.tokenFetchedAt = nowSec();
        noteStatusAttempt(raffle);
        resp = await requestFn(raffle);
      } else {
        warnLog("Token refresh failed", raffle?.postId || "unknown", contextLabel);
        noteStatusError(
          raffle,
          "http-401",
          contextLabel ? `token-refresh:${contextLabel}` : "token-refresh",
        );
      }
    }
    noteStatusFromResponse(raffle, resp, contextLabel);
    if (raffle?.status) {
      raffle.status.phase = inferStatusPhase(raffle);
    }
    if (contextLabel === "getRaffleData") {
      const hasPayload = Boolean(resp && resp.data);
      debugLog("network", "getRaffleData response", {
        postId: raffle?.postId || "unknown",
        status: resp?.status || 0,
        hasPayload,
      });
    }
    const deleted = markDeletedOnServerError(raffle, resp, contextLabel);
    return { resp, deleted };
  }

  /***************************************************************************
   * Auto-claim policy for getRaffleData responses.
   *
   * We ONLY auto-claim when ALL are true:
   * - Raffle has ended (endTime <= now)
   * - unrevealedForCurrentUser === false
   * - CURRENT_USER_ID is NOT in participantIds
   * - Winner is missing (winnerName is empty) AND winnerName != "nobody"
   *
   * Rationale:
   * - If the raffle is over and it’s already revealed, and the user did not
   *   participate, then calling claimRaffle does not risk claiming a real win.
   * - We avoid extra getRaffleData calls to prevent long retries.
   ***************************************************************************/
  function shouldClaimAfterGetRaffleData(raffle, data) {
    if (!data || typeof data !== "object") return false;
    const rawWinner = data.winner && typeof data.winner === "object" ? data.winner : null;
    const winnerName = data.winnerName || rawWinner?.name || rawWinner?.username || null;
    if (winnerName && String(winnerName).trim()) return false;
    if (String(winnerName || "").trim().toLowerCase() === "nobody") return false;
    const endTimeSec = toEpochSec(data.endTime || raffle?.raffle?.endTime);
    if (!endTimeSec || endTimeSec > nowSec()) return false;
    const unrevealed =
      data.unrevealedForCurrentUser === false ||
      raffle?.raffle?.unrevealedForCurrentUser === false;
    if (!unrevealed) return false;
    const participants = Array.isArray(data.participantIds)
      ? data.participantIds
      : Array.isArray(raffle?.raffle?.participantIds)
        ? raffle.raffle.participantIds
        : null;
    if (!participants || !CURRENT_USER_ID) return false;
    return !participants.includes(CURRENT_USER_ID);
  }

  function getWinnerIdFromData(data) {
    if (!data || typeof data !== "object") return null;
    const winner = data.winner;
    const rawId =
      typeof winner === "string" ? winner : winner?.id || winner?.userId || data.winnerId || null;
    return typeof rawId === "string" ? rawId.trim() : rawId;
  }

  function getWinnerNameFromData(data) {
    if (!data || typeof data !== "object") return null;
    const winner = data.winner;
    const rawName = winner?.name || winner?.username || data.winnerName || null;
    return typeof rawName === "string" ? rawName.trim() : rawName;
  }

  function isExpiredFromDataOrRaffle(raffle, data) {
    const endTimeSec = toEpochSec(data?.endTime || raffle?.raffle?.endTime);
    return Boolean(endTimeSec && endTimeSec <= nowSec());
  }

  function isCurrentUserParticipantFromDataOrRaffle(raffle, data) {
    const participants = Array.isArray(data?.participantIds)
      ? data.participantIds
      : Array.isArray(raffle?.raffle?.participantIds)
        ? raffle.raffle.participantIds
        : null;
    if (!participants || !CURRENT_USER_ID) return false;
    return participants.includes(CURRENT_USER_ID);
  }

  function normalizeStickerStars(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function summarizeRaffleState(raffle, data) {
    const winnerId = getWinnerIdFromData(data) || raffle?.winner?.winnerId || raffle?.winnerId || null;
    const winnerName =
      getWinnerNameFromData(data) || raffle?.winner?.winnerName || raffle?.winnerName || null;
    const unrevealed =
      data?.unrevealedForCurrentUser ?? raffle?.raffle?.unrevealedForCurrentUser ?? null;
    const currentUserParticipant = isCurrentUserParticipantFromDataOrRaffle(raffle, data);
    const expired = isExpiredFromDataOrRaffle(raffle, data);
    const stickerStars = normalizeStickerStars(
      raffle?.raffle?.stickerStars ?? data?.stickerStars ?? null,
    );
    return {
      expired,
      winnerId,
      winnerName,
      unrevealed,
      currentUserParticipant,
      stickerStars,
    };
  }

  function applyGetRaffleDataResult(raffle, resp, store, contextLabel, options = {}) {
    const persist = typeof options.persistFn === "function" ? options.persistFn : raffleStore.put;
    const data = resp?.data;
    if (!(resp?.status >= 200 && resp?.status < 300) || !data) {
      return { applied: false, summary: summarizeRaffleState(raffle, data) };
    }
    const refreshed = raffleEnrichment.applyGetRaffleData(raffle, data, store?.stickerMap || {});
    Object.assign(raffle, refreshed);
    touchRaffle(raffle, contextLabel || "getRaffleData");
    persist(raffle);
    return { applied: true, summary: summarizeRaffleState(raffle, data) };
  }

  function shouldAutoClaimWinner(summary, flags = {}) {
    // Policy gate: only auto-claim low-risk wins that are clearly ours.
    if (!flags.autoClaimWins) return false;
    if (!summary.expired) return false;
    if (summary.winnerId !== CURRENT_USER_ID) return false;
    if (summary.unrevealed !== true) return false;
    if (summary.stickerStars === 5 || summary.stickerStars === null) return false;
    return true;
  }

  function shouldNonParticipantClaim(summary) {
    // Only claim when the current user cannot be affected by the outcome.
    if (!summary.expired) return false;
    if (summary.unrevealed !== false) return false;
    if (summary.currentUserParticipant) return false;
    if (summary.winnerId === CURRENT_USER_ID) return false;
    const winnerName = String(summary.winnerName || "").trim().toLowerCase();
    if (winnerName === "nobody") return false;
    if (winnerName) return false;
    return true;
  }

  function shouldRefetchAfterClaim(summary) {
    // Refetch if still unrevealed to avoid persisting ambiguous state.
    return summary.unrevealed !== false;
  }

  function extractWinner(data) {
    if (!data || typeof data !== "object") return { winnerId: null, winnerName: null };
    const winner = data.winner;
    const rawId =
      typeof winner === "string" ? winner : winner?.id || winner?.userId || data.winnerId || null;
    const rawName = winner?.name || winner?.username || data.winnerName || null;
    return {
      winnerId: typeof rawId === "string" ? rawId.trim() : rawId,
      winnerName: typeof rawName === "string" ? rawName.trim() : rawName,
    };
  }

  function applyRaffleData(raffle, data) {
    if (!data || typeof data !== "object") return raffle;
    // Enrichment phase: merge API data into the canonical raffle shape.
    // We only set fields when the API provided something concrete.
    const next = { ...raffle };
    next.raffle = { ...(raffle.raffle || {}) };
    next.status = { ...(raffle.status || {}) };
    const setIfDefined = (obj, key, value) => {
      if (value === undefined || value === null) return;
      obj[key] = value;
    };

    const { winnerId, winnerName } = extractWinner(data);
    const owner = data.owner;
    const ownerId =
      typeof owner === "string" ? owner : owner?.id || owner?.userId || owner?.name || null;
    const ownerName = owner?.name || owner?.username || null;

    setIfDefined(next.raffle, "ownerId", ownerId);
    setIfDefined(next.raffle, "ownerName", ownerName);
    setIfDefined(next.raffle, "stickerId", data.stickerId || data.sticker?.id || null);
    setIfDefined(next.raffle, "stickerbook", data.stickerbook || data.sticker?.book || null);
    if (data.endTime !== undefined && data.endTime !== null) {
      setIfDefined(next.raffle, "endTime", toEpochSec(data.endTime));
    }
    if (data.stickerbookEndTime !== undefined && data.stickerbookEndTime !== null) {
      setIfDefined(next.raffle, "stickerbookEndTime", toEpochSec(data.stickerbookEndTime));
    }
    if (Array.isArray(data.participantIds)) {
      next.raffle.participantIds = data.participantIds;
      next.raffle.participantCount = data.participantIds.length;
    }
    if (data.unrevealedForCurrentUser !== undefined) {
      next.raffle.unrevealedForCurrentUser = data.unrevealedForCurrentUser;
    }
    if (winnerId || winnerName) {
      next.winner = { ...(raffle.winner || {}) };
      if (winnerId) next.winner.winnerId = winnerId;
      if (winnerName) next.winner.winnerName = winnerName;
      next.winner.winnerFetchedAt = nowSec();
    }
    const endTimeSec = toEpochSec(next.raffle?.endTime);
    const participants = next.raffle?.participantIds;
    const noParticipants = !Array.isArray(participants) || participants.length === 0;
    const noWinner = !(winnerId || winnerName);
    const onlyParticipantIsCurrentUser =
      Array.isArray(participants) &&
      participants.length === 1 &&
      CURRENT_USER_ID &&
      participants[0] === CURRENT_USER_ID;

    /***************************************************************************
     * Winner inference (ended + solo participant)
     *
     * If the raffle has ended, the API did not report a winner, and the only
     * participant id matches the current user, we treat this as a deterministic
     * win. This is a fallback for cases where getRaffleData returns empty
     * winner fields, and it will be overwritten later if an authoritative
     * winner appears in a future API payload.
     ***************************************************************************/
    if (endTimeSec && endTimeSec <= nowSec() && noWinner && onlyParticipantIsCurrentUser) {
      next.winner = { ...(next.winner || {}) };
      next.winner.winnerId = CURRENT_USER_ID;
      if (CURRENT_USER_NAME) next.winner.winnerName = CURRENT_USER_NAME;
      next.winner.winnerFetchedAt = nowSec();
    } else if (endTimeSec && endTimeSec <= nowSec() && noWinner && noParticipants) {
      next.winner = { ...(next.winner || {}) };
      next.winner.winnerName = "nobody";
      next.winner.winnerFetchedAt = nowSec();
    }
    noteStatusSuccess(next);
    next.status.lastFetchAt = nowSec();
    next.status.lastFetchStatus = "ok";
    next.status.phase = inferStatusPhase(next);
    next.updatedAt = nowSec();
    return next;
  }

  /***************************************************************************
   * raffle_enrichment.js
   *
   * Pure-ish transformations that apply API payloads to raffles. These
   * functions should not perform I/O or storage writes.
   ***************************************************************************/

  const raffleEnrichment = {
    extractWinner,
    applyGetRaffleData(raffle, data, stickerMap) {
      if (!data || typeof data !== "object") return raffle;
      const enriched = applyRaffleData(raffle, data);
      return normalizeStickerFields(enriched, stickerMap);
    },
  };

  /***************************************************************************
   * api_error.js
   *
   * Mark raffles as deleted when the API returns a hard 500 response.
   ***************************************************************************/

  function markRaffleDeleted(raffle, contextLabel) {
    if (!raffle || typeof raffle !== "object") return;
    const status = ensureRaffleStatus(raffle);
    const errorLabel = contextLabel ? `server-500:${contextLabel}` : "server-500";
    status.lastFetchStatus = "deleted";
    noteStatusError(raffle, "http-500", errorLabel);
    status.phase = "inactive";
    raffle.updatedAt = nowSec();
  }

  function markDeletedOnServerError(raffle, resp, contextLabel) {
    if (!resp || resp.status !== 500) return false;
    markRaffleDeleted(raffle, contextLabel);
    return true;
  }

  /***************************************************************************
   * raffle_status.js
   *
   * Helpers for determining when a raffle should be treated as inactive.
   * Inactive raffles stay in storage for review, but are skipped by auto
   * loops and separated in the expired UI list so they do not re-run.
   ***************************************************************************/

  /***************************************************************************
   * Status model:
   *
   * - status.phase is a *derived* concept, not a raw truth source.
   * - Winner presence always implies phase = "resolved".
   * - "inactive" is reserved for cases where transport/lastFetchStatus indicates
   *   the server refused access (401).
   *
   * Important:
   * - Do not set phase = "inactive" if a winner exists.
   * - Successful fetch should always clear stale transport/error indicators.
   ***************************************************************************/

  function ensureRaffleStatus(raffle) {
    if (!raffle || typeof raffle !== "object") return {};
    raffle.status = { ...(raffle.status || {}) };
    return raffle.status;
  }

  function inferStatusPhase(raffle) {
    if (!raffle || typeof raffle !== "object") return "discovered";
    const status = raffle.status || {};
    const hasWinner = hasRaffleWinner(raffle);
    if (hasWinner) return "resolved";
    if (status.phase === "inactive") return "inactive";
    if (status.phase === "claimed") return "claimed";
    if (isRaffleInactiveStatus(status.lastFetchStatus)) return "inactive";
    const endTime = toEpochSec(raffle.raffle?.endTime);
    if (endTime && endTime <= nowSec()) return "expired";
    return status.phase || "discovered";
  }

  function noteStatusAttempt(raffle) {
    const status = ensureRaffleStatus(raffle);
    status.lastAttemptAt = nowSec();
    return status;
  }

  function touchRaffle(raffle, reason) {
    if (!raffle || typeof raffle !== "object") return;
    raffle.updatedAt = nowSec();
    if (!reason) return;
    const status = ensureRaffleStatus(raffle);
    status.lastAttemptAt = status.lastAttemptAt || nowSec();
  }

  function noteStatusSuccess(raffle) {
    const status = ensureRaffleStatus(raffle);
    status.transport = "ok";
    status.lastAttemptAt = nowSec();
    status.lastSuccessAt = nowSec();
    status.lastFetchStatus = "ok";
    delete status.lastError;
    delete status.lastErrorAt;
    if (status.phase === "inactive") delete status.phase;
    return status;
  }

  function noteStatusError(raffle, transport, errorLabel) {
    const status = ensureRaffleStatus(raffle);
    if (transport) status.transport = transport;
    status.lastAttemptAt = nowSec();
    status.lastErrorAt = nowSec();
    if (errorLabel) status.lastError = errorLabel;
    return status;
  }

  function mapTransportFromHttpStatus(status) {
    if (status === 401) return "http-401";
    if (status === 500) return "http-500";
    return "http-500";
  }

  function mapTransportFromError(error) {
    const raw = String(error || "").toLowerCase();
    if (raw.includes("timeout")) return "timeout";
    if (raw.includes("network")) return "network-error";
    return "network-error";
  }

  function noteStatusFromResponse(raffle, resp, contextLabel) {
    if (!resp) return;
    if (resp.status >= 200 && resp.status < 300) {
      noteStatusSuccess(raffle);
      return;
    }
    if (resp.status) {
      noteStatusError(
        raffle,
        mapTransportFromHttpStatus(resp.status),
        contextLabel ? `${contextLabel}:http-${resp.status}` : `http-${resp.status}`,
      );
      return;
    }
    if (resp.error) {
      noteStatusError(
        raffle,
        mapTransportFromError(resp.error),
        contextLabel ? `${contextLabel}:${resp.error}` : String(resp.error),
      );
    }
  }

  const INACTIVE_RAFFLE_STATUSES = new Set(["deleted", "http-401"]);

  function isRaffleInactiveStatus(status) {
    if (!status) return false;
    return INACTIVE_RAFFLE_STATUSES.has(status);
  }

  function hasRaffleWinner(raffle) {
    return Boolean(
      raffle?.winner?.winnerId ||
        raffle?.winner?.winnerName ||
        raffle?.winnerId ||
        raffle?.winnerName,
    );
  }

  function isRaffleInactive(raffle) {
    if (hasRaffleWinner(raffle)) return false;
    if (raffle?.status?.phase === "inactive") return true;
    return isRaffleInactiveStatus(raffle?.status?.lastFetchStatus);
  }

  function isRaffleInactiveForUi(raffle) {
    if (hasRaffleWinner(raffle)) return false;
    return getStatusTransport(raffle) === "http-401";
  }

  function getStatusPhase(raffle) {
    if (!raffle || typeof raffle !== "object") return "discovered";
    return inferStatusPhase(raffle);
  }

  function inferTransportFromLegacyStatus(status) {
    if (!status || typeof status !== "object") return "";
    const legacy = status.lastFetchStatus;
    if (!legacy) return "";
    if (String(legacy).startsWith("http-")) {
      const code = Number(String(legacy).replace("http-", ""));
      return mapTransportFromHttpStatus(Number.isFinite(code) ? code : 500);
    }
    if (legacy === "deleted") return "http-500";
    if (legacy === "error") {
      return mapTransportFromError(status.lastError || "");
    }
    if (legacy === "no-token") return "network-error";
    if (legacy === "unable-to-resolve") return "network-error";
    if (legacy === "ok") return "ok";
    return "";
  }

  function getStatusTransport(raffle) {
    if (!raffle || typeof raffle !== "object") return "ok";
    if (raffle.status?.transport) return raffle.status.transport;
    const legacy = inferTransportFromLegacyStatus(raffle.status || {});
    return legacy || "ok";
  }

  /***************************************************************************
   * status_migration.js
   *
   * Backfill new status fields for existing raffle entries. This is a
   * one-time migration so older storage snapshots are compatible with the
   * new phase/transport model.
   ***************************************************************************/

  function backfillStatusFieldsOnce() {
    const settings = loadSettings();
    const migrations = settings.migrations || {};
    if (migrations.statusPhaseV1) return;

    const batch = raffleStore.beginBatch("status-backfill");
    const dayKeys = raffleStore.listDayKeys(batch);
    let updated = 0;

    for (const dayKey of dayKeys) {
      const raffles = raffleStore.listByDay(dayKey, batch);
      for (const raffle of raffles) {
        if (!raffle || typeof raffle !== "object") continue;
        const status = ensureRaffleStatus(raffle);
        let changed = false;

        if (!status.phase) {
          status.phase = inferStatusPhase(raffle);
          changed = true;
        }
        if (!status.transport) {
          const transport = inferTransportFromLegacyStatus(status);
          if (transport) {
            status.transport = transport;
            changed = true;
          }
        }
        if (!status.lastAttemptAt) {
          if (status.lastFetchAt) {
            status.lastAttemptAt = status.lastFetchAt;
            changed = true;
          } else if (status.lastErrorAt) {
            status.lastAttemptAt = status.lastErrorAt;
            changed = true;
          }
        }
        if (!status.lastSuccessAt && status.lastFetchStatus === "ok" && status.lastFetchAt) {
          status.lastSuccessAt = status.lastFetchAt;
          changed = true;
        }

        if (changed) {
          raffle.updatedAt = nowSec();
          raffleStore.put(raffle, batch);
          updated += 1;
        }
      }
    }

    batch.flush();
    saveSettings({
      ...settings,
      migrations: { ...migrations, statusPhaseV1: nowSec() },
    });
    debugLog("storage", "Backfilled status fields", { updated, days: dayKeys.length });
  }

  function claimRaffle(raffle) {
    const token = raffle?.token?.webbitToken || "";
    if (!token) return Promise.resolve({ status: 0, data: null, error: "missing token" });
    const origin = getOriginFromWebviewUrl(raffle?.token?.webviewUrl);
    const url = `${origin}${CLAIM_RAFFLE_PATH}`;
    logHttp("GET", url);
    return gmRequestJson({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }


  /***************************************************************************
   * discovery.js
   *
   * Fetch the flair feed with pagination and store new/updated raffles.
   ***************************************************************************/

  async function fetchFeedAndStore() {
    const store = loadStore({ includeRaffles: false });
    let updated = 0;
    let totalLoaders = 0;
    let stoppedEarly = false;
    const parseLoadersFromDoc = (doc) => {
      const loaders = Array.from(doc.querySelectorAll("shreddit-devvit-ui-loader"));
      totalLoaders += loaders.length;
      debugLog("discovery", "Loaders found on page", loaders.length);
      let pageAdded = 0;
      for (const loader of loaders) {
        const postId = getAttr(loader, "postId", "postid");
        const existing = postId ? raffleStore.get(postId) : null;
        const raffle = normalizeRaffleFromFeed(loader, store, existing);
        if (!raffle) continue;
        raffleStore.put(raffle);
        updated += 1;
        if (!existing) {
          pageAdded += 1;
        }
      }
      return pageAdded;
    };
    // Pagination keeps pulling older pages until Reddit gives us no cursor.
    let pageUrl = FEED_URL;
    let pageCount = 0;
    while (pageUrl) {
      pageCount += 1;
      if (pageCount > MAX_FEED_PAGES) {
        warnLog("Feed pagination stopped at max pages", MAX_FEED_PAGES);
        break;
      }
      debugLog("discovery", "Fetching page", { pageCount, pageUrl });
      const html = await fetchHtml(pageUrl);
      if (!html) break;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const pageAdded = parseLoadersFromDoc(doc);
      if (pageAdded === 0) {
        debugLog("discovery", "No new raffles on page; stopping pagination");
        stoppedEarly = true;
        pageUrl = "";
        break;
      }
      const nextPage = extractNextPageUrl(doc);
      debugLog("discovery", "Next page", nextPage || "(none)");
      pageUrl = nextPage ? resolveRedditUrl(nextPage) : "";
      if (pageUrl) {
        await new Promise((resolve) => setTimeout(resolve, FEED_PAGE_DELAY_MS));
      }
    }
    debugLog("discovery", "Feed parsed", {
      pagesFetched: pageCount,
      loadersSeen: totalLoaders,
      newRaffles: updated,
      stoppedEarly,
    });
    appendDebugLog("feed-summary", {
      pagesFetched: pageCount,
      loadersSeen: totalLoaders,
      newRaffles: updated,
      stoppedEarly,
    });
    ui.invalidate("feed:fetch");
    assertRaffleStoreInvariants("feed");
  }

  /***************************************************************************
   * album_bootstrap.js
   *
   * Manual, intentional album bootstrap. This fetches the stickerbook once,
   * stores the canonical sticker map, and re-links existing raffles so the
   * UI can display stars and names without guessing.
   ***************************************************************************/

  function findAnyRaffleToken() {
    const dayKeys = raffleStore.listDayKeys();
    for (const dayKey of dayKeys) {
      const raffles = raffleStore.listByDay(dayKey);
      for (let raffle of raffles) {
        const token = raffle?.token?.webbitToken;
        if (!token) continue;
        const origin = getOriginFromWebviewUrl(raffle?.token?.webviewUrl);
        return { token, origin };
      }
    }
    return null;
  }

  function buildStickerMapForBook(data, stickerbookId) {
    if (!data || typeof data !== "object") return null;
    const book = data[stickerbookId];
    if (!book || typeof book !== "object") return null;
    const map = {};
    for (const [stickerId, entry] of Object.entries(book)) {
      if (!entry || typeof entry !== "object") continue;
      const name = entry.localizedName || null;
      const tier = Number(entry.tier);
      map[stickerId] = {
        stickerName: name,
        stickerStars: Number.isFinite(tier) ? tier : null,
      };
    }
    return map;
  }

  async function startNewAlbumBootstrap() {
    const store = loadStore({ includeRaffles: false });
    const tokenInfo = findAnyRaffleToken();
    if (!tokenInfo) {
      alert("No raffle token available to fetch stickerbook.");
      return;
    }

    const requestedId = prompt("Enter stickerbook ID:", store.activeStickerbookId || "");
    if (requestedId === null) return;
    const stickerbookId = String(requestedId).trim();
    if (!stickerbookId) {
      alert("Stickerbook ID is required.");
      return;
    }

    const resp = await gmRequestJson({
      url: `${tokenInfo.origin}${STICKERBOOK_PATH}`,
      headers: {
        Authorization: `Bearer ${tokenInfo.token}`,
        Accept: "application/json",
      },
    });

    if (!(resp?.status >= 200 && resp?.status < 300) || !resp.data) {
      alert(`Stickerbook fetch failed (${resp?.status || 0}).`);
      return;
    }

    const stickerMap = buildStickerMapForBook(resp.data, stickerbookId);
    if (!stickerMap) {
      alert(`Stickerbook "${stickerbookId}" not found in response.`);
      return;
    }

    store.activeStickerbookId = stickerbookId;
    store.stickerMap = stickerMap;
    saveStoreMeta(store);

    const dayKeys = raffleStore.listDayKeys();
    let updated = 0;
    for (const dayKey of dayKeys) {
      const raffles = raffleStore.listByDay(dayKey);
      for (const raffle of raffles) {
        if (!raffle || typeof raffle !== "object") continue;
        const stickerId = raffle.raffle?.stickerId;
        if (!stickerId) continue;
        const entry = stickerMap[stickerId];
        if (!entry) continue;
        raffle.raffle = { ...(raffle.raffle || {}) };
        raffle.raffle.stickerName = entry.stickerName || raffle.raffle.stickerName || null;
        if (entry.stickerStars !== null && entry.stickerStars !== undefined) {
          raffle.raffle.stickerStars = entry.stickerStars;
        }
        raffle.updatedAt = nowSec();
        updated += 1;
        raffleStore.put(raffle);
      }
    }

    alert("Stickerbook loaded. Raffles updated.");
    debugLog("storage", "Stickerbook loaded", {
      stickerbookId,
      entries: Object.keys(stickerMap).length,
      rafflesUpdated: updated,
    });
    ui.invalidate("album:stickerbook");
  }

  function getCurrentUserIdFromRaffles(raffles) {
    if (CURRENT_USER_ID) return CURRENT_USER_ID;
    for (const raffle of raffles) {
      const webViewUserId = raffle?.feed?.webViewClientData?.userId;
      if (webViewUserId) return webViewUserId;
      const signedContext = raffle?.feed?.signedRequestContext;
      if (signedContext) {
        const parsed = safeJsonParse(signedContext);
        const candidate =
          parsed?.userId || parsed?.user?.id || parsed?.user?.userId || parsed?.context?.userId;
        if (candidate) return candidate;
      }
    }
    return null;
  }

  function isRaffleEntered(raffle) {
    return Boolean(raffle?.entry?.entered);
  }

  /***************************************************************************
   * piggybank_policy.js
   *
   * Auto-claim should never claim 5★ wins. We treat 5★ (and unknown stars)
   * as "do not auto-claim" so those raffles are left untouched for manual
   * claiming via the Piggybank tab. This keeps high-value wins safe.
   ***************************************************************************/

  function resolveStickerStars(raffle, stickerMap) {
    const direct = raffle?.raffle?.stickerStars;
    if (direct !== undefined && direct !== null && direct !== "") {
      const numeric = Number(direct);
      return Number.isFinite(numeric) ? numeric : null;
    }
    const stickerId = raffle?.raffle?.stickerId;
    const mapped = stickerId ? stickerMap?.[stickerId]?.stickerStars : null;
    if (mapped !== undefined && mapped !== null && mapped !== "") {
      const numeric = Number(mapped);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  /***************************************************************************
   * expired_engine.js
   *
   * Policy engine for expired raffles: scan -> resolve -> claim. This module
   * owns the background logic and writes results through raffleStore only.
   *
   * High-level flow:
   * 1) Scan all buckets for expired raffles
   * 2) Skip inactive + already-resolved winners
   * 3) If auto-claim is disabled or policy forbids (5★), only refresh data
   * 4) If auto-claim is allowed, attempt claim -> optionally refresh
   * 5) Persist after every mutation
   *
   * Design constraints:
   * - Must be idempotent across runs
   * - Must never treat heuristic fields as final for claiming
   * - Must persist each raffle immediately to avoid losing progress on crash
   ***************************************************************************/

  const expiredEngine = {
    async autoRefresh() {
      const store = loadStore({ includeRaffles: false });
      const dayKeys = raffleStore.listDayKeys();
      const now = nowSec();
        const summary = {
          scanned: 0,
          expired: 0,
          candidates: 0,
          skippedWithWinner: 0,
          skippedFiveStar: 0,
          skippedUnknownStars: 0,
          claimed: 0,
          missingToken: 0,
          errors: 0,
          getRaffleDataAttempts: 0,
          getRaffleDataSuccess: 0,
        claimAttempts: 0,
        claimSuccess: 0,
      };
      let crashed = null;

      const persistExpiredAuto = (raffle, dayKey, note) => {
        touchRaffle(raffle, "expired:auto");
        console.log("[FMV:expired:auto:stage]", {
          dayKey,
          postId: raffle.postId,
          winnerId: raffle?.winner?.winnerId || null,
          winnerName: raffle?.winner?.winnerName || null,
          unrevealed: raffle?.raffle?.unrevealedForCurrentUser ?? null,
          note: note || null,
        });
        sheetsSync.enqueueFromRaffle(raffle, `expired:auto:${note || "stage"}`);
        raffleStore.put(raffle);
      };

      try {
        for (const dayKey of dayKeys) {
          const raffles = raffleStore.listByDay(dayKey);
          for (const raffle of raffles) {
            if (!raffle || typeof raffle !== "object") continue;
            summary.scanned += 1;
            if (isRaffleInactive(raffle)) continue;
            const endTime = toEpochSec(raffle.raffle?.endTime);
            if (!endTime || endTime > now) continue;
            summary.expired += 1;
            const hasWinner = Boolean(
              raffle.winner?.winnerId ||
                raffle.winner?.winnerName ||
                raffle.winnerId ||
                raffle.winnerName,
            );
            if (hasWinner) {
              summary.skippedWithWinner += 1;
              continue;
            }
            summary.candidates += 1;
            const stickerStars = resolveStickerStars(raffle, store.stickerMap);
            const isFiveStar = stickerStars === 5;
            const skipAutoClaim = !autoClaimWins || isFiveStar || stickerStars === null;
            if (isFiveStar) {
              summary.skippedFiveStar += 1;
            } else if (autoClaimWins && stickerStars === null) {
              summary.skippedUnknownStars += 1;
            }
            const claimSkipNote = !autoClaimWins
              ? "auto-claim-disabled"
              : isFiveStar
                ? "auto-claim-disabled-5star"
                : "auto-claim-disabled-unknown-stars";

            await ensureToken(raffle);

            if (!raffle.token?.webbitToken) {
              summary.missingToken += 1;
              const status = ensureRaffleStatus(raffle);
              status.lastFetchStatus = "no-token";
              status.lastError = "claimRaffle";
              status.lastErrorAt = nowSec();
              noteStatusError(raffle, "network-error", status.lastError);
              status.phase = inferStatusPhase(raffle);
              persistExpiredAuto(raffle, dayKey, "no-token");
              continue;
            }

            summary.getRaffleDataAttempts += 1;
            const { resp: dataResp, deleted: dataDeleted } = await runRaffleRequest(
              raffle,
              fetchRaffleData,
              "getRaffleData",
            );
            console.log("[FMV:expired:auto:getRaffleData]", {
              postId: raffle.postId,
              sticker: raffle.raffle?.stickerName || raffle.postTitle || "(unknown)",
              status: dataResp?.status || 0,
              deleted: dataDeleted || false,
              payload: dataResp?.data || null,
              error: dataResp?.error || null,
              note: claimSkipNote,
            });
            if (dataDeleted) {
              warnLog("getRaffleData marked deleted (500)", raffle.postId);
              summary.errors += 1;
              persistExpiredAuto(raffle, dayKey, "data-500");
              continue;
            }
            if (dataResp?.status >= 200 && dataResp?.status < 300 && dataResp.data) {
              const autoClaimEligible = autoClaimWins && !isFiveStar && stickerStars !== null;
              const result = applyGetRaffleDataResult(raffle, dataResp, store, "getRaffleData");
              const localSummary = result.summary;
              if (result.applied) {
                if (shouldAutoClaimWinner(localSummary, { autoClaimWins: autoClaimEligible })) {
                  const { resp: claimResp } = await runRaffleRequest(
                    raffle,
                    claimRaffle,
                    "claimRaffle",
                  );
                  touchRaffle(raffle, "claimRaffle:auto");
                  raffleStore.put(raffle);
                  if (claimResp?.status >= 200 && claimResp?.status < 300) {
                    if (shouldRefetchAfterClaim(localSummary)) {
                      const { resp: followResp } = await runRaffleRequest(
                        raffle,
                        fetchRaffleData,
                        "getRaffleData",
                      );
                      if (followResp?.status >= 200 && followResp?.status < 300 && followResp.data) {
                        applyGetRaffleDataResult(raffle, followResp, store, "getRaffleData");
                      }
                    }
                  }
                } else if (shouldNonParticipantClaim(localSummary)) {
                  await runRaffleRequest(raffle, claimRaffle, "claimRaffle");
                  touchRaffle(raffle, "claimRaffle:nonparticipant");
                  raffleStore.put(raffle);
                }
              }
              summary.getRaffleDataSuccess += 1;
              persistExpiredAuto(raffle, dayKey, autoClaimEligible ? "data" : "data-no-claim");
              continue;
            }
            if (dataResp?.status) {
              const status = ensureRaffleStatus(raffle);
              status.lastFetchStatus = `http-${dataResp.status}`;
              status.lastError = "getRaffleData";
              status.lastErrorAt = nowSec();
              noteStatusError(
                raffle,
                mapTransportFromHttpStatus(dataResp.status),
                status.lastError,
              );
              status.phase = inferStatusPhase(raffle);
              summary.errors += 1;
              persistExpiredAuto(raffle, dayKey, "data-http");
              continue;
            }
            if (dataResp?.error) {
              const status = ensureRaffleStatus(raffle);
              status.lastFetchStatus = "error";
              status.lastError = `getRaffleData:${dataResp.error}`;
              status.lastErrorAt = nowSec();
              noteStatusError(
                raffle,
                mapTransportFromError(dataResp.error),
                status.lastError,
              );
              status.phase = inferStatusPhase(raffle);
              summary.errors += 1;
              persistExpiredAuto(raffle, dayKey, "data-error");
              continue;
            }
            persistExpiredAuto(raffle, dayKey, "data-none");
          }
        }
      } catch (err) {
        crashed = err;
        summary.errors += 1;
        errorLog("Expired refresh crashed", err);
      } finally {
        debugLog("actions", "Expired refresh complete", {
          ...summary,
          crashed: crashed ? String(crashed) : null,
        });
        appendDebugLog("expired-auto", {
          ...summary,
          autoClaimWins,
          crashed: crashed ? String(crashed) : null,
        });
        ui.invalidate("expired:auto");
        assertRaffleStoreInvariants("expired:auto");
        if (SHEETS_AUTO_SYNC) {
          try {
            const syncResult = await sheetsSync.flush({ force: false, reason: "expired:auto" });
            debugLog("actions", "Sheets auto-sync (expired:auto)", syncResult);
          } catch (err) {
            warnLog("Sheets auto-sync failed (expired:auto)", err);
          }
        }
      }

      return summary;
    },

    async runManualAction(action, raffles, options = {}) {
      const store = loadStore({ includeRaffles: false });
      const delayMs = Number.isFinite(Number(options.delayMs))
        ? Math.max(0, Number(options.delayMs))
        : 0;
      const skipFiveStarClaim = options.skipFiveStarClaim !== false;
      const invalidate = options.invalidate !== false;
      const total = raffles.length;
      let index = 0;
      let skippedFiveStar = false;
      const summary = {
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
      };

      for (const raffle of raffles) {
        index += 1;
        if (!raffle || !raffle.postId) continue;
        summary.processed += 1;

        if (action === "refresh-token") {
          const refreshed = await ensureToken(raffle);
          if (refreshed.ok && refreshed.refreshed) {
            summary.updated += 1;
          }
          console.log("[FMV:expired:refreshToken]", {
            postId: raffle.postId,
            progress: `${index}/${total}`,
            sticker: raffle.raffle?.stickerName || raffle.postTitle || "(unknown)",
            updated: refreshed.refreshed,
          });
        } else if (action === "getRaffleData") {
          const { resp, deleted } = await runRaffleRequest(raffle, fetchRaffleData, "getRaffleData");
          console.log("[FMV:expired:getRaffleData]", {
            postId: raffle.postId,
            progress: `${index}/${total}`,
            sticker: raffle.raffle?.stickerName || raffle.postTitle || "(unknown)",
            status: resp?.status || 0,
            deleted,
            payload: resp?.data || null,
            error: resp?.error || null,
          });
          if (deleted) {
            warnLog("getRaffleData marked deleted (500)", raffle.postId);
            summary.errors += 1;
          } else if (resp?.status >= 200 && resp?.status < 300 && resp?.data) {
            const result = applyGetRaffleDataResult(raffle, resp, store, "getRaffleData");
            const localSummary = result.summary;
            if (result.applied) {
              if (shouldAutoClaimWinner(localSummary, { autoClaimWins })) {
                const { resp: claimResp } = await runRaffleRequest(
                  raffle,
                  claimRaffle,
                  "claimRaffle",
                );
                touchRaffle(raffle, "claimRaffle:auto");
                raffleStore.put(raffle);
                if (
                  claimResp?.status >= 200 &&
                  claimResp?.status < 300 &&
                  shouldRefetchAfterClaim(localSummary)
                ) {
                  const { resp: followResp } = await runRaffleRequest(
                    raffle,
                    fetchRaffleData,
                    "getRaffleData",
                  );
                  if (
                    followResp?.status >= 200 &&
                    followResp?.status < 300 &&
                    followResp.data
                  ) {
                    applyGetRaffleDataResult(raffle, followResp, store, "getRaffleData");
                  }
                }
              } else if (shouldNonParticipantClaim(localSummary)) {
                await runRaffleRequest(raffle, claimRaffle, "claimRaffle");
                touchRaffle(raffle, "claimRaffle:nonparticipant");
                raffleStore.put(raffle);
              }
            }
            summary.updated += 1;
          } else if (resp?.status) {
            const status = ensureRaffleStatus(raffle);
            status.lastFetchStatus = `http-${resp.status}`;
            status.lastError = "getRaffleData";
            status.lastErrorAt = nowSec();
            noteStatusError(
              raffle,
              mapTransportFromHttpStatus(resp.status),
              status.lastError,
            );
            status.phase = inferStatusPhase(raffle);
            summary.errors += 1;
          } else if (resp?.error) {
            warnLog("getRaffleData failed", raffle.postId, resp.error);
            summary.errors += 1;
          }
        } else if (action === "claimRaffle") {
          const stars = Number(raffle.raffle?.stickerStars);
          if (skipFiveStarClaim && stars === 5) {
            debugLog("actions", "Skipped 5★ claim on expired tab", raffle.postId);
            console.log("[FMV:expired:claimRaffle]", {
              postId: raffle.postId,
              progress: `${index}/${total}`,
              sticker: raffle.raffle?.stickerName || raffle.postTitle || "(unknown)",
              status: "skipped-5-star",
              deleted: false,
              payload: null,
              error: null,
            });
            skippedFiveStar = true;
            summary.skipped += 1;
          } else {
            const { resp, deleted } = await runRaffleRequest(raffle, claimRaffle, "claimRaffle");
            console.log("[FMV:expired:claimRaffle]", {
              postId: raffle.postId,
              progress: `${index}/${total}`,
              sticker: raffle.raffle?.stickerName || raffle.postTitle || "(unknown)",
              status: resp?.status || 0,
              deleted,
              payload: resp?.data || null,
              error: resp?.error || null,
            });
            if (deleted) {
              warnLog("claimRaffle marked deleted (500)", raffle.postId);
              summary.errors += 1;
            } else if (resp?.status >= 200 && resp?.status < 300) {
              if (raffle.raffle?.unrevealedForCurrentUser !== false) {
                const { resp: dataResp, deleted: dataDeleted } = await runRaffleRequest(
                  raffle,
                  fetchRaffleData,
                  "getRaffleData",
                );
                console.log("[FMV:expired:getRaffleData]", {
                  postId: raffle.postId,
                  progress: `${index}/${total}`,
                  sticker: raffle.raffle?.stickerName || raffle.postTitle || "(unknown)",
                  status: dataResp?.status || 0,
                  deleted: dataDeleted,
                  payload: dataResp?.data || null,
                  error: dataResp?.error || null,
                });
                if (dataDeleted) {
                  warnLog("getRaffleData marked deleted (500)", raffle.postId);
                  summary.errors += 1;
                } else if (dataResp?.status >= 200 && dataResp?.status < 300 && dataResp?.data) {
                  applyGetRaffleDataResult(raffle, dataResp, store, "getRaffleData");
                  summary.updated += 1;
                } else if (dataResp?.status) {
                  const status = ensureRaffleStatus(raffle);
                  status.lastFetchStatus = `http-${dataResp.status}`;
                  status.lastError = "getRaffleData";
                  status.lastErrorAt = nowSec();
                  noteStatusError(
                    raffle,
                    mapTransportFromHttpStatus(dataResp.status),
                    status.lastError,
                  );
                  status.phase = inferStatusPhase(raffle);
                  summary.errors += 1;
                } else if (dataResp?.error) {
                  warnLog("getRaffleData failed", raffle.postId, dataResp.error);
                  summary.errors += 1;
                }
              }
            } else if (resp?.status) {
              const status = ensureRaffleStatus(raffle);
              status.lastFetchStatus = `http-${resp.status}`;
              status.lastError = "claimRaffle";
              status.lastErrorAt = nowSec();
              noteStatusError(
                raffle,
                mapTransportFromHttpStatus(resp.status),
                status.lastError,
              );
              status.phase = inferStatusPhase(raffle);
              summary.errors += 1;
            } else if (resp?.error) {
              warnLog("claimRaffle failed", raffle.postId, resp.error);
              summary.errors += 1;
            }
          }
        }

        touchRaffle(raffle, `expired:${action}`);
        sheetsSync.enqueueFromRaffle(raffle, `expired:${action}`);
        raffleStore.put(raffle);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      if (invalidate) {
        ui.invalidate(`expired:${action}`);
      }
      if (SHEETS_AUTO_SYNC) {
        try {
          const syncResult = await sheetsSync.flush({ force: false, reason: `expired:${action}` });
          debugLog("actions", `Sheets auto-sync (expired:${action})`, syncResult);
        } catch (err) {
          warnLog("Sheets auto-sync failed", err);
        }
      }

      return {
        ...summary,
        statusMessage: skippedFiveStar
          ? "Skipped 5★ raffle on claim (use Piggybank tab)."
          : "",
      };
    },
  };

  /***************************************************************************
   * forced_settle.js
   *
   * Manually retry winner resolution for a specific day bucket, ignoring
   * previous status markers like deleted. If still missing after retry,
   * mark as unable-to-resolve.
   ***************************************************************************/

  async function forceResolveWinnersForDayPrompt(defaultDayKey = "") {
    const seed = defaultDayKey && defaultDayKey !== "all" ? defaultDayKey : "";
    const raw = prompt("Force-settle winners for date (YYYY-MM-DD):", seed);
    if (raw === null) return;
    const dayKey = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      warnLog("Invalid date format for force-settle.");
      return;
    }

    const store = loadStore({ includeRaffles: false });
    const entries = raffleStore.listByDay(dayKey);
    const summary = {
      scanned: 0,
      missingWinner: 0,
      refreshed: 0,
      updated: 0,
      unable: 0,
      missingToken: 0,
      errors: 0,
    };

    debugLog("actions", "Force-settle starting", { dayKey, count: entries.length });

    for (const raffle of entries) {
      if (!raffle || typeof raffle !== "object") continue;
      summary.scanned += 1;
      const hasWinner = Boolean(raffle.winner?.winnerId || raffle.winner?.winnerName);
      if (hasWinner) continue;
      summary.missingWinner += 1;
      debugLog("actions", "Force-settle checking raffle", raffle.postId);

      const tryFetch = async () => {
        await ensureToken(raffle);
        if (!raffle.token?.webbitToken) {
          summary.missingToken += 1;
          warnLog("Force-settle missing token", raffle.postId);
          return { ok: false, resp: null, deleted: false };
        }
        const { resp, deleted } = await runRaffleRequest(
          raffle,
          fetchRaffleData,
          "force-settle",
        );
        if (deleted) {
          warnLog("Force-settle marked deleted (500)", raffle.postId);
        }
        return { ok: Boolean(resp?.status >= 200 && resp?.status < 300 && resp.data), resp, deleted };
      };

      let result = await tryFetch();
      if (!result.ok) {
        summary.refreshed += 1;
        await ensureToken(raffle);
        result = await tryFetch();
      }

      if (result.ok && result.resp?.data) {
        const extracted = extractWinner(result.resp.data);
        const unrevealed =
          result.resp.data?.unrevealedForCurrentUser === true ||
          raffle.raffle?.unrevealedForCurrentUser === true;
        const applied = applyGetRaffleDataResult(raffle, result.resp, store, "getRaffleData");
        const localSummary = applied.summary;
        if (applied.applied) {
          if (shouldAutoClaimWinner(localSummary, { autoClaimWins })) {
            const { resp: claimResp } = await runRaffleRequest(
              raffle,
              claimRaffle,
              "claimRaffle",
            );
            touchRaffle(raffle, "claimRaffle:auto");
            raffleStore.put(raffle);
            if (
              claimResp?.status >= 200 &&
              claimResp?.status < 300 &&
              shouldRefetchAfterClaim(localSummary)
            ) {
              const { resp: followResp } = await runRaffleRequest(
                raffle,
                fetchRaffleData,
                "getRaffleData",
              );
              if (followResp?.status >= 200 && followResp?.status < 300 && followResp.data) {
                applyGetRaffleDataResult(raffle, followResp, store, "getRaffleData");
              }
            }
          } else if (shouldNonParticipantClaim(localSummary)) {
            await runRaffleRequest(raffle, claimRaffle, "claimRaffle");
            touchRaffle(raffle, "claimRaffle:nonparticipant");
            raffleStore.put(raffle);
          }
        }
        const hasWinnerNow = Boolean(raffle.winner?.winnerId || raffle.winner?.winnerName);
        if (hasWinnerNow) {
          summary.updated += 1;
          debugLog("actions", "Force-settle resolved winner", {
            postId: raffle.postId,
            winnerId: raffle.winner?.winnerId || null,
            winnerName: raffle.winner?.winnerName || null,
          });
        } else {
          if (unrevealed && raffle.token?.webbitToken) {
            debugLog("actions", "Force-settle claiming to reveal winner", raffle.postId);
            const { resp: claimResp, deleted: claimDeleted } = await runRaffleRequest(
              raffle,
              claimRaffle,
              "force-settle-claim",
            );
            if (claimDeleted) {
              warnLog("Force-settle claim marked deleted (500)", raffle.postId);
            } else if (claimResp?.status >= 200 && claimResp?.status < 300) {
              raffle.raffle = { ...(raffle.raffle || {}) };
              raffle.raffle.unrevealedForCurrentUser = false;
            } else if (claimResp?.status) {
              warnLog(
                "Force-settle claim failed",
                raffle.postId,
                claimResp.status,
                claimResp.error || claimResp.text || "unknown",
              );
            }
            const claimFetch = await tryFetch();
            if (claimFetch.ok && claimFetch.resp?.data) {
              applyGetRaffleDataResult(raffle, claimFetch.resp, store, "getRaffleData");
            }
          }
          if (extracted.winnerId || extracted.winnerName) {
            raffle.winner = { ...(raffle.winner || {}) };
            if (extracted.winnerId) raffle.winner.winnerId = extracted.winnerId;
            if (extracted.winnerName) raffle.winner.winnerName = extracted.winnerName;
            raffle.winner.winnerFetchedAt = nowSec();
          }
          const hasWinnerAfterFallback = Boolean(
            raffle.winner?.winnerId || raffle.winner?.winnerName,
          );
          if (hasWinnerAfterFallback) {
            summary.updated += 1;
            debugLog("actions", "Force-settle resolved winner (fallback)", {
              postId: raffle.postId,
              winnerId: raffle.winner?.winnerId || null,
              winnerName: raffle.winner?.winnerName || null,
            });
          } else {
            const status = ensureRaffleStatus(raffle);
            status.lastFetchStatus = "unable-to-resolve";
            status.lastError = "force-settle:no-winner";
            status.lastErrorAt = nowSec();
            noteStatusError(raffle, "network-error", status.lastError);
            status.phase = inferStatusPhase(raffle);
            summary.unable += 1;
            warnLog("Force-settle missing winner after fetch", raffle.postId);
            debugLog("actions", "Force-settle no-winner payload", {
              postId: raffle.postId,
              data: result.resp?.data || null,
            });
            debugLog("actions", "Force-settle winner extract", {
              postId: raffle.postId,
              extracted,
              rawWinner: result.resp?.data?.winner || null,
            });
          }
        }
      } else {
        if (result.resp?.status) {
          const status = ensureRaffleStatus(raffle);
          status.lastFetchStatus = "unable-to-resolve";
          status.lastError = `force-settle:http-${result.resp.status}`;
          status.lastErrorAt = nowSec();
          noteStatusError(
            raffle,
            mapTransportFromHttpStatus(result.resp.status),
            status.lastError,
          );
          status.phase = inferStatusPhase(raffle);
        } else {
          const status = ensureRaffleStatus(raffle);
          status.lastFetchStatus = "unable-to-resolve";
          status.lastError = "force-settle:no-data";
          status.lastErrorAt = nowSec();
          noteStatusError(raffle, "network-error", status.lastError);
          status.phase = inferStatusPhase(raffle);
        }
        summary.unable += 1;
        summary.errors += 1;
        warnLog("Force-settle unable to resolve", raffle.postId, result.resp?.status || "no-data");
      }

      touchRaffle(raffle, "force-settle");
      raffleStore.put(raffle);
    }

    debugLog("actions", "Force-settle winners complete", { dayKey, ...summary });
    ui.invalidate("force-settle");
    alert(
      `Force-settle done for ${dayKey}.\\n` +
        `Scanned: ${summary.scanned}\\n` +
        `Missing winners: ${summary.missingWinner}\\n` +
        `Updated: ${summary.updated}\\n` +
        `Unable: ${summary.unable}`,
    );
  }

  /***************************************************************************
   * restore_snapshot.js
   *
   * Restore 5★ winners from a snapshot JSON file into TM storage.
   ***************************************************************************/

  function restoreFiveStarWinnersFromSnapshotPrompt() {
    const raw = prompt("Restore 5★ winners for date (YYYY-MM-DD):", "");
    if (raw === null) return;
    const dayKey = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      warnLog("Invalid date format for restore.");
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const bucket = parsed[`fmvTracker:raffles:${dayKey}`];
          if (!bucket || typeof bucket !== "object") {
            warnLog("Restore snapshot missing day bucket", dayKey);
            return;
          }

          const batch = raffleStore.beginBatch("restore-5star");
          let restored = 0;

          for (const raffle of Object.values(bucket)) {
            if (!raffle || typeof raffle !== "object") continue;
            const stars = Number(raffle.raffle?.stickerStars);
            if (stars !== 5) continue;
            const winnerId = raffle.winner?.winnerId || raffle.winnerId || null;
            const winnerName = raffle.winner?.winnerName || raffle.winnerName || null;
            if (!winnerId && !winnerName) continue;
            raffleStore.put(raffle, batch);
            restored += 1;
          }

          batch.flush();
          debugLog("storage", "Restored 5★ winners from snapshot", {
            dayKey,
            restored,
          });
          ui.invalidate("restore:5star");
          alert(`Restored ${restored} 5★ winners for ${dayKey}.`);
        } catch (err) {
          errorLog("Restore snapshot failed", err);
        }
      };
      reader.readAsText(file);
    });

    input.click();
  }

  /***************************************************************************
   * scheduler.js
   *
   * Boss tab runs the 30-minute feed fetch so we do not duplicate work across
   * multiple open Reddit tabs.
   ***************************************************************************/

  function scheduleHourlyFeed() {
    if (!isBossTab()) return;
    startFeedScheduler();
  }

  let feedIntervalId = null;
  let expiredIntervalId = null;
  let feedIntervalMs = 30 * 60 * 1000;
  let expiredIntervalMs = 15 * 60 * 1000;
  let autoRunFeed = true;
  let autoRunExpired = true;
  let autoClaimWins = true;
  let requestDelayMs = REQUEST_DELAY_MS;
  let expiredActionDelayMs = 2000;

  function startFeedScheduler() {
    if (!isBossTab() || !autoRunFeed) return;
    if (feedIntervalId) clearInterval(feedIntervalId);
    const intervalSec = Math.floor(feedIntervalMs / 1000);
    const shouldRunNow = () => {
      const lastRunRaw = loadJsonKey(FEED_LAST_RUN_KEY, { allowPrimitive: true });
      // The feed timestamp might be a JSON number, JSON string, or a legacy raw number.
      // Coercing once here keeps the scheduling logic predictable and easy to audit.
      const lastRun = Number.isFinite(Number(lastRunRaw)) ? Number(lastRunRaw) : 0;
      const now = nowSec();
      return now - lastRun >= intervalSec;
    };
    const markRunNow = () => {
      saveJsonKey(FEED_LAST_RUN_KEY, nowSec());
    };
    const runFeedNow = async () => {
      await fetchFeedAndStore();
      const stamped = nowSec();
      saveJsonKey(FEED_LAST_RUN_KEY, stamped);
      appendDebugLog("feed-last-run", { source: "scheduled", stamped });
    };
    debugLog("boss", "Boss tab active", window.location.href);
    // On reload, only run immediately if 30 minutes have passed since the last run.
    if (shouldRunNow()) {
      runFeedNow();
    } else {
      debugLog("timers", "Skip immediate fetch; last run < 30 min ago.");
    }
    feedIntervalId = setInterval(() => {
      if (!shouldRunNow()) return;
      debugLog("timers", "Scheduled feed fetch");
      runFeedNow();
    }, feedIntervalMs);
  }

  function scheduleQuarterHourExpiredRefresh() {
    if (!isBossTab()) return;
    startExpiredScheduler();
  }

  function startExpiredScheduler() {
    if (!isBossTab() || !autoRunExpired) return;
    if (expiredIntervalId) clearInterval(expiredIntervalId);
    refreshExpiredRaffles();
    expiredIntervalId = setInterval(() => {
      debugLog("timers", "Scheduled expired refresh");
      refreshExpiredRaffles();
    }, expiredIntervalMs);
  }

  function stopFeedScheduler() {
    if (feedIntervalId) clearInterval(feedIntervalId);
    feedIntervalId = null;
  }

  function stopExpiredScheduler() {
    if (expiredIntervalId) clearInterval(expiredIntervalId);
    expiredIntervalId = null;
  }

  /***************************************************************************
   * ui_panel.js
   *
   * Raffle panel UI components and rendering logic.
   ***************************************************************************/

  const PANEL_ID = "fmv-raffles-panel";
  const PANEL_STYLE_ID = "fmv-raffles-panel-style";

  const panelState = {
    visible: false,
    filters: {
      starsSelected: new Set([1, 2, 3, 4, 5]),
      status: "all",
      text: "",
      entered: "not-entered",
      stickerIdsSelected: new Set(),
      stickerNameSet: new Set(),
      stickerSelectionInitialized: false,
      stickerSelectionKey: "",
    },
    expiredFilters: {
      date: "all",
      winner: "without",
      sort: "alpha",
      limit: 10,
      unrevealed: "all",
      winnerUser: "all",
    },
    piggybankFilters: {
      unrevealed: "all",
    },
    expiredStatusMessage: "",
    expiredDisplayedRaffles: [],
    displayedRaffles: [],
    activeTab: "raffles",
  };

  /***************************************************************************
   * piggybank_hash.js
   *
   * Rendering should not spam storage writes. We build a small, stable
   * snapshot of piggybank entries and only persist when it changes.
   ***************************************************************************/

  const previousPiggybankHash = { value: "" };

  function stableStringify(value) {
    try {
      if (Array.isArray(value)) {
        return JSON.stringify(value);
      }
      if (!value || typeof value !== "object") {
        return String(value ?? "");
      }
      const keys = Object.keys(value).sort();
      const normalized = {};
      for (const key of keys) {
        normalized[key] = value[key];
      }
      return JSON.stringify(normalized);
    } catch {
      return "";
    }
  }

  function buildPiggybankHash(piggybankStore) {
    const keys = Object.keys(piggybankStore || {}).sort();
    const summary = keys.map((postId) => {
      const raffle = piggybankStore[postId] || {};
      const winner = raffle.winner || {};
      const raffleData = raffle.raffle || {};
      return [
        postId,
        String(winner.winnerId || raffle.winnerId || ""),
        String(winner.winnerName || raffle.winnerName || ""),
        raffleData.unrevealedForCurrentUser === true ? 1 : 0,
        toEpochSec(raffleData.endTime) || "",
        String(raffleData.stickerName || raffle.postTitle || ""),
        raffleData.stickerStars !== undefined && raffleData.stickerStars !== null
          ? String(raffleData.stickerStars)
          : "",
        String(raffle.status?.lastFetchStatus || ""),
      ];
    });
    return stableStringify(summary);
  }

  const STAR_FILTER_VALUES = [1, 2, 3, 4, 5];

  function parseStickerIdOrder(stickerId) {
    if (!stickerId) return Number.MAX_SAFE_INTEGER;
    const match = String(stickerId).match(/(\d+)/);
    const numeric = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
  }

  function buildStickerEntries(stickerMap) {
    const entries = Object.entries(stickerMap || {}).map(([stickerId, entry]) => ({
      stickerId,
      stickerName: entry?.stickerName || "",
      stickerStars: entry?.stickerStars ?? null,
    }));
    entries.sort((a, b) => {
      const orderA = parseStickerIdOrder(a.stickerId);
      const orderB = parseStickerIdOrder(b.stickerId);
      if (orderA !== orderB) return orderA - orderB;
      return String(a.stickerId).localeCompare(String(b.stickerId));
    });
    return entries;
  }

  function chunkStickerEntries(entries, size) {
    const chunks = [];
    for (let i = 0; i < entries.length; i += size) {
      chunks.push(entries.slice(i, i + size));
    }
    return chunks;
  }

  function ensureStickerSelection(stickerEntries, stickerbookId) {
    const filters = panelState.filters;
    const currentKey = `${stickerbookId || "unknown"}:${stickerEntries.length}`;
    const entryById = new Map(stickerEntries.map((entry) => [entry.stickerId, entry]));
    if (filters.stickerSelectionKey !== currentKey) {
      filters.stickerSelectionKey = currentKey;
      filters.stickerIdsSelected = new Set(stickerEntries.map((entry) => entry.stickerId));
      filters.stickerSelectionInitialized = stickerEntries.length > 0;
    }
    if (!filters.stickerIdsSelected) {
      filters.stickerIdsSelected = new Set();
    }
    if (!filters.stickerSelectionInitialized && stickerEntries.length > 0) {
      filters.stickerIdsSelected = new Set(stickerEntries.map((entry) => entry.stickerId));
      filters.stickerSelectionInitialized = true;
    }
    const nameSet = new Set();
    for (const stickerId of filters.stickerIdsSelected) {
      const name = entryById.get(stickerId)?.stickerName;
      if (name) nameSet.add(String(name).toLowerCase());
    }
    filters.stickerNameSet = nameSet;
  }

  function updateStarFilterButtons(panel) {
    const filters = panelState.filters;
    if (!filters.starsSelected) {
      filters.starsSelected = new Set(STAR_FILTER_VALUES);
    }
    const allSelected = STAR_FILTER_VALUES.every((value) => filters.starsSelected.has(value));
    const starButtons = panel.querySelectorAll("[data-star]");
    starButtons.forEach((button) => {
      const value = Number(button.getAttribute("data-star"));
      button.classList.toggle("active", filters.starsSelected.has(value));
    });
    const allButton = panel.querySelector("[data-star-all]");
    if (allButton) {
      allButton.classList.toggle("active", allSelected);
    }
  }

  function renderStickerFilterButtons(panel, stickerEntries) {
    const container = panel.querySelector("[data-sticker-sets]");
    if (!container) return;
    container.innerHTML = "";
    if (!stickerEntries.length) {
      const empty = document.createElement("div");
      empty.className = "fmv-sticker-empty";
      empty.textContent = "Stickerbook not loaded yet.";
      container.appendChild(empty);
      return;
    }
    const sets = chunkStickerEntries(stickerEntries, 9);
    sets.forEach((setEntries, index) => {
      const set = document.createElement("div");
      set.className = "fmv-sticker-set";
      const title = document.createElement("div");
      title.className = "fmv-sticker-set-title";
      title.textContent = `Set ${index + 1}`;
      set.appendChild(title);
      const grid = document.createElement("div");
      grid.className = "fmv-sticker-grid";
      for (const entry of setEntries) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "fmv-sticker-button";
        button.setAttribute("data-sticker-id", entry.stickerId);
        const starLabel =
          entry.stickerStars !== null && entry.stickerStars !== undefined
            ? `★${entry.stickerStars}`
            : "";
        const name = entry.stickerName || entry.stickerId;
        button.textContent = starLabel ? `${name} ${starLabel}` : name;
        if (panelState.filters.stickerIdsSelected?.has(entry.stickerId)) {
          button.classList.add("active");
        }
        grid.appendChild(button);
      }
      set.appendChild(grid);
      container.appendChild(set);
    });
  }


  function applySettingsFromStorage() {
    const settings = loadSettings();
    if (settings.debug && typeof settings.debug === "object") {
      for (const [key, value] of Object.entries(settings.debug)) {
        if (Object.prototype.hasOwnProperty.call(DEBUG, key)) {
          DEBUG[key] = Boolean(value);
        }
      }
    }
    if (settings.loops && typeof settings.loops === "object") {
      if (settings.loops.autoRunFeed !== undefined) {
        autoRunFeed = Boolean(settings.loops.autoRunFeed);
      }
      if (settings.loops.autoRunExpired !== undefined) {
        autoRunExpired = Boolean(settings.loops.autoRunExpired);
      }
      if (settings.loops.autoClaimWins !== undefined) {
        autoClaimWins = Boolean(settings.loops.autoClaimWins);
      }
      if (Number.isFinite(Number(settings.loops.feedIntervalMin))) {
        feedIntervalMs = Math.max(1, Math.floor(Number(settings.loops.feedIntervalMin))) * 60 * 1000;
      }
      if (Number.isFinite(Number(settings.loops.expiredIntervalMin))) {
        expiredIntervalMs =
          Math.max(1, Math.floor(Number(settings.loops.expiredIntervalMin))) * 60 * 1000;
      }
    }
    if (settings.tuning && typeof settings.tuning === "object") {
      if (Number.isFinite(Number(settings.tuning.requestDelayMs))) {
        requestDelayMs = Math.max(0, Math.floor(Number(settings.tuning.requestDelayMs)));
      }
      if (Number.isFinite(Number(settings.tuning.expiredActionDelayMs))) {
        expiredActionDelayMs = Math.max(0, Math.floor(Number(settings.tuning.expiredActionDelayMs)));
      }
    }
  }

  function persistSettings() {
    saveSettings({
      debug: { ...DEBUG },
      loops: {
        autoRunFeed,
        autoRunExpired,
        autoClaimWins,
        feedIntervalMin: Math.round(feedIntervalMs / 60000),
        expiredIntervalMin: Math.round(expiredIntervalMs / 60000),
      },
      tuning: {
        requestDelayMs,
        expiredActionDelayMs,
      },
    });
  }

  function ensurePanelStyles() {
    if (document.getElementById(PANEL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PANEL_STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        top: 40px;
        width: 720px;
        background: #f8f5ef;
        color: #2b2b2b;
        border: 1px solid #c8b9a4;
        border-radius: 12px;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
        z-index: 999999;
        display: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }
      #${PANEL_ID} .fmv-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid #d8c8b4;
        background: #efe6d7;
        border-top-left-radius: 12px;
        border-top-right-radius: 12px;
      }
      #${PANEL_ID} .fmv-panel-health {
        font-size: 11px;
        color: #6a5b4c;
      }
      #${PANEL_ID} .fmv-panel-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.4px;
      }
      #${PANEL_ID} .fmv-panel-actions button {
        margin-left: 8px;
        border: 1px solid #bfae96;
        background: #f7f1e8;
        color: #2b2b2b;
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
      }
      #${PANEL_ID} .fmv-panel-actions button:hover {
        background: #efe1cf;
      }
      #${PANEL_ID} .fmv-panel-filters {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #d8c8b4;
      }
      #${PANEL_ID} .fmv-panel-filters label {
        display: flex;
        flex-direction: column;
        font-size: 11px;
        gap: 4px;
      }
      #${PANEL_ID} .fmv-panel-filters select,
      #${PANEL_ID} .fmv-panel-filters input {
        border: 1px solid #bfae96;
        border-radius: 6px;
        padding: 4px 6px;
        background: #fffaf2;
        color: #2b2b2b;
      }
      #${PANEL_ID} .fmv-panel-filters button {
        border: 1px solid #bfae96;
        border-radius: 6px;
        padding: 6px 10px;
        background: #f7f1e8;
        color: #2b2b2b;
        cursor: pointer;
      }
      #${PANEL_ID} .fmv-panel-filters button:hover {
        background: #efe1cf;
      }
      #${PANEL_ID} .fmv-panel-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      #${PANEL_ID} .fmv-panel-table th,
      #${PANEL_ID} .fmv-panel-table td {
        padding: 6px 8px;
        border-bottom: 1px solid #e0d3c1;
        text-align: left;
        vertical-align: top;
      }
      #${PANEL_ID} .fmv-panel-table thead th {
        position: sticky;
        top: 0;
        background: #efe6d7;
        z-index: 1;
      }
      #${PANEL_ID} .fmv-panel-body {
        flex: 1 1 auto;
        overflow: visible;
        min-height: 0;
      }
      #${PANEL_ID} .fmv-expired-section {
        padding: 8px 12px 0;
      }
      #${PANEL_ID} .fmv-expired-section-title {
        font-size: 12px;
        font-weight: 700;
        margin: 4px 0 6px;
        color: #4a3f34;
      }
      #${PANEL_ID} .fmv-expired-count,
      #${PANEL_ID} .fmv-expired-status {
        padding: 6px 12px;
        font-size: 11px;
        color: #6a5b4c;
      }
      #${PANEL_ID} .fmv-panel-view {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
      }
      #${PANEL_ID} .fmv-panel-empty {
        padding: 12px;
        font-size: 12px;
        color: #555;
      }
      #${PANEL_ID} .fmv-panel-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        padding: 8px 12px;
        border-bottom: 1px solid #d8c8b4;
        background: #f7f1e8;
        font-size: 11px;
      }
      #${PANEL_ID} .fmv-panel-summary span {
        white-space: nowrap;
      }
      #${PANEL_ID} .fmv-panel-tabs {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid #d8c8b4;
        background: #efe1cf;
      }
      #${PANEL_ID} .fmv-panel-tabs button {
        border: 1px solid #bfae96;
        background: #f7f1e8;
        color: #2b2b2b;
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
      }
      #${PANEL_ID} .fmv-panel-tabs button.active {
        background: #e0cfb7;
        font-weight: 700;
      }
      #${PANEL_ID} .fmv-panel-piggybank button {
        border: 1px solid #bfae96;
        background: #f7f1e8;
        color: #2b2b2b;
        border-radius: 6px;
        padding: 3px 6px;
        cursor: pointer;
      }
      #${PANEL_ID} .fmv-panel-piggybank button:hover {
        background: #efe1cf;
      }
      #${PANEL_ID} .fmv-panel-join {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid #d8c8b4;
        background: #f1e7d6;
      }
      #${PANEL_ID} .fmv-panel-join input {
        width: 80px;
        border: 1px solid #bfae96;
        border-radius: 6px;
        padding: 4px 6px;
        background: #fffaf2;
        color: #2b2b2b;
      }
      #${PANEL_ID} .fmv-panel-join button {
        border: 1px solid #bfae96;
        background: #f7f1e8;
        color: #2b2b2b;
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
      }
      #${PANEL_ID} .fmv-panel-join button:hover {
        background: #efe1cf;
      }
      #${PANEL_ID} .fmv-filter-block {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 11px;
      }
      #${PANEL_ID} .fmv-filter-label {
        font-size: 11px;
        font-weight: 700;
        color: #4a3f34;
      }
      #${PANEL_ID} .fmv-filter-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      #${PANEL_ID} .fmv-filter-buttons button {
        border: 1px solid #bfae96;
        background: #f7f1e8;
        color: #2b2b2b;
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 11px;
      }
      #${PANEL_ID} .fmv-filter-buttons button.active {
        background: #e0cfb7;
        font-weight: 700;
      }
      #${PANEL_ID} .fmv-sticker-sets {
        display: grid;
        grid-template-columns: repeat(2, minmax(220px, 1fr));
        gap: 10px;
      }
      #${PANEL_ID} .fmv-sticker-set {
        border: 1px solid #d8c8b4;
        border-radius: 8px;
        padding: 6px;
        background: #fffaf2;
      }
      #${PANEL_ID} .fmv-sticker-set-title {
        font-size: 10px;
        font-weight: 700;
        color: #6a5b4c;
        margin-bottom: 6px;
      }
      #${PANEL_ID} .fmv-sticker-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
      }
      #${PANEL_ID} .fmv-sticker-button {
        border: 1px solid #bfae96;
        background: #f7f1e8;
        color: #2b2b2b;
        border-radius: 6px;
        padding: 4px 6px;
        cursor: pointer;
        font-size: 10px;
        line-height: 1.2;
        text-align: center;
      }
      #${PANEL_ID} .fmv-sticker-button.active {
        background: #e0cfb7;
        font-weight: 700;
      }
      #${PANEL_ID} .fmv-sticker-empty {
        font-size: 11px;
        color: #6a5b4c;
      }
    `;
    document.head.appendChild(style);
  }

  /***************************************************************************
   * ui_projection.js
   *
   * Read-only helpers that turn storage into UI-ready lists and counts.
   ***************************************************************************/

  const uiProjection = {
    listRaffles() {
      const dayKeys = raffleStore.listDayKeys();
      const raffles = [];
      for (const dayKey of dayKeys) {
        const bucketRaffles = raffleStore.listByDay(dayKey);
        for (const raffle of bucketRaffles) {
          if (!raffle || typeof raffle !== "object") continue;
          raffles.push(raffle);
        }
      }
      return raffles;
    },

    getHealthSummary(raffles) {
      const summary = {
        missingToken: 0,
        inactive: 0,
        ambiguous: 0,
      };
      const seenIds = new Set();
      for (const raffle of raffles) {
        const postId = raffle?.postId;
        if (!postId || seenIds.has(postId)) continue;
        seenIds.add(postId);
        if (!raffle.token?.webbitToken) summary.missingToken += 1;
        if (isRaffleInactiveForUi(raffle)) summary.inactive += 1;
        if (raffle.status?.lastFetchStatus === "ambiguous") summary.ambiguous += 1;
      }
      return summary;
    },

    filterRaffles(raffles, filters, stickerMap) {
      return raffles.filter((raffle) => matchesFilters(raffle, filters, stickerMap));
    },

    splitActiveRaffles(raffles, now) {
      let expired = 0;
      let active = 0;
      const activeRaffles = [];
      for (const raffle of raffles) {
        const endTime = toEpochSec(raffle.raffle?.endTime);
        if (!endTime) continue;
        if (endTime <= now) {
          expired += 1;
        } else {
          active += 1;
          activeRaffles.push(raffle);
        }
      }
      activeRaffles.sort(
        (a, b) => toEpochSec(a.raffle?.endTime) - toEpochSec(b.raffle?.endTime),
      );
      return { activeRaffles, expiredCount: expired, activeCount: active };
    },

    getExpiredRaffles(raffles, now) {
      return raffles.filter((raffle) => {
        const endTime = toEpochSec(raffle.raffle?.endTime);
        return Boolean(endTime && endTime <= now);
      });
    },

    splitExpiredRaffles(expiredRaffles) {
      const active = [];
      const inactive = [];
      for (const raffle of expiredRaffles) {
        if (isRaffleInactiveForUi(raffle)) {
          inactive.push(raffle);
        } else {
          active.push(raffle);
        }
      }
      return { active, inactive };
    },

    getExpiredDates(expiredRaffles) {
      const expiredDates = new Set();
      for (const raffle of expiredRaffles) {
        const endTime = toEpochSec(raffle.raffle?.endTime);
        if (!endTime) continue;
        expiredDates.add(formatDayKey(endTime));
      }
      return Array.from(expiredDates).sort().reverse();
    },

    filterExpiredRaffles(expiredRaffles, filters, currentUserId) {
      return expiredRaffles.filter((raffle) => {
        const endTime = toEpochSec(raffle.raffle?.endTime);
        const dayKey = endTime ? formatDayKey(endTime) : "";
        if (filters.date !== "all" && dayKey !== filters.date) {
          return false;
        }
        const winnerId = raffle.winner?.winnerId || raffle.winnerId;
        const winnerName = raffle.winner?.winnerName || raffle.winnerName;
        const hasWinner = Boolean(winnerId || winnerName);
        if (filters.winner === "with" && !hasWinner) return false;
        if (filters.winner === "without" && hasWinner) return false;
        const unrevealedValue = raffle.raffle?.unrevealedForCurrentUser;
        const isUnrevealedTrue = unrevealedValue === true;
        const isUnrevealedFalse = unrevealedValue === false;
        if (filters.unrevealed === "true" && !isUnrevealedTrue) return false;
        if (filters.unrevealed === "false" && !isUnrevealedFalse) return false;
        if (filters.unrevealed === "unknown" && (isUnrevealedTrue || isUnrevealedFalse)) {
          return false;
        }
        if (filters.winnerUser === "mine") {
          if (!currentUserId) return false;
          const winnerMatch =
            winnerId === currentUserId ||
            String(winnerName || "").toLowerCase() === CURRENT_USER_NAME.toLowerCase();
          if (!winnerMatch) return false;
        }
        return true;
      });
    },
  };

  function formatCountdown(endTimeSec) {
    if (!endTimeSec) return "?";
    const now = nowSec();
    if (endTimeSec <= now) return "ended";
    const diff = endTimeSec - now;
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  function formatStatusLabel(raffle) {
    const phase = getStatusPhase(raffle);
    const transport = getStatusTransport(raffle);
    if (!transport || transport === "ok") return phase;
    return `${phase} (${transport})`;
  }

  function formatUnrevealedLabel(value) {
    if (value === true) return "true";
    if (value === false) return "false";
    return "-";
  }

  function matchesFilters(raffle, filters, stickerMap) {
    const stickerName = raffle.raffle?.stickerName || "";
    const postTitle = raffle.postTitle || "";
    const text = filters.text.trim().toLowerCase();
    if (text) {
      const haystack = `${stickerName} ${postTitle}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    const starsSelected = filters.starsSelected;
    if (starsSelected instanceof Set) {
      if (starsSelected.size === 0) return false;
      if (starsSelected.size < STAR_FILTER_VALUES.length) {
        const stars = Number(raffle.raffle?.stickerStars);
        if (!starsSelected.has(stars)) return false;
      }
    }
    if (filters.stickerSelectionInitialized) {
      const stickerIds = filters.stickerIdsSelected;
      if (!stickerIds || stickerIds.size === 0) return false;
      const raffleStickerId = String(raffle.raffle?.stickerId || "");
      if (raffleStickerId && stickerIds.has(raffleStickerId)) {
        // matched by stickerId
      } else {
        const raffleName = String(stickerName || "").toLowerCase();
        const nameSet =
          filters.stickerNameSet instanceof Set
            ? filters.stickerNameSet
            : new Set(
                Object.entries(stickerMap || {})
                  .filter(([id]) => stickerIds?.has(id))
                  .map(([, entry]) => String(entry?.stickerName || "").toLowerCase())
                  .filter(Boolean),
              );
        if (!raffleName || !nameSet.has(raffleName)) return false;
      }
    }
    if (filters.status !== "all") {
      const phase = getStatusPhase(raffle);
      const transport = getStatusTransport(raffle);
      const legacyStatus = raffle.status?.lastFetchStatus || "";
      if (filters.status === "ok") {
        if (transport !== "ok") return false;
      } else if (filters.status === "http-*") {
        if (!String(transport).startsWith("http-")) return false;
      } else if (filters.status === "error") {
        if (!["network-error", "timeout"].includes(transport)) return false;
      } else if (filters.status === "no-token") {
        if (legacyStatus !== "no-token") return false;
      } else if (phase !== filters.status) {
        return false;
      }
    }
    const isEntered = isRaffleEntered(raffle);
    if (filters.entered === "entered" && !isEntered) {
      return false;
    }
    if (filters.entered === "not-entered" && isEntered) {
      return false;
    }
    return true;
  }

  /***************************************************************************
   * renderPanel()
   *
   * Read-only UI projection:
   * - Pulls fresh storage each render (no cached derived state)
   * - Uses uiProjection helpers for list splitting/filtering
   *
   * Warning:
   * - Any background mutation MUST call ui.invalidate(reason)
   *   to keep displayed counts in sync.
   ***************************************************************************/
  function renderPanel(panel) {
    const store = loadStore({ includeRaffles: false });
    const stickerEntries = buildStickerEntries(store.stickerMap || {});
    ensureStickerSelection(stickerEntries, store.activeStickerbookId);
    const allRaffles = uiProjection.listRaffles();
    const healthSummary = uiProjection.getHealthSummary(allRaffles);
    const healthEl = panel.querySelector(".fmv-panel-health");
    if (healthEl) {
      healthEl.textContent = `Missing token: ${healthSummary.missingToken} · Inactive: ${healthSummary.inactive} · Ambiguous: ${healthSummary.ambiguous}`;
    }
    const filtered = uiProjection.filterRaffles(allRaffles, panelState.filters, store.stickerMap);
    updateStarFilterButtons(panel);
    renderStickerFilterButtons(panel, stickerEntries);
    const tbody = panel.querySelector("tbody");
    const emptyState = panel.querySelector(".fmv-panel-empty");
    const summary = panel.querySelector(".fmv-panel-summary");
    const now = nowSec();
    const { activeRaffles, expiredCount, activeCount } = uiProjection.splitActiveRaffles(
      filtered,
      now,
    );
    panelState.displayedRaffles = activeRaffles;
    summary.innerHTML = `
      <span>Total raffles: ${filtered.length}</span>
      <span>Total expired: ${expiredCount}</span>
      <span>Total not expired: ${activeCount}</span>
      <span>Total displayed: ${activeRaffles.length}</span>
    `;
    const piggybankBody = panel.querySelector(".fmv-piggybank-body");
    const piggybankEmpty = panel.querySelector(".fmv-piggybank-empty");
    const piggybankCountEl = panel.querySelector(".fmv-piggybank-count");
    const expiredBody = panel.querySelector(".fmv-expired-body");
    const expiredEmpty = panel.querySelector(".fmv-expired-empty");
    const expiredInactiveBody = panel.querySelector(".fmv-expired-inactive-body");
    const expiredInactiveEmpty = panel.querySelector(".fmv-expired-inactive-empty");
    const currentUserId = getCurrentUserIdFromRaffles(allRaffles);
    tbody.innerHTML = "";
    if (piggybankBody) piggybankBody.innerHTML = "";
    expiredBody.innerHTML = "";
    if (expiredInactiveBody) expiredInactiveBody.innerHTML = "";
    const expiredAll = uiProjection.getExpiredRaffles(allRaffles, now);
    const { active: expiredActive, inactive: expiredInactive } =
      uiProjection.splitExpiredRaffles(expiredAll);
    const expiredDateSelect = panel.querySelector('[data-expired-filter="date"]');
    const expiredWinnerSelect = panel.querySelector('[data-expired-filter="winner"]');
    const expiredUnrevealedSelect = panel.querySelector('[data-expired-filter="unrevealed"]');
    const expiredSortSelect = panel.querySelector('[data-expired-filter="sort"]');
    const expiredLimitInput = panel.querySelector("[data-expired-limit]");
    const expiredWinnerUserSelect = panel.querySelector('[data-expired-filter="winnerUser"]');
    const sortedExpiredDates = uiProjection.getExpiredDates(expiredActive);
    const expiredDates = new Set(sortedExpiredDates);
    if (expiredDateSelect) {
      const selected = panelState.expiredFilters.date;
      expiredDateSelect.innerHTML = "";
      const allOption = document.createElement("option");
      allOption.value = "all";
      allOption.textContent = "All dates";
      expiredDateSelect.appendChild(allOption);
      for (const dayKey of sortedExpiredDates) {
        const option = document.createElement("option");
        option.value = dayKey;
        option.textContent = dayKey;
        expiredDateSelect.appendChild(option);
      }
      if (selected && selected !== "all" && !expiredDates.has(selected)) {
        panelState.expiredFilters.date = "all";
      }
      expiredDateSelect.value = panelState.expiredFilters.date;
    }
    if (expiredWinnerSelect) {
      expiredWinnerSelect.value = panelState.expiredFilters.winner;
    }
    if (expiredUnrevealedSelect) {
      expiredUnrevealedSelect.value = panelState.expiredFilters.unrevealed;
    }
    if (expiredSortSelect) {
      if (panelState.expiredFilters.sort === "chron") {
        panelState.expiredFilters.sort = "chron-desc";
      }
      if (panelState.expiredFilters.sort === "stars") {
        panelState.expiredFilters.sort = "stars-desc";
      }
      expiredSortSelect.value = panelState.expiredFilters.sort;
    }
    if (expiredLimitInput) {
      expiredLimitInput.value = String(panelState.expiredFilters.limit || 10);
    }
    if (expiredWinnerUserSelect) {
      expiredWinnerUserSelect.value = panelState.expiredFilters.winnerUser;
    }
    const piggybankUnrevealedSelect = panel.querySelector(
      '[data-piggybank-filter="unrevealed"]',
    );
    if (piggybankUnrevealedSelect) {
      piggybankUnrevealedSelect.value = panelState.piggybankFilters.unrevealed || "all";
    }
    const piggybankStore = loadPiggybank();
    for (const raffle of allRaffles) {
      const stars = Number(raffle.raffle?.stickerStars);
      if (stars !== 5) continue;
      if (!currentUserId) continue;
      if (raffle.winner?.winnerId !== currentUserId) continue;
      piggybankStore[raffle.postId] = raffle;
    }
    const nextPiggybankHash = buildPiggybankHash(piggybankStore);
    if (nextPiggybankHash !== previousPiggybankHash.value) {
      savePiggybank(piggybankStore);
      previousPiggybankHash.value = nextPiggybankHash;
    }
    const piggybank = Object.values(piggybankStore);
    const piggybankFiltered = piggybank.filter((raffle) => {
      const unrevealedValue = raffle?.raffle?.unrevealedForCurrentUser;
      const isUnrevealedTrue = unrevealedValue === true;
      const isUnrevealedFalse = unrevealedValue === false;
      if (panelState.piggybankFilters.unrevealed === "true") return isUnrevealedTrue;
      if (panelState.piggybankFilters.unrevealed === "false") return isUnrevealedFalse;
      return true;
    });
    piggybankFiltered.sort((a, b) => {
      const endA = toEpochSec(a.raffle?.endTime) || 0;
      const endB = toEpochSec(b.raffle?.endTime) || 0;
      return endA - endB;
    });
    const piggybankTab = panel.querySelector('[data-tab="piggybank"]');
    if (piggybankTab) {
      piggybankTab.textContent = `Piggybank (${piggybank.length})`;
    }
    if (piggybankCountEl) {
      piggybankCountEl.textContent =
        `Total: ${piggybank.length} · Displayed: ${piggybankFiltered.length}`;
    }
    const expiredTab = panel.querySelector('[data-tab="expired"]');
    if (expiredTab) {
      expiredTab.textContent = `Expired Raffles (${expiredAll.length})`;
    }
    if (!activeRaffles.length) {
      emptyState.textContent = "No raffles match the current filters.";
      emptyState.style.display = "block";
    } else {
      emptyState.style.display = "none";
    }
    for (const raffle of activeRaffles) {
      const row = document.createElement("tr");
      const stickerName = raffle.raffle?.stickerName || raffle.postTitle || "(unknown)";
      const stars =
        raffle.raffle?.stickerStars !== undefined && raffle.raffle?.stickerStars !== null
          ? String(raffle.raffle.stickerStars)
          : "?";
      const endsIn = formatCountdown(toEpochSec(raffle.raffle?.endTime));
      const entered = isRaffleEntered(raffle) ? "yes" : "no";
      const status = formatStatusLabel(raffle);

      const cells = [stickerName, stars, endsIn, entered, status];
      for (const value of cells) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      }
      const linkCell = document.createElement("td");
      const linkUrl = toFullUrl(raffle.url || raffle.permalink);
      if (linkUrl) {
        const link = document.createElement("a");
        link.href = linkUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open";
        link.title = linkUrl;
        linkCell.appendChild(link);
      } else {
        linkCell.textContent = "-";
      }
      row.appendChild(linkCell);
      tbody.appendChild(row);
    }

    if (piggybankBody && piggybankEmpty) {
      if (!piggybankFiltered.length) {
        piggybankEmpty.textContent = "No 5★ wins in piggybank.";
        piggybankEmpty.style.display = "block";
      } else {
        piggybankEmpty.style.display = "none";
        for (const raffle of piggybankFiltered) {
          const row = document.createElement("tr");
          const stickerName = raffle.raffle?.stickerName || raffle.postTitle || "(unknown)";
          const endTime = toEpochSec(raffle.raffle?.endTime);
          const endedAt = endTime ? formatLogTimestamp(endTime) : "-";
          const unrevealedValue = raffle.raffle?.unrevealedForCurrentUser;
          const unrevealed = unrevealedValue === true;
          const cells = [stickerName, "5", endedAt, formatUnrevealedLabel(unrevealedValue)];
          for (const value of cells) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
          }
          const linkCell = document.createElement("td");
          const linkUrl = toFullUrl(raffle.url || raffle.permalink);
          if (linkUrl) {
            const link = document.createElement("a");
            link.href = linkUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "Open";
            link.title = linkUrl;
            linkCell.appendChild(link);
          } else {
            linkCell.textContent = "-";
          }
          row.appendChild(linkCell);
          const actionCell = document.createElement("td");
          if (unrevealed) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Claim";
            button.addEventListener("click", async () => {
              await ensureToken(raffle);
              const { resp, deleted } = await runRaffleRequest(raffle, claimRaffle, "claimRaffle");
              if (deleted) {
                warnLog("Piggybank claim marked deleted (500)", raffle.postId);
              } else if (resp?.status >= 200 && resp?.status < 300) {
                raffle.raffle = { ...(raffle.raffle || {}) };
                raffle.raffle.unrevealedForCurrentUser = false;
                {
                  const status = ensureRaffleStatus(raffle);
                  status.phase = "claimed";
                  noteStatusSuccess(raffle);
                }
                debugLog("actions", "claimRaffle succeeded", {
                  postId: raffle.postId,
                  winnerId: raffle.winner?.winnerId || null,
                  winnerName: raffle.winner?.winnerName || null,
                });
                if (raffle.raffle?.unrevealedForCurrentUser !== false) {
                  const { resp: dataResp } = await runRaffleRequest(
                    raffle,
                    fetchRaffleData,
                    "getRaffleData",
                  );
                  if (dataResp?.status >= 200 && dataResp?.status < 300 && dataResp.data) {
                    applyGetRaffleDataResult(raffle, dataResp, store, "getRaffleData", {
                      persistFn: (next) => raffleStore.put(next),
                    });
                  }
                }
              } else if (resp?.status) {
                const status = ensureRaffleStatus(raffle);
                status.lastFetchStatus = `http-${resp.status}`;
                status.lastError = "claimRaffle";
                status.lastErrorAt = nowSec();
                noteStatusError(
                  raffle,
                  mapTransportFromHttpStatus(resp.status),
                  status.lastError,
                );
                status.phase = inferStatusPhase(raffle);
              } else {
                warnLog("Piggybank claim failed", raffle.postId, resp?.error || "unknown");
              }
              touchRaffle(raffle, "piggybank:claim");
              raffleStore.put(raffle);
              const piggybankStore = loadPiggybank();
              piggybankStore[raffle.postId] = raffle;
              savePiggybank(piggybankStore);
              previousPiggybankHash.value = buildPiggybankHash(piggybankStore);
              renderPanel(panel);
            });
            actionCell.appendChild(button);
          } else if (unrevealedValue === false) {
            actionCell.textContent = "Revealed";
          } else {
            actionCell.textContent = "-";
          }
          row.appendChild(actionCell);
          piggybankBody.appendChild(row);
        }
      }
    }

    const filteredExpired = uiProjection.filterExpiredRaffles(
      expiredActive,
      panelState.expiredFilters,
      currentUserId,
    );

    panelState.expiredDisplayedRaffles = filteredExpired;
    const expiredCountEl = panel.querySelector(".fmv-expired-count");
    if (expiredCountEl) {
      expiredCountEl.textContent =
        `Displayed: ${filteredExpired.length} · ` +
        `Running: ${expiredActive.length} · ` +
        `Inactive: ${expiredInactive.length}`;
    }
    const expiredStatusEl = panel.querySelector(".fmv-expired-status");
    if (expiredStatusEl) {
      expiredStatusEl.textContent = panelState.expiredStatusMessage || "";
      expiredStatusEl.style.display = panelState.expiredStatusMessage ? "block" : "none";
    }
    const sortExpired = (list) =>
      [...list].sort((a, b) => {
        if (
          panelState.expiredFilters.sort === "chron-desc" ||
          panelState.expiredFilters.sort === "chron"
        ) {
          return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "chron-asc") {
          return toEpochSec(a.raffle?.endTime) - toEpochSec(b.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "winner") {
          const winnerA = String(a.winner?.winnerName || a.winner?.winnerId || "").toLowerCase();
          const winnerB = String(b.winner?.winnerName || b.winner?.winnerId || "").toLowerCase();
          if (winnerA < winnerB) return -1;
          if (winnerA > winnerB) return 1;
          return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "stars-desc") {
          const starsA = Number(a.raffle?.stickerStars || 0);
          const starsB = Number(b.raffle?.stickerStars || 0);
          if (starsA !== starsB) return starsB - starsA;
          return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "stars-asc") {
          const starsA = Number(a.raffle?.stickerStars || 0);
          const starsB = Number(b.raffle?.stickerStars || 0);
          if (starsA !== starsB) return starsA - starsB;
          return toEpochSec(a.raffle?.endTime) - toEpochSec(b.raffle?.endTime);
        }
        const nameA = String(a.raffle?.stickerName || a.postTitle || "").toLowerCase();
        const nameB = String(b.raffle?.stickerName || b.postTitle || "").toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
      });

    const appendExpiredRow = (targetBody, raffle) => {
      if (!targetBody) return;
      const row = document.createElement("tr");
    const stickerName = raffle.raffle?.stickerName || raffle.postTitle || "(unknown)";
    const postId = raffle.postId || "-";
    const stars =
      raffle.raffle?.stickerStars !== undefined && raffle.raffle?.stickerStars !== null
        ? String(raffle.raffle.stickerStars)
        : "?";
    const endTimeSec = toEpochSec(raffle.raffle?.endTime);
    const endedAt = endTimeSec ? formatTimeOfDay(endTimeSec) : "-";
    const winnerName = raffle.winner?.winnerName || raffle.winner?.winnerId || "-";
    const unrevealed = formatUnrevealedLabel(raffle.raffle?.unrevealedForCurrentUser);
      const status = formatStatusLabel(raffle);
      const cells = [stickerName, postId, stars, endedAt, winnerName, unrevealed, status];
      for (const value of cells) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      }
      const linkCell = document.createElement("td");
      const linkUrl = toFullUrl(raffle.url || raffle.permalink);
      if (linkUrl) {
        const link = document.createElement("a");
        link.href = linkUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open";
        link.title = linkUrl;
        linkCell.appendChild(link);
      } else {
        linkCell.textContent = "-";
      }
      row.appendChild(linkCell);
      const deleteCell = document.createElement("td");
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "x";
      deleteBtn.title = "Delete raffle from storage";
      deleteBtn.addEventListener("click", () => {
        raffleStore.remove(raffle.postId);
        const piggybank = loadPiggybank();
        if (piggybank && piggybank[raffle.postId]) {
          delete piggybank[raffle.postId];
          savePiggybank(piggybank);
          previousPiggybankHash.value = buildPiggybankHash(piggybank);
        }
        debugLog("storage", "Deleted raffle from storage", raffle.postId);
        renderPanel(panel);
      });
      deleteCell.appendChild(deleteBtn);
      row.appendChild(deleteCell);
      targetBody.appendChild(row);
    };

    if (!filteredExpired.length) {
      expiredEmpty.textContent = "No active expired raffles match the current filters.";
      expiredEmpty.style.display = "block";
    } else {
      expiredEmpty.style.display = "none";
      const sortedExpired = sortExpired(filteredExpired);
      for (const raffle of sortedExpired) {
        appendExpiredRow(expiredBody, raffle);
      }
    }

    if (expiredInactiveBody && expiredInactiveEmpty) {
      if (!expiredInactive.length) {
        expiredInactiveEmpty.textContent = "No inactive (401) expired raffles.";
        expiredInactiveEmpty.style.display = "block";
      } else {
        expiredInactiveEmpty.style.display = "none";
        const sortedInactive = sortExpired(expiredInactive);
        for (const raffle of sortedInactive) {
          appendExpiredRow(expiredInactiveBody, raffle);
        }
      }
    }

    const debugBody = panel.querySelector(".fmv-debug-body");
    if (debugBody) {
      debugBody.innerHTML = "";
      const scopes = Object.keys(DEBUG).sort();
      for (const scope of scopes) {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        nameCell.textContent = scope;
        row.appendChild(nameCell);
        const toggleCell = document.createElement("td");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(DEBUG[scope]);
        checkbox.addEventListener("change", () => {
          DEBUG[scope] = checkbox.checked;
          persistSettings();
        });
        toggleCell.appendChild(checkbox);
        row.appendChild(toggleCell);
        debugBody.appendChild(row);
      }
    }
    const exportsBody = panel.querySelector(".fmv-debug-exports-body");
    const exportsEmpty = panel.querySelector(".fmv-debug-exports-empty");
    if (exportsBody && exportsEmpty) {
      exportsBody.innerHTML = "";
      const history = loadExportHistory();
      if (!history.length) {
        exportsEmpty.textContent = "No exports recorded yet.";
        exportsEmpty.style.display = "block";
      } else {
        exportsEmpty.style.display = "none";
        for (const entry of history) {
          const row = document.createElement("tr");
          const timeCell = document.createElement("td");
          timeCell.textContent = entry.timestampHuman || formatLogTimestamp(entry.timestamp);
          const fileCell = document.createElement("td");
          fileCell.textContent = entry.filename || "-";
          const contextCell = document.createElement("td");
          contextCell.textContent = entry.context || "-";
          row.appendChild(timeCell);
          row.appendChild(fileCell);
          row.appendChild(contextCell);
          exportsBody.appendChild(row);
        }
      }
    }
    const feedToggle = panel.querySelector('[data-auto="feed"]');
    if (feedToggle) feedToggle.checked = autoRunFeed;
    const expiredToggle = panel.querySelector('[data-auto="expired"]');
    if (expiredToggle) expiredToggle.checked = autoRunExpired;
    const claimToggle = panel.querySelector('[data-auto="claimWins"]');
    if (claimToggle) claimToggle.checked = autoClaimWins;
    const feedIntervalInput = panel.querySelector('[data-auto-interval="feed"]');
    if (feedIntervalInput) feedIntervalInput.value = String(Math.round(feedIntervalMs / 60000));
    const expiredIntervalInput = panel.querySelector('[data-auto-interval="expired"]');
    if (expiredIntervalInput)
      expiredIntervalInput.value = String(Math.round(expiredIntervalMs / 60000));
    const requestDelayInput = panel.querySelector('[data-tune="requestDelayMs"]');
    if (requestDelayInput) requestDelayInput.value = String(requestDelayMs);
    const expiredActionDelayInput = panel.querySelector('[data-tune="expiredActionDelayMs"]');
    if (expiredActionDelayInput) expiredActionDelayInput.value = String(expiredActionDelayMs);

    const raffleView = panel.querySelector('[data-view="raffles"]');
    const piggybankView = panel.querySelector('[data-view="piggybank"]');
    const expiredView = panel.querySelector('[data-view="expired"]');
    const debugView = panel.querySelector('[data-view="debug"]');
    if (panelState.activeTab === "piggybank") {
      raffleView.style.display = "none";
      if (piggybankView) piggybankView.style.display = "flex";
      expiredView.style.display = "none";
      if (debugView) debugView.style.display = "none";
    } else if (panelState.activeTab === "expired") {
      raffleView.style.display = "none";
      if (piggybankView) piggybankView.style.display = "none";
      expiredView.style.display = "flex";
      if (debugView) debugView.style.display = "none";
    } else if (panelState.activeTab === "debug") {
      raffleView.style.display = "none";
      if (piggybankView) piggybankView.style.display = "none";
      expiredView.style.display = "none";
      if (debugView) debugView.style.display = "flex";
    } else {
      raffleView.style.display = "flex";
      if (piggybankView) piggybankView.style.display = "none";
      expiredView.style.display = "none";
      if (debugView) debugView.style.display = "none";
    }
  }

  /***************************************************************************
   * ui_controller.js
   *
   * Event wiring + render orchestration for the panel UI.
   ***************************************************************************/

  const uiController = {
    render() {
      const panel = ensurePanel();
      renderPanel(panel);
      return panel;
    },

    toggle() {
      const panel = ensurePanel();
      panelState.visible = !panelState.visible;
      panel.style.display = panelState.visible ? "flex" : "none";
      if (panelState.visible) {
        renderPanel(panel);
      }
    },
  };

  /***************************************************************************
   * ui_invalidate.js
   *
   * Background mutations call this once when finished so the panel stays in
   * sync without each worker needing to know render details.
   ***************************************************************************/

  let uiInvalidatePending = false;

  const ui = {
    invalidate(reason) {
      debugLog("ui", "invalidate", reason || "unspecified");
      if (!panelState.visible) return;
      if (uiInvalidatePending) return;
      uiInvalidatePending = true;
      requestAnimationFrame(() => {
        uiInvalidatePending = false;
        uiController.render();
      });
    },
  };

  function ensurePanel() {
    ensurePanelStyles();
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="fmv-panel-header">
        <div class="fmv-panel-title">FMV Raffles</div>
        <div class="fmv-panel-health"></div>
        <div class="fmv-panel-actions">
          <button type="button" data-action="refresh">⟳</button>
          <button type="button" data-action="close">✕</button>
        </div>
      </div>
      <div class="fmv-panel-tabs">
        <button type="button" data-tab="raffles" class="active">Raffles</button>
        <button type="button" data-tab="piggybank">Piggybank (0)</button>
        <button type="button" data-tab="expired">Expired Raffles (0)</button>
        <button type="button" data-tab="debug">Debug & Auto</button>
      </div>
      <div data-view="raffles" class="fmv-panel-view">
        <div class="fmv-panel-filters">
          <div class="fmv-filter-block">
            <div class="fmv-filter-label">Stars</div>
            <div class="fmv-filter-buttons" data-star-filter>
              <button type="button" data-star-all>All</button>
              <button type="button" data-star="1">1★</button>
              <button type="button" data-star="2">2★</button>
              <button type="button" data-star="3">3★</button>
              <button type="button" data-star="4">4★</button>
              <button type="button" data-star="5">5★</button>
            </div>
          </div>
          <label>
            Phase
            <select data-filter="status">
              <option value="all">All</option>
              <option value="discovered">discovered</option>
              <option value="expired">expired</option>
              <option value="claimed">claimed</option>
              <option value="resolved">resolved</option>
              <option value="inactive">inactive</option>
            </select>
          </label>
        <div class="fmv-filter-block" style="grid-column: span 2;">
          <div class="fmv-filter-label">Stickers</div>
          <div class="fmv-sticker-sets" data-sticker-sets></div>
        </div>
        <label>
          Entered
          <select data-filter="entered">
            <option value="all">All</option>
            <option value="entered">Entered</option>
            <option value="not-entered" selected>Not Entered</option>
          </select>
        </label>
      </div>
        <div class="fmv-panel-join">
          <span>Open displayed</span>
          <input type="number" min="1" step="1" value="10" data-open-count />
          <button type="button" data-action="open">Open</button>
        </div>
        <div class="fmv-panel-summary"></div>
        <div class="fmv-panel-body">
          <table class="fmv-panel-table">
            <thead>
              <tr>
                <th>Sticker</th>
                <th>★</th>
                <th>Ends In</th>
                <th>Entered</th>
                <th>Status</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
          <div class="fmv-panel-empty" style="display:none;"></div>
        </div>
      </div>
      <div data-view="piggybank" class="fmv-panel-view fmv-panel-piggybank" style="display:none;">
        <div class="fmv-panel-filters">
          <label>
            Unrevealed
            <select data-piggybank-filter="unrevealed">
              <option value="all">All</option>
              <option value="true">Only true</option>
              <option value="false">Only false</option>
            </select>
          </label>
        </div>
        <div class="fmv-piggybank-count"></div>
        <div class="fmv-panel-body">
          <table class="fmv-panel-table">
            <thead>
              <tr>
                <th>Sticker</th>
                <th>★</th>
                <th>Ended At</th>
                <th>Unrevealed</th>
                <th>Link</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody class="fmv-piggybank-body"></tbody>
          </table>
          <div class="fmv-piggybank-empty" style="display:none;"></div>
        </div>
      </div>
      <div data-view="expired" class="fmv-panel-view fmv-panel-expired" style="display:none;">
        <div class="fmv-panel-filters">
          <label>
            Date
            <select data-expired-filter="date"></select>
          </label>
          <label>
            Winner
            <select data-expired-filter="winner">
              <option value="all">All</option>
              <option value="with">Only raffles with winners</option>
              <option value="without" selected>Only raffles without winners</option>
            </select>
          </label>
          <label>
            Unrevealed
            <select data-expired-filter="unrevealed">
              <option value="all">All</option>
              <option value="true">Only true</option>
              <option value="false">Only false</option>
              <option value="unknown">Only -</option>
            </select>
          </label>
          <label>
            Winner user
            <select data-expired-filter="winnerUser">
              <option value="all">All</option>
              <option value="mine">Only my wins</option>
            </select>
          </label>
          <label>
            Sort
            <select data-expired-filter="sort">
              <option value="alpha" selected>Alphabetical</option>
              <option value="chron-desc">Chronological (newest first)</option>
              <option value="chron-asc">Chronological (oldest first)</option>
              <option value="winner">Winner username</option>
              <option value="stars-desc">Star count (high → low)</option>
              <option value="stars-asc">Star count (low → high)</option>
            </select>
          </label>
          <label>
            Limit
            <input type="number" min="1" step="1" value="10" data-expired-limit />
          </label>
          <button type="button" data-action="expired-refresh-token">Refresh Token</button>
          <button type="button" data-action="expired-getraffledata">getRaffleData</button>
          <button type="button" data-action="expired-claimraffle">claimRaffle</button>
          <button type="button" data-action="expired-force-settle">Force-settle by date</button>
        </div>
        <div class="fmv-expired-count"></div>
        <div class="fmv-expired-status" style="display:none;"></div>
        <div class="fmv-panel-body">
          <div class="fmv-expired-section">
            <div class="fmv-expired-section-title">Running expired raffles</div>
            <table class="fmv-panel-table">
              <thead>
                <tr>
                  <th>Sticker</th>
                  <th>Post ID</th>
                  <th>★</th>
                  <th>Ended</th>
                  <th>Winner</th>
                  <th>Unrevealed</th>
                  <th>Status</th>
                  <th>Link</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody class="fmv-expired-body"></tbody>
            </table>
            <div class="fmv-expired-empty" style="display:none;"></div>
          </div>
          <div class="fmv-expired-section">
            <div class="fmv-expired-section-title">Inactive (401)</div>
            <table class="fmv-panel-table">
              <thead>
                <tr>
                  <th>Sticker</th>
                  <th>Post ID</th>
                  <th>★</th>
                  <th>Ended</th>
                  <th>Winner</th>
                  <th>Unrevealed</th>
                  <th>Status</th>
                  <th>Link</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody class="fmv-expired-inactive-body"></tbody>
            </table>
            <div class="fmv-expired-inactive-empty" style="display:none;"></div>
          </div>
        </div>
      </div>
      <div data-view="debug" class="fmv-panel-view fmv-panel-debug" style="display:none;">
        <div class="fmv-panel-filters">
          <label>
            Feed loop
            <input type="checkbox" data-auto="feed" />
          </label>
          <label>
            Feed minutes
            <input type="number" min="1" step="1" data-auto-interval="feed" />
          </label>
          <label>
            Expired loop
            <input type="checkbox" data-auto="expired" />
          </label>
          <label>
            Auto-claim wins
            <input type="checkbox" data-auto="claimWins" />
          </label>
          <label>
            Expired minutes
            <input type="number" min="1" step="1" data-auto-interval="expired" />
          </label>
          <label>
            Request delay (ms)
            <input type="number" min="0" step="100" data-tune="requestDelayMs" />
          </label>
          <label>
            Expired action delay (ms)
            <input type="number" min="0" step="100" data-tune="expiredActionDelayMs" />
          </label>
        </div>
        <div class="fmv-panel-body">
          <table class="fmv-panel-table">
            <thead>
              <tr>
                <th>Debug Scope</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody class="fmv-debug-body"></tbody>
          </table>
          <div class="fmv-debug-exports" style="margin-top: 12px;">
            <div class="fmv-debug-exports-title">Recent exports</div>
            <table class="fmv-panel-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>File</th>
                  <th>Context</th>
                </tr>
              </thead>
              <tbody class="fmv-debug-exports-body"></tbody>
            </table>
            <div class="fmv-debug-exports-empty" style="display:none;"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const filterEls = panel.querySelectorAll("[data-filter]");
    for (const el of filterEls) {
      el.addEventListener("input", () => {
        const key = el.getAttribute("data-filter");
        panelState.filters[key] = el.value;
        renderPanel(panel);
      });
      el.addEventListener("change", () => {
        const key = el.getAttribute("data-filter");
        panelState.filters[key] = el.value;
        renderPanel(panel);
      });
    }
    const starFilter = panel.querySelector("[data-star-filter]");
    if (starFilter) {
      starFilter.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const filters = panelState.filters;
        if (!(filters.starsSelected instanceof Set)) {
          filters.starsSelected = new Set(STAR_FILTER_VALUES);
        }
        if (button.hasAttribute("data-star-all")) {
          const allSelected = STAR_FILTER_VALUES.every((value) => filters.starsSelected.has(value));
          filters.starsSelected = allSelected ? new Set() : new Set(STAR_FILTER_VALUES);
        } else if (button.hasAttribute("data-star")) {
          const value = Number(button.getAttribute("data-star"));
          if (!Number.isFinite(value)) return;
          if (filters.starsSelected.has(value)) {
            filters.starsSelected.delete(value);
          } else {
            filters.starsSelected.add(value);
          }
        }
        renderPanel(panel);
      });
    }
    const stickerSets = panel.querySelector("[data-sticker-sets]");
    if (stickerSets) {
      stickerSets.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-sticker-id]");
        if (!button) return;
        const stickerId = button.getAttribute("data-sticker-id");
        if (!stickerId) return;
        const filters = panelState.filters;
        if (!(filters.stickerIdsSelected instanceof Set)) {
          filters.stickerIdsSelected = new Set();
        }
        if (filters.stickerIdsSelected.has(stickerId)) {
          filters.stickerIdsSelected.delete(stickerId);
        } else {
          filters.stickerIdsSelected.add(stickerId);
        }
        filters.stickerSelectionInitialized = true;
        renderPanel(panel);
      });
    }
    const expiredFilterEls = panel.querySelectorAll("[data-expired-filter]");
    for (const el of expiredFilterEls) {
      el.addEventListener("input", () => {
        const key = el.getAttribute("data-expired-filter");
        panelState.expiredFilters[key] = el.value;
        renderPanel(panel);
      });
      el.addEventListener("change", () => {
        const key = el.getAttribute("data-expired-filter");
        panelState.expiredFilters[key] = el.value;
        renderPanel(panel);
      });
    }
    const piggybankFilterEls = panel.querySelectorAll("[data-piggybank-filter]");
    for (const el of piggybankFilterEls) {
      el.addEventListener("input", () => {
        const key = el.getAttribute("data-piggybank-filter");
        panelState.piggybankFilters[key] = el.value;
        renderPanel(panel);
      });
      el.addEventListener("change", () => {
        const key = el.getAttribute("data-piggybank-filter");
        panelState.piggybankFilters[key] = el.value;
        renderPanel(panel);
      });
    }
    const expiredLimitInput = panel.querySelector("[data-expired-limit]");
    if (expiredLimitInput) {
      expiredLimitInput.addEventListener("change", () => {
        const limit = Number(String(expiredLimitInput.value || "").trim());
        if (!Number.isFinite(limit) || limit <= 0) return;
        panelState.expiredFilters.limit = Math.floor(limit);
        renderPanel(panel);
      });
    }
    panel.querySelector('[data-action="refresh"]').addEventListener("click", () => {
      renderPanel(panel);
    });
    panel.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.getAttribute("data-tab");
        panelState.activeTab =
          tab === "piggybank"
            ? "piggybank"
            : tab === "expired"
              ? "expired"
              : tab === "debug"
                ? "debug"
                : "raffles";
        panel.querySelectorAll("[data-tab]").forEach((btn) => {
          btn.classList.toggle("active", btn.getAttribute("data-tab") === panelState.activeTab);
        });
        renderPanel(panel);
      });
    });
    panel.querySelector('[data-action="open"]').addEventListener("click", async () => {
      const countInput = panel.querySelector("[data-open-count]");
      const target = Number(String(countInput?.value || "").trim());
      if (!Number.isFinite(target) || target <= 0) {
        warnLog("Invalid count for panel open.");
        return;
      }
      const now = nowSec();
      const openable = panelState.displayedRaffles.filter((raffle) => {
        if (!raffle || typeof raffle !== "object") return false;
        const endTime = toEpochSec(raffle.raffle?.endTime);
        if (!endTime || endTime <= now) return false;
        const linkUrl = toFullUrl(raffle.url || raffle.permalink);
        return Boolean(linkUrl);
      });
      openable.sort((a, b) => toEpochSec(a.raffle?.endTime) - toEpochSec(b.raffle?.endTime));
      const slice = openable.slice(0, target);
      for (const raffle of slice) {
        const linkUrl = toFullUrl(raffle.url || raffle.permalink);
        if (!linkUrl) continue;
        openInBackground(linkUrl);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      renderPanel(panel);
    });
    panel.querySelector('[data-action="close"]').addEventListener("click", () => {
      panelState.visible = false;
      panel.style.display = "none";
    });
    const autoToggles = panel.querySelectorAll("[data-auto]");
    for (const toggle of autoToggles) {
      toggle.addEventListener("change", () => {
        const key = toggle.getAttribute("data-auto");
        const enabled = toggle.checked;
        if (key === "feed") {
          autoRunFeed = enabled;
          if (enabled) startFeedScheduler();
          else stopFeedScheduler();
        } else if (key === "expired") {
          autoRunExpired = enabled;
          if (enabled) startExpiredScheduler();
          else stopExpiredScheduler();
        } else if (key === "claimWins") {
          autoClaimWins = enabled;
        }
        persistSettings();
      });
    }
    const intervalInputs = panel.querySelectorAll("[data-auto-interval]");
    for (const input of intervalInputs) {
      input.addEventListener("change", () => {
        const key = input.getAttribute("data-auto-interval");
        const minutes = Number(String(input.value || "").trim());
        if (!Number.isFinite(minutes) || minutes <= 0) return;
        if (key === "feed") {
          feedIntervalMs = Math.max(1, Math.floor(minutes)) * 60 * 1000;
          if (autoRunFeed) startFeedScheduler();
        } else if (key === "expired") {
          expiredIntervalMs = Math.max(1, Math.floor(minutes)) * 60 * 1000;
          if (autoRunExpired) startExpiredScheduler();
        }
        persistSettings();
      });
    }
    const tuningInputs = panel.querySelectorAll("[data-tune]");
    for (const input of tuningInputs) {
      input.addEventListener("change", () => {
        const key = input.getAttribute("data-tune");
        const value = Number(String(input.value || "").trim());
        if (!Number.isFinite(value) || value < 0) return;
        if (key === "requestDelayMs") {
          requestDelayMs = Math.floor(value);
        } else if (key === "expiredActionDelayMs") {
          expiredActionDelayMs = Math.floor(value);
        }
        persistSettings();
      });
    }
    const runExpiredAction = async (action) => {
      panelState.expiredStatusMessage = "";
      const sortedTargets = [...(panelState.expiredDisplayedRaffles || [])].sort((a, b) => {
        if (
          panelState.expiredFilters.sort === "chron-desc" ||
          panelState.expiredFilters.sort === "chron"
        ) {
          return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "chron-asc") {
          return toEpochSec(a.raffle?.endTime) - toEpochSec(b.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "winner") {
          const winnerA = String(a.winner?.winnerName || a.winner?.winnerId || "").toLowerCase();
          const winnerB = String(b.winner?.winnerName || b.winner?.winnerId || "").toLowerCase();
          if (winnerA < winnerB) return -1;
          if (winnerA > winnerB) return 1;
          return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "stars-desc") {
          const starsA = Number(a.raffle?.stickerStars || 0);
          const starsB = Number(b.raffle?.stickerStars || 0);
          if (starsA !== starsB) return starsB - starsA;
          return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
        }
        if (panelState.expiredFilters.sort === "stars-asc") {
          const starsA = Number(a.raffle?.stickerStars || 0);
          const starsB = Number(b.raffle?.stickerStars || 0);
          if (starsA !== starsB) return starsA - starsB;
          return toEpochSec(a.raffle?.endTime) - toEpochSec(b.raffle?.endTime);
        }
        const nameA = String(a.raffle?.stickerName || a.postTitle || "").toLowerCase();
        const nameB = String(b.raffle?.stickerName || b.postTitle || "").toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return toEpochSec(b.raffle?.endTime) - toEpochSec(a.raffle?.endTime);
      });
      const limit = Math.max(1, Number(panelState.expiredFilters.limit || 10));
      const targets = sortedTargets.slice(0, limit);
      if (!targets.length) {
        warnLog("No expired raffles to process for current filters.");
        return;
      }
      console.log("[FMV:expired:action:start]", {
        action,
        limit,
        total: targets.length,
      });
      const result = await expiredEngine.runManualAction(action, targets, {
        delayMs: expiredActionDelayMs,
        skipFiveStarClaim: true,
        invalidate: false,
      });
      if (result?.statusMessage) {
        panelState.expiredStatusMessage = result.statusMessage;
      }
      renderPanel(panel);
    };
    panel
      .querySelector('[data-action="expired-refresh-token"]')
      .addEventListener("click", async () => {
        await runExpiredAction("refresh-token");
      });
    panel
      .querySelector('[data-action="expired-getraffledata"]')
      .addEventListener("click", async () => {
        await runExpiredAction("getRaffleData");
      });
    panel
      .querySelector('[data-action="expired-claimraffle"]')
      .addEventListener("click", async () => {
        await runExpiredAction("claimRaffle");
      });
    panel
      .querySelector('[data-action="expired-force-settle"]')
      .addEventListener("click", () => {
        forceResolveWinnersForDayPrompt(panelState.expiredFilters.date);
      });
    return panel;
  }

  function togglePanel() {
    uiController.toggle();
  }

  /***************************************************************************
   * export.js
   *
   * Create a readable JSON snapshot for VS Code inspection.
   ***************************************************************************/

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportPrettyStorage(contextLabel = "") {
    // This export rehydrates JSON strings into real objects for inspection.
    // It does not change storage; it just writes a readable snapshot file.
    const output = {};
    output[META_KEY] = loadJsonKey(META_KEY) || {};
    output[STICKER_MAP_KEY] = loadJsonKey(STICKER_MAP_KEY) || {};
    const raffleIndex = raffleStore.getIndexSnapshot();
    const raffleDays = raffleStore.getDaySetSnapshot();
    output[RAFFLE_INDEX_KEY] = raffleIndex;
    output[RAFFLE_DAYS_KEY] = raffleDays;
    output[PIGGYBANK_KEY] = loadJsonKey(PIGGYBANK_KEY) || {};
    output[DEBUG_LOG_DAYS_KEY] = loadJsonKey(DEBUG_LOG_DAYS_KEY) || {};
    const dayKeys = raffleStore.listDayKeys();
    for (const dayKey of dayKeys) {
      output[`${RAFFLE_BUCKET_PREFIX}${dayKey}`] = raffleStore.getBucketSnapshot(dayKey);
    }
    const debugDays = Object.keys(loadDebugLogDays());
    for (const dayKey of debugDays) {
      output[`${DEBUG_LOG_BUCKET_PREFIX}${dayKey}`] = loadDebugLogBucket(dayKey);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `fmv-raffle-storage-${stamp}.json`;
    downloadJson(output, filename);
    recordExportHistory(filename, contextLabel);
    debugLog("storage", "Exported pretty storage", {
      dayCount: dayKeys.length,
      raffleCount: Object.keys(raffleIndex || {}).length,
    });
  }

  /***************************************************************************
   * maintenance.js
   *
   * Small cleanup helpers for debug summaries and old raffle buckets.
   ***************************************************************************/

  /***************************************************************************
   * cleanup_records.js
   *
   * One cleanup entry point that clears BOTH raffle buckets and debug logs
   * prior to a given dayKey. This avoids running two separate commands and
   * keeps historical storage consistent.
   ***************************************************************************/

  function clearRecordsBeforeDatePrompt() {
    const today = formatDayKeyInTimeZone(nowSec(), LOG_TIMEZONE);
    const raw = prompt("Clear records before date (YYYY-MM-DD):", today);
    if (raw === null) return;
    const cutoff = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
      warnLog("Invalid date format for cleanup.");
      return;
    }

    // Always export a snapshot before destructive cleanup.
    exportPrettyStorage("cleanup:clear-records");

    // Clear raffles before the cutoff (excluding the cutoff day itself).
    const batch = raffleStore.beginBatch("clear-records");
    const dayKeys = raffleStore.listDayKeys(batch);
    let rafflesDeleted = 0;
    for (const dayKey of dayKeys) {
      if (dayKey >= cutoff) continue;
      const raffles = raffleStore.listByDay(dayKey, batch);
      for (const raffle of raffles) {
        if (raffleStore.remove(raffle.postId, batch)) {
          rafflesDeleted += 1;
        }
      }
    }
    batch.flush();

    // Clear debug logs before the cutoff (by day bucket).
    const days = loadDebugLogDays();
    const debugDayKeys = Object.keys(days);
    let debugBucketsDeleted = 0;
    for (const dayKey of debugDayKeys) {
      if (dayKey >= cutoff) continue;
      saveDebugLogBucket(dayKey, []);
      delete days[dayKey];
      debugBucketsDeleted += 1;
    }
    saveDebugLogDays(days);

    debugLog("storage", "Cleared records before date", {
      cutoff,
      rafflesDeleted,
      debugBucketsDeleted,
    });
    ui.invalidate("cleanup:clear-records");
  }

  /***************************************************************************
   * bootstrap.js
   *
   * Register menu commands and kick off scheduled work.
   ***************************************************************************/

  GM_registerMenuCommand("FMV Raffles: Fetch Feed Now", async () => {
    await fetchFeedAndStore();
    const stamped = nowSec();
    saveJsonKey(FEED_LAST_RUN_KEY, stamped);
    appendDebugLog("feed-last-run", { source: "manual", stamped });
    debugLog("timers", "Manual feed fetch (30 min schedule); last run updated", stamped);
  });
  GM_registerMenuCommand("FMV Raffles: Start New Album (Fetch Stickerbook)", startNewAlbumBootstrap);
  GM_registerMenuCommand("FMV Raffles: Toggle Panel", togglePanel);
  GM_registerMenuCommand("FMV Raffles: Export storage (pretty)", () =>
    exportPrettyStorage("manual"),
  );
  GM_registerMenuCommand(
    "FMV Raffles: Sync winners to Sheets (Prompt Date)",
    syncWinnersToSheetsPrompt,
  );
  GM_registerMenuCommand(
    "FMV Raffles: Flush pending Sheets sync now",
    flushPendingSheetsSyncNow,
  );
  GM_registerMenuCommand(
    "FMV Raffles: Restore 5★ Winners From Snapshot",
    restoreFiveStarWinnersFromSnapshotPrompt,
  );
  GM_registerMenuCommand("FMV Raffles: Clear Records Before Date", clearRecordsBeforeDatePrompt);
  applySettingsFromStorage();
  backfillStatusFieldsOnce();
  scheduleHourlyFeed();
  scheduleQuarterHourExpiredRefresh();
  if (window.location.href === FEED_URL) {
    panelState.visible = true;
    uiController.render();
  }
  debugLog("boss", "Menu commands installed.");
})();
