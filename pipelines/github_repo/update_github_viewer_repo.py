#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import time
import fcntl
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

VARS = ["chl", "sst", "uv", "chl_front", "sst_front"]

DEFAULT_GRID_NAMES = {
    # Do not publish/use a single CHL grid. CHL frames now mix OLCI composites
    # and VIIRS model rasters with different shapes; the viewer must infer axes
    # per frame from bbox/nx/ny metadata.
    "sst": "goes_sst_1000_grid.json",
    "uv": "uv_12500_grid.json",
}

MANIFEST_NAME = "sync_manifest.json"

@contextmanager
def repo_update_lock(repo_root: Path, timeout_seconds: int = 900):
    """Serialize all GitHub Pages repo mutations.

    Multiple regional pipelines can finish at nearly the same time. Without a
    process-level lock, two updater processes can both enter git add/commit and
    collide on .git/index.lock. Hold this lock around the whole sync + git
    section so file copies, index writes, manifest writes, and git operations
    are atomic from the repo's point of view.
    """
    safe_name = str(repo_root.resolve()).replace(os.sep, "_")
    lock_path = Path("/tmp") / f"openclaw_update{safe_name}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    start = datetime.now(timezone.utc)
    with open(lock_path, "w") as lock_f:
        while True:
            try:
                fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                lock_f.seek(0)
                lock_f.truncate()
                lock_f.write(f"pid={os.getpid()} acquired_at={datetime.now(timezone.utc).isoformat()}\n")
                lock_f.flush()
                break
            except BlockingIOError:
                waited = (datetime.now(timezone.utc) - start).total_seconds()
                if waited >= timeout_seconds:
                    raise TimeoutError(f"Timed out waiting for repo update lock: {lock_path}")
                time.sleep(5)
        try:
            yield
        finally:
            fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)

@dataclass
class FrameEntry:
    var: str
    id: str
    label: str
    time_iso: Optional[str]
    json_path: str
    grid_file: str

# ----------------------------- helpers -----------------------------

SENSOR_RE = re.compile(r"(?:^|_)(?P<sensor>VNP|VJ1|VJ2|S3A(?:-S3B)?|S3B|G1[6-9]|CMEMS|DUACS|cmems-duacs)(?:_|$)", re.IGNORECASE)

def sensor_from_stem(stem: str) -> Optional[str]:
    """Return only a sensor token that is actually present in the product filename.

    Never synthesize sensor labels from leftover filename fragments. Bad labels like
    `machl_VJ1` were caused by removing the timestamp and displaying the residue.
    """
    m = SENSOR_RE.search(stem)
    if not m:
        return None
    sensor = m.group("sensor")
    canonical = {"vnp":"VNP", "vj1":"VJ1", "vj2":"VJ2", "s3a":"S3A", "s3b":"S3B", "s3a-s3b":"S3A-S3B", "cmems-duacs":"CMEMS/DUACS"}
    return canonical.get(sensor.lower(), sensor.upper())

def label_with_sensor(dt: datetime, sensor: Optional[str]) -> str:
    label = dt.strftime("%Y-%m-%d %H:%M UTC")
    return f"{label} | {sensor}" if sensor else label

