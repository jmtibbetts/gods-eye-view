import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createMarkerField } from './markerField.js';

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
