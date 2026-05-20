# OpenLayers Desktop Migration — SPEC

## Why
Plotly is a general-purpose charting library. It's fighting us on hover events (readout broken, fires but DOM doesn't update) and has never supported trackpad pinch-to-zoom. OpenLayers is built for georeferenced map rendering, handles touch/pinch natively, and is already proven working on mobile.

## Approach: Minimal Migration First
Replace the Plotly heatmap renderer on desktop with OpenLayers. Keep everything else (frame navigation, product selector, color scale, thermal overlay logic) in place. Add OL layer to the existing `#plot-div` container that already holds Plotly — we'll render OL underneath and keep the Plotly DOM for the color bar footer only.

**Critical constraint:** Do NOT change anything Mike didn't ask to change. The working behaviors (zoom, page load) must stay working. This is a surgical swap.

## Architecture

### Desktop OpenLayers State
```javascript
let desktopMapState = {
  map: null,           // OL Map instance
  imageLayer: null,    // ol.layer.Image for raster
  arrowLayer: null,    // ol.layer.Vector for UV currents
  landLayer: null,     // ol.layer.Image for land
  cursorLayer: null,   // ol.layer.Vector for cursor dot
  cursorFeature: null, // ol.Feature
  currentGridInfo: null,
  currentDataObj: null,
  ready: false
};
```

### Raster Rendering (reuse makeMobileRasterCanvas)
`makeMobileRasterCanvas(varKey, gridInfo, dataObj)` already produces a canvas. On desktop, we convert that to a data URL and use `ol.source.ImageStatic` — same pattern as mobile.

### Image Extent
```javascript
function frameExtentFromGrid(gridInfo) {
  const nx = gridInfo.xAxis.length;
  const ny = gridInfo.yAxis.length;
  return [
    gridInfo.xAxis[0],              // left (lonMin)
    gridInfo.yAxis[ny - 1],        // bottom (latMin from south-up data)
    gridInfo.xAxis[nx - 1],        // right (lonMax)
    gridInfo.yAxis[0]               // top (latMax)
  ];
}
```

### Readout
Uses existing `renderMobileReadout()` which already:
- Takes lon/lat as arguments (same signature for desktop and mobile)
- Shows lat/lon + value for valid pixels
- Shows just lat/lon (no 0, no value) when value is NaN
- Calls `setReadout()` which updates `#readout` div

**Hook:** `desktopMapState.map.on("pointermove", (ev) => { renderMobileReadout(ev.coordinate[0], ev.coordinate[1]); });`

### Zoom
OpenLayers handles smooth pinch-to-zoom and wheel zoom natively via `ol.interaction.defaults({ pin... })`. No custom wheel handler needed.

### Frame Navigation
Existing prev/next arrow handlers call `showFrame()`. After migration, `showFrame()` will call the OL render path instead of Plotly. The product selector and datetime display stay in the same DOM.

### Init Flow
1. On `showFrame()`, detect desktop (not IS_TOUCH)
2. Call `initDesktopMapIfNeeded()` if `desktopMapState.map` is null
3. `initDesktopMapIfNeeded()` creates OL Map targeting `#plot-div`
4. Build canvas via `makeMobileRasterCanvas(currentVar, gridInfo, dataObj)`
5. Set as `ol.source.ImageStatic` layer
6. OL `pointermove` → `renderMobileReadout`

### Cleanup
- Remove Plotly heatmap trace building (`buildChl`, `buildSst`, `buildBathy`)
- Remove `setupReadoutHandlersOnce` (Plotly hover handlers)
- Keep `setReadout` and `#readout` div
- Keep `renderMobileReadout` (shared readout logic)
- Keep `smoothWheelZoom` references (or remove if OL handles it)

## Migration Steps (in order)

1. **Add desktop OL state + init function** — create map, view, pointermove hook
2. **Add desktop raster render path** — reuse `makeMobileRasterCanvas`, push to OL ImageStatic
3. **Wire readout** — `pointermove` → `renderMobileReadout`, NaN handling shows lat/lon only
4. **Verify smooth zoom** — OL wheel/pinch native, remove custom smoothWheelZoom if OL handles it
5. **Test with CHL + SST** — verify readout, zoom, frame nav
6. **UV currents** — migrate `buildUV` arrow rendering to OL vector layer
7. **Push to GitHub** — verify on live site

## What NOT to Change (Mike's explicit requests)
- Color palette (keep as-is)
- CHL range: 0.02–20 mg/m³ (but this is data pipeline, not viewer change)
- Prev/next arrows (already work)
- Daytime labels (already work)
- Thermal fronts checkbox on product pages (already works on mobile, will work on desktop after migration)
- Gray transparent circle cursor (keep as-is)

## What NOT to Migrate Yet (separate work)
- thermal-fronts.html (separate Plotly page, not index.html)
- UV currents arrow rendering (P2, after base migration)
- Demo readiness features (TBD, placeholders only)