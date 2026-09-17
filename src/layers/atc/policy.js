/**
 * ATC layer policy — air traffic control facilities and frequencies.
 *
 * The directory is a bundled snapshot: every US airport, heliport and
 * seaplane base with a published VHF frequency (FAA NASR 28-day cycle,
 * with tower type, hours, radio call and approach provider) plus airports
 * worldwide from OurAirports open data, and the FAA's ARTCC remote sites
 * that carry the en-route Center frequencies.
 *
 * Audio is never relayed by the app. LiveATC's terms forbid third-party
 * use of its streams, so the layer hands the operator to LiveATC's own
 * page for the airport, and where a public web SDR within range covers
 * the airband it tunes that receiver instead — inside the map.
 */

export const ATC_LAYER_ID = 'atc';
export const ATC_ENTITY_PREFIX = 'atc:';

/** Bundled directory (see src/data/local_data/atc_airports/source.json). */
export const ATC_DIRECTORY_URL = new URL(
  '../../data/local_data/atc_airports/airports.json',
  import.meta.url,
).href;

export const ATC_FETCH_TIMEOUT_MS = 20_000;

export const ATC_OVERLAY_SOURCE_ID = 'atc';
export const ATC_SELECTED_OVERLAY_SOURCE_ID = 'atc-selected';
export const ATC_OVERLAY_COHORT_LIMIT = 36;
export const ATC_OVERLAY_COLLISION_CAPACITY = 20;
export const ATC_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Untowered fields are only drawn this close to the camera (metres). */
export const ATC_UNTOWERED_DRAW_DISTANCE_M = 450_000;

/** How often the selected aircraft is re-read while following (ms). */
export const ATC_FOLLOW_POLL_MS = 2500;

/** Airband SDR search radius around the facility (km). */
export const ATC_SDR_RANGE_KM = 90;

/** Frequency-position codes, in display order. */
export const ATC_POSITIONS = Object.freeze([
  'TWR',
  'GND',
  'CLD',
  'APP',
  'DEP',
  'CTR',
  'ATIS',
  'CTAF',
  'UNICOM',
  'AFIS',
  'INFO',
  'RAMP',
  'WX',
]);

export const ATC_POSITION_LABELS = Object.freeze({
  TWR: 'Tower',
  GND: 'Ground',
  CLD: 'Clearance',
  APP: 'Approach',
  DEP: 'Departure',
  CTR: 'Center',
  ATIS: 'ATIS',
  CTAF: 'CTAF',
  UNICOM: 'UNICOM',
  AFIS: 'AFIS',
  INFO: 'Information',
  RAMP: 'Ramp',
  WX: 'Weather',
});

/** Plain-language hint per position, for the panel. */
export const ATC_POSITION_HINTS = Object.freeze({
  TWR: 'Takeoff and landing clearances on the runway.',
  GND: 'Taxiing between gate and runway.',
  CLD: 'IFR route clearances before pushback.',
  APP: 'Arrivals and departures within ~40 nm of the field.',
  DEP: 'Climb-out handling after takeoff.',
  CTR: 'En-route traffic between terminal areas.',
  ATIS: 'Recorded weather and runway information, looping.',
  CTAF: 'Pilots announcing themselves at an untowered field.',
  UNICOM: 'Airport services and pilot advisories.',
  AFIS: 'Aerodrome flight information (non-radar).',
  INFO: 'Flight information service.',
  RAMP: 'Apron and gate movements.',
  WX: 'Automated weather observation, looping.',
});

/** Flight phases the follow engine reports, with the position it maps to. */
export const ATC_PHASES = Object.freeze({
  ground: Object.freeze({ label: 'On the ground', position: 'GND' }),
  tower: Object.freeze({ label: 'Tower airspace', position: 'TWR' }),
  departure: Object.freeze({ label: 'Departing', position: 'DEP' }),
  approach: Object.freeze({ label: 'Approach airspace', position: 'APP' }),
  center: Object.freeze({ label: 'En route', position: 'CTR' }),
});

/** Phase thresholds. */
export const ATC_PHASE_RULES = Object.freeze({
  /** Within this many km of the field and below towerAglFt → tower. */
  towerRadiusKm: 12,
  towerAglFt: 3_000,
  /** Within this many km and below approachAglFt → approach / departure. */
  approachRadiusKm: 75,
  approachAglFt: 14_000,
  /** Climbing faster than this (ft/min) inside approach airspace → departure. */
  climbFpm: 300,
  /** Ground speed below which a low contact counts as on the ground (kt). */
  groundSpeedKt: 40,
});

/** Marker colours. */
export const ATC_COLORS = Object.freeze({
  tower24: '#65f7ff',
  tower: '#3fc9d8',
  untowered: '#6d8a94',
  center: '#ff9d4d',
  selected: '#ffffff',
});

/** LiveATC airport page (the operator's own player). */
export function liveAtcAirportUrl(icaoOrCode) {
  const code = String(icaoOrCode || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return code ? `https://www.liveatc.net/search/?icao=${code}` : '';
}
