/**
 * IMAGERY panel — choose which sensor each GIBS overlay slot is looking
 * through.
 *
 * The globe carries three switchable imagery slots (orbital, geostationary,
 * measured science) plus radar. Each slot draws from its own product list in
 * the imagery catalog, so this panel is a rendering of that catalog rather
 * than a hand-kept list: add a sensor there and it appears here.
 *
 * Two honesty rules this panel exists to keep:
 *
 *  1. IT SAYS THESE COVER THE GLOBE. Every one of these is a full-globe raster
 *     painted over the photorealistic 3D basemap. A user who leaves one on and
 *     later wonders why the world went flat has not hit a bug, and the panel
 *     should be the thing that tells them that before they file one.
 *  2. IT NAMES THE VINTAGE. Each product carries its real publication lag and
 *     cadence — a geostationary feed is ten minutes old, snow cover is three
 *     days old, and Black Marble is a 2016 composite. Presenting those
 *     identically as "satellite imagery" would be the lie of the whole feature.
 */

import { IMAGERY_SLOT_ORDER } from '../layers/imageryOverlays/catalog.js';

/** The surface coordinator's "I took the globe back" signal (see surface.js). */
export const IMAGERY_SURFACE_RECLAIMED_EVENT = 'gev:imagery-surface-reclaimed';

/** What to tell the user when Google 3D would not stay. */
export function surfaceReclaimedText(holders) {
  const n = Number.isFinite(holders) && holders > 0 ? holders : 1;
  return `Google 3D hides satellite imagery — back on the 2D globe while ${n} imagery overlay${n === 1 ? ' is' : 's are'} on. Press CLEAR in IMAGERY to use Google 3D.`;
}

/** Slot ids, in panel order. */
const SLOT_IDS = IMAGERY_SLOT_ORDER;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** "every ~10 min" / "1 day behind" / "2016 composite" — the vintage, plainly. */
export function cadenceText(product) {
  if (!product) return '';
  if (product.cadence === 'rolling') return 'refreshed ~10 min';
  if (product.cadence === 'static') return 'fixed composite';
  const lag = Number.isFinite(product.lagDays) ? product.lagDays : 1;
  if (lag <= 0) return 'same day';
  return lag === 1 ? '1 day behind' : `${lag} days behind`;
}

/**
 * "partial coverage" for a product that does not cover the globe on a given day.
 *
 * Without this, a swath product reads as broken: you turn it on, most of the
 * world stays empty, and nothing tells you that is the correct result.
 */
export function coverageText(product) {
  if (!product?.sparse) return '';
  return 'partial coverage';
}

/**
 * "zoom in to see" for a product its service will not render from afar.
 *
 * Sentinel Hub draws Sentinel-2 only under 200 m/px, so the layer is blank
 * from orbit by design and appears as you close in. Without saying so, a user
 * who picks it at globe scale sees nothing change and reads that as broken.
 */
export function zoomText(product) {
  if (!Number.isFinite(Number(product?.maxMetersPerPixel))) return '';
  return 'zoom in to see';
}

/** "archive to 2000" when a product has real history worth scrubbing. */
export function archiveText(product) {
  if (!product?.archive) return '';
  return `archive to ${String(product.archive).slice(0, 4)}`;
}

export class ImageryPanel {
  constructor({
    elements,
    dataManager,
    onToast,
    windowRef = globalThis.window,
  } = {}) {
    this.elements = elements || {};
    this._window = windowRef;
    this._resolveDataManager =
      typeof dataManager === 'function' ? dataManager : () => dataManager;
    this.onToast = typeof onToast === 'function' ? onToast : () => {};
    this.destroyed = false;
    this._abort = new AbortController();
    this._busy = false;
    this._rendered = false;
    this._unsubscribe = null;
    /** Keyed service -> usable right now. Absent means "not yet checked". */
    this._keyed = new Map();
    this._keyedChecked = false;
  }

