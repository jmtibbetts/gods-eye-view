import * as Cesium from 'cesium';
import { marineFeedListingFor } from './audioPanels.js';

/**
 * INSPECT — the selected thing and what the app can do for it, in one place.
 *
 * Click a plane and the card on the map names its controller frequency;
 * until now LISTEN was two sections away and FOLLOW PLANE in a third. Click
 * a satellite and its products were in IMAGERY; click a ship and whether it
 * is sanctioned was in VESSEL WATCH. The app already knew, for everything it
 * lets you select, what could be heard, watched, drawn and pinned for it. This
 * section puts those actions beside the object they belong to.
 *
 * It renders from the selection the app already keeps — the shared context
 * store every layer publishes its click into — so it adds no second notion
 * of "selected". Actions come from a small registry keyed by layer, and an
 * action only appears when the service behind it is present and says it can
 * act: nothing here promises what the app cannot do.
 *
 * Verbs are the ones the rest of the rail uses. LISTEN plays sound in the
 * dock, WATCH plays video, SHOW draws on the globe, GO TO moves the camera,
 * FOLLOW retunes as a plane moves, PIN adds to the WATCHLIST, and PANEL ›
 * opens the section that owns the deeper controls.
 */

/** How often live values (an aircraft's altitude, the frequency it is on) are re-read. */
const POLL_MS = 1500;
/** Camera height for GO TO when the current view is too far out to keep. */
const GOTO_DEFAULT_HEIGHT_M = 60_000;
const GOTO_MAX_HEIGHT_M = 150_000;
const GOTO_MIN_HEIGHT_M = 1_500;
const MAX_LINES = 9;
const TRACKED_LAYERS = new Set(['flights', 'military', 'satellites']);
const AIRCRAFT_LAYERS = new Set(['flights', 'military']);
const ISS_NORAD = 25544;

/** What the header calls the selected thing — the kind, not the source. */
const KICKERS = Object.freeze({
  flights: 'AIRCRAFT',
  military: 'MILITARY AIRCRAFT',
  satellites: 'SATELLITE',
  'ais-live-vessels': 'VESSEL',
  atc: 'AIRPORT',
  sdr: 'RECEIVER',
  scanner: 'SCANNER SYSTEM',
  tfr: 'FLIGHT RESTRICTION',
  conjunctions: 'CLOSE APPROACH',
  satnogs: 'GROUND STATION',
  'alpr-cameras': 'PLATE READER',
  'military-installations': 'INSTALLATION',
  'local-firms': 'FIRE DETECTION',
  'weather-alerts': 'WEATHER ALERT',
  'storm-reports': 'STORM REPORT',
  volcanoes: 'VOLCANO',
  'tropical-cyclones': 'TROPICAL SYSTEM',
  'aviation-hazards': 'AVIATION HAZARD',
  'river-flood': 'RIVER GAUGE',
  'air-quality': 'AIR QUALITY',
  lightning: 'LIGHTNING',
  drought: 'DROUGHT',
  'severe-outlook': 'SEVERE OUTLOOK',
  'conflict-reports': 'CONFLICT REPORTING',
});

/** Property keys that repeat the title or carry no reading. */
const SKIP_PROPERTY_KEYS = new Set([
  'name',
  'label',
  'id',
  'page',
  'url',
  'liveAtcUrl',
]);

/** "0–30 MHz", "118–137 MHz", "24 MHz–1.8 GHz" from a pair of hertz. */
function bandText(lowHz, highHz) {
  const low = Number(lowHz);
  const high = Number(highHz);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return '';
  const unitOf = (hz) => (hz >= 1e9 ? 'GHz' : hz >= 1e6 ? 'MHz' : 'kHz');
  const scale = { GHz: 1e9, MHz: 1e6, kHz: 1e3 };
  const number = (hz, unit) => {
    const value = hz / scale[unit];
    return value.toFixed(Number.isInteger(value) ? 0 : 1);
  };
  const highUnit = unitOf(high);
  // The floor of a band is spoken in the ceiling's unit when it fits ("0–30
  // MHz", not "0 kHz–30 MHz"); a real change of unit is spelled out.
  const lowUnit =
    low === 0 || unitOf(low) === highUnit ? highUnit : unitOf(low);
  return lowUnit === highUnit
    ? `${number(low, highUnit)}–${number(high, highUnit)} ${highUnit}`
    : `${number(low, lowUnit)} ${lowUnit}–${number(high, highUnit)} ${highUnit}`;
}

