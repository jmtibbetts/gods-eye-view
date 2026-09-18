import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HORIZON,
  DRAWN_STATUSES,
  FLOOD_HORIZONS,
  FLOOD_STATUSES,
  SCALE_TOLERANCE,
  floodQueryUrl,
  horizonFor,
  statusFor,
  statusRank,
} from './policy.js';
import {
  aboveFloodStage,
  parseGauges,
  scaleMismatch,
  summarizeGauges,
} from './records.js';
import { createNwpsGaugeSource } from './source.js';
import { gaugeLabelText } from './index.js';

const NOW = horizonFor('observed');
const F48 = horizonFor('f48');

function gauge(props, lon = -86, lat = 40) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: props,
  };
}

const NORMAL = {
  gaugelid: 'DECI3',
  status: 'moderate',
  location: 'Decatur',
  waterbody: 'St Marys River',
  state: 'IN',
  observed: '23.1',
  forecast: '23.4',
  units: 'ft',
  action: '13',
  flood: '17',
  moderate: '20',
  major: '24',
  obstime: '2026-09-18 18:45:00',
  fcsttime: '2026-09-19 00:00:00',
  url: 'https://water.noaa.gov/gauges/DECI3',
};

test('horizons name their own stage and time columns', () => {
  // The observed layer and the forecast layers do not share a schema, and the
  // service answers a wrong column with an error inside an HTTP 200 rather
  // than an HTTP error — so this mapping is what keeps three of four horizons
  // from silently reporting "no gauges" during a flood.
  assert.equal(NOW.stageField, 'observed');
  assert.equal(NOW.timeField, 'obstime');
  for (const h of FLOOD_HORIZONS.filter((x) => x.key !== 'observed')) {
    assert.equal(h.stageField, 'forecast');
    assert.equal(h.timeField, 'fcsttime');
  }
});

test('the query asks each horizon only for columns it has', () => {
  const now = new URL(floodQueryUrl(NOW));
  const fields = now.searchParams.get('outFields').split(',');
  assert.ok(fields.includes('observed'));
  assert.ok(fields.includes('obstime'));
  assert.ok(!fields.includes('forecast'));
  assert.ok(!fields.includes('fcsttime'));

  const later = new URL(floodQueryUrl(F48));
  const laterFields = later.searchParams.get('outFields').split(',');
  assert.ok(laterFields.includes('forecast'));
  assert.ok(laterFields.includes('fcsttime'));
  assert.ok(!laterFields.includes('observed'));
  assert.ok(!laterFields.includes('obstime'));
});

test('the where clause is encoded, not concatenated', () => {
  const url = new URL(floodQueryUrl(NOW));
  const where = url.searchParams.get('where');
  for (const status of DRAWN_STATUSES) assert.ok(where.includes(`'${status}'`));
  // The raw query string must carry the quotes and parens encoded; an
  // unencoded IN clause is how this returned zero gauges mid-flood.
  assert.ok(!url.search.includes("'"));
  assert.ok(url.search.includes('%27'));
});

test('the query path targets the horizon layer id', () => {
  assert.ok(floodQueryUrl(NOW).includes('/MapServer/0/query'));
  assert.ok(floodQueryUrl(F48).includes('/MapServer/2/query'));
});

test('an unknown horizon falls back to the default rather than throwing', () => {
  assert.equal(horizonFor('nonsense').key, DEFAULT_HORIZON);
  assert.equal(horizonFor(undefined).key, DEFAULT_HORIZON);
});

test('a forecast horizon reads the forecast column, not the observed one', () => {
  const [row] = parseGauges({ features: [gauge(NORMAL)] }, F48);
  assert.equal(row.stage, 23.4);
  assert.equal(row.stageTime, '2026-09-19 00:00:00');
  assert.equal(row.forecast, true);

  const [obs] = parseGauges({ features: [gauge(NORMAL)] }, NOW);
  assert.equal(obs.stage, 23.1);
  assert.equal(obs.stageTime, '2026-09-18 18:45:00');
  assert.equal(obs.forecast, false);
});

