/**
 * SatNOGS — the open ground-station network that actually receives satellites.
 *
 * Every other satellite layer in this project draws where a spacecraft IS.
 * This one draws where somebody is LISTENING to it: about 4,500 registered
 * stations, volunteer-run, each an antenna on someone's roof feeding
 * observations back to a shared archive.
 *
 * THE DEFAULT IS THE POINT, as with the river gauges. Drawing all 4,500 would
 * be a wall of dots that says nothing, because the overwhelming majority have
 * not been heard from in years — the oldest `lastSeen` in the set is 2022.
 * The default shows stations connected right now, which is a few dozen, and
 * the chips widen the net from there.
 *
 * TWO FIELDS THAT DISAGREE, and the disagreement is real rather than a bug.
 * SatNOGS publishes `status` (Online / Offline / Testing) and `lastSeen`. At
 * the time this was written 26 stations reported Online while 472 had been
 * heard from within the hour — because `status` means "connected AND accepting
 * scheduling right now" and `lastSeen` means "last reported in at all". A
 * station can be mid-observation, and therefore unavailable for scheduling,
 * while plainly alive. Both are exposed and neither is presented as the other.
 */

export const SATNOGS_LAYER_ID = 'satnogs';
export const SATNOGS_ENTITY_PREFIX = 'satnogs:';

export const SATNOGS_STATIONS_URL = '/api/satnogs/stations';

/** Stations heartbeat on the order of minutes. */
export const SATNOGS_UPDATE_MS = 10 * 60 * 1000;
export const SATNOGS_FETCH_TIMEOUT_MS = 30_000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Activity scopes, narrowest first.
 *
 * `maxAgeMs` is measured against `lastSeen`. `connectedOnly` additionally
 * requires the station to be connected right now, which is what SatNOGS's own
 * Online status means.
 */
export const STATION_SCOPES = Object.freeze([
  Object.freeze({
    key: 'online',
    chip: 'LIVE',
    label: 'Connected now',
    connectedOnly: true,
    maxAgeMs: null,
    blurb: 'Stations connected to the network right now.',
  }),
  Object.freeze({
    key: 'day',
    chip: '24H',
    label: 'Heard in 24 hours',
    connectedOnly: false,
    maxAgeMs: 24 * HOUR_MS,
    blurb: 'Stations that reported in within the last day.',
  }),
  Object.freeze({
    key: 'month',
    chip: '30D',
    label: 'Heard in 30 days',
    connectedOnly: false,
    maxAgeMs: 30 * 24 * HOUR_MS,
    blurb: 'Stations active in the last month.',
  }),
  Object.freeze({
    key: 'all',
    chip: 'ALL',
    label: 'Every registered station',
    connectedOnly: false,
    maxAgeMs: null,
    blurb: 'Every station on file, including long-dormant ones.',
  }),
]);

export const DEFAULT_SCOPE = 'online';

export function scopeFor(key) {
  return (
    STATION_SCOPES.find((s) => s.key === key) ||
    STATION_SCOPES.find((s) => s.key === DEFAULT_SCOPE)
  );
}

/**
 * Station states, ranked so the most active draws on top.
 *
 * `testing` is SatNOGS's own flag for a station being brought up: it is
 * connected and working but its data is not trusted yet, which is worth
 * showing differently rather than either hiding or promoting.
 */
export const STATION_STATES = Object.freeze({
  online: Object.freeze({
    key: 'online',
    name: 'Online',
    rank: 3,
    color: '#7cff6b',
    meaning: 'Connected and accepting scheduled observations.',
  }),
  testing: Object.freeze({
    key: 'testing',
    name: 'Testing',
    rank: 2,
    color: '#ffd24d',
    meaning: 'Connected and observing, but still being commissioned.',
  }),
  idle: Object.freeze({
    key: 'idle',
    name: 'Idle',
    rank: 1,
    color: '#4db8ff',
    meaning: 'Reported in recently but not currently accepting work.',
  }),
  offline: Object.freeze({
    key: 'offline',
    name: 'Offline',
    rank: 0,
    color: '#6b7a8c',
    meaning: 'Registered, but not currently connected to the network.',
  }),
});

/**
 * Resolve a station's state from the fields rather than from `status` alone.
 *
 * SatNOGS reports `status: 'Offline'` for stations that are connected but not
 * available for scheduling — 19 of them at the time of writing, every one of
 * them also flagged `testing`, so they resolve here as Testing. Reading
 * `status` alone would draw them as dormant when they are demonstrably
 * connected and observing.
 *
 * `idle` covers the connected-but-unavailable station that is NOT in testing —
 * one mid-observation, say. No station is in that state in the current
 * snapshot, but the combination is reachable and silently folding it into
 * offline would misreport a running station the moment it occurs.
 */
export function stationState(station) {
  if (station?.testing && station?.connected) return STATION_STATES.testing;
  if (station?.connected && station?.available) return STATION_STATES.online;
  if (station?.connected) return STATION_STATES.idle;
  return STATION_STATES.offline;
}

/** Whether a station falls inside a scope, given `now`. */
export function withinScope(station, scope, now = Date.now()) {
  if (scope.connectedOnly) return Boolean(station?.connected);
  if (scope.maxAgeMs == null) return true;
  const seen = Date.parse(station?.lastSeen || '');
  if (!Number.isFinite(seen)) return false;
  return now - seen <= scope.maxAgeMs;
}
