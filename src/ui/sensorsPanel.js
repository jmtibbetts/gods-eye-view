import {
  IMAGING_PLATFORMS,
  imagingPlatformFor,
  swathKmFor,
} from '../layers/satellites/sensors.js';
import {
  IMAGERY_SLOTS,
  IMAGERY_SLOT_ORDER,
} from '../layers/imageryOverlays/catalog.js';
import { cadenceText } from './imageryPanel.js';

/**
 * The catalog products a platform's sensors publish here, each with the slot
 * that draws it — the buttons this panel offers. Joined live against the
 * imagery catalog so a product added there appears on its satellite, and
 * joined here rather than in the satellites layer so that layer never needs
 * to know what the imagery overlays can draw.
 * @param {object|null} platform An IMAGING_PLATFORMS entry.
 * @returns {Array<{slotId: string, product: object}>}
 */
export function productsForPlatform(platform) {
  if (!platform?.platforms?.length) return [];
  const wanted = new Set(platform.platforms);
  const out = [];
  for (const slotId of IMAGERY_SLOT_ORDER) {
    for (const product of IMAGERY_SLOTS[slotId].products) {
      if (wanted.has(product.platform)) out.push({ slotId, product });
    }
  }
  return out;
}

/**
 * SENSORS — what the satellite you are following can see, and which of its
 * pictures the globe is drawing.
 *
 * Track an imaging satellite and this panel names its instruments, their
 * swath, resolution and bands, and offers every band and product the imagery
 * catalog serves for that platform as a button: press one and the globe
 * switches to it, live. The satellites layer draws the instrument's footprint
 * under the satellite meanwhile, so the picture is seen being laid down.
 *
 * What it will never offer is a way to point the camera. No public satellite
 * takes commands from anyone but its operator, and every product here is
 * published on the instrument's own schedule — the panel says how far behind
 * live each one runs rather than letting a ten-minute geostationary frame and
 * a day-old polar mosaic both pass as "now".
 *
 * With nothing tracked it lists the imaging fleet that is on the globe, each
 * with a TRACK button, because finding NOAA-20 among eight hundred dots by
 * eye is not a reasonable ask.
 */

/** "NOW · 3,060 km swath" — one line of orbit facts for the panel head. */
export function orbitText(platform) {
  if (!platform) return '';
  const swath = swathKmFor(platform);
  const orbit =
    platform.orbit === 'geostationary'
      ? 'GEOSTATIONARY'
      : platform.orbit === 'polar'
        ? 'POLAR ORBIT'
        : String(platform.orbit || '').toUpperCase();
  return swath === null
    ? `${orbit} · FULL DISK`
    : `${orbit} · ${swath.toLocaleString('en-US')} km SWATH`;
}

/**
 * What the footer should say about a product's currency. Deliberately blunt:
 * "published ~10 min behind" is the honest description of the closest thing
 * here to live, and "1 day behind" is what a polar mosaic actually is.
 */
export function currencyText(product) {
  if (!product) return '';
  const cadence = cadenceText(product);
  if (product.cadence === 'rolling')
    return `published ${cadence} — not a live view`;
  if (product.cadence === 'composite')
    return 'the clearest pass of a trailing window — not a live view';
  if (product.cadence === 'static') return `${cadence} — not a live view`;
  return `published ${cadence} — the newest pass, not a live view`;
}

/** "19:50Z · 7 / 12 · STOP" — where a playing loop is. */
export function loopClockText(loop) {
  if (!loop) return '';
  const at = loop.instant ? `${loop.instant.slice(11, 16)}Z` : '--:--Z';
  return `${at} · ${loop.index + 1} / ${loop.frames} · STOP`;
}

