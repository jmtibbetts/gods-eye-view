import test from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import {
  findNextImagingPass,
  findNextIssPass,
  findNextPass,
  groundDistanceKm,
  solarElevationDeg,
  subpointAt,
} from './satellitePass.js';
import { compassPoint, untilText } from '../ui/sensorsPanel.js';

// NOAA-20, live elements, epoch 2026-09-19. A sun-synchronous afternoon
// orbit: every spot on Earth is under its 3,060 km swath about twice a day.
const NOAA20 = twoline2satrec(
  '1 43013U 17073A   26262.24111710  .00000040  00000+0  39795-4 0  9994',
  '2 43013  98.7821 200.8849 0001386  44.7303 315.3984 14.19526567457812',
);
// GOES-19, parked at 75°W.
const GOES19 = twoline2satrec(
  '1 60133U 24119A   26262.26457023 -.00000253  00000+0  00000+0 0  9996',
  '2 60133   0.0324  14.9261 0000298 235.8372 127.4756  1.00271875  7905',
);
const FROM = Date.parse('2026-09-19T12:00:00Z');
const AUSTIN = { latDeg: 30.2672, lonDeg: -97.7431 };

test('the general finder is the ISS finder, and a polar orbiter passes everywhere within a day', () => {
  assert.equal(findNextIssPass, findNextPass);
  const pass = findNextPass({ satrec: NOAA20, ...AUSTIN, fromMs: FROM, minElevDeg: 10 });
  assert.ok(pass, 'a 98.8° orbit rises over Austin inside 24 h');
  assert.ok(pass.riseMs >= FROM && pass.riseMs < FROM + 86_400_000);
  assert.ok(pass.riseMs < pass.maxElevMs && pass.maxElevMs <= pass.setMs);
  assert.ok(pass.maxElevDeg >= 10 && pass.maxElevDeg <= 90);
  assert.ok(pass.riseAzDeg >= 0 && pass.riseAzDeg < 360);
  // A pass is a few minutes, not an hour: a LEO horizon crossing.
  assert.ok(pass.setMs - pass.riseMs < 20 * 60_000);
});

test('a parked satellite either is or is not in view, and never rises', () => {
  // From Austin GOES-East sits high in the south, permanently.
  const pass = findNextPass({ satrec: GOES19, ...AUSTIN, fromMs: FROM, minElevDeg: 10 });
  assert.ok(pass, 'in view from the start');
  assert.equal(pass.riseMs, FROM, 'already up: the pass begins now');
  assert.ok(pass.maxElevDeg > 30);
  // From Tokyo it is below the horizon and stays there.
  const none = findNextPass({
    satrec: GOES19,
    latDeg: 35.68,
    lonDeg: 139.69,
    fromMs: FROM,
    minElevDeg: 10,
    horizonHours: 6,
  });
  assert.equal(none, null);
});

test('an imaging pass is the swath covering the ground, with off-track distance and daylight', () => {
  const pass = findNextImagingPass({
    satrec: NOAA20,
    ...AUSTIN,
    fromMs: FROM,
    swathKm: 3060,
  });
  assert.ok(pass, 'the swath covers Austin inside 24 h');
  assert.ok(pass.atMs >= FROM && pass.atMs < FROM + 86_400_000);
  assert.ok(pass.offTrackKm >= 0 && pass.offTrackKm <= 1530, `off track ${pass.offTrackKm}`);
  assert.equal(typeof pass.daylight, 'boolean');
  // At closest approach the sub-satellite point really is that far away.
  const sub = subpointAt(NOAA20, pass.atMs);
  const km = groundDistanceKm(AUSTIN.latDeg, AUSTIN.lonDeg, sub.latDeg, sub.lonDeg);
  assert.ok(Math.abs(km - pass.offTrackKm) < 2, `${km} vs ${pass.offTrackKm}`);
  // Daylight agrees with the sun.
  assert.equal(pass.daylight, solarElevationDeg(pass.atMs, AUSTIN.latDeg, AUSTIN.lonDeg) > 0);
  // A narrow swath covers a given spot far less often: Sentinel-2's 290 km
  // may not reach Austin in a day at all, and if it does it is close to nadir.
  const narrow = findNextImagingPass({ satrec: NOAA20, ...AUSTIN, fromMs: FROM, swathKm: 290 });
  if (narrow) assert.ok(narrow.offTrackKm <= 145);
  assert.equal(findNextImagingPass({ satrec: NOAA20, ...AUSTIN, fromMs: FROM, swathKm: 0 }), null);
});

test('the sun is up at noon and down at midnight, near enough', () => {
  const noon = Date.parse('2026-06-21T18:30:00Z'); // solar noon-ish at 97.7°W
  const midnight = Date.parse('2026-06-21T06:30:00Z');
  assert.ok(solarElevationDeg(noon, AUSTIN.latDeg, AUSTIN.lonDeg) > 75);
  assert.ok(solarElevationDeg(midnight, AUSTIN.latDeg, AUSTIN.lonDeg) < -30);
  // Equator at the equinox: the sun passes overhead.
  assert.ok(solarElevationDeg(Date.parse('2026-09-22T12:00:00Z'), 0, 0) > 85);
});

test('text helpers read like a person', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(44), 'NE');
  assert.equal(compassPoint(225), 'SW');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(-90), 'W');
  assert.equal(untilText(FROM + 40_000, FROM), 'in 40 s');
  assert.equal(untilText(FROM + 5 * 60_000, FROM), 'in 5 min');
  assert.equal(untilText(FROM + 72 * 60_000, FROM), 'in 1 h 12 min');
  assert.equal(untilText(FROM + 120 * 60_000, FROM), 'in 2 h');
  assert.equal(untilText(FROM - 1000, FROM), 'now');
  assert.ok(Math.abs(groundDistanceKm(0, 0, 0, 1) - 111.19) < 0.1);
});
