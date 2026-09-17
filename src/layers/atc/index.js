import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  ATC_ENTITY_PREFIX,
  ATC_FOLLOW_POLL_MS,
  ATC_LAYER_ID,
  ATC_OVERLAY_COHORT_LIMIT,
  ATC_OVERLAY_COLLISION_CAPACITY,
  ATC_OVERLAY_SOURCE_ID,
  ATC_PHASES,
  ATC_POSITIONS,
  ATC_SDR_RANGE_KM,
  ATC_SELECTED_OVERLAY_SOURCE_ID,
  ATC_SELECTED_OVERLAY_SOURCE_OPTIONS,
  ATC_UNTOWERED_DRAW_DISTANCE_M,
  liveAtcAirportUrl,
} from './policy.js';
import {
  atcColor,
  atcContactFromContext,
  atcFacilityName,
  atcFollowTarget,
  atcFrequencyFor,
  atcMhzText,
  atcNearestAirports,
  atcPlaceText,
  createAtcOverlayEntry,
  createAtcSelectedOverlayEntry,
  mapAtcAnalystRecord,
} from './model.js';
import { createMarkerField } from '../../data/markerField.js';

export * from './model.js';
export * from './policy.js';
export { createBundledAtcSource } from './source.js';

const entityId = (airportId) => `${ATC_ENTITY_PREFIX}${airportId}`;
const airportIdFromEntityId = (id) =>
  typeof id === 'string' && id.startsWith(ATC_ENTITY_PREFIX)
    ? id.slice(ATC_ENTITY_PREFIX.length)
    : null;

const TRACKED_LAYERS = new Set(['flights', 'military']);

/**
 * Own the ATC display: one dot per airport with published frequencies, a
 * frequency card on select, a listen hand-off (an airband web SDR in range,
 * tuned inside the map, or LiveATC's own page), and a follow engine that
 * moves the listen target between Ground, Tower, Approach/Departure and
 * Center as the selected aircraft moves.
 *
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @param {{setEntries:Function,setVisible:Function,clearSource:Function}} options.overlayHost
 * @param {object} [options.context] contextStore module (register/select/clear + getSelectedEntityContext)
 * @param {(url: string, meta: object) => void} [options.openUrl] Listen hand-off (defaults to a new tab).
 * @param {(query: {lat:number, lon:number, freqHz:number, maxKm:number}) => Promise<{receiver:object, url:string}|null>} [options.findSdr]
 *   Airband web-SDR lookup; null when none covers the frequency in range.
 * @param {(viewer: any) => Cesium.ScreenSpaceEventHandler} [options.screenSpaceEventHandlerFactory]
 * @param {{cachedGroundFloor?: Function, warmGroundFloor?: Function}|null} [options.ground]
 * @param {EventTarget} [options.eventTarget] Where tracked-subject events arrive (window).
 */
