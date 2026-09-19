import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FILTER,
  HAZARD_CLASSES,
  HAZARD_FILTERS,
  filterFor,
  hazardClassFor,
  inForce,
} from './policy.js';
import {
  altitudeText,
  intensity,
  isoMinute,
  parseSigmets,
  summarizeSigmets,
  volcanoName,
} from './records.js';
import { createAviationHazardSource } from './source.js';
import { createAviationHazardsLayer, sigmetLabelText } from './index.js';

const NOW = Date.parse('2026-09-18T21:00:00Z');
const ALL = filterFor('all');
const ASH = filterFor('ash');

const SQUARE = [-100, 35, -95, 35, -95, 40, -100, 40];

function sigmet(over = {}) {
  return {
    id: 'international:FAOR:B01:1789754400:FACA:1',
    origin: 'international',
    hazard: 'TURB',
    qualifier: 'SEV',
    region: 'FACA CAPE TOWN',
    low: 27000,
    high: 34000,
    dir: null,
    speed: null,
    trend: 'NC',
    from: NOW / 1000 - 3600,
    to: NOW / 1000 + 3600,
    raw: 'WSZA21 FAOR 181800',
    parts: [SQUARE],
    ...over,
  };
}

test('an unknown filter falls back to the default rather than throwing', () => {
  assert.equal(filterFor('nonsense').key, DEFAULT_FILTER);
  assert.equal(filterFor(undefined).key, DEFAULT_FILTER);
});

test('the domestic and international codes for one weather map to one class', () => {
  // The domestic feed says CONVECTIVE where the international one says TS.
  // Two chips for the same thunderstorm would be a bug, not a feature.
  assert.equal(hazardClassFor('TS').key, 'storm');
  assert.equal(hazardClassFor('CONVECTIVE').key, 'storm');
  assert.equal(hazardClassFor('convective').key, 'storm');
});

test('an unknown hazard is drawn, not dropped', () => {
  // The opposite of the drought layer's rule, and deliberately: every record
  // in this feed is something an authority warned aircraft about, so omitting
  // one because its code is unfamiliar is the worse failure.
  const klass = hazardClassFor('XYZ');
  assert.ok(klass);
  assert.equal(klass.key, 'other');
  assert.ok(klass.name.includes('XYZ'));

  const areas = parseSigmets([sigmet({ hazard: 'XYZ' })], ALL, NOW);
  assert.equal(areas.length, 1);
  assert.equal(areas[0].classKey, 'other');
});

test('an expired advisory is dropped and counted', () => {
  // An expired SIGMET drawn as current tells a reader that airspace is
  // dangerous after the authority has said it is not.
  const areas = parseSigmets(
    [sigmet({ id: 'a', to: NOW / 1000 - 1 }), sigmet({ id: 'b' })],
    ALL,
    NOW,
  );
  assert.equal(areas.length, 1);
  assert.equal(areas[0].id, 'b');
  assert.equal(areas.expired, 1);
  assert.equal(summarizeSigmets(areas, ALL).expired, 1);
});

test('an advisory with no stated expiry is treated as in force', () => {
  assert.equal(inForce({ to: null }, NOW), true);
  assert.equal(inForce({}, NOW), true);
  assert.equal(inForce({ to: NOW / 1000 + 60 }, NOW), true);
  assert.equal(inForce({ to: NOW / 1000 - 60 }, NOW), false);
});

test('an advisory covering several areas becomes several polygons', () => {
  // `geom: 'AREAS'` gives a list of point lists. Reducing that to its first
  // part silently discarded two thirds of a three-part thunderstorm warning
  // over Brazzaville.
  const areas = parseSigmets(
    [sigmet({ parts: [SQUARE, SQUARE, SQUARE] })],
    ALL,
    NOW,
  );
  assert.equal(areas.length, 3);
  assert.equal(new Set(areas.map((a) => a.id)).size, 3);
});

test('an advisory with no usable geometry is counted rather than ignored', () => {
  const areas = parseSigmets(
    [sigmet({ parts: [] }), sigmet({ id: 'b', parts: [[1, 2]] })],
    ALL,
    NOW,
  );
  assert.equal(areas.length, 0);
  assert.equal(areas.dropped, 2);
});

