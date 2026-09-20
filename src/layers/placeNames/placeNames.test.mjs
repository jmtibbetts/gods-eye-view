import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPITAL_RANK_BONUS,
  PLACE_TIERS,
  cityRankCeiling,
  effectiveCityRank,
  tiersForHeight,
} from './policy.js';
import {
  buildPlaces,
  buildPolygonAnchors,
  lonInView,
  visiblePlaces,
} from './records.js';
import { createPlaceNamesLayer } from './index.js';

const ANCHORS = {
  features: [
    { tier: 'continent', name: 'Europe', lon: 15, lat: 50, rank: 0 },
    { tier: 'ocean', name: 'North Atlantic Ocean', lon: -40, lat: 35, rank: 0 },
    { tier: 'country', name: 'France', lon: 2, lat: 47, rank: 6 },
    { tier: 'country', name: 'Spain', lon: -3, lat: 40, rank: 7 },
    { tier: 'sea', name: 'North Sea', lon: 3, lat: 56, rank: 9 },
    { tier: 'region', name: 'Alps', lon: 10, lat: 46, rank: 10 },
  ],
};
const PLACES = {
  features: [
    { name: 'Paris', lon: 2.35, lat: 48.86, rank: 0, capital: 1, pop: 9904000 },
    { name: 'Lyon', lon: 4.84, lat: 45.76, rank: 4, pop: 1423000 },
    { name: 'Dijon', lon: 5.03, lat: 47.32, rank: 7, pop: 245000 },
  ],
};

test('a tier is live only between its own heights', () => {
  const at = (h) => tiersForHeight(h).map((tier) => tier.id);
  assert.deepEqual(at(12_000_000), ['continent', 'ocean', 'country']);
  assert.ok(at(500_000).includes('country'));
  assert.ok(!at(500_000).includes('continent'), 'no continents from 500 km');
  assert.ok(at(5_000).includes('city'));
  assert.ok(!at(5_000).includes('country'), 'no country name from 5 km up');
});

test('every tier is reachable from some height', () => {
  // A tier nobody can ever see is a tier that should not be in the list.
  for (const tier of PLACE_TIERS) {
    const probe = Number.isFinite(tier.maxHeight)
      ? (tier.minHeight + tier.maxHeight) / 2
      : tier.minHeight + 1;
    assert.ok(
      tiersForHeight(probe).some((live) => live.id === tier.id),
      `${tier.id} is never live`,
    );
  }
});

test('the city ceiling tightens with height, and never inverts', () => {
  const heights = [10_000, 50_000, 200_000, 500_000, 1_000_000, 5_000_000];
  const ceilings = heights.map(cityRankCeiling);
  for (let i = 1; i < ceilings.length; i++)
    assert.ok(
      ceilings[i] <= ceilings[i - 1],
      'going up may only ever show fewer cities',
    );
  assert.equal(cityRankCeiling(5_000_000), 0, 'from orbit, only the largest');
});

test('a capital is treated as more prominent than its size says', () => {
  const capital = { rank: 5, capital: 1 };
  const plain = { rank: 5 };
  assert.equal(effectiveCityRank(capital), 5 - CAPITAL_RANK_BONUS);
  assert.equal(effectiveCityRank(plain), 5);
  assert.ok(effectiveCityRank(capital) < effectiveCityRank(plain));
  assert.equal(effectiveCityRank(null), 10, 'an unranked place goes last');
});

test('places are built tiered and pre-sorted by what matters most', () => {
  const places = buildPlaces({ anchors: ANCHORS, places: PLACES });
  assert.equal(places.length, 9);
  assert.equal(places[0].name, 'Europe', 'a continent outranks everything');
  const tiers = places.map((place) => place.tier);
  assert.ok(
    tiers.indexOf('country') < tiers.indexOf('city'),
    'countries come before cities in the budget',
  );
  for (let i = 1; i < places.length; i++)
    assert.ok(places[i - 1].priority >= places[i].priority, 'sorted');
});

