import test from 'node:test';
import assert from 'node:assert/strict';
import { magnitudeText } from './policy.js';
import {
  normalizeStormReports,
  parseStormReports,
  splitReportRow,
} from './records.js';

// Shaped exactly like spc.noaa.gov/climo/reports/<day>.csv: one header row per
// section, the second column naming the kind.
const SAMPLE = [
  'Time,F_Scale,Location,County,State,Lat,Lon,Comments',
  '1959,UNK,4 N Hohenwald,Lewis,TN,35.61,-87.56,Tornado viewed on webcam. (OHX)',
  'Time,Speed,Location,County,State,Lat,Lon,Comments',
  '1504,UNK,7 E Eagle Point,Jackson,OR,42.45,-122.67,Tree limbs down. (MFR)',
  '1810,65,2 W East Mesa,Maricopa,AZ,33.42,-111.72,Downed power lines. (PSR)',
  'Time,Size,Location,County,State,Lat,Lon,Comments',
  '1540,125,Gannett,Blaine,ID,43.35,-114.18,(PIH)',
].join('\n');

test('splitReportRow keeps commas inside the trailing comment field', () => {
  const row = splitReportRow(
    '1540,125,Gannett,Blaine,ID,43.35,-114.18,Trees down, roof damage, and hail',
  );
  assert.equal(row.length, 8);
  assert.equal(row[7], 'Trees down, roof damage, and hail');
  assert.equal(splitReportRow('a,b,c').length, 3);
});

test('parseStormReports splits sections by their header row', () => {
  const reports = parseStormReports(SAMPLE, 'today');
  assert.equal(reports.length, 4);
  assert.deepEqual(
    reports.map((r) => r.kind),
    ['tornado', 'wind', 'wind', 'hail'],
  );
  const tornado = reports[0];
  assert.equal(tornado.location, '4 N Hohenwald');
  assert.equal(tornado.county, 'Lewis');
  assert.equal(tornado.state, 'TN');
  assert.equal(tornado.lat, 35.61);
  assert.equal(tornado.lon, -87.56);
  assert.equal(tornado.day, 'today');
});

test('parseStormReports drops rows without a usable coordinate', () => {
  const csv = [
    'Time,Size,Location,County,State,Lat,Lon,Comments',
    '1540,125,Good,Blaine,ID,43.35,-114.18,ok',
    '1541,125,NoLat,Blaine,ID,,-114.18,missing',
    '1542,125,BadLat,Blaine,ID,999,-114.18,out of range',
    '1543,125,Short,Blaine',
  ].join('\n');
  const reports = parseStormReports(csv);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].location, 'Good');
});

test('parseStormReports ignores rows before any section header', () => {
  const csv = ['1540,125,Orphan,Blaine,ID,43.35,-114.18,no header yet'].join(
    '\n',
  );
  assert.deepEqual(parseStormReports(csv), []);
  assert.deepEqual(parseStormReports(''), []);
  assert.deepEqual(parseStormReports(null), []);
});

test('normalizeStormReports merges days, dedupes, and counts by kind', () => {
  const { reports, byKind } = normalizeStormReports([
    { day: 'today', csv: SAMPLE },
    // Same file again as "yesterday": every row is a duplicate spotter report.
    { day: 'yesterday', csv: SAMPLE },
  ]);
  assert.equal(reports.length, 4);
  assert.deepEqual(byKind, { tornado: 1, wind: 2, hail: 1 });
});

test('normalizeStormReports orders rarer kinds last so they draw on top', () => {
  const { reports } = normalizeStormReports([{ day: 'today', csv: SAMPLE }]);
  assert.equal(reports.at(-1).kind, 'tornado');
  assert.equal(reports[0].kind, 'wind');
});

test('magnitudeText converts hail hundredths and wind knots', () => {
  assert.equal(magnitudeText('hail', '125'), '1.25″ hail');
  assert.equal(magnitudeText('wind', '65'), '65 kt (75 mph)');
  assert.equal(magnitudeText('wind', 'UNK'), 'unmeasured');
  assert.equal(magnitudeText('tornado', 'UNK'), 'EF-scale pending');
  assert.equal(magnitudeText('tornado', 'EF2'), 'EF2');
});
