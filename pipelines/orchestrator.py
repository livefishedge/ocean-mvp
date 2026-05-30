import os
import sys
import time
import json
import subprocess
import logging
import fcntl
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

# ================= CONFIGURATION =================
# Variables to replace hardcoded strings
WORK_MODE = "prod"
DEFAULT_NEW_REGION_BOOTSTRAP_DAYS = 7
DEFAULT_MAX_ONLINE_RETENTION_DAYS = 31

# Viewer regions. Current Mid-Atlantic region renamed from `ma` to `usec_md`.
# Region polygons are carried as metadata for the viewer; current science CLIs
# consume rectangular bboxes, so bbox is the polygon envelope where needed.
REGIONS = [
    {
        "id": "usec_md",
        "label": "US East Coast — Mid-Atlantic",
        "bbox": ["-76.5", "35.5", "-71.5", "40.5"],
        "source_region_id": "ma",  # legacy production data path while products migrate
    },
    {
        "id": "usec_south",
        "label": "US East Coast — South-Atlantic",
        "polygon": [[-81, 32], [-76, 36], [-73, 35], [-79, 31]],
        "bbox": ["-81", "31", "-73", "36"],
        "data_days": DEFAULT_NEW_REGION_BOOTSTRAP_DAYS,
    },
]
DEFAULT_REGION_ID = "usec_md"
ONLINE_RETENTION_DAYS = 31

# Paths
HOME = os.path.expanduser("~")
# update_github_viewer_repo.py is persisted in the ocean-mvp git repo (pipelines/)
# so the fix survives filesystem resets. All other pipeline scripts live in ~/pipelines.
OCEAN_MVP_REPO = os.path.join(HOME, "github", "ocean-mvp")
PIPELINE_ROOT = os.path.join(HOME, "pipelines")  # JAXA, S3, CMEMS, fronts pipelines
GITHUB_REPO_PIPELINE = os.path.join(HOME, "github", "ocean-mvp", "pipelines")  # update_github_viewer_repo.py lives here (persisted in git)
STATE_FILE = os.path.join(PIPELINE_ROOT, "orchestrator_state.json")
LOG_FILE = os.path.join(PIPELINE_ROOT, "orchestrator.log")
LOCK_FILE = os.path.join(PIPELINE_ROOT, "orchestrator.lock")

# Pipeline dependencies live in Mike's ML venv. Do not inherit OpenClaw's
# runtime python, which may lack xarray/netCDF4/copernicusmarine/cartopy.
PIPELINE_PYTHON = os.environ.get(
    "PIPELINE_PYTHON",
    os.path.join(HOME, "envs", "ml", "bin", "python"),
)
if not os.path.exists(PIPELINE_PYTHON):
    PIPELINE_PYTHON = sys.executable

# ================= ENVIRONMENT SETUP =================
env = os.environ.copy()

# Add the root AND all specific pipeline subdirectories to PYTHONPATH
python_paths = [
    PIPELINE_ROOT,
    os.path.join(PIPELINE_ROOT, "goes_pipeline"),
    os.path.join(PIPELINE_ROOT, "nasa_pipeline"),
    os.path.join(PIPELINE_ROOT, "cmems_pipeline"),
    os.path.join(PIPELINE_ROOT, "github_repo"),
    env.get("PYTHONPATH", "")
]

env["PYTHONPATH"] = os.pathsep.join(filter(None, python_paths))

# ================= Logging Setup =================

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# Timezone
TZ_EASTERN = ZoneInfo("America/New_York")
TZ_GMT = ZoneInfo("GMT")

# ================= HELPER FUNCTIONS =================

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    return {}

def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=4)


def success_history_key(job_id):
    return f"success_history:{job_id}"


def record_success(state, job_id, when=None, max_samples=45):
    """Record successful retrieval hours so schedules converge to real availability."""
    when = when or datetime.now(TZ_EASTERN)
    hist = state.get(success_history_key(job_id), [])
    hist.append({"ts": when.timestamp(), "hour": when.hour + when.minute / 60.0})
    state[success_history_key(job_id)] = hist[-max_samples:]


