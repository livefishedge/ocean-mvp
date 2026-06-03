#!/usr/bin/env python3
"""
Retro-clean chl viewer JSONs.

Applies two filters to every published chl JSON in the viewer repo:

1. Cap out-of-range CHL values to NaN. Physically valid open-ocean CHL
   is 0.01 - 20 mg/m3. Values above 20 saturate the viewer's
   LogNorm(0.02, 10) colormap and produce blocky artifacts.
   Mirrors the cap in s3_nrt_chl_pipeline.py:_regrid_swath (line ~499)
   and jaxa_pipeline/jaxa_chl_pipeline.py:publish_chl_frame (line ~264).

2. Drop singleton cells: any finite cell with zero 4-connected neighbors
   is set to NaN. These are isolated pixels (often swath-edge artifacts)
   that render as visible speckle on the dashboard. Mirrors the filter
   in s3_nrt_chl_pipeline.py:_regrid_swath (line ~565).

This script was written on 2026-06-03 after Mike reported that the
fdbc01b28e retro-clean only covered S3B and S3X, leaving PACE-OCI and
older S3A frames with 40-70% singleton rates and max values up to 100.

After this run, the orchestrator's "Update viewer data" sync will keep
re-applying the upstream pipeline output. To prevent the cap from being
silently reverted, the PACE-OCI pipeline (pace_nrt_chl_pipeline.py)
also needs the singleton drop appended to _regrid_subset, and the S3
pipeline needs the cap range tightened to (0.01, 20) which it already
has. This script handles the historical backlog only.

Usage:
    python3 retro_clean_chl.py [--dry-run] [--regions usec_south,usec_md]
"""
from __future__ import annotations
import argparse
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np

CHL_MAX = 20.0      # upper cap, mg/m3
CHL_MIN = 0.001     # lower bound, mg/m3
SINGLETON_DROP = True  # 4-connected-neighbor drop filter


