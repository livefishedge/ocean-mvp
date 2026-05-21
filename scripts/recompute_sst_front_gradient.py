#!/usr/bin/env python3
"""Recompute SST front intensity as gradient (°C/km) from raw SST cross-sections.

For each front point:
  1. Find perpendicular direction to the front
  2. Sample raw SST at ±1..±10km perpendicular to the front
  3. Fit a step-function model: cold_mean at negative distances, warm_mean at positive
  4. gradient = |warm_mean - cold_mean| / (2 * d_step)
     where d_step = distance where SST first reaches the midpoint between warm_mean and cold_mean

This is the actual physical gradient at the front boundary.
"""
import json, math, numpy as np, argparse
from pathlib import Path

KM_PER_DEG_LAT = 111.0

def load_sst(sst_path):
    with open(sst_path) as f:
        d = json.load(f)
    z = np.array(d['z'], dtype=np.float32)
    z[z == -9999] = np.nan
    return z, d['bbox'], d['ny'], d['nx']

def lonlat_to_yx(lon, lat, bbox, ny, nx):
    min_lon, min_lat, max_lon, max_lat = bbox
    x = (lon - min_lon) / (max_lon - min_lon) * (nx - 1)
    y = (max_lat - lat) / (max_lat - min_lat) * (ny - 1)
    return round(y), round(x)

def km_per_px_at(y, x, bbox, ny, nx):
    min_lon, min_lat, max_lon, max_lat = bbox
    lat = max_lat - (y / (ny - 1)) * (max_lat - min_lat)
    deg_per_px_x = (max_lon - min_lon) / (nx - 1)
    deg_per_px_y = (max_lat - min_lat) / (ny - 1)
    kmx = deg_per_px_x * 111.0 * math.cos(math.radians(lat))
    kmy = deg_per_px_y * KM_PER_DEG_LAT
    return math.sqrt(kmx**2 + kmy**2)

def perp_gradient_at(z, bbox, ny, nx, lon, lat, prev_coord, next_coord):
    """Compute perpendicular SST gradient at a single front point.
    
    Args:
        z: SST array (ny x nx)
        bbox, ny, nx: SST metadata
        lon, lat: front point coordinates
        prev_coord, next_coord: neighboring coords to determine tangent direction
    
    Returns:
        gradient_C_km or None if computation fails
    """
    y, x = lonlat_to_yx(lon, lat, bbox, ny, nx)
    kp = km_per_px_at(y, x, bbox, ny, nx)
    
    # Tangent direction from neighboring points
    if prev_coord and next_coord:
        dx = next_coord[0] - prev_coord[0]
        dy = next_coord[1] - prev_coord[1]
    elif prev_coord:
        dx = lon - prev_coord[0]; dy = lat - prev_coord[1]
    elif next_coord:
        dx = next_coord[0] - lon; dy = next_coord[1] - lat
    else:
        return None
    tlen = math.hypot(dx, dy)
    if tlen < 1e-10: return None
    pn_x = -dy / tlen  # perpendicular unit vector
    pn_y = dx / tlen
    
    min_lon, min_lat, max_lon, max_lat = bbox
    lat_val = max_lat - (y / (ny - 1)) * (max_lat - min_lat)
    deg_per_px_x = (max_lon - min_lon) / (nx - 1)
    deg_per_px_y = (max_lat - min_lat) / (ny - 1)
    
    warm_sst = []; cold_sst = []
    for sign in (1, -1):
        for d_km in range(1, 11):
            dlon = sign * d_km * pn_x / (111.0 * math.cos(math.radians(lat_val)))
            dlat = sign * d_km * pn_y / 111.0
            sx = x + int(round(dlon / deg_per_px_x))
            sy = y + int(round(dlat / deg_per_px_y))
            if 0 <= sx < nx and 0 <= sy < ny:
                v = z[sy, sx]
                if np.isfinite(v):
                    if sign > 0: warm_sst.append(v)
                    else: cold_sst.append(v)
    
    if len(warm_sst) < 3 or len(cold_sst) < 3: return None
    
    # Step-function model:
    # cold_mean = mean of closest cold-side samples
    # warm_mean = mean of closest warm-side samples
    # midpoint = (cold_mean + warm_mean) / 2
    # Find d_cold where SST first rises above midpoint (from cold side)
    # Find d_warm where SST first rises above midpoint (from warm side)
    # front_width = d_cold + d_warm
    # gradient = |warm_mean - cold_mean| / front_width
    
    # Use closest 3 samples on each side as "near-front" values
    cold_mean = np.mean(cold_sst[:3])
    warm_mean = np.mean(warm_sst[:3])
    delta = abs(warm_mean - cold_mean)
    if delta < 0.1: return None
    
    # midpoint between the two means
    midpoint = (cold_mean + warm_mean) / 2.0
    
    # Find transition distance on cold side (how far to reach midpoint from cold water)
    d_cold = None
    for v, d in zip(cold_sst, range(1, len(cold_sst)+1)):
        if v >= midpoint:
            d_cold = d
            break
    # Find transition distance on warm side
    d_warm = None
    for v, d in zip(warm_sst, range(1, len(warm_sst)+1)):
        if v >= midpoint:
            d_warm = d
            break
    
    if d_cold is not None and d_warm is not None:
        front_width_km = d_cold + d_warm
    elif d_cold is not None:
        front_width_km = 2 * d_cold
    elif d_warm is not None:
        front_width_km = 2 * d_warm
    else:
        # Fallback: use total sampling extent
        front_width_km = len(cold_sst) + len(warm_sst)
    
    if front_width_km < 0.5: return None
    return delta / front_width_km


