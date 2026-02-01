#!/usr/bin/env python3
import argparse
import json
import subprocess
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract a day bucket into data/daily-results and refresh dashboard."
    )
    parser.add_argument("source", help="Path to fmv-raffle-storage-*.json")
    parser.add_argument("date", help="Day key to extract (YYYY-MM-DD)")
    parser.add_argument(
        "--out-dir",
        default="data/daily-results",
        help="Output directory for daily snapshots.",
    )
    parser.add_argument(
        "--run-dash",
        action="store_true",
        help="Run scripts/raffle_dash.py after extraction.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    src = Path(args.source).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        raise SystemExit(f"Source file not found: {src}")

    bucket_key = f"fmvTracker:raffles:{args.date}"
    debug_key = f"fmvTracker:debugLog:{args.date}"

    with src.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    bucket = data.get(bucket_key)
    if not isinstance(bucket, dict):
        raise SystemExit(f"Bucket not found or not a dict: {bucket_key}")

    debug_bucket = data.get(debug_key)

    out_path = out_dir / f"Raffles-{args.date}.json"
    with out_path.open("w", encoding="utf-8") as handle:
        payload = {bucket_key: bucket}
        if isinstance(debug_bucket, list):
            payload[debug_key] = debug_bucket
        json.dump(payload, handle, indent=2)

    print(f"Wrote {out_path}")

    if args.run_dash:
        script = Path(__file__).resolve().parent / "raffle_dash.py"
        if not script.exists():
            raise SystemExit(f"Dashboard script not found: {script}")
        subprocess.run(["python", str(script)], check=True)


if __name__ == "__main__":
    main()
