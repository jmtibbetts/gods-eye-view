/**
 * Scanner layer policy — constants for the OpenMHz public-safety radio layer.
 *
 * OpenMHz (openmhz.com) republishes trunked P25 public-safety radio traffic
 * recorded by volunteer trunk-recorder sites: police, fire, EMS, transit and
 * public-works talkgroups, one clip per transmission, seconds after it aired.
 * The API is keyless and CORS-open, so the browser talks to it directly —
 * exactly like the USGS earthquake feed. Audio plays through a plain
 * HTMLAudioElement straight from OpenMHz's media host (no CORS on media, so
 * the bytes are never decoded client-side; that is fine for playback).
 */

export const SCANNER_LAYER_ID = 'scanner';
export const SCANNER_ENTITY_PREFIX = 'scanner:';

/** OpenMHz read API (CORS `*`). */
export const OPENMHZ_API_ORIGIN = 'https://api.openmhz.com';
/** Only audio from this host is ever handed to the audio element. */
export const OPENMHZ_MEDIA_HOST = 'media2.openmhz.com';

/** Bundled geocoded seed (see src/data/local_data/openmhz_systems/source.json). */
export const SCANNER_SEED_URL = new URL(
  '../../data/local_data/openmhz_systems/systems.json',
  import.meta.url,
).href;

/** Live catalog refresh cadence (the seed paints instantly; this only updates activity). */
export const SCANNER_CATALOG_REFRESH_MS = 30 * 60 * 1000;
/** How often a selected system is polled for new calls. */
export const SCANNER_LIVE_POLL_MS = 4000;
/** Newest calls fetched on first select. */
export const SCANNER_RECENT_LIMIT = 8;
/** Calls kept in the card history. */
export const SCANNER_HISTORY_LIMIT = 5;
/** Queue cap: a busy system produces more clips than can be played; drop the oldest. */
export const SCANNER_QUEUE_LIMIT = 12;
/** Calls older than this on first select are listed but not queued for playback. */
export const SCANNER_QUEUE_MAX_AGE_MS = 90 * 1000;
export const SCANNER_FETCH_TIMEOUT_MS = 12_000;
export const SCANNER_DEFAULT_VOLUME = 0.9;

/** Ambient labels for the busiest systems only; the rest are dots until zoomed. */
export const SCANNER_OVERLAY_SOURCE_ID = 'scanner';
export const SCANNER_SELECTED_OVERLAY_SOURCE_ID = 'scanner-selected';
export const SCANNER_OVERLAY_COHORT_LIMIT = 48;
export const SCANNER_OVERLAY_COLLISION_CAPACITY = 32;
export const SCANNER_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Marker colour by activity band (calls per minute across the whole system). */
export const SCANNER_COLORS = Object.freeze({
  hot: '#ff4d4d', // ≥ 10 calls/min
  busy: '#ffb24d', // ≥ 3
  quiet: '#66d9ff', // > 0
  idle: '#5d7080', // no traffic in the last window
  selected: '#00ffff',
});

/** Discipline keywords used to colour talkgroup lines in the card. */
export const SCANNER_DISCIPLINES = Object.freeze([
  ['fire', ['fire', 'fd ', 'brush', 'engine', 'ladder', 'rescue', 'tac']],
  ['ems', ['ems', 'medic', 'ambulance', 'hospital', 'trauma']],
  [
    'police',
    ['police', 'pd ', 'sheriff', 'so ', 'patrol', 'dispatch', 'trooper', 'law'],
  ],
]);
