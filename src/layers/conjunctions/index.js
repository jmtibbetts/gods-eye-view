import * as Cesium from 'cesium';
import { createLayerSelection } from '../../data/layerSelection.js';
import {
  CONJUNCTIONS_ENTITY_PREFIX,
  CONJUNCTIONS_LAYER_ID,
  CONJUNCTIONS_PENDING_RETRY_MS,
  CONJUNCTIONS_UPDATE_MS,
  CONJUNCTION_FILTERS,
  DEFAULT_CONJUNCTION_FILTER,
  conjunctionFilterFor,
  probabilityText,
} from './policy.js';
import {
  parseConjunctions,
  rangeText,
  summarizeConjunctions,
  untilText,
} from './records.js';

export * from './policy.js';
export * from './records.js';
export { createConjunctionSource } from './source.js';

const entityId = (id) => `${CONJUNCTIONS_ENTITY_PREFIX}${id}`;

/** The readout card for one conjunction. */
export function conjunctionLabelText(record, nowMs = Date.now()) {
  const [a, b] = record.objects;
  const lines = [
    `${a.name} × ${b.name}`,
    `Closest approach ${record.tca.slice(0, 16).replace('T', ' ')}Z (${untilText(record.tcaMs, nowMs)})`,
    `Miss ${rangeText(record.rangeKm)}${
      record.relativeSpeedKms !== null
        ? ` at ${record.relativeSpeedKms.toFixed(1)} km/s relative`
        : ''
    }`,
    `SOCRATES maximum probability ${probabilityText(record.maxProbability)} — ${record.band.name.toLowerCase()}`,
  ];
  lines.push(
    `${a.name}: ${a.status}${a.station ? ` · ${a.station}` : ''}; ${b.name}: ${b.status}${b.station ? ` · ${b.station}` : ''}`,
  );
  if (record.position)
    lines.push(
      `Over ${Math.abs(record.position.lat).toFixed(1)}°${record.position.lat >= 0 ? 'N' : 'S'} ${Math.abs(record.position.lon).toFixed(1)}°${record.position.lon >= 0 ? 'E' : 'W'} at ${Math.round(record.position.altKm)} km`,
    );
  else
    lines.push(
      record.objects.some((o) => o.hasElements)
        ? 'Not placed: an element set failed to propagate.'
        : 'Not placed yet: elements for these objects are still being fetched.',
    );
  lines.push(
    'A screening figure from public elements, not an operator’s assessment: operators see tracking data the public does not, and a probability of one is usually a stale element set.',
  );
  return lines.join('\n');
}

/**
 * Conjunctions — SOCRATES close approaches at the point they will happen.
 *
 * @param {object} options
 * @param {{fetchConjunctions: Function}} options.source
 * @param {object} [options.context] contextStore module.
 * @param {{set: Function, clear: Function}} [options.timers]
 */
