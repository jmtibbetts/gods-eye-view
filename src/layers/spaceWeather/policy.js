/**
 * Space weather — NOAA SWPC's aurora oval, the planetary K index, the R/S/G
 * scales and the alerts they issue.
 *
 * All four feeds are keyless, CORS-open JSON from services.swpc.noaa.gov,
 * so the browser reads them directly. What they are is stated precisely:
 * the OVATION oval is a FORECAST of aurora probability about half an hour
 * ahead, not an observation of light in the sky; Kp is a three-hourly index
 * that lags; the scales are SWPC's own now-cast plus three days of outlook.
 * The layer names the observation and forecast times rather than letting a
 * forecast read as tonight's sky.
 */

export const SPACE_WEATHER_LAYER_ID = 'space-weather';

export const SWPC_ORIGIN = 'https://services.swpc.noaa.gov';
export const AURORA_URL = `${SWPC_ORIGIN}/json/ovation_aurora_latest.json`;
export const KP_URL = `${SWPC_ORIGIN}/products/noaa-planetary-k-index.json`;
export const SCALES_URL = `${SWPC_ORIGIN}/products/noaa-scales.json`;
export const ALERTS_URL = `${SWPC_ORIGIN}/products/alerts.json`;

/** OVATION lands about every five minutes; the scales hourly. */
export const SPACE_WEATHER_UPDATE_MS = 5 * 60 * 1000;
export const SPACE_WEATHER_FETCH_TIMEOUT_MS = 30_000;

/** A cell below this probability is not drawn at all. */
export const AURORA_MIN_PROBABILITY = 5;

/** Alerts older than this are history, not conditions. */
export const ALERT_MAX_AGE_MS = 24 * 3600_000;

/**
 * The oval's colour ramp by probability: the green of a quiet arc, up
 * through the yellow of an active one to the red of a storm, at an alpha
 * that lets the ground read underneath.
 */
export const AURORA_RAMP = Object.freeze([
  Object.freeze({ min: 5, color: '#2bd66b', alpha: 0.16 }),
  Object.freeze({ min: 20, color: '#8be07a', alpha: 0.28 }),
  Object.freeze({ min: 40, color: '#e8e04a', alpha: 0.4 }),
  Object.freeze({ min: 60, color: '#ff9f43', alpha: 0.5 }),
  Object.freeze({ min: 80, color: '#ff4d4d', alpha: 0.6 }),
]);

/** What the G scale means, in the words SWPC uses. */
export const G_SCALE_TEXT = Object.freeze({
  0: 'none',
  1: 'minor',
  2: 'moderate',
  3: 'strong',
  4: 'severe',
  5: 'extreme',
});

/** Kp bands, for the legend. */
export function kpText(kp) {
  if (!Number.isFinite(kp)) return 'Kp unavailable';
  if (kp < 4) return `Kp ${kp.toFixed(1)} · quiet`;
  if (kp < 5) return `Kp ${kp.toFixed(1)} · active`;
  if (kp < 6) return `Kp ${kp.toFixed(1)} · G1 storm`;
  if (kp < 7) return `Kp ${kp.toFixed(1)} · G2 storm`;
  if (kp < 8) return `Kp ${kp.toFixed(1)} · G3 storm`;
  if (kp < 9) return `Kp ${kp.toFixed(1)} · G4 storm`;
  return `Kp ${kp.toFixed(1)} · G5 storm`;
}

/** The ramp step a probability falls in, or null below the floor. */
export function auroraBand(probability) {
  let band = null;
  for (const step of AURORA_RAMP) if (probability >= step.min) band = step;
  return band;
}
