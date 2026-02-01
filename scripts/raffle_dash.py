#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - fallback for older Python
    ZoneInfo = None


def parse_args():
    parser = argparse.ArgumentParser(
        description="Summarize daily raffle snapshots and overall trends."
    )
    parser.add_argument(
        "--input",
        default="data/daily-results",
        help="Directory containing daily JSON snapshots.",
    )
    parser.add_argument(
        "--out-json",
        default=None,
        help="Path for JSON summary output (default: <input>/summary.json).",
    )
    parser.add_argument(
        "--out-md",
        default=None,
        help="Path for Markdown summary output (default: <input>/summary.md).",
    )
    parser.add_argument(
        "--timezone",
        default="America/New_York",
        help="Timezone for endTime bucketing (default: America/New_York).",
    )
    parser.add_argument(
        "--user-id",
        default=None,
        help="Optional user id for entered/not-entered stats.",
    )
    return parser.parse_args()


def get_tzinfo(tz_name):
    if ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return timezone.utc


def to_epoch_sec(value):
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not num == num:  # NaN
        return None
    return int(num / 1000) if num >= 1e12 else int(num)


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


def stats_from_values(values, precision=2):
    if not values:
        return {"n": 0}
    values = sorted(values)
    avg = sum(values) / len(values)
    return {
        "n": len(values),
        "avg": round(avg, precision),
        "median": round(percentile(values, 50), precision),
        "p90": round(percentile(values, 90), precision),
        "min": values[0],
        "max": values[-1],
    }


def extract_raffles(obj):
    raffles = []
    seen = set()
    dupes = 0

    def add(item):
        nonlocal dupes
        if not isinstance(item, dict):
            return
        post_id = item.get("postId") or item.get("postid")
        if not post_id:
            return
        if post_id in seen:
            dupes += 1
            return
        seen.add(post_id)
        raffles.append(item)

    def scan_bucket(bucket):
        if isinstance(bucket, dict):
            for value in bucket.values():
                add(value)
        elif isinstance(bucket, list):
            for value in bucket:
                add(value)

    if isinstance(obj, list):
        for item in obj:
            add(item)
        return raffles, dupes

    if not isinstance(obj, dict):
        return raffles, dupes

    for key, value in obj.items():
        if isinstance(key, str) and key.startswith("fmvTracker:raffles:"):
            scan_bucket(value)

    if not raffles:
        if isinstance(obj.get("raffles"), list):
            for item in obj.get("raffles", []):
                add(item)
        elif isinstance(obj.get("raffles"), dict):
            scan_bucket(obj.get("raffles"))

    if not raffles:
        if any(
            isinstance(value, dict)
            and (value.get("postId") or value.get("postid"))
            for value in obj.values()
        ):
            scan_bucket(obj)

    return raffles, dupes


def get_star(raffle):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    raw = None
    if isinstance(raffle_data, dict):
        raw = raffle_data.get("stickerStars")
    if raw is None and isinstance(raffle, dict):
        raw = raffle.get("stickerStars")
    try:
        star = int(raw)
    except (TypeError, ValueError):
        return None
    return star if 1 <= star <= 5 else None


def get_end_time(raffle):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    raw = None
    if isinstance(raffle_data, dict):
        raw = raffle_data.get("endTime")
    if raw is None and isinstance(raffle, dict):
        raw = raffle.get("endTime")
    return to_epoch_sec(raw)


def get_participant_info(raffle):
    raffle_data = raffle.get("raffle") if isinstance(raffle, dict) else None
    if not isinstance(raffle_data, dict):
        return None, None, False
    ids = raffle_data.get("participantIds")
    if isinstance(ids, list):
        return len(ids), ids, True
    count_raw = raffle_data.get("participantCount")
    try:
        count = int(count_raw)
    except (TypeError, ValueError):
        return None, None, False
    return count, None, False


def winner_present(raffle):
    if not isinstance(raffle, dict):
        return False
    winner = raffle.get("winner")
    if isinstance(winner, dict):
        if winner.get("winnerId") or winner.get("winnerName"):
            return True
    if raffle.get("winnerId") or raffle.get("winnerName"):
        return True
    return False


