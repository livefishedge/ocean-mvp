"""Enhance recompute_sst_front_gradient.py to store per-point gradient arrays."""
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

def perp_gradient_at(z, bbox, ny, nx, lon, lat, prev_coord, next_coord):
    y, x = lonlat_to_yx(lon, lat, bbox, ny, nx)
    if not (0 <= y < ny and 0 <= x < nx): return None
    min_lon, min_lat, max_lon, max_lat = bbox
    lat_val = max_lat - (y / (ny - 1)) * (max_lat - min_lat)
    deg_per_px_x = (max_lon - min_lon) / (nx - 1)
    deg_per_px_y = (max_lat - min_lat) / (ny - 1)
    
    if prev_coord and next_coord:
        dx = next_coord[0] - prev_coord[0]; dy = next_coord[1] - prev_coord[1]
    elif prev_coord:
        dx = lon - prev_coord[0]; dy = lat - prev_coord[1]
    elif next_coord:
        dx = next_coord[0] - lon; dy = next_coord[1] - lat
    else:
        return None
    tlen = math.hypot(dx, dy)
    if tlen < 1e-10: return None
    pn_x = -dy / tlen; pn_y = dx / tlen
    
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
    cold_mean = np.mean(cold_sst[:3]); warm_mean = np.mean(warm_sst[:3])
    delta = abs(warm_mean - cold_mean)
    if delta < 0.1: return None
    midpoint = (cold_mean + warm_mean) / 2.0
    d_cold = next((d for v, d in zip(cold_sst, range(1, len(cold_sst)+1)) if v >= midpoint), None)
    d_warm = next((d for v, d in zip(warm_sst, range(1, len(warm_sst)+1)) if v >= midpoint), None)
    if d_cold is not None and d_warm is not None: fw = d_cold + d_warm
    elif d_cold is not None: fw = 2 * d_cold
    elif d_warm is not None: fw = 2 * d_warm
    else: fw = len(cold_sst) + len(warm_sst)
    if fw < 0.5: return None
    return delta / fw

def process_front_file(front_path, sst_dir, out_path=None):
    with open(front_path) as f:
        front = json.load(f)
    
    source_frame = front.get('source_frame')
    if source_frame:
        sst_path = Path(sst_dir) / source_frame
    else:
        parts = Path(front_path).stem.split('_')
        sst_path = Path(sst_dir) / f"sst_{'_'.join(parts[1:5])}_{parts[4]}_{parts[-1]}.json"
    
    if not sst_path.exists():
        print(f"  SST not found: {sst_path}")
        return 0
    
    z, bbox, ny, nx = load_sst(sst_path)
    updated = 0
    for feat in front.get('features', []):
        coords = feat.get('geometry', {}).get('coordinates', [])
        if not coords: continue
        
        per_point = []
        for i, coord in enumerate(coords):
            lon, lat = coord[0], coord[1]
            prev_c = coords[i-1] if i > 0 else None
            next_c = coords[i+1] if i < len(coords)-1 else None
            g = perp_gradient_at(z, bbox, ny, nx, lon, lat, prev_c, next_c)
            per_point.append(round(g, 4) if g is not None else None)
        
        valid = [g for g in per_point if g is not None]
        if valid:
            feat['properties']['gradient_per_km'] = round(float(np.median(valid)), 4)
            feat['properties']['gradient_map'] = per_point  # NEW: per-point array
        else:
            feat['properties']['gradient_per_km'] = None
            feat['properties']['gradient_map'] = [None] * len(coords)
        
        updated += 1
    
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
            print(f"  Updated {n} features with gradient_per_km + gradient_map")

if __name__ == '__main__':
    main()
