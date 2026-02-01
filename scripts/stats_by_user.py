#!/usr/bin/env python3
"""
===============================================================================
stats_by_user.py
-------------------------------------------------------------------------------
Purpose:
  Generate a per-user raffle report that answers "entered vs won" questions.
  The report is written as Markdown and includes:
    - Overall expected vs actual win rates
    - Totals by star count
    - Entries/wins by date + star
    - Full lists of entered and won raffles
===============================================================================
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from pathlib import Path


"""
===============================================================================
cli_args
-------------------------------------------------------------------------------
Beginner-friendly note:
  We keep the CLI small and explicit so you can run:
    python scripts/stats_by_user.py --user-id t2_abc123
  and get a report without editing code.
===============================================================================
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a per-user raffle stats report."
    )
    parser.add_argument(
        "--user-id",
        default=None,
        help="Reddit user id to analyze (example: t2_10kc43).",
    )
    parser.add_argument(
        "--user-name",
        default=None,
        help="Reddit username to analyze (example: Cee94).",
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
        "--label",
        default=None,
        help="Optional report label (used for the title and default output name).",
    )
    parser.add_argument(
        "--out-md",
        default=None,
        help=(
            "Output Markdown path. If omitted, uses data/stats-by-user/<label>.md "
            "or data/stats-by-user/<user-id>.md."
        ),
    )
    args = parser.parse_args()
    if not args.user_id and not args.user_name:
        parser.error("Provide --user-id or --user-name.")
    return args


"""
===============================================================================
file_discovery
-------------------------------------------------------------------------------
Beginner-friendly note:
  We scan two sources:
    1) data/daily-results/Raffles-*.json snapshots
    2) a single storage snapshot (fmv-raffle-storage-*.json)

  The storage file is optional but useful for the newest data.
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


"""
===============================================================================
raffle_extraction
-------------------------------------------------------------------------------
Beginner-friendly note:
  Each daily JSON file stores buckets under keys like:
    fmvTracker:raffles:YYYY-MM-DD

  We read those buckets and preserve the day key so we can group results
  by date later on.
===============================================================================
"""


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
raffle_helpers
-------------------------------------------------------------------------------
Beginner-friendly note:
  These helpers normalize values so the rest of the script can be simple.
  They do not mutate data; they only read and interpret it.
===============================================================================
"""


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