def learned_window(state, job_id, default_start_hour, default_end_hour, min_samples=3, pad_hours=1.0):
    """Return an adaptive local-time run window learned from prior successes.

    Until there are enough samples, use the conservative default. Once data has
    landed several times, shrink to the observed availability hour range +/- pad.
    """
    hist = state.get(success_history_key(job_id), [])
    hours = [float(x.get("hour")) for x in hist if "hour" in x]
    if len(hours) < min_samples:
        return default_start_hour, default_end_hour
    start = max(0.0, min(hours) - pad_hours)
    end = min(23.99, max(hours) + pad_hours)
    # Never collapse into a too-narrow window; cloud/API delays are real.
    if end - start < 2.0:
        mid = (start + end) / 2.0
        start = max(0.0, mid - 1.0)
        end = min(23.99, mid + 1.0)
    return start, end


def in_hour_window(now, start_hour, end_hour):
    h = now.hour + now.minute / 60.0
    return start_hour <= h <= end_hour


def run_command(cmd_list, description, cwd=None):
    """
    Runs a shell command and logs output.
    """
    logging.info(f"STARTING: {description}")
    try:
        full_cmd = [PIPELINE_PYTHON] + cmd_list
        
        result = subprocess.run(
            full_cmd, 
            env=env, 
            check=True, 
            capture_output=True, 
            text=True, 
            cwd=cwd
        )
        logging.info(f"SUCCESS: {description}")
        if result.stdout:
            logging.info(f"STDOUT {description}: {result.stdout[-2000:]}")
        return True
    except subprocess.CalledProcessError as e:
        logging.error(f"FAILED: {description}. Error: {e.stderr}")
        if e.stdout:
            logging.error(f"STDOUT {description}: {e.stdout[-2000:]}")
        return False

# ================= PIPELINE DEFINITIONS =================

def region_data_days(region):
    # New regions should be bootstrapped with a full week of products by default.
    return int(region.get("data_days", DEFAULT_NEW_REGION_BOOTSTRAP_DAYS))


def run_nasa_nrt(state, region):
    """Job 1: Every 30 mins, 2pm - 8:30pm ET"""
    job_id = f"nasa_nrt:{region['id']}"
    now = datetime.now(TZ_EASTERN)
    
    # VIIRS NPP/N20/N21 overpass is ~1:30pm local solar; L2/NRT products
    # typically become worth checking around 2:30pm. Start at 14:30 ET and
    # learn tighter windows from successful retrievals over time.
    start_hour, end_hour = learned_window(state, job_id, 14.5, 20.5)
    if not in_hour_window(now, start_hour, end_hour):
        return False

    last_run_ts = state.get(job_id, 0)
    last_run = datetime.fromtimestamp(last_run_ts, tz=TZ_EASTERN)
    
    # Check every 15 minutes inside the learned/physics-based availability window.
    if (now - last_run) > timedelta(minutes=15):
        
        script_dir = os.path.join(PIPELINE_ROOT, "nasa_pipeline")
        cmd = [
            "nrt_chl_full_pipeline.py",
            "--work-mode", WORK_MODE,
            "--region-id", region["id"],
            "--bbox", *region["bbox"],
            "--nrt",
            "--days", str(region_data_days(region)),
            # Download any real ROI-intersecting VIIRS granule. Small-overlap
            # neighbor swaths are needed to complete orbit composites; the
            # downstream --min-swath-coverage gate still prevents publishing
            # useless tiny standalone products.
            "--min-coverage", "0.1"
        ]
        
        if run_command(cmd, f"NASA NRT Pipeline ({region['id']})", cwd=script_dir):
            state[job_id] = now.timestamp()
            record_success(state, job_id, now)
            save_state(state)
            return True
    return False

def run_goes_sst(state, region):
    """Job 2: Every hour"""
    job_id = f"goes_sst:{region['id']}"
    now = datetime.now(TZ_EASTERN)
    last_run_ts = state.get(job_id, 0)
    last_run = datetime.fromtimestamp(last_run_ts, tz=TZ_EASTERN)

    # GOES SST should be close to now; check frequently enough to keep ~1h latency.
    if (now - last_run) > timedelta(minutes=15):
        
        script_dir = os.path.join(PIPELINE_ROOT, "goes_pipeline")
        cmd = [
            "goes_sst_daily_cli.py",
            "--bbox", *region["bbox"],
            "--min-coverage", "5",
            "--region-id", region["id"],
            "--base-path", f"{HOME}/data",
            "--goes-id", "g19",
            "--work-mode", WORK_MODE,
            "--save-json-scan",
            "--remote-latency-hours", "1",
            "--days", str(region_data_days(region))
        ]
        
        if run_command(cmd, f"GOES SST Pipeline ({region['id']})", cwd=script_dir):
            state[job_id] = now.timestamp()
            record_success(state, job_id, now)
            save_state(state)
            return True
    return False

