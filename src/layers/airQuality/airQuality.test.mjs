import test from 'node:test';
import assert from 'node:assert/strict';
import { AQI_BANDS, airNowQueryUrl, bandFor, bandRank } from './policy.js';
import { parseAirQuality, summarizeAirQuality } from './records.js';
import { createAirNowSource } from './source.js';
import { airQualityLabelText } from './index.js';

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

function contour(gridcode, rings = [SQUARE], extra = {}) {
  return {
    geometry: { type: 'Polygon', coordinates: rings },
    properties: { OBJECTID: Math.random(), gridcode, ...extra },
  };
}

test('the six EPA bands are complete, ordered and distinctly coloured', () => {
  const codes = Object.keys(AQI_BANDS)
    .map(Number)
    .sort((a, b) => a - b);
  assert.deepEqual(codes, [1, 2, 3, 4, 5, 6]);
  const colors = new Set();
  for (const code of codes) {
    const band = AQI_BANDS[code];
    assert.equal(band.code, code);
    for (const field of ['name', 'range', 'color', 'guidance'])
      assert.ok(band[field], `band ${code} missing ${field}`);
    assert.match(band.color, /^#[0-9a-f]{6}$/i);
    assert.ok(!colors.has(band.color), `band ${code} reuses a colour`);
    colors.add(band.color);
    // Guidance is health advice; it must actually say something.
    assert.ok(band.guidance.length > 20, `band ${code} guidance too thin`);
  }
  assert.equal(AQI_BANDS[1].name, 'Good');
  assert.equal(AQI_BANDS[6].name, 'Hazardous');
});

test('unknown grid codes resolve to nothing rather than a default band', () => {
  assert.equal(bandFor(99), null);
  assert.equal(bandFor(0), null);
  assert.equal(bandFor(null), null);
  assert.equal(bandRank(99), 0);
  assert.equal(bandRank(6), 6);
});

test('worse air outranks better air, so a bad pocket is never buried', () => {
  const areas = parseAirQuality({
    features: [contour(6), contour(1), contour(3)],
  });
  assert.deepEqual(
    areas.map((a) => a.code),
    [1, 3, 6],
  );
  assert.equal(areas.at(-1).name, 'Hazardous');
});

test('an unrecognised contour is dropped, never drawn in a stand-in colour', () => {
  // Every colour here carries a health meaning: an unknown value shown green
  // is false reassurance, shown red is a false alarm. Silence is the honest
  // option.
  const areas = parseAirQuality({
    features: [contour(1), contour(42), contour(null)],
  });
  assert.equal(areas.length, 1);
  assert.equal(areas[0].code, 1);
});

test('holes survive, and a broken ring drops only what is broken', () => {
  const [withHole] = parseAirQuality({
    features: [contour(2, [SQUARE, HOLE])],
  });
  assert.equal(withHole.holes.length, 1);

  const bad = [
    [-100, 35],
    [NaN, 36],
    [-95, 40],
    [-100, 35],
  ];
  assert.deepEqual(parseAirQuality({ features: [contour(2, [bad])] }), []);
  const [outerOnly] = parseAirQuality({
    features: [contour(2, [SQUARE, bad])],
  });
  assert.equal(outerOnly.holes.length, 0);
  assert.ok(outerOnly.positions.length > 0);
});

test('observation time is read from either field the service may send', () => {
  const [byMs] = parseAirQuality({
    features: [contour(1, [SQUARE], { Timestamp: 1789758000000 })],
  });
  assert.equal(byMs.observedMs, 1789758000000);
  const [bySeconds] = parseAirQuality({
    features: [contour(1, [SQUARE], { Unixtime: 1789758000 })],
  });
  assert.equal(bySeconds.observedMs, 1789758000000);
});

test('the summary reports the worst band, which is the actionable number', () => {
  const summary = summarizeAirQuality(
    parseAirQuality({ features: [contour(1), contour(1), contour(4)] }),
  );
  assert.equal(summary.areas, 3);
  assert.equal(summary.worst, 'Unhealthy');
  assert.equal(summary.worstCode, 4);
  assert.deepEqual(summary.breakdown, [
    { name: 'Good', count: 2 },
    { name: 'Unhealthy', count: 1 },
  ]);
  const empty = summarizeAirQuality([]);
  assert.equal(empty.worst, null);
  assert.equal(empty.areas, 0);
});

test('every card carries the published guidance and the coverage caveat', () => {
  const [area] = parseAirQuality({ features: [contour(5)] });
  const card = airQualityLabelText(area);
  assert.match(card, /Very Unhealthy/);
  assert.match(card, /AQI 201–300/);
  // The health wording is EPA's, not a paraphrase of ours.
  assert.match(card, /Health alert/);
  // Absence of a contour is unmeasured, not clean.
  assert.match(card, /unmeasured, not clean/);
});

test('the query asks for GeoJSON in WGS84', () => {
  const url = airNowQueryUrl();
  assert.match(url, /f=geojson/);
  assert.match(url, /outSR=4326/);
});

test('a failed fetch rejects rather than reporting clean air', async () => {
  // Reporting an outage as "no contours" would read as good air everywhere,
  // which is the most dangerous possible failure mode for this layer.
  const source = createAirNowSource({
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => source.fetchAirQuality({}), /500/);
});