def get_participant_count(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    if not isinstance(raffle_data, dict):
        return None
    count_raw = raffle_data.get("participantCount")
    try:
        return int(count_raw)
    except (TypeError, ValueError):
        pass
    ids = raffle_data.get("participantIds")
    if isinstance(ids, list):
        return len(ids)
    return None


def get_participant_ids(raffle: dict):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    if not isinstance(raffle_data, dict):
        return []
    ids = raffle_data.get("participantIds")
    return ids if isinstance(ids, list) else []


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
    if winner_name is None:
        return False
    return normalize_name(str(winner_name)) != ""


def get_permalink(raffle: dict):
    return raffle.get("permalink") or raffle.get("url") or ""


def score_entry(entry: dict):
    """
    Score entries to prefer the most complete snapshot when duplicates exist.
    Higher scores win.
    """

    winner = entry.get("winner") or {}
    raffle = entry.get("raffle") or {}
    return (
        1 if (winner.get("winnerName") or winner.get("winnerId")) else 0,
        1 if (raffle.get("participantCount") is not None or raffle.get("participantIds") is not None) else 0,
        1 if (raffle.get("stickerStars") is not None) else 0,
        1 if (raffle.get("stickerName") is not None) else 0,
    )


"""
===============================================================================
user_resolution
-------------------------------------------------------------------------------
Beginner-friendly note:
  The storage snapshots contain winnerId + winnerName pairs. We scan those
  pairs to build a lookup so the script can accept either a user id or a
  username, then resolve the missing half when possible.
===============================================================================
"""


def pick_most_common(counter: Counter):
    if not counter:
        return None
    # Sort by count desc, then key asc for deterministic output.
    return sorted(counter.items(), key=lambda item: (-item[1], str(item[0])))[0][0]


def build_winner_index(paths):
    name_to_ids = defaultdict(Counter)
    id_to_names = defaultdict(Counter)
    name_display = defaultdict(Counter)

    for path in paths:
        for _day_key, _post_id, raffle in iter_raffles_from_file(path):
            winner_id, winner_name = get_winner(raffle)
            if not winner_id and not winner_name:
                continue
            normalized = normalize_name(winner_name)
            if winner_id and normalized:
                name_key = normalized.lower()
                name_to_ids[name_key][winner_id] += 1
                id_to_names[winner_id][normalized] += 1
                name_display[name_key][normalized] += 1

    return name_to_ids, id_to_names, name_display


def resolve_user(user_id, user_name, name_to_ids, id_to_names, name_display):
    warnings = []
    resolved_id = user_id.strip() if user_id else None
    resolved_name = normalize_name(user_name) if user_name else None

    name_key = resolved_name.lower() if resolved_name else None
    candidate_id = pick_most_common(name_to_ids.get(name_key, Counter())) if name_key else None

    if resolved_id and candidate_id and resolved_id != candidate_id:
        warnings.append(
            f"Name lookup points to {candidate_id}, but --user-id is {resolved_id}."
        )

    if not resolved_id:
        resolved_id = candidate_id

    if not resolved_id:
        raise SystemExit(
            "Could not resolve user id from winner data. "
            "Provide --user-id explicitly or ensure the username appears in winner records."
        )

    if not resolved_name:
        resolved_name = pick_most_common(id_to_names.get(resolved_id, Counter()))
    else:
        # Ensure we use the most common casing for the name if available.
        resolved_name = pick_most_common(name_display.get(name_key, Counter())) or resolved_name

    return resolved_id, resolved_name, warnings


"""
===============================================================================
report_generation
-------------------------------------------------------------------------------
Beginner-friendly note:
  The report is intentionally verbose because these requests often come from
  "this person must be cheating" claims. The report lays out the inputs
  (entries + odds) and the outputs (wins) so the math is visible.
===============================================================================
"""


def build_report(
    user_id: str,
    user_name: str | None,
    entries_by_date: dict,
    out_path: Path,
    label: str | None,
):
    entered_rows = []
    won_rows = []

    expected_total = 0.0
    entries_total = 0
    wins_total = 0
    missing_counts = 0
    unresolved_excluded = 0

    per_date_star = defaultdict(
        lambda: {"entries": 0, "wins": 0, "expected": 0.0, "missing": 0}
    )
    per_star = defaultdict(
        lambda: {"entries": 0, "wins": 0, "expected": 0.0, "missing": 0}
    )

    for date in sorted(entries_by_date.keys()):
        for post_id, entry in entries_by_date[date].items():
            if not winner_present(entry):
                unresolved_excluded += 1
                continue
            raffle = entry.get("raffle") or {}
            stars = get_star(entry)
            sticker_name = raffle.get("stickerName") or entry.get("postTitle") or ""
            winner_id, winner_name = get_winner(entry)
            permalink = get_permalink(entry)

            entered_rows.append(
                {
                    "date": date,
                    "stars": stars,
                    "stickerName": sticker_name,
                    "postId": post_id,
                    "winnerName": winner_name,
                    "permalink": permalink,
                }
            )

            entries_total += 1
            if winner_id == user_id:
                wins_total += 1
                won_rows.append(
                    {
                        "date": date,
                        "stars": stars,
                        "stickerName": sticker_name,
                        "postId": post_id,
                        "winnerName": winner_name,
                        "permalink": permalink,
                    }
                )

            count = get_participant_count(entry)
            date_key = (date, stars if stars is not None else "unknown")
            per_date_star[date_key]["entries"] += 1
            per_star[stars if stars is not None else "unknown"]["entries"] += 1

            if winner_id == user_id:
                per_date_star[date_key]["wins"] += 1
                per_star[stars if stars is not None else "unknown"]["wins"] += 1

            if count and count > 0:
                odds = 1.0 / count
                expected_total += odds
                per_date_star[date_key]["expected"] += odds
                per_star[stars if stars is not None else "unknown"]["expected"] += odds
            else:
                missing_counts += 1
                per_date_star[date_key]["missing"] += 1
                per_star[stars if stars is not None else "unknown"]["missing"] += 1

    entered_rows.sort(
        key=lambda r: (r["date"], r["stars"] if r["stars"] is not None else 99, r["postId"])
    )
    won_rows.sort(
        key=lambda r: (r["date"], r["stars"] if r["stars"] is not None else 99, r["postId"])
    )

    title = label or user_id

    with out_path.open("w", encoding="utf-8") as handle:
        handle.write(f"# {title}\n\n")
        handle.write(f"User ID: `{user_id}`\n")
        if user_name:
            handle.write(f"User name: `{user_name}`\n")
        handle.write("\n")
        handle.write(
            "This report treats a raffle as entered when the user id appears in "
            "`raffle.participantIds` in storage snapshots.\n"
        )
        handle.write(
            "Expected wins use per-raffle odds: `1 / participantCount` "
            "(or `len(participantIds)` when the count is missing).\n\n"
        )

        handle.write("## Overall rates\n\n")
        handle.write(f"- Total entries: **{entries_total}**\n")
        handle.write(f"- Total wins: **{wins_total}**\n")
        handle.write(
            f"- Excluded unresolved entries (no winner yet): **{unresolved_excluded}**\n"
        )
        if entries_total:
            actual_rate = wins_total / entries_total
            handle.write(f"- Actual win rate: **{actual_rate:.4%}**\n")
        if expected_total > 0:
            expected_rate = expected_total / entries_total if entries_total else 0.0
            handle.write(f"- Expected wins: **{expected_total:.2f}**\n")
            handle.write(f"- Expected win rate: **{expected_rate:.4%}**\n")
        else:
            handle.write("- Expected wins: **n/a** (no participant counts)\n")
        handle.write(f"- Entries missing participant counts: **{missing_counts}**\n\n")

        handle.write("## Totals by star\n\n")
        handle.write(
            "| Stars | Entries | Wins | Expected wins | Expected win rate | Missing counts |\n"
        )
        handle.write("| --- | --- | --- | --- | --- | --- |\n")
        for stars in sorted(
            per_star.keys(), key=lambda k: (k if isinstance(k, int) else 99)
        ):
            data = per_star[stars]
            entries = data["entries"]
            wins = data["wins"]
            expected = data["expected"]
            missing = data["missing"]
            expected_rate = (expected / entries) if entries else 0.0
            handle.write(
                f"| {stars} | {entries} | {wins} | {expected:.2f} | "
                f"{expected_rate:.4%} | {missing} |\n"
            )
        handle.write("\n")

        handle.write("## Entries and wins by date + star\n\n")
        handle.write(
            "| Date | Stars | Entries | Wins | Expected wins | Expected win rate | Missing counts |\n"
        )
        handle.write("| --- | --- | --- | --- | --- | --- | --- |\n")
        for date, stars in sorted(
            per_date_star.keys(),
            key=lambda k: (k[0], k[1] if isinstance(k[1], int) else 99),
        ):
            data = per_date_star[(date, stars)]
            entries = data["entries"]
            wins = data["wins"]
            expected = data["expected"]
            missing = data["missing"]
            expected_rate = (expected / entries) if entries else 0.0
            stars_label = stars if stars is not None else "unknown"
            handle.write(
                f"| {date} | {stars_label} | {entries} | {wins} | "
                f"{expected:.2f} | {expected_rate:.4%} | {missing} |\n"
            )
        handle.write("\n")

        handle.write("## All entered raffles (by date, star)\n\n")
        handle.write("| Date | Stars | Sticker | Post ID | Winner | Permalink |\n")
        handle.write("| --- | --- | --- | --- | --- | --- |\n")
        for row in entered_rows:
            stars = row["stars"] if row["stars"] is not None else "unknown"
            sticker = str(row["stickerName"]).replace("\n", " ").strip()
            winner = row["winnerName"] or ""
            link = row["permalink"] or ""
            handle.write(
                f"| {row['date']} | {stars} | {sticker} | {row['postId']} | "
                f"{winner} | {link} |\n"
            )
        handle.write("\n")

        handle.write("## All won raffles (by date, star)\n\n")
        handle.write("| Date | Stars | Sticker | Post ID | Winner | Permalink |\n")
        handle.write("| --- | --- | --- | --- | --- | --- |\n")
        for row in won_rows:
            stars = row["stars"] if row["stars"] is not None else "unknown"
            sticker = str(row["stickerName"]).replace("\n", " ").strip()
            winner = row["winnerName"] or ""
            link = row["permalink"] or ""
            handle.write(
                f"| {row['date']} | {stars} | {sticker} | {row['postId']} | "
                f"{winner} | {link} |\n"
            )


"""
===============================================================================
main
-------------------------------------------------------------------------------
Beginner-friendly note:
  This ties everything together:
    - load daily snapshots
    - load the newest storage snapshot (optional)
    - de-duplicate entries by postId
    - generate the Markdown report
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

    paths = [path for path in sorted(daily_dir.glob("Raffles-*.json"))]
    if storage_file and storage_file.exists():
        paths.append(storage_file)

    name_to_ids, id_to_names, name_display = build_winner_index(paths)
    resolved_id, resolved_name, warnings = resolve_user(
        args.user_id, args.user_name, name_to_ids, id_to_names, name_display
    )
    for warning in warnings:
        print(f"Warning: {warning}")

    label = args.label or resolved_name or resolved_id
    default_out_dir = project_root / "data" / "stats-by-user"
    default_out_dir.mkdir(parents=True, exist_ok=True)
    out_md = (
        Path(args.out_md)
        if args.out_md
        else default_out_dir / f"{label}.md"
    )

    entries_by_date = defaultdict(dict)

    def add_entry(date: str, post_id: str, entry: dict):
        existing = entries_by_date[date].get(post_id)
        if existing is None or score_entry(entry) > score_entry(existing):
            entries_by_date[date][post_id] = entry

    # Daily snapshots.
    for path in sorted(daily_dir.glob("Raffles-*.json")):
        for day_key, post_id, entry in iter_raffles_from_file(path):
            participant_ids = get_participant_ids(entry)
            if resolved_id in participant_ids:
                add_entry(day_key, post_id, entry)

    # Storage snapshot (optional).
    if storage_file and storage_file.exists():
        for day_key, post_id, entry in iter_raffles_from_file(storage_file):
            participant_ids = get_participant_ids(entry)
            if resolved_id in participant_ids:
                add_entry(day_key, post_id, entry)

    build_report(resolved_id, resolved_name, entries_by_date, out_md, label)

    print(f"Wrote {out_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
