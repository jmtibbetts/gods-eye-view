import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONJUNCTION_FILTERS,
  DEFAULT_CONJUNCTION_FILTER,
  bandFor,
  conjunctionFilterFor,
  probabilityText,
} from './policy.js';
import {
  parseConjunctions,
  positionAt,
  rangeText,
  summarizeConjunctions,
  untilText,
} from './records.js';
import { createConjunctionSource } from './source.js';
import { conjunctionLabelText, createConjunctionsLayer } from './index.js';

const NOW = Date.parse('2026-09-19T22:00:00Z');
const ALL = conjunctionFilterFor('all');

// ISS and NOAA-20, live elements, epoch 2026-09-19.
const ISS = [
  '1 25544U 98067A   26262.54166667  .00016717  00000+0  10270-3 0  9006',
  '2 25544  51.6400 208.9163 0006703  35.4706  46.3903 15.49560000  6704',
];
const NOAA20 = [
  '1 43013U 17073A   26262.24111710  .00000040  00000+0  39795-4 0  9994',
  '2 43013  98.7821 200.8849 0001386  44.7303 315.3984 14.19526567457812',
];

function row(over = {}) {
  return {
    id: '25544-43013-2026-09-20T01:00:00',
    objects: [
      { noradId: 25544, name: 'ISS (ZARYA)', status: 'active', station: 'ISS', tle: ISS },
      { noradId: 43013, name: 'NOAA 20', status: 'active', station: null, tle: NOAA20 },
    ],
    tca: '2026-09-20T01:00:00.000Z',
    rangeKm: 0.42,
    relativeSpeedKms: 11.3,
    maxProbability: 2.5e-4,
    dilutionKm: 0.1,
    crewed: true,
    why: ['probability', 'crewed'],
    ...over,
  };
}

test('bands, filters and the odds read the way operators say them', () => {
  assert.equal(bandFor(1e-3).key, 'high');
  assert.equal(bandFor(1e-4).key, 'high');
  assert.equal(bandFor(5e-5).key, 'elevated');
  assert.equal(bandFor(1e-7).key, 'low');
  assert.equal(bandFor(null).key, 'low');
  assert.equal(conjunctionFilterFor('nonsense').key, DEFAULT_CONJUNCTION_FILTER);
  assert.equal(CONJUNCTION_FILTERS[0].key, 'all');
  assert.equal(probabilityText(1.2e-4), '1 in 8,333');
  assert.equal(probabilityText(1), '1 in 1 (element set at fault, most likely)');
  assert.equal(probabilityText(0), 'below 1 in 1,000,000');
  assert.equal(rangeText(0.005), '5 m');
  assert.equal(rangeText(1.234), '1.23 km');
  assert.equal(rangeText(12.34), '12.3 km');
  assert.equal(untilText(NOW + 40_000, NOW), 'in 40 s');
  assert.equal(untilText(NOW + 3 * 3600_000 + 12 * 60_000, NOW), 'in 3 h 12 min');
  assert.equal(untilText(NOW + 50 * 3600_000, NOW), 'in 2 d 2 h');
  assert.equal(untilText(NOW - 1, NOW), 'now');
});

test('an object is placed by propagating its elements to the instant, in the Earth-fixed frame', () => {
  const p = positionAt(ISS, NOW);
  assert.ok(p, 'the ISS propagates');
  assert.ok(Math.abs(p.lat) <= 51.7, `inclination bounds latitude: ${p.lat}`);
  assert.ok(p.altKm > 380 && p.altKm < 440, `ISS height ${p.altKm}`);
  assert.ok(p.lon >= -180 && p.lon <= 180);
  assert.equal(positionAt(null, NOW), null);
  assert.equal(positionAt(['garbage', 'lines'], NOW), null);
});

