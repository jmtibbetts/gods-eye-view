import test from 'node:test';
import assert from 'node:assert/strict';
import {
  labelAnchor,
  largestRing,
  ringArea,
  ringBounds,
  signedDistanceToRing,
} from './placeAnchors.js';
import { pointInRing } from './naturalEarthRegions.js';

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

/** A C: a square with a deep bite taken out of its right side. */
const CRESCENT = [
  [0, 0],
  [10, 0],
  [10, 3],
  [3, 3],
  [3, 7],
  [10, 7],
  [10, 10],
  [0, 10],
];

test('a convex shape is labelled at its middle', () => {
  const anchor = labelAnchor([SQUARE]);
  assert.ok(Math.abs(anchor.lon - 5) < 0.2);
  assert.ok(Math.abs(anchor.lat - 5) < 0.2);
  assert.ok(anchor.clearance > 4.5, 'the middle of a 10-wide square has room');
});

test('a crescent is labelled inside itself, not in its own bite', () => {
  // This is the whole point. Norway's centroid is in Sweden; the centroid of
  // this shape is in the notch, which is not part of the shape.
  const centroidX = CRESCENT.reduce((sum, [x]) => sum + x, 0) / CRESCENT.length;
  const centroidY =
    CRESCENT.reduce((sum, [, y]) => sum + y, 0) / CRESCENT.length;
  assert.equal(
    pointInRing(CRESCENT, centroidY, centroidX),
    false,
    'the centroid really is outside — otherwise this test proves nothing',
  );
  const anchor = labelAnchor([CRESCENT]);
  assert.equal(pointInRing(CRESCENT, anchor.lat, anchor.lon), true);
});

test('the name goes on the mainland, not on whichever island is listed first', () => {
  const island = [
    [50, 50],
    [51, 50],
    [51, 51],
    [50, 51],
  ];
  const anchor = labelAnchor([island, SQUARE]);
  assert.equal(pointInRing(SQUARE, anchor.lat, anchor.lon), true);
  assert.equal(largestRing([island, SQUARE]), SQUARE);
});

test('clearance reports how much room the name has', () => {
  const wide = labelAnchor([SQUARE]).clearance;
  const narrow = labelAnchor([
    [
      [0, 0],
      [10, 0],
      [10, 1],
      [0, 1],
    ],
  ]).clearance;
  assert.ok(narrow < wide, 'a strip has less room than a square');
  assert.ok(narrow > 0.3 && narrow < 0.6, 'and about half its short side');
});

test('distance to a ring is signed, so inside and outside are distinguishable', () => {
  assert.ok(signedDistanceToRing(SQUARE, 5, 5) > 0);
  assert.ok(signedDistanceToRing(SQUARE, -5, 5) < 0);
  assert.ok(Math.abs(signedDistanceToRing(SQUARE, 5, 5) - 5) < 1e-9);
});

test('bounds and area read the ring as given, closed or open', () => {
  assert.deepEqual(ringBounds(SQUARE), [0, 0, 10, 10]);
  assert.equal(ringArea(SQUARE), 100);
  assert.equal(ringArea([...SQUARE, [0, 0]]), 100, 'a closing vertex is free');
});

test('a shape with no usable ring is not given a made-up anchor', () => {
  assert.equal(labelAnchor(null), null);
  assert.equal(labelAnchor([]), null);
  assert.equal(labelAnchor([[[1, 1]]]), null, 'two points are not a shape');
});

test('a degenerate ring with no extent does not spin', () => {
  const flat = [
    [5, 5],
    [5, 5],
    [5, 5],
  ];
  const anchor = labelAnchor([flat]);
  assert.equal(anchor.lon, 5);
  assert.equal(anchor.lat, 5);
  assert.equal(anchor.clearance, 0);
});

test('precision is honoured, and a looser one is cheaper', () => {
  const fine = labelAnchor([CRESCENT], { precision: 0.001 });
  const coarse = labelAnchor([CRESCENT], { precision: 1 });
  assert.equal(pointInRing(CRESCENT, fine.lat, fine.lon), true);
  assert.equal(pointInRing(CRESCENT, coarse.lat, coarse.lon), true);
  assert.ok(fine.clearance >= coarse.clearance - 1e-6);
});
