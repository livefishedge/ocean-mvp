// fishing-grounds.js — FishEdge permanent offshore fishing-ground overlay
// Source: IHO-IOC GEBCO Gazetteer of Undersea Feature Names via ArcGIS REST.
// The current GEBCO service has separate point and line layers; keep the
// rendering intentionally light: named structure markers, not bathymetry.

(function () {
  'use strict';

  var SOURCE_LABEL = 'GEBCO / IHO-IOC';
  var SERVICE_ROOT =
    'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/' +
    'Undersea_Features/FeatureServer/';
  var ATTRIBUTION =
    'Permanent grounds: IHO-IOC GEBCO Gazetteer of Undersea Feature Names (www.gebco.net)';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  var FETCH_TIMEOUT_MS = 12000;
  var BBOX_PAD = 0.05;
  var MAX_FEATURES = 250;
  var POINT_TYPES = ['Seamount', 'Knoll', 'Bank'];

  var state = {
    enabled: true,
    layers: new Map(),
    cache: new Map(),
    inflight: new Map(),
    attributionEl: null,
  };

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[fishing-grounds]');
    if (window.console && console.log) console.log.apply(console, args);
  }
  function logErr() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[fishing-grounds]');
    if (window.console && console.error) console.error.apply(console, args);
  }
  function bboxKey(bbox) { return bbox.map(function (v) { return v.toFixed(2); }).join(','); }

  function paddedBbox(extent) {
    var min = ol.proj.toLonLat([extent[0], extent[1]]);
    var max = ol.proj.toLonLat([extent[2], extent[3]]);
    var dx = (max[0] - min[0]) * BBOX_PAD;
    var dy = (max[1] - min[1]) * BBOX_PAD;
    return [
      Math.max(-180, min[0] - dx), Math.max(-90, min[1] - dy),
      Math.min(180, max[0] + dx), Math.min(90, max[1] + dy),
    ];
  }

  function whereIn(field, values) {
    return field + ' IN (' + values.map(function (v) {
      return "'" + v.replace(/'/g, "''") + "'";
    }).join(',') + ')';
  }

  function collectCoords(value, out) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      out.push(value);
      return;
    }
    value.forEach(function (v) { collectCoords(v, out); });
  }

  function featurePoint(feature) {
    var coords = [];
    collectCoords(feature.geometry && feature.geometry.coordinates, coords);
    if (!coords.length) return null;
    var lon = 0, lat = 0;
    coords.forEach(function (c) { lon += c[0]; lat += c[1]; });
    return [lon / coords.length, lat / coords.length];
  }

  function fetchLayer(layerId, where, bbox) {
    var params = new URLSearchParams({
      where: where,
      geometry: bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      outFields: 'NAME,TYPE',
      f: 'geojson',
      returnGeometry: 'true',
      resultRecordCount: String(MAX_FEATURES),
      returnExceededLimitFeatures: 'false',
    });
    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(SERVICE_ROOT + layerId + '/query?' + params.toString(), { signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j.error) throw new Error(j.error.message || 'GEBCO query error');
        return (j.features || []).map(function (f) {
          var point = featurePoint(f);
          if (!point) return null;
          return { point: point, name: (f.properties && f.properties.NAME) || 'Unnamed',
            type: (f.properties && f.properties.TYPE) || 'Ground' };
        }).filter(Boolean);
      })
      .finally(function () { clearTimeout(timeout); });
  }

  function fetchGrounds(bbox) {
    var key = bboxKey(bbox);
    var cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.features);
    if (state.inflight.has(key)) return state.inflight.get(key);
    var promise = Promise.all([
      fetchLayer(1, "TYPE='Canyon'", bbox),
      fetchLayer(0, whereIn('TYPE', POINT_TYPES), bbox),
    ]).then(function (sets) {
      var features = sets[0].concat(sets[1]);
      state.cache.set(key, { features: features, fetchedAt: Date.now() });
      return features;
    }).catch(function (err) {
      logErr('fetch failed', err && err.message ? err.message : err);
      return [];
    }).finally(function () { state.inflight.delete(key); });
    state.inflight.set(key, promise);
    return promise;
  }

  function styleFor(feature) {
    var type = feature.get('type');
    var canyon = type === 'Canyon';
    return new ol.style.Style({
      image: new ol.style.RegularShape({
        points: canyon ? 3 : 5,
        radius: canyon ? 6 : 5,
        angle: canyon ? 0 : Math.PI / 5,
        fill: new ol.style.Fill({ color: canyon ? '#ffd166' : '#62e6c5' }),
        stroke: new ol.style.Stroke({ color: '#08131b', width: 1.5 }),
      }),
      text: new ol.style.Text({
        text: feature.get('name'),
        font: '700 11px system-ui, -apple-system, sans-serif',
        fill: new ol.style.Fill({ color: canyon ? '#ffe9b3' : '#a8ffe8' }),
        stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.9)', width: 3 }),
        offsetY: -12,
        textAlign: 'center',
        textBaseline: 'bottom',
        overflow: true,
      }),
    });
  }

  function attachToMap(map) {
    if (!map || state.layers.has(map) || typeof ol === 'undefined') return;
    var source = new ol.source.Vector({ wrapX: false });
    var layer = new ol.layer.Vector({ source: source, declutter: true, zIndex: 400,
      properties: { 'fish-layer': 'fishing-grounds', 'fish-source': SOURCE_LABEL }, style: styleFor });
    map.addLayer(layer);
    layer.setVisible(state.enabled);
    state.layers.set(map, layer);
    function refresh() {
      if (!state.enabled) return;
      var extent = map.getView().calculateExtent(map.getSize() || [800, 600]);
      fetchGrounds(paddedBbox(extent)).then(function (items) {
        source.clear();
        source.addFeatures(items.map(function (item) {
          var f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat(item.point)),
            name: item.name, type: item.type, source: SOURCE_LABEL });
          return f;
        }));
        log('refreshed', items.length, 'permanent grounds');
      });
    }
    map.on('moveend', refresh);
    map.on('change:size', refresh);
    if (state.enabled) refresh();
  }

  function scoutMaps() {
    if (window.desktopMapState && window.desktopMapState.map) attachToMap(window.desktopMapState.map);
    if (window.mobileMapState && window.mobileMapState.map) attachToMap(window.mobileMapState.map);
    if (window._combinedMap) attachToMap(window._combinedMap);
  }

  function showAttribution() {
    if (state.attributionEl) return;
    var card = document.createElement('div');
    card.id = 'fishing-grounds-attribution';
    card.textContent = ATTRIBUTION;
    card.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:1100;background:rgba(10,16,24,.88);color:#cbd5e1;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;font:11px/1.4 system-ui,sans-serif;max-width:360px;pointer-events:none;opacity:0;transition:opacity .2s';
    document.body.appendChild(card);
    state.attributionEl = card;
  }

  function buildToggleButton() {
    if (document.getElementById('captain-canyon-btn')) return;
    var tools = document.getElementById('captain-tools');
    if (!tools) { setTimeout(buildToggleButton, 500); return; }
    var btn = document.createElement('button');
    btn.id = 'captain-canyon-btn';
    btn.className = 'captain-tool-btn';
    btn.title = 'Permanent fishing grounds: canyons, seamounts, banks';
    btn.setAttribute('aria-label', 'Toggle permanent fishing grounds');
    btn.setAttribute('aria-pressed', 'true');
    btn.style.color = 'var(--accent2, #ff8c00)';
    btn.innerHTML = '<span style="font-size:13px;font-weight:700;letter-spacing:.02em">▲ Grounds</span>';
    btn.addEventListener('click', function () {
      state.enabled = !state.enabled;
      btn.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
      btn.style.color = state.enabled ? 'var(--accent2, #ff8c00)' : '';
      btn.innerHTML = state.enabled
        ? '<span style="font-size:13px;font-weight:700;letter-spacing:.02em">▲ Grounds</span>'
        : '<span style="font-size:13px;font-weight:700;letter-spacing:.02em;opacity:.55">△ Grounds</span>';
      state.layers.forEach(function (layer, map) {
        layer.setVisible(state.enabled);
        if (state.enabled) map.dispatchEvent('moveend'); else layer.getSource().clear();
      });
      if (state.attributionEl) state.attributionEl.style.opacity = state.enabled ? '1' : '0';
    });
    tools.appendChild(btn);
    if (state.attributionEl) state.attributionEl.style.opacity = '1';
  }

  function init() {
    if (window.__fishing_grounds_loaded) return;
    window.__fishing_grounds_loaded = true;
    if (typeof ol === 'undefined') return;
    buildToggleButton();
    showAttribution();
    var tick = 0;
    scoutMaps();
    var interval = setInterval(function () {
      scoutMaps();
      if (state.enabled) {
        state.layers.forEach(function (layer, map) { layer.setVisible(true); map.dispatchEvent('moveend'); });
      }
      if (++tick > 60) clearInterval(interval);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
