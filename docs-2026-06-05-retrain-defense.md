# Three-Layer Defense For Daily-Retrain Regressions (2026-06-05)

## Background

## Actual 6/4 retrain results (2026-06-05 holdout validation)

The 6/4 retrain completed and passed the saved-checkpoint gate for all
3 sensors (VNP, VJ1, VJ2). Post-publish holdout validation against
individual VIIRS swaths gave the following:

| Swath | New ratio | Flag | Prior ratio | Gate |
|---|---|---|---|---|
| 6/4 VJ2 (1654) | 0.23 | **inverted** | 7.65 | **REJECTED** |
| 6/4 VNP (1730) | 1.41 | no signal | 8.24 | ✅ PASS |
| 6/4 VJ1 (1748) | 1.40 | no signal | 10.05 | ✅ PASS |
| 6/4 VJ2 (1836) | 1.37 | no signal | 5.76 | ✅ PASS |
| 6/4 VNP (1909) | 1.31 | no signal | 11.51 | ✅ PASS |

**VJ2 (1654) was correctly rejected** by the holdout gate (coastal/offshore
ratio 0.23x = inverted gradient). All other swaths passed with "no signal"
(coastal/offshore too similar to call — not a regression, just low signal).
The prior model (May 13 `multi_day_120_132_det41`) remains in production.
The 6/4 retrain models are quarantined in `_quarantine_20260605_usec_south_broken_retrain/`.

## Original 6/4 incident (before defense layers)

Before the three-layer defense was added, the 6/4 daily retrain of
`cross_sensor/usec_south` produced a degraded detector-aware model that
inverted CHL output on the 6/4 VIIRS swaths:

- Healthy 6/3 (working): coastal/offshore ratio 0.06 - 0.09x
- Broken 6/4: ratio 12.2x (VNP), 0.82x (VJ1), 1.86x (VJ2)

The inversion was silently published over the fine original CHL frames
on 6/4 19:53 UTC. The viewer showed bad data for ~15 hours until Mike
noticed and asked for the 3 bad frames to be removed.

## Root cause

The 6/4 retrain overfitted to a single-platform S3A OLCI truth
distribution that had a different VIIRS-detector occupancy than the
6/4 swaths the model was asked to predict. The result: the new model
applied learned detector-specific corrections that were wrong for the
6/4 swaths, producing inverted output.

## Three-layer defense

After this incident, three gates were added to prevent recurrence:

### Layer 1 — Post-training holdout validation

**File:** `~/pipelines/nasa_pipeline/validate_model_against_holdout.py`

After `retrain_cross_sensor.py` completes, the new model is run
against 3-5 held-out historical VIIRS swaths that the model was NOT
trained on. For each swath, both the new and prior models are run;
the physical invariants (coastal/offshore ratio, mid-band spike,
mean CHL) are compared. If the new model regresses on ANY swath,
the new model is rejected and the prior model is restored.

Wired into `chl_retrain_daily.py` at the point right after
`retrain_cross_sensor.py` and before
`nrt_chl_full_pipeline.py --reprocess`.

### Layer 2 — Shadow-mode on live NRT

**File:** `~/pipelines/nasa_pipeline/nrt_chl_full_pipeline.py`
(args: `--shadow-prior-model-dir`, `--shadow-report-path`)

When a new model is in production, every NRT scan also runs the prior
model in parallel. A divergence report is written per-scan to the
shadow report path. The new model still produces production output;
the prior is observational. If the operator sees sustained divergence
on real NRT data, they can roll back via the model quarantine
(rename `cross_sensor/<region>/` to `_quarantine_<date>_<region>/`).

Use case: even if Layer 1 (validation) passes on the holdout set, the
new model might still fail on a future swath whose detector
distribution is unusual. Shadow mode catches this in real time.

### Layer 3 — Cycle gate + manual approval

**Files:**
- `~/pipelines/chl_retrain_daily.py` (cycle gate, manual approval)
- `~/pipelines/approve_pending_retrain.py` (operator command)

The cycle gate is a guard on the retrain frequency:

- New behavior (default): retrain at most once every
  `RETRAIN_CYCLE_DAYS` calendar days (default 3).
- Old behavior: retrain on every new OLCI day.

The manual approval gate is a staging step:

- New behavior: a new retrain is staged in
  `models/cross_sensor/_pending_<date>_<region>/` and a marker
  JSON is written. The production model is NOT replaced. The
  operator must run `approve_pending_retrain.py --decision approve`
  to promote (or `--decision reject` to discard).
- Old behavior: a successful retrain auto-replaced the production
  model and the auto-publish loop pushed it to the viewer.

The combination of cycle + approval breaks the "fast-fail-fast-recover"
auto-publish loop that produced the 6/4 incident.

## Usage examples

```bash
# Run a retrain with manual approval (recommended for production)
python chl_retrain_daily.py --region usec_south --require-manual-approval

# Check what's pending
python approve_pending_retrain.py --list

# Approve a pending retrain
python approve_pending_retrain.py --region usec_south --date 20260607 --decision approve

# Reject
python approve_pending_retrain.py --region usec_south --date 20260607 --decision reject
```

## Quarantine procedure (manual rollback)

If a bad model is already in production:

```bash
# Move the broken model to a quarantine dir
mv /home/gzheng/retrain_chlnet/models/cross_sensor/<region> \
   /home/gzheng/retrain_chlnet/models/cross_sensor/_quarantine_<date>_<region>

# Move the prior good model (saved automatically as _prior_<date>_<region>)
# OR the validated fallback (multi_day_120_132_det41) back to production
mv /home/gzheng/retrain_chlnet/models/cross_sensor/_prior_<date>_<region> \
   /home/gzheng/retrain_chlnet/models/cross_sensor/<region>
```

The next NRT pipeline run will pick up the restored model via the
selector at `_select_chl_model_version`.