test('a place with no usable position is not invented', () => {
  const places = buildPlaces({
    anchors: { features: [{ tier: 'country', name: 'Nowhere', rank: 1 }] },
  });
  assert.deepEqual(places, []);
});

test('an unknown tier is dropped rather than drawn with no rules', () => {
  const places = buildPlaces({
    anchors: { features: [{ tier: 'moon', name: 'Mare', lon: 0, lat: 0 }] },
  });
  assert.deepEqual(places, []);
});

test('the view filter keeps what is on screen and drops what is not', () => {
  const places = buildPlaces({ anchors: ANCHORS, places: PLACES });
  const shown = visiblePlaces({
    places,
    heightM: 500_000,
    view: { west: -1, south: 44, east: 8, north: 50 },
  }).map((place) => place.name);
  assert.ok(shown.includes('France'));
  assert.ok(!shown.includes('Spain'), 'Spain is outside this box');
  assert.ok(!shown.includes('North Atlantic Ocean'));
});

test('a view across the antimeridian is not an empty view', () => {
  assert.equal(lonInView(179, 170, -170), true);
  assert.equal(lonInView(-179, 170, -170), true);
  assert.equal(lonInView(0, 170, -170), false);
  assert.equal(lonInView(5, -10, 10), true);
  assert.equal(lonInView(50, -10, 10), false);
});

test('the label budget is honoured, taking the most important first', () => {
  const places = buildPlaces({ anchors: ANCHORS, places: PLACES });
  const shown = visiblePlaces({
    places,
    heightM: 500_000,
    view: null,
    limit: 2,
  });
  assert.equal(shown.length, 2);
  assert.equal(shown[0].tier, 'country', 'the coarsest live tier leads');
});

test('anchors are computed from polygons, told apart by class', () => {
  const square = [
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ],
  ];
  const anchors = buildPolygonAnchors({
    regions: {
      features: [
        { name: 'Asia', featurecla: 'Continent', polygons: square },
        { name: 'Alps', featurecla: 'Range/mtn', polygons: square },
        { name: 'A Pond', featurecla: 'Lake', polygons: square },
      ],
    },
    marine: {
      features: [
        { name: 'Arctic Ocean', featurecla: 'ocean', polygons: square },
        { name: 'A Fjord', featurecla: 'fjord', polygons: square },
      ],
    },
    countries: { features: [{ name: 'France', polygons: square }] },
  });
  const byTier = anchors.map((a) => `${a.tier}:${a.name}`);
  assert.deepEqual(byTier, [
    'continent:Asia',
    'region:Alps',
    'ocean:Arctic Ocean',
    'country:France',
  ]);
  assert.ok(anchors.every((a) => a.lon > 0 && a.lat > 0));
});

/* ------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------ */

function fixture({ heightM = 500_000, packs = null } = {}) {
  const calls = [];
  const overlayHost = {
    setEntries: (sourceId, cohort, options) =>
      calls.push(['setEntries', sourceId, cohort, options]),
    setVisible: (sourceId, visible) =>
      calls.push(['setVisible', sourceId, visible]),
    clearSource: (sourceId) => calls.push(['clearSource', sourceId]),
  };
  const ticks = [];
  const timers = {
    set: (fn, ms) => {
      ticks.push({ fn, ms });
      return ticks.length;
    },
    clear: (id) => {
      ticks[id - 1] = null;
    },
  };
  const camera = {
    positionWC: { x: 7_000_000, y: 0, z: 0 },
    positionCartographic: { height: heightM },
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
    computeViewRectangle: () => ({
      west: -0.5,
      south: 0.6,
      east: 0.5,
      north: 1.1,
    }),
  };
  const viewer = {
    camera,
    scene: { globe: { ellipsoid: {} }, requestRender() {} },
  };
  const layer = createPlaceNamesLayer({
    overlayHost,
    timers,
    loadPacks: async () => packs || { anchors: ANCHORS, places: PLACES },
  });
  const entries = () => calls.filter((call) => call[0] === 'setEntries');
  return { layer, viewer, camera, calls, ticks, entries, overlayHost };
}

