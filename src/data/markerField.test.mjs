import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import * as Cesium from 'cesium';
import { createMarkerField, createMarkerFieldLoop } from './markerField.js';

const entityAt = (lon, lat, h = 0) => ({
  show: true,
  position: new Cesium.ConstantPositionProperty(
    Cesium.Cartesian3.fromDegrees(lon, lat, h),
  ),
});
const camera = (lon, lat, alt) => ({
  positionWC: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
  heading: 0,
  pitch: -1.2,
  roll: 0,
});

test('far-side markers are hidden and visible ones rank nearest first', () => {
  const field = createMarkerField();
  const austin = entityAt(-97.74, 30.27);
  const dallas = entityAt(-96.8, 32.78);
  const perth = entityAt(115.86, -31.95);
  field.track('austin', austin, 30.27, -97.74);
  field.track('dallas', dallas, 32.78, -96.8);
  field.track('perth', perth, -31.95, 115.86);
  const visible = field.cull(camera(-97.74, 30.27, 20_000));
  assert.deepEqual(visible, ['austin', 'dallas']);
  assert.equal(perth.show, false, 'a marker behind the globe is hidden');
  assert.equal(austin.show, true);
  assert.equal(
    field.cull(camera(-97.74, 30.27, 20_000)),
    null,
    'no work when the camera is still',
  );
  assert.ok(
    Array.isArray(field.cull(camera(-97.74, 30.27, 20_000), { force: true })),
  );
  field.setHidden('austin');
  field.cull(camera(-97.75, 30.27, 20_000));
  assert.equal(austin.show, false, 'the selected marker stays hidden');
  assert.equal(dallas.show, true);
  field.setHidden(null);
  field.cull(camera(-97.76, 30.27, 20_000));
  assert.equal(austin.show, true);
});

test('markers move onto floors as they warm', () => {
  const floors = new Map();
  const ground = {
    cachedGroundFloor: (lat, lon) => floors.get(`${lat},${lon}`) ?? null,
    warmGroundFloor: (points) => {
      for (const p of points) floors.set(`${p.lat},${p.lon}`, 600);
    },
  };
  const field = createMarkerField({ ground, liftM: 2 });
  const e = {
    show: true,
    position: new Cesium.ConstantPositionProperty(
      field.positionFor(36.1, -115.2),
    ),
  };
  field.track('vegas', e, 36.1, -115.2);
  const before = Cesium.Cartographic.fromCartesian(
    e.position.getValue(),
  ).height;
  assert.ok(
    Math.abs(before - 2) < 0.01,
    'ellipsoid + lift before the floor is known',
  );
  assert.equal(field.reposition(), 0);
  field.warm([{ lat: 36.1, lon: -115.2 }]);
  assert.equal(field.reposition(), 1);
  const after = Cesium.Cartographic.fromCartesian(e.position).height;
  assert.ok(Math.abs(after - 602) < 0.01, 'moved onto the warmed floor');
  assert.equal(field.reposition(), 0, 'stable once placed');
});

test('the field loop culls on a tick, re-floors on schedule, and stops cleanly', () => {
  const floors = new Map();
  const ground = {
    cachedGroundFloor: (lat, lon) => floors.get(`${lat},${lon}`) ?? null,
    warmGroundFloor: () => {},
  };
  const field = createMarkerField({ ground, liftM: 2 });
  const austin = entityAt(-97.74, 30.27, 2);
  const perth = entityAt(115.86, -31.95, 2);
  field.track('austin', austin, 30.27, -97.74);
  field.track('perth', perth, -31.95, 115.86);
  let renders = 0;
  const viewer = {
    camera: camera(-97.74, 30.27, 20_000),
    scene: { requestRender: () => renders++ },
  };
  const loop = createMarkerFieldLoop(field, () => viewer, {
    repositionEvery: 3,
  });

  // No viewer yet: a tick is a no-op rather than a throw.
  assert.equal(createMarkerFieldLoop(field, () => null).refresh(), null);

  // The interval must die even when an assertion below throws, or the test
  // process never exits.
  try {
    loop.start();
    assert.ok(loop.running(), 'start arms the interval');
    assert.equal(perth.show, false, 'the first pass culls the far side');
    assert.equal(loop.refresh(), null, 'a still camera is no work');

    // Floors warm between ticks; the scheduled pass moves the marker and asks
    // for a frame, because nothing else would redraw a still scene.
    floors.set('30.27,-97.74', 600);
    loop.refresh();
    assert.equal(renders, 1, 'the re-floor tick requested a render');
    // A real Entity wraps an assigned Cartesian3 in a position property; this
    // stand-in keeps the raw value, so read it as one.
    const height = Cesium.Cartographic.fromCartesian(austin.position).height;
    assert.ok(Math.abs(height - 602) < 0.01, 'the marker moved onto its floor');
  } finally {
    loop.stop();
  }
  assert.equal(loop.running(), false);
  loop.stop();
});

test('every static point layer with depth-test-free dots goes through the field', async () => {
  // A point with `disableDepthTestDistance: Infinity` is painted through the
  // Earth, so a global field of them projects far-side dots onto whatever
  // city is on screen, sliding as the camera moves. Six layers shipped that
  // way. The field floors and horizon-culls them; this keeps the seventh
  // from shipping the same way.
  const layers = [
    'lightning',
    'riverFlood',
    'satnogs',
    'stormReports',
    'tropical',
    'volcanoes',
  ];
  for (const dir of layers) {
    const source = await readFile(
      new URL(`../layers/${dir}/index.js`, import.meta.url),
      'utf8',
    );
    assert.ok(
      source.includes('createMarkerField({ ground })'),
      `${dir} builds a field`,
    );
    assert.ok(
      source.includes('createMarkerFieldLoop('),
      `${dir} runs the field loop`,
    );
    for (const call of [
      '_field.track(',
      '_field.warm(',
      '_field.clear()',
      '_fieldLoop.start()',
      '_fieldLoop.stop()',
    ]) {
      assert.ok(source.includes(call), `${dir} calls ${call}`);
    }
    // Every point block that disables the depth test must be floored by the
    // field rather than clamped: clamping has no globe to clamp to under the
    // photoreal stack, and a clamped point at height 0 sits under the mesh.
    const pointBlocks = source.match(/point: \{[^}]*\}/g) || [];
    assert.ok(pointBlocks.length > 0, `${dir} draws points`);
    for (const block of pointBlocks) {
      if (!block.includes('disableDepthTestDistance')) continue;
      assert.equal(
        block.includes('heightReference'),
        false,
        `${dir}: a depth-test-free point is floored by the field, not clamped`,
      );
    }
    assert.ok(
      /position: _field\.positionFor\(/.test(source),
      `${dir} places points on the floor`,
    );
  }
});
