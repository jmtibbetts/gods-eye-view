import * as Cesium from 'cesium';
import {
  createLayerSelection,
  flatRingCentroid,
} from '../../data/layerSelection.js';
import {
  AIR_QUALITY_ENTITY_PREFIX,
  AIR_QUALITY_LAYER_ID,
  AIR_QUALITY_UPDATE_MS,
} from './policy.js';
import { summarizeAirQuality } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createAirNowSource } from './source.js';

const entityId = (id) => `${AIR_QUALITY_ENTITY_PREFIX}${id}`;

/** The readout card for one contour. */
export function airQualityLabelText(area) {
  const lines = [`Air Quality: ${area.name}`, `AQI ${area.range}`];
  lines.push(area.guidance);
  if (area.observedMs)
    lines.push(
      `Observed ${new Date(area.observedMs).toISOString().slice(0, 16)}Z`,
    );
  // Absence is not cleanliness, and a contour is not a measurement at a point.
  lines.push(
    'EPA AirNow, interpolated between monitors. US coverage — elsewhere is unmeasured, not clean.',
  );
  return lines.join('\n');
}

/**
 * Air quality contours.
 *
 * The companion to the fire layers: FIRMS shows where things burn, this shows
 * where the smoke reached, and the two are routinely hundreds of miles apart.
 *
 * Worse air draws on top, so a hazardous pocket is never hidden beneath the
 * large "good" contour surrounding it.
 *
 * @param {object} options
 * @param {{fetchAirQuality: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createAirQualityLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchAirQuality !== 'function')
    throw new TypeError('Air quality layer requires an AirNow source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _summary = summarizeAirQuality([]);
  /** @type {Map<string, object>} */
  const _areas = new Map();

  const selection = createLayerSelection({
    layerId: AIR_QUALITY_LAYER_ID,
    layerName: 'Air Quality',
    source: 'EPA AirNow',
    entityPrefix: AIR_QUALITY_ENTITY_PREFIX,
    context,
    getRecord: (id) => _areas.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    // An AQI contour can span states; the card goes where the click landed.
    anchorCardAtClick: true,
    describe: (area) => {
      const c = flatRingCentroid(area.positions) || { lat: 0, lon: 0 };
      return {
        label: airQualityLabelText(area),
        latitude: c.lat,
        longitude: c.lon,
        properties: { category: area.name, range: area.range },
      };
    },
    screenSpaceEventHandlerFactory,
  });

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _areas.clear();
  }

  function rebuild(areas) {
    if (!_dataSource) return;
    clearEntities();
    for (const area of areas) {
      const color = Cesium.Color.fromCssColorString(area.color);
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(area.positions),
        area.holes.map(
          (hole) =>
            new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(hole),
            ),
        ),
      );
      const entity = _dataSource.entities.add({
        id: entityId(area.id),
        polygon: {
          hierarchy,
          // Light enough that the ground stays readable underneath: this is
          // an overlay on the world, not a replacement for it.
          material: color.withAlpha(0.3),
          outline: true,
          outlineColor: color.withAlpha(0.8),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      // A polygon has no position of its own, and the readout needs one to
      // draw the card next to: the area's centroid, until a click moves it.
      const centroid = flatRingCentroid(area.positions) || { lat: 0, lon: 0 };
      entity.gevTrackedId = entityId(area.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, 0);
      entity.gevLabelModel = {
        title: `${area.name} · AQI ${area.range}`,
        details: [],
        accent: area.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _areas.set(area.id, area);
    }
    selection.reconcile();
    _summary = summarizeAirQuality(areas);
  }

  async function refresh() {
    if (!_enabled) return false;
    _abort?.abort();
    _abort = new AbortController();
    try {
      const areas = await source.fetchAirQuality({ signal: _abort.signal });
      if (!_enabled) return false;
      rebuild(areas);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:AirQuality] load error:`, error);
      _lastError = error?.message || 'AirNow unavailable';
      return false;
    }
  }

  const layer = {
    id: AIR_QUALITY_LAYER_ID,
    name: 'Air Quality',
    icon: '😷',
    source: 'EPA AirNow',
    updateInterval: AIR_QUALITY_UPDATE_MS,

    init(viewer) {
      if (_viewer)
        throw new Error(`${AIR_QUALITY_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(AIR_QUALITY_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:AirQuality] Initialized`);
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
      _lastUpdate = null;
    },

    getRowControls() {
      return {
        chips: [],
        legend: _summary.breakdown.map((entry) => ({
          label: `${entry.name} ×${entry.count}`,
          blurb: null,
        })),
      };
    },

    getStats() {
      return {
        count: _summary.areas,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // The worst band present is the actionable number; a raw count of
        // contours says nothing about whether anyone should stay indoors.
        coverage: _summary.areas
          ? `worst: ${_summary.worst}`
          : 'no contours reported',
      };
    },

    getAnalystRecords() {
      return [..._areas.values()].map((area) => ({
        id: area.id,
        layer: AIR_QUALITY_LAYER_ID,
        kind: 'air-quality',
        label: `${area.name} (AQI ${area.range})`,
        detail: airQualityLabelText(area),
      }));
    },
  };
  return layer;
}
