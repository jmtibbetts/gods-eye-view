import { stationState, withinScope } from './policy.js';

const text = (value, max = 120) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * A coordinate, or null.
 *
 * Rejects blank, null and boolean BEFORE converting, because `Number(null)`,
 * `Number('')` and `Number(false)` are all 0 — a perfectly valid latitude. A
 * station with no latitude on file would otherwise be placed on the equator
 * at its real longitude, which looks like a site rather than a gap.
 */
const coord = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean')
    return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * Parse trimmed SatNOGS stations into drawable records.
 *
 * @param {any} payload The proxy's trimmed list.
 * @param {object} scope
 * @param {number} [now]
 * @returns {object[]} Least active first, so live stations draw on top.
 *   Carries a non-enumerable `total` — every station the network published,
 *   before the scope filter, so the layer can say what it is not showing.
 */
export function parseStations(payload, scope, now = Date.now()) {
  const rows = Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const lat = coord(row?.lat);
    const lon = coord(row?.lng);
    if (lat === null || Math.abs(lat) > 90) continue;
    if (lon === null || Math.abs(lon) > 180) continue;
    // A station at exactly 0,0 is an unset location, not a buoy in the
    // Atlantic: SatNOGS stations are somebody's roof.
    if (lat === 0 && lon === 0) continue;
    if (!withinScope(row, scope, now)) continue;
    const id = String(row?.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = stationState(row);
    out.push({
      id,
      stationId: row.id,
      name: text(row.name, 60) || `Station ${id}`,
      state: state.key,
      stateName: state.name,
      meaning: state.meaning,
      color: state.color,
      rank: state.rank,
      observations: count(row.observations),
      future: count(row.future),
      // A success rate of 0 is a real reading, so it must survive the
      // null-versus-falsy distinction that `||` would collapse.
      successRate: count(row.successRate),
      bands: Array.isArray(row.bands) ? row.bands.map((b) => text(b, 12)) : [],
      lastSeen: text(row.lastSeen, 32),
      altitude: count(row.altitude),
      lat,
      lon,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  Object.defineProperty(out, 'total', {
    value: rows.length,
    enumerable: false,
  });
  return out;
}

/** What the panel reports. */
export function summarizeStations(stations, scope) {
  const counts = new Map();
  let observations = 0;
  for (const station of stations) {
    counts.set(station.stateName, (counts.get(station.stateName) || 0) + 1);
    observations += station.observations || 0;
  }
  return {
    scope: scope.key,
    scopeLabel: scope.label,
    stations: stations.length,
    total: stations.total ?? stations.length,
    observations,
    // Insertion order, which is ascending rank because the station list is
    // sorted that way. Deterministic, and consistent with the other layers'
    // legends; sorting by count would tie unpredictably.
    breakdown: [...counts.entries()].map(([name, n]) => ({ name, count: n })),
  };
}

/** How long ago a station reported in, in plain words. */
export function lastSeenText(station, now = Date.now()) {
  const at = Date.parse(station?.lastSeen || '');
  if (!Number.isFinite(at)) return 'never reported in';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'seen just now';
  if (minutes < 60) return `seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `seen ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 90) return `seen ${days} days ago`;
  return `seen ${station.lastSeen.slice(0, 10)}`;
}
