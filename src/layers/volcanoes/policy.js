/**
 * Volcano alerts — USGS volcanic activity notices for every US-monitored
 * volcano currently above background, plotted on the globe.
 *
 * The USGS elevated-volcano feed is the authority for which volcanoes are
 * restless, what they are named and what level they sit at, but it carries no
 * coordinates — only a Smithsonian Global Volcanism Program volcano number
 * (vnum). Position therefore comes from a bundled vnum lookup, and everything
 * the operator reads comes from the live notice.
 *
 * Two scales are reported together. The aviation colour code (GREEN → RED)
 * describes the ash hazard to aircraft; the ground alert level (NORMAL →
 * WARNING) describes the hazard on the ground. They move independently, which
 * is the point: a volcano can be ORANGE for aviation while the ground stays at
 * ADVISORY.
 */

export const VOLCANOES_LAYER_ID = 'volcanoes';
export const VOLCANOES_ENTITY_PREFIX = 'volcano:';

/** USGS HANS public feed; keyless JSON, and it serves `access-control-allow-origin: *`. */
export const USGS_ELEVATED_URL =
  'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes';

/** Bundled vnum lookup (see src/data/local_data/volcanoes/source.json). */
export const VOLCANO_COORDINATES_URL = new URL(
  '../../data/local_data/volcanoes/volcanoes.json',
  import.meta.url,
).href;

export const VOLCANOES_FETCH_TIMEOUT_MS = 15_000;

/** Aviation colour code — the ash hazard to aircraft. */
export const COLOR_CODES = Object.freeze({
  GREEN: '#34c759',
  YELLOW: '#ffd60a',
  ORANGE: '#ff9500',
  RED: '#ff2d55',
  UNASSIGNED: '#8e8e93',
});

/** Ground alert level, worst last. */
export const ALERT_RANK = Object.freeze({
  NORMAL: 0,
  ADVISORY: 1,
  WATCH: 2,
  WARNING: 3,
});

/** Aviation code severity, worst last — drives draw order and marker size. */
export const COLOR_RANK = Object.freeze({
  UNASSIGNED: 0,
  GREEN: 1,
  YELLOW: 2,
  ORANGE: 3,
  RED: 4,
});

export function volcanoColor(colorCode) {
  return (
    COLOR_CODES[String(colorCode || '').toUpperCase()] || COLOR_CODES.UNASSIGNED
  );
}

/** Plain-language gloss so the two scales are not mistaken for one another. */
export function alertSummary(colorCode, alertLevel) {
  const code = String(colorCode || 'UNASSIGNED').toUpperCase();
  const level = String(alertLevel || 'NORMAL').toUpperCase();
  return `Aviation ${code} · Ground ${level}`;
}
