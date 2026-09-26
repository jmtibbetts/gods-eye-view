import * as Cesium from 'cesium';
import { createLayerSelection } from '../../data/layerSelection.js';
import {
  createMarkerField,
  createMarkerFieldLoop,
} from '../../data/markerField.js';
import {
  TROPICAL_ENTITY_PREFIX,
  TROPICAL_LAYER_ID,
  TROPICAL_UPDATE_MS,
  categoryColor,
} from './policy.js';
import { summarize } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createNhcTropicalSource } from './source.js';

const entityId = (id) => `${TROPICAL_ENTITY_PREFIX}${id}`;

/** The readout card for an active storm. */
export function stormLabelText(storm) {
  const lines = [storm.headline];
  if (storm.knots != null)
    lines.push(`${storm.knots} kt sustained (${storm.mph} mph)`);
  if (storm.pressureMb != null) lines.push(`${storm.pressureMb} mb`);
  if (storm.movementKnots != null)
    lines.push(
      `Moving ${storm.movementCompass || '—'} at ${storm.movementKnots} kt`,
    );
  if (storm.advisoryNumber) lines.push(`Advisory ${storm.advisoryNumber}`);
  // The cone is the most misread object in public weather graphics. Say what
  // it means wherever a storm is described, not only in the panel.
  lines.push(
    'Cone shows the likely track of the CENTRE, about 2 times in 3 — hazards reach well outside it.',
  );
  return lines.join('\n');
}

/** The readout card for a disturbance that is not yet a cyclone. */
export function disturbanceLabelText(disturbance) {
  const lines = [`${disturbance.basin} disturbance`];
  if (disturbance.prob2day != null)
    lines.push(
      `2-day formation: ${disturbance.prob2day}% (${disturbance.risk2day})`,
    );
  if (disturbance.prob7day != null)
    lines.push(
      `7-day formation: ${disturbance.prob7day}% (${disturbance.risk7day})`,
    );
  lines.push('Not a cyclone — an area being watched for development.');
  return lines.join('\n');
}

/**
 * Tropical cyclones and the areas being watched for development.
 *
 * Draws four things, in ascending order of certainty: development regions
 * (a forecaster's shaded "somewhere in here"), disturbance points, forecast
 * cones and tracks, and the storms themselves. Everything else is deliberately
 * drawn beneath the storm markers so the actual position is never obscured by
 * a probability shape.
 *
 * @param {object} options
 * @param {{fetchTropical: Function}} options.source
 * @param {object} [options.context] contextStore module.
 * @param {object|null} [options.ground] Surface ground-floor service, so a
 *   storm marker sits on the surface rather than at the ellipsoid.
 */
