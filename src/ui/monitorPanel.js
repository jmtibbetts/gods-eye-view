import * as Cesium from 'cesium';
import {
  MONITOR_RADII,
  defaultWatchboxName,
  diffScan,
  scanWatchbox,
} from './monitorEngine.js';

const SCAN_MS = 4000;
const STORAGE_KEY = 'gev.monitor.v1';
/** Records pulled per layer per scan — a generous cap that stays cheap. */
const RECORDS_PER_LAYER = 3000;
/** A "new arrival" stays highlighted this long. */
const NEW_HOLD_MS = 30_000;

function setText(el, value) {
  if (el) el.textContent = value;
}

/** Camera aim point on the globe, or the sub-camera point. */
function viewCenter(viewer) {
  const camera = viewer?.camera;
  const scene = viewer?.scene;
  if (!camera) return null;
  let carto = null;
  const canvas = scene?.canvas;
  if (canvas && typeof camera.pickEllipsoid === 'function') {
    const center = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const hit = camera.pickEllipsoid(
      center,
      scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
    );
    if (hit) carto = Cesium.Cartographic.fromCartesian(hit);
  }
  carto ||= camera.positionCartographic || null;
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

function flyTo(viewer, lat, lon, heightM) {
  if (!viewer?.camera) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    duration: 1.4,
  });
}

/**
 * MONITOR panel: draw a watch circle over the current view and get a live
 * count of what every enabled layer has inside it, with new arrivals flagged.
 * Reads layer data through the data manager's `getAnalystRecords`; owns no
 * feed of its own.
 */
export class MonitorPanel {
  constructor({ elements, dataManager, viewer, storage = null, onToast } = {}) {
    this.elements = elements || {};
    // Accept the manager itself or a resolver — the shell may not have assigned
    // it yet when this panel is constructed, so resolve it lazily at scan time.
    this._resolveDataManager =
      typeof dataManager === 'function' ? dataManager : () => dataManager;
    this.viewer = viewer;
    this.storage = storage;
    this.onToast = typeof onToast === 'function' ? onToast : () => {};
    this.destroyed = false;
    this._abort = new AbortController();
    this._timer = null;
    /** @type {Array<object>} watchboxes */
    this._boxes = [];
    this._seq = 0;
    this._restore();
  }

  connect() {
    const e = this.elements;
    const { signal } = this._abort;
    e.addBtn?.addEventListener('click', () => this.addFromView(), { signal });
    e.clearBtn?.addEventListener('click', () => this.clearAll(), { signal });
    this._timer = setInterval(() => this.scan(), SCAN_MS);
    this.renderRadii();
    this.scan();
    this.render();
  }

  renderRadii() {
    const sel = this.elements.radius;
    if (!sel || sel.options.length) return;
    for (const km of MONITOR_RADII) {
      const opt = document.createElement('option');
      opt.value = String(km);
      opt.textContent = km >= 1000 ? `${km / 1000}k km` : `${km} km`;
      if (km === 150) opt.selected = true;
      sel.append(opt);
    }
  }

