import * as Cesium from 'cesium';
import { createLayerSelection } from '../../data/layerSelection.js';
import {
  DEFAULT_SCOPE,
  SATNOGS_ENTITY_PREFIX,
  SATNOGS_LAYER_ID,
  SATNOGS_UPDATE_MS,
  STATION_SCOPES,
  scopeFor,
} from './policy.js';
import { lastSeenText, summarizeStations } from './records.js';

export * from './policy.js';
export * from './records.js';
export { createSatnogsSource } from './source.js';

const entityId = (id) => `${SATNOGS_ENTITY_PREFIX}${id}`;

/** The readout card for one ground station. */
export function stationLabelText(station, now = Date.now()) {
  const lines = [`${station.stateName} — ${station.name}`];
  lines.push(station.meaning);
  if (station.bands.length) lines.push(`Bands: ${station.bands.join(', ')}`);
  if (station.observations != null) {
    const rate =
      station.successRate != null ? ` · ${station.successRate}% good` : '';
    lines.push(`${station.observations.toLocaleString()} observations${rate}`);
  }
  if (station.future) lines.push(`${station.future} scheduled ahead`);
  lines.push(lastSeenText(station, now));
  lines.push(`SatNOGS station #${station.stationId}`);
  return lines.join('\n');
}

/**
 * SatNOGS ground stations.
 *
 * Where somebody is listening, rather than where a satellite is. The scope
 * chips widen from stations connected right now out to every station on file.
 *
 * @param {object} options
 * @param {{fetchStations: Function}} options.source
 * @param {object} [options.context] contextStore module.
 */
export function createSatnogsLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.fetchStations !== 'function')
    throw new TypeError('SatNOGS layer requires a station source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _params = { scope: DEFAULT_SCOPE };
  let _summary = summarizeStations([], scopeFor(DEFAULT_SCOPE));
  /** @type {Map<string, object>} */
  const _stations = new Map();

  const selection = createLayerSelection({
    layerId: SATNOGS_LAYER_ID,
    layerName: 'SatNOGS',
    source: 'SatNOGS Network',
    entityPrefix: SATNOGS_ENTITY_PREFIX,
    context,
    getRecord: (id) => _stations.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    describe: (station) => ({
      label: stationLabelText(station),
      latitude: station.lat,
      longitude: station.lon,
      properties: {
        state: station.stateName,
        bands: station.bands.join(', '),
        observations: station.observations,
        successRate: station.successRate,
        lastSeen: station.lastSeen,
      },
    }),
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
    _stations.clear();
  }

  function rebuild(stations, scope) {
    if (!_dataSource) return;
    clearEntities();
    for (const station of stations) {
      const color = Cesium.Color.fromCssColorString(station.color);
      const entity = _dataSource.entities.add({
        id: entityId(station.id),
        position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 0),
        point: {
          // A live station is bigger as well as brighter, so it stays findable
          // in the ALL scope where four thousand dormant ones surround it.
          pixelSize: station.rank >= 2 ? 10 : station.rank >= 1 ? 8 : 5,
          color: color.withAlpha(station.rank > 0 ? 0.95 : 0.6),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { stationId: station.stationId },
      });
      entity.gevTrackedId = entityId(station.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 0);
      entity.gevLabelModel = {
        title: `${station.name} · ${station.stateName}`,
        details: [],
        accent: station.color,
        cardStyle: 'tactical',
        selected: true,
      };
      _stations.set(station.id, station);
    }
    selection.reconcile();
    _summary = summarizeStations(stations, scope);
  }

  async function refresh() {
    if (!_enabled) return false;
    const scope = scopeFor(_params.scope);
    _abort?.abort();
    _abort = new AbortController();
    try {
      const stations = await source.fetchStations(scope, {
        signal: _abort.signal,
      });
      if (!_enabled) return false;
      rebuild(stations, scope);
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn(`[Data:SatNOGS] load error:`, error);
      _lastError = error?.message || 'SatNOGS unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: SATNOGS_LAYER_ID,
    name: 'SatNOGS',
    icon: '📡',
    source: 'SatNOGS Network',
    updateInterval: SATNOGS_UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error(`${SATNOGS_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(SATNOGS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log(`[Data:SatNOGS] Initialized`);
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

    /** Switch scope. Anything unrecognised falls back to the default. */
    async setParams(params = {}) {
      const next = scopeFor(params.scope).key;
      if (next === _params.scope) return false;
      _params = { ..._params, scope: next };
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
      const active = scopeFor(_params.scope).key;
      return {
        chips: STATION_SCOPES.map((scope) => ({
          id: scope.key,
          label: scope.chip,
          active: scope.key === active,
          title: `${scope.label} — ${scope.blurb}`,
          params: { scope: scope.key },
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
      const scope = scopeFor(_params.scope);
      return {
        count: _summary.stations,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Say the denominator. "48 stations" invites being read as the size of
        // the network; "48 of 4,477" says what the scope is hiding.
        coverage: _summary.stations
          ? `${scope.chip} · ${_summary.stations} of ${_summary.total}`
          : _lastError
            ? `${scope.chip} · unavailable`
            : `${scope.chip} · none in scope`,
      };
    },

    getAnalystRecords() {
      return [..._stations.values()].map((station) => ({
        id: station.id,
        layer: SATNOGS_LAYER_ID,
        kind: 'satnogs-station',
        label: `${station.stateName}: ${station.name}`,
        detail: stationLabelText(station),
      }));
    },
  };
  return layer;
}