  /**
   * Which keyed services are actually usable right now.
   *
   * A sensor that needs credentials is hidden until they exist, rather than
   * listed and failing when clicked. An offered control that cannot work is
   * worse than an absent one: the user cannot tell a missing key from a broken
   * feed, and goes looking for the fault in the wrong place.
   *
   * Availability is asked once and cached. A failed check means "not
   * available", never "assume yes" — an optimistic default would put the
   * broken control back.
   */
  async _checkKeyedServices() {
    if (this._keyedChecked) return;
    this._keyedChecked = true;
    try {
      const response = await fetch('/api/copernicus/status', {
        cache: 'no-store',
      });
      const status = await response.json();
      this._keyed.set('copernicus', status?.ready === true);
    } catch {
      this._keyed.set('copernicus', false);
    }
    if (!this.destroyed) this.render();
  }

  /** Whether one product can be offered right now, given configured credentials. */
  isProductAvailable(product) {
    const needs = product?.requiresKey;
    if (!needs) return true;
    return this._keyed.get(needs) === true;
  }

  /** Products this slot can actually offer, given configured credentials. */
  _availableSensors(layer) {
    return layer
      .listSensors()
      .filter((product) => this.isProductAvailable(product));
  }

  /** The product key a slot is showing, or null when the slot is off. */
  activeSensor(slotId) {
    if (!this._isEnabled(slotId)) return null;
    const layer = this._layer(slotId);
    const key = layer?.getSensor?.();
    return typeof key === 'string' && key ? key : null;
  }

  connect() {
    this.elements.clearBtn?.addEventListener(
      'click',
      () => void this.clearAll(),
      { signal: this._abort.signal },
    );
    // A stack switch that hid the globe was reversed underneath the user;
    // say so, or the tray chip jumping back reads as a bug.
    this._window?.addEventListener?.(
      IMAGERY_SURFACE_RECLAIMED_EVENT,
      (event) => {
        if (this.destroyed) return;
        this.onToast(surfaceReclaimedText(event?.detail?.holders));
        this.render();
      },
      { signal: this._abort.signal },
    );
    this._ensureSubscribed();
    void this._checkKeyedServices();
    this.render();
  }

  /**
   * Follow layer activity so the panel agrees with the world when a slot is
   * toggled from somewhere else — the DATA LAYERS list, a combination preset,
   * or a restored share link. A panel that only knew about its own clicks
   * would sit reading CLEAR over a covered globe.
   *
   * The manager may not exist yet when the shell builds panels, so this is
   * retried from render() rather than assumed to have worked once.
   */
  _ensureSubscribed() {
    if (this._unsubscribe || this.destroyed) return;
    const dm = this._resolveDataManager();
    if (typeof dm?.subscribeActivity !== 'function') return;
    this._unsubscribe = dm.subscribeActivity((change) => {
      if (this.destroyed) return;
      if (change?.type === 'status' || change?.type === 'visibility-settled')
        this.render();
    });
  }

  /** The layer module for a slot, or null when it is not registered. */
  _layer(slotId) {
    const dm = this._resolveDataManager();
    if (!dm?.layers) return null;
    const entry = dm.layers.get(slotId);
    const module = entry?.module || entry;
    return typeof module?.listSensors === 'function' ? module : null;
  }

  _isEnabled(slotId) {
    const dm = this._resolveDataManager();
    try {
      return dm?.isEnabled?.(slotId) === true;
    } catch {
      return false;
    }
  }