def parse_time_from_stem(stem: str) -> Tuple[Optional[str], str]:
    # 1. OLCI composite pattern, e.g. usec_md_20260505_2026125.1444_chl_S3A-S3B
    m_olci = re.search(r"_(?P<yyyymmdd>\d{8})_(?P<yyyyjjj>\d{7})\.(?P<hhmm>\d{4})_", stem)
    if m_olci:
        yyyyjjj = m_olci.group("yyyyjjj")
        hhmm = m_olci.group("hhmm")
        try:
            dt = datetime.strptime(yyyyjjj + hhmm, "%Y%j%H%M")
            iso = dt.strftime("%Y-%m-%dT%H:%M:00Z")
            return iso, label_with_sensor(dt, sensor_from_stem(stem))
        except Exception:
            pass

    # 2. GOES hourly SST pattern, e.g. sst_usec_south_2026127_20260507_14_g19
    m_sst_hour = re.search(r"(?:^|_)(?P<yyyyjjj>\d{7})_(?P<yyyymmdd>\d{8})_(?P<hh>\d{2})(?:_|$)", stem)
    if m_sst_hour:
        yyyyjjj = m_sst_hour.group("yyyyjjj")
        hhmm = m_sst_hour.group("hh") + "00"
        try:
            dt = datetime.strptime(yyyyjjj + hhmm, "%Y%j%H%M")
            iso = dt.strftime("%Y-%m-%dT%H:%M:00Z")
            return iso, dt.strftime("%Y-%m-%d %H:%M UTC")
        except Exception:
            pass

    # 3. VIIRS / swath pattern, e.g. usec_md_2026124.1912_chl_VJ1
    m_swath = re.search(r"(?:^|_)(?P<yyyyjjj>\d{7})\.(?P<hhmm>\d{4})(?:_|$)", stem)
    if m_swath:
        yyyyjjj = m_swath.group("yyyyjjj")
        hhmm = m_swath.group("hhmm")
        try:
            dt = datetime.strptime(yyyyjjj + hhmm, "%Y%j%H%M")
            iso = dt.strftime("%Y-%m-%dT%H:%M:00Z")
            return iso, label_with_sensor(dt, sensor_from_stem(stem))
        except Exception:
            pass

    # 4. Daily Date Pattern
    m2 = re.match(r".*_(?P<yyyymmdd>\d{8})_.*", stem)
    if m2:
        yyyymmdd = m2.group("yyyymmdd")
        try:
            dt = datetime.strptime(yyyymmdd, "%Y%m%d")
            iso = dt.strftime("%Y-%m-%dT00:00:00Z")
            label = dt.strftime("%Y-%m-%d")
            return iso, label
        except Exception:
            pass
    return None, stem

def stat_sig(p: Path) -> Tuple[int, int]:
    st = p.stat()
    return int(st.st_size), int(st.st_mtime_ns)

def load_manifest(repo_root: Path) -> Dict:
    p = repo_root / MANIFEST_NAME
    if not p.exists(): return {"files": {}}
    try: return json.loads(p.read_text(encoding="utf-8"))
    except Exception: return {"files": {}}

def save_manifest(repo_root: Path, manifest: Dict) -> None:
    p = repo_root / MANIFEST_NAME
    p.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

def manifest_key(src: Path) -> str:
    return str(src.resolve())

def should_skip_by_manifest(src: Path, manifest: Dict) -> bool:
    key = manifest_key(src)
    sig = stat_sig(src)
    prev = manifest.get("files", {}).get(key)
    return bool(prev and tuple(prev.get("sig", ())) == sig)

