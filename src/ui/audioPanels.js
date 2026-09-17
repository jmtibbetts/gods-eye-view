import * as Cesium from 'cesium';
import { cameraPoseSignature } from '../data/iconOrientation.js';

/**
 * Context-rail panels for the two audio layers:
 *
 *  - SCANNERS — the public-safety radio systems nearest the current view,
 *    a live call ticker for the selected one, and transport controls.
 *  - SDR / HAM — plain-language band presets and one LISTEN button that
 *    opens the best receiver inside the map; the receivers nearest the
 *    current view; an exact-frequency row for people who know what they want.
 *  - ATC — every airport with published frequencies, the positions at the
 *    selected one, LISTEN through an airband SDR or LiveATC's page, and a
 *    FOLLOW PLANE mode that retunes as the selected aircraft moves.
 *
 * Both follow the RadioControls contract: `connect()` after the layer
 * manager is live, `destroy()` on teardown, `actions` for the manager-level
 * verbs the shell owns (enable/disable through the lifecycle, camera
 * flights, panel disclosure).
 */

const LIST_REFRESH_MS = 1500;

/**
 * Above 30 MHz radio is line-of-sight: a receiver 1,600 km away hears
 * nothing on a tower frequency, however well it covers the band. HF
 * (shortwave, 20 m / 40 m ham, WWV) bounces off the ionosphere, so any
 * receiver in the world will do.
 */
const VHF_FLOOR_HZ = 30_000_000;
const VHF_MAX_KM = 250;

/**
 * OpenMHz only carries systems a volunteer feeds. Beyond this distance the
 * nearest one is somebody else's city, and the panel says so and points at
 * Broadcastify's listing for the state instead.
 */
const SCANNER_COVERAGE_KM = 150;

/** Broadcastify's state pages are keyed by FIPS state code. */
const US_STATE_FIPS = Object.freeze({
  AL: 1,
  AK: 2,
  AZ: 4,
  AR: 5,
  CA: 6,
  CO: 8,
  CT: 9,
  DE: 10,
  DC: 11,
  FL: 12,
  GA: 13,
  HI: 15,
  ID: 16,
  IL: 17,
  IN: 18,
  IA: 19,
  KS: 20,
  KY: 21,
  LA: 22,
  ME: 23,
  MD: 24,
  MA: 25,
  MI: 26,
  MN: 27,
  MS: 28,
  MO: 29,
  MT: 30,
  NE: 31,
  NV: 32,
  NH: 33,
  NJ: 34,
  NM: 35,
  NY: 36,
  NC: 37,
  ND: 38,
  OH: 39,
  OK: 40,
  OR: 41,
  PA: 42,
  RI: 44,
  SC: 45,
  SD: 46,
  TN: 47,
  TX: 48,
  UT: 49,
  VT: 50,
  VA: 51,
  WA: 53,
  WV: 54,
  WI: 55,
  WY: 56,
  PR: 72,
});
const US_STATE_NAMES = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'DC',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
});

/** Broadcastify listing for the place under the view: the state's page in the US, the front page elsewhere. */
export function broadcastifyListingFor(region) {
  if (region?.country === 'US' && US_STATE_FIPS[region.code])
    return {
      url: `https://www.broadcastify.com/listen/stid/${US_STATE_FIPS[region.code]}`,
      label: `MORE FEEDS: BROADCASTIFY · ${US_STATE_NAMES[region.code].toUpperCase()} ↗`,
    };
  return {
    url: 'https://www.broadcastify.com/listen/',
    label: 'MORE FEEDS: BROADCASTIFY ↗',
  };
}

/**
 * Beginner presets: what people actually want to hear, with a frequency
 * that is busy or always on, the right mode, and a one-line explanation.
 * Airband resolves to the nearest tower frequency when the ATC directory
 * is available, so LISTEN lands on real traffic rather than a guard channel.
 */
export const SDR_PRESETS = Object.freeze({
  airband: Object.freeze({
    label: 'Airband',
    freqHz: 121_500_000,
    mode: 'am',
    band: [118_000_000, 137_000_000],
    hint: 'Pilots talking to control towers. AM voice, busiest near big airports in daytime. LISTEN picks the nearest tower frequency.',
    airband: true,
  }),
  marine: Object.freeze({
    label: 'Marine',
    freqHz: 156_800_000,
    mode: 'nbfm',
    band: [156_000_000, 162_500_000],
    hint: 'Channel 16: ships, harbors and the coast guard calling each other. Needs a receiver near the water.',
  }),
  ham2m: Object.freeze({
    label: 'Ham 2 m',
    freqHz: 146_520_000,
    mode: 'nbfm',
    band: [144_000_000, 148_000_000],
    hint: 'Local amateur radio on the 2-metre calling frequency (FM). Repeaters nearby are often busier.',
  }),
  ham20m: Object.freeze({
    label: 'Ham 20 m',
    freqHz: 14_200_000,
    mode: 'usb',
    band: [14_000_000, 14_350_000],
    hint: 'Worldwide amateur voice on 20 metres (upper sideband). Best in daylight; tune around 14.150–14.350.',
  }),
  ham40m: Object.freeze({
    label: 'Ham 40 m',
    freqHz: 7_150_000,
    mode: 'lsb',
    band: [7_000_000, 7_300_000],
    hint: 'Regional amateur voice on 40 metres (lower sideband). Best evenings and nights.',
  }),
  shortwave: Object.freeze({
    label: 'Shortwave',
    freqHz: 9_700_000,
    mode: 'am',
    band: [9_400_000, 9_900_000],
    hint: 'International broadcasters on the 31-metre band (AM). Programs come and go by the hour; tune around.',
  }),
  wwv: Object.freeze({
    label: 'Time signal',
    freqHz: 10_000_000,
    mode: 'am',
    band: [9_990_000, 10_010_000],
    hint: 'WWV, the US atomic-clock station: ticks and a voice every minute, always on. A good first test that a receiver works.',
  }),
});

