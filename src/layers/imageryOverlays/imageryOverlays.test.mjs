import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_IMAGERY_PRODUCTS,
  clampToAvailable,
  IMAGERY_OVERLAYS,
  IMAGERY_SLOTS,
  IMAGERY_SLOT_ORDER,
  gibsTileUrl,
  isArchived,
  liveTimeFor,
  productFor,
  isWms,
  rainviewerLatest,
  wmsParameters,
  slotCodec,
} from './policy.js';
import {
  createImageryOverlayLayer,
  createSurfaceCoordinator,
} from './index.js';

/** A map controller double that mirrors the real photoreal/globe behaviour. */
function fakeStackController({ active = 'photoreal' } = {}) {
  const calls = [];
  const ctrl = {
    calls,
    viewer: { scene: { globe: { show: active !== 'photoreal' } } },
    getActiveId: () => active,
    getStacks: () => [
      { id: 'photoreal' },
      { id: 'esri-imagery' },
      { id: 'osm' },
    ],
    isStackAvailable: (id) => ['photoreal', 'esri-imagery', 'osm'].includes(id),
    setStack: async (id) => {
      calls.push(id);
      active = id;
      ctrl.viewer.scene.globe.show = id !== 'photoreal';
    },
  };
  return ctrl;
}

const AT = Date.parse('2026-09-18T06:40:00Z');
const radarDescriptor = IMAGERY_OVERLAYS.find((d) => d.id === 'imagery-radar');

test('every catalog product is completely and consistently described', () => {
  assert.ok(ALL_IMAGERY_PRODUCTS.length >= 20);
  const keys = new Set();
  for (const p of ALL_IMAGERY_PRODUCTS) {
    assert.ok(!keys.has(p.key), `duplicate product key ${p.key}`);
    keys.add(p.key);
    // Every product needs describing; only the GIBS ones carry tile identity,
    // since a WMS product is addressed by layer name instead.
    for (const field of ['label', 'platform', 'instrument', 'reveals']) {
      assert.equal(typeof p[field], 'string', `${p.key} missing ${field}`);
      assert.ok(p[field].length, `${p.key} has an empty ${field}`);
    }
    if (!isWms(p)) {
      for (const field of ['gibsId', 'matrixSet', 'ext']) {
        assert.equal(typeof p[field], 'string', `${p.key} missing ${field}`);
        assert.ok(p[field].length, `${p.key} has an empty ${field}`);
      }
      assert.ok(['jpg', 'png'].includes(p.ext), `${p.key} odd extension`);
    }
    assert.ok(Number.isInteger(p.maximumLevel), `${p.key} maximumLevel`);
    assert.ok(
      ['daily', 'rolling', 'static', 'composite'].includes(p.cadence),
      `${p.key} cadence`,
    );
    // The matrix set has to agree with the zoom ceiling, or tiles are
    // requested at levels the product does not publish.
    if (!isWms(p)) {
      assert.match(
        p.matrixSet,
        new RegExp(`_Level${p.maximumLevel}$`),
        `${p.key}: matrixSet ${p.matrixSet} disagrees with maximumLevel ${p.maximumLevel}`,
      );
    }
    if (p.cadence === 'daily') {
      assert.ok(
        Number.isInteger(p.lagDays) && p.lagDays >= 0,
        `${p.key} is daily and must carry a measured lagDays`,
      );
      assert.match(p.archive, /^\d{4}-\d{2}-\d{2}$/, `${p.key} archive date`);
    }
  }
});

test('the deep radar products are declared sparse and lagged in weeks', () => {
  const sar = productFor('imagery-viirs', 'opera-sar');
  const flood = productFor('imagery-science', 'flood-extent');
  // Sentinel-1 images strips, not the globe, and OPERA processing lands weeks
  // after the pass - both have to be declared or they read as broken.
  for (const p of [sar, flood]) {
    assert.equal(p.sparse, true, `${p.key} must declare partial coverage`);
    assert.ok(p.lagDays >= 10, `${p.key} lag is in weeks, not days`);
    assert.equal(p.maximumLevel, 12, `${p.key} is the deep-zoom product`);
  }
  // The lag ceiling must not clamp them to a date they have not published.
  assert.equal(
    liveTimeFor(flood, Date.parse('2026-09-18T16:45:00Z')),
    '2026-08-26',
  );
  assert.equal(
    liveTimeFor(sar, Date.parse('2026-09-18T16:45:00Z')),
    '2026-09-08',
  );
});

