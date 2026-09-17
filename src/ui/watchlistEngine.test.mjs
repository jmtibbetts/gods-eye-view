import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeWatchHit,
  diffWatchHits,
  matchesWatchEntry,
  normalizeWatchValue,
  recordIdentifiers,
  scanWatchlist,
  watchEntryLabel,
} from './watchlistEngine.js';

const FLIGHTS = {
  layerId: 'flights',
  name: 'Live Flights',
  records: [
    {
      id: 'UAL123',
      icao24: 'a1b2c3',
      callsign: 'UAL123',
      lat: 30,
      lon: -97,
      altitudeM: 10000,
    },
    { id: 'SWA99', icao24: 'ddeeff', callsign: 'SWA99', lat: 31, lon: -96 },
  ],
};
const VESSELS = {
  layerId: 'ais-live-vessels',
  name: 'Live AIS Vessels',
  records: [
    {
      id: 'EVER GIVEN',
      mmsi: '366999123',
      name: 'EVER GIVEN',
      lat: 29.9,
      lon: 32.5,
      speedKts: 12,
    },
  ],
};

test('normalizeWatchValue folds case and separators', () => {
  assert.equal(normalizeWatchValue('ual 123'), 'UAL123');
  assert.equal(normalizeWatchValue('N-628TS'), 'N628TS');
  assert.equal(normalizeWatchValue('  366999123  '), '366999123');
  assert.equal(normalizeWatchValue(''), '');
  assert.equal(normalizeWatchValue(null), '');
});

test('recordIdentifiers collects every identity field a record carries', () => {
  const ids = recordIdentifiers(FLIGHTS.records[0]);
  assert.ok(ids.has('A1B2C3'));
  assert.ok(ids.has('UAL123'));
  assert.equal(recordIdentifiers(null).size, 0);
  assert.equal(recordIdentifiers('nope').size, 0);
});

test('matchesWatchEntry accepts any identifier spelling', () => {
  const record = FLIGHTS.records[0];
  assert.equal(matchesWatchEntry({ value: 'ual 123' }, record), true);
  assert.equal(matchesWatchEntry({ value: 'A1B2C3' }, record), true);
  assert.equal(matchesWatchEntry({ value: 'nope' }, record), false);
  assert.equal(matchesWatchEntry({ value: '' }, record), false);
});

test('scanWatchlist finds entries across different layers at once', () => {
  const entries = [
    { id: 'e1', value: 'UAL123' },
    { id: 'e2', value: '366999123' },
    { id: 'e3', value: 'GHOST1' },
  ];
  const hits = scanWatchlist(entries, [FLIGHTS, VESSELS]);
  assert.equal(hits.size, 2);
  assert.equal(hits.get('e1').layerId, 'flights');
  assert.equal(hits.get('e2').layerName, 'Live AIS Vessels');
  assert.equal(hits.has('e3'), false);
});

test('scanWatchlist is inert without entries or targets', () => {
  assert.equal(scanWatchlist([], [FLIGHTS]).size, 0);
  assert.equal(scanWatchlist(null, [FLIGHTS]).size, 0);
  assert.equal(scanWatchlist([{ id: 'e', value: '  ' }], [FLIGHTS]).size, 0);
});

test('diffWatchHits reports appearances and losses', () => {
  const { appeared, lost } = diffWatchHits(
    new Set(['a', 'b']),
    new Set(['b', 'c']),
  );
  assert.deepEqual(appeared, ['c']);
  assert.deepEqual(lost, ['a']);
});

test('describeWatchHit summarises layer, position and altitude or speed', () => {
  const air = describeWatchHit({
    layerName: 'Live Flights',
    record: FLIGHTS.records[0],
  });
  assert.match(air, /Live Flights/);
  assert.match(air, /30\.00N 97\.00W/);
  assert.match(air, /10000 m/);
  const sea = describeWatchHit({
    layerName: 'Live AIS Vessels',
    record: VESSELS.records[0],
  });
  assert.match(sea, /12 kt/);
  assert.equal(describeWatchHit(null), '');
});

test('watchEntryLabel normalises what the operator typed', () => {
  assert.equal(watchEntryLabel('  ual123 '), 'UAL123');
  assert.equal(watchEntryLabel(null), '');
});
