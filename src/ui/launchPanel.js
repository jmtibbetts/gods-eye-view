import * as Cesium from 'cesium';
import {
  countdownText,
  launchPhase,
  listenSourcesFor,
  normalizeLaunchWatch,
  phaseLabel,
  primaryWebcast,
  sortForWatch,
  watchableLaunches,
} from '../data/launchWatch.js';

/**
 * LAUNCH — the next launches as live countdowns, each with the honest way
 * to watch it and to hear it.
 *
 * WATCH opens the operator's webcast: framed in the receiver dock when the
 * publisher allows it (YouTube), otherwise on the publisher's own page.
 * FLY TO PAD puts the camera on the pad with a clock over it, so the
 * countdown, the pad and the stream are on screen together. LISTEN lists
 * what a radio near the range can actually hear — the range's own trunked
 * system where one is on OpenMHz, the tower and approach frequencies of the
 * airfields on and around the range, and the web SDRs nearby — each labelled
 * for what it is. The mission nets on the webcast are the operator's own
 * loops mixed into the stream; no public receiver hears them, and this panel
 * never suggests otherwise.
 */

/** "128.55", "118.9", "121.0" — the way a frequency is read on the air. */
export function mhzText(mhz) {
  if (!Number.isFinite(mhz)) return '';
  return mhz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');
}

const REFRESH_MS = 60_000;
const TICK_MS = 1000;
const LISTEN_CACHE_MS = 10 * 60_000;
const PAD_VIEW_HEIGHT_M = 6000;

export class LaunchPanel {
  /**
   * @param {object} options
   * @param {object} options.elements `{ state, body, note }`.
   * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl]
   * @param {object|null} [options.viewer] The Cesium viewer, for FLY TO PAD and the pad clock.
   * @param {(url: string, meta: object) => void} options.openInDock The receiver dock hand-off.
   * @param {(url: string) => void} [options.openTab] Open a page in its own tab.
   * @param {() => object|null} [options.scanner] The scanner layer when registered.
   * @param {() => object|null} [options.atc] The ATC layer when registered.
   * @param {() => object|null} [options.sdr] The SDR layer when registered.
   * @param {(layerId: string) => Promise<unknown>} [options.enableLayer]
   * @param {(layerId: string) => boolean} [options.isLayerEnabled]
   * @param {(message: string) => void} [options.onToast]
   * @param {Window} [options.windowRef]
   * @param {() => number} [options.now]
   */
  constructor({
    elements,
    fetchImpl = (...args) => globalThis.fetch(...args),
    viewer = null,
    openInDock,
    openTab = null,
    scanner = () => null,
    atc = () => null,
    sdr = () => null,
    enableLayer = async () => {},
    isLayerEnabled = () => false,
    onToast = () => {},
    windowRef = globalThis.window,
    now = () => Date.now(),
  } = {}) {
    this.elements = elements || {};
    this._fetch = fetchImpl;
    this._viewer = viewer;
    this._openInDock = openInDock;
    this._openTab =
      openTab ||
      ((url) => {
        if (typeof window === 'undefined') return;
        const tab = window.open(url, '_blank', 'noopener,noreferrer');
        if (tab) tab.opener = null;
      });
    this._scanner = scanner;
    this._atc = atc;
    this._sdr = sdr;
    this._enableLayer = enableLayer;
    this._isLayerEnabled = isLayerEnabled;
    this.onToast = onToast;
    this._window = windowRef;
    this._now = now;
    this._abort = new AbortController();
    this.destroyed = false;
    this._launches = [];
    this._error = null;
    this._loadedAt = 0;
    this._refreshTimer = null;
    this._tickTimer = null;
    this._request = null;
    this._listenOpen = null;
    this._listen = new Map();
    this._clocks = new Map();
    this._followedId = null;
    this._padEntity = null;
    this._busy = false;
  }

  connect() {
    this.render();
    void this.refresh();
    const w = this._window;
    const setTimer = w?.setInterval ? w.setInterval.bind(w) : setInterval;
    this._refreshTimer = setTimer(() => void this.refresh(), REFRESH_MS);
    this._tickTimer = setTimer(() => this.tick(), TICK_MS);
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._request?.abort();
    const w = this._window;
    const clear = w?.clearInterval ? w.clearInterval.bind(w) : clearInterval;
    if (this._refreshTimer != null) clear(this._refreshTimer);
    if (this._tickTimer != null) clear(this._tickTimer);
    this._refreshTimer = null;
    this._tickTimer = null;
    this._unfollow();
  }

