import { intensityFor } from './policy.js';

const text = (value, max = 120) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

/** Flatten a [[lon,lat],…] ring, rejecting the whole ring on a bad vertex. */
function flatRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const flat = [];
  for (const point of ring) {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    flat.push(lon, lat);
  }
  return flat.length >= 6 ? flat : null;
}

/**
 * Join per-country counts to country polygons.
 *
 * @param {any} payload The proxy's aggregate.
 * @param {Map<string, object[]>} index FIPS code -> country features.
 * @returns {object[]} Least intense first, so worse shading draws on top.
 *   Carries non-enumerable `unmapped` — countries the feed reported that the
 *   boundary pack has no shape for.
 */
export function parseReports(payload, index) {
  const rows = Array.isArray(payload?.countries) ? payload.countries : [];
  const out = [];
  const unmapped = [];
  for (const row of rows) {
    const code = String(row?.code || '')
      .trim()
      .toUpperCase();
    const events = count(row?.events);
    const band = intensityFor(events);
    if (!code || !band) continue;
    const features = index?.get(code);
    if (!features?.length) {
      // Small states the 110m boundary set omits — the Cook Islands turned up
      // in the very first live sample. Counted and surfaced rather than
      // dropped, because a country quietly missing from a conflict map is
      // indistinguishable from a country with nothing to report.
      unmapped.push({ code, events });
      continue;
    }
    for (const feature of features) {
      for (const [part, ring] of (feature.polygons || []).entries()) {
        const positions = flatRing(ring);
        if (!positions) continue;
        out.push({
          id: `${code}:${feature.name}:${part}`,
          code,
          country: text(feature.name, 48),
          events,
          mentions: count(row?.mentions),
          // How many of this country's events carried no place more precise
          // than the country or a state — the honest measure of how little
          // this data localizes.
          centroidOnly: count(row?.centroidOnly),
          kinds: row?.kinds && typeof row.kinds === 'object' ? row.kinds : {},
          band: band.key,
          bandName: band.name,
          color: band.color,
          rank: band.rank,
          positions,
        });
      }
    }
  }
  out.sort((a, b) => a.rank - b.rank);
  Object.defineProperty(out, 'unmapped', {
    value: unmapped,
    enumerable: false,
  });
  return out;
}

/** What the panel reports. */
export function summarizeReports(areas, payload) {
  const countries = new Set(areas.map((a) => a.code));
  let events = 0;
  const counted = new Set();
  for (const area of areas) {
    if (counted.has(area.code)) continue;
    counted.add(area.code);
    events += area.events;
  }
  const counts = new Map();
  for (const code of counted) {
    const area = areas.find((a) => a.code === code);
    counts.set(area.bandName, (counts.get(area.bandName) || 0) + 1);
  }
  const unmapped = areas.unmapped || [];
  return {
    countries: countries.size,
    events,
    windowMinutes: Number(payload?.windowMinutes) || 0,
    sourceFile: text(payload?.sourceFile, 48),
    scanned: count(payload?.totals?.rows),
    unmapped,
    unmappedEvents: unmapped.reduce((n, u) => n + u.events, 0),
    breakdown: [...counts.entries()].map(([name, n]) => ({ name, count: n })),
  };
}

/** Share of a country's reports that carried no place inside it. */
export function centroidShare(area) {
  if (!area?.events) return null;
  return Math.round((100 * (area.centroidOnly || 0)) / area.events);
}
