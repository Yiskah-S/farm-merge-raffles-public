#!/usr/bin/env python3
"""
===============================================================================
export_reverify_list.py
-------------------------------------------------------------------------------
Purpose:
  Build a JSON list of 5★ raffles (or any star filter) sorted by participant
  count, so the list can be imported into the Tampermonkey "Reverify old data"
  tab for refresh.
===============================================================================
"""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a sorted list of raffles for re-verification."
    )
    parser.add_argument(
        "--stars",
        default="5",
        help="Comma-separated list of stars to include (default: 5). Use 'all' for all.",
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
        "--include-active",
        action="store_true",
        help="Include raffles that have not ended yet (default: false).",
    )
    parser.add_argument(
        "--out-json",
        default=None,
        help=(
            "Output JSON path. If omitted, uses "
            "data/verification/reverify-5star-list.json."
        ),
    )
    return parser.parse_args()


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


def to_epoch_sec(value):
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num:
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


def get_end_time(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    raw = None
    if isinstance(raffle_data, dict):
        raw = raffle_data.get("endTime")
    if raw is None and isinstance(raffle, dict):
        raw = raffle.get("endTime")
    return to_epoch_sec(raw)


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


def get_sticker_name(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    if isinstance(raffle_data, dict) and raffle_data.get("stickerName"):
        return raffle_data.get("stickerName")
    return raffle.get("postTitle") or "(unknown)"


def score_entry(entry: dict):
    winner = entry.get("winner") or {}
    raffle = entry.get("raffle") or {}
    return (
        1 if (winner.get("winnerName") or winner.get("winnerId")) else 0,
        1
        if (raffle.get("participantCount") is not None or raffle.get("participantIds") is not None)
        else 0,
        1 if (raffle.get("stickerStars") is not None) else 0,
        1 if (raffle.get("stickerName") is not None) else 0,
    )


def main() -> int:
    args = parse_args()
    project_root = Path.cwd()
    daily_dir = project_root / args.daily_dir
    if not daily_dir.exists():
        raise SystemExit(f"Daily dir not found: {daily_dir}")

    if args.stars.strip().lower() == "all":
        star_filter = None
    else:
        star_filter = {int(item.strip()) for item in args.stars.split(",") if item.strip()}

    storage_file = (
        Path(args.storage_file)
        if args.storage_file
        else find_latest_storage_file(project_root)
    )

    out_dir = project_root / "data" / "verification"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_json = (
        Path(args.out_json)
        if args.out_json
        else out_dir / "reverify-5star-list.json"
    )

    now_sec = int(time.time())

    entries_by_post = {}
    day_keys_by_post = {}

    def consider(day_key, post_id, entry):
        existing = entries_by_post.get(post_id)
        if existing is None or score_entry(entry) > score_entry(existing):
            entries_by_post[post_id] = entry
            day_keys_by_post[post_id] = day_key

    for path in sorted(daily_dir.glob("Raffles-*.json")):
        for day_key, post_id, entry in iter_raffles_from_file(path):
            consider(day_key, post_id, entry)

    if storage_file and storage_file.exists():
        for day_key, post_id, entry in iter_raffles_from_file(storage_file):
            consider(day_key, post_id, entry)

    items = []
    for post_id, entry in entries_by_post.items():
        star = get_star(entry)
        if star_filter is not None and star not in star_filter:
            continue
        end_time = get_end_time(entry)
        ended = bool(end_time and end_time <= now_sec)
        if not args.include_active and not ended:
            continue
        count, ids_len = get_participant_info(entry)
        items.append(
            {
                "postId": post_id,
                "dayKey": day_keys_by_post.get(post_id, ""),
                "endTime": end_time,
                "stickerStars": star,
                "stickerName": get_sticker_name(entry),
                "participantCount": count,
                "participantIdsLength": ids_len,
                "permalink": entry.get("permalink") or entry.get("url") or "",
                "postTitle": entry.get("postTitle") or "",
            }
        )

    def sort_key(item):
        count = item.get("participantCount")
        if count is None:
            return (-1, item.get("postId") or "")
        return (count, item.get("postId") or "")

    items.sort(key=sort_key, reverse=True)

    payload = {
        "meta": {
            "stars": sorted(star_filter) if star_filter is not None else "all",
            "includeActive": args.include_active,
            "count": len(items),
        },
        "items": items,
    }

    with out_json.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)

    print(f"Wrote {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
