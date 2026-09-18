/**
 * Air quality — EPA AirNow's latest AQI contours.
 *
 * This is the layer that makes the fire layers mean something. FIRMS shows
 * where things are burning; this shows where the smoke went, which is what
 * actually reaches people. The two are routinely hundreds of miles apart.
 *
 * COLOURS AND CATEGORIES COME FROM THE SERVICE, not from here. AirNow's own
 * renderer defines the six-band scale and its colours, and those bands are a
 * public health convention people are taught to read — an orange sky warning
 * means something specific. Inventing a palette, or renumbering the bands,
 * would be a health-relevant distortion rather than a styling choice.
 *
 * COVERAGE IS THE UNITED STATES, with some cross-border reporting. Absence of
 * a contour over another continent means AirNow does not measure there, not
 * that the air is clean, and the layer says so.
 */

export const AIR_QUALITY_LAYER_ID = 'air-quality';
export const AIR_QUALITY_ENTITY_PREFIX = 'aqi:';

/** EPA's public AirNow contour service. Keyless, CORS-open. */
export const AIRNOW_LAYER_URL =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/AirNowLatestContoursCombined/FeatureServer/0';

/** AirNow publishes hourly; polling faster would only add load. */
export const AIR_QUALITY_UPDATE_MS = 15 * 60 * 1000;
export const AIR_QUALITY_FETCH_TIMEOUT_MS = 20_000;

/**
 * The six AQI bands, as EPA defines them.
 *
 * `range` is the AQI index range the band covers, and `guidance` is the
 * standard public-health wording for it. It is deliberately the published
 * advice rather than anything of ours: this is the one layer where a
 * paraphrase could change what someone does about their own health.
 */
export const AQI_BANDS = Object.freeze({
  1: Object.freeze({
    code: 1,
    name: 'Good',
    range: '0–50',
    color: '#00e400',
    guidance: 'Air quality is satisfactory and poses little or no risk.',
  }),
  2: Object.freeze({
    code: 2,
    name: 'Moderate',
    range: '51–100',
    color: '#ffff00',
    guidance:
      'Acceptable for most. Unusually sensitive people may want to limit prolonged outdoor exertion.',
  }),
  3: Object.freeze({
    code: 3,
    name: 'Unhealthy for Sensitive Groups',
    range: '101–150',
    color: '#ff7e00',
    guidance:
      'People with heart or lung disease, older adults, children and teens should reduce prolonged outdoor exertion.',
  }),
  4: Object.freeze({
    code: 4,
    name: 'Unhealthy',
    range: '151–200',
    color: '#ff0000',
    guidance:
      'Sensitive groups should avoid prolonged outdoor exertion; everyone else should reduce it.',
  }),
  5: Object.freeze({
    code: 5,
    name: 'Very Unhealthy',
    range: '201–300',
    color: '#99004c',
    guidance:
      'Health alert: the risk of health effects is increased for everyone. Sensitive groups should avoid outdoor exertion.',
  }),
  6: Object.freeze({
    code: 6,
    name: 'Hazardous',
    range: '301+',
    color: '#4c0026',
    guidance:
      'Health warning of emergency conditions: everyone is more likely to be affected. Avoid outdoor exertion.',
  }),
});

/** A band by gridcode, or null when the service sends something unexpected. */
export function bandFor(gridcode) {
  const code = Number(gridcode);
  return AQI_BANDS[code] || null;
}

/**
 * Drawing rank. Worse air draws on top, so a hazardous pocket is never hidden
 * beneath the large "good" contour that surrounds it.
 */
export function bandRank(gridcode) {
  const band = bandFor(gridcode);
  return band ? band.code : 0;
}

/** The GeoJSON query for the whole current contour set. */
export function airNowQueryUrl() {
  return `${AIRNOW_LAYER_URL}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`;
}
