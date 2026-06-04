#!/usr/bin/env python3
"""
Retro-clean chl viewer JSONs: flip upside-down frames.

Handles two producer bug classes that wrote upside-down chl frames:

1. S3 OLCI (eumetsat_pipeline, fixed in 84578f4): an inverted flipud
   condition in _save_json that was effectively always-false after the
   fix, so the flip stopped firing.

2. PACE OCI (nasa_pipeline, fixed in a follow-up commit): an
   unconditional flipud() in _save_json that turned south-up into
   north-up, the opposite of what the viewer expects.

We use a physical test (top half mean chl < bottom half mean chl for
usec_south's lat range) so we only flip the actually-inverted frames,
never the ones that happen to render correctly via buggy double-flip
cancellation or non-monotonic gradients.

Usage:
    python3 retro_clean_s3_orientation.py [--dry-run] [--regions usec_south,usec_md] [--sensors S3,PACE]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np


def _finite_mean(arr: np.ndarray) -> float:
    vs = arr[np.isfinite(arr)]
    if vs.size == 0:
        return float("nan")
    return float(np.mean(vs))


def is_inverted(z: list) -> tuple[bool, float, float]:
    """Return (inverted, top_mean, bot_mean) for a 2D chl list-of-lists.

    For usec_south's lat range (31..36) the southern half is oligotrophic
    and the northern half is productive, so top < bot is the correct
    physical orientation.
    """
    arr = np.array([[v if v is not None else np.nan for v in row] for row in z], dtype=float)
    if arr.ndim != 2 or arr.shape[0] < 2:
        return False, float("nan"), float("nan")
    ny = arr.shape[0]
    top = _finite_mean(arr[: ny // 2])
    bot = _finite_mean(arr[ny // 2 :])
    if not (np.isfinite(top) and np.isfinite(bot)):
        return False, top, bot
    return top >= bot, top, bot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--viewer-repo", default="/home/gzheng/github/view",
                    help="Path to the viewer GitHub Pages repo checkout")
    ap.add_argument("--regions", default="usec_south",
                    help="Comma-separated region ids to process")
    ap.add_argument("--sensors", default="S3,PACE",
                    help="Comma-separated sensor suffixes to process "
                         "(S3 matches S3A, S3B, S3A-S3B, S3X; PACE matches PACE-OCI)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute stats but do not write back")
    ap.add_argument("--summary-only", action="store_true",
                    help="Print summary, do not show per-file detail")
    args = ap.parse_args()

    viewer_repo = Path(args.viewer_repo)
    regions = [r.strip() for r in args.regions.split(",") if r.strip()]
    sensors = [s.strip() for s in args.sensors.split(",") if s.strip()]
    files = []
    for region in regions:
        for f in sorted(glob.glob(str(viewer_repo / "data" / region / "chl" / "*.json"))):
            base = os.path.basename(f)
            matched = False
            for sensor in sensors:
                if sensor == "S3" and ("S3" in base or "OLCI" in base):
                    matched = True
                    break
                if sensor in base:
                    matched = True
                    break
            if not matched:
                continue
            files.append(f)
    print(f"Found {len(files)} chl JSONs across regions {regions} sensors {sensors}")

    n_flipped = 0
    n_correct = 0
    n_empty = 0
    bad_files = []

    for f in files:
        try:
            with open(f) as fh:
                d = json.load(fh)
        except Exception as e:
            bad_files.append((f, f"load: {e}"))
            continue
        z = d.get("z")
        if not z or not isinstance(z, list) or not z or not isinstance(z[0], list):
            # S3 producer writes under "data" (newer frames) or "z" (older
            # frames). Try the producer's native key as a fallback.
            z = d.get("data")
        if not z or not isinstance(z, list) or not z or not isinstance(z[0], list):
            n_empty += 1
            continue
        try:
            inverted, top, bot = is_inverted(z)
        except Exception as e:
            bad_files.append((f, f"check: {e}"))
            continue
        if not inverted:
            n_correct += 1
            continue
        if not args.summary_only:
            name = os.path.basename(f)
            print(f"  FLIP {name:60s}  top={top:.3f} bot={bot:.3f}")
        if not args.dry_run:
            arr = np.array(
                [[v if v is not None else np.nan for v in row] for row in z], dtype=float
            )
            arr = np.flipud(arr)
            new_z = np.where(np.isnan(arr), None, arr).tolist()
            d["z"] = new_z
            # Bump the retro-clean tag so consumers can see the file was reprocessed.
            d["_retro_clean"] = "2026-06-04_chl_orientation"
            with open(f, "w") as fh:
                json.dump(d, fh)
        n_flipped += 1

    print()
    print(f"Summary:")
    print(f"  Files scanned:    {len(files)}")
    print(f"  Already correct:  {n_correct}")
    print(f"  Flipped (fixed):  {n_flipped}")
    print(f"  Empty / skipped:  {n_empty}")
    if bad_files:
        print(f"  Files that failed: {len(bad_files)}")
        for f, e in bad_files[:5]:
            print(f"    {f}: {e}")
    if args.dry_run:
        print("  (DRY RUN, nothing written)")


if __name__ == "__main__":
    main()
