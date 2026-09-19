import test from 'node:test';
import assert from 'node:assert/strict';
import { INTENSITY_BANDS, indexCountries, intensityFor } from './policy.js';
import { centroidShare, parseReports, summarizeReports } from './records.js';
import { createConflictSource } from './source.js';
import { countryLabelText, createConflictReportsLayer } from './index.js';

const SQUARE = [
  [-10, 40],
  [0, 40],
  [0, 50],
  [-10, 50],
  [-10, 40],
];

/** The two overrides that deliberately share one FIPS code. */
const PACK = {
  features: [
    { name: 'Testland', codes: ['TL'], polygons: [SQUARE] },
    { name: 'Cyprus', codes: ['CY'], polygons: [SQUARE] },
    { name: 'N. Cyprus', codes: ['CY'], polygons: [SQUARE] },
    { name: 'Palestine', codes: ['WE', 'GZ'], polygons: [SQUARE] },
  ],
};

const INDEX = indexCountries(PACK);

const payload = (countries, over = {}) => ({
  at: '2026-09-18T22:00:00Z',
  sourceFile: '20260918220000.export.CSV.zip',
  windowMinutes: 15,
  totals: { rows: 912, violent: 34, noCountry: 0 },
  countries,
  ...over,
});

test('intensity bands are ordered and a zero count is not a band', () => {
  const mins = INTENSITY_BANDS.map((b) => b.min);
  assert.deepEqual(
    mins,
    [...mins].sort((a, b) => a - b),
  );
  // Zero reports is not "low intensity", it is nothing to draw.
  assert.equal(intensityFor(0), null);
  assert.equal(intensityFor(null), null);
  assert.equal(intensityFor(-1), null);
  assert.equal(intensityFor(1).key, 'isolated');
  assert.equal(intensityFor(3).key, 'several');
  assert.equal(intensityFor(10).key, 'many');
  assert.equal(intensityFor(30).key, 'heavy');
  assert.equal(intensityFor(9999).key, 'heavy');
});

test('one FIPS code can shade several polygons', () => {
  // Natural Earth splits territory that FIPS treats as one state: N. Cyprus
  // sits inside Cyprus's code, Somaliland inside Somalia's. Keying one-to-one
  // silently dropped one polygon of each pair.
  assert.equal(INDEX.get('CY').length, 2);
  const areas = parseReports(payload([{ code: 'CY', events: 5 }]), INDEX);
  assert.equal(areas.length, 2);
  assert.deepEqual(areas.map((a) => a.country).sort(), ['Cyprus', 'N. Cyprus']);
  // Both carry the country's count; they are one country drawn twice.
  assert.ok(areas.every((a) => a.events === 5));
});

test('one polygon can answer to several FIPS codes', () => {
  // FIPS splits the Palestinian territories into West Bank and Gaza Strip
  // while the boundary set carries one shape.
  for (const code of ['WE', 'GZ']) {
    const areas = parseReports(payload([{ code, events: 2 }]), INDEX);
    assert.equal(areas.length, 1);
    assert.equal(areas[0].country, 'Palestine');
  }
});

test('a country with no polygon is surfaced, never silently dropped', () => {
  // The 110m boundary set omits small states — the Cook Islands turned up in
  // the first live sample. A country quietly missing from a conflict map is
  // indistinguishable from one with nothing to report.
  const areas = parseReports(
    payload([
      { code: 'TL', events: 4 },
      { code: 'CW', events: 3 },
    ]),
    INDEX,
  );
  assert.equal(areas.length, 1);
  assert.deepEqual(areas.unmapped, [{ code: 'CW', events: 3 }]);
  const summary = summarizeReports(areas, payload([]));
  assert.equal(summary.unmappedEvents, 3);
  assert.equal(summary.unmapped.length, 1);
});

test('areas sort least intense first so heavier shading draws on top', () => {
  const areas = parseReports(
    payload([
      { code: 'CY', events: 40 },
      { code: 'TL', events: 1 },
    ]),
    INDEX,
  );
  assert.equal(areas[0].band, 'isolated');
  assert.equal(areas[areas.length - 1].band, 'heavy');
});

test('a country drawn as several polygons is counted once', () => {
  // Cyprus contributes two polygons; the event total must not double.
  const areas = parseReports(payload([{ code: 'CY', events: 5 }]), INDEX);
  const summary = summarizeReports(areas, payload([]));
  assert.equal(areas.length, 2);
  assert.equal(summary.countries, 1);
  assert.equal(summary.events, 5);
});