test('a layer with no overlay host to draw on is a mistake, not a silent no-op', () => {
  assert.throws(() => createPlaceNamesLayer({}), /world-overlay host/);
});

test('enabling then updating puts names on the overlay', async () => {
  const f = fixture();
  f.layer.init(f.viewer);
  f.layer.enable(f.viewer);
  assert.equal(await f.layer.update(), true);
  const [, sourceId, cohort, options] = f.entries().at(-1);
  assert.equal(sourceId, 'place-names');
  assert.ok(cohort.length > 0);
  assert.equal(cohort[0].variant, 'label');
  assert.equal(cohort[0].horizonCull, true, 'never on the far side');
  assert.equal(cohort[0].terrainOcclusion, false);
  assert.equal(cohort[0].interactive, false);
  assert.ok(options.cohortLimit > 0);
  f.layer.destroy();
});

test('a still camera is not re-projected on every tick', async () => {
  const f = fixture();
  f.layer.init(f.viewer);
  f.layer.enable(f.viewer);
  await f.layer.update();
  const before = f.entries().length;
  f.ticks.find(Boolean).fn();
  assert.equal(f.entries().length, before, 'nothing moved, nothing redrawn');
  f.camera.positionWC = { x: 7_100_000, y: 0, z: 0 };
  f.ticks.find(Boolean).fn();
  assert.equal(f.entries().length, before + 1, 'a moved camera redraws');
  f.layer.destroy();
});

test('height decides which names are drawn', async () => {
  const high = fixture({ heightM: 8_000_000 });
  high.layer.init(high.viewer);
  high.layer.enable(high.viewer);
  await high.layer.update();
  const highNames = high
    .entries()
    .at(-1)[2]
    .map((entry) => entry.title);
  assert.ok(highNames.includes('Europe'), 'a continent is named from orbit');
  assert.ok(!highNames.includes('Dijon'), 'a town is not');

  const low = fixture({ heightM: 10_000 });
  low.layer.init(low.viewer);
  low.layer.enable(low.viewer);
  await low.layer.update();
  const lowNames = low
    .entries()
    .at(-1)[2]
    .map((entry) => entry.title);
  assert.ok(!lowNames.includes('Europe'), 'and not from ten kilometres up');
  high.layer.destroy();
  low.layer.destroy();
});

test('disabling takes the names down and stops the tick', async () => {
  const f = fixture();
  f.layer.init(f.viewer);
  f.layer.enable(f.viewer);
  await f.layer.update();
  f.layer.disable();
  assert.ok(f.calls.some((call) => call[0] === 'clearSource'));
  assert.equal(f.ticks.filter(Boolean).length, 0);
  const after = f.entries().length;
  assert.equal(await f.layer.update(), false, 'a disabled layer draws nothing');
  assert.equal(f.entries().length, after);
});

test('a pack that will not load is reported, not drawn empty', async () => {
  const f = fixture();
  f.layer = createPlaceNamesLayer({
    overlayHost: f.overlayHost,
    timers: { set: () => 1, clear: () => {} },
    loadPacks: async () => {
      throw new Error('pack missing');
    },
  });
  f.layer.init(f.viewer);
  f.layer.enable(f.viewer);
  assert.equal(await f.layer.update(), false);
  assert.match(f.layer.getStats().error, /pack missing/);
  assert.equal(f.layer.getStats().count, 0);
});

test('the row says what it is showing and at what scale', async () => {
  const f = fixture();
  f.layer.init(f.viewer);
  f.layer.enable(f.viewer);
  assert.match(f.layer.getStats().coverage, /loading/);
  await f.layer.update();
  const stats = f.layer.getStats();
  assert.ok(stats.count > 0);
  assert.match(stats.coverage, /shown/);
  assert.equal(stats.error, null);
  f.layer.destroy();
});

