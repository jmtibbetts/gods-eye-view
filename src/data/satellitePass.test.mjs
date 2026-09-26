// src/data/satellitePass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec, propagate } from 'satellite.js';
import {
  findNextSatellitePass,
  hasVisibleInterval,
  lookAnglesAt,
  solarPositionECI,
  isSatelliteSunlit,
  observerSolarElevation,
  isObserverDark,
  findNextImagingPass,
  findNextPass,
  groundDistanceKm,
  solarElevationDeg,
  subpointAt,
} from './satellitePass.js';
import { findNextIssPass } from './issPass.js';
import { compassPoint, untilText } from '../ui/sensorsPanel.js';

// Canonical archived ISS TLE (epoch 2008-09-20 ~12:25 UTC).
const L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const AUSTIN = { latDeg: 30.2672, lonDeg: -97.7431 };
const FROM_MS = Date.UTC(2008, 8, 20, 12, 30, 0);

test('solarPositionECI matches the Sun at J2000.0', () => {
  // Reference: Cesium Simon1994PlanetaryPositions at 2000-01-01 12:00 UTC
  // gives RA 281.289°, Dec -23.033°.
  const j2000 = solarPositionECI(Date.UTC(2000, 0, 1, 12, 0, 0));
  assert.ok(
    Math.abs(j2000.raDeg - 281.289) < 0.05,
    `RA ${j2000.raDeg}° within 0.05°`,
  );
  assert.ok(
    Math.abs(j2000.decDeg - -23.033) < 0.05,
    `Dec ${j2000.decDeg}° within 0.05°`,
  );
});

test('solarPositionECI calculates reasonable solar coordinates across seasons', () => {
  // Near Autumnal Equinox (Sept 22, 2020): declination ≈ 0°
  const equinox = solarPositionECI(Date.UTC(2020, 8, 22, 12, 0, 0));
  assert.ok(
    Math.abs(equinox.decDeg) < 1.0,
    'declination near equinox must be close to 0°',
  );

  // Near Summer Solstice (June 21, 2020): declination ≈ +23.44°
  const solsticeSummer = solarPositionECI(Date.UTC(2020, 5, 21, 12, 0, 0));
  assert.ok(
    Math.abs(solsticeSummer.decDeg - 23.44) < 0.5,
    'summer declination ≈ 23.44°',
  );

  // Near Winter Solstice (Dec 21, 2020): declination ≈ -23.44°
  const solsticeWinter = solarPositionECI(Date.UTC(2020, 11, 21, 12, 0, 0));
  assert.ok(
    Math.abs(solsticeWinter.decDeg - -23.44) < 0.5,
    'winter declination ≈ -23.44°',
  );
});

test('observerSolarElevation distinguishes local noon from local midnight', () => {
  // Greenwich noon on equinox: solar elevation should be close to 90 - lat
  const greenwichNoon = observerSolarElevation(
    51.5,
    0,
    Date.UTC(2020, 8, 22, 12, 0, 0),
  );
  assert.ok(greenwichNoon > 30, 'sun must be well above horizon at local noon');

  // Greenwich midnight: solar elevation must be deeply negative
  const greenwichMidnight = observerSolarElevation(
    51.5,
    0,
    Date.UTC(2020, 8, 22, 0, 0, 0),
  );
  assert.ok(
    greenwichMidnight < -20,
    'sun must be well below horizon at midnight',
  );
  assert.ok(isObserverDark(51.5, 0, Date.UTC(2020, 8, 22, 0, 0, 0), -6));
});

test('isSatelliteSunlit accurately computes cylindrical umbra shadow', () => {
  const summerDate = Date.UTC(2020, 5, 21, 12, 0, 0);
  const sun = solarPositionECI(summerDate);
  const sunLen = Math.hypot(sun.x, sun.y, sun.z);
  const sx = sun.x / sunLen;
  const sy = sun.y / sunLen;
  const sz = sun.z / sunLen;

  // Point toward the Sun: must be sunlit
  const daysideSat = { x: 7000 * sx, y: 7000 * sy, z: 7000 * sz };
  assert.equal(isSatelliteSunlit(daysideSat, summerDate), true);

  // Point directly in Earth shadow (opposite Sun, r = 6700 km, < Earth radius offset): must be eclipsed
  const shadowedSat = { x: -6700 * sx, y: -6700 * sy, z: -6700 * sz };
  assert.equal(isSatelliteSunlit(shadowedSat, summerDate), false);

  // Point on night side but high altitude / far perpendicular to shadow axis (> 6371 km): must be sunlit
  const highAltSat = { x: -6700 * sx + 10000, y: -6700 * sy, z: -6700 * sz };
  assert.equal(isSatelliteSunlit(highAltSat, summerDate), true);
});

