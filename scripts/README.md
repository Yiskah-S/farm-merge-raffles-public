# Scripts

This folder contains small, focused utilities for extracting daily raffle data,
generating daily posts, auditing participant counts, and producing per‑user
stats. Most scripts are read‑only and operate on JSON snapshots.

## Daily workflow (typical)
1) Extract the finished day bucket into `data/daily-results`:
   - `python scripts/extract_daily.py path/to/fmv-raffle-storage-YYYY-MM-DD.json YYYY-MM-DD --run-dash`
2) Generate the daily winners sheet TSV + stats + post template:
   - `python scripts/generate_daily_post.py path/to/fmv-raffle-storage-YYYY-MM-DD.json YYYY-MM-DD`
3) (Optional) Export wins-by-day markdown for sharing:
   - `python scripts/export-wins-by-day.py data/daily-results/Raffles-YYYY-MM-DD.json`
4) (Optional) Run audits for counts or reverify lists as needed.

## Script index

### apps-script-fmv-winners-webhook.gs
Google Apps Script webhook for Sheets.
- Accepts a daily batch payload and upserts rows into a date‑named tab.
- Preserves `firstPostedAt` on subsequent upserts.
- Sorts by winner name, then by first posted time.

### extract_daily.py
Extract a single day’s raffle bucket from a storage snapshot.
- Writes `data/daily-results/Raffles-YYYY-MM-DD.json`.
- Optionally refreshes the dashboard via `raffle_dash.py`.

### generate_daily_post.py
Creates daily artifacts from a storage snapshot.
- Outputs:
  - `data/daily-results/Raffles-YYYY-MM-DD.json`
  - `data/daily-results/sheets/YYYY-MM-DD.tsv`
  - `data/daily-results/winners/winners-YYYY-MM-DD.md`
  - `data/daily-results/unrevealed/unrevealed-YYYY-MM-DD.txt`
  - `data/daily-results/posts/post-YYYY-MM-DD.md`
  - Updates `data/daily-results/daily-stats.md`

### raffle_dash.py
Builds rollup summaries from daily snapshots.
- Outputs `data/daily-results/summary.json` + `summary.md`.
- Supports timezone bucketing and optional per‑user entered stats.

### stats_by_user.py
Per‑user raffle report (entered vs won).
- Accepts `--user-id` or `--user-name`.
- Reads daily snapshots + optional newest storage snapshot.
- Outputs `data/stats-by-user/<user>.md`.

### export-wins-by-day.py
Exports a simple “wins by day” markdown file.
- Input: one or more `Raffles-YYYY-MM-DD.json` files.
- Output: `data/daily-results/wins-YYYY-MM-DD.md`.

### export_reverify_list.py
Builds a JSON list of raffles to reverify (typically 5★), sorted by count.
- Input: daily snapshots (+ optional newest storage snapshot).
- Output: `data/verification/reverify-5star-list.json`.

### verify_participant_counts.py
Audits participant counts for suspiciously low values or mismatches.
- Scans daily snapshots (+ optional storage snapshot).
- Outputs `data/verification/participant-count-audit.md` and `.json`.

## Notes
- All scripts assume UTF‑8 JSON snapshots and a project layout with `data/`.
- None of these scripts mutate the original storage snapshot.
