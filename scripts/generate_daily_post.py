#!/usr/bin/env python3
import argparse
import json
import math
import statistics
from collections import Counter
from pathlib import Path


DEFAULT_OUT_DIR = Path("data/daily-results")
DEFAULT_SHEETS_DIR = DEFAULT_OUT_DIR / "sheets"
DEFAULT_WINNERS_DIR = DEFAULT_OUT_DIR / "winners"
DEFAULT_POSTS_DIR = DEFAULT_OUT_DIR / "posts"
DEFAULT_UNREVEALED_DIR = DEFAULT_OUT_DIR / "unrevealed"
DEFAULT_STATS_PATH = DEFAULT_OUT_DIR / "daily-stats.md"
DEFAULT_WINNER_EXCLUDES = {"maximum-cover-", "independent_sand_295", "alexeye"}
DEFAULT_EXCLUDED_IDS = {"t2_9529g96e"}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract daily raffle data, update sheet + stats, and generate a post template."
    )
    parser.add_argument("storage", help="Path to fmv-raffle-storage-*.json")
    parser.add_argument("date", help="Day key to extract (YYYY-MM-DD)")
    parser.add_argument(
        "--spreadsheet-link",
        default="[**WINNER SPREADSHEET LINK**](https://docs.google.com/spreadsheets/d/1f2s6wF2axw4SgSyolkMfkwxcdAfWMa_X2Ik3RcaZkpk/edit?gid=433102186#gid=433102186)",
        help="Spreadsheet link text to embed in the post template.",
    )
    parser.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT_DIR),
        help="Output directory for daily snapshots.",
    )
    return parser.parse_args()


def load_json(path):
    with path.open("r", encoding="utf-8") as handle:
        raw = handle.read()
    stripped = raw.lstrip("\ufeff \t\r\n")
    if stripped and stripped[0] not in "{[":
        brace_index = stripped.find("{")
        if brace_index != -1:
            stripped = stripped[brace_index:]
    return json.loads(stripped)


