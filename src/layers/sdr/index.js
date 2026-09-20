import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { chooseMarineListen, marineRefusalText } from './marine.js';
import {
  SDR_ENTITY_PREFIX,
  SDR_LAYER_ID,
  SDR_OVERLAY_COHORT_LIMIT,
  SDR_OVERLAY_COLLISION_CAPACITY,
  SDR_OVERLAY_SOURCE_ID,
  SDR_SELECTED_OVERLAY_SOURCE_ID,
  SDR_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';
import {
  createSdrOverlayEntry,
  createSdrSelectedOverlayEntry,
  mapSdrAnalystRecord,
  sdrColor,
  sdrCoversFrequency,
  sdrTunedUrl,
  sdrTypeLabel,
} from './model.js';
import { createMarkerField } from '../../data/markerField.js';

export * from './model.js';
export * from './policy.js';
export { createBundledSdrSource } from './source.js';

const entityId = (receiverId) => `${SDR_ENTITY_PREFIX}${receiverId}`;
const receiverIdFromEntityId = (id) =>
  typeof id === 'string' && id.startsWith(SDR_ENTITY_PREFIX)
    ? id.slice(SDR_ENTITY_PREFIX.length)
    : null;

/**
 * Own the web-SDR receiver display: one dot per public receiver, a detail
 * card on select, and a hand-off to the receiver's own page (tuned when a
 * frequency is set) on a second click.
 *
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @param {{setEntries:Function,setVisible:Function,clearSource:Function}} options.overlayHost
 * @param {{registerEntityContext?:Function,selectEntityContext?:Function,clearSelectedEntityContextForLayer?:Function}} [options.context]
 * @param {(url: string) => void} [options.openUrl] Receiver hand-off (defaults to a new tab).
 * @param {(viewer: any) => Cesium.ScreenSpaceEventHandler} [options.screenSpaceEventHandlerFactory]
 * @param {{cachedGroundFloor?: Function, warmGroundFloor?: Function}|null} [options.ground]
 */
export function createSdrLayer({
  source,
  overlayHost,
  context = null,
  openUrl,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  ground = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SDR layer requires a snapshot source');
  if (!overlayHost) throw new TypeError('SDR layer requires an overlay host');

  let open =
    openUrl ||
    ((url) => {
      if (typeof window === 'undefined') return;
      const tab = window.open(url, '_blank', 'noopener,noreferrer');
      if (tab) tab.opener = null;
    });

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  /** @type {Map<string, object>} */
  const _receivers = new Map();
  /** @type {Map<string, Cesium.Entity>} */
  const _entities = new Map();
  let _loaded = false;
  /** @type {Promise<void>|null} In-flight directory load shared by update() and ensureSdrDirectory(). */
  let _loading = null;
  let _builtAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _keyHandler = null;
  let _selectedId = null;
  let _selectedEntity = null;
  /** @type {{freqHz:number, mode:string}|null} Pending tune applied on hand-off. */
  let _tune = null;
  const _field = createMarkerField({ ground });
  const _overlayEntries = new Map();
  let _viewTimer = null;
  let _viewTicks = 0;
  /** @type {Set<(state: object) => void>} */
  const _listeners = new Set();
  let _notifyTimer = null;

  function notify() {
    if (_notifyTimer != null || !_listeners.size) return;
    _notifyTimer = setTimeout(() => {
      _notifyTimer = null;
      const state = layer.getSdrUIState();
      for (const listener of _listeners) {
        try {
          listener(state);
        } catch (error) {
          console.warn('[Data:SDR] listener failed:', error);
        }
      }
    }, 0);
  }

  function rebuildEntities() {
    if (!_dataSource) return;
    _overlayEntries.clear();
    for (const receiver of _receivers.values()) {
      const id = entityId(receiver.id);
      let entity = _entities.get(receiver.id);
      if (!entity) {
        const color = Cesium.Color.fromCssColorString(sdrColor(receiver));
        entity = _dataSource.entities.add({
          id,
          position: _field.positionFor(receiver.lat, receiver.lon),
          point: {
            pixelSize: receiver.bands ? 8 : 7,
            color: color.withAlpha(0.88),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(
              100_000,
              1.15,
              12_000_000,
              1,
            ),
          },
          properties: { receiverId: receiver.id },
        });
        _entities.set(receiver.id, entity);
        _field.track(receiver.id, entity, receiver.lat, receiver.lon);
      }
      _overlayEntries.set(
        receiver.id,
        createSdrOverlayEntry({
          id,
          position: () => entity.position.getValue(Cesium.JulianDate.now()),
          receiver,
        }),
      );
    }
    _field.setHidden(_selectedId);
    _field.warm([..._receivers.values()]);
    refreshView({ force: true });
  }

  /** Horizon-cull the dots and label the visible receivers nearest the camera. */
  function refreshView({ force = false } = {}) {
    if (!_enabled || !_viewer?.camera) return;
    _viewTicks++;
    if (_viewTicks % 8 === 0 && _field.reposition() > 0) force = true;
    const visible = _field.cull(_viewer.camera, { force });
    if (!visible) return;
    const cohort = [];
    for (const id of visible) {
      const entry = _overlayEntries.get(id);
      if (entry) cohort.push(entry);
      if (cohort.length >= SDR_OVERLAY_COHORT_LIMIT) break;
    }
    overlayHost.setEntries(SDR_OVERLAY_SOURCE_ID, cohort, {
      cohortLimit: SDR_OVERLAY_COHORT_LIMIT,
      collisionCapacity: SDR_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
  }

  function publishCard() {
    notify();
    if (!_selectedId || !_enabled) return;
    const receiver = _receivers.get(_selectedId);
    const entity = _entities.get(_selectedId);
    if (!receiver || !entity) return;
    overlayHost.setEntries(
      SDR_SELECTED_OVERLAY_SOURCE_ID,
      [
        createSdrSelectedOverlayEntry({
          id: entityId(receiver.id),
          position: entity.position.getValue(Cesium.JulianDate.now()),
          receiver,
          tune: _tune,
        }),
      ],
      SDR_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
    overlayHost.setVisible(SDR_SELECTED_OVERLAY_SOURCE_ID, true);
  }

  function publishContext(receiver, entity) {
    if (!context?.registerEntityContext || !context?.selectEntityContext)
      return;
    try {
      context.registerEntityContext(entity, {
        id: entityId(receiver.id),
        layerId: SDR_LAYER_ID,
        layerName: 'SDR Receivers',
        source: 'Web SDR directory',
        dataSource: _dataSource,
        label: `${receiver.name} · ${sdrTypeLabel(receiver)}`,
        latitude: receiver.lat,
        longitude: receiver.lon,
        properties: {
          url: receiver.url,
          software: receiver.type,
          bandLowHz: receiver.bands?.[0] ?? null,
          bandHighHz: receiver.bands?.[1] ?? null,
        },
      });
      context.selectEntityContext(entity);
    } catch {
      /* context store unavailable — the card still works */
    }
  }

  function selectReceiver(receiverId) {
    if (!_enabled) return false;
    const receiver = _receivers.get(receiverId);
    const entity = _entities.get(receiverId);
    if (!receiver || !entity || !_viewer) return false;
    clearSelection();
    _selectedId = receiverId;
    _field.setHidden(receiverId);
    _selectedEntity = _viewer.entities.add({
      position: entity.position.getValue(Cesium.JulianDate.now()),
      point: {
        pixelSize: 15,
        color: Cesium.Color.CYAN,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    // The selection is published on the visible marker, not the field dot it
    // replaces: the field dot is hidden while selected, and the context store
    // drops a selection whose entity is not shown. The dot keeps the id tag
    // so a scan of visible entities still resolves it to the same record.
    publishContext(receiver, _selectedEntity || entity);
    if (_selectedEntity?.__gevContextId)
      entity.__gevContextId = _selectedEntity.__gevContextId;
    publishCard();
    return true;
  }

  function clearSelection() {
    _selectedId = null;
    _field.setHidden(null);
    refreshView({ force: true });
    notify();
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    overlayHost.clearSource(SDR_SELECTED_OVERLAY_SOURCE_ID);
    try {
      context?.clearSelectedEntityContextForLayer?.(SDR_LAYER_ID);
    } catch {
      /* ignore */
    }
  }

  function openSelected() {
    const receiver = _selectedId ? _receivers.get(_selectedId) : null;
    if (!receiver) return null;
    const url = sdrTunedUrl(receiver, _tune || {});
    open(url, {
      kind: 'sdr',
      layerId: SDR_LAYER_ID,
      title: receiver.name,
      subtitle: _tune
        ? `${(_tune.freqHz / 1e6).toFixed(3)} MHz ${String(_tune.mode).toUpperCase()} · ${sdrTypeLabel(receiver)}`
        : sdrTypeLabel(receiver),
      receiver,
    });
    return url;
  }

  /** Load the bundled directory once, with or without the layer enabled. */
  function loadDirectory(signal) {
    if (_loaded) return Promise.resolve();
    if (_loading) return _loading;
    _loading = (async () => {
      try {
        const { rows, builtAt } = await source.getSnapshot({ signal });
        for (const row of rows) _receivers.set(row.id, row);
        _builtAt = builtAt;
        _loaded = true;
      } finally {
        _loading = null;
      }
    })();
    return _loading;
  }

  function distanceKm(lat, lon, r) {
    const toRad = Math.PI / 180;
    const dLat = (r.lat - lat) * toRad;
    const dLon = (r.lon - lon) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat * toRad) * Math.cos(r.lat * toRad) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  function installInput(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      const receiverId = receiverIdFromEntityId(pickedId);
      if (receiverId && _receivers.has(receiverId)) {
        if (receiverId === _selectedId) openSelected();
        else selectReceiver(receiverId);
        return;
      }
      if (picked && _selectedEntity && picked.id === _selectedEntity) {
        openSelected();
        return;
      }
      if (isOwnedByOtherLayer(SDR_LAYER_ID, pickedId)) return;
      if (_selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _keyHandler = (event) => {
      if (!_selectedId) return;
      if (event.key === 'Escape') clearSelection();
      else if (event.key === 'Enter' && !event.repeat) openSelected();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _keyHandler);
    registerPickOwner(
      SDR_LAYER_ID,
      (id) => typeof id === 'string' && id.startsWith(SDR_ENTITY_PREFIX),
    );
  }

  function removeInput() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_keyHandler && typeof document !== 'undefined')
      document.removeEventListener('keydown', _keyHandler);
    _keyHandler = null;
    unregisterPickOwner(SDR_LAYER_ID);
  }

  const layer = {
    id: SDR_LAYER_ID,
    name: 'SDR Receivers',
    icon: '📡',
    source: 'Web SDR directory',
    updateInterval: 6 * 60 * 60 * 1000,

    init(viewer) {
      if (_viewer) throw new Error('SDR layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('sdr');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(SDR_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(SDR_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:SDR] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(SDR_OVERLAY_SOURCE_ID, true);
      installInput(viewer || _viewer);
      if (!_viewTimer) _viewTimer = setInterval(() => refreshView(), 250);
      refreshView({ force: true });
      notify();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_viewTimer) clearInterval(_viewTimer);
      _viewTimer = null;
      clearSelection();
      removeInput();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(SDR_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(SDR_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(SDR_SELECTED_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        if (!_loaded) {
          await loadDirectory(request.signal);
          if (request.signal.aborted || _request !== request || !_enabled)
            return false;
        }
        rebuildEntities();
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        console.log(`[Data:SDR] ${_receivers.size} receivers`);
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SDR] Load error:', error);
        _lastError = error?.message || 'SDR directory unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      this.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _listeners.clear();
      if (_notifyTimer != null) clearTimeout(_notifyTimer);
      _notifyTimer = null;
      _entities.clear();
      _field.clear();
      _overlayEntries.clear();
      _receivers.clear();
      _loaded = false;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _tune = null;
    },

    getStats() {
      const selected = _selectedId ? _receivers.get(_selectedId) : null;
      return {
        count: _receivers.size,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _builtAt ? `snapshot ${_builtAt}` : undefined,
        loadingLabel: selected
          ? `${sdrTypeLabel(selected)} · ${selected.name}`
          : undefined,
      };
    },

    // ---- programmatic / voice surface ----
    /** Swap the receiver hand-off (the shell installs the in-map dock here). */
    setSdrUrlOpener(fn) {
      if (typeof fn === 'function') open = fn;
    },
    /** Resolve once the directory is in memory (does not enable the layer). */
    ensureSdrDirectory() {
      return loadDirectory();
    },
    /**
     * One-click listen: pick the nearest receiver that covers the frequency
     * and open it tuned. Selects it on the globe when the layer is enabled.
     * @param {{freqHz:number, mode?:string, lat:number, lon:number, maxKm?:number}} query
     * @returns {Promise<{receiver:object, url:string}|null>}
     */
    async listenSdr({ freqHz, mode = 'am', lat, lon, maxKm = Infinity } = {}) {
      await loadDirectory();
      const [best] = layer.findSdrReceivers({
        lat,
        lon,
        freqHz,
        coveredOnly: true,
        limit: 1,
      });
      if (!best || !(best.distanceKm <= maxKm)) return null;
      layer.setSdrTune({ freqHz, mode });
      if (_enabled && _entities.has(best.id)) {
        selectReceiver(best.id);
        return { receiver: best, url: openSelected() };
      }
      const url = sdrTunedUrl(best, { freqHz, mode });
      open(url, {
        kind: 'sdr',
        layerId: SDR_LAYER_ID,
        title: best.name,
        subtitle: `${(freqHz / 1e6).toFixed(3)} MHz ${String(mode).toUpperCase()} · ${sdrTypeLabel(best)}`,
        receiver: best,
      });
      return { receiver: best, url };
    },
    /**
     * Open whatever can actually hear a ship at this position.
     *
     * Tries Channel 16 first and falls back through the HF marine bands, so a
     * ship off a covered coast gets the traffic people mean by marine radio
     * and a ship mid-ocean gets the band that carries that far — rather than
     * a receiver tuned to a frequency it cannot possibly hear.
     *
     * @param {{lat: number, lon: number}} position
     * @returns {Promise<{receiver: object, band: object, url: string}|
     *   {receiver: null, band: null, reason: string}>}
     */
    async listenMarineNear({ lat, lon } = {}) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        return { receiver: null, band: null, reason: 'no position' };
      await loadDirectory();
      const outcome = chooseMarineListen({
        receiversFor: (band) =>
          layer.findSdrReceivers({
            lat,
            lon,
            freqHz: band.freqHz,
            coveredOnly: true,
            limit: 1,
          }),
      });
      if (!outcome.band)
        return {
          receiver: null,
          band: null,
          reason: marineRefusalText(outcome),
        };
      const result = await layer.listenSdr({
        freqHz: outcome.band.freqHz,
        mode: outcome.band.mode,
        lat,
        lon,
        maxKm: outcome.band.maxKm,
      });
      if (!result)
        return {
          receiver: null,
          band: null,
          reason: marineRefusalText(outcome),
        };
      return { ...result, band: outcome.band };
    },
    selectSdrReceiver: selectReceiver,
    clearSdrSelection() {
      clearSelection();
    },
    /** Open the selected receiver (tuned when a frequency is set). Returns the URL used. */
    openSelectedSdrReceiver: openSelected,
    /**
     * Set (or clear) the frequency applied on hand-off.
     * @param {{freqHz?: number, mode?: string}|null} tune
     */
    setSdrTune(tune) {
      _tune =
        tune && Number.isFinite(tune.freqHz) && tune.freqHz > 0
          ? { freqHz: tune.freqHz, mode: tune.mode || 'am' }
          : null;
      publishCard();
      return _tune;
    },
    getSelectedSdrReceiver() {
      return _selectedId ? { ..._receivers.get(_selectedId) } : null;
    },
    /**
     * Nearest receivers to a point, optionally only those covering a
     * frequency. Receivers with no published range pass the frequency
     * filter unless `coveredOnly` is set.
     * @param {{lat:number, lon:number, freqHz?:number, type?:string, coveredOnly?:boolean, limit?:number}} query
     */
    findSdrReceivers({
      lat,
      lon,
      freqHz,
      type,
      coveredOnly = false,
      limit = 5,
    } = {}) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const out = [];
      for (const r of _receivers.values()) {
        if (type && r.type !== type) continue;
        if (Number.isFinite(freqHz)) {
          const covers = sdrCoversFrequency(r, freqHz);
          if (covers === false || (coveredOnly && covers !== true)) continue;
        }
        out.push([distanceKm(lat, lon, r), r]);
      }
      return out
        .sort((a, b) => a[0] - b[0])
        .slice(0, Math.max(1, limit))
        .map(([km, r]) => ({ ...r, distanceKm: Math.round(km) }));
    },
    getSdrUIState() {
      const selected = _selectedId ? _receivers.get(_selectedId) : null;
      return Object.freeze({
        enabled: _enabled,
        receivers: _receivers.size,
        selected: _selectedId,
        selectedReceiver: selected ? { ...selected } : null,
        tune: _tune,
        tunedUrl: selected ? sdrTunedUrl(selected, _tune || {}) : null,
        error: _lastError,
      });
    },
    /** Change notifications for panels; returns an unsubscribe function. */
    subscribeSdr(listener) {
      if (typeof listener !== 'function') return () => {};
      _listeners.add(listener);
      try {
        listener(layer.getSdrUIState());
      } catch {
        /* listener's problem */
      }
      return () => _listeners.delete(listener);
    },
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const out = [];
      for (const receiver of _receivers.values()) {
        if (out.length >= limit) break;
        out.push(mapSdrAnalystRecord(receiver, out.length));
      }
      return out;
    },
  };
  return layer;
}
