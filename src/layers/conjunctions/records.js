import { eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';
import { bandFor } from './policy.js';

/**
 * Conjunction records: the proxy's list, placed.
 *
 * Placing means propagating each object's elements to the time of closest
 * approach and reading off latitude, longitude and height in the frame the
 * Earth will be in at that instant. The marker goes at the midpoint. When
 * only one object has elements the marker goes on that one — the two are
 * within a few kilometres of each other by definition — and when neither
 * does the record is kept, unplaced, so the list and the count are honest.
 */

const R2D = 180 / Math.PI;

/** Geodetic position of a TLE at an instant, or null. */
export function positionAt(lines, dateMs) {
  if (!Array.isArray(lines) || lines.length !== 2) return null;
  let satrec;
  try {
    satrec = twoline2satrec(lines[0], lines[1]);
  } catch {
    return null;
  }
  const date = new Date(dateMs);
  const pv = propagate(satrec, date);
  const pos = pv && pv.position;
  if (!pos || typeof pos === 'boolean' || !Number.isFinite(pos.x)) return null;
  const geo = eciToGeodetic(pos, gstime(date));
  let lon = geo.longitude * R2D;
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  if (!Number.isFinite(geo.height) || geo.height < 80) return null;
  return { lat: geo.latitude * R2D, lon, altKm: geo.height };
}

/** The midpoint of two geodetic points, or whichever exists. */
function midpoint(a, b) {
  if (a && b) {
    let dLon = b.lon - a.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let lon = a.lon + dLon / 2;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return {
      lat: (a.lat + b.lat) / 2,
      lon,
      altKm: (a.altKm + b.altKm) / 2,
    };
  }
  return a || b || null;
}

/**
 * @param {object} payload The proxy body.
 * @param {object} filter A CONJUNCTION_FILTERS entry.
 * @param {number} [nowMs]
 * @returns {Array<object>} Records, soonest first, with `.placed`,
 *   `.unplaced`, `.pending`, `.total`, `.coOrbiting` and `.fetchedAt`.
 */
export function parseConjunctions(payload, filter, nowMs = Date.now()) {
  const rows = Array.isArray(payload?.conjunctions) ? payload.conjunctions : [];
  const out = [];
  let placed = 0;
  let unplaced = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !row.id || !row.tca) continue;
    const tcaMs = Date.parse(row.tca);
    if (!Number.isFinite(tcaMs) || tcaMs < nowMs) continue;
    const objects = (row.objects || []).slice(0, 2).map((o) => ({
      noradId: o.noradId,
      name: o.name || `NORAD ${o.noradId}`,
      status: o.status || 'unknown',
      station: o.station || null,
      hasElements: Array.isArray(o.tle) && o.tle.length === 2,
      position: positionAt(o.tle, tcaMs),
    }));
    if (objects.length !== 2) continue;
    const record = {
      id: row.id,
      objects,
      tca: row.tca,
      tcaMs,
      rangeKm: Number.isFinite(row.rangeKm) ? row.rangeKm : null,
      relativeSpeedKms: Number.isFinite(row.relativeSpeedKms)
        ? row.relativeSpeedKms
        : null,
      maxProbability: Number.isFinite(row.maxProbability)
        ? row.maxProbability
        : null,
      dilutionKm: Number.isFinite(row.dilutionKm) ? row.dilutionKm : null,
      crewed: row.crewed === true,
      why: Array.isArray(row.why) ? row.why : [],
      band: bandFor(row.maxProbability),
      position: midpoint(objects[0].position, objects[1].position),
    };
    if (filter && !filter.test(record)) continue;
    if (record.position) placed++;
    else unplaced++;
    out.push(record);
  }
  out.sort((a, b) => a.tcaMs - b.tcaMs);
  out.placed = placed;
  out.unplaced = unplaced;
  out.pending = Number.isFinite(payload?.pending) ? payload.pending : 0;
  out.total = Number.isFinite(payload?.total) ? payload.total : rows.length;
  out.coOrbiting = Number.isFinite(payload?.coOrbiting)
    ? payload.coOrbiting
    : 0;
  out.fetchedAt = payload?.fetchedAt ?? null;
  return out;
}

/** "in 3 h 12 min", "in 2 d 4 h", "now". */
export function untilText(tcaMs, nowMs) {
  const s = Math.round((tcaMs - nowMs) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `in ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `in ${h} h ${m % 60} min` : `in ${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `in ${d} d ${h % 24} h` : `in ${d} d`;
}

/** "0.005 km" / "1.2 km" — the miss as SOCRATES states it. */
export function rangeText(rangeKm) {
  if (!Number.isFinite(rangeKm)) return 'range unknown';
  if (rangeKm < 1) return `${Math.round(rangeKm * 1000)} m`;
  return `${rangeKm.toFixed(rangeKm < 10 ? 2 : 1)} km`;
}

/** Counts per band, most serious first, plus the soonest record. */
export function summarizeConjunctions(records) {
  const counts = new Map();
  for (const r of records)
    counts.set(r.band.name, (counts.get(r.band.name) || 0) + 1);
  return {
    count: records.length,
    placed: records.placed ?? 0,
    unplaced: records.unplaced ?? 0,
    pending: records.pending ?? 0,
    next: records[0] || null,
    worst: records.length
      ? records.reduce((a, b) => (b.band.rank > a.band.rank ? b : a)).band.name
      : null,
    breakdown: [...counts.entries()].map(([name, count]) => ({ name, count })),
  };
}
