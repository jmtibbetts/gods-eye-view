import * as Cesium from 'cesium';
import {
  createLayerSelection,
  flatRingCentroid,
} from '../../data/layerSelection.js';
import {
  DEFAULT_PRODUCT,
  OUTLOOK_PRODUCTS,
  SEVERE_OUTLOOK_ENTITY_PREFIX,
  SEVERE_OUTLOOK_LAYER_ID,
  SEVERE_OUTLOOK_UPDATE_MS,
  productFor,
} from './policy.js';
import { summarizeOutlook } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createSpcOutlookSource } from './source.js';

const entityId = (id) => `${SEVERE_OUTLOOK_ENTITY_PREFIX}${id}`;

/** The readout card for one risk area. */
export function outlookLabelText(area) {
  const lines = [`${area.productLabel}: ${area.name}`];
  if (area.detail && area.detail !== area.name) lines.push(area.detail);
  if (area.valid) lines.push(`Valid ${area.valid}`);
  if (area.expire) lines.push(`Expires ${area.expire}`);
  if (area.forecaster) lines.push(`Forecaster: ${area.forecaster}`);
  // A forecast is not an observation, and an outlook area is not a warning.
  lines.push('Forecast risk area — not a warning. SPC covers the CONUS only.');
  return lines.join('\n');
}

/**
 * SPC convective outlooks.
 *
 * One product at a time, switched by the chips on the layer row. Areas are
 * drawn in SPC's own colours and in ascending risk order, so a HIGH risk is
 * never buried beneath the general-thunderstorm area that encloses it.
 *
 * @param {object} options
 * @param {{fetchOutlook: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createSevereOutlookLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchOutlook !== 'function')
    throw new TypeError('Severe outlook layer requires an SPC source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _params = { product: DEFAULT_PRODUCT };
  let _summary = summarizeOutlook([], productFor(DEFAULT_PRODUCT));
  /** @type {Map<string, object>} */
  const _areas = new Map();

  const selection = createLayerSelection({
    layerId: SEVERE_OUTLOOK_LAYER_ID,
    layerName: 'Severe Outlook',
    source: 'NOAA Storm Prediction Center',
    entityPrefix: SEVERE_OUTLOOK_ENTITY_PREFIX,
    context,
    getRecord: (id) => _areas.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    // An outlook area spans states; the card goes where the click landed.
    anchorCardAtClick: true,
    describe: (area) => {
      const c = flatRingCentroid(area.positions) || { lat: 0, lon: 0 };
      return {
        label: outlookLabelText(area),
        latitude: c.lat,
        longitude: c.lon,
        properties: {
          product: area.productLabel,
          category: area.name,
          valid: area.valid,
          expire: area.expire,
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

  function rebuild(areas, product, statement) {
    if (!_dataSource) return;
    clearEntities();
    for (const area of areas) {
      const fill = Cesium.Color.fromCssColorString(area.fill);
      const stroke = Cesium.Color.fromCssColorString(area.stroke);
      // Holes are punched out, not filled: a categorical outlook nests its
      // bands, and filling the hole would paint the lower category over the
      // higher one inside it — inverting the map where it matters most.
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
          material: fill.withAlpha(0.32),
          outline: true,
          outlineColor: stroke.withAlpha(0.9),
          outlineWidth: 2,
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
        title: `${product.chip} · ${area.name}`,
        details: [],
        accent: area.stroke,
        cardStyle: 'tactical',
        selected: true,
      };
      _areas.set(area.id, area);
    }
    selection.reconcile();
    _summary = summarizeOutlook(areas, product, statement);
  }

  async function refresh() {
    if (!_enabled) return false;
    const product = productFor(_params.product);
    _abort?.abort();
    _abort = new AbortController();
    try {
      const { areas, statement } = await source.fetchOutlook(product, {
        signal: _abort.signal,
      });
      if (!_enabled) return false;
      rebuild(areas, product, statement);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:SevereOutlook] load error:`, error);
      _lastError = error?.message || 'SPC outlook unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: SEVERE_OUTLOOK_LAYER_ID,
    name: 'Severe Outlook',
    icon: '⛈️',
    source: 'NOAA Storm Prediction Center',
    updateInterval: SEVERE_OUTLOOK_UPDATE_MS,

    init(viewer) {
      if (_viewer)
        throw new Error(`${SEVERE_OUTLOOK_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(SEVERE_OUTLOOK_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:SevereOutlook] Initialized`);
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
        chips: OUTLOOK_PRODUCTS.map((product) => ({
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
        count: _summary.areas,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Naming the highest category is the one number that matters; "4
        // areas" says nothing about whether today is dangerous.
        // SPC's own words when it drew nothing — "Less Than 2% All Areas" is
        // an assessment, and reporting it as absent data would discard it.
        coverage: _summary.areas
          ? `${product.chip} · ${_summary.highest}`
          : `${product.chip} · ${_summary.statement || 'no risk areas drawn'}`,
      };
    },

    getAnalystRecords() {
      return [..._areas.values()].map((area) => ({
        id: area.id,
        layer: SEVERE_OUTLOOK_LAYER_ID,
        kind: 'severe-outlook',
        label: `${area.productLabel}: ${area.name}`,
        detail: outlookLabelText(area),
      }));
    },
  };
  return layer;
}
