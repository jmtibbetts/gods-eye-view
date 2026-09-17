import test from 'node:test';
import assert from 'node:assert/strict';
import { alertSummary, volcanoColor } from './policy.js';
import {
  normalizeVolcanoAlerts,
  normalizeVolcanoCoordinates,
} from './records.js';

const COORDS = normalizeVolcanoCoordinates({
  volcanoes: {
    311120: { lat: 52.0764, lon: -176.1108, name: 'Great Sitkin', elev: 1740 },
    332010: { lat: 19.3668, lon: -155.201, elev: 1024 },
    999999: { lat: 'nope', lon: 5 },
    888888: { lat: 999, lon: 5 },
  },
});

// Shaped like volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes.
const FEED = [
  {
    vnum: '311120',
    volcano_name: 'Great Sitkin',
    color_code: 'ORANGE',
    alert_level: 'WATCH',
    obs_fullname: 'Alaska Volcano Observatory',
    obs_abbr: 'avo',
    sent_utc: '2026-09-16 21:25:22',
    notice_url: 'https://volcanoes.usgs.gov/notice/x',
  },
  {
    vnum: '332010',
    volcano_name: 'Kilauea',
    color_code: 'YELLOW',
    alert_level: 'ADVISORY',
    obs_fullname: 'Hawaiian Volcano Observatory',
    obs_abbr: 'hvo',
  },
  { vnum: '404404', volcano_name: 'Nowhere', color_code: 'RED' },
];

test('coordinate table drops unusable rows', () => {
  assert.equal(COORDS.size, 2);
  assert.equal(COORDS.has('999999'), false);
  assert.equal(COORDS.has('888888'), false);
  assert.equal(COORDS.get('311120').lat, 52.0764);
  assert.equal(normalizeVolcanoCoordinates(null).size, 0);
  assert.equal(normalizeVolcanoCoordinates({}).size, 0);
});

test('alerts join to coordinates and keep the live notice name', () => {
  const { volcanoes, total, unplaced } = normalizeVolcanoAlerts(FEED, COORDS);
  assert.equal(total, 3);
  assert.equal(volcanoes.length, 2);
  // The bundle has no name for 332010 and a stale one is never preferred:
  // the notice is the authority for what the volcano is called.
  const kilauea = volcanoes.find((v) => v.vnum === '332010');
  assert.equal(kilauea.name, 'Kilauea');
  assert.equal(kilauea.lat, 19.3668);
  assert.deepEqual(unplaced, ['Nowhere']);
});

test('alerts sort least severe first so the worst draws on top', () => {
  const { volcanoes } = normalizeVolcanoAlerts(FEED, COORDS);
  assert.equal(volcanoes[0].colorCode, 'YELLOW');
  assert.equal(volcanoes.at(-1).colorCode, 'ORANGE');
});

test('a malformed payload is rejected, not guessed at', () => {
  assert.equal(normalizeVolcanoAlerts(null, COORDS), null);
  assert.equal(normalizeVolcanoAlerts({ nope: true }, COORDS), null);
  assert.deepEqual(normalizeVolcanoAlerts([], COORDS).volcanoes, []);
});

test('duplicate vnums in one feed are collapsed', () => {
  const { volcanoes } = normalizeVolcanoAlerts(
    [FEED[0], { ...FEED[0], color_code: 'RED' }],
    COORDS,
  );
  assert.equal(volcanoes.length, 1);
  assert.equal(volcanoes[0].colorCode, 'ORANGE');
});

test('missing codes fall back rather than throwing', () => {
  const { volcanoes } = normalizeVolcanoAlerts(
    [{ vnum: '311120', volcano_name: 'X' }],
    COORDS,
  );
  assert.equal(volcanoes[0].colorCode, 'UNASSIGNED');
  assert.equal(volcanoes[0].alertLevel, 'NORMAL');
  assert.equal(volcanoColor('nonsense'), '#8e8e93');
  assert.equal(volcanoColor('red'), '#ff2d55');
});

test('the two hazard scales are reported separately', () => {
  assert.equal(
    alertSummary('ORANGE', 'WATCH'),
    'Aviation ORANGE · Ground WATCH',
  );
  assert.equal(alertSummary(null, null), 'Aviation UNASSIGNED · Ground NORMAL');
});