def _replace_nans(obj):
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj): return None
        return obj
    if isinstance(obj, list):
        return [_replace_nans(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _replace_nans(v) for k, v in obj.items()}
    return obj

def _finite_fraction_2d(values) -> Optional[float]:
    if not isinstance(values, list) or not values:
        return None
    total = 0
    finite = 0
    for row in values:
        if not isinstance(row, list):
            continue
        for v in row:
            total += 1
            if isinstance(v, (int, float)) and math.isfinite(float(v)):
                finite += 1
    if total <= 0:
        return None
    return finite / total

def _scalar_raster_from_payload(payload: Dict):
    for key in ("z", "chl", "data", "chlor_a", "sst"):
        if key in payload:
            return payload.get(key)
    return None

def _chl_finite_fraction_from_payload(payload: Dict) -> Optional[float]:
    for key in ("chl_finite_fraction", "finite_fraction", "valid_fraction"):
        value = payload.get(key)
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return float(value)
    return _finite_fraction_2d(_scalar_raster_from_payload(payload))

def sanitize_and_write_json(src: Path, dst: Path, flip_vertical: bool = False) -> bool:
    try:
        raw_text = src.read_text(encoding="utf-8")
        data = json.loads(raw_text)
    except Exception as e:
        print(f"[WARN] Skipping invalid JSON {src}: {e}")
        return False

    if "NaN" in raw_text or "Infinity" in raw_text:
        data = _replace_nans(data)

    # --- 1. NORMALIZE KEYS TO 'z' ---
    # VIIRS uses 'chl', OLCI uses 'data', GOES uses 'sst'. The viewer wants
    # one scalar raster named 'z'. For UV vectors, expose speed as 'z' while
    # preserving u/v for vector-aware clients.
    if 'z' not in data:
        if 'chl' in data:
            data['z'] = data.pop('chl')
        elif 'data' in data:
            data['z'] = data.pop('data')
        elif 'chlor_a' in data:
            data['z'] = data.pop('chlor_a')
        elif 'sst' in data:
            data['z'] = data.pop('sst')
        elif 'u' in data and 'v' in data:
            u = data.get('u')
            v = data.get('v')
            if isinstance(u, list) and isinstance(v, list):
                speed = []
                for row_u, row_v in zip(u, v):
                    if isinstance(row_u, list) and isinstance(row_v, list):
                        speed.append([
                            None if (uu is None or vv is None) else math.sqrt(uu * uu + vv * vv)
                            for uu, vv in zip(row_u, row_v)
                        ])
                if speed:
                    data['z'] = speed
    
    # IMPORTANT: publishing must not alter raster orientation.
    # The viewer/grid convention was already working before the transfer-learned
    # VIIRS model deployment. Model swaps may change CHL values, not row/column
    # ordering. Orientation fixes belong upstream where the product is generated
    # with known lat/lon axes, never here via visual heuristics.

    # S3/OLCI CHL composites store axes in a sibling grid file. Embed bbox +
    # shape into each payload so the viewer can infer axes without relying on a
    # separate grid filename convention.
    if 'bbox' not in data:
        grid_files = list(src.parent.glob('*chl_grid_*m.json'))
        if grid_files:
            try:
                grid = json.loads(grid_files[0].read_text(encoding='utf-8'))
                lat = grid.get('lat') or []
                lon = grid.get('lon') or []
                if lat and lon:
                    data['bbox'] = [min(lon), min(lat), max(lon), max(lat)]
                    data['ny'] = len(lat)
                    data['nx'] = len(lon)
            except Exception as e:
                print(f"[WARN] Could not embed grid metadata for {src.name}: {e}")

    # Check if we actually have data now
    if 'z' not in data:
        # If no Z data found, creating this file is pointless/risky for viewer
        # We'll write it anyway but log a warning
        print(f"[WARN] No scalar raster key found in {src.name}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("w", encoding="utf-8") as f:
        json.dump(data, f, allow_nan=False, separators=(",", ":"))
    return True

def copy_file_if_needed(src: Path, dst: Path, manifest: Dict, dry_run: bool = False) -> bool:
    if should_skip_by_manifest(src, manifest) and dst.exists(): return False
    if dry_run:
        print(f"[DRY] COPY {src} -> {dst}")
        manifest["files"][manifest_key(src)] = {"sig": stat_sig(src)}
        return True
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    manifest["files"][manifest_key(src)] = {"sig": stat_sig(src)}
    return True

def sanitize_json_if_needed(src: Path, dst: Path, manifest: Dict, dry_run: bool = False, flip_vertical: bool = False) -> bool:
    # Always re-sanitize JSON. The source signature can stay stable while the
    # normalizer changes (e.g., sst/u/v -> z), and stale viewer payloads are
    # worse than a few small rewrites.
    if dry_run:
        print(f"[DRY] SANITIZE {src} -> {dst} (flip={flip_vertical})")
        manifest["files"][manifest_key(src)] = {"sig": stat_sig(src)}
        return True

    ok = sanitize_and_write_json(src, dst, flip_vertical=flip_vertical)
    if not ok: return False
    
    # Note: We do NOT use set_dst_mtime here. 
    # We want a fresh timestamp so the browser invalidates cache.
    
    manifest["files"][manifest_key(src)] = {"sig": stat_sig(src)}
    return True

# ----------------------------- sync logic -----------------------------

def _olci_date_key(frame: FrameEntry) -> Optional[str]:
    sensor = sensor_from_stem(frame.id)
    if sensor not in {"S3A", "S3B", "S3A-S3B"}:
        return None
    dt = parse_iso_dt(frame.time_iso)
    return dt.strftime("%Y-%m-%d") if dt else None


def prefer_olci_composites(frames: List[FrameEntry]) -> List[FrameEntry]:
    """If an S3A-S3B composite exists for a date, hide same-day S3A/S3B singles.

    The singles may remain on disk for provenance, but the viewer timeline should
    present the composite when both OLCI sensors are available.
    """
    composite_dates = {
        d for f in frames
        if sensor_from_stem(f.id) == "S3A-S3B"
        for d in [_olci_date_key(f)]
        if d
    }
    if not composite_dates:
        return frames
    out = []
    for f in frames:
        sensor = sensor_from_stem(f.id)
        d = _olci_date_key(f)
        if sensor in {"S3A", "S3B"} and d in composite_dates:
            continue
        out.append(f)
    return out


def collect_and_sync_frames(prod_root, work_mode, region_id, repo_root, manifest, dry_run=False, source_region_id: Optional[str] = None):
    source_region_id = source_region_id or region_id
    frames_by_var = {v: [] for v in VARS}

    for var in VARS:
        src_dirs = []
        if var == "chl":
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "composites" / "json")
            # Prefer the region-specific daily cross-sensor model after the
            # retrain gate has produced a complete sensor family. Keep the
            # transfer-learned multi-day families as fallback only.
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "by_model" / "cross_sensor_usec_south" / "json")
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "by_model" / "multi_day_120_132_det41" / "json")
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "by_model" / "multi_day_120_130" / "json")
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "by_model" / "cross_sensor_multi_day_120_130" / "json")
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "by_model" / "008" / "json")
            if source_region_id != "usec_south":
                src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "json")
            # Also scan the GitHub repo itself for manually-written frames
            # (e.g. JAXA SGLI frames published directly via jaxa_pipeline)
            repo_chl_dir = repo_root / "data" / region_id / var
            if repo_chl_dir.is_dir():
                src_dirs.append(repo_chl_dir)
        elif var == "sst":
            # Publish only hourly GOES SST snapshots. Do not publish SST composites:
            # low-coverage periods should remain individual scans, per product direction.
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "json")
        elif var in {"chl_front", "sst_front"}:
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "json")
        else:
            src_dirs.append(prod_root / work_mode / source_region_id / var / "images" / "json")
        
        do_flip = False

        for src_dir in src_dirs:
            if not src_dir.is_dir(): continue
            
            dst_dir = repo_root / "data" / region_id / var
            dst_dir.mkdir(parents=True, exist_ok=True)
            
            for src in sorted(src_dir.glob("*.json")):
                if "grid" in src.stem.lower():
                    continue
                stem = src.stem

                # Guardrail: for USEC South VIIRS CHL, publish only the current
                # daily region model or validated multi-day fallback families.
                # Legacy 008 artifacts may remain on disk for provenance but
                # must not leak back into the live viewer.
                if var == "chl" and region_id == "usec_south":
                    try:
                        payload = json.loads(src.read_text())
                    except Exception:
                        payload = {}
                    sensor = payload.get("sensor")
                    model_version = payload.get("model_version")
                    allowed_viirs_models = {
                        "cross_sensor/usec_south",
                        "multi_day_120_132_det41",
                        "multi_day_120_130",
                        "cross_sensor/multi_day_120_130",
                    }
                    if sensor in {"VNP", "VJ1", "VJ2"} and model_version and model_version not in allowed_viirs_models:
                        continue
                # Keep the first source encountered for a frame id. For CHL this
                # deliberately lets composites / transfer-learned by_model outputs
                # win over stale generic images/json payloads with the same name.
                if any(f.id == stem for f in frames_by_var[var]):
                    continue

                dst = dst_dir / src.name
                
                changed = sanitize_json_if_needed(src, dst, manifest, dry_run=dry_run, flip_vertical=do_flip)
                
                if not dst.exists() and not dry_run: continue

                iso, label = parse_time_from_stem(stem)
                rel_path = (dst_dir / src.name).relative_to(repo_root).as_posix()
                grid_name = DEFAULT_GRID_NAMES.get(var, "frame_bbox")

                frames_by_var[var].append(FrameEntry(var, stem, label, iso, rel_path, grid_name))

        print(f"[INFO] {var}: {len(frames_by_var[var])} frames indexed (Flipped: {do_flip})")

    if "chl" in frames_by_var:
        before = len(frames_by_var["chl"])
        frames_by_var["chl"] = prefer_olci_composites(frames_by_var["chl"])
        hidden = before - len(frames_by_var["chl"])
        if hidden:
            print(f"[INFO] chl: hid {hidden} same-day OLCI single-sensor frame(s) where S3A-S3B composite exists")

    for v in frames_by_var:
        frames_by_var[v].sort(key=lambda f: (f.time_iso or "", f.label))
        
    return frames_by_var

