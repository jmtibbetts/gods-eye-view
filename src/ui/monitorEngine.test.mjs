import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONITOR_RADII,
  defaultWatchboxName,
  diffScan,
  monitorDistanceKm,
  recordLatLon,
  scanWatchbox,
} from './monitorEngine.js';

test('distance and coordinate reading', () => {
  assert.equal(Math.round(monitorDistanceKm(0, 0, 0, 1)), 111);
  assert.deepEqual(recordLatLon({ lat: 1, lon: 2 }), { lat: 1, lon: 2 });
  assert.deepEqual(recordLatLon({ latitude: 3, longitude: 4 }), {
    lat: 3,
    lon: 4,
  });
  assert.equal(recordLatLon({ lat: 'x' }), null);
  assert.equal(recordLatLon(null), null);
});

test('scanWatchbox counts only records inside the radius, across layers', () => {
  const box = { lat: 30, lon: -97, radiusKm: 150 };
  const layers = [
    {
      layerId: 'fires',
      name: 'Fires',
      records: [
        { id: 'f1', lat: 30.1, lon: -97.1 }, // ~15 km — in
        { id: 'f2', latitude: 40, longitude: -100 }, // far — out
      ],
    },
    {
      layerId: 'quakes',
      name: 'Quakes',
      records: [{ id: 'q1', lat: 29.5, lon: -96.8 }], // ~60 km — in
    },
  ];
  const { total, byLayer, ids } = scanWatchbox(box, layers);
  assert.equal(total, 2);
  assert.deepEqual(
    byLayer.map((l) => [l.layerId, l.count]),
    [
      ['fires', 1],
      ['quakes', 1],
    ],
  );
  assert.ok(ids.has('fires:f1'));
  assert.ok(ids.has('quakes:q1'));
  assert.equal(ids.has('fires:f2'), false);
});

test('diffScan reports arrivals and departures', () => {
  const prev = new Set(['a', 'b']);
  const cur = new Set(['b', 'c']);
  const { newIds, goneIds } = diffScan(prev, cur);
  assert.deepEqual(newIds, ['c']);
  assert.deepEqual(goneIds, ['a']);
});

test('watchbox names and radii presets', () => {
  assert.match(
    defaultWatchboxName(30.2, -97.7, 2),
    /^Watch 2 · 30\.2N 97\.7W$/,
  );
  assert.match(defaultWatchboxName(-33.9, 151.2), /33\.9S 151\.2E/);
  assert.ok(MONITOR_RADII.includes(150));
});
