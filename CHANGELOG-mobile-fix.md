# 2026-08-09 — Mobile OL "Can't find variable url" + NaN-in-JSON fix (v2)

Branch: feature/fix-mobile-ol-url-undefined
HEAD: 94148c7c437

Bugs fixed:
1. mobileMapState.imageUrl = url; ReferenceError at renderMobileFrame:6913
   (dead code from b13739edcc2's canvas→ImageCanvas refactor)
2. NaN literals in v2 front JSON (Python allow_nan=True extension) — browsers'
   JSON.parse() rejected with "The string did not match the expected pattern"
   at index.html:8474 (await res.json() in thermal-fronts init)

Files: see sstfront_*.json under data/usec_*/sst_front/

This file is a no-op retrigger; it has no runtime impact.