test('statuses below action stage are dropped even if the service sends them', () => {
  const rows = parseGauges(
    {
      features: [
        gauge({ ...NORMAL, status: 'no_flooding' }),
        gauge({ ...NORMAL, status: 'not_defined' }, -87),
        gauge({ ...NORMAL, status: 'action' }, -88),
      ],
    },
    NOW,
  );
  // The layer's promise is that everything drawn is at or above action stage.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'action');
});

test('gauges sort least severe first so worse floods draw on top', () => {
  const rows = parseGauges(
    {
      features: [
        gauge({ ...NORMAL, gaugelid: 'A', status: 'major' }),
        gauge({ ...NORMAL, gaugelid: 'B', status: 'action' }, -87),
        gauge({ ...NORMAL, gaugelid: 'C', status: 'moderate' }, -88),
      ],
    },
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ['action', 'moderate', 'major'],
  );
});

test('a repeated gauge is drawn once', () => {
  const rows = parseGauges(
    { features: [gauge(NORMAL), gauge(NORMAL, -86.0001)] },
    NOW,
  );
  assert.equal(rows.length, 1);
});

test('a gauge with no reading is not a gauge reading zero', () => {
  const [row] = parseGauges(
    { features: [gauge({ ...NORMAL, observed: '' })] },
    NOW,
  );
  assert.equal(row.stage, null);
  assert.equal(aboveFloodStage(row), null);
});

test('bad coordinates are rejected rather than drawn at null island', () => {
  const rows = parseGauges(
    {
      features: [
        gauge(NORMAL, 999, 40),
        gauge(NORMAL, -86, 999),
        { type: 'Feature', geometry: null, properties: NORMAL },
      ],
    },
    NOW,
  );
  assert.equal(rows.length, 0);
});

test('a reading on the same scale as its thresholds keeps its difference', () => {
  const [row] = parseGauges({ features: [gauge(NORMAL)] }, NOW);
  assert.equal(row.scaleMismatch, false);
  assert.equal(aboveFloodStage(row), 6.1);
});

test('a gauge below flood stage reports a negative difference, not zero', () => {
  // Action stage is by definition below flood stage, and that is the most
  // common status on the map — clamping it would mislabel the normal case.
  const [row] = parseGauges(
    { features: [gauge({ ...NORMAL, status: 'action', observed: '14' })] },
    NOW,
  );
  assert.equal(aboveFloodStage(row), -3);
});

test('a reading on a different scale from its thresholds withholds the difference', () => {
  // Provo UT, observed live: 779.08 ft against an 8.19/8.76/9.15/9.52 ladder.
  const [row] = parseGauges(
    {
      features: [
        gauge({
          ...NORMAL,
          location: 'Provo',
          state: 'UT',
          status: 'major',
          observed: '779.08',
          action: '8.19',
          flood: '8.76',
          moderate: '9.15',
          major: '9.52',
        }),
      ],
    },
    NOW,
  );
  assert.equal(row.scaleMismatch, true);
  assert.equal(aboveFloodStage(row), null);
  // NOAA's own severity is untouched: the gauge stays on the map in major flood.
  assert.equal(row.status, 'major');
  assert.equal(row.stage, 779.08);
  const card = gaugeLabelText(row);
  assert.ok(card.includes('different scales'));
  assert.ok(!card.includes('770'));
});

test('a lake gauge with placeholder thresholds is caught too', () => {
  // Devils Lake ND, observed live: ~50 ft against a 0.1/0.2/0.3 ladder.
  const [row] = parseGauges(
    {
      features: [
        gauge({
          ...NORMAL,
          status: 'major',
          observed: '50.09',
          action: '',
          flood: '0.1',
          moderate: '0.2',
          major: '0.3',
        }),
      ],
    },
    NOW,
  );
  assert.equal(row.scaleMismatch, true);
  assert.equal(aboveFloodStage(row), null);
});