  /** Pull the upcoming feed; a failure keeps the last good list. */
  async refresh() {
    if (this.destroyed) return false;
    this._request?.abort();
    const request = new AbortController();
    this._request = request;
    try {
      const response = await this._fetch('/api/launches/upcoming', {
        signal: request.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (request.signal.aborted || this.destroyed) return false;
      this._launches = normalizeLaunchWatch(payload);
      this._loadedAt = this._now();
      this._error = null;
      this.render();
      return true;
    } catch (error) {
      if (request.signal.aborted || this.destroyed) return false;
      this._error = 'Launch Library 2 unavailable';
      this.render();
      return false;
    } finally {
      if (this._request === request) this._request = null;
    }
  }

  /** The list as it should read right now. */
  _visible() {
    const now = this._now();
    return sortForWatch(watchableLaunches(this._launches, now), now);
  }

  _el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  _button(label, className, onClick, title) {
    const btn = this._el('button', className, label);
    btn.type = 'button';
    if (title) btn.title = title;
    btn.addEventListener('click', onClick, { signal: this._abort.signal });
    return btn;
  }

  /** Once a second: clocks and the header, without a rebuild. */
  tick() {
    if (this.destroyed) return;
    const now = this._now();
    let phaseChanged = false;
    for (const { el, record, phase } of this._clocks.values()) {
      if (launchPhase(record, now) !== phase) phaseChanged = true;
      el.textContent = this._clockText(record, now);
    }
    this._renderState(now);
    // A launch crossing T-0 or a hold lifting changes chips and order.
    if (phaseChanged) this.render();
  }

  _clockText(record, now) {
    const phase = launchPhase(record, now);
    const text = countdownText(record.net, now);
    if (phase === 'tbd')
      return record.net ? `NET ${record.net.slice(0, 10)}` : 'NET TBD';
    if (phase === 'hold') return text ? `${text} · HOLD` : 'HOLD';
    return text || '';
  }

  _renderState(now = this._now()) {
    const { state } = this.elements;
    if (!state) return;
    const list = this._visible();
    const top = list[0];
    if (!top) {
      state.textContent = this._error ? 'OFFLINE' : 'NONE';
      return;
    }
    const phase = launchPhase(top, now);
    const short = (top.name || '').split('|')[0].trim().toUpperCase();
    const lead =
      phase === 'flying'
        ? 'IN FLIGHT'
        : phase === 'flown'
          ? phaseLabel(phase, top)
          : this._clockText(top, now);
    const text = `${lead} · ${short}`;
    state.textContent = text;
  }

  render() {
    if (this.destroyed) return;
    const { body, note } = this.elements;
    if (!body) return;
    const now = this._now();
    body.textContent = '';
    this._clocks.clear();
    const list = this._visible();
    this._renderState(now);

    if (!list.length) {
      body.append(
        this._el(
          'p',
          'launch-empty',
          this._error
            ? 'Launch Library 2 is unreachable right now — the list comes back when it is.'
            : this._loadedAt
              ? 'Nothing on the manifest for the next few days.'
              : 'Loading the launch manifest…',
        ),
      );
      if (note) note.textContent = '';
      return;
    }
    for (const record of list) body.append(this._renderLaunch(record, now));
    if (note)
      note.textContent = this._error
        ? 'Launch Library 2 is unreachable — showing the last manifest it sent. Clocks keep running from the last known net.'
        : 'Times are the operator’s latest net, from Launch Library 2; a scrub or hold shows as soon as its editors post it. Nothing here is telemetry: the pad and the clock are on the globe, the rocket is on the webcast.';
  }

  _renderLaunch(record, now) {
    const phase = launchPhase(record, now);
    const row = this._el('div', `launch-row launch-row-${phase}`);
    row.dataset.launchId = record.id;

    const head = this._el('div', 'launch-head');
    head.append(this._el('span', 'launch-name', record.name));
    head.append(
      this._el(
        'span',
        `launch-chip launch-chip-${phase}`,
        phaseLabel(phase, record),
      ),
    );
    row.append(head);

    const clock = this._el('div', 'launch-clock', this._clockText(record, now));
    this._clocks.set(record.id, { el: clock, record, phase });
    row.append(clock);

    const who = [record.provider, record.rocket].filter(Boolean).join(' · ');
    if (who) row.append(this._el('div', 'launch-meta', who));
    const where = [record.padName, record.siteName].filter(Boolean).join(' · ');
    if (where) row.append(this._el('div', 'launch-meta', where));
    const facts = [];
    if (record.netPrecision && record.netPrecision !== 'Second')
      facts.push(`net precision ${record.netPrecision.toLowerCase()}`);
    if (
      record.windowStart &&
      record.windowEnd &&
      record.windowStart !== record.windowEnd
    )
      facts.push(
        `window ${record.windowStart.slice(11, 16)}–${record.windowEnd.slice(11, 16)} UTC`,
      );
    if (Number.isFinite(record.probability))
      facts.push(`${record.probability}% weather go`);
    if (record.weatherConcerns) facts.push(record.weatherConcerns);
    if (phase === 'hold' && record.holdReason)
      facts.push(`hold: ${record.holdReason}`);
    if (phase === 'flown' && record.failReason) facts.push(record.failReason);
    if (facts.length)
      row.append(
        this._el('div', 'launch-meta launch-facts', facts.join(' · ')),
      );
    if (record.latestUpdate?.comment) {
      const update = this._el('div', 'launch-update');
      const stamp = record.latestUpdate.at
        ? `${record.latestUpdate.at.slice(11, 16)}Z · `
        : '';
      update.textContent = `${stamp}${record.latestUpdate.comment.slice(0, 160)}`;
      row.append(update);
    }

    const actions = this._el('div', 'launch-actions');
    const webcast = primaryWebcast(record);
    if (webcast) {
      const live = record.webcastLive || webcast.live;
      actions.append(
        this._button(
          live ? 'WATCH · LIVE' : 'WATCH',
          `launch-btn launch-btn-watch${live ? ' live' : ''}`,
          () => this._watch(record, webcast),
          webcast.embedUrl
            ? `${webcast.title} — opens in the receiver dock`
            : `${webcast.title} — ${webcast.publisher || 'the publisher'} does not allow framing, so it opens in its own tab`,
        ),
      );
    } else {
      actions.append(this._el('span', 'launch-nocast', 'NO WEBCAST LISTED'));
    }
    actions.append(
      this._button(
        this._listenOpen === record.id ? 'LISTEN ▴' : 'LISTEN',
        'launch-btn',
        () => this._toggleListen(record),
        'What a radio near the range can hear',
      ),
    );
    if (Number.isFinite(record.lat) && Number.isFinite(record.lon)) {
      actions.append(
        this._button(
          this._followedId === record.id ? 'ON PAD' : 'FLY TO PAD',
          `launch-btn${this._followedId === record.id ? ' active' : ''}`,
          () => this._flyToPad(record),
          'Put the camera on the pad with the clock over it',
        ),
      );
    }
    row.append(actions);

    if (this._listenOpen === record.id) row.append(this._renderListen(record));
    return row;
  }

  _watch(record, webcast) {
    if (webcast.embedUrl && this._openInDock) {
      this._openInDock(webcast.embedUrl, {
        kind: 'video',
        layerId: 'launches',
        title: record.name,
        subtitle: webcast.publisher || 'Webcast',
        note: 'The mission audio on this stream is the operator’s own nets, mixed in by them — it is not a public band. If the player says the video is unavailable, the publisher has switched embedding off or the stream has not started yet: POP OUT opens it on YouTube.',
      });
      return;
    }
    this._openTab(webcast.url);
    this.onToast(
      `${webcast.publisher || 'This publisher'} does not allow its player inside other sites — the webcast is open in its own tab.`,
    );
  }

  _toggleListen(record) {
    this._listenOpen = this._listenOpen === record.id ? null : record.id;
    this.render();
    if (this._listenOpen === record.id) void this._loadListen(record);
  }

  /** Gather the directories once per launch; each layer loads its own seed. */
  async _loadListen(record) {
    const cached = this._listen.get(record.id);
    if (cached && this._now() - cached.at < LISTEN_CACHE_MS) return;
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) {
      this._listen.set(record.id, {
        at: this._now(),
        sources: listenSourcesFor(record, {}),
        ready: true,
      });
      this.render();
      return;
    }
    const directories = {};
    const scanner = this._scanner();
    const atc = this._atc();
    const sdr = this._sdr();
    const tasks = [];
    if (scanner?.nearestScannerSystems)
      tasks.push(
        Promise.resolve(scanner.ensureScannerSeed?.())
          .then(() => {
            directories.scannerSystems = scanner.nearestScannerSystems({
              lat: record.lat,
              lon: record.lon,
              limit: 6,
            });
          })
          .catch(() => {}),
      );
    if (atc?.findAtcAirports)
      tasks.push(
        Promise.resolve(atc.ensureAtcDirectory?.())
          .then(() => {
            directories.airports = atc.findAtcAirports({
              lat: record.lat,
              lon: record.lon,
              limit: 10,
            });
          })
          .catch(() => {}),
      );
    if (sdr?.findSdrReceivers)
      tasks.push(
        Promise.resolve(sdr.ensureSdrDirectory?.())
          .then(() => {
            directories.receivers = sdr.findSdrReceivers({
              lat: record.lat,
              lon: record.lon,
              limit: 6,
            });
          })
          .catch(() => {}),
      );
    await Promise.all(tasks);
    if (this.destroyed) return;
    this._listen.set(record.id, {
      at: this._now(),
      sources: listenSourcesFor(record, directories),
      ready: true,
    });
    this.render();
  }

  _renderListen(record) {
    const wrap = this._el('div', 'launch-listen');
    const entry = this._listen.get(record.id);
    const webcast = primaryWebcast(record);

    wrap.append(this._el('div', 'launch-listen-heading', 'MISSION AUDIO'));
    wrap.append(
      this._el(
        'p',
        'launch-listen-note',
        webcast
          ? 'The countdown net, the flight director loop and the vehicle callouts are the operator’s own circuits, mixed into their webcast. That stream is the only place they are heard — press WATCH.'
          : 'No webcast is listed for this launch, so its mission audio is not public anywhere.',
      ),
    );

    if (!entry?.ready) {
      wrap.append(
        this._el(
          'p',
          'launch-listen-note',
          'Checking the radio directories around the pad…',
        ),
      );
      return wrap;
    }
    const { scanner, airband, sdr } = entry.sources;

    wrap.append(
      this._el('div', 'launch-listen-heading', 'RANGE RADIO · OPENMHZ'),
    );
    if (!scanner.length) {
      wrap.append(
        this._el(
          'p',
          'launch-listen-note',
          'No trunked public-safety system within 120 km of this pad is on OpenMHz.',
        ),
      );
    } else {
      for (const s of scanner) {
        const line = this._el('div', 'launch-source');
        line.append(
          this._el(
            'span',
            'launch-source-name',
            `${s.name}${s.onRange ? ' · ON THE RANGE' : ''}`,
          ),
        );
        line.append(
          this._el(
            'span',
            'launch-source-meta',
            [
              s.place,
              `${s.distanceKm} km`,
              s.callAvg ? `${s.callAvg.toFixed(1)}/min` : 'quiet',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        );
        line.append(
          this._button(
            'LISTEN',
            'launch-btn launch-btn-small',
            () => void this._listenScanner(s),
          ),
        );
        wrap.append(line);
      }
      wrap.append(
        this._el(
          'p',
          'launch-listen-note',
          'Security, fire, operations and range-support talkgroups, a clip per transmission seconds after it airs. Not the countdown net.',
        ),
      );
    }

    wrap.append(this._el('div', 'launch-listen-heading', 'AIRBAND · LIVEATC'));
    if (!airband.length) {
      wrap.append(
        this._el(
          'p',
          'launch-listen-note',
          'No airfield with a published VHF frequency within 60 km.',
        ),
      );
    } else {
      for (const a of airband.slice(0, 5)) {
        const line = this._el('div', 'launch-source');
        line.append(
          this._el(
            'span',
            'launch-source-name',
            `${a.id} ${a.call ? `${a.call} ` : ''}${a.onRange ? '· ON THE RANGE' : ''}`.trim(),
          ),
        );
        line.append(
          this._el(
            'span',
            'launch-source-meta',
            `${a.freqs.map((f) => `${f.position} ${mhzText(f.mhz)}`).join(' · ')} · ${a.distanceKm} km`,
          ),
        );
        line.append(
          this._button(
            'LISTEN',
            'launch-btn launch-btn-small',
            () => void this._listenAtc(a),
          ),
        );
        wrap.append(line);
      }
      wrap.append(
        this._el(
          'p',
          'launch-listen-note',
          'Tower and approach for the range’s own strips and the airfields under the closure. LiveATC carries feeds for some of them and opens in its own tab; the airspace clearing before a launch is what you will hear.',
        ),
      );
    }

    wrap.append(this._el('div', 'launch-listen-heading', 'WEB SDR'));
    if (!sdr.length) {
      wrap.append(
        this._el(
          'p',
          'launch-listen-note',
          'No public web receiver within 250 km of this pad.',
        ),
      );
    } else {
      const airbandCapable = sdr.filter((r) => r.coversAirband);
      const tower =
        airband[0]?.freqs.find((f) => f.position === 'TWR') ||
        airband[0]?.freqs[0];
      if (airbandCapable.length && tower) {
        const line = this._el('div', 'launch-source');
        line.append(
          this._el('span', 'launch-source-name', `${airbandCapable[0].name}`),
        );
        line.append(
          this._el(
            'span',
            'launch-source-meta',
            `covers VHF airband · ${airbandCapable[0].distanceKm} km`,
          ),
        );
        line.append(
          this._button(
            `TUNE ${mhzText(tower.mhz)} AM`,
            'launch-btn launch-btn-small',
            () => void this._tuneSdr(record, tower.mhz),
          ),
        );
        wrap.append(line);
      }
      for (const r of sdr.filter((x) => !x.coversAirband).slice(0, 3)) {
        const line = this._el('div', 'launch-source');
        line.append(this._el('span', 'launch-source-name', r.name));
        line.append(
          this._el(
            'span',
            'launch-source-meta',
            `${r.distanceKm} km · ${r.hfOnly ? 'HF only (0–30 MHz) — cannot hear the range' : r.rangeKnown ? 'does not cover airband' : 'coverage unpublished'}`,
          ),
        );
        line.append(
          this._button('OPEN', 'launch-btn launch-btn-small', () =>
            this._openTab(r.url),
          ),
        );
        wrap.append(line);
      }
      wrap.append(
        this._el(
          'p',
          'launch-listen-note',
          airbandCapable.length
            ? 'A receiver that covers 118–137 MHz can be tuned to the tower in AM; range UHF nets are outside every public receiver.'
            : 'Every public receiver near this pad is HF only. Launch-day traffic is VHF and UHF, so none of them can hear it — they are listed so the map is honest, not as a way in.',
        ),
      );
    }
    return wrap;
  }

  async _listenScanner(system) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this._isLayerEnabled('scanner')) await this._enableLayer('scanner');
      const layer = this._scanner();
      const ok = layer?.selectScannerSystem?.(system.id);
      if (!ok)
        this.onToast(
          `Could not tune ${system.name} — turn on Scanners and pick it from the list.`,
        );
    } finally {
      this._busy = false;
    }
  }

