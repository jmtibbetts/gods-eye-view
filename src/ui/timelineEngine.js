/**
 * Timeline engine (pure): the day model behind the TIMELINE scrubber.
 *
 * Daily GIBS products are published per UTC day and the current day is not
 * complete, so "now" on this timeline means the most recent fully-published
 * day — yesterday UTC — not today. Offsets count backwards from there, so
 * offset 0 is the live frame and larger offsets reach further into the
 * archive. Keeping that convention in one place is the point of this module:
 * everything else just passes offsets around.
 *
 * No Cesium, no DOM, no network.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the scrubber can reach. GIBS keeps far more than this. */
export const TIMELINE_SPAN_DAYS = 14;

/** The most recent fully-published UTC day for a daily product. */
export function latestPublishedDay(now = Date.now()) {
  return new Date(now - DAY_MS).toISOString().slice(0, 10);
}

/** Clamp an offset into the scrubber's range. */
export function clampOffset(offset, span = TIMELINE_SPAN_DAYS) {
  const value = Math.round(Number(offset));
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), Math.max(0, span - 1));
}

/**
 * The UTC date string a given offset selects.
 * @param {number} offset Days back from the latest published day.
 * @param {number} [now]
 * @returns {string} YYYY-MM-DD
 */
export function dateForOffset(offset, now = Date.now()) {
  const clamped = clampOffset(offset, Number.POSITIVE_INFINITY);
  return new Date(now - DAY_MS * (clamped + 1)).toISOString().slice(0, 10);
}

/** Offset 0 is the live frame; anything else is history. */
export function isLiveOffset(offset) {
  return clampOffset(offset, Number.POSITIVE_INFINITY) === 0;
}

/**
 * A label for the current position, saying plainly whether this is the live
 * frame or an archived day.
 * @param {number} offset
 * @param {number} [now]
 * @returns {string}
 */
export function timelineLabel(offset, now = Date.now()) {
  const date = dateForOffset(offset, now);
  if (isLiveOffset(offset)) return `LIVE · ${date}`;
  const days = clampOffset(offset, Number.POSITIVE_INFINITY);
  return `${date} · ${days} day${days === 1 ? '' : 's'} back`;
}

/**
 * Every position the scrubber can take, newest first.
 * @param {number} [span]
 * @param {number} [now]
 * @returns {Array<{offset:number, date:string, live:boolean}>}
 */
export function timelinePositions(span = TIMELINE_SPAN_DAYS, now = Date.now()) {
  const positions = [];
  for (let offset = 0; offset < Math.max(1, span); offset++)
    positions.push({
      offset,
      date: dateForOffset(offset, now),
      live: isLiveOffset(offset),
    });
  return positions;
}

/**
 * What to hand a time-aware layer for a given offset: null means "use your own
 * latest", which is what the live frame should do rather than pinning a date
 * that will go stale as the day rolls over.
 * @param {number} offset
 * @param {number} [now]
 * @returns {string|null}
 */
export function displayDateForOffset(offset, now = Date.now()) {
  return isLiveOffset(offset) ? null : dateForOffset(offset, now);
}

/** Step the offset, staying inside the range. Positive steps go back in time. */
export function stepOffset(offset, step, span = TIMELINE_SPAN_DAYS) {
  return clampOffset(clampOffset(offset, span) + Math.round(step || 0), span);
}