test('a daylight-only band is flagged, because night is not a failure', () => {
  assert.equal(productFor('imagery-goes', 'himawari-vis').daylightOnly, true);
  // GeoColor switches to infrared after dark, so it is not daylight-limited.
  assert.notEqual(
    productFor('imagery-goes', 'goes-east-geo').daylightOnly,
    true,
  );
});

test('EUMETView products resolve to a WMS provider, addressed by instant', async () => {
  const wmsCalls = [];
  const viewer = fakeViewer();
  const layer = createImageryOverlayLayer({
    descriptor: IMAGERY_OVERLAYS.find((d) => d.id === 'imagery-goes'),
    now: () => Date.parse('2026-09-18T17:05:00Z'),
    surface: createSurfaceCoordinator(),
    providerFactory: (url) => ({ url }),
    wmsProviderFactory: (opts) => {
      wmsCalls.push(opts);
      return opts;
    },
    imageryLayerFactory: (provider, opts) => ({ provider, opts }),
  });
  layer.init(viewer);
  await layer.setSensor('georing-natural');
  await layer.enable(viewer);
  assert.equal(
    wmsCalls.length,
    1,
    'a WMS product must not go through the tile path',
  );
  const call = wmsCalls[0];
  assert.match(call.url, /view\.eumetsat\.int/);
  assert.equal(call.layers, 'mumi:wideareacoverage_rgb_natural');
  assert.equal(call.parameters.transparent, true);
  // No TIME at all: the service's own default is the newest frame.
  assert.equal(call.parameters.TIME, undefined);

  // Switching back to a GIBS product returns to the tile-template path.
  await layer.setSensor('goes-east-geo');
  assert.equal(wmsCalls.length, 1);
});

test('EUMETView asks for the service default; only Sentinel-2 takes a window', () => {
  const at = Date.parse('2026-09-18T17:40:00Z');
  // EUMETView's default resolves to its newest frame and does so reliably.
  // Pinning an instant is strictly worse: missing frames return HTTP 502, so
  // it introduces the failure it was meant to prevent.
  assert.deepEqual(
    wmsParameters(productFor('imagery-goes', 'meteosat-geocolour'), at),
    {},
  );
  // Sentinel-2 has no newest-frame to ask for - it composites the clearest
  // pass inside a window, so an instant would usually return nothing.
  const s2 = wmsParameters(productFor('imagery-viirs', 'sentinel2-true'), at);
  assert.equal(s2.TIME, '2026-06-20/2026-09-18');
  assert.equal(s2.MAXCC, '20');
});

test('the geostationary slot now covers the whole ring, not just the Americas', () => {
  const geo = IMAGERY_SLOTS['imagery-goes'].products;
  const platforms = geo.map((p) => p.platform).join(' ');
  assert.match(platforms, /GOES/);
  assert.match(platforms, /Himawari/, 'west Pacific');
  assert.match(platforms, /Meteosat/, 'Europe, Africa and the Indian Ocean');
  // Every EUMETView product must name a WMS layer and a scan interval, or its
  // time cannot be computed and it silently serves blanks.
  for (const p of geo.filter(isWms)) {
    assert.ok(p.wmsLayer, `${p.key} needs a wmsLayer`);
    assert.equal(p.cadence, 'rolling');
  }
});

test('every keyed product routes through the proxy, never the service directly', () => {
  for (const p of ALL_IMAGERY_PRODUCTS.filter((x) => x.requiresKey)) {
    assert.ok(
      p.wmsUrl && p.wmsUrl.startsWith('/api/'),
      `${p.key} must go through our proxy so its secret stays server side`,
    );
  }
});

