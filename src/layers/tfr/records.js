import { tfrClassFor, tfrCurrent } from './policy.js';

/**
 * TFR records, from the proxy's shape to what the layer draws.
 *
 * The proxy hands over one record per NOTAM with its list of areas. The
 * layer draws one polygon per AREA — a NOTAM that closes four separate
 * boxes down range is four polygons with one card — so this is where a
 * record fans out, and where the ones the filter excludes, the ones with
 * no shape, and the ones that are plainly over are set aside and counted.
 */

/** "6/2736#233535": one polygon's id, from its NOTAM and the FAA's GID. */
export const areaId = (notamId, gid) => `${notamId}#${gid}`;

/**
 * @param {object} payload The proxy body `{ fetchedAt, tfrs }`.
 * @param {object} filter A TFR_FILTERS entry.
 * @param {number} [nowMs]
 * @returns {Array<object>} Areas to draw, with `.total`, `.noShape`,
 *   `.over` counts and `.fetchedAt` on the array.
 */
export function parseTfrs(payload, filter, nowMs = Date.now()) {
  const rows = Array.isArray(payload?.tfrs) ? payload.tfrs : [];
  const areas = [];
  let noShape = 0;
  let over = 0;
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !row.id) continue;
    const klass = tfrClassFor(row.type);
    if (filter?.classKey && klass.key !== filter.classKey) continue;
    if (!tfrCurrent(row, nowMs)) {
      over++;
      continue;
    }
    total++;
    if (!Array.isArray(row.areas) || !row.areas.length) {
      noShape++;
      continue;
    }
    for (const area of row.areas) {
      if (!Array.isArray(area?.ring) || area.ring.length < 8) continue;
      areas.push({
        id: areaId(row.id, area.gid),
        notamId: row.id,
        classKey: klass.key,
        name: klass.name,
        color: klass.color,
        rank: klass.rank,
        meaning: klass.meaning,
        type: row.type,
        title: row.title,
        facility: row.facility,
        state: row.state,
        begins: row.begins,
        ends: row.ends,
        timesExact: row.timesExact === true,
        localTime: row.localTime === true,
        altitude: row.altitude,
        reason: row.reason,
        location: row.location,
        contact: row.contact,
        pageUrl: row.pageUrl,
        positions: area.ring,
        centre: area.centre,
        parts: row.areas.length,
      });
    }
  }
  // Ascending severity, so the closure that matters most is drawn last
  // and lands on top of whatever it overlaps.
  areas.sort((a, b) => a.rank - b.rank);
  areas.total = total;
  areas.noShape = noShape;
  areas.over = over;
  areas.fetchedAt = payload?.fetchedAt ?? null;
  return areas;
}

/** Per class, how many NOTAMs (not polygons) are drawn, most serious first. */
export function summarizeTfrs(areas, filter) {
  const byClass = new Map();
  let worst = null;
  for (const area of areas) {
    if (!byClass.has(area.name)) byClass.set(area.name, new Set());
    byClass.get(area.name).add(area.notamId);
    if (!worst || area.rank > worst.rank) worst = area;
  }
  return {
    filter: filter.key,
    filterLabel: filter.label,
    polygons: areas.length,
    notams: new Set(areas.map((a) => a.notamId)).size,
    total: areas.total ?? 0,
    noShape: areas.noShape ?? 0,
    over: areas.over ?? 0,
    worst: worst ? worst.name : null,
    breakdown: [...byClass.entries()].map(([name, ids]) => ({
      name,
      count: ids.size,
    })),
  };
}

/** "Sep 20 14:00Z → Sep 21 06:00Z", or the day form when only dates are known. */
export function windowText(record) {
  const b = Date.parse(record?.begins || '');
  const e = Date.parse(record?.ends || '');
  if (!Number.isFinite(b) && !Number.isFinite(e)) return null;
  const day = (t) =>
    new Date(t).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const stamp = (t) => `${day(t)} ${new Date(t).toISOString().slice(11, 16)}Z`;
  if (record.timesExact) {
    if (Number.isFinite(b) && Number.isFinite(e))
      return `${stamp(b)} → ${stamp(e)}`;
    return Number.isFinite(b) ? `from ${stamp(b)}` : `until ${stamp(e)}`;
  }
  const from = Number.isFinite(b) ? day(b) : null;
  const to = Number.isFinite(e) ? day(e) : null;
  const span = from && to && from !== to ? `${from} – ${to}` : from || to;
  return `${span} (${record.localTime ? 'local days' : 'UTC days'} — exact times on the NOTAM)`;
}

/** Where a closure is on the clock. */
export function tfrPhase(record, nowMs) {
  const b = Date.parse(record?.begins || '');
  const e = Date.parse(record?.ends || '');
  if (Number.isFinite(e) && nowMs > e) return 'over';
  if (Number.isFinite(b) && nowMs < b) return 'ahead';
  return 'active';
}
