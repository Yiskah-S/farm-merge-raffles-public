# FMV Raffle Tracker (Userscript)

A Tampermonkey userscript for tracking, managing, and auditing raffle posts in
**r/FarmMergeValley** with an emphasis on durability, safety, and auditability.

This project grew out of real daily use and prioritizes **state correctness and crash safety** over minimalism.

---

## Purpose

* Track raffle posts from r/FarmMergeValley
* Normalize raffle state into durable, per-day storage
* Provide a UI for discovery, filtering, joining, and auditing raffles
* Safely resolve expired raffles, including winner detection and claims
* Export verified winner data for daily community reporting

---

## Quick start (2 minutes)

1) Install Tampermonkey (Chrome/Firefox).
2) Create a new userscript and paste in `fmv-raffle-tracker-open-only.user.js`.
3) Fill in the **USER CONFIG** block at the top of the script (local only).
4) Open the **boss tab** (required for discovery):
   `https://www.reddit.com/r/FarmMergeValley/?f=flair_name%3A%22%F0%9F%8E%81%20Raffles%2FGiveaways%22`
5) On any Reddit page, open the Tampermonkey menu and click **FMV Raffles: Toggle Panel**.
6) First‑run checklist:
   - Confirm feed discovery runs in the boss tab.
   - Open a few raffles manually to seed tokens.
   - Keep auto‑claim disabled until you review settings.
   - Flip `DEBUG` flags on when you need deep tracing.

## Core Design Principles

* **Storage is the source of truth**
  No derived or UI-only state is persisted.

* **Immediate persistence after mutation**
  Every successful data fetch or state transition is written immediately to avoid
  losing progress on reloads, crashes, or browser restarts.

* **Explicit policy gates**
  Automation (auto-claim, auto-sync) is centralized and opt-in.

* **Single-writer discipline**
  All raffle mutations flow through `raffleStore` to preserve invariants.

* **Crash-safe over “clean”**
  This is a long-running userscript operating against external services;
  defensive design is intentional.

---

## Workflow Overview

### 1. Boss Tab & Feed Discovery

To prevent synchronization issues across multiple Reddit tabs:

* **Automatic feed discovery only runs on a single “boss tab”**
* The boss tab is **explicitly defined** as this page:

```
https://www.reddit.com/r/FarmMergeValley/?f=flair_name%3A%22%F0%9F%8E%81%20Raffles%2FGiveaways%22
```

Only when the script is active on this page will:

* Scheduled feed polling run
* Pagination occur
* New raffles be discovered and normalized

This avoids duplicate ingestion and race conditions across tabs.

> The panel UI can be opened from *any* Reddit page, but background feed work is centralized to the boss tab by design.

---

### 2. Discovery → Normalization → Storage

When the feed runs (automatically or manually):

1. Raffle posts are discovered from the Reddit feed
2. Each raffle is normalized into a canonical shape
3. Raffles are stored in **per-day buckets**, keyed by an inferred day
4. An index maps `postId → dayKey` to allow fast lookups and safe movement

This model:

* Prevents large monolithic storage blobs
* Makes exports readable
* Allows targeted cleanup and recovery

---

### 3. UI Interaction (Manual Phase)

From the panel UI, the user can:

* Filter and sort raffles by:

  * Sticker
  * Star count
  * Status (discovered / expired / inactive / resolved)
* Open raffles individually or in batches


The UI is a **pure projection of storage** — no UI state is treated as authoritative.

---

### 4. Expired Raffle Processing

Once raffles expire, they move into the **Expired Raffles** pipeline.

The logic is intentionally conservative:

1. If a raffle is expired and **has no winner recorded**:

   * Call `getRaffleData`
2. If the winner is the **current user** and:

   * `unrevealedForCurrentUser === true`
   * Auto-claim is enabled
     → Call `claimRaffle`, then `getRaffleData` again to resolve
3. If the winner is **not the current user**:

   * The result is queued for Google Sheets export

All steps are:

* Idempotent
* Persisted immediately
* Logged for auditability

---

### 5. Auto-Claim Policy & Piggybank

* **5★ raffles are never auto-claimed**
* Any 5★ win by the current user is routed to the **Piggybank** tab
* Piggybank claims are always manual

This ensures high-value wins are never touched by automation.

Auto-claim for non-5★ wins can be toggled on/off in the Debug & Auto tab.

---

### 6. Google Sheets Sync & Daily Reporting

* Winners **other than the current user** are batched and sent to Google Sheets
* Batches are capped at **100 rows per request**
* Sync is deduplicated via per-post fingerprints
* At the end of the day:

  * Storage is exported
  * External scripts validate results
  * A daily winners post is created from the verified data

The userscript itself remains **read-only** with respect to reporting;
publishing is handled externally.

---

## File Structure (Single-File by Design)

This userscript is intentionally kept as a **single file** for rapid iteration.

Logical modules are separated via section headers rather than physical files:

```js
// Sections:
//  - constants / policy / debug
//  - storage + bucket model
//  - raffleStore / reverifyStore
//  - network + API wrappers
//  - discovery + normalization
//  - expired & reverify engines
//  - UI projection + controller
//  - maintenance & export
```

### Why not split into modules?

During development, iteration speed mattered more than build hygiene:

* Changes were frequent and experimental
* Rebuilding via esbuild / Vite slowed feedback loops
* Crashes and reloads were common while tuning logic

For a solo userscript under active development, **inline modularization won**.

The structure is deliberately written so it *can* be split and bundled later if needed.

---

## Known Limitations / Design Tradeoffs

* **Single file** for iteration speed (no bundler/build step).
* **Immediate writes** to Tampermonkey storage for crash safety.
* **Storage size** depends on Tampermonkey limits; large histories may need cleanup.
* **Boss tab requirement** for discovery to avoid race conditions across tabs.
* **Endpoint coupling** to Reddit/Devvit APIs and markup; changes may require patches.

---

## Immediate Writes vs Batched Writes (Intentional Tradeoff)

While batching writes is generally preferable, this script writes immediately because:

* Browser crashes, reloads, and tab closures were frequent during testing
* Losing state caused repeated API calls to the same raffles
* Repeated calls increased the risk of:

  * Rate limiting
  * Unnecessary load
  * Unclear failure states

Immediate persistence ensures:

* Progress is never lost
* The script does not “forget” what it already processed
* External services are hit **less**, not more

This choice is explicitly documented and localized to storage helpers.

---

## Safety Guarantees

* No auto-claiming of 5★ wins
* All automation is toggleable
* Inactive (401 / deleted) raffles are isolated
* All destructive actions are user-initiated

---

## About This Project

This is my **first JavaScript project**.

Feedback is especially welcome on:

* Architecture
* Naming
* API boundaries
* State modeling