export class SensorsPanel {
  /**
   * @param {object} options
   * @param {object} options.elements `{ state, body, note }`.
   * @param {() => object|null} options.satellites The satellites layer, when registered.
   * @param {(slotId: string, key: string) => Promise<void>} options.selectSensor
   *   Point an imagery slot at a product — the IMAGERY panel's own path, so the
   *   basemap trade and the toast are the same whichever panel asked.
   * @param {(slotId: string) => string|null} options.activeSensor The key a slot
   *   currently shows, or null when the slot is off.
   * @param {(product: object) => boolean} options.isProductAvailable Keyed
   *   products are offered only when their credentials exist.
   * @param {(layerId: string, enabled: boolean) => Promise<void>} options.setLayerEnabled
   * @param {(layerId: string) => boolean} options.isLayerEnabled
   * @param {((listener: (change: object) => void) => (() => void))|null} [options.subscribeActivity]
   *   The data manager's activity feed, so a band picked from the IMAGERY
   *   panel — or a layer toggled anywhere — is reflected here without a click.
   * @param {object|null} [options.frameLoop] The imagery slots' frame loops:
   *   `{ canLoop(slotId), windowText(slotId), start(slotId), stop(slotId),
   *   state(slotId) }` — a geostationary imager's last dozen frames, played.
   * @param {(() => void)|null} [options.openIssStream] The ISS LIVE hand-off.
   * @param {(panelId: string) => void} [options.expandPanel]
   * @param {(message: string) => void} [options.onToast]
   * @param {Window} [options.windowRef]
   */
  constructor({
    elements,
    satellites,
    selectSensor,
    activeSensor,
    isProductAvailable,
    setLayerEnabled,
    isLayerEnabled,
    subscribeActivity = null,
    frameLoop = null,
    openIssStream = null,
    expandPanel = null,
    onToast = () => {},
    windowRef = globalThis.window,
  } = {}) {
    this.elements = elements || {};
    this._satellites =
      typeof satellites === 'function' ? satellites : () => null;
    this._selectSensor = selectSensor;
    this._activeSensor = activeSensor;
    this._isProductAvailable = isProductAvailable || (() => true);
    this._setLayerEnabled = setLayerEnabled;
    this._isLayerEnabled = isLayerEnabled || (() => false);
    this._subscribeActivity = subscribeActivity;
    this._frameLoop = frameLoop;
    this._loopTicker = null;
    this._unsubscribe = null;
    this._openIssStream = openIssStream;
    this._expandPanel = expandPanel;
    this.onToast = onToast;
    this._window = windowRef;
    this._abort = new AbortController();
    this.destroyed = false;
    this._busy = false;
    this._trackedNorad = null;
  }

  connect() {
    const { signal } = this._abort;
    const w = this._window;
    if (w?.addEventListener) {
      w.addEventListener(
        'gev:awareness-subject-selected',
        (event) => {
          if (event?.detail?.layerId !== 'satellites') return;
          this._trackedNorad = Number(event.detail.id);
          // Following an imaging satellite is the moment the panel earns its
          // place on screen; anything else it leaves alone.
          if (imagingPlatformFor(this._trackedNorad))
            this._expandPanel?.('sensors-panel');
          this.render();
        },
        { signal },
      );
      w.addEventListener(
        'gev:awareness-subject-cleared',
        (event) => {
          if (event?.detail?.layerId && event.detail.layerId !== 'satellites')
            return;
          this._trackedNorad = null;
          this.render();
        },
        { signal },
      );
    }
    this._ensureSubscribed();
    this.render();
  }

  /**
   * Follow the manager's activity feed. The manager may not exist yet when
   * the shell builds panels, so this is retried from render() rather than
   * assumed to have worked once.
   */
  _ensureSubscribed() {
    if (this._unsubscribe || this.destroyed) return;
    if (typeof this._subscribeActivity !== 'function') return;
    const unsubscribe = this._subscribeActivity((change) => {
      if (this.destroyed) return;
      if (change?.type === 'status' || change?.type === 'visibility-settled')
        this.render();
    });
    if (typeof unsubscribe === 'function') this._unsubscribe = unsubscribe;
  }

  /** Re-read the tracked satellite from the layer — after a restore, say. */
  sync() {
    const layer = this._satellites();
    const norad = layer?.getTrackedNorad?.();
    this._trackedNorad = Number.isFinite(norad) ? norad : null;
    this.render();
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._stopLoopTicker();
  }

