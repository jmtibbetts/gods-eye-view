/**
 * River flood stages — NOAA's National Water Prediction Service gauge network.
 *
 * THE DEFAULT IS THE POINT. There are roughly 12,800 gauges, and drawing them
 * all would be a wall of dots that says nothing: the overwhelming majority are
 * reading normally at any moment. This layer shows only gauges at or above
 * ACTION stage — the level at which a forecast office starts preparing — which
 * today is about forty. That is a map you can read at a glance.
 *
 * AND IT SHOWS THE FORECAST. The observed picture answers "where is it flooding",
 * and the 24/48/72-hour layers answer "where is it going to". Those are
 * different questions and the second is the one you can still act on: today the
 * count runs 44 now, 55 at two days, 60 at three.
 *
 * Statuses and colours are NOAA's own, for the same reason SPC's and EPA's are:
 * "moderate flood" is a defined operational threshold with consequences
 * attached, not a shade someone picked.
 */

export const RIVER_FLOOD_LAYER_ID = 'river-flood';
export const RIVER_FLOOD_ENTITY_PREFIX = 'rivergauge:';

const NWPS_BASE =
  'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer';

/** Gauges report hourly or faster; a quarter hour is ample. */
export const RIVER_FLOOD_UPDATE_MS = 15 * 60 * 1000;
export const RIVER_FLOOD_FETCH_TIMEOUT_MS = 25_000;

/**
 * Horizons. Layer 0 is what gauges actually read; 1, 2 and 3 are the 24, 48
 * and 72-hour forecast stages for the same gauges.
 *
 * The observed layer and the forecast layers do NOT share a schema: the
 * observed layer carries `observed`/`obstime`, the forecast layers carry
 * `forecast`/`fcsttime`, and asking either one for the other's columns makes
 * the service answer with an error inside an HTTP 200. So each horizon names
 * its own stage and time columns, and the query is built from those.
 */
export const FLOOD_HORIZONS = Object.freeze([
  Object.freeze({
    key: 'observed',
    chip: 'NOW',
    label: 'Observed',
    layerId: 0,
    stageField: 'observed',
    timeField: 'obstime',
    blurb: 'What the gauges are reading now.',
  }),
  Object.freeze({
    key: 'f24',
    chip: '+24H',
    label: '24-hour forecast',
    layerId: 1,
    stageField: 'forecast',
    timeField: 'fcsttime',
    blurb: 'Forecast stage a day out.',
  }),
  Object.freeze({
    key: 'f48',
    chip: '+48H',
    label: '48-hour forecast',
    layerId: 2,
    stageField: 'forecast',
    timeField: 'fcsttime',
    blurb: 'Two days out.',
  }),
  Object.freeze({
    key: 'f72',
    chip: '+72H',
    label: '72-hour forecast',
    layerId: 3,
    stageField: 'forecast',
    timeField: 'fcsttime',
    blurb: 'Three days out — the furthest this layer reaches.',
  }),
]);

export const DEFAULT_HORIZON = 'observed';

export function horizonFor(key) {
  return (
    FLOOD_HORIZONS.find((h) => h.key === key) ||
    FLOOD_HORIZONS.find((h) => h.key === DEFAULT_HORIZON)
  );
}

/**
 * Flood statuses worth drawing, with NOAA's own colours and severity order.
 *
 * Everything below `action` is deliberately absent: a gauge reading normally is
 * not news, and twelve thousand green dots would bury the forty that are.
 */
export const FLOOD_STATUSES = Object.freeze({
  action: Object.freeze({
    key: 'action',
    name: 'Action',
    rank: 1,
    color: '#ffff00',
    meaning:
      'Approaching flood stage — the level at which a forecast office begins preparing.',
  }),
  minor: Object.freeze({
    key: 'minor',
    name: 'Minor Flood',
    rank: 2,
    color: '#ff9900',
    meaning: 'Minimal or no property damage, but some public inconvenience.',
  }),
  moderate: Object.freeze({
    key: 'moderate',
    name: 'Moderate Flood',
    rank: 3,
    color: '#ff0000',
    meaning:
      'Some inundation of structures and roads. Some evacuations may be needed.',
  }),
  major: Object.freeze({
    key: 'major',
    name: 'Major Flood',
    rank: 4,
    color: '#cc33ff',
    meaning:
      'Extensive inundation of structures and roads. Significant evacuations likely.',
  }),
});

/** The statuses this layer requests. Order is severity, ascending. */
export const DRAWN_STATUSES = Object.freeze([
  'action',
  'minor',
  'moderate',
  'major',
]);

export function statusFor(status) {
  return (
    FLOOD_STATUSES[
      String(status || '')
        .trim()
        .toLowerCase()
    ] || null
  );
}

export function statusRank(status) {
  return statusFor(status)?.rank ?? 0;
}

/** Columns every horizon carries. The stage and time columns are added per horizon. */
const COMMON_FIELDS = Object.freeze([
  'objectid',
  'gaugelid',
  'status',
  'location',
  'waterbody',
  'state',
  'units',
  'action',
  'flood',
  'moderate',
  'major',
  'url',
]);

/**
 * How far past the top threshold a reading may sit, as a multiple of the
 * ladder's own span, before the reading and the thresholds are treated as
 * being on different scales.
 *
 * This is a deliberately loose tolerance. It exists to catch readings that are
 * off by two orders of magnitude — a gauge reporting 779 ft against an
 * 8.19/8.76/9.15/9.52 ladder, or 50 ft against 0.1/0.2/0.3 — not to second-guess
 * a river that is genuinely running high. A gauge well above its major-flood
 * threshold on a consistent scale is exactly what a serious flood looks like,
 * and must still read as one.
 */
export const SCALE_TOLERANCE = 10;

/**
 * The query for one horizon.
 *
 * The where clause is built with URLSearchParams rather than string
 * concatenation: an IN clause contains quotes, commas and parentheses, and
 * hand-encoding it is how the first version of this silently returned zero
 * gauges while the network was actually in flood.
 */
export function floodQueryUrl(horizon) {
  const fields = [
    ...COMMON_FIELDS,
    horizon.stageField,
    horizon.timeField,
  ].filter(Boolean);
  const params = new URLSearchParams({
    where: `status IN (${DRAWN_STATUSES.map((s) => `'${s}'`).join(',')})`,
    outFields: [...new Set(fields)].join(','),
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });
  return `${NWPS_BASE}/${horizon.layerId}/query?${params.toString()}`;
}
