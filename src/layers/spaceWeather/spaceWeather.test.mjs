import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AURORA_MIN_PROBABILITY,
  AURORA_RAMP,
  auroraBand,
  bandCells,
  createSpaceWeatherLayer,
  createSwpcSource,
  kpText,
  parseAlerts,
  parseAurora,
  parseKp,
  parseScales,
} from './index.js';

const NOW = Date.parse('2026-09-19T21:30:00Z');

/** A tiny OVATION grid: the shape SWPC sends, at a few cells. */
function ovation(cells) {
  // The real grid is 360×181; the parser refuses anything much smaller, so
  // pad with zeros and let the interesting cells stand.
  const rows = [];
  for (let lon = 0; lon < 360; lon += 1)
    for (let lat = -90; lat <= 90; lat += 30) rows.push([lon, lat, 0]);
  for (const [lon, lat, p] of cells) rows.push([lon, lat, p]);
  return {
    'Observation Time': '2026-09-19T21:04:00Z',
    'Forecast Time': '2026-09-19T22:11:00Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates: rows,
    type: 'MultiPoint',
  };
}

test('the oval keeps only cells worth drawing, wraps longitude west, and refuses a broken grid', () => {
  const grid = parseAurora(
    ovation([
      [200, 66, 45],
      [355, 64, 12],
      [10, 63, 3],
      [30, 90, 80],
      [300, -70, 22],
    ]),
  );
  assert.equal(grid.observedAt, '2026-09-19T21:04:00.000Z');
  assert.equal(grid.forecastAt, '2026-09-19T22:11:00.000Z');
  assert.equal(grid.max, 80, 'the maximum counts the pole even though it is not drawn');
  const drawn = grid.cells.map((c) => `${c.lon},${c.lat},${c.p}`);
  assert.deepEqual(drawn, ['-160,66,45', '-5,64,12', '-60,-70,22']);
  assert.ok(AURORA_MIN_PROBABILITY > 3, 'a 3% cell is not drawn');
  assert.equal(parseAurora({ coordinates: [[0, 0, 1]] }), null, 'too small to be the grid');
  assert.equal(parseAurora({ coordinates: [...Array(2000)].map(() => [0, 0]) }), null);
  assert.equal(parseAurora(null), null);
});

test('cells are banded by probability into the ramp, and the ramp is ascending', () => {
  let last = -1;
  for (const step of AURORA_RAMP) {
    assert.ok(step.min > last);
    last = step.min;
    assert.match(step.color, /^#[0-9a-f]{6}$/i);
    assert.ok(step.alpha > 0 && step.alpha <= 0.7);
  }
  assert.equal(auroraBand(4), null);
  assert.equal(auroraBand(5).min, 5);
  assert.equal(auroraBand(39).min, 20);
  assert.equal(auroraBand(95).min, 80);
  const groups = bandCells([
    { lon: 0, lat: 60, p: 7 },
    { lon: 1, lat: 60, p: 25 },
    { lon: 2, lat: 60, p: 26 },
    { lon: 3, lat: 60, p: 90 },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.band.min, g.cells.length]),
    [
      [5, 1],
      [20, 2],
      [80, 1],
    ],
  );
});