test('a ring with an unusable vertex is rejected whole', () => {
  const broken = indexCountries({
    features: [
      {
        name: 'Broken',
        codes: ['BX'],
        polygons: [
          [
            [0, 0],
            [1, 999],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    ],
  });
  const areas = parseReports(payload([{ code: 'BX', events: 3 }]), broken);
  assert.equal(areas.length, 0);
});

test('the centroid share is reported because it is the honest limitation', () => {
  // Chile and Mexico both ran at 100% in the first live sample: every event
  // geocoded no more precisely than the country itself.
  const areas = parseReports(
    payload([{ code: 'TL', events: 4, centroidOnly: 4 }]),
    INDEX,
  );
  assert.equal(centroidShare(areas[0]), 100);
  assert.equal(centroidShare({ events: 4, centroidOnly: 1 }), 25);
  assert.equal(centroidShare({ events: 0 }), null);
  assert.equal(centroidShare(null), null);
});

test('every card says the data is news-derived and unverified', () => {
  // A shaded country reads as authoritative unless it is told otherwise, so
  // the caveat is per-country rather than in a legend nobody reads.
  const areas = parseReports(
    payload([
      {
        code: 'TL',
        events: 4,
        centroidOnly: 2,
        kinds: { Assault: 3, Fight: 1 },
      },
    ]),
    INDEX,
  );
  const card = countryLabelText(areas[0], { windowMinutes: 15 });
  assert.ok(card.includes('not verified'));
  assert.ok(card.includes('media attention'));
  assert.ok(card.includes('50%'));
  assert.ok(card.includes('Assault ×3'));
});

test('a country with no centroid-only events omits the caveat line', () => {
  const areas = parseReports(
    payload([{ code: 'TL', events: 2, centroidOnly: 0 }]),
    INDEX,
  );
  const card = countryLabelText(areas[0], { windowMinutes: 15 });
  assert.ok(!card.includes('no location more precise'));
  // The unverified warning still stands: it is about provenance, not geocoding.
  assert.ok(card.includes('not verified'));
});

test('an empty update summarizes without inventing activity', () => {
  const areas = parseReports(payload([]), INDEX);
  assert.equal(areas.length, 0);
  const summary = summarizeReports(areas, payload([]));
  assert.equal(summary.countries, 0);
  assert.equal(summary.events, 0);
  assert.deepEqual(summary.unmapped, []);
});

test('a malformed payload is empty rather than throwing', () => {
  assert.equal(parseReports(null, INDEX).length, 0);
  assert.equal(parseReports({}, INDEX).length, 0);
  assert.equal(parseReports({ countries: 'nope' }, INDEX).length, 0);
  assert.equal(
    parseReports(payload([{ code: 'TL', events: 1 }]), null).length,
    0,
  );
});

test('the proxy error body is an error, not a peaceful world', () => {
  const source = createConflictSource({
    fetchImpl: async (u) =>
      u.includes('countries')
        ? { ok: true, json: async () => PACK }
        : { ok: true, json: async () => ({ error: 'upstream_failed' }) },
  });
  return assert.rejects(() => source.fetchReports(), /upstream_failed/);
});

test('a failed country pack is not cached, so a retry can succeed', () => {
  // Without boundaries the layer can draw nothing at all, so caching the
  // rejection would disable the layer for the whole session.
  let attempts = 0;
  const source = createConflictSource({
    fetchImpl: async (u) => {
      if (u.includes('countries')) {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 500 };
        return { ok: true, json: async () => PACK };
      }
      return {
        ok: true,
        json: async () => payload([{ code: 'TL', events: 2 }]),
      };
    },
  });
  return source
    .fetchReports()
    .then(
      () => assert.fail('first attempt should reject'),
      () => source.fetchReports(),
    )
    .then((areas) => {
      assert.equal(attempts, 2);
      assert.equal(areas.length, 1);
    });
});

test('the country pack is fetched once and reused', () => {
  let packFetches = 0;
  const source = createConflictSource({
    fetchImpl: async (u) => {
      if (u.includes('countries')) {
        packFetches += 1;
        return { ok: true, json: async () => PACK };
      }
      return {
        ok: true,
        json: async () => payload([{ code: 'TL', events: 1 }]),
      };
    },
  });
  return source
    .fetchReports()
    .then(() => source.fetchReports())
    .then(() => assert.equal(packFetches, 1));
});

test('an HTTP failure surfaces rather than emptying the map', () => {
  const source = createConflictSource({
    fetchImpl: async (u) =>
      u.includes('countries')
        ? { ok: true, json: async () => PACK }
        : { ok: false, status: 502 },
  });
  return assert.rejects(() => source.fetchReports(), /502/);
});

test('a caller abort is honoured mid-flight', async () => {
  const controller = new AbortController();
  const source = createConflictSource({
    fetchImpl: async (u, opts) => {
      if (u.includes('countries')) return { ok: true, json: async () => PACK };
      return new Promise((_resolve, reject) => {
        // Mirrors real fetch, which rejects rather than hanging when handed a
        // signal that is already aborted.
        if (opts.signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        opts.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      });
    },
  });
  const pending = source.fetchReports({ signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(() => pending, /abort/i);
});

test('an abort during the country-pack load stops before the second request', () => {
  // The pack can take a moment on a cold start. Starting the reports request
  // after the caller has already given up is work nobody is waiting for.
  const controller = new AbortController();
  let reportsRequested = false;
  const source = createConflictSource({
    fetchImpl: async (u) => {
      if (u.includes('countries')) {
        controller.abort();
        return { ok: true, json: async () => PACK };
      }
      reportsRequested = true;
      return { ok: true, json: async () => payload([]) };
    },
  });
  return assert
    .rejects(() => source.fetchReports({ signal: controller.signal }), /abort/i)
    .then(() => assert.equal(reportsRequested, false));
});

test('a failed load keeps its error through the disable the manager triggers', async () => {
  // The manager treats `update() === false` as a rejected enable and disables
  // the layer — which is exactly what a failed first fetch produces. Clearing
  // the error inside disable() therefore turned "the upstream is down" into a
  // layer that quietly switched itself off and reported nothing to see.
  const layer = createConflictReportsLayer({
    source: {
      fetchReports: async () => {
        throw new Error('upstream exploded');
      },
    },
  });
  layer.enable();
  // enable() no longer fetches — the manager calls update() right after it,
  // and fetching in both pulled every feed twice. Mirror the manager here.
  await layer.update();
  const failed = layer;
  assert.match(failed.getStats().error ?? '', /upstream exploded/);
  layer.disable();
  assert.match(
    failed.getStats().error ?? '',
    /upstream exploded/,
    'the reason must survive the disable',
  );
  assert.ok(
    !failed.getStats().coverage.includes('no violent events'),
    `coverage still asserted emptiness: ${failed.getStats().coverage}`,
  );
});
