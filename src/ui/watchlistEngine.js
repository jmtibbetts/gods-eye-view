/**
 * Watchlist engine (pure): keep a list of specific contacts of interest —
 * aircraft by ICAO24 or callsign, vessels by MMSI or name — and report which
 * of them are currently on the globe, across every enabled layer.
 *
 * No Cesium, no DOM, no network, so the matching rules are fully unit tested
 * and the panel stays a thin renderer over this.
 *
 * Matching is deliberately identifier-agnostic: layers spell identity
 * differently (`icao24`, `callsign`, `mmsi`, `name`), and a watch entry is a
 * string the operator typed. Rather than make the operator say which kind of
 * identifier they mean, every candidate field on a record is normalised and
 * compared, so "N628TS", "ual123" and "366999123" all just work.
 */

/** Identity fields a layer record may carry, in priority order for display. */
export const WATCH_IDENTITY_FIELDS = Object.freeze([
  'icao24',
  'callsign',
  'mmsi',
  'registration',
  'name',
  'id',
]);

/** A hit stays "recently seen" this long after it drops off the feed. */
export const WATCH_STALE_MS = 120_000;

/**
 * Fold an identifier to its comparable form: case and separators carry no
 * meaning across feeds ("UAL 123" and "ual-123" are one aircraft).
 * @param {unknown} value
 * @returns {string} Normalised identifier, or '' when unusable.
 */
export function normalizeWatchValue(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Every normalised identifier a record answers to.
 * @param {object} record
 * @returns {Set<string>}
 */
export function recordIdentifiers(record) {
  const out = new Set();
  if (!record || typeof record !== 'object') return out;
  for (const field of WATCH_IDENTITY_FIELDS) {
    const normalized = normalizeWatchValue(record[field]);
    if (normalized) out.add(normalized);
  }
  return out;
}

/**
 * Does this record answer to the watch entry's identifier?
 * @param {{value: string}} entry
 * @param {object} record
 * @returns {boolean}
 */
export function matchesWatchEntry(entry, record) {
  const target = normalizeWatchValue(entry?.value);
  if (!target) return false;
  return recordIdentifiers(record).has(target);
}

/**
 * Scan every layer for each watch entry.
 *
 * Entries are matched against all layers rather than a declared kind, so an
 * operator who pins an MMSI does not have to also tell us it is a ship.
 *
 * @param {Array<{id: string, value: string}>} entries
 * @param {Array<{layerId: string, name: string, records: object[]}>} layers
 * @returns {Map<string, {layerId: string, layerName: string, record: object}>}
 *   Keyed by entry id; absent when that entry is not currently on the globe.
 */
export function scanWatchlist(entries, layers) {
  const hits = new Map();
  if (!Array.isArray(entries) || !entries.length) return hits;
  const targets = new Map();
  for (const entry of entries) {
    const target = normalizeWatchValue(entry?.value);
    if (target && !targets.has(target)) targets.set(target, entry.id);
  }
  if (!targets.size) return hits;
  for (const layer of layers || []) {
    for (const record of layer.records || []) {
      for (const identifier of recordIdentifiers(record)) {
        const entryId = targets.get(identifier);
        // First layer to claim an entry wins; later duplicates are ignored.
        if (entryId === undefined || hits.has(entryId)) continue;
        hits.set(entryId, {
          layerId: layer.layerId,
          layerName: layer.name || layer.layerId,
          record,
        });
      }
    }
  }
  return hits;
}

/**
 * Which watched contacts just appeared, and which just dropped off.
 * @param {Set<string>} previous Entry ids seen on the last scan.
 * @param {Set<string>} current Entry ids seen now.
 * @returns {{appeared: string[], lost: string[]}}
 */
export function diffWatchHits(previous, current) {
  const appeared = [];
  const lost = [];
  for (const id of current) if (!previous.has(id)) appeared.push(id);
  for (const id of previous) if (!current.has(id)) lost.push(id);
  return { appeared, lost };
}

/**
 * A short human summary of where a hit is right now.
 * @param {{layerName: string, record: object}} hit
 * @returns {string}
 */
export function describeWatchHit(hit) {
  const record = hit?.record || {};
  const bits = [hit?.layerName].filter(Boolean);
  if (Number.isFinite(record.lat) && Number.isFinite(record.lon)) {
    const ns = record.lat >= 0 ? 'N' : 'S';
    const ew = record.lon >= 0 ? 'E' : 'W';
    bits.push(
      `${Math.abs(record.lat).toFixed(2)}${ns} ${Math.abs(record.lon).toFixed(2)}${ew}`,
    );
  }
  if (Number.isFinite(record.altitudeM))
    bits.push(`${Math.round(record.altitudeM)} m`);
  else if (Number.isFinite(record.speedKts))
    bits.push(`${Math.round(record.speedKts)} kt`);
  return bits.join(' · ');
}

/** The label shown for an entry: what the operator typed, tidied. */
export function watchEntryLabel(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .slice(0, 24);
}
