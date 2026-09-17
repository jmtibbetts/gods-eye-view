import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  SCANNER_CATALOG_REFRESH_MS,
  SCANNER_ENTITY_PREFIX,
  SCANNER_HISTORY_LIMIT,
  SCANNER_LAYER_ID,
  SCANNER_LIVE_POLL_MS,
  SCANNER_OVERLAY_COHORT_LIMIT,
  SCANNER_OVERLAY_COLLISION_CAPACITY,
  SCANNER_OVERLAY_SOURCE_ID,
  SCANNER_QUEUE_MAX_AGE_MS,
  SCANNER_RECENT_LIMIT,
  SCANNER_SELECTED_OVERLAY_SOURCE_ID,
  SCANNER_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';
import {
  createScannerOverlayEntry,
  createScannerSelectedOverlayEntry,
  mapScannerAnalystRecord,
  scannerColor,
  scannerPixelSize,
  scannerPlace,
  selectScannerOverlayCohort,
} from './model.js';
import { createScannerPlayer } from './player.js';

export * from './model.js';
export * from './policy.js';
export { createOpenMhzSource } from './source.js';
export { createScannerPlayer } from './player.js';

const entityId = (systemId) => `${SCANNER_ENTITY_PREFIX}${systemId}`;
const systemIdFromEntityId = (id) =>
  typeof id === 'string' && id.startsWith(SCANNER_ENTITY_PREFIX)
    ? id.slice(SCANNER_ENTITY_PREFIX.length)
    : null;

/**
 * Own the OpenMHz scanner display: one dot per recorded public-safety radio
 * system, and a scanner-style live session (queued clip playback) for the
 * selected system.
 *
 * @param {object} options
 * @param {{getSeed:Function,getSystems:Function,getTalkgroups:Function,getGroups:Function,getRecentCalls:Function,getNewerCalls:Function}} options.source
 * @param {{setEntries:Function,setVisible:Function,clearSource:Function}} options.overlayHost
 * @param {{registerEntityContext?:Function,selectEntityContext?:Function,clearSelectedEntityContextForLayer?:Function}} [options.context]
 * @param {() => HTMLAudioElement} [options.createAudio]
 * @param {() => number} [options.now]
 * @param {(viewer: any) => Cesium.ScreenSpaceEventHandler} [options.screenSpaceEventHandlerFactory]
 */
