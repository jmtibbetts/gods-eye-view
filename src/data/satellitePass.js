/**
 * Pass prediction for any satellite with elements — the ISS finder,
 * generalised, plus the question an imaging satellite raises that a plain
 * pass does not: when does its swath actually cover this ground?
 *
 * A pass is "above the horizon from here" — what an observer would see, or a
 * ground station would hear. An imaging pass is "the sub-satellite track
 * comes within half a swath of here", which is when the instrument records
 * this spot; a 3,000 km swath sees ground the satellite never rises very
 * high over. Both scan SGP4 coarsely over the horizon and refine at the
 * edges: a few thousand propagations, tens of milliseconds, fine on demand.
 *
 * Whether the imaging pass is in daylight is answered too, with a plain
 * solar-elevation estimate (good to a degree), because a visible-light band
 * records nothing of a night pass and the panel must not promise a picture
 * that will be black.
 */
import {
  propagate,
  gstime,
  eciToEcf,
  eciToGeodetic,
  ecfToLookAngles,
} from 'satellite.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0088;

/** Observer look angles at an instant, or null when propagation fails. */
export function lookAnglesAt(satrec, dateMs, latDeg, lonDeg) {
  const date = new Date(dateMs);
  const pv = propagate(satrec, date);
  const pos = pv && pv.position;
  if (!pos || typeof pos === 'boolean') return null;
  const ecf = eciToEcf(pos, gstime(date));
  const look = ecfToLookAngles(
    { latitude: latDeg * D2R, longitude: lonDeg * D2R, height: 0 },
    ecf,
  );
  return {
    elevDeg: look.elevation * R2D,
    azDeg: (((look.azimuth * R2D) % 360) + 360) % 360,
  };
}

/** Sub-satellite point at an instant, degrees, or null. */
export function subpointAt(satrec, dateMs) {
  const date = new Date(dateMs);
  const pv = propagate(satrec, date);
  const pos = pv && pv.position;
  if (!pos || typeof pos === 'boolean') return null;
  const geo = eciToGeodetic(pos, gstime(date));
  let lon = geo.longitude * R2D;
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return { latDeg: geo.latitude * R2D, lonDeg: lon, altKm: geo.height };
}

/** Great-circle distance in km. */
export function groundDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/**
 * Solar elevation at a point, degrees — the low-precision NOAA algorithm,
 * good to about a degree, which is all "is it daylight" needs.
 */
export function solarElevationDeg(dateMs, latDeg, lonDeg) {
  const d = new Date(dateMs);
  const dayOfYear =
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
      Date.UTC(d.getUTCFullYear(), 0, 0)) /
    86_400_000;
  const hours =
    d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hours - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const trueSolarMin = (hours * 60 + eqTime + 4 * lonDeg) % 1440;
  let hourAngle = trueSolarMin / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;
  const lat = latDeg * D2R;
  const cosZenith =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle * D2R);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) * R2D;
}

/**
 * The next pass above `minElevDeg` from an observer, within the horizon.
 * @returns {{riseMs:number,setMs:number,maxElevDeg:number,maxElevMs:number,riseAzDeg:number}|null}
 */
export function findNextPass({
  satrec,
  latDeg,
  lonDeg,
  fromMs,
  minElevDeg = 10,
  horizonHours = 24,
  coarseStepSec = 30,
  fineStepSec = 5,
}) {
  const elev = (t) => lookAnglesAt(satrec, t, latDeg, lonDeg)?.elevDeg ?? -90;
  const horizonMs = fromMs + horizonHours * 3600_000;
  const coarse = coarseStepSec * 1000;
  const fine = fineStepSec * 1000;

  // Coarse scan for the first sample above threshold. Starting inside a
  // pass still counts as "the next pass".
  let hit = null;
  for (let t = fromMs; t <= horizonMs; t += coarse) {
    if (elev(t) >= minElevDeg) {
      hit = t;
      break;
    }
  }
  if (hit == null) return null;

  let riseMs = hit;
  while (riseMs - fine > fromMs && elev(riseMs - fine) >= minElevDeg)
    riseMs -= fine;

  let maxElevDeg = -90;
  let maxElevMs = riseMs;
  let t = riseMs;
  while (t <= horizonMs) {
    const e = elev(t);
    if (e < minElevDeg && t > riseMs) break;
    if (e > maxElevDeg) {
      maxElevDeg = e;
      maxElevMs = t;
    }
    t += fine;
  }
  const setMs = t;
  const rise = lookAnglesAt(satrec, riseMs, latDeg, lonDeg);
  return {
    riseMs,
    setMs,
    maxElevDeg,
    maxElevMs,
    riseAzDeg: rise ? rise.azDeg : 0,
  };
}

/** The ISS finder by its old name, for the voice action and its tests. */
export const findNextIssPass = findNextPass;

/**
 * The next time an imager's swath covers the observer: the sub-satellite
 * track's closest approach inside half a swath. Reports how far off-track
 * the ground lies (nadir is the sharpest pixel; the edge is the coarsest)
 * and whether the sun is up there — a visible band images nothing at night.
 * @param {object} options
 * @param {object} options.satrec
 * @param {number} options.latDeg
 * @param {number} options.lonDeg
 * @param {number} options.fromMs
 * @param {number} options.swathKm Cross-track coverage.
 * @param {number} [options.horizonHours]
 * @returns {{atMs:number,offTrackKm:number,daylight:boolean,sunElevDeg:number}|null}
 */
export function findNextImagingPass({
  satrec,
  latDeg,
  lonDeg,
  fromMs,
  swathKm,
  horizonHours = 24,
  coarseStepSec = 60,
  fineStepSec = 5,
}) {
  if (!Number.isFinite(swathKm) || swathKm <= 0) return null;
  const half = swathKm / 2;
  const distance = (t) => {
    const p = subpointAt(satrec, t);
    return p ? groundDistanceKm(latDeg, lonDeg, p.latDeg, p.lonDeg) : Infinity;
  };
  const horizonMs = fromMs + horizonHours * 3600_000;
  const coarse = coarseStepSec * 1000;
  const fine = fineStepSec * 1000;
  let hit = null;
  for (let t = fromMs; t <= horizonMs; t += coarse) {
    if (distance(t) <= half) {
      hit = t;
      break;
    }
  }
  if (hit == null) return null;
  // Walk to the closest approach inside this covering window.
  let t = hit;
  while (t - fine >= fromMs && distance(t - fine) <= half) t -= fine;
  let best = t;
  let bestKm = distance(t);
  for (let u = t; u <= horizonMs; u += fine) {
    const km = distance(u);
    if (km > half && u > t) break;
    if (km < bestKm) {
      bestKm = km;
      best = u;
    }
  }
  const sunElevDeg = solarElevationDeg(best, latDeg, lonDeg);
  return {
    atMs: best,
    offTrackKm: Math.round(bestKm),
    daylight: sunElevDeg > 0,
    sunElevDeg: Math.round(sunElevDeg * 10) / 10,
  };
}
