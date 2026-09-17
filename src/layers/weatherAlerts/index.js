import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  SEVERITY_RANK,
  WEATHER_ALERTS_ENTITY_PREFIX,
  WEATHER_ALERTS_LAYER_ID,
  severityColor,
} from './policy.js';

export * from './policy.js';
export { createNwsAlertsSource } from './source.js';

const entityId = (id) => `${WEATHER_ALERTS_ENTITY_PREFIX}${id}`;

/** One line per useful field, for the readout card on click. */
function alertLabelText(alert) {
  const lines = [`${alert.event} · ${alert.severity}`];
  if (alert.area) lines.push(alert.area);
  const when = alert.expires
    ? `until ${alert.expires.replace('T', ' ').slice(0, 16)}`
    : '';
  const meta = [alert.urgency, when].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (alert.headline) lines.push(alert.headline);
  if (alert.instruction) lines.push(alert.instruction);
  else if (alert.description) lines.push(alert.description);
  if (alert.sender) lines.push(alert.sender);
  return lines.join('\n');
}

/**
 * Own the NWS weather-alert display: severity-coloured polygons for active
 * storm-based warnings, a readout card on click, refreshed on the layer's
 * update tick.
 *
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @param {object} [options.context] contextStore module (register/select/clear)
 * @param {(viewer:any) => Cesium.ScreenSpaceEventHandler} [options.screenSpaceEventHandlerFactory]
 */
export function createWeatherAlertsLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Weather alerts require a snapshot source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  let _count = 0;
  let _total = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _keyHandler = null;
  let _selectedId = null;
  /** @type {Map<string, object>} */
  const _alerts = new Map();

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _alerts.clear();
  }

  function rebuild(alerts) {
    if (!_dataSource) return;
    clearEntities();
    for (const alert of alerts) {
      _alerts.set(alert.id, alert);
      const color = Cesium.Color.fromCssColorString(
        severityColor(alert.severity),
      );
      const entity = _dataSource.entities.add({
        id: entityId(alert.id),
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(alert.rings[0].flat()),
          material: color.withAlpha(0.22),
          outline: true,
          outlineColor: color.withAlpha(0.9),
          outlineWidth: 2,
          height: 0,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      entity.gevTrackedId = entityId(alert.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(alert.lon, alert.lat, 0);
      entity.gevLabelModel = {
        title: `${alert.event} · ${alert.severity}`,
        details: [],
        accent: severityColor(alert.severity),
        cardStyle: 'tactical',
        selected: true,
      };
      // Extra rings of a multipolygon share the record but need their own shapes.
      for (let i = 1; i < alert.rings.length; i++) {
        _dataSource.entities.add({
          id: `${entityId(alert.id)}#${i}`,
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(
              alert.rings[i].flat(),
            ),
            material: color.withAlpha(0.22),
            outline: true,
            outlineColor: color.withAlpha(0.9),
            height: 0,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
      }
    }
    _count = _alerts.size;
  }

  function selectAlert(id) {
    const alert = _alerts.get(id);
    const entity = _dataSource?.entities.getById(entityId(id));
    if (!alert || !entity || !context) return false;
    _selectedId = id;
    try {
      context.registerEntityContext(entity, {
        id: entityId(id),
        layerId: WEATHER_ALERTS_LAYER_ID,
        layerName: 'Weather Alerts',
        source: alert.sender || 'US National Weather Service',
        dataSource: _dataSource,
        label: alertLabelText(alert),
        latitude: alert.lat,
        longitude: alert.lon,
        properties: {
          event: alert.event,
          severity: alert.severity,
          urgency: alert.urgency,
          area: alert.area,
          expires: alert.expires,
        },
      });
      context.selectEntityContext(entity);
    } catch {
      /* context store unavailable — polygons still render */
    }
    return true;
  }

  function clearSelection() {
    _selectedId = null;
    try {
      context?.clearSelectedEntityContextForLayer?.(WEATHER_ALERTS_LAYER_ID);
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
        pickedId.startsWith(WEATHER_ALERTS_ENTITY_PREFIX)
      ) {
        const id = pickedId
          .slice(WEATHER_ALERTS_ENTITY_PREFIX.length)
          .split('#')[0];
        if (_alerts.has(id)) {
          selectAlert(id);
          return;
        }
      }
      if (isOwnedByOtherLayer(WEATHER_ALERTS_LAYER_ID, pickedId)) return;
      if (_selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _keyHandler = (event) => {
      if (event.key === 'Escape' && _selectedId) clearSelection();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _keyHandler);
    registerPickOwner(
      WEATHER_ALERTS_LAYER_ID,
      (id) =>
        typeof id === 'string' && id.startsWith(WEATHER_ALERTS_ENTITY_PREFIX),
    );
  }

  function removeInput() {
    _clickHandler?.destroy();
    _clickHandler = null;
    if (_keyHandler && typeof document !== 'undefined')
      document.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
    unregisterPickOwner(WEATHER_ALERTS_LAYER_ID);
  }

  const layer = {
    id: WEATHER_ALERTS_LAYER_ID,
    name: 'Weather Alerts',
    icon: '⚠️',
    source: 'US NWS',
    updateInterval: 3 * 60 * 1000,

    init(viewer) {
      if (_viewer) throw new Error('Weather alerts already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('weather-alerts');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:WeatherAlerts] Initialized');
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
        const { alerts, total } = await source.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        rebuild(alerts);
        _total = total;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:WeatherAlerts] ${_count} polygons of ${_total} active alerts`,
        );
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:WeatherAlerts] Load error:', error);
        _lastError = error?.message || 'NWS alerts unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      this.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _alerts.clear();
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage:
          _total > _count
            ? `${_count} mapped · ${_total - _count} zone-only`
            : `${_count} active`,
      };
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, maxCount) : 2000;
      const out = [];
      for (const alert of _alerts.values()) {
        if (out.length >= limit) break;
        out.push({
          id: alert.id,
          event: alert.event,
          severity: alert.severity,
          rank: SEVERITY_RANK[alert.severity] ?? 0,
          area: alert.area,
          expires: alert.expires,
          lat: alert.lat,
          lon: alert.lon,
        });
      }
      return out;
    },
  };
  return layer;
}
