import test from 'node:test';
import assert from 'node:assert/strict';
import { ENERGY_BANDS, energyBand, satelliteName } from './policy.js';
import { coverageText, parseFlashes, summarizeFlashes } from './records.js';
import { createLightningSource } from './source.js';
import { flashLabelText } from './index.js';

const payload = (over = {}) => ({
  at: '2026-09-18T21:29:35.634Z',
  windowSeconds: 60,
  satellites: [
    { id: 'G19', name: 'GOES-19 East', flashes: 2 },
    { id: 'G18', name: 'GOES-18 West', flashes: 1 },
  ],
  missing: [],
  flashes: [
    { lat: 34.9, lon: -107.9, energy: 200, sat: 'G19' },
    { lat: -18.8, lon: -52.4, energy: 45, sat: 'G19' },
    { lat: 12.1, lon: -160.2, energy: 5, sat: 'G18' },
  ],
  ...over,
});

test('energy bands are ordered and every energy lands in one', () => {
  const mins = ENERGY_BANDS.map((b) => b.min);
  assert.deepEqual(
    mins,
    [...mins].sort((a, b) => a - b),
  );
  assert.equal(energyBand(0).key, 'faint');
  assert.equal(energyBand(29).key, 'faint');
  assert.equal(energyBand(30).key, 'moderate');
  assert.equal(energyBand(119).key, 'moderate');
  assert.equal(energyBand(120).key, 'bright');
  assert.equal(energyBand(99999).key, 'bright');
  // Nothing may fall through to undefined, whatever arrives.
  for (const value of [null, undefined, NaN, 'abc', -5, false])
    assert.ok(energyBand(value).key, `${String(value)} had no band`);
});

test('flashes sort faintest first so bright ones draw on top', () => {
  const rows = parseFlashes(payload());
  assert.deepEqual(
    rows.map((r) => r.band),
    ['faint', 'moderate', 'bright'],
  );
});

test('unusable coordinates are rejected', () => {
  const rows = parseFlashes(
    payload({
      flashes: [
        { lat: 999, lon: 0, energy: 1, sat: 'G19' },
        { lat: 0, lon: 999, energy: 1, sat: 'G19' },
        { lat: null, lon: 10, energy: 1, sat: 'G19' },
        { lat: 10, lon: '', energy: 1, sat: 'G19' },
        { lat: 10, lon: 20, energy: 1, sat: 'G19' },
      ],
    }),
  );
  // `Number(null)` and `Number('')` are both 0, a valid coordinate, so the
  // guard has to reject them before converting.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, 10);
});

test('a flash at 0,0 is kept — lightning over the Gulf of Guinea is real', () => {
  // Unlike a SatNOGS station, which is somebody's roof, a lightning flash at
  // the origin is an ordinary observation and must not be filtered as a
  // placeholder.
  const rows = parseFlashes(
    payload({ flashes: [{ lat: 0, lon: 0, energy: 40, sat: 'G19' }] }),
  );
  assert.equal(rows.length, 1);
});

test('the summary carries the observation window, not just a count', () => {
  const rows = parseFlashes(payload());
  const summary = summarizeFlashes(rows);
  assert.equal(summary.flashes, 3);
  assert.equal(summary.windowSeconds, 60);
  assert.deepEqual(summary.satellites, ['G19', 'G18']);
  assert.deepEqual(summary.breakdown, [
    { name: 'Faint', count: 1 },
    { name: 'Moderate', count: 1 },
    { name: 'Bright', count: 1 },
  ]);
});

test('coverage names the satellites so an unobserved hemisphere is not read as calm', () => {
  // GOES sees the Americas only. A flash count with no coverage statement lets
  // an empty Europe read as "no lightning" when it means "not looked at".
  const both = summarizeFlashes(parseFlashes(payload()));
  assert.equal(coverageText(both), 'GOES-19 East + GOES-18 West');

  const one = summarizeFlashes(
    parseFlashes(payload({ satellites: [{ id: 'G19' }], missing: ['G18'] })),
  );
  assert.ok(coverageText(one).includes('not reporting'));
  assert.ok(coverageText(one).includes('GOES-18 West'));

  assert.equal(
    coverageText({ satellites: [], missing: ['G19', 'G18'] }),
    'no satellite reporting',
  );
  assert.equal(coverageText(null), 'no satellite reporting');
});

test('satellite ids resolve to names and an unknown id passes through', () => {
  assert.equal(satelliteName('G19'), 'GOES-19 East');
  assert.equal(satelliteName('g18'), 'GOES-18 West');
  assert.equal(satelliteName('G99'), 'G99');
  assert.equal(satelliteName(null), '');
});

test('the card calls the energy a relative unit rather than a physical one', () => {
  // GLM reports a scaled instrument value, not joules. Presenting it as an
  // absolute measurement would be inventing precision.
  const [flash] = parseFlashes(
    payload({ flashes: [{ lat: 1, lon: 2, energy: 57, sat: 'G19' }] }),
  );
  const card = flashLabelText(flash);
  assert.ok(card.includes('relative units'));
  assert.ok(card.includes('GOES-19 East'));
});

test('an empty sky parses without inventing a window', () => {
  const rows = parseFlashes({ flashes: [], satellites: [], missing: [] });
  assert.equal(rows.length, 0);
  const summary = summarizeFlashes(rows);
  assert.equal(summary.flashes, 0);
  assert.deepEqual(summary.breakdown, []);
});

test('a malformed payload is empty rather than throwing', () => {
  assert.equal(parseFlashes(null).length, 0);
  assert.equal(parseFlashes({}).length, 0);
  assert.equal(parseFlashes({ flashes: 'nope' }).length, 0);
});

test('the proxy error body is an error, not a calm planet', () => {
  const source = createLightningSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: 'upstream_failed' }),
    }),
  });
  return assert.rejects(() => source.fetchFlashes(), /upstream_failed/);
});

test('an HTTP failure surfaces rather than emptying the map', () => {
  const source = createLightningSource({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  return assert.rejects(() => source.fetchFlashes(), /503/);
});

test('the source reads through the proxy, never S3 directly', () => {
  // S3 does send CORS headers, so a direct fetch would work — it would just be
  // 400 KB of HDF5 per twenty seconds and a WASM reader in the browser.
  let asked = null;
  const source = createLightningSource({
    fetchImpl: async (url) => {
      asked = url;
      return { ok: true, json: async () => ({ flashes: [] }) };
    },
  });
  return source.fetchFlashes().then(() => {
    assert.ok(asked.startsWith('/api/lightning/'), asked);
    assert.ok(!asked.includes('amazonaws.com'), asked);
  });
});

test('a caller abort is honoured', async () => {
  const controller = new AbortController();
  const source = createLightningSource({
    fetchImpl: (url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  const pending = source.fetchFlashes({ signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /aborted/);
});