test('isSatelliteSunlit accurately identifies SGP4 orbital shadow entry and exit', () => {
  const satrec = twoline2satrec(L1, L2);
  // Minute 17 after FROM_MS (1221914820000): ISS is inside Earth umbra shadow cone
  const tShadowed = FROM_MS + 17 * 60_000;
  const pvShadowed = propagate(satrec, new Date(tShadowed));
  assert.equal(
    isSatelliteSunlit(pvShadowed.position, tShadowed),
    false,
    'ISS must be eclipsed in Earth umbra during orbital night',
  );

  // Minute 18 after FROM_MS (1221914880000): ISS emerges from umbra into sunlight
  const tSunlit = FROM_MS + 18 * 60_000;
  const pvSunlit = propagate(satrec, new Date(tSunlit));
  assert.equal(
    isSatelliteSunlit(pvSunlit.position, tSunlit),
    true,
    'ISS must be illuminated upon orbital sunrise',
  );
});

test('findNextSatellitePass resolves pass boundaries with sub-second precision', () => {
  const satrec = twoline2satrec(L1, L2);
  const pass = findNextSatellitePass({
    satrec,
    ...AUSTIN,
    fromMs: FROM_MS,
    minElevDeg: 10,
  });
  assert.ok(pass, 'expected a pass within 24h at Austin for ISS');
  assert.ok(pass.riseMs > FROM_MS);
  assert.ok(pass.riseMs < pass.maxElevMs && pass.maxElevMs < pass.setMs);
  assert.ok(pass.maxElevDeg >= 10);
  assert.ok(pass.riseAzDeg >= 0 && pass.riseAzDeg < 360);

  // Verify bisection accuracy at rise time:
  const beforeRise = lookAnglesAt(
    satrec,
    pass.riseMs - 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  const atRise = lookAnglesAt(
    satrec,
    pass.riseMs,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  const afterRise = lookAnglesAt(
    satrec,
    pass.riseMs + 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  assert.ok(
    beforeRise && beforeRise.elevDeg < 10.05,
    'elevation before riseMs must be below threshold',
  );
  assert.ok(
    atRise && Math.abs(atRise.elevDeg - 10) < 0.2,
    'elevation at riseMs must be within 0.2° of 10°',
  );
  assert.ok(
    afterRise && afterRise.elevDeg > 9.95,
    'elevation after riseMs must be rising above threshold',
  );

  // Verify bisection accuracy at set time:
  const beforeSet = lookAnglesAt(
    satrec,
    pass.setMs - 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  const atSet = lookAnglesAt(satrec, pass.setMs, AUSTIN.latDeg, AUSTIN.lonDeg);
  const afterSet = lookAnglesAt(
    satrec,
    pass.setMs + 1000,
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
  );
  assert.ok(
    beforeSet && beforeSet.elevDeg > 9.95,
    'elevation before setMs must be above threshold',
  );
  assert.ok(
    atSet && Math.abs(atSet.elevDeg - 10) < 0.2,
    'elevation at setMs must be within 0.2° of 10°',
  );
  assert.ok(
    afterSet && afterSet.elevDeg < 10.05,
    'elevation after setMs must be below threshold',
  );

  // Parabolic culmination accuracy: max elevation must be peak
  assert.ok(pass.maxElevDeg >= atRise.elevDeg);
  assert.ok(pass.maxElevDeg >= atSet.elevDeg);
});

test('findNextSatellitePass skips non-visible passes when requireVisible is true', () => {
  const satrec = twoline2satrec(L1, L2);
  const geometricPass = findNextSatellitePass({
    satrec,
    ...AUSTIN,
    fromMs: FROM_MS,
    minElevDeg: 10,
    requireVisible: false,
  });
  assert.ok(geometricPass);

  const visiblePass = findNextSatellitePass({
    satrec,
    ...AUSTIN,
    fromMs: FROM_MS,
    minElevDeg: 10,
    horizonHours: 72,
    requireVisible: true,
  });

  assert.ok(visiblePass, 'expected at least one visible pass within horizon');
  assert.equal(visiblePass.visible, true);
  assert.ok(visiblePass.riseMs >= geometricPass.riseMs);
});

test('findNextSatellitePass samples the peak at fineStepSec', () => {
  const satrec = twoline2satrec(L1, L2);
  const opts = { satrec, ...AUSTIN, fromMs: FROM_MS, minElevDeg: 10 };
  const fine = findNextSatellitePass({ ...opts, fineStepSec: 1 });
  const coarse = findNextSatellitePass({ ...opts, fineStepSec: 10 });
  assert.ok(fine && coarse);
  // The step is used: peak samples differ.
  assert.notEqual(fine.maxElevMs, coarse.maxElevMs);
  // Rise comes from bisection, so it does not depend on the step.
  assert.ok(Math.abs(fine.riseMs - coarse.riseMs) < 1000);
  // Parabolic refinement keeps 10s sampling close to the 1s peak.
  assert.ok(Math.abs(fine.maxElevMs - coarse.maxElevMs) < 1000);
  assert.ok(Math.abs(fine.maxElevDeg - coarse.maxElevDeg) < 0.01);
});

test('invalid numerical search options return promptly without unbounded scans', () => {
  const satrec = twoline2satrec(L1, L2);
  const options = { satrec, ...AUSTIN, fromMs: FROM_MS };
  for (const change of [
    { coarseStepSec: 0 },
    { coarseStepSec: -1 },
    { horizonHours: Infinity },
    { horizonHours: 73 },
    { fineStepSec: NaN },
    { latDeg: 91 },
    { fromMs: NaN },
  ]) {
    assert.equal(findNextSatellitePass({ ...options, ...change }), null);
  }
});

test('visibility catches a short overlap between shadow exit and dawn', () => {
  assert.equal(
    hasVisibleInterval(0, 5000, (t) => [t >= 2400, t <= 2500]),
    true,
  );
  assert.equal(
    hasVisibleInterval(0, 5000, (t) => [t >= 2500, t <= 2400]),
    false,
  );
});

test('a pass already underway clips rise to the requested start', () => {
  const satrec = twoline2satrec(L1, L2);
  const first = findNextSatellitePass({ satrec, ...AUSTIN, fromMs: FROM_MS });
  const clipped = findNextSatellitePass({
    satrec,
    ...AUSTIN,
    fromMs: first.maxElevMs,
  });
  assert.equal(clipped.riseMs, first.maxElevMs);
  assert.ok(clipped.setMs >= clipped.riseMs);
  assert.ok(
    clipped.maxElevMs >= clipped.riseMs && clipped.maxElevMs <= clipped.setMs,
  );
});

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

test('the general finder is the ISS finder, and a polar orbiter passes everywhere within a day', () => {
  const pass = findNextPass({
    satrec: NOAA20,
    ...AUSTIN,
    fromMs: FROM,
    minElevDeg: 10,
  });
  // The ISS wrapper keeps its original 30 s coarse step; with the same step
  // it is the general finder.
  assert.deepEqual(
    findNextIssPass({
      satrec: NOAA20,
      ...AUSTIN,
      fromMs: FROM,
      minElevDeg: 10,
    }),
    findNextPass({
      satrec: NOAA20,
      ...AUSTIN,
      fromMs: FROM,
      minElevDeg: 10,
      coarseStepSec: 30,
    }),
  );
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
  const pass = findNextPass({
    satrec: GOES19,
    ...AUSTIN,
    fromMs: FROM,
    minElevDeg: 10,
  });
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
  assert.ok(
    pass.offTrackKm >= 0 && pass.offTrackKm <= 1530,
    `off track ${pass.offTrackKm}`,
  );
  assert.equal(typeof pass.daylight, 'boolean');
  // At closest approach the sub-satellite point really is that far away.
  const sub = subpointAt(NOAA20, pass.atMs);
  const km = groundDistanceKm(
    AUSTIN.latDeg,
    AUSTIN.lonDeg,
    sub.latDeg,
    sub.lonDeg,
  );
  assert.ok(Math.abs(km - pass.offTrackKm) < 2, `${km} vs ${pass.offTrackKm}`);
  // Daylight agrees with the sun.
  assert.equal(
    pass.daylight,
    solarElevationDeg(pass.atMs, AUSTIN.latDeg, AUSTIN.lonDeg) > 0,
  );
  // A narrow swath covers a given spot far less often: Sentinel-2's 290 km
  // may not reach Austin in a day at all, and if it does it is close to nadir.
  const narrow = findNextImagingPass({
    satrec: NOAA20,
    ...AUSTIN,
    fromMs: FROM,
    swathKm: 290,
  });
  if (narrow) assert.ok(narrow.offTrackKm <= 145);
  assert.equal(
    findNextImagingPass({
      satrec: NOAA20,
      ...AUSTIN,
      fromMs: FROM,
      swathKm: 0,
    }),
    null,
  );
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
