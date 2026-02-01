#!/usr/bin/env python3
"""
===============================================================================
verify_participant_counts.py
-------------------------------------------------------------------------------
Purpose:
  Read-only verification of participant counts. This script scans raffle
  snapshots and flags suspiciously low participant counts (especially 5★),
  plus any mismatch between participantCount and participantIds length.

Why:
  Early records can under-report participants if enrichment happened before
  the raffle ended. This produces artificially low odds. The report surfaces
  those cases without mutating storage.
===============================================================================
"""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path


"""
===============================================================================
cli_args
-------------------------------------------------------------------------------
Beginner-friendly note:
  Run with defaults:
    python scripts/verify_participant_counts.py

  Or target stars explicitly:
    python scripts/verify_participant_counts.py --stars 5
===============================================================================
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify participant counts and flag suspiciously low values."
    )
    parser.add_argument(
        "--daily-dir",
        default="data/daily-results",
        help="Directory containing daily JSON snapshots (default: data/daily-results).",
    )
    parser.add_argument(
        "--storage-file",
        default=None,
        help=(
            "Optional storage snapshot JSON file. If omitted, the newest "
            "fmv-raffle-storage-*.json in the project root is used."
        ),
    )
    parser.add_argument(
        "--stars",
        default="5",
        help="Comma-separated list of stars to flag (default: 5). Use 'all' for all.",
    )
    parser.add_argument(
        "--min-count",
        type=int,
        default=5,
        help="Absolute minimum participants to consider 'not suspicious' (default: 5).",
    )
    parser.add_argument(
        "--iqr-mult",
        type=float,
        default=1.5,
        help="IQR multiplier for low outlier detection (default: 1.5).",
    )
    parser.add_argument(
        "--five-star-rel",
        type=float,
        default=0.25,
        help="5★ relative threshold vs median (default: 0.25, meaning <25%% of median).",
    )
    parser.add_argument(
        "--out-md",
        default=None,
        help=(
            "Output Markdown path. If omitted, uses "
            "data/verification/participant-count-audit.md."
        ),
    )
    parser.add_argument(
        "--out-json",
        default=None,
        help=(
            "Output JSON path. If omitted, uses "
            "data/verification/participant-count-audit.json."
        ),
    )
    return parser.parse_args()


"""
===============================================================================
file_discovery
-------------------------------------------------------------------------------
Beginner-friendly note:
  We scan two sources:
    1) data/daily-results/Raffles-*.json snapshots
    2) one storage snapshot (fmv-raffle-storage-*.json)
===============================================================================
"""


def find_latest_storage_file(project_root: Path) -> Path | None:
    candidates = sorted(project_root.glob("fmv-raffle-storage-*.json"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def iter_raffle_buckets(obj):
    if not isinstance(obj, dict):
        return
    for key, value in obj.items():
        if not isinstance(key, str):
            continue
        if not key.startswith("fmvTracker:raffles:"):
            continue
        day_key = key.split(":")[-1]
        if isinstance(value, dict):
            yield day_key, value


def iter_raffles_from_file(path: Path):
    data = load_json(path)
    for day_key, bucket in iter_raffle_buckets(data):
        for post_id, raffle in bucket.items():
            if not isinstance(raffle, dict):
                continue
            yield day_key, post_id, raffle


"""
===============================================================================
value_helpers
-------------------------------------------------------------------------------
Beginner-friendly note:
  These helpers normalize values so the audit logic stays simple.
===============================================================================
"""


def to_epoch_sec(value):
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num:  # NaN
        return None
    return int(num / 1000) if num >= 1e12 else int(num)


def get_star(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    raw = None
    if isinstance(raffle_data, dict):
        raw = raffle_data.get("stickerStars")
    if raw is None and isinstance(raffle, dict):
        raw = raffle.get("stickerStars")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def get_participant_info(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    if not isinstance(raffle_data, dict):
        return None, None
    ids = raffle_data.get("participantIds")
    ids_len = len(ids) if isinstance(ids, list) else None
    count_raw = raffle_data.get("participantCount")
    try:
        count = int(count_raw)
    except (TypeError, ValueError):
        count = None
    if count is None and ids_len is not None:
        count = ids_len
    return count, ids_len


def get_end_time(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    raw = None
    if isinstance(raffle_data, dict):
        raw = raffle_data.get("endTime")
    if raw is None and isinstance(raffle, dict):
        raw = raffle.get("endTime")
    return to_epoch_sec(raw)


def get_sticker_name(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    if isinstance(raffle_data, dict) and raffle_data.get("stickerName"):
        return raffle_data.get("stickerName")
    return raffle.get("postTitle") or "(unknown)"


def get_winner(raffle: dict):
    winner = raffle.get("winner")
    if isinstance(winner, dict):
        return winner.get("winnerId"), winner.get("winnerName") or ""
    return raffle.get("winnerId"), raffle.get("winnerName") or ""


def normalize_name(raw: str) -> str:
    if not raw:
        return ""
    name = str(raw).strip().lstrip("/")
    if name.lower().startswith("u/"):
        name = name[2:]
    return name.strip()


def winner_present(raffle: dict) -> bool:
    winner_id, winner_name = get_winner(raffle)
    if winner_id:
        return True
    return normalize_name(str(winner_name)) != ""


"""
===============================================================================
stats_helpers
-------------------------------------------------------------------------------
Beginner-friendly note:
  We compute basic distribution stats to detect unusually low counts.
