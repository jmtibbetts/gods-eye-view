import * as Cesium from 'cesium';
import {
  WATCH_STALE_MS,
  describeWatchHit,
  diffWatchHits,
  scanWatchlist,
  watchEntryLabel,
} from './watchlistEngine.js';

const SCAN_MS = 4000;
const STORAGE_KEY = 'gev.watchlist.v1';
/** Records pulled per layer per scan — generous, and still cheap. */
const RECORDS_PER_LAYER = 4000;
/** Cap so a runaway paste cannot make the scan quadratic. */
const MAX_ENTRIES = 40;

function setText(el, value) {
  if (el) el.textContent = value;
}

function flyTo(viewer, lat, lon, heightM) {
  if (!viewer?.camera) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    duration: 1.4,
  });
}

/**
 * WATCHLIST panel: pin specific contacts — an aircraft callsign or ICAO24, a
 * vessel MMSI or name — and see at a glance which of them are on the globe
 * right now, wherever they are, with a toast the moment one appears.
 *
 * Reads layer data through the data manager's `getAnalystRecords` and owns no
 * feed of its own, so it works against any layer that exposes records.
 */
export class WatchlistPanel {
  constructor({ elements, dataManager, viewer, storage = null, onToast } = {}) {
    this.elements = elements || {};
    // Accept the manager itself or a resolver — the shell may not have assigned
    // it yet at construction time, so resolve lazily at scan time.
    this._resolveDataManager =
      typeof dataManager === 'function' ? dataManager : () => dataManager;
    this.viewer = viewer;
    this.storage = storage;
    this.onToast = typeof onToast === 'function' ? onToast : () => {};
    this.destroyed = false;
    this._abort = new AbortController();
    this._timer = null;
    /** @type {Array<{id:string, value:string}>} */
    this._entries = [];
    /** @type {Map<string, {layerId:string, layerName:string, record:object}>} */
    this._hits = new Map();
    /** @type {Map<string, number>} entry id → last time it was seen. */
    this._lastSeen = new Map();
    this._seq = 0;
    this._restore();
  }

  connect() {
    const e = this.elements;
    const { signal } = this._abort;
    e.addBtn?.addEventListener('click', () => this.addFromInput(), { signal });
    e.input?.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.addFromInput();
        }
      },
      { signal },
    );
    e.clearBtn?.addEventListener('click', () => this.clearAll(), { signal });
    this._timer = setInterval(() => this.scan(), SCAN_MS);
    this.scan();
    this.render();
  }

  _restore() {
    try {
      const raw = this.storage?.getItem?.(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (Array.isArray(saved)) {
        this._entries = saved
          .map((entry) => ({
            id: String(entry?.id || `watch-${++this._seq}`),
            value: watchEntryLabel(entry?.value),
          }))
          .filter((entry) => entry.value)
          .slice(0, MAX_ENTRIES);
        this._seq = Math.max(this._seq, this._entries.length);
      }
    } catch {
      /* storage is a per-viewer nicety */
    }
  }

  _persist() {
    try {
      this.storage?.setItem?.(STORAGE_KEY, JSON.stringify(this._entries));
    } catch {
      /* ignore */
    }
  }

  addFromInput() {
    const input = this.elements.input;
    const value = watchEntryLabel(input?.value);
    if (!value) return;
    const result = this.add(value);
    if (result === 'exists') this.onToast(`${value} is already pinned`);
    if (result !== false && input) input.value = '';
  }

  /**
   * Pin a contact from anywhere — the LAUNCH panel pins a droneship this
   * way. Returns what happened so the caller can word its own toast.
   * @param {string} raw
   * @returns {'added'|'exists'|false}
   */
  add(raw) {
    const value = watchEntryLabel(raw);
    if (!value) return false;
    if (this._entries.some((entry) => entry.value === value)) return 'exists';
    if (this._entries.length >= MAX_ENTRIES) {
      this.onToast(`WATCHLIST full (${MAX_ENTRIES} max)`);
      return false;
    }
    this._entries.push({ id: `watch-${++this._seq}`, value });
    this._persist();
    this.scan();
    this.render();
    return 'added';
  }

  removeEntry(id) {
    this._entries = this._entries.filter((entry) => entry.id !== id);
    this._hits.delete(id);
    this._lastSeen.delete(id);
    this._persist();
    this.render();
  }

  clearAll() {
    this._entries = [];
    this._hits.clear();
    this._lastSeen.clear();
    this._persist();
    this.render();
  }

  /** Enabled layers that expose records, as {layerId, name, records}. */
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
    if (this.destroyed) return;
    if (!this._entries.length) {
      this._hits.clear();
      this.render();
      return;
    }
    const previous = new Set(this._hits.keys());
    const hits = scanWatchlist(this._entries, this._layerRecords());
    const { appeared } = diffWatchHits(previous, new Set(hits.keys()));
    const now = Date.now();
    for (const id of hits.keys()) this._lastSeen.set(id, now);
    this._hits = hits;
    for (const id of appeared) {
      const entry = this._entries.find((candidate) => candidate.id === id);
      const hit = hits.get(id);
      if (entry && hit)
        this.onToast(`WATCHLIST: ${entry.value} is up on ${hit.layerName}`);
    }
    this.render();
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    const live = this._hits.size;
    if (e.layerState)
      setText(
        e.layerState,
        this._entries.length ? `${live}/${this._entries.length} UP` : 'READY',
      );
    if (e.empty) e.empty.hidden = this._entries.length > 0;
    if (e.clearBtn) e.clearBtn.disabled = !this._entries.length;
    const list = e.list;
    if (!list) return;
    list.replaceChildren();
    const now = Date.now();
    for (const entry of this._entries) {
      const hit = this._hits.get(entry.id);
      const lastSeen = this._lastSeen.get(entry.id);
      const li = document.createElement('li');
      li.className = 'watchlist-entry';
      if (hit) li.classList.add('is-live');
      li.innerHTML = `
        <div class="watchlist-entry-head">
          <strong></strong>
          <span class="watchlist-entry-state"></span>
        </div>
        <div class="watchlist-entry-meta"></div>
        <div class="watchlist-entry-actions">
          <button type="button" data-act="fly">FLY TO</button>
          <button type="button" data-act="remove">REMOVE</button>
        </div>`;
      setText(li.querySelector('strong'), entry.value);
      setText(li.querySelector('.watchlist-entry-state'), hit ? 'ON MAP' : '—');
      let meta;
      if (hit) meta = describeWatchHit(hit);
      else if (lastSeen && now - lastSeen < WATCH_STALE_MS)
        meta = 'just dropped off the feed';
      else meta = 'not on any enabled layer right now';
      setText(li.querySelector('.watchlist-entry-meta'), meta);
      const flyBtn = li.querySelector('[data-act="fly"]');
      const record = hit?.record;
      const canFly =
        Number.isFinite(record?.lat) && Number.isFinite(record?.lon);
      flyBtn.disabled = !canFly;
      if (canFly)
        flyBtn.addEventListener('click', () =>
          flyTo(
            this.viewer,
            record.lat,
            record.lon,
            Number.isFinite(record.altitudeM)
              ? Math.max(record.altitudeM * 3, 40000)
              : 120000,
          ),
        );
      li.querySelector('[data-act="remove"]').addEventListener('click', () =>
        this.removeEntry(entry.id),
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