test('Kp, the scales and the alerts read as SWPC publishes them', () => {
  const kp = parseKp([
    { time_tag: '2026-09-19T15:00:00', Kp: 2.33, a_running: 9, station_count: 8 },
    { time_tag: '2026-09-19T18:00:00', Kp: 1.67, a_running: 6, station_count: 8 },
  ]);
  assert.equal(kp.kp, 1.67);
  assert.equal(kp.at, '2026-09-19T18:00:00.000Z');
  assert.deepEqual(kp.last24h, [2.33, 1.67]);
  assert.equal(parseKp('nope'), null);
  assert.equal(parseKp([{ time_tag: 'bad', Kp: 'x' }]), null);
  assert.equal(kpText(1.67), 'Kp 1.7 · quiet');
  assert.equal(kpText(5.33), 'Kp 5.3 · G1 storm');
  assert.equal(kpText(9), 'Kp 9.0 · G5 storm');
  assert.equal(kpText(NaN), 'Kp unavailable');

  const scales = parseScales({
    0: {
      DateStamp: '2026-09-19',
      TimeStamp: '21:11:00',
      R: { Scale: '0', Text: 'none' },
      S: { Scale: '0', Text: 'none' },
      G: { Scale: '2', Text: 'moderate' },
    },
    1: { DateStamp: '2026-09-20', R: { Scale: '1', Text: 'minor' }, S: { Scale: '0', Text: 'none' }, G: { Scale: '0', Text: 'none' } },
    '-1': { DateStamp: '2026-09-18' },
  });
  assert.equal(scales.now.G.level, 2);
  assert.equal(scales.now.G.text, 'moderate');
  assert.equal(scales.now.time, '21:11:00');
  assert.equal(scales.outlook.length, 1);
  assert.equal(scales.outlook[0].R.level, 1);
  assert.equal(parseScales({}), null);

  const alerts = parseAlerts(
    [
      { product_id: 'K04W', issue_datetime: '2026-09-19 05:38:03.320', message: 'Space Weather Message Code: WARK04\r\nSerial Number: 5418\r\n\r\nEXTENDED WARNING: Geomagnetic K-index of 4 expected\nValid From: ...' },
      { product_id: 'K04W', issue_datetime: '2026-09-19 01:00:00.000', message: 'older copy' },
      { product_id: 'A20F', issue_datetime: '2026-09-19 20:00:00.000', message: 'Space Weather Message Code: ALTK04\r\nALERT: Geomagnetic K-index of 4\r\n' },
      { product_id: 'OLD', issue_datetime: '2026-09-17 20:00:00.000', message: 'ALERT: ancient' },
      null,
    ],
    NOW,
  );
  assert.deepEqual(
    alerts.map((a) => [a.code, a.headline]),
    [
      ['A20F', 'ALERT: Geomagnetic K-index of 4'],
      ['K04W', 'EXTENDED WARNING: Geomagnetic K-index of 4 expected'],
    ],
    'newest first, one per code, nothing older than a day',
  );
  assert.deepEqual(parseAlerts(null, NOW), []);
});

test('the source needs the oval and tolerates the rest going missing', async () => {
  const asked = [];
  const source = createSwpcSource({
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.includes('ovation')) return { ok: true, json: async () => ovation([[200, 66, 45]]) };
      if (url.includes('k-index')) return { ok: false, status: 503 };
      if (url.includes('scales')) throw new Error('reset');
      return { ok: true, json: async () => [] };
    },
    now: () => NOW,
  });
  const report = await source.fetchSpaceWeather();
  assert.equal(report.aurora.cells.length, 1);
  assert.equal(report.kp, null);
  assert.equal(report.scales, null);
  assert.deepEqual(report.alerts, []);
  assert.equal(asked.length, 4);
  const broken = createSwpcSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(broken.fetchSpaceWeather(), /Malformed OVATION/);
});

function harness(report) {
  const added = [];
  const removed = [];
  const viewer = {
    scene: {
      requestRender() {},
      primitives: {
        add: (p) => added.push(p),
        remove: (p) => removed.push(p),
      },
    },
  };
  const built = [];
  const layer = createSpaceWeatherLayer({
    source: { fetchSpaceWeather: async () => report },
    primitiveFactory: (instances, band) => {
      const primitive = { instances, band };
      built.push(primitive);
      return primitive;
    },
  });
  layer.init(viewer);
  return { layer, viewer, added, removed, built };
}