def clean_chl_grid(z: list, cap_max: float = CHL_MAX, drop_singletons: bool = SINGLETON_DROP) -> tuple[list, dict]:
    """Apply cap and singleton drop in-place on a JSON list-of-lists chl array.

    Returns (new_z, stats). stats is a dict of:
      - finite_before, finite_after, dropped_cap, dropped_singletons
    """
    arr = np.array(z, dtype=float)
    if arr.size == 0:
        return z, {"finite_before": 0, "finite_after": 0, "dropped_cap": 0, "dropped_singletons": 0}
    finite = np.isfinite(arr) & (arr > 0) & (arr < 1e20)
    finite_before = int(finite.sum())
    # Cap out-of-range values to NaN
    over = finite & (arr > cap_max)
    under = finite & (arr < CHL_MIN)
    arr_out = arr.copy()
    arr_out[over] = np.nan
    arr_out[under] = np.nan
    dropped_cap = int(over.sum() + under.sum())

    if drop_singletons:
        finite2 = np.isfinite(arr_out)
        if finite2.sum() > 0:
            fm = finite2.astype(np.int8)
            ny, nx = arr_out.shape
            nbrs = np.zeros_like(fm)
            nbrs[1:, :] += fm[:-1, :]
            nbrs[:-1, :] += fm[1:, :]
            nbrs[:, 1:] += fm[:, :-1]
            nbrs[:, :-1] += fm[:, 1:]
            single = finite2 & (nbrs == 0)
            dropped_singletons = int(single.sum())
            arr_out[single] = np.nan
        else:
            dropped_singletons = 0
    else:
        dropped_singletons = 0

    finite_after = int(np.isfinite(arr_out).sum())
    # Convert back to list-of-lists with None for NaN
    new_z = np.where(np.isnan(arr_out), None, arr_out).tolist()
    return new_z, {
        "finite_before": finite_before,
        "finite_after": finite_after,
        "dropped_cap": dropped_cap,
        "dropped_singletons": dropped_singletons,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--viewer-repo", default="/home/gzheng/github/view",
                    help="Path to the viewer GitHub Pages repo checkout")
    ap.add_argument("--regions", default="usec_south,usec_md",
                    help="Comma-separated region ids to process")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute stats but do not write back")
    ap.add_argument("--summary-only", action="store_true",
                    help="Print summary, do not show per-file detail")
    args = ap.parse_args()

    viewer_repo = Path(args.viewer_repo)
    regions = [r.strip() for r in args.regions.split(",") if r.strip()]
    files = []
    for region in regions:
        for f in sorted(glob.glob(str(viewer_repo / "data" / region / "chl" / "*.json"))):
            files.append(f)
    print(f"Found {len(files)} chl JSONs across regions {regions}")

    n_changed = 0
    total_dropped_cap = 0
    total_dropped_singletons = 0
    n_files_with_speckle = 0
    n_files_with_cap_violation = 0
    n_unchanged = 0
    n_already_clean = 0
    bad_files = []

    for f in sorted(files):
        try:
            with open(f) as fh:
                d = json.load(fh)
        except Exception as e:
            bad_files.append((f, f"load: {e}"))
            continue
        z = d.get("z")
        if not z or not isinstance(z, list):
            continue
        try:
            new_z, stats = clean_chl_grid(z)
        except Exception as e:
            bad_files.append((f, f"clean: {e}"))
            continue

        # The "before" cap and singleton numbers are computed from the original z
        arr_before = np.array(z, dtype=float)
        finite_before = np.isfinite(arr_before) & (arr_before > 0) & (arr_before < 1e20)
        cap_viol_before = int((finite_before & (arr_before > CHL_MAX)).sum())

        fm = finite_before.astype(np.int8)
        nbrs = np.zeros_like(fm)
        ny, nx = arr_before.shape
        nbrs[1:, :] += fm[:-1, :]
        nbrs[:-1, :] += fm[1:, :]
        nbrs[:, 1:] += fm[:, :-1]
        nbrs[:, :-1] += fm[:, 1:]
        srate_before = 100.0 * int((finite_before & (nbrs == 0)).sum()) / max(1, int(finite_before.sum()))

        any_change = (stats["dropped_cap"] > 0 or stats["dropped_singletons"] > 0)
        if not any_change:
            n_unchanged += 1
            continue

        if not args.summary_only:
            name = os.path.basename(f)
            sensor = d.get("sensor") or "?"
            print(f"  {name:60s}  {str(sensor).ljust(10)}  "
                  f"finite {stats['finite_before']:>7} -> {stats['finite_after']:>7}  "
                  f"cap-drop={stats['dropped_cap']:>5}  sing-drop={stats['dropped_singletons']:>5}  "
                  f"sing-rate-before={srate_before:5.1f}%")

        if cap_viol_before > 0:
            n_files_with_cap_violation += 1
            total_dropped_cap += stats["dropped_cap"]
        if srate_before > 5.0:
            n_files_with_speckle += 1
            total_dropped_singletons += stats["dropped_singletons"]

        if not args.dry_run:
            d["z"] = new_z
            # bump _retro_clean_version so consumers can see it was processed
            d["_retro_clean"] = "2026-06-03_cap20_singleton"
            with open(f, "w") as fh:
                json.dump(d, fh)
        n_changed += 1

    print()
    print(f"Summary:")
    print(f"  Files scanned:          {len(files)}")
    print(f"  Files unchanged:        {n_unchanged}")
    print(f"  Files retro-cleaned:    {n_changed}")
    print(f"  Files with cap > 20:    {n_files_with_cap_violation}")
    print(f"  Files with sing>5%:     {n_files_with_speckle}")
    print(f"  Total values capped:    {total_dropped_cap}")
    print(f"  Total singletons drop:  {total_dropped_singletons}")
    if bad_files:
        print(f"  Files that failed:      {len(bad_files)}")
        for f, e in bad_files[:5]:
            print(f"    {f}: {e}")
    if args.dry_run:
        print("  (DRY RUN, nothing written)")


if __name__ == "__main__":
    main()