export function createAtcLayer({
  source,
  overlayHost,
  context = null,
  openUrl,
  findSdr = null,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  ground = null,
  eventTarget = typeof window !== 'undefined' ? window : null,
  onAnnotationChange = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('ATC layer requires a snapshot source');
  if (!overlayHost) throw new TypeError('ATC layer requires an overlay host');

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
  const _airports = new Map();
  /** @type {Map<string, object>} FAA LID → airport (US only). */
  const _byFaa = new Map();
  /** @type {object[]} */
  let _centers = [];
  /** @type {Map<string, Cesium.Entity>} */
  const _entities = new Map();
  let _loaded = false;
  /** @type {Promise<void>|null} In-flight directory load shared by update() and ensureAtcDirectory(). */
  let _loading = null;
  let _builtAt = null;
  let _cycle = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _keyHandler = null;
  let _selectedId = null;
  let _selectedEntity = null;
  /** The position the operator asked for at the selected airport. */
  let _selectedPosition = 'TWR';
  /** @type {{airport:object, position:string, frequency:object, via:string, url:string, receiver:object|null, center:object|null}|null} */
  let _listening = null;
  let _listenSeq = 0;
  /** Follow-the-plane engine. */
  let _follow = false;
  let _followTimer = null;
  let _followContact = null;
  let _followPhase = null;
  let _followLastAlt = null;
  let _followLastAt = 0;
  let _followKey = null;
  let _toweredCount = 0;
  let _subjectHandler = null;
  let _subjectClearedHandler = null;
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
      const state = layer.getAtcUIState();
      for (const listener of _listeners) {
        try {
          listener(state);
        } catch (error) {
          console.warn('[Data:ATC] listener failed:', error);
        }
      }
    }, 0);
  }

  function rebuildEntities() {
    if (!_dataSource) return;
    _overlayEntries.clear();
    for (const airport of _airports.values()) {
      const id = entityId(airport.id);
      let entity = _entities.get(airport.id);
      if (!entity) {
        const color = Cesium.Color.fromCssColorString(atcColor(airport));
        entity = _dataSource.entities.add({
          id,
          position: _field.positionFor(airport.lat, airport.lon),
          point: {
            pixelSize: airport.towered ? (airport.hours === '24' ? 8 : 7) : 5,
            color: color.withAlpha(airport.towered ? 0.9 : 0.7),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: airport.towered ? 1.5 : 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(
              100_000,
              1.15,
              12_000_000,
              1,
            ),
            distanceDisplayCondition: airport.towered
              ? undefined
              : new Cesium.DistanceDisplayCondition(
                  0,
                  ATC_UNTOWERED_DRAW_DISTANCE_M,
                ),
          },
          properties: { airportId: airport.id },
        });
        _entities.set(airport.id, entity);
        _field.track(airport.id, entity, airport.lat, airport.lon);
      }
      _overlayEntries.set(
        airport.id,
        createAtcOverlayEntry({
          id,
          position: () => entity.position.getValue(Cesium.JulianDate.now()),
          airport,
        }),
      );
    }
    _field.setHidden(_selectedId);
    _field.warm(
      [..._airports.values()].filter((a) => a.towered).slice(0, 1500),
    );
    refreshView({ force: true });
  }

  /** Horizon-cull the dots and label the visible fields nearest the camera. */
  function refreshView({ force = false } = {}) {
    if (!_enabled || !_viewer?.camera) return;
    _viewTicks++;
    if (_viewTicks % 8 === 0 && _field.reposition() > 0) force = true;
    const visible = _field.cull(_viewer.camera, { force });
    if (!visible) return;
    const heightM = _viewer.camera.positionCartographic?.height ?? 0;
    const labelUntowered = heightM < ATC_UNTOWERED_DRAW_DISTANCE_M * 0.6;
    const cohort = [];
    for (const id of visible) {
      const entry = _overlayEntries.get(id);
      if (!entry) continue;
      if (!labelUntowered && !_airports.get(id)?.towered) continue;
      cohort.push(entry);
      if (cohort.length >= ATC_OVERLAY_COHORT_LIMIT) break;
    }
    overlayHost.setEntries(ATC_OVERLAY_SOURCE_ID, cohort, {
      cohortLimit: ATC_OVERLAY_COHORT_LIMIT,
      collisionCapacity: ATC_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
  }

  function publishCard() {
    notify();
    if (!_selectedId || !_enabled) return;
    const airport = _airports.get(_selectedId);
    const entity = _entities.get(_selectedId);
    if (!airport || !entity) return;
    overlayHost.setEntries(
      ATC_SELECTED_OVERLAY_SOURCE_ID,
      [
        createAtcSelectedOverlayEntry({
          id: entityId(airport.id),
          position: entity.position.getValue(Cesium.JulianDate.now()),
          airport,
          listening:
            _listening && _listening.airport.id === airport.id
              ? _listening
              : null,
        }),
      ],
      ATC_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
    overlayHost.setVisible(ATC_SELECTED_OVERLAY_SOURCE_ID, true);
  }

  function publishContext(airport, entity) {
    if (!context?.registerEntityContext || !context?.selectEntityContext)
      return;
    try {
      const properties = {
        place: atcPlaceText(airport),
        towered: airport.towered ? 'yes' : 'no',
        towerHours: airport.hours || '',
        radioCall: airport.call || '',
        liveAtcUrl: liveAtcAirportUrl(airport.id),
      };
      for (const f of airport.freqs) {
        if (f.secondary) continue;
        const key = f.position.toLowerCase();
        if (!properties[key]) properties[key] = atcMhzText(f.mhz);
      }
      context.registerEntityContext(entity, {
        id: entityId(airport.id),
        layerId: ATC_LAYER_ID,
        layerName: 'ATC',
        source: 'FAA NASR / OurAirports',
        dataSource: _dataSource,
        label: `${airport.id} · ${airport.name}`,
        latitude: airport.lat,
        longitude: airport.lon,
        properties,
      });
      context.selectEntityContext(entity);
    } catch {
      /* context store unavailable — the card still works */
    }
  }

  function selectAirport(airportId, { position } = {}) {
    if (!_enabled) return false;
    const airport = _airports.get(airportId);
    const entity = _entities.get(airportId);
    if (!airport || !entity || !_viewer) return false;
    clearSelection({ keepListening: true });
    _selectedId = airportId;
    if (position && ATC_POSITIONS.includes(position))
      _selectedPosition = position;
    else if (!atcFrequencyFor(airport, _selectedPosition))
      _selectedPosition = airport.towered ? 'TWR' : 'CTAF';
    _field.setHidden(airportId);
    _selectedEntity = _viewer.entities.add({
      position: entity.position.getValue(Cesium.JulianDate.now()),
      point: {
        pixelSize: 15,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    publishContext(airport, entity);
    publishCard();
    return true;
  }

  function clearSelection({ keepListening = false } = {}) {
    _selectedId = null;
    _field.setHidden(null);
    refreshView({ force: true });
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    overlayHost.clearSource(ATC_SELECTED_OVERLAY_SOURCE_ID);
    try {
      context?.clearSelectedEntityContextForLayer?.(ATC_LAYER_ID);
    } catch {
      /* ignore */
    }
    if (!keepListening) {
      _listening = null;
      _listenSeq++;
    }
    notify();
  }

  /**
   * Resolve where to listen for a facility and hand off. An airband SDR
   * inside the map wins when one covers the frequency in range; LiveATC's
   * airport page is the fallback.
   */
  async function listenTo({
    airport,
    position,
    frequency,
    center = null,
    reason = 'user',
  }) {
    if (!airport && !center) return null;
    const seq = ++_listenSeq;
    const mhz = frequency?.mhz ?? null;
    const anchor = center || airport;
    let sdr = null;
    if (findSdr && Number.isFinite(mhz)) {
      try {
        sdr = await findSdr({
          lat: anchor.lat,
          lon: anchor.lon,
          freqHz: Math.round(mhz * 1e6),
          maxKm: ATC_SDR_RANGE_KM,
        });
      } catch (error) {
        console.warn('[Data:ATC] SDR lookup failed:', error);
      }
    }
    if (seq !== _listenSeq || !_enabled) return null;
    const via = sdr?.url ? 'sdr' : 'liveatc';
    const url = sdr?.url || liveAtcAirportUrl(airport?.id || '');
    const facility = center
      ? `${center.artcc || center.name} Center`
      : atcFacilityName(airport, position);
    const target = {
      airport: airport || null,
      center,
      position,
      frequency: frequency || null,
      via,
      url,
      receiver: sdr?.receiver || null,
      facility,
      reason,
      at: Date.now(),
    };
    const same =
      _listening &&
      _listening.url === target.url &&
      _listening.frequency?.mhz === target.frequency?.mhz;
    _listening = target;
    publishCard();
    if (!same || reason === 'user') {
      open(url, {
        kind: via,
        layerId: ATC_LAYER_ID,
        title: facility,
        subtitle: Number.isFinite(mhz)
          ? `${atcMhzText(mhz)} MHz AM${sdr?.receiver ? ` · via ${sdr.receiver.name}` : ''}`
          : sdr?.receiver?.name || '',
        note:
          via === 'liveatc'
            ? `Press LISTEN on LiveATC's page for ${atcMhzText(mhz)} MHz.`
            : 'Audio starts on the receiver; click inside its page if it stays silent.',
      });
    }
    notify();
    return target;
  }

  /** Load the bundled directory once, with or without the layer enabled. */
  function loadDirectory(signal) {
    if (_loaded) return Promise.resolve();
    if (_loading) return _loading;
    _loading = (async () => {
      try {
        const snapshot = await source.getSnapshot({ signal });
        for (const airport of snapshot.airports) {
          _airports.set(airport.id, airport);
          if (airport.country === 'US' && airport.faa)
            _byFaa.set(airport.faa, airport);
        }
        _centers = snapshot.centers || [];
        _toweredCount = snapshot.airports.reduce(
          (n, a) => n + (a.towered ? 1 : 0),
          0,
        );
        _builtAt = snapshot.builtAt;
        _cycle = snapshot.cycle;
        _loaded = true;
        try {
          onAnnotationChange?.();
        } catch {
          /* the readout refreshes on its own poll regardless */
        }
      } finally {
        _loading = null;
      }
    })();
    return _loading;
  }

  function listenSelected(position = _selectedPosition) {
    const airport = _selectedId ? _airports.get(_selectedId) : null;
    if (!airport) return null;
    const frequency = atcFrequencyFor(airport, position);
    _selectedPosition = position;
    return listenTo({
      airport,
      position: frequency?.position || position,
      frequency,
    });
  }

  // ---- follow the selected aircraft ----
  function readFollowContact() {
    const record = context?.getSelectedEntityContext?.();
    if (!record || !TRACKED_LAYERS.has(record.layerId)) return null;
    return atcContactFromContext(record);
  }

  function followTick() {
    if (!_follow || !_enabled || !_loaded) return;
    const contact = readFollowContact();
    if (!contact) {
      if (_followContact) {
        _followContact = null;
        _followPhase = null;
        notify();
      }
      return;
    }
    const now = Date.now();
    if (
      _followContact?.id === contact.id &&
      Number.isFinite(_followLastAlt) &&
      Number.isFinite(contact.altitudeFt) &&
      now - _followLastAt > 5_000
    ) {
      const minutes = (now - _followLastAt) / 60_000;
      contact.verticalFpm = (contact.altitudeFt - _followLastAlt) / minutes;
    }
    if (Number.isFinite(contact.altitudeFt)) {
      _followLastAlt = contact.altitudeFt;
      _followLastAt = now;
    }
    _followContact = contact;
    const target = atcFollowTarget(contact, {
      airports: _airports,
      byFaa: _byFaa,
      centers: _centers,
    });
    _followPhase = target.phase;
    const key = `${target.center?.id || target.airport?.id || ''}|${target.position}|${target.frequency?.mhz ?? ''}`;
    if (key !== _followKey) {
      _followKey = key;
      if (target.frequency)
        listenTo({ ...target, reason: 'follow' }).catch(() => {});
    }
    notify();
  }

  function setFollow(active) {
    const next = Boolean(active);
    if (next === _follow) return _follow;
    _follow = next;
    _followKey = null;
    _followContact = null;
    _followPhase = null;
    if (_followTimer) clearInterval(_followTimer);
    _followTimer = null;
    if (_follow && _enabled) {
      _followTimer = setInterval(followTick, ATC_FOLLOW_POLL_MS);
      followTick();
    }
    notify();
    return _follow;
  }

  function installSubjectListeners() {
    if (!eventTarget?.addEventListener || _subjectHandler) return;
    _subjectHandler = (event) => {
      if (!TRACKED_LAYERS.has(event?.detail?.layerId)) return;
      _followKey = null;
      if (_follow) setTimeout(followTick, 50);
      try {
        onAnnotationChange?.();
      } catch {
        /* ignore */
      }
    };
    _subjectClearedHandler = (event) => {
      if (!TRACKED_LAYERS.has(event?.detail?.layerId)) return;
      _followContact = null;
      _followPhase = null;
      _followKey = null;
      notify();
    };
    eventTarget.addEventListener(
      'gev:awareness-subject-selected',
      _subjectHandler,
    );
    eventTarget.addEventListener(
      'gev:awareness-subject-cleared',
      _subjectClearedHandler,
    );
  }

  function removeSubjectListeners() {
    if (!eventTarget?.removeEventListener) return;
    if (_subjectHandler)
      eventTarget.removeEventListener(
        'gev:awareness-subject-selected',
        _subjectHandler,
      );
    if (_subjectClearedHandler)
      eventTarget.removeEventListener(
        'gev:awareness-subject-cleared',
        _subjectClearedHandler,
      );
    _subjectHandler = null;
    _subjectClearedHandler = null;
  }

  function installInput(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      const airportId = airportIdFromEntityId(pickedId);
      if (airportId && _airports.has(airportId)) {
        if (airportId === _selectedId) listenSelected();
        else selectAirport(airportId);
        return;
      }
      if (picked && _selectedEntity && picked.id === _selectedEntity) {
        listenSelected();
        return;
      }
      if (isOwnedByOtherLayer(ATC_LAYER_ID, pickedId)) return;
      if (_selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _keyHandler = (event) => {
      if (!_selectedId) return;
      if (event.key === 'Escape') clearSelection();
      else if (event.key === 'Enter' && !event.repeat) listenSelected();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _keyHandler);
    registerPickOwner(
      ATC_LAYER_ID,
      (id) => typeof id === 'string' && id.startsWith(ATC_ENTITY_PREFIX),
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
    unregisterPickOwner(ATC_LAYER_ID);
  }

  const layer = {
    id: ATC_LAYER_ID,
    name: 'ATC',
    icon: '🛫',
    source: 'FAA NASR / OurAirports',
    updateInterval: 6 * 60 * 60 * 1000,

    init(viewer) {
      if (_viewer) throw new Error('ATC layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('atc');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(ATC_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(ATC_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:ATC] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(ATC_OVERLAY_SOURCE_ID, true);
      installInput(viewer || _viewer);
      installSubjectListeners();
      if (!_viewTimer) _viewTimer = setInterval(() => refreshView(), 250);
      if (_follow && !_followTimer)
        _followTimer = setInterval(followTick, ATC_FOLLOW_POLL_MS);
      refreshView({ force: true });
      notify();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_viewTimer) clearInterval(_viewTimer);
      _viewTimer = null;
      if (_followTimer) clearInterval(_followTimer);
      _followTimer = null;
      _followContact = null;
      _followPhase = null;
      _followKey = null;
      _listening = null;
      _listenSeq++;
      clearSelection();
      removeInput();
      removeSubjectListeners();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(ATC_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ATC_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(ATC_SELECTED_OVERLAY_SOURCE_ID, false);
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
        if (_follow) followTick();
        notify();
        console.log(
          `[Data:ATC] ${_airports.size} airports, ${_centers.length} center sites`,
        );
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:ATC] Load error:', error);
        _lastError = error?.message || 'ATC directory unavailable';
        notify();
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
      _airports.clear();
      _byFaa.clear();
      _centers = [];
      _loaded = false;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _follow = false;
    },

    getStats() {
      const selected = _selectedId ? _airports.get(_selectedId) : null;
      return {
        count: _airports.size,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: _cycle
          ? `FAA NASR ${_cycle.match(/\d{4}-\d{2}-\d{2}/)?.[0] || ''} + OurAirports`
          : _builtAt
            ? `snapshot ${_builtAt}`
            : undefined,
        loadingLabel: _listening
          ? `${_listening.facility} ${atcMhzText(_listening.frequency?.mhz)}`
          : selected
            ? `${selected.id} · ${selected.name}`
            : undefined,
      };
    },

    // ---- programmatic / voice surface ----
    /** Swap the listen hand-off (the shell installs the in-map dock here). */
    setAtcUrlOpener(fn) {
      if (typeof fn === 'function') open = fn;
    },
    /** Resolve once the directory is in memory (does not enable the layer). */
    ensureAtcDirectory() {
      return loadDirectory();
    },
    selectAtcAirport: selectAirport,
    clearAtcSelection() {
      clearSelection();
    },
    /** Listen to a position at the selected airport (or a named one). */
    async listenAtc({ airportId, position } = {}) {
      if (airportId && airportId !== _selectedId) {
        const id = String(airportId).toUpperCase();
        const resolved = _airports.has(id)
          ? id
          : _byFaa.get(id)?.id || (_airports.has(`K${id}`) ? `K${id}` : null);
        if (!resolved || !selectAirport(resolved, { position })) return null;
      }
      return listenSelected(
        position && ATC_POSITIONS.includes(position)
          ? position
          : _selectedPosition,
      );
    },
    /** Stop reporting a listen target (the dock closes through the shell). */
    stopAtc() {
      _listening = null;
      _listenSeq++;
      publishCard();
      notify();
    },
    setAtcFollow: setFollow,
    getAtcListening() {
      return _listening ? { ..._listening } : null;
    },
    getSelectedAtcAirport() {
      return _selectedId ? { ..._airports.get(_selectedId) } : null;
    },
    /**
     * Nearest airports to a point, optionally towered only and filtered by text.
     * @param {{lat:number, lon:number, query?:string, toweredOnly?:boolean, limit?:number}} query
     */
    findAtcAirports({ lat, lon, query, toweredOnly, limit = 12 } = {}) {
      return atcNearestAirports(_airports.values(), {
        lat,
        lon,
        query,
        toweredOnly: Boolean(toweredOnly),
        limit,
      });
    },
    /**
     * A compact "controller frequency" line for the currently selected
     * tracked aircraft, for the readout card. Loads the directory on first
     * use so a plain click identifies the frequency even with the ATC dots
     * off. Returns null when nothing is selected or no VHF frequency applies.
     * @returns {string|null}
     */
    contactAnnotationText() {
      const record = context?.getSelectedEntityContext?.();
      if (!record || !TRACKED_LAYERS.has(record.layerId)) return null;
      if (!_loaded) {
        loadDirectory().catch(() => {});
        return null;
      }
      const contact = atcContactFromContext(record);
      if (!contact || !Number.isFinite(contact.lat)) return null;
      const target = atcFollowTarget(contact, {
        airports: _airports,
        byFaa: _byFaa,
        centers: _centers,
      });
      if (target.center)
        return target.frequency
          ? `ATC ${target.center.artcc || target.center.name} Center ${atcMhzText(target.frequency.mhz)}`
          : `ATC ${target.center.artcc || target.center.name} Center`;
      if (!target.airport || !target.frequency) return null;
      return `ATC ${atcFacilityName(target.airport, target.position)} ${atcMhzText(target.frequency.mhz)}`;
    },
    /** Resolve the controller a contact would be talking to right now. */
    atcTargetForContact(contact) {
      if (!contact || !Number.isFinite(contact.lat)) return null;
      return atcFollowTarget(contact, {
        airports: _airports,
        byFaa: _byFaa,
        centers: _centers,
      });
    },
    getAtcUIState() {
      const selected = _selectedId ? _airports.get(_selectedId) : null;
      return Object.freeze({
        enabled: _enabled,
        loaded: _loaded,
        airports: _airports.size,
        towered: _toweredCount,
        selected: _selectedId,
        selectedAirport: selected ? { ...selected } : null,
        selectedPosition: _selectedPosition,
        listening: _listening ? { ..._listening } : null,
        follow: Object.freeze({
          active: _follow,
          contact: _followContact ? { ..._followContact } : null,
          phase: _followPhase,
          phaseLabel: _followPhase ? ATC_PHASES[_followPhase].label : null,
        }),
        error: _lastError,
      });
    },
    /** Change notifications for panels; returns an unsubscribe function. */
    subscribeAtc(listener) {
      if (typeof listener !== 'function') return () => {};
      _listeners.add(listener);
      try {
        listener(layer.getAtcUIState());
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
      for (const airport of _airports.values()) {
        if (out.length >= limit) break;
        if (!airport.towered) continue;
        out.push(mapAtcAnalystRecord(airport, out.length));
      }
      return out;
    },
  };
  return layer;
}