/** Assign text without naming string literals in the assignment itself. */
function setText(el, value) {
  if (el) el.textContent = value;
}

function viewportAnchor(viewer) {
  const camera = viewer?.camera;
  const scene = viewer?.scene;
  if (!camera) return null;
  let cartographic = null;
  const canvas = scene?.canvas;
  if (canvas && typeof camera.pickEllipsoid === 'function') {
    const center = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const position = camera.pickEllipsoid(
      center,
      scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
    );
    if (position) cartographic = Cesium.Cartographic.fromCartesian(position);
  }
  cartographic ||= camera.positionCartographic || null;
  if (!cartographic) return null;
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
  };
}

function kmText(km) {
  if (!Number.isFinite(km)) return '';
  return km < 10 ? `${km.toFixed(0)} km` : `${Math.round(km)} km`;
}

function flyTo(viewer, lat, lon, heightM = 40_000) {
  if (!viewer?.camera || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-55),
      roll: 0,
    },
    duration: 1.6,
  });
}

/** Shared enable/disable button behaviour, routed through the lifecycle. */
async function toggleLayer(control, enabling) {
  const btn = control.elements.enableBtn;
  if (!btn || control.destroyed) return;
  btn.setAttribute('aria-disabled', 'true');
  btn.setAttribute('aria-busy', 'true');
  try {
    await control.actions.runUserAction(
      (notificationToken) =>
        control.actions.setEnabled(enabling, {
          origin: 'user',
          notificationToken,
        }),
      `${control.label} could not ${enabling ? 'start' : 'stop'} cleanly`,
    );
  } finally {
    if (!control.destroyed) {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-busy');
      control.render();
    }
  }
}

function lifecycleState(control) {
  const state = control.actions.getLifecycle?.();
  if (state === 'enabling' || state === 'disabling') return state;
  return control.actions.isEnabled?.() ? 'enabled' : 'disabled';
}

function paintEnableButton(control, state) {
  const btn = control.elements.enableBtn;
  if (!btn) return;
  const enabled = state === 'enabled';
  setText(
    btn,
    state === 'enabling'
      ? 'STARTING…'
      : state === 'disabling'
        ? 'STOPPING…'
        : enabled
          ? 'DISABLE'
          : 'ENABLE',
  );
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.classList.toggle('active', enabled);
}

function renderList({ list, rows, selectedId, render, onPick }) {
  if (!list) return;
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', row.id === selectedId ? 'true' : 'false');
    li.dataset.id = row.id;
    if (row.id === selectedId) li.classList.add('selected');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'audio-list-row';
    render(button, row);
    button.addEventListener('click', () => onPick(row));
    li.append(button);
    list.append(li);
  }
}

/** SCANNERS panel. */
export class ScannerPanel {
  constructor({ elements, layer, actions, viewer, atc = null }) {
    this.elements = elements;
    this.layer = layer;
    this.actions = actions;
    this.viewer = viewer;
    /** Optional ATC layer: its airport directory names the state under the view. */
    this.atc = atc;
    this.label = 'Scanners';
    this.destroyed = false;
    this._abort = new AbortController();
    this._unsubscribe = null;
    this._timer = null;
    this._pose = null;
    this._state = null;
    this._rows = [];
    /** @type {{code:string, country:string}|null} State/country under the view. */
    this._region = null;
    this._regionAnchor = null;
  }

  /** Name the state under the view from the nearest airport (cheap, offline). */
  async _resolveRegion(anchor) {
    if (!anchor || !this.atc?.ensureAtcDirectory) return;
    const prev = this._regionAnchor;
    if (
      prev &&
      Math.abs(prev.lat - anchor.lat) < 0.25 &&
      Math.abs(prev.lon - anchor.lon) < 0.25
    )
      return;
    this._regionAnchor = anchor;
    try {
      await this.atc.ensureAtcDirectory();
      const [airport] =
        this.atc.findAtcAirports?.({ ...anchor, limit: 1 }) ?? [];
      const next = airport
        ? { code: airport.region, country: airport.country }
        : null;
      if (next?.code !== this._region?.code) {
        this._region = next;
        if (!this.destroyed) this.render();
      }
    } catch {
      /* the link falls back to Broadcastify's front page */
    }
  }

  connect() {
    const { signal } = this._abort;
    const e = this.elements;
    e.enableBtn?.addEventListener(
      'click',
      () => toggleLayer(this, !this.actions.isEnabled?.()),
      { signal },
    );
    e.search?.addEventListener(
      'input',
      () => this.refreshList({ force: true }),
      {
        signal,
      },
    );
    e.pauseBtn?.addEventListener(
      'click',
      () => this.layer.toggleScannerPlayback?.(),
      { signal },
    );
    e.stopBtn?.addEventListener('click', () => this.layer.stopScanner?.(), {
      signal,
    });
    e.flyBtn?.addEventListener(
      'click',
      () => {
        const s = this.layer.getSelectedScannerSystem?.();
        if (s) flyTo(this.viewer, s.lat, s.lon, 60_000);
      },
      { signal },
    );
    e.volume?.addEventListener(
      'input',
      () => {
        const v = Number(e.volume.value) / 100;
        this.layer.setScannerVolume?.(v);
        if (e.volumeValue) setText(e.volumeValue, `${Math.round(v * 100)}%`);
      },
      { signal },
    );
    this._unsubscribe = this.layer.subscribeScanner?.((state) => {
      this._state = state;
      this.render();
    });
    this._timer = setInterval(() => this.refreshList(), LIST_REFRESH_MS);
    this.refreshList({ force: true });
    this.render();
  }

