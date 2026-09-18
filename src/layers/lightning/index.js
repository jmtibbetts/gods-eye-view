import * as Cesium from 'cesium';
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
 */
export function createLightningLayer({ source, context = null } = {}) {
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

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _flashes.clear();
  }

  function rebuild(flashes) {
    if (!_dataSource) return;
    clearEntities();
    for (const flash of flashes) {
      const color = Cesium.Color.fromCssColorString(flash.color);
      _dataSource.entities.add({
        id: entityId(flash.id),
        position: Cesium.Cartesian3.fromDegrees(flash.lon, flash.lat, 0),
        point: {
          pixelSize: flash.size,
          color: color.withAlpha(0.95),
          outlineColor:
            Cesium.Color.fromCssColorString('#2a4a6a').withAlpha(0.5),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      _flashes.set(flash.id, flash);
    }
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
      console.warn(`[Data:${LIGHTNING_LAYER_ID}] load error:`, error);
      _lastError = error?.message || 'Lightning unavailable';
      return false;
    }
  }

  const layer = {
    id: LIGHTNING_LAYER_ID,
    name: 'Lightning',
    icon: '⚡',
    source: 'NOAA GOES Geostationary Lightning Mapper',
    updateInterval: LIGHTNING_UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error(`${LIGHTNING_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LIGHTNING_LAYER_ID);
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:${LIGHTNING_LAYER_ID}] Initialized`);
    },

    async enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      await refresh();
    },

    disable() {
      _enabled = false;
      _abort?.abort();
      _abort = null;
      clearEntities();
      if (_dataSource) _dataSource.show = false;
      _lastError = null;
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
        coverage: `${_summary.flashes} in ${_summary.windowSeconds}s · ${coverageText(_summary)}`,
      };
    },

    getSummary() {
      return { ..._summary };
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