test('the volcano name and the intensity share one field and are kept apart', () => {
  // The international feed reuses `qualifier` for an intensity code on most
  // hazards and for the VOLCANO NAME on an ash advisory. Reading it blindly
  // labels a Mayon eruption "MAYON intensity".
  assert.equal(volcanoName({ hazard: 'VA', qualifier: 'MAYON' }), 'MAYON');
  assert.equal(volcanoName({ hazard: 'VA', qualifier: 'SEV' }), '');
  assert.equal(volcanoName({ hazard: 'TURB', qualifier: 'MAYON' }), '');
  assert.equal(intensity({ qualifier: 'SEV' }), 'Severe');
  assert.equal(intensity({ qualifier: 'EMBD' }), 'Embedded');
  assert.equal(intensity({ qualifier: 'MAYON' }), '');
});

test('an ash card leads with the volcano and a turbulence card with intensity', () => {
  const [ash] = parseSigmets(
    [sigmet({ hazard: 'VA', qualifier: 'FUEGO', low: 0, high: 15000 })],
    ASH,
    NOW,
  );
  const ashCard = sigmetLabelText(ash);
  assert.ok(ashCard.startsWith('Volcanic ash: FUEGO'));
  assert.ok(ashCard.includes('surface to FL150'));

  const [turb] = parseSigmets([sigmet()], ALL, NOW);
  assert.ok(sigmetLabelText(turb).startsWith('Severe turbulence'));
});

test('altitudes read as flight levels and a surface base survives', () => {
  // Zero is a real base — an ash cloud reaching the ground — so it must not
  // collapse into "no value given".
  assert.equal(altitudeText({ low: 0, high: 15000 }), 'surface to FL150');
  assert.equal(altitudeText({ low: 27000, high: 34000 }), 'FL270–FL340');
  assert.equal(altitudeText({ low: null, high: 9000 }), 'up to FL090');
  assert.equal(altitudeText({ low: 5000, high: null }), 'above FL050');
  assert.equal(altitudeText({ low: 0, high: null }), 'from the surface');
  assert.equal(altitudeText({ low: null, high: null }), '');
  // Absent is not the same as explicitly null: destructuring a record with no
  // altitude fields yields undefined, which a strict null check renders as
  // "FLNaN–FLNaN".
  assert.equal(altitudeText({}), '');
  assert.equal(altitudeText(null), '');
  assert.equal(altitudeText(undefined), '');
  assert.equal(altitudeText({ low: NaN, high: NaN }), '');
});

test('an unreported base is not drawn as ash reaching the ground', () => {
  // `Number('')` is 0, and 0 is a real base — an ash cloud at the surface. A
  // SIGMET whose base is simply unreported once read "surface to FL150",
  // indistinguishable from ash genuinely reaching the ground. The two must
  // stay distinguishable.
  const [unreported] = parseSigmets(
    [sigmet({ hazard: 'VA', qualifier: 'FUEGO', low: '', high: 15000 })],
    ALL,
    NOW,
  );
  assert.equal(unreported.low, null);
  assert.equal(altitudeText(unreported), 'up to FL150');

  const [surface] = parseSigmets(
    [sigmet({ hazard: 'VA', qualifier: 'FUEGO', low: 0, high: 15000 })],
    ALL,
    NOW,
  );
  assert.equal(surface.low, 0);
  assert.equal(altitudeText(surface), 'surface to FL150');
});

test('a filter shows only its own class', () => {
  const rows = [
    sigmet({ id: 'a', hazard: 'VA', qualifier: 'FUEGO' }),
    sigmet({ id: 'b', hazard: 'TURB' }),
    sigmet({ id: 'c', hazard: 'CONVECTIVE' }),
  ];
  assert.equal(parseSigmets(rows, ALL, NOW).length, 3);
  assert.equal(parseSigmets(rows, ASH, NOW).length, 1);
  assert.equal(parseSigmets(rows, filterFor('storm'), NOW).length, 1);
  assert.equal(parseSigmets(rows, filterFor('ice'), NOW).length, 0);
});