  _stopLoopTicker() {
    if (this._loopTicker != null) {
      const w = this._window;
      const clear = w?.clearInterval ? w.clearInterval.bind(w) : clearInterval;
      clear(this._loopTicker);
      this._loopTicker = null;
    }
  }

  /** While a loop plays, its clock label follows the frame without a rebuild. */
  _startLoopTicker(slotId, label) {
    this._stopLoopTicker();
    const w = this._window;
    const set = w?.setInterval ? w.setInterval.bind(w) : setInterval;
    this._loopTicker = set(() => {
      const loop = this._frameLoop?.state?.(slotId);
      if (!loop) {
        this._stopLoopTicker();
        this.render();
        return;
      }
      label.textContent = loopClockText(loop);
    }, 250);
  }

  _el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** The imaging platforms the loaded catalog actually has, for the fleet list. */
  _fleetOnGlobe() {
    const layer = this._satellites();
    if (!layer?.hasSatellite) return [];
    return IMAGING_PLATFORMS.filter((p) => layer.hasSatellite(p.norad));
  }

  render() {
    if (this.destroyed) return;
    this._ensureSubscribed();
    const { state, body, note } = this.elements;
    if (!body) return;
    body.textContent = '';
    const platform = imagingPlatformFor(this._trackedNorad);
    const layer = this._satellites();

    if (state) {
      state.textContent = platform
        ? platform.name.toUpperCase()
        : this._trackedNorad !== null
          ? 'NO SENSOR'
          : 'NONE';
    }

    if (!platform) {
      if (this._trackedNorad !== null) {
        const name =
          layer?.satelliteName?.(this._trackedNorad) ||
          `NORAD ${this._trackedNorad}`;
        body.append(
          this._el(
            'p',
            'sensors-empty',
            `${name} carries no imaging sensor whose pictures this app can show.`,
          ),
        );
      }
      body.append(this._renderFleet());
      if (note)
        note.textContent =
          'Track an imaging satellite and its instruments appear here, with every band the globe can draw and the ground it is sweeping.';
      return;
    }

    body.append(this._renderPlatform(platform));
    if (note) {
      const active = this._activeProductFor(platform);
      note.textContent = active
        ? `${active.product.label}: ${currencyText(active.product)}. Nothing here commands the spacecraft.`
        : 'Pick a band and the globe draws it. Nothing here commands the spacecraft — every picture is published on the instrument’s own schedule.';
    }
  }

  _renderFleet() {
    const wrap = this._el('div', 'sensors-fleet');
    const fleet = this._fleetOnGlobe();
    if (!fleet.length) {
      wrap.append(
        this._el(
          'p',
          'sensors-empty',
          'Turn on Satellites and the imaging fleet is listed here — NOAA-20, Suomi NPP, Terra, Aqua, the Sentinels, GOES, Himawari and Meteosat.',
        ),
      );
      return wrap;
    }
    wrap.append(
      this._el('div', 'sensors-fleet-heading', 'IMAGING FLEET ON THE GLOBE'),
    );
    for (const platform of fleet) {
      const row = this._el('button', 'sensors-fleet-row');
      row.type = 'button';
      row.dataset.norad = String(platform.norad);
      const served = productsForPlatform(platform);
      const products = served.filter((p) =>
        this._isProductAvailable(p.product),
      );
      row.append(this._el('span', 'sensors-fleet-name', platform.name));
      row.append(
        this._el(
          'span',
          'sensors-fleet-meta',
          `${platform.instruments.map((i) => i.name).join(' · ')} · ${
            products.length
              ? `${products.length} band${products.length === 1 ? '' : 's'} here`
              : served.length
                ? 'bands need a key'
                : platform.link
                  ? 'no product here yet'
                  : 'watch only'
          }`,
        ),
      );
      row.append(this._el('span', 'sensors-fleet-track', 'TRACK'));
      row.title = `Follow ${platform.name} — ${orbitText(platform)}`;
      row.addEventListener(
        'click',
        () => {
          const layer = this._satellites();
          layer?.trackSatellite?.(platform.norad);
        },
        { signal: this._abort.signal },
      );
      wrap.append(row);
    }
    return wrap;
  }

