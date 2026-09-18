import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_RANK,
  DEFAULT_PRODUCT,
  FALLBACK_FILL,
  OUTLOOK_PRODUCTS,
  categoryName,
  featureRank,
  outlookUrl,
  productFor,
} from './policy.js';
import { outlookStatement, parseOutlook, summarizeOutlook } from './records.js';
import { createSpcOutlookSource } from './source.js';
import { outlookLabelText } from './index.js';

const CAT = productFor('day1-cat');

function polygon(rings, props) {
  return {
    geometry: { type: 'Polygon', coordinates: rings },
    properties: props,
  };
}

const SQUARE = [
  [-100, 35],
  [-95, 35],
  [-95, 40],
  [-100, 40],
  [-100, 35],
];
const HOLE = [
  [-99, 36],
  [-97, 36],
  [-97, 38],
  [-99, 38],
  [-99, 36],
];

test('every product is completely described and addressable', () => {
  const keys = new Set();
  for (const p of OUTLOOK_PRODUCTS) {
    assert.ok(!keys.has(p.key), `duplicate ${p.key}`);
    keys.add(p.key);
    for (const field of ['chip', 'label', 'file', 'kind', 'blurb'])
      assert.ok(p[field], `${p.key} missing ${field}`);
    assert.ok(['categorical', 'probability'].includes(p.kind));
    assert.match(outlookUrl(p), /^https:\/\/www\.spc\.noaa\.gov\/.*\.geojson$/);
  }
  assert.ok(keys.has(DEFAULT_PRODUCT));
});

test('an unknown product falls back rather than failing', () => {
  assert.equal(productFor('nonsense').key, DEFAULT_PRODUCT);
  assert.equal(productFor(undefined).key, DEFAULT_PRODUCT);
});

test('risk ranks ascend, and anything unrecognised sorts below a known risk', () => {
  assert.ok(CATEGORY_RANK.HIGH > CATEGORY_RANK.MDT);
  assert.ok(CATEGORY_RANK.MDT > CATEGORY_RANK.ENH);
  assert.ok(CATEGORY_RANK.ENH > CATEGORY_RANK.SLGT);
  assert.ok(CATEGORY_RANK.SLGT > CATEGORY_RANK.MRGL);
  assert.ok(CATEGORY_RANK.MRGL > CATEGORY_RANK.TSTM);
  // An unknown label must never outrank a real HIGH risk and bury it.
  assert.ok(featureRank({ label: '???', dn: 99 }) < CATEGORY_RANK.TSTM);
  // Probability labels rank numerically against each other.
  assert.ok(featureRank({ label: '0.30' }) > featureRank({ label: '0.05' }));
});

test('categories expand for readers, and unknown labels pass through', () => {
  assert.equal(categoryName('MDT'), 'Moderate');
  assert.equal(categoryName('tstm'), 'General Thunderstorms');
  assert.equal(categoryName('0.15'), '0.15');
});

test('areas parse lowest-risk-first so high risk is never buried', () => {
  const areas = parseOutlook(
    {
      features: [
        polygon([SQUARE], {
          DN: 6,
          LABEL: 'MDT',
          fill: '#ff0000',
          stroke: '#aa0000',
        }),
        polygon([SQUARE], {
          DN: 2,
          LABEL: 'TSTM',
          fill: '#00ff00',
          stroke: '#00aa00',
        }),
        polygon([SQUARE], {
          DN: 8,
          LABEL: 'HIGH',
          fill: '#ff00ff',
          stroke: '#aa00aa',
        }),
      ],
    },
    CAT,
  );
  assert.deepEqual(
    areas.map((a) => a.label),
    ['TSTM', 'MDT', 'HIGH'],
  );
  assert.equal(areas[0].name, 'General Thunderstorms');
});

test("SPC's own colours are used, with a fallback only when it omits one", () => {
  // The categorical scale is a public convention — recolouring it would
  // misinform even with the labels right.
  const [withColor, without] = parseOutlook(
    {
      features: [
        polygon([SQUARE], {
          DN: 2,
          LABEL: 'TSTM',
          fill: '#C1E9C1',
          stroke: '#55BB55',
        }),
        polygon([SQUARE], { DN: 3, LABEL: 'MRGL', fill: 'not-a-colour' }),
      ],
    },
    CAT,
  );
  assert.equal(withColor.fill, '#C1E9C1');
  assert.equal(withColor.stroke, '#55BB55');
  assert.equal(without.fill, FALLBACK_FILL);
});