test('areas sort least severe first so ash draws over thunderstorms', () => {
  const areas = parseSigmets(
    [
      sigmet({ id: 'a', hazard: 'VA', qualifier: 'FUEGO' }),
      sigmet({ id: 'b', hazard: 'MTW' }),
      sigmet({ id: 'c', hazard: 'TS' }),
    ],
    ALL,
    NOW,
  );
  assert.deepEqual(
    areas.map((a) => a.classKey),
    ['wave', 'storm', 'ash'],
  );
});

test('the summary names the most serious hazard in force', () => {
  const areas = parseSigmets(
    [
      sigmet({ id: 'a', hazard: 'TURB' }),
      sigmet({ id: 'b', hazard: 'TURB' }),
      sigmet({ id: 'c', hazard: 'VA', qualifier: 'IBU' }),
    ],
    ALL,
    NOW,
  );
  const summary = summarizeSigmets(areas, ALL);
  assert.equal(summary.areas, 3);
  assert.equal(summary.worst, 'Volcanic ash');
  assert.deepEqual(summary.breakdown, [
    { name: 'Turbulence', count: 2 },
    { name: 'Volcanic ash', count: 1 },
  ]);
});

test('an empty feed summarizes without inventing a hazard', () => {
  const summary = summarizeSigmets([], ALL);
  assert.equal(summary.areas, 0);
  assert.equal(summary.worst, null);
});

test('times read as UTC minutes', () => {
  assert.equal(isoMinute(1789754400), '2026-09-18 18:00');
  assert.equal(isoMinute(null), '');
  assert.equal(isoMinute('abc'), '');
});

test('every class is reachable from a chip and the chips are distinct', () => {
  const chips = HAZARD_FILTERS.map((f) => f.chip);
  assert.equal(new Set(chips).size, chips.length);
  for (const klass of HAZARD_CLASSES) {
    const filter = HAZARD_FILTERS.find((f) => f.classKey === klass.key);
    assert.ok(filter, `${klass.key} has no chip`);
  }
});

test('the proxy error body is an error, not an absence of hazards', () => {
  const source = createAviationHazardSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: 'upstream_failed' }),
    }),
  });
  return assert.rejects(() => source.fetchSigmets(ALL), /upstream_failed/);
});

test('an HTTP failure surfaces rather than emptying the map', () => {
  const source = createAviationHazardSource({
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  return assert.rejects(() => source.fetchSigmets(ALL), /502/);
});

test('the source reads through the proxy, never the upstream directly', () => {
  let asked = null;
  const source = createAviationHazardSource({
    fetchImpl: async (url) => {
      asked = url;
      return { ok: true, json: async () => [] };
    },
  });
  return source.fetchSigmets(ALL).then(() => {
    assert.ok(asked.startsWith('/api/aviation/'), asked);
    assert.ok(!asked.includes('aviationweather.gov'), asked);
  });
});

test('a caller abort is honoured', async () => {
  const controller = new AbortController();
  const source = createAviationHazardSource({
    fetchImpl: (url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  const pending = source.fetchSigmets(ALL, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /aborted/);
});

test('a failed load keeps its error through the disable the manager triggers', async () => {
  // The manager treats `update() === false` as a rejected enable and disables
  // the layer — which is exactly what a failed first fetch produces. Clearing
  // the error inside disable() therefore turned "the upstream is down" into a
  // layer that quietly switched itself off and reported nothing to see.
  const layer = createAviationHazardsLayer({
    source: {
      fetchSigmets: async () => {
        throw new Error('upstream exploded');
      },
    },
  });
  await layer.enable();
  const failed = layer;
  assert.match(failed.getStats().error ?? '', /upstream exploded/);
  layer.disable();
  assert.match(
    failed.getStats().error ?? '',
    /upstream exploded/,
    'the reason must survive the disable',
  );
  assert.ok(
    !failed.getStats().coverage.includes('none in force'),
    `coverage still asserted emptiness: ${failed.getStats().coverage}`,
  );
});
