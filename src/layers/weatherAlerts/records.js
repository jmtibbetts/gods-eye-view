import { SEVERITY_RANK } from './policy.js';

const text = (value, max = 400) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A ring is an array of [lon, lat] pairs; validate and coerce to numbers. */
function ring(coords) {
  if (!Array.isArray(coords)) return null;
  const out = [];
  for (const pair of coords) {
    const lon = Number(pair?.[0]);
    const lat = Number(pair?.[1]);
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    out.push([lon, lat]);
  }
  return out.length >= 3 ? out : null;
}

/** Outer rings only (holes dropped) from Polygon / MultiPolygon geometry. */
function ringsFromGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    const r = ring(geometry.coordinates?.[0]);
    return r ? [r] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    const out = [];
    for (const poly of geometry.coordinates || []) {
      const r = ring(poly?.[0]);
      if (r) out.push(r);
    }
    return out;
  }
  return [];
}

/** Rough centroid of the first ring, for camera fly-to and labels. */
function ringCentroid(rings) {
  const r = rings[0];
  if (!r) return null;
  let lon = 0;
  let lat = 0;
  for (const [x, y] of r) {
    lon += x;
    lat += y;
  }
  return { lon: lon / r.length, lat: lat / r.length };
}

/**
 * Normalise the active-alerts FeatureCollection into drawable records. Only
 * features with polygon geometry survive; the rest are counted by the caller.
 * @param {any} payload Parsed GeoJSON from api.weather.gov/alerts/active.
 * @returns {{alerts: object[], total: number}|null}
 */
export function normalizeWeatherAlerts(payload) {
  const features = payload?.features;
  if (!Array.isArray(features)) return null;
  const alerts = [];
  const seen = new Set();
  for (const feature of features) {
    const rings = ringsFromGeometry(feature?.geometry);
    if (!rings.length) continue;
    const p = feature.properties || {};
    const id = text(feature.id || p.id, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const centroid = ringCentroid(rings);
    if (!centroid) continue;
    alerts.push({
      id,
      event: text(p.event, 80) || 'Alert',
      severity: text(p.severity, 20) || 'Unknown',
      urgency: text(p.urgency, 20),
      certainty: text(p.certainty, 20),
      headline: text(p.headline, 200),
      area: text(p.areaDesc, 200),
      description: text(p.description, 1200),
      instruction: text(p.instruction, 600),
      sender: text(p.senderName, 80),
      expires: text(p.expires || p.ends, 40),
      rings,
      lat: centroid.lat,
      lon: centroid.lon,
    });
  }
  // Worst last, so higher-severity polygons are added on top.
  alerts.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] || 0) - (SEVERITY_RANK[b.severity] || 0),
  );
  return { alerts, total: features.length };
}
