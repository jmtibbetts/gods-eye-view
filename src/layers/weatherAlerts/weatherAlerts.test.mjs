import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWeatherAlerts } from './records.js';
import { createNwsAlertsSource } from './source.js';
import { severityColor } from './policy.js';

const POLY = (offset = 0) => [
  [
    [-97 + offset, 30],
    [-96 + offset, 30],
    [-96 + offset, 31],
    [-97 + offset, 31],
    [-97 + offset, 30],
  ],
];

const PAYLOAD = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'urn:oid:zone-only',
      geometry: null,
      properties: { event: 'Heat Advisory', severity: 'Minor' },
    },
    {
      id: 'urn:oid:tornado',
      geometry: { type: 'Polygon', coordinates: POLY() },
      properties: {
        event: 'Tornado Warning',
        severity: 'Extreme',
        urgency: 'Immediate',
        headline: 'Tornado Warning issued',
        areaDesc: 'Travis, TX',
        description: 'A tornado was sighted.',
        instruction: 'Take cover now.',
        senderName: 'NWS Austin',
        expires: '2026-09-17T18:00:00-05:00',
      },
    },
    {
      id: 'urn:oid:flood',
      geometry: { type: 'MultiPolygon', coordinates: [POLY(2), POLY(4)] },
      properties: { event: 'Flash Flood Warning', severity: 'Severe' },
    },
    {
      id: 'urn:oid:bad',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
      properties: { event: 'Broken', severity: 'Minor' },
    },
  ],
};

test('normalizeWeatherAlerts keeps polygon alerts, drops zone-only and degenerate, sorts worst last', () => {
  const { alerts, total } = normalizeWeatherAlerts(PAYLOAD);
  assert.equal(total, 4);
  assert.deepEqual(
    alerts.map((a) => a.event),
    ['Flash Flood Warning', 'Tornado Warning'],
    'severe before extreme (worst added last); zone-only and 2-point ring dropped',
  );
  const tornado = alerts[1];
  assert.equal(tornado.instruction, 'Take cover now.');
  assert.equal(tornado.rings.length, 1);
  assert.ok(Number.isFinite(tornado.lat) && Number.isFinite(tornado.lon));
  const flood = alerts[0];
  assert.equal(flood.rings.length, 2, 'multipolygon keeps both outer rings');
  assert.equal(normalizeWeatherAlerts({}), null);
});

test('severity colours are defined for every NWS level', () => {
  for (const s of ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown', '???'])
    assert.match(severityColor(s), /^#[0-9a-f]{6}$/i);
});

test('the source validates and honours abort', async () => {
  const src = createNwsAlertsSource({
    fetchImpl: async () => ({ ok: true, json: async () => PAYLOAD }),
  });
  const snap = await src.getSnapshot();
  assert.equal(snap.alerts.length, 2);
  const bad = createNwsAlertsSource({
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(bad.getSnapshot(), /HTTP 500/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(src.getSnapshot({ signal: aborted.signal }));
});
