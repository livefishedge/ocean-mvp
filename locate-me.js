/* ============================================================================
 * FishEdge Dashboard — "My Boat" locate-me button.
 *
 * Pure client-side GPS location overlay. Renders an OL Vector layer (point +
 * accuracy circle) on whichever map is currently active. Works on every data
 * layer (SST, CHL, UV, bathy, thermal fronts) — independent of layer choice.
 *
 * Privacy contract (MUST NOT regress):
 *   - Zero network calls. No Supabase, no analytics, no logs.
 *   - Session-only by default. No localStorage / no sessionStorage.
 *   - Persistence is opt-in via a user-facing toggle (off by default).
 *   - No auto-follow by default (battery). Toggle present but off by default.
 *   - Available to everyone (no tier gate).
 *
 * Behavior:
 *   - First click: browser prompts for geolocation permission. Then centers
 *     the active map on the result and renders point + accuracy circle.
 *   - Subsequent clicks: re-acquire single-shot, recenter.
 *   - Auto-follow toggle (off by default): watchPosition() continuously.
 *   - Persistence toggle (off by default): stores last position in
 *     localStorage; reload re-shows without re-prompting.
 *   - "Clear position" button removes the marker.
 *   - Permission denied: status text explains. No fallback pin (out of scope
 *     for this release; can be added later if captains ask).
 *
 * Requires: HTTPS (or localhost). Production is HTTPS, so this is fine.
 * Requires: window.ol (OpenLayers) is loaded before this script. The
 *   dashboard loads ol@10.4.0 in <head> so this is satisfied.
 * ========================================================================== */
'use strict';