test('a gauge on an elevation datum is left alone when it is self-consistent', () => {
  // Lake Zorinsky NE, observed live: 1113.14 ft against 1112/1119/1122/1128.2.
  // Large absolute numbers are not the problem; disagreeing scales are.
  const [row] = parseGauges(
    {
      features: [
        gauge({
          ...NORMAL,
          status: 'action',
          observed: '1113.14',
          action: '1112',
          flood: '1119',
          moderate: '1122',
          major: '1128.2',
        }),
      ],
    },
    NOW,
  );
  assert.equal(row.scaleMismatch, false);
  assert.equal(aboveFloodStage(row), -5.86);
});

test('a single published threshold is taken at face value', () => {
  // Carters Lake GA publishes an action stage and nothing else; there is no
  // span to judge against, so the reading is trusted rather than suppressed.
  assert.equal(scaleMismatch(1074.24, [1074, null, null, null]), false);
  assert.equal(scaleMismatch(null, [1, 2, 3, 4]), false);
});

test('a genuinely high river is not mistaken for a scale mismatch', () => {
  // A gauge well above major flood stage on a consistent scale is what a
  // serious flood looks like and must keep its difference.
  const ladder = [13, 17, 20, 24];
  assert.equal(scaleMismatch(30, ladder), false);
  assert.equal(scaleMismatch(24 + SCALE_TOLERANCE * 11 - 1, ladder), false);
  assert.equal(scaleMismatch(24 + SCALE_TOLERANCE * 11 + 1, ladder), true);
});

test('the summary names the worst status present, not just a count', () => {
  const rows = parseGauges(
    {
      features: [
        gauge({ ...NORMAL, gaugelid: 'A', status: 'action' }),
        gauge({ ...NORMAL, gaugelid: 'B', status: 'action' }, -87),
        gauge({ ...NORMAL, gaugelid: 'C', status: 'major' }, -88),
      ],
    },
    NOW,
  );
  const summary = summarizeGauges(rows, NOW);
  assert.equal(summary.gauges, 3);
  assert.equal(summary.worst, 'Major Flood');
  assert.equal(summary.worstRank, FLOOD_STATUSES.major.rank);
  assert.deepEqual(summary.breakdown, [
    { name: 'Action', count: 2 },
    { name: 'Major Flood', count: 1 },
  ]);
});

test('an empty network summarizes without inventing a worst case', () => {
  const summary = summarizeGauges([], NOW);
  assert.equal(summary.gauges, 0);
  assert.equal(summary.worst, null);
  assert.equal(summary.worstRank, 0);
});

test('statuses carry NOAA severity order and colours', () => {
  assert.ok(
    statusRank('major') > statusRank('moderate') &&
      statusRank('moderate') > statusRank('minor') &&
      statusRank('minor') > statusRank('action'),
  );
  assert.equal(statusFor('MAJOR').color, '#cc33ff');
  assert.equal(statusFor(' minor ').key, 'minor');
  assert.equal(statusFor('no_flooding'), null);
  assert.equal(statusRank('no_flooding'), 0);
});

test('a forecast card says it is a forecast', () => {
  const [row] = parseGauges({ features: [gauge(NORMAL)] }, F48);
  const card = gaugeLabelText(row);
  assert.ok(card.includes('Forecast stage'));
  assert.ok(card.includes('not a reading'));
  const [obs] = parseGauges({ features: [gauge(NORMAL)] }, NOW);
  assert.ok(!gaugeLabelText(obs).includes('not a reading'));
});

test('an ArcGIS error inside a 200 is an error, not an empty network', () => {
  // The service answers a bad query with HTTP 200 and an `error` body. Reading
  // that as "no gauges are flooding" is the worst failure this layer can have.
  const source = createNwpsGaugeSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ error: { message: 'Failed to execute query.' } }),
    }),
  });
  return assert.rejects(
    () => source.fetchGauges(NOW),
    /Failed to execute query/,
  );
});

test('an HTTP failure surfaces rather than emptying the map', () => {
  const source = createNwpsGaugeSource({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  return assert.rejects(() => source.fetchGauges(NOW), /503/);
});

test('a caller abort is honoured', async () => {
  const controller = new AbortController();
  const source = createNwpsGaugeSource({
    fetchImpl: (url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  const pending = source.fetchGauges(NOW, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /aborted/);
});
