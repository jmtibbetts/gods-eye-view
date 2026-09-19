import * as Cesium from 'cesium';
import {
  createLayerSelection,
  flatRingCentroid,
} from '../../data/layerSelection.js';
import {
  DEFAULT_TFR_FILTER,
  TFR_ENTITY_PREFIX,
  TFR_FILTERS,
  TFR_LAYER_ID,
  TFR_UPDATE_MS,
  tfrClassFor,
  tfrCurrent,
  tfrFilterFor,
} from './policy.js';
import { parseTfrs, summarizeTfrs, tfrPhase, windowText } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createTfrSource } from './source.js';

const entityId = (id) => `${TFR_ENTITY_PREFIX}${id}`;

/** Great-circle distance, km. */
function groundKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** The readout card for one closed area. */
export function tfrLabelText(area, nowMs = Date.now()) {
  const lines = [`FDC ${area.notamId} · ${area.name}`];
  if (area.location) lines.push(area.location);
  else if (area.title) lines.push(area.title.split(',').slice(0, 2).join(','));
  const window = windowText(area);
  if (window) {
    const phase = tfrPhase(area, nowMs);
    lines.push(
      `${phase === 'ahead' ? 'Opens' : phase === 'over' ? 'Ended' : 'In force'} ${window}`,
    );
  }
  if (area.altitude) lines.push(area.altitude);
  if (area.reason) lines.push(area.reason);
  if (area.parts > 1) lines.push(`One of ${area.parts} areas under this NOTAM`);
  lines.push(area.meaning);
  if (area.contact) lines.push(`Pilots contact ${area.contact}`);
  return lines.join('\n');
}

