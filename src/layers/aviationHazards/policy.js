/**
 * Aviation hazards — SIGMETs in force right now.
 *
 * A SIGMET is a meteorological authority telling aircraft that something
 * dangerous is happening in a defined volume of sky for a defined window. That
 * makes this layer different from the forecast layers beside it: every polygon
 * here is current, bounded in time, and issued by a named authority.
 *
 * THE VALIDITY WINDOW IS NOT DECORATION. The upstream feed keeps publishing
 * advisories after they expire — ten of a hundred and fifty-two at one sampling
 * — and an expired SIGMET drawn as current tells a reader that airspace is
 * hazardous when the authority has already said it is not. Expired advisories
 * are dropped, and the count is reported rather than swallowed.
 *
 * UNKNOWN HAZARDS ARE DRAWN, which is the opposite of the drought layer's rule
 * and deliberately so. There, an unrecognised class meant "No_Drought" and
 * painting it would have blanketed the country in a class meaning nothing to
 * report. Here, every record in the feed is by definition something an
 * authority thought worth warning aircraft about, so a hazard code this layer
 * has not seen before is drawn in a neutral colour and named as-is. Omitting a
 * live hazard because the code is unfamiliar is the worse failure.
 *
 * COLOURS ARE CHOSEN HERE, not read off a service renderer. Unlike the drought,
 * air-quality and severe-outlook bands there is no published symbology to
 * inherit: this is a text API. They are picked to separate the classes, and
 * carry no official standing.
 */

export const AVIATION_HAZARDS_LAYER_ID = 'aviation-hazards';
export const AVIATION_HAZARDS_ENTITY_PREFIX = 'sigmet:';

export const AVIATION_SIGMETS_URL = '/api/aviation/sigmets';

/** SIGMETs are issued hourly or as conditions change. */
export const AVIATION_UPDATE_MS = 5 * 60 * 1000;
export const AVIATION_FETCH_TIMEOUT_MS = 25_000;

const FALLBACK = Object.freeze({
  key: 'other',
  name: 'Other hazard',
  color: '#9aa7b5',
  rank: 1,
  meaning: 'A hazard class this layer does not yet name specifically.',
});

/**
 * Hazard classes. `codes` are the upstream's own strings; the domestic feed
 * says CONVECTIVE where the international one says TS for the same weather,
 * so both map to one class rather than appearing as two.
 */
export const HAZARD_CLASSES = Object.freeze([
  Object.freeze({
    key: 'ash',
    chip: 'ASH',
    name: 'Volcanic ash',
    codes: ['VA'],
    rank: 6,
    color: '#b05cff',
    meaning: 'Volcanic ash in flight levels — engine-damaging.',
  }),
  Object.freeze({
    key: 'storm',
    chip: 'STORM',
    name: 'Thunderstorms',
    codes: ['TS', 'CONVECTIVE'],
    rank: 5,
    color: '#ff4d4d',
    meaning: 'Thunderstorm activity, often embedded or obscured.',
  }),
  Object.freeze({
    key: 'cyclone',
    chip: 'TC',
    name: 'Tropical cyclone',
    codes: ['TC'],
    rank: 4,
    color: '#ff66cc',
    meaning: 'Tropical cyclone affecting the region.',
  }),
  Object.freeze({
    key: 'turbulence',
    chip: 'TURB',
    name: 'Turbulence',
    codes: ['TURB'],
    rank: 3,
    color: '#ffaa33',
    meaning: 'Turbulence severe enough to warrant an advisory.',
  }),
  Object.freeze({
    key: 'ice',
    chip: 'ICE',
    name: 'Icing',
    codes: ['ICE'],
    rank: 2,
    color: '#66ccff',
    meaning: 'Airframe icing conditions.',
  }),
  Object.freeze({
    key: 'wave',
    chip: 'WAVE',
    name: 'Mountain wave',
    codes: ['MTW'],
    rank: 1,
    color: '#ccaa66',
    meaning:
      'Mountain wave activity — strong vertical motion downwind of terrain.',
  }),
]);

const CLASS_BY_CODE = new Map();
for (const klass of HAZARD_CLASSES)
  for (const code of klass.codes) CLASS_BY_CODE.set(code, klass);

/**
 * The class for an upstream hazard code.
 *
 * Never null: an unrecognised code falls back rather than being dropped. See
 * the note at the top of this file.
 */
export function hazardClassFor(code) {
  const key = String(code || '')
    .trim()
    .toUpperCase();
  if (!key) return FALLBACK;
  return CLASS_BY_CODE.get(key) || { ...FALLBACK, name: `${key} hazard` };
}

export { FALLBACK as FALLBACK_HAZARD };

/** Chips: everything, then one per class. */
export const HAZARD_FILTERS = Object.freeze([
  Object.freeze({
    key: 'all',
    chip: 'ALL',
    label: 'All hazards',
    classKey: null,
    blurb: 'Every SIGMET currently in force.',
  }),
  ...HAZARD_CLASSES.map((klass) =>
    Object.freeze({
      key: klass.key,
      chip: klass.chip,
      label: klass.name,
      classKey: klass.key,
      blurb: klass.meaning,
    }),
  ),
]);

export const DEFAULT_FILTER = 'all';

export function filterFor(key) {
  return (
    HAZARD_FILTERS.find((f) => f.key === key) ||
    HAZARD_FILTERS.find((f) => f.key === DEFAULT_FILTER)
  );
}

/**
 * Intensity qualifiers the international feed uses.
 *
 * For a VOLCANIC ASH advisory this same field carries the volcano's name
 * instead — MAYON, SEMERU, FUEGO — so it is only read as an intensity when the
 * value is one of these.
 */
export const QUALIFIERS = Object.freeze({
  SEV: 'Severe',
  EMBD: 'Embedded',
  FRQ: 'Frequent',
  OCNL: 'Occasional',
  ISOL: 'Isolated',
  MOD: 'Moderate',
});

/** Trend codes. */
export const TRENDS = Object.freeze({
  NC: 'No change',
  INTSF: 'Intensifying',
  WKN: 'Weakening',
});

/** Whether an advisory is in force at `now` (epoch ms). */
export function inForce(record, now = Date.now()) {
  const to = record?.to;
  if (!Number.isFinite(to)) return true;
  return to * 1000 >= now;
}
