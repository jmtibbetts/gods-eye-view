import * as Cesium from 'cesium';
import {
  EUMETVIEW_WMS,
  IMAGERY_OVERLAYS,
  IMAGERY_SLOTS,
  clampToAvailable,
  gibsTileUrl,
  isArchived,
  isWms,
  liveTimeFor,
  productFor,
  wmsParameters,
} from './policy.js';
import { imagerySurface } from './surface.js';

export * from './policy.js';
export { createSurfaceCoordinator, imagerySurface } from './surface.js';

/**
 * Wrap one imagery-overlay descriptor as a data-layer-contract object. It adds
 * a Cesium imagery layer on enable, removes it on disable, and rebuilds it on
 * update() so time-varying feeds (radar, geostationary) stay current.
 *
 * A descriptor carrying `slotId` is a GIBS sensor slot: it can be switched
 * between the products in that slot's catalog without being torn down, and
 * whether TIMELINE may scrub it depends on the SELECTED product rather than on
 * the slot — GOES GeoColor has no daily archive, VIIRS true colour has eight
 * years of one, and both live in slots the user can point anywhere.
 *
 * @param {object} options
 * @param {object} options.descriptor One of IMAGERY_OVERLAYS.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now] Clock override for tests.
 * @param {(provider: any, options: object) => any} [options.imageryLayerFactory]
 *   Injectable for tests; defaults to `new Cesium.ImageryLayer`.
 * @param {(url: string, options: object) => any} [options.providerFactory]
 *   Injectable for tests; defaults to `new Cesium.UrlTemplateImageryProvider`.
 */
