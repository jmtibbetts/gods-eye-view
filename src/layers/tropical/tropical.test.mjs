import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NHC_CURRENT_STORMS_URL,
  NHC_MAPSERVER,
  classificationLabel,
  compassPoint,
  geoJsonQueryUrl,
  knotsToMph,
  layerIdsForBin,
  saffirSimpson,
} from './policy.js';
import {
  parseActiveStorms,
  parseDevelopmentRegions,
  parseDisturbances,
  parseTrackLines,
  summarize,
} from './records.js';
import { createNhcTropicalSource } from './source.js';
import { disturbanceLabelText, stormLabelText } from './index.js';

/**
 * NHC's own published sample. It matters because for most of the year the live
 * feed answers "there are no tropical cyclones at this time" — so without a
 * fixture the storm path would ship unverified and only be exercised during a
 * hurricane, which is the worst possible moment to discover a parsing bug.
 */
const SAMPLE = JSON.parse(
  readFileSync(new URL('./nhc-sample.fixture.json', import.meta.url), 'utf8'),
);

test('Saffir-Simpson boundaries land on the published thresholds', () => {
  assert.equal(saffirSimpson(33), 0, 'depression');
  assert.equal(saffirSimpson(63), 0, 'tropical storm, not yet a hurricane');
  assert.equal(saffirSimpson(64), 1, 'hurricane starts at 64 kt');
  assert.equal(saffirSimpson(82), 1);
  assert.equal(saffirSimpson(83), 2);
  assert.equal(saffirSimpson(96), 3);
  assert.equal(saffirSimpson(113), 4);
  assert.equal(saffirSimpson(137), 5);
  assert.equal(saffirSimpson(NaN), 0);
  assert.equal(saffirSimpson(null), 0);
});

test('wind converts to mph the way advisories state it', () => {
  assert.equal(knotsToMph(64), 75);
  assert.equal(knotsToMph(100), 115);
  assert.ok(Number.isNaN(knotsToMph('gale')));
});

test('compass points wrap correctly at both ends', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(90), 'E');
  assert.equal(compassPoint(285), 'WNW');
  assert.equal(compassPoint(NaN), '');
});

test('classifications expand, and unknown codes pass through rather than guess', () => {
  assert.equal(classificationLabel('HU'), 'Hurricane');
  assert.equal(classificationLabel('ptc'), 'Potential Tropical Cyclone');
  assert.equal(classificationLabel('ZZ'), 'ZZ');
  assert.equal(classificationLabel(''), 'Unknown');
});

test('the official NHC sample parses into complete storm records', () => {
  const storms = parseActiveStorms(SAMPLE);
  assert.equal(storms.length, 4);
  // Sorted strongest first so the most significant storm draws on top.
  assert.deepEqual(
    storms.map((s) => s.knots),
    [...storms.map((s) => s.knots)].sort((a, b) => b - a),
  );
  const franklin = storms.find((s) => s.name === 'Franklin');
  assert.ok(franklin, 'Franklin is in the sample');
  assert.equal(franklin.knots, 45);
  assert.equal(franklin.mph, 50);
  assert.equal(franklin.pressureMb, 1002);
  assert.equal(franklin.movementCompass, 'NNW');
  assert.equal(franklin.classification, 'TS');
  assert.match(franklin.headline, /Tropical Storm Franklin/);
  assert.ok(Number.isFinite(franklin.lat) && Number.isFinite(franklin.lon));
  assert.ok(franklin.publicAdvisoryUrl.startsWith('http'));
});

test('a western-hemisphere longitude never comes back positive', () => {
  // The bulletin gives longitude twice, as a number and as "58.4W". Getting
  // the hemisphere wrong would put an Atlantic hurricane over Africa.
  for (const storm of parseActiveStorms(SAMPLE)) {
    assert.ok(storm.lon < 0, `${storm.name} should be west of Greenwich`);
  }
  // And when the numeric field is missing, the labelled one still decides.
  const parsed = parseActiveStorms({
    activeStorms: [
      {
        id: 'x',
        name: 'Test',
        latitude: '17.1N',
        longitude: '58.4W',
        intensity: 70,
      },
    ],
  });
  assert.equal(parsed[0].lon, -58.4);
  assert.equal(parsed[0].lat, 17.1);
  assert.equal(parsed[0].category, 1);
});