  _activeProductFor(platform) {
    for (const entry of productsForPlatform(platform)) {
      if (this._activeSensor?.(entry.slotId) === entry.product.key)
        return entry;
    }
    return null;
  }

  _renderPlatform(platform) {
    const wrap = this._el('div', 'sensors-platform');
    const head = this._el('div', 'sensors-platform-head');
    head.append(this._el('span', 'sensors-platform-name', platform.name));
    head.append(
      this._el('span', 'sensors-platform-orbit', orbitText(platform)),
    );
    wrap.append(head);
    wrap.append(
      this._el(
        'p',
        'sensors-platform-note',
        `${platform.operator}. ${platform.note || ''}`.trim(),
      ),
    );

    for (const instrument of platform.instruments) {
      const card = this._el('div', 'sensors-instrument');
      const title = this._el('div', 'sensors-instrument-head');
      title.append(
        this._el('span', 'sensors-instrument-name', instrument.name),
      );
      title.append(
        this._el('span', 'sensors-instrument-full', instrument.fullName),
      );
      card.append(title);
      const facts = [
        instrument.swathKm
          ? `${instrument.swathKm.toLocaleString('en-US')} km swath`
          : 'full disk',
        instrument.resolution,
        instrument.bands,
      ].filter(Boolean);
      card.append(
        this._el('div', 'sensors-instrument-facts', facts.join(' · ')),
      );
      card.append(
        this._el('p', 'sensors-instrument-reveals', instrument.reveals),
      );
      if (instrument.layerId) {
        const on = this._isLayerEnabled(instrument.layerId);
        const btn = this._el('button', `imagery-sensor${on ? ' active' : ''}`);
        btn.type = 'button';
        btn.append(
          this._el(
            'span',
            'imagery-sensor-label',
            on ? `${instrument.layerLabel} · ON` : instrument.layerLabel,
          ),
        );
        btn.append(
          this._el(
            'span',
            'imagery-sensor-reveals',
            'A data layer, not imagery — every flash this instrument reports',
          ),
        );
        btn.addEventListener(
          'click',
          () => void this._toggleLayer(instrument.layerId, !on),
          { signal: this._abort.signal },
        );
        card.append(btn);
      }
      wrap.append(card);
    }

    const served = productsForPlatform(platform);
    const products = served.filter((p) => this._isProductAvailable(p.product));
    if (products.length) {
      wrap.append(
        this._el(
          'div',
          'sensors-fleet-heading',
          'BANDS & PRODUCTS THE GLOBE CAN DRAW',
        ),
      );
      const list = this._el('div', 'imagery-sensor-list');
      for (const { slotId, product } of products) {
        const active = this._activeSensor?.(slotId) === product.key;
        const btn = this._el(
          'button',
          `imagery-sensor${active ? ' active' : ''}`,
        );
        btn.type = 'button';
        btn.dataset.slotId = slotId;
        btn.dataset.key = product.key;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.append(this._el('span', 'imagery-sensor-label', product.label));
        btn.append(
          this._el(
            'span',
            'imagery-sensor-meta',
            [product.instrument, cadenceText(product)]
              .filter(Boolean)
              .join(' · '),
          ),
        );
        btn.append(this._el('span', 'imagery-sensor-reveals', product.reveals));
        btn.addEventListener(
          'click',
          () => void this._select(slotId, product.key),
          { signal: this._abort.signal },
        );
        list.append(btn);
      }
      wrap.append(list);
    } else if (served.length) {
      // Every product this platform has is keyed and no key is configured:
      // say so rather than hiding the bands as if they did not exist.
      wrap.append(
        this._el(
          'p',
          'sensors-empty',
          `Its bands need a key this app does not have yet — ${served.length} product${served.length === 1 ? '' : 's'} unlock from POWER UP.`,
        ),
      );
    } else if (platform.link) {
      const p = this._el(
        'p',
        'sensors-empty',
        'This app serves no product from this instrument yet. ',
      );
      const a = this._el('a', 'sensors-link', 'Where its data lives ↗');
      a.href = platform.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      p.append(a);
      wrap.append(p);
    }

    // A parked imager's newest frames, played: the weather moving is what
    // the satellite is for, and a still full disk does not show it.
    const active = this._activeProductFor(platform);
    if (
      platform.orbit === 'geostationary' &&
      active &&
      this._frameLoop?.canLoop?.(active.slotId)
    ) {
      const loop = this._frameLoop.state?.(active.slotId) || null;
      const btn = this._el('button', `imagery-sensor${loop ? ' active' : ''}`);
      btn.type = 'button';
      btn.dataset.loop = active.slotId;
      const label = this._el(
        'span',
        'imagery-sensor-label',
        loop
          ? loopClockText(loop)
          : `PLAY ${this._frameLoop.windowText?.(active.slotId) || 'the newest frames'}`.toUpperCase(),
      );
      btn.append(label);
      btn.append(
        this._el(
          'span',
          'imagery-sensor-reveals',
          loop
            ? 'Stop the loop and return to the newest published frame'
            : `${active.product.label}, frame by frame as published — the disk moving, not a live view`,
        ),
      );
      btn.addEventListener(
        'click',
        () => void this._toggleLoop(active.slotId),
        { signal: this._abort.signal },
      );
      wrap.append(btn);
      if (loop) this._startLoopTicker(active.slotId, label);
      else this._stopLoopTicker();
    } else {
      this._stopLoopTicker();
    }

    if (platform.norad === 25544 && this._openIssStream) {
      const btn = this._el('button', 'imagery-sensor');
      btn.type = 'button';
      btn.append(this._el('span', 'imagery-sensor-label', 'ISS LIVE STREAM'));
      btn.append(
        this._el(
          'span',
          'imagery-sensor-reveals',
          'NASA’s live stream in the receiver dock — exterior views when they are streaming them',
        ),
      );
      btn.addEventListener('click', () => this._openIssStream(), {
        signal: this._abort.signal,
      });
      wrap.append(btn);
    }
    return wrap;
  }