  /**
   * Point a slot at a sensor. Turning on a slot that is off is deliberate:
   * clicking a sensor is an unambiguous request to SEE it, and making the user
   * find the separate layer toggle afterwards would be a puzzle, not a safety
   * feature. The toast names what just covered their basemap.
   */
  async selectSensor(slotId, key) {
    if (this._busy || this.destroyed) return;
    const layer = this._layer(slotId);
    if (!layer) return;
    this._busy = true;
    try {
      await layer.setSensor(key);
      const product = layer.getSensorProduct?.() || null;
      if (!this._isEnabled(slotId)) {
        const dm = this._resolveDataManager();
        await dm?.setEnabled?.(slotId, true, { origin: 'user' });
      }
      if (product) {
        // Naming the basemap trade matters more than naming the sensor: the
        // user is about to lose the photorealistic 3D, and if we let that
        // happen wordlessly they will read it as the globe breaking.
        const swap = layer.getSurfaceChange?.();
        const traded = swap?.switched
          ? ' Switched to the 2D globe — imagery cannot draw over Google 3D.'
          : '';
        this.onToast(`${product.label} — ${cadenceText(product)}.${traded}`);
      }
    } catch {
      this.onToast('Could not switch that sensor');
    } finally {
      this._busy = false;
      this.render();
    }
  }

  /** Turn every imagery slot off — the one-click way back to the 3D globe. */
  async clearAll() {
    if (this._busy || this.destroyed) return;
    this._busy = true;
    try {
      const dm = this._resolveDataManager();
      for (const slotId of [...SLOT_IDS, 'imagery-radar']) {
        if (this._isEnabled(slotId))
          await dm?.setEnabled?.(slotId, false, { origin: 'user' });
      }
      this.onToast('Imagery cleared — the photorealistic globe is back');
    } finally {
      this._busy = false;
      this.render();
    }
  }

  _renderSlot(slotId) {
    const layer = this._layer(slotId);
    if (!layer) return null;
    const slot = layer.getSlot?.();
    if (!slot) return null;
    const enabled = this._isEnabled(slotId);
    const activeKey = layer.getSensor?.();

    const group = el('div', 'imagery-slot');
    if (enabled) group.classList.add('active');

    const head = el('div', 'imagery-slot-head');
    head.append(el('span', 'imagery-slot-title', slot.heading));
    head.append(el('span', 'imagery-slot-state', enabled ? 'ON' : 'OFF'));
    group.append(head);
    group.append(el('p', 'imagery-slot-blurb', slot.blurb));

    const list = el('div', 'imagery-sensor-list');
    for (const product of this._availableSensors(layer)) {
      const active = enabled && product.key === activeKey;
      const btn = el('button', 'imagery-sensor');
      btn.type = 'button';
      btn.dataset.slot = slotId;
      btn.dataset.sensor = product.key;
      if (active) btn.classList.add('active');
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');

      btn.append(el('span', 'imagery-sensor-label', product.label));
      const meta = [
        product.instrument,
        cadenceText(product),
        coverageText(product),
        zoomText(product),
        archiveText(product),
      ]
        .filter(Boolean)
        .join(' · ');
      btn.append(el('span', 'imagery-sensor-meta', meta));
      btn.append(el('span', 'imagery-sensor-reveals', product.reveals));
      btn.addEventListener(
        'click',
        () => void this.selectSensor(slotId, product.key),
        { signal: this._abort.signal },
      );
      list.append(btn);
    }
    group.append(list);
    return group;
  }

  render() {
    if (this.destroyed) return;
    this._ensureSubscribed();
    const host = this.elements.list;
    if (!host) return;
    host.replaceChildren();
    let onCount = 0;
    for (const slotId of SLOT_IDS) {
      const node = this._renderSlot(slotId);
      if (node) host.append(node);
      if (this._isEnabled(slotId)) onCount++;
    }
    if (this._isEnabled('imagery-radar')) onCount++;
    const anyOn = onCount > 0;

    if (this.elements.layerState)
      this.elements.layerState.textContent = anyOn ? `${onCount} ON` : 'OFF';
    if (this.elements.clearBtn) this.elements.clearBtn.disabled = !anyOn;
    if (this.elements.note) {
      this.elements.note.textContent = anyOn
        ? 'Imagery is drawn on the 2D globe, so the photorealistic 3D basemap is set aside while any sensor is on. CLEAR brings it back.'
        : 'Nothing is covering the globe. Picking a sensor switches to the 2D basemap, because imagery cannot draw over Google 3D.';
    }
    this._rendered = true;
  }

  destroy() {
    this.destroyed = true;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._abort.abort();
  }
}
