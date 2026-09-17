import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  KIND_LABELS,
  KIND_RANK,
  STORM_REPORTS_ENTITY_PREFIX,
  STORM_REPORTS_LAYER_ID,
  kindColor,
} from './policy.js';

export * from './policy.js';
export { createSpcStormReportsSource } from './source.js';

const entityId = (id) => `${STORM_REPORTS_ENTITY_PREFIX}${id}`;

/** One line per useful field, for the readout card on click. */
function reportLabelText(report) {
  const lines = [
    `${KIND_LABELS[report.kind] || report.kind} · ${report.magnitudeText}`,
  ];
  const place = [
    report.location,
    report.county && `${report.county} Co.`,
    report.state,
  ]
    .filter(Boolean)
    .join(', ');
  if (place) lines.push(place);
  const when = report.time ? `${report.time}Z` : '';
  const meta = [when, report.day].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (report.comments) lines.push(report.comments);
  lines.push('Preliminary — subject to NWS review');
  return lines.join('\n');
}

/**
 * Own the NOAA SPC storm-report display: colour-coded points for preliminary
 * tornado, hail and damaging-wind reports over a rolling two-day window, with
 * a readout card on click.
 *
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @param {object} [options.context] contextStore module (register/select/clear)
 * @param {(viewer:any) => Cesium.ScreenSpaceEventHandler} [options.screenSpaceEventHandlerFactory]
 */
export function createStormReportsLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Storm reports require a snapshot source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  let _count = 0;
  let _byKind = {};
  let _days = [];
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _keyHandler = null;
  let _selectedId = null;
  /** @type {Map<string, object>} */
  const _reports = new Map();

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _reports.clear();
  }

  function rebuild(reports) {
    if (!_dataSource) return;
    clearEntities();
    for (const report of reports) {
      _reports.set(report.id, report);
      const color = Cesium.Color.fromCssColorString(kindColor(report.kind));
      const entity = _dataSource.entities.add({
        id: entityId(report.id),
        position: Cesium.Cartesian3.fromDegrees(report.lon, report.lat, 0),
        point: {
          pixelSize: (KIND_RANK[report.kind] || 1) >= 3 ? 12 : 8,
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entity.gevTrackedId = entityId(report.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(report.lon, report.lat, 0);
      entity.gevLabelModel = {
        title: `${KIND_LABELS[report.kind] || report.kind} · ${report.magnitudeText}`,
        details: [],
        accent: kindColor(report.kind),
        cardStyle: 'tactical',
        selected: true,
      };
    }
    _count = _reports.size;
  }

  function selectReport(id) {
    const report = _reports.get(id);
    const entity = _dataSource?.entities.getById(entityId(id));
    if (!report || !entity || !context) return false;
    _selectedId = id;
    try {
      context.registerEntityContext(entity, {
        id: entityId(id),
        layerId: STORM_REPORTS_LAYER_ID,
        layerName: 'Storm Reports',
        source: 'NOAA Storm Prediction Center',
        dataSource: _dataSource,
        label: reportLabelText(report),
        latitude: report.lat,
        longitude: report.lon,
        properties: {
          kind: report.kind,
          magnitude: report.magnitudeText,
          location: report.location,
          county: report.county,
          state: report.state,
          time: report.time,
          day: report.day,
        },
      });
      context.selectEntityContext(entity);
    } catch {
      /* context store unavailable — points still render */
    }
    return true;
  }

  function clearSelection() {
    _selectedId = null;
    try {
      context?.clearSelectedEntityContextForLayer?.(STORM_REPORTS_LAYER_ID);
    } catch {
      /* ignore */
    }
  }

  function installInput(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      if (
        typeof pickedId === 'string' &&
        pickedId.startsWith(STORM_REPORTS_ENTITY_PREFIX)
      ) {
        const id = pickedId.slice(STORM_REPORTS_ENTITY_PREFIX.length);
        if (_reports.has(id)) {
          selectReport(id);
          return;
        }
      }
      if (isOwnedByOtherLayer(STORM_REPORTS_LAYER_ID, pickedId)) return;
      if (_selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _keyHandler = (event) => {
      if (event.key === 'Escape' && _selectedId) clearSelection();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _keyHandler);
    registerPickOwner(
      STORM_REPORTS_LAYER_ID,
      (id) =>
        typeof id === 'string' && id.startsWith(STORM_REPORTS_ENTITY_PREFIX),
    );
  }

  function removeInput() {
    _clickHandler?.destroy();
    _clickHandler = null;
    if (_keyHandler && typeof document !== 'undefined')
      document.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
    unregisterPickOwner(STORM_REPORTS_LAYER_ID);
  }

  const layer = {
    id: STORM_REPORTS_LAYER_ID,
    name: 'Storm Reports',
    icon: '🌪️',
    source: 'NOAA SPC',
    updateInterval: 5 * 60 * 1000,

    init(viewer) {
      if (_viewer) throw new Error('Storm reports already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('storm-reports');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:StormReports] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      installInput(viewer || _viewer);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      clearSelection();
      removeInput();
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const { reports, byKind, days } = await source.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        rebuild(reports);
        _byKind = byKind || {};
        _days = days || [];
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:StormReports] ${_count} reports over ${_days.length} day(s)`,
        );
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:StormReports] Load error:', error);
        _lastError = error?.message || 'SPC reports unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      this.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _reports.clear();
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      const parts = [];
      for (const kind of ['tornado', 'wind', 'hail'])
        if (_byKind[kind]) parts.push(`${KIND_LABELS[kind]} ${_byKind[kind]}`);
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: parts.length ? parts.join(' · ') : 'no reports filed',
      };
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, maxCount) : 2000;
      const out = [];
      for (const report of _reports.values()) {
        if (out.length >= limit) break;
        out.push({
          id: report.id,
          kind: report.kind,
          magnitude: report.magnitudeText,
          location: report.location,
          state: report.state,
          time: report.time,
          lat: report.lat,
          lon: report.lon,
        });
      }
      return out;
    },
  };
  return layer;
}
