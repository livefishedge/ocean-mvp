# v5 Plan: One Map, One Basemap Contract

**Status:** Draft — pending Mike approval before v5.0 work starts.
**Triggered by:** v4.16.5 → v4.16.6 regression where the Captain's Dashboard
showed black land because the dashboard's `#combined-map .ol-viewport` had
`background:transparent` rules that defeated the global tan rule.
**Author:** CTO, 2026-06-16.

---

## TL;DR

Collapse the three map containers (`#plot`, `#mobile-map`, `#combined-map`)
into a single `#map` div. Express the basemap visual contract once. Eliminate
the entire class of "did I remember to set the bg on this page's wrapper?"
bugs.

## The Contract (Locked In)

The basemap is a two-color print-map look. Land and water are two layers
in a fixed z-order. The contract applies to every page, no exceptions.

| Layer | Visual | How it's painted | z |
|---|---|---|---|
| **Water (bottom)** | `#d0d0d0` light gray | OFM `water` layer, `fill-color` + `fill-opacity: 1.0` | `0` |
| **Data** (CHL, SST, UV, bathy, fronts) | per-product | per-product raster/vector layers | `10–35` |
| **Land (on top of viewport)** | `#d2b48c` tan | OL `.ol-viewport { background:#d2b48c }` CSS — visible wherever OFM has no fill | canvas bg |
| **Roads + labels (top)** | dark gray | OFM `line` + `symbol` layers (cull all `fill` + `fill-extrusion`) | `40` |

Notes:
- **"Land on top"** here means the land color is the *visual default* of
  every viewport — it dominates the visible area, with water and data
  painting on top of it. It is not a separate OL layer.
- **"Water at bottom"** means the OFM water layer is z=0, below every data
  layer. Water shows through wherever no data is present.
- The OL viewport CSS bg is the only reliable way to paint the landmass
  in a flat color, because the Mapbox `background` layer type does not
  render inside an OL VectorTileLayer (proven at v4.16.4 → v4.16.5).

## Why This Matters

### The v4.16.6 bug in one sentence
`applyOfmTwoLayerBasemap` is shared, but the dashboard had its own
`#combined-map .ol-viewport` rule with `background:transparent` and a
higher specificity than the v4.16.5 global tan rule, so the dashboard
land showed the dark page background.

### The deeper smell
The bug wasn't a missing code path. It was a CSS context per page, and
CSS contexts drift. Every future visual contract we add to the basemap
will have to be re-applied to every container or it will be silently
overridden on the page we forgot.

### What "one map div" buys us
- **One CSS rule** for the basemap. Source order and specificity stop
  mattering for the visual contract — there is only one place to set it.
- **One OL Map instance** option (recommended; see §Architecture below).
- **No more `body.combined-mode #combined-map .ol-viewport`-shaped bugs.**
- **Cheaper to reason about.** "Where is the basemap painted?" → "one
  place." Currently it's "one function + three CSS rules + a NOTE."

## Current State (the three-div design)

| Div | Mode | Layer set | Overlay UI | Notes |
|---|---|---|---|---|
| `#plot` | desktop single-product | one of CHL/SST/UV/bathy | toolbar above, zoom controls | canvas-rendered, not OL |
| `#mobile-map` | mobile single-product | one of CHL/SST/UV/bathy | hamburger menu, mobile readout | OL Map, touch handlers |
| `#combined-map` | desktop dashboard (combined mode) | CHL + SST + UV + bathy + fronts stacked | sidebar, captain briefing | OL Map, full-screen |

All three call the same `applyOfmTwoLayerBasemap(map, label)` function.
The visual divergence came from CSS overrides in each container's scope,
not from different basemap code.

## Target Architecture

### DOM
```html
<div id="map"></div>          <!-- the only map container -->
<div id="overlay-toolbar">…</div>   <!-- desktop single-product only -->
<div id="overlay-hamburger">…</div> <!-- mobile single-product only -->
<div id="overlay-sidebar">…</div>   <!-- dashboard only -->
```

Overlays are siblings of `#map`, absolutely positioned, swapped by
`currentVar` / `body` class. The map container has zero mode-specific
CSS.

### JS
```js
// One function, no label arg.
async function applyOfmTwoLayerBasemap(map) { … }

// One OL Map instance, reused across modes.
// Mode-specific behavior is layer-set config, not map instance.
function buildLayersForMode(mode) {
  if (mode === 'combined') return [chlComposite, sst, uv, bathy, fronts];
  return [productLayerFor(currentVar)];
}
```

When the user switches modes, we swap the layer set on the existing map
and toggle overlay visibility. The map instance is the same.

### CSS
```css
#map { position: absolute; inset: 0; }
#map .ol-viewport { background: #d2b48c; }   /* the entire basemap contract */
```

