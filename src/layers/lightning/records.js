import {
  feedLatitude,
  feedLongitude,
  feedNumber,
} from '../../data/feedNumbers.js';
import { energyBand, satelliteName } from './policy.js';

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
    const lat = feedLatitude(row?.lat);
    const lon = feedLongitude(row?.lon);
    if (lat === null || lon === null) continue;
    const energy = feedNumber(row?.energy) ?? 0;
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
      windowSeconds: feedNumber(payload?.windowSeconds) ?? 0,
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
