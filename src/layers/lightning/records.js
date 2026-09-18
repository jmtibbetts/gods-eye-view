import { energyBand, satelliteName } from './policy.js';

/**
 * A finite number, or null.
 *
 * Blank strings, null and booleans are rejected BEFORE the conversion, because
 * `Number('')`, `Number(null)` and `Number(false)` are all 0 — a valid latitude
 * and a valid longitude. Without this a flash with a missing coordinate is
 * drawn in the Gulf of Guinea, which is both a plausible place for lightning
 * and the wrong one.
 */
const number = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean')
    return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the proxy's flash list.
 *
 * @param {any} payload
 * @returns {object[]} Faintest first, so bright flashes draw on top.
 *   Carries non-enumerable `meta` describing the observation window.
 */
export function parseFlashes(payload) {
  const rows = Array.isArray(payload?.flashes) ? payload.flashes : [];
  const out = [];
  for (const [index, row] of rows.entries()) {
    const lat = number(row?.lat);
    const lon = number(row?.lon);
    if (lat === null || Math.abs(lat) > 90) continue;
    if (lon === null || Math.abs(lon) > 180) continue;
    const energy = number(row?.energy) ?? 0;
    const band = energyBand(energy);
    out.push({
      id: `${row?.sat || 'x'}:${index}`,
      lat,
      lon,
      energy,
      band: band.key,
      bandName: band.name,
      color: band.color,
      size: band.size,
      satellite: String(row?.sat || ''),
      satelliteName: satelliteName(row?.sat),
    });
  }
  out.sort((a, b) => a.energy - b.energy);
  Object.defineProperty(out, 'meta', {
    value: {
      at: String(payload?.at || ''),
      windowSeconds: number(payload?.windowSeconds) ?? 0,
      satellites: Array.isArray(payload?.satellites) ? payload.satellites : [],
      missing: Array.isArray(payload?.missing) ? payload.missing : [],
    },
    enumerable: false,
  });
  return out;
}

/** What the panel reports. */
export function summarizeFlashes(flashes) {
  const meta = flashes.meta || {
    satellites: [],
    missing: [],
    windowSeconds: 0,
  };
  const counts = new Map();
  for (const flash of flashes)
    counts.set(flash.bandName, (counts.get(flash.bandName) || 0) + 1);
  return {
    flashes: flashes.length,
    windowSeconds: meta.windowSeconds,
    at: meta.at,
    satellites: meta.satellites.map((s) => s.id),
    missing: meta.missing,
    breakdown: [...counts.entries()].map(([name, count]) => ({ name, count })),
  };
}

/**
 * What the layer can honestly claim to have looked at.
 *
 * Naming the satellites rather than only counting flashes is what keeps an
 * unobserved hemisphere from reading as a calm one.
 */
export function coverageText(summary) {
  const seen = (summary?.satellites || []).map(satelliteName);
  if (!seen.length) return 'no satellite reporting';
  if (summary.missing?.length) {
    const lost = summary.missing.map(satelliteName).join(', ');
    return `${seen.join(' + ')} only — ${lost} not reporting`;
  }
  return seen.join(' + ');
}
