import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceSources } from './reference.js';
import { createStandaloneReferenceSources } from '../standalone/layerSources.js';

test('reference factories retain compatibility without starting acquisition or sharing instances', (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('unexpected acquisition');
  });
  assert.equal(createReferenceSources, createStandaloneReferenceSources);
  const first = createReferenceSources();
  const second = createReferenceSources();
  assert.deepEqual(Object.keys(first), [
    'earthquakes',
    'cables',
    'scanner',
    'sdr',
    'atc',
    'weatherAlerts',
    'stormReports',
    'volcanoes',
    'tropical',
    'aviationHazards',
    'conflictReports',
    'drought',
    'lightning',
    'riverFlood',
    'satnogs',
    'severeOutlook',
    'airQuality',
    'spaceWeather',
  ]);
  assert.notEqual(first.scanner, second.scanner);
  assert.notEqual(first.spaceWeather, second.spaceWeather);
  assert.equal(typeof first.spaceWeather.fetchSpaceWeather, 'function');
  assert.notEqual(first.sdr, second.sdr);
  assert.equal(typeof first.scanner.getSeed, 'function');
  assert.equal(typeof first.sdr.getSnapshot, 'function');
  assert.notEqual(first.atc, second.atc);
  assert.equal(typeof first.atc.getSnapshot, 'function');
  assert.notEqual(first.weatherAlerts, second.weatherAlerts);
  assert.equal(typeof first.weatherAlerts.getSnapshot, 'function');
  assert.notEqual(first.stormReports, second.stormReports);
  assert.equal(typeof first.stormReports.getSnapshot, 'function');
  assert.notEqual(first.volcanoes, second.volcanoes);
  assert.equal(typeof first.volcanoes.getSnapshot, 'function');
  assert.notEqual(first.earthquakes, second.earthquakes);
  assert.notEqual(first.cables, second.cables);
  assert.equal(typeof first.earthquakes.getSnapshot, 'function');
  assert.equal(typeof first.cables.fetch, 'function');
  assert.equal(requests, 0);
});
