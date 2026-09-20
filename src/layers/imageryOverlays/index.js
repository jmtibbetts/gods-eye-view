import * as Cesium from 'cesium';
import {
  EUMETVIEW_WMS,
  IMAGERY_OVERLAYS,
  IMAGERY_SLOTS,
  clampToAvailable,
  drapeSourceFor,
  gibsTileUrl,
  isArchived,
  isWms,
  liveTimeFor,
  productFor,
  wmsParameters,
  zoomFloorFor,
} from './policy.js';
import { imagerySurface } from './surface.js';
import { createImageryDrape } from './drape.js';
import {
  LOOP_FRAMES,
  describeDomainsUrl,
  domainInstants,
  frameConfig,
  loopStepMinutes,
  loopWindow,
  loopWindowText,
  probeFrames,
  stepInstants,
} from './frames.js';

export * from './policy.js';
export {
  createSurfaceCoordinator,
  imagerySurface,
  IMAGERY_SURFACE_RECLAIMED_EVENT,
} from './surface.js';

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
  drapeFactory = (options) => createImageryDrape(options),
  eventTarget = globalThis.window ?? null,
  // Wrapped, not referenced: a browser's setInterval throws "Illegal
  // invocation" when called off a plain object.
  timers = {
    set: (fn, ms) => globalThis.setInterval(fn, ms),
    clear: (id) => globalThis.clearInterval(id),
  },
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
  /** A running frame loop (see startLoop), or null. */
  let _loop = null;
  /** Paints this product onto a hidden-globe surface; built on first need. */
  let _drape = null;
  /** Unsubscribes the stack listener that keeps the presentation honest. */
  let _unlistenStack = null;
  /** Whether this layer is one of the surface coordinator's holders. */
  let _retained = false;

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

  /* ---------------------------------------------------------------- *
   * Which renderer draws this overlay
   *
   * Cesium's imagery layer paints on the globe. Under the photoreal stack
   * the globe is hidden, so there the same product is draped onto the 3D
   * tiles instead (see drape.js). The choice is made from the scene rather
   * than remembered, because the stack can change under a layer that is
   * already on — by share link, by preset, or by the user's own hand.
   * ---------------------------------------------------------------- */

  /** True when the globe is not the surface, so an imagery layer would be inert. */
  function globeHidden() {
    try {
      return _viewer?.scene?.globe?.show === false;
    } catch {
      return false;
    }
  }

  /** The day or instant the current selection should be shown at. */
  function selectedTime(current) {
    return _displayDate && isArchived(current)
      ? clampToAvailable(current, _displayDate, now())
      : liveTimeFor(current, now());
  }

  /**
   * How this product would be draped, or null if it cannot be.
   *
   * A descriptor with its own resolver (radar) builds a tile template from a
   * service that speaks no WMS, so it has no single-image form and keeps the
   * older behaviour of borrowing a surface it can be seen on.
   */
  function drapeSource() {
    const current = product();
    if (!current) return null;
    return drapeSourceFor(current, selectedTime(current), now());
  }

  function ensureDrape() {
    if (!_drape && _viewer)
      _drape = drapeFactory({ viewer: _viewer, id: descriptor.id });
    return _drape;
  }

  function clearDrape() {
    _drape?.clear();
  }

  /**
   * Draw this overlay with whichever renderer the current surface allows,
   * and take down the other one.
   * @returns {Promise<boolean>}
   */
  async function present() {
    if (!_enabled) return false;
    const source = globeHidden() ? drapeSource() : null;
    if (!source) {
      clearDrape();
      return applyProvider();
    }
    removeLayer();
    const drawn = await ensureDrape()?.show(source, { alpha: alpha() });
    if (drawn) {
      _lastUpdate = Date.now();
      _lastError = null;
    } else {
      _lastError = _drape?.getLastError?.() || `${descriptor.name} unavailable`;
    }
    return Boolean(drawn);
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
      // A service that refuses coarse requests gets a zoom floor on both the
      // provider (which level to ask for) and the layer (whether to draw at
      // all) — see zoomFloorFor for why Sentinel Hub needs one.
      const floor = zoomFloorFor(current);
      return {
        wms: {
          // A product may route through our own proxy instead of calling a
          // service directly — that is how the keyed one keeps its secret.
          url: current.wmsUrl || EUMETVIEW_WMS,
          layers: current.wmsLayer,
          credit: descriptor.attribution,
          maximumLevel: current.maximumLevel,
          ...(floor ? { minimumLevel: floor.minimumLevel } : {}),
          parameters: {
            format: 'image/png',
            transparent: true,
            ...wmsParameters(current, now()),
          },
        },
        ...(floor
          ? { layerOptions: { minimumTerrainLevel: floor.minimumTerrainLevel } }
          : {}),
      };
    }
    return {
      url: gibsTileUrl(current, selectedTime(current)),
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
      const {
        url,
        frameTime,
        credit,
        wms,
        layerOptions = {},
        ...providerOptions
      } = config;
      const provider = wms
        ? wmsProviderFactory(wms)
        : providerFactory(url, {
            ...providerOptions,
            credit: credit || descriptor.attribution,
          });
      const layerObj = imageryLayerFactory(provider, {
        alpha: alpha(),
        ...layerOptions,
      });
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

  /* ---------------------------------------------------------------- *
   * Frame loop (rolling geostationary products) — see frames.js
   * ---------------------------------------------------------------- */

  function showLoopFrame(index) {
    if (!_loop) return;
    _loop.index = index;
    const visible = alpha();
    _loop.layers.forEach((frame, i) => {
      frame.alpha = i === index ? visible : 0;
    });
    _viewer?.scene?.requestRender?.();
  }

  function stopLoop({ refresh = true } = {}) {
    if (!_loop) return false;
    const finished = _loop;
    _loop = null;
    if (finished.timer != null) timers.clear(finished.timer);
    for (const frame of finished.layers) {
      try {
        _viewer?.imageryLayers?.remove(frame, true);
      } catch {
        /* scene may be tearing down */
      }
    }
    if (_imageryLayer) _imageryLayer.alpha = alpha();
    _viewer?.scene?.requestRender?.();
    if (refresh && _enabled) void present();
    return true;
  }

  /**
   * Play the selected product's newest frames as a loop. Frames are found
   * and probed before any is drawn; fewer than two answering means no loop.
   * The live frame underneath is hidden while the loop runs and comes back,
   * refreshed, when it stops.
   * @param {{stepMs?: number}} [options] Dwell per frame.
   * @returns {Promise<{frames: number, instants: string[]}|null>}
   */
  async function startLoop({ stepMs = 750 } = {}) {
    const current = product();
    const window = current ? loopWindow(current, now()) : null;
    if (!_enabled || !window || !_viewer?.imageryLayers) return null;
    stopLoop({ refresh: false });
    const token = ++_request;
    let candidates;
    if (isWms(current)) {
      candidates = stepInstants(window.fromMs, window.toMs, window.stepMinutes);
    } else {
      try {
        const response = await fetchImpl(
          describeDomainsUrl(current, window.fromMs, window.toMs),
          { cache: 'no-store' },
        );
        candidates = response?.ok
          ? domainInstants(await response.text(), window.fromMs, window.toMs)
          : [];
      } catch {
        candidates = [];
      }
      // The domain answer is coarse; a late or missing scan still probes out.
      if (!candidates.length)
        candidates = stepInstants(
          window.fromMs,
          window.toMs,
          window.stepMinutes,
        );
    }
    const instants = (
      await probeFrames(current, candidates.slice(-LOOP_FRAMES), fetchImpl)
    ).slice(-LOOP_FRAMES);
    if (token !== _request || !_enabled || !_viewer?.imageryLayers) return null;
    if (instants.length < 2) return null;
    const layers = instants.map((instant) => {
      const config = frameConfig(current, instant, {
        credit: descriptor.attribution,
      });
      const provider = config.wms
        ? wmsProviderFactory(config.wms)
        : providerFactory(config.url, {
            maximumLevel: config.maximumLevel,
            credit: config.credit,
          });
      const frame = imageryLayerFactory(provider, { alpha: 0 });
      _viewer.imageryLayers.add(frame);
      return frame;
    });
    if (_imageryLayer) _imageryLayer.alpha = 0;
    _loop = {
      instants,
      layers,
      index: -1,
      timer: null,
      stepMs,
      product: current.key,
    };
    showLoopFrame(0);
    _loop.timer = timers.set(() => {
      if (!_loop) return;
      showLoopFrame((_loop.index + 1) % _loop.layers.length);
    }, stepMs);
    return { frames: instants.length, instants };
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
      // Under the photoreal stack the globe is hidden, and an imagery layer
      // added there draws nothing and requests no tiles at all. A product
      // that can be draped is painted onto the 3D tiles instead, and the
      // user keeps the basemap they chose. Only a product with no
      // single-image form still has to borrow a surface it can be seen on.
      if (globeHidden() && drapeSource()) {
        _surfaceChange = { switched: false, from: null, to: null };
      } else {
        _retained = true;
        _surfaceChange = await surface.retain();
      }
      await present();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _request++;
      stopLoop({ refresh: false });
      removeLayer();
      clearDrape();
      _lastError = null;
      _surfaceChange = null;
      // Release exactly what was retained. A drape never took the surface,
      // and releasing one it never held would decrement another overlay's
      // hold — after which the last real holder would fail to give it back.
      if (_retained) {
        _retained = false;
        void surface.release();
      }
      _viewer?.scene?.requestRender?.();
    },

    /**
     * Receive the map stack controller (see app/data.js). Without it the layer
     * still works on a globe stack and is simply inert on photoreal, which is
     * the pre-existing behaviour rather than a new failure.
     */
    attachMapStackController(controller) {
      surface.attach(controller);
      // The stack can change under a layer that is already on. When it does,
      // the renderer that suits the new surface takes over from the one that
      // does not — otherwise leaving photoreal leaves a drape stranded on a
      // surface that is gone, and arriving at it leaves an imagery layer
      // drawing nothing at all.
      if (_unlistenStack || !eventTarget?.addEventListener) return;
      const onStackChange = (event) => {
        if (event?.detail?.status && event.detail.status !== 'ready') return;
        if (_enabled && !_loop) void present();
      };
      eventTarget.addEventListener('gev:map-stack-changed', onStackChange);
      _unlistenStack = () =>
        eventTarget.removeEventListener('gev:map-stack-changed', onStackChange);
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
      // A loop holds its frames still; the live frame refreshes when it stops.
      if (_loop) return false;
      return present();
    },

    destroy() {
      this.disable();
      _unlistenStack?.();
      _unlistenStack = null;
      _drape?.destroy();
      _drape = null;
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

    /* ---------------------------------------------------------------- *
     * Frame loop
     * ---------------------------------------------------------------- */

    /** True when the selected product publishes frames often enough to loop. */
    canLoop() {
      return Boolean(_enabled && loopStepMinutes(product()));
    },

    /** "the last 2 h" for the selected product, or ''. */
    loopWindowText() {
      return loopWindowText(product());
    },

    startLoop,

    /** Stop the loop and put the live frame back. */
    stopLoop() {
      return stopLoop();
    },

    /** Advance one frame by hand (tests, or a paused scrub). */
    stepLoop() {
      if (!_loop) return null;
      showLoopFrame((_loop.index + 1) % _loop.layers.length);
      return _loop.instants[_loop.index];
    },

    /** Where the loop is, or null when none is running. */
    getLoop() {
      if (!_loop) return null;
      return {
        playing: true,
        frames: _loop.instants.length,
        index: _loop.index,
        instant: _loop.instants[_loop.index] ?? null,
        product: _loop.product,
      };
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
      stopLoop({ refresh: false });
      _sensorKey = next.key;
      if (_displayDate && !isArchived(next)) _displayDate = null;
      if (!_enabled) return true;
      await present();
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
      return present();
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