export function createConjunctionsLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  timers = {
    set: (fn, ms) => globalThis.setTimeout(fn, ms),
    clear: (id) => globalThis.clearTimeout(id),
  },
  now = () => Date.now(),
} = {}) {
  if (typeof source?.fetchConjunctions !== 'function')
    throw new TypeError('Conjunctions layer requires a SOCRATES source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _abort = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;
  let _params = { show: DEFAULT_CONJUNCTION_FILTER };
  let _payload = null;
  let _retry = null;
  let _summary = summarizeConjunctions(
    parseConjunctions({ conjunctions: [] }, null, 0),
  );
  /** @type {Map<string, object>} */
  const _records = new Map();

  const selection = createLayerSelection({
    layerId: CONJUNCTIONS_LAYER_ID,
    layerName: 'Conjunctions',
    source: 'CelesTrak SOCRATES',
    entityPrefix: CONJUNCTIONS_ENTITY_PREFIX,
    context,
    getRecord: (id) => _records.get(id),
    getEntity: (id) => _dataSource?.entities.getById(entityId(id)),
    getDataSource: () => _dataSource,
    describe: (record) => ({
      label: conjunctionLabelText(record, now()),
      latitude: record.position?.lat ?? 0,
      longitude: record.position?.lon ?? 0,
      properties: {
        tca: record.tca,
        rangeKm: record.rangeKm,
        relativeSpeedKms: record.relativeSpeedKms,
        maxProbability: record.maxProbability,
        objects: record.objects.map((o) => `${o.noradId} ${o.name}`),
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
    _records.clear();
  }

  function clearRetry() {
    if (_retry != null) timers.clear(_retry);
    _retry = null;
  }

  function rebuild() {
    if (!_dataSource || !_payload) return;
    const filter = conjunctionFilterFor(_params.show);
    const records = parseConjunctions(_payload, filter, now());
    clearEntities();
    for (const record of records) {
      _records.set(record.id, record);
      if (!record.position) continue;
      const color = Cesium.Color.fromCssColorString(record.band.color);
      const { lat, lon, altKm } = record.position;
      const position = Cesium.Cartesian3.fromDegrees(lon, lat, altKm * 1000);
      const entity = _dataSource.entities.add({
        id: entityId(record.id),
        position,
        point: {
          pixelSize: 6 + record.band.rank * 3 + (record.crewed ? 2 : 0),
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        polyline: {
          // A stalk to the ground, so the spot it is over can be read.
          positions: [Cesium.Cartesian3.fromDegrees(lon, lat, 0), position],
          width: 1,
          material: color.withAlpha(0.35),
        },
      });
      entity.gevTrackedId = entityId(record.id);
      entity.gevDisplayPosition = () => position;
      entity.gevLabelModel = {
        title: `${record.objects[0].name} × ${record.objects[1].name}`,
        details: [],
        accent: record.band.color,
        cardStyle: 'tactical',
        selected: true,
      };
    }
    selection.reconcile();
    _summary = summarizeConjunctions(records);
  }

  async function refresh() {
    if (!_enabled) return false;
    clearRetry();
    _abort?.abort();
    _abort = new AbortController();
    try {
      const payload = await source.fetchConjunctions({
        signal: _abort.signal,
      });
      if (!_enabled) return false;
      _payload = payload;
      rebuild();
      _lastUpdate = now();
      _lastError = null;
      _viewer?.scene?.requestRender?.();
      notifyRowControls();
      // Elements still arriving at the proxy: ask again soon, not in a
      // quarter of an hour.
      if (_summary.pending > 0)
        _retry = timers.set(() => {
          _retry = null;
          void refresh();
        }, CONJUNCTIONS_PENDING_RETRY_MS);
      return true;
    } catch (error) {
      if (!_enabled) return false;
      console.warn('[Data:Conjunctions] load error:', error);
      _lastError = error?.message || 'Conjunctions unavailable';
      notifyRowControls();
      return false;
    }
  }

  const layer = {
    id: CONJUNCTIONS_LAYER_ID,
    name: 'Conjunctions',
    icon: '💥',
    source: 'CelesTrak SOCRATES',
    updateInterval: CONJUNCTIONS_UPDATE_MS,

    init(viewer) {
      if (_viewer)
        throw new Error(`${CONJUNCTIONS_LAYER_ID} already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(CONJUNCTIONS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:Conjunctions] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      // No fetch here: the manager calls update() once enable() settles.
      selection.install(viewer || _viewer);
    },

    disable() {
      _enabled = false;
      clearRetry();
      _abort?.abort();
      _abort = null;
      selection.clear();
      selection.remove();
      clearEntities();
      if (_dataSource) _dataSource.show = false;
      // _lastError survives a disable, as elsewhere: the manager disables a
      // layer whose first update failed, and the row must still say why.
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
      _payload = null;
    },

    /** Switch the filter; the body is re-cut, not re-fetched. */
    async setParams(params = {}) {
      const next = conjunctionFilterFor(params.show).key;
      if (next === _params.show) return false;
      _params = { ..._params, show: next };
      if (_enabled && _payload) {
        rebuild();
        _viewer?.scene?.requestRender?.();
      }
      notifyRowControls();
      return true;
    },

    getParams() {
      return { ..._params };
    },

    getRowControls() {
      const active = conjunctionFilterFor(_params.show).key;
      const legend = _summary.breakdown.map((entry) => ({
        label: `${entry.name} ×${entry.count}`,
        blurb: null,
      }));
      if (_summary.next) {
        const n = _summary.next;
        legend.unshift({
          label: `next ${untilText(n.tcaMs, now())}: ${n.objects[0].name} × ${n.objects[1].name}`,
          blurb: `${rangeText(n.rangeKm)} miss, SOCRATES maximum probability ${probabilityText(n.maxProbability)}`,
        });
      }
      if (_summary.pending > 0)
        legend.push({
          label: `${_summary.unplaced} not placed yet`,
          blurb:
            'CelesTrak serves elements one object at a time; the proxy is still fetching them.',
        });
      else if (_summary.unplaced > 0)
        legend.push({
          label: `${_summary.unplaced} not placed`,
          blurb: 'No elements on CelesTrak for one of the objects.',
        });
      return {
        chips: CONJUNCTION_FILTERS.map((filter) => ({
          id: filter.key,
          label: filter.chip,
          active: filter.key === active,
          title: `${filter.label} — ${filter.blurb}`,
          params: { show: filter.key },
        })),
        legend,
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const filter = conjunctionFilterFor(_params.show);
      return {
        count: _summary.count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _summary.count
          ? `${filter.chip} · ${_summary.count} in the week · worst ${_summary.worst}${_summary.pending ? ` · placing ${_summary.placed}/${_summary.count}` : ''}`
          : _lastError
            ? `${filter.chip} · unavailable`
            : `${filter.chip} · none kept`,
      };
    },

    getAnalystRecords() {
      return [..._records.values()].map((record) => ({
        id: record.id,
        layer: CONJUNCTIONS_LAYER_ID,
        kind: 'conjunction',
        label: `${record.objects[0].name} × ${record.objects[1].name} ${untilText(record.tcaMs, now())}`,
        lat: record.position?.lat ?? null,
        lon: record.position?.lon ?? null,
        detail: conjunctionLabelText(record, now()),
      }));
    },

    /** The latest body, for panels. */
    getConjunctions() {
      return _payload;
    },
  };
  return layer;
}
