import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCOPE,
  STATION_SCOPES,
  STATION_STATES,
  scopeFor,
  stationState,
  withinScope,
} from './policy.js';
import { lastSeenText, parseStations, summarizeStations } from './records.js';
import { createSatnogsSource } from './source.js';
import { stationLabelText } from './index.js';

const NOW = Date.parse('2026-09-18T20:00:00Z');
const LIVE = scopeFor('online');
const DAY = scopeFor('day');
const ALL = scopeFor('all');

const ago = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

function station(over = {}) {
  return {
    id: 1,
    name: 'Test Station',
    lat: 38.4,
    lng: 21.8,
    altitude: 100,
    status: 'Online',
    connected: true,
    available: true,
    testing: false,
    observations: 1234,
    future: 5,
    successRate: 76,
    lastSeen: ago(10 * 60_000),
    bands: ['VHF', 'UHF'],
    ...over,
  };
}

test('an unknown scope falls back to the default rather than throwing', () => {
  assert.equal(scopeFor('nonsense').key, DEFAULT_SCOPE);
  assert.equal(scopeFor(undefined).key, DEFAULT_SCOPE);
});

test('state comes from the fields, not from the status string alone', () => {
  // SatNOGS reports status 'Offline' for stations that are connected but not
  // accepting scheduling. Trusting `status` would draw a running station as
  // dormant.
  assert.equal(stationState(station()).key, 'online');
  assert.equal(
    stationState(station({ status: 'Offline', testing: true })).key,
    'testing',
  );
  assert.equal(
    stationState(station({ status: 'Offline', available: false })).key,
    'idle',
  );
  assert.equal(stationState(station({ connected: false })).key, 'offline');
  assert.equal(stationState({}).key, 'offline');
  assert.equal(stationState(null).key, 'offline');
});

test('a connected station is never drawn as offline whatever its status says', () => {
  for (const over of [
    { status: 'Offline' },
    { status: 'Offline', available: false },
    { status: 'Offline', testing: true, available: false },
  ]) {
    assert.notEqual(
      stationState(station(over)).key,
      'offline',
      JSON.stringify(over),
    );
  }
});

test('states rank so the most active draws on top', () => {
  assert.ok(STATION_STATES.online.rank > STATION_STATES.idle.rank);
  assert.ok(STATION_STATES.testing.rank > STATION_STATES.idle.rank);
  assert.ok(STATION_STATES.idle.rank > STATION_STATES.offline.rank);
});

test('the live scope asks about connection, the others about recency', () => {
  const connectedButStale = station({ lastSeen: ago(400 * 24 * HOUR) });
  // Connected right now, last heartbeat record ancient: live yes, 24h no.
  assert.equal(withinScope(connectedButStale, LIVE, NOW), true);
  assert.equal(withinScope(connectedButStale, DAY, NOW), false);

  const recentButDisconnected = station({
    connected: false,
    lastSeen: ago(2 * HOUR),
  });
  assert.equal(withinScope(recentButDisconnected, LIVE, NOW), false);
  assert.equal(withinScope(recentButDisconnected, DAY, NOW), true);
});

test('a station that never reported in is out of every timed scope', () => {
  const never = station({ connected: false, lastSeen: null });
  assert.equal(withinScope(never, DAY, NOW), false);
  assert.equal(withinScope(never, scopeFor('month'), NOW), false);
  // ALL has no age limit, so it still appears there.
  assert.equal(withinScope(never, ALL, NOW), true);
});

test('a station at exactly 0,0 is an unset location, not a place', () => {
  // 207 of the network's records sit at 0,0. A SatNOGS station is somebody's
  // roof, so drawing them puts a cluster of antennas in the Atlantic.
  const rows = parseStations(
    [station({ lat: 0, lng: 0 }), station({ id: 2 })],
    ALL,
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stationId, 2);
  // The denominator still counts it, so the layer can say what it dropped.
  assert.equal(rows.total, 2);
});

test('unusable coordinates are rejected', () => {
  const rows = parseStations(
    [
      station({ lat: 999 }),
      station({ id: 2, lng: 999 }),
      // `Number(null)` is 0, a valid latitude — without an explicit guard this
      // station lands on the equator at its real longitude, looking like a site.
      station({ id: 3, lat: null }),
      station({ id: 4, lng: 'abc' }),
      station({ id: 5, lat: '' }),
      station({ id: 6, lng: false }),
    ],
    ALL,
    NOW,
  );
  assert.equal(rows.length, 0);
});

test('a repeated station is drawn once', () => {
  const rows = parseStations([station(), station()], ALL, NOW);
  assert.equal(rows.length, 1);
});

