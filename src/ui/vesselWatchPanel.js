import * as Cesium from 'cesium';
import {
  findDarkVessels,
  matchSanctionedVessels,
  normalizeSanctionedVessels,
  pruneVesselTracks,
  silenceText,
  updateVesselTracks,
} from './vesselWatchEngine.js';

const SCAN_MS = 30_000;
const RECORDS_PER_SCAN = 6000;
const MAX_ROWS = 12;
const VESSEL_LAYER_IDS = Object.freeze(['ais-live-vessels']);

/** Bundled OFAC vessel table (see src/data/local_data/sanctioned_vessels/source.json). */
export const SANCTIONED_VESSELS_URL = new URL(
  '../data/local_data/sanctioned_vessels/vessels.json',
  import.meta.url,
).href;

function setText(el, value) {
  if (el) el.textContent = value;
}

function flyTo(viewer, lat, lon) {
  if (!viewer?.camera) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 180000),
    duration: 1.4,
  });
}

/**
 * VESSEL WATCH panel: two reads over the live AIS feed that the raw feed does
 * not offer — which vessels in view are on the OFAC sanctions list, and which
 * tracked vessels have stopped transmitting.
 *
 * Reads through the data manager's `getAnalystRecords` and owns no feed.
 */
export class VesselWatchPanel {
  constructor({
    elements,
    dataManager,
    viewer,
    onToast,
    fetchImpl = (...args) => globalThis.fetch(...args),
    sanctionsUrl = SANCTIONED_VESSELS_URL,
  } = {}) {
    this.elements = elements || {};
    this._resolveDataManager =
      typeof dataManager === 'function' ? dataManager : () => dataManager;
    this.viewer = viewer;
    this.onToast = typeof onToast === 'function' ? onToast : () => {};
    this._fetch = fetchImpl;
    this._sanctionsUrl = sanctionsUrl;
    this.destroyed = false;
    this._timer = null;
    /** @type {Map<string, object>} MMSI → running track. */
    this._tracks = new Map();
    /** @type {Map<string, object>} MMSI → OFAC listing. */
    this._sanctions = new Map();
    this._sanctionsError = null;
    this._sanctionHits = [];
    this._dark = [];
    this._announced = new Set();
  }

  async connect() {
    this._timer = setInterval(() => this.scan(), SCAN_MS);
    this.render();
    await this._loadSanctions();
    this.scan();
  }

  async _loadSanctions() {
    if (this._sanctions.size || this.destroyed) return;
    try {
      const response = await this._fetch(this._sanctionsUrl, {
        cache: 'force-cache',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this._sanctions = normalizeSanctionedVessels(await response.json());
      if (!this._sanctions.size) throw new Error('empty table');
    } catch (error) {
      this._sanctionsError = error?.message || 'unavailable';
    }
    this.render();
  }

  /** Vessel records from whichever vessel layers are enabled. */
  _vesselRecords() {
    const dm = this._resolveDataManager();
    const records = [];
    if (!dm?.layers) return records;
    for (const id of VESSEL_LAYER_IDS) {
      if (!dm.isEnabled?.(id)) continue;
      const module = dm.layers.get(id)?.module;
      if (typeof module?.getAnalystRecords !== 'function') continue;
      try {
        const batch = module.getAnalystRecords(RECORDS_PER_SCAN);
        if (Array.isArray(batch)) records.push(...batch);
      } catch {
        /* a layer mid-teardown simply contributes nothing */
      }
    }
    return records;
  }

  scan() {
    if (this.destroyed) return;
    const now = Date.now();
    const records = this._vesselRecords();
    if (records.length) {
      updateVesselTracks(this._tracks, records, now);
      pruneVesselTracks(this._tracks, now);
    }
    this._sanctionHits = matchSanctionedVessels(records, this._sanctions);
    this._dark = findDarkVessels(this._tracks, now);
    for (const hit of this._sanctionHits) {
      const key = `sanctioned:${hit.record.mmsi}`;
      if (this._announced.has(key)) continue;
      this._announced.add(key);
      this.onToast(
        `VESSEL WATCH: ${hit.listing.name || hit.record.name || hit.record.mmsi} is OFAC-listed (${hit.listing.program})`,
      );
    }
    this.render();
  }

  render() {
    if (this.destroyed) return;
    const e = this.elements;
    if (e.layerState)
      setText(
        e.layerState,
        this._tracks.size
          ? `${this._sanctionHits.length} LISTED · ${this._dark.length} DARK`
          : 'READY',
      );
    if (e.empty)
      e.empty.hidden = this._tracks.size > 0 || Boolean(this._sanctionsError);
    if (e.note)
      setText(
        e.note,
        this._sanctionsError
          ? `Sanctions table unavailable (${this._sanctionsError}) — dark-ship detection still running.`
          : `${this._sanctions.size} OFAC-listed MMSIs loaded · tracking ${this._tracks.size} vessels`,
      );
    const list = e.list;
    if (!list) return;
    list.replaceChildren();
    for (const hit of this._sanctionHits.slice(0, MAX_ROWS))
      list.append(
        this._row({
          kind: 'listed',
          title: hit.listing.name || hit.record.name || hit.record.mmsi,
          state: 'OFAC',
          meta: [
            hit.listing.program,
            hit.listing.flag,
            hit.listing.imo && `IMO ${hit.listing.imo}`,
            `MMSI ${hit.record.mmsi}`,
          ]
            .filter(Boolean)
            .join(' · '),
          lat: hit.record.lat,
          lon: hit.record.lon,
        }),
      );
    for (const track of this._dark.slice(0, MAX_ROWS))
      list.append(
        this._row({
          kind: 'dark',
          title: track.name || `MMSI ${track.mmsi}`,
          state: 'DARK',
          meta: `${silenceText(track.silentMs)} · last fix ${track.lat.toFixed(2)}, ${track.lon.toFixed(2)}`,
          lat: track.lat,
          lon: track.lon,
        }),
      );
  }

  _row({ kind, title, state, meta, lat, lon }) {
    const li = document.createElement('li');
    li.className = `vessel-watch-row is-${kind}`;
    li.innerHTML = `
      <div class="vessel-watch-head">
        <strong></strong>
        <span class="vessel-watch-state"></span>
      </div>
      <div class="vessel-watch-meta"></div>
      <div class="vessel-watch-actions">
        <button type="button" data-act="fly">FLY TO</button>
      </div>`;
    setText(li.querySelector('strong'), title);
    setText(li.querySelector('.vessel-watch-state'), state);
    setText(li.querySelector('.vessel-watch-meta'), meta);
    const fly = li.querySelector('[data-act="fly"]');
    const canFly = Number.isFinite(lat) && Number.isFinite(lon);
    fly.disabled = !canFly;
    if (canFly)
      fly.addEventListener('click', () => flyTo(this.viewer, lat, lon));
    return li;
  }

  destroy() {
    this.destroyed = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._tracks.clear();
    this._announced.clear();
  }
}
