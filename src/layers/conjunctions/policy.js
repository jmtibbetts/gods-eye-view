/**
 * Conjunctions — the close approaches CelesTrak's SOCRATES predicts for the
 * next week, placed on the globe where they will happen.
 *
 * A conjunction is two catalogued objects predicted to pass within a few
 * kilometres of each other. SOCRATES screens the public catalog against
 * itself eight times a day and reports the time of closest approach, the
 * miss distance, the relative speed and a maximum collision probability.
 * This layer draws the few dozen the proxy keeps — the highest
 * probabilities, the closest misses, and anything involving a crewed
 * station — as a marker at the point in space and time each one happens.
 *
 * WHAT THE NUMBER MEANS. The probability is SOCRATES's own, computed from
 * public two-line elements with an assumed covariance, and it is a
 * screening figure, not an operator's: operators use tracking data the
 * public never sees, and a pair that reads 1e-4 here may be nothing to
 * them or already a manoeuvre. The layer says "SOCRATES maximum
 * probability" every time and never "collision risk". A miss under a
 * kilometre with a probability of one is as often an old element set as a
 * close call.
 *
 * WHERE IT IS DRAWN. Both objects' elements are propagated to the time of
 * closest approach and the marker goes at their midpoint, in the
 * Earth-fixed frame of that instant — over the ground it will be over when
 * it happens. Until an object's elements arrive the conjunction is listed
 * but not placed, and the row says how many are still on their way.
 */

export const CONJUNCTIONS_LAYER_ID = 'conjunctions';
export const CONJUNCTIONS_ENTITY_PREFIX = 'conjunction:';

export const CONJUNCTIONS_URL = '/api/space/conjunctions';

/** SOCRATES runs eight times a day; the proxy re-reads it every three hours. */
export const CONJUNCTIONS_UPDATE_MS = 15 * 60 * 1000;
/** While elements are still arriving the layer asks again sooner. */
export const CONJUNCTIONS_PENDING_RETRY_MS = 45 * 1000;
export const CONJUNCTIONS_FETCH_TIMEOUT_MS = 30_000;

/**
 * Probability bands, by SOCRATES's own maximum probability. The thresholds
 * are the ones operators talk about — 1e-4 is where a manoeuvre is
 * commonly considered — but the colour is a reading aid, not a verdict.
 */
export const PROBABILITY_BANDS = Object.freeze([
  Object.freeze({
    key: 'high',
    min: 1e-4,
    name: 'High probability',
    color: '#ff4d4d',
    rank: 3,
    meaning: 'SOCRATES maximum probability of 1 in 10,000 or worse.',
  }),
  Object.freeze({
    key: 'elevated',
    min: 1e-5,
    name: 'Elevated',
    color: '#ff9f43',
    rank: 2,
    meaning: 'Between 1 in 100,000 and 1 in 10,000.',
  }),
  Object.freeze({
    key: 'low',
    min: 0,
    name: 'Low',
    color: '#8be07a',
    rank: 1,
    meaning: 'Below 1 in 100,000 — listed for its miss distance or its crew.',
  }),
]);

export function bandFor(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p))
    return PROBABILITY_BANDS[PROBABILITY_BANDS.length - 1];
  return (
    PROBABILITY_BANDS.find((b) => p >= b.min) ||
    PROBABILITY_BANDS[PROBABILITY_BANDS.length - 1]
  );
}

/** Chips: everything the proxy kept, the high band alone, the crewed ones alone. */
export const CONJUNCTION_FILTERS = Object.freeze([
  Object.freeze({
    key: 'all',
    chip: 'ALL',
    label: 'All kept conjunctions',
    blurb:
      'The highest probabilities, the closest misses, and every crewed one.',
    test: () => true,
  }),
  Object.freeze({
    key: 'high',
    chip: 'HIGH',
    label: 'High probability',
    blurb: 'SOCRATES maximum probability of 1e-4 or worse.',
    test: (r) => r.band.key === 'high',
  }),
  Object.freeze({
    key: 'crewed',
    chip: 'CREWED',
    label: 'Crewed',
    blurb: 'The ISS, Tiangong, and the crew and cargo vehicles flying to them.',
    test: (r) => r.crewed === true,
  }),
]);

export const DEFAULT_CONJUNCTION_FILTER = 'all';

export function conjunctionFilterFor(key) {
  return (
    CONJUNCTION_FILTERS.find((f) => f.key === key) ||
    CONJUNCTION_FILTERS.find((f) => f.key === DEFAULT_CONJUNCTION_FILTER)
  );
}

/** "1 in 8,300" — the way a probability reads to a person. */
export function probabilityText(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0) return 'below 1 in 1,000,000';
  if (p >= 1) return '1 in 1 (element set at fault, most likely)';
  const odds = Math.round(1 / p);
  return `1 in ${odds.toLocaleString('en-US')}`;
}