test('a blank coordinate is rejected rather than read as zero', () => {
  // Number('') is a finite 0, which would plant a storm in the Gulf of Guinea.
  const parsed = parseActiveStorms({
    activeStorms: [
      { id: 'a', name: 'Blank', latitude: '', longitude: '', intensity: 60 },
      { id: 'b', name: 'Good', latitudeNumeric: 20, longitudeNumeric: -60 },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Good');
});

test('no active storms is an answer, not a failure', () => {
  assert.deepEqual(parseActiveStorms({ activeStorms: [] }), []);
  assert.deepEqual(parseActiveStorms(null), []);
  assert.deepEqual(parseActiveStorms({}), []);
});

test('outlook disturbances carry both horizons, strongest first', () => {
  const geojson = {
    features: [
      {
        geometry: { type: 'Point', coordinates: [-34, 32.8] },
        properties: {
          objectid: 1,
          basin: 'Atlantic',
          prob2day: '60%',
          risk2day: 'Medium',
          prob7day: '60%',
          risk7day: 'Medium',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [-118, 12.3] },
        properties: {
          objectid: 2,
          basin: 'Pacific',
          prob2day: '20%',
          risk2day: 'Low',
          prob7day: '80%',
          risk7day: 'High',
        },
      },
    ],
  };
  const parsed = parseDisturbances(geojson);
  assert.equal(parsed.length, 2);
  // Seven-day is usually the larger figure, so reporting one number would
  // consistently understate what the forecaster is saying.
  assert.equal(parsed[0].prob7day, 80, 'sorted by seven-day probability');
  assert.equal(parsed[0].prob2day, 20);
  assert.equal(parsed[0].risk7day, 'High');
  assert.notEqual(
    parsed[0].color,
    parsed[1].color,
    'risk bands differ in colour',
  );
});

test('development regions flatten to Cesium-ready rings', () => {
  const ring = [
    [-40, 30],
    [-30, 30],
    [-30, 35],
    [-40, 30],
  ];
  const parsed = parseDevelopmentRegions({
    features: [
      {
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { objectid: 7, basin: 'Atlantic', risk7day: 'Medium' },
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].positions, [-40, 30, -30, 30, -30, 35, -40, 30]);
  // A ring with a non-finite vertex is dropped whole rather than drawn bent.
  assert.deepEqual(
    parseDevelopmentRegions({
      features: [
        {
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-40, 30],
                [NaN, 31],
                [-30, 35],
              ],
            ],
          },
          properties: { objectid: 8 },
        },
      ],
    }),
    [],
  );
});

test('track lines flatten, and degenerate lines are dropped', () => {
  const lines = parseTrackLines({
    features: [
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [-40, 20],
            [-42, 21],
          ],
        },
      },
      { geometry: { type: 'LineString', coordinates: [[-40, 20]] } },
      { geometry: { type: 'Point', coordinates: [-40, 20] } },
    ],
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], [-40, 20, -42, 21]);
});

test('map-service layer ids are read per storm bin, never hardcoded', () => {
  // The service renumbers these as storms form and dissipate.
  const layers = [
    { id: 7, name: 'AT1 Forecast Track' },
    { id: 8, name: 'AT1 Forecast Cone' },
    { id: 12, name: 'AT1 Past Track' },
    { id: 20, name: 'AT2 Forecast Cone' },
    { id: 99, name: 'Seven-Day Outlook' },
  ];
  assert.deepEqual(layerIdsForBin(layers, 'AT1'), {
    cone: 8,
    forecastTrack: 7,
    pastTrack: 12,
    forecastPoints: null,
  });
  assert.equal(layerIdsForBin(layers, 'AT2').cone, 20);
  assert.equal(layerIdsForBin(layers, 'EP9').cone, null);
  assert.equal(layerIdsForBin(layers, '').cone, null);
  assert.match(geoJsonQueryUrl(8), /MapServer\/8\/query\?.*f=geojson/);
});

test('summaries count hurricanes and majors separately', () => {
  const storms = parseActiveStorms({
    activeStorms: [
      {
        id: '1',
        name: 'A',
        latitudeNumeric: 20,
        longitudeNumeric: -60,
        intensity: 120,
      },
      {
        id: '2',
        name: 'B',
        latitudeNumeric: 21,
        longitudeNumeric: -61,
        intensity: 70,
      },
      {
        id: '3',
        name: 'C',
        latitudeNumeric: 22,
        longitudeNumeric: -62,
        intensity: 40,
      },
    ],
  });
  const s = summarize({ storms, disturbances: [{}, {}] });
  assert.equal(s.storms, 3);
  assert.equal(s.hurricanes, 2);
  assert.equal(s.major, 1);
  assert.equal(s.disturbances, 2);
  assert.match(s.strongest, /Category 4/);
});

test('every storm card warns what the cone does and does not mean', () => {
  const [storm] = parseActiveStorms(SAMPLE);
  const card = stormLabelText(storm);
  // The cone is the most misread object in public weather graphics: it shows
  // where the CENTRE is likely to go, not how far the damage reaches.
  assert.match(card, /CENTRE/);
  assert.match(card, /outside it/);
  assert.match(
    disturbanceLabelText({ basin: 'Atlantic', prob7day: 60 }),
    /Not a cyclone/,
  );
});

test('the bulletin is read through our proxy, not the CORS-blocked origin', () => {
  // nhc.noaa.gov sends no access-control-allow-origin, so a browser fetch of
  // it fails with an opaque TypeError and the storm half of this layer would
  // sit permanently empty while looking merely quiet. The map service DOES
  // send CORS headers, which is why the outlook loads directly and this
  // cannot — an asymmetry invisible until you try it in a browser.
  assert.equal(NHC_CURRENT_STORMS_URL, '/api/nhc/storms');
  assert.doesNotMatch(NHC_CURRENT_STORMS_URL, /nhc\.noaa\.gov/);
  // The map service is reached directly, precisely because it allows it.
  assert.match(NHC_MAPSERVER, /^https:\/\/mapservices\.weather\.noaa\.gov/);
});

test('a failed bulletin degrades to empty rather than throwing', async () => {
  const source = createNhcTropicalSource({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const result = await source.fetchTropical({});
  assert.equal(result.bulletinOk, false);
  assert.deepEqual(result.storms, []);
  assert.deepEqual(result.disturbances, []);
});

test('a missing outlook does not cost you the storms', async () => {
  const source = createNhcTropicalSource({
    fetchImpl: async (url) => {
      if (String(url).includes('/api/nhc/storms'))
        return { ok: true, json: async () => SAMPLE };
      throw new Error('map service down');
    },
  });
  const result = await source.fetchTropical({});
  assert.equal(result.bulletinOk, true);
  assert.equal(result.storms.length, 4, 'storms survive an outlook outage');
  assert.equal(result.outlookOk, false);
});
