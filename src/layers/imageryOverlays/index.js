import * as Cesium from 'cesium';
import { IMAGERY_OVERLAYS } from './policy.js';

export * from './policy.js';

/**
 * Wrap one imagery-overlay descriptor as a data-layer-contract object. It adds
 * a Cesium imagery layer on enable, removes it on disable, and rebuilds it on
 * update() so time-varying feeds (radar, GOES) stay current.
 *
 * @param {object} options
 * @param {object} options.descriptor One of IMAGERY_OVERLAYS.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(provider: any, options: object) => any} [options.imageryLayerFactory]
 *   Injectable for tests; defaults to `new Cesium.ImageryLayer`.
 * @param {(url: string, options: object) => any} [options.providerFactory]
 *   Injectable for tests; defaults to `new Cesium.UrlTemplateImageryProvider`.
 */
export function createImageryOverlayLayer({
  descriptor,
  fetchImpl = (...args) => globalThis.fetch(...args),
  imageryLayerFactory = (provider, options) =>
    new Cesium.ImageryLayer(provider, options),
  providerFactory = (url, options) =>
    new Cesium.UrlTemplateImageryProvider({ url, ...options }),
} = {}) {
  if (!descriptor?.id)
    throw new TypeError('Imagery overlay needs a descriptor');

  let _viewer = null;
  let _enabled = false;
  let _imageryLayer = null;
  let _request = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _frameTime = null;

  function removeLayer() {
    if (_imageryLayer && _viewer?.imageryLayers) {
      try {
        _viewer.imageryLayers.remove(_imageryLayer, true);
      } catch {
        /* the scene may already be tearing down */
      }
    }
    _imageryLayer = null;
  }

  async function applyProvider() {
    const token = ++_request;
    try {
      const config = await descriptor.resolve(fetchImpl);
      if (!_enabled || token !== _request || !_viewer?.imageryLayers)
        return false;
      const { url, frameTime, credit, ...providerOptions } = config;
      const provider = providerFactory(url, {
        ...providerOptions,
        credit: credit || descriptor.attribution,
      });
      const layerObj = imageryLayerFactory(provider, {
        alpha: descriptor.opacity ?? 1,
      });
      // Add the fresh layer, then drop the old one — no flicker between frames.
      _viewer.imageryLayers.add(layerObj);
      if (_imageryLayer) removeLayer();
      _imageryLayer = layerObj;
      _frameTime = Number.isFinite(frameTime) ? frameTime : null;
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer.scene?.requestRender?.();
      return true;
    } catch (error) {
      if (token !== _request) return false;
      console.warn(`[Data:${descriptor.id}] load error:`, error);
      _lastError = error?.message || `${descriptor.name} unavailable`;
      return false;
    }
  }

  const layer = {
    id: descriptor.id,
    name: descriptor.name,
    icon: descriptor.icon,
    source: descriptor.source,
    updateInterval: descriptor.updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${descriptor.id} already initialized`);
      _viewer = viewer;
      console.log(`[Data:${descriptor.id}] Initialized`);
    },

    async enable(viewer) {
      _enabled = true;
      _viewer = viewer || _viewer;
      await applyProvider();
    },

    disable() {
      _enabled = false;
      _request++;
      removeLayer();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
    },

    async update() {
      if (!_enabled) return false;
      return applyProvider();
    },

    destroy() {
      this.disable();
      _viewer = null;
      _lastUpdate = null;
    },

    getStats() {
      return {
        count: _enabled && _imageryLayer ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _frameTime
          ? `frame ${new Date(_frameTime * 1000).toISOString().slice(11, 16)}Z`
          : descriptor.source,
      };
    },

    /** Overlay layers carry no point records for the analyst export. */
    getAnalystRecords() {
      return [];
    },
  };
  return layer;
}

/** Construct all three imagery-overlay layers. */
export function createImageryOverlayLayers(options = {}) {
  return IMAGERY_OVERLAYS.map((descriptor) =>
    createImageryOverlayLayer({ ...options, descriptor }),
  );
}