def write_index_json(repo_root: Path, region_id: str, frames_by_var: Dict[str, List[FrameEntry]], dry_run: bool = False, index_name: Optional[str] = None, region_meta: Optional[dict] = None) -> None:
    out = {
        "region": region_id,
        "last_updated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "vars": [v for v in VARS if frames_by_var.get(v)],
        "frames": {v: [asdict(f) for f in frames_by_var[v]] for v in VARS if frames_by_var.get(v)},
    }
    if region_meta:
        out["region_meta"] = region_meta
    index_path = repo_root / (index_name or "index.json")
    if dry_run:
        print(f"[DRY] Wrote {index_path}")
        return
    index_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"[INFO] Wrote {index_path}")

def find_grid_src(prod_root: Path, work_mode: str, region_id: str, grid_name: str, source_region_id: Optional[str] = None) -> Optional[Path]:
    source_region_id = source_region_id or region_id
    region_root = prod_root / work_mode / source_region_id
    p = region_root / "grids" / grid_name
    if p.exists(): return p
    hits = list(region_root.rglob(grid_name))
    if hits: return hits[0]

    # Source pipelines use region-specific grid filenames; the viewer uses stable
    # canonical names. Map known source locations into those canonical names.
    fallback_patterns = {
        "viirs_chl_750_grid.json": [
            "chl/images/composites/json/*chl_grid*750m.json",
            "chl/images/json/*chl_grid*750m.json",
        ],
        "uv_12500_grid.json": [
            "uv/grid/*uv_grid*.json",
            "uv/images/json/*uv_grid*.json",
        ],
        "goes_sst_1000_grid.json": [
            "sst/images/composites/json/*grid*.json",
            "sst/images/json/*grid*.json",
        ],
    }
    for pattern in fallback_patterns.get(grid_name, []):
        hits = sorted(region_root.glob(pattern))
        if hits:
            return hits[0]
    return None

