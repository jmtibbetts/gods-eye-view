import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DARK_AFTER_MS,
  findDarkVessels,
  matchSanctionedVessels,
  normalizeSanctionedVessels,
  pruneVesselTracks,
  silenceText,
  updateVesselTracks,
} from './vesselWatchEngine.js';

const TABLE = normalizeSanctionedVessels({
  vessels: {
    572469210: {
      name: 'ARTAVIL',
      program: 'IRAN',
      flag: 'Iran',
      imo: '9187629',
    },
    256845000: { name: 'SILVER I', program: 'IRAN' },
    12345: { name: 'TOO SHORT', program: 'X' },
    abcdefghi: { name: 'NOT NUMERIC', program: 'X' },
  },
});

const T0 = 1_000_000_000_000;

test('the sanctions table keeps only well-formed MMSI keys', () => {
  assert.equal(TABLE.size, 2);
  assert.equal(TABLE.get('572469210').name, 'ARTAVIL');
  assert.equal(TABLE.has('12345'), false);
  assert.equal(TABLE.has('abcdefghi'), false);
  assert.equal(normalizeSanctionedVessels(null).size, 0);
});

test('sanctions match on MMSI, never on vessel name', () => {
  const records = [
    { mmsi: '572469210', name: 'SOMETHING ELSE', lat: 1, lon: 2 },
    // Same name as a listed vessel but a different MMSI: must NOT match.
    { mmsi: '999999999', name: 'ARTAVIL', lat: 3, lon: 4 },
  ];
  const hits = matchSanctionedVessels(records, TABLE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record.mmsi, '572469210');
  assert.equal(hits[0].listing.program, 'IRAN');
});

test('sanctions matching is inert without a table', () => {
  assert.deepEqual(matchSanctionedVessels([{ mmsi: '1' }], new Map()), []);
  assert.deepEqual(matchSanctionedVessels(null, TABLE), []);
});

test('tracks accumulate sightings and keep the last known position', () => {
  const tracks = new Map();
  updateVesselTracks(tracks, [{ mmsi: '111', name: 'A', lat: 5, lon: 6 }], T0);
  updateVesselTracks(
    tracks,
    [{ mmsi: '111', name: 'A', lat: 7, lon: 8 }],
    T0 + 1000,
  );
  const track = tracks.get('111');
  assert.equal(track.sightings, 2);
  assert.equal(track.lat, 7);
  assert.equal(track.lastSeen, T0 + 1000);
  // A record with no coordinate must not erase the last good fix.
  updateVesselTracks(tracks, [{ mmsi: '111', name: 'A' }], T0 + 2000);
  assert.equal(tracks.get('111').lat, 7);
});

test('a vessel is dark only after enough sightings and enough silence', () => {
  const tracks = new Map();
  for (let i = 0; i < 3; i++)
    updateVesselTracks(
      tracks,
      [{ mmsi: '111', name: 'A', lat: 5, lon: 6 }],
      T0 + i,
    );
  // Seen three times, but only just missed once.
  assert.deepEqual(findDarkVessels(tracks, T0 + 60_000), []);
  const dark = findDarkVessels(tracks, T0 + DARK_AFTER_MS + 1000);
  assert.equal(dark.length, 1);
  assert.equal(dark[0].mmsi, '111');
  assert.ok(dark[0].silentMs >= DARK_AFTER_MS);
});

test('a one-off blip never counts as going dark', () => {
  const tracks = new Map();
  updateVesselTracks(tracks, [{ mmsi: '222', name: 'B', lat: 1, lon: 2 }], T0);
  assert.deepEqual(findDarkVessels(tracks, T0 + DARK_AFTER_MS * 10), []);
});

test('reappearing clears the dark state so it can re-arm', () => {
  const tracks = new Map();
  for (let i = 0; i < 3; i++)
    updateVesselTracks(
      tracks,
      [{ mmsi: '333', name: 'C', lat: 1, lon: 2 }],
      T0 + i,
    );
  const late = T0 + DARK_AFTER_MS + 5000;
  assert.equal(findDarkVessels(tracks, late).length, 1);
  updateVesselTracks(
    tracks,
    [{ mmsi: '333', name: 'C', lat: 1, lon: 2 }],
    late,
  );
  assert.deepEqual(findDarkVessels(tracks, late + 1000), []);
});

test('stale tracks are pruned', () => {
  const tracks = new Map();
  updateVesselTracks(tracks, [{ mmsi: '444', name: 'D', lat: 1, lon: 2 }], T0);
  assert.equal(pruneVesselTracks(tracks, T0 + 1000, 10_000), 0);
  assert.equal(pruneVesselTracks(tracks, T0 + 20_000, 10_000), 1);
  assert.equal(tracks.size, 0);
});

test('silence is reported in readable units', () => {
  assert.equal(silenceText(20 * 60_000), 'silent 20 min');
  assert.equal(silenceText(90 * 60_000), 'silent 1h 30m');
  assert.equal(silenceText(120 * 60_000), 'silent 2h');
});