def write_text(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def bucket_key(date):
    return f"fmvTracker:raffles:{date}"


def get_bucket(data, date):
    bucket = data.get(bucket_key(date))
    if not isinstance(bucket, dict):
        raise SystemExit(f"Bucket not found or not a dict: {bucket_key(date)}")
    return bucket


def extract_winner(entry):
    winner = entry.get("winner") or {}
    winner_name = winner.get("winnerName") or entry.get("winnerName") or winner.get("name")
    winner_id = winner.get("winnerId") or entry.get("winnerId") or winner.get("id")
    return winner_name, winner_id


def normalize_winner(name, user_id, excluded_names, excluded_ids):
    if name:
        name_value = str(name).strip()
        if name_value.lower() == "nobody":
            return None
        if name_value.lower() in excluded_names:
            return None
        return name_value
    if user_id:
        user_value = str(user_id).strip()
        if user_value in excluded_ids:
            return None
        return user_value
    return None


def is_unrevealed_win(entry, current_user_id):
    if not isinstance(entry, dict):
        return False
    winner = entry.get("winner") or {}
    winner_id = winner.get("winnerId") or entry.get("winnerId")
    if winner_id != current_user_id:
        return False
    raffle = entry.get("raffle") or {}
    return raffle.get("unrevealedForCurrentUser") is True


def extract_permalink(entry, post_id):
    url = entry.get("url") or entry.get("permalink") or entry.get("feed", {}).get("permalink")
    if not url:
        return f"https://www.reddit.com/comments/{post_id.replace('t3_', '')}"
    if url.startswith("http"):
        return url
    if url.startswith("/"):
        return f"https://www.reddit.com{url}"
    return f"https://www.reddit.com/{url.lstrip('/')}"


def extract_sticker(entry):
    return entry.get("raffle", {}).get("stickerName") or entry.get("postTitle") or "(unknown)"


def extract_stars(entry):
    stars = entry.get("raffle", {}).get("stickerStars")
    if stars is None:
        return ""
    return str(stars)


def compute_stats(bucket, excluded_names, excluded_ids):
    participants_per_raffle_by_star = {i: [] for i in range(1, 6)}
    participant_counts = {}
    unique_participants = set()
    unique_winners = set()
    raffle_counts_by_star = {i: 0 for i in range(1, 6)}
    five_star_participant_entries = Counter()
    five_star_lambda = Counter()
    five_star_winner_counts = Counter()

    for entry in bucket.values():
        if not isinstance(entry, dict):
            continue
        raffle = entry.get("raffle") or {}
        stars_raw = raffle.get("stickerStars")
        try:
            stars = int(stars_raw)
        except (TypeError, ValueError):
            stars = None
        if stars in raffle_counts_by_star:
            raffle_counts_by_star[stars] += 1

        participant_ids = raffle.get("participantIds")
        if isinstance(participant_ids, list):
            filtered_ids = [pid for pid in participant_ids if pid not in excluded_ids]
            filtered_unique = set(filtered_ids)
            if stars in participants_per_raffle_by_star:
                participants_per_raffle_by_star[stars].append(len(filtered_ids))
            for pid in filtered_ids:
                unique_participants.add(pid)
                participant_counts[pid] = participant_counts.get(pid, 0) + 1
            if stars == 5 and filtered_unique:
                per_raffle_prob = 1 / len(filtered_unique)
                for pid in filtered_unique:
                    five_star_participant_entries[pid] += 1
                    five_star_lambda[pid] += per_raffle_prob

        winner_name, winner_id = extract_winner(entry)
        winner_key = normalize_winner(winner_name, winner_id, excluded_names, excluded_ids)
        if winner_key:
            unique_winners.add(winner_key)
        if stars == 5 and winner_key:
            five_star_winner_counts[winner_key] += 1

    raffles_per_participant = list(participant_counts.values())

    def avg(values):
        return sum(values) / len(values) if values else 0

    def median(values):
        if not values:
            return 0
        return statistics.median(values)

    avg_by_star = {k: avg(v) for k, v in participants_per_raffle_by_star.items()}
    median_by_star = {k: median(v) for k, v in participants_per_raffle_by_star.items()}

    avg_all = avg(raffles_per_participant)
    median_all = median(raffles_per_participant)
    vals_ge2 = [v for v in raffles_per_participant if v >= 2]
    vals_ge5 = [v for v in raffles_per_participant if v >= 5]
    avg_ge2 = avg(vals_ge2)
    median_ge2 = median(vals_ge2)
    avg_ge5 = avg(vals_ge5)
    median_ge5 = median(vals_ge5)
    count_lt5 = sum(1 for v in raffles_per_participant if v < 5)
    count_gt100 = sum(1 for v in raffles_per_participant if v > 100)

    five_star_entries = list(five_star_participant_entries.values())
    five_star_entry_buckets = {
        "lt5": sum(1 for count in five_star_entries if count < 5),
        "btw5_50": sum(1 for count in five_star_entries if 5 <= count <= 50),
        "gt50": sum(1 for count in five_star_entries if count > 50),
    }
    expected_double_winners = 0.0
    for lam in five_star_lambda.values():
        expected_double_winners += 1 - math.exp(-lam) * (1 + lam)
    actual_double_winners = sum(1 for wins in five_star_winner_counts.values() if wins >= 2)

    return {
        "participants": len(unique_participants),
        "winners": len(unique_winners),
        "avg_by_star": avg_by_star,
        "median_by_star": median_by_star,
        "avg_all": avg_all,
        "median_all": median_all,
        "avg_ge2": avg_ge2,
        "median_ge2": median_ge2,
        "avg_ge5": avg_ge5,
        "median_ge5": median_ge5,
        "lt5": count_lt5,
        "gt100": count_gt100,
        "raffle_counts_by_star": raffle_counts_by_star,
        "five_star_raffles": raffle_counts_by_star[5],
        "five_star_participants": len(five_star_participant_entries),
        "five_star_entry_buckets": five_star_entry_buckets,
        "expected_double_winners": expected_double_winners,
        "actual_double_winners": actual_double_winners,
    }


def update_daily_stats(stats_path, date, stats):
    header = "# Daily Raffle Stats"
    section_lines = [
        f"## {date}",
        f"- Total unique participants (by id): {stats['participants']}",
        f"- Total unique winners (by id): {stats['winners']}",
        (
            "- Raffle counts by star: "
            f"1* {stats['raffle_counts_by_star'][1]}, "
            f"2* {stats['raffle_counts_by_star'][2]}, "
            f"3* {stats['raffle_counts_by_star'][3]}, "
            f"4* {stats['raffle_counts_by_star'][4]}, "
            f"5* {stats['raffle_counts_by_star'][5]}"
        ),
        (
            "- Average raffle entries per raffle by star: "
            f"1* {stats['avg_by_star'][1]:.2f}, "
            f"2* {stats['avg_by_star'][2]:.2f}, "
            f"3* {stats['avg_by_star'][3]:.2f}, "
            f"4* {stats['avg_by_star'][4]:.2f}, "
            f"5* {stats['avg_by_star'][5]:.2f}"
        ),
        (
            "- Median raffle entries per raffle by star: "
            f"1* {stats['median_by_star'][1]:.1f}, "
            f"2* {stats['median_by_star'][2]:.1f}, "
            f"3* {stats['median_by_star'][3]}, "
            f"4* {stats['median_by_star'][4]}, "
            f"5* {stats['median_by_star'][5]:.1f}"
        ),
        f"- Average raffles per participant: {stats['avg_all']:.2f}",
        f"- Median raffles per participant: {stats['median_all']}",
        f"- Average raffles per participant (>=2 entries): {stats['avg_ge2']:.2f}",
        f"- Median raffles per participant (>=2 entries): {stats['median_ge2']}",
        f"- Average raffles per participant (>=5 entries): {stats['avg_ge5']:.2f}",
        f"- Median raffles per participant (>=5 entries): {stats['median_ge5']}",
        f"- Participants with <5 raffles: {stats['lt5']}",
        f"- Participants with >100 raffles: {stats['gt100']}",
        (
            "- 5* entry buckets (unique participants): "
            f"<5: {stats['five_star_entry_buckets']['lt5']}, "
            f"5-50: {stats['five_star_entry_buckets']['btw5_50']}, "
            f">50: {stats['five_star_entry_buckets']['gt50']}"
        ),
        (
            "- 5* expected double winners (Poisson approx): "
            f"{stats['expected_double_winners']:.1f} "
            f"(actual: {stats['actual_double_winners']})"
        ),
        "",
    ]
    section = "\n".join(section_lines)

    if stats_path.exists():
        content = stats_path.read_text(encoding="utf-8")
    else:
        content = header + "\n\n"

    if header not in content:
        content = header + "\n\n" + content.strip() + "\n\n"

    marker = f"## {date}"
    if marker in content:
        before, rest = content.split(marker, 1)
        after = ""
        if "\n## " in rest:
            after = rest[rest.index("\n## ") + 1 :]
        content = before.rstrip() + "\n\n" + section + after.lstrip()
    else:
        content = content.rstrip() + "\n\n" + section

    write_text(stats_path, content)


def build_post(date, stats, winners, spreadsheet_link):
    """
    build_post() output format

    This function MUST match the canonical daily post style exactly.
    If you change formatting here, regenerate all posts to keep history
    consistent.

    Formatting invariants:
    - Spreadsheet link first, bold
    - Stats heading with date in bold
    - Raffle counts by star on a single line
    - Bullet lists use "*" and star symbol "★"
    - Winners are a single line: "**MM-DD Winners:** u/..."
    """
    def fmt_star_counts():
        return (
            f"1★ {stats['raffle_counts_by_star'][1]}, "
            f"2★ {stats['raffle_counts_by_star'][2]}, "
            f"3★ {stats['raffle_counts_by_star'][3]}, "
            f"4★ {stats['raffle_counts_by_star'][4]}, "
            f"5★ {stats['raffle_counts_by_star'][5]}"
        )

    def fmt_avg_by_star():
        return (
            f"1★ {stats['avg_by_star'][1]:.2f}, "
            f"2★ {stats['avg_by_star'][2]:.2f}, "
            f"3★ {stats['avg_by_star'][3]:.2f}, "
            f"4★ {stats['avg_by_star'][4]:.2f}, "
            f"5★ {stats['avg_by_star'][5]:.2f}"
        )

    def fmt_median_star(star, value):
        if star == 3:
            return f"{int(value)}" if value == int(value) else f"{value:.1f}"
        return f"{value:.1f}"

    def fmt_median_by_star():
        return (
            f"1★ {fmt_median_star(1, stats['median_by_star'][1])}, "
            f"2★ {fmt_median_star(2, stats['median_by_star'][2])}, "
            f"3★ {fmt_median_star(3, stats['median_by_star'][3])}, "
            f"4★ {fmt_median_star(4, stats['median_by_star'][4])}, "
            f"5★ {fmt_median_star(5, stats['median_by_star'][5])}"
        )

    def fmt_optional_decimal(value, force_decimal=False):
        if force_decimal:
            return f"{value:.1f}"
        return f"{int(value)}" if value == int(value) else f"{value:.1f}"

    winners_line = " ".join(f"u/{name}" for name in winners)

    lines = [
        "",
        "",
        spreadsheet_link,
        "",
        "The spreadsheet has multiple tabs (by date).",
        "",
        "I update the current day as I have time.",
        "",
        "Once a day is fully finished, I'll post the final winner names for that date.",
        "",
        "If you're looking at today's tab mid-day, it may be incomplete - that's expected.",
        "",
        f"**Some stats (from {date})**",
        "",
        f"Raffle counts by star: {fmt_star_counts()}",
        "",
        f"* Total unique participants (by id): {stats['participants']}",
        f"* Total unique winners (by id): {stats['winners']}",
        "",
        "",
        f"* Average raffle entries per raffle by star: {fmt_avg_by_star()}",
        f"* Median raffle entries per raffle by star: {fmt_median_by_star()}",
        f"* Average raffles per participant: {stats['avg_all']:.2f}",
        f"* Median raffles per participant: {fmt_optional_decimal(stats['median_all'], True)}",
        f"* Average raffles per participant (>=2 entries): {stats['avg_ge2']:.2f}",
        f"* Median raffles per participant (>=2 entries): {fmt_optional_decimal(stats['median_ge2'], True)}",
        f"* Average raffles per participant (>=5 entries): {stats['avg_ge5']:.2f}",
        f"* Median raffles per participant (>=5 entries): {fmt_optional_decimal(stats['median_ge5'])}",
        f"* Participants with <5 raffles: {stats['lt5']}",
        f"* Participants with >100 raffles: {stats['gt100']}",
        "",
        "# 5★ fairness check (expected multi-winners)",
        "",
        f"* 5★ raffles: {stats['five_star_raffles']}",
        f"* Unique 5★ participants: {stats['five_star_participants']}",
        (
            "* 5★ entry buckets (unique participants): "
            f"<5: {stats['five_star_entry_buckets']['lt5']}, "
            f"5-50: {stats['five_star_entry_buckets']['btw5_50']}, "
            f">50: {stats['five_star_entry_buckets']['gt50']}"
        ),
        f"* Expected double 5★ winners (Poisson approx): {stats['expected_double_winners']:.1f}",
        f"* Actual double 5★ winners: {stats['actual_double_winners']}",
        (
            "* Simplified math: for each participant i, "
            "lambda_i = sum(1 / entrants_in_raffle); "
            "P(i>=2 wins) ~= 1 - e^-lambda_i(1+lambda_i); "
            "expected double winners = sum P(i>=2 wins) As before:"
        ),
        "",
        (
            "**If you do not want to be included or tagged, please comment \"OPT OUT\" "
            "or DM me and I'll exclude you going forward.**"
        ),
        "",
        "If you notice missing or incorrect data, please let me know so I can fine-tune things.",
        "",
        f"**{date[-5:]} Winners:** {winners_line}",
        "",
        "If you like this post please say thanks by visiting my farm: "
        "[Maximum-Cover-'s farm](https://www.reddit.com/r/FarmMergeValley/comments/1qlticg/visit_maximumcovers_farm/)",
    ]
    return "\n".join(lines)


def main():
    args = parse_args()
    storage_path = Path(args.storage).expanduser().resolve()
    if not storage_path.exists():
        raise SystemExit(f"Storage file not found: {storage_path}")

    out_dir = Path(args.out_dir).expanduser().resolve()
    sheets_dir = out_dir / "sheets"
    winners_dir = out_dir / "winners"
    posts_dir = out_dir / "posts"
    unrevealed_dir = out_dir / "unrevealed"
    out_dir.mkdir(parents=True, exist_ok=True)
    sheets_dir.mkdir(parents=True, exist_ok=True)
    winners_dir.mkdir(parents=True, exist_ok=True)
    posts_dir.mkdir(parents=True, exist_ok=True)
    unrevealed_dir.mkdir(parents=True, exist_ok=True)

    data = load_json(storage_path)
    bucket = get_bucket(data, args.date)

    # Daily snapshot
    snapshot_path = out_dir / f"Raffles-{args.date}.json"
    write_text(snapshot_path, json.dumps({bucket_key(args.date): bucket}, indent=2))

    excluded_names = {name.lower() for name in DEFAULT_WINNER_EXCLUDES}
    excluded_ids = set(DEFAULT_EXCLUDED_IDS)

    # Sheet + winners list
    rows = []
    winners = set()
    for post_id, entry in bucket.items():
        if not isinstance(entry, dict):
            continue
        winner_name, winner_id = extract_winner(entry)
        winner = normalize_winner(winner_name, winner_id, excluded_names, excluded_ids)
        if not winner:
            continue
        winners.add(winner)
        rows.append(
            (winner, extract_sticker(entry), extract_stars(entry), extract_permalink(entry, post_id))
        )

    rows.sort(key=lambda x: x[0].lower())
    sheet_lines = ["winnerName\tstickerName\tstickerStars\tpostUrl"]
    for row in rows:
        sheet_lines.append("\t".join(row))
    sheet_path = sheets_dir / f"{args.date}.tsv"
    write_text(sheet_path, "\n".join(sheet_lines) + "\n")

    winners_sorted = sorted(winners, key=lambda x: x.lower())
    winners_path = winners_dir / f"winners-{args.date}.md"
    write_text(winners_path, "\n".join(f"u/{name}" for name in winners_sorted) + "\n")

    unrevealed_urls = []
    for post_id, entry in bucket.items():
        if not is_unrevealed_win(entry, next(iter(DEFAULT_EXCLUDED_IDS))):
            continue
        unrevealed_urls.append(extract_permalink(entry, post_id))
    unrevealed_path = unrevealed_dir / f"unrevealed-{args.date}.txt"
    write_text(unrevealed_path, "\n".join(unrevealed_urls) + "\n")

    # Daily stats + post template
    stats = compute_stats(bucket, excluded_names, excluded_ids)
    update_daily_stats(DEFAULT_STATS_PATH, args.date, stats)
    post_path = posts_dir / f"post-{args.date}.md"
    post_body = build_post(args.date, stats, winners_sorted, args.spreadsheet_link)
    write_text(post_path, post_body)

    print(snapshot_path)
    print(sheet_path)
    print(winners_path)
    print(DEFAULT_STATS_PATH)
    print(post_path)
    print(unrevealed_path)


if __name__ == "__main__":
    raise SystemExit(main())
