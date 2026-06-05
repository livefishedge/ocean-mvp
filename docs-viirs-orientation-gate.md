# Producer-Side Coastal/Offshore Orientation QA Gate

**Added**: 2026-06-05 after Mike flagged 3 inverted VIIRS CHL frames for 2026-06-04 (coastal=low, open-ocean=high — physically backwards).

**Where**: `~/pipelines/nasa_pipeline/nrt_chl_full_pipeline.py` — function `_check_coastal_offshore_gradient` and the call site inside `save_composite_visuals` (right after the lat_1d N/S flip, before any JSON/NC write). Rejected frames also have their just-written NC deleted via `out_path.unlink(missing_ok=True)`.

**What it catches**:
1. **Inverted coastal/offshore gradient** — coastal/inshore CHL is 0.06–0.09× offshore in healthy USEC data. If offshore/coastal > 2.0×, the field is rejected.
2. **Mid-band spike** — a single vertical strip of hot CHL between two cooler edges (e.g. 2026-06-04 1748 VJ1 with mid=5.07 vs edges=0.3). If mid > 3× both edges, the field is rejected.

**Why producer-side not viewer-side**:
- The bad NCs were getting re-downloaded from NASA on every orchestrator run.
- A viewer-side filter would be silently re-overwritten on each publish.
- Producer-side rejection drops the bad NCs and prevents downstream contamination of the by_model/ cross_sensor/ and multi-day fallback paths.

**Threshold rationale**:
- Healthy day 154 (2026-06-03) VIIRS ratios: 0.06, 0.09, 0.07 (VNP, VJ1, VJ2).
- Bad day 155 (2026-06-04) VIIRS ratios: 12.2, 0.82, 1.86 (VNP, VJ1, VJ2).
- Threshold 2.0× catches the clear VNP inversion. Mid-spike check catches the VJ1 strip artifact.

**False-positive risk**:
- A legitimate upwelling front could plausibly reverse the gradient. If the gate fires on real data, the producer logs a WARNING and drops the frame — recoverable by retraining the model or relaxing `COASTAL_OFFSHORE_RATIO_MAX`.
- If Mike wants me to relax, change `COASTAL_OFFSHORE_RATIO_MAX` from 2.0 to e.g. 3.0 (allows 1.86 borderline VJ2 from 6/4 to slip through).
