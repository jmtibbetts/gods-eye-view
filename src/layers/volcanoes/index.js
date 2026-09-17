import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  VOLCANOES_ENTITY_PREFIX,
  VOLCANOES_LAYER_ID,
  volcanoColor,
} from './policy.js';

export * from './policy.js';
export { createUsgsVolcanoSource } from './source.js';

const entityId = (id) => `${VOLCANOES_ENTITY_PREFIX}${id}`;

/** One line per useful field, for the readout card on click. */
function volcanoLabelText(volcano) {
  const lines = [`${volcano.name} · ${volcano.summary}`];
  if (Number.isFinite(volcano.elevationM))
    lines.push(`Summit ${volcano.elevationM} m`);
  if (volcano.observatory) lines.push(volcano.observatory);
  if (volcano.sentUtc) lines.push(`Notice ${volcano.sentUtc} UTC`);
  lines.push(
    'Aviation colour code is the ash hazard to aircraft; ground alert level is the hazard on the ground. They move independently.',
  );
  if (volcano.noticeUrl) lines.push(volcano.noticeUrl);
  return lines.join('\n');
}

/**
 * Own the USGS volcanic-alert display: one marker per volcano currently above
 * background, sized and coloured by aviation colour code, with a readout card
 * on click.
 *
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @param {object} [options.context] contextStore module (register/select/clear)
 * @param {(viewer:any) => Cesium.ScreenSpaceEventHandler} [options.screenSpaceEventHandlerFactory]
 */
export function createVolcanoesLayer({
  source,
  context = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Volcano alerts require a snapshot source');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  let _count = 0;
  let _total = 0;
  let _unplaced = [];
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _keyHandler = null;
  let _selectedId = null;
  /** @type {Map<string, object>} */
  const _volcanoes = new Map();

  function clearEntities() {
    if (_dataSource) _dataSource.entities.removeAll();
    _volcanoes.clear();
  }

  function rebuild(volcanoes) {
    if (!_dataSource) return;
    clearEntities();
    for (const volcano of volcanoes) {
      _volcanoes.set(volcano.id, volcano);
      const color = Cesium.Color.fromCssColorString(
        volcanoColor(volcano.colorCode),
      );
      const entity = _dataSource.entities.add({
        id: entityId(volcano.id),
        position: Cesium.Cartesian3.fromDegrees(volcano.lon, volcano.lat, 0),
        point: {
          pixelSize: 10 + volcano.colorRank * 2,
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entity.gevTrackedId = entityId(volcano.id);
      entity.gevDisplayPosition = () =>
        Cesium.Cartesian3.fromDegrees(volcano.lon, volcano.lat, 0);
      entity.gevLabelModel = {
        title: `${volcano.name} · ${volcano.colorCode}`,
        details: [],
        accent: volcanoColor(volcano.colorCode),
        cardStyle: 'tactical',
        selected: true,
      };
    }
    _count = _volcanoes.size;
  }

  function selectVolcano(id) {
    const volcano = _volcanoes.get(id);
    const entity = _dataSource?.entities.getById(entityId(id));
    if (!volcano || !entity || !context) return false;
    _selectedId = id;
    try {
      context.registerEntityContext(entity, {
        id: entityId(id),
        layerId: VOLCANOES_LAYER_ID,
        layerName: 'Volcano Alerts',
        source: volcano.observatory || 'USGS Volcano Hazards Program',
        dataSource: _dataSource,
        label: volcanoLabelText(volcano),
        latitude: volcano.lat,
        longitude: volcano.lon,
        properties: {
          vnum: volcano.vnum,
          colorCode: volcano.colorCode,
          alertLevel: volcano.alertLevel,
          observatory: volcano.observatoryAbbr,
          sent: volcano.sentUtc,
        },
      });
      context.selectEntityContext(entity);
    } catch {
      /* context store unavailable — markers still render */
    }
    return true;
  }

  function clearSelection() {
    _selectedId = null;
    try {
      context?.clearSelectedEntityContextForLayer?.(VOLCANOES_LAYER_ID);
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
        pickedId.startsWith(VOLCANOES_ENTITY_PREFIX)
      ) {
        const id = pickedId.slice(VOLCANOES_ENTITY_PREFIX.length);
        if (_volcanoes.has(id)) {
          selectVolcano(id);
          return;
        }
      }
      if (isOwnedByOtherLayer(VOLCANOES_LAYER_ID, pickedId)) return;
      if (_selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _keyHandler = (event) => {
      if (event.key === 'Escape' && _selectedId) clearSelection();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _keyHandler);
    registerPickOwner(
      VOLCANOES_LAYER_ID,
      (id) => typeof id === 'string' && id.startsWith(VOLCANOES_ENTITY_PREFIX),
    );
  }

  function removeInput() {
    _clickHandler?.destroy();
    _clickHandler = null;
    if (_keyHandler && typeof document !== 'undefined')
      document.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
    unregisterPickOwner(VOLCANOES_LAYER_ID);
  }

  const layer = {
    id: VOLCANOES_LAYER_ID,
    name: 'Volcano Alerts',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 10 * 60 * 1000,

    init(viewer) {
      if (_viewer) throw new Error('Volcano alerts already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('volcanoes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:Volcanoes] Initialized');
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
        const { volcanoes, total, unplaced } = await source.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        rebuild(volcanoes);
        _total = total;
        _unplaced = unplaced || [];
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Volcanoes] ${_count} of ${_total} placed`);
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Volcanoes] Load error:', error);
        _lastError = error?.message || 'USGS volcano alerts unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      this.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _volcanoes.clear();
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _unplaced.length
          ? `${_count} above background · ${_unplaced.length} unplaced`
          : _count
            ? `${_count} above background`
            : 'all quiet',
      };
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, maxCount) : 2000;
      const out = [];
      for (const volcano of _volcanoes.values()) {
        if (out.length >= limit) break;
        out.push({
          id: volcano.id,
          name: volcano.name,
          colorCode: volcano.colorCode,
          alertLevel: volcano.alertLevel,
          observatory: volcano.observatoryAbbr,
          lat: volcano.lat,
          lon: volcano.lon,
        });
      }
      return out;
    },
  };
  return layer;
}