That's it. No `#plot .ol-viewport`, no `#mobile-map .ol-viewport`, no
`#combined-map .ol-viewport`. If a future change needs to update the
basemap, it updates this one rule and every page is correct.

## Migration Steps (ordered for safe rollout)

1. **Audit.** `grep -rn '#plot\|#mobile-map\|#combined-map' --include='*.html' --include='*.css' --include='*.js' .`
   to enumerate every reference. Group by file.
2. **Rename `#combined-map` → `#map`.** Simplest first cut. The Captain's
   Dashboard is the highest-value screen and the one that v4.16.6 just
   fixed. If the rename breaks nothing, the CSS context problem is gone
   for the dashboard.
3. **Collapse per-mode CSS into overlay CSS.** The `#captain-tools`,
   `#hamburger`, `#captain-briefing` rules become "visible only when
   `body` has the right class" overlays, not properties of the map
   container.
4. **Refactor `applyOfmTwoLayerBasemap(map, label)` → `applyOfmTwoLayerBasemap(map)`.**
   The `label` arg is used only for debug logging. Drop it.
5. **Unify OL Map instance.** Decide between:
   - **(a)** One map instance, swap layer set on mode change (cleanest,
     matches the v5 spirit).
   - **(b)** Three map instances, three divs, but no CSS overrides on
     the divs (intermediate — unlocks the CSS fix without the
     instance-unification risk).
   - Recommend (a) for v5.0, (b) as a v4.X.Y stepping stone if the
     instance unification reveals issues.
6. **Refactor gesture/handler binding.** Mobile touch handlers should
   bind based on `IS_TOUCH`, not based on which map div exists. With
   one map instance this becomes natural.
7. **Remove the v4.16.6 NOTE comment.** It will no longer be needed —
   the contract is structurally enforced, not just CSS-locked.
8. **Verify on all three modes** (desktop single, mobile single, dashboard)
   with the same headless-Chromium checks used for v4.16.6.

## Out of Scope for v5

- The internal basemap math (water recolor, road/label culling). Locked at
  v4.16.6 and should not change.
- New data products. The Captain's Dashboard already supports the full
  layer stack.
- New overlay UIs. New overlays should be built against the new sibling
  model from day one.

## Risks

1. **Combined mode + single-product sharing one map instance.**
   The combined map is built once and never torn down inside a session.
   Single-product maps are torn down on var switch. Unifying means
   designing a clean "reset to known empty state, then add layer set X"
   path. This is the largest single risk in v5.
2. **Mobile gesture handlers bound to specific map instance.**
   `mobileMapState` is referenced from many places. A unification
   requires deciding what `mobileMapState` becomes (a flag? a wrapper?
   a single `mapState` with mode config?).
3. **Hamburger menu + readout HTML currently inside `#mobile-map`.**
   Pulling them out as siblings changes their `position: fixed` anchors
   and z-index contracts. Must verify on iOS Safari and Android Chrome
   before declaring done.
4. **Third-party map state in `window._combinedMap`, `window._combinedChlLayer`, etc.**
   There's a lot of `window._combinedX` state for the dashboard layer
   stack. Unification means either generalizing it to `window._layerX`
   or moving it off `window` entirely.

## Success Criteria (definition of done for v5.0)

- `grep -rn '#plot\|#mobile-map\|#combined-map' --include='*.html' --include='*.css' --include='*.js' .`
  returns **0** hits (other than the historical git log).
- The basemap visual contract is exactly one CSS rule.
- All three modes render identically: tan land + light gray ocean + dark
  road network + dark labels + per-mode data overlays.
- The v4.16.6 NOTE comment is removed.
- Headless-Chromium computed-style check passes for all three modes.
- Visual regression: the Captain's Dashboard, mobile CHL, and desktop CHL
  are pixel-equivalent to v4.16.6 except where data overlay differs.

## Estimated Effort

- Step 1 (audit): 30 min.
- Step 2–3 (rename + CSS collapse): 2–4 hours, low risk, can ship as a
  v4.17 hotfix if Mike wants the CSS fix without the JS unification.
- Step 4 (drop `label` arg): 30 min.
- Step 5a (unify OL instances): 1–2 days, medium-high risk, real testing.
- Step 6 (gesture refactor): 0.5 day, can be deferred to v5.1.
- Step 7–8 (cleanup + verify): 1 hour.

**Total:** 2–3 days for v5.0 if Step 5a and Step 6 are done together.
1 day for the "v4.17 CSS-only hotfix" path that does Steps 1–4 + 7–8.

## Recommendation

Ship a **v4.17 CSS-only hotfix first** (Steps 1–4 + 7–8) so the v4.16.6
lock-down is structurally protected against future regression, then
schedule **v5.0** for the full OL instance unification as a deliberate
architecture release. This matches the rule "don't bundle a
consolidation into v4.17" and keeps each release small and reversible.
