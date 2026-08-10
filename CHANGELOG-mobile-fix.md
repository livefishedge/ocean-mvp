# 2026-08-09 — Mobile OL "Can't find variable: url" fix

Branch: feature/fix-mobile-ol-url-undefined
Commit: ce8a4539344

Removes the dead `mobileMapState.imageUrl = url;` left over from b13739edcc2
(Aug 6: route all raster layers through ImageCanvas). That refactor removed
the canvas.toBlob() path that defined `url` but left the trailing assignment
behind. iOS Safari throws ReferenceError on every non-Captain var layer.

This file exists only to retrigger the git_push webhook; it has no runtime
impact on the dashboard.