test('the layer draws one ground primitive per band and tells the row what SWPC said', async () => {
  const report = {
    aurora: {
      observedAt: '2026-09-19T21:04:00.000Z',
      forecastAt: '2026-09-19T22:11:00.000Z',
      max: 45,
      cells: [
        { lon: -160, lat: 66, p: 45 },
        { lon: -159, lat: 66, p: 44 },
        { lon: -5, lat: 64, p: 12 },
      ],
    },
    kp: { kp: 4.33, at: '2026-09-19T18:00:00.000Z', last24h: [4.33] },
    scales: { now: { R: { level: 0, text: 'none' }, S: { level: 0, text: 'none' }, G: { level: 1, text: 'minor' }, time: '21:11:00' }, outlook: [] },
    alerts: [{ code: 'K04W', at: '2026-09-19T20:00:00.000Z', headline: 'WARNING: Geomagnetic K-index of 4 expected', message: '' }],
  };
  const h = harness(report);
  h.layer.enable(h.viewer);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.built.length, 2, 'two bands present: 40% and 5%');
  assert.deepEqual(
    h.built.map((p) => [p.band.min, p.instances.length]),
    [
      [40, 2],
      [5, 1],
    ],
  );
  assert.equal(h.added.length, 2);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.coverage, 'Kp 4.3 · active · aurora ≤ 45% · fcst 22:11Z');
  const legend = h.layer.getRowControls().legend.map((l) => l.label);
  assert.deepEqual(legend, [
    'Kp 4.3 · active',
    'G1 minor',
    'R0 none · S0 none',
    'aurora up to 45%',
    'WARNING: Geomagnetic K-index of 4 expected',
  ]);
  assert.match(h.layer.getRowControls().legend[3].blurb, /a probability, not a sighting/);
  assert.equal(h.layer.getAnalystRecords().length, 1);
  assert.match(h.layer.getAnalystRecords()[0].detail, /G1 · R0 · S0/);
  // A refresh replaces the primitives rather than stacking them.
  await h.layer.update();
  assert.equal(h.removed.length, 2);
  assert.equal(h.added.length, 4);
  h.layer.disable();
  assert.equal(h.removed.length, 4, 'disable clears the globe');
  assert.equal(h.layer.getStats().count, 3, 'the last report is still known');
});

test('a cell on the antimeridian or the pole is clamped into the ellipsoid, never past it', async () => {
  // Rectangle.fromDegrees throws for an east edge past 180°, and the OVATION
  // grid has a column centred exactly there; the first live load died on it.
  const built = [];
  const viewer = { scene: { requestRender() {}, primitives: { add() {}, remove() {} } } };
  const layer = createSpaceWeatherLayer({
    source: {
      fetchSpaceWeather: async () => ({
        aurora: {
          observedAt: null,
          forecastAt: null,
          max: 50,
          cells: [
            { lon: 180, lat: 67, p: 50 },
            { lon: -179, lat: 67, p: 50 },
            { lon: 0, lat: 89, p: 50 },
            { lon: 0, lat: -89, p: 50 },
          ],
        },
        kp: null,
        scales: null,
        alerts: [],
      }),
    },
    primitiveFactory: (instances) => {
      built.push(instances);
      return {};
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  assert.equal(built[0].length, 4);
  for (const instance of built[0]) {
    const r = instance.geometry._rectangle;
    assert.ok(r.west >= -Math.PI && r.east <= Math.PI, 'inside the ellipsoid');
    assert.ok(r.south >= -Math.PI / 2 && r.north <= Math.PI / 2);
    assert.ok(r.east > r.west && r.north > r.south, 'never degenerate');
  }
});

test('a failed fetch is reported, survives a disable, and the layer stays constructible', async () => {
  const added = [];
  const viewer = { scene: { requestRender() {}, primitives: { add: (p) => added.push(p), remove() {} } } };
  const layer = createSpaceWeatherLayer({
    source: {
      fetchSpaceWeather: async () => {
        throw new Error('SWPC HTTP 503');
      },
    },
    primitiveFactory: () => ({}),
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, 'SWPC HTTP 503');
  assert.equal(layer.getStats().coverage, 'unavailable');
  layer.disable();
  assert.equal(layer.getStats().error, 'SWPC HTTP 503', 'the row still says why');
  assert.equal(added.length, 0);
  assert.throws(() => createSpaceWeatherLayer({}), /requires an SWPC source/);
});