def run_cmems_uv(state, region):
    """
    Job 3: CMEMS UV
    Schedule: Daily.
    Window: Starts at 11:02 AM GMT.
    Retry: Every 30 minutes until data is successfully updated for the current day.
    """
    job_id = f"cmems_uv:{region['id']}"
    attempt_key = f"cmems_uv_last_attempt:{region['id']}"
    
    TZ_GMT = ZoneInfo("GMT")
    now = datetime.now(TZ_GMT)
    
    # 1. Check Success Status
    last_success_ts = state.get(job_id, 0)
    last_success = datetime.fromtimestamp(last_success_ts, tz=TZ_GMT)
    
    if last_success.date() == now.date():
        return False 

    # 2. Check Start Time
    start_time = now.replace(hour=11, minute=2, second=0, microsecond=0)
    if now < start_time:
        return False 

    # 3. Check Retry Interval
    last_attempt_ts = state.get(attempt_key, 0)
    last_attempt = datetime.fromtimestamp(last_attempt_ts, tz=TZ_GMT)
    
    if (now - last_attempt) < timedelta(minutes=30):
        return False 

    # 4. Run Pipeline
    state[attempt_key] = now.timestamp()
    save_state(state)

    script_dir = os.path.join(PIPELINE_ROOT, "cmems_pipeline")
    cmd = [
        "cli_uv_daily.py",
        "--bbox", *region["bbox"],
        "--n-days", str(region_data_days(region)),
        "--region-id", region["id"],
        "--base-path", f"{HOME}/data",
        "--work-mode", WORK_MODE
    ]
    
    if run_command(cmd, f"CMEMS UV Pipeline ({region['id']})", cwd=script_dir):
        state[job_id] = now.timestamp()
        record_success(state, job_id, datetime.now(TZ_EASTERN))
        save_state(state)
        return True

    return False

def run_s3_nrt(state, region):
    """
    Job 4: Sentinel-3 NRT
    Schedule: every 15 min after OLCI local overpass + typical L2 latency.
    """
    job_id = f"s3_nrt:{region['id']}"
    now = datetime.now(TZ_EASTERN)

    # OLCI overpass is ~10:30am local solar; L2 is usually available ~2h
    # later, so start checking at 12:30 ET and learn tighter windows from
    # observed successes.
    start_hour, end_hour = learned_window(state, job_id, 12.5, 23.99)
    if not in_hour_window(now, start_hour, end_hour):
        return False

    last_run_ts = state.get(job_id, 0)
    last_run = datetime.fromtimestamp(last_run_ts, tz=TZ_EASTERN)

    # Check every 15 minutes inside the learned/physics-based availability window.
    if (now - last_run) > timedelta(minutes=15):
        
        script_dir = os.path.join(PIPELINE_ROOT, "eumetsat_pipeline")
        
        cmd = [
            "s3_nrt_chl_pipeline.py",
            "--region_id", region["id"],
            "--bbox", *region["bbox"],
            "--n_days", str(region_data_days(region)),
            "--variable", "CHL_OC4ME",
            "--mode", WORK_MODE,
            "--quality", "aggressive"
        ]
        
        if run_command(cmd, f"S3 NRT Pipeline ({region['id']})", cwd=script_dir):
            state[job_id] = now.timestamp()
            record_success(state, job_id, now)
            save_state(state)
            return True
    return False



def run_jaxa_sgli(state, region):
    """
    Job 5: JAXA G-Portal SGLI NRT
    Schedule: every 15 min during daylight (6am-8pm ET) when GCOM-C passes are active.
    """
    job_id = f"jaxa_sgli:{region['id']}"
    now = datetime.now(TZ_EASTERN)

    # GCOM-C descending node ~10:30 AM local solar; L2 appears ~1-2h later
    start_hour, end_hour = learned_window(state, job_id, 11.5, 20.0)
    if not in_hour_window(now, start_hour, end_hour):
        return False

    last_run_ts = state.get(job_id, 0)
    last_run = datetime.fromtimestamp(last_run_ts, tz=TZ_EASTERN)

    if (now - last_run) > timedelta(minutes=15):

        script_dir = os.path.join(PIPELINE_ROOT, "jaxa_pipeline")

        cmd = [
            "publish_to_viewer.py",
            "--bbox", *region["bbox"],
            "--days", "3",
            "--mode", "standalone",
        ]

        if run_command(cmd, f"JAXA SGLI Pipeline ({region['id']})", cwd=script_dir):
            state[job_id] = now.timestamp()
            record_success(state, job_id, now)
            save_state(state)
            return True
    return False



