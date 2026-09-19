import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOP_FRAMES,
  describeDomainsUrl,
  domainInstants,
  frameConfig,
  frameProbeUrl,
  loopStepMinutes,
  loopWindow,
  loopWindowText,
  probeFrames,
  stepInstants,
} from './frames.js';
import {
  ALL_IMAGERY_PRODUCTS,
  IMAGERY_OVERLAYS,
  createImageryOverlayLayer,
  createSurfaceCoordinator,
  productFor,
} from './index.js';

const NOW = Date.parse('2026-09-19T20:23:40Z');
const GOES = productFor('imagery-goes', 'goes-east-geo');
const MTG = productFor('imagery-goes', 'meteosat-geocolour');
const RING = productFor('imagery-goes', 'georing-natural');

test('every rolling geostationary product says how often its frames come; nothing else loops', () => {
  for (const p of ALL_IMAGERY_PRODUCTS) {
    if (p.cadence === 'rolling' && p.key !== 'rainviewer')
      assert.ok(loopStepMinutes(p), `${p.key} has no loop step`);
    if (p.cadence !== 'rolling')
      assert.equal(loopStepMinutes(p), null, `${p.key} must not loop`);
  }
  assert.equal(loopStepMinutes(GOES), 10);
  assert.equal(loopStepMinutes(MTG), 10);
  assert.equal(loopStepMinutes(RING), 180);
  assert.equal(loopStepMinutes({ cadence: 'rolling' }), null);
  assert.equal(loopStepMinutes(null), null);
});

test('the window is a dozen steps back from now, and says so in hours', () => {
  const w = loopWindow(GOES, NOW);
  assert.equal(w.stepMinutes, 10);
  assert.equal(w.toMs, Date.parse('2026-09-19T20:23:00Z'));
  assert.equal(w.toMs - w.fromMs, LOOP_FRAMES * 10 * 60_000);
  assert.equal(loopWindowText(GOES), 'the last 2 h');
  assert.equal(loopWindowText(RING), 'the last 36 h');
  assert.equal(loopWindowText({ cadence: 'daily' }), '');
  assert.equal(loopWindow({ cadence: 'daily' }, NOW), null);
});

test('stepping a window lands on the step boundaries inside it', () => {
  const from = Date.parse('2026-09-19T18:23:00Z');
  const to = Date.parse('2026-09-19T20:23:00Z');
  const out = stepInstants(from, to, 10);
  assert.equal(out[0], '2026-09-19T18:30:00Z');
  assert.equal(out.at(-1), '2026-09-19T20:20:00Z');
  assert.equal(out.length, 12);
});

test('DescribeDomains is asked for the product over the window, and its answer is expanded', () => {
  const url = new URL(describeDomainsUrl(GOES, NOW - 3600_000, NOW));
  assert.equal(url.origin, 'https://gibs.earthdata.nasa.gov');
  assert.equal(url.searchParams.get('REQUEST'), 'DescribeDomains');
  assert.equal(url.searchParams.get('LAYER'), 'GOES-East_ABI_GeoColor');
  assert.equal(url.searchParams.get('TILEMATRIXSET'), 'GoogleMapsCompatible_Level7');
  assert.match(url.searchParams.get('TIME'), /^2026-09-19T19:23:40Z\/2026-09-19T20:23:40Z$/);

  const from = Date.parse('2026-09-19T19:00:00Z');
  const to = Date.parse('2026-09-19T20:00:00Z');
  // The shape GIBS actually returns: a day-start range at the step.
  const xml =
    "<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-19/2026-09-19T20:00:00Z/PT10M</Domain><Size>1</Size></DimensionDomain></Domains>";
  const got = domainInstants(xml, from, to);
  assert.equal(got[0], '2026-09-19T19:00:00Z');
  assert.equal(got.at(-1), '2026-09-19T20:00:00Z');
  assert.equal(got.length, 7);
  // Ranges with gaps and bare instants, as the capabilities list them.
  const gappy =
    '<Domain>2026-09-19T19:00:00Z/2026-09-19T19:10:00Z/PT10M,2026-09-19T19:40:00Z,2026-09-19T19:50:00Z/2026-09-19T20:00:00Z/PT10M</Domain>';
  assert.deepEqual(domainInstants(gappy, from, to), [
    '2026-09-19T19:00:00Z',
    '2026-09-19T19:10:00Z',
    '2026-09-19T19:40:00Z',
    '2026-09-19T19:50:00Z',
    '2026-09-19T20:00:00Z',
  ]);
  assert.deepEqual(domainInstants('<Domains/>', from, to), []);
  assert.deepEqual(domainInstants(null, from, to), []);
});