  refreshList({ force = false } = {}) {
    if (this.destroyed) return;
    const enabled = this.actions.isEnabled?.();
    if (!enabled) {
      if (this._rows.length) {
        this._rows = [];
        this.renderList();
      }
      return;
    }
    const camera = this.viewer?.camera;
    const pose = camera ? cameraPoseSignature(camera) : null;
    if (!force && pose === this._pose) return;
    this._pose = pose;
    const anchor = viewportAnchor(this.viewer);
    if (!anchor) return;
    this._rows =
      this.layer.nearestScannerSystems?.({
        ...anchor,
        query: this.elements.search?.value ?? '',
        limit: 14,
      }) ?? [];
    this.renderList();
    this._resolveRegion(anchor);
  }

  /** The nearest system when it is too far to count as local coverage. */
  _coverageGap() {
    const nearest = this._rows[0];
    if (!nearest || String(this.elements.search?.value ?? '').trim())
      return null;
    return nearest.distanceKm > SCANNER_COVERAGE_KM ? nearest : null;
  }

  renderList() {
    const e = this.elements;
    const selectedId = this._state?.selected ?? null;
    renderList({
      list: e.list,
      rows: this._rows,
      selectedId,
      render: (button, row) => {
        const rate = Number(row.callAvg) || 0;
        const band =
          rate >= 10 ? 'hot' : rate >= 3 ? 'busy' : rate > 0 ? 'quiet' : 'idle';
        button.innerHTML = `<span class="audio-list-dot ${band}" aria-hidden="true"></span><span class="audio-list-main"><strong></strong><span></span></span><span class="audio-list-side"><b></b><i></i></span>`;
        setText(button.querySelector('strong'), row.name);
        setText(button.querySelector('.audio-list-main span'), row.place);
        setText(
          button.querySelector('b'),
          rate ? `${rate.toFixed(rate >= 10 ? 0 : 1)}/min` : 'quiet',
        );
        setText(button.querySelector('i'), kmText(row.distanceKm));
        button.title =
          row.id === selectedId
            ? 'Click to pause / resume'
            : `Listen to ${row.name}`;
      },
      onPick: (row) => {
        if (row.id === selectedId) this.layer.toggleScannerPlayback?.();
        else this.layer.selectScannerSystem?.(row.id);
      },
    });
    if (e.listCount)
      setText(
        e.listCount,
        this._rows.length
          ? `${this._rows.length} shown · ${this._state?.active ?? 0} live of ${this._state?.systems ?? 0}`
          : '',
      );
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const s = this._state;
    const lifecycle = lifecycleState(this);
    const enabled = lifecycle === 'enabled';
    paintEnableButton(this, lifecycle);
    if (e.layerState) {
      setText(
        e.layerState,
        enabled
          ? s?.selected
            ? s.player?.paused
              ? 'PAUSED'
              : 'LIVE'
            : `${s?.active ?? 0} LIVE`
          : lifecycle === 'enabling'
            ? 'SYNC'
            : 'OFF',
      );
      e.layerState.classList.toggle('active', enabled);
    }
    if (e.search) e.search.disabled = !enabled;
    const hasSelection = enabled && Boolean(s?.selected);
    if (e.pauseBtn) {
      e.pauseBtn.disabled = !hasSelection;
      setText(e.pauseBtn, s?.player?.paused ? 'RESUME' : 'PAUSE');
      e.pauseBtn.classList.toggle('active', hasSelection && !s?.player?.paused);
    }
    if (e.stopBtn) e.stopBtn.disabled = !hasSelection;
    if (e.flyBtn) e.flyBtn.disabled = !hasSelection;
    if (e.nowName)
      setText(
        e.nowName,
        hasSelection
          ? s.selectedName
          : enabled
            ? 'NO SYSTEM SELECTED'
            : 'SCANNERS OFF',
      );
    if (e.nowMeta) {
      if (hasSelection) {
        const status =
          s.session?.status === 'error'
            ? 'feed unavailable'
            : s.player?.paused
              ? 'paused'
              : s.player?.state === 'playing' || s.player?.state === 'waiting'
                ? 'live'
                : 'monitoring';
        setText(
          e.nowMeta,
          `${s.selectedPlace} · ${status} · ${(s.selectedRate ?? 0).toFixed(1)} calls/min · ${s.player?.queued ?? 0} queued`,
        );
      } else {
        setText(
          e.nowMeta,
          enabled
            ? 'Pick a system from the list or a globe marker.'
            : 'Enable Scanners, then pick a system from the list or a globe marker.',
        );
      }
    }
    if (e.nowCalls) {
      e.nowCalls.replaceChildren();
      for (const line of hasSelection ? s.recentLines : []) {
        const li = document.createElement('li');
        setText(li, line);
        if (line.startsWith('▶')) li.classList.add('playing');
        e.nowCalls.append(li);
      }
    }
    const gap = enabled && !hasSelection ? this._coverageGap() : null;
    if (e.playbackState) {
      const error = s?.error || s?.player?.error;
      setText(
        e.playbackState,
        !enabled
          ? 'Scanners off'
          : error
            ? error
            : hasSelection
              ? s.player?.state === 'playing'
                ? 'Playing transmissions as they arrive'
                : s.player?.paused
                  ? 'Paused — click RESUME to continue'
                  : 'Waiting for traffic…'
              : gap
                ? `No OpenMHz system within ${SCANNER_COVERAGE_KM} km of the view — nearest is ${gap.name} (${kmText(gap.distanceKm)}). OpenMHz only carries systems a volunteer records, and many police departments encrypt dispatch. Try the Broadcastify link below for local fire, EMS and unencrypted police feeds.`
                : `${s?.active ?? 0} systems with live traffic`,
      );
      e.playbackState.classList.toggle('error', Boolean(error || gap));
    }
    if (e.broadcastifyLink) {
      const listing = broadcastifyListingFor(this._region);
      e.broadcastifyLink.href = listing.url;
      setText(e.broadcastifyLink, listing.label);
      e.broadcastifyLink.classList.toggle('audio-link-hot', Boolean(gap));
    }
    if (e.volume && s?.player && Number.isFinite(s.player.volume)) {
      const pct = Math.round(s.player.volume * 100);
      if (
        Number(e.volume.value) !== pct &&
        document.activeElement !== e.volume
      ) {
        e.volume.value = String(pct);
        if (e.volumeValue) setText(e.volumeValue, `${pct}%`);
      }
    }
    this.renderList();
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

/** SDR / HAM panel. */
export class SdrPanel {
  constructor({ elements, layer, actions, viewer, atc = null, dock = null }) {
    this.elements = elements;
    this.layer = layer;
    this.actions = actions;
    this.viewer = viewer;
    /** Optional ATC layer: turns the Airband preset into the nearest tower frequency. */
    this.atc = atc;
    /** The in-map receiver dock (LiveATC fallback when no airband SDR is in range). */
    this.dock = dock;
    this.label = 'SDR';
    this.destroyed = false;
    this._abort = new AbortController();
    this._unsubscribe = null;
    this._timer = null;
    this._pose = null;
    this._state = null;
    this._rows = [];
    this._preset = null;
    this._busy = false;
    /** @type {{text:string, error:boolean}|null} Outcome of the last LISTEN, kept across renders. */
    this._notice = null;
  }

  connect() {
    const { signal } = this._abort;
    const e = this.elements;
    e.enableBtn?.addEventListener(
      'click',
      () => toggleLayer(this, !this.actions.isEnabled?.()),
      { signal },
    );
    e.search?.addEventListener(
      'input',
      () => this.refreshList({ force: true }),
      {
        signal,
      },
    );
    const applyTune = () => {
      const mhz = Number(e.freq?.value);
      const mode = e.mode?.value || 'am';
      this.layer.setSdrTune?.(
        Number.isFinite(mhz) && mhz > 0
          ? { freqHz: Math.round(mhz * 1e6), mode }
          : null,
      );
      this.refreshList({ force: true });
    };
    e.freq?.addEventListener('change', applyTune, { signal });
    e.freq?.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') {
          applyTune();
          event.preventDefault();
        }
      },
      { signal },
    );
    e.mode?.addEventListener('change', applyTune, { signal });
    e.presets?.addEventListener(
      'click',
      (event) => {
        const key = event.target?.closest?.('button[data-preset]')?.dataset
          .preset;
        if (key && SDR_PRESETS[key]) this.choosePreset(key);
      },
      { signal },
    );
    e.advancedBtn?.addEventListener(
      'click',
      () => {
        const open = e.advanced ? e.advanced.hidden : false;
        if (e.advanced) e.advanced.hidden = !open;
        e.advancedBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        setText(
          e.advancedBtn,
          open ? 'ADVANCED: EXACT FREQUENCY ▾' : 'ADVANCED: EXACT FREQUENCY ▸',
        );
      },
      { signal },
    );
    e.listenBtn?.addEventListener('click', () => this.listen(), { signal });
    e.openBtn?.addEventListener(
      'click',
      () => this.layer.openSelectedSdrReceiver?.(),
      { signal },
    );
    e.clearBtn?.addEventListener(
      'click',
      () => this.layer.clearSdrSelection?.(),
      {
        signal,
      },
    );
    e.flyBtn?.addEventListener(
      'click',
      () => {
        const r = this.layer.getSelectedSdrReceiver?.();
        if (r) flyTo(this.viewer, r.lat, r.lon, 25_000);
      },
      { signal },
    );
    this._unsubscribe = this.layer.subscribeSdr?.((state) => {
      this._state = state;
      this.render();
    });
    this._timer = setInterval(() => this.refreshList(), LIST_REFRESH_MS);
    this.refreshList({ force: true });
    this.render();
  }

  /** Apply a beginner preset: tune, filter the list by coverage, explain. */
  choosePreset(key) {
    const preset = SDR_PRESETS[key];
    if (!preset) return;
    this._preset = key;
    this._notice = null;
    const e = this.elements;
    if (e.freq) e.freq.value = (preset.freqHz / 1e6).toFixed(3);
    if (e.mode) e.mode.value = preset.mode;
    this.layer.setSdrTune?.({ freqHz: preset.freqHz, mode: preset.mode });
    for (const button of e.presets?.querySelectorAll('button[data-preset]') ??
      [])
      button.classList.toggle('active', button.dataset.preset === key);
    setText(e.presetHint, preset.hint);
    this.refreshList({ force: true });
    this.render();
  }

  /** The frequency LISTEN should use: the preset's, or the exact-tune row's. */
  async _resolveListenTune(anchor) {
    const preset = this._preset ? SDR_PRESETS[this._preset] : null;
    const tune = this._state?.tune;
    if (preset?.airband && this.atc?.ensureAtcDirectory && anchor) {
      try {
        await this.atc.ensureAtcDirectory();
        const [airport] =
          this.atc.findAtcAirports?.({
            ...anchor,
            toweredOnly: true,
            limit: 1,
          }) ?? [];
        const tower = airport?.freqs?.find(
          (f) => f.position === 'TWR' && !f.secondary,
        );
        if (tower)
          return {
            freqHz: Math.round(tower.mhz * 1e6),
            mode: 'am',
            label: `${airport.call || airport.id} Tower ${tower.mhz.toFixed(3)}`,
            liveAtcCode: airport.id,
          };
      } catch {
        /* fall through to the preset frequency */
      }
    }
    if (tune?.freqHz) return { freqHz: tune.freqHz, mode: tune.mode || 'am' };
    if (preset) return { freqHz: preset.freqHz, mode: preset.mode };
    return null;
  }

  /** One click: best receiver for the chosen band, opened inside the map. */
  async listen() {
    if (this._busy || this.destroyed) return;
    const e = this.elements;
    const anchor = viewportAnchor(this.viewer);
    const tune = await this._resolveListenTune(anchor);
    if (!tune) {
      this._notice = {
        text: 'Pick a band above (or type a frequency under ADVANCED) first.',
        error: true,
      };
      this.render();
      return;
    }
    this._busy = true;
    this._notice = null;
    if (e.listenBtn) e.listenBtn.disabled = true;
    this.render();
    try {
      if (!this.actions.isEnabled?.()) await toggleLayer(this, true);
      const selected = this.layer.getSelectedSdrReceiver?.();
      let result = null;
      if (selected && this._state?.tune?.freqHz === tune.freqHz) {
        result = {
          receiver: selected,
          url: this.layer.openSelectedSdrReceiver?.(),
        };
      } else {
        const vhf = tune.freqHz > VHF_FLOOR_HZ;
        result = await this.layer.listenSdr?.({
          ...tune,
          lat: anchor?.lat ?? 0,
          lon: anchor?.lon ?? 0,
          maxKm: vhf ? VHF_MAX_KM : Infinity,
        });
        if (!result && vhf) {
          // Say how far the nearest covering receiver really is, and for
          // the airband hand the tower to LiveATC's page instead.
          const [nearest] =
            this.layer.findSdrReceivers?.({
              lat: anchor?.lat ?? 0,
              lon: anchor?.lon ?? 0,
              freqHz: tune.freqHz,
              coveredOnly: true,
              limit: 1,
            }) ?? [];
          const why = nearest
            ? `The nearest public receiver that covers ${(tune.freqHz / 1e6).toFixed(3)} MHz is ${kmText(nearest.distanceKm)} away — too far to hear anything above 30 MHz (line-of-sight).`
            : `No public receiver in the directory covers ${(tune.freqHz / 1e6).toFixed(3)} MHz.`;
          if (tune.liveAtcCode && this.dock?.open) {
            this.dock.open(
              `https://www.liveatc.net/search/?icao=${tune.liveAtcCode}`,
              {
                kind: 'liveatc',
                layerId: 'sdr',
                title: tune.label || `${tune.liveAtcCode} Tower`,
                subtitle: `${(tune.freqHz / 1e6).toFixed(3)} MHz AM`,
                note: `Press LISTEN on LiveATC's page for ${(tune.freqHz / 1e6).toFixed(3)} MHz.`,
              },
            );
            this._notice = {
              text: `${why} LiveATC's page for ${tune.liveAtcCode} opened in its own tab instead (LiveATC refuses to load inside other sites) — press LISTEN there.`,
              error: false,
            };
            return;
          }
          this._notice = {
            text: `${why} Move the map closer to a receiver, or pick a receiver from the list.`,
            error: true,
          };
          return;
        }
      }
      this._notice = {
        text: result
          ? `Listening ${tune.label || `${(tune.freqHz / 1e6).toFixed(3)} MHz ${String(tune.mode).toUpperCase()}`} on ${result.receiver.name}${Number.isFinite(result.receiver.distanceKm) ? ` (${kmText(result.receiver.distanceKm)} away)` : ''}`
          : 'No public receiver in the directory covers that frequency. Try another band, or pick a receiver from the list.',
        error: !result,
      };
    } finally {
      this._busy = false;
      this.refreshList({ force: true });
      this.render();
    }
  }

  refreshList({ force = false } = {}) {
    if (this.destroyed) return;
    const enabled = this.actions.isEnabled?.();
    if (!enabled) {
      if (this._rows.length) {
        this._rows = [];
        this.renderList();
      }
      return;
    }
    const camera = this.viewer?.camera;
    const pose = camera ? cameraPoseSignature(camera) : null;
    if (!force && pose === this._pose) return;
    this._pose = pose;
    const anchor = viewportAnchor(this.viewer);
    if (!anchor) return;
    const q = String(this.elements.search?.value ?? '')
      .toLowerCase()
      .trim();
    const tune = this._state?.tune;
    const candidates =
      this.layer.findSdrReceivers?.({
        ...anchor,
        freqHz: tune?.freqHz,
        coveredOnly: Boolean(this._preset),
        limit: q ? 200 : 14,
      }) ?? [];
    this._rows = q
      ? candidates
          .filter((r) =>
            `${r.name} ${r.type} ${r.url}`.toLowerCase().includes(q),
          )
          .slice(0, 14)
      : candidates;
    this.renderList();
  }

  renderList() {
    const e = this.elements;
    const selectedId = this._state?.selected ?? null;
    const typeLabel = {
      kiwisdr: 'KiwiSDR',
      websdr: 'WebSDR',
      openwebrx: 'OpenWebRX',
      ubersdr: 'UberSDR',
      novasdr: 'NovaSDR',
      web888: 'Web-888',
      sdr: 'SDR',
    };
    renderList({
      list: e.list,
      rows: this._rows,
      selectedId,
      render: (button, row) => {
        button.innerHTML = `<span class="audio-list-dot ${row.type}" aria-hidden="true"></span><span class="audio-list-main"><strong></strong><span></span></span><span class="audio-list-side"><b></b><i></i></span>`;
        setText(button.querySelector('strong'), row.name);
        const band = Array.isArray(row.bands)
          ? `${(row.bands[0] / 1e6).toFixed(row.bands[0] ? 1 : 0)}–${(row.bands[1] / 1e6).toFixed(row.bands[1] >= 100e6 ? 0 : 1)} MHz`
          : 'band unlisted';
        setText(button.querySelector('.audio-list-main span'), band);
        setText(button.querySelector('b'), typeLabel[row.type] || 'SDR');
        setText(button.querySelector('i'), kmText(row.distanceKm));
        button.title =
          row.id === selectedId
            ? 'Click to open this receiver'
            : `Select ${row.name}`;
      },
      onPick: (row) => {
        if (row.id === selectedId) this.layer.openSelectedSdrReceiver?.();
        else this.layer.selectSdrReceiver?.(row.id);
      },
    });
    if (e.listCount)
      setText(
        e.listCount,
        this._rows.length
          ? `${this._rows.length} shown of ${this._state?.receivers ?? 0}${this._state?.tune ? ' covering ' + (this._state.tune.freqHz / 1e6).toFixed(3) + ' MHz' : ''}`
          : '',
      );
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const s = this._state;
    const lifecycle = lifecycleState(this);
    const enabled = lifecycle === 'enabled';
    paintEnableButton(this, lifecycle);
    if (e.layerState) {
      setText(
        e.layerState,
        enabled
          ? s?.selected
            ? 'SELECTED'
            : `${s?.receivers ?? 0} RX`
          : lifecycle === 'enabling'
            ? 'SYNC'
            : 'OFF',
      );
      e.layerState.classList.toggle('active', enabled);
    }
    for (const el of [e.search, e.freq, e.mode]) if (el) el.disabled = !enabled;
    if (e.listenBtn)
      e.listenBtn.disabled =
        this._busy ||
        lifecycle === 'enabling' ||
        lifecycle === 'disabling' ||
        !(this._preset || s?.tune?.freqHz);
    const r = enabled ? s?.selectedReceiver : null;
    if (e.openBtn) e.openBtn.disabled = !r;
    if (e.flyBtn) e.flyBtn.disabled = !r;
    if (e.clearBtn) e.clearBtn.disabled = !r;
    if (e.nowName)
      setText(
        e.nowName,
        r ? r.name : enabled ? 'NO RECEIVER SELECTED' : 'SDR OFF',
      );
    if (e.nowMeta) {
      if (r) {
        const parts = [];
        if (Array.isArray(r.bands))
          parts.push(
            `${(r.bands[0] / 1e6).toFixed(1)}–${(r.bands[1] / 1e6).toFixed(1)} MHz`,
          );
        if (r.antenna) parts.push(r.antenna);
        if (r.usersMax) parts.push(`${r.usersMax} slots`);
        if (s.tune)
          parts.push(
            `tune ${(s.tune.freqHz / 1e6).toFixed(3)} MHz ${String(s.tune.mode).toUpperCase()}`,
          );
        try {
          parts.push(new URL(r.url).host);
        } catch {
          /* ignore */
        }
        setText(e.nowMeta, parts.join(' · '));
      } else {
        setText(
          e.nowMeta,
          enabled
            ? 'Pick a receiver from the list or a globe marker. Set a frequency to filter by coverage.'
            : 'Enable SDR, then pick a receiver from the list or a globe marker.',
        );
      }
    }
    if (e.playbackState) {
      const notice = this._busy
        ? { text: 'Finding the nearest receiver that covers it…', error: false }
        : this._notice;
      setText(
        e.playbackState,
        notice
          ? notice.text
          : !enabled
            ? 'SDR off — pick a band and press LISTEN'
            : s?.error
              ? s.error
              : r
                ? 'OPEN HERE shows this receiver on the map, tuned if a frequency is set'
                : `${s?.receivers ?? 0} public receivers in the directory`,
      );
      e.playbackState.classList.toggle(
        'error',
        Boolean(notice ? notice.error : s?.error),
      );
    }
    this.renderList();
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

const ATC_POSITION_ORDER = [
  'TWR',
  'GND',
  'CLD',
  'APP',
  'DEP',
  'CTR',
  'ATIS',
  'CTAF',
  'UNICOM',
  'AFIS',
  'INFO',
  'RAMP',
  'WX',
];
const ATC_POSITION_NAMES = {
  TWR: 'TOWER',
  GND: 'GROUND',
  CLD: 'CLEARANCE',
  APP: 'APPROACH',
  DEP: 'DEPARTURE',
  CTR: 'CENTER',
  ATIS: 'ATIS',
  CTAF: 'CTAF',
  UNICOM: 'UNICOM',
  AFIS: 'AFIS',
  INFO: 'INFO',
  RAMP: 'RAMP',
  WX: 'WEATHER',
};

/** ATC panel. */
export class AtcPanel {
  constructor({ elements, layer, actions, viewer, dock = null }) {
    this.elements = elements;
    this.layer = layer;
    this.actions = actions;
    this.viewer = viewer;
    /** The in-map receiver dock, closed by STOP. */
    this.dock = dock;
    this.label = 'ATC';
    this.destroyed = false;
    this._abort = new AbortController();
    this._unsubscribe = null;
    this._timer = null;
    this._pose = null;
    this._state = null;
    this._rows = [];
    this._position = null;
  }

  connect() {
    const { signal } = this._abort;
    const e = this.elements;
    e.enableBtn?.addEventListener(
      'click',
      () => toggleLayer(this, !this.actions.isEnabled?.()),
      { signal },
    );
    e.search?.addEventListener(
      'input',
      () => this.refreshList({ force: true }),
      { signal },
    );
    e.toweredOnly?.addEventListener(
      'change',
      () => this.refreshList({ force: true }),
      { signal },
    );
    e.freqs?.addEventListener(
      'click',
      (event) => {
        const button = event.target?.closest?.('button[data-position]');
        if (!button) return;
        this._position = button.dataset.position;
        this.layer.listenAtc?.({ position: this._position });
      },
      { signal },
    );
    e.listenBtn?.addEventListener(
      'click',
      () => this.layer.listenAtc?.({ position: this._position || undefined }),
      { signal },
    );
    e.followBtn?.addEventListener(
      'click',
      () => this.layer.setAtcFollow?.(!this._state?.follow?.active),
      { signal },
    );
    e.flyBtn?.addEventListener(
      'click',
      () => {
        const a = this.layer.getSelectedAtcAirport?.();
        if (a) flyTo(this.viewer, a.lat, a.lon, 18_000);
      },
      { signal },
    );
    e.stopBtn?.addEventListener(
      'click',
      () => {
        this.layer.setAtcFollow?.(false);
        this.layer.stopAtc?.();
        this.dock?.close?.();
      },
      { signal },
    );
    this._unsubscribe = this.layer.subscribeAtc?.((state) => {
      if (state?.selected !== this._state?.selected) this._position = null;
      this._state = state;
      this.render();
    });
    this._timer = setInterval(() => this.refreshList(), LIST_REFRESH_MS);
    this.refreshList({ force: true });
    this.render();
  }

  refreshList({ force = false } = {}) {
    if (this.destroyed) return;
    const enabled = this.actions.isEnabled?.();
    if (!enabled) {
      if (this._rows.length) {
        this._rows = [];
        this.renderList();
      }
      return;
    }
    const camera = this.viewer?.camera;
    const pose = camera ? cameraPoseSignature(camera) : null;
    if (!force && pose === this._pose) return;
    this._pose = pose;
    const anchor = viewportAnchor(this.viewer);
    if (!anchor) return;
    this._rows =
      this.layer.findAtcAirports?.({
        ...anchor,
        query: this.elements.search?.value ?? '',
        toweredOnly: this.elements.toweredOnly?.checked ?? true,
        limit: 14,
      }) ?? [];
    this.renderList();
  }

  renderList() {
    const e = this.elements;
    const selectedId = this._state?.selected ?? null;
    renderList({
      list: e.list,
      rows: this._rows,
      selectedId,
      render: (button, row) => {
        const tower = row.freqs?.find(
          (f) => f.position === 'TWR' && !f.secondary,
        );
        const ctaf = row.freqs?.find((f) => f.position === 'CTAF');
        const kind = row.towered
          ? row.hours === '24'
            ? 'tower24'
            : 'tower'
          : 'untowered';
        button.innerHTML = `<span class="audio-list-dot ${kind}" aria-hidden="true"></span><span class="audio-list-main"><strong></strong><span></span></span><span class="audio-list-side"><b></b><i></i></span>`;
        setText(button.querySelector('strong'), `${row.id} · ${row.name}`);
        const region = row.country === 'US' ? row.region : row.country;
        setText(
          button.querySelector('.audio-list-main span'),
          [row.city, region].filter(Boolean).join(', ') +
            (row.towered
              ? ` · tower ${row.hours === '24' ? '24 h' : row.hours || 'part time'}`
              : ' · no tower'),
        );
        setText(
          button.querySelector('b'),
          tower
            ? `TWR ${tower.mhz.toFixed(3)}`
            : ctaf
              ? `CTAF ${ctaf.mhz.toFixed(3)}`
              : `${row.freqs?.length ?? 0} freqs`,
        );
        setText(button.querySelector('i'), kmText(row.distanceKm));
        button.title =
          row.id === selectedId
            ? 'Click to listen'
            : `Select ${row.id} ${row.name}`;
      },
      onPick: (row) => {
        if (row.id === selectedId) this.layer.listenAtc?.({});
        else this.layer.selectAtcAirport?.(row.id);
      },
    });
    if (e.listCount)
      setText(
        e.listCount,
        this._rows.length
          ? `${this._rows.length} shown · ${this._state?.towered ?? 0} towered of ${this._state?.airports ?? 0}`
          : '',
      );
  }

  renderFrequencies(airport) {
    const e = this.elements;
    if (!e.freqs) return;
    e.freqs.replaceChildren();
    if (!airport) return;
    const listening = this._state?.listening;
    const seen = new Set();
    const rows = [...airport.freqs].sort(
      (a, b) =>
        ATC_POSITION_ORDER.indexOf(a.position) -
          ATC_POSITION_ORDER.indexOf(b.position) ||
        Number(a.secondary) - Number(b.secondary),
    );
    for (const f of rows) {
      const key = `${f.position}|${f.mhz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'audio-freq-chip';
      button.dataset.position = f.position;
      button.dataset.mhz = String(f.mhz);
      const active =
        listening &&
        listening.airport?.id === airport.id &&
        listening.frequency?.mhz === f.mhz;
      const chosen =
        (this._position || this._state?.selectedPosition) === f.position &&
        !f.secondary;
      button.classList.toggle('active', Boolean(active));
      button.classList.toggle('chosen', Boolean(chosen) && !active);
      button.innerHTML = '<b></b><span></span><i></i>';
      setText(
        button.querySelector('b'),
        ATC_POSITION_NAMES[f.position] || f.position,
      );
      setText(button.querySelector('span'), f.mhz.toFixed(3));
      setText(
        button.querySelector('i'),
        f.sector || (f.secondary ? 'secondary' : ''),
      );
      button.title = `Listen to ${ATC_POSITION_NAMES[f.position] || f.position} ${f.mhz.toFixed(3)} MHz`;
      e.freqs.append(button);
    }
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const s = this._state;
    const lifecycle = lifecycleState(this);
    const enabled = lifecycle === 'enabled';
    paintEnableButton(this, lifecycle);
    const listening = enabled ? s?.listening : null;
    const follow = s?.follow;
    if (e.layerState) {
      setText(
        e.layerState,
        enabled
          ? follow?.active
            ? 'FOLLOWING'
            : listening
              ? 'LISTENING'
              : s?.loaded
                ? `${s.towered} TOWERS`
                : 'LOADING'
          : lifecycle === 'enabling'
            ? 'SYNC'
            : 'OFF',
      );
      e.layerState.classList.toggle('active', enabled);
    }
    if (e.search) e.search.disabled = !enabled;
    const airport = enabled ? s?.selectedAirport : null;
    if (e.listenBtn) e.listenBtn.disabled = !airport;
    if (e.flyBtn) e.flyBtn.disabled = !airport;
    if (e.followBtn) {
      e.followBtn.disabled = !enabled;
      e.followBtn.classList.toggle('active', Boolean(follow?.active));
      e.followBtn.setAttribute(
        'aria-pressed',
        follow?.active ? 'true' : 'false',
      );
      setText(e.followBtn, follow?.active ? 'FOLLOWING ✓' : 'FOLLOW PLANE');
    }
    if (e.stopBtn) e.stopBtn.disabled = !(listening || follow?.active);
    if (e.nowName)
      setText(
        e.nowName,
        airport
          ? `${airport.id} · ${airport.name}`
          : enabled
            ? 'NO AIRPORT SELECTED'
            : 'ATC OFF',
      );
    if (e.nowMeta) {
      if (airport) {
        const region =
          airport.country === 'US' ? airport.region : airport.country;
        const parts = [[airport.city, region].filter(Boolean).join(', ')];
        parts.push(
          airport.towered
            ? `${airport.call ? airport.call + ' Tower' : 'Towered'} · ${airport.hours === '24' ? '24 h' : airport.hours || 'part time'}`
            : 'No tower — pilots self-announce on CTAF',
        );
        if (airport.appCall) parts.push(`approach: ${airport.appCall}`);
        setText(e.nowMeta, parts.join(' · '));
      } else {
        setText(
          e.nowMeta,
          enabled
            ? 'Pick an airport from the list or a globe marker, then tap a frequency.'
            : 'Enable ATC, then pick an airport from the list or a globe marker.',
        );
      }
    }
    this.renderFrequencies(airport);
    if (e.followState) {
      const contact = follow?.contact;
      e.followState.hidden = !(follow?.active && enabled);
      setText(
        e.followContact,
        contact
          ? `${contact.label}${contact.route ? ' · ' + contact.route : ''}`
          : 'Select a plane on the globe (Live Flights or Military) to follow it.',
      );
      setText(
        e.followPhase,
        contact
          ? `${follow.phaseLabel || ''}${listening ? ' → ' + listening.facility + ' ' + (listening.frequency ? listening.frequency.mhz.toFixed(3) : '') : ''}`
          : '',
      );
    }
    if (e.playbackState) {
      const error = s?.error;
      setText(
        e.playbackState,
        !enabled
          ? 'ATC off'
          : error
            ? error
            : listening
              ? listening.via === 'sdr'
                ? `Tuned ${listening.facility} ${listening.frequency?.mhz.toFixed(3)} MHz on ${listening.receiver?.name || 'a web SDR'} — audio in the window on the map`
                : `${listening.facility} ${listening.frequency?.mhz.toFixed(3) ?? ''} MHz — no airband SDR within 90 km, so LiveATC's page for ${listening.airport?.id || 'the airport'} is open in its own tab (LiveATC blocks embedding): press LISTEN there for that frequency`
              : airport
                ? 'Tap a frequency, or press LISTEN for the tower'
                : `${s?.towered ?? 0} towered airports · ${s?.airports ?? 0} with published frequencies`,
      );
      e.playbackState.classList.toggle('error', Boolean(error));
    }
    this.renderList();
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
