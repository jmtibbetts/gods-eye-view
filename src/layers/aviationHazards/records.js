import { QUALIFIERS, TRENDS, hazardClassFor, inForce } from './policy.js';

const text = (value, max = 120) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const number = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean')
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** An epoch-second time as an ISO minute, or ''. */
export function isoMinute(seconds) {
  const n = number(seconds);
  if (n === null) return '';
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The volcano an ash advisory names, or ''.
 *
 * The international feed reuses one `qualifier` field for two unrelated things:
 * an intensity code on most hazards, and the VOLCANO NAME on a volcanic-ash
 * advisory. Reading it blindly would label a Mayon eruption "MAYON intensity";
 * reading it as intensity only when it is a known intensity code keeps both
 * meanings straight and lets the ash advisories tie back to the volcano layer.
 */
export function volcanoName(record) {
  if (record?.hazard !== 'VA') return '';
  const q = text(record?.qualifier, 40);
  return q && !QUALIFIERS[q.toUpperCase()] ? q : '';
}

/** The intensity a record states, or ''. */
export function intensity(record) {
  const q = text(record?.qualifier, 12).toUpperCase();
  return QUALIFIERS[q] || '';
}

/**
 * Parse the proxy's normalized SIGMET list into drawable areas.
 *
 * @param {any} payload
 * @param {object} filter
 * @param {number} [now] epoch ms
 * @returns {object[]} Least severe first, so worse hazards draw on top.
 *   Carries non-enumerable `total` and `expired` counts.
 */
export function parseSigmets(payload, filter, now = Date.now()) {
  const rows = Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  let expired = 0;
  let dropped = 0;
  for (const row of rows) {
    // An expired SIGMET drawn as current says airspace is dangerous after the
    // issuing authority has said it is not.
    if (!inForce(row, now)) {
      expired += 1;
      continue;
    }
    // One advisory can cover several discrete areas; each becomes its own
    // drawable polygon rather than the advisory being reduced to its first.
    const parts = Array.isArray(row?.parts)
      ? row.parts.filter((p) => Array.isArray(p) && p.length >= 6)
      : [];
    if (!parts.length) {
      dropped += 1;
      continue;
    }
    const klass = hazardClassFor(row.hazard);
    if (filter.classKey && klass.key !== filter.classKey) continue;
    const id = text(row?.id, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    parts.forEach((positions, part) => {
      out.push({
        id: parts.length > 1 ? `${id}#${part}` : id,
        origin: row.origin === 'domestic' ? 'domestic' : 'international',
        hazard: row.hazard,
        classKey: klass.key,
        name: klass.name,
        meaning: klass.meaning,
        color: klass.color,
        rank: klass.rank,
        region: text(row.region, 48),
        volcano: volcanoName(row),
        intensity: intensity(row),
        trend: TRENDS[text(row.trend, 8).toUpperCase()] || '',
        // Flight levels in feet. Zero is a real base — an ash cloud reaching the
        // surface — so it must survive rather than read as absent.
        low: number(row.low),
        high: number(row.high),
        dir: number(row.dir),
        speed: number(row.speed),
        from: isoMinute(row.from),
        to: isoMinute(row.to),
        raw: text(row.raw, 400),
        positions,
      });
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  Object.defineProperty(out, 'total', {
    value: rows.length,
    enumerable: false,
  });
  Object.defineProperty(out, 'expired', { value: expired, enumerable: false });
  // Advisories with no usable geometry at all. Counted rather than ignored:
  // a rise here means the feed changed shape again.
  Object.defineProperty(out, 'dropped', { value: dropped, enumerable: false });
  return out;
}

/** What the panel reports: the most serious hazard present, and how many. */
export function summarizeSigmets(areas, filter) {
  const counts = new Map();
  let worst = null;
  for (const area of areas) {
    counts.set(area.name, (counts.get(area.name) || 0) + 1);
    if (!worst || area.rank > worst.rank) worst = area;
  }
  return {
    filter: filter.key,
    filterLabel: filter.label,
    areas: areas.length,
    total: areas.total ?? areas.length,
    expired: areas.expired ?? 0,
    dropped: areas.dropped ?? 0,
    worst: worst ? worst.name : null,
    breakdown: [...counts.entries()].map(([name, count]) => ({ name, count })),
  };
}

/**
 * "FL050–FL340", "surface to FL150", or '' when neither bound is given.
 *
 * Compares with `== null` rather than `=== null` so an ABSENT field counts as
 * absent alongside an explicitly null one: destructuring a record that has no
 * altitudes at all yields undefined, which a strict null check lets through to
 * render as "FLNaN–FLNaN".
 *
 * A base of 0 is a real reading — an ash cloud reaching the surface — so it is
 * distinguished from a missing one rather than being treated as falsy.
 */
export function altitudeText(area) {
  const fl = (feet) => `FL${String(Math.round(feet / 100)).padStart(3, '0')}`;
  const { low, high } = area || {};
  const hasLow = low != null && Number.isFinite(low);
  const hasHigh = high != null && Number.isFinite(high);
  if (!hasLow && !hasHigh) return '';
  if (hasLow && hasHigh)
    return low === 0 ? `surface to ${fl(high)}` : `${fl(low)}–${fl(high)}`;
  if (hasHigh) return `up to ${fl(high)}`;
  return low === 0 ? 'from the surface' : `above ${fl(low)}`;
}