def compute_metrics(raffles, now_sec, tzinfo, user_id=None):
    counts = {
        "total": 0,
        "expired": 0,
        "active": 0,
        "missingEndTime": 0,
        "winnersPresent": 0,
        "winnersPresentExpired": 0,
        "winnersMissingExpired": 0,
        "missingParticipantIds": 0,
        "missingParticipantCount": 0,
        "stars": {str(i): 0 for i in range(1, 6)},
        "starsUnknown": 0,
    }

    participants_all = []
    participants_expired = []
    participants_by_star = {str(i): [] for i in range(1, 6)}
    roi_by_star = {str(i): [] for i in range(1, 6)}
    hourly_participants = {}
    hourly_roi = {}

    entered = 0
    not_entered = 0
    entered_missing_participant_ids = 0

    for raffle in raffles:
        counts["total"] += 1

        star = get_star(raffle)
        if star is None:
            counts["starsUnknown"] += 1
        else:
            counts["stars"][str(star)] += 1

        end_sec = get_end_time(raffle)
        expired = False
        if end_sec is None:
            counts["missingEndTime"] += 1
        else:
            if end_sec <= now_sec:
                expired = True
                counts["expired"] += 1
            else:
                counts["active"] += 1

        has_winner = winner_present(raffle)
        if has_winner:
            counts["winnersPresent"] += 1
            if expired:
                counts["winnersPresentExpired"] += 1
        elif expired:
            counts["winnersMissingExpired"] += 1

        participant_count, participant_ids, has_ids = get_participant_info(raffle)
        if participant_count is None:
            counts["missingParticipantCount"] += 1
        else:
            participants_all.append(participant_count)
            if expired:
                participants_expired.append(participant_count)
            if star is not None:
                participants_by_star[str(star)].append(participant_count)

        if participant_ids is None:
            counts["missingParticipantIds"] += 1
            if user_id:
                entered_missing_participant_ids += 1
        elif user_id:
            if user_id in participant_ids:
                entered += 1
            else:
                not_entered += 1

        if (
            star is not None
            and participant_count is not None
            and participant_count > 0
            and expired
        ):
            roi = star / participant_count
            roi_by_star[str(star)].append(roi)

        if expired and end_sec is not None:
            hour = datetime.fromtimestamp(end_sec, tz=tzinfo).hour
            hourly_participants.setdefault(hour, [])
            hourly_participants[hour].append(participant_count)
            if (
                star is not None
                and participant_count is not None
                and participant_count > 0
            ):
                hourly_roi.setdefault(hour, [])
                hourly_roi[hour].append(star / participant_count)

    participants_stats = {
        "all": stats_from_values(participants_all, precision=2),
        "expired": stats_from_values(participants_expired, precision=2),
    }
    participants_star_stats = {
        star: stats_from_values(values, precision=2)
        for star, values in participants_by_star.items()
    }
    roi_star_stats = {
        star: stats_from_values(values, precision=4)
        for star, values in roi_by_star.items()
    }

    hourly_stats = {}
    for hour, values in hourly_participants.items():
        hourly_stats[str(hour)] = {
            "participants": stats_from_values(
                [v for v in values if v is not None], precision=2
            )
        }
        if hour in hourly_roi:
            hourly_stats[str(hour)]["roi"] = stats_from_values(
                hourly_roi[hour], precision=4
            )

    entry_stats = None
    if user_id:
        entry_stats = {
            "entered": entered,
            "notEntered": not_entered,
            "missingParticipantIds": entered_missing_participant_ids,
        }

    return {
        "counts": counts,
        "participants": participants_stats,
        "participantsByStar": participants_star_stats,
        "roiByStar": roi_star_stats,
        "hourly": hourly_stats,
        "entryStats": entry_stats,
    }


def parse_date_from_filename(name):
    if name.startswith("Raffles-") and name.endswith(".json"):
        return name[len("Raffles-") : -len(".json")]
    return None


def summarize_files(input_dir, tzinfo, user_id):
    files = sorted(Path(input_dir).glob("*.json"))
    now_sec = int(datetime.now(timezone.utc).timestamp())
    file_results = []
    errors = []
    all_raffles = []
    overall_seen = set()
    overall_dupes = 0

    for path in files:
        try:
            with path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception as exc:
            errors.append({"file": path.name, "error": str(exc)})
            continue

        raffles, dupes = extract_raffles(data)
        metrics = compute_metrics(raffles, now_sec, tzinfo, user_id)
        metrics["counts"]["duplicatesInFile"] = dupes
        metrics["file"] = path.name
        metrics["date"] = parse_date_from_filename(path.name)
        file_results.append(metrics)

        for raffle in raffles:
            post_id = raffle.get("postId") if isinstance(raffle, dict) else None
            if not post_id:
                continue
            if post_id in overall_seen:
                overall_dupes += 1
                continue
            overall_seen.add(post_id)
            all_raffles.append(raffle)

    overall_metrics = compute_metrics(all_raffles, now_sec, tzinfo, user_id)
    overall_metrics["counts"]["duplicatesAcrossFiles"] = overall_dupes

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "timezone": getattr(tzinfo, "key", "UTC"),
        "inputDir": str(Path(input_dir).resolve()),
        "files": file_results,
        "overall": overall_metrics,
        "errors": errors,
    }


