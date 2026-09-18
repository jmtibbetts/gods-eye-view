import {
  MIN_PART_KM2,
  droughtClassFor,
  outlookClassFor,
  ringAreaKm2,
} from './policy.js';

const text = (value, max = 120) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Flatten one GeoJSON ring to [lon, lat, …], rejecting the whole ring if any
 * vertex is unusable — a drought band drawn with a missing corner would put a
 * boundary somewhere the Drought Monitor did not.
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

/** An ArcGIS epoch-millisecond date as a plain ISO day, or ''. */
export function isoDay(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return text(value, 32);
}

/**
 * Parse a drought GeoJSON into drawable bands.
 *
 * Holes are kept. Both services publish polygons with interior rings, and
 * filling one would paint a class over ground it does not cover.
 *
 * A feature whose class is unrecognised is dropped rather than drawn in a
 * fallback colour: CPC's `No_Drought` arrives on every outlook and is published
 * with alpha 0, so painting it would blanket the country in a class that means
 * "nothing to report".
 *
 * Parts below the geometry's own resolution are dropped and counted; see
 * MIN_PART_KM2. The count comes back on the result so the layer can report it
 * rather than quietly showing less than it received.
 *
 * @param {any} geojson
 * @param {object} product
 * @returns {object[]} Least severe first, so worse bands draw on top.
 *   Carries a non-enumerable `droppedParts` count.
 */
export function parseDrought(geojson, product) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const monitor = product.kind === 'monitor';
  const out = [];
  let dropped = 0;
  for (const feature of features) {
    const p = feature?.properties || {};
    const klass = monitor ? droughtClassFor(p.dm) : outlookClassFor(p.outlook);
    if (!klass) continue;
    const geometry = feature?.geometry;
    const polygons =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    const valid = monitor ? isoDay(p.ddate) : text(p.target, 32);
    const issued = monitor ? '' : isoDay(p.fcst_date);
    polygons.forEach((rings, index) => {
      const outer = flatRing(rings?.[0]);
      if (!outer) return;
      if (ringAreaKm2(outer) < MIN_PART_KM2) {
        dropped += 1;
        return;
      }
      const holes = [];
      for (let i = 1; i < (rings?.length || 0); i++) {
        const hole = flatRing(rings[i]);
        if (hole) holes.push(hole);
      }
      out.push({
        id: `${product.key}:${klass.key}:${index}`,
        product: product.key,
        productLabel: product.label,
        kind: product.kind,
        classKey: klass.key,
        name: klass.name,
        meaning: klass.meaning,
        color: klass.color,
        rank: klass.rank,
        valid,
        issued,
        attribution: product.attribution,
        positions: outer,
        holes,
      });
    });
  }
  // Ascending severity. The published bands overlap across roughly a tenth of
  // their area, so where two cover the same ground the worse one must draw last.
  out.sort((a, b) => a.rank - b.rank);
  Object.defineProperty(out, 'droppedParts', {
    value: dropped,
    enumerable: false,
  });
  return out;
}

/** What the panel reports: the worst class present, and how many parts of each. */
export function summarizeDrought(bands, product) {
  const counts = new Map();
  let worst = null;
  for (const band of bands) {
    counts.set(band.name, (counts.get(band.name) || 0) + 1);
    if (!worst || band.rank > worst.rank) worst = band;
  }
  return {
    product: product.key,
    productLabel: product.label,
    kind: product.kind,
    bands: bands.length,
    worst: worst ? worst.name : null,
    worstRank: worst ? worst.rank : 0,
    valid: bands[0]?.valid || '',
    issued: bands[0]?.issued || '',
    droppedParts: bands.droppedParts || 0,
    breakdown: [...counts.entries()].map(([name, count]) => ({ name, count })),
  };
}
