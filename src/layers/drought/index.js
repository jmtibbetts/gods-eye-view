import * as Cesium from 'cesium';
import {
  createLayerSelection,
  flatRingCentroid,
} from '../../data/layerSelection.js';
import {
  DEFAULT_PRODUCT,
  DROUGHT_ENTITY_PREFIX,
  DROUGHT_LAYER_ID,
  DROUGHT_PRODUCTS,
  DROUGHT_UPDATE_MS,
  productFor,
} from './policy.js';
import { summarizeDrought } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createDroughtSource } from './source.js';

const entityId = (id) => `${DROUGHT_ENTITY_PREFIX}${id}`;

/** The readout card for one drought band. */
export function droughtLabelText(band) {
  const lines = [`${band.productLabel}: ${band.name}`];
  lines.push(band.meaning);
  if (band.kind === 'monitor') {
    if (band.valid) lines.push(`Conditions as of ${band.valid}`);
    // Weekly cadence is the thing people get wrong about this product: it is
    // never today's map, and during a fast-developing drought that matters.
    lines.push('US Drought Monitor — released weekly, not a live reading.');
  } else {
    if (band.valid) lines.push(`Valid through ${band.valid}`);
    if (band.issued) lines.push(`Issued ${band.issued}`);
    lines.push('CPC outlook — a forecast of change, not current conditions.');
  }
  return lines.join('\n');
}

/**
 * Drought — current conditions and CPC's outlooks.
 *
 * One product at a time, switched by the chips on the layer row. Bands are
 * drawn in the services' own colours and in ascending severity, so an
 * exceptional-drought core is never buried under the abnormally-dry band that
 * overlaps it.
 *
 * @param {object} options
 * @param {{fetchDrought: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createDroughtLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchDrought !== 'function')
    throw new TypeError('Drought layer requires a drought source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _params = { product: DEFAULT_PRODUCT };
  let _summary = summarizeDrought([], productFor(DEFAULT_PRODUCT));
  /** @type {Map<string, object>} */
  const _bands = new Map();

  const selection = createLayerSelection({
    layerId: DROUGHT_LAYER_ID,
    layerName: 'Drought',
    source: 'US Drought Monitor · NOAA CPC',
    entityPrefix: DROUGHT_ENTITY_PREFIX,
    context,
    getRecord: (id) => _bands.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    describe: (band) => {
      const c = flatRingCentroid(band.positions) || { lat: 0, lon: 0 };
      return {
        label: droughtLabelText(band),
        latitude: c.lat,
        longitude: c.lon,
        properties: {
          product: band.productLabel,
          category: band.name,
          valid: band.valid,
          issued: band.issued,
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
    _bands.clear();
  }

  function rebuild(bands, product) {
    if (!_dataSource) return;
    clearEntities();
    for (const band of bands) {
      const color = Cesium.Color.fromCssColorString(band.color);
      // Holes are punched out, not filled: both services publish interior
      // rings, and filling one paints a class over ground it does not cover.
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(band.positions),
        band.holes.map(
          (hole) =>
            new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(hole),
            ),
        ),
      );
      const entity = _dataSource.entities.add({
        id: entityId(band.id),
        polygon: {
          hierarchy,
          // Light enough that the ground stays readable underneath: this is an
          // overlay on the world, not a replacement for it.
          material: color.withAlpha(0.35),
          outline: false,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      entity.gevLabelModel = {
        title: `${product.chip} · ${band.name}`,
        details: [],
        accent: band.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _bands.set(band.id, band);
    }
    selection.reconcile();
    _summary = summarizeDrought(bands, product);
  }

  async function refresh() {
    if (!_enabled) return false;
    const product = productFor(_params.product);
    _abort?.abort();
    _abort = new AbortController();
    try {
      const bands = await source.fetchDrought(product, {
        signal: _abort.signal,
      });
      if (!_enabled) return false;
      rebuild(bands, product);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:Drought] load error:`, error);
      _lastError = error?.message || 'Drought data unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: DROUGHT_LAYER_ID,
    name: 'Drought',
    icon: '🏜️',
    source: 'US Drought Monitor · NOAA CPC',
    updateInterval: DROUGHT_UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error(`${DROUGHT_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(DROUGHT_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:Drought] Initialized`);
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

    /** Switch product. Anything unrecognised falls back to the default. */
    async setParams(params = {}) {
      const next = productFor(params.product).key;
      if (next === _params.product) return false;
      _params = { ..._params, product: next };
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
      const active = productFor(_params.product).key;
      return {
        chips: DROUGHT_PRODUCTS.map((product) => ({
          id: product.key,
          label: product.chip,
          active: product.key === active,
          title: `${product.label} — ${product.blurb}`,
          params: { product: product.key },
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
      const product = productFor(_params.product);
      return {
        count: _summary.bands,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // The worst class present, and the date it describes. A drought map
        // without its date invites being read as today's conditions when the
        // Drought Monitor is released weekly.
        coverage: _summary.bands
          ? `${product.chip} · ${_summary.worst}${_summary.valid ? ` · ${_summary.valid}` : ''}`
          : _lastError
            ? `${product.chip} · unavailable`
            : `${product.chip} · nothing drawn`,
      };
    },

    getAnalystRecords() {
      return [..._bands.values()].map((band) => ({
        id: band.id,
        layer: DROUGHT_LAYER_ID,
        kind: 'drought',
        label: `${band.productLabel}: ${band.name}`,
        detail: droughtLabelText(band),
      }));
    },
  };
  return layer;
}
