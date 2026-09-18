import {
  categoryColor,
  classificationLabel,
  compassPoint,
  knotsToMph,
  riskColor,
  saffirSimpson,
} from './policy.js';

const text = (value, max = 200) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Read a coordinate that the bulletin supplies twice — once as a number and
 * once as a hemisphere string ("58.4W"). Prefer the number, fall back to
 * parsing the string, and reject anything that is neither. An empty cell must
 * not become 0: `Number('')` is a finite zero that would plant an Atlantic
 * hurricane in the Gulf of Guinea.
 */
function coordinate(numeric, labelled, negativeHemispheres) {
  if (typeof numeric === 'number' && Number.isFinite(numeric)) return numeric;
  const raw = String(labelled ?? '').trim();
  if (!raw) return Number.NaN;
  const match = /^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/i.exec(raw);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return Number.NaN;
  const hemisphere = (match[2] || '').toUpperCase();
  return negativeHemispheres.includes(hemisphere) ? -Math.abs(value) : value;
}

/** A storm's headline: "Hurricane Gert — Category 2". */
function headline(classification, name, knots) {
  const category = saffirSimpson(knots);
  const label = classificationLabel(classification);
  const base = name ? `${label} ${name}` : label;
  return category ? `${base} — Category ${category}` : base;
}

/**
 * Parse the NHC active-storm bulletin.
 *
 * An empty `activeStorms` is the ordinary answer for most of the year and is
 * not an error — callers distinguish "no storms" from "fetch failed", because
 * presenting a quiet ocean as a broken feed would be worse than either.
 *
 * @param {any} payload Parsed CurrentStorms.json.
 * @returns {object[]}
 */
export function parseActiveStorms(payload) {
  const storms = Array.isArray(payload?.activeStorms)
    ? payload.activeStorms
    : [];
  const out = [];
  for (const storm of storms) {
    const lat = coordinate(storm?.latitudeNumeric, storm?.latitude, ['S']);
    const lon = coordinate(storm?.longitudeNumeric, storm?.longitude, ['W']);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    const knots = Number(storm?.intensity);
    const pressure = Number(storm?.pressure);
    const moveDir = Number(storm?.movementDir);
    const moveSpeed = Number(storm?.movementSpeed);
    const id = text(storm?.id, 32) || text(storm?.binNumber, 16);
    if (!id) continue;
    out.push({
      id,
      bin: text(storm?.binNumber, 16),
      name: text(storm?.name, 48),
      classification: text(storm?.classification, 8).toUpperCase(),
      classificationLabel: classificationLabel(storm?.classification),
      category: saffirSimpson(knots),
      headline: headline(storm?.classification, text(storm?.name, 48), knots),
      knots: Number.isFinite(knots) ? knots : null,
      mph: Number.isFinite(knots) ? knotsToMph(knots) : null,
      pressureMb: Number.isFinite(pressure) ? pressure : null,
      movementDir: Number.isFinite(moveDir) ? moveDir : null,
      movementCompass: compassPoint(moveDir),
      movementKnots: Number.isFinite(moveSpeed) ? moveSpeed : null,
      lastUpdate: text(storm?.lastUpdate, 40),
      color: categoryColor(knots),
      // Advisory links are the authority; the map is a summary of them.
      publicAdvisoryUrl: text(storm?.publicAdvisory?.url, 300),
      forecastDiscussionUrl: text(storm?.forecastDiscussion?.url, 300),
      advisoryNumber: text(storm?.publicAdvisory?.advNum, 12),
      lat,
      lon,
    });
  }
  // Strongest first, so the most significant storm draws on top.
  out.sort((a, b) => (b.knots ?? -1) - (a.knots ?? -1));
  return out;
}

/** Percentage from NHC's "60%" strings, or null when absent. */
function percent(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = /(\d{1,3})/.exec(raw);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * Parse the Tropical Weather Outlook disturbance points.
 *
 * These are areas NHC is watching that have not become cyclones. They carry
 * two horizons — two-day and seven-day — and the seven-day figure is usually
 * the larger one, so reporting a single number would consistently understate
 * what the forecaster is saying.
 *
 * @param {any} geojson A GeoJSON FeatureCollection.
 * @returns {object[]}
 */
export function parseDisturbances(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'Point') continue;
    const [lon, lat] = geometry.coordinates || [];
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    const p = feature.properties || {};
    const risk7 = text(p.risk7day, 16);
    out.push({
      id: `disturbance:${p.objectid ?? `${lat},${lon}`}`,
      basin: text(p.basin, 24),
      prob2day: percent(p.prob2day),
      prob7day: percent(p.prob7day),
      risk2day: text(p.risk2day, 16),
      risk7day: risk7,
      color: riskColor(risk7),
      lat,
      lon,
    });
  }
  out.sort((a, b) => (b.prob7day ?? -1) - (a.prob7day ?? -1));
  return out;
}

/**
 * Parse the potential-development-region polygons that accompany the points.
 * Rings are kept as flat [lon, lat, lon, lat, …] for direct Cesium use.
 * @param {any} geojson
 * @returns {object[]}
 */
export function parseDevelopmentRegions(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    const p = feature.properties || {};
    const risk7 = text(p.risk7day, 16);
    polygons.forEach((rings, index) => {
      const outer = Array.isArray(rings?.[0]) ? rings[0] : null;
      if (!outer || outer.length < 3) return;
      const flat = [];
      for (const point of outer) {
        const [lon, lat] = point || [];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        flat.push(lon, lat);
      }
      out.push({
        id: `devregion:${p.objectid ?? 'x'}:${index}`,
        basin: text(p.basin, 24),
        prob2day: percent(p.prob2day),
        prob7day: percent(p.prob7day),
        risk7day: risk7,
        color: riskColor(risk7),
        positions: flat,
      });
    });
  }
  return out;
}

/**
 * Flatten a GeoJSON line layer (forecast or past track) into coordinate pairs.
 * @param {any} geojson
 * @returns {number[][]} One flat [lon, lat, …] array per line.
 */
export function parseTrackLines(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const lines = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    const parts =
      geometry?.type === 'LineString'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const part of parts) {
      const flat = [];
      for (const point of part || []) {
        const [lon, lat] = point || [];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        flat.push(lon, lat);
      }
      if (flat.length >= 4) lines.push(flat);
    }
  }
  return lines;
}

/** Counts for the panel, so it can say what it is showing. */
export function summarize({ storms = [], disturbances = [] } = {}) {
  const hurricanes = storms.filter((s) => s.category >= 1).length;
  const major = storms.filter((s) => s.category >= 3).length;
  return {
    storms: storms.length,
    hurricanes,
    major,
    disturbances: disturbances.length,
    strongest: storms.length ? storms[0].headline : null,
  };
}
