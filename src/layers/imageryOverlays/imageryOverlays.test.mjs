import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGERY_OVERLAYS,
  gibsTemplate,
  rainviewerLatest,
  recentGibsDate,
} from './policy.js';
import { createImageryOverlayLayer } from './index.js';

test('GIBS templates and recent date are well formed', () => {
  assert.equal(
    recentGibsDate(Date.parse('2026-09-17T00:00:00Z')),
    '2026-09-16',
  );
  const url = gibsTemplate(
    'X',
    'GoogleMapsCompatible_Level9',
    'jpg',
    '2026-09-16',
  );
  assert.match(
    url,
    /epsg3857\/best\/X\/default\/2026-09-16\/GoogleMapsCompatible_Level9\/\{z\}\/\{y\}\/\{x\}\.jpg$/,
  );
  // The three overlays each resolve to a usable tile config.
  const byId = Object.fromEntries(IMAGERY_OVERLAYS.map((d) => [d.id, d]));
  assert.deepEqual(IMAGERY_OVERLAYS.map((d) => d.token).sort(), [
    '1',
    '2',
    '3',
  ]);
  assert.match(byId['imagery-goes'].name, /GOES/);
});

test('rainviewerLatest picks the newest frame and builds a tile url', () => {
  const cfg = rainviewerLatest({
    host: 'https://tilecache.rainviewer.com',
    radar: {
      past: [
        { time: 1, path: '/v2/radar/a' },
        { time: 2, path: '/v2/radar/b' },
      ],
    },
  });
  assert.equal(
    cfg.url,
    'https://tilecache.rainviewer.com/v2/radar/b/256/{z}/{x}/{y}/2/1_1.png',
  );
  assert.equal(cfg.frameTime, 2);
  assert.equal(rainviewerLatest({ host: '', radar: {} }), null);
});

function fakeViewer() {
  const layers = [];
  return {
    layers,
    scene: { requestRender() {} },
    imageryLayers: {
      add: (l) => layers.push(l),
      remove: (l) => {
        const i = layers.indexOf(l);
        if (i >= 0) layers.splice(i, 1);
        return i >= 0;
      },
    },
  };
}

test('the overlay layer adds one imagery layer on enable, swaps on update, removes on disable', async () => {
  const built = [];
  const viewer = fakeViewer();
  const layer = createImageryOverlayLayer({
    descriptor: IMAGERY_OVERLAYS[2], // radar (has frameTime)
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        host: 'https://h',
        radar: { past: [{ time: 100, path: '/v2/radar/z' }] },
      }),
    }),
    providerFactory: (url) => {
      built.push(url);
      return { url };
    },
    imageryLayerFactory: (provider, opts) => ({ provider, opts }),
  });
  layer.init(viewer);
  await layer.enable(viewer);
  assert.equal(viewer.layers.length, 1, 'one imagery layer added');
  assert.equal(layer.getStats().count, 1);
  assert.match(layer.getStats().coverage, /frame /);
  await layer.update();
  assert.equal(viewer.layers.length, 1, 'update swaps in place, no stacking');
  assert.equal(built.length, 2, 'a fresh provider was built on update');
  layer.disable();
  assert.equal(viewer.layers.length, 0, 'disable removes the layer');
  assert.equal(layer.getStats().count, 0);
});

test('a load failure is reported, not thrown', async () => {
  const viewer = fakeViewer();
  const layer = createImageryOverlayLayer({
    descriptor: IMAGERY_OVERLAYS[2],
    fetchImpl: async () => ({ ok: false, status: 503 }),
    providerFactory: (url) => ({ url }),
    imageryLayerFactory: (p) => p,
  });
  layer.init(viewer);
  await layer.enable(viewer);
  assert.equal(viewer.layers.length, 0);
  assert.match(layer.getStats().error, /503/);
});
