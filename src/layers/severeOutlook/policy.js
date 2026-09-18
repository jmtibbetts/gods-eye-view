/**
 * SPC convective outlooks — where the Storm Prediction Center expects severe
 * weather, up to three days out.
 *
 * This is the forecast side of severe weather, and the globe already carries
 * the other two: NWS warnings for what is happening now, and SPC storm reports
 * for what already did. Outlooks are what people actually plan around.
 *
 * SPC PUBLISHES ITS OWN COLOURS, and this uses them rather than inventing a
 * palette. The categorical scale is a recognised public convention — a
 * forecaster, a pilot and an emergency manager all read "moderate risk" by its
 * colour — so recolouring it would be a small act of misinformation even if
 * the labels stayed right.
 *
 * COVERAGE IS THE CONTINENTAL US ONLY. SPC does not forecast elsewhere, so an
 * empty outlook over Europe means "not covered", not "no risk". The layer says
 * so rather than letting a blank map imply safety.
 */

export const SEVERE_OUTLOOK_LAYER_ID = 'severe-outlook';
export const SEVERE_OUTLOOK_ENTITY_PREFIX = 'spcoutlook:';

const SPC_BASE = 'https://www.spc.noaa.gov/products/outlook';

/** Outlooks reissue on a fixed schedule; a quarter hour is far fresher. */
export const SEVERE_OUTLOOK_UPDATE_MS = 15 * 60 * 1000;
export const SEVERE_OUTLOOK_FETCH_TIMEOUT_MS = 15_000;

/**
 * The products this layer can show. `categorical` ones carry the familiar
 * TSTM→HIGH scale; the probability ones are day-1 only, because SPC does not
 * issue separate hazard probabilities further out.
 */
export const OUTLOOK_PRODUCTS = Object.freeze([
  Object.freeze({
    key: 'day1-cat',
    chip: 'DAY 1',
    label: 'Day 1 Categorical',
    file: 'day1otlk_cat',
    kind: 'categorical',
    blurb: "Today's severe risk, in the categories SPC issues it in.",
  }),
  Object.freeze({
    key: 'day2-cat',
    chip: 'DAY 2',
    label: 'Day 2 Categorical',
    file: 'day2otlk_cat',
    kind: 'categorical',
    blurb: 'Tomorrow.',
  }),
  Object.freeze({
    key: 'day3-cat',
    chip: 'DAY 3',
    label: 'Day 3 Categorical',
    file: 'day3otlk_cat',
    kind: 'categorical',
    blurb: 'The day after tomorrow — the furthest SPC draws categories.',
  }),
  Object.freeze({
    key: 'day1-torn',
    chip: 'TORN',
    label: 'Day 1 Tornado Probability',
    file: 'day1otlk_torn',
    kind: 'probability',
    blurb: 'Chance of a tornado within 25 miles of a point, today.',
  }),
  Object.freeze({
    key: 'day1-wind',
    chip: 'WIND',
    label: 'Day 1 Damaging Wind Probability',
    file: 'day1otlk_wind',
    kind: 'probability',
    blurb: 'Chance of 58 mph or stronger gusts within 25 miles, today.',
  }),
  Object.freeze({
    key: 'day1-hail',
    chip: 'HAIL',
    label: 'Day 1 Hail Probability',
    file: 'day1otlk_hail',
    kind: 'probability',
    blurb: 'Chance of one-inch or larger hail within 25 miles, today.',
  }),
]);

export const DEFAULT_PRODUCT = 'day1-cat';

export function productFor(key) {
  return (
    OUTLOOK_PRODUCTS.find((p) => p.key === key) ||
    OUTLOOK_PRODUCTS.find((p) => p.key === DEFAULT_PRODUCT)
  );
}

export function outlookUrl(product) {
  return `${SPC_BASE}/${product.file}.nolyr.geojson`;
}

/**
 * Categorical risk ordering. Drawn low-to-high so a HIGH risk is never buried
 * under the general-thunderstorm area that surrounds it.
 *
 * SPC's `DN` is the ordinal it publishes; the names are its abbreviations.
 */
export const CATEGORY_RANK = Object.freeze({
  TSTM: 1,
  MRGL: 2,
  SLGT: 3,
  ENH: 4,
  MDT: 5,
  HIGH: 6,
});

export const CATEGORY_NAMES = Object.freeze({
  TSTM: 'General Thunderstorms',
  MRGL: 'Marginal',
  SLGT: 'Slight',
  ENH: 'Enhanced',
  MDT: 'Moderate',
  HIGH: 'High',
});

/**
 * A drawing rank for any feature.
 *
 * Categorical features rank by their category; probability features rank by
 * their numeric label, so a 30% area draws above the 5% area enclosing it.
 * Anything unrecognised sorts to the bottom rather than the top — an unknown
 * value must not outrank a known HIGH risk.
 */
export function featureRank({ label, dn }) {
  const name = String(label || '')
    .trim()
    .toUpperCase();
  if (CATEGORY_RANK[name]) return CATEGORY_RANK[name];
  const numeric = Number(String(label || '').replace('%', ''));
  if (Number.isFinite(numeric)) return numeric;
  const ordinal = Number(dn);
  return Number.isFinite(ordinal) ? ordinal / 100 : 0;
}

/** Expand an abbreviation, leaving anything else as SPC wrote it. */
export function categoryName(label) {
  const name = String(label || '')
    .trim()
    .toUpperCase();
  return CATEGORY_NAMES[name] || String(label || '').trim();
}

/** The fallback colour, used only when SPC omits one. */
export const FALLBACK_FILL = '#8e8e93';