test('a camera looking away from the planet does not crash the tick', async () => {
  const f = fixture();
  f.viewer.camera.computeViewRectangle = () => undefined;
  f.layer.init(f.viewer);
  f.layer.enable(f.viewer);
  assert.equal(await f.layer.update(), true, 'the whole world is in view');
  f.layer.destroy();
});

/* ------------------------------------------------------------------ *
 * Naming the country you are inside
 * ------------------------------------------------------------------ */

// A square country from 0–10 in both axes, and a neighbour to its east.
const COUNTRY_PACK = {
  features: [
    {
      name: 'Squareland',
      polygons: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
    },
    {
      name: 'Eastria',
      polygons: [
        [
          [10, 0],
          [20, 0],
          [20, 10],
          [10, 10],
        ],
      ],
    },
  ],
};

test('the country under the middle of the screen is named', async () => {
  const { countryAt, viewCenter } = await import('./records.js');
  assert.equal(countryAt(COUNTRY_PACK, 5, 5), 'Squareland');
  assert.equal(countryAt(COUNTRY_PACK, 15, 5), 'Eastria');
  assert.equal(countryAt(COUNTRY_PACK, 50, 50), null, 'the sea is nobody’s');
  assert.equal(countryAt(null, 5, 5), null);
  assert.deepEqual(viewCenter({ west: 0, south: 0, east: 10, north: 10 }), {
    lon: 5,
    lat: 5,
  });
});

test('a view across the antimeridian has a centre on the right side', async () => {
  const { viewCenter } = await import('./records.js');
  const center = viewCenter({ west: 170, south: -5, east: -170, north: 5 });
  assert.equal(center.lat, 0);
  assert.ok(
    center.lon === 180 || center.lon === -180,
    `centre should be at the dateline, got ${center.lon}`,
  );
});

test('flying into a country keeps its name on screen', async () => {
  // The whole point: a country is anchored at one point, and that point
  // leaves the screen long before the country does.
  const places = buildPlaces({
    anchors: {
      features: [
        { tier: 'country', name: 'Squareland', lon: 5, lat: 5, rank: 6 },
      ],
    },
  });
  const farCorner = { west: 8.5, south: 8.5, east: 9.5, north: 9.5 };
  const anchorOffScreen = visiblePlaces({
    places,
    heightM: 200_000,
    view: farCorner,
  });
  assert.deepEqual(
    anchorOffScreen.map((p) => p.name),
    [],
    'without the outlines, the name is lost — this is the bug',
  );

  const withOutlines = visiblePlaces({
    places,
    heightM: 200_000,
    view: farCorner,
    countries: COUNTRY_PACK,
  });
  assert.deepEqual(
    withOutlines.map((p) => p.name),
    ['Squareland'],
  );
  assert.equal(withOutlines[0].lon, 9, 'pinned to the middle of the view');
  assert.equal(withOutlines[0].lat, 9);
});

test('a country whose anchor IS on screen keeps its real position, and appears once', () => {
  const places = buildPlaces({
    anchors: {
      features: [
        { tier: 'country', name: 'Squareland', lon: 5, lat: 5, rank: 6 },
      ],
    },
  });
  const shown = visiblePlaces({
    places,
    heightM: 200_000,
    view: { west: 0, south: 0, east: 10, north: 10 },
    countries: COUNTRY_PACK,
  });
  assert.equal(
    shown.length,
    1,
    'not once for the anchor and once for being inside',
  );
  assert.equal(shown[0].lon, 5, 'its own anchor, not the view centre');
});

test('being over the sea names no country rather than the nearest one', () => {
  const places = buildPlaces({
    anchors: {
      features: [
        { tier: 'country', name: 'Squareland', lon: 5, lat: 5, rank: 6 },
      ],
    },
  });
  const shown = visiblePlaces({
    places,
    heightM: 200_000,
    view: { west: 40, south: 40, east: 41, north: 41 },
    countries: COUNTRY_PACK,
  });
  assert.deepEqual(shown, []);
});