  _restore() {
    try {
      const raw = this.storage?.getItem?.(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (Array.isArray(saved)) {
        this._boxes = saved
          .filter(
            (b) =>
              Number.isFinite(b?.lat) &&
              Number.isFinite(b?.lon) &&
              Number.isFinite(b?.radiusKm),
          )
          .map((b) => ({
            id: String(b.id || `box-${++this._seq}`),
            name: String(b.name || defaultWatchboxName(b.lat, b.lon)),
            lat: b.lat,
            lon: b.lon,
            radiusKm: b.radiusKm,
            seen: new Set(),
            total: 0,
            byLayer: [],
            newCount: 0,
            newAt: 0,
          }));
        this._seq = Math.max(this._seq, this._boxes.length);
      }
    } catch {
      /* storage is a per-viewer nicety */
    }
  }

  _persist() {
    try {
      this.storage?.setItem?.(
        STORAGE_KEY,
        JSON.stringify(
          this._boxes.map((b) => ({
            id: b.id,
            name: b.name,
            lat: b.lat,
            lon: b.lon,
            radiusKm: b.radiusKm,
          })),
        ),
      );
    } catch {
      /* ignore */
    }
  }

  addFromView() {
    const center = viewCenter(this.viewer);
    if (!center) return;
    const radiusKm = Number(this.elements.radius?.value) || 150;
    const box = {
      id: `box-${++this._seq}`,
      name: defaultWatchboxName(center.lat, center.lon, this._boxes.length + 1),
      lat: center.lat,
      lon: center.lon,
      radiusKm,
      seen: new Set(),
      total: 0,
      byLayer: [],
      newCount: 0,
      newAt: 0,
    };
    this._boxes.push(box);
    this._persist();
    this.scan();
    this.render();
  }

  removeBox(id) {
    this._boxes = this._boxes.filter((b) => b.id !== id);
    this._persist();
    this.render();
  }

  clearAll() {
    this._boxes = [];
    this._persist();
    this.render();
  }

  /** Enabled layers that expose point records, as {layerId, name, records}. */
  _layerRecords() {
    const dm = this._resolveDataManager();
    const layers = [];
    if (!dm?.layers) return layers;
    for (const [id, entry] of dm.layers) {
      if (!dm.isEnabled?.(id)) continue;
      const module = entry?.module || entry;
      if (typeof module?.getAnalystRecords !== 'function') continue;
      let records;
      try {
        records = module.getAnalystRecords(RECORDS_PER_LAYER);
      } catch {
        continue;
      }
      if (Array.isArray(records) && records.length)
        layers.push({ layerId: id, name: module.name || id, records });
    }
    return layers;
  }

  scan() {
    if (this.destroyed || !this._boxes.length) {
      if (!this._boxes.length) this.render();
      return;
    }
    const layers = this._layerRecords();
    const now = Date.now();
    for (const box of this._boxes) {
      const { total, byLayer, ids } = scanWatchbox(box, layers);
      const { newIds } = diffScan(box.seen, ids);
      // Only announce arrivals after the box has one baseline scan.
      const hadBaseline = box.seen.size > 0 || box._scanned;
      box._scanned = true;
      box.seen = ids;
      box.total = total;
      box.byLayer = byLayer;
      if (hadBaseline && newIds.length) {
        box.newCount = newIds.length;
        box.newAt = now;
        this.onToast(
          `MONITOR: ${newIds.length} new in ${box.name} (${byLayer[0]?.name || 'layers'})`,
        );
      } else if (now - box.newAt > NEW_HOLD_MS) {
        box.newCount = 0;
      }
    }
    this.render();
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const list = e.list;
    if (e.layerState)
      setText(
        e.layerState,
        this._boxes.length ? `${this._boxes.length} WATCHING` : 'READY',
      );
    if (e.empty) e.empty.hidden = this._boxes.length > 0;
    if (e.clearBtn) e.clearBtn.disabled = !this._boxes.length;
    if (!list) return;
    list.replaceChildren();
    const now = Date.now();
    for (const box of this._boxes) {
      const li = document.createElement('li');
      li.className = 'monitor-box';
      const fresh = box.newCount > 0 && now - box.newAt < NEW_HOLD_MS;
      if (fresh) li.classList.add('has-new');
      const breakdown = box.byLayer
        .slice(0, 4)
        .map((l) => `${l.name} ${l.count}`)
        .join(' · ');
      li.innerHTML = `
        <div class="monitor-box-head">
          <strong></strong>
          <span class="monitor-box-total"></span>
        </div>
        <div class="monitor-box-meta"></div>
        <div class="monitor-box-actions">
          <button type="button" data-act="fly">GO TO</button>
          <button type="button" data-act="remove">REMOVE</button>
        </div>`;
      setText(li.querySelector('strong'), box.name);
      setText(
        li.querySelector('.monitor-box-total'),
        fresh ? `${box.total} · +${box.newCount} new` : `${box.total} in view`,
      );
      setText(
        li.querySelector('.monitor-box-meta'),
        breakdown ||
          `radius ${box.radiusKm} km · nothing from enabled layers yet`,
      );
      li.querySelector('[data-act="fly"]').addEventListener('click', () =>
        flyTo(this.viewer, box.lat, box.lon, box.radiusKm * 3000 + 60000),
      );
      li.querySelector('[data-act="remove"]').addEventListener('click', () =>
        this.removeBox(box.id),
      );
      list.append(li);
    }
  }

  destroy() {
    this.destroyed = true;
    this._abort.abort();
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