def run_front_generation(region, products):
    """Generate derived front products before publishing the viewer repo."""
    script_dir = os.path.join(PIPELINE_ROOT, "fronts")
    ok = True
    for product in products:
        cmd = [
            "generate_fronts.py",
            "--region-root", f"{HOME}/data/{WORK_MODE}/{region['id']}",
            "--product", product,
        ]
        ok = run_command(cmd, f"{product.upper()} Front Generation ({region['id']})", cwd=script_dir) and ok
    return ok
    

def region_meta(region):
    meta = {k: region[k] for k in ("id", "label", "bbox", "polygon") if k in region}
    meta["bathy_path"] = "gebco_bath_latest/gebco_bathy.json"
    return meta

def ensure_bathy(region):
    bathy_json = Path(HOME) / "data" / WORK_MODE / region["id"] / "bathy" / "gebco_bath_latest" / "gebco_bathy.json"
    if bathy_json.exists():
        return
    script_dir = os.path.join(PIPELINE_ROOT, "bathy")
    cmd = [
        "fetch_gebco_bathy.py",
        "--region-id", region["id"],
        "--bbox", *region["bbox"],
        "--out-root", f"{HOME}/data/{WORK_MODE}",
    ]
    run_command(cmd, f"GEBCO Bathy Fetch ({region['id']})", cwd=script_dir)

def run_github_updater(region):
    """Job 5: Runs if data changed"""
    script_dir = os.path.join(GITHUB_REPO_PIPELINE, "github_repo")
    
    cmd = [
        "update_github_viewer_repo.py",
        "--prod-root", f"{HOME}/data",
        "--work-mode", WORK_MODE,
        "--region-id", region["id"],
        "--repo-dir", f"{HOME}/github/ocean-mvp",
        "--source-region-id", region.get("source_region_id", region["id"]),
        "--index-name", f"index-{region['id']}.json",
        "--region-meta-json", json.dumps(region_meta(region)),
        "--retention-days", str(ONLINE_RETENTION_DAYS),
        "--bathy-src", f"{HOME}/data/{WORK_MODE}/{region['id']}/bathy/gebco_bath_latest"
    ]
    
    run_command(cmd, f"GitHub Repo Updater ({region['id']})", cwd=script_dir)

# ================= MAIN LOOP =================

def main():
    lock_f = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        logging.error("Another orchestrator instance is already running; exiting.")
        print("Another orchestrator instance is already running; exiting.")
        return
    lock_f.seek(0)
    lock_f.truncate()
    lock_f.write(f"pid={os.getpid()} acquired_at={datetime.now().isoformat()}\n")
    lock_f.flush()

    logging.info("Orchestrator Service Started")
    print("Orchestrator running... Press Ctrl+C to stop.")
    
    while True:
        try:
            state = load_state()
            # --- RUN ALL PIPELINE JOBS FOR ALL REGIONS ---
            pipeline_results = {}  # region_id -> bool (any pipeline succeeded)
            for region in REGIONS:
                pipeline_results[region["id"]] = False
                if run_nasa_nrt(state, region):
                    run_front_generation(region, ["chl"])
                    pipeline_results[region["id"]] = True

                if run_goes_sst(state, region):
                    run_front_generation(region, ["sst"])
                    pipeline_results[region["id"]] = True

                if run_cmems_uv(state, region):
                    pipeline_results[region["id"]] = True

                if run_s3_nrt(state, region):
                    pipeline_results[region["id"]] = True

                if run_jaxa_sgli(state, region):
                    pipeline_results[region["id"]] = True

            # --- DEPENDENCY CHECK: trigger github updater for each region with new data ---
            for region in REGIONS:
                if pipeline_results[region["id"]]:
                    logging.info(f"Data detected for {region['id']}. Triggering GitHub update.")
                    run_github_updater(region)

            # Sleep for 1 minute before checking again
            time.sleep(60)

        except KeyboardInterrupt:
            print("Stopping orchestrator.")
            break
        except Exception as e:
            logging.error(f"CRITICAL ERROR in main loop: {e}")
            time.sleep(60) # Wait before retrying

if __name__ == "__main__":
    main()