def top_hours(hourly_stats, key):
    scored = []
    for hour, data in hourly_stats.items():
        stats = data.get(key)
        if not stats or stats.get("n", 0) == 0:
            continue
        scored.append((hour, stats))
    return scored


def render_markdown(summary):
    lines = []
    lines.append("# Raffle Dashboard Summary")
    lines.append("")
    lines.append(f"Generated: {summary['generatedAt']}")
    lines.append(f"Timezone: {summary['timezone']}")
    lines.append("")

    lines.append("## Daily Summary")
    lines.append(
        "| Date | Total | Expired | Winners (expired) | Avg participants (expired) | 1-star | 2-star | 3-star | 4-star | 5-star |"
    )
    lines.append(
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    )
    for entry in summary["files"]:
        counts = entry["counts"]
        date = entry.get("date") or entry["file"]
        expired = counts["expired"]
        winners = counts["winnersPresentExpired"]
        avg_part = entry["participants"]["expired"].get("avg", 0)
        lines.append(
            f"| {date} | {counts['total']} | {expired} | {winners} | {avg_part} | "
            f"{counts['stars']['1']} | {counts['stars']['2']} | {counts['stars']['3']} | "
            f"{counts['stars']['4']} | {counts['stars']['5']} |"
        )
    lines.append("")

    lines.append("## Overall (unique postIds)")
    overall = summary["overall"]
    counts = overall["counts"]
    lines.append(f"- Total raffles: {counts['total']}")
    lines.append(f"- Expired raffles: {counts['expired']}")
    lines.append(
        f"- Winner coverage (expired): {counts['winnersPresentExpired']} present, {counts['winnersMissingExpired']} missing"
    )
    lines.append(
        f"- Missing participantIds: {counts['missingParticipantIds']} (count missing: {counts['missingParticipantCount']})"
    )
    lines.append(
        f"- Avg participants (expired): {overall['participants']['expired'].get('avg', 0)}"
    )
    lines.append("")

    lines.append("### ROI (stars per entry) by star, expired only")
    roi_line = []
    for star in ["1", "2", "3", "4", "5"]:
        avg = overall["roiByStar"][star].get("avg", 0)
        n = overall["roiByStar"][star].get("n", 0)
        roi_line.append(f"{star}-star: {avg} (n={n})")
    lines.append("- " + "; ".join(roi_line))
    lines.append("")

    lines.append("### Best hours (lowest avg participants, expired)")
    hours = top_hours(overall["hourly"], "participants")
    hours_sorted = sorted(hours, key=lambda item: item[1].get("avg", 0))[:5]
    if hours_sorted:
        lines.append(
            "- "
            + "; ".join(
                f"{hour}:00 avg={stats['avg']} n={stats['n']}"
                for hour, stats in hours_sorted
            )
        )
    else:
        lines.append("- No data")
    lines.append("")

    lines.append("### Best hours (highest ROI, expired)")
    hours_roi = top_hours(overall["hourly"], "roi")
    hours_roi_sorted = sorted(
        hours_roi, key=lambda item: item[1].get("avg", 0), reverse=True
    )[:5]
    if hours_roi_sorted:
        lines.append(
            "- "
            + "; ".join(
                f"{hour}:00 roi={stats['avg']} n={stats['n']}"
                for hour, stats in hours_roi_sorted
            )
        )
    else:
        lines.append("- No data")
    lines.append("")

    if summary.get("errors"):
        lines.append("## Errors")
        for error in summary["errors"]:
            lines.append(f"- {error['file']}: {error['error']}")
        lines.append("")

    return "\n".join(lines)


def main():
    args = parse_args()
    input_dir = Path(args.input)
    out_json = Path(args.out_json) if args.out_json else input_dir / "summary.json"
    out_md = Path(args.out_md) if args.out_md else input_dir / "summary.md"

    tzinfo = get_tzinfo(args.timezone)
    summary = summarize_files(input_dir, tzinfo, args.user_id)

    out_json.parent.mkdir(parents=True, exist_ok=True)
    with out_json.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2, sort_keys=False)

    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(render_markdown(summary), encoding="utf-8")

    print(f"Wrote {out_json}")
    print(f"Wrote {out_md}")


if __name__ == "__main__":
    main()