test('a frame is probed with one tiny request, and configured the way the live frame is', () => {
  const at = '2026-09-19T19:50:00Z';
  assert.equal(
    frameProbeUrl(GOES, at),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/2026-09-19T19:50:00Z/GoogleMapsCompatible_Level7/0/0/0.png',
  );
  const wms = new URL(frameProbeUrl(MTG, at));
  assert.equal(wms.origin, 'https://view.eumetsat.int');
  assert.equal(wms.searchParams.get('LAYERS'), 'mtg_fd:rgb_geocolour');
  assert.equal(wms.searchParams.get('TIME'), at);
  assert.equal(wms.searchParams.get('WIDTH'), '64');
  const tiles = frameConfig(GOES, at, { credit: 'NASA' });
  assert.match(tiles.url, /default\/2026-09-19T19:50:00Z\/GoogleMapsCompatible_Level7\/\{z\}/);
  assert.equal(tiles.maximumLevel, GOES.maximumLevel);
  const frame = frameConfig(MTG, at, { credit: 'EUMETSAT' });
  assert.equal(frame.wms.layers, 'mtg_fd:rgb_geocolour');
  assert.equal(frame.wms.parameters.TIME, at);
  assert.equal(frame.wms.parameters.transparent, true);
});

test('probing keeps the frames that answer and drops the rest without failing', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.includes('19:20:00Z')) return { ok: false, status: 404 };
    if (url.includes('19:30:00Z')) throw new Error('reset');
    return { ok: true };
  };
  const got = await probeFrames(
    GOES,
    ['2026-09-19T19:10:00Z', '2026-09-19T19:20:00Z', '2026-09-19T19:30:00Z', '2026-09-19T19:40:00Z'],
    fetchImpl,
  );
  assert.deepEqual(got, ['2026-09-19T19:10:00Z', '2026-09-19T19:40:00Z']);
  assert.equal(asked.length, 4);
});

/* ------------------------------------------------------------------ *
 * The loop inside the layer
 * ------------------------------------------------------------------ */

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

function loopLayer({ fetchImpl }) {
  const viewer = fakeViewer();
  const timers = [];
  const layer = createImageryOverlayLayer({
    descriptor: IMAGERY_OVERLAYS.find((d) => d.id === 'imagery-goes'),
    now: () => NOW,
    fetchImpl,
    surface: createSurfaceCoordinator(),
    providerFactory: (url, opts) => ({ url, opts }),
    wmsProviderFactory: (opts) => ({ wms: opts }),
    imageryLayerFactory: (provider, opts) => ({ provider, ...opts }),
    timers: {
      set: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clear: (id) => {
        timers[id - 1] = null;
      },
    },
  });
  layer.init(viewer);
  return { layer, viewer, timers };
}

const domainFor = (from, to) =>
  `<Domains><DimensionDomain><Domain>${from}/${to}/PT10M</Domain></DimensionDomain></Domains>`;

