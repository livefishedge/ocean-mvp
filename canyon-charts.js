// fishing-grounds.js — FishEdge permanent basemap feature labels
// Renders IHO-IOC GEBCO Gazetteer undersea feature names (canyons, seamounts,
// knolls, banks) as a permanent part of the captain's-dashboard basemap.
// No toggle, no toolbar icon — these are geographic context, like city labels.
// Source: IHO-IOC GEBCO Gazetteer of Undersea Feature Names via ArcGIS REST.
// Layer zIndex is low so the grounds sit with the basemap context, beneath
// SST / CHL / thermal-fronts overlays.

(function () {
  'use strict';

  var SOURCE_LABEL = 'BOEM US Submarine Canyons';
  var SERVICE_ROOT =
    'https://services.arcgis.com/bDAhvQYMG4WL8O5o/arcgis/rest/services/' +
    'US_Submarine_Canyons/FeatureServer/';
  var ATTRIBUTION =
    'Permanent canyon systems: BOEM US Submarine Canyons';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  var FETCH_TIMEOUT_MS = 12000;
  var BBOX_PAD = 0.05;
  var MAX_FEATURES = 250;
  var BASEMAP_ZINDEX = 5;
  var REGION_BBOXES = {
    usec_south: [-81, 31, -73, 36],
    usec_md: [-76.5, 35.5, -71.5, 40.5],
  };

  var state = {
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

  function selectedRegionBbox() {
    var region = new URLSearchParams(window.location.search).get('region');
    return REGION_BBOXES[region] || null;
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
      outFields: 'Name,Region,Sys_Can,DepthMin_m,DepthMax_m,Length_Km',
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
          return { point: point, name: (f.properties && f.properties.Name) || 'Unnamed',
            type: 'Canyon', region: f.properties && f.properties.Region,
            system: f.properties && f.properties.Sys_Can };
        }).filter(Boolean);
      })
      .finally(function () { clearTimeout(timeout); });
  }

  function fetchGrounds(bbox) {
    var key = bboxKey(bbox);
    var cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.features);
    if (state.inflight.has(key)) return state.inflight.get(key);
    var promise = fetchLayer(0, '1=1', bbox).then(function (features) {
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
        radius: canyon ? 5 : 4,
        angle: canyon ? 0 : Math.PI / 5,
        fill: new ol.style.Fill({ color: canyon ? '#ffd166' : '#62e6c5' }),
        stroke: new ol.style.Stroke({ color: '#08131b', width: 1.2 }),
      }),
      text: new ol.style.Text({
        text: feature.get('name'),
        font: '600 11px system-ui, -apple-system, sans-serif',
        fill: new ol.style.Fill({ color: canyon ? '#ffe9b3' : '#a8ffe8' }),
        stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.9)', width: 3 }),
        offsetY: -10,
        textAlign: 'center',
        textBaseline: 'bottom',
        overflow: true,
      }),
    });
  }

  function attachToMap(map) {
    if (!map || state.layers.has(map) || typeof ol === 'undefined') return;
    var source = new ol.source.Vector({ wrapX: false });
    var layer = new ol.layer.Vector({
      source: source,
      declutter: true,
      zIndex: BASEMAP_ZINDEX,
      properties: { 'fish-layer': 'fishing-grounds', 'fish-source': SOURCE_LABEL },
      style: styleFor,
    });
    map.addLayer(layer);
    layer.setVisible(true);
    state.layers.set(map, layer);
    function refresh() {
      var extent = map.getView().calculateExtent(map.getSize() || [800, 600]);
      // Never let a broad/temporarily-unfitted map viewport turn a regional
      // dashboard into a worldwide feature-name layer.
      var bbox = selectedRegionBbox() || paddedBbox(extent);
      fetchGrounds(bbox).then(function (items) {
        source.clear();
        source.addFeatures(items.map(function (item) {
          var f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat(item.point)),
            name: item.name, type: item.type, region: item.region,
            system: item.system, source: SOURCE_LABEL });
          return f;
        }));
        log('refreshed', items.length, 'permanent grounds');
      });
    }
    map.on('moveend', refresh);
    map.on('change:size', refresh);
    refresh();
  }

  function scoutMaps() {
    // The dashboard keeps desktopMapState/mobileMapState module-scoped, so
    // they are not available as window properties. Its map instrumentation
    // exposes the live OpenLayers instances here; use those as the primary
    // attachment path and retain the older globals for compatibility.
    if (window.__fishedgeMaps && window.__fishedgeMaps.length) {
      window.__fishedgeMaps.forEach(attachToMap);
    }
    if (window.desktopMapState && window.desktopMapState.map) attachToMap(window.desktopMapState.map);
    if (window.mobileMapState && window.mobileMapState.map) attachToMap(window.mobileMapState.map);
    if (window._combinedMap) attachToMap(window._combinedMap);
  }

  function showAttribution() {
    if (state.attributionEl) return;
    var card = document.createElement('div');
    card.id = 'fishing-grounds-attribution';
    card.textContent = ATTRIBUTION;
    card.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:1100;background:rgba(10,16,24,.88);color:#cbd5e1;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;font:11px/1.4 system-ui,sans-serif;max-width:360px;pointer-events:none;opacity:1';
    document.body.appendChild(card);
    state.attributionEl = card;
  }

  function init() {
    if (window.__fishing_grounds_loaded) return;
    window.__fishing_grounds_loaded = true;
    if (typeof ol === 'undefined') return;
    showAttribution();
    var tick = 0;
    scoutMaps();
    var interval = setInterval(function () {
      scoutMaps();
      if (++tick > 60) clearInterval(interval);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
