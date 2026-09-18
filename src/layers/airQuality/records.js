import { bandFor, bandRank } from './policy.js';

/**
 * Flatten one ring, rejecting the whole ring if any vertex is unusable — an
 * AQI contour drawn with a missing corner would put a health boundary
 * somewhere EPA did not.
 * @returns {number[]|null}
 */
function flatRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const flat = [];
  for (const point of ring) {
    const [lon, lat] = point || [];
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    flat.push(lon, lat);
  }
  return flat.length >= 6 ? flat : null;
}

/**
 * Parse AirNow contours.
 *
 * A feature whose gridcode is not one of the six published bands is DROPPED
 * rather than drawn in a default colour. Every colour on this layer carries a
 * health meaning, so an unknown value shown as green would be a false
 * reassurance and shown as red a false alarm; the honest option is silence.
 *
 * @param {any} geojson
 * @returns {object[]} Best air first, so worse air draws on top.
 */
export function parseAirQuality(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const feature of features) {
    const p = feature?.properties || {};
    const band = bandFor(p.gridcode);
    if (!band) continue;
    const geometry = feature?.geometry;
    const polygons =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    const observedMs = Number(p.Timestamp) || Number(p.Unixtime) * 1000 || null;
    polygons.forEach((rings, index) => {
      const outer = flatRing(rings?.[0]);
      if (!outer) return;
      const holes = [];
      for (let i = 1; i < (rings?.length || 0); i++) {
        const hole = flatRing(rings[i]);
        if (hole) holes.push(hole);
      }
      out.push({
        id: `aqi:${p.OBJECTID ?? p.Id ?? 'x'}:${index}`,
        code: band.code,
        name: band.name,
        range: band.range,
        guidance: band.guidance,
        color: band.color,
        rank: bandRank(p.gridcode),
        observedMs: Number.isFinite(observedMs) ? observedMs : null,
        positions: outer,
        holes,
      });
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}

/** What the panel reports: the worst band present is the number that matters. */
export function summarizeAirQuality(areas) {
  const counts = new Map();
  let worst = null;
  let observedMs = null;
  for (const area of areas) {
    counts.set(area.name, (counts.get(area.name) || 0) + 1);
    if (!worst || area.rank > worst.rank) worst = area;
    if (area.observedMs && (!observedMs || area.observedMs > observedMs))
      observedMs = area.observedMs;
  }
  return {
    areas: areas.length,
    worst: worst ? worst.name : null,
    worstCode: worst ? worst.code : 0,
    observedMs,
    breakdown: [...counts.entries()].map(([name, count]) => ({ name, count })),
  };
}
