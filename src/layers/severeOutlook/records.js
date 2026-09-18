import { FALLBACK_FILL, categoryName, featureRank } from './policy.js';

const text = (value, max = 120) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Accept SPC's own colour, or fall back rather than draw nothing. */
function color(value) {
  const raw = text(value, 24);
  return /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : FALLBACK_FILL;
}

/**
 * Flatten one GeoJSON ring to [lon, lat, …], rejecting the whole ring if any
 * vertex is unusable — a risk polygon drawn with a missing corner would put
 * the boundary somewhere SPC did not.
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
 * Parse an SPC outlook GeoJSON into drawable risk areas.
 *
 * Holes matter here and are kept. A categorical outlook is drawn as nested
 * bands, and the higher category is punched out of the lower one — filling
 * that hole would paint "slight risk" over the enhanced area inside it, which
 * inverts the reading of the map at exactly the place it matters most.
 *
 * @param {any} geojson
 * @param {object} product The catalog entry this came from.
 * @returns {object[]} Lowest risk first, so higher risk draws on top.
 */
export function parseOutlook(geojson, product) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    const polygons =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    const p = feature?.properties || {};
    const label = text(p.LABEL, 24);
    const rank = featureRank({ label, dn: p.DN });
    polygons.forEach((rings, index) => {
      const outer = flatRing(rings?.[0]);
      if (!outer) return;
      const holes = [];
      for (let i = 1; i < (rings?.length || 0); i++) {
        const hole = flatRing(rings[i]);
        if (hole) holes.push(hole);
      }
      out.push({
        id: `${product.key}:${p.DN ?? 'x'}:${index}:${out.length}`,
        product: product.key,
        productLabel: product.label,
        kind: product.kind,
        label,
        // "Slight" reads to anyone; "SLGT" reads to forecasters.
        name: product.kind === 'categorical' ? categoryName(label) : label,
        detail: text(p.LABEL2, 120),
        rank,
        fill: color(p.fill),
        stroke: color(p.stroke),
        valid: text(p.VALID_ISO || p.VALID, 32),
        expire: text(p.EXPIRE_ISO || p.EXPIRE, 32),
        issued: text(p.ISSUE_ISO || p.ISSUE, 32),
        forecaster: text(p.FORECASTER, 40),
        positions: outer,
        holes,
      });
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}

/**
 * SPC's own words when it has drawn nothing.
 *
 * An empty product is not always an absent one. When the tornado risk is below
 * threshold everywhere, SPC publishes a feature with an empty geometry and the
 * label "Less Than 2% All Areas" — an active assessment, not a missing file.
 * Reporting that as "no data" would throw away the actual forecast, and the
 * two mean different things to anyone deciding whether to worry.
 *
 * @param {any} geojson
 * @returns {string|null}
 */
export function outlookStatement(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    const empty =
      !geometry ||
      (geometry.type === 'GeometryCollection' &&
        (geometry.geometries || []).length === 0) ||
      (Array.isArray(geometry.coordinates) &&
        geometry.coordinates.length === 0);
    if (!empty) continue;
    const label = String(feature?.properties?.LABEL ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (label) return label.slice(0, 80);
  }
  return null;
}

/** What the panel says about the current product. */
export function summarizeOutlook(areas, product, statement = null) {
  const byName = new Map();
  for (const area of areas) {
    byName.set(area.name, (byName.get(area.name) || 0) + 1);
  }
  const highest = areas.length ? areas[areas.length - 1] : null;
  return {
    product: product.key,
    productLabel: product.label,
    areas: areas.length,
    highest: highest ? highest.name : null,
    statement,
    breakdown: [...byName.entries()].map(([name, count]) => ({ name, count })),
  };
}