export function createImageryOverlayLayer({
  descriptor,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  imageryLayerFactory = (provider, options) =>
    new Cesium.ImageryLayer(provider, options),
  providerFactory = (url, options) =>
    new Cesium.UrlTemplateImageryProvider({ url, ...options }),
  wmsProviderFactory = (options) =>
    new Cesium.WebMapServiceImageryProvider(options),
  surface = imagerySurface,
} = {}) {
  if (!descriptor?.id)
    throw new TypeError('Imagery overlay needs a descriptor');

  const slot = descriptor.slotId ? IMAGERY_SLOTS[descriptor.slotId] : null;

  let _viewer = null;
  let _enabled = false;
  let _imageryLayer = null;
  let _request = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _frameTime = null;
  /** null means 'whatever this feed calls latest'. */
  let _displayDate = null;
  /** Selected catalog product key; null for non-slot descriptors. */
  let _sensorKey = slot ? slot.defaultKey : null;
  /** The last basemap swap this layer's enable caused, if any. */
  let _surfaceChange = null;

  /** The catalog entry currently selected, or null for a custom resolver. */
  function product() {
    return slot ? productFor(descriptor.slotId, _sensorKey) : null;
  }

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

  /**
   * Tile config for the current selection. A slot descriptor builds it from
   * the catalog; anything else delegates to its own resolver.
   */
  async function resolveConfig() {
    const current = product();
    if (!current) {
      return descriptor.resolve(fetchImpl, { date: _displayDate });
    }
    // A pinned day only means anything for an archived product; a scrubbed
    // date on a rolling feed would address a frame that does not exist.
    // EUMETView speaks WMS rather than serving a REST tile template, and it
    // is addressed by instant rather than by day, so it takes its own path.
    if (isWms(current)) {
      return {
        wms: {
          // A product may route through our own proxy instead of calling a
          // service directly — that is how the keyed one keeps its secret.
          url: current.wmsUrl || EUMETVIEW_WMS,
          layers: current.wmsLayer,
          credit: descriptor.attribution,
          maximumLevel: current.maximumLevel,
          parameters: {
            format: 'image/png',
            transparent: true,
            ...wmsParameters(current, now()),
          },
        },
      };
    }
    const time =
      _displayDate && isArchived(current)
        ? clampToAvailable(current, _displayDate, now())
        : liveTimeFor(current, now());
    return {
      url: gibsTileUrl(current, time),
      maximumLevel: current.maximumLevel,
      credit: descriptor.attribution,
    };
  }

  /** Opacity for the current selection — a product may override its slot. */
  function alpha() {
    const current = product();
    return current?.opacity ?? descriptor.opacity ?? 1;
  }

  async function applyProvider() {
    const token = ++_request;
    try {
      const config = await resolveConfig();
      if (!_enabled || token !== _request || !_viewer?.imageryLayers)
        return false;
      const { url, frameTime, credit, wms, ...providerOptions } = config;
      const provider = wms
        ? wmsProviderFactory(wms)
        : providerFactory(url, {
            ...providerOptions,
            credit: credit || descriptor.attribution,
          });
      const layerObj = imageryLayerFactory(provider, { alpha: alpha() });
      // Add the fresh layer, then drop the old one — no flicker between frames,
      // and no blank globe while a switched sensor's first tiles are in flight.
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
      if (_enabled) return;
      _enabled = true;
      _viewer = viewer || _viewer;
      // Claim a surface that can actually show imagery BEFORE building the
      // provider. Under the photoreal stack the globe is hidden, and an
      // overlay added there draws nothing and requests no tiles at all.
      _surfaceChange = await surface.retain();
      await applyProvider();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _request++;
      removeLayer();
      _lastError = null;
      _surfaceChange = null;
      void surface.release();
      _viewer?.scene?.requestRender?.();
    },

    /**
     * Receive the map stack controller (see app/data.js). Without it the layer
     * still works on a globe stack and is simply inert on photoreal, which is
     * the pre-existing behaviour rather than a new failure.
     */
    attachMapStackController(controller) {
      surface.attach(controller);
    },

    /**
     * What claiming the surface cost, for the caller to tell the user: the
     * basemap it switched away from, or null when nothing had to change.
     */
    getSurfaceChange() {
      return _surfaceChange;
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
      const current = product();
      return {
        count: _enabled && _imageryLayer ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _frameTime
          ? `frame ${new Date(_frameTime * 1000).toISOString().slice(11, 16)}Z`
          : current
            ? current.label
            : descriptor.source,
      };
    },

    /** Overlay layers carry no point records for the analyst export. */
    getAnalystRecords() {
      return [];
    },

    /* ---------------------------------------------------------------- *
     * Sensor selection (GIBS slots only)
     * ---------------------------------------------------------------- */

    /** True when this overlay can be pointed at more than one sensor. */
    hasSensors() {
      return Boolean(slot);
    },

    /** The catalog products this overlay can be switched to. */
    listSensors() {
      return slot ? slot.products : [];
    },

    /** Catalog metadata for the slot, for panel headings. */
    getSlot() {
      return slot ? { id: descriptor.slotId, ...slot } : null;
    },

    /** The selected product key, or null when this overlay has no sensors. */
    getSensor() {
      return slot ? (product()?.key ?? null) : null;
    },

    /** The selected product record, or null. */
    getSensorProduct() {
      return product();
    },

    /**
     * Point this overlay at another sensor. Swaps the provider in place rather
     * than disabling and re-enabling, so the layer never leaves the scene and
     * the user never sees the basemap flash through mid-switch.
     *
     * A pinned archive date is dropped when the incoming product has no
     * archive to be pinned to — silently keeping it would leave the TIMELINE
     * reading ARCHIVE over a feed showing live.
     *
     * @param {string} key A product key from `listSensors()`.
     * @returns {Promise<boolean>} True when the selection changed.
     */
    async setSensor(key) {
      if (!slot) return false;
      const next = productFor(descriptor.slotId, key);
      if (!next || next.key === _sensorKey) return false;
      _sensorKey = next.key;
      if (_displayDate && !isArchived(next)) _displayDate = null;
      if (!_enabled) return true;
      await applyProvider();
      return true;
    },

    /* ---------------------------------------------------------------- *
     * TIMELINE integration
     * ---------------------------------------------------------------- */

    /**
     * Whether the TIMELINE scrubber can move this feed through its archive.
     * Answered for the SELECTED product, not the slot.
     */
    isTimeAware() {
      const current = product();
      return current ? isArchived(current) : descriptor.timeAware === true;
    },

    /**
     * Pin this overlay to a UTC day, or pass null to return it to the feed's
     * own latest frame. Re-resolves immediately when enabled so the scrub is
     * visible without waiting for the next update tick.
     * @param {string|null} date YYYY-MM-DD, or null for live.
     * @returns {Promise<boolean>} True when a new frame was applied.
     */
    async setDisplayDate(date) {
      if (!this.isTimeAware()) return false;
      const next = typeof date === 'string' && date ? date : null;
      if (next === _displayDate) return false;
      _displayDate = next;
      if (!_enabled) return false;
      return applyProvider();
    },

    /** The day this overlay is pinned to, or null when following live. */
    getDisplayDate() {
      return _displayDate;
    },
  };
  return layer;
}

/** Construct all four imagery-overlay layers. */
export function createImageryOverlayLayers(options = {}) {
  return IMAGERY_OVERLAYS.map((descriptor) =>
    createImageryOverlayLayer({ ...options, descriptor }),
  );
}