test('URL codes are unique within each slot', () => {
  for (const slotId of IMAGERY_SLOT_ORDER) {
    const { codes, values, defaultKey } = slotCodec(slotId);
    const seen = new Set();
    for (const [key, code] of Object.entries(codes)) {
      assert.equal(code.length, 1, `${key} code must be one char`);
      assert.ok(!seen.has(code), `${slotId}: duplicate code ${code}`);
      seen.add(code);
    }
    assert.ok(values.includes(defaultKey), `${slotId} default not in values`);
  }
});

test('live time asks GIBS for default only when that is not today', () => {
  // Rolling and static feeds are addressed by their own latest frame.
  assert.equal(
    liveTimeFor(productFor('imagery-goes', 'goes-east-geo'), AT),
    'default',
  );
  assert.equal(
    liveTimeFor(productFor('imagery-viirs', 'black-marble'), AT),
    'default',
  );
  // Daily products must NOT use `default` — that means today, whose mosaic is
  // still being stitched and comes back black. Each steps back its own lag.
  assert.equal(
    liveTimeFor(productFor('imagery-viirs', 'viirs-n20-true'), AT),
    '2026-09-17',
  );
  assert.equal(
    liveTimeFor(productFor('imagery-science', 'snow-cover'), AT),
    '2026-09-15',
  );
  assert.equal(
    liveTimeFor(productFor('imagery-science', 'sst'), AT),
    '2026-09-16',
  );
  // Month and year boundaries step back properly.
  assert.equal(
    liveTimeFor(
      productFor('imagery-science', 'snow-cover'),
      Date.parse('2026-01-01T00:30:00Z'),
    ),
    '2025-12-29',
  );
});

test('tile URLs carry the product, matrix set, time and extension', () => {
  const product = productFor('imagery-viirs', 'viirs-n20-fire');
  assert.equal(
    gibsTileUrl(product, '2026-09-17'),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1/default/2026-09-17/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
  );
});

test('an unknown product key degrades to the slot default, never to nothing', () => {
  assert.equal(
    productFor('imagery-viirs', 'retired-sensor').key,
    'viirs-n20-true',
  );
  assert.equal(productFor('imagery-viirs', null).key, 'viirs-n20-true');
  assert.equal(productFor('no-such-slot', 'x'), null);
});

test('only daily products are archived', () => {
  assert.equal(
    isArchived(productFor('imagery-viirs', 'modis-terra-true')),
    true,
  );
  assert.equal(isArchived(productFor('imagery-goes', 'goes-east-geo')), false);
  assert.equal(isArchived(productFor('imagery-viirs', 'black-marble')), false);
});

