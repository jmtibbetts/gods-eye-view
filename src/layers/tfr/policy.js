/**
 * Flight restrictions — every FAA TFR in force, as the polygon it closes.
 *
 * A temporary flight restriction is the FAA telling pilots that a volume of
 * sky is closed for a reason and a window: a rocket launch, a wildfire's
 * aircraft, a stadium, the President's motorcade. It is the aviation
 * counterpart of the SIGMET layer beside it, and the difference matters:
 * a SIGMET is weather an authority warns about, a TFR is a rule.
 *
 * FOR THE LAUNCH WATCHER the space-operations closures are the point. A
 * launch closes the airspace over the pad and down range hours before the
 * window and reopens it after, and the closure's start and end are often the
 * first hard evidence of when an operator really means to fly. Those
 * records carry the NOTAM's own times to the minute; the rest carry the
 * day their list title names, and the layer says which is which.
 *
 * COLOURS ARE CHOSEN HERE. The FAA's map colours its types too, but as a
 * courtesy, not a standard, and this palette is picked to sit beside the
 * SIGMET classes without colliding with them.
 */

export const TFR_LAYER_ID = 'tfr';
export const TFR_ENTITY_PREFIX = 'tfr:';

export const TFR_URL = '/api/aviation/tfrs';

/** TFRs come and go through the day; the proxy holds them ten minutes. */
export const TFR_UPDATE_MS = 10 * 60 * 1000;
export const TFR_FETCH_TIMEOUT_MS = 25_000;

const FALLBACK = Object.freeze({
  key: 'other',
  name: 'Other restriction',
  color: '#9aa7b5',
  rank: 1,
  meaning: 'A restriction type this layer does not yet name specifically.',
});

/**
 * Restriction types, by the FAA's own `type` strings. Ranked so that when
 * two closures overlap, the one a pilot must not enter under any
 * circumstance is drawn on top.
 */
export const TFR_CLASSES = Object.freeze([
  Object.freeze({
    key: 'space',
    chip: 'SPACE',
    name: 'Space operations',
    codes: ['SPACE OPERATIONS'],
    rank: 6,
    color: '#ff9f43',
    meaning: 'Airspace closed for a launch or re-entry — 14 CFR 91.143.',
  }),
  Object.freeze({
    key: 'hazard',
    chip: 'HAZARD',
    name: 'Hazards',
    codes: ['HAZARDS'],
    rank: 5,
    color: '#ff4d4d',
    meaning:
      'A hazard on the ground — usually firefighting aircraft over a wildfire, or a disaster scene — 14 CFR 91.137.',
  }),
  Object.freeze({
    key: 'security',
    chip: 'SECURITY',
    name: 'Security',
    codes: ['SECURITY', 'SPECIAL'],
    rank: 4,
    color: '#b05cff',
    meaning: 'National security or special-purpose airspace — 14 CFR 99.7.',
  }),
  Object.freeze({
    key: 'vip',
    chip: 'VIP',
    name: 'VIP movement',
    codes: ['VIP'],
    rank: 3,
    color: '#4da3ff',
    meaning:
      'Airspace around a protected person — the President, most often — 14 CFR 91.141.',
  }),
  Object.freeze({
    key: 'event',
    chip: 'EVENTS',
    name: 'Events',
    codes: ['AIR SHOWS/SPORTS', 'UAS PUBLIC GATHERING'],
    rank: 2,
    color: '#2bd66b',
    meaning:
      'Stadiums, air shows and public gatherings — 14 CFR 91.145 and the drone rules under it.',
  }),
]);

const CLASS_BY_CODE = new Map();
for (const klass of TFR_CLASSES)
  for (const code of klass.codes) CLASS_BY_CODE.set(code, klass);

/**
 * The class for an FAA type string. Never null: an unrecognised type is
 * drawn in the neutral colour and named as-is, because every record in
 * the list is airspace the FAA closed, and omitting one because its label
 * is unfamiliar is the worse failure.
 */
export function tfrClassFor(type) {
  const key = String(type || '')
    .trim()
    .toUpperCase();
  if (!key) return FALLBACK;
  return CLASS_BY_CODE.get(key) || { ...FALLBACK, name: `${key} restriction` };
}

export { FALLBACK as FALLBACK_TFR_CLASS };

/** Chips: everything, then one per class. */
export const TFR_FILTERS = Object.freeze([
  Object.freeze({
    key: 'all',
    chip: 'ALL',
    label: 'All restrictions',
    classKey: null,
    blurb: 'Every TFR the FAA currently lists.',
  }),
  ...TFR_CLASSES.map((klass) =>
    Object.freeze({
      key: klass.key,
      chip: klass.chip,
      label: klass.name,
      classKey: klass.key,
      blurb: klass.meaning,
    }),
  ),
]);

export const DEFAULT_TFR_FILTER = 'all';

/** The filter for a key, falling back to the default rather than throwing. */
export function tfrFilterFor(key) {
  return (
    TFR_FILTERS.find((f) => f.key === key) ||
    TFR_FILTERS.find((f) => f.key === DEFAULT_TFR_FILTER)
  );
}

/**
 * Whether a restriction is in force, or still ahead, at an instant. One
 * that ended more than a day ago is over even if the list has not caught
 * up; the list itself is the authority on the rest.
 */
export function tfrCurrent(record, nowMs) {
  const ends = Date.parse(record?.ends || '');
  if (!Number.isFinite(ends)) return true;
  return ends + 86_400_000 > nowMs;
}