/** Values that are plainly an ISO-8601 instant, not prose that starts with digits. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const MONTHS = Object.freeze([
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
]);

/**
 * An instant a person can read: the UTC stamp the rest of the app speaks in,
 * plus how far off it is while that is the useful part. A raw
 * "2026-09-20T06:15:00-04:00" is what the feed said, not what the reader
 * asked; an alert's value is almost always "how long have I got".
 *
 * @param {string} value An ISO-8601 instant.
 * @param {number} [now]
 * @returns {string} The readable form, or '' when it does not parse.
 */
export function instantText(value, now = Date.now()) {
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  const stamp = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${sameYear ? '' : ' ' + d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  const deltaMs = ms - now;
  const away = Math.abs(deltaMs);
  if (away > 7 * 86_400_000) return stamp;
  const minutes = Math.round(away / 60_000);
  const span =
    minutes < 60
      ? `${minutes} min`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} h ${minutes % 60 ? (minutes % 60) + ' min' : ''}`.trim()
        : `${Math.round(minutes / 1440)} d`;
  return `${stamp} · ${deltaMs >= 0 ? `in ${span}` : `${span} ago`}`;
}

/**
 * Layers whose flat properties read better as a sentence than as a list.
 * Everything else falls through to "KEY value" lines.
 */
const LINE_READERS = Object.freeze({
  cctv(p) {
    // The operator is already the card's source line; repeating it here is
    // how the old panels read, and it is what this section is fixing.
    const feed = String(p.feed || '').toLowerCase();
    return [
      p.place || '',
      feed ? (/mp4|hls|webm/.test(feed) ? 'VIDEO FEED' : 'STILL FRAMES') : '',
    ];
  },
  'ais-live-vessels'(p) {
    const speed = Number(p.speedKt);
    const direction = Number.isFinite(Number(p.heading))
      ? Number(p.heading)
      : Number(p.course);
    const destination = String(p.destination || '').trim();
    return [
      [
        String(p.typeName || '').trim() || 'VESSEL',
        Number.isFinite(speed) ? `${speed.toFixed(1)} KT` : '',
        Number.isFinite(direction) ? `${Math.round(direction)}°` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      destination ? `→ ${destination}` : '',
      p.mmsi ? `MMSI ${p.mmsi}` : '',
    ];
  },
  sdr(p) {
    const band = bandText(p.bandLowHz, p.bandHighHz);
    return [band ? `COVERS ${band}` : ''];
  },
  scanner(p) {
    const calls = Number(p.callsPerMinute);
    const listeners = Number(p.listeners);
    return [
      Number.isFinite(calls) ? `${calls.toFixed(1)} CALLS / MIN` : '',
      Number.isFinite(listeners) ? `${listeners} LISTENING NOW` : '',
    ];
  },
  atc(p) {
    const positions = ['twr', 'gnd', 'app', 'dep', 'ctaf', 'atis', 'unicom'];
    const freqs = positions
      .filter((key) => p[key])
      .map((key) => `${key.toUpperCase()} ${p[key]}`);
    return [
      p.place || '',
      freqs.join(' · '),
      p.towered === 'yes'
        ? `TOWERED${p.towerHours ? ` · ${p.towerHours === '24' ? '24 H' : p.towerHours}` : ''}`
        : 'NO TOWER',
      p.radioCall ? `CALL "${p.radioCall}"` : '',
    ];
  },
});

/** "AIRCRAFT" for a flights record, the layer's own name otherwise. */
export function inspectKicker(record) {
  if (!record) return '';
  return (
    KICKERS[record.layerId] ||
    String(record.layerName || record.layerId || '')
      .trim()
      .toUpperCase()
  );
}

/** A property key as a readout label: `speedKt` → "SPEED KT", `noradId` → "NORAD ID". */
function propertyLabel(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * The card lines for a selection: the layer's own label model when it drew
 * one, its flat properties otherwise. Tracked aircraft and satellites keep
 * their card on the viewer's tracked entity rather than the context record,
 * so the tracked entity is consulted first for those.
 *
 * @param {object|null} record Context-store record.
 * @param {object} [options]
 * @param {object|null} [options.trackedEntity] `viewer.trackedEntity`.
 * @param {string|null} [options.annotation] An extra line (the ATC controller).
 * @returns {{title: string, lines: string[]}}
 */
export function inspectLines(
  record,
  { trackedEntity = null, annotation = null } = {},
) {
  if (!record) return { title: '', lines: [] };
  const tracked = TRACKED_LAYERS.has(record.layerId);
  const model =
    (tracked ? trackedEntity?.gevLabelModel : null) ||
    record.entity?.gevLabelModel ||
    null;
  const title = String(model?.title || record.label || record.id || '').trim();
  let lines = [];
  if (Array.isArray(model?.details) && model.details.length) {
    lines = model.details.map((line) => String(line).trim()).filter(Boolean);
  } else if (LINE_READERS[record.layerId]) {
    lines = LINE_READERS[record.layerId](record.properties || {}).filter(
      Boolean,
    );
  } else {
    const properties = record.properties || {};
    for (const [key, value] of Object.entries(properties)) {
      if (SKIP_PROPERTY_KEYS.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') continue;
      const raw = String(value).trim();
      if (!raw || /^https?:\/\//i.test(raw)) continue;
      // A property that only repeats the title is not a second fact.
      if (raw.toLowerCase() === title.toLowerCase()) continue;
      const text = ISO_INSTANT.test(raw) ? instantText(raw) || raw : raw;
      lines.push(`${propertyLabel(key)} ${text}`);
    }
  }
  if (annotation && !lines.includes(annotation)) lines.push(annotation);
  return { title, lines: lines.slice(0, MAX_LINES) };
}

/**
 * The actions the app can take for a selection, given what its services can
 * do right now. Pure: it names actions and the capability each needs, and
 * the panel binds them. An action whose capability is absent is not offered.
 *
 * @param {object|null} record Context-store record.
 * @param {object} caps Capabilities the shell reports.
 * @param {string|null} [caps.atcAnnotation] "ATC Austin Tower 121.0", or null.
 * @param {boolean} [caps.atcFollowing] FOLLOW is on in the Airband section.
 * @param {boolean} [caps.canListenAtc] The Airband layer can play a frequency.
 * @param {boolean} [caps.canListenSdr] The selected receiver can be opened.
 * @param {boolean} [caps.canListenScanner] The selected system can be tuned.
 * @param {boolean} [caps.canPin] A WATCHLIST is mounted.
 * @param {boolean} [caps.pinned] The selection is already on it.
 * @param {boolean} [caps.imaging] The satellite carries an imager SENSORS knows.
 * @param {boolean} [caps.canWatchIss] The ISS stream can be opened.
 * @param {boolean} [caps.canFocusTfr] The closure can be flown to.
 * @param {string|null} [caps.panelId] The section that owns this layer's controls.
 * @param {string|null} [caps.panelName] What that section is called.
 * @param {boolean} [caps.canGoTo] The camera can move to the record.
 * @returns {Array<{id: string, label: string, kind: string, title: string, active?: boolean}>}
 */
export function inspectActions(record, caps = {}) {
  if (!record) return [];
  const actions = [];
  const layerId = record.layerId;
  const pinValue = pinValueFor(record);
  if (AIRCRAFT_LAYERS.has(layerId)) {
    if (caps.canListenAtc && caps.atcAnnotation) {
      actions.push({
        id: 'listen',
        label: 'LISTEN',
        kind: 'listen',
        title: `${caps.atcAnnotation} — play it in the dock`,
      });
      actions.push({
        id: 'follow',
        label: caps.atcFollowing ? 'FOLLOWING' : 'FOLLOW',
        kind: 'follow',
        active: Boolean(caps.atcFollowing),
        title:
          'Retune as it moves: Ground → Tower → Approach → Center (the Airband section shows the phase)',
      });
    }
  } else if (layerId === 'ais-live-vessels') {
    if (caps.canListenMarine)
      actions.push({
        id: 'listen',
        label: 'LISTEN',
        kind: 'listen',
        title:
          'The nearest receiver that can actually hear this ship: Channel 16 from a coast within range, otherwise the marine HF bands',
      });
  } else if (layerId === 'satellites') {
    if (caps.imaging && caps.panelId)
      actions.push({
        id: 'sensors',
        label: 'SENSORS PANEL ›',
        kind: 'panel',
        title:
          'The instrument it carries, the ground it is sweeping and the products it feeds',
      });
    if (caps.canWatchIss && Number(record.id) === ISS_NORAD)
      actions.push({
        id: 'watch',
        label: 'WATCH',
        kind: 'watch',
        title: 'The NASA live stream from the station, in the dock',
      });
  } else if (layerId === 'atc') {
    if (caps.canListenAtc)
      actions.push({
        id: 'listen',
        label: 'LISTEN',
        kind: 'listen',
        title:
          'Tower where there is one, otherwise the first published frequency',
      });
  } else if (layerId === 'sdr') {
    if (caps.canListenSdr)
      actions.push({
        id: 'listen',
        label: 'LISTEN',
        kind: 'listen',
        title:
          'Open this receiver in the dock, tuned to the band the Receivers section has set',
      });
  } else if (layerId === 'scanner') {
    if (caps.canListenScanner)
      actions.push({
        id: 'listen',
        label: 'LISTEN',
        kind: 'listen',
        title: 'Play this system, a clip per transmission',
      });
  } else if (layerId === 'cctv') {
    if (caps.canWatchCamera)
      actions.push({
        id: 'watch',
        label: 'WATCH',
        kind: 'watch',
        title: 'Open this camera in the CAMERAS console',
      });
  } else if (layerId === 'tfr') {
    if (record.properties?.page)
      actions.push({
        id: 'notam',
        label: 'NOTAM',
        kind: 'show',
        title: 'The FAA notice, on its own page',
      });
  }
  if (caps.canPin && pinValue) {
    actions.push({
      id: 'pin',
      label: caps.pinned ? 'PINNED' : 'PIN',
      kind: 'pin',
      active: Boolean(caps.pinned),
      title: caps.pinned
        ? `${pinValue} is on the WATCHLIST`
        : `Put ${pinValue} on the WATCHLIST`,
    });
  }
  if (
    caps.panelId &&
    caps.panelName &&
    !actions.some((action) => action.kind === 'panel')
  ) {
    actions.push({
      id: 'panel',
      label: `${caps.panelName} PANEL ›`,
      kind: 'panel',
      title: `Open the ${caps.panelName} section`,
    });
  }
  if (caps.canGoTo && !TRACKED_LAYERS.has(layerId)) {
    actions.push({
      id: 'goto',
      label: 'GO TO',
      kind: 'goto',
      title: 'Move the camera here',
    });
  }
  return actions;
}

/**
 * The card's one provenance line: who publishes this, not what the app
 * calls the layer. The layer's name is the fallback for a record that
 * names no source.
 * @param {object|null} record
 * @returns {string}
 */
export function sourceText(record) {
  return String(record?.source || record?.layerName || '').trim();
}

/** The identifier the WATCHLIST would match this selection by, or ''. */
export function pinValueFor(record) {
  if (!record) return '';
  const p = record.properties || {};
  switch (record.layerId) {
    case 'flights':
    case 'military':
      return String(p.callsign || p.registration || p.icao24 || record.id || '')
        .trim()
        .toUpperCase();
    case 'ais-live-vessels':
      return String(p.mmsi || '').trim();
    case 'satellites':
      return String(p.name || record.label || '').trim();
    default:
      return '';
  }
}

/** A short VESSEL WATCH verdict for a ship, or '' when nothing applies. */
export function vesselStatusText(status) {
  if (!status) return '';
  const parts = [];
  if (status.listed)
    parts.push(
      `OFAC-LISTED${status.listed.program ? ` · ${status.listed.program}` : ''}`,
    );
  else if (status.tableLoaded) parts.push('NOT ON THE OFAC LIST');
  else if (status.tableError) parts.push('OFAC LIST UNAVAILABLE');
  if (status.darkText) parts.push(`DARK · ${status.darkText}`);
  return parts.join(' · ');
}

export class InspectPanel {
  /**
   * @param {object} options
   * @param {object} options.elements `{ section, state, body, empty }`.
   * @param {() => object|null} options.getSelected The context store's
   *   selected record, already checked against the data manager.
   * @param {object|null} [options.viewer] The Cesium viewer.
   * @param {() => object|null} [options.atc] The Airband layer.
   * @param {() => object|null} [options.sdr] The Receivers layer.
   * @param {() => object|null} [options.scanner] The Scanners layer.
   * @param {() => object|null} [options.satellites] The satellites layer.
   * @param {() => object|null} [options.tfr] The Flight Restrictions layer.
   * @param {() => object|null} [options.cctv] The Cameras layer.
   * @param {(value: string) => 'added'|'exists'|false} [options.pinWatch]
   * @param {(value: string) => boolean} [options.isPinned]
   * @param {(mmsi: string) => object|null} [options.vesselStatus]
   * @param {(noradId: number) => boolean} [options.isImagingSatellite]
   * @param {(layerId: string) => {panelId: string, name: string}|null} [options.panelFor]
   * @param {(panelId: string) => void} [options.openPanel]
   * @param {(url: string) => void} [options.openTab]
   * @param {(layerId: string) => Promise<void>|void} [options.enableLayer]
   * @param {(layerId: string) => boolean} [options.isLayerEnabled]
   * @param {(message: string) => void} [options.onToast]
   * @param {object} [options.windowRef] Event target and timers.
   */
  constructor({
    elements,
    getSelected,
    viewer = null,
    atc = () => null,
    sdr = () => null,
    scanner = () => null,
    satellites = () => null,
    tfr = () => null,
    cctv = () => null,
    pinWatch = null,
    isPinned = () => false,
    vesselStatus = () => null,
    isImagingSatellite = () => false,
    panelFor = () => null,
    openPanel = () => {},
    openTab = (url) => {
      if (typeof window === 'undefined') return;
      const tab = window.open(url, '_blank', 'noopener,noreferrer');
      if (tab) tab.opener = null;
    },
    enableLayer = () => {},
    isLayerEnabled = () => false,
    onToast = () => {},
    windowRef = typeof window !== 'undefined' ? window : null,
  }) {
    this.elements = elements || {};
    this._getSelected = getSelected;
    this._viewer = viewer;
    this._atc = atc;
    this._sdr = sdr;
    this._scanner = scanner;
    this._satellites = satellites;
    this._tfr = tfr;
    this._cctv = cctv;
    this._pinWatch = pinWatch;
    this._isPinned = isPinned;
    this._vesselStatus = vesselStatus;
    this._isImagingSatellite = isImagingSatellite;
    this._panelFor = panelFor;
    this._openPanel = openPanel;
    this._openTab = openTab;
    this._enableLayer = enableLayer;
    this._isLayerEnabled = isLayerEnabled;
    this.onToast = onToast;
    this._window = windowRef;
    this._abort = new AbortController();
    this._timer = null;
    this._pending = null;
    this._signature = null;
    this._busy = false;
    this.destroyed = false;
  }

  connect() {
    const w = this._window;
    const { signal } = this._abort;
    if (w?.addEventListener) {
      // The tracking layers publish their event before they write the
      // context record, so every event defers one tick before reading it.
      const later = () => this._scheduleRender();
      for (const type of [
        'gev:entity-selected',
        'gev:entity-selection-cleared',
        'gev:awareness-subject-selected',
        'gev:awareness-subject-cleared',
      ])
        w.addEventListener(type, later, { signal });
    }
    const setTimer = w?.setInterval ? w.setInterval.bind(w) : setInterval;
    // Live values move without an event: an aircraft's altitude, the
    // controller it has crossed into, a layer switched off underneath.
    this._timer = setTimer(() => this.render(), POLL_MS);
    this.render();
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    const w = this._window;
    const clear = w?.clearInterval ? w.clearInterval.bind(w) : clearInterval;
    if (this._timer != null) clear(this._timer);
    this._timer = null;
    if (this._pending != null) {
      const clearT = w?.clearTimeout ? w.clearTimeout.bind(w) : clearTimeout;
      clearT(this._pending);
      this._pending = null;
    }
  }

  _scheduleRender() {
    if (this.destroyed || this._pending != null) return;
    const w = this._window;
    const setT = w?.setTimeout ? w.setTimeout.bind(w) : setTimeout;
    this._pending = setT(() => {
      this._pending = null;
      this.render();
    }, 0);
  }

  /** The record on screen, or null. */
  selected() {
    try {
      return this._getSelected?.() || null;
    } catch {
      return null;
    }
  }

  _capabilities(record) {
    const layerId = record?.layerId;
    const atc = this._atc();
    const panel = this._panelFor(layerId) || null;
    let atcAnnotation = null;
    if (AIRCRAFT_LAYERS.has(layerId)) {
      try {
        atcAnnotation = atc?.contactAnnotationText?.() || null;
      } catch {
        atcAnnotation = null;
      }
    }
    const pinValue = pinValueFor(record);
    return {
      atcAnnotation,
      atcFollowing: Boolean(atc?.getAtcUIState?.()?.follow?.active),
      canListenAtc: Boolean(
        atc &&
        (AIRCRAFT_LAYERS.has(layerId) ? atc.listenAtcContact : atc.listenAtc),
      ),
      canListenSdr: Boolean(this._sdr()?.openSelectedSdrReceiver),
      canListenMarine: Boolean(
        this._sdr()?.listenMarineNear &&
        Number.isFinite(record?.properties?.lat) &&
        Number.isFinite(record?.properties?.lon),
      ),
      canListenScanner: Boolean(
        this._scanner()?.selectScannerSystem && record?.properties?.system,
      ),
      canPin: typeof this._pinWatch === 'function',
      pinned: Boolean(pinValue && this._isPinned(pinValue)),
      imaging:
        layerId === 'satellites' && this._isImagingSatellite(Number(record.id)),
      canWatchIss: Boolean(this._satellites()?.openIssStream),
      canWatchCamera: Boolean(this._cctv()?.selectCamera),
      canFocusTfr: Boolean(this._tfr()?.focusTfr),
      panelId: panel?.panelId || null,
      panelName: panel?.name || null,
      canGoTo:
        Boolean(this._viewer?.camera?.flyTo) &&
        Number.isFinite(record?.latitude) &&
        Number.isFinite(record?.longitude),
    };
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const record = this.selected();
    if (!record) {
      if (this._signature !== '') {
        this._signature = '';
        setText(e.state, 'READY');
        if (e.body) e.body.textContent = '';
        if (e.empty) e.empty.hidden = false;
      }
      return;
    }
    const caps = this._capabilities(record);
    const { title, lines } = inspectLines(record, {
      trackedEntity: this._viewer?.trackedEntity || null,
      annotation: caps.atcAnnotation,
    });
    const status =
      record.layerId === 'ais-live-vessels'
        ? vesselStatusText(this._vesselStatus(record.properties?.mmsi))
        : '';
    const actions = inspectActions(record, caps);
    const signature = JSON.stringify([
      record.id,
      record.layerId,
      title,
      lines,
      status,
      actions.map((a) => [a.id, a.label, a.active]),
    ]);
    if (signature === this._signature) return;
    this._signature = signature;

    setText(e.state, inspectKicker(record));
    if (e.empty) e.empty.hidden = true;
    const body = e.body;
    if (!body) return;
    body.textContent = '';
    const card = el('div', 'inspect-card');
    card.dataset.layerId = record.layerId;
    const head = el('div', 'inspect-title', title || '—');
    card.append(head);
    // Where it came from, once. The header already says what kind of thing
    // this is, so pairing it with the layer's own name said "receiver"
    // three times: RECEIVER · SDR Receivers · Web SDR directory.
    const provenance = sourceText(record);
    if (provenance) card.append(el('div', 'inspect-source', provenance));
    if (lines.length) {
      const list = el('div', 'inspect-lines');
      for (const line of lines) list.append(el('div', 'inspect-line', line));
      card.append(list);
    }
    if (status) {
      const verdict = el('div', 'inspect-status', status);
      if (/OFAC-LISTED|DARK/.test(status)) verdict.className += ' alert';
      card.append(verdict);
    }
    if (actions.length) {
      const row = el('div', 'inspect-actions');
      for (const action of actions) {
        const btn = el(
          'button',
          `launch-btn inspect-btn inspect-btn-${action.kind}`,
        );
        btn.textContent = action.label;
        btn.setAttribute('type', 'button');
        btn.setAttribute('title', action.title);
        if (action.active) btn.className += ' active';
        btn.addEventListener('click', () => void this._run(action, record));
        row.append(btn);
      }
      card.append(row);
    }
    body.append(card);
  }

  async _run(action, record) {
    if (this._busy || this.destroyed) return;
    this._busy = true;
    try {
      switch (action.id) {
        case 'listen':
          await this._listen(record);
          break;
        case 'follow':
          await this._follow();
          break;
        case 'watch':
          if (record.layerId === 'cctv') {
            const panel = this._panelFor('cctv');
            if (panel?.panelId) this._openPanel(panel.panelId);
          } else this._satellites()?.openIssStream?.();
          break;
        case 'sensors':
        case 'panel': {
          const panel = this._panelFor(record.layerId);
          if (panel?.panelId) this._openPanel(panel.panelId);
          break;
        }
        case 'pin':
          this._pin(record);
          break;
        case 'notam':
          if (record.properties?.page) this._openTab(record.properties.page);
          break;
        case 'goto':
          this._goTo(record);
          break;
        default:
          break;
      }
    } catch (error) {
      console.warn('[Inspect] action failed:', error);
    } finally {
      this._busy = false;
      this._signature = null;
      this.render();
    }
  }

  /**
   * Where somebody else is already listening to marine VHF near a ship.
   *
   * The region comes from the nearest airport in the bundled ATC directory,
   * which is the same offline trick the Receivers panel uses — a ship off
   * Massachusetts resolves to a Massachusetts airport, and the listing is
   * that state's.
   *
   * @param {number} lat
   * @param {number} lon
   * @returns {Promise<{url: string, label: string}|null>}
   */
  async _marineFeedListing(lat, lon) {
    let region = null;
    try {
      const atc = this._atc();
      if (atc?.ensureAtcDirectory) {
        await atc.ensureAtcDirectory();
        const [airport] = atc.findAtcAirports?.({ lat, lon, limit: 1 }) ?? [];
        if (airport)
          region = { code: airport.region, country: airport.country };
      }
    } catch {
      /* the generic directory is the fallback, not a failure */
    }
    return marineFeedListingFor(region);
  }

  async _ensureLayer(layerId) {
    if (this._isLayerEnabled(layerId)) return true;
    await this._enableLayer(layerId);
    return this._isLayerEnabled(layerId);
  }

  async _listen(record) {
    const layerId = record.layerId;
    if (AIRCRAFT_LAYERS.has(layerId)) {
      if (!(await this._ensureLayer('atc'))) {
        this.onToast('Turn on Airband to hear the controller.');
        return;
      }
      const result = await this._atc()?.listenAtcContact?.();
      if (!result)
        this.onToast(
          'No published VHF frequency applies to this aircraft right now.',
        );
      return;
    }
    if (layerId === 'atc') {
      // The record id carries the layer's entity prefix ("atc:KAUS").
      const airportId = String(record.id || '').replace(/^atc:/, '');
      const result = await this._atc()?.listenAtc?.({ airportId });
      if (!result) this.onToast('Could not open this airport in the dock.');
      return;
    }
    if (layerId === 'ais-live-vessels') {
      if (!(await this._ensureLayer('sdr'))) {
        this.onToast('Turn on Receivers to listen near a ship.');
        return;
      }
      const { lat, lon } = record.properties || {};
      const result = await this._sdr()?.listenMarineNear?.({ lat, lon });
      if (!result?.receiver) {
        // Nothing in the directory can hear it. Volunteers with coastal
        // antennas stream marine VHF, so point at that rather than stopping.
        const listing = await this._marineFeedListing(lat, lon);
        if (listing && this._openTab) {
          this._openTab(listing.url);
          this.onToast(
            `${result?.reason || 'No receiver can hear this ship.'} ${listing.label} opened instead — volunteers stream marine VHF from the coast.`,
          );
          return;
        }
        this.onToast(result?.reason || 'No receiver can hear this ship.');
        return;
      }
      this.onToast(
        `${result.band.label} on ${result.receiver.name} — ${Math.round(result.receiver.distanceKm)} km away.`,
      );
      return;
    }
    if (layerId === 'sdr') {
      const url = this._sdr()?.openSelectedSdrReceiver?.();
      if (!url)
        this.onToast('Pick the receiver again — its page could not be opened.');
      return;
    }
    if (layerId === 'scanner') {
      const ok = this._scanner()?.selectScannerSystem?.(
        record.properties?.system,
      );
      if (!ok) this.onToast('Could not tune this system.');
    }
  }

  async _follow() {
    if (!(await this._ensureLayer('atc'))) {
      this.onToast(
        'Turn on Airband to follow the aircraft between frequencies.',
      );
      return;
    }
    const atc = this._atc();
    const active = Boolean(atc?.getAtcUIState?.()?.follow?.active);
    atc?.setAtcFollow?.(!active);
  }

  _pin(record) {
    const value = pinValueFor(record);
    if (!value || typeof this._pinWatch !== 'function') return;
    const result = this._pinWatch(value);
    if (result === 'added') this.onToast(`WATCHLIST: pinned ${value}`);
    else if (result === 'exists') this.onToast(`${value} is already pinned`);
  }

  _goTo(record) {
    const viewer = this._viewer;
    const lat = record.latitude;
    const lon = record.longitude;
    if (
      !viewer?.camera?.flyTo ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    )
      return;
    if (record.layerId === 'tfr' && this._tfr()?.focusTfr) {
      if (this._tfr().focusTfr(record.properties?.notam)) return;
    }
    // A camera is framed by its own layer: the console knows the pose to
    // look along, which a plain fly-to-the-pin does not.
    if (record.layerId === 'cctv' && this._cctv()?.focusCamera) {
      const result = this._cctv().focusCamera(record.properties?.camera);
      if (result === 'focused') return;
    }
    const current = viewer.camera.positionCartographic?.height;
    const height = Number.isFinite(current)
      ? Math.min(Math.max(current, GOTO_MIN_HEIGHT_M), GOTO_MAX_HEIGHT_M)
      : GOTO_DEFAULT_HEIGHT_M;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.6,
    });
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node) node.textContent = text;
}
