/**
 * NWS weather-alerts layer — active US watches/warnings from the National
 * Weather Service, drawn as severity-coloured polygons on the globe.
 *
 * Only storm-based alerts that ship inline polygon geometry are drawn
 * (tornado, severe thunderstorm, flash flood, and similar warnings) — these
 * are the actionable, specific ones. Zone-based advisories carry no geometry
 * in the feed and are counted but not outlined.
 */

export const WEATHER_ALERTS_LAYER_ID = 'weather-alerts';
export const WEATHER_ALERTS_ENTITY_PREFIX = 'wxalert:';

/** api.weather.gov active alerts; keyless, GeoJSON. A default UA is fine from a browser. */
export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
export const WEATHER_ALERTS_FETCH_TIMEOUT_MS = 15_000;

/** Fill/outline colour by NWS severity. */
export const SEVERITY_COLORS = Object.freeze({
  Extreme: '#ff2d55',
  Severe: '#ff9500',
  Moderate: '#ffd60a',
  Minor: '#34c759',
  Unknown: '#8e8e93',
});

/** Higher = more urgent; used to paint the worst alert on top. */
export const SEVERITY_RANK = Object.freeze({
  Extreme: 4,
  Severe: 3,
  Moderate: 2,
  Minor: 1,
  Unknown: 0,
});

export function severityColor(severity) {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.Unknown;
}