  async _listenAtc(airport) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this._isLayerEnabled('atc')) await this._enableLayer('atc');
      const layer = this._atc();
      const position = airport.freqs.find((f) => f.position === 'TWR')
        ? 'TWR'
        : airport.freqs[0]?.position;
      const result = await layer?.listenAtc?.({
        airportId: airport.id,
        position,
      });
      if (!result)
        this.onToast(
          `Could not open ${airport.id} — turn on ATC and pick it from the list.`,
        );
    } finally {
      this._busy = false;
    }
  }

  async _tuneSdr(record, mhz) {
    if (this._busy) return;
    this._busy = true;
    try {
      const layer = this._sdr();
      const result = await layer?.listenSdr?.({
        freqHz: Math.round(mhz * 1e6),
        mode: 'am',
        lat: record.lat,
        lon: record.lon,
        maxKm: 250,
      });
      if (!result)
        this.onToast(
          'No web receiver within 250 km covers the airband — the ones near this pad are HF only.',
        );
    } finally {
      this._busy = false;
    }
  }

  /** Put the camera on the pad and hang the clock over it. */
  _flyToPad(record) {
    const viewer = this._viewer;
    if (
      !viewer?.camera ||
      !Number.isFinite(record.lat) ||
      !Number.isFinite(record.lon)
    )
      return;
    this._unfollow();
    this._followedId = record.id;
    if (viewer.entities?.add) {
      const position = Cesium.Cartesian3.fromDegrees(
        record.lon,
        record.lat,
        60,
      );
      this._padEntity = viewer.entities.add({
        position,
        point: {
          pixelSize: 12,
          color: Cesium.Color.fromCssColorString('#ffd166'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: new Cesium.CallbackProperty(() => {
            const now = this._now();
            const phase = launchPhase(record, now);
            return `${(record.name || '').split('|')[0].trim()}\n${
              phase === 'flying' ? 'IN FLIGHT ' : ''
            }${this._clockText(record, now)}`;
          }, false),
          font: '13px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        record.lon,
        record.lat - 0.035,
        PAD_VIEW_HEIGHT_M,
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-50),
        roll: 0,
      },
      duration: 2.2,
    });
    viewer.scene?.requestRender?.();
    this.render();
  }

  _unfollow() {
    if (this._padEntity && this._viewer?.entities?.remove)
      this._viewer.entities.remove(this._padEntity);
    this._padEntity = null;
    this._followedId = null;
  }
}