  /**
   * Show one band. The imagery slots stack — a science ramp or radar drawn
   * over the picked product hides it completely, which reads as "nothing
   * changed" — so a band chosen here is made the one on the globe: every
   * other slot is set aside, and the toast says how many. IMAGERY brings
   * them back.
   */
  async _select(slotId, key) {
    if (this._busy || this.destroyed) return;
    this._busy = true;
    try {
      const others = [...IMAGERY_SLOT_ORDER, 'imagery-radar'].filter(
        (id) => id !== slotId && this._isLayerEnabled(id),
      );
      for (const id of others) await this._setLayerEnabled?.(id, false);
      await this._selectSensor?.(slotId, key);
      if (others.length)
        this.onToast(
          `${others.length} other imagery overlay${others.length === 1 ? '' : 's'} set aside so this band is the one on the globe — IMAGERY brings ${others.length === 1 ? 'it' : 'them'} back.`,
        );
    } finally {
      this._busy = false;
      this.render();
    }
  }

  async _toggleLoop(slotId) {
    if (this._busy || this.destroyed || !this._frameLoop) return;
    this._busy = true;
    try {
      if (this._frameLoop.state?.(slotId)) {
        await this._frameLoop.stop?.(slotId);
      } else {
        const started = await this._frameLoop.start?.(slotId);
        if (!started)
          this.onToast(
            'No run of frames to play yet — the service has fewer than two of them for this window.',
          );
      }
    } finally {
      this._busy = false;
      this.render();
    }
  }

  async _toggleLayer(layerId, enabled) {
    if (this._busy || this.destroyed) return;
    this._busy = true;
    try {
      await this._setLayerEnabled?.(layerId, enabled);
    } finally {
      this._busy = false;
      this.render();
    }
  }
}