test('records are placed at the midpoint, past ones dropped, unplaced ones kept and counted', () => {
  const payload = {
    fetchedAt: 'x',
    total: 9,
    coOrbiting: 3,
    pending: 1,
    conjunctions: [
      row(),
      row({
        id: 'later',
        tca: '2026-09-22T12:00:00.000Z',
        maxProbability: 1e-6,
        crewed: false,
        objects: [
          { noradId: 1, name: 'DEB A', status: 'inactive', tle: null },
          { noradId: 2, name: 'DEB B', status: 'inactive', tle: null },
        ],
      }),
      row({ id: 'past', tca: '2026-09-19T00:00:00.000Z' }),
    ],
  };
  const all = parseConjunctions(payload, ALL, NOW);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, '25544-43013-2026-09-20T01:00:00', 'soonest first');
  assert.ok(all[0].position, 'both have elements: placed');
  assert.equal(all[1].position, null, 'no elements: listed, not placed');
  assert.equal(all.placed, 1);
  assert.equal(all.unplaced, 1);
  assert.equal(all.pending, 1);
  assert.equal(all.total, 9);
  assert.equal(all.coOrbiting, 3);
  const a = all[0].objects[0].position;
  const b = all[0].objects[1].position;
  assert.ok(a && b);
  assert.ok(Math.abs(all[0].position.lat - (a.lat + b.lat) / 2) < 1e-9);

  const high = parseConjunctions(payload, conjunctionFilterFor('high'), NOW);
  assert.equal(high.length, 1);
  const crewed = parseConjunctions(payload, conjunctionFilterFor('crewed'), NOW);
  assert.equal(crewed.length, 1);
  const summary = summarizeConjunctions(all);
  assert.equal(summary.count, 2);
  assert.equal(summary.worst, 'High probability');
  assert.equal(summary.next.id, all[0].id);
  assert.deepEqual(
    summary.breakdown.map((b) => `${b.name}:${b.count}`).sort(),
    ['High probability:1', 'Low:1'],
  );

  // One object with elements is enough to place the pair.
  const one = parseConjunctions(
    { conjunctions: [row({ objects: [row().objects[0], { ...row().objects[1], tle: null }] })] },
    ALL,
    NOW,
  );
  assert.ok(one[0].position);
  assert.ok(Math.abs(one[0].position.lat - one[0].objects[0].position.lat) < 1e-9);
});

test('the card says what SOCRATES said and that it is a screening figure', () => {
  const [record] = parseConjunctions({ conjunctions: [row()] }, ALL, NOW);
  const text = conjunctionLabelText(record, NOW);
  assert.match(text, /^ISS \(ZARYA\) × NOAA 20/);
  assert.match(text, /Closest approach 2026-09-20 01:00Z \(in 3 h\)/);
  assert.match(text, /Miss 420 m at 11\.3 km\/s relative/);
  assert.match(text, /SOCRATES maximum probability 1 in 4,000 — high probability/);
  assert.match(text, /Over \d+\.\d°[NS] \d+\.\d°[EW] at \d+ km/);
  assert.match(text, /screening figure/);
  assert.ok(!/collision risk/i.test(text));
});

test('the source reads the proxy and refuses an error body', async () => {
  let asked = null;
  const ok = createConjunctionSource({
    fetchImpl: async (url) => {
      asked = url;
      return { ok: true, json: async () => ({ conjunctions: [], pending: 0 }) };
    },
  });
  await ok.fetchConjunctions();
  assert.ok(asked.startsWith('/api/space/conjunctions'));
  const down = createConjunctionSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ error: 'upstream_failed' }) }),
  });
  await assert.rejects(() => down.fetchConjunctions(), /unavailable/);
});

test('the layer draws the placed ones, re-cuts on a chip, and asks again while elements are pending', async () => {
  let fetches = 0;
  let pending = 1;
  const source = {
    fetchConjunctions: async () => {
      fetches++;
      return {
        fetchedAt: 'x',
        total: 2,
        coOrbiting: 0,
        pending,
        conjunctions: [
          row(),
          row({
            id: 'deb',
            crewed: false,
            maxProbability: 1e-6,
            objects: [
              { noradId: 1, name: 'DEB A', status: 'inactive', tle: pending ? null : NOAA20 },
              { noradId: 2, name: 'DEB B', status: 'inactive', tle: null },
            ],
          }),
        ],
      };
    },
  };
  const scheduled = [];
  const timers = {
    set: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clear: (id) => {
      scheduled[id - 1] = null;
    },
  };
  const viewer = {
    dataSources: {
      added: [],
      add(ds) {
        this.added.push(ds);
      },
      remove() {},
    },
    scene: { requestRender() {} },
  };
  const layer = createConjunctionsLayer({ source, timers, now: () => NOW });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  const ds = viewer.dataSources.added[0];
  assert.equal(ds.entities.values.length, 1, 'one placed, one waiting on elements');
  assert.equal(layer.getStats().count, 2);
  assert.match(layer.getStats().coverage, /placing 1\/2/);
  const legend = layer.getRowControls().legend.map((l) => l.label);
  assert.match(legend[0], /^next in 3 h: ISS \(ZARYA\) × NOAA 20/);
  assert.ok(legend.includes('1 not placed yet'));
  assert.equal(scheduled.filter(Boolean).length, 1, 'a retry is scheduled while pending');
  assert.equal(scheduled[0].ms, 45_000);

  // The elements arrive: the retry fires, both are drawn, no further retry.
  pending = 0;
  await scheduled[0].fn();
  assert.equal(fetches, 2);
  assert.equal(ds.entities.values.length, 2);
  assert.equal(scheduled.filter(Boolean).length, 1, 'nothing more scheduled');
  assert.equal(layer.getRowControls().legend.some((l) => /not placed/.test(l.label)), false);

  assert.equal(await layer.setParams({ show: 'crewed' }), true);
  assert.equal(fetches, 2, 'a chip is a re-cut, not a refetch');
  assert.equal(ds.entities.values.length, 1);
  assert.equal(layer.getAnalystRecords().length, 1);
  assert.match(layer.getAnalystRecords()[0].label, /ISS \(ZARYA\) × NOAA 20 in 3 h/);
  layer.disable();
  assert.equal(ds.entities.values.length, 0);
  layer.destroy();
});

