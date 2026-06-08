# Quarantined: PACE-OCI and S3B frames with NORTH-UP orientation (2026-06-08)

The Step 2 truth audit (pipelines/cto_6p4_reapply/RECOVERY_FREEZE.json)
found 3 PACE-OCI frames and 1 S3B frame in the 6/4-6/8 window that have
row 0 = NORTH (latMax), not the contractually-required SOUTH (latMin).

## Frames

- usec_south_2026155.1657_chl_PACE-OCI.json (6/4)
- usec_south_2026158.1703_chl_PACE-OCI.json (6/7)
- usec_south_2026159.1737_chl_PACE-OCI.json (6/8)
- usec_south_2026156.1557_chl_S3B.json (6/5) - inverted + S cell CHL=5.11 (saturated)

## Root cause (preliminary)

PACE-OCI: the producer's `_regrid_subset` calls pyresample's
`resample_nearest` which returns north-up. The earlier version of
`_save_json` had an unconditional `flipud()` to reconcile this; commit
`262ce2f` removed the flip under the assumption that the dataset was
already south-up at the source. But the source IS north-up from
pyresample, so the resulting JSONs are now north-up. Compare with the
S3 producer which has an explicit `grid_south_up = np.flipud(grid)` at
the pyresample call site in `_regrid_swath` (line 619 of
s3_nrt_chl_pipeline.py).

S3B: 6/5 frame shows N/S ratio 0.19 (top half 0.16, bot half 0.81) and
the south cell at 5.11 mg/m3 (saturated). Likely a different upstream
producer bug or an orientation regression similar to the 6/4 S3 case.

## Disposition

DO NOT re-publish these frames until the producers are fixed and the
same data re-audited. See /home/gzheng/pipelines/cto_6p4_reapply/ for
the recovery plan.
