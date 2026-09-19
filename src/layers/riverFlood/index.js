import * as Cesium from 'cesium';
import {
  DEFAULT_HORIZON,
  FLOOD_HORIZONS,
  RIVER_FLOOD_ENTITY_PREFIX,
  RIVER_FLOOD_LAYER_ID,
  RIVER_FLOOD_UPDATE_MS,
  horizonFor,
} from './policy.js';
import { aboveFloodStage, summarizeGauges } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createNwpsGaugeSource } from './source.js';

const entityId = (id) => `${RIVER_FLOOD_ENTITY_PREFIX}${id}`;

/** A stage with its units, or null when the gauge did not report one. */
function stageText(value, units) {
  if (value == null) return null;
  return units ? `${value} ${units}` : String(value);
}

/** The readout card for one gauge. */
export function gaugeLabelText(gauge) {
  const lines = [`${gauge.statusName} — ${gauge.location || gauge.gaugeId}`];
  if (gauge.waterbody) lines.push(gauge.waterbody);
  const reading = stageText(gauge.stage, gauge.units);
  if (reading)
    lines.push(`${gauge.forecast ? 'Forecast stage' : 'Stage'}: ${reading}`);
  const flood = stageText(gauge.floodStage, gauge.units);
  if (flood) lines.push(`Flood stage: ${flood}`);

  const delta = aboveFloodStage(gauge);
  if (delta != null)
    lines.push(
      delta > 0
        ? `${delta} ${gauge.units || ''}`.trim() + ' above flood stage'
        : `${Math.abs(delta)} ${gauge.units || ''}`.trim() +
            ' below flood stage',
    );
  else if (gauge.scaleMismatch)
    // Saying why the difference is missing is the point. Silence here reads as
    // a bug; this reads as the gauge's own data being inconsistent, which it is.
    lines.push(
      "Reading and flood thresholds are on different scales — difference not shown. NOAA's status is unchanged.",
    );

  if (gauge.stageTime)
    lines.push(`${gauge.forecast ? 'Valid' : 'Observed'} ${gauge.stageTime}`);
  lines.push(gauge.meaning);
  if (gauge.forecast)
    lines.push(`${gauge.horizonLabel} — a forecast, not a reading.`);
  return lines.join('\n');
}

/**
 * River flood stages — NOAA's National Water Prediction Service gauges.
 *
 * Only gauges at or above action stage are drawn, and the horizon chips switch
 * between what the network is reading now and what it is forecast to read a
 * day, two days and three days out.
 *
 * @param {object} options
 * @param {{fetchGauges: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createRiverFloodLayer({ source, context = null } = {}) {
  if (typeof source?.fetchGauges !== 'function')
    throw new TypeError('River flood layer requires an NWPS source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _params = { horizon: DEFAULT_HORIZON };
  let _summary = summarizeGauges([], horizonFor(DEFAULT_HORIZON));
  /** @type {Map<string, object>} */
  const _gauges = new Map();

  function notifyRowControls() {
    try {
      _rowControlsListener?.();
    } catch {
      /* a listener failure must not break a refresh */
    }
  }

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _gauges.clear();
  }

  function rebuild(gauges, horizon) {
    if (!_dataSource) return;
    clearEntities();
    for (const gauge of gauges) {
      const color = Cesium.Color.fromCssColorString(gauge.color);
      const entity = _dataSource.entities.add({
        id: entityId(gauge.id),
        position: Cesium.Cartesian3.fromDegrees(gauge.lon, gauge.lat, 0),
        point: {
          // Severity reads as size as well as colour, so a major flood is
          // findable on a zoomed-out map without hunting for a purple dot.
          pixelSize: gauge.rank >= 3 ? 13 : gauge.rank >= 2 ? 10 : 8,
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { gaugeId: gauge.gaugeId },
      });
      entity.gevTrackedId = entityId(gauge.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(gauge.lon, gauge.lat, 0);
      entity.gevLabelModel = {
        title: `${gauge.statusName} · ${gauge.location || gauge.gaugeId}`,
        details: [],
        accent: gauge.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _gauges.set(gauge.id, gauge);
    }
    _summary = summarizeGauges(gauges, horizon);
  }

  async function refresh() {
    if (!_enabled) return false;
    const horizon = horizonFor(_params.horizon);
    _abort?.abort();
    _abort = new AbortController();
    try {
      const gauges = await source.fetchGauges(horizon, {
        signal: _abort.signal,
      });
      if (!_enabled) return false;
      rebuild(gauges, horizon);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:${RIVER_FLOOD_LAYER_ID}] load error:`, error);
      _lastError = error?.message || 'NWPS gauges unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: RIVER_FLOOD_LAYER_ID,
    name: 'River Flood',
    icon: '🌊',
    source: 'NOAA National Water Prediction Service',
    updateInterval: RIVER_FLOOD_UPDATE_MS,

    init(viewer) {
      if (_viewer)
        throw new Error(`${RIVER_FLOOD_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(RIVER_FLOOD_LAYER_ID);
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:${RIVER_FLOOD_LAYER_ID}] Initialized`);
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

    /** Switch horizon. Anything unrecognised falls back to the default. */
    async setParams(params = {}) {
      const next = horizonFor(params.horizon).key;
      if (next === _params.horizon) return false;
      _params = { ..._params, horizon: next };
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
      const active = horizonFor(_params.horizon).key;
      return {
        chips: FLOOD_HORIZONS.map((horizon) => ({
          id: horizon.key,
          label: horizon.chip,
          active: horizon.key === active,
          title: `${horizon.label} — ${horizon.blurb}`,
          params: { horizon: horizon.key },
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
      const horizon = horizonFor(_params.horizon);
      return {
        count: _summary.gauges,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // The worst status present is the number that matters. "44 gauges"
        // does not distinguish a network at action stage from one in major
        // flood, and those are not the same day.
        coverage: _summary.gauges
          ? `${horizon.chip} · ${_summary.worst}`
          : _lastError
            ? `${horizon.chip} · unavailable`
            : `${horizon.chip} · no gauges at or above action stage`,
      };
    },

    getSummary() {
      return { ..._summary };
    },

    getAnalystRecords() {
      return [..._gauges.values()].map((gauge) => ({
        id: gauge.id,
        layer: RIVER_FLOOD_LAYER_ID,
        kind: 'river-flood',
        label: `${gauge.statusName}: ${gauge.location || gauge.gaugeId}`,
        detail: gaugeLabelText(gauge),
      }));
    },
  };
  return layer;
}