test('a failed load keeps its error through the disable the manager triggers', async () => {
  const layer = createConjunctionsLayer({
    source: {
      fetchConjunctions: async () => {
        throw new Error('upstream exploded');
      },
    },
  });
  layer.enable();
  await layer.update();
  assert.match(layer.getStats().error ?? '', /upstream exploded/);
  layer.disable();
  assert.match(layer.getStats().error ?? '', /upstream exploded/);
  assert.throws(() => createConjunctionsLayer({}), /requires a SOCRATES source/);
});

/**
 * A viewer whose camera sits over a chosen point, so the horizon cull has a
 * real pose to judge against.
 */
function cullFixture({ cameraHeight = 12_000_000 } = {}) {
  const ticks = [];
  const viewTimers = {
    set: (fn, ms) => {
      ticks.push({ fn, ms });
      return ticks.length;
    },
    clear: (id) => {
      ticks[id - 1] = null;
    },
  };
  let renders = 0;
  // Camera on the +X axis, looking at the planet: everything with a negative
  // x is on the far side of it.
  const camera = {
    positionWC: { x: 6378137 + cameraHeight, y: 0, z: 0 },
    position: { x: 6378137 + cameraHeight, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  };
  const viewer = {
    camera,
    dataSources: {
      added: [],
      add(ds) {
        this.added.push(ds);
      },
      remove() {},
    },
    scene: {
      requestRender() {
        renders++;
      },
    },
  };
  return { viewer, camera, ticks, viewTimers, renders: () => renders };
}

async function enabledLayer(fixture, rows) {
  const layer = createConjunctionsLayer({
    source: { fetchConjunctions: async () => ({ conjunctions: rows }) },
    viewTimers: fixture.viewTimers,
    now: () => NOW,
  });
  layer.init(fixture.viewer);
  layer.enable(fixture.viewer);
  await layer.update();
  return { layer, ds: fixture.viewer.dataSources.added[0] };
}

test('a conjunction the planet is in front of is not drawn over it', async () => {
  const f = cullFixture();
  const { layer, ds } = await enabledLayer(f, [row()]);
  const entity = ds.entities.values[0];
  const position = entity.gevDisplayPosition();
  // Put the camera on the far side of the planet from this marker.
  f.camera.positionWC = {
    x: -position.x * 3,
    y: -position.y * 3,
    z: -position.z * 3,
  };
  f.ticks.find(Boolean).fn();
  assert.equal(entity.show, false, 'the far side is not painted over the near');

  // And back: a marker the camera can actually see returns.
  f.camera.positionWC = {
    x: position.x * 3,
    y: position.y * 3,
    z: position.z * 3,
  };
  f.ticks.find(Boolean).fn();
  assert.equal(entity.show, true);
  layer.destroy();
});

test('a fresh set of markers is judged before the camera moves again', async () => {
  // Markers are rebuilt between camera moves. Waiting for a move to judge
  // them is how a far-side dot gets drawn in the first place.
  const f = cullFixture();
  const { layer, ds } = await enabledLayer(f, [row()]);
  const position = ds.entities.values[0].gevDisplayPosition();
  f.camera.positionWC = {
    x: -position.x * 3,
    y: -position.y * 3,
    z: -position.z * 3,
  };
  f.ticks.find(Boolean).fn();
  assert.equal(ds.entities.values[0].show, false);

  // A refresh replaces every entity, each one shown by default.
  await layer.update();
  assert.equal(
    ds.entities.values[0].show,
    false,
    'the replacement is judged on arrival, not at the next camera move',
  );
  layer.destroy();
});

test('the cull costs one pose compare while the camera is still', async () => {
  const f = cullFixture();
  const { layer, ds } = await enabledLayer(f, [row()]);
  const entity = ds.entities.values[0];
  entity.show = false;
  const tick = f.ticks.find(Boolean).fn;
  tick();
  assert.equal(entity.show, false, 'a still camera is not re-judged');
  layer.destroy();
});

test('disabling stops the cull, and enabling starts exactly one', async () => {
  const f = cullFixture();
  const { layer } = await enabledLayer(f, [row()]);
  assert.equal(f.ticks.filter(Boolean).length, 1);
  layer.disable();
  assert.equal(f.ticks.filter(Boolean).length, 0, 'no tick survives disable');
  layer.enable(f.viewer);
  assert.equal(f.ticks.filter(Boolean).length, 1);
  layer.destroy();
});

test('a viewer with no camera yet is not a crash', async () => {
  const f = cullFixture();
  f.viewer.camera = null;
  const { layer, ds } = await enabledLayer(f, [row()]);
  assert.equal(ds.entities.values.length, 1, 'the marker is still built');
  layer.destroy();
});
