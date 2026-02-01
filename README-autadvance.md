# FMV Sticker Collect - Auto Advance

fmv-sticker-collect-autoadvance.user.js userscript that automates the
Farm Merge Valley sticker collect flow in the Devvit webview. It reduces
repetitive clicks by auto-collecting rewards and (optionally) skipping
animations or declining raffle proposals.

## Why this exists
Opening sticker packs can involve repeated clicks across many screens.
This script is a small quality-of-life tool to reduce that friction while
keeping behavior explicit and controllable.

## What it does
- Detects the sticker collect UI inside Devvit webviews.
- Optionally auto-clicks the Collect button after reveal completes.
- Optionally auto-skips pack animations.
- Optionally auto-declines raffle proposals after collect.
- Includes a capture logger to record click positions for tuning.
- Includes an input fallback that simulates clicks when direct hooks fail.

## Safety / intent
- Defaults are conservative (most automation toggles are off).
- The script only runs on `https://*.devvit.net/*`.
- It is intended for personal use to reduce repetitive UI work.

## Quick start (2 minutes)
1) Install Tampermonkey (Chrome/Firefox).
2) Create a new userscript and paste in `fmv-sticker-collect-autoadvance.user.js`.
3) Open the Farm Merge Valley sticker collect flow (Devvit webview).
4) First‑run checklist:
   - Verify the script logs once in the console.
   - Turn on only the toggles you want (auto‑collect, skip, decline).
   - If buttons fail to trigger, enable the input fallback.
   - Enable capture only when you need to retune click targets.

## Install
1) Install Tampermonkey (Chrome/Firefox).
2) Create a new userscript and paste in:
   `fmv-sticker-collect-autoadvance.user.js`
3) Save and enable the script.

## Configure
Edit the `CONFIG` block near the top of the script:
- `autoCollect`: auto-click Collect
- `autoSkip`: auto-skip pack animation
- `autoDeclineRaffle`: auto-decline raffle proposal
- `scanIntervalMs`: how often to scan for UI
- `inputFallbackEnabled`: enable simulated clicks

## Notes
- The capture logger helps refine click targets if the UI layout changes.
- If the Devvit runtime changes, the fallback click targets may need updating.

## Known Limitations / Design Tradeoffs
- **Single file** for rapid iteration (no build step).
- **Canvas‑position heuristics** can drift when the UI layout changes.
- **Input fallback** simulates clicks; it is a last‑resort for isolated runtimes.
- **Devvit coupling** means runtime changes may require retuning delays/targets.

## Disclaimer
Not affiliated with Reddit or Farm Merge Valley. Use at your own risk.