test('stations sort least active first so live ones draw on top', () => {
  const rows = parseStations(
    [
      station({ id: 1, connected: false }),
      station({ id: 2 }),
      station({ id: 3, testing: true }),
    ],
    ALL,
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.state),
    ['offline', 'testing', 'online'],
  );
});

test('a zero success rate survives as a reading rather than becoming absent', () => {
  // `||` would turn a genuine 0% into null and the card would omit it, which
  // reads as "no data" for a station that is in fact failing every pass.
  const [row] = parseStations([station({ successRate: 0 })], ALL, NOW);
  assert.equal(row.successRate, 0);
  assert.ok(stationLabelText(row, NOW).includes('0% good'));
});

test('compound band strings are already split by the proxy and pass through', () => {
  const [row] = parseStations(
    [station({ bands: ['HF', 'VHF', 'UHF'] })],
    ALL,
    NOW,
  );
  assert.deepEqual(row.bands, ['HF', 'VHF', 'UHF']);
  assert.ok(stationLabelText(row, NOW).includes('HF, VHF, UHF'));
});

test('the summary reports the scope against the whole network', () => {
  const rows = parseStations(
    [
      station({ id: 1 }),
      station({ id: 2, testing: true }),
      station({ id: 3, connected: false, lastSeen: ago(400 * 24 * HOUR) }),
    ],
    LIVE,
    NOW,
  );
  const summary = summarizeStations(rows, LIVE);
  assert.equal(summary.stations, 2);
  // Saying "2" alone invites reading it as the size of the network.
  assert.equal(summary.total, 3);
  assert.equal(summary.observations, 2468);
  // Ascending rank, matching the draw order and the other layers' legends.
  assert.deepEqual(summary.breakdown, [
    { name: 'Testing', count: 1 },
    { name: 'Online', count: 1 },
  ]);
});

test('an empty network summarizes without inventing a total', () => {
  const summary = summarizeStations([], LIVE);
  assert.equal(summary.stations, 0);
  assert.equal(summary.total, 0);
  assert.equal(summary.observations, 0);
});

test('last-seen reads in plain words and never claims a time it lacks', () => {
  assert.equal(lastSeenText({ lastSeen: ago(30_000) }, NOW), 'seen just now');
  assert.equal(
    lastSeenText({ lastSeen: ago(20 * 60_000) }, NOW),
    'seen 20 min ago',
  );
  assert.equal(lastSeenText({ lastSeen: ago(5 * HOUR) }, NOW), 'seen 5 h ago');
  assert.equal(
    lastSeenText({ lastSeen: ago(10 * 24 * HOUR) }, NOW),
    'seen 10 days ago',
  );
  assert.ok(
    lastSeenText({ lastSeen: '2022-10-05T12:49:26Z' }, NOW).includes(
      '2022-10-05',
    ),
  );
  assert.equal(lastSeenText({ lastSeen: null }, NOW), 'never reported in');
  assert.equal(lastSeenText({}, NOW), 'never reported in');
});

test('every scope is reachable and the chips are distinct', () => {
  const keys = STATION_SCOPES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  const chips = STATION_SCOPES.map((s) => s.chip);
  assert.equal(new Set(chips).size, chips.length);
  for (const key of keys) assert.equal(scopeFor(key).key, key);
});

test('the proxy error body is an error, not an empty network', () => {
  // The proxy answers 503 with {error} when it has nothing to serve. Reading
  // that as "no stations exist" would show an empty globe as if it were true.
  const source = createSatnogsSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: 'upstream_failed' }),
    }),
  });
  return assert.rejects(() => source.fetchStations(ALL), /upstream_failed/);
});

test('an HTTP failure surfaces rather than emptying the map', () => {
  const source = createSatnogsSource({
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  return assert.rejects(() => source.fetchStations(ALL), /502/);
});

test('the source reads through the proxy, never the upstream directly', () => {
  // network.satnogs.org sends no CORS headers on any method, so a direct
  // fetch cannot work from a browser at all.
  let asked = null;
  const source = createSatnogsSource({
    fetchImpl: async (url) => {
      asked = url;
      return { ok: true, json: async () => [] };
    },
  });
  return source.fetchStations(ALL).then(() => {
    assert.ok(asked.startsWith('/api/satnogs/'), asked);
    assert.ok(!asked.includes('network.satnogs.org'), asked);
  });
});

test('a caller abort is honoured', async () => {
  const controller = new AbortController();
  const source = createSatnogsSource({
    fetchImpl: (url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  const pending = source.fetchStations(ALL, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /aborted/);
});