===============================================================================
"""


def percentile(values, pct):
    if not values:
        return None
    values = sorted(values)
    if len(values) == 1:
        return values[0]
    k = (len(values) - 1) * (pct / 100.0)
    f = int(k)
    c = min(f + 1, len(values) - 1)
    if f == c:
        return values[f]
    return values[f] + (values[c] - values[f]) * (k - f)


def compute_stats(values):
    if not values:
        return {
            "n": 0,
            "min": None,
            "p10": None,
            "p25": None,
            "median": None,
            "p75": None,
            "p90": None,
            "max": None,
            "iqr": None,
        }
    values = sorted(values)
    p10 = percentile(values, 10)
    p25 = percentile(values, 25)
    p50 = percentile(values, 50)
    p75 = percentile(values, 75)
    p90 = percentile(values, 90)
    iqr = None
    if p25 is not None and p75 is not None:
        iqr = p75 - p25
    return {
        "n": len(values),
        "min": values[0],
        "p10": p10,
        "p25": p25,
        "median": p50,
        "p75": p75,
        "p90": p90,
        "max": values[-1],
        "iqr": iqr,
    }


"""
===============================================================================
main_audit
-------------------------------------------------------------------------------
Beginner-friendly note:
  We build a unified record list, compute per-star stats (ended raffles only),
  then flag suspiciously low counts and any count/id mismatches.
