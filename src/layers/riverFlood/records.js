import {
  feedLatitude,
  feedLongitude,
  feedNumber,
} from '../../data/feedNumbers.js';
import { SCALE_TOLERANCE, statusFor, statusRank } from './policy.js';

const text = (value, max = 120) => {
  const t = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A stage reading, or null. A gauge with no reading is not a gauge at zero. */
const stage = feedNumber;

/**
 * Whether a reading and the gauge's own flood thresholds are on the same scale.
 *
 * A handful of gauges in the network publish a stage in one datum and their
 * thresholds in another: Provo UT reads 779.08 ft against an 8.19/8.76/9.15/9.52
 * ladder, and two North Dakota lake gauges read near 50 ft against 0.1/0.2/0.3.
 * Subtracting across that gap produces a confident, specific, wrong number —
 * "770.32 ft above flood stage" — which is worse than showing nothing, because
 * a reader has no way to tell it apart from a real crest.
 *
 * NOAA's own `status` is unaffected and still drives the map: those gauges stay
 * on screen at the severity the service assigned them. Only the derived
 * difference is withheld.
 *
 * Needs two distinct thresholds to judge a span. A gauge publishing just one
 * (Carters Lake GA has an action stage and nothing else) is taken at face value.
 */
export function scaleMismatch(reading, ladder) {
  if (reading == null) return false;
  const levels = ladder.filter((v) => v != null);
  if (levels.length < 2) return false;
  const top = Math.max(...levels);
  const span = top - Math.min(...levels);
  if (!(span > 0)) return false;
  return reading > top + SCALE_TOLERANCE * span;
}

/**
 * Parse NWPS gauge features.
 *
 * A gauge whose status is not one of the four drawn flood levels is skipped
 * even if the service returns it — the layer's whole value is that everything
 * on screen is at or above action stage, and one stray normal reading would
 * undermine that promise.
 *
 * @param {any} geojson
 * @param {object} horizon
 * @returns {object[]} Least severe first, so worse floods draw on top.
 */
export function parseGauges(geojson, horizon) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  const seen = new Set();
  for (const feature of features) {
    const p = feature?.properties || {};
    const status = statusFor(p.status);
    if (!status) continue;
    const [rawLon, rawLat] = feature?.geometry?.coordinates || [];
    const lat = feedLatitude(rawLat);
    const lon = feedLongitude(rawLon);
    if (lat === null || lon === null) continue;
    // One row per gauge per horizon; the service can repeat a gauge.
    const gaugeId = text(p.gaugelid, 16) || `${lat},${lon}`;
    const key = `${horizon.key}:${gaugeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reading = stage(p[horizon.stageField]);
    const ladder = [p.action, p.flood, p.moderate, p.major].map(stage);
    out.push({
      id: key,
      gaugeId,
      horizon: horizon.key,
      horizonLabel: horizon.label,
      status: status.key,
      statusName: status.name,
      meaning: status.meaning,
      color: status.color,
      rank: status.rank,
      location: text(p.location, 80),
      waterbody: text(p.waterbody, 80),
      state: text(p.state, 8),
      // Named for what it is rather than how it arrived: on a forecast horizon
      // this is a predicted stage, and calling it `observed` would be a lie the
      // popup would then repeat.
      stage: reading,
      floodStage: ladder[1],
      actionStage: ladder[0],
      majorStage: ladder[3],
      // A gauge whose reading and thresholds disagree by orders of magnitude
      // keeps its NOAA status and its place on the map; what it loses is the
      // derived difference, which would otherwise be nonsense stated precisely.
      scaleMismatch: scaleMismatch(reading, ladder),
      units: text(p.units, 8),
      stageTime: text(p[horizon.timeField], 40),
      forecast: horizon.key !== 'observed',
      url: text(p.url, 200),
      lat,
      lon,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}

/** What the panel reports: the worst flood present, and how many. */
export function summarizeGauges(gauges, horizon) {
  const counts = new Map();
  let worst = null;
  for (const gauge of gauges) {
    counts.set(gauge.statusName, (counts.get(gauge.statusName) || 0) + 1);
    if (!worst || gauge.rank > worst.rank) worst = gauge;
  }
  return {
    horizon: horizon.key,
    horizonLabel: horizon.label,
    gauges: gauges.length,
    worst: worst ? worst.statusName : null,
    worstRank: worst ? worst.rank : 0,
    breakdown: [...counts.entries()].map(([name, count]) => ({ name, count })),
  };
}

/**
 * How far above flood stage a gauge stands, when both numbers exist.
 *
 * Returns a signed number: a gauge at action stage is below flood stage, so a
 * negative answer is the normal case for the most common status and must not
 * be clamped away.
 */
export function aboveFloodStage(gauge) {
  if (gauge?.stage == null || gauge?.floodStage == null) return null;
  if (gauge.scaleMismatch) return null;
  return Math.round((gauge.stage - gauge.floodStage) * 100) / 100;
}
