#!/usr/bin/env python3
"""Prototype literature-style CHL/SST front detectors on published viewer frames.

This is intentionally offline: it writes artifacts for inspection, not production
front products. The two trial detectors are:

- CHL: BOA-style local histogram separation on log chlorophyll.
- SST: Cayula-Cornillon/SIED-style local histogram separation with cohesion gates.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import matplotlib.pyplot as plt
import numpy as np
from scipy import ndimage as ndi


@dataclass(frozen=True)
class FrontConfig:
    name: str
    transform: str
    window_px: int
    stride_px: int
    min_valid_fraction: float
    min_population_fraction: float
    min_class_delta: float
    min_cohesion: float
    min_component_px: int
    max_components: int
    unit: str


CHL_BOA = FrontConfig(
    name="boa_local_histogram_log_chl_v0",
    transform="log_chl",
    window_px=41,
    stride_px=6,
    min_valid_fraction=0.45,
    min_population_fraction=0.12,
    min_class_delta=math.log(1.35),  # 1.35x CHL contrast
    min_cohesion=0.45,
    min_component_px=18,
    max_components=40,
    unit="fold",
)

SST_CCA = FrontConfig(
    name="cca_sied_local_histogram_sst_v0",
    transform="linear",
    window_px=49,
    stride_px=6,
    min_valid_fraction=0.55,
    min_population_fraction=0.15,
    min_class_delta=0.45,  # deg C
    min_cohesion=0.42,
    min_component_px=22,
    max_components=60,
    unit="degC",
)


def load_frame(index_path: Path, var_name: str, frame_idx: int | None) -> tuple[dict, Path, dict]:
    index = json.loads(index_path.read_text())
    frames = index["frames"][var_name]
    if not frames:
        raise SystemExit(f"No frames for {var_name}")
    if frame_idx is None:
        frame_idx = len(frames) - 1
    meta = frames[frame_idx]
    frame_path = index_path.parent / meta["json_path"]
    data = json.loads(frame_path.read_text())
    return meta, frame_path, data


def as_array(data: dict) -> np.ndarray:
    z = np.asarray(data["z"], dtype=np.float32)
    z[~np.isfinite(z)] = np.nan
    return z


def transform_field(z: np.ndarray, transform: str) -> np.ndarray:
    if transform == "log_chl":
        out = np.full_like(z, np.nan, dtype=np.float32)
        valid = np.isfinite(z) & (z > 0)
        out[valid] = np.log(z[valid])
        return out
    return z.astype(np.float32, copy=True)


def otsu_threshold(values: np.ndarray, bins: int = 64) -> float | None:
    values = values[np.isfinite(values)]
    if values.size < 64:
        return None
    vmin, vmax = np.nanpercentile(values, [1, 99])
    if not np.isfinite(vmin) or not np.isfinite(vmax) or vmax <= vmin:
        return None
    hist, edges = np.histogram(values, bins=bins, range=(float(vmin), float(vmax)))
    centers = (edges[:-1] + edges[1:]) / 2
    weight1 = np.cumsum(hist)
    weight2 = np.cumsum(hist[::-1])[::-1]
    if weight1[-1] == 0:
        return None
    mean1 = np.cumsum(hist * centers) / np.maximum(weight1, 1)
    mean2 = (np.cumsum((hist * centers)[::-1]) / np.maximum(weight2[::-1], 1))[::-1]
    variance12 = weight1[:-1] * weight2[1:] * (mean1[:-1] - mean2[1:]) ** 2
    if variance12.size == 0 or not np.isfinite(variance12).any():
        return None
    return float(centers[:-1][int(np.nanargmax(variance12))])


def largest_fraction(mask: np.ndarray) -> float:
    labels, count = ndi.label(mask)
    if count == 0:
        return 0.0
    sizes = np.bincount(labels.ravel())
    if sizes.size <= 1:
        return 0.0
    return float(sizes[1:].max() / max(mask.sum(), 1))


def local_histogram_front(field: np.ndarray, config: FrontConfig) -> tuple[np.ndarray, np.ndarray, dict]:
    valid_global = np.isfinite(field)
    half = config.window_px // 2
    votes = np.zeros(field.shape, dtype=np.float32)
    strength = np.zeros(field.shape, dtype=np.float32)
    accepted = rejected = 0

    for y in range(half, field.shape[0] - half, config.stride_px):
        for x in range(half, field.shape[1] - half, config.stride_px):
            win = field[y - half : y + half + 1, x - half : x + half + 1]
            valid = np.isfinite(win)
            valid_fraction = float(valid.mean())
            if valid_fraction < config.min_valid_fraction:
                rejected += 1
                continue

            values = win[valid]
            threshold = otsu_threshold(values)
            if threshold is None:
                rejected += 1
                continue

            cold_or_low = valid & (win <= threshold)
            warm_or_high = valid & (win > threshold)
            low_fraction = cold_or_low.sum() / valid.sum()
            high_fraction = warm_or_high.sum() / valid.sum()
            if min(low_fraction, high_fraction) < config.min_population_fraction:
                rejected += 1
                continue

            low_mean = float(np.nanmean(win[cold_or_low]))
            high_mean = float(np.nanmean(win[warm_or_high]))
            delta = high_mean - low_mean
            if delta < config.min_class_delta:
                rejected += 1
                continue

            cohesion = min(largest_fraction(cold_or_low), largest_fraction(warm_or_high))
            if cohesion < config.min_cohesion:
                rejected += 1
                continue

            binary = warm_or_high
            boundary = binary ^ ndi.binary_erosion(binary, structure=np.ones((3, 3)), border_value=0)
            boundary &= valid
            if not boundary.any():
                rejected += 1
                continue
            votes[y - half : y + half + 1, x - half : x + half + 1][boundary] += 1.0
            strength[y - half : y + half + 1, x - half : x + half + 1][boundary] = np.maximum(
                strength[y - half : y + half + 1, x - half : x + half + 1][boundary],
                delta,
            )
            accepted += 1

    edge = votes >= max(2.0, np.nanpercentile(votes[votes > 0], 35) if np.any(votes > 0) else 2.0)
    edge &= valid_global
    edge = ndi.binary_opening(edge, structure=np.ones((2, 2)))
    labels, count = ndi.label(edge)
    component_sizes = np.bincount(labels.ravel())
    keep = np.zeros_like(edge, dtype=bool)
    kept_sizes: list[int] = []
    for label in range(1, count + 1):
        size = int(component_sizes[label])
        if size >= config.min_component_px:
            keep[labels == label] = True
            kept_sizes.append(size)

    if len(kept_sizes) > config.max_components:
        ordered = sorted(enumerate(kept_sizes, start=1), key=lambda t: t[1], reverse=True)
        cutoff = {label for label, _ in ordered[: config.max_components]}
        keep = np.isin(labels, list(cutoff))

    summary = {
        "algorithm": config.name,
        "accepted_windows": accepted,
        "rejected_windows": rejected,
        "edge_pixels": int(keep.sum()),
        "component_count": int(ndi.label(keep)[1]),
        "strength_unit": config.unit,
        "strength_p50": safe_percentile(strength[keep], 50),
        "strength_p90": safe_percentile(strength[keep], 90),
        "strength_max": safe_percentile(strength[keep], 100),
    }
    return keep, strength, summary


def safe_percentile(values: np.ndarray, pct: float) -> float | None:
    values = values[np.isfinite(values)]
    if values.size == 0:
        return None
    return round(float(np.nanpercentile(values, pct)), 4)


def lonlat_from_yx(y: int, x: int, bbox: Iterable[float], ny: int, nx: int) -> tuple[float, float]:
    min_lon, min_lat, max_lon, max_lat = bbox
    lon = min_lon + (max_lon - min_lon) * (x / max(nx - 1, 1))
    lat = min_lat + (max_lat - min_lat) * (y / max(ny - 1, 1))
    return round(float(lon), 6), round(float(lat), 6)


def components_to_geojson(mask: np.ndarray, strength: np.ndarray, data: dict, source_meta: dict, config: FrontConfig) -> dict:
    labels, count = ndi.label(mask)
    sizes = np.bincount(labels.ravel())
    ranked = sorted(range(1, count + 1), key=lambda label: sizes[label], reverse=True)[: config.max_components]
    features = []
    bbox = data["bbox"]
    ny, nx = mask.shape
    for label in ranked:
        ys, xs = np.where(labels == label)
        if ys.size < config.min_component_px:
            continue
        coords = [lonlat_from_yx(int(y), int(x), bbox, ny, nx) for y, x in sorted(zip(ys, xs))]
        vals = strength[labels == label]
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "source_var": source_meta["var"],
                    "pixel_count": int(ys.size),
                    "strength_unit": config.unit,
                    "strength_median": safe_percentile(vals, 50),
                    "strength_max": safe_percentile(vals, 100),
                },
            }
        )
    return {
        "type": "FeatureCollection",
        "variable": f"{source_meta['var']}_front_trial",
        "source_variable": source_meta["var"],
        "source_frame": source_meta.get("json_path"),
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "bbox": data["bbox"],
        "ny": ny,
        "nx": nx,
        "algorithm": {
            "name": config.name,
            "window_px": config.window_px,
            "stride_px": config.stride_px,
            "transform": config.transform,
            "min_class_delta": config.min_class_delta,
            "min_cohesion": config.min_cohesion,
        },
        "features": features,
    }


def plot_trial(raw: np.ndarray, mask: np.ndarray, strength: np.ndarray, title: str, out_path: Path) -> None:
    fig, axes = plt.subplots(1, 3, figsize=(15, 5), constrained_layout=True)
    finite = raw[np.isfinite(raw)]
    vmin, vmax = np.nanpercentile(finite, [2, 98]) if finite.size else (0, 1)
    axes[0].imshow(raw, origin="lower", cmap="viridis", vmin=vmin, vmax=vmax)
    axes[0].set_title("source")
    axes[1].imshow(mask, origin="lower", cmap="gray")
    axes[1].set_title("trial fronts")
    axes[2].imshow(raw, origin="lower", cmap="gray", vmin=vmin, vmax=vmax)
    overlay = np.ma.masked_where(~mask, strength)
    axes[2].imshow(overlay, origin="lower", cmap="autumn")
    axes[2].set_title("overlay / strength")
    for ax in axes:
        ax.set_xticks([])
        ax.set_yticks([])
    fig.suptitle(title)
    fig.savefig(out_path, dpi=160)
    plt.close(fig)


def run_one(index_path: Path, var_name: str, frame_idx: int | None, config: FrontConfig, out_dir: Path) -> dict:
    meta, frame_path, data = load_frame(index_path, var_name, frame_idx)
    raw = as_array(data)
    field = transform_field(raw, config.transform)
    mask, strength, summary = local_histogram_front(field, config)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(meta["json_path"]).stem
    geojson = components_to_geojson(mask, strength, data, meta, config)
    geojson_path = out_dir / f"{stem}.{config.name}.geojson"
    png_path = out_dir / f"{stem}.{config.name}.png"
    geojson_path.write_text(json.dumps(geojson, separators=(",", ":")))
    plot_trial(raw, mask, strength, f"{var_name.upper()} {stem} {config.name}", png_path)
    summary.update(
        {
            "var": var_name,
            "source": str(frame_path),
            "geojson": str(geojson_path),
            "png": str(png_path),
            "feature_count": len(geojson["features"]),
        }
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", default="index-usec_south.json", type=Path)
    parser.add_argument("--out-dir", default="artifacts/front_trials", type=Path)
    parser.add_argument("--chl-frame-idx", type=int)
    parser.add_argument("--sst-frame-idx", type=int)
    args = parser.parse_args()

    results = [
        run_one(args.index, "chl", args.chl_frame_idx, CHL_BOA, args.out_dir),
        run_one(args.index, "sst", args.sst_frame_idx, SST_CCA, args.out_dir),
    ]
    summary_path = args.out_dir / "summary.json"
    summary_path.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
