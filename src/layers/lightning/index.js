import * as Cesium from 'cesium';
import { createLayerSelection } from '../../data/layerSelection.js';
import {
  createMarkerField,
  createMarkerFieldLoop,
} from '../../data/markerField.js';
import {
  LIGHTNING_ENTITY_PREFIX,
  LIGHTNING_LAYER_ID,
  LIGHTNING_UPDATE_MS,
} from './policy.js';
import { coverageText, summarizeFlashes } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createLightningSource } from './source.js';

const entityId = (id) => `${LIGHTNING_ENTITY_PREFIX}${id}`;

/** The readout card for one flash. */
export function flashLabelText(flash) {
  return [
    `Lightning flash — ${flash.bandName.toLowerCase()}`,
    `Detected by ${flash.satelliteName}`,
    // GLM's energy is a scaled instrument unit, not joules, so it is shown as
    // a relative figure rather than dressed up as a physical measurement.
    `Radiant energy ${flash.energy} (relative units)`,
  ].join('\n');
}

/**
 * Lightning flashes from the GOES lightning mappers.
 *
 * Each dot is one detected optical flash in the last minute. No chips: there
 * is no meaningful user choice here, and a time-window control would imply the
 * layer holds history it does not.
 *
 * @param {object} options
 * @param {{fetchFlashes: Function}} options.source
 * @param {object} [options.context] contextStore module.
 * @param {object|null} [options.ground] Surface ground-floor service, so a
 *   flash sits on the terrain rather than at the ellipsoid.
 */
export function createLightningLayer({
  source,
  context = null,
  ground = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchFlashes !== 'function')
    throw new TypeError('Lightning layer requires a flash source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _summary = summarizeFlashes(Object.assign([], { meta: null }));
  /** @type {Map<string, object>} */
  const _flashes = new Map();
  // A dot drawn through the Earth slides against whatever city you are
  // looking at as the camera moves; the field floors each marker and hides
  // the ones behind the horizon, exactly as the audio layers do.
  const _field = createMarkerField({ ground });
  const _fieldLoop = createMarkerFieldLoop(_field, () => _viewer);

  const selection = createLayerSelection({
    layerId: LIGHTNING_LAYER_ID,
    layerName: 'Lightning',
    source: 'NOAA GOES Geostationary Lightning Mapper',
    entityPrefix: LIGHTNING_ENTITY_PREFIX,
    context,
    getRecord: (id) => _flashes.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    describe: (flash) => ({
      label: flashLabelText(flash),
      latitude: flash.lat,
      longitude: flash.lon,
      properties: {
        band: flash.bandName,
        energy: flash.energy,
        satellite: flash.satelliteName,
      },
    }),
    screenSpaceEventHandlerFactory,
  });

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _flashes.clear();
    _field.clear();
  }

  function rebuild(flashes) {
    if (!_dataSource) return;
    clearEntities();
    for (const flash of flashes) {
      const color = Cesium.Color.fromCssColorString(flash.color);
      const entity = _dataSource.entities.add({
        id: entityId(flash.id),
        position: _field.positionFor(flash.lat, flash.lon),
        point: {
          pixelSize: flash.size,
          color: color.withAlpha(0.95),
          outlineColor:
            Cesium.Color.fromCssColorString('#2a4a6a').withAlpha(0.5),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      _field.track(flash.id, entity, flash.lat, flash.lon);
      entity.gevTrackedId = entityId(flash.id);
      entity.gevDisplayPosition = () =>
        entity.position.getValue(Cesium.JulianDate.now());
      entity.gevLabelModel = {
        title: `${flash.bandName} lightning · ${flash.satelliteName}`,
        details: [],
        accent: flash.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _flashes.set(flash.id, flash);
    }
    _field.warm(flashes);
    _fieldLoop.refresh({ force: true });
    selection.reconcile();
    _summary = summarizeFlashes(flashes);
  }

  async function refresh() {
    if (!_enabled) return false;
    _abort?.abort();
    _abort = new AbortController();
    try {
      const flashes = await source.fetchFlashes({ signal: _abort.signal });
      if (!_enabled) return false;
      rebuild(flashes);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:Lightning] load error:`, error);
      _lastError = error?.message || 'Lightning unavailable';
      return false;
    }
  }

  const layer = {
    id: LIGHTNING_LAYER_ID,
    name: 'Lightning Flashes',
    icon: '⚡',
    source: 'NOAA GOES Geostationary Lightning Mapper',
    updateInterval: LIGHTNING_UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error(`${LIGHTNING_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LIGHTNING_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:Lightning] Initialized`);
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
      return {
        count: _summary.flashes,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Name what was observed, not only what was found. GOES sees one
        // hemisphere, so a flash count alone would let an unobserved Europe
        // read as a calm one.
        coverage: _lastError
          ? 'unavailable'
          : `${_summary.flashes} in ${_summary.windowSeconds}s · ${coverageText(_summary)}`,
      };
    },

    getAnalystRecords() {
      return [..._flashes.values()].map((flash) => ({
        id: flash.id,
        layer: LIGHTNING_LAYER_ID,
        kind: 'lightning-flash',
        label: `${flash.bandName} flash (${flash.satelliteName})`,
        detail: flashLabelText(flash),
      }));
    },
  };
  return layer;
}
