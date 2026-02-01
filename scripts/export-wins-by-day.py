#!/usr/bin/env python3
import json
import sys
from pathlib import Path

def extract_winner(entry):
    winner = entry.get("winner", {})
    if not winner and isinstance(entry.get("raffle"), dict):
        maybe = entry["raffle"].get("winner")
        if isinstance(maybe, dict):
            winner = maybe
    name = winner.get("winnerName") or winner.get("winner_name") or winner.get("name") or winner.get("username")
    user_id = winner.get("winnerId") or winner.get("winner_id") or winner.get("id") or winner.get("userId")
    return name, user_id

def extract_permalink(entry, post_id):
    permalink = entry.get("permalink") or entry.get("feed", {}).get("permalink") or entry.get("raffle", {}).get("permalink")
    if permalink:
        if permalink.startswith("/"):
            return "https://www.reddit.com" + permalink
        if permalink.startswith("http"):
            return permalink
        return "https://www.reddit.com/" + permalink.lstrip("/")
    return f"https://www.reddit.com/comments/{post_id.replace('t3_', '')}"

def extract_sticker(entry):
    return entry.get("raffle", {}).get("stickerName") or entry.get("postTitle") or "(unknown)"

def iter_raffle_entries(data):
    for key, bucket in data.items():
        if not key.startswith("fmvTracker:raffles:"):
            continue
        day_key = key.split("fmvTracker:raffles:")[-1]
        if isinstance(bucket, str):
            try:
                bucket = json.loads(bucket)
            except Exception:
                continue
        if not isinstance(bucket, dict):
            continue
        for post_id, entry in bucket.items():
            if isinstance(entry, str):
                try:
                    entry = json.loads(entry)
                except Exception:
                    continue
            if not isinstance(entry, dict):
                continue
            yield day_key, post_id, entry

def format_username(name):
    return f"u/[{name}](https://www.reddit.com/user/{name}/)"

def build_day_output(day_key, items):
    lines = [f"## {day_key}"]
    current_winner = None
    first_group = True
    for winner_name, sticker, url in items:
        if winner_name != current_winner:
            if not first_group:
                lines.append("")
            first_group = False
            current_winner = winner_name
            lines.append(format_username(winner_name))
        lines.append(f"[{sticker}]({url})")
    lines.append("")
    return "\n".join(lines)

def main(argv):
    if len(argv) < 2:
        print("Usage: export-wins-by-day.py data/daily-results/Raffles-YYYY-MM-DD.json [more files...]", file=sys.stderr)
        return 1

    excluded = {"maximum-cover-", "independent_sand_295", "alexeye"}
    out_dir = Path("data/daily-results")
    out_dir.mkdir(parents=True, exist_ok=True)

    for in_path_str in argv[1:]:
        in_path = Path(in_path_str)
        if not in_path.exists():
            print(f"Skip missing file: {in_path}", file=sys.stderr)
            continue
        with in_path.open() as f:
            data = json.load(f)

        by_day = {}
        for day_key, post_id, entry in iter_raffle_entries(data):
            winner_name, winner_id = extract_winner(entry)
            if not winner_name and not winner_id:
                continue
            winner_name = winner_name or winner_id
            if not winner_name:
                continue
            if str(winner_name).strip().lower() in excluded:
                continue
            sticker = extract_sticker(entry)
            url = extract_permalink(entry, post_id)
            by_day.setdefault(day_key, []).append((str(winner_name), sticker, url))

        outputs = []
        for day_key in sorted(by_day.keys()):
            items = sorted(by_day[day_key], key=lambda x: x[0].lower())
            outputs.append(build_day_output(day_key, items))

        out_path = out_dir / f"wins-{in_path.stem.replace('Raffles-', '')}.md"
        content = "\n".join(outputs).rstrip() + "\n"
        out_path.write_text(content, encoding="ascii")
        print(out_path)

    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
