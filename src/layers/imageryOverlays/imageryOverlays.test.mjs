import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_IMAGERY_PRODUCTS,
  clampToAvailable,
  drapeSourceFor,
  EUMETVIEW_WMS,
  GIBS_WMS,
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
  zoomFloorFor,
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

test('Sentinel-2 declares the service ceiling and is not asked for anything coarser', async () => {
  // Sentinel Hub renders Sentinel-2 "up to 200 m/px" and answers a coarser
  // request with a picture of the error, which the globe painted as imagery:
  // every tile of every Sentinel-2 product, worldwide, was red text until
  // you were zoomed in past the limit. Level 5 is 2445.98 m/px — the figure
  // in the error itself; level 9 (152.87 m/px) is the first level under it.
  const s2 = ALL_IMAGERY_PRODUCTS.filter((p) => p.service === 'copernicus');
  assert.ok(s2.length >= 8);
  for (const p of s2) {
    assert.equal(p.maxMetersPerPixel, 200, `${p.key} carries the ceiling`);
    assert.deepEqual(zoomFloorFor(p), {
      minimumLevel: 9,
      minimumTerrainLevel: 9,
    });
  }
  // Nothing else is limited this way, and nothing else gets a floor.
  for (const p of ALL_IMAGERY_PRODUCTS.filter(
    (x) => x.service !== 'copernicus',
  )) {
    assert.equal(zoomFloorFor(p), null, `${p.key} has no floor`);
  }
  assert.equal(zoomFloorFor({ maxMetersPerPixel: 0 }), null);
  assert.equal(zoomFloorFor({ maxMetersPerPixel: 1e9 }).minimumLevel, 0);

  // The floor reaches both the provider (which level to request) and the
  // layer (whether to draw at all); EUMETView, unlimited, gets neither.
  const wmsCalls = [];
  const layers = [];
  const viewer = fakeViewer();
  const build = (id) =>
    createImageryOverlayLayer({
      descriptor: IMAGERY_OVERLAYS.find((d) => d.id === id),
      now: () => AT,
      surface: createSurfaceCoordinator(),
      providerFactory: (url) => ({ url }),
      wmsProviderFactory: (opts) => {
        wmsCalls.push(opts);
        return opts;
      },
      imageryLayerFactory: (provider, opts) => {
        layers.push(opts);
        return { provider, opts };
      },
    });
  const orbital = build('imagery-viirs');
  orbital.init(viewer);
  await orbital.setSensor('sentinel2-true');
  await orbital.enable(viewer);
  assert.equal(wmsCalls.at(-1).minimumLevel, 9);
  assert.equal(wmsCalls.at(-1).maximumLevel, 15);
  assert.equal(layers.at(-1).minimumTerrainLevel, 9);

  const geo = build('imagery-goes');
  geo.init(viewer);
  await geo.setSensor('meteosat-geocolour');
  await geo.enable(viewer);
  assert.equal(wmsCalls.at(-1).minimumLevel, undefined);
  assert.equal(layers.at(-1).minimumTerrainLevel, undefined);
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

test('every catalog product can be asked for as one image', () => {
  // A drape needs a picture, not a pyramid. If a product could not be
  // expressed as a WMS layer it would have to keep taking the basemap away,
  // so this is the property that makes draping a rule rather than a favour.
  const missing = [];
  for (const [slotId, slot] of Object.entries(IMAGERY_SLOTS))
    for (const product of slot.products)
      if (!drapeSourceFor(product)) missing.push(`${slotId}/${product.key}`);
  assert.deepEqual(missing, []);
});

test('a GIBS product is draped from the GIBS WMS, by its own layer id', () => {
  const product = productFor('imagery-viirs', 'viirs-n20-fire');
  const source = drapeSourceFor(product, '2026-09-17');
  assert.equal(source.url, GIBS_WMS);
  assert.equal(
    source.layers,
    'VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1',
  );
  assert.deepEqual(source.parameters, { TIME: '2026-09-17' });
});

test("GIBS's latest frame is asked for by saying nothing, not by saying 'default'", () => {
  // `default` is a REST path segment. As a TIME value it is a date GIBS
  // cannot parse, and the request fails rather than returning the newest.
  const source = drapeSourceFor(productFor('imagery-goes', null));
  assert.deepEqual(source.parameters, {});
});

test('an outside WMS product is draped from its own service, with its own terms', () => {
  const product = Object.values(IMAGERY_SLOTS)
    .flatMap((slot) => slot.products)
    .find((entry) => entry.wmsLayer && !entry.gibsId);
  const source = drapeSourceFor(product);
  assert.equal(source.layers, product.wmsLayer);
  assert.equal(source.url, product.wmsUrl || EUMETVIEW_WMS);
});

test('a product naming no layer at all cannot be drawn, and says so', () => {
  assert.equal(drapeSourceFor({ key: 'nothing' }), null);
  assert.equal(drapeSourceFor(null), null);
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

function fakeViewer({ globeShown = true } = {}) {
  const layers = [];
  return {
    layers,
    // The globe's visibility is what decides which renderer can draw, so a
    // viewer double that omits it can only ever test half the behaviour.
    scene: { globe: { show: globeShown }, requestRender() {} },
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

function fakeDrape() {
  const calls = [];
  let showing = false;
  const drape = {
    calls,
    async show(source, options) {
      calls.push(['show', source.layers, options?.alpha]);
      showing = true;
      return true;
    },
    clear() {
      calls.push(['clear']);
      showing = false;
    },
    isShowing: () => showing,
    getLastError: () => null,
    destroy() {
      calls.push(['destroy']);
      showing = false;
    },
  };
  return drape;
}

function surfaceLayer(
  id,
  surface,
  { globeShown = true, drape = null, eventTarget = null } = {},
) {
  const viewer = fakeViewer({ globeShown });
  const events = eventTarget || new EventTarget();
  const layer = createImageryOverlayLayer({
    descriptor: IMAGERY_OVERLAYS.find((d) => d.id === id),
    now: () => AT,
    surface,
    eventTarget: events,
    providerFactory: (url) => ({ url }),
    imageryLayerFactory: (provider, opts) => ({ provider, opts }),
    ...(drape ? { drapeFactory: () => drape } : {}),
  });
  layer.init(viewer);
  return { layer, viewer, events };
}

/** Announce a settled stack change the way the map controller does. */
function announceStack(events) {
  events.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', { detail: { status: 'ready' } }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('an overlay on the 3D surface is draped onto it, not swapped away from it', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  const drape = fakeDrape();
  const { layer, viewer } = surfaceLayer('imagery-viirs', surface, {
    globeShown: false,
    drape,
  });
  await layer.enable(viewer);
  assert.deepEqual(ctrl.calls, [], 'the basemap the user chose is left alone');
  assert.equal(layer.getSurfaceChange().switched, false);
  assert.equal(drape.calls[0][0], 'show');
  assert.equal(viewer.layers.length, 0, 'an imagery layer there draws nothing');

  layer.disable();
  await tick();
  assert.deepEqual(ctrl.calls, [], 'and nothing has to be handed back');
  assert.equal(drape.isShowing(), false);
});

test('a draped overlay releases no hold, so another overlay still gets its surface back', async () => {
  // Release is counted. A drape that released a surface it never took would
  // decrement the radar overlay's hold, and radar's own disable would then
  // find the count already at zero and never restore the basemap.
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  const borrower = await surface.retain();
  assert.equal(borrower.switched, true);
  assert.deepEqual(ctrl.calls, ['esri-imagery']);

  const { layer, viewer } = surfaceLayer('imagery-viirs', surface, {
    globeShown: false,
    drape: fakeDrape(),
  });
  await layer.enable(viewer);
  layer.disable();
  await tick();
  assert.deepEqual(ctrl.calls, ['esri-imagery'], 'the holder still holds');

  await surface.release();
  assert.deepEqual(ctrl.calls, ['esri-imagery', 'photoreal']);
});

test('an overlay with no single-image form still borrows a surface it can be seen on', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  const viewer = fakeViewer({ globeShown: false });
  const layer = createImageryOverlayLayer({
    descriptor: radarDescriptor,
    surface,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        host: 'https://h',
        radar: { past: [{ time: 100, path: '/v2/radar/z' }] },
      }),
    }),
    providerFactory: (url) => ({ url }),
    imageryLayerFactory: (provider, opts) => ({ provider, opts }),
  });
  layer.init(viewer);
  await layer.enable(viewer);
  assert.deepEqual(ctrl.calls, ['esri-imagery']);
  assert.equal(layer.getSurfaceChange().switched, true);

  layer.disable();
  await tick();
  assert.deepEqual(ctrl.calls, ['esri-imagery', 'photoreal']);
});