===============================================================================
"""


def main() -> int:
    args = parse_args()
    project_root = Path.cwd()
    daily_dir = project_root / args.daily_dir
    if not daily_dir.exists():
        raise SystemExit(f"Daily dir not found: {daily_dir}")

    storage_file = (
        Path(args.storage_file)
        if args.storage_file
        else find_latest_storage_file(project_root)
    )

    out_dir = project_root / "data" / "verification"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_md = Path(args.out_md) if args.out_md else out_dir / "participant-count-audit.md"
    out_json = Path(args.out_json) if args.out_json else out_dir / "participant-count-audit.json"

    if args.stars.strip().lower() == "all":
        star_filter = None
    else:
        star_filter = {
            int(item.strip()) for item in args.stars.split(",") if item.strip()
        }

    now_sec = int(time.time())

    records = []
    source_files = sorted(daily_dir.glob("Raffles-*.json"))
    if storage_file and storage_file.exists():
        source_files.append(storage_file)

    seen = set()
    for path in source_files:
        for day_key, post_id, raffle in iter_raffles_from_file(path):
            if post_id in seen:
                continue
            seen.add(post_id)
            stars = get_star(raffle)
            end_time = get_end_time(raffle)
            ended = bool(end_time and end_time <= now_sec)
            settled = winner_present(raffle)
            count, ids_len = get_participant_info(raffle)
            records.append(
                {
                    "postId": post_id,
                    "dayKey": day_key,
                    "stars": stars,
                    "stickerName": get_sticker_name(raffle),
                    "endTime": end_time,
                    "ended": ended,
                    "settled": settled,
                    "participantCount": count,
                    "participantIdsLength": ids_len,
                }
            )

    # Per-star stats (ended raffles only).
    per_star_counts = defaultdict(list)
    for row in records:
        if not row["ended"] or not row["settled"]:
            continue
        if row["participantCount"] is None:
            continue
        star_key = row["stars"] if row["stars"] is not None else "unknown"
        per_star_counts[star_key].append(row["participantCount"])

    per_star_stats = {k: compute_stats(v) for k, v in per_star_counts.items()}

    mismatches = []
    low_outliers = []

    for row in records:
        stars = row["stars"]
        if star_filter is not None and stars not in star_filter:
            continue
        if not row["ended"] or not row["settled"]:
            continue
        count = row["participantCount"]
        ids_len = row["participantIdsLength"]

        if ids_len is not None and count is not None and ids_len != count:
            mismatches.append({**row, "reason": "count-mismatch"})

        if count is None:
            continue

        star_key = stars if stars is not None else "unknown"
        stats = per_star_stats.get(star_key)
        if not stats or stats["n"] == 0:
            continue

        thresholds = [args.min_count]
        if stats["p10"] is not None:
            thresholds.append(stats["p10"] * 0.5)
        if stats["iqr"] is not None and stats["p25"] is not None:
            thresholds.append(stats["p25"] - (args.iqr_mult * stats["iqr"]))
        if stars == 5 and stats["median"] is not None:
            thresholds.append(stats["median"] * args.five_star_rel)

        # Ignore negative thresholds.
        threshold = max(t for t in thresholds if t is not None and t > 0)
        if count < threshold:
            low_outliers.append(
                {
                    **row,
                    "threshold": round(threshold, 2),
                    "reason": "low-outlier",
                }
            )

    # Sort outliers by count ascending then date.
    low_outliers.sort(key=lambda r: (r["participantCount"], r["dayKey"], r["postId"]))
    mismatches.sort(key=lambda r: (r["dayKey"], r["postId"]))

    summary = {
        "records": len(records),
        "ended": sum(1 for r in records if r["ended"]),
        "settled": sum(1 for r in records if r["ended"] and r["settled"]),
        "withCounts": sum(
            1
            for r in records
            if r["ended"] and r["settled"] and r["participantCount"] is not None
        ),
        "mismatchCount": len(mismatches),
        "lowOutlierCount": len(low_outliers),
        "starFilter": sorted(star_filter) if star_filter is not None else "all",
        "minCount": args.min_count,
        "iqrMult": args.iqr_mult,
        "fiveStarRel": args.five_star_rel,
        "sources": [str(p) for p in source_files],
    }

    # Write JSON summary + details.
    with out_json.open("w", encoding="utf-8") as handle:
        json.dump(
            {
                "summary": summary,
                "perStarStats": per_star_stats,
                "lowOutliers": low_outliers,
                "mismatches": mismatches,
            },
            handle,
            indent=2,
        )

    # Write Markdown report.
    with out_md.open("w", encoding="utf-8") as handle:
        handle.write("# Participant Count Audit\n\n")
        handle.write("Read-only verification of participant counts.\n\n")
        handle.write("## Summary\n\n")
        handle.write(f"- Records scanned: **{summary['records']}**\n")
        handle.write(f"- Ended raffles: **{summary['ended']}**\n")
        handle.write(f"- Settled raffles (winner present): **{summary['settled']}**\n")
        handle.write(f"- Settled raffles with counts: **{summary['withCounts']}**\n")
        handle.write(f"- Low-count outliers flagged: **{summary['lowOutlierCount']}**\n")
        handle.write(f"- Count mismatches flagged: **{summary['mismatchCount']}**\n")
        handle.write(f"- Star filter: **{summary['starFilter']}**\n")
        handle.write(
            f"- Thresholds: min={args.min_count}, "
            f"iqrMult={args.iqr_mult}, fiveStarRel={args.five_star_rel}\n\n"
        )

        handle.write("## Per-star participant count stats (ended only)\n\n")
        handle.write(
            "| Stars | N | Min | P10 | P25 | Median | P75 | P90 | Max | IQR |\n"
        )
        handle.write("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
        for star_key in sorted(
            per_star_stats.keys(),
            key=lambda k: (k if isinstance(k, int) else 99),
        ):
            stats = per_star_stats[star_key]
            handle.write(
                f"| {star_key} | {stats['n']} | {stats['min']} | "
                f"{stats['p10']} | {stats['p25']} | {stats['median']} | "
                f"{stats['p75']} | {stats['p90']} | {stats['max']} | "
                f"{stats['iqr']} |\n"
            )
        handle.write("\n")

        handle.write("## Low-count outliers (ended, filtered stars)\n\n")
        handle.write(
            "| Date | Stars | Count | IDs Len | Threshold | Sticker | Post ID |\n"
        )
        handle.write("| --- | --- | --- | --- | --- | --- | --- |\n")
        for row in low_outliers:
            handle.write(
                f"| {row['dayKey']} | {row['stars']} | {row['participantCount']} | "
                f"{row['participantIdsLength']} | {row['threshold']} | "
                f"{row['stickerName']} | {row['postId']} |\n"
            )
        handle.write("\n")

        handle.write("## Count mismatches (participantCount vs IDs length)\n\n")
        handle.write("| Date | Stars | Count | IDs Len | Sticker | Post ID |\n")
        handle.write("| --- | --- | --- | --- | --- | --- |\n")
        for row in mismatches:
            handle.write(
                f"| {row['dayKey']} | {row['stars']} | {row['participantCount']} | "
                f"{row['participantIdsLength']} | {row['stickerName']} | "
                f"{row['postId']} |\n"
            )

    print(f"Wrote {out_md}")
    print(f"Wrote {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
