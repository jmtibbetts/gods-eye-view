import test from 'node:test';
import assert from 'node:assert/strict';
import {
  feedCount,
  feedLatitude,
  feedLongitude,
  feedNumber,
} from './feedNumbers.js';

test('everything that coerces to a deceptive zero is rejected', () => {
  // This is the entire reason the module exists: each of these is `0` under a
  // bare Number(), and 0 is a valid latitude, flight level and class code.
  for (const value of ['', '   ', null, undefined, false, [], '\t\n'])
    assert.equal(
      feedNumber(value),
      null,
      `${JSON.stringify(value)} became a number`,
    );
});

test('a genuine zero survives', () => {
  // The other half of the contract. A surface-level ash base and a gauge
  // reading of zero are real readings, not missing ones.
  assert.equal(feedNumber(0), 0);
  assert.equal(feedNumber('0'), 0);
  assert.equal(feedNumber('0.0'), 0);
  assert.equal(feedNumber(-0), -0);
  assert.equal(feedCount(0), 0);
  assert.equal(feedLatitude(0), 0);
  assert.equal(feedLongitude(0), 0);
});

test('ordinary numbers and numeric strings pass through', () => {
  assert.equal(feedNumber(42), 42);
  assert.equal(feedNumber('42'), 42);
  assert.equal(feedNumber('-17.5'), -17.5);
  assert.equal(feedNumber(' 3.25 '), 3.25);
  assert.equal(feedNumber(1e3), 1000);
});

test('non-numbers are rejected rather than coerced', () => {
  for (const value of [
    'abc',
    'FL120',
    NaN,
    Infinity,
    -Infinity,
    {},
    [5],
    () => 5,
  ])
    assert.equal(feedNumber(value), null, `${String(value)} became a number`);
});

test('true is rejected as firmly as false', () => {
  // `Number(true)` is 1, which is a valid drought class and a valid count.
  assert.equal(feedNumber(true), null);
  assert.equal(feedCount(true), null);
});

test('counts reject negatives and round', () => {
  assert.equal(feedCount(3), 3);
  assert.equal(feedCount('7'), 7);
  assert.equal(feedCount(2.4), 2);
  assert.equal(feedCount(2.6), 3);
  assert.equal(feedCount(-1), null);
  assert.equal(feedCount(''), null);
});

test('coordinates are range-checked, and the poles and antimeridian are valid', () => {
  assert.equal(feedLatitude(90), 90);
  assert.equal(feedLatitude(-90), -90);
  assert.equal(feedLatitude(90.1), null);
  assert.equal(feedLatitude(-91), null);
  assert.equal(feedLongitude(180), 180);
  assert.equal(feedLongitude(-180), -180);
  assert.equal(feedLongitude(180.1), null);
  assert.equal(feedLatitude(''), null);
  assert.equal(feedLongitude(null), null);
});

test('a longitude out of latitude range is still a valid longitude', () => {
  // The two limits are genuinely different; sharing one check would reject
  // most of the Pacific.
  assert.equal(feedLongitude(150), 150);
  assert.equal(feedLatitude(150), null);
});
