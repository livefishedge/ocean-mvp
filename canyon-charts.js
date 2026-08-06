// canyon-charts.js — FishEdge dashboard overlay
// Adds GEBCO-IOC submarine canyon labels to the existing OpenLayers maps.
// Toggle: button in the captain-tools toolbar (#captain-tools).
// Data: IHO-IOC GEBCO Gazetteer of Undersea Feature Names (ArcGIS REST).
// Source URL: https://www.gebco.net/data-products/undersea-feature-names
// Attribution: IHO-IOC GEBCO Gazetteer of Undersea Feature Names (www.gebco.net)
//
// Dev-only build feature/canyon-charts — pushes to Cloudflare Pages preview URL,
// never to main. See js-only-deploy-checklist skill for cache-buster rules.

(function () {
  'use strict';

  var SOURCE_LABEL = 'GEBCO-IOC';
  var ARCGIS_URL =
    'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/' +
    'Undersea_Features/FeatureServer/0/query';
  var ATTRIBUTION =
    'Submarine canyons: IHO-IOC GEBCO Gazetteer of Undersea Feature Names (www.gebco.net)';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
  var CACHE_MAX = 32;
  var MAX_FEATURES = 500;
  var FETCH_TIMEOUT_MS = 12000;
  var BBOX_PAD = 0.05; // 5% padding around map view
  var MAX_WORLD_BBOX_AREA = 120.0; // guard against fetching the whole ocean

  var state = {
    enabled: false,
    layers: new Map(), // map -> ol.layer.Vector
    source: null,
    cache: new Map(), // bboxKey -> { features, fetchedAt }
    inflight: new Map(), // bboxKey -> Promise
    listeners: new Map(), // map -> Array<fn>
  };

  function log() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[canyon-charts]');
    if (window.console && console.log) console.log.apply(console, a);
  }
  function logErr() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[canyon-charts]');
    if (window.console && console.error) console.error.apply(console, a);
  }

  function bboxKey(bbox) {
    return bbox.map(function (v) { return v.toFixed(2); }).join(',');
  }

  function paddedBbox(extent) {
    // extent is EPSG:3857; expand to EPSG:4326 with light padding.
    var min = ol.proj.toLonLat([extent[0], extent[1]]);
    var max = ol.proj.toLonLat([extent[2], extent[3]]);
    var dx = (max[0] - min[0]) * BBOX_PAD;
    var dy = (max[1] - min[1]) * BBOX_PAD;
    var lonMin = Math.max(-180, min[0] - dx);
    var lonMax = Math.min(180, max[0] + dx);
    var latMin = Math.max(-90, min[1] - dy);
    var latMax = Math.min(90, max[1] + dy);
    return [lonMin, latMin, lonMax, latMax];
  }

  function bboxArea(bbox) {
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  }

  function fetchCanyons(bbox) {
    var key = bboxKey(bbox);
    var cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return Promise.resolve(cached.features);
    }
    if (state.inflight.has(key)) return state.inflight.get(key);

    if (bboxArea(bbox) > MAX_WORLD_BBOX_AREA) {
      // Too wide — clip to a sensible upper bound for one request.
      log('bbox too wide for one fetch; clipping', bbox);
      bbox = [
        Math.max(bbox[0], -120),
        Math.max(bbox[1], -60),
        Math.min(bbox[2], -50),
        Math.min(bbox[3], 60),
      ];
    }

    var params = new URLSearchParams({
      where: "generic_type='CANYON'",
      geometry: bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      outFields: 'name,generic_type',
      f: 'geojson',
      returnGeometry: 'true',
      resultRecordCount: String(MAX_FEATURES),
      returnExceededLimitFeatures: 'false',
    });
    var url = ARCGIS_URL + '?' + params.toString();

    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);

    var promise = fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j.error) throw new Error(j.error.message || 'ArcGIS error');
        var features = (j.features || []).map(function (f) {
          var coords = (f.geometry && f.geometry.coordinates) || [0, 0];
          var name = (f.properties && f.properties.name) || 'Canyon';
          var feat = new ol.Feature({
            geometry: new ol.geom.Point(coords),
          });
          feat.set('name', name);
          feat.set('source', SOURCE_LABEL);
          return feat;
        });
        // Cache eviction: LRU-ish.
        if (state.cache.size >= CACHE_MAX) {
          var firstKey = state.cache.keys().next().value;
          state.cache.delete(firstKey);
        }
        state.cache.set(key, { features: features, fetchedAt: Date.now() });
        return features;
      })
      .catch(function (err) {
        clearTimeout(timeout);
        logErr('fetch failed', err && err.message ? err.message : err);
        return [];
      })
      .then(function (features) {
        state.inflight.delete(key);
        return features;
      });

    state.inflight.set(key, promise);
    return promise;
  }

  function ensureSource() {
    if (state.source) return state.source;
    state.source = new ol.source.Vector({ projection: 'EPSG:4326', wrapX: false });
    return state.source;
  }

  function buildStyle() {
    return function (feat) {
      var name = feat.get('name') || 'Canyon';
      return new ol.style.Style({
        text: new ol.style.Text({
          text: name,
          font: '600 11px var(--font, system-ui, -apple-system, sans-serif)',
          fill: new ol.style.Fill({ color: '#ffe9b3' }),
          stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.85)', width: 2.5 }),
          offsetY: -10,
          textAlign: 'center',
          textBaseline: 'bottom',
          overflow: true,
          padding: [2, 4, 2, 4],
        }),
      });
    };
  }

  function createLayer() {
    var src = ensureSource();
    var layer = new ol.layer.Vector({
      source: src,
      declutter: true,
      zIndex: 400,
      properties: { 'fish-layer': 'canyon-charts', 'fish-source': SOURCE_LABEL },
      style: buildStyle(),
    });
    return layer;
  }

  function refreshLayer(map) {
    if (!map || !state.enabled) return;
    var layer = state.layers.get(map);
    if (!layer) return;
    var view = map.getView();
    var size = map.getSize() || [800, 600];
    var extent = view.calculateExtent(size);
    var bbox = paddedBbox(extent);
    fetchCanyons(bbox).then(function (features) {
      var src = layer.getSource();
      src.clear();
      src.addFeatures(features);
      log('refreshed', features.length, 'canyons for bbox', bbox.join(','));
    });
  }

  function attachToMap(map) {
    if (!map || state.layers.has(map)) return;
    if (typeof ol === 'undefined') return;
    var layer = createLayer();
    map.addLayer(layer);
    layer.setVisible(state.enabled);
    state.layers.set(map, layer);

    var onMoveEnd = function () { refreshLayer(map); };
    var onSizeChange = function () { refreshLayer(map); };
    map.on('moveend', onMoveEnd);
    map.on('change:size', onSizeChange);
    state.listeners.set(map, [onMoveEnd, onSizeChange]);

    if (state.enabled) refreshLayer(map);
  }

  function scoutMaps() {
    if (typeof window === 'undefined') return;
    if (window.desktopMapState && window.desktopMapState.map) {
      attachToMap(window.desktopMapState.map);
    }
    if (window.mobileMapState && window.mobileMapState.map) {
      attachToMap(window.mobileMapState.map);
    }
    if (window._combinedMap) {
      attachToMap(window._combinedMap);
    }
  }

  function startScout() {
    scoutMaps();
    var tick = 0;
    var interval = setInterval(function () {
      scoutMaps();
      tick++;
      if (state.layers.size >= 3 || tick > 60) clearInterval(interval);
    }, 500);
    setTimeout(function () { clearInterval(interval); }, 30000);
  }

  function buildToggleButton() {
    if (document.getElementById('captain-canyon-btn')) return;
    var tools = document.getElementById('captain-tools');
    if (!tools) {
      // Toolbar mounts later; retry briefly.
      setTimeout(buildToggleButton, 500);
      return;
    }
    var btn = document.createElement('button');
    btn.id = 'captain-canyon-btn';
    btn.className = 'captain-tool-btn';
    btn.title = 'Submarine canyons (GEBCO)';
    btn.setAttribute('data-tool', 'canyons');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Toggle submarine canyon labels');
    btn.innerHTML = [
      '<svg width="20" height="20" viewBox="0 0 22 22" fill="none"',
      ' xmlns="http://www.w3.org/2000/svg" style="display:block;">',
      '  <path d="M2 17 L7 9 L11 14 L15 5 L20 17"',
      '        stroke="currentColor" stroke-width="1.8"',
      '        stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
      '  <line x1="2" y1="19.6" x2="20" y2="19.6"',
      '         stroke="currentColor" stroke-width="0.8" stroke-dasharray="2 2"/>',
      '</svg>',
    ].join('\n');
    btn.addEventListener('click', function () {
      state.enabled = !state.enabled;
      btn.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
      btn.style.color = state.enabled ? 'var(--accent2, #ff8c00)' : '';
      for (var i = 0; i < state.layers.values.length; ) { break; } // no-op sentinel
      var ls = Array.from(state.layers.values());
      for (var i = 0; i < ls.length; i++) {
        ls[i].setVisible(state.enabled);
      }
      if (state.enabled) {
        var ms = Array.from(state.layers.keys());
        for (var k = 0; k < ms.length; k++) refreshLayer(ms[k]);
      } else {
        for (var j = 0; j < ls.length; j++) {
          var src = ls[j].getSource();
          if (src) src.clear();
        }
      }
      log('toggled', state.enabled);
    });
    tools.appendChild(btn);
  }

  function showAttributionCard() {
    if (document.getElementById('canyon-attribution')) return;
    var card = document.createElement('div');
    card.id = 'canyon-attribution';
    card.style.cssText = [
      'position:fixed',
      'bottom:8px',
      'left:8px',
      'z-index:1100',
      'background:rgba(10,16,24,0.85)',
      'color:#cbd5e1',
      'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:8px',
      'padding:6px 10px',
      'font:11px/1.4 system-ui,-apple-system,sans-serif',
      'max-width:340px',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity .2s ease',
    ].join(';');
    card.textContent = ATTRIBUTION;
    document.body.appendChild(card);
    // fade in if enabled
    if (state.enabled) {
      setTimeout(function () { card.style.opacity = '1'; }, 50);
    }
    state.attributionEl = card;
  }

  function toggleAttribution(on) {
    if (!state.attributionEl) return;
    state.attributionEl.style.opacity = on ? '1' : '0';
  }

  function init() {
    if (window.__canyon_charts_loaded) return;
    window.__canyon_charts_loaded = true;

    if (typeof ol === 'undefined') {
      logErr('OpenLayers not loaded; canyon-charts disabled');
      return;
    }

    buildToggleButton();
    showAttributionCard();
    startScout();
    log('initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