test('overlay descriptors cover four distinct slots and tokens', () => {
  assert.deepEqual(IMAGERY_OVERLAYS.map((d) => d.id).sort(), [
    'imagery-goes',
    'imagery-radar',
    'imagery-science',
    'imagery-viirs',
  ]);
  assert.deepEqual(IMAGERY_OVERLAYS.map((d) => d.token).sort(), [
    '1',
    '2',
    '3',
    '7',
  ]);
  // The slot names must not claim a single instrument they no longer carry.
  assert.doesNotMatch(
    IMAGERY_OVERLAYS.find((d) => d.id === 'imagery-viirs').name,
    /VIIRS/,
    'the orbital slot also carries MODIS, so its name must not say VIIRS',
  );
  assert.equal(Object.keys(IMAGERY_SLOTS).length, 3);
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
  // RainViewer serves radar to zoom 7 and answers deeper requests with an
  // HTTP 200 placeholder tile ("Zoom Level Not Supported") that Cesium would
  // paint over the whole view. The cap is the provider's documented maximum.
  assert.equal(cfg.maximumLevel, 7, 'radar stops where RainViewer stops');
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

function slotLayer(id, { built = [] } = {}) {
  const viewer = fakeViewer();
  const layer = createImageryOverlayLayer({
    descriptor: IMAGERY_OVERLAYS.find((d) => d.id === id),
    now: () => AT,
    providerFactory: (url, opts) => {
      built.push({ url, opts });
      return { url };
    },
    imageryLayerFactory: (provider, opts) => ({ provider, opts }),
  });
  layer.init(viewer);
  return { layer, viewer, built };
}

test('the overlay layer adds one imagery layer on enable, swaps on update, removes on disable', async () => {
  const built = [];
  const viewer = fakeViewer();
  const layer = createImageryOverlayLayer({
    descriptor: radarDescriptor,
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
    descriptor: radarDescriptor,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    providerFactory: (url) => ({ url }),
    imageryLayerFactory: (p) => p,
  });
  layer.init(viewer);
  await layer.enable(viewer);
  assert.equal(viewer.layers.length, 0);
  assert.match(layer.getStats().error, /503/);
});

test('switching sensor swaps the provider without ever leaving the scene empty', async () => {
  const { layer, viewer, built } = slotLayer('imagery-viirs');
  await layer.enable(viewer);
  assert.equal(layer.getSensor(), 'viirs-n20-true');
  assert.match(built.at(-1).url, /VIIRS_NOAA20_CorrectedReflectance_TrueColor/);

  const changed = await layer.setSensor('modis-terra-true');
  assert.equal(changed, true);
  assert.equal(
    viewer.layers.length,
    1,
    'exactly one imagery layer throughout the switch — never zero, never two',
  );
  assert.match(built.at(-1).url, /MODIS_Terra_CorrectedReflectance_TrueColor/);
  assert.equal(layer.getSensor(), 'modis-terra-true');

  // Re-selecting the same sensor is a no-op rather than a needless rebuild.
  const before = built.length;
  assert.equal(await layer.setSensor('modis-terra-true'), false);
  assert.equal(built.length, before);
});

test('a product may override its slot opacity', async () => {
  const { layer, viewer } = slotLayer('imagery-science');
  await layer.enable(viewer);
  // Science products are drawn semi-transparent so imagery beneath still reads.
  const alpha = viewer.layers.at(-1).opts.alpha;
  assert.ok(
    alpha > 0 && alpha < 1,
    `expected a translucent overlay, got ${alpha}`,
  );

  // The opaque slots stay opaque, or true colour would wash out over the globe.
  const orbital = slotLayer('imagery-viirs');
  await orbital.layer.enable(orbital.viewer);
  assert.equal(orbital.viewer.layers.at(-1).opts.alpha, 1);
});

test('time-awareness follows the selected product, not the slot', async () => {
  const { layer, viewer } = slotLayer('imagery-goes');
  await layer.enable(viewer);
  // GOES GeoColor has no daily archive...
  assert.equal(layer.isTimeAware(), false);
  assert.equal(await layer.setDisplayDate('2026-09-10'), false);

  const orbital = slotLayer('imagery-viirs');
  await orbital.layer.enable(orbital.viewer);
  assert.equal(orbital.layer.isTimeAware(), true);
  assert.equal(await orbital.layer.setDisplayDate('2026-09-10'), true);
  assert.match(orbital.built.at(-1).url, /\/2026-09-10\//);
  assert.equal(orbital.layer.getDisplayDate(), '2026-09-10');
});

test('scrubbing to a day then switching to an unarchived sensor drops the pin', async () => {
  const { layer, viewer, built } = slotLayer('imagery-viirs');
  await layer.enable(viewer);
  await layer.setDisplayDate('2026-09-10');
  assert.equal(layer.getDisplayDate(), '2026-09-10');

  // Black Marble is a fixed composite — a pinned day would be meaningless, and
  // leaving it set would strand TIMELINE reading ARCHIVE over a static image.
  await layer.setSensor('black-marble');
  assert.equal(layer.getDisplayDate(), null);
  assert.equal(layer.isTimeAware(), false);
  assert.match(built.at(-1).url, /VIIRS_Black_Marble\/default\/default\//);
});

test('a scrubbed day is clamped into what the product can actually serve', () => {
  const snow = productFor('imagery-science', 'snow-cover');
  // TIMELINE's first step back is two days ago, which snow cover (3 days
  // behind) has not published — it must show its newest real frame, not black.
  assert.equal(clampToAvailable(snow, '2026-09-16', AT), '2026-09-15');
  assert.equal(clampToAvailable(snow, '2026-09-10', AT), '2026-09-10');
  // The far end is clamped to each product's own archive start.
  assert.equal(
    clampToAvailable(
      productFor('imagery-viirs', 'viirs-n20-true'),
      '1999-01-01',
      AT,
    ),
    '2018-01-05',
  );
  assert.equal(
    clampToAvailable(
      productFor('imagery-viirs', 'modis-terra-true'),
      '1999-01-01',
      AT,
    ),
    '2000-02-24',
  );
});

test('the layer applies that clamp when TIMELINE scrubs a lagging product', async () => {
  const { layer, viewer, built } = slotLayer('imagery-science');
  await layer.setSensor('snow-cover');
  await layer.enable(viewer);
  await layer.setDisplayDate('2026-09-16');
  assert.match(
    built.at(-1).url,
    /\/2026-09-15\//,
    'asked for a day snow cover has not published; must fall back to its newest',
  );
});

function surfaceLayer(id, surface) {
  const viewer = fakeViewer();
  const layer = createImageryOverlayLayer({
    descriptor: IMAGERY_OVERLAYS.find((d) => d.id === id),
    now: () => AT,
    surface,
    providerFactory: (url) => ({ url }),
    imageryLayerFactory: (provider, opts) => ({ provider, opts }),
  });
  layer.init(viewer);
  return { layer, viewer };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('enabling an overlay borrows a surface that can actually show it', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  const { layer, viewer } = surfaceLayer('imagery-viirs', surface);
  await layer.enable(viewer);
  // Under photoreal the globe is hidden and imagery draws nothing at all, so
  // enabling must move to a globe stack or the layer is silently dead.
  assert.deepEqual(ctrl.calls, ['esri-imagery']);
  assert.equal(layer.getSurfaceChange().switched, true);
  assert.equal(layer.getSurfaceChange().from, 'photoreal');

  layer.disable();
  await tick();
  assert.deepEqual(
    ctrl.calls,
    ['esri-imagery', 'photoreal'],
    'the last overlay off must hand the photorealistic basemap back',
  );
});

test('a second overlay does not switch again, and only the last one restores', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  const a = surfaceLayer('imagery-viirs', surface);
  const b = surfaceLayer('imagery-science', surface);
  await a.layer.enable(a.viewer);
  await b.layer.enable(b.viewer);
  assert.deepEqual(ctrl.calls, ['esri-imagery'], 'one switch for two overlays');

  a.layer.disable();
  await tick();
  assert.deepEqual(ctrl.calls, ['esri-imagery'], 'one overlay still needs it');

  b.layer.disable();
  await tick();
  assert.deepEqual(ctrl.calls, ['esri-imagery', 'photoreal']);
});

test('a basemap the user chose by hand is never yanked back', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  await surface.retain();
  assert.deepEqual(ctrl.calls, ['esri-imagery']);
  // The user then picks OSM deliberately while imagery is on.
  await ctrl.setStack('osm');
  const released = await surface.release();
  assert.equal(released.restored, false);
  assert.deepEqual(ctrl.calls, ['esri-imagery', 'osm'], 'their choice stands');
});

test('starting on a globe stack costs nothing', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'esri-imagery' });
  surface.attach(ctrl);
  const result = await surface.retain();
  assert.equal(result.switched, false);
  assert.deepEqual(
    ctrl.calls,
    [],
    'no switch when imagery can already be seen',
  );
  await surface.release();
  assert.deepEqual(ctrl.calls, []);
});

test('radar has no sensors to switch between', async () => {
  const viewer = fakeViewer();
  const layer = createImageryOverlayLayer({
    descriptor: radarDescriptor,
    fetchImpl: async () => ({ ok: false, status: 500 }),
    providerFactory: (url) => ({ url }),
    imageryLayerFactory: (p) => p,
  });
  layer.init(viewer);
  assert.equal(layer.hasSensors(), false);
  assert.deepEqual(layer.listSensors(), []);
  assert.equal(layer.getSensor(), null);
  assert.equal(await layer.setSensor('anything'), false);
});
