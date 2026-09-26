import test from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { createSatelliteSource } from './source.js';
import { createSatellitesLayer } from './index.js';

test('satellite sources confine catalog groups and reject a cancelled body', async () => {
  const controller = new AbortController();
  let requests = 0;
  const source = createSatelliteSource({
    fetchImpl: async (url) => {
      requests++;
      assert.equal(url, '/api/celestrak/stations');
      return {
        ok: true,
        status: 200,
        text: async () => {
          controller.abort();
          return 'late catalog';
        },
      };
    },
  });
  await assert.rejects(
    source.readGroup('../active'),
    /Unknown satellite group/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    source.readGroup('stations', { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('satellite factories keep control state separate and construct without requests', () => {
  const source = {
    readGroup() {
      assert.fail('construction fetched a catalog');
    },
  };
  const services = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  services.layerState.isExplicitLayerStateOrigin = () => false;
  const first = createSatellitesLayer({ source, services });
  const second = createSatellitesLayer({ source, services });
  first.setParams({ showPoints: false });
  assert.equal(first.getParams().showPoints, false);
  assert.equal(second.getParams().showPoints, true);
  assert.notEqual(first.getStats(), second.getStats());
});

/** The harness the two factory tests above use, without the fetch trap. */
function buildLayer() {
  const services = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  services.layerState.isExplicitLayerStateOrigin = () => false;
  return createSatellitesLayer({ source: { readGroup() {} }, services });
}

test('the ISS stream chip is absent until a host installs an opener', () => {
  // A headless or embedded host cannot open a frame, so it must not be shown a
  // button for one. The chip is offered only once something can honour it.
  const layer = buildLayer();
  const before = layer.getRowControls().chips.map((c) => c.id);
  assert.ok(!before.includes('iss-stream'), before.join(','));
});

test('the ISS stream chip is still absent when the ISS is not in the catalog', () => {
  // A live-feed button for a satellite this layer is not tracking promises
  // something that is not on screen.
  const layer = buildLayer();
  layer.setIssStreamOpener(() => {});
  // No _seedIssCatalogForTest here: that is the point of the test.
  const chips = layer.getRowControls().chips.map((c) => c.id);
  assert.ok(!chips.includes('iss-stream'), chips.join(','));
});

test('the ISS stream chip hands the dock a framable NASA URL', async () => {
  const layer = buildLayer();
  const opened = [];
  layer.setIssStreamOpener((url, meta) => opened.push({ url, meta }));
  layer._seedIssCatalogForTest();
  const chip = layer.getRowControls().chips.find((c) => c.id === 'iss-stream');
  assert.ok(chip, 'the chip must appear once the ISS is in the catalog');
  chip.onClick();
  assert.equal(opened.length, 1);
  const { url, meta } = opened[0];
  // youtube-nocookie is the tracking-free host and the one already allowlisted.
  assert.ok(url.startsWith('https://www.youtube-nocookie.com/embed/'), url);
  // The label must not promise a camera: HDEV was decommissioned and what
  // streams now alternates with mission coverage.
  assert.ok(!/camera/i.test(meta.title), meta.title);
  assert.equal(meta.layerId, 'satellites');
});

test('a non-function opener detaches the chip rather than throwing', () => {
  const layer = buildLayer();
  layer._seedIssCatalogForTest();
  layer.setIssStreamOpener(() => {});
  assert.ok(
    layer.getRowControls().chips.some((c) => c.id === 'iss-stream'),
    'precondition: the chip is present before detaching',
  );
  layer.setIssStreamOpener(null);
  const chips = layer.getRowControls().chips.map((c) => c.id);
  assert.ok(!chips.includes('iss-stream'));
});

test('satellite pass prediction methods report no-tle on cold catalog and coerce IDs', () => {
  const source = { readGroup() {} };
  const services = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  services.layerState.isExplicitLayerStateOrigin = () => false;
  const layer = createSatellitesLayer({ source, services });

  // Cold catalog (no satellites loaded yet)
  assert.deepEqual(layer.getNextIssPass({ latDeg: 30, lonDeg: -97 }), {
    status: 'no-tle',
  });
  assert.deepEqual(
    layer.getNextSatellitePass(25544, { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );

  // String NORAD ID coercion
  assert.deepEqual(
    layer.getNextSatellitePass('25544', { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );

  // Invalid / non-finite ID handling
  assert.deepEqual(
    layer.getNextSatellitePass(NaN, { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );
  assert.deepEqual(
    layer.getNextSatellitePass(null, { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );

  // Populated catalog: verify numeric and string coercion succeed
  const L1 =
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
  const L2 =
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
  const satrec = twoline2satrec(L1, L2);
  layer._setTrackedSatelliteRefreshStateForTest({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    satrec,
  });

  const FROM_MS = 1221868800000;
  const numericResult = layer.getNextSatellitePass(25544, {
    latDeg: 30.2672,
    lonDeg: -97.7431,
    fromMs: FROM_MS,
  });
  assert.equal(numericResult.status, 'ok');
  assert.ok(numericResult.pass);

  const stringResult = layer.getNextSatellitePass('25544', {
    latDeg: 30.2672,
    lonDeg: -97.7431,
    fromMs: FROM_MS,
  });
  assert.equal(stringResult.status, 'ok');
  assert.deepEqual(stringResult, numericResult);

  const issResult = layer.getNextIssPass({
    latDeg: 30.2672,
    lonDeg: -97.7431,
    fromMs: FROM_MS,
  });
  assert.equal(issResult.status, 'ok');
  assert.deepEqual(issResult, numericResult);

  layer._setTrackedSatelliteRefreshStateForTest({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    satrec,
    neighbours: [
      { noradId: 10, name: 'STARLINK ONE', satrec },
      { noradId: 11, name: 'STARLINK TWO', satrec },
    ],
  });
  assert.equal(layer.resolveSatelliteForPass('25544').noradId, 25544);
  assert.equal(layer.resolveSatelliteForPass('iss (zarya)').noradId, 25544);
  assert.equal(layer.resolveSatelliteForPass('starlink').status, 'ambiguous');
  assert.equal(layer.resolveSatelliteForPass('starlink').totalMatches, 2);
  assert.equal(layer.resolveSatelliteForPass('STARLINK ONE').noradId, 10);
  assert.equal(layer.resolveSatelliteForPass('missing').status, 'not-found');
  layer._clearDenseCatalogStateForTest();
  assert.equal(layer.resolveSatelliteForPass('25544').status, 'not-found');

  // Non-existent satellite ID in populated catalog
  assert.deepEqual(
    layer.getNextSatellitePass(99999, {
      latDeg: 30.2672,
      lonDeg: -97.7431,
      fromMs: FROM_MS,
    }),
    { status: 'no-tle' },
  );
});
