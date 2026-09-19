/**
 * Aviation hazard proxy — SIGMETs from aviationweather.gov.
 *
 * aviationweather.gov sends no `access-control-allow-origin`, so a browser
 * cannot read it: the same shape as the NHC bulletin and SatNOGS.
 *
 * TWO FEEDS, ONE RECORD. The international feed carries six hazard classes
 * across seventy flight information regions but covers the United States only
 * in its OCEANIC regions — Oakland, Miami and New York Oceanic — so on its own
 * it leaves a hole over the continental US. The domestic feed fills that hole,
 * and publishes a different schema to do it: `altitudeLow1`/`altitudeHi1`
 * rather than `base`/`top`, `movementDir`/`movementSpd` rather than
 * `dir`/`spd`, `rawAirSigmet` rather than `rawSigmet`. Both are normalized
 * here so the layer sees one kind of record, and each keeps an `origin` so a
 * reader can tell which authority issued it.
 *
 * Routes:
 *   GET /api/aviation/sigmets → one normalized list from both feeds
 */

import { cachedJsonEndpoint } from './cachedEndpoint.js';

const INTERNATIONAL_URL =
  'https://aviationweather.gov/api/data/isigmet?format=json';
const DOMESTIC_URL =
  'https://aviationweather.gov/api/data/airsigmet?format=json';

/** SIGMETs are issued on the hour or as conditions change; 5 minutes is ample. */
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 25_000;

const number = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean')
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** [{lon,lat}, …] → a flat [lon, lat, …], or null if any vertex is unusable. */
function flattenRing(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const flat = [];
  for (const point of coords) {
    const lon = number(point?.lon);
    const lat = number(point?.lat);
    if (lat === null || Math.abs(lat) > 90) return null;
    if (lon === null || Math.abs(lon) > 180) return null;
    flat.push(lon, lat);
  }
  return flat.length >= 6 ? flat : null;
}

/**
 * An advisory's polygon parts, always as a list of flat rings.
 *
 * The feed publishes TWO geometry shapes under one field name. `geom: 'AREA'`
 * gives `coords` as a flat list of points; `geom: 'AREAS'` gives a list of
 * point LISTS, one per discrete area. Treating the second as the first rejects
 * it outright — which silently dropped a three-part embedded-thunderstorm
 * SIGMET over Brazzaville, a warning covering three separate pieces of sky.
 *
 * Sniffing the structure rather than trusting `geom` keeps this working if the
 * flag and the payload ever disagree.
 */
export function polygonParts(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  const nested = Array.isArray(coords[0]);
  const rings = nested ? coords : [coords];
  const parts = [];
  for (const ring of rings) {
    const flat = flattenRing(ring);
    if (flat) parts.push(flat);
  }
  return parts;
}

/**
 * The identity of one advisory AREA, which is not the identity of the SIGMET.
 *
 * A single series — FAOR B01, say — is issued across several flight information
 * regions as separate polygons, and one region can carry several discrete areas
 * of the same series. Keying on issuing office, series and validity alone
 * collides for every one of those: at one sampling it merged ten distinct
 * hazard areas into nine keys, and a layer de-duplicating by id would have
 * dropped real warnings over Johannesburg because Cape Town sorted first.
 *
 * So the region is part of the key, and `seq` disambiguates whatever remains.
 */
function base(row, origin, seq) {
  const region = row.firId || row.firName || row.icaoId || '?';
  const series = row.seriesId || row.alphaChar || '?';
  return {
    origin,
    id: `${origin}:${row.icaoId || '?'}:${series}:${row.validTimeFrom || 0}:${region}:${seq}`,
    hazard: String(row.hazard || '').toUpperCase(),
    from: number(row.validTimeFrom),
    to: number(row.validTimeTo),
    parts: polygonParts(row.coords),
  };
}

/**
 * Per-key occurrence counter, so two polygons that agree on every identifying
 * field still get distinct ids rather than one silently replacing the other.
 */
export function sequencer() {
  const seen = new Map();
  return (key) => {
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n;
  };
}

export function trimInternational(row, seq) {
  return {
    ...base(row, 'international', seq),
    region: row.firName || row.firId || '',
    // For a volcanic-ash SIGMET this field holds the VOLCANO NAME (MAYON,
    // SEMERU, FUEGO); for everything else it holds an intensity qualifier
    // (SEV, EMBD, FRQ, OCNL). The layer reads it accordingly.
    qualifier: row.qualifier || '',
    low: number(row.base),
    high: number(row.top),
    dir: number(row.dir),
    speed: number(row.spd),
    trend: row.chng || '',
    raw: row.rawSigmet || '',
  };
}

export function trimDomestic(row, seq) {
  return {
    ...base(row, 'domestic', seq),
    region: row.icaoId || '',
    qualifier: row.severity || '',
    low: number(row.altitudeLow1),
    high: number(row.altitudeHi1),
    dir: number(row.movementDir),
    speed: number(row.movementSpd),
    trend: '',
    kind: row.airSigmetType || '',
    raw: row.rawAirSigmet || '',
  };
}

/** Fetch both feeds, keeping whichever succeeds. */
async function loadBoth() {
  const get = async (url, trim, label) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'gods-eye-view/aviation' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload))
        throw new Error('upstream did not return a list');
      const next = sequencer();
      return payload.map((row) => {
        const key = `${row.icaoId || '?'}:${row.seriesId || row.alphaChar || '?'}:${row.validTimeFrom || 0}:${row.firId || row.firName || row.icaoId || '?'}`;
        return trim(row, next(key));
      });
    } catch (error) {
      console.warn(`[Aviation] ${label} fetch failed: ${error?.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const [international, domestic] = await Promise.all([
    get(INTERNATIONAL_URL, trimInternational, 'international'),
    get(DOMESTIC_URL, trimDomestic, 'domestic'),
  ]);
  // One feed failing must not discard the other: losing the international
  // feed should not also blank the continental US, and vice versa. Only both
  // failing is a failure, which throwing here reports as one.
  if (!international && !domestic) throw new Error('both SIGMET feeds failed');
  return [...(international || []), ...(domestic || [])];
}

export function aviationProxy() {
  const sigmets = cachedJsonEndpoint({
    load: loadBoth,
    ttlMs: TTL_MS,
    label: 'Aviation SIGMETs',
  });

  function installMiddleware(server) {
    server.middlewares.use('/api/aviation/sigmets', sigmets);
  }

  return {
    name: 'gev-aviation-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