test('a second borrower does not switch again, and only the last one restores', async () => {
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

test('leaving the 3D surface hands the overlay back to the imagery layer', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  const drape = fakeDrape();
  const { layer, viewer, events } = surfaceLayer('imagery-viirs', surface, {
    globeShown: false,
    drape,
  });
  layer.attachMapStackController(ctrl);
  await layer.enable(viewer);
  assert.equal(viewer.layers.length, 0);

  // The user picks a globe stack by hand: the globe comes back, and the
  // sharper renderer takes over from the drape.
  viewer.scene.globe.show = true;
  announceStack(events);
  await tick();
  assert.equal(viewer.layers.length, 1, 'the imagery layer draws there');
  assert.equal(drape.isShowing(), false, 'and the drape is taken down');
  layer.destroy();
});

test('arriving at the 3D surface takes down the layer that cannot draw there', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'esri-imagery' });
  surface.attach(ctrl);
  const drape = fakeDrape();
  const { layer, viewer, events } = surfaceLayer('imagery-viirs', surface, {
    globeShown: true,
    drape,
  });
  layer.attachMapStackController(ctrl);
  await layer.enable(viewer);
  assert.equal(viewer.layers.length, 1);

  viewer.scene.globe.show = false;
  announceStack(events);
  await tick();
  assert.equal(viewer.layers.length, 0, 'an inert layer is not left behind');
  assert.equal(drape.isShowing(), true);
  layer.destroy();
});