def sync_grids(prod_root, work_mode, region_id, repo_root, manifest, dry_run=False, source_region_id: Optional[str] = None):
    dst_dir = repo_root / "data" / region_id / "grids"
    dst_dir.mkdir(parents=True, exist_ok=True)
    needed_grids = set(DEFAULT_GRID_NAMES.values())
    stale_chl_grid = dst_dir / "viirs_chl_750_grid.json"
    if stale_chl_grid.exists():
        if dry_run:
            print(f"[DRY] REMOVE stale CHL grid {stale_chl_grid}")
        else:
            stale_chl_grid.unlink()
    for gname in needed_grids:
        src = find_grid_src(prod_root, work_mode, region_id, gname, source_region_id)
        if not src: continue
        dst = dst_dir / gname
        copy_file_if_needed(src, dst, manifest, dry_run=dry_run)

def parse_iso_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None

def apply_online_retention(repo_root: Path, region_id: str, frames_by_var: Dict[str, List[FrameEntry]], retention_days: Optional[int], dry_run: bool = False) -> Dict[str, List[FrameEntry]]:
    """Keep only recent published frame payloads in the GitHub Pages repo.

    Local processed products under /home/gzheng/data are untouched. This only
    prunes the online repo's data/<region>/<var> JSON payloads and the index.
    """
    if not retention_days or retention_days <= 0:
        return frames_by_var
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    retained: Dict[str, List[FrameEntry]] = {v: [] for v in VARS}
    keep_paths = set()
    for var, frames in frames_by_var.items():
        for frame in frames:
            dt = parse_iso_dt(frame.time_iso)
            if dt is None or dt >= cutoff:
                retained[var].append(frame)
                keep_paths.add(frame.json_path)
    for var in VARS:
        var_dir = repo_root / "data" / region_id / var
        if not var_dir.exists():
            continue
        for path in var_dir.glob("*.json"):
            rel = path.relative_to(repo_root).as_posix()
            if rel not in keep_paths:
                if dry_run:
                    print(f"[DRY] PRUNE online old frame {rel}")
                else:
                    path.unlink()
                    print(f"[INFO] Pruned online old frame {rel}")
    return retained

