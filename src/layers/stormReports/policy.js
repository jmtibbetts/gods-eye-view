/**
 * NOAA SPC storm reports — preliminary local storm reports (tornado, hail,
 * damaging wind) filed by NWS offices, plotted as points on the globe.
 *
 * The Storm Prediction Center publishes a rolling CSV per day. Each file holds
 * three sections, one per report kind, each introduced by its own header row;
 * the second column name is what identifies the section (F_Scale → tornado,
 * Size → hail, Speed → wind). Reports are preliminary and get revised or
 * removed during later review, which the panel says plainly.
 *
 * Today alone is often nearly empty outside severe season, so the layer reads
 * today and yesterday and presents a rolling ~48h window.
 */

export const STORM_REPORTS_LAYER_ID = 'storm-reports';
export const STORM_REPORTS_ENTITY_PREFIX = 'stormreport:';

/** SPC climo reports; keyless CSV, and it serves `access-control-allow-origin: *`. */
export const SPC_REPORTS_BASE = 'https://www.spc.noaa.gov/climo/reports';
export const SPC_REPORT_DAYS = Object.freeze(['today', 'yesterday']);
export const STORM_REPORTS_FETCH_TIMEOUT_MS = 15_000;

/** Report kinds, keyed by the section header's second column. */
export const REPORT_KINDS = Object.freeze({
  F_Scale: 'tornado',
  Size: 'hail',
  Speed: 'wind',
});

/** SPC's conventional plot colours. */
export const KIND_COLORS = Object.freeze({
  tornado: '#ff2d55',
  wind: '#0a84ff',
  hail: '#34c759',
});

/** Drawn largest-first so tornadoes sit above the denser wind/hail fields. */
export const KIND_RANK = Object.freeze({ tornado: 3, hail: 2, wind: 1 });

export const KIND_LABELS = Object.freeze({
  tornado: 'Tornado',
  wind: 'Wind',
  hail: 'Hail',
});

export function kindColor(kind) {
  return KIND_COLORS[kind] || '#8e8e93';
}

/**
 * Human magnitude for a report. Hail arrives in hundredths of an inch, wind in
 * knots; both use UNK when the spotter gave no measurement.
 * @param {string} kind
 * @param {string} magnitude Raw second-column value.
 * @returns {string}
 */
export function magnitudeText(kind, magnitude) {
  const raw = String(magnitude ?? '').trim();
  if (!raw || raw.toUpperCase() === 'UNK') {
    return kind === 'tornado' ? 'EF-scale pending' : 'unmeasured';
  }
  const value = Number(raw);
  if (kind === 'hail' && Number.isFinite(value))
    return `${(value / 100).toFixed(2)}″ hail`;
  if (kind === 'wind' && Number.isFinite(value))
    return `${Math.round(value)} kt (${Math.round(value * 1.15078)} mph)`;
  return raw;
}