test('holes are preserved, because a nested outlook depends on them', () => {
  const [area] = parseOutlook(
    { features: [polygon([SQUARE, HOLE], { DN: 2, LABEL: 'TSTM' })] },
    CAT,
  );
  assert.equal(area.holes.length, 1);
  assert.deepEqual(area.holes[0].slice(0, 4), [-99, 36, -97, 36]);
  // Filling that hole would paint the lower category over the higher one
  // inside it, inverting the map exactly where it matters most.
  assert.equal(area.positions.length, SQUARE.length * 2);
});

test('a ring with an unusable vertex is dropped whole, not drawn bent', () => {
  const bad = [
    [-100, 35],
    [NaN, 36],
    [-95, 40],
    [-100, 35],
  ];
  assert.deepEqual(
    parseOutlook({ features: [polygon([bad], { DN: 2 })] }, CAT),
    [],
  );
  // A bad hole drops the hole, not the whole area.
  const [area] = parseOutlook(
    { features: [polygon([SQUARE, bad], { DN: 2, LABEL: 'TSTM' })] },
    CAT,
  );
  assert.equal(area.holes.length, 0);
  assert.ok(area.positions.length > 0);
});

test('MultiPolygon features split into separate drawable areas', () => {
  const shifted = SQUARE.map(([lon, lat]) => [lon + 20, lat]);
  const areas = parseOutlook(
    {
      features: [
        {
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[SQUARE], [shifted]],
          },
          properties: { DN: 3, LABEL: 'MRGL' },
        },
      ],
    },
    CAT,
  );
  assert.equal(areas.length, 2);
  assert.notDeepEqual(areas[0].positions, areas[1].positions);
});

test('an empty outlook is a quiet day, not a failure', () => {
  assert.deepEqual(parseOutlook({ features: [] }, CAT), []);
  assert.deepEqual(parseOutlook(null, CAT), []);
  const summary = summarizeOutlook([], CAT);
  assert.equal(summary.areas, 0);
  assert.equal(summary.highest, null);
});

test('the summary names the highest risk, which is the number that matters', () => {
  const areas = parseOutlook(
    {
      features: [
        polygon([SQUARE], { DN: 2, LABEL: 'TSTM' }),
        polygon([SQUARE], { DN: 2, LABEL: 'TSTM' }),
        polygon([SQUARE], { DN: 5, LABEL: 'ENH' }),
      ],
    },
    CAT,
  );
  const summary = summarizeOutlook(areas, CAT);
  assert.equal(summary.areas, 3);
  assert.equal(summary.highest, 'Enhanced');
  assert.deepEqual(summary.breakdown, [
    { name: 'General Thunderstorms', count: 2 },
    { name: 'Enhanced', count: 1 },
  ]);
});

test('every card says this is a forecast and where SPC actually forecasts', () => {
  const [area] = parseOutlook(
    {
      features: [
        polygon([SQUARE], { DN: 5, LABEL: 'ENH', LABEL2: 'Enhanced Risk' }),
      ],
    },
    CAT,
  );
  const card = outlookLabelText(area);
  assert.match(card, /not a warning/i);
  // An empty outlook over Europe means "not covered", not "no risk".
  assert.match(card, /CONUS/);
});

test("an empty product still reports SPC's own assessment", () => {
  // When tornado risk is below threshold everywhere, SPC publishes a feature
  // with an empty geometry labelled "Less Than 2% All Areas". That is an
  // active forecast, not a missing file, and the two mean different things to
  // someone deciding whether to worry.
  const payload = {
    features: [
      {
        geometry: { type: 'GeometryCollection', geometries: [] },
        properties: { DN: 0, LABEL: 'Less Than 2% All Areas' },
      },
    ],
  };
  assert.deepEqual(parseOutlook(payload, CAT), []);
  assert.equal(outlookStatement(payload), 'Less Than 2% All Areas');
  const summary = summarizeOutlook([], CAT, outlookStatement(payload));
  assert.equal(summary.statement, 'Less Than 2% All Areas');
  // A genuinely empty file has nothing to report.
  assert.equal(outlookStatement({ features: [] }), null);
  assert.equal(outlookStatement(null), null);
  // A drawable feature is not a statement.
  assert.equal(
    outlookStatement({
      features: [polygon([SQUARE], { DN: 2, LABEL: 'TSTM' })],
    }),
    null,
  );
});

test('a failed fetch rejects rather than resolving to an empty forecast', async () => {
  const source = createSpcOutlookSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(() => source.fetchOutlook(CAT, {}), /503/);
});

test('the source requests the file the product names', async () => {
  const seen = [];
  const source = createSpcOutlookSource({
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, json: async () => ({ features: [] }) };
    },
  });
  const result = await source.fetchOutlook(productFor('day1-torn'), {});
  assert.match(seen[0], /day1otlk_torn\.nolyr\.geojson$/);
  assert.deepEqual(result.areas, []);
  assert.equal(result.statement, null);
});
