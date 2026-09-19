import * as Cesium from 'cesium';
import {
  createLayerSelection,
  flatRingCentroid,
} from '../../data/layerSelection.js';
import {
  AVIATION_HAZARDS_ENTITY_PREFIX,
  AVIATION_HAZARDS_LAYER_ID,
  AVIATION_UPDATE_MS,
  DEFAULT_FILTER,
  HAZARD_FILTERS,
  filterFor,
} from './policy.js';
import { altitudeText, summarizeSigmets } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createAviationHazardSource } from './source.js';

const entityId = (id) => `${AVIATION_HAZARDS_ENTITY_PREFIX}${id}`;

/** The readout card for one advisory area. */
export function sigmetLabelText(area) {
  const headline = area.volcano
    ? `${area.name}: ${area.volcano}`
    : area.intensity
      ? `${area.intensity} ${area.name.toLowerCase()}`
      : area.name;
  const lines = [headline];
  if (area.region) lines.push(area.region);
  const altitude = altitudeText(area);
  if (altitude) lines.push(altitude);
  if (area.trend) lines.push(area.trend);
  if (area.dir != null && area.speed != null)
    lines.push(`Moving ${area.dir}° at ${area.speed} kt`);
  if (area.from && area.to)
    lines.push(`In force ${area.from} → ${area.to} UTC`);
  lines.push(area.meaning);
  // A SIGMET is an instruction to aircraft, not a general-purpose weather
  // product, and saying so keeps it from being read as one.
  lines.push(
    area.origin === 'domestic'
      ? 'US domestic SIGMET — advisory to aircraft.'
      : 'International SIGMET — advisory to aircraft.',
  );
  return lines.join('\n');
}

/**
 * Aviation hazards — SIGMETs in force.
 *
 * One hazard class at a time, or all of them, switched by the chips. Areas are
 * drawn in ascending severity so a volcanic-ash advisory is never buried under
 * the thunderstorm area it overlaps.
 *
 * @param {object} options
 * @param {{fetchSigmets: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createAviationHazardsLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchSigmets !== 'function')
    throw new TypeError('Aviation hazards layer requires a SIGMET source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _params = { hazard: DEFAULT_FILTER };
  let _summary = summarizeSigmets([], filterFor(DEFAULT_FILTER));
  /** @type {Map<string, object>} */
  const _areas = new Map();

  const selection = createLayerSelection({
    layerId: AVIATION_HAZARDS_LAYER_ID,
    layerName: 'Aviation Hazards',
    source: 'NOAA Aviation Weather Center',
    entityPrefix: AVIATION_HAZARDS_ENTITY_PREFIX,
    context,
    getRecord: (id) => _areas.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    describe: (area) => {
      const c = flatRingCentroid(area.positions) || { lat: 0, lon: 0 };
      return {
        label: sigmetLabelText(area),
        latitude: c.lat,
        longitude: c.lon,
        properties: {
          hazard: area.name,
          region: area.region,
          volcano: area.volcano,
          intensity: area.intensity,
          altitude: altitudeText(area),
          from: area.from,
          to: area.to,
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

  function rebuild(areas, filter) {
    if (!_dataSource) return;
    clearEntities();
    for (const area of areas) {
      const color = Cesium.Color.fromCssColorString(area.color);
      const entity = _dataSource.entities.add({
        id: entityId(area.id),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(area.positions),
          ),
          material: color.withAlpha(0.28),
          outline: true,
          outlineColor: color.withAlpha(0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      entity.gevLabelModel = {
        title: area.volcano
          ? `${area.name} · ${area.volcano}`
          : `${area.name} · ${area.region}`,
        details: [],
        accent: area.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _areas.set(area.id, area);
    }
    selection.reconcile();
    _summary = summarizeSigmets(areas, filter);
  }

  async function refresh() {
    if (!_enabled) return false;
    const filter = filterFor(_params.hazard);
    _abort?.abort();
    _abort = new AbortController();
    try {
      const areas = await source.fetchSigmets(filter, {
        signal: _abort.signal,
      });
      if (!_enabled) return false;
      rebuild(areas, filter);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:AviationHazards] load error:`, error);
      _lastError = error?.message || 'SIGMETs unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: AVIATION_HAZARDS_LAYER_ID,
    name: 'Aviation Hazards',
    icon: '⚠️',
    source: 'NOAA Aviation Weather Center',
    updateInterval: AVIATION_UPDATE_MS,

    init(viewer) {
      if (_viewer)
        throw new Error(`${AVIATION_HAZARDS_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(AVIATION_HAZARDS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:AviationHazards] Initialized`);
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      // No fetch here. The manager calls update() the moment enable() settles,
      // so fetching in both meant every enable pulled the feed twice.
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
      // _lastError deliberately SURVIVES a disable. The manager disables a
      // layer whose first update returned false, which is exactly what a
      // failed fetch does — so clearing the error here is what turns "the
      // upstream is down" into a layer that quietly switched itself off and
      // reports nothing in scope. A later successful refresh clears it.
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
    },

    /** Switch hazard filter. Anything unrecognised falls back to the default. */
    async setParams(params = {}) {
      const next = filterFor(params.hazard).key;
      if (next === _params.hazard) return false;
      _params = { ..._params, hazard: next };
      if (!_enabled) {
        notifyRowControls();
        return true;
      }
      await refresh();
      return true;
    },

    getParams() {
      return { ..._params };
    },

    getRowControls() {
      const active = filterFor(_params.hazard).key;
      return {
        chips: HAZARD_FILTERS.map((filter) => ({
          id: filter.key,
          label: filter.chip,
          active: filter.key === active,
          title: `${filter.label} — ${filter.blurb}`,
          params: { hazard: filter.key },
        })),
        legend: _summary.breakdown.map((entry) => ({
          label: `${entry.name} ×${entry.count}`,
          blurb: null,
        })),
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const filter = filterFor(_params.hazard);
      return {
        count: _summary.areas,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Name the most serious hazard in force rather than only counting: "163
        // areas" does not distinguish a day of routine turbulence from one with
        // ash over a flight corridor.
        coverage: _summary.areas
          ? `${filter.chip} · ${_summary.worst}`
          : _lastError
            ? `${filter.chip} · unavailable`
            : `${filter.chip} · none in force`,
      };
    },

    getAnalystRecords() {
      return [..._areas.values()].map((area) => ({
        id: area.id,
        layer: AVIATION_HAZARDS_LAYER_ID,
        kind: 'aviation-hazard',
        label: area.volcano
          ? `${area.name}: ${area.volcano}`
          : `${area.name}: ${area.region}`,
        detail: sigmetLabelText(area),
      }));
    },
  };
  return layer;
}