def sync_optional_bathy(bathy_src, repo_root, region_id, manifest, dry_run=False):
    if not bathy_src: return
    bathy_src = bathy_src.expanduser().resolve()
    if not bathy_src.exists(): return
    dst_base = repo_root / "data" / region_id
    if bathy_src.is_dir():
        for src in sorted(bathy_src.rglob("*")):
            if src.is_dir(): continue
            # Online site needs compact viewer JSON + provenance manifest only.
            # Keep raw GEBCO zip/netCDF locally under /home/gzheng/data.
            if src.suffix.lower() not in {".json"}:
                continue
            rel = src.relative_to(bathy_src)
            # Publish bathy under a stable per-region path regardless of source
            # directory date/version. Local source keeps full provenance.
            dst = dst_base / "gebco_bath_latest" / rel
            copy_file_if_needed(src, dst, manifest, dry_run=dry_run)
    else:
        dst = dst_base / "gebco_bath_latest" / bathy_src.name
        copy_file_if_needed(bathy_src, dst, manifest, dry_run=dry_run)

def maybe_update_index_html(index_html_src, repo_root, manifest, dry_run=False):
    if not index_html_src: return
    index_html_src = index_html_src.expanduser().resolve()
    if index_html_src.exists():
        dst = repo_root / "index.html"
        if copy_file_if_needed(index_html_src, dst, manifest, dry_run=dry_run):
            print("[INFO] Updated index.html")

def git_has_changes(repo_root: Path) -> bool:
    cp = subprocess.run(["git", "status", "--porcelain"], cwd=str(repo_root), check=True, capture_output=True, text=True)
    return bool(cp.stdout.strip())

def git_commit_push(repo_root: Path, message: str, push: bool = True) -> None:
    allowed_paths = ["data", MANIFEST_NAME]
    allowed_paths.extend(p.name for p in repo_root.glob("index*.json"))
    subprocess.run(["git", "add", "-A", "--", *allowed_paths], cwd=str(repo_root), check=True)
    cp = subprocess.run(["git", "commit", "-m", message], cwd=str(repo_root), check=False)
    if cp.returncode == 0:
        if push:
            subprocess.run(["git", "push"], cwd=str(repo_root), check=True)
    else:
        print("[INFO] Nothing to commit.")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prod-root", required=True)
    ap.add_argument("--work-mode", required=True)
    ap.add_argument("--region-id", required=True)
    ap.add_argument("--source-region-id", default=None, help="Read production products from this region id but publish as --region-id")
    ap.add_argument("--repo-dir", required=True)
    ap.add_argument("--index-name", default=None, help="Output index filename, e.g. index-usec_md.json")
    ap.add_argument("--region-meta-json", default=None, help="JSON metadata to embed under region_meta")
    ap.add_argument("--retention-days", type=int, default=31, help="Published online data retention; local processed data is never deleted")
    ap.add_argument("--index-html", default=None)
    ap.add_argument(
        "--allow-index-html-update",
        action="store_true",
        help="Allow --index-html to replace repo index.html. Default is disabled so automated data publishes cannot modify viewer code.",
    )
    ap.add_argument("--bathy-src", default=None)
    ap.add_argument("--no-git", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    prod_root = Path(args.prod_root).expanduser().resolve()
    repo_root = Path(args.repo_dir).expanduser().resolve()

    lock_cm = repo_update_lock(repo_root) if not args.dry_run else nullcontext()
    with lock_cm:
        manifest = load_manifest(repo_root)

        frames = collect_and_sync_frames(prod_root, args.work_mode, args.region_id, repo_root, manifest, args.dry_run, args.source_region_id)
        sync_grids(prod_root, args.work_mode, args.region_id, repo_root, manifest, args.dry_run, args.source_region_id)
        if args.index_html and not args.allow_index_html_update:
            raise SystemExit("--index-html requires --allow-index-html-update")
        maybe_update_index_html(Path(args.index_html) if args.index_html else None, repo_root, manifest, args.dry_run)
        sync_optional_bathy(Path(args.bathy_src) if args.bathy_src else None, repo_root, args.region_id, manifest, args.dry_run)
        frames = apply_online_retention(repo_root, args.region_id, frames, args.retention_days, args.dry_run)
        region_meta = json.loads(args.region_meta_json) if args.region_meta_json else None
        if region_meta is None:
            region_meta = {}
        region_meta["online_retention_days"] = args.retention_days
        write_index_json(repo_root, args.region_id, frames, args.dry_run, args.index_name, region_meta)

        if not args.dry_run:
            save_manifest(repo_root, manifest)

        if not args.no_git and not args.dry_run and git_has_changes(repo_root):
            msg = f"Update viewer data: {args.work_mode}/{args.region_id} @ {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')}"
            git_commit_push(repo_root, msg, push=(not args.no_push))

if __name__ == "__main__":
    main()
