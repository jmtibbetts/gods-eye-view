/**
 * Numeric coercion for values arriving from external feeds.
 *
 * THE HAZARD THIS EXISTS FOR. `Number('')`, `Number(null)`, `Number(false)`
 * and `Number([])` are all `0`, and `0` is a perfectly valid latitude, flight
 * level, drought class and flash count. So the obvious `Number(x)` turns a
 * field that is MISSING into a field that is present and says zero — and a
 * reader has no way to tell the difference.
 *
 * It is not a hypothetical. In one working session it produced, in five
 * different layers:
 *
 *   - a drought polygon with no class code drawn as "D0 Abnormally Dry";
 *   - a ground station with no latitude drawn on the equator at its real
 *     longitude, where it looked like a site rather than a gap;
 *   - a volcanic-ash SIGMET with no reported base drawn as "surface to FL150",
 *     indistinguishable from ash genuinely reaching the ground;
 *   - "FLNaN–FLNaN" on a record with no altitudes at all;
 *   - a lightning flash with an empty longitude placed in the Gulf of Guinea,
 *     which is both a plausible place for lightning and the wrong one.
 *
 * Each was fixed where it was found, and the copies then drifted: the aviation
 * one was still missing the blank-string case when this module was written.
 * That drift is the argument for one implementation rather than six.
 *
 * Every function here answers `null` for "the feed did not give me this", and
 * a number only when the feed actually said one. Callers distinguish the two
 * rather than defaulting, because defaulting is how the bugs above happened.
 */

/**
 * A finite number, or null.
 *
 * Rejects blank strings, null, undefined and booleans BEFORE converting, since
 * all of them coerce to a valid-looking 0.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function feedNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean')
    return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  // Arrays and objects coerce in surprising ways — `Number([])` is 0 and
  // `Number([5])` is 5 — and a feed field should never be either.
  if (typeof value === 'object') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A non-negative whole number, or null.
 *
 * For tallies a feed reports: observation counts, event counts, mentions.
 * A genuine 0 survives; a missing field does not become one.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function feedCount(value) {
  const n = feedNumber(value);
  if (n === null || n < 0) return null;
  return Math.round(n);
}

/**
 * A latitude in range, or null.
 * @param {unknown} value
 * @returns {number|null}
 */
export function feedLatitude(value) {
  const n = feedNumber(value);
  return n === null || Math.abs(n) > 90 ? null : n;
}

/**
 * A longitude in range, or null.
 * @param {unknown} value
 * @returns {number|null}
 */
export function feedLongitude(value) {
  const n = feedNumber(value);
  return n === null || Math.abs(n) > 180 ? null : n;
}