export function createScannerLayer({
  source,
  overlayHost,
  context = null,
  createAudio,
  now = () => Date.now(),
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  for (const method of [
    'getSeed',
    'getSystems',
    'getRecentCalls',
    'getNewerCalls',
  ])
    if (typeof source?.[method] !== 'function')
      throw new TypeError(`Scanner source must provide ${method}()`);
  if (!overlayHost) throw new TypeError('Scanner requires an overlay host');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  /** @type {Map<string, object>} id → system (seed merged with live activity) */
  const _systems = new Map();
  /** @type {Map<string, Cesium.Entity>} */
  const _entities = new Map();
  let _seedLoaded = false;
  let _liveCatalogAt = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _keyHandler = null;

  // ---- live session (selected system) ----
  let _selectedId = null;
  let _selectedEntity = null;
  let _session = null; // { id, abort, timer, labels, calls, newestMs, status }
  let _player = null;
  let _playerState = null;
  let _cardRaf = null;

  function ensurePlayer() {
    if (_player) return _player;
    _player = createScannerPlayer({
      ...(createAudio ? { createAudio } : {}),
      onChange(state) {
        _playerState = state;
        scheduleCard();
      },
    });
    return _player;
  }

  // ---- catalog ----
  function mergeSeed(rows) {
    for (const row of rows) {
      const prev = _systems.get(row.id);
      _systems.set(row.id, prev ? { ...row, ...activityOf(prev) } : row);
    }
    _seedLoaded = true;
  }

  const activityOf = (s) => ({
    active: s.active,
    lastActive: s.lastActive,
    callAvg: s.callAvg,
    clientCount: s.clientCount,
  });

  async function refreshLiveCatalog(signal) {
    const live = await source.getSystems({ signal });
    for (const [id, activity] of live) {
      const system = _systems.get(id);
      if (!system) continue; // unknown to the seed → no position → skip
      Object.assign(system, {
        active: activity.active,
        lastActive: activity.lastActive,
        callAvg: activity.callAvg,
        clientCount: activity.clientCount,
        name: activity.name || system.name,
        desc: activity.desc || system.desc,
      });
    }
    // Systems the live catalog no longer lists have gone quiet (>30 days).
    for (const system of _systems.values()) {
      if (!live.has(system.id)) {
        system.active = false;
        system.callAvg = 0;
      }
    }
    _liveCatalogAt = now();
  }

  function rebuildEntities() {
    if (!_dataSource) return;
    const overlayEntries = [];
    for (const system of _systems.values()) {
      const id = entityId(system.id);
      const position = Cesium.Cartesian3.fromDegrees(system.lon, system.lat);
      const color = Cesium.Color.fromCssColorString(scannerColor(system));
      let entity = _entities.get(system.id);
      if (!entity) {
        entity = _dataSource.entities.add({
          id,
          position,
          point: {
            pixelSize: scannerPixelSize(system),
            color: color.withAlpha(0.9),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { systemId: system.id },
        });
        _entities.set(system.id, entity);
      } else {
        entity.point.pixelSize = scannerPixelSize(system);
        entity.point.color = color.withAlpha(0.9);
      }
      if (_selectedId === system.id) entity.show = false;
      overlayEntries.push(createScannerOverlayEntry({ id, position, system }));
    }
    if (_enabled) {
      overlayHost.setEntries(
        SCANNER_OVERLAY_SOURCE_ID,
        selectScannerOverlayCohort(overlayEntries),
        {
          cohortLimit: SCANNER_OVERLAY_COHORT_LIMIT,
          collisionCapacity: SCANNER_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
  }

  // ---- selection + live session ----
  function scheduleCard() {
    if (_cardRaf != null) return;
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 0);
    _cardRaf = schedule(() => {
      _cardRaf = null;
      publishCard();
    });
  }

  function publishCard() {
    if (!_selectedId || !_enabled) return;
    const system = _systems.get(_selectedId);
    const entity = _entities.get(_selectedId);
    if (!system || !entity) return;
    const entry = createScannerSelectedOverlayEntry({
      id: entityId(system.id),
      position: entity.position.getValue(Cesium.JulianDate.now()),
      system,
      calls: _session?.calls ?? [],
      labels: _session?.labels ?? null,
      player: _playerState,
      status: _session?.status ?? null,
      now: now(),
    });
    overlayHost.setEntries(
      SCANNER_SELECTED_OVERLAY_SOURCE_ID,
      [entry],
      SCANNER_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
    overlayHost.setVisible(SCANNER_SELECTED_OVERLAY_SOURCE_ID, true);
  }

  function publishContext(system, entity) {
    if (!context?.registerEntityContext || !context?.selectEntityContext)
      return;
    try {
      context.registerEntityContext(entity, {
        id: entityId(system.id),
        layerId: SCANNER_LAYER_ID,
        layerName: 'Scanners',
        source: 'OpenMHz',
        dataSource: _dataSource,
        label: `${system.name} · ${scannerPlace(system)}`,
        latitude: system.lat,
        longitude: system.lon,
        properties: {
          system: system.id,
          callsPerMinute: system.callAvg,
          listeners: system.clientCount,
        },
      });
      context.selectEntityContext(entity);
    } catch {
      /* context store unavailable — the card still works */
    }
  }

  function selectSystem(systemId) {
    if (!_enabled) return false;
    const system = _systems.get(systemId);
    const entity = _entities.get(systemId);
    if (!system || !entity || !_viewer) return false;
    clearSelection({ keepPlayerSeen: false });
    _selectedId = systemId;
    entity.show = false;
    const position = entity.position.getValue(Cesium.JulianDate.now());
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: 15,
        color: Cesium.Color.CYAN,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    publishContext(system, entity);
    startSession(system);
    publishCard();
    return true;
  }

  function clearSelection() {
    stopSession();
    if (_selectedId) {
      const entity = _entities.get(_selectedId);
      if (entity) entity.show = true;
    }
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    _selectedId = null;
    overlayHost.clearSource(SCANNER_SELECTED_OVERLAY_SOURCE_ID);
    try {
      context?.clearSelectedEntityContextForLayer?.(SCANNER_LAYER_ID);
    } catch {
      /* ignore */
    }
  }

  function startSession(system) {
    const abort = new AbortController();
    const session = {
      id: system.id,
      abort,
      timer: null,
      labels: new Map(),
      calls: [],
      newestMs: 0,
      status: 'loading',
      polling: false,
    };
    _session = session;
    const player = ensurePlayer();
    player.reset();

    const labelsPromise = Promise.all([
      typeof source.getTalkgroups === 'function'
        ? source
            .getTalkgroups(system.id, { signal: abort.signal })
            .catch(() => new Map())
        : new Map(),
      typeof source.getGroups === 'function'
        ? source
            .getGroups(system.id, { signal: abort.signal })
            .catch(() => new Map())
        : new Map(),
    ]).then(([talkgroups, groups]) => {
      if (_session !== session) return;
      for (const [num, label] of talkgroups)
        session.labels.set(num, { ...label, group: groups.get(num) || null });
      for (const [num, group] of groups)
        if (!session.labels.has(num))
          session.labels.set(num, { alpha: '', description: '', group });
      scheduleCard();
    });

    source
      .getRecentCalls(system.id, { signal: abort.signal })
      .then(async (calls) => {
        if (_session !== session) return;
        const desc = calls.slice().sort((a, b) => b.time - a.time);
        session.calls = desc.slice(0, SCANNER_RECENT_LIMIT);
        session.newestMs = desc[0]?.time ?? now() - 60_000;
        session.status = 'live';
        // History is listed; only the freshest clips are worth hearing now.
        const cutoff = now() - SCANNER_QUEUE_MAX_AGE_MS;
        const fresh = desc.filter((c) => c.time >= cutoff).reverse();
        player.markSeen(desc.filter((c) => c.time < cutoff));
        player.enqueue(fresh.slice(-3));
        await labelsPromise;
        scheduleCard();
        armPoll(session);
      })
      .catch((error) => {
        if (_session !== session || abort.signal.aborted) return;
        session.status = 'error';
        _lastError = error?.message || 'OpenMHz unavailable';
        scheduleCard();
        armPoll(session);
      });
  }

  function armPoll(session) {
    if (_session !== session || session.timer) return;
    session.timer = setInterval(
      () => pollSession(session),
      SCANNER_LIVE_POLL_MS,
    );
  }

  async function pollSession(session) {
    if (_session !== session || session.polling) return;
    session.polling = true;
    try {
      const since = session.newestMs || now() - 60_000;
      const calls = await source.getNewerCalls(session.id, since, {
        signal: session.abort.signal,
      });
      if (_session !== session) return;
      if (calls.length) {
        const asc = calls.slice().sort((a, b) => a.time - b.time);
        session.newestMs = Math.max(session.newestMs, asc[asc.length - 1].time);
        session.calls = [...asc.slice().reverse(), ...session.calls].slice(
          0,
          Math.max(SCANNER_HISTORY_LIMIT, SCANNER_RECENT_LIMIT),
        );
        ensurePlayer().enqueue(asc);
      }
      session.status = 'live';
      _lastError = null;
      scheduleCard();
    } catch (error) {
      if (_session !== session || session.abort.signal.aborted) return;
      session.status = 'error';
      scheduleCard();
    } finally {
      session.polling = false;
    }
  }

  function stopSession() {
    const session = _session;
    _session = null;
    if (!session) return;
    session.abort.abort();
    if (session.timer) clearInterval(session.timer);
    _player?.stop();
  }

  // ---- input ----
  function installInput(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      const systemId = systemIdFromEntityId(pickedId);
      if (systemId && _systems.has(systemId)) {
        if (systemId === _selectedId) _player?.toggle();
        else selectSystem(systemId);
        return;
      }
      if (picked && _selectedEntity && picked.id === _selectedEntity) {
        _player?.toggle();
        return;
      }
      if (isOwnedByOtherLayer(SCANNER_LAYER_ID, pickedId)) return;
      if (_selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _keyHandler = (event) => {
      if (event.key === 'Escape' && _selectedId) clearSelection();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _keyHandler);
    registerPickOwner(
      SCANNER_LAYER_ID,
      (id) => typeof id === 'string' && id.startsWith(SCANNER_ENTITY_PREFIX),
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
    unregisterPickOwner(SCANNER_LAYER_ID);
  }

  const layer = {
    id: SCANNER_LAYER_ID,
    name: 'Scanners',
    icon: '📻',
    source: 'OpenMHz',
    updateInterval: 5 * 60 * 1000,

    init(viewer) {
      if (_viewer) throw new Error('Scanner layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('scanner');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(SCANNER_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(SCANNER_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Scanner] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(SCANNER_OVERLAY_SOURCE_ID, true);
      installInput(viewer || _viewer);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      clearSelection();
      removeInput();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(SCANNER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(SCANNER_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(SCANNER_SELECTED_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const seed = _seedLoaded
          ? null
          : await source.getSeed({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        if (seed) mergeSeed(seed);
        rebuildEntities();
        _lastUpdate = now();
        if (
          _liveCatalogAt === 0 ||
          now() - _liveCatalogAt >= SCANNER_CATALOG_REFRESH_MS
        ) {
          try {
            await refreshLiveCatalog(request.signal);
            if (request.signal.aborted || _request !== request || !_enabled)
              return false;
            rebuildEntities();
            _lastError = null;
          } catch (error) {
            if (request.signal.aborted) return false;
            // The seed already painted; a live-catalog miss only stales activity.
            console.warn('[Data:Scanner] Live catalog unavailable:', error);
            _lastError = 'OpenMHz catalog unavailable';
          }
        }
        console.log(`[Data:Scanner] ${_systems.size} systems`);
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Scanner] Load error:', error);
        _lastError = error?.message || 'Scanner catalog unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      this.disable();
      _player?.destroy();
      _player = null;
      _playerState = null;
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _entities.clear();
      _systems.clear();
      _seedLoaded = false;
      _liveCatalogAt = 0;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      const live = _selectedId ? _systems.get(_selectedId) : null;
      const active = [..._systems.values()].filter((s) => s.callAvg > 0).length;
      return {
        count: _systems.size,
        countLabel: _systems.size ? `${active}/${_systems.size}` : undefined,
        lastUpdate: _lastUpdate,
        error: _lastError,
        loadingLabel: live
          ? `${_playerState?.paused ? 'PAUSED' : 'LIVE'} · ${live.name}`
          : undefined,
      };
    },

    // ---- programmatic / voice surface ----
    /** Select a system by id (returns false when unknown or disabled). */
    selectScannerSystem: selectSystem,
    stopScanner() {
      clearSelection();
    },
    toggleScannerPlayback() {
      if (!_selectedId) return false;
      ensurePlayer().toggle();
      return true;
    },
    setScannerVolume(value) {
      ensurePlayer().setVolume(value);
    },
    getSelectedScannerSystem() {
      return _selectedId ? { ..._systems.get(_selectedId) } : null;
    },
    /** Rank systems for a free-text query ("chicago police", "king county"). */
    findScannerSystems(query, limit = 5) {
      const q = String(query || '')
        .toLowerCase()
        .trim();
      if (!q) return [];
      const terms = q.split(/\s+/);
      const scored = [];
      for (const s of _systems.values()) {
        const hay =
          `${s.name} ${scannerPlace(s)} ${s.desc || ''} ${s.id}`.toLowerCase();
        const hits = terms.filter((t) => hay.includes(t)).length;
        if (hits) scored.push([hits * 10 + Math.min(9, s.callAvg), s]);
      }
      return scored
        .sort((a, b) => b[0] - a[0])
        .slice(0, limit)
        .map(([, s]) => ({ ...s }));
    },
    getScannerUIState() {
      return Object.freeze({
        enabled: _enabled,
        systems: _systems.size,
        selected: _selectedId,
        session: _session
          ? { status: _session.status, calls: _session.calls.length }
          : null,
        player: _playerState,
      });
    },
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const out = [];
      for (const system of _systems.values()) {
        if (out.length >= limit) break;
        out.push(mapScannerAnalystRecord(system, out.length));
      }
      return out;
    },
  };
  return layer;
}