def process_front_file(front_path, sst_dir, out_path=None):
    """Process one front JSON file, computing gradient from companion SST."""
    with open(front_path) as f:
        front = json.load(f)
    
    # Find companion SST file
    stem = Path(front_path).stem
    # front stem like: sstfront_usec_south_2026139_20260519_07_g19
    # SST stem like: sst_usec_south_2026139_20260519_07_g19
    # Use source_frame from front JSON metadata — it's the exact companion SST filename
    source_frame = front.get('source_frame')
    if source_frame:
        sst_path = Path(sst_dir) / source_frame
    else:
        # Fallback: parse filename
        parts = stem.split('_')
        sat_str = parts[-1]
        hour_str = parts[4]
        sst_stem = f"sst_{'_'.join(parts[1:5])}_{hour_str}_{sat_str}"
        sst_path = Path(sst_dir) / f"{sst_stem}.json"
    
    if not sst_path.exists():
        print(f"  SST not found: {sst_path}")
        return None
    
    z, bbox, ny, nx = load_sst(sst_path)
    min_lon, min_lat, max_lon, max_lat = bbox
    
    updated = 0
    for feat in front.get('features', []):
        coords = feat.get('geometry', {}).get('coordinates', [])
        if not coords: continue
        
        gradients = []
        for i, coord in enumerate(coords):
            lon, lat = coord[0], coord[1]
            prev_c = coords[i-1] if i > 0 else None
            next_c = coords[i+1] if i < len(coords)-1 else None
            
            g = perp_gradient_at(z, bbox, ny, nx, lon, lat, prev_c, next_c)
            if g is not None:
                gradients.append(g)
        
        if gradients:
            median_grad = float(np.median(gradients))
            feat['properties']['gradient_per_km'] = round(median_grad, 4)
            updated += 1
        else:
            feat['properties']['gradient_per_km'] = None
    
    front['algorithm']['gradient_unit'] = '°C/km'
    front['algorithm']['gradient_method'] = 'step_function_sst_cross_section'
    
    if out_path is None:
        out_path = front_path
    with open(out_path, 'w') as f:
        json.dump(front, f, separators=(',', ':'))
    
    return updated


def main():
    parser = argparse.ArgumentParser(description='Recompute SST front gradient from raw SST')
    parser.add_argument('front_glob', help='Front JSON path or glob pattern')
    parser.add_argument('--sst-dir', required=True, help='Directory containing SST JSON files')
    parser.add_argument('--out-dir', help='Output directory (default: overwrite in place)')
    args = parser.parse_args()
    
    import glob
    files = glob.glob(args.front_glob)
    if not files:
        print(f"No files match: {args.front_glob}")
        return
    
    for fpath in sorted(files):
        out = None
        if args.out_dir:
            out = Path(args.out_dir) / Path(fpath).name
        print(f"Processing: {fpath}")
        n = process_front_file(fpath, args.sst_dir, out)
        if n:
            print(f"  Updated {n} features with gradient_per_km")


if __name__ == '__main__':
    main()