test('switching sensor while draped redraws the drape, not a dead imagery layer', async () => {
  const surface = createSurfaceCoordinator();
  const drape = fakeDrape();
  const { layer, viewer } = surfaceLayer('imagery-viirs', surface, {
    globeShown: false,
    drape,
  });
  await layer.enable(viewer);
  const first = drape.calls.filter((call) => call[0] === 'show').length;
  await layer.setSensor('modis-terra-true');
  const shows = drape.calls.filter((call) => call[0] === 'show');
  assert.equal(shows.length, first + 1);
  assert.equal(shows.at(-1)[1], 'MODIS_Terra_CorrectedReflectance_TrueColor');
  assert.equal(viewer.layers.length, 0);
});

test('destroying a draped overlay releases its drape and its stack listener', async () => {
  const surface = createSurfaceCoordinator();
  const ctrl = fakeStackController({ active: 'photoreal' });
  surface.attach(ctrl);
  const drape = fakeDrape();
  const { layer, viewer, events } = surfaceLayer('imagery-viirs', surface, {
    globeShown: false,
    drape,
  });
  layer.attachMapStackController(ctrl);
  await layer.enable(viewer);
  layer.destroy();
  assert.ok(drape.calls.some((call) => call[0] === 'destroy'));
  const before = drape.calls.length;
  announceStack(events);
  await tick();
  assert.equal(drape.calls.length, before, 'a dead layer answers nothing');
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

test('a stack switch that hides the globe while imagery is on is taken back, and said', async () => {
  // A share-link restore, a saved visual state or the map tray can put
  // Google 3D back with overlays still on; every overlay then draws nothing
  // with healthy stats. That is exactly "switching bands changes nothing".
  const events = new EventTarget();
  const surface = createSurfaceCoordinator({ eventTarget: events });
  const ctrl = fakeStackController({ active: 'photoreal' });
  const reclaimed = [];
  events.addEventListener('gev:imagery-surface-reclaimed', (e) =>
    reclaimed.push(e.detail),
  );
  surface.attach(ctrl);
  await surface.retain();
  await surface.retain();
  assert.deepEqual(ctrl.calls, ['esri-imagery']);
  // The user (or a restore) picks Google 3D; the controller announces it.
  await ctrl.setStack('photoreal');
  events.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', {
      detail: { status: 'switching', activeId: 'esri-imagery' },
    }),
  );
  await tick();
  assert.deepEqual(
    ctrl.calls,
    ['esri-imagery', 'photoreal'],
    'switching is not yet the truth',
  );
  events.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', {
      detail: { status: 'ready', activeId: 'photoreal' },
    }),
  );
  await tick();
  await tick();
  assert.deepEqual(
    ctrl.calls,
    ['esri-imagery', 'photoreal', 'esri-imagery'],
    'the globe is borrowed again',
  );
  assert.equal(ctrl.viewer.scene.globe.show, true);
  assert.deepEqual(reclaimed, [
    { from: 'photoreal', to: 'esri-imagery', holders: 2 },
  ]);
  // With the globe showing, the same event is a no-op.
  events.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', { detail: { status: 'ready' } }),
  );
  await tick();
  assert.equal(ctrl.calls.length, 3);
  // Once nothing holds the surface, Google 3D is left alone.
  await surface.release();
  await surface.release();
  await tick();
  assert.deepEqual(ctrl.calls.at(-1), 'photoreal', 'the last release restores');
  await ctrl.setStack('photoreal');
  events.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', { detail: { status: 'ready' } }),
  );
  await tick();
  assert.equal(ctrl.calls.filter((c) => c === 'esri-imagery').length, 2);
  assert.equal(reclaimed.length, 1);
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