/**
 * Flight restrictions — FAA TFRs as the polygons they close.
 *
 * One restriction class at a time, or all of them, switched by the chips.
 * Areas are drawn in ascending severity so a launch closure is never
 * buried under the stadium TFR it overlaps.
 *
 * @param {object} options
 * @param {{fetchTfrs: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createTfrLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  now = () => Date.now(),
} = {}) {
  if (typeof source?.fetchTfrs !== 'function')
    throw new TypeError('TFR layer requires a TFR source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _params = { type: DEFAULT_TFR_FILTER };
  let _payload = null;
  let _summary = summarizeTfrs([], tfrFilterFor(DEFAULT_TFR_FILTER));
  /** @type {Map<string, object>} */
  const _areas = new Map();

  const selection = createLayerSelection({
    layerId: TFR_LAYER_ID,
    layerName: 'Flight Restrictions',
    source: 'FAA',
    entityPrefix: TFR_ENTITY_PREFIX,
    context,
    getRecord: (id) => _areas.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    anchorCardAtClick: true,
    describe: (area) => {
      const c = flatRingCentroid(area.positions) ||
        area.centre || {
          lat: 0,
          lon: 0,
        };
      return {
        label: tfrLabelText(area, now()),
        latitude: c.lat,
        longitude: c.lon,
        properties: {
          notam: area.notamId,
          type: area.type,
          begins: area.begins,
          ends: area.ends,
          altitude: area.altitude,
          reason: area.reason,
          page: area.pageUrl,
        },
      };
    },
    screenSpaceEventHandlerFactory,
  });

  function notifyRowControls() {
    try {
      _rowControlsListener?.();
    } catch {
      /* a listener failure must not break a refresh */
    }
  }

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _areas.clear();
  }

  function rebuild() {
    if (!_dataSource || !_payload) return;
    const filter = tfrFilterFor(_params.type);
    const areas = parseTfrs(_payload, filter, now());
    clearEntities();
    for (const area of areas) {
      const color = Cesium.Color.fromCssColorString(area.color);
      const ahead = tfrPhase(area, now()) === 'ahead';
      const entity = _dataSource.entities.add({
        id: entityId(area.id),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(area.positions),
          ),
          // A closure still ahead is drawn hollow-ish: it is published, not
          // yet in force.
          material: color.withAlpha(ahead ? 0.12 : 0.28),
          outline: true,
          outlineColor: color.withAlpha(0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      const centroid = flatRingCentroid(area.positions) || area.centre;
      entity.gevTrackedId = entityId(area.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, 0);
      entity.gevLabelModel = {
        title: `${area.name} · FDC ${area.notamId}`,
        details: [],
        accent: area.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _areas.set(area.id, area);
    }
    selection.reconcile();
    _summary = summarizeTfrs(areas, filter);
  }

  async function refresh() {
    if (!_enabled) return false;
    _abort?.abort();
    _abort = new AbortController();
    try {
      const payload = await source.fetchTfrs({ signal: _abort.signal });
      if (!_enabled) return false;
      _payload = payload;
      rebuild();
      _lastUpdate = now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn('[Data:TFR] load error:', error);
      _lastError = error?.message || 'TFRs unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: TFR_LAYER_ID,
    name: 'Flight Restrictions',
    icon: '⛔',
    source: 'FAA',
    updateInterval: TFR_UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error(`${TFR_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(TFR_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:TFR] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      // No fetch here: the manager calls update() once enable() settles.
      selection.install(viewer || _viewer);
    },

    disable() {
      _enabled = false;
      _abort?.abort();
      _abort = null;
      selection.clear();
      selection.remove();
      clearEntities();
      if (_dataSource) _dataSource.show = false;
      // _lastError survives a disable, as elsewhere: the manager disables a
      // layer whose first update failed, and the row must still say why.
      _viewer?.scene?.requestRender?.();
    },

    async update() {
      return refresh();
    },

    destroy() {
      this.disable();
      if (_dataSource && _viewer?.dataSources) {
        try {
          _viewer.dataSources.remove(_dataSource, true);
        } catch {
          /* scene may already be tearing down */
        }
      }
      _dataSource = null;
      _viewer = null;
      _rowControlsListener = null;
      _lastUpdate = null;
      _payload = null;
    },

    /** Switch restriction filter; the body is re-cut, not re-fetched. */
    async setParams(params = {}) {
      const next = tfrFilterFor(params.type).key;
      if (next === _params.type) return false;
      _params = { ..._params, type: next };
      if (_enabled && _payload) {
        rebuild();
        _viewer?.scene?.requestRender?.();
      }
      notifyRowControls();
      return true;
    },

    getParams() {
      return { ..._params };
    },

    getRowControls() {
      const active = tfrFilterFor(_params.type).key;
      const legend = _summary.breakdown.map((entry) => ({
        label: `${entry.name} ×${entry.count}`,
        blurb: null,
      }));
      if (_summary.noShape)
        legend.push({
          label: `${_summary.noShape} without a published shape`,
          blurb:
            'Listed by the FAA but drawn nowhere: the NOTAM text is the only description.',
        });
      return {
        chips: TFR_FILTERS.map((filter) => ({
          id: filter.key,
          label: filter.chip,
          active: filter.key === active,
          title: `${filter.label} — ${filter.blurb}`,
          params: { type: filter.key },
        })),
        legend,
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const filter = tfrFilterFor(_params.type);
      return {
        count: _summary.notams,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _summary.notams
          ? `${filter.chip} · ${_summary.notams} NOTAMs · worst ${_summary.worst}`
          : _lastError
            ? `${filter.chip} · unavailable`
            : `${filter.chip} · none listed`,
      };
    },

    getAnalystRecords() {
      const seen = new Set();
      const out = [];
      for (const area of _areas.values()) {
        if (seen.has(area.notamId)) continue;
        seen.add(area.notamId);
        out.push({
          id: area.notamId,
          layer: TFR_LAYER_ID,
          kind: 'tfr',
          name: `FDC ${area.notamId}`,
          label: `${area.name}: ${area.location || area.title}`,
          lat: area.centre?.lat ?? null,
          lon: area.centre?.lon ?? null,
          detail: tfrLabelText(area, now()),
        });
      }
      return out;
    },

    /** The latest proxy body, unfiltered, for panels that want the list. */
    getTfrs() {
      return _payload;
    },

    /**
     * Restrictions whose nearest drawn area is within `maxKm` of a point,
     * nearest first — the closures a launch watcher should know about
     * around a pad. Reads the last body whether or not the layer is on;
     * `ensureTfrs()` fetches one when there is none yet.
     * @param {{lat:number, lon:number, maxKm?:number, type?:string}} query
     */
    findTfrsNear({ lat, lon, maxKm = 150, type = null } = {}) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const rows = Array.isArray(_payload?.tfrs) ? _payload.tfrs : [];
      const wanted = type ? String(type).toUpperCase() : null;
      const out = [];
      for (const row of rows) {
        if (wanted && String(row.type).toUpperCase() !== wanted) continue;
        if (!tfrCurrent(row, now())) continue;
        let best = Infinity;
        for (const area of row.areas || []) {
          if (!area?.centre) continue;
          const km = groundKm(lat, lon, area.centre.lat, area.centre.lon);
          if (km < best) best = km;
        }
        if (best <= maxKm)
          out.push({
            ...row,
            className: tfrClassFor(row.type).name,
            distanceKm: Math.round(best),
            phase: tfrPhase(row, now()),
            window: windowText(row),
          });
      }
      return out.sort((a, b) => a.distanceKm - b.distanceKm);
    },

    /** Fetch the body if none is held yet; resolves to the body or null. */
    async ensureTfrs() {
      if (_payload) return _payload;
      try {
        _payload = await source.fetchTfrs({});
        return _payload;
      } catch {
        return null;
      }
    },

    /**
     * Fly to a restriction and select its first area. Works only while
     * enabled (there is nothing to select otherwise); returns whether it did.
     */
    focusTfr(notamId) {
      if (!_enabled || !_viewer?.camera) return false;
      const area = [..._areas.values()].find((a) => a.notamId === notamId);
      if (!area) return false;
      const ring = area.positions;
      let west = 180;
      let east = -180;
      let south = 90;
      let north = -90;
      for (let i = 0; i < ring.length; i += 2) {
        west = Math.min(west, ring[i]);
        east = Math.max(east, ring[i]);
        south = Math.min(south, ring[i + 1]);
        north = Math.max(north, ring[i + 1]);
      }
      const pad = Math.max(0.15, (east - west) * 0.6, (north - south) * 0.6);
      _viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          west - pad,
          south - pad,
          east + pad,
          north + pad,
        ),
        duration: 1.6,
      });
      selection.select?.(area.id);
      _viewer.scene?.requestRender?.();
      return true;
    },
  };
  return layer;
}
