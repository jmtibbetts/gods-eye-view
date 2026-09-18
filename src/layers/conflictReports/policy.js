/**
 * Conflict reporting — GDELT violent-event counts, shaded by country.
 *
 * READ THE NAME CAREFULLY, because it is doing work. This layer shows where
 * violence is being REPORTED, not where it is happening. A GDELT event is a
 * machine-coded report in news coverage, so the count follows media attention
 * as much as it follows violence: a country with an active English-language
 * press and a quiet week can out-score a country with a closed press and a
 * terrible one. Nothing here is verified, and the readout says so on every
 * country rather than burying it in a tooltip.
 *
 * WHY COUNTRIES AND NOT POINTS. This was the whole reason the layer took the
 * shape it did. GDELT geocodes a large share of its events to a state or
 * country centroid — 36% of violent events in the sample this was built
 * against, with 74 events sharing 39 coordinates. Drawn as points that places a
 * conflict marker in the empty middle of Nevada and stacks eight on a capital.
 * Shading whole countries is the resolution the data actually has, so the layer
 * claims exactly that and no more.
 *
 * WHY NOT ACLED OR UCDP, which are better data. ACLED's licence permits only
 * "transformative" derivative materials and explicitly forbids making the data
 * available through your own dashboard, which is what this would be. UCDP's
 * live API now requires a token and its open download is annual rather than
 * live. GDELT is the only one both openly licensed and current.
 */

export const CONFLICT_REPORTS_LAYER_ID = 'conflict-reports';
export const CONFLICT_REPORTS_ENTITY_PREFIX = 'conflict:';

export const CONFLICT_REPORTS_URL = '/api/conflict/reports';
export const COUNTRIES_URL = new URL(
  '../../data/local_data/natural_earth_countries/countries.json',
  import.meta.url,
).href;

/** GDELT publishes every 15 minutes. */
export const CONFLICT_UPDATE_MS = 10 * 60 * 1000;
export const CONFLICT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Intensity bands by reported-event count in one 15-minute update.
 *
 * Thresholds are counts, not rates: this is not normalised by population or by
 * press volume, and calling a band "severe" would assert a judgement the
 * numbers cannot support. They are named for what they measure — how much is
 * being reported — and the scale is stated on the card.
 */
export const INTENSITY_BANDS = Object.freeze([
  Object.freeze({
    key: 'isolated',
    name: 'Isolated reports',
    min: 1,
    rank: 1,
    color: '#ffd24d',
  }),
  Object.freeze({
    key: 'several',
    name: 'Several reports',
    min: 3,
    rank: 2,
    color: '#ff9900',
  }),
  Object.freeze({
    key: 'many',
    name: 'Many reports',
    min: 10,
    rank: 3,
    color: '#ff4d4d',
  }),
  Object.freeze({
    key: 'heavy',
    name: 'Heavy reporting',
    min: 30,
    rank: 4,
    color: '#cc0033',
  }),
]);

export function intensityFor(events) {
  const n = Number(events);
  if (!Number.isFinite(n) || n < 1) return null;
  let band = INTENSITY_BANDS[0];
  for (const candidate of INTENSITY_BANDS)
    if (n >= candidate.min) band = candidate;
  return band;
}

/**
 * Build a FIPS code -> polygons index from the bundled country pack.
 *
 * A code resolves to a LIST, not a single country, because two of the pack's
 * deliberate overrides share the code of the state that contains them —
 * N. Cyprus with Cyprus, Somaliland with Somalia. Keying one-to-one silently
 * dropped one polygon of each pair, so a code that covers two shapes shades
 * both.
 */
export function indexCountries(pack) {
  const features = Array.isArray(pack?.features) ? pack.features : [];
  const index = new Map();
  for (const feature of features) {
    const codes = Array.isArray(feature?.codes) ? feature.codes : [];
    for (const code of codes) {
      const key = String(code || '')
        .trim()
        .toUpperCase();
      if (!key) continue;
      const list = index.get(key);
      if (list) list.push(feature);
      else index.set(key, [feature]);
    }
  }
  return index;
}