test('a GOES loop finds its frames, probes them, hides the live frame and cycles', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.includes('DescribeDomains'))
      return { ok: true, text: async () => domainFor('2026-09-19T18:20:00Z', '2026-09-19T20:20:00Z') };
    // The 19:50 scan never arrived.
    if (url.includes('19:50:00Z')) return { ok: false, status: 404 };
    return { ok: true };
  };
  const { layer, viewer, timers } = loopLayer({ fetchImpl });
  assert.equal(layer.canLoop(), false, 'not enabled: nothing to loop');
  await layer.enable(viewer);
  await layer.setSensor('goes-east-geo');
  assert.equal(layer.canLoop(), true);
  assert.equal(layer.loopWindowText(), 'the last 2 h');
  const live = viewer.layers[0];
  assert.equal(live.alpha, 1);

  const started = await layer.startLoop({ stepMs: 500 });
  assert.equal(started.frames, 11, 'twelve candidates, one missing');
  assert.ok(!started.instants.includes('2026-09-19T19:50:00Z'));
  assert.equal(started.instants.at(-1), '2026-09-19T20:20:00Z');
  assert.equal(asked.filter((u) => u.includes('DescribeDomains')).length, 1);
  assert.equal(asked.filter((u) => u.endsWith('/0/0/0.png')).length, 12, 'one probe per candidate');
  assert.equal(viewer.layers.length, 12, 'the live frame plus eleven');
  assert.equal(live.alpha, 0, 'the live frame is hidden under the loop');
  const frames = viewer.layers.slice(1);
  assert.equal(frames.filter((f) => f.alpha === 1).length, 1, 'one frame showing');
  assert.equal(frames[0].alpha, 1);
  assert.match(frames[0].provider.url, /18:30:00Z/);
  assert.equal(layer.getLoop().index, 0);
  assert.equal(layer.getLoop().instant, '2026-09-19T18:30:00Z');
  assert.equal(timers.filter(Boolean).length, 1);
  assert.equal(timers[0].ms, 500);

  timers[0].fn();
  assert.equal(layer.getLoop().index, 1);
  assert.equal(frames[0].alpha, 0);
  assert.equal(frames[1].alpha, 1);
  for (let i = 0; i < 10; i++) timers[0].fn();
  assert.equal(layer.getLoop().index, 0, 'wraps');

  // The five-minute refresh leaves the loop alone.
  assert.equal(await layer.update(), false);
  assert.equal(viewer.layers.length, 12);

  assert.equal(layer.stopLoop(), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(layer.getLoop(), null);
  assert.equal(timers.filter(Boolean).length, 0, 'timer cleared');
  assert.equal(viewer.layers.length, 1, 'frames removed, live frame refreshed');
  assert.equal(viewer.layers[0].alpha, 1);
  assert.equal(layer.stopLoop(), false, 'stopping twice is a no-op');
});

test('a WMS loop steps the window itself and carries TIME on every frame', async () => {
  const fetchImpl = async () => ({ ok: true });
  const { layer, viewer } = loopLayer({ fetchImpl });
  await layer.enable(viewer);
  await layer.setSensor('meteosat-geocolour');
  const started = await layer.startLoop();
  assert.equal(started.frames, 12);
  const frames = viewer.layers.slice(1);
  assert.equal(frames[0].provider.wms.parameters.TIME, started.instants[0]);
  assert.equal(frames[0].provider.wms.layers, 'mtg_fd:rgb_geocolour');
  layer.stopLoop();
});

test('fewer than two frames is no loop, and switching sensor or disabling ends one', async () => {
  const fetchImpl = async (url) =>
    url.includes('DescribeDomains')
      ? { ok: true, text: async () => domainFor('2026-09-19T20:20:00Z', '2026-09-19T20:20:00Z') }
      : { ok: true };
  const { layer, viewer } = loopLayer({ fetchImpl });
  await layer.enable(viewer);
  await layer.setSensor('goes-east-geo');
  assert.equal(await layer.startLoop(), null, 'one frame is a still, not a loop');
  assert.equal(layer.getLoop(), null);
  assert.equal(viewer.layers.length, 1);

  const plenty = async (url) =>
    url.includes('DescribeDomains')
      ? { ok: true, text: async () => domainFor('2026-09-19T18:20:00Z', '2026-09-19T20:20:00Z') }
      : { ok: true };
  const second = loopLayer({ fetchImpl: plenty });
  await second.layer.enable(second.viewer);
  await second.layer.setSensor('goes-east-geo');
  assert.ok(await second.layer.startLoop());
  await second.layer.setSensor('goes-east-ir');
  assert.equal(second.layer.getLoop(), null, 'a new sensor ends the loop');
  assert.ok(await second.layer.startLoop());
  second.layer.disable();
  assert.equal(second.layer.getLoop(), null);
  assert.equal(second.viewer.layers.length, 0, 'nothing left in the scene');
  assert.equal(second.layer.canLoop(), false);
});