(function () {
  // ----- Constants -----
  const STORAGE_KEY = 'fishedge_locate_last_position';
  const STORAGE_ENABLED_KEY = 'fishedge_locate_persist_enabled';
  const STORAGE_AUTOFOLLOW_KEY = 'fishedge_locate_autofollow_enabled';

  const COLORS = {
    point: '#19a7ff',
    pointBorder: '#071017',
    accuracyFill: 'rgba(25, 167, 255, 0.15)',
    accuracyStroke: 'rgba(25, 167, 255, 0.4)',
  };

  const BUTTON_LABEL = 'Locate me';
  const BUTTON_ARIA = 'Locate me';

  // ----- Internal state -----
  const STATE = {
    permission: 'unknown',   // 'unknown' | 'granted' | 'denied' | 'unsupported' | 'error'
    lastPosition: null,      // {coords:{latitude,longitude,accuracy}, timestamp, shown}
    autoFollow: false,
    watchId: null,
    persistEnabled: false,
    mapsAtBoot: [],          // detected at boot; re-detected on demand
  };

  // =========================================================================
  // PURE HELPERS (no DOM, no navigator) — testable in isolation
  // =========================================================================

  function supportsGeolocation(nav) {
    if (!nav || typeof nav !== 'object') return false;
    if (!nav.geolocation || typeof nav.geolocation !== 'object') return false;
    return typeof nav.geolocation.getCurrentPosition === 'function';
  }

  function isHttps(loc) {
    if (!loc || typeof loc !== 'object') return false;
    const protocol = loc.protocol || '';
    const hostname = loc.hostname || '';
    if (protocol === 'https:') return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true;
    return false;
  }

  function classifyError(err) {
    if (!err || typeof err !== 'object') return 'unknown';
    switch (err.code) {
      case 1: return 'denied';       // PERMISSION_DENIED
      case 2: return 'unavailable';  // POSITION_UNAVAILABLE
      case 3: return 'timeout';      // TIMEOUT
      default: return 'unknown';
    }
  }

  function formatStatus(position) {
    if (!position || !position.coords) return 'No position yet';
    const c = position.coords;
    const lat = Number(c.latitude).toFixed(4);
    const lon = Number(c.longitude).toFixed(4);
    const acc = Math.round(Number(c.accuracy || 0));
    return lat + ', ' + lon + ' (\u00B1' + acc + 'm)';
  }

  function makeStoredPosition(lat, lon, accuracyM, timestamp) {
    return {
      lat: Number(lat),
      lon: Number(lon),
      accuracyM: Number(accuracyM),
      timestamp: Number(timestamp) || Date.now(),
    };
  }

  function loadStoredPosition(storage, enabledKey, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      if (storage.getItem(enabledKey) !== '1') return null;
      const raw = storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed) return null;
      if (typeof parsed.lat !== 'number' || typeof parsed.lon !== 'number') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function storePosition(storage, enabledKey, key, lat, lon, accuracyM, timestamp) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try {
      if (storage.getItem(enabledKey) !== '1') return; // persistence is off
      storage.setItem(key, JSON.stringify({
        lat: Number(lat),
        lon: Number(lon),
        accuracyM: Number(accuracyM),
        timestamp: Number(timestamp) || Date.now(),
      }));
    } catch (_) { /* no-op */ }
  }

  function clearStoredPosition(storage, key) {
    if (!storage || typeof storage.removeItem !== 'function') return;
    try { storage.removeItem(key); } catch (_) { /* no-op */ }
  }

  // =========================================================================
  // OL FEATURE BUILDER (uses window.ol)
  // =========================================================================

  function buildPositionFeatures(ol, lat, lon, accuracyM) {
    if (!ol || !ol.proj || !ol.Feature || !ol.geom) {
      throw new Error('[fishedge-locate] window.ol not available');
    }
    const center = ol.proj.fromLonLat([Number(lon), Number(lat)]);
    const point = new ol.Feature(new ol.geom.Point(center));
    point.set('kind', 'boat-position-point');
    const radius = Math.max(Number(accuracyM) || 0, 1); // ol.geom.Circle requires > 0
    const circle = new ol.Feature(new ol.geom.Circle(center, radius));
    circle.set('kind', 'boat-position-accuracy');
    return { point: point, circle: circle, center: center };
  }

  function buildPositionStyle(ol) {
    if (!ol || !ol.style) {
      throw new Error('[fishedge-locate] window.ol not available');
    }
    return [
      new ol.style.Style({
        filter: function (f) { return f.get('kind') === 'boat-position-accuracy'; },
        fill: new ol.style.Fill({ color: COLORS.accuracyFill }),
        stroke: new ol.style.Stroke({ color: COLORS.accuracyStroke, width: 1 }),
      }),
      new ol.style.Style({
        filter: function (f) { return f.get('kind') === 'boat-position-point'; },
        image: new ol.style.Circle({
          radius: 7,
          fill: new ol.style.Fill({ color: COLORS.point }),
          stroke: new ol.style.Stroke({ color: COLORS.pointBorder, width: 2 }),
        }),
      }),
    ];
  }

  // =========================================================================
  // MAP INTEGRATION
  // =========================================================================

  function detectActiveMaps() {
    const maps = [];
    if (typeof window === 'undefined') return maps;
    // 1) Instrumented registry (preferred — set up by the inline shim before locate-me.js loads)
    if (Array.isArray(window.__fishedgeMaps)) {
      window.__fishedgeMaps.forEach(function (m) { if (m) maps.push(m); });
    }
    // 2) window globals (fallback — in case the dashboard exposes them someday)
    if (window.desktopMapState && window.desktopMapState.map && maps.indexOf(window.desktopMapState.map) < 0) {
      maps.push(window.desktopMapState.map);
    }
    if (window.mobileMapState && window.mobileMapState.map && maps.indexOf(window.mobileMapState.map) < 0) {
      maps.push(window.mobileMapState.map);
    }
    return maps;
  }

  function ensureLayerOnMap(ol, map) {
    if (!ol || !ol.layer || !ol.source) {
      throw new Error('[fishedge-locate] window.ol not available');
    }
    let found = null;
    map.getLayers().forEach(function (l) {
      if (l && l.get && l.get('fishedge-locate') === true) found = l;
    });
    if (found) return found;
    const layer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      style: buildPositionStyle(ol),
    });
    layer.set('fishedge-locate', true);
    map.addLayer(layer);
    return layer;
  }

  function showPosition(ol, position, opts) {
    opts = opts || {};
    const maps = (opts.maps && opts.maps.length) ? opts.maps : detectActiveMaps();
    if (maps.length === 0) {
      return { shown: 0, maps: 0, centeredFirst: false };
    }
    const feats = buildPositionFeatures(
      ol,
      position.coords.latitude,
      position.coords.longitude,
      position.coords.accuracy
    );
    let centeredFirst = false;
    for (let i = 0; i < maps.length; i++) {
      const map = maps[i];
      const layer = ensureLayerOnMap(ol, map);
      const src = layer.getSource();
      src.clear();
      src.addFeatures([feats.point, feats.circle]);
      // Always recenter when the user clicks "Locate me". animate() with
      // setCenter fallback if the animation throws.
      if (map.getView && typeof map.getView === 'function') {
        const view = map.getView();
        if (view) {
          const z = (typeof view.getZoom === 'function') ? (view.getZoom() || 0) : 0;
          if (typeof view.animate === 'function') {
            try {
              view.animate({ center: feats.center, zoom: Math.max(z, 9), duration: 600 });
              centeredFirst = true;
            } catch (animErr) {
              if (typeof view.setCenter === 'function') view.setCenter(feats.center);
              if (typeof view.setZoom === 'function' && z < 9) view.setZoom(9);
              centeredFirst = true;
            }
          } else if (typeof view.setCenter === 'function') {
            view.setCenter(feats.center);
            if (typeof view.setZoom === 'function' && z < 9) view.setZoom(9);
            centeredFirst = true;
          }
        }
      }
    }
    if (typeof console !== 'undefined' && console.info) {
      console.info('[fishedge-locate] showPosition: ' + maps.length + ' map(s), recentered=' + centeredFirst);
    }
    return { shown: maps.length, maps: maps.length, centeredFirst: centeredFirst };
  }

  function clearPositionOnMaps(maps) {
    const list = maps || detectActiveMaps();
    for (let i = 0; i < list.length; i++) {
      const map = list[i];
      map.getLayers().forEach(function (l) {
        if (l && l.get && l.get('fishedge-locate') === true) {
          const src = l.getSource && l.getSource();
          if (src && typeof src.clear === 'function') src.clear();
        }
      });
    }
  }

  // =========================================================================
  // GEOLOCATION API WRAPPERS
  // =========================================================================

  function getCurrentPosition(nav) {
    return new Promise(function (resolve, reject) {
      if (!supportsGeolocation(nav || (typeof navigator !== 'undefined' ? navigator : null))) {
        reject({ code: 'unsupported', message: 'Geolocation API not available' });
        return;
      }
      nav.geolocation.getCurrentPosition(
        function (pos) { resolve(pos); },
        function (err) { reject({ code: classifyError(err), message: err && err.message }); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  function startWatch(nav, onSuccess, onError) {
    if (!supportsGeolocation(nav || (typeof navigator !== 'undefined' ? navigator : null))) return null;
    return nav.geolocation.watchPosition(
      onSuccess,
      onError,
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 }
    );
  }

  function stopWatch(nav, watchId) {
    if (watchId == null) return;
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    if (n && n.geolocation && typeof n.geolocation.clearWatch === 'function') {
      n.geolocation.clearWatch(watchId);
    }
  }

  // =========================================================================
  // UI — toolbar button + popover
  // =========================================================================

  function buildToolbarButton(doc, hooks) {
    hooks = hooks || {};
    const toolbar = doc.querySelector ? doc.querySelector('#toolbar') : null;
    if (!toolbar) return null;

    const wrap = doc.createElement('div');
    wrap.id = 'fishedge-locate-wrap';
    wrap.style.cssText = 'position:relative; display:inline-flex; align-items:center;';

    const btn = doc.createElement('button');
    btn.id = 'fishedge-locate-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', BUTTON_ARIA);
    btn.setAttribute('title', 'Show my GPS position on the map');
    btn.textContent = BUTTON_LABEL;
    btn.addEventListener('click', hooks.onLocateClick || function () {});
    wrap.appendChild(btn);

    const popover = doc.createElement('div');
    popover.id = 'fishedge-locate-popover';
    popover.style.cssText = 'display:none; position:absolute; top:36px; right:0; min-width:220px; background:rgba(5,11,16,0.95); border:1px solid #1b2836; border-radius:8px; padding:10px 12px; z-index:1100; font-size:12px; color:#e0e6ee; box-shadow:0 6px 20px rgba(0,0,0,0.4);';

    const autofollowId = 'fishedge-locate-autofollow';
    const persistId = 'fishedge-locate-persist';
    const statusId = 'fishedge-locate-status';
    const clearId = 'fishedge-locate-clear';

    popover.innerHTML =
      '<label style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:4px 0;">' +
        '<input type="checkbox" id="' + autofollowId + '"> Auto-follow (continuous GPS)' +
      '</label>' +
      '<label style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:4px 0;">' +
        '<input type="checkbox" id="' + persistId + '"> Remember position across reloads' +
      '</label>' +
      '<div style="border-top:1px solid #1b2836; margin-top:8px; padding-top:8px; color:#9fb0c3; font-size:11px;">' +
        '<div id="' + statusId + '">No position yet</div>' +
        '<button id="' + clearId + '" type="button" style="margin-top:6px; background:transparent; border:1px solid #1b2836; border-radius:4px; color:#e0e6ee; padding:3px 8px; font-size:11px; cursor:pointer;">Clear position</button>' +
      '</div>';

    wrap.appendChild(popover);
    toolbar.appendChild(wrap);

    // Right-click (or long-press on touch) opens the popover. Click closes it
    // when clicking outside the wrap.
    btn.addEventListener('contextmenu', function (e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      popover.style.display = (popover.style.display === 'none') ? 'block' : 'none';
    });
    doc.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) popover.style.display = 'none';
    });

    // Wire up toggles + clear button via the hooks the caller provides.
    if (typeof hooks.onAutoFollowChange === 'function') {
      const el = popover.querySelector('#' + autofollowId);
      if (el) el.addEventListener('change', function (ev) { hooks.onAutoFollowChange(!!ev.target.checked); });
    }
    if (typeof hooks.onPersistChange === 'function') {
      const el = popover.querySelector('#' + persistId);
      if (el) el.addEventListener('change', function (ev) { hooks.onPersistChange(!!ev.target.checked); });
    }
    if (typeof hooks.onClear === 'function') {
      const el = popover.querySelector('#' + clearId);
      if (el) el.addEventListener('click', hooks.onClear);
    }

    // Add a visible status indicator next to the button so the captain can see
  // what is happening without having to open the popover.
  const statusSpan = doc.createElement('span');
  statusSpan.id = 'fishedge-locate-button-status';
  statusSpan.style.cssText = 'font-size:11px; color:#9fb0c3; padding:0 8px; max-width:240px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600;';
  statusSpan.textContent = '';
  wrap.appendChild(statusSpan);

  console.info('[fishedge-locate] button mounted into #toolbar');
  return {
    wrap: wrap,
    button: btn,
    popover: popover,
    setStatus: function (text) {
      const el = popover.querySelector('#' + statusId);
      if (el) el.textContent = text;
      if (statusSpan) statusSpan.textContent = text;
    },
    setAutoFollowChecked: function (v) {
      const el = popover.querySelector('#' + autofollowId);
      if (el) el.checked = !!v;
    },
    setPersistChecked: function (v) {
      const el = popover.querySelector('#' + persistId);
      if (el) el.checked = !!v;
    },
  };
  }

  // =========================================================================
  // BOOT
  // =========================================================================

  // Idempotency guard: boot() is called from multiple paths (DOMContentLoaded,
  // setTimeout retry, rAF retry, MutationObserver). Make it safe to call repeatedly
  // by short-circuiting if the button is already in the DOM.
  function boot(env) {
    env = env || {};
    const doc = env.document || (typeof document !== 'undefined' ? document : null);
    if (doc && doc.getElementById('fishedge-locate-wrap')) {
      // Already mounted — don't re-create.
      return doc.getElementById('fishedge-locate-wrap');
    }
    const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const ol = env.ol || (typeof window !== 'undefined' ? window.ol : null);
    const loc = env.location || (typeof location !== 'undefined' ? location : null);
    const storage = env.storage || (function () {
      try { return (typeof localStorage !== 'undefined') ? localStorage : null; }
      catch (_) { return null; }
    })();
    const setTimeoutFn = env.setTimeout || setTimeout;

    if (!doc) return;

    // Read persisted toggles BEFORE building UI so the checkboxes reflect them.
    let persistEnabled = false;
    let autoFollowEnabled = false;
    if (storage && typeof storage.getItem === 'function') {
      try {
        persistEnabled = storage.getItem(STORAGE_ENABLED_KEY) === '1';
        autoFollowEnabled = storage.getItem(STORAGE_AUTOFOLLOW_KEY) === '1';
      } catch (_) { /* no-op */ }
    }
    STATE.persistEnabled = persistEnabled;
    STATE.autoFollow = autoFollowEnabled;

    const ui = buildToolbarButton(doc, {
      onLocateClick: function () {
        handleLocateClick({ navigator: nav, location: loc, storage: storage, ol: ol, ui: ui });
      },
    });
    // Add a second mount inside the captain tools palette (upper-left, only
    // visible in combined-mode via CSS) so the button reaches the captain's
    // dashboard next to the existing captain-tool icons.
    
  // Locate-me button: 48x48 SVG icon, always visible at upper-left.
  // Mounts into a fixed-position host (#fishedge-locate-host) so it's visible
  // in ALL dashboard modes (regular + combined/captain), not gated by
  // #captain-tools' display:none. Compass-needle SVG icon — clearly
  // different from the waypoint crosshair.
  function buildLocateButton(doc, hooks) {
    hooks = hooks || {};
    if (!doc || !doc.body) return null;

    // Idempotent: if the button is already mounted, return early.
    if (doc.getElementById('captain-locate-btn')) {
      return { button: doc.getElementById('captain-locate-btn'), host: doc.getElementById('captain-tools') };
    }

    // Bug fix 2026-08-02: mount into the always-visible #fishedge-locate-host
    // (position:fixed; top:8px; right:8px; z-index:1100) instead of
    // #captain-tools, which has CSS display:none outside body.combined-mode.
    // The icon was present in the DOM but invisible in normal dashboard mode.
    // The pre-existing #fishedge-locate-host div is already in index.html
    // (line 975) and is always rendered.
    let host = doc.getElementById('fishedge-locate-host');
    if (!host) {
      // Fallback: if the host div is missing (rare), create it.
      host = doc.createElement('div');
      host.id = 'fishedge-locate-host';
      host.style.cssText = 'position:fixed; top:8px; right:8px; z-index:1100; display:flex; flex-direction:row; gap:8px;';
      doc.body.appendChild(host);
    }

    const btn = doc.createElement('button');
    btn.id = 'captain-locate-btn';
    btn.type = 'button';
    btn.className = 'captain-tool-btn';
    btn.title = 'Locate me';
    btn.setAttribute('aria-label', 'Locate me');
    btn.setAttribute('data-tool', 'locate');
    // Compass needle: outer circle + north/south diamond halves + center dot.
    // Distinctive from the waypoint crosshair (concentric circles + cross arms).
    btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">'
      + '<circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/>'
      + '<path d="M11 3 L13.5 11 L11 9.5 L8.5 11 Z" fill="currentColor"/>'
      + '<path d="M11 19 L13.5 11 L11 12.5 L8.5 11 Z" fill="currentColor" opacity="0.35"/>'
      + '<circle cx="11" cy="11" r="1.2" fill="currentColor"/>'
      + '</svg>';
    btn.addEventListener('click', hooks.onLocateClick || function () {});
    host.appendChild(btn);

    console.info('[fishedge-locate] button mounted at #fishedge-locate-host');
    return { button: btn, host: host };
  }

const captainUi = buildLocateButton(doc, {
      onLocateClick: function () {
        handleLocateClick({ navigator: nav, location: loc, storage: storage, ol: ol, ui: ui });
      },
      onAutoFollowChange: function (checked) {
        STATE.autoFollow = checked;
        if (storage) {
          try { storage.setItem(STORAGE_AUTOFOLLOW_KEY, checked ? '1' : '0'); } catch (_) {}
        }
        if (checked) {
          if (STATE.lastPosition) showPosition(ol, STATE.lastPosition);
          STATE.watchId = startWatch(nav,
            function (pos) { showPosition(ol, pos); if (ui) ui.setStatus(formatStatus(pos)); },
            function (err) { if (ui) ui.setStatus('Watch error: ' + classifyError(err)); }
          );
        } else {
          stopWatch(nav, STATE.watchId);
          STATE.watchId = null;
        }
      },
      onPersistChange: function (checked) {
        STATE.persistEnabled = checked;
        if (storage) {
          try { storage.setItem(STORAGE_ENABLED_KEY, checked ? '1' : '0'); } catch (_) {}
          if (!checked) clearStoredPosition(storage, STORAGE_KEY);
        }
        if (checked && STATE.lastPosition) {
          const c = STATE.lastPosition.coords;
          storePosition(storage, STORAGE_ENABLED_KEY, STORAGE_KEY, c.latitude, c.longitude, c.accuracy, STATE.lastPosition.timestamp);
        }
      },
      onClear: function () {
        clearPositionOnMaps();
        STATE.lastPosition = null;
        if (storage) clearStoredPosition(storage, STORAGE_KEY);
        if (ui) ui.setStatus('Position cleared');
      },
    });

    if (ui) {
      ui.setAutoFollowChecked(STATE.autoFollow);
      ui.setPersistChecked(STATE.persistEnabled);
      if (!supportsGeolocation(nav)) {
        ui.setStatus('Geolocation not supported in this browser');
      } else if (!isHttps(loc)) {
        ui.setStatus('Geolocation requires HTTPS');
      }
    }

    // If persistence is on AND a stored position exists, show it on the map
    // without re-prompting. Wait a beat so the maps have time to initialize.
    setTimeoutFn(function () {
      if (!ol) return;
      const stored = loadStoredPosition(storage, STORAGE_ENABLED_KEY, STORAGE_KEY);
      if (stored) {
        const synthetic = {
          coords: {
            latitude: stored.lat,
            longitude: stored.lon,
            accuracy: stored.accuracyM,
          },
          timestamp: stored.timestamp,
        };
        showPosition(ol, synthetic);
        STATE.lastPosition = synthetic;
        if (ui) ui.setStatus('Last position: ' + formatStatus(synthetic));
      }
      // If auto-follow was previously enabled, restart the watch.
      if (STATE.autoFollow && supportsGeolocation(nav) && isHttps(loc)) {
        STATE.watchId = startWatch(nav,
          function (pos) { showPosition(ol, pos); if (ui) ui.setStatus(formatStatus(pos)); },
          function (err) { if (ui) ui.setStatus('Watch error: ' + classifyError(err)); }
        );
      }
    }, 1500);
  }

  async function handleLocateClick(env) {
    env = env || {};
    const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const loc = env.location || (typeof location !== 'undefined' ? location : null);
    const ol = env.ol || (typeof window !== 'undefined' ? window.ol : null);
    const storage = env.storage || (function () {
      try { return (typeof localStorage !== 'undefined') ? localStorage : null; }
      catch (_) { return null; }
    })();
    const ui = env.ui || null;

    if (!supportsGeolocation(nav)) {
      if (ui) ui.setStatus('Geolocation not supported in this browser');
      return;
    }
    if (!isHttps(loc)) {
      if (ui) ui.setStatus('Geolocation requires HTTPS');
      return;
    }
    if (ui) ui.setStatus('Requesting location\u2026');

    try {
      const position = await getCurrentPosition(nav);
      const result = showPosition(ol, position);
      STATE.lastPosition = position;
      if (ui) {
        if (result.maps === 0) {
          ui.setStatus('Got position, but no map detected — try refreshing');
        } else {
          ui.setStatus(formatStatus(position));
        }
      }
      if (STATE.persistEnabled) {
        const c = position.coords;
        storePosition(storage, STORAGE_ENABLED_KEY, STORAGE_KEY, c.latitude, c.longitude, c.accuracy, position.timestamp);
      }
      STATE.permission = 'granted';
    } catch (err) {
      STATE.permission = err && err.code ? err.code : 'error';
      const code = err && err.code;
      let msg = 'Could not get location';
      if (code === 'denied') msg = 'Permission denied. Enable location in browser settings to use this.';
      else if (code === 'unavailable') msg = 'Location unavailable. Try again outdoors or near a window.';
      else if (code === 'timeout') msg = 'Location request timed out. Try again.';
      else if (code === 'unsupported') msg = 'Geolocation not supported in this browser.';
      if (ui) ui.setStatus(msg);
    }
  }

  // =========================================================================
  // EXPORTS — exposed on window.FISHEDGE_LOCATE for tests + external control
  // =========================================================================

  const api = {
    getState: function () { return Object.assign({}, STATE); },
    showPosition: function (position, opts) { return showPosition(api.__ol || (typeof window !== 'undefined' ? window.ol : null), position, opts); },
    clearPosition: clearPositionOnMaps,
    getCurrentPosition: function () { return getCurrentPosition(typeof navigator !== 'undefined' ? navigator : null); },
    supportsGeolocation: function () { return supportsGeolocation(typeof navigator !== 'undefined' ? navigator : null); },
    isHttps: function () { return isHttps(typeof location !== 'undefined' ? location : null); },
    classifyError: classifyError,
    buildPositionFeatures: function (lat, lon, accuracyM) {
      return buildPositionFeatures(api.__ol || (typeof window !== 'undefined' ? window.ol : null), lat, lon, accuracyM);
    },
    buildLocateButton: function (doc, hooks) {
      return buildLocateButton(doc || (typeof document !== 'undefined' ? document : null), hooks || {});
    },
    loadStoredPosition: function () { return loadStoredPosition(typeof localStorage !== 'undefined' ? localStorage : null, STORAGE_ENABLED_KEY, STORAGE_KEY); },
    clearStoredPosition: function () { return clearStoredPosition(typeof localStorage !== 'undefined' ? localStorage : null, STORAGE_KEY); },
    formatStatus: formatStatus,
    boot: boot,
    handleLocateClick: handleLocateClick,
    // Constants exposed for tests
    STORAGE_KEY: STORAGE_KEY,
    STORAGE_ENABLED_KEY: STORAGE_ENABLED_KEY,
    STORAGE_AUTOFOLLOW_KEY: STORAGE_AUTOFOLLOW_KEY,
  };

  if (typeof window !== 'undefined') {
    window.FISHEDGE_LOCATE = api;
    // Re-bind internal functions to the public API so callers can inject ol via api.__ol.
    api.showPosition = function (position, opts) { return showPosition(api.__ol || window.ol, position, opts); };
    api.buildPositionFeatures = function (lat, lon, accuracyM) {
      return buildPositionFeatures(api.__ol || window.ol, lat, lon, accuracyM);
    };
    api.__boot = boot;
    api.__handleLocateClick = handleLocateClick;
  }

  // Auto-boot once the DOM is ready. Deferred via setTimeout(0) so we run
  // AFTER any DOMContentLoaded handlers registered by the dashboard's main
  // script (which loads later in <body>). Falls back to <body> if #toolbar
  // is missing. Uses a MutationObserver to re-attach the button if some
  // other script removes it from the DOM.
  let mountObserver = null;
  let mountedWrap = null;

  function tryMount() {
    try {
      const doc = (typeof document !== 'undefined') ? document : null;
      if (!doc) return false;
      boot();
      mountedWrap = doc.getElementById('fishedge-locate-wrap');
      if (mountedWrap && mountObserver) {
        mountObserver.observe(mountedWrap.parentNode || doc.body, {
          childList: true,
          subtree: false,
        });
      }
      // Visible mount indicator for QA / DevTools
      if (typeof console !== 'undefined' && console.info) {
        console.info('[fishedge-locate] mounted; button:', mountedWrap ? 'YES' : 'NO');
      }
      return !!mountedWrap;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[fishedge-locate] mount failed:', e && e.message);
      }
      return false;
    }
  }

  function onDomReady() {
    // First attempt immediately (DOMContentLoaded fired).
    if (tryMount()) return;
    // Retry once after a tick in case the dashboard's own DOMContentLoaded
    // handler hasn't finished wiring up the toolbar yet.
    setTimeout(function () {
      if (tryMount()) return;
      // Final retry with rAF — last chance before the page becomes interactive.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { tryMount(); });
      }
    }, 0);
  }

  // Watch for the button being removed (defensive — dashboard might re-render).
  if (typeof MutationObserver === 'function') {
    mountObserver = new MutationObserver(function (mutations) {
      if (!mountedWrap) return;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        for (let j = 0; j < m.removedNodes.length; j++) {
          if (m.removedNodes[j] === mountedWrap) {
            // Re-mount. Skip if boot isn't ready.
            try { boot(); mountedWrap = document.getElementById('fishedge-locate-wrap'); } catch (_) {}
            return;
          }
        }
      }
    });
  }

  if (typeof document !== 'undefined') {
    console.info('[fishedge-locate] script loaded; readyState=' + document.readyState);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onDomReady);
    } else {
      onDomReady();
    }
  }
})();