export function createTropicalLayer({
  source,
  context = null,
  ground = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchTropical !== 'function')
    throw new TypeError('Tropical layer requires an NHC source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _summary = { storms: 0, hurricanes: 0, major: 0, disturbances: 0 };
  let _outlookOnly = false;
  /** @type {Map<string, object>} */
  const _storms = new Map();
  /** @type {Map<string, object>} */
  const _disturbances = new Map();
  // A dot drawn through the Earth slides against whatever city you are
  // looking at as the camera moves; the field floors each marker and hides
  // the ones behind the horizon, exactly as the audio layers do. Cones and
  // tracks are ground geometry and need neither.
  const _field = createMarkerField({ ground });
  const _fieldLoop = createMarkerFieldLoop(_field, () => _viewer);

  /**
   * Resolve a clicked entity id to its storm or disturbance.
   *
   * A storm draws several entities besides its own point — the forecast cone
   * as `id:cone:N`, past and forecast track segments as `id:past:N` and
   * `id:fcst:N`. Clicking any of them should select the storm they belong to,
   * not clear whatever was selected. Disturbance ids carry their own colon
   * (`disturbance:123`), so exact matches are tried before the storm prefix.
   */
  function recordFor(id) {
    if (_storms.has(id)) return _storms.get(id);
    if (_disturbances.has(id)) return _disturbances.get(id);
    const stormId = String(id).split(':')[0];
    return _storms.get(stormId) || null;
  }

  function entityFor(id) {
    const record = recordFor(id);
    if (!record) return null;
    return _dataSource?.entities.getById(entityId(record.id)) || null;
  }

  const selection = createLayerSelection({
    layerId: TROPICAL_LAYER_ID,
    layerName: 'Tropical Storms & Outlook',
    source: 'NOAA National Hurricane Center',
    entityPrefix: TROPICAL_ENTITY_PREFIX,
    context,
    getRecord: recordFor,
    getEntity: entityFor,
    getDataSource: () => _dataSource,
    // A cone or track click far from the eye still wants its card in view.
    anchorCardAtClick: true,
    describe: (record) =>
      _storms.has(record.id)
        ? {
            label: stormLabelText(record),
            latitude: record.lat,
            longitude: record.lon,
            properties: {
              name: record.name,
              classification: record.classificationLabel,
              category: record.category,
              knots: record.knots,
              pressureMb: record.pressureMb,
              advisory: record.advisoryNumber,
            },
          }
        : {
            label: disturbanceLabelText(record),
            latitude: record.lat,
            longitude: record.lon,
            properties: {
              basin: record.basin,
              twoDay: record.prob2day,
              sevenDay: record.prob7day,
              risk: record.risk7day,
            },
          },
    screenSpaceEventHandlerFactory,
  });

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _storms.clear();
    _disturbances.clear();
    _field.clear();
  }

  function addRegion(region) {
    const color = Cesium.Color.fromCssColorString(region.color);
    _dataSource.entities.add({
      id: entityId(region.id),
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(region.positions),
        ),
        material: color.withAlpha(0.16),
        outline: true,
        outlineColor: color.withAlpha(0.7),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
  }

  function addTrack(id, flat, { color, dashed }) {
    if (!Array.isArray(flat) || flat.length < 4) return;
    _dataSource.entities.add({
      id: entityId(id),
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        width: dashed ? 2 : 3,
        clampToGround: true,
        material: dashed
          ? new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
              dashLength: 12,
            })
          : Cesium.Color.fromCssColorString(color).withAlpha(0.75),
      },
    });
  }

  function addStorm(storm, geometry) {
    const color = Cesium.Color.fromCssColorString(storm.color);
    // Cone first, so it sits under the track and the marker.
    for (const cone of geometry?.cone || []) {
      _dataSource.entities.add({
        id: entityId(`${storm.id}:cone:${cone.id}`),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(cone.positions),
          ),
          material: color.withAlpha(0.18),
          outline: true,
          outlineColor: color.withAlpha(0.75),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
    }
    (geometry?.pastTrack || []).forEach((line, i) =>
      addTrack(`${storm.id}:past:${i}`, line, {
        color: '#9dd6de',
        dashed: false,
      }),
    );
    (geometry?.forecastTrack || []).forEach((line, i) =>
      addTrack(`${storm.id}:fcst:${i}`, line, {
        color: storm.color,
        dashed: true,
      }),
    );

    const entity = _dataSource.entities.add({
      id: entityId(storm.id),
      position: _field.positionFor(storm.lat, storm.lon),
      point: {
        // Size reads intensity at a glance; a major hurricane should not look
        // like a depression from altitude.
        pixelSize: 10 + Math.min(4, storm.category) * 3,
        color: color.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    _field.track(storm.id, entity, storm.lat, storm.lon);
    entity.gevTrackedId = entityId(storm.id);
    entity.gevDisplayPosition = () =>
      entity.position.getValue(Cesium.JulianDate.now());
    entity.gevLabelModel = {
      title: storm.headline,
      details: [],
      accent: storm.color,
      cardStyle: 'tactical',
      selected: true,
    };
    _storms.set(storm.id, storm);
  }

  function addDisturbance(disturbance) {
    const color = Cesium.Color.fromCssColorString(disturbance.color);
    const entity = _dataSource.entities.add({
      id: entityId(disturbance.id),
      position: _field.positionFor(disturbance.lat, disturbance.lon),
      point: {
        pixelSize: 9,
        color: color.withAlpha(0.85),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    _field.track(disturbance.id, entity, disturbance.lat, disturbance.lon);
    entity.gevTrackedId = entityId(disturbance.id);
    entity.gevDisplayPosition = () =>
      entity.position.getValue(Cesium.JulianDate.now());
    entity.gevLabelModel = {
      title: `${disturbance.basin} disturbance · ${disturbance.prob7day ?? '—'}% in 7 days`,
      details: [],
      accent: disturbance.color,
      cardStyle: 'tactical',
      selected: true,
    };
    _disturbances.set(disturbance.id, disturbance);
  }

  function rebuild(data) {
    if (!_dataSource) return;
    clearEntities();
    for (const region of data.regions) addRegion(region);
    for (const disturbance of data.disturbances) addDisturbance(disturbance);
    for (const storm of data.storms)
      addStorm(storm, data.geometry?.get(storm.id));
    _field.warm([...data.disturbances, ...data.storms]);
    _fieldLoop.refresh({ force: true });
    selection.reconcile();
    _summary = summarize(data);
    _outlookOnly = data.storms.length === 0 && data.disturbances.length > 0;
  }

  async function refresh() {
    if (!_enabled) return false;
    _abort?.abort();
    _abort = new AbortController();
    try {
      const data = await source.fetchTropical({ signal: _abort.signal });
      if (!_enabled) return false;
      rebuild(data);
      _lastUpdate = Date.now();
      // A quiet ocean is an answer, not a failure. Only a bulletin that could
      // not be read at all counts as an error.
      _lastError = data.bulletinOk ? null : 'NHC bulletin unavailable';
      _viewer?.scene?.requestRender?.();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:TropicalCyclones] load error:`, error);
      _lastError = error?.message || 'Tropical feed unavailable';
      return false;
    }
  }

  const layer = {
    id: TROPICAL_LAYER_ID,
    name: 'Tropical Storms & Outlook',
    icon: '🌀',
    source: 'NOAA National Hurricane Center',
    updateInterval: TROPICAL_UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error(`${TROPICAL_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(TROPICAL_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:TropicalCyclones] Initialized`);
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      // No fetch here. The manager calls update() the moment enable() settles,
      // so fetching in both meant every enable pulled the feed twice.
      selection.install(viewer || _viewer);
      _fieldLoop.start();
    },

    disable() {
      _enabled = false;
      _abort?.abort();
      _abort = null;
      _fieldLoop.stop();
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

    getStats() {
      const { storms, hurricanes, disturbances } = _summary;
      // Say which of the two pictures is on screen — "0" alone would read as
      // a broken feed during the two-thirds of the year with no named storm.
      const coverage = storms
        ? `${storms} storm${storms === 1 ? '' : 's'}${hurricanes ? `, ${hurricanes} hurricane${hurricanes === 1 ? '' : 's'}` : ''}`
        : disturbances
          ? `no named storms · ${disturbances} area${disturbances === 1 ? '' : 's'} watched`
          : 'no tropical activity';
      return {
        count: storms + disturbances,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage,
      };
    },

    /** Whether the only content right now is the outlook, not storms. */
    isOutlookOnly() {
      return _outlookOnly;
    },

    getAnalystRecords() {
      const records = [];
      for (const storm of _storms.values()) {
        records.push({
          id: storm.id,
          layer: TROPICAL_LAYER_ID,
          kind: 'tropical-cyclone',
          label: storm.headline,
          lat: storm.lat,
          lon: storm.lon,
          detail: stormLabelText(storm),
        });
      }
      for (const disturbance of _disturbances.values()) {
        records.push({
          id: disturbance.id,
          layer: TROPICAL_LAYER_ID,
          kind: 'tropical-disturbance',
          label: `${disturbance.basin} disturbance`,
          lat: disturbance.lat,
          lon: disturbance.lon,
          detail: disturbanceLabelText(disturbance),
        });
      }
      return records;
    },
  };
  return layer;
}